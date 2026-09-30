/**
 * 095 — Reprend 094 pour les liens stockés en texte brut.
 *
 * 094 ne lisait que les liens au format JSON (`["rec…"]`) ; les adresses dont
 * le lien ferme / facturation est un simple `rec…` (ou une liste séparée par
 * des virgules) restaient sans entreprise.
 */
import { mergedCompanyForAirtableId } from '../../services/companyMerge.js'

export const id = '095-adresses-company-from-plain-links'
export const description = 'adresses : company_id depuis les liens ferme / facturation en texte brut'

function firstId(raw) {
  if (!raw) return null
  try { const v = JSON.parse(raw); if (Array.isArray(v)) return v[0] || null } catch {}
  return String(raw).split(',').map(s => s.trim()).find(s => /^rec[A-Za-z0-9]{14}$/.test(s)) || null
}

export function up(db) {
  const rows = db.prepare(`SELECT id, entreprise_adresse_de_la_ferme_2 AS f2, entreprise_adresse_de_la_ferme AS f1,
    entreprise_adresse_de_factuation AS b FROM adresses WHERE company_id IS NULL`).all()
  const co = db.prepare('SELECT id, deleted_at FROM companies WHERE airtable_id=? LIMIT 1')
  const set = db.prepare('UPDATE adresses SET company_id=? WHERE id=?')
  let n = 0
  for (const r of rows) {
    const recId = firstId(r.f2) || firstId(r.f1) || firstId(r.b)
    if (!recId) continue
    const c = co.get(recId)
    const companyId = (c && !c.deleted_at) ? c.id : (mergedCompanyForAirtableId(recId) || c?.id)
    if (companyId) { set.run(companyId, r.id); n++ }
  }
  console.log(`↪ adresses : ${n} rattachées à leur entreprise (liens en texte brut)`)
}
