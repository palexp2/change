import db from '../db/database.js'

// ── Airtable table_id → table ERP ───────────────────────────────────────────
//
// Chaque module de sync connaît l'id de la table Airtable qu'il miroite ; cette
// map fait le chemin inverse. Elle sert (a) au mapping de champs (pré-suggérer
// la table cible d'un champ lien, valider une cible), et (b) à savoir vers
// QUELLE table pointe un champ lien dont le mapping n'a pas de table cible
// configurée — l'`options.linked_table_id` du mapping le dit, et c'est la seule
// façon d'offrir une liste de candidats sur un champ lien qui n'a encore aucune
// valeur. Poser `link_target_table` sur le mapping ferait bien plus que
// renseigner l'UI : la sync RÉÉCRIRAIT les valeurs stockées (recXXXX → id
// Boréal), cassant les requêtes qui joignent sur airtable_id.

// Construit une map Airtable table_id → ERP table à partir des configs.
// Permet (a) de pré-suggérer la table cible pour un champ lien, et (b) de
// valider qu'une table cible référencée existe bien côté ERP.
export function buildAirtableTableToErp() {
  const m = new Map()
  const sync = db.prepare('SELECT contacts_table_id, companies_table_id FROM airtable_sync_config').get()
  if (sync?.contacts_table_id) m.set(sync.contacts_table_id, 'contacts')
  if (sync?.companies_table_id) m.set(sync.companies_table_id, 'companies')
  const projets = db.prepare('SELECT projects_table_id FROM airtable_projets_config').get()
  if (projets?.projects_table_id) m.set(projets.projects_table_id, 'projects')
  const orders = db.prepare('SELECT orders_table_id, items_table_id FROM airtable_orders_config').get()
  if (orders?.orders_table_id) m.set(orders.orders_table_id, 'orders')
  if (orders?.items_table_id) m.set(orders.items_table_id, 'order_items')
  const moduleToErp = {
    pieces: 'products', achats: 'purchases', billets: 'tickets', serials: 'serial_numbers',
    envois: 'shipments', soumissions: 'soumissions', retours: 'returns', retour_items: 'return_items',
    adresses: 'adresses', bom: 'bom_items', assemblages: 'assemblages', employees: 'employees',
    paies: 'paies', paie_items: 'paie_items', serial_changes: 'serial_state_changes',
  }
  for (const r of db.prepare('SELECT module, table_id FROM airtable_module_config').all()) {
    if (r.table_id && moduleToErp[r.module]) m.set(r.table_id, moduleToErp[r.module])
  }
  return m
}

// Table ERP miroir de la table Airtable `tableId`, ou null.
export function erpTableForAirtableTableId(tableId) {
  if (!tableId) return null
  return buildAirtableTableToErp().get(tableId) || null
}
