import { Router } from 'express'
import { v4 as uuid } from 'uuid'
import { requireAuth } from '../middleware/auth.js'
import db from '../db/database.js'

const router = Router()

// GET /api/interactions
router.get('/', requireAuth, (req, res) => {
  const { type, contact_id, company_id, user_id, limit = 50, offset = 0 } = req.query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : Number(limit)
  const offsetVal = limitAll ? 0 : Number(offset)
  const where = ['i.deleted_at IS NULL']
  const params = []

  if (type) { where.push('i.type=?'); params.push(type) }
  if (contact_id) { where.push('i.contact_id=?'); params.push(contact_id) }
  if (user_id) { where.push('i.user_id=?'); params.push(user_id) }
  if (company_id) {
    // Include interactions linked directly to the company OR via a contact belonging to it
    where.push('(i.company_id=? OR i.contact_id IN (SELECT id FROM contacts WHERE company_id=?))')
    params.push(company_id, company_id)
  }

  const whereStr = where.join(' AND ')

  const rows = db.prepare(`
    SELECT
      i.*,
      c.first_name || ' ' || c.last_name AS contact_name,
      co.name AS company_name,
      u.name AS user_name,
      ca.id as call_id, ca.recording_path, ca.transcript_formatted, ca.duration_seconds,
      ca.transcription_status, ca.caller_number, ca.callee_number, ca.drive_filename, ca.drive_file_id,
      CASE
        WHEN i.type='call' AND i.direction='out' THEN ca.callee_number
        WHEN i.type='call' AND i.direction='in'  THEN ca.caller_number
        WHEN i.type='call' THEN COALESCE(ca.callee_number, ca.caller_number)
        ELSE NULL
      END as phone_number,
      e.subject, e.from_address, e.to_address, e.body_text, e.body_html, e.automated, e.open_count,
      m.title AS meeting_title, m.duration_minutes, m.notes AS meeting_notes
    FROM interactions i
    LEFT JOIN contacts c ON i.contact_id = c.id
    LEFT JOIN companies co ON i.company_id = co.id
    LEFT JOIN users u ON i.user_id = u.id
    LEFT JOIN calls ca ON i.type='call' AND ca.interaction_id = i.id
    LEFT JOIN emails e ON i.type='email' AND e.interaction_id = i.id
    LEFT JOIN meetings m ON (i.type='meeting' OR i.type='note') AND m.interaction_id = i.id
    WHERE ${whereStr}
    ORDER BY i.timestamp DESC
    LIMIT ? OFFSET ?
  `).all(...params, limitVal, offsetVal)

  const total = db.prepare(`SELECT COUNT(*) as n FROM interactions i WHERE ${whereStr}`)
    .get(...params).n

  res.json({ interactions: rows, total: Number(total) })
})

// GET /api/interactions/:id/email-body
router.get('/:id/email-body', requireAuth, (req, res) => {
  const row = db.prepare(`
    SELECT e.* FROM emails e
    JOIN interactions i ON e.interaction_id = i.id
    WHERE i.id=?
  `).get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

// POST /api/interactions
router.post('/', requireAuth, (req, res) => {
  const { contact_id, company_id, type, direction, timestamp, notes, title, url, duration_minutes, attendees } = req.body
  if (!type) return res.status(400).json({ error: 'type required' })

  const id = uuid()
  const ts = timestamp || new Date().toISOString()
  db.prepare('INSERT INTO interactions (id, contact_id, company_id, user_id, type, direction, timestamp) VALUES (?,?,?,?,?,?,?)')
    .run(id, contact_id || null, company_id || null, req.user.id, type, direction || null, ts)

  if (type === 'meeting' || type === 'note') {
    db.prepare('INSERT INTO meetings (id, interaction_id, title, url, duration_minutes, notes, attendees) VALUES (?,?,?,?,?,?,?)')
      .run(uuid(), id, title || (type === 'note' ? 'Note' : null), url || null, duration_minutes || null, notes || null, attendees || null)
  }

  res.status(201).json({ id })
})

// DELETE /api/interactions/:id
router.delete('/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM interactions WHERE id=?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  db.prepare("UPDATE interactions SET deleted_at = datetime('now') WHERE id=?").run(req.params.id)
  res.json({ ok: true })
})

export default router
