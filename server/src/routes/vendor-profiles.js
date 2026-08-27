import { Router } from 'express'
import { v4 as uuid } from 'uuid'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { normalizeVendorKey, serializeProfile, seedVendorProfiles, mergeVendorProfiles, findDuplicateProfileGroups, dismissDuplicateGroup } from '../services/vendorProfiles.js'

const router = Router()
router.use(requireAuth)

// Enrichit un profil du nombre d'abonnements actifs, du nombre de reçus et de la
// dernière comptabilisation connue (les particularités vivent sur le profil lui-même).
function enrich(profile, { subsByProfile, receiptsByProfile }) {
  const r = receiptsByProfile.get(profile.id)
  return {
    ...profile,
    active_subscriptions: subsByProfile.get(profile.id) || 0,
    receipt_count: r?.count || 0,
    last_receipt_date: r?.date || null,
    last_receipt_total: r?.total ?? null,
  }
}

// Les reçus sont rattachés par vendor_profile_id quand il est posé (survit aux
// fusions/renommages), sinon par nom d'entreprise (nom canonique OU alias du profil).
function buildContext() {
  const profiles = db.prepare('SELECT id, name, aliases FROM vendor_profiles WHERE deleted_at IS NULL').all().map(serializeProfile)
  const idByKey = new Map()
  for (const p of profiles) {
    const set = (k) => { if (k && !idByKey.has(k)) idByKey.set(k, p.id) }
    set(normalizeVendorKey(p.name))
    for (const a of p.aliases) set(normalizeVendorKey(a))
  }
  const subsByProfile = new Map()
  for (const s of db.prepare('SELECT vendor, COUNT(*) c FROM vendor_subscriptions WHERE deleted_at IS NULL AND active=1 GROUP BY vendor').all()) {
    const pid = idByKey.get(normalizeVendorKey(s.vendor))
    if (pid) subsByProfile.set(pid, (subsByProfile.get(pid) || 0) + s.c)
  }
  const receiptsByProfile = new Map()
  for (const r of db.prepare(`
    SELECT vendor_profile_id pid, company, COALESCE(receipt_date, substr(created_at,1,10)) date, total
    FROM sale_receipts WHERE deleted_at IS NULL
  `).all()) {
    const pid = r.pid || (r.company ? idByKey.get(normalizeVendorKey(r.company)) : null)
    if (!pid) continue
    const cur = receiptsByProfile.get(pid) || { count: 0, date: null, total: null }
    cur.count++
    if (!cur.date || r.date > cur.date) { cur.date = r.date; cur.total = r.total }
    receiptsByProfile.set(pid, cur)
  }
  return { subsByProfile, receiptsByProfile }
}

router.get('/', (req, res) => {
  const ctx = buildContext()
  const rows = db.prepare('SELECT * FROM vendor_profiles WHERE deleted_at IS NULL ORDER BY name COLLATE NOCASE').all()
  res.json({ data: rows.map(r => enrich(serializeProfile(r), ctx)) })
})

// Amorçage : profils créés depuis l'historique publié,
// défauts remplis depuis la dernière transaction par devise. Idempotent.
router.post('/seed', (req, res) => {
  try {
    res.json(seedVendorProfiles())
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Groupes de doublons probables (clés normalisées en préfixe l'une de l'autre ou
// identiques une fois les suffixes légaux retirés). Les groupes ignorés sont tus.
router.get('/duplicates', (req, res) => {
  const ctx = buildContext()
  res.json({ data: findDuplicateProfileGroups().map(g => g.map(p => enrich(p, ctx))) })
})

// Marque un groupe « pas des doublons » (persistant) : il ne sera re-proposé que si
// sa composition change (un nouveau profil rejoint le groupe). Body : { ids: [] }.
router.post('/duplicates/dismiss', (req, res) => {
  const ids = req.body?.ids
  if (!Array.isArray(ids) || ids.length < 2 || ids.some(i => typeof i !== 'string')) {
    return res.status(400).json({ error: 'ids: tableau d\'au moins 2 ids attendu' })
  }
  res.status(201).json({ id: dismissDuplicateGroup(ids) })
})

// Ré-active la détection pour un groupe précédemment ignoré.
router.delete('/duplicates/dismissals/:id', (req, res) => {
  const r = db.prepare(`UPDATE vendor_duplicate_dismissals SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=? AND deleted_at IS NULL`).run(req.params.id)
  if (!r.changes) return res.status(404).json({ error: 'Not found' })
  res.json({ ok: true })
})

// Fusionne des profils doublons dans le profil cible :id. Body : { sourceIds: [] }.
router.post('/:id/merge', (req, res) => {
  const sourceIds = req.body?.sourceIds
  if (!Array.isArray(sourceIds) || !sourceIds.length || sourceIds.some(s => typeof s !== 'string')) {
    return res.status(400).json({ error: 'sourceIds: tableau d\'ids attendu' })
  }
  if (sourceIds.includes(req.params.id)) return res.status(400).json({ error: 'Le profil cible ne peut pas être aussi une source' })
  try {
    res.json(enrich(mergeVendorProfiles(req.params.id, [...new Set(sourceIds)]), buildContext()))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

router.post('/', (req, res) => {
  const name = String(req.body?.name || '').trim()
  if (!name) return res.status(400).json({ error: 'Nom requis' })
  const dupe = db.prepare('SELECT id FROM vendor_profiles WHERE deleted_at IS NULL AND LOWER(TRIM(name))=LOWER(?)').get(name)
  if (dupe) return res.status(409).json({ error: 'Un profil existe déjà pour ce fournisseur' })
  const id = uuid()
  db.prepare('INSERT INTO vendor_profiles (id, name) VALUES (?,?)').run(id, name)
  res.status(201).json(enrich(serializeProfile(db.prepare('SELECT * FROM vendor_profiles WHERE id=?').get(id)), buildContext()))
})

const TEXT_FIELDS = new Set([
  'name', 'qb_vendor_id_cad', 'qb_vendor_id_usd', 'default_qb_type',
  'default_expense_account_id', 'default_payment_account_id_cad', 'default_payment_account_id_usd',
  'default_transaction_type', 'default_tax_code_id_cad', 'default_tax_code_id_usd', 'notes',
  // Particularités du fournisseur (ex-Google Doc « Fournisseurs_Particularités »).
  'usual_currency', 'payment_method', 'qb_category', 'description', 'particularites',
  // Commentaire type du paiement émis (re-proposé dans /paiements-emis).
  'payment_note',
])

router.patch('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM vendor_profiles WHERE id=? AND deleted_at IS NULL').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  const sets = []
  const values = []
  for (const key of Object.keys(req.body || {})) {
    if (TEXT_FIELDS.has(key)) {
      const v = req.body[key] == null ? null : String(req.body[key]).trim() || null
      if (key === 'name' && !v) return res.status(400).json({ error: 'Nom requis' })
      if (key === 'default_qb_type' && v && !['purchase', 'bill', 'cc_credit'].includes(v)) {
        return res.status(400).json({ error: 'default_qb_type: purchase|bill|cc_credit attendu' })
      }
      sets.push(`${key}=?`); values.push(v)
    } else if (key === 'payment_terms_days') {
      let v = req.body[key]
      if (v === '' || v == null) v = null
      else {
        v = Number(v)
        if (!Number.isInteger(v) || v < 0 || v > 365) return res.status(400).json({ error: 'payment_terms_days: entier 0-365 attendu' })
      }
      sets.push('payment_terms_days=?'); values.push(v)
    } else if (key === 'aliases' || key === 'bank_label_patterns') {
      const v = req.body[key]
      if (!Array.isArray(v) || v.some(a => typeof a !== 'string')) return res.status(400).json({ error: `${key}: tableau de chaînes attendu` })
      sets.push(`${key}=?`); values.push(JSON.stringify(v.map(a => a.trim()).filter(Boolean)))
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'Aucun champ modifiable fourni' })
  sets.push(`updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
  values.push(req.params.id)
  db.prepare(`UPDATE vendor_profiles SET ${sets.join(', ')} WHERE id=?`).run(...values)
  res.json(enrich(serializeProfile(db.prepare('SELECT * FROM vendor_profiles WHERE id=?').get(req.params.id)), buildContext()))
})

router.delete('/:id', (req, res) => {
  const r = db.prepare(`UPDATE vendor_profiles SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=? AND deleted_at IS NULL`).run(req.params.id)
  if (!r.changes) return res.status(404).json({ error: 'Not found' })
  res.json({ ok: true })
})

export default router
