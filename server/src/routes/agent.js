import { Router } from 'express'
import { randomUUID } from 'crypto'
import { readFileSync, writeFileSync, renameSync } from 'fs'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import { requireAuth } from '../middleware/auth.js'
import { runNextTask, isRunnerBusy, getCurrentTaskId, getStreamBuffer } from '../services/taskRunner.js'

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

const STATUS_ORDER = { in_progress: 0, approved: 1, pending: 2, blocked: 3, done: 4, rejected: 5 }

function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const so = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9)
    if (so !== 0) return so
    if (b.priority !== a.priority) return b.priority - a.priority
    return a.created_at.localeCompare(b.created_at)
  })
}

// POST /api/agent/tasks/internal — used by Claude subprocess to create sub-tasks (no JWT auth)
router.post('/tasks/internal', (req, res) => {
  const secret = process.env.AGENT_INTERNAL_SECRET || 'agent-internal-secret'
  if (req.headers['x-agent-secret'] !== secret) {
    return res.status(401).json({ error: 'unauthorized' })
  }
  const { title, description, priority = 0 } = req.body
  if (!title) return res.status(400).json({ error: 'title required' })
  const task = {
    id: randomUUID(),
    title,
    description: description || null,
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
  const { title, description, priority = 0 } = req.body
  if (!title) return res.status(400).json({ error: 'title required' })
  const task = {
    id: randomUUID(),
    title,
    description: description || null,
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

  const allowed = ['status', 'user_comment', 'agent_result', 'priority', 'title', 'description', 'feedback']
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

// POST /api/agent/claude/run — spawn claude CLI and stream output via SSE
router.post('/claude/run', requireAuth, (req, res) => {
  const { message } = req.body
  if (!message?.trim()) return res.status(400).json({ error: 'message required' })

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()

  const cwd = '/home/ec2-user/erp'
  const claudeBin = '/home/ec2-user/.local/bin/claude'
  const escaped = message.trim().replace(/'/g, `'"'"'`)

  // Supprimer les variables héritées de Claude Code pour éviter la détection d'imbrication
  const { CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, ...cleanEnv } = process.env

  const proc = spawn('bash', [
    '-c',
    `echo '${escaped}' | '${claudeBin}' -p --output-format stream-json --verbose --allowedTools 'Bash,Read,Write,Edit,Glob,Grep'`,
  ], { cwd, env: { ...cleanEnv, HOME: '/home/ec2-user' } })

  let buffer = ''
  let procDone = false

  proc.stdout.on('data', chunk => {
    buffer += chunk.toString()
    const lines = buffer.split('\n')
    buffer = lines.pop()
    for (const line of lines) {
      if (line.trim()) res.write(`data: ${line}\n\n`)
    }
  })

  proc.stderr.on('data', () => {})

  proc.on('close', (code) => {
    procDone = true
    if (buffer.trim()) res.write(`data: ${buffer}\n\n`)
    res.write(`data: ${JSON.stringify({ type: 'done', code })}\n\n`)
    res.end()
  })

  res.on('close', () => {
    if (!procDone) { try { proc.kill() } catch {} }
  })
})

export default router
