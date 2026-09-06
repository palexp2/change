import { join } from 'path'
import { newRecordId } from '../utils/recordId.js'
import { createHash } from 'crypto'
import { writeFileSync } from 'fs'
import db from '../db/database.js'
import { runExtractionAndUpdate } from './saleReceiptExtraction.js'
import { emitEntity } from './realtimeEmitters.js'
import { ensureUploadsDir } from '../config/uploads.js'

// Point d'entrée commun « un fichier de facture → un reçu en extraction ».
// Utilisé par les collecteurs de portails (services/scrapers/*) ; le chemin
// Gmail garde le sien parce qu'il porte des colonnes de dédup propres au
// courriel (gmail_message_id, rfc822_message_id).

const receiptsDir = ensureUploadsDir('receipts')

export function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

// Même contenu déjà en base (facture téléchargée deux fois, ou déjà reçue par
// courriel) : on ne crée pas de doublon. Volontairement sans filtre
// `deleted_at IS NULL` — un reçu supprimé à la main ne doit pas revenir.
export function contentAlreadyImported(hash) {
  return !!db.prepare('SELECT id FROM sale_receipts WHERE content_sha256=?').get(hash)
}

/**
 * Écrit le fichier, crée le reçu et lance l'extraction IA en tâche de fond.
 * @param {Buffer} buffer contenu du fichier
 * @param {string} originalName nom lisible affiché dans l'UI
 * @param {string} ext extension avec le point (« .pdf »)
 * @param {string} source valeur de sale_receipts.source (« scraper:amazon »…)
 * @param {string|null} userId auteur attribué
 * @returns {{status:'imported'|'duplicate', id?:string, hash:string}}
 */
export function ingestReceiptBuffer({ buffer, originalName, ext = '.pdf', source = 'scraper', userId = null }) {
  const hash = sha256(buffer)
  const existing = db.prepare('SELECT id FROM sale_receipts WHERE content_sha256=?').get(hash)
  if (existing) return { status: 'duplicate', id: existing.id, hash }

  const id = newRecordId()
  const storedName = `${id}${ext}`
  const filePath = join(receiptsDir, storedName)
  writeFileSync(filePath, buffer)

  db.prepare(`
    INSERT INTO sale_receipts (id, filename, original_name, file_type, status, created_by, source, content_sha256)
    VALUES (?, ?, ?, ?, 'processing', ?, ?, ?)
  `).run(id, storedName, originalName || storedName, ext, userId, source, hash)

  const created = db.prepare('SELECT * FROM sale_receipts WHERE id=?').get(id)
  if (created) emitEntity('sale_receipt', 'created', id, { ...created, items: [] }, userId)

  runExtractionAndUpdate({ saleReceiptId: id, filePath, fileExt: ext, userId, trigger: 'scheduled' })
  return { status: 'imported', id, hash, filename: storedName }
}
