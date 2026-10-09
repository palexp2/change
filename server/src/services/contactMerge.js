// Fusion de contacts en double (Charles, 2026-10-09 : James Douglass en deux
// fiches au même courriel). La fiche gardée complète ses champs vides avec ceux
// des absorbées ; tout ce qui pointe vers une absorbée (FK déclarées, colonnes
// « contact_id » non déclarées, champs lien texte vers les contacts) est
// rattaché à la gardée ; les absorbées passent à la corbeille.
import db from '../db/database.js'

const PROTECTED = new Set(['id', 'airtable_id', 'record_id', 'created_at', 'updated_at', 'deleted_at', 'extra_fields'])
const blank = v => v === null || v === undefined || (typeof v === 'string' && v.trim() === '')

export function realName(c) {
  const n = `${c.first_name || ''} ${c.last_name || ''}`.trim()
  return !!n && !/^inconnu$/i.test(n) && !n.includes('@')
}

function contactRefs() {
  const refs = []
  for (const { name: t } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
    if (t === 'contacts') continue
    let fks = [], cols = []
    try { fks = db.pragma(`foreign_key_list("${t}")`); cols = db.pragma(`table_info("${t}")`) } catch { continue }
    for (const f of fks) if (f.table === 'contacts') refs.push([t, f.from])
    for (const c of cols) {
      if (/^(.+_)?contact_id$/.test(c.name) && !refs.some(([rt, rc]) => rt === t && rc === c.name)) refs.push([t, c.name])
    }
  }
  return refs
}

function textLinkColumns() {
  return db.prepare(`
    SELECT erp_table, column_name FROM custom_fields
    WHERE deleted_at IS NULL AND json_valid(options) AND json_extract(options, '$.link_display_target') = 'contacts'
  `).all().filter(r => {
    try { return db.pragma(`table_info("${r.erp_table}")`).some(c => c.name === r.column_name) } catch { return false }
  })
}

export function mergeContacts({ keepId, dropIds }) {
  const ids = [...new Set((dropIds || []).filter(id => id && id !== keepId))]
  if (!keepId || !ids.length) throw Object.assign(new Error('Deux contacts au moins'), { status: 400 })
  return db.transaction(() => {
    const get = db.prepare('SELECT * FROM contacts WHERE id=? AND deleted_at IS NULL')
    const keep = get.get(keepId)
    if (!keep) throw Object.assign(new Error('Contact gardé introuvable'), { status: 404 })
    const drops = ids.map(id => get.get(id) || (() => { throw Object.assign(new Error(`Contact ${id} introuvable`), { status: 404 }) })())

    const updates = {}
    for (const col of db.pragma('table_info(contacts)').map(c => c.name).filter(c => !PROTECTED.has(c))) {
      if (!blank(keep[col])) continue
      const src = drops.find(d => !blank(d[col]))
      if (src) updates[col] = src[col]
    }

    // Nom de remplacement (« Inconnu », courriel, vide) : celui d'une absorbée qui a un vrai nom.
    if (!realName(keep)) {
      const src = drops.find(realName)
      if (src) { updates.first_name = src.first_name; updates.last_name = src.last_name }
    }

    const moved = {}
    const refs = contactRefs()
    const links = textLinkColumns().filter(r => r.erp_table !== 'contacts')
    for (const d of drops) {
      for (const [t, c] of refs) {
        const n = db.prepare(`UPDATE OR IGNORE "${t}" SET "${c}"=? WHERE "${c}"=?`).run(keep.id, d.id).changes
        if (n) moved[t] = (moved[t] || 0) + n
        // Lien déjà présent sur la gardée (entreprise…) : celui de l'absorbée est superflu.
        if (t === 'contact_companies') db.prepare('DELETE FROM contact_companies WHERE contact_id=?').run(d.id)
      }
      const keys = [d.id, ...(d.airtable_id ? [d.airtable_id] : [])]
      const to = { [d.id]: keep.id, ...(d.airtable_id ? { [d.airtable_id]: keep.airtable_id || keep.id } : {}) }
      for (const { erp_table: t, column_name: c } of links) {
        const rows = db.prepare(`SELECT rowid AS rid, "${c}" AS v FROM "${t}" WHERE ${keys.map(() => `instr(COALESCE("${c}",''), ?) > 0`).join(' OR ')}`).all(...keys)
        for (const r of rows) {
          let v = String(r.v)
          for (const k of keys) v = v.split(k).join(to[k])
          db.prepare(`UPDATE "${t}" SET "${c}"=? WHERE rowid=?`).run(v, r.rid)
        }
        if (rows.length) moved[`${t}.${c}`] = (moved[`${t}.${c}`] || 0) + rows.length
      }
    }

    const sets = Object.keys(updates)
    if (sets.length) db.prepare(`UPDATE contacts SET ${sets.map(c => `"${c}"=?`).join(', ')} WHERE id=?`).run(...sets.map(c => updates[c]), keep.id)
    const trash = db.prepare("UPDATE contacts SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?")
    for (const d of drops) trash.run(d.id)
    return { keep_id: keep.id, dropped: drops.map(d => d.id), fields: sets, moved }
  })()
}
