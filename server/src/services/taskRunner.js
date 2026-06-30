import { spawn } from 'child_process'
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import cron from 'node-cron'
import db from '../db/database.js'
import { broadcastAll } from './realtime.js'
import { AGENT_INTERNAL_SECRET } from '../config/secrets.js'

// ─── Paths (must match what the running server already uses) ──────────────────
// Resolves to the repo root /home/ec2-user/erp/ (versioned + backed up by WIP snapshots).
const TASKS_FILE    = resolve(fileURLToPath(import.meta.url), '../../../../agent-tasks.json')
const TASKS_TMP     = TASKS_FILE + '.tmp'
const DATA_DIR      = dirname(TASKS_FILE)
const BACKLOG_FILE  = resolve(DATA_DIR, 'agent-backlog.json')
const SETTINGS_FILE = resolve(DATA_DIR, 'agent-settings.json')
const PID_FILE      = resolve(fileURLToPath(import.meta.url), '../../../../.agent-pid')
const CLAUDE_BIN    = '/home/ec2-user/.local/bin/claude'
const CWD           = '/home/ec2-user/erp'

// Per-execution durable artifacts (ignored by git). The detached exec Claude writes
// its stream + exit code HERE, not to the parent's stdout pipe — so a `pm2 restart`
// (mandatory after server changes) can't lose the result or SIGPIPE-kill the child.
const EXEC_LOG    = id => resolve(DATA_DIR, `.agent-exec-${id}.log`)
const EXEC_CODE   = id => resolve(DATA_DIR, `.agent-exec-${id}.code`)
const EXEC_PROMPT = id => resolve(DATA_DIR, `.agent-exec-${id}.prompt`)

// ─── Tunables (settled during the design grilling) ────────────────────────────
const MAX_OPEN_PROPOSALS = 25           // generation pauses when this many proposals await triage
const EXEC_TIMEOUT_MS    = 30 * 60_000  // hard kill an execution after 30 min
const READONLY_TIMEOUT_MS = 8 * 60_000  // generation / conversation read-only turns
const READONLY_TOOLS = 'Read,Glob,Grep' // truly read-only — no Bash/Write/Edit
const EXEC_TOOLS     = 'Bash,Read,Write,Edit,Glob,Grep'

// ─── Prompt général (préambule système, éditable depuis la page Agent) ─────────
// Injecté en tête de CHAQUE activité (génération / conversation / exécution).
// Surchargeable via agent-settings.json (clé `generalPrompt`) — voir getSettings().
export const DEFAULT_GENERAL_PROMPT =
  'Tu es un agent autonome d\'amélioration de l\'ERP Orisha (repo à /home/ec2-user/erp). ' +
  'L\'ERP est une app single-tenant qui couvre marketing, ventes, logistique, assemblage, comptabilité, RH et dashboards. ' +
  'Respecte toujours le CLAUDE.md à la racine du projet.'

function generalPrompt() {
  const p = getSettings().generalPrompt
  return (typeof p === 'string' && p.trim()) ? p.trim() : DEFAULT_GENERAL_PROMPT
}

// ─── Modèles de prompt par activité (éditables depuis la page Agent) ───────────
// Chaque modèle est le prompt COMPLET d'une activité (au-delà du préambule général).
// Les jetons {{placeholder}} sont remplacés au moment de l'exécution par renderTemplate().
// Surchargeables via agent-settings.json (clés generationPrompt / conversationPrompt /
// executionPrompt) — un champ vide retombe sur le défaut ci-dessous (voir promptTemplate()).
//
// Placeholders disponibles :
//   génération    : {{general}} {{slots}} {{backlog}} {{signals}} {{history}}
//   conversation  : {{general}} {{proposal}} {{why}} {{zone}} {{thread}}
//   exécution     : {{general}} {{brief}} {{internalSecret}}

export const DEFAULT_GENERATION_PROMPT = [
  '{{general}}', '\n\n',
  'Tu es en LECTURE SEULE: explore le code (Read/Glob/Grep) mais ne modifie RIEN.\n\n',
  'Génère AU PLUS {{slots}} proposition(s) d\'amélioration, de haute qualité, ancrées dans le réel.\n\n',
  '=== SOURCES D\'IDÉES (par ordre de priorité) ===\n',
  'D. BACKLOG de l\'humain (PRIORITÉ ABSOLUE — élabore-les d\'abord, une proposition par note si pertinent):\n',
  '{{backlog}}', '\n\n',
  'C. CONFORMITÉ aux règles design du CLAUDE.md (DataTable partout, autosave partout, pickers FK cliquables, dropdowns recherchables >10 options, modales de confirmation des side effects…). Cherche les VIOLATIONS réelles dans client/src/.\n',
  'B. SIGNAUX SYSTÈME réels (erreurs récentes sync_log / automation_logs, TODO/FIXME dans le code):\n',
  '{{signals}}', '\n',
  'Note: si "readErrors" est non vide ci-dessus, la lecture des logs de santé a ÉCHOUÉ — les listes d\'erreurs sont incomplètes/non fiables, ne conclus PAS que le système est sain.\n',
  'A. SCAN libre du code (dette technique, incohérences) — minoritaire, seulement si vraiment pertinent.\n\n',
  '=== NE PAS REPROPOSER (historique — dédup strict) ===\n',
  '{{history}}', '\n',
  'Ne propose JAMAIS une idée déjà rejetée, déjà faite, ou déjà ouverte ci-dessus. Tiens compte des raisons de rejet pour te calibrer.\n\n',
  '=== FORMAT DE SORTIE ===\n',
  'Après ton exploration, termine ta réponse par UN SEUL bloc ```json contenant un tableau d\'objets. Chaque objet:\n',
  '{\n',
  '  "title": "une ligne",\n',
  '  "why": "le problème réel / la règle / le signal qui déclenche ça (2-3 phrases)",\n',
  '  "source": "A" | "B" | "C" | "D",\n',
  '  "zone": "fichiers/domaines concrets touchés (ex: client/src/pages/X.jsx)",\n',
  '  "risk": "low" | "high",  // high = touche argent/compta, auth/sécurité, OAuth connectors, ou schéma DB\n',
  '  "side_effects": "side effects déclenchés (email, push tiers, mouvement monétaire, cascade) ou \\"aucun\\"",\n',
  '  "effort": "small" | "medium" | "large",\n',
  '  "backlog_id": "id de la note backlog si dérivée de D, sinon omettre"\n',
  '}\n',
  'Si tu n\'as aucune bonne idée ancrée, renvoie un tableau vide []. Pas de remplissage gratuit.',
].join('')

export const DEFAULT_CONVERSATION_PROMPT = [
  '{{general}}', '\n\n',
  'Tu DISCUTES d\'une proposition d\'amélioration avec l\'humain — tu ne codes PAS maintenant.\n',
  'Tu es en LECTURE SEULE: tu peux explorer le code (Read/Glob/Grep) pour répondre précisément, mais tu ne modifies RIEN.\n\n',
  'Proposition: {{proposal}}\n',
  '{{why}}',
  '{{zone}}',
  '\nFil de discussion:\n{{thread}}\n\n',
  'Réponds au DERNIER message de l\'humain de façon concise (max ~150 mots). ',
  'Tu peux raffiner l\'idée, clarifier la zone touchée ou le risque, ou proposer une variante. ',
  'Si l\'humain demande des changements, confirme-les: ils seront appliqués quand il cliquera « Approuver & coder ». ',
  'Ne produis que ta réponse, sans préambule.',
].join('')

export const DEFAULT_EXECUTION_PROMPT = [
  '{{general}}', '\n\n',
  'Implémente UNIQUEMENT la tâche ci-dessous. ',
  'Ne lis pas agent-tasks.json ni les autres fichiers de gestion de tâches de l\'agent.\n\n',
  '{{brief}}',
  '\n\n=== RÈGLES IMPÉRATIVES (CLAUDE.md) ===\n',
  '- Respecte le CLAUDE.md à la racine du projet (lis-le si besoin).\n',
  '- Definition of Done frontend: toute modif dans client/src/ DOIT être suivie de `cd /home/ec2-user/erp/client && npm run build` PUIS d\'un test Playwright réel dans e2e/tests/ exécuté contre http://localhost:3004/erp.\n',
  '- Toute modif serveur (server/src/) DOIT être suivie de `pm2 restart erp-server`.\n',
  '- Si un test E2E échoue: corrige et relance. Au MAXIMUM 3 tentatives de correction. Si après 3 tentatives le test échoue encore, ARRÊTE, n\'invente rien, et explique clairement le blocage (ce sera marqué « bloqué »).\n',
  '- Nettoie tout record créé par tes tests E2E (hook after()), et restaure toute configuration existante que le test a écrasée — voir CLAUDE.md.\n\n',
  'Si tu as besoin d\'une approbation humaine pour une sous-étape, crée une sous-tâche:\n',
  'curl -s -X POST http://localhost:3004/api/agent/tasks/internal -H \'Content-Type: application/json\' -H \'X-Agent-Secret: {{internalSecret}}\' -d \'{"description":"...","priority":0}\'\n\n',
  'Termine par un rapport détaillé: ce que tu as changé, le résultat du build et des tests E2E (vert/rouge), ou la raison du blocage.',
].join('')

// Map clé de réglage → modèle par défaut. Source de vérité partagée avec la route
// GET /settings (qui renvoie ces défauts au front pour le bouton « Réinitialiser »).
export const PROMPT_TEMPLATE_DEFAULTS = {
  generationPrompt:   DEFAULT_GENERATION_PROMPT,
  conversationPrompt: DEFAULT_CONVERSATION_PROMPT,
  executionPrompt:    DEFAULT_EXECUTION_PROMPT,
}

// Récupère le modèle effectif d'une activité : override utilisateur si non vide, sinon défaut.
function promptTemplate(key) {
  const v = getSettings()[key]
  return (typeof v === 'string' && v.trim()) ? v : PROMPT_TEMPLATE_DEFAULTS[key]
}

// Remplace les jetons {{placeholder}} par leur valeur. N'affecte QUE les doubles accolades —
// les accolades simples du schéma JSON de sortie sont préservées telles quelles.
function renderTemplate(tpl, vars) {
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k] ?? '') : m))
}

// ─── Single global slot ───────────────────────────────────────────────────────
// Exactly ONE Claude activity runs at a time (execution / conversation / generation),
// because everything edits or reads the live working tree — no isolation.
// Priority: execution > conversation > generation.
let busy = false
let currentTaskId = null
let currentActivity = null     // 'execution' | 'conversation' | 'generation'
let _currentProc = null
let _genRequested = false
const _replyQueue = []         // proposal ids awaiting a conversation reply

// In-memory stream buffer per task: taskId -> chunk[]
const streamBuffers = new Map()

function appendStreamChunk(taskId, chunk) {
  if (!taskId) return
  if (!streamBuffers.has(taskId)) streamBuffers.set(taskId, [])
  const buf = streamBuffers.get(taskId)
  buf.push(chunk)
  if (buf.length > 500) buf.shift()
  broadcastAll({ type: 'agent:task:stream', taskId, chunk })
}

export function getStreamBuffer(taskId) {
  return streamBuffers.get(taskId) || []
}

// Parse ONE line of Claude's stream-json output and push UI chunks (no-op if taskId null).
function streamLine(taskId, line) {
  if (!taskId || !line.trim()) return
  try {
    const evt = JSON.parse(line)
    if (evt.type === 'assistant' && evt.message?.content) {
      for (const block of evt.message.content) {
        if (block.type === 'text' && block.text?.trim()) {
          appendStreamChunk(taskId, { kind: 'text', text: block.text })
        } else if (block.type === 'tool_use') {
          const inp = block.input
          const preview = inp?.command || inp?.file_path || inp?.pattern ||
            (typeof inp === 'object' ? String(Object.values(inp)[0] ?? '').slice(0, 120) : '')
          appendStreamChunk(taskId, { kind: 'tool', name: block.name, input: preview })
        }
      }
    } else if (evt.type === 'user' && evt.message?.content) {
      for (const block of evt.message.content) {
        if (block.type === 'tool_result') {
          let content = ''
          if (typeof block.content === 'string') content = block.content
          else if (Array.isArray(block.content)) content = block.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
          const trimmed = content.trim()
          if (trimmed) appendStreamChunk(taskId, { kind: 'result', content: trimmed.slice(0, 400) })
        }
      }
    }
  } catch {}
}

// Concatenate the assistant's final text blocks from a full stream-json transcript.
function extractAssistantText(transcript) {
  let text = ''
  for (const line of transcript.split('\n')) {
    if (!line.trim()) continue
    try {
      const evt = JSON.parse(line)
      if (evt.type === 'assistant' && evt.message?.content) {
        for (const block of evt.message.content) {
          if (block.type === 'text') text += block.text
        }
      }
    } catch {}
  }
  return text
}

// ─── File-backed stores (atomic write) ────────────────────────────────────────
function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJson(file, value) {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

function readTasks() { return readJson(TASKS_FILE, []) }
function writeTasks(tasks) {
  writeFileSync(TASKS_TMP, JSON.stringify(tasks, null, 2) + '\n', 'utf8')
  renameSync(TASKS_TMP, TASKS_FILE)
}

export function getSettings() {
  return {
    enabled: false,
    generalPrompt: DEFAULT_GENERAL_PROMPT,
    generationPrompt: DEFAULT_GENERATION_PROMPT,
    conversationPrompt: DEFAULT_CONVERSATION_PROMPT,
    executionPrompt: DEFAULT_EXECUTION_PROMPT,
    ...readJson(SETTINGS_FILE, {}),
  }
}
export function setSettings(patch) {
  const next = { ...getSettings(), ...patch }
  writeJson(SETTINGS_FILE, next)
  broadcastAll({ type: 'agent:settings:updated', settings: next })
  // Turning the agent ON may unblock queued work.
  if (next.enabled) setImmediate(kick)
  return next
}

export function readBacklog() { return readJson(BACKLOG_FILE, []) }
function writeBacklog(items) { writeJson(BACKLOG_FILE, items); broadcastAll({ type: 'agent:backlog:updated' }) }
export function addBacklogItem(text) {
  const item = { id: randomUUID(), text, processed: false, created_at: new Date().toISOString() }
  const items = readBacklog()
  items.push(item)
  writeBacklog(items)
  return item
}
export function deleteBacklogItem(id) {
  writeBacklog(readBacklog().filter(i => i.id !== id))
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

function broadcastTask(task) { broadcastAll({ type: 'agent:task:updated', task }) }

export function isRunnerBusy() { return busy }
export function getCurrentTaskId() { return currentTaskId }
export function getCurrentActivity() { return currentActivity }

// ─── Public scheduling API ────────────────────────────────────────────────────
export function requestGeneration() { _genRequested = true; setImmediate(kick) }
export function requestReply(taskId) {
  if (!_replyQueue.includes(taskId)) _replyQueue.push(taskId)
  setImmediate(kick)
}

// runNextTask kept as a public alias for back-compat (routes call it after approve).
export function runNextTask() { kick() }

// ─── The scheduler heart: pick the next activity by priority ───────────────────
function kick() {
  if (busy) return
  if (!getSettings().enabled) {
    // Paused. Drop any pending generation request so it does NOT fire the instant
    // the agent is re-enabled — otherwise a generation queued while OFF (e.g. by the
    // hourly cron) would burst the moment the toggle flips back ON.
    _genRequested = false
    return
  }

  const tasks = readTasks()

  // 1. Execution has absolute priority — never read a tree mid-edit.
  const nextExec = tasks
    .filter(t => t.status === 'approved')
    .sort((a, b) => (b.priority - a.priority) || a.created_at.localeCompare(b.created_at))[0]
  if (nextExec) { executeTask(nextExec); return }

  // 2. Conversation replies (the user is waiting live).
  while (_replyQueue.length) {
    const id = _replyQueue.shift()
    const t = readTasks().find(x => x.id === id)
    if (t && (t.status === 'pending' || t.status === 'in_discussion')) { conversationReply(t); return }
  }

  // 3. Idea generation — only if the triage queue has room.
  if (_genRequested) {
    _genRequested = false
    const open = tasks.filter(t => t.status === 'pending' || t.status === 'in_discussion').length
    if (open < MAX_OPEN_PROPOSALS) { generate(); return }
  }
}

function releaseSlot() {
  busy = false
  currentTaskId = null
  currentActivity = null
  _currentProc = null
  setImmediate(kick)
}

// ─── Read-only Claude spawn helper (conversation / generation) ─────────────────
// Pipe-based & in-process. Resolves with { code, text, timedOut }. NOT for execution:
// these turns are short, read-only, and never restart the server, so the in-process
// completion handler is safe here. Execution uses runDetachedExecution() instead.
function spawnClaude({ prompt, allowedTools, streamTaskId = null, timeoutMs }) {
  return new Promise((resolveP) => {
    const { CLAUDECODE: _c, CLAUDE_CODE_ENTRYPOINT: _e, ...cleanEnv } = process.env
    const proc = spawn(CLAUDE_BIN, [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--allowedTools', allowedTools,
    ], { cwd: CWD, env: { ...cleanEnv, HOME: '/home/ec2-user' }, stdio: 'pipe' })

    _currentProc = proc

    proc.stdin.write(prompt)
    proc.stdin.end()

    let output = ''
    let lineBuffer = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      try { proc.kill('SIGKILL') } catch {}
    }, timeoutMs)

    proc.stdout.on('data', rawChunk => {
      const str = rawChunk.toString()
      output += str
      lineBuffer += str
      const parts = lineBuffer.split('\n')
      lineBuffer = parts.pop()
      for (const line of parts) streamLine(streamTaskId, line)
    })
    proc.stderr.on('data', () => {})

    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const timedOut = code === null || code === 137 // SIGKILL
      resolveP({ code, text: extractAssistantText(output), timedOut })
    })
  })
}

// ─── Detached execution — durable result (survives `pm2 restart erp-server`) ────
// The exec Claude runs inside a detached bash wrapper that redirects its stream to a
// log file and writes the exit code to a sibling file when done. Because nothing reads
// the child's stdout pipe, a parent restart neither loses the result nor SIGPIPE-kills
// the child. monitorExecution() tails the log to stream live and finalizes the task off
// the .code file — the same path used to reconnect after a restart. (taskId, optional pid
// when reconnecting to an already-running orphan.)
export function monitorExecution(taskId, knownPid = null) {
  const LOG = EXEC_LOG(taskId)
  const CODE = EXEC_CODE(taskId)
  const startedAt = Date.now()
  let offset = 0
  let lineBuffer = ''
  let finished = false

  function drainLog() {
    try {
      if (!existsSync(LOG)) return
      const buf = readFileSync(LOG)
      if (buf.length <= offset) return
      const chunk = buf.slice(offset).toString('utf8')
      offset = buf.length
      lineBuffer += chunk
      const parts = lineBuffer.split('\n')
      lineBuffer = parts.pop()
      for (const line of parts) streamLine(taskId, line)
    } catch {}
  }

  function finalize({ killedTimeout = false } = {}) {
    if (finished) return
    finished = true
    clearInterval(poll)
    drainLog()

    let code = null
    try { if (existsSync(CODE)) code = parseInt(readFileSync(CODE, 'utf8').trim(), 10) } catch {}
    const text = existsSync(LOG) ? extractAssistantText(readFileSync(LOG, 'utf8')) : ''

    let status, agent_result
    if (killedTimeout) {
      status = 'blocked'
      agent_result = `(interrompu: dépassement du délai de ${Math.round(EXEC_TIMEOUT_MS / 60000)} min)\n\n${text}`
    } else if (code === 0) {
      status = 'done'
      agent_result = text || '(terminé sans rapport)'
    } else if (code === null) {
      status = 'blocked'
      agent_result = (text ? text + '\n\n' : '') + '(process interrompu sans code de sortie — relancer manuellement si besoin)'
    } else {
      status = 'blocked'
      agent_result = (text ? text + '\n\n' : '') + `(exit code: ${code})`
    }

    const finalTask = updateTask(taskId, { status, agent_result, completed_at: new Date().toISOString() })
    if (finalTask) broadcastTask(finalTask)

    try { unlinkSync(LOG) } catch {}
    try { unlinkSync(CODE) } catch {}
    try { unlinkSync(EXEC_PROMPT(taskId)) } catch {}
    try { unlinkSync(PID_FILE) } catch {}
    setTimeout(() => streamBuffers.delete(taskId), 120_000).unref?.()
    releaseSlot()
  }

  function currentPid() {
    if (knownPid) return knownPid
    try { return parseInt(readFileSync(PID_FILE, 'utf8').trim().split('\n')[0], 10) } catch { return null }
  }

  const poll = setInterval(() => {
    drainLog()
    // Primary signal: the wrapper wrote the exit code → done/blocked by code.
    if (existsSync(CODE)) { finalize(); return }
    // Hard timeout: kill the whole detached group, mark blocked.
    if (Date.now() - startedAt > EXEC_TIMEOUT_MS) {
      const pid = currentPid()
      if (pid) { try { process.kill(-pid, 'SIGKILL') } catch {} }
      finalize({ killedTimeout: true })
      return
    }
    // Process vanished without a code file (crash / SIGKILL) — give the FS a beat to
    // flush a possible last-moment .code, then finalize as blocked.
    const pid = currentPid()
    if (pid && !isProcessAlive(pid) && Date.now() - startedAt > 6000) {
      drainLog()
      finalize() // code stays null unless a .code appeared → blocked
    }
  }, 2000)

  drainLog()
}

function runDetachedExecution(taskId, prompt) {
  const LOG = EXEC_LOG(taskId)
  const CODE = EXEC_CODE(taskId)
  const PROMPT = EXEC_PROMPT(taskId)

  // Clear any stale artifacts from a previous run of the same id.
  for (const f of [LOG, CODE]) { try { if (existsSync(f)) unlinkSync(f) } catch {} }
  writeFileSync(PROMPT, prompt, 'utf8')

  const { CLAUDECODE: _c, CLAUDE_CODE_ENTRYPOINT: _e, ...cleanEnv } = process.env
  // claude reads the prompt from stdin (PROMPT file); stream-json → LOG; exit code → CODE.
  const cmd = `"${CLAUDE_BIN}" -p --output-format stream-json --verbose ` +
    `--allowedTools "${EXEC_TOOLS}" < "${PROMPT}" > "${LOG}" 2>&1; echo $? > "${CODE}"`

  const proc = spawn('bash', ['-c', cmd], {
    cwd: CWD,
    env: { ...cleanEnv, HOME: '/home/ec2-user' },
    detached: true,
    stdio: 'ignore', // nobody reads the child's stdout → restart can't SIGPIPE it
  })
  proc.unref()
  writeFileSync(PID_FILE, `${proc.pid}\n${taskId}`, 'utf8')
  _currentProc = proc

  monitorExecution(taskId, proc.pid)
}

// ─── Execution (read-write, edits the live tree) ──────────────────────────────
function executeTask(next) {
  busy = true
  currentTaskId = next.id
  currentActivity = 'execution'

  // started_at : horodate le passage en in_progress pour alimenter le compteur de
  // temps écoulé côté UI (timer live pendant l'exécution, durée totale une fois terminée).
  const task = updateTask(next.id, { status: 'in_progress', started_at: new Date().toISOString() })
  broadcastTask(task)

  const internalSecret = AGENT_INTERNAL_SECRET || ''
  const isProposal = next.kind === 'proposal'

  let brief
  if (isProposal) {
    const thread = (next.messages || [])
      .map(m => `${m.role === 'user' ? 'Humain' : 'Agent'}: ${m.text}`)
      .join('\n')
    brief = [
      `Titre: ${next.title || next.description}`,
      next.why ? `\nPourquoi: ${next.why}` : '',
      next.zone ? `\nZone visée: ${next.zone}` : '',
      next.user_comment ? `\nCommentaire humain: ${next.user_comment}` : '',
      thread ? `\n\nFil de discussion (raffinements convenus):\n${thread}` : '',
    ].join('')
  } else {
    brief = `Description:\n${next.description}${next.user_comment ? `\n\nCommentaire humain: ${next.user_comment}` : ''}`
  }

  const prompt = renderTemplate(promptTemplate('executionPrompt'), {
    general: generalPrompt(),
    brief,
    internalSecret,
  })

  // Detached + durable: the result is recorded off a .code file, so a `pm2 restart`
  // triggered by the implementation itself can't lose the success and leave the task
  // wrongly "blocked". monitorExecution() handles streaming + finalization.
  runDetachedExecution(next.id, prompt)
}

// ─── Conversation reply (read-only) ───────────────────────────────────────────
function conversationReply(task) {
  busy = true
  currentTaskId = task.id
  currentActivity = 'conversation'

  const thread = (task.messages || [])
    .map(m => `${m.role === 'user' ? 'Humain' : 'Agent'}: ${m.text}`)
    .join('\n')

  const prompt = renderTemplate(promptTemplate('conversationPrompt'), {
    general: generalPrompt(),
    proposal: task.title || task.description,
    why: task.why ? `Pourquoi: ${task.why}\n` : '',
    zone: task.zone ? `Zone visée: ${task.zone}\n` : '',
    thread,
  })

  spawnClaude({ prompt, allowedTools: READONLY_TOOLS, timeoutMs: READONLY_TIMEOUT_MS })
    .then(({ text }) => {
      const reply = (text || '').trim() || '(pas de réponse)'
      const fresh = readTasks().find(t => t.id === task.id)
      if (fresh) {
        const messages = [...(fresh.messages || []), { role: 'agent', text: reply, at: new Date().toISOString() }]
        const updated = updateTask(task.id, { messages, status: fresh.status === 'pending' ? 'in_discussion' : fresh.status })
        if (updated) broadcastTask(updated)
      }
      releaseSlot()
    })
}

// ─── Idea generation (read-only) ──────────────────────────────────────────────
function gatherSignals() {
  // `readErrors` distingue « aucune erreur en DB » de « le SELECT a planté » : sans ça,
  // un échec de lecture rend un tableau vide indiscernable d'un système sain (faux vert).
  const out = { syncErrors: [], automationErrors: [], readErrors: [] }
  try {
    out.syncErrors = db.prepare(
      `SELECT module, error_message, created_at FROM sync_log
       WHERE status='error' AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-14 days')
       ORDER BY created_at DESC LIMIT 15`
    ).all()
  } catch (e) {
    console.error('🤖 Agent: échec lecture sync_log (santé système non fiable):', e.message)
    out.readErrors.push({ source: 'sync_log', error: e.message })
  }
  try {
    out.automationErrors = db.prepare(
      `SELECT automation_id, error, created_at FROM automation_logs
       WHERE status='error' AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-14 days')
       ORDER BY created_at DESC LIMIT 15`
    ).all()
  } catch (e) {
    console.error('🤖 Agent: échec lecture automation_logs (santé système non fiable):', e.message)
    out.readErrors.push({ source: 'automation_logs', error: e.message })
  }
  return out
}

function generate() {
  busy = true
  currentActivity = 'generation'

  const open = readTasks().filter(t => t.status === 'pending' || t.status === 'in_discussion').length
  const slots = Math.max(0, MAX_OPEN_PROPOSALS - open)
  if (slots <= 0) { releaseSlot(); return }

  const tasks = readTasks()
  const history = tasks
    .filter(t => t.kind === 'proposal')
    .slice(-60)
    .map(t => {
      if (t.status === 'rejected') return `[REJETÉE] ${t.title || t.description}${t.user_comment ? ` — raison: ${t.user_comment}` : ''}`
      if (t.status === 'done') return `[DÉJÀ FAITE] ${t.title || t.description}`
      return `[EN COURS/OUVERTE] ${t.title || t.description}`
    })
    .join('\n') || '(aucun historique)'

  const backlog = readBacklog().filter(b => !b.processed)
  const backlogStr = backlog.length
    ? backlog.map(b => `- (id:${b.id}) ${b.text}`).join('\n')
    : '(backlog vide)'

  const signals = gatherSignals()
  const signalsStr = JSON.stringify(signals).slice(0, 4000)

  const prompt = renderTemplate(promptTemplate('generationPrompt'), {
    general: generalPrompt(),
    slots,
    backlog: backlogStr,
    signals: signalsStr,
    history,
  })

  spawnClaude({ prompt, allowedTools: READONLY_TOOLS, timeoutMs: READONLY_TIMEOUT_MS })
    .then(({ text }) => {
      try {
        const proposals = parseProposals(text)
        const usedBacklogIds = new Set()
        const now = new Date().toISOString()
        const fresh = readTasks()
        let added = 0
        for (const p of proposals) {
          if (added >= slots) break
          if (!p || !p.title) continue
          const task = {
            id: randomUUID(),
            kind: 'proposal',
            title: String(p.title).slice(0, 200),
            why: p.why ? String(p.why) : '',
            source: ['A', 'B', 'C', 'D'].includes(p.source) ? p.source : 'A',
            zone: p.zone ? String(p.zone) : '',
            risk: p.risk === 'high' ? 'high' : 'low',
            side_effects: p.side_effects ? String(p.side_effects) : 'aucun',
            effort: ['small', 'medium', 'large'].includes(p.effort) ? p.effort : 'medium',
            description: `${p.title}${p.why ? `\n\n${p.why}` : ''}`,
            status: 'pending',
            priority: 0,
            messages: [],
            user_comment: null,
            agent_result: null,
            created_at: now,
            updated_at: now,
            completed_at: null,
          }
          fresh.push(task)
          added++
          if (p.backlog_id) usedBacklogIds.add(p.backlog_id)
          broadcastTask(task)
        }
        if (added > 0) writeTasks(fresh)
        if (usedBacklogIds.size) {
          const items = readBacklog().map(b => usedBacklogIds.has(b.id) ? { ...b, processed: true } : b)
          writeBacklog(items)
        }
        // Génération continue : tant que cette passe a produit des idées ET qu'il reste
        // de la place dans la file de triage, on enchaîne IMMÉDIATEMENT une autre passe
        // (pas d'attente d'horloge). releaseSlot() ci-dessous déclenche kick(), qui
        // relancera generate() puisque _genRequested est ré-armé.
        // La chaîne s'arrête d'elle-même quand :
        //   - la passe n'a rien produit (added === 0) → modèle à court d'idées neuves, et
        //   - la file est pleine (openNow >= MAX_OPEN_PROPOSALS).
        // Le cron horaire (ou un déclenchement manuel) relance une nouvelle chaîne plus tard.
        const openNow = fresh.filter(t => t.status === 'pending' || t.status === 'in_discussion').length
        if (added > 0 && openNow < MAX_OPEN_PROPOSALS) {
          _genRequested = true
        } else if (added === 0) {
          console.log('🤖 Agent: génération à court d\'idées neuves — chaîne en pause jusqu\'au prochain déclenchement')
        }
      } catch (e) {
        console.error('🤖 Agent: échec parsing génération:', e.message)
      }
      releaseSlot()
    })
}

function parseProposals(text) {
  if (!text) return []
  // Prefer the last ```json fenced block
  const fences = [...text.matchAll(/```json\s*([\s\S]*?)```/gi)]
  let raw = fences.length ? fences[fences.length - 1][1] : null
  if (!raw) {
    const start = text.indexOf('[')
    const end = text.lastIndexOf(']')
    if (start !== -1 && end > start) raw = text.slice(start, end + 1)
  }
  if (!raw) return []
  const parsed = JSON.parse(raw)
  return Array.isArray(parsed) ? parsed : []
}

// ─── Orphan / lifecycle (preserved from the original runner) ──────────────────
function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

export function initTaskRunner() {
  // Reconnect to an orphaned execution Claude from a previous server instance.
  // monitorExecution() finalizes off the durable .code file, so an exec that finished
  // successfully WHILE the server was restarting (e.g. it ran `pm2 restart erp-server`
  // itself) is correctly marked DONE — not blocked. If the child already finished, the
  // first poll detects the .code file immediately; if it's still running, we tail it; if
  // it crashed without a .code file, it's marked blocked.
  if (existsSync(PID_FILE)) {
    try {
      const [pidStr, taskId] = readFileSync(PID_FILE, 'utf8').trim().split('\n')
      const pid = parseInt(pidStr, 10)
      const t = taskId && readTasks().find(x => x.id === taskId)
      if (t && t.status === 'in_progress') {
        console.log(`🤖 Agent: exécution orpheline détectée (PID ${pid}, tâche ${taskId}) — reprise du suivi…`)
        busy = true
        currentTaskId = taskId
        currentActivity = 'execution'
        monitorExecution(taskId, pid || null)
        scheduleGeneration()
        return
      }
    } catch {}
    // Stale PID file (task already finalized / gone) → clean up its artifacts.
    try {
      const taskId = readFileSync(PID_FILE, 'utf8').trim().split('\n')[1]
      if (taskId) { for (const f of [EXEC_LOG(taskId), EXEC_CODE(taskId), EXEC_PROMPT(taskId)]) { try { unlinkSync(f) } catch {} } }
    } catch {}
    try { unlinkSync(PID_FILE) } catch {}
  }

  // An execution interrupted by a server restart is marked BLOCKED (needs a human),
  // never silently re-approved. Re-approving created a runaway: an execution that
  // ran `pm2 restart erp-server` would be re-queued on every boot and loop forever.
  const tasks = readTasks()
  let changed = false
  for (const t of tasks) {
    if (t.status === 'in_progress') {
      t.status = 'blocked'
      t.agent_result = (t.agent_result ? t.agent_result + '\n' : '') +
        '(exécution interrompue par un redémarrage serveur — relancer manuellement si besoin)'
      t.updated_at = new Date().toISOString()
      changed = true
    }
  }
  if (changed) writeTasks(tasks)

  scheduleGeneration()
  setImmediate(kick)
}

let _cronJob = null
function scheduleGeneration() {
  if (_cronJob) return
  // La génération s'enchaîne désormais en continu (voir generate() : une passe productive
  // ré-arme la suivante sans attente, jusqu'à remplir la file ou tarir les idées). Le cron
  // n'est plus un cadenceur « une génération par heure » : c'est un simple battement qui
  // RELANCE une chaîne quand elle s'est arrêtée (file vidée par le triage, nouveaux signaux
  // sync_log / nouveau code à scanner). No-op si le toggle est OFF ou la file déjà pleine.
  _cronJob = cron.schedule('0 * * * *', () => { requestGeneration() })
  console.log('🤖 Agent autonome: génération continue (chaînée) — relance horaire de la chaîne si arrêtée (toggle ON requis)')
}

export function shutdownTaskRunner() {
  // Execution Claude is detached and finishes as an orphan; PID file persists for reconnect.
}
