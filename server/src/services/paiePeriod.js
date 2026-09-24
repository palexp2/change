// Début de période d'une paie — la vérité est dans Airtable.
//
// `paies.period_start` a été démappée par la migration 051 : l'ERP ne
// l'importait plus et la comptabilisation la déduisait (fin − 13 jours, paie
// aux 2 semaines) en affichant un avertissement. Charles (2026-09-19) veut
// qu'on aille voir Airtable à chaque fois plutôt que de déduire : le champ
// « Période de paie » (« YYYY-MM-DD au YYYY-MM-DD ») est relu au sync et, si
// la colonne est encore vide au moment de comptabiliser, directement sur le
// record. La déduction ne reste que comme dernier recours (Airtable muet).
import db from '../db/database.js'
import { PAIES_UNMAPPED_AIRTABLE_FIELDS } from './airtableUiFieldMap.js'

const RANGE_RE = /(\d{4}-\d{2}-\d{2})\s*au\b/i

// « 2026-08-30 au 2026-09-12 » → '2026-08-30'.
export function parsePeriodRangeStart(value) {
  const raw = Array.isArray(value) ? value[0] : value
  const m = String(raw ?? '').match(RANGE_RE)
  return m ? m[1] : null
}

export function periodStartFromFields(fields) {
  return parsePeriodRangeStart(fields?.[PAIES_UNMAPPED_AIRTABLE_FIELDS.period_range])
}

// Relit le record Airtable de la paie et mémorise son début de période.
// Best-effort : renvoie null si la paie n'a pas de jumeau Airtable, si le
// connecteur est muet ou si le champ est vide — l'appelant retombe alors sur
// sa déduction.
export async function fetchPaiePeriodStart(paieId) {
  const paie = db.prepare('SELECT id, airtable_id FROM paies WHERE id=?').get(paieId)
  if (!paie?.airtable_id) return null
  try {
    const cfg = db.prepare("SELECT base_id, table_id FROM airtable_module_config WHERE module='paies'").get()
    if (!cfg?.base_id || !cfg?.table_id) return null
    const { getAccessToken, airtableFetch } = await import('../connectors/airtable.js')
    const token = await getAccessToken()
    if (!token) return null
    const rec = await airtableFetch(`/${cfg.base_id}/${cfg.table_id}/${paie.airtable_id}`, token)
    const start = periodStartFromFields(rec?.fields)
    if (!start) return null
    db.prepare('UPDATE paies SET period_start=? WHERE id=?').run(start, paie.id)
    return start
  } catch (e) {
    console.warn(`⚠️  Paie ${paieId} : début de période illisible sur Airtable — ${e.message}`)
    return null
  }
}

// Début de période garanti à jour : la colonne si elle est remplie, sinon
// Airtable. `null` = ni l'un ni l'autre.
export async function ensurePaiePeriodStart(paieId) {
  const current = db.prepare('SELECT period_start FROM paies WHERE id=?').get(paieId)?.period_start
  if (current) return current
  return fetchPaiePeriodStart(paieId)
}
