// Fichiers d'un champ personnalisé de type « Attachement ».
//
// Un champ perso `type='attachment'` stocke, dans sa colonne cf_* (TEXT), un
// tableau JSON décrivant les fichiers déposés :
//
//   [{ id: "<uuid>_<nom-assaini>", name: "facture.pdf", size: 12345, type: "application/pdf" }]
//
// Les octets vivent sous uploads/attachments/fields/<field_id>/<record_id>/<id>
// (convention CLAUDE.md : server/uploads/ pour tout fichier, jamais server/data/).
//
// Pourquoi une route dédiée plutôt que la route PATCH de chaque table : déposer
// un fichier est déjà une écriture serveur (multipart → disque). Faire écrire la
// colonne ICI rend le champ utilisable sur TOUTES les tables à champs perso sans
// que chacune ait à whitelister ses colonnes cf_ — et la valeur reste toujours
// cohérente avec ce qui est réellement sur le disque.

import { Router } from 'express'
import { randomUUID } from 'crypto'
import { makeUpload } from '../utils/upload.js'
import path from 'path'
import fs from 'fs'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { isColumnWritable } from '../services/customFieldWritability.js'
import { writebackModuleForTable } from '../services/airtableWriteback.js'
import { normalizeUploadName } from '../utils/uploadFileName.js'
import { uploadsPath } from '../config/uploads.js'

const router = Router()
router.use(requireAuth)

const UPLOADS_ROOT = uploadsPath()
const FIELD_FILES_DIR = path.join(UPLOADS_ROOT, 'attachments', 'fields')

// Même palette que les pièces jointes polymorphes (routes/attachments.js) : PDF,
// images, bureautique, archives.
const ALLOWED_EXT = [
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.heic', '.svg', '.pdf',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.csv', '.txt', '.zip',
]

// Un identifiant de fichier est le nom sur disque : `<uuid>_<nom assaini>`.
// Le valider avant toute manipulation de chemin ferme la traversée de répertoire.
const FILE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}_[^/\\]{1,220}$/i

function sanitizeFileName(name) {
  return String(name || 'fichier').replace(/[/\\?%*:|"<>]/g, '_').slice(0, 200) || 'fichier'
}

// Le champ visé existe-t-il, est-il bien un champ « Attachement », et sa table
// porte-t-elle l'enregistrement ? Retourne { field } ou une erreur portée par
// `status`.
//
// `write` : le contrôle de lecture seule ne concerne QUE les écritures. Un champ
// alimenté par Airtable (ex. « Photo » des employés) est en lecture seule côté
// ERP, mais ses fichiers doivent rester lisibles — c'est tout l'intérêt du
// miroir local. Refuser la lecture rendait la photo introuvable (l'ancienne
// version renvoyait l'erreur SANS `field`, et la route de service du fichier,
// qui tolère ce cas, plantait en 500 sur `field.column_name`).
function resolveTarget(fieldId, recordId, { write = true } = {}) {
  const field = db.prepare(
    `SELECT id, erp_table, column_name, type, kind, source, airtable_mapping_id
     FROM custom_fields WHERE id=? AND deleted_at IS NULL`
  ).get(fieldId)
  if (!field) return { error: 'Champ introuvable', status: 404 }
  if (field.type !== 'attachment' || (field.kind && field.kind !== 'data')) {
    return { error: "Ce champ n'est pas un champ Attachement", status: 400 }
  }
  // Un champ importé d'Airtable en sens « import » est en lecture seule côté ERP
  // (l'écriture serait écrasée au prochain sync) — même règle que partout.
  if (write) {
    const mapping = db.prepare(
      `SELECT id AS mapping_id, import_disabled FROM airtable_field_mappings
       WHERE erp_table=? AND column_name=?`
    ).get(field.erp_table, field.column_name)
    const writable = isColumnWritable(
      field.erp_table,
      { ...field, mapping_id: mapping?.mapping_id, import_disabled: mapping?.import_disabled },
      writebackModuleForTable(field.erp_table),
    )
    if (!writable) return { field, error: 'Champ en lecture seule (importé d\'Airtable)', status: 409 }
  }

  if (!recordId) return { error: 'Enregistrement manquant', status: 400 }
  // `erp_table` vient de custom_fields, posé par la route de création qui la
  // valide contre ALLOWED_TABLES — sûr à interpoler.
  let row
  try { row = db.prepare(`SELECT id FROM ${field.erp_table} WHERE id=?`).get(recordId) }
  catch { return { error: 'Table introuvable', status: 400 } }
  if (!row) return { error: 'Enregistrement introuvable', status: 404 }
  return { field }
}

// Liste de fichiers actuellement stockée dans la colonne (tolère une colonne
// vide, un JSON cassé ou une valeur héritée non-tableau → liste vide).
function readFiles(field, recordId) {
  const row = db.prepare(`SELECT ${field.column_name} AS v FROM ${field.erp_table} WHERE id=?`).get(recordId)
  const raw = row?.v
  if (raw == null || raw === '') return []
  try {
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr.filter(f => f && typeof f.id === 'string') : []
  } catch { return [] }
}

// Écrit la liste dans la colonne. Une liste vide devient NULL : « aucun fichier »
// se lit alors comme n'importe quelle cellule vide (filtres, exports, formules).
function writeFiles(field, recordId, files) {
  const value = files.length ? JSON.stringify(files) : null
  db.prepare(`UPDATE ${field.erp_table} SET ${field.column_name}=? WHERE id=?`).run(value, recordId)
  return value
}

function recordDir(fieldId, recordId) {
  return path.join(FIELD_FILES_DIR, fieldId, recordId)
}

const upload = makeUpload({
  destination: (req, file, cb) => {
    const dir = recordDir(req.params.fieldId, req.params.recordId)
    try { fs.mkdirSync(dir, { recursive: true }); cb(null, dir) }
    catch (e) { cb(e) }
  },
  filename: (req, file) => `${randomUUID()}_${sanitizeFileName(file.originalname)}`,
  fileSize: 25 * 1024 * 1024,
  allowedExt: ALLOWED_EXT,
  rejectMessage: ext => `Type de fichier non supporté : ${ext || 'inconnu'}`,
})

// GET /:fieldId/:recordId — liste des fichiers du champ pour cet enregistrement.
// Lecture : un champ en lecture seule se liste comme les autres.
router.get('/:fieldId/:recordId', (req, res) => {
  const t = resolveTarget(req.params.fieldId, req.params.recordId, { write: false })
  if (t.error) return res.status(t.status).json({ error: t.error })
  res.json({ data: readFiles(t.field, req.params.recordId) })
})

// POST /:fieldId/:recordId — dépose un ou plusieurs fichiers. Répond avec la
// NOUVELLE valeur de la cellule (liste complète), pour que le client remplace
// son état sans re-fetch.
router.post('/:fieldId/:recordId', (req, res) => {
  const t = resolveTarget(req.params.fieldId, req.params.recordId)
  if (t.error) return res.status(t.status).json({ error: t.error })

  upload.array('file', 20)(req, res, (uploadErr) => {
    if (uploadErr) return res.status(400).json({ error: uploadErr.message })
    const uploaded = req.files || []
    if (!uploaded.length) return res.status(400).json({ error: 'Aucun fichier reçu' })
    const files = readFiles(t.field, req.params.recordId)
    for (const f of uploaded) {
      files.push({
        id: path.basename(f.path),
        name: normalizeUploadName(f.originalname),
        size: f.size,
        type: f.mimetype || null,
        uploaded_at: new Date().toISOString(),
      })
    }
    writeFiles(t.field, req.params.recordId, files)
    res.status(201).json({ data: files })
  })
})

// GET /:fieldId/:recordId/:fileId — sert le fichier. Affiché dans l'onglet
// (images, PDF) plutôt que téléchargé de force ; `?download=1` force la
// sauvegarde. Auth par header OU `?token=` (cf. middleware requireAuth) — un
// <img src> ne peut pas porter d'en-tête.
router.get('/:fieldId/:recordId/:fileId', (req, res) => {
  const { fieldId, recordId, fileId } = req.params
  if (!FILE_ID_RE.test(fileId)) return res.status(400).json({ error: 'Fichier invalide' })
  const t = resolveTarget(fieldId, recordId, { write: false })
  if (t.error) return res.status(t.status).json({ error: t.error })
  const field = t.field
  const meta = readFiles(field, recordId).find(f => f.id === fileId)
  if (!meta) return res.status(404).json({ error: 'Fichier introuvable' })
  const abs = path.resolve(recordDir(fieldId, recordId), fileId)
  if (!abs.startsWith(FIELD_FILES_DIR + path.sep)) return res.status(400).json({ error: 'Chemin invalide' })
  if (!fs.existsSync(abs)) return res.status(404).json({ error: 'Fichier introuvable sur le disque' })
  if (req.query.download) return res.download(abs, meta.name || fileId)
  if (meta.type) res.type(meta.type)
  res.sendFile(abs)
})

// DELETE /:fieldId/:recordId/:fileId — retire le fichier de la cellule ET du
// disque. Répond avec la nouvelle liste.
router.delete('/:fieldId/:recordId/:fileId', (req, res) => {
  const { fieldId, recordId, fileId } = req.params
  if (!FILE_ID_RE.test(fileId)) return res.status(400).json({ error: 'Fichier invalide' })
  const t = resolveTarget(fieldId, recordId)
  if (t.error) return res.status(t.status).json({ error: t.error })
  const files = readFiles(t.field, recordId)
  const next = files.filter(f => f.id !== fileId)
  if (next.length === files.length) return res.status(404).json({ error: 'Fichier introuvable' })
  writeFiles(t.field, recordId, next)
  const abs = path.resolve(recordDir(fieldId, recordId), fileId)
  if (abs.startsWith(FIELD_FILES_DIR + path.sep)) {
    try { fs.unlinkSync(abs) } catch { /* déjà absent — la cellule est à jour, c'est l'essentiel */ }
  }
  res.json({ data: next })
})

export default router
