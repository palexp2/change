import { Router } from 'express'
import { v4 as uuid } from 'uuid'
import multer from 'multer'
import { join, extname } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { spawn } from 'child_process'
import { requireAuth } from '../middleware/auth.js'
import jwt from 'jsonwebtoken'

function requireAuthOrQuery(req, res, next) {
  const tokenStr = req.headers['authorization']?.slice(7) || req.query.token
  if (!tokenStr) return res.status(401).json({ error: 'Authentication required' })
  try {
    req.user = jwt.verify(tokenStr, process.env.JWT_SECRET || 'change-this-secret-in-production')
    next()
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}
import db from '../db/database.js'
import { enqueueTranscription } from '../services/whisper.js'
import { getDriveClient } from '../connectors/google.js'

const router = Router()

// Normalize phone to last 10 digits for matching
function normalizePhone(phone) {
  if (!phone) return null
  const digits = String(phone).replace(/\D/g, '')
  return digits.length >= 10 ? digits.slice(-10) : null
}

function findContactByPhone(...numbers) {
  for (const num of numbers) {
    const norm = normalizePhone(num)
    if (!norm) continue
    // Search all contacts where phone or mobile normalized to 10 digits matches
    const contacts = db.prepare(
      `SELECT id, company_id, phone, mobile FROM contacts WHERE phone IS NOT NULL OR mobile IS NOT NULL`
    ).all()
    for (const c of contacts) {
      if (normalizePhone(c.phone) === norm || normalizePhone(c.mobile) === norm) return c
    }
  }
  return null
}

export function rematchCalls() {
  const unlinked = db.prepare(`
    SELECT i.id as interaction_id, ca.caller_number, ca.callee_number
    FROM interactions i
    JOIN calls ca ON ca.interaction_id = i.id
    WHERE i.contact_id IS NULL
  `).all()

  let matched = 0
  for (const row of unlinked) {
    const contact = findContactByPhone(row.callee_number, row.caller_number)
    if (contact) {
      db.prepare(`UPDATE interactions SET contact_id=?, company_id=COALESCE(company_id,?) WHERE id=?`)
        .run(contact.id, contact.company_id, row.interaction_id)
      matched++
    }
  }
  if (unlinked.length > 0) console.log(`📞 Appels rematchés: ${matched}/${unlinked.length}`)
  return matched
}

const uploadsDir = join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'calls')
if (!existsSync(uploadsDir)) mkdirSync(uploadsDir, { recursive: true })

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (req, file, cb) => cb(null, `${uuid()}${extname(file.originalname)}`),
})
const upload = multer({ storage, limits: { fileSize: 200 * 1024 * 1024 } })

// Middleware: secret partagé pour l'ingestion FTP (sans JWT utilisateur)
function requireFtpSecret(req, res, next) {
  const secret = process.env.FTP_INGEST_SECRET
  if (!secret) return res.status(503).json({ error: 'FTP_INGEST_SECRET not configured' })
  if (req.headers['x-ftp-secret'] !== secret) return res.status(401).json({ error: 'Invalid FTP secret' })
  next()
}

// POST /api/calls/ftp-ingest — reçoit un enregistrement depuis le serveur FTP
// Header requis : x-ftp-secret
// Body (multipart) : recording (fichier), ftp_username, caller_number, callee_number, duration_seconds, timestamp, direction
router.post('/ftp-ingest', requireFtpSecret, upload.single('recording'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' })

  const { ftp_username, caller_number, callee_number, duration_seconds, timestamp, direction } = req.body
  if (!ftp_username) return res.status(400).json({ error: 'ftp_username required' })

  // Résoudre l'utilisateur ERP à partir du nom FTP
  const user = db.prepare(`SELECT id FROM users WHERE ftp_username=? AND active=1`).get(ftp_username)
  if (!user) return res.status(404).json({ error: `Aucun utilisateur ERP avec ftp_username="${ftp_username}"` })

  // Auto-match contact par numéro
  let resolvedContactId = null
  let resolvedCompanyId = null
  const match = findContactByPhone(callee_number, caller_number)
  if (match) {
    resolvedContactId = match.id
    resolvedCompanyId = match.company_id
  }

  // Deduplication: skip if this original filename was already ingested
  const origName = req.file.originalname
  const existing = db.prepare('SELECT id FROM calls WHERE original_filename=?').get(origName)
  if (existing) {
    console.log(`📞 FTP ingest (doublon ignoré): ${origName}`)
    return res.status(200).json({ id: existing.id, duplicate: true })
  }

  const interactionId = uuid()
  const callId = uuid()
  const ts = timestamp || new Date().toISOString()

  db.prepare('INSERT INTO interactions (id, contact_id, company_id, user_id, type, direction, timestamp) VALUES (?,?,?,?,?,?,?)')
    .run(interactionId, resolvedContactId, resolvedCompanyId, user.id, 'call', direction || 'in', ts)

  db.prepare('INSERT INTO calls (id, interaction_id, recording_path, caller_number, callee_number, duration_seconds, original_filename) VALUES (?,?,?,?,?,?,?)')
    .run(callId, interactionId, req.file.filename, caller_number || null, callee_number || null, duration_seconds ? Number(duration_seconds) : null, origName)

  const filePath = join(uploadsDir, req.file.filename)
  enqueueTranscription(callId, filePath).catch(console.error)

  console.log(`📞 FTP ingest: ${origName} → vendeur=${ftp_username}, contact=${resolvedContactId || 'non résolu'}`)
  res.status(201).json({ id: callId, interaction_id: interactionId, contact_matched: !!resolvedContactId })
})

// POST /api/calls/upload — upload recording + create interaction+call
router.post('/upload', requireAuth, upload.single('recording'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' })

  const { contact_id, company_id, direction, caller_number, callee_number, duration_seconds, timestamp } = req.body
  // Auto-match contact by phone if not provided
  let resolvedContactId = contact_id || null
  let resolvedCompanyId = company_id || null
  if (!resolvedContactId) {
    const match = findContactByPhone(callee_number, caller_number)
    if (match) {
      resolvedContactId = match.id
      resolvedCompanyId = resolvedCompanyId || match.company_id
    }
  }

  const interactionId = uuid()
  const callId = uuid()
  const ts = timestamp || new Date().toISOString()

  db.prepare('INSERT INTO interactions (id, contact_id, company_id, user_id, type, direction, timestamp) VALUES (?,?,?,?,?,?,?)')
    .run(interactionId, resolvedContactId, resolvedCompanyId, req.user.id, 'call', direction || 'in', ts)

  db.prepare('INSERT INTO calls (id, interaction_id, recording_path, caller_number, callee_number, duration_seconds) VALUES (?,?,?,?,?,?)')
    .run(callId, interactionId, req.file.filename, caller_number || null, callee_number || null, duration_seconds ? Number(duration_seconds) : null)

  const filePath = join(uploadsDir, req.file.filename)
  enqueueTranscription(callId, filePath).catch(console.error)

  res.status(201).json({ id: callId, interaction_id: interactionId })
})

// POST /api/calls/rematch — retroactively link unmatched calls to contacts by phone
router.post('/rematch', requireAuth, (req, res) => {
  const matched = rematchCalls()
  res.json({ matched })
})

// GET /api/calls/:id/transcript
router.get('/:id/transcript', requireAuth, (req, res) => {
  const row = db.prepare(`
    SELECT ca.* FROM calls ca
    JOIN interactions i ON ca.interaction_id = i.id
    WHERE ca.id=?
  `).get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json({ transcript: row.transcript_formatted || row.transcript, status: row.transcription_status })
})

// GET /api/calls/:id/recording — stream audio from local disk or Google Drive
router.get('/:id/recording', requireAuthOrQuery, async (req, res) => {
  const row = db.prepare(`
    SELECT ca.* FROM calls ca
    JOIN interactions i ON ca.interaction_id = i.id
    WHERE ca.id=?
  `).get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })

  // Try local file first
  if (row.recording_path) {
    const localPath = join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'calls', row.recording_path)
    if (existsSync(localPath)) {
      // Convert AMR/AMR-in-MP4 to MP3 on-the-fly (browsers don't support AMR codec)
      if (/\.(amr|mp4)$/i.test(localPath)) {
        res.setHeader('Content-Type', 'audio/mpeg')
        res.setHeader('Accept-Ranges', 'none')
        const ff = spawn('ffmpeg', ['-i', localPath, '-f', 'mp3', '-ab', '64k', 'pipe:1'], { stdio: ['ignore', 'pipe', 'ignore'] })
        ff.stdout.pipe(res)
        ff.on('error', (e) => { console.error('ffmpeg error:', e.message); if (!res.headersSent) res.status(500).end() })
        return
      }
      return res.sendFile(localPath)
    }
  }

  // Fall back to Google Drive streaming
  if (!row.drive_file_id) return res.status(404).json({ error: 'No recording available' })

  try {
    const oauthRow = db.prepare(`
      SELECT id FROM connector_oauth WHERE connector='google' ORDER BY updated_at DESC LIMIT 1
    `).get()
    if (!oauthRow) return res.status(503).json({ error: 'Google not connected' })

    const drive = await getDriveClient(oauthRow.id)
    const ext = (row.recording_path || row.drive_filename || '').match(/\.(m4a|mp4|wav|mp3)$/i)?.[1] || 'm4a'
    const mimeType = ext === 'mp3' ? 'audio/mpeg' : ext === 'wav' ? 'audio/wav' : 'audio/mp4'

    res.setHeader('Content-Type', mimeType)
    res.setHeader('Accept-Ranges', 'bytes')

    const driveRes = await drive.files.get(
      { fileId: row.drive_file_id, alt: 'media' },
      { responseType: 'stream' }
    )
    driveRes.data.pipe(res)
  } catch (e) {
    console.error('Recording stream error:', e.message)
    res.status(500).json({ error: 'Failed to stream recording' })
  }
})

// POST /api/calls/:id/retranscribe
router.post('/:id/retranscribe', requireAuth, async (req, res) => {
  const row = db.prepare(`
    SELECT ca.* FROM calls ca
    JOIN interactions i ON ca.interaction_id = i.id
    WHERE ca.id=?
  `).get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  if (!row.recording_path) return res.status(400).json({ error: 'No recording' })

  const filePath = join(uploadsDir, row.recording_path)
  enqueueTranscription(row.id, filePath).catch(console.error)
  res.json({ ok: true })
})

export default router
