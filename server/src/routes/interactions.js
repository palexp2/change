import { Router } from 'express'
import { newRecordId } from '../utils/recordId.js'
import { requireAuth } from '../middleware/auth.js'
import db from '../db/database.js'
import { normalizeToUtcIso } from '../utils/datetime.js'
import { checkForeignKeys } from '../utils/fkExists.js'
import { emitEntity } from '../services/realtimeEmitters.js'
import { listInteractionEmailAttachments, downloadInteractionEmailAttachment, sendEmail } from '../services/gmail.js'
import { interactionFile } from '../services/hubspotHistoryImport.js'
import { trackEmailHtml, emailTrackingSummary } from '../services/emailTracking.js'

// Reuse the LIST query shape (lightweight, without heavy fields) so the
// realtime payload matches what `Interactions.jsx` consumes in its table.
const INTERACTION_LIST_SELECT = `
  SELECT
    i.*,
    c.first_name || ' ' || c.last_name AS contact_name,
    co.name AS company_name,
    u.name AS user_name,
    ca.id as call_id, ca.recording_path, ca.duration_seconds,
    ca.transcription_status, ca.caller_number, ca.callee_number, ca.drive_filename, ca.drive_file_id,
    ca.summary AS call_summary, ca.next_steps AS call_next_steps,
    CASE
      WHEN i.type='call' AND i.direction='out' THEN ca.callee_number
      WHEN i.type='call' AND i.direction='in'  THEN ca.caller_number
      WHEN i.type='call' THEN COALESCE(ca.callee_number, ca.caller_number)
      ELSE NULL
    END as phone_number,
    e.subject, e.from_address, e.to_address, e.automated, e.open_count, e.click_count,
    m.title AS meeting_title, m.duration_minutes
  FROM interactions i
  LEFT JOIN contacts c ON i.contact_id = c.id
  LEFT JOIN companies co ON i.company_id = co.id
  LEFT JOIN users u ON i.user_id = u.id
  LEFT JOIN calls ca ON i.type='call' AND ca.interaction_id = i.id
  LEFT JOIN emails e ON i.type='email' AND e.interaction_id = i.id
  -- Jointure non filtrée par type : un log manuel (appel, SMS…) range ses notes
  -- dans meetings, seule table de détail qui en porte. Sans ligne meetings,
  -- la jointure ne ramène rien — les autres types ne changent pas.
  LEFT JOIN meetings m ON m.interaction_id = i.id
  WHERE i.id = ? AND i.deleted_at IS NULL
`

const router = Router()

// Heavy detail fields (body_html, body_text, transcript_formatted, meeting_notes)
// are omitted from the list payload — they only feed the detail panel, which
// fetches the full record via GET /api/interactions/:id. This cut ~87% of
// the payload size (measured 2026-04-24: 34MB of 39MB). Pass ?include=heavy
// to keep the old behaviour.

// GET /api/interactions
router.get('/', requireAuth, (req, res) => {
  const { type, contact_id, company_id, user_id, from, to, limit = 50, offset = 0, include } = req.query
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
  if (from) { where.push('i.timestamp >= ?'); params.push(from) }
  if (to) { where.push('i.timestamp <= ?'); params.push(to) }

  const whereStr = where.join(' AND ')

  // Opt-in to heavy fields via ?include=heavy (backwards compat for any caller
  // that still needs the full body/transcript in the list response).
  const includeHeavy = include === 'heavy'
  const heavySelect = includeHeavy
    ? 'ca.transcript_formatted, e.body_text, e.body_html, m.notes AS meeting_notes,'
    : ''

  const rows = db.prepare(`
    SELECT
      i.*,
      c.first_name || ' ' || c.last_name AS contact_name,
      co.name AS company_name,
      u.name AS user_name,
      ca.id as call_id, ca.recording_path, ca.duration_seconds,
      ca.transcription_status, ca.caller_number, ca.callee_number, ca.drive_filename, ca.drive_file_id,
      ca.summary AS call_summary, ca.next_steps AS call_next_steps,
      CASE
        WHEN i.type='call' AND i.direction='out' THEN ca.callee_number
        WHEN i.type='call' AND i.direction='in'  THEN ca.caller_number
        WHEN i.type='call' THEN COALESCE(ca.callee_number, ca.caller_number)
        ELSE NULL
      END as phone_number,
      e.subject, e.from_address, e.to_address, e.automated, e.open_count, e.click_count,
      ${heavySelect}
      m.title AS meeting_title, m.duration_minutes
    FROM interactions i
    LEFT JOIN contacts c ON i.contact_id = c.id
    LEFT JOIN companies co ON i.company_id = co.id
    LEFT JOIN users u ON i.user_id = u.id
    LEFT JOIN calls ca ON i.type='call' AND ca.interaction_id = i.id
    LEFT JOIN emails e ON i.type='email' AND e.interaction_id = i.id
    LEFT JOIN meetings m ON m.interaction_id = i.id
    WHERE ${whereStr}
    ORDER BY i.pinned DESC, i.timestamp DESC
    LIMIT ? OFFSET ?
  `).all(...params, limitVal, offsetVal)

  const total = db.prepare(`SELECT COUNT(*) as n FROM interactions i WHERE ${whereStr}`)
    .get(...params).n

  res.json({ interactions: rows, total: Number(total) })
})

// GET /api/interactions/:id — full record incl. heavy detail fields
router.get('/:id', requireAuth, (req, res) => {
  const row = db.prepare(`
    SELECT
      i.*,
      c.first_name || ' ' || c.last_name AS contact_name,
      co.name AS company_name,
      u.name AS user_name,
      ca.id as call_id, ca.recording_path, ca.transcript_formatted, ca.duration_seconds,
      ca.transcription_status, ca.caller_number, ca.callee_number, ca.drive_filename, ca.drive_file_id,
      ca.summary AS call_summary, ca.next_steps AS call_next_steps,
      CASE
        WHEN i.type='call' AND i.direction='out' THEN ca.callee_number
        WHEN i.type='call' AND i.direction='in'  THEN ca.caller_number
        WHEN i.type='call' THEN COALESCE(ca.callee_number, ca.caller_number)
        ELSE NULL
      END as phone_number,
      e.subject, e.from_address, e.to_address, e.body_text, e.body_html, e.automated, e.open_count, e.click_count,
      m.title AS meeting_title, m.duration_minutes, m.notes AS meeting_notes
    FROM interactions i
    LEFT JOIN contacts c ON i.contact_id = c.id
    LEFT JOIN companies co ON i.company_id = co.id
    LEFT JOIN users u ON i.user_id = u.id
    LEFT JOIN calls ca ON i.type='call' AND ca.interaction_id = i.id
    LEFT JOIN emails e ON i.type='email' AND e.interaction_id = i.id
    LEFT JOIN meetings m ON m.interaction_id = i.id
    WHERE i.id=? AND i.deleted_at IS NULL
  `).get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

// GET /api/interactions/:id/tracking — ouvertures et clics d'un courriel
// envoyé depuis Boréal (fiche du fil). tracked=false : courriel sans suivi.
router.get('/:id/tracking', requireAuth, (req, res) => {
  const email = db.prepare('SELECT e.id FROM emails e WHERE e.interaction_id = ?').get(req.params.id)
  if (!email) return res.json({ tracked: false, opens: [], links: [] })
  res.json(emailTrackingSummary(email.id))
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

// GET /api/interactions/:id/attachments — pièces jointes du courriel synchronisé.
// Les métadonnées sont listées auprès de Gmail au premier accès (le sync
// n'importe que le corps), le contenu au clic sur le fichier.
router.get('/:id/attachments', requireAuth, async (req, res) => {
  const row = db.prepare(`SELECT id FROM interactions WHERE id=? AND deleted_at IS NULL`).get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  try {
    // + pièces jointes importées de HubSpot (notes, réunions, courriels d'avant Gmail)
    const hs = db.prepare(`
      SELECT f.id, f.file_name, f.content_type, f.file_size, f.created_at AS fetched_at, i.timestamp
      FROM interaction_files f JOIN interactions i ON i.id = f.interaction_id
      WHERE f.interaction_id = ? AND f.file_path IS NOT NULL ORDER BY f.file_name
    `).all(req.params.id)
    res.json([...(await listInteractionEmailAttachments(req.params.id)), ...hs])
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// GET /api/interactions/:id/attachments/:attId/download
router.get('/:id/attachments/:attId/download', requireAuth, async (req, res) => {
  try {
    const { absPath, fileName, contentType } = interactionFile(req.params.id, req.params.attId)
      || await downloadInteractionEmailAttachment(req.params.id, req.params.attId)
    if (contentType) res.type(contentType)
    res.download(absPath, fileName || 'piece-jointe')
  } catch (e) {
    res.status(e.message === 'Not found' ? 404 : 400).json({ error: e.message })
  }
})

// POST /api/interactions
router.post('/', requireAuth, (req, res) => {
  const { contact_id, company_id, type, direction, timestamp, notes, title, url, duration_minutes, attendees } = req.body
  if (!type) return res.status(400).json({ error: 'type required' })
  const fkErr = checkForeignKeys({ company_id, contact_id })
  if (fkErr) return res.status(400).json({ error: fkErr.message })

  const id = newRecordId()
  const ts = normalizeToUtcIso(timestamp) || new Date().toISOString()

  // Tout-ou-rien : la ligne interactions et sa ligne de détail meetings doivent
  // être insérées ensemble, sinon un échec du 2e INSERT laisserait une
  // interaction orpheline sans détail. db.transaction() garantit le rollback complet.
  const insertInteraction = db.transaction(() => {
    db.prepare('INSERT INTO interactions (id, contact_id, company_id, user_id, type, direction, timestamp) VALUES (?,?,?,?,?,?,?)')
      .run(id, contact_id || null, company_id || null, req.user.id, type, direction || null, ts)

    // La ligne de détail sert aussi aux logs manuels d'appel/SMS : dès qu'il y a
    // un titre ou des notes à conserver, on l'écrit quel que soit le type.
    if (type === 'meeting' || type === 'note' || title || notes) {
      db.prepare('INSERT INTO meetings (id, interaction_id, title, url, duration_minutes, notes, attendees) VALUES (?,?,?,?,?,?,?)')
        .run(newRecordId(), id, title || (type === 'note' ? 'Note' : null), url || null, duration_minutes || null, notes || null, attendees || null)
    }
  })
  insertInteraction()

  const created = db.prepare(INTERACTION_LIST_SELECT).get(id)
  if (created) emitEntity('interaction', 'created', id, created, req.user?.id)
  res.status(201).json({ id })
})

// POST /api/interactions/send-email — courriel libre écrit depuis une fiche
// entreprise ou contact, envoyé depuis le Gmail de l'utilisateur (ou
// `from_account`) et consigné au fil. Pixel de suivi comme pour les soumissions
// (absent du corps consigné : l'afficher dans l'ERP compterait une ouverture).
router.post('/send-email', requireAuth, async (req, res) => {
  const { to, cc, bcc, subject, body_html, company_id, contact_id, from_account } = req.body || {}
  if (!to || !String(to).includes('@')) return res.status(400).json({ error: 'Adresse courriel invalide' })
  if (!subject || !String(subject).trim()) return res.status(400).json({ error: 'Objet requis' })
  const fkErr = checkForeignKeys({ company_id, contact_id })
  if (fkErr) return res.status(400).json({ error: fkErr.message })

  const emailId = newRecordId()
  let result
  try {
    result = await sendEmail(to, String(subject).trim(), trackEmailHtml(body_html, emailId), {
      cc: cc || undefined,
      bcc: bcc || undefined,
      userId: req.user?.id,
      accountEmail: from_account || undefined,
    })
  } catch (e) {
    console.error('Interaction send-email error:', e.message)
    return res.status(502).json({ error: e.message })
  }

  const contactId = db.prepare('SELECT id FROM contacts WHERE lower(email) = lower(?) AND deleted_at IS NULL').get(to)?.id || contact_id || null
  const senderUserId = db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(result.account_email)?.id || req.user?.id || null
  const id = newRecordId()
  db.transaction(() => {
    db.prepare(`
      INSERT INTO interactions (id, contact_id, company_id, user_id, type, direction, timestamp)
      VALUES (?, ?, ?, ?, 'email', 'out', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).run(id, contactId, company_id || null, senderUserId)
    db.prepare(`
      INSERT INTO emails (id, interaction_id, subject, body_html, from_address, to_address, cc, bcc, gmail_message_id, gmail_thread_id, automated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(emailId, id, String(subject).trim(), String(body_html || ''), result.account_email, to, cc || null, bcc || null, result.message_id, result.thread_id)
  })()

  const created = db.prepare(INTERACTION_LIST_SELECT).get(id)
  if (created) emitEntity('interaction', 'created', id, created, req.user?.id)
  res.status(201).json({ id })
})

// PATCH /api/interactions/:id/pin — épingler/désépingler en haut du fil
router.patch('/:id/pin', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id FROM interactions WHERE id=? AND deleted_at IS NULL').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  const pinned = req.body?.pinned ? 1 : 0
  db.prepare('UPDATE interactions SET pinned=?, pinned_at=? WHERE id=?')
    .run(pinned, pinned ? new Date().toISOString() : null, req.params.id)
  const updated = db.prepare(INTERACTION_LIST_SELECT).get(req.params.id)
  emitEntity('interaction', 'updated', req.params.id, updated, req.user?.id)
  res.json(updated)
})

// POST /api/interactions/:id/restore — annuler une suppression
router.post('/:id/restore', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id, deleted_at FROM interactions WHERE id=?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  db.prepare('UPDATE interactions SET deleted_at = NULL WHERE id=?').run(req.params.id)
  const restored = db.prepare(INTERACTION_LIST_SELECT).get(req.params.id)
  emitEntity('interaction', 'created', req.params.id, restored, req.user?.id)
  res.json(restored)
})

// DELETE /api/interactions/:id
router.delete('/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM interactions WHERE id=?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  db.prepare("UPDATE interactions SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?").run(req.params.id)
  emitEntity('interaction', 'deleted', req.params.id, { id: req.params.id }, req.user?.id)
  res.json({ ok: true })
})

export default router
