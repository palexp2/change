// Connecteur bancaire Venn — LECTURE SEULE.
//
// Monté sous /api/venn (donc /erp/api/venn côté nginx : aucune `location` à
// ajouter, le préfixe /erp/api/ est déjà proxié).
//
// Ce que ces routes font : lire les comptes Venn et leurs soldes, les relier
// aux comptes bancaires de l'ERP (Venn CAD / Venn USD), et verser leurs
// transactions dans le rapprochement bancaire. Ce qu'elles ne font PAS, et ne
// feront pas : émettre un paiement, un virement, ou publier quoi que ce soit
// dans QuickBooks — le push QB reste un geste humain.
import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { saveConfig, deleteConfig, publicConfig, isVennConfigured, DEFAULTS } from '../connectors/venn.js'
import { testVennConnection, listVennAccounts } from '../services/venn.js'
import { syncVennAccount, scheduledVennSync, vennSyncStatus, linkedVennAccounts } from '../services/vennSync.js'
import { getSessionStatus } from '../services/sessionHealth.js'

const router = Router()
router.use(requireAuth)

const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')"
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

router.get('/status', (req, res) => {
  const last = db.prepare(`
    SELECT created_at, status, records_modified, error_message, duration_ms
    FROM sync_log WHERE module='venn' ORDER BY created_at DESC LIMIT 1
  `).get() || null
  res.json({
    configured: isVennConfigured(),
    config: publicConfig(),
    defaults: DEFAULTS,
    accounts: vennSyncStatus(),
    // Comptes bancaires candidats au rattachement (toute la liste : c'est
    // l'humain qui sait lequel est lequel).
    bank_accounts: db.prepare(`
      SELECT id, name, currency, institution, venn_account_id
      FROM bank_accounts WHERE deleted_at IS NULL ORDER BY sort_order, name
    `).all(),
    session: getSessionStatus('venn'),
    last_sync: last,
  })
})

const CONFIG_KEYS = new Set(Object.keys(DEFAULTS).concat(['api_key']))

router.put('/config', requireAdmin, (req, res) => {
  const body = req.body || {}
  const unknown = Object.keys(body).filter(k => !CONFIG_KEYS.has(k))
  if (unknown.length) return res.status(400).json({ error: `Clé inconnue : ${unknown.join(', ')}` })
  if (body.api_base !== undefined && body.api_base !== '' && !/^https:\/\/[\w.-]+/.test(String(body.api_base))) {
    return res.status(400).json({ error: "L'adresse de l'API doit commencer par https://" })
  }
  for (const key of ['accounts_path', 'transactions_path']) {
    if (body[key] !== undefined && body[key] !== '' && !String(body[key]).startsWith('/')) {
      return res.status(400).json({ error: `${key} doit commencer par « / »` })
    }
  }
  for (const key of ['page_size', 'lookback_days']) {
    if (body[key] !== undefined && body[key] !== '' && !/^\d{1,4}$/.test(String(body[key]))) {
      return res.status(400).json({ error: `${key} doit être un nombre` })
    }
  }
  try {
    saveConfig(body)
    res.json({ ok: true, config: publicConfig(), configured: isVennConfigured() })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

router.delete('/config', requireAdmin, (req, res) => {
  deleteConfig()
  res.json({ ok: true, configured: isVennConfigured() })
})

// « Tester la connexion » — lit les comptes et leurs soldes. Aucune écriture.
router.post('/test', async (req, res) => {
  try {
    res.json(await testVennConnection())
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

// Les comptes tels que Venn les voit (pour le rattachement).
router.get('/accounts', async (req, res) => {
  try {
    res.json({ accounts: await listVennAccounts() })
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

// Rattache un compte bancaire de l'ERP à un compte Venn (chaîne vide = détacher).
router.post('/accounts/:bankAccountId/link', requireAdmin, (req, res) => {
  const vennAccountId = req.body?.venn_account_id == null ? '' : String(req.body.venn_account_id).trim()
  const account = db.prepare('SELECT id FROM bank_accounts WHERE id=? AND deleted_at IS NULL').get(req.params.bankAccountId)
  if (!account) return res.status(404).json({ error: 'Compte introuvable' })
  const taken = vennAccountId && db.prepare(
    'SELECT name FROM bank_accounts WHERE venn_account_id=? AND id<>? AND deleted_at IS NULL'
  ).get(vennAccountId, account.id)
  if (taken) return res.status(400).json({ error: `Ce compte Venn est déjà relié à « ${taken.name} »` })
  db.prepare(`UPDATE bank_accounts SET venn_account_id=?, updated_at=${NOW} WHERE id=?`)
    .run(vennAccountId || null, account.id)
  res.json({ ok: true, accounts: vennSyncStatus() })
})

// Synchronisation sur une plage de dates. Sans corps : tous les comptes
// reliés, sur la fenêtre par défaut. Relancer ne crée jamais de doublon.
router.post('/sync', async (req, res) => {
  const { bank_account_id: bankAccountId, from, to } = req.body || {}
  for (const [k, v] of Object.entries({ from, to })) {
    if (v && !DATE_RE.test(String(v))) return res.status(400).json({ error: `${k} : date au format AAAA-MM-JJ` })
  }
  if ((from && !to) || (to && !from)) return res.status(400).json({ error: 'Donner les deux dates, ou aucune' })
  try {
    if (bankAccountId) {
      return res.json({ results: [await syncVennAccount(bankAccountId, { from, to, trigger: 'manual' })] })
    }
    if (from && to) {
      const results = []
      for (const acc of linkedVennAccounts()) {
        try { results.push(await syncVennAccount(acc.id, { from, to, trigger: 'manual' })) }
        catch (e) { results.push({ account: acc.name, account_id: acc.id, error: e.message }) }
      }
      return res.json({ results })
    }
    res.json({ results: await scheduledVennSync({ trigger: 'manual' }) })
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

export default router
