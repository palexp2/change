import { Router } from 'express'
import { randomUUID } from 'crypto'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const MEMORY_PATH = process.env.DATABASE_PATH
  ? path.join(path.dirname(path.resolve(process.cwd(), process.env.DATABASE_PATH)), 'agent-memory.md')
  : path.join(__dirname, '../../data/agent-memory.md')

function ensureMemoryFile() {
  const dir = path.dirname(MEMORY_PATH)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  if (!existsSync(MEMORY_PATH)) {
    writeFileSync(MEMORY_PATH, `# Mémoire de l'agent Orisha\n\n_Ce fichier est la mémoire persistante de l'agent autonome. Il peut y noter des informations importantes entre les sessions._\n\n## Contexte général\n\n## Notes de l'agent\n\n## Préférences utilisateur\n`, 'utf8')
  }
}

// Compute next run time (every 30 min at :00 and :30)
function getNextRunTime() {
  const now = new Date()
  const next = new Date(now)
  const minutes = now.getMinutes()
  if (minutes < 30) {
    next.setMinutes(30, 0, 0)
  } else {
    next.setHours(now.getHours() + 1, 0, 0, 0)
  }
  return next.toISOString()
}

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

// GET /api/agent/status — agent run status
router.get('/status', (req, res) => {
  res.json({
    next_run: getNextRunTime(),
    interval_minutes: 30,
  })
})

// GET /api/agent/memory — read memory file
router.get('/memory', (req, res) => {
  try {
    ensureMemoryFile()
    const content = readFileSync(MEMORY_PATH, 'utf8')
    res.json({ content })
  } catch (err) {
    res.status(500).json({ error: 'Impossible de lire le fichier mémoire' })
  }
})

// PUT /api/agent/memory — write memory file
router.put('/memory', (req, res) => {
  const { content } = req.body
  if (typeof content !== 'string') return res.status(400).json({ error: 'content required' })
  try {
    ensureMemoryFile()
    writeFileSync(MEMORY_PATH, content, 'utf8')
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'Impossible d\'écrire le fichier mémoire' })
  }
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

// PATCH /api/agent/tasks/:id — update status, comment, result, feedback
router.patch('/tasks/:id', (req, res) => {
  const { id } = req.params
  const task = db.prepare('SELECT * FROM agent_tasks WHERE id = ?').get(id)
  if (!task) return res.status(404).json({ error: 'not found' })

  const allowed = ['status', 'user_comment', 'agent_result', 'priority', 'title', 'description', 'feedback']
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
