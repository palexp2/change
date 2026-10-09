import { Router } from 'express'
import { newRecordId } from '../utils/recordId.js'
import { randomBytes } from 'crypto'
import { makeUpload } from '../utils/upload.js'
import { join } from 'path'
import { existsSync, unlinkSync } from 'fs'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { normalizeUploadName } from '../utils/uploadFileName.js'
import { ensureUploadsDir } from '../config/uploads.js'
import { buildPartialUpdate } from '../utils/partialUpdate.js'
import { getPageByToken, injectAcceptScript, refreshAcceptFlag, syncServedCopy } from '../services/hostedPages.js'
import { emit } from '../services/realtime.js'

const uploadsDir = ensureUploadsDir('public')

const upload = makeUpload({ destination: uploadsDir, fileSize: 100 * 1024 * 1024 })

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

  const id = newRecordId()
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
    normalizeUploadName(req.file.originalname),
    req.file.filename,
    req.file.mimetype || null,
    req.file.size || null,
    folder,
    description,
    tags,
    req.user.id
  )

  refreshAcceptFlag(id)
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
    normalizeUploadName(req.file.originalname),
    req.file.mimetype || null,
    req.file.size || null,
    req.params.id
  )
  refreshAcceptFlag(req.params.id)

  const updated = db.prepare(`
    SELECT pf.*, u.name AS uploaded_by_name
    FROM public_files pf LEFT JOIN users u ON u.id = pf.uploaded_by
    WHERE pf.id = ?
  `).get(req.params.id)
  res.json(hydrate(updated))
})

const ACCEPTANCE_SELECT = `
  SELECT a.*, pf.original_name AS page_name, pf.token AS page_token,
    TRIM(COALESCE(ct.first_name,'') || ' ' || COALESCE(ct.last_name,'')) AS contact_name
  FROM page_acceptances a JOIN public_files pf ON pf.id = a.public_file_id
  LEFT JOIN contacts ct ON ct.id = a.contact_id`

// GET /api/public-files/acceptances — acceptations de toutes les pages (page Acceptations)
publicFilesRouter.get('/acceptances', (_req, res) => {
  res.json({ data: db.prepare(`${ACCEPTANCE_SELECT} ORDER BY a.at DESC, a.id DESC LIMIT 2000`).all() })
})

// GET /api/public-files/acceptances/:id — fiche d'une acceptation (texte signé)
publicFilesRouter.get('/acceptances/:id', (req, res) => {
  const row = db.prepare(`${ACCEPTANCE_SELECT} WHERE a.id = ?`).get(Number(req.params.id) || 0)
  if (!row) return res.status(404).json({ error: 'Acceptation introuvable' })
  res.json(row)
})

// DELETE /api/public-files/acceptances/:id — retire une acceptation
publicFilesRouter.delete('/acceptances/:id', (req, res) => {
  const id = Number(req.params.id) || 0
  const r = db.prepare('DELETE FROM page_acceptances WHERE id = ?').run(id)
  if (!r.changes) return res.status(404).json({ error: 'Acceptation introuvable' })
  emit('page_acceptances:list', { type: 'page_acceptances:deleted', payload: { id } })
  res.json({ ok: true })
})

publicFilesRouter.patch('/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM public_files WHERE id=?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })

  const body = { ...req.body }
  if (!String(body.original_name ?? '').trim()) delete body.original_name
  const { setClause, values } = buildPartialUpdate(body, {
    allowed: ['folder', 'description', 'tags', 'original_name'],
    coerce: {
      folder: v => String(v || '').trim(),
      description: v => v || null,
      tags: v => JSON.stringify(Array.isArray(v) ? v.map(String) : []),
      original_name: v => normalizeUploadName(String(v).trim()),
    },
  })
  if (!setClause) return res.json(hydrate(row))

  db.prepare(`UPDATE public_files SET ${setClause}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(...values, req.params.id)

  const updated = db.prepare(`
    SELECT pf.*, u.name AS uploaded_by_name
    FROM public_files pf LEFT JOIN users u ON u.id = pf.uploaded_by
    WHERE pf.id = ?
  `).get(req.params.id)
  res.json(hydrate(updated))
})

publicFilesRouter.delete('/:id', (req, res) => {
  const row = db.prepare('SELECT stored_name, token FROM public_files WHERE id=?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  try { unlinkSync(join(uploadsDir, row.stored_name)) } catch {}
  syncServedCopy({ token: row.token, deleted: true })
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

  // Page avec acceptation : bloc « Nom + J'accepte + Payer » injecté.
  if (row.accept_page) {
    const page = getPageByToken(row.token)
    if (page) {
      res.setHeader('Cache-Control', 'no-store')
      return res.type('html').send(injectAcceptScript(page.html))
    }
  }

  if (row.mime_type) res.setHeader('Content-Type', row.mime_type)
  // Affiche inline (images/pdf) — le navigateur force le téléchargement si type inconnu.
  // Deux noms : l'ASCII pour les vieux clients, le `filename*` RFC 5987 pour
  // que « Capture d'écran.png » garde ses accents à l'enregistrement.
  const original = row.original_name || 'fichier'
  const safeName = original.replace(/[^\w.\-+\s()]/g, '_')
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${safeName}"; filename*=UTF-8''${encodeURIComponent(original)}`
  )
  res.setHeader('Cache-Control', 'public, max-age=3600')
  res.sendFile(filePath)
})
