// Document en trop d'une dépense déjà comptabilisée (facture + reçu de paiement,
// copie reçue par un autre canal…) : au lieu de le publier une seconde fois, on
// joint son fichier à la transaction QuickBooks existante, puis on l'archive.
// La transaction cible est celle que désigne receiptObsolescence.
import { readFileSync } from 'fs'
import db from '../db/database.js'
import { qbUploadAttachment, qbEntityUrl } from '../connectors/quickbooks.js'
import { receiptObsolescence } from './transactionAnomalies.js'
import { statementFiles, existingAttachmentNames } from './prepaidStatementAttach.js'

// Slug d'URL QB (receiptObsolescence.qb_entity) → entité de l'API Attachable.
const ATTACH_ENTITY = { expense: 'Purchase', creditcardcredit: 'Purchase', bill: 'Bill' }

export async function attachReceiptToExistingQb(receiptId) {
  const row = db.prepare('SELECT * FROM sale_receipts WHERE id=? AND deleted_at IS NULL').get(receiptId)
  if (!row) throw new Error('Document introuvable')
  if (row.quickbooks_id) throw new Error('Ce document est déjà publié lui-même')
  const ob = receiptObsolescence(receiptId)
  if (!ob?.qb_id || !ATTACH_ENTITY[ob.qb_entity]) throw new Error('Aucune transaction QuickBooks existante pour ce document')
  const files = statementFiles(row)
  if (!files.length) throw new Error('Fichier du document introuvable sur le serveur')

  const entityType = ATTACH_ENTITY[ob.qb_entity]
  const already = await existingAttachmentNames(entityType, ob.qb_id)
  let uploaded = 0
  for (const f of files) {
    if (already.has(f.name)) continue
    await qbUploadAttachment({
      entityType, entityId: ob.qb_id,
      fileBuffer: readFileSync(f.path), fileName: f.name, contentType: f.contentType,
    })
    uploaded++
  }
  return { qb_id: ob.qb_id, qb_entity: ob.qb_entity, qb_url: qbEntityUrl(ob.qb_entity, ob.qb_id), uploaded, skipped: files.length - uploaded }
}
