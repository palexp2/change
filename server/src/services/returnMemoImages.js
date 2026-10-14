import fs from 'fs'
import path from 'path'
import sharp from 'sharp'
import { uploadsPath } from '../config/uploads.js'

// Images de l'aide-mémoire de retour (routes/retours.js POST /:id/memo).
// Toute erreur → null : une image manquante ne doit jamais casser le PDF.

// Charge un buffer image depuis une URL locale `/erp/api/attachments/...` ou
// `/api/attachments/...` (miroir Airtable, cf. reference_airtable_attachment_mirror) —
// lecture disque directe, pas de fetch HTTP. Une image Airtable synced peut
// être une liste séparée par des virgules (cf. RetourDetail.jsx) : on ne
// prend que la première.
export function loadAttachmentBuffer(value) {
  if (!value) return null
  const url = String(value).split(',')[0].trim()
  const marker = '/api/attachments/'
  const idx = url.indexOf(marker)
  if (idx === -1) return null
  const relPath = url.slice(idx + marker.length)
  const filePath = uploadsPath('attachments', relPath)
  try { return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null } catch { return null }
}

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i

// Valeur d'un champ pièce jointe d'une fiche, sous l'une de ses deux formes :
// - chemins miroir `/erp/api/attachments/airtable/<fichier>` (séparés par ', ') ;
// - tableau JSON `[{id,name,size,type}]` (champ perso 'attachment', fichiers
//   dans attachments/fields/<fieldId>/<recordId>/<id>, cf. custom-field-files.js).
// Une URL Airtable brute (expire en 410) est ignorée.
export function loadFieldAttachmentBuffer(value, fieldId, recordId) {
  if (!value) return null
  const raw = String(value).trim()
  if (!raw.startsWith('[')) return loadAttachmentBuffer(raw)
  if (!fieldId || !recordId) return null
  try {
    const files = JSON.parse(raw)
    const file = (Array.isArray(files) ? files : []).find(f =>
      f?.id && (String(f.type || '').startsWith('image/') || IMAGE_EXT.test(f.name || f.id)))
    if (!file) return null
    const filePath = uploadsPath('attachments', 'fields', String(fieldId), String(recordId), path.basename(String(file.id)))
    return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null
  } catch { return null }
}

// pdfkit ne lit que PNG et JPEG : tout autre format (webp, gif…) est converti en PNG.
export async function toPdfImage(buf) {
  if (!buf || !buf.length) return null
  const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47
  const isJpeg = buf[0] === 0xff && buf[1] === 0xd8
  if (isPng || isJpeg) return buf
  try { return await sharp(buf).png().toBuffer() } catch { return null }
}
