// Collecte automatique des factures sur les portails fournisseurs.
//
// Pour les fournisseurs qui n'envoient rien par courriel et n'exposent pas
// d'API (Amazon, Wix), un collecteur va chercher les factures derrière le login
// du portail et les dépose dans l'extracteur de données comme n'importe quel
// reçu. Ici : gestion des comptes (identifiants chiffrés), déclenchement,
// réponse aux défis 2FA et consultation de l'historique des tournées.
import { Router } from 'express'
import { newRecordId } from '../utils/recordId.js'
import { existsSync, unlinkSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'
import { execFile } from 'child_process'
import db from '../db/database.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { encryptCredentials } from '../utils/encryption.js'
import { buildPartialUpdate } from '../utils/partialUpdate.js'
import { SCRAPERS, VENDOR_LABELS, VENDOR_DOMAINS, BRIDGE_DOMAINS, runScraper, runAllScrapers, isRunning, getAccount, reapOrphanRuns } from '../services/scrapers/index.js'
import { parseSessionPayload, sessionCoversDomain } from '../services/scrapers/session.js'
import { chromiumAvailable } from '../services/scrapers/browser.js'
import { refreshInvoiceNeeds, dueNeedsForAccount } from '../services/scrapers/invoiceNeeds.js'
import { collectionHealth, collectionHealthSummary } from '../services/collectionHealth.js'
import { nowIso } from '../utils/datetime.js'
import { parseLimit } from '../utils/pagination.js'
import { uploadsPath } from '../config/uploads.js'

// Au démarrage : refermer les tournées qu'un redémarrage a laissées « en cours ».
reapOrphanRuns()

const router = Router()
router.use(requireAuth)

const artifactsRoot = uploadsPath('scrapers')

// Les identifiants ne ressortent JAMAIS de l'API : le front affiche seulement
// s'ils sont présents, jamais leur valeur.
function publicAccount(row) {
  if (!row) return null
  const {
    password_enc, totp_secret_enc, storage_state_enc, otp_code: _otp, ...rest
  } = row
  return {
    ...rest,
    vendor_label: VENDOR_LABELS[row.vendor] || row.vendor,
    has_password: !!password_enc,
    has_totp: !!totp_secret_enc,
    has_session: !!storage_state_enc,
    // Portail à captcha : sans session envoyée depuis le module de navigateur, la
    // tournée ne partira même pas.
    session_required: !!SCRAPERS[row.vendor]?.requiresImportedSession,
    running: isRunning(row.id),
  }
}

router.get('/', (req, res) => {
  const accounts = db.prepare(`
    SELECT s.*, v.name AS vendor_profile_name,
           (SELECT COUNT(*) FROM invoice_needs n
             WHERE n.scraper_account_id = s.id AND n.status != 'trouvee') AS pending_needs
    FROM scraper_accounts s
    LEFT JOIN vendor_profiles v ON v.id = s.vendor_profile_id
    WHERE s.deleted_at IS NULL ORDER BY s.vendor, s.label
  `).all().map(publicAccount)
  // Un défi 2FA en cours doit sauter aux yeux : c'est la seule chose qui exige
  // une action humaine immédiate.
  const pending = db.prepare(`
    SELECT id, account_id, vendor, started_at FROM scraper_runs WHERE status='needs_otp'
  `).all()
  res.json({
    accounts,
    vendors: Object.entries(SCRAPERS).map(([key, s]) => ({ key, label: s.label, fields: s.fields })),
    // Pour le picker « fournisseur » du formulaire de compte : c'est ce lien qui
    // permet de partir d'une ligne bancaire et de savoir quel portail interroger.
    vendor_profiles: db.prepare(
      'SELECT id, name FROM vendor_profiles WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE'
    ).all(),
    pending_otp: pending,
    chromium: chromiumAvailable(),
  })
})

router.get('/runs', (req, res) => {
  const { account_id, limit } = req.query
  const rows = account_id
    ? db.prepare('SELECT * FROM scraper_runs WHERE account_id=? ORDER BY started_at DESC LIMIT ?')
      .all(account_id, parseLimit(limit, { def: 30, max: 200 }))
    : db.prepare('SELECT * FROM scraper_runs ORDER BY started_at DESC LIMIT ?')
      .all(parseLimit(limit, { def: 30, max: 200 }))
  res.json(rows.map(r => ({
    ...r,
    log: JSON.parse(r.log || '[]'),
    artifacts: JSON.parse(r.artifacts || '[]'),
  })))
})

router.get('/documents', (req, res) => {
  const rows = db.prepare(`
    SELECT d.*, r.original_name, r.company, r.total, r.status AS receipt_status
    FROM scraper_documents d
    LEFT JOIN sale_receipts r ON r.id = d.sale_receipt_id
    ORDER BY d.created_at DESC LIMIT 200
  `).all()
  res.json(rows)
})

// Les transactions bancaires qui attendent leur facture. C'est la liste de
// travail de la collecte ciblée, et la file de priorisation pour brancher le
// prochain portail (« fournisseur reconnu, pas de collecteur »).
router.get('/needs', (req, res) => {
  refreshInvoiceNeeds()
  // L'ancienneté est LE tri de la liste « Factures manquantes » : ce qui traîne
  // depuis trois semaines passe avant le débit d'hier.
  const rows = db.prepare(`
    SELECT n.id, n.bank_txn_id, n.scraper_account_id, n.amount, n.currency, n.txn_date,
           n.status, n.attempts, n.last_attempt_at, n.note, n.sale_receipt_id,
           CAST(julianday('now') - julianday(n.txn_date) AS INTEGER) AS age_days,
           v.name AS vendor_name,
           COALESCE(NULLIF(t.details, ''), t.description) AS label,
           t.account_id AS bank_account_id,
           b.name AS bank_account_name,
           s.label AS collector_label, s.last_status AS collector_status,
           r.company AS receipt_company, r.total AS receipt_total
    FROM invoice_needs n
    LEFT JOIN vendor_profiles v ON v.id = n.vendor_profile_id
    JOIN bank_transactions t ON t.id = n.bank_txn_id
    JOIN bank_accounts b ON b.id = t.account_id
    LEFT JOIN scraper_accounts s ON s.id = n.scraper_account_id
    LEFT JOIN sale_receipts r ON r.id = n.sale_receipt_id
    WHERE t.deleted_at IS NULL
    ORDER BY (n.status = 'trouvee'), n.txn_date ASC
  `).all()
  res.json(rows)
})


// Le besoin attaché à une transaction précise — sert au tiroir du rapprochement
// bancaire à savoir s'il y a un portail à interroger pour cette ligne.
router.get('/needs/transaction/:txnId', (req, res) => {
  const row = db.prepare(`
    SELECT n.*, v.name AS vendor_name, s.label AS account_label, s.enabled AS account_enabled
    FROM invoice_needs n
    LEFT JOIN vendor_profiles v ON v.id = n.vendor_profile_id
    LEFT JOIN scraper_accounts s ON s.id = n.scraper_account_id
    WHERE n.bank_txn_id = ?
  `).get(req.params.txnId)
  res.json(row || null)
})

// Déclenche la tournée du portail qui doit fournir cette facture. La tournée est
// forcément celle du compte entier (une session, un navigateur) : elle traitera
// aussi les autres transactions en attente du même fournisseur.
router.post('/needs/transaction/:txnId/collect', (req, res) => {
  refreshInvoiceNeeds()
  const need = db.prepare('SELECT * FROM invoice_needs WHERE bank_txn_id = ?').get(req.params.txnId)
  if (!need?.scraper_account_id) {
    return res.status(400).json({ error: "Aucun collecteur pour le fournisseur de cette transaction" })
  }
  if (isRunning(need.scraper_account_id)) return res.status(409).json({ error: 'Une tournée est déjà en cours' })
  // Le besoin est peut-être en pause après plusieurs échecs : une demande
  // explicite de l'utilisateur remet le compteur à zéro.
  db.prepare('UPDATE invoice_needs SET attempts = 0, status = ?, updated_at = ? WHERE id = ?')
    .run('en_attente', nowIso(), need.id)
  runScraper({ accountId: need.scraper_account_id, trigger: 'manual', userId: req.user?.id })
    .catch(e => console.error('❌ scraper:', e.message))
  res.json({ ok: true, started: true })
})

// Capture d'écran d'une tournée (diagnostic quand un sélecteur casse).
router.get('/runs/:runId/artifacts/:name', (req, res) => {
  const { runId, name } = req.params
  if (!/^[\w.-]+$/.test(runId) || !/^[\w.-]+\.(png|html)$/.test(name)) {
    return res.status(400).json({ error: 'Nom de fichier invalide' })
  }
  const path = join(artifactsRoot, runId, name)
  if (!existsSync(path)) return res.status(404).json({ error: 'Artefact introuvable' })
  res.sendFile(path)
})

router.post('/accounts', requireAdmin, (req, res) => {
  const { vendor, label, username, password, totp_secret, lookback_days, enabled,
    vendor_profile_id: vendorProfileId, collect_mode: collectMode } = req.body || {}
  if (!SCRAPERS[vendor]) return res.status(400).json({ error: 'Fournisseur non pris en charge' })
  if (!username || !password) return res.status(400).json({ error: 'Courriel et mot de passe requis' })

  const id = newRecordId()
  db.prepare(`
    INSERT INTO scraper_accounts (id, vendor, label, username, password_enc, totp_secret_enc,
      lookback_days, enabled, vendor_profile_id, collect_mode, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, vendor, label || `${VENDOR_LABELS[vendor]} — ${username}`, username,
    encryptCredentials(password), totp_secret ? encryptCredentials(totp_secret) : null,
    Number(lookback_days) || 60, enabled === false ? 0 : 1,
    vendorProfileId || null, collectMode === 'fenetre' ? 'fenetre' : 'ciblee',
    req.user?.id || null,
  )
  res.status(201).json(publicAccount(getAccount(id)))
})

router.patch('/accounts/:id', requireAdmin, (req, res) => {
  const account = getAccount(req.params.id)
  if (!account) return res.status(404).json({ error: 'Compte introuvable' })

  const body = { ...req.body }
  // Changer le mot de passe ou le courriel invalide la session persistée :
  // la garder ferait échouer la prochaine tournée sur une session orpheline.
  let resetSession = false
  if (body.password !== undefined) {
    body.password_enc = body.password ? encryptCredentials(body.password) : null
    delete body.password
    resetSession = true
  }
  if (body.totp_secret !== undefined) {
    body.totp_secret_enc = body.totp_secret ? encryptCredentials(body.totp_secret) : null
    delete body.totp_secret
  }
  if (body.username !== undefined) resetSession = true
  if (body.enabled !== undefined) body.enabled = body.enabled ? 1 : 0
  if (resetSession) { body.storage_state_enc = null; body.storage_state_at = null }
  body.updated_at = nowIso()

  const { setClause, values, error } = buildPartialUpdate(body, {
    allowed: ['label', 'username', 'password_enc', 'totp_secret_enc', 'lookback_days',
      'enabled', 'schedule_cron', 'storage_state_enc', 'storage_state_at',
      'vendor_profile_id', 'collect_mode', 'updated_at'],
    coerce: {
      lookback_days: v => Math.min(Math.max(Number(v) || 60, 1), 730),
      collect_mode: v => (v === 'fenetre' ? 'fenetre' : 'ciblee'),
    },
  })
  if (error) return res.status(400).json({ error })
  if (!setClause) return res.json(publicAccount(account))
  db.prepare(`UPDATE scraper_accounts SET ${setClause} WHERE id = ?`).run(...values, req.params.id)
  res.json(publicAccount(getAccount(req.params.id)))
})

router.delete('/accounts/:id', requireAdmin, (req, res) => {
  const account = getAccount(req.params.id)
  if (!account) return res.status(404).json({ error: 'Compte introuvable' })
  db.prepare('UPDATE scraper_accounts SET deleted_at=?, enabled=0 WHERE id=?').run(nowIso(), req.params.id)
  res.json({ ok: true })
})

// Importer une session ouverte à la main. Seule voie pour un portail dont le
// formulaire est protégé par un captcha (Wix) ou passe par une connexion Google,
// que le collecteur ne peut pas franchir lui-même.
router.post('/accounts/:id/session', requireAdmin, (req, res) => {
  const account = getAccount(req.params.id)
  if (!account) return res.status(404).json({ error: 'Compte introuvable' })
  const domain = VENDOR_DOMAINS[account.vendor] || ''
  let state
  try {
    state = parseSessionPayload(req.body?.payload, domain.replace(/^\./, ''))
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }
  if (domain && !sessionCoversDomain(state, domain)) {
    return res.status(400).json({ error: `Aucun cookie de ${domain} dans cet export — exporter depuis l'onglet du portail, une fois connecté` })
  }
  db.prepare('UPDATE scraper_accounts SET storage_state_enc=?, storage_state_at=?, updated_at=? WHERE id=?')
    .run(encryptCredentials(JSON.stringify(state)), nowIso(), nowIso(), req.params.id)
  res.json({ ok: true, cookies: state.cookies.length })
})

// État de chaque portail, résumé en français — c'est ce que lit le bandeau du
// tableau de bord comptabilité, pour qu'une collecte cassée se voie sans venir
// ici.
router.get('/health', (req, res) => {
  res.json({ portals: collectionHealth(), summary: collectionHealthSummary() })
})

// ── Pont de session (module de navigateur) ──────────────────────────────────────────
//
// Plusieurs portails (Bell, DigiKey) posent un captcha sur leur écran de
// connexion : aucun navigateur sans humain ne le franchira jamais. Mais le
// captcha ne garde QUE la connexion — une session déjà ouverte dans le vrai
// navigateur de l'utilisateur suffit pour toutes les tournées suivantes.
//
// Le module de navigateur (dossier browser-extension/) lit les cookies de chaque
// domaine de collecte — httpOnly compris, ce que le collage Cookie-Editor
// rate — et les dépose ici, puis lance la collecte. Un clic, tous les portails.

// Le module lui-même, en un fichier. Le dépôt n'est cloné que sur le serveur :
// sans ça, il n'y a aucun moyen d'obtenir les fichiers sur son poste. Le lien
// porte le jeton en paramètre (requireAuth l'accepte sur un GET), donc un clic
// suffit depuis la page.
router.get('/session-bridge/module', (req, res) => {
  const source = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'browser-extension')
  if (!existsSync(source)) return res.status(404).json({ error: 'Module introuvable sur le serveur' })
  const out = join(tmpdir(), `orisha-pont-session-${Date.now()}.zip`)
  // `-j` aplatit : l'utilisateur décompresse et charge le dossier obtenu, sans
  // niveau intermédiaire qui ferait rater le manifeste.
  execFile('zip', ['-j', '-q', '-r', out, source], (err) => {
    if (err) return res.status(500).json({ error: `Compression impossible : ${err.message}` })
    res.download(out, 'orisha-pont-session.zip', () => { try { unlinkSync(out) } catch { /* déjà parti */ } })
  })
})

// Ce que le module doit aller chercher, et où en est chaque portail.
router.get('/session-bridge/targets', (req, res) => {
  const rows = db.prepare(`
    SELECT id, vendor, label, storage_state_at, enabled
    FROM scraper_accounts WHERE deleted_at IS NULL AND enabled = 1
  `).all()
  res.json(rows.map(r => ({
    account_id: r.id,
    vendor: r.vendor,
    label: r.label || VENDOR_LABELS[r.vendor] || r.vendor,
    domains: BRIDGE_DOMAINS[r.vendor] || [],
    session_at: r.storage_state_at,
    // Le collecteur refuse de tourner sans session importée sur ces portails.
    session_required: !!SCRAPERS[r.vendor]?.requiresImportedSession,
  })).filter(t => t.domains.length))
})

// Une session qui arrive est le seul instant où l'on est certain que le portail
// est ouvert et valide. Si une facture est attendue sur ce fournisseur, la
// collecte part TOUT DE SUITE : autrement la session attendait la tournée
// suivante, et à Bell elle avait le temps de mourir avant.
const AUTO_COLLECT_COOLDOWN_MS = 15 * 60_000

function collectAfterPush(account) {
  if (isRunning(account.id)) return false
  const last = db.prepare('SELECT MAX(started_at) AS at FROM scraper_runs WHERE account_id = ?').get(account.id)?.at
  if (last && Date.now() - new Date(last).getTime() < AUTO_COLLECT_COOLDOWN_MS) return false
  refreshInvoiceNeeds()
  // En mode ciblé, rien à aller chercher tant qu'aucun débit n'attend sa pièce.
  if (account.collect_mode !== 'fenetre' && !dueNeedsForAccount(account.id).length) return false
  runScraper({ accountId: account.id, trigger: 'session' })
    .catch(e => console.error('❌ scraper (session):', e.message))
  return true
}

// Dépôt d'une session. Même normalisation et même chiffrement que l'import
// manuel ci-dessus — parseSessionPayload accepte déjà un tableau de cookies
// d'extension.
router.post('/session-bridge/push', (req, res) => {
  const account = getAccount(req.body?.account_id)
  if (!account) return res.status(404).json({ error: 'Compte introuvable' })
  const domain = VENDOR_DOMAINS[account.vendor] || ''
  let state
  try {
    // Les témoins ne suffisent pas partout : MyBell (Auth0) garde son jeton
    // dans le stockage local de la page, pas dans un cookie. Le module envoie
    // donc AUSSI `origins` — la forme d'un storageState Playwright, que
    // parseSessionPayload sait déjà lire.
    const payload = { cookies: req.body?.cookies || [], origins: req.body?.origins || [] }
    state = parseSessionPayload(JSON.stringify(payload), domain.replace(/^\./, ''))
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }
  if (domain && !sessionCoversDomain(state, domain)) {
    return res.status(400).json({ error: `Aucun cookie de ${domain} — ouvrir le portail et se connecter, puis recommencer` })
  }
  db.prepare('UPDATE scraper_accounts SET storage_state_enc=?, storage_state_at=?, updated_at=? WHERE id=?')
    .run(encryptCredentials(JSON.stringify(state)), nowIso(), nowIso(), account.id)
  res.json({
    ok: true, vendor: account.vendor,
    cookies: state.cookies.length, origins: state.origins.length,
    collecting: collectAfterPush(getAccount(account.id)),
  })
})

// Le bouton « Tout récolter ». Les portails défilent l'un après l'autre : un
// seul Chromium à la fois sur une machine qui fait déjà tourner l'API.
router.post('/session-bridge/collect', (req, res) => {
  refreshInvoiceNeeds()
  const queued = db.prepare(`
    SELECT vendor, label, (storage_state_enc IS NOT NULL) AS has_session
    FROM scraper_accounts WHERE deleted_at IS NULL AND enabled = 1
  `).all().map(a => ({
    vendor: a.vendor,
    label: a.label || VENDOR_LABELS[a.vendor] || a.vendor,
    skipped: !a.has_session && !!SCRAPERS[a.vendor]?.requiresImportedSession,
  }))
  runAllScrapers('manual', { userId: req.user?.id })
    .catch(e => console.error('❌ scrapers:', e.message))
  res.json({ ok: true, started: true, portals: queued })
})

// Oublier la session : force une reconnexion complète (utile si le portail
// répond « session expirée » en boucle).
router.post('/accounts/:id/forget-session', requireAdmin, (req, res) => {
  if (!getAccount(req.params.id)) return res.status(404).json({ error: 'Compte introuvable' })
  db.prepare('UPDATE scraper_accounts SET storage_state_enc=NULL, storage_state_at=NULL, updated_at=? WHERE id=?')
    .run(nowIso(), req.params.id)
  res.json({ ok: true })
})

// La tournée tourne en tâche de fond : elle peut durer plusieurs minutes et
// s'interrompre en attente d'un code 2FA.
router.post('/accounts/:id/run', (req, res) => {
  const account = getAccount(req.params.id)
  if (!account) return res.status(404).json({ error: 'Compte introuvable' })
  if (isRunning(account.id)) return res.status(409).json({ error: 'Une tournée est déjà en cours' })
  runScraper({ accountId: account.id, trigger: 'manual', userId: req.user?.id })
    .catch(e => console.error('❌ scraper:', e.message))
  res.json({ ok: true, started: true })
})

router.post('/run-all', requireAdmin, (req, res) => {
  runAllScrapers('manual').catch(e => console.error('❌ scrapers:', e.message))
  res.json({ ok: true, started: true })
})

// Réponse à un défi 2FA : le collecteur en attente sonde cette colonne.
router.post('/accounts/:id/otp', (req, res) => {
  const account = getAccount(req.params.id)
  if (!account) return res.status(404).json({ error: 'Compte introuvable' })
  const code = String(req.body?.code || '').trim()
  if (!/^\d{4,10}$/.test(code)) return res.status(400).json({ error: 'Code invalide' })
  db.prepare('UPDATE scraper_accounts SET otp_code=?, updated_at=? WHERE id=?').run(code, nowIso(), req.params.id)
  res.json({ ok: true })
})

export default router
