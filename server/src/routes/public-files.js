import { Router } from 'express'
import { randomUUID, randomBytes } from 'crypto'
import multer from 'multer'
import { join, extname } from 'path'
import { existsSync, mkdirSync, unlinkSync } from 'fs'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'

const uploadsDir = join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'public')
if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true })

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, `${randomUUID()}${extname(file.originalname).toLowerCase()}`),
})
const upload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 Mo
})

function hydrate(row) {
  if (!row) return null
  let tags = []
  try { tags = JSON.parse(row.tags || '[]') } catch {}
  return { ...row, tags }
}

function genToken() {
  // 16 octets → 32 hex, suffisamment opaque pour qu'un lien ne soit pas devinable.
  return randomBytes(16).toString('hex')
}

// ── Authenticated CRUD router ────────────────────────────────────────────────

export const publicFilesRouter = Router()
publicFilesRouter.use(requireAuth)

publicFilesRouter.get('/', (req, res) => {
  const { folder } = req.query
  let sql = `
    SELECT pf.*, u.name AS uploaded_by_name
    FROM public_files pf
    LEFT JOIN users u ON u.id = pf.uploaded_by
  `
  const params = []
  if (folder !== undefined) {
    sql += ' WHERE pf.folder = ?'
    params.push(folder)
  }
  sql += ' ORDER BY pf.created_at DESC'
  const rows = db.prepare(sql).all(...params).map(hydrate)
  res.json({ data: rows, total: rows.length })
})

publicFilesRouter.get('/folders', (_req, res) => {
  const rows = db.prepare(`
    SELECT folder, COUNT(*) AS count
    FROM public_files
    GROUP BY folder
    ORDER BY folder
  `).all()
  res.json({ data: rows })
})

publicFilesRouter.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' })

  const id = randomUUID()
  const token = genToken()
  const folder = typeof req.body.folder === 'string' ? req.body.folder.trim() : ''
  const description = req.body.description || null
  let tags = '[]'
  if (req.body.tags) {
    try {
      const parsed = typeof req.body.tags === 'string' ? JSON.parse(req.body.tags) : req.body.tags
      if (Array.isArray(parsed)) tags = JSON.stringify(parsed.map(String))
    } catch {}
  }

  db.prepare(`
    INSERT INTO public_files (id, token, original_name, stored_name, mime_type, size, folder, description, tags, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    token,
    req.file.originalname,
    req.file.filename,
    req.file.mimetype || null,
    req.file.size || null,
    folder,
    description,
    tags,
    req.user.id
  )

  const row = db.prepare(`
    SELECT pf.*, u.name AS uploaded_by_name
    FROM public_files pf LEFT JOIN users u ON u.id = pf.uploaded_by
    WHERE pf.id = ?
  `).get(id)
  res.status(201).json(hydrate(row))
})

// Remplace le CONTENU d'un fichier existant en conservant id + token (donc le
// lien public /erp/p/<token> reste identique). L'ancien fichier disque est supprimé.
publicFilesRouter.post('/:id/replace', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Aucun fichier reçu' })

  const row = db.prepare('SELECT * FROM public_files WHERE id=?').get(req.params.id)
  if (!row) {
    try { unlinkSync(join(uploadsDir, req.file.filename)) } catch {}
    return res.status(404).json({ error: 'Not found' })
  }

  // Supprime l'ancien blob disque (sauf collision improbable de nom).
  if (row.stored_name && row.stored_name !== req.file.filename) {
    try { unlinkSync(join(uploadsDir, row.stored_name)) } catch {}
  }

  db.prepare(`
    UPDATE public_files
    SET stored_name = ?, original_name = ?, mime_type = ?, size = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(
    req.file.filename,
    req.file.originalname,
    req.file.mimetype || null,
    req.file.size || null,
    req.params.id
  )

  const updated = db.prepare(`
    SELECT pf.*, u.name AS uploaded_by_name
    FROM public_files pf LEFT JOIN users u ON u.id = pf.uploaded_by
    WHERE pf.id = ?
  `).get(req.params.id)
  res.json(hydrate(updated))
})

publicFilesRouter.patch('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM public_files WHERE id=?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })

  const { folder, description, tags, original_name } = req.body
  const updates = []
  const params = []
  if (folder !== undefined)        { updates.push('folder = ?');        params.push(String(folder || '').trim()) }
  if (description !== undefined)   { updates.push('description = ?');   params.push(description || null) }
  if (tags !== undefined) {
    const arr = Array.isArray(tags) ? tags.map(String) : []
    updates.push('tags = ?')
    params.push(JSON.stringify(arr))
  }
  if (original_name !== undefined && String(original_name).trim()) {
    updates.push('original_name = ?')
    params.push(String(original_name).trim())
  }
  if (updates.length === 0) return res.json(hydrate(row))

  updates.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")
  params.push(req.params.id)
  db.prepare(`UPDATE public_files SET ${updates.join(', ')} WHERE id = ?`).run(...params)

  const updated = db.prepare(`
    SELECT pf.*, u.name AS uploaded_by_name
    FROM public_files pf LEFT JOIN users u ON u.id = pf.uploaded_by
    WHERE pf.id = ?
  `).get(req.params.id)
  res.json(hydrate(updated))
})

publicFilesRouter.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT stored_name FROM public_files WHERE id=?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  try { unlinkSync(join(uploadsDir, row.stored_name)) } catch {}
  db.prepare('DELETE FROM public_files WHERE id=?').run(req.params.id)
  res.json({ ok: true })
})

// ── Public, unauthenticated serve router ─────────────────────────────────────
// Monté sur /erp/p — l'URL publique partagée est /erp/p/<token> ou
// /erp/p/<token>/<original-name> (le nom est purement cosmétique).

export const publicFileServeRouter = Router()

publicFileServeRouter.get('/:token{/:filename}', (req, res) => {
  const row = db.prepare('SELECT * FROM public_files WHERE token = ?').get(req.params.token)
  if (!row) return res.status(404).send('Fichier introuvable')

  const filePath = join(uploadsDir, row.stored_name)
  if (!existsSync(filePath)) return res.status(404).send('Fichier introuvable')

  if (row.mime_type) res.setHeader('Content-Type', row.mime_type)
  // Affiche inline (images/pdf) — le navigateur force le téléchargement si type inconnu.
  const safeName = (row.original_name || 'fichier').replace(/[^\w.\-+\s()]/g, '_')
  res.setHeader('Content-Disposition', `inline; filename="${safeName}"`)
  res.setHeader('Cache-Control', 'public, max-age=3600')
  res.sendFile(filePath)
})
