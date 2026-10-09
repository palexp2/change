import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { newRecordId } from '../utils/recordId.js'

// Clients → Modèles de courriel : objets et textes réutilisables. Variables
// [First name], [Email]… et liens [texte](url) rendus à l'insertion dans un
// courriel (client/src/lib/emailTemplateVars.js).

const router = Router()
router.use(requireAuth)

const SELECT = `
  SELECT t.*, u.name AS created_by_name
  FROM email_templates t LEFT JOIN users u ON u.id=t.created_by`

const getOne = id => db.prepare(`${SELECT} WHERE t.id=?`).get(id)

const WRITABLE = {
  name: v => { const s = String(v || '').trim(); if (!s) throw new Error('Nom requis'); return s.slice(0, 200) },
  subject: v => String(v ?? '').slice(0, 500),
  body: v => String(v ?? '').slice(0, 100000),
  language: v => (String(v || '').toLowerCase().startsWith('en') ? 'en' : 'fr'),
  // { variable: texte } utilisé quand la valeur du destinataire manque.
  fallbacks: v => {
    const o = v && typeof v === 'object' ? v : {}
    const clean = Object.fromEntries(Object.entries(o).map(([k, t]) => [String(k).slice(0, 40), String(t ?? '').slice(0, 500)]).filter(([, t]) => t))
    return Object.keys(clean).length ? JSON.stringify(clean) : null
  },
}
const CREATE_KEYS = ['name', 'subject', 'body', 'language']

// GET /api/email-templates
router.get('/', (req, res) => {
  res.json(db.prepare(`${SELECT} ORDER BY t.name COLLATE NOCASE`).all())
})

// POST /api/email-templates
router.post('/', (req, res) => {
  let row
  try {
    row = Object.fromEntries(CREATE_KEYS.map(k => [k, WRITABLE[k](req.body?.[k])]))
  } catch (e) { return res.status(400).json({ error: e.message }) }
  const id = newRecordId()
  db.prepare(`INSERT INTO email_templates (id, name, subject, body, language, created_by)
    VALUES (@id, @name, @subject, @body, @language, @created_by)`)
    .run({ ...row, id, created_by: req.user.id })
  res.status(201).json(getOne(id))
})

// GET /api/email-templates/:id
router.get('/:id', (req, res) => {
  const t = getOne(req.params.id)
  if (!t) return res.status(404).json({ error: 'Modèle introuvable' })
  res.json(t)
})

// PATCH /api/email-templates/:id
router.patch('/:id', (req, res) => {
  if (!getOne(req.params.id)) return res.status(404).json({ error: 'Modèle introuvable' })
  const sets = {}
  try {
    for (const [k, v] of Object.entries(req.body || {})) {
      if (WRITABLE[k]) sets[k] = WRITABLE[k](v)
    }
  } catch (e) { return res.status(400).json({ error: e.message }) }
  if (Object.keys(sets).length) {
    const cols = Object.keys(sets).map(k => `${k}=@${k}`).join(', ')
    db.prepare(`UPDATE email_templates SET ${cols}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=@id`)
      .run({ ...sets, id: req.params.id })
  }
  res.json(getOne(req.params.id))
})

// POST /api/email-templates/:id/duplicate
router.post('/:id/duplicate', (req, res) => {
  const src = getOne(req.params.id)
  if (!src) return res.status(404).json({ error: 'Modèle introuvable' })
  const id = newRecordId()
  db.prepare(`INSERT INTO email_templates (id, name, subject, body, language, fallbacks, created_by) VALUES (?,?,?,?,?,?,?)`)
    .run(id, `${src.name} (copie)`.slice(0, 200), src.subject, src.body, src.language, src.fallbacks || null, req.user.id)
  res.status(201).json(getOne(id))
})

// DELETE /api/email-templates/:id
router.delete('/:id', (req, res) => {
  const r = db.prepare('DELETE FROM email_templates WHERE id=?').run(req.params.id)
  if (!r.changes) return res.status(404).json({ error: 'Modèle introuvable' })
  res.json({ ok: true })
})

export default router
