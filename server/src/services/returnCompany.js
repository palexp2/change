import db from '../db/database.js'
import { erpTableForAirtableTableId } from './airtableTableMap.js'

// L'entreprise d'un retour.
//
// `returns.company_id` a été droppée (migration 037 — « supprime tous les
// champs Airtable codés en dur ») : le retour ne porte plus de colonne codée en
// dur pour son client. Trois sources restent, dans cet ordre :
//
//  1. `return_items.company_id` — la clé cœur `company` du miroir
//     `retour_items`, renseignée par « Retourner tous les numéros de série »
//     et donc par 100 % des retours créés depuis l'ERP.
//  2. le champ « Entreprise » DU RETOUR lui-même — un champ lien miroité vers
//     la table Airtable des entreprises, celui qu'affiche la fiche. Sa colonne
//     n'est pas codée en dur : elle se retrouve dans les champs de `returns`
//     (`link_target_table = companies`, ou mapping Airtable dont la table liée
//     est celle des entreprises), pour qu'un renommage du champ ne la casse pas.
//  3. `serial_numbers.company_id` — dernier recours seulement : c'est le
//     PROPRIÉTAIRE ACTUEL du numéro de série, pas le client du retour. Un
//     appareil réexpédié depuis fait mentir cette source (125 des 317 retours
//     concernés donnaient une autre entreprise que celle de la fiche).
//
// Sans (2), les 288 vieux retours sans article rattaché à une entreprise
// n'avaient plus de client — donc plus aucune adresse proposée pour
// l'étiquette de retour, alors que la fiche affichait bien une entreprise.

const LINK_TTL_MS = 60_000
let linkCache = { at: 0, column: null }

function returnsHasColumn(column) {
  return db.prepare('PRAGMA table_xinfo(returns)').all().some(c => c.name === column)
}

// Colonne du champ « Entreprise » du retour, ou null s'il n'y en a plus.
// Mise en cache 60 s : la résolution coûte quelques requêtes et la définition
// des champs bouge rarement (mais elle bouge — pas de cache définitif).
export function returnCompanyLinkColumn() {
  if (Date.now() - linkCache.at < LINK_TTL_MS) return linkCache.column

  const fields = db.prepare(`
    SELECT cf.column_name, cf.link_target_table, m.options
      FROM custom_fields cf
      LEFT JOIN airtable_field_mappings m ON m.id = cf.airtable_mapping_id
     WHERE cf.erp_table = 'returns' AND cf.deleted_at IS NULL AND cf.kind = 'data'
     ORDER BY cf.sort_order, cf.name
  `).all()

  let column = null
  for (const f of fields) {
    if (f.link_target_table === 'companies') { column = f.column_name; break }
  }
  if (!column) {
    for (const f of fields) {
      let tableId = null
      try { tableId = JSON.parse(f.options || '{}').linked_table_id || null } catch { /* options illisible */ }
      if (!tableId || erpTableForAirtableTableId(tableId) !== 'companies') continue
      column = f.column_name
      break
    }
  }
  if (column && !returnsHasColumn(column)) column = null

  linkCache = { at: Date.now(), column }
  return column
}

// Premier identifiant d'une cellule de lien miroitée : les valeurs multiples
// sont stockées jointes par « , » (cf. services/airtable.js getVal).
const firstLinkId = (expr) => `NULLIF(TRIM(CASE WHEN instr(${expr}, ',') > 0
      THEN substr(${expr}, 1, instr(${expr}, ',') - 1) ELSE ${expr} END), '')`

// ⚠️ `returnRef` est répété plusieurs fois dans le SQL produit : passer un
// paramètre nommé (`@rid`), jamais un `?` positionnel.
export const RETURN_COMPANY_SQL = (returnRef) => {
  const fromItems = `(
  SELECT ri.company_id FROM return_items ri
   WHERE ri.return_id = ${returnRef} AND ri.company_id IS NOT NULL
   LIMIT 1)`

  const column = returnCompanyLinkColumn()
  const tok = column ? firstLinkId(`r_rc."${column}"`) : null
  const fromField = column ? `(
  SELECT co_rc.id FROM returns r_rc
    JOIN companies co_rc
      ON (co_rc.id = ${tok} OR co_rc.airtable_id = ${tok}) AND co_rc.deleted_at IS NULL
   WHERE r_rc.id = ${returnRef}
   LIMIT 1)` : null

  const fromSerial = `(
  SELECT sn.company_id FROM return_items ri
    JOIN serial_numbers sn ON sn.id = ri.serial_id
   WHERE ri.return_id = ${returnRef} AND sn.company_id IS NOT NULL
   LIMIT 1)`

  return `COALESCE(${[fromItems, fromField, fromSerial].filter(Boolean).join(', ')})`
}

export function returnCompanyId(returnId) {
  return db.prepare(`SELECT ${RETURN_COMPANY_SQL('@rid')} AS company_id`)
    .get({ rid: returnId })?.company_id || null
}
