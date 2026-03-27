import { Router } from 'express'
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

// GET /api/agent/tasks — list all tasks
router.get('/tasks', (req, res) => {
  const tasks = db.prepare(`
    SELECT * FROM agent_tasks ORDER BY
      CASE status
        WHEN 'in_progress' THEN 0
        WHEN 'approved'    THEN 1
        WHEN 'pending'     THEN 2
        WHEN 'blocked'     THEN 3
        WHEN 'done'        THEN 4
        WHEN 'rejected'    THEN 5
        ELSE 6
      END,
      priority DESC, created_at ASC
  `).all()
  res.json(tasks)
})

// POST /api/agent/tasks — create a task (user or agent)
router.post('/tasks', (req, res) => {
  const { title, description, priority = 0, status: reqStatus } = req.body
  if (!title) return res.status(400).json({ error: 'title required' })
  const status = reqStatus === 'approved' ? 'approved' : 'pending'
  const task = {
    id: randomUUID(),
    title,
    description: description || null,
    status,
    priority,
    user_comment: null,
    agent_result: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: null,
  }
  db.prepare(`
    INSERT INTO agent_tasks (id, title, description, status, priority, created_at, updated_at)
    VALUES (@id, @title, @description, @status, @priority, @created_at, @updated_at)
  `).run(task)
  res.status(201).json(task)
})

// PATCH /api/agent/tasks/:id — update status, comment, result
router.patch('/tasks/:id', (req, res) => {
  const { id } = req.params
  const task = db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(id)
  if (!task) return res.status(404).json({ error: 'not found' })

  const allowed = ['status', 'user_comment', 'agent_result', 'priority', 'title', 'description']
  const updates = {}
  for (const key of allowed) {
    if (key in req.body) updates[key] = req.body[key]
  }

  if (updates.status === 'done' && task.status !== 'done') {
    updates.completed_at = new Date().toISOString()
  }
  updates.updated_at = new Date().toISOString()

  const sets = Object.keys(updates).map(k => `${k} = @${k}`).join(', ')
  db.prepare(`UPDATE agent_tasks SET ${sets} WHERE id = @id`).run({ ...updates, id })
  res.json(db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(id))
})

// DELETE /api/agent/tasks/:id
router.delete('/tasks/:id', (req, res) => {
  db.prepare('DELETE FROM agent_tasks WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

export default router
