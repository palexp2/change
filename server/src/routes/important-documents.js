import path from 'path'
import { existsSync } from 'fs'
import db from '../db/database.js'
import { crudRouter } from '../utils/crudRouter.js'
import { RECORD_REGISTRY } from '../db/recordRegistry.js'
import { makeUpload } from '../utils/upload.js'
import { normalizeUploadName } from '../utils/uploadFileName.js'
import { ensureUploadsDir } from '../config/uploads.js'
import { newRecordId } from '../utils/recordId.js'
import { emitEntity } from '../services/realtimeEmitters.js'

// Documents importants de l'entreprise (statuts, assurances, permis…).
// Métadonnées : CRUD du registre. Fichiers : uploads/documents-importants/.
const spec = RECORD_REGISTRY.important_documents
const DIR = ensureUploadsDir('documents-importants')
const upload = makeUpload({ destination: DIR, fileSize: 100 * 1024 * 1024 })

export default crudRouter(spec, {
  extend: router => {
    // Un document par fichier ; le nom part du nom de fichier, sans extension.
    router.post('/upload', upload.array('files', 20), (req, res) => {
      if (!req.files?.length) return res.status(400).json({ error: 'Aucun fichier reçu' })
      const insert = db.prepare(`
        INSERT INTO important_documents (id, name, category, original_name, stored_name, mime_type, size, uploaded_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      const category = typeof req.body.category === 'string' && req.body.category.trim() ? req.body.category.trim() : null
      const rows = req.files.map(f => {
        const id = newRecordId()
        const original = normalizeUploadName(f.originalname)
        const name = original.replace(/\.[^.]+$/, '') || original
        insert.run(id, name, category, original, f.filename, f.mimetype, f.size, req.user?.id || null)
        const row = db.prepare('SELECT * FROM important_documents WHERE id = ?').get(id)
        emitEntity(spec.entity, 'created', id, row, req.user?.id)
        return row
      })
      res.status(201).json({ data: rows })
    })

    // Ouverture dans le navigateur (auth par ?token= pour un nouvel onglet).
    router.get('/:id/file', (req, res) => {
      const row = db.prepare('SELECT * FROM important_documents WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
      if (!row?.stored_name) return res.status(404).json({ error: 'Fichier introuvable' })
      const file = path.join(DIR, path.basename(row.stored_name))
      if (!existsSync(file)) return res.status(404).json({ error: 'Fichier introuvable' })
      if (row.mime_type) res.type(row.mime_type)
      res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(row.original_name || 'document')}`)
      res.sendFile(file)
    })
  },
})
