import { Router } from 'express'
import { randomUUID, timingSafeEqual } from 'crypto'
import { readFileSync, writeFileSync, renameSync } from 'fs'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { requireAuth } from '../middleware/auth.js'
import { AGENT_INTERNAL_SECRET } from '../config/secrets.js'
import { runNextTask, isRunnerBusy, getCurrentTaskId, getStreamBuffer } from '../services/taskRunner.js'

function safeEqualSecret(provided, expected) {
  if (!provided || !expected) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

const router = Router()

// Path to the file-based task queue (tracked in git, readable by remote agent)
const TASKS_FILE = resolve(fileURLToPath(import.meta.url), '../../../../../agent-tasks.json')
const TASKS_TMP  = TASKS_FILE + '.tmp'

function readTasks() {
  try {
    return JSON.parse(readFileSync(TASKS_FILE, 'utf8'))
  } catch {
    return []
  }
}

function writeTasks(tasks) {
  writeFileSync(TASKS_TMP, JSON.stringify(tasks, null, 2) + '\n', 'utf8')
  renameSync(TASKS_TMP, TASKS_FILE)
}

const _STATUS_ORDER = { in_progress: 0, approved: 1, pending: 2, blocked: 3, done: 4, rejected: 5 }

function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    return b.created_at.localeCompare(a.created_at)
  })
}

// POST /api/agent/tasks/internal — used by Claude subprocess to create sub-tasks (no JWT auth)
router.post('/tasks/internal', (req, res) => {
  if (!AGENT_INTERNAL_SECRET) {
    return res.status(503).json({ error: 'agent endpoint disabled (AGENT_INTERNAL_SECRET not configured)' })
  }
  if (!safeEqualSecret(req.headers['x-agent-secret'], AGENT_INTERNAL_SECRET)) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  const { description, priority = 0 } = req.body
  if (!description) return res.status(400).json({ error: 'description required' })
  const task = {
    id: randomUUID(),
    description,
    status: 'pending',
    priority,
    user_comment: null,
    agent_result: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: null,
  }
  const tasks = readTasks()
  tasks.push(task)
  writeTasks(tasks)
  res.status(201).json(task)
})

// All routes below require authentication
router.use(requireAuth)

// GET /api/agent/tasks
router.get('/tasks', (req, res) => {
  res.json(sortTasks(readTasks()))
})

// POST /api/agent/tasks
router.post('/tasks', (req, res) => {
  const { description, priority = 0 } = req.body
  if (!description) return res.status(400).json({ error: 'description required' })
  const task = {
    id: randomUUID(),
    description,
    status: 'approved',
    priority,
    user_comment: null,
    agent_result: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    completed_at: null,
  }
  const tasks = readTasks()
  tasks.push(task)
  writeTasks(tasks)
  res.status(201).json(task)
  // Auto-approved: kick the runner immediately
  setImmediate(runNextTask)
})

// PATCH /api/agent/tasks/:id
router.patch('/tasks/:id', (req, res) => {
  const tasks = readTasks()
  const idx = tasks.findIndex(t => t.id === req.params.id)
  if (idx === -1) return res.status(404).json({ error: 'not found' })

  const allowed = ['status', 'user_comment', 'agent_result', 'priority', 'description', 'feedback']
  const task = { ...tasks[idx] }
  for (const key of allowed) {
    if (key in req.body) task[key] = req.body[key]
  }
  if (req.body.status === 'done' && tasks[idx].status !== 'done') {
    task.completed_at = new Date().toISOString()
  }
  task.updated_at = new Date().toISOString()
  tasks[idx] = task
  writeTasks(tasks)
  res.json(task)

  // If a task was just approved, kick the runner
  if (req.body.status === 'approved') {
    setImmediate(runNextTask)
  }
})

// GET /api/agent/runner/status
router.get('/runner/status', (req, res) => {
  res.json({ busy: isRunnerBusy(), currentTaskId: getCurrentTaskId() })
})

// GET /api/agent/tasks/:id/stream-log — fetch buffered stream chunks for a task
router.get('/tasks/:id/stream-log', (req, res) => {
  res.json({ chunks: getStreamBuffer(req.params.id) })
})

// DELETE /api/agent/tasks/:id
router.delete('/tasks/:id', (req, res) => {
  const tasks = readTasks()
  writeTasks(tasks.filter(t => t.id !== req.params.id))
  res.json({ ok: true })
})

export default router
