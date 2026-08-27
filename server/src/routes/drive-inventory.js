// Inventaire Drive de la comptabilité — recensement, analyse de pertinence et
// décisions. Aucune route de ce module n'importe de donnée métier : on lit des
// métadonnées et le contenu des onglets pour DÉCIDER, rien de plus.
import { Router } from 'express'
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import {
  startFullPass, isRunning, getState, DEFAULT_ACCOUNT_EMAIL, kindOfMime,
} from '../services/driveInventory.js'
import { ERP_MODULES } from '../services/driveInventoryAnalysis.js'

const router = Router()
router.use(requireAuth)

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
const DECISIONS = ['import', 'keep_drive', 'archive']
const STATUSES = ['synced', 'partial', 'candidate', 'ignore']

function hydrateItem(row) {
  let tabs = null
  let terms = []
  try { tabs = row.tabs ? JSON.parse(row.tabs) : null } catch {}
  try { terms = row.match_terms ? JSON.parse(row.match_terms) : [] } catch {}
  return { ...row, tabs, match_terms: terms }
}

function hydrateTab(row) {
  let header = []
  let sample = []
  let sections = []
  try { header = JSON.parse(row.header_json || '[]') } catch {}
  try { sample = JSON.parse(row.sample_json || '[]') } catch {}
  try { sections = JSON.parse(row.sections_json || '[]') } catch {}
  return { ...row, header, sample, sections }
}

function listItems() {
  const items = db.prepare(`
    SELECT i.*, u.name AS decided_by_name
    FROM drive_inventory_items i
    LEFT JOIN users u ON u.id = i.decided_by
    WHERE i.deleted_at IS NULL
    ORDER BY
      CASE i.status WHEN 'partial' THEN 0 WHEN 'candidate' THEN 1 WHEN 'synced' THEN 2 ELSE 3 END,
      COALESCE(i.modified_time, '') DESC,
      i.name COLLATE NOCASE
  `).all().map(hydrateItem)

  const tabs = db.prepare(`
    SELECT t.*, u.name AS decided_by_name
    FROM drive_inventory_tabs t
    LEFT JOIN users u ON u.id = t.decided_by
    WHERE t.deleted_at IS NULL
    ORDER BY t.item_id, t.tab_index
  `).all().map(hydrateTab)

  const byItem = new Map()
  for (const t of tabs) {
    if (!byItem.has(t.item_id)) byItem.set(t.item_id, [])
    byItem.get(t.item_id).push(t)
  }
  for (const i of items) i.tab_details = byItem.get(i.id) || []
  return items
}

// Les suggestions : les onglets que l'analyse retient pour l'import, du plus
// pertinent au moins, avec le classeur d'où ils viennent. C'est la réponse à
// « quels fichiers, et quels onglets dedans ? ».
function listSuggestions() {
  return db.prepare(`
    SELECT t.id, t.tab_name, t.rows_count, t.nature, t.status, t.relevance, t.target_module,
           t.suggestion, t.verdict, t.analysis_source, t.decision, t.decision_note, t.header_json,
           i.id AS item_id, i.name AS file_name, i.parent_folder_name, i.owner_name, i.owner_email,
           i.web_view_link, i.frequency, i.days_since_modified
    FROM drive_inventory_tabs t
    JOIN drive_inventory_items i ON i.id = t.item_id AND i.deleted_at IS NULL
    WHERE t.deleted_at IS NULL AND t.verdict = 'importer'
    ORDER BY t.relevance DESC, i.name COLLATE NOCASE, t.tab_index
  `).all().map(r => {
    let header = []
    try { header = JSON.parse(r.header_json || '[]') } catch {}
    return { ...r, header }
  })
}

function googleAccounts() {
  return db.prepare(`
    SELECT account_email FROM connector_oauth
    WHERE connector='google' AND refresh_token IS NOT NULL
    ORDER BY account_email COLLATE NOCASE
  `).all().map(r => r.account_email).filter(Boolean)
}

function stats(items) {
  const s = {
    total: items.length, synced: 0, partial: 0, candidate: 0, ignore: 0, decided: 0, undecided: 0,
    tabs_total: 0, tabs_synced: 0, tabs_partial: 0, tabs_candidate: 0, tabs_ignore: 0,
    tabs_to_import: 0, tabs_decided: 0,
  }
  for (const i of items) {
    if (s[i.status] != null) s[i.status]++
    if (i.decision) s.decided++
    else if (i.status === 'candidate' || i.status === 'partial') s.undecided++
    for (const t of i.tab_details || []) {
      s.tabs_total++
      const key = `tabs_${t.status}`
      if (s[key] != null) s[key]++
      if (t.verdict === 'importer') s.tabs_to_import++
      if (t.decision) s.tabs_decided++
    }
  }
  return s
}

router.get('/', (req, res) => {
  const items = listItems()
  res.json({
    items,
    stats: stats(items),
    suggestions: listSuggestions(),
    state: getState(),
    running: isRunning(),
    accounts: googleAccounts(),
    default_account: DEFAULT_ACCOUNT_EMAIL,
    modules: ERP_MODULES.map(([m]) => m),
    ai_available: Boolean(process.env.OPENAI_API_KEY),
  })
})

// Recensement complet : lecture du Drive, ouverture des classeurs candidats,
// puis analyse de pertinence. Plusieurs minutes → job en arrière-plan, la page
// suit `state.analysis_*`.
router.post('/scan', (req, res) => {
  const r = startFullPass({
    accountEmail: req.body?.account_email || null,
    analyze: req.body?.analyze !== false,
  })
  if (!r.started) return res.status(409).json({ error: r.reason })
  res.status(202).json({ started: true, state: getState() })
})

router.get('/status', (req, res) => {
  res.json({ running: isRunning(), state: getState() })
})

// Ajout manuel — un document que le compte connecté ne voit pas (Drive d'un
// tiers, fichier reçu par courriel) mais qui doit figurer dans l'inventaire.
router.post('/items', (req, res) => {
  const b = req.body || {}
  const name = String(b.name || '').trim()
  if (!name) return res.status(400).json({ error: 'name requis' })
  const status = STATUSES.includes(b.status) ? b.status : 'candidate'
  const fileId = String(b.drive_file_id || '').trim() || `manual:${randomUUID()}`
  const existing = db.prepare('SELECT id FROM drive_inventory_items WHERE drive_file_id = ? AND deleted_at IS NULL').get(fileId)
  if (existing) return res.status(409).json({ error: 'Ce document est déjà dans l\'inventaire' })
  const id = randomUUID()
  db.prepare(`
    INSERT INTO drive_inventory_items (
      id, drive_file_id, name, mime_type, kind, owner_email, web_view_link,
      parent_folder_name, frequency, status, status_reason, match_terms, source, last_seen_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,'[]','manual', ${NOW})
  `).run(id, fileId, name, b.mime_type || null, kindOfMime(b.mime_type), b.owner_email || null,
    b.web_view_link || null, b.parent_folder_name || null, b.frequency || 'inconnue',
    status, 'Ajouté à la main')
  const row = hydrateItem(db.prepare('SELECT * FROM drive_inventory_items WHERE id = ?').get(id))
  res.status(201).json({ ...row, tab_details: [] })
})

// Décision au niveau du FICHIER (autosave) — jamais écrasée par un re-scan.
router.patch('/items/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM drive_inventory_items WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  const upd = buildDecisionUpdate(req.body || {}, req.user.id)
  if (upd.error) return res.status(400).json({ error: upd.error })
  db.prepare(`UPDATE drive_inventory_items SET ${upd.sets.join(', ')}, updated_at = ${NOW} WHERE id = ?`)
    .run(...upd.values, req.params.id)
  const fresh = hydrateItem(db.prepare('SELECT * FROM drive_inventory_items WHERE id = ?').get(req.params.id))
  fresh.tab_details = db.prepare('SELECT * FROM drive_inventory_tabs WHERE item_id = ? AND deleted_at IS NULL ORDER BY tab_index')
    .all(req.params.id).map(hydrateTab)
  res.json(fresh)
})

// Décision au niveau de l'ONGLET (autosave) — la granularité qui compte :
// « importer l'onglet Abonn. de CTB - Suivi », pas « importer CTB - Suivi ».
router.patch('/tabs/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM drive_inventory_tabs WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  const upd = buildDecisionUpdate(req.body || {}, req.user.id)
  if (upd.error) return res.status(400).json({ error: upd.error })
  db.prepare(`UPDATE drive_inventory_tabs SET ${upd.sets.join(', ')}, updated_at = ${NOW} WHERE id = ?`)
    .run(...upd.values, req.params.id)
  res.json(hydrateTab(db.prepare('SELECT * FROM drive_inventory_tabs WHERE id = ?').get(req.params.id)))
})

// Fichiers et onglets partagent les mêmes champs de décision.
function buildDecisionUpdate(b, userId) {
  const sets = []
  const values = []
  if ('decision' in b) {
    const d = b.decision === null || b.decision === '' ? null : String(b.decision)
    if (d !== null && !DECISIONS.includes(d)) return { error: 'decision invalide' }
    sets.push('decision = ?', `decided_at = ${d ? NOW : 'NULL'}`, 'decided_by = ?')
    values.push(d, d ? userId : null)
  }
  if ('decision_note' in b) {
    const n = b.decision_note == null || String(b.decision_note).trim() === '' ? null : String(b.decision_note).trim()
    sets.push('decision_note = ?')
    values.push(n)
  }
  if ('status' in b) {
    if (!STATUSES.includes(b.status)) return { error: 'status invalide' }
    sets.push('status = ?', 'status_reason = ?')
    values.push(b.status, 'Statut corrigé à la main')
  }
  if (sets.length === 0) return { error: 'Aucun champ modifiable fourni' }
  return { sets, values }
}

router.delete('/items/:id', (req, res) => {
  const row = db.prepare('SELECT id FROM drive_inventory_items WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  db.prepare(`UPDATE drive_inventory_items SET deleted_at = ${NOW} WHERE id = ?`).run(req.params.id)
  db.prepare(`UPDATE drive_inventory_tabs SET deleted_at = ${NOW} WHERE item_id = ? AND deleted_at IS NULL`).run(req.params.id)
  res.json({ ok: true })
})

export default router
