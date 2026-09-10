// Connexion bancaire Plaid : flux Link (créer link_token, échanger le
// public_token), mapping des comptes détectés vers bank_accounts, et webhook
// entrant qui déclenche la sync incrémentale. Voir connectors/plaid.js et
// services/plaidSync.js pour la logique.
import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { createLinkToken, exchangePublicToken, listItems, probeLiabilities, recordItemIssue, removeItem, resetItemCursor, requestTransactionsRefresh, resolveWebhookItem, verifyWebhook } from '../connectors/plaid.js'
import { syncPlaidItem, plaidSyncStatus } from '../services/plaidSync.js'

// Webhook PUBLIC — Plaid appelle directement, pas de session utilisateur.
// Monté séparément dans index.js AVANT express.json() (corps brut requis pour
// vérifier la signature JWT — voir connectors/plaid.js:verifyWebhook).
export const plaidWebhookRouter = Router()

// Ce que Plaid nous demande de faire, d'après le type du webhook. Fonction
// PURE (exportée pour le test) : elle décide, le handler agit.
//   'sync'   → des transactions ont bougé
//   'issue'  → la connexion est abîmée, `message` est destiné à l'utilisateur
//   'clear'  → la connexion est réparée
//   'ignore' → rien à faire
//
// Avant, le handler synchronisait sur N'IMPORTE quel webhook : les webhooks
// ITEM déclenchaient une sync vouée à échouer et leur message — le seul endroit
// où Plaid explique que la banque ne répond plus — était perdu.
export function webhookAction(body) {
  const type = body?.webhook_type
  const code = body?.webhook_code
  // Tous les codes TRANSACTIONS méritent une sync : SYNC_UPDATES_AVAILABLE (le
  // seul qui arrive, on utilise /transactions/sync) et les codes hérités
  // INITIAL_UPDATE / HISTORICAL_UPDATE / DEFAULT_UPDATE / TRANSACTIONS_REMOVED.
  if (type === 'TRANSACTIONS') return { action: 'sync' }
  if (type === 'ITEM') {
    switch (code) {
      case 'ERROR':
        return { action: 'issue', message: body?.error?.error_message || 'Erreur signalée par Plaid' }
      case 'PENDING_DISCONNECT':
      case 'PENDING_EXPIRATION':
        return { action: 'issue', message: 'Connexion à renouveler : la banque va couper l\u2019accès sous peu.' }
      case 'USER_PERMISSION_REVOKED':
      case 'USER_ACCOUNT_REVOKED':
        return { action: 'issue', message: 'Accès révoqué par le titulaire du compte — reconnexion nécessaire.' }
      case 'NEW_ACCOUNTS_AVAILABLE':
        return { action: 'issue', message: 'Un nouveau compte est disponible chez la banque : à mapper.' }
      case 'LOGIN_REPAIRED':
        return { action: 'clear' }
      default:
        return { action: 'ignore' }
    }
  }
  return { action: 'ignore' }
}

plaidWebhookRouter.post('/', async (req, res) => {
  try {
    await verifyWebhook({ rawBody: req.rawBody, verificationHeader: req.headers['plaid-verification'] })
  } catch (e) {
    console.error('plaid webhook: signature invalide —', e.message)
    return res.status(401).json({ error: 'Signature invalide' })
  }
  const itemId = resolveWebhookItem(req.body)
  if (!itemId) return res.status(404).json({ error: 'Item inconnu' })
  // Répondre tout de suite : Plaid retente si la réponse tarde, la sync peut
  // prendre plusieurs secondes (pagination /transactions/sync).
  res.status(200).json({ ok: true })
  const { action, message } = webhookAction(req.body)
  try {
    if (action === 'sync') await syncPlaidItem(itemId, 'webhook')
    else if (action === 'issue') recordItemIssue(itemId, message)
    else if (action === 'clear') recordItemIssue(itemId, null)
    else console.error('plaid webhook: type ignoré —', req.body?.webhook_type, req.body?.webhook_code)
  } catch (e) {
    console.error('plaid webhook sync:', e.message)
  }
})

const router = Router()
router.use(requireAuth)

router.post('/link-token', async (req, res) => {
  const { link_token, expiration } = await createLinkToken({ userId: req.user?.id })
  res.json({ link_token, expiration })
})

router.post('/exchange', async (req, res) => {
  const { public_token: publicToken } = req.body
  if (!publicToken) return res.status(400).json({ error: 'public_token requis' })
  const result = await exchangePublicToken({ publicToken, userId: req.user?.id })
  res.json(result)
})

router.get('/status', (req, res) => {
  res.json(listItems())
})

// État par compte mappé : fraîcheur, nombre de transactions Plaid, solde lu.
// C'est ici qu'un compte « mappé mais vide » se voit (curseur avancé avant le
// mapping — il faut relire l'historique, voir reset-cursor ci-dessous).
router.get('/sync-status', async (req, res) => {
  res.json(await plaidSyncStatus())
})

router.post('/accounts/:bankAccountId/link', (req, res) => {
  const { plaid_account_id: plaidAccountId, plaid_item_id: plaidItemId } = req.body
  if (!plaidAccountId || !plaidItemId) return res.status(400).json({ error: 'plaid_account_id et plaid_item_id requis' })
  const account = db.prepare('SELECT id FROM bank_accounts WHERE id=? AND deleted_at IS NULL').get(req.params.bankAccountId)
  if (!account) return res.status(404).json({ error: 'Compte introuvable' })
  db.prepare(`
    UPDATE bank_accounts SET plaid_account_id=?, plaid_item_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id=?
  `).run(plaidAccountId, plaidItemId, account.id)
  res.json({ ok: true })
})

router.post('/sync/:itemId', async (req, res) => {
  const result = await syncPlaidItem(req.params.itemId, 'manual')
  res.json(result)
})

// Relit tout l'historique que Plaid détient pour l'item : remet le curseur à
// zéro puis resynchronise. Aucun doublon possible (dedup_key = plaid:<txn_id>),
// c'est le rattrapage d'un compte mappé après coup.
router.post('/items/:itemId/reset-cursor', requireAdmin, async (req, res) => {
  resetItemCursor(req.params.itemId)
  const result = await syncPlaidItem(req.params.itemId, 'manual')
  res.json(result)
})

// Demande à Plaid d'interroger la banque tout de suite, puis relit. À utiliser
// quand la banque a cessé de livrer (last_successful_update qui date) : sans
// ça, on attend son prochain passage, qui peut ne jamais venir.
router.post('/items/:itemId/refresh', async (req, res) => {
  try {
    await requestTransactionsRefresh(req.params.itemId)
  } catch (e) {
    const msg = e?.response?.data?.error_message || e.message
    return res.status(502).json({ error: `La banque n'a pas répondu à la demande de relecture : ${msg}` })
  }
  const result = await syncPlaidItem(req.params.itemId, 'manual')
  res.json(result)
})

// Diagnostic ponctuel, pas une fonctionnalité : Liabilities donnerait
// l'échéance, le solde de relevé et le paiement minimum de la MasterCard, mais
// il faut l'activer commercialement chez Plaid ET re-consentir chaque item via
// Link. Cette sonde dit, avant de payer, si la BNC est seulement non consentie
// ou franchement non couverte au Canada. Lecture seule.
router.post('/items/:itemId/probe-liabilities', requireAdmin, async (req, res) => {
  res.json(await probeLiabilities(req.params.itemId))
})

router.delete('/items/:itemId', requireAdmin, async (req, res) => {
  await removeItem(req.params.itemId)
  res.json({ ok: true })
})

export default router
