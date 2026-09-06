import db from '../db/database.js'
import { getAccessToken } from '../connectors/airtable.js'
import { fetchAllRecords } from './airtable.js'
import { resolveProjectVendeurRef } from './airtableNativeMappedColumns.js'

// ── Commissions d'un projet ────────────────────────────────────────────────
//
// La table Airtable « Commissions » est hors du périmètre du miroir (décision
// du 2026-09-03 : on ne branche plus de nouvelle table). Côté Boréal il ne
// reste donc que `projects.commissions`, une liste de record IDs. Ce service
// va lire ces lignes en direct dans Airtable au moment de l'affichage : rien
// n'est stocké, rien n'est écrit, la fiche projet montre ce que dit Airtable.

// Colonne Boréal → champ Airtable qui l'alimente. Le lecteur (`toRow`) s'en sert,
// et la page /champs/project_commissions l'affiche en lecture seule : sans elle,
// la colonne « Champ Airtable » manquait à cette table et le mapping semblait
// avoir disparu (cf. services/airtableDirectSources.js).
export const COMMISSION_AIRTABLE_FIELDS = {
  at_id: 'ID',
  beneficiary_label: 'Bénéficiaire',
  rate: 'Commission',
  amount: 'Commission $',
  paid_invoices: 'Total des factures payés',
  close_date: 'Date de fermeture',
}

const FALLBACK_BASE_ID = 'appB4Fehk9jYd4s4B'
const FALLBACK_TABLE_ID = 'tblO5aR5xGIh8xVih'
// « Employés et partenaires » : table des bénéficiaires, elle non plus n'est
// pas miroitée.
const FALLBACK_PARTNERS_TABLE_ID = 'tblE4igHH8qrmy5Mq'
// Champ titre de cette table, dans l'ordre où on le cherche.
const PARTNER_NAME_FIELDS = ['Nom complet', 'Nom', 'Name']

// Le cache évite de rappeler Airtable à chaque ouverture/fermeture du panneau.
// Court : la donnée vient d'ailleurs, on ne veut pas la voir figée.
const TTL_MS = 60_000
const cache = new Map() // clé = record IDs joints → { at, data }

// Les noms des bénéficiaires bougent beaucoup moins que les montants : cache
// séparé, sans expiration (une poignée d'enregistrements, remis à zéro au
// redémarrage du serveur).
const partnerNames = new Map() // record ID Airtable → nom (ou null si inconnu)

// base/table du lien « Commissions » : lus dans le mapping Airtable des projets
// (options.linked_table_id) plutôt que codés en dur — si le lien change de
// table dans Airtable, la fiche suit.
function linkedTableOf(column) {
  const mapping = db.prepare(
    `SELECT module, options FROM airtable_field_mappings
     WHERE erp_table='projects' AND column_name=? LIMIT 1`
  ).get(column)
  if (!mapping) return { baseId: null, tableId: null }
  let tableId = null
  try { tableId = JSON.parse(mapping.options || '{}').linked_table_id || null } catch { /* options illisible */ }
  const mirror = db.prepare('SELECT base_id FROM airtable_mirrors WHERE id=?').get(mapping.module)
  return { baseId: mirror?.base_id || null, tableId }
}

// Une cellule Airtable de lien/lookup est un tableau ; un champ simple ne l'est
// pas. On aplatit toujours pour n'avoir qu'une règle de lecture.
function arr(val) {
  if (val === null || val === undefined) return []
  return Array.isArray(val) ? val : [val]
}

function firstNum(val) {
  for (const v of arr(val)) {
    const n = typeof v === 'number' ? v : parseFloat(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

function firstStr(val) {
  for (const v of arr(val)) {
    const s = typeof v === 'object' && v ? String(v.name || v.label || '') : String(v ?? '')
    if (s.trim()) return s.trim()
  }
  return null
}

function firstLink(val) {
  for (const v of arr(val)) {
    if (typeof v === 'string' && v.startsWith('rec')) return v
  }
  return null
}

/**
 * Noms des bénéficiaires. « Employés et partenaires » n'étant pas miroitée,
 * ses record IDs ne veulent rien dire dans Boréal : il faut aller y lire le
 * champ titre pour avoir un nom, puis retomber sur le résolveur du vendeur
 * (même table côté Airtable) pour le relier à un employé ou une entreprise.
 * Un échec ici ne fait pas échouer les commissions — on affiche les montants
 * sans le nom plutôt que rien du tout.
 */
async function loadPartnerNames(ids, baseId, token) {
  const missing = ids.filter(id => !partnerNames.has(id))
  if (!missing.length) return
  const { tableId } = linkedTableOf('vendeur')
  try {
    const records = await fetchAllRecords(baseId, tableId || FALLBACK_PARTNERS_TABLE_ID, token, null, missing)
    for (const rec of records) {
      const f = rec.fields || {}
      const name = PARTNER_NAME_FIELDS.map(k => firstStr(f[k])).find(Boolean) || null
      partnerNames.set(rec.id, name)
    }
  } catch (e) {
    console.warn(`⚠️  commissions : noms des bénéficiaires illisibles — ${e.message}`)
  }
  // Un ID resté sans réponse (droit manquant, enregistrement supprimé) est
  // mémorisé comme inconnu : inutile de le redemander à chaque affichage.
  for (const id of missing) if (!partnerNames.has(id)) partnerNames.set(id, null)
}

// Règle de design des champs référence : le bénéficiaire s'affiche comme un
// lien vers sa fiche quand l'employé ou l'entreprise existe dans Boréal.
function beneficiary(recId) {
  const name = recId ? partnerNames.get(recId) : null
  if (!name) return { beneficiary_label: null, beneficiary_href: null }
  const ref = resolveProjectVendeurRef(name)
  if (ref?.startsWith('employee:')) {
    const eid = ref.slice(9)
    const e = db.prepare('SELECT first_name, last_name FROM employees WHERE id=?').get(eid)
    if (e) {
      return {
        beneficiary_label: [e.first_name, e.last_name].filter(Boolean).join(' '),
        beneficiary_href: `/employees/${eid}`,
      }
    }
  } else if (ref?.startsWith('company:')) {
    const cid = ref.slice(8)
    const c = db.prepare('SELECT name FROM companies WHERE id=?').get(cid)
    if (c) return { beneficiary_label: c.name, beneficiary_href: `/companies/${cid}` }
  }
  // Nom sans correspondance dans Boréal : affichable, mais rien à ouvrir.
  return { beneficiary_label: name, beneficiary_href: null }
}

function toRow(rec) {
  const f = rec.fields || {}
  const F = COMMISSION_AIRTABLE_FIELDS
  return {
    id: rec.id,
    at_id: firstStr(f[F.at_id]) || rec.id,
    ...beneficiary(firstLink(f[F.beneficiary_label])),
    // Airtable stocke un pourcentage en fraction (0,025 = 2,5 %).
    rate: firstNum(f[F.rate]),
    amount: firstNum(f[F.amount]),
    paid_invoices: firstNum(f[F.paid_invoices]),
    close_date: firstStr(f[F.close_date]),
  }
}

/**
 * @param {string|null} commissionsCell — contenu de `projects.commissions`
 *   (JSON d'un tableau de record IDs Airtable, tel qu'importé).
 * @returns {Promise<Array>} lignes prêtes à afficher, triées par date de
 *   fermeture décroissante.
 */
export async function fetchProjectCommissions(commissionsCell) {
  let ids = []
  try {
    const parsed = JSON.parse(commissionsCell || '[]')
    ids = (Array.isArray(parsed) ? parsed : []).filter(v => typeof v === 'string' && v.startsWith('rec'))
  } catch { ids = [] }
  if (!ids.length) return []

  const key = [...ids].sort().join(',')
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data

  const src = linkedTableOf('commissions')
  const baseId = src.baseId || FALLBACK_BASE_ID
  const token = await getAccessToken()
  const records = await fetchAllRecords(baseId, src.tableId || FALLBACK_TABLE_ID, token, null, ids)

  const beneficiaryIds = [...new Set(records.map(r => firstLink(r.fields?.['Bénéficiaire'])).filter(Boolean))]
  await loadPartnerNames(beneficiaryIds, baseId, token)

  const data = records.map(toRow)
    .sort((a, b) => String(b.close_date || '').localeCompare(String(a.close_date || '')))

  if (cache.size > 500) cache.clear() // borne mémoire : le TTL est court, on repart à zéro
  cache.set(key, { at: Date.now(), data })
  return data
}
