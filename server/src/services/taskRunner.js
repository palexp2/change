import { spawn, execSync } from 'child_process'
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'fs'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { broadcastAll } from './realtime.js'

const TASKS_FILE = resolve(fileURLToPath(import.meta.url), '../../../../../agent-tasks.json')
const TASKS_TMP  = TASKS_FILE + '.tmp'
const PID_FILE   = resolve(fileURLToPath(import.meta.url), '../../../../../.agent-pid')
const CLAUDE_BIN = '/home/ec2-user/.local/bin/claude'
const CWD = '/home/ec2-user/erp'

let busy = false
let currentTaskId = null
let currentProc = null

// In-memory stream buffer per task: taskId -> chunk[]
const streamBuffers = new Map()

function appendStreamChunk(taskId, chunk) {
  if (!streamBuffers.has(taskId)) streamBuffers.set(taskId, [])
  const buf = streamBuffers.get(taskId)
  buf.push(chunk)
  if (buf.length > 500) buf.shift()
  broadcastAll({ type: 'agent:task:stream', taskId, chunk })
}

export function getStreamBuffer(taskId) {
  return streamBuffers.get(taskId) || []
}

function readTasks() {
  try { return JSON.parse(readFileSync(TASKS_FILE, 'utf8')) } catch { return [] }
}

// Atomic write: write to .tmp then rename — prevents partial-write corruption
function writeTasks(tasks) {
  writeFileSync(TASKS_TMP, JSON.stringify(tasks, null, 2) + '\n', 'utf8')
  renameSync(TASKS_TMP, TASKS_FILE)
}

function updateTask(id, updates) {
  const tasks = readTasks()
  const idx = tasks.findIndex(t => t.id === id)
  if (idx === -1) return null
  const task = { ...tasks[idx], ...updates, updated_at: new Date().toISOString() }
  tasks[idx] = task
  writeTasks(tasks)
  return task
}

function broadcastTask(task) {
  broadcastAll({ type: 'agent:task:updated', task })
}

export function isRunnerBusy() { return busy }
export function getCurrentTaskId() { return currentTaskId }

export function runNextTask() {
  if (busy) return
  const tasks = readTasks()
  const next = tasks
    .filter(t => t.status === 'approved')
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority
      return a.created_at.localeCompare(b.created_at)
    })[0]

  if (!next) return

  busy = true
  currentTaskId = next.id

  const task = updateTask(next.id, { status: 'in_progress' })
  broadcastTask(task)

  const internalSecret = process.env.AGENT_INTERNAL_SECRET || 'agent-internal-secret'
  const userComment = next.user_comment ? `\n\nCommentaire humain: ${next.user_comment}` : ''
  const prompt = [
    'Tu es un agent ERP Orisha. Exécute UNIQUEMENT la tâche suivante — ne lis pas agent-tasks.json ni aucun autre fichier de gestion des tâches.\n\n',
    `Titre: ${next.title}`,
    next.description ? `\n\nDescription:\n${next.description}` : '',
    userComment,
    '\n\nSi la tâche est trop complexe ou nécessite une approbation humaine pour une sous-étape, ',
    'crée une sous-tâche (elle restera en attente jusqu\'à approbation humaine):\n',
    `curl -s -X POST http://localhost:3004/api/agent/tasks/internal \\
  -H 'Content-Type: application/json' \\
  -H 'X-Agent-Secret: ${internalSecret}' \\
  -d '{"title":"...","description":"...","priority":0}'\n\n`,
    'Rapporte en détail ce que tu as accompli (ou pourquoi tu es bloqué).',
  ].join('')

  const { CLAUDECODE, CLAUDE_CODE_ENTRYPOINT, ...cleanEnv } = process.env

  const proc = spawn(CLAUDE_BIN, [
    '-p', '--output-format', 'stream-json', '--verbose',
    '--allowedTools', 'Bash,Read,Write,Edit,Glob,Grep',
  ], { cwd: CWD, env: { ...cleanEnv, HOME: '/home/ec2-user' }, stdio: 'pipe', detached: true })

  // Detach so Claude survives pm2 restart (it may call pm2 restart itself)
  proc.unref()
  currentProc = proc
  writeFileSync(PID_FILE, `${proc.pid}\n${next.id}`, 'utf8')

  proc.stdin.write(prompt)
  proc.stdin.end()

  let output = ''
  let lineBuffer = ''

  proc.stdout.on('data', rawChunk => {
    const str = rawChunk.toString()
    output += str
    lineBuffer += str
    const parts = lineBuffer.split('\n')
    lineBuffer = parts.pop() // keep incomplete last line
    for (const line of parts) {
      if (!line.trim()) continue
      try {
        const evt = JSON.parse(line)
        if (evt.type === 'assistant' && evt.message?.content) {
          for (const block of evt.message.content) {
            if (block.type === 'text' && block.text?.trim()) {
              appendStreamChunk(next.id, { kind: 'text', text: block.text })
            } else if (block.type === 'tool_use') {
              const inp = block.input
              const preview = inp?.command || inp?.file_path || inp?.pattern ||
                (typeof inp === 'object' ? String(Object.values(inp)[0] ?? '').slice(0, 120) : '')
              appendStreamChunk(next.id, { kind: 'tool', name: block.name, input: preview })
            }
          }
        }
        if (evt.type === 'user' && evt.message?.content) {
          for (const block of evt.message.content) {
            if (block.type === 'tool_result') {
              let content = ''
              if (typeof block.content === 'string') {
                content = block.content
              } else if (Array.isArray(block.content)) {
                content = block.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
              }
              const trimmed = content.trim()
              if (trimmed) {
                appendStreamChunk(next.id, { kind: 'result', content: trimmed.slice(0, 400) })
              }
            }
          }
        }
      } catch {}
    }
  })
  proc.stderr.on('data', () => {})

  proc.on('close', (code) => {
    // Extract assistant text blocks from stream-json output
    let result = ''
    for (const line of output.split('\n')) {
      if (!line.trim()) continue
      try {
        const evt = JSON.parse(line)
        if (evt.type === 'assistant' && evt.message?.content) {
          for (const block of evt.message.content) {
            if (block.type === 'text') result += block.text
          }
        }
      } catch {}
    }

    const finalTask = updateTask(next.id, {
      status: code === 0 ? 'done' : 'blocked',
      agent_result: result || `(exit code: ${code})`,
      completed_at: new Date().toISOString(),
    })
    if (finalTask) broadcastTask(finalTask)

    busy = false
    currentTaskId = null
    currentProc = null
    try { unlinkSync(PID_FILE) } catch {}

    // Keep stream buffer 2 minutes then discard
    setTimeout(() => streamBuffers.delete(next.id), 120_000)

    // Chain: immediately try next approved task
    setImmediate(runNextTask)
  })
}

// Check if a PID is still running
function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

export function initTaskRunner() {
  // Check if an orphaned Claude process from a previous server instance is still running
  if (existsSync(PID_FILE)) {
    try {
      const [pidStr, taskId] = readFileSync(PID_FILE, 'utf8').trim().split('\n')
      const pid = parseInt(pidStr)
      if (pid && isProcessAlive(pid)) {
        // Orphan Claude is still working — mark runner as busy and poll until it finishes
        console.log(`🤖 Agent: process orphelin détecté (PID ${pid}), en attente de fin…`)
        busy = true
        currentTaskId = taskId || null
        const poll = setInterval(() => {
          if (isProcessAlive(pid)) return
          clearInterval(poll)
          console.log(`🤖 Agent: process orphelin terminé (PID ${pid})`)
          // Re-read the task — the orphan may have written its result via the API
          const tasks = readTasks()
          const task = tasks.find(t => t.id === taskId)
          if (task && task.status === 'in_progress') {
            // Orphan died without writing result — mark blocked
            updateTask(taskId, { status: 'blocked', agent_result: '(process interrompu par un redémarrage serveur)' })
          }
          busy = false
          currentTaskId = null
          try { unlinkSync(PID_FILE) } catch {}
          runNextTask()
        }, 3000)
        return
      }
    } catch {}
    // PID file exists but process is dead — clean up
    try { unlinkSync(PID_FILE) } catch {}
  }

  // No orphan — reset any stuck in_progress tasks and start
  const tasks = readTasks()
  let changed = false
  for (const t of tasks) {
    if (t.status === 'in_progress') {
      t.status = 'approved'
      t.updated_at = new Date().toISOString()
      changed = true
    }
  }
  if (changed) writeTasks(tasks)
  setImmediate(runNextTask)
}

// Called on server shutdown — do NOT kill Claude, let it finish as orphan
export function shutdownTaskRunner() {
  // Nothing to do: Claude is detached and will finish on its own.
  // The PID file stays so the next server instance can reconnect.
}
