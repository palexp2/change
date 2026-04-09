import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { newId } from '../utils/ids.js'
import { runAutomation } from '../services/automationEngine.js'
import { scheduleAutomation, unscheduleAutomation } from '../services/automationScheduler.js'

const router = Router()
router.use(requireAuth)

// GET /api/automations
router.get('/', (req, res) => {
  const automations = db.prepare(`
    SELECT * FROM automations WHERE deleted_at IS NULL ORDER BY created_at DESC
  `).all()
  res.json(automations)
})

// GET /api/automations/:id
router.get('/:id', (req, res) => {
  const automation = db.prepare(
    'SELECT * FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })
  res.json(automation)
})

// POST /api/automations
router.post('/', (req, res) => {
  const { name, description, trigger_type, trigger_config, script, active } = req.body
  if (!name?.trim()) return res.status(400).json({ error: 'Nom requis' })
  if (!trigger_type) return res.status(400).json({ error: 'trigger_type requis' })

  const id = newId('auto')
  db.prepare(`
    INSERT INTO automations (id, name, description, trigger_type, trigger_config, action_type, action_config, script, active)
    VALUES (?, ?, ?, ?, ?, 'script', '{}', ?, ?)
  `).run(id, name.trim(), description || null, trigger_type,
    trigger_config || '{}', script || '', active !== undefined ? active : 1)

  const created = db.prepare('SELECT * FROM automations WHERE id = ?').get(id)

  if (created.trigger_type === 'schedule' && created.active) {
    scheduleAutomation(created)
  }

  res.status(201).json(created)
})

// PATCH /api/automations/:id
router.patch('/:id', (req, res) => {
  const automation = db.prepare(
    'SELECT * FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })

  const { name, description, trigger_type, trigger_config, script, active } = req.body

  db.prepare(`
    UPDATE automations SET
      name = COALESCE(?, name),
      description = COALESCE(?, description),
      trigger_type = COALESCE(?, trigger_type),
      trigger_config = COALESCE(?, trigger_config),
      script = COALESCE(?, script),
      active = COALESCE(?, active),
      updated_at = datetime('now')
    WHERE id = ?
  `).run(
    name !== undefined ? name.trim() : null,
    description !== undefined ? description : null,
    trigger_type !== undefined ? trigger_type : null,
    trigger_config !== undefined ? trigger_config : null,
    script !== undefined ? script : null,
    active !== undefined ? active : null,
    req.params.id
  )

  const updated = db.prepare('SELECT * FROM automations WHERE id = ?').get(req.params.id)

  // Mettre à jour le scheduler
  if (updated.trigger_type === 'schedule') {
    if (updated.active) scheduleAutomation(updated)
    else unscheduleAutomation(updated.id)
  } else {
    unscheduleAutomation(updated.id)
  }

  res.json(updated)
})

// DELETE /api/automations/:id
router.delete('/:id', (req, res) => {
  const automation = db.prepare(
    'SELECT id FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })

  db.prepare("UPDATE automations SET deleted_at = datetime('now') WHERE id = ?").run(req.params.id)
  unscheduleAutomation(req.params.id)
  res.json({ success: true })
})

// GET /api/automations/:id/logs
router.get('/:id/logs', (req, res) => {
  const automation = db.prepare(
    'SELECT id FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })

  const logs = db.prepare(`
    SELECT * FROM automation_logs WHERE automation_id = ? ORDER BY created_at DESC LIMIT 50
  `).all(req.params.id)
  res.json(logs)
})

// POST /api/automations/:id/run
router.post('/:id/run', async (req, res) => {
  const automation = db.prepare(
    'SELECT * FROM automations WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.id)
  if (!automation) return res.status(404).json({ error: 'Introuvable' })

  const result = await runAutomation(automation, { trigger: 'manual' })
  res.json(result)
})

export default router
