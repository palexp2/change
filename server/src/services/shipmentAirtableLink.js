// shipmentAirtableLink — miroir Airtable d'un envoi : articles expédiés + push.
//
// Deux services, tous deux appelés par les chemins qui modifient un envoi hors
// du PATCH de la fiche (achat d'étiquette Novoxpress, création depuis une
// commande, assignation d'un article à un envoi) :
//
//  1. `refreshShipmentItemsMirror` — la vérité de « quels articles partent dans
//     cet envoi » vit dans `order_items.shipment_id`, alors que le champ
//     Airtable « items expédiés » attend un tableau de record ids. La colonne
//     `shipments.items_expedies` est la colonne MIROIR de ce champ : elle
//     n'était remplie que par l'IMPORT, jamais recalculée depuis Boréal — un
//     envoi né ici n'avait donc aucun article lié côté Airtable.
//
//  2. `pushShipmentToAirtable` — writeBackRecord si l'envoi a déjà un jumeau
//     Airtable, createInAirtable sinon (chemin de rattrapage), avec la même
//     trace sync_log que les routes. Sans lui, l'achat d'étiquette écrivait le
//     numéro de suivi et le transporteur en base sans jamais les renvoyer.

import db from '../db/database.js'
import { writeBackRecord, createInAirtable } from './airtableWriteback.js'
import { logSync } from './syncLog.js'

// Colonne miroir du champ lien « items expédiés » — à passer dans
// `changedColumns` pour que le write-back inclue les articles.
export const SHIPMENT_ITEMS_COLUMN = 'items_expedies'

// Clés du champ lien pour les articles assignés à l'envoi : l'airtable_id quand
// la ligne a un jumeau, sinon son id Boréal — même forme que les autres colonnes
// lien poussables. `airtableLinkIds` résout les ids Boréal et SAUTE le champ si
// l'un d'eux n'a pas de jumeau, plutôt que de délier côté Airtable.
export function shipmentItemLinkKeys(shipmentId) {
  return db.prepare(`
    SELECT COALESCE(airtable_id, id) AS key FROM order_items
    WHERE shipment_id = ? ORDER BY rowid
  `).all(shipmentId).map(r => r.key)
}

// Recalcule `shipments.items_expedies` depuis les articles réellement assignés.
// Liste vide → on ne touche à RIEN par défaut : un envoi sans assignation locale
// (vieil envoi, envoi né dans Airtable) doit garder les articles qu'Airtable lui
// connaît. `allowEmpty` sert au seul cas où le vide est une décision de
// l'utilisateur (article retiré de l'envoi, envoi délié de sa commande).
export function refreshShipmentItemsMirror(shipmentId, { allowEmpty = false } = {}) {
  const keys = shipmentItemLinkKeys(shipmentId)
  if (!keys.length && !allowEmpty) return { keys, written: false }
  db.prepare('UPDATE shipments SET items_expedies = ? WHERE id = ?')
    .run(JSON.stringify(keys), shipmentId)
  return { keys, written: true }
}

// Pousse l'envoi vers Airtable (fire-and-forget : la promesse ne rejette jamais).
// Un envoi sans airtable_id est CRÉÉ — même chemin de rattrapage que le PATCH de
// la fiche, sinon un envoi né dans l'ERP resterait invisible côté Airtable.
export function pushShipmentToAirtable(shipmentId, changedColumns = null) {
  const row = db.prepare('SELECT airtable_id FROM shipments WHERE id = ?').get(shipmentId)
  const trigger = row?.airtable_id ? 'erp-writeback' : 'erp-create'
  const promise = row?.airtable_id
    ? writeBackRecord('envois', shipmentId, changedColumns)
    : createInAirtable('envois', shipmentId)
  return promise.catch(e => {
    console.error(`${trigger} envois ${shipmentId} (async):`, e.message)
    logSync('envois', trigger, { status: 'error', error: `${shipmentId}: ${e.message}` })
  })
}
