/**
 * 094 — Rattache à leur entreprise les adresses de ferme et de facturation.
 *
 * La synchro Airtable ne lisait que « Entreprise (Adresse de livraison) » :
 * les adresses liées par « Entreprise (adresse de la ferme) » ou
 * « Entreprise (adresse de factuation) » restaient sans company_id et
 * n'apparaissaient pas sur la fiche entreprise (~1 100 lignes).
 */
import { mergedCompanyForAirtableId } from '../../services/companyMerge.js'

export const id = '094-adresses-company-from-farm-billing-links'
export const description = 'adresses : company_id depuis les liens ferme / facturation'

function firstId(raw) {
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v[0] : null } catch { return null }
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
  console.log(`↪ adresses : ${n} rattachées à leur entreprise (ferme / facturation)`)
}
