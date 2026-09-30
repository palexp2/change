// Doublons d'entreprises : détection en lot et fusion.
//
// Détection — une entreprise se rapproche d'une autre par son nom normalisé
// (accents, ponctuation et formes juridiques « inc », « ltée », « s.e.n.c. »…
// retirés), son courriel, le domaine de son courriel/site (hors webmails) ou
// son NEQ. Les paires marquées « pas un doublon » ne sont plus proposées.
//
// Fusion — la fiche gardée absorbe les autres : ses champs vides se complètent,
// les champs choisis par l'utilisateur viennent de l'absorbée, et TOUT ce qui
// pointe vers l'absorbée (contacts, commandes, projets, factures… trouvés par
// les FK déclarées, plus les champs lien texte vers `companies`) est rattaché à
// la gardée. L'absorbée passe à la corbeille. `company_merges` garde l'alias
// Airtable : le sync qui relie encore un record à l'ancienne fiche retombe sur
// la gardée (lookupCompany).
import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { normalizeEmail } from '../utils/duplicateMatch.js'

const LEGAL_WORDS = new Set([
  'inc', 'ltd', 'ltee', 'limitee', 'limited', 'llc', 'llp', 'lp', 'plc', 'enr', 'senc', 'sencrl',
  'corp', 'corporation', 'co', 'cie', 'sa', 'sas', 'gmbh', 'the',
])

const WEBMAIL = new Set([
  'gmail.com', 'hotmail.com', 'hotmail.ca', 'outlook.com', 'live.com', 'live.ca', 'msn.com',
  'yahoo.com', 'yahoo.ca', 'yahoo.fr', 'icloud.com', 'me.com', 'aol.com', 'videotron.ca',
  'bell.net', 'sympatico.ca', 'globetrotter.net', 'cgocable.ca', 'cogeco.ca', 'telus.net',
  'shaw.ca', 'rogers.com', 'protonmail.com', 'proton.me', 'outlook.fr', 'hotmail.fr', 'orange.fr',
  'free.fr', 'b2b2c.ca', 'xplornet.com', 'mail.com', 'gmx.com',
])

export function companyNameKey(name) {
  const s = String(name ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' et ').replace(/[^a-z0-9]+/g, ' ').trim()
  if (!s) return ''
  // « s.e.n.c. » → s e n c → senc : on recolle les lettres isolées consécutives.
  const words = []
  let letters = ''
  for (const w of s.split(' ')) {
    if (w.length === 1) { letters += w; continue }
    if (letters) { words.push(letters); letters = '' }
    words.push(w)
  }
  if (letters) words.push(letters)
  const key = words.filter(w => !LEGAL_WORDS.has(w)).join(' ')
  return key.length >= 3 ? key : ''
}

function domainOf(row) {
  const raw = row.domain || (normalizeEmail(row.email).split('@')[1]) || ''
  const d = String(raw).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]
  if (!d || !d.includes('.') || WEBMAIL.has(d)) return ''
  return d
}

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`)

// Un seau plus gros que ça est une valeur générique (« n/a », un domaine
// d'hébergeur…), pas un doublon.
const MAX_BUCKET = 8

export function findDuplicateGroups() {
  const cols = new Set(db.pragma('table_info(companies)').map(c => c.name))
  const opt = c => (cols.has(c) ? c : `NULL AS ${c}`)
  const rows = db.prepare(`
    SELECT id, name, email, city, province, lifecycle_phase, created_at, airtable_id,
           ${opt('domain')}, ${opt('neq')}
    FROM companies WHERE deleted_at IS NULL
  `).all()
  const dismissed = new Set(
    db.prepare('SELECT a_id, b_id FROM company_duplicate_dismissals').all().map(r => pairKey(r.a_id, r.b_id))
  )

  const buckets = new Map()
  const put = (reason, value, id) => {
    if (!value) return
    const k = `${reason}\u0000${value}`
    if (!buckets.has(k)) buckets.set(k, { reason, ids: [] })
    buckets.get(k).ids.push(id)
  }
  for (const r of rows) {
    put('name', companyNameKey(r.name), r.id)
    put('email', normalizeEmail(r.email), r.id)
    put('domain', domainOf(r), r.id)
    put('neq', String(r.neq ?? '').replace(/\D/g, ''), r.id)
  }

  const parent = new Map()
  const find = x => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x) } return x }
  const reasonsById = new Map()
  for (const { reason, ids } of buckets.values()) {
    if (ids.length < 2 || ids.length > MAX_BUCKET) continue
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        if (dismissed.has(pairKey(ids[i], ids[j]))) continue
        for (const id of [ids[i], ids[j]]) {
          if (!parent.has(id)) parent.set(id, id)
          if (!reasonsById.has(id)) reasonsById.set(id, new Set())
          reasonsById.get(id).add(reason)
        }
        parent.set(find(ids[i]), find(ids[j]))
      }
    }
  }

  const byId = new Map(rows.map(r => [r.id, r]))
  const groups = new Map()
  for (const id of parent.keys()) {
    const root = find(id)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(id)
  }

  const allIds = [...parent.keys()]
  const counts = linkCounts(allIds)
  return [...groups.values()]
    .filter(ids => ids.length > 1)
    .map(ids => {
      const members = ids.map(id => {
        const r = byId.get(id)
        return {
          id, name: r.name, email: r.email, city: r.city, province: r.province,
          lifecycle_phase: r.lifecycle_phase, created_at: r.created_at, airtable: !!r.airtable_id,
          counts: counts.get(id) || {},
        }
      })
      // La plus liée d'abord : c'est elle qu'on propose de garder.
      const weight = m => Object.values(m.counts).reduce((a, b) => a + b, 0)
      members.sort((a, b) => weight(b) - weight(a) || String(a.created_at).localeCompare(String(b.created_at)))
      const reasons = [...new Set(ids.flatMap(id => [...(reasonsById.get(id) || [])]))]
      return { key: members[0].id, reasons, members }
    })
    .sort((a, b) => String(a.members[0].name || '').localeCompare(String(b.members[0].name || ''), 'fr', { sensitivity: 'base' }))
}

const COUNTED = [
  ['contacts', 'SELECT company_id id, COUNT(DISTINCT contact_id) n FROM contact_companies WHERE company_id IN (SELECT value FROM json_each(?)) GROUP BY company_id'],
  ['orders', 'SELECT company_id id, COUNT(*) n FROM orders WHERE deleted_at IS NULL AND company_id IN (SELECT value FROM json_each(?)) GROUP BY company_id'],
  ['projects', 'SELECT company_id id, COUNT(*) n FROM projects WHERE deleted_at IS NULL AND company_id IN (SELECT value FROM json_each(?)) GROUP BY company_id'],
  ['factures', 'SELECT company_id id, COUNT(*) n FROM factures WHERE company_id IN (SELECT value FROM json_each(?)) GROUP BY company_id'],
]

function linkCounts(ids) {
  const out = new Map()
  if (!ids.length) return out
  const json = JSON.stringify(ids)
  for (const [key, sql] of COUNTED) {
    let rows = []
    try { rows = db.prepare(sql).all(json) } catch { continue }
    for (const r of rows) {
      if (!out.has(r.id)) out.set(r.id, {})
      out.get(r.id)[key] = r.n
    }
  }
  return out
}

export function dismissDuplicates(ids, userId = null) {
  const list = [...new Set((ids || []).filter(Boolean))]
  const ins = db.prepare('INSERT OR IGNORE INTO company_duplicate_dismissals (a_id, b_id, dismissed_by) VALUES (?, ?, ?)')
  db.transaction(() => {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [a, b] = list[i] < list[j] ? [list[i], list[j]] : [list[j], list[i]]
        ins.run(a, b, userId)
      }
    }
  })()
  return list.length
}

// Champs proposés au choix quand les deux fiches ont chacune une valeur.
export const MERGE_FIELDS = [
  ['name', 'Nom'], ['lifecycle_phase', 'Phase'], ['email', 'Courriel'], ['address', 'Adresse'],
  ['city', 'Ville'], ['province', 'Province'], ['country', 'Pays'], ['currency', 'Devise'],
  ['language', 'Langue'], ['domain', 'Domaine'], ['neq', 'NEQ'], ['notes', 'Notes'],
  ['stripe_customer_id', 'Client Stripe'], ['quickbooks_customer_id', 'Client QuickBooks'],
  ['quickbooks_customer_id_usd', 'Client QuickBooks USD'], ['quickbooks_vendor_id', 'Fournisseur QuickBooks'],
]

const PROTECTED = new Set(['id', 'airtable_id', 'record_id', 'created_at', 'updated_at', 'deleted_at', 'extra_fields'])
const blank = v => v === null || v === undefined || (typeof v === 'string' && v.trim() === '')

// Références qui ne sont pas des FK déclarées.
const EXTRA_REFS = [
  ['stripe_invoice_queue', 'company_id'],
  ['greenhouse_leads', 'matched_company_id'],
]
// Tables de jointure : un lien déjà présent sur la gardée rend celui de
// l'absorbée superflu.
const JUNCTIONS = new Set(['contact_companies'])

function companyRefs() {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name)
  const refs = []
  for (const t of tables) {
    if (t === 'companies') continue
    let fks = []
    try { fks = db.pragma(`foreign_key_list("${t}")`) } catch { continue }
    for (const f of fks) if (f.table === 'companies') refs.push([t, f.from])
  }
  for (const [t, c] of EXTRA_REFS) {
    if (refs.some(([rt, rc]) => rt === t && rc === c)) continue
    try { if (db.pragma(`table_info("${t}")`).some(x => x.name === c)) refs.push([t, c]) } catch {}
  }
  return refs
}

// Champs lien texte vers les entreprises (« Entreprise » des billets, des
// retours…) : la valeur porte un record ID Airtable ou un id ERP, brut ou en
// tableau JSON.
function textLinkColumns() {
  const rows = db.prepare(`
    SELECT erp_table, column_name FROM custom_fields
    WHERE deleted_at IS NULL AND json_valid(options)
      AND json_extract(options, '$.link_display_target') = 'companies'
  `).all()
  return rows.filter(r => {
    try { return db.pragma(`table_info("${r.erp_table}")`).some(c => c.name === r.column_name) } catch { return false }
  })
}

function rewriteLinkValue(value, map) {
  const s = String(value)
  try {
    const arr = JSON.parse(s)
    if (Array.isArray(arr)) return JSON.stringify([...new Set(arr.map(v => map.get(v) ?? v))])
  } catch {}
  let out = s
  for (const [from, to] of map) out = out.split(from).join(to)
  return out
}

export function mergePreview(keepId, dropIds) {
  const keep = db.prepare('SELECT * FROM companies WHERE id=? AND deleted_at IS NULL').get(keepId)
  const drops = dropIds.map(id => db.prepare('SELECT * FROM companies WHERE id=? AND deleted_at IS NULL').get(id)).filter(Boolean)
  if (!keep || !drops.length) return null
  const fields = []
  for (const [col, label] of MERGE_FIELDS) {
    if (!(col in keep)) continue
    const values = [{ id: keep.id, value: keep[col] }, ...drops.map(d => ({ id: d.id, value: d[col] }))]
      .filter(v => !blank(v.value))
    if (new Set(values.map(v => String(v.value).trim())).size > 1) fields.push({ col, label, values })
  }
  return { keep: { id: keep.id, name: keep.name }, drops: drops.map(d => ({ id: d.id, name: d.name })), fields }
}

// pick : { colonne: id de la fiche dont prendre la valeur }.
export function mergeCompanies({ keepId, dropIds, pick = {}, userId = null }) {
  const ids = [...new Set((dropIds || []).filter(id => id && id !== keepId))]
  if (!keepId || !ids.length) throw Object.assign(new Error('Deux entreprises au moins'), { status: 400 })

  return db.transaction(() => {
    const get = db.prepare('SELECT * FROM companies WHERE id=? AND deleted_at IS NULL')
    const keep = get.get(keepId)
    if (!keep) throw Object.assign(new Error('Entreprise gardée introuvable'), { status: 404 })
    const drops = ids.map(id => {
      const d = get.get(id)
      if (!d) throw Object.assign(new Error(`Entreprise ${id} introuvable`), { status: 404 })
      return d
    })

    // 1. Valeurs de la fiche gardée.
    const columns = db.pragma('table_info(companies)').map(c => c.name).filter(c => !PROTECTED.has(c))
    const updates = {}
    for (const [col, srcId] of Object.entries(pick || {})) {
      if (!columns.includes(col)) continue
      const src = drops.find(d => d.id === srcId)
      if (src) updates[col] = src[col]
    }
    for (const col of columns) {
      if (col in updates || !blank(keep[col])) continue
      const src = drops.find(d => !blank(d[col]))
      if (src) updates[col] = src[col]
    }
    let extra = {}
    for (const r of [...drops].reverse().concat(keep)) {
      try { extra = { ...extra, ...(JSON.parse(r.extra_fields || '{}') || {}) } } catch {}
    }

    // Une valeur unique (fournisseur QuickBooks…) reprise de l'absorbée doit
    // d'abord la quitter.
    const uniqueCols = db.pragma('index_list(companies)').filter(i => i.unique)
      .map(i => db.pragma(`index_info("${i.name}")`).map(c => c.name))
      .filter(c => c.length === 1 && !PROTECTED.has(c[0])).map(c => c[0])
    for (const col of uniqueCols) {
      if (!(col in updates)) continue
      for (const d of drops) db.prepare(`UPDATE companies SET "${col}"=NULL WHERE id=?`).run(d.id)
    }

    // 2. Rattacher tout ce qui pointe vers les absorbées.
    const moved = {}
    const refs = companyRefs()
    for (const d of drops) {
      for (const [t, c] of refs) {
        const n = db.prepare(`UPDATE OR IGNORE "${t}" SET "${c}"=? WHERE "${c}"=?`).run(keep.id, d.id).changes
        if (n) moved[t] = (moved[t] || 0) + n
        const left = db.prepare(`SELECT COUNT(*) n FROM "${t}" WHERE "${c}"=?`).get(d.id).n
        if (!left) continue
        if (!JUNCTIONS.has(t)) throw new Error(`${t} : ${left} lien(s) impossibles à rattacher`)
        // Lien principal de l'absorbée → le lien déjà présent sur la gardée le devient.
        db.prepare(`
          UPDATE contact_companies SET is_primary=1
          WHERE company_id=? AND contact_id IN (SELECT contact_id FROM contact_companies WHERE company_id=? AND is_primary=1)
        `).run(keep.id, d.id)
        db.prepare(`DELETE FROM "${t}" WHERE "${c}"=?`).run(d.id)
      }

      const map = new Map([[d.id, keep.id]])
      if (d.airtable_id) map.set(d.airtable_id, keep.airtable_id || keep.id)
      for (const { erp_table: t, column_name: c } of textLinkColumns()) {
        const where = [...map.keys()].map(() => `instr(COALESCE("${c}", ''), ?) > 0`).join(' OR ')
        const rows = db.prepare(`SELECT rowid AS rid, "${c}" AS v FROM "${t}" WHERE ${where}`).all(...map.keys())
        const upd = db.prepare(`UPDATE "${t}" SET "${c}"=? WHERE rowid=?`)
        for (const r of rows) upd.run(rewriteLinkValue(r.v, map), r.rid)
        if (rows.length) moved[`${t}.${c}`] = (moved[`${t}.${c}`] || 0) + rows.length
      }
      try {
        const n = db.prepare('UPDATE projects SET vendeur_ref=? WHERE vendeur_ref=?').run(`company:${keep.id}`, `company:${d.id}`).changes
        if (n) moved['projects.vendeur_ref'] = (moved['projects.vendeur_ref'] || 0) + n
      } catch {}
    }

    // 3. Écrire la gardée, mettre les absorbées à la corbeille, tracer.
    const sets = Object.keys(updates)
    db.prepare(`
      UPDATE companies SET ${sets.map(c => `"${c}"=?, `).join('')}extra_fields=?,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id=?
    `).run(...sets.map(c => updates[c]), JSON.stringify(extra), keep.id)
    const trash = db.prepare("UPDATE companies SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?")
    const log = db.prepare(`
      INSERT INTO company_merges (id, kept_id, dropped_id, dropped_airtable_id, dropped_name, snapshot, moved, merged_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const d of drops) {
      trash.run(d.id)
      log.run(newRecordId(), keep.id, d.id, d.airtable_id || null, d.name || null, JSON.stringify(d), JSON.stringify(moved), userId)
    }
    return { keep_id: keep.id, dropped: drops.map(d => d.id), fields: sets, moved }
  })()
}

// Entreprise qui a absorbé `id` (en suivant les fusions successives), ou `id`.
export function resolveMergedCompanyId(id) {
  let cur = id
  try {
    const stmt = db.prepare('SELECT kept_id FROM company_merges WHERE dropped_id=? ORDER BY merged_at DESC LIMIT 1')
    for (let i = 0; i < 10; i++) {
      const m = stmt.get(cur)
      if (!m) break
      cur = m.kept_id
    }
  } catch {}
  return cur
}

// Alias Airtable : record ID d'une entreprise absorbée → id ERP de la gardée,
// ou null si ce record n'a jamais été fusionné (ou si la gardée a disparu).
export function mergedCompanyForAirtableId(airtableId) {
  if (!airtableId) return null
  try {
    const m = db.prepare('SELECT kept_id FROM company_merges WHERE dropped_airtable_id=? ORDER BY merged_at DESC LIMIT 1').get(airtableId)
    if (!m) return null
    const id = resolveMergedCompanyId(m.kept_id)
    return db.prepare('SELECT id FROM companies WHERE id=? AND deleted_at IS NULL').get(id)?.id || null
  } catch { return null }
}
