import { spawn } from 'child_process'
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
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
const EXEC_TIMEOUT_MS    = 30 * 60_000  // hard kill an execution after 30 min
const READONLY_TIMEOUT_MS = 8 * 60_000  // conversation read-only turns
const INSTANT_TIMEOUT_MS = 3 * 60_000   // proposition instantanée (sans outils, réponse courte)
const READONLY_TOOLS = 'Read,Glob,Grep' // truly read-only — no Bash/Write/Edit
const EXEC_TOOLS     = 'Bash,Read,Write,Edit,Glob,Grep'

// ─── Préréglages modèle / effort (choisis par l'utilisateur à la soumission) ──
// Appliqués à la proposition instantanée ET à l'exécution du correctif.
export const PRESETS = {
  fast:     { model: 'haiku',  effort: 'low',    label: 'Rapide' },
  standard: { model: 'sonnet', effort: 'medium', label: 'Standard' },
  deep:     { model: 'opus',   effort: 'high',   label: 'Approfondi' },
}
export function presetFor(key) { return PRESETS[key] || PRESETS.standard }

// ─── Prompt général (préambule système, éditable depuis la page Agent) ─────────
// Injecté en tête de CHAQUE activité (proposition instantanée / conversation / exécution).
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
// Surchargeables via agent-settings.json (clés instantPrompt / conversationPrompt /
// executionPrompt) — un champ vide retombe sur le défaut ci-dessous (voir promptTemplate()).
//
// Placeholders disponibles :
//   instantané    : {{general}} {{text}} {{context}}
//   conversation  : {{general}} {{proposal}} {{why}} {{zone}} {{thread}}
//   exécution     : {{general}} {{brief}} {{internalSecret}}

export const DEFAULT_INSTANT_PROMPT = [
  '{{general}}', '\n\n',
  'Un utilisateur vient de signaler un problème ou de suggérer une amélioration via la bulle d\'aide de l\'app. ',
  'Tu n\'as AUCUN outil : ne tente pas de lire le code, réponds uniquement à partir du signalement et de ta connaissance générale de l\'ERP.\n\n',
  'Signalement (depuis la page {{context}}):\n{{text}}\n\n',
  'Propose UN correctif concret et plausible : ce qui devrait changer dans l\'app, où (page/zone), et le comportement attendu après le correctif. ',
  'Écris en français, orienté utilisateur (pas de jargon technique ni de noms de fichiers), en 3 à 6 phrases maximum. ',
  'Si le signalement est trop vague pour proposer quoi que ce soit, dis-le et pose LA question qui débloquerait. ',
  'Ne produis que la proposition, sans préambule ni titre.',
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

// Consigne du compte-rendu utilisateur — garantie dans CHAQUE prompt d'exécution,
// même si l'utilisateur a personnalisé son modèle sans l'inclure (voir executeTask).
// Longueur proportionnelle à la complexité : quelques mots pour un petit correctif,
// quelques lignes pour un gros changement.
export const SUMMARY_SECTION_MARKER = '=== RÉSUMÉ UTILISATEUR ==='
export const SUMMARY_SECTION_INSTRUCTION = [
  'Puis termine IMPÉRATIVEMENT ta réponse par une section délimitée EXACTEMENT ainsi:\n',
  SUMMARY_SECTION_MARKER, '\n',
  'Suivie d\'un court compte-rendu en français destiné à l\'utilisateur qui a signalé le problème, SANS jargon technique ni noms de fichiers. ',
  'Adapte la longueur à la complexité du changement : quelques mots pour un petit correctif, 2 à 4 phrases pour un changement plus important. ',
  'Explique ce qui a changé dans l\'app, comment le constater, et tout commentaire pertinent (limite connue, comportement à surveiller…). ',
  'Si la tâche est bloquée, explique simplement pourquoi.',
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
  'Termine par un rapport détaillé: ce que tu as changé, le résultat du build et des tests E2E (vert/rouge), ou la raison du blocage.\n',
  SUMMARY_SECTION_INSTRUCTION,
].join('')

// Consigne de la section réponse pour une QUESTION — même marqueur que le résumé
// d'implémentation (le pipeline monitorExecution/user_summary est partagé), mais la
// section contient la RÉPONSE, pas un compte-rendu de changements.
export const QUESTION_SUMMARY_INSTRUCTION = [
  'Termine IMPÉRATIVEMENT ta réponse par une section délimitée EXACTEMENT ainsi:\n',
  SUMMARY_SECTION_MARKER, '\n',
  'Suivie de la RÉPONSE à la question, en français, destinée à l\'utilisateur, SANS jargon technique ni noms de fichiers. ',
  'Adapte la longueur à la complexité de la question : une phrase pour une question simple, quelques paragraphes si nécessaire. ',
  'Si tu n\'as pas pu répondre, explique simplement pourquoi.',
].join('')

// Prompt d'exécution d'une QUESTION (mode choisi par l'utilisateur à la soumission) :
// exploration en lecture seule, AUCUNE implémentation — la réponse part dans la
// section résumé et devient le compte-rendu de la carte.
export const DEFAULT_QUESTION_PROMPT = [
  '{{general}}', '\n\n',
  'La demande ci-dessous est une QUESTION de l\'utilisateur — PAS une demande d\'implémentation. ',
  'N\'implémente RIEN : tu es en LECTURE SEULE (Read/Glob/Grep uniquement), tu ne modifies aucun fichier, tu ne lances ni build, ni test, ni redémarrage. ',
  'Ne lis pas agent-tasks.json ni les autres fichiers de gestion de tâches de l\'agent.\n\n',
  '{{brief}}',
  '\n\nExplore le code autant que nécessaire pour répondre précisément et complètement à la question.\n',
  QUESTION_SUMMARY_INSTRUCTION,
].join('')

// Map clé de réglage → modèle par défaut. Source de vérité partagée avec la route
// GET /settings (qui renvoie ces défauts au front pour le bouton « Réinitialiser »).
export const PROMPT_TEMPLATE_DEFAULTS = {
  instantPrompt:      DEFAULT_INSTANT_PROMPT,
  conversationPrompt: DEFAULT_CONVERSATION_PROMPT,
  executionPrompt:    DEFAULT_EXECUTION_PROMPT,
  questionPrompt:     DEFAULT_QUESTION_PROMPT,
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
let currentActivity = null     // 'execution' | 'conversation'
let _currentProc = null
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
    autoApprove: true,
    generalPrompt: DEFAULT_GENERAL_PROMPT,
    instantPrompt: DEFAULT_INSTANT_PROMPT,
    conversationPrompt: DEFAULT_CONVERSATION_PROMPT,
    executionPrompt: DEFAULT_EXECUTION_PROMPT,
    questionPrompt: DEFAULT_QUESTION_PROMPT,
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

// Une « suggestion » : signalement utilisateur (bulle d'aide ou page agent) qui
// porte sa proposition instantanée puis le lien vers la tâche d'implémentation.
export function addBacklogItem(text, { context = '', author = '', preset = 'standard', mode = 'implement' } = {}) {
  const item = {
    id: randomUUID(),
    text,
    context,                       // route de la page d'où vient le signalement
    author,                        // nom de l'utilisateur qui signale
    mode: mode === 'question' ? 'question' : 'implement', // question = répondre sans rien implémenter
    preset: PRESETS[preset] ? preset : 'standard',
    instant_status: 'generating',  // 'generating' | 'ready' | 'error'
    instant_proposal: null,        // correctif proposé (LLM sans outils)
    task_id: null,                 // tâche d'implémentation une fois approuvée
    processed: false,
    created_at: new Date().toISOString(),
  }
  const items = readBacklog()
  items.push(item)
  writeBacklog(items)
  return item
}
export function updateBacklogItem(id, updates) {
  const items = readBacklog()
  const idx = items.findIndex(i => i.id === id)
  if (idx === -1) return null
  items[idx] = { ...items[idx], ...updates }
  writeBacklog(items)
  return items[idx]
}
export function deleteBacklogItem(id) {
  writeBacklog(readBacklog().filter(i => i.id !== id))
}

// ─── Proposition instantanée (sans outils, hors slot global) ──────────────────
// Tourne en PARALLÈLE de tout le reste : aucun outil autorisé → aucune interaction
// avec l'arbre de travail, donc pas besoin du slot global ni du toggle enabled.
export function generateInstantProposal(itemId) {
  const item = readBacklog().find(i => i.id === itemId)
  if (!item) return
  const { model, effort } = presetFor(item.preset)
  const prompt = renderTemplate(promptTemplate('instantPrompt'), {
    general: generalPrompt(),
    text: item.text,
    context: item.context || '(inconnue)',
  })

  const { CLAUDECODE: _c, CLAUDE_CODE_ENTRYPOINT: _e, ...cleanEnv } = process.env
  const proc = spawn(CLAUDE_BIN, [
    '-p', '--model', model, '--effort', effort, '--tools', '',
  ], { cwd: CWD, env: { ...cleanEnv, HOME: '/home/ec2-user' }, stdio: 'pipe' })

  proc.stdin.write(prompt)
  proc.stdin.end()

  let output = ''
  let settled = false
  const timer = setTimeout(() => { if (!settled) { try { proc.kill('SIGKILL') } catch {} } }, INSTANT_TIMEOUT_MS)

  proc.stdout.on('data', chunk => { output += chunk.toString() })
  proc.stderr.on('data', () => {})
  proc.on('error', () => {})
  proc.on('close', (code) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    const text = output.trim()
    const ok = code === 0 && text
    updateBacklogItem(itemId, ok
      ? { instant_status: 'ready', instant_proposal: text }
      : { instant_status: 'error', instant_proposal: null })
    if (!ok) console.error(`🤖 Agent: proposition instantanée en échec (item ${itemId}, exit ${code})`)
  })
}

// ─── Compte-rendu utilisateur de secours (a posteriori, sans outils) ───────────
// Deux cas alimentent ce chemin : une exécution dont le modèle a oublié la section
// « RÉSUMÉ UTILISATEUR », et les tâches terminées AVANT l'ajout du compte-rendu
// (rattrapage au démarrage — voir backfillUserSummaries). Aucun outil autorisé →
// tourne hors slot global, en parallèle de tout le reste, comme la proposition
// instantanée.
const SUMMARY_TIMEOUT_MS = 3 * 60_000
const _summarizing = new Set()

export function generateUserSummary(taskId) {
  return new Promise((resolveP) => {
    if (_summarizing.has(taskId)) return resolveP(false)
    const task = readTasks().find(t => t.id === taskId)
    if (!task || task.user_summary || !['done', 'blocked'].includes(task.status)) return resolveP(false)
    const report = (task.agent_result || '').trim()
    if (!report || report === '(terminé sans rapport)') return resolveP(false)
    _summarizing.add(taskId)

    // Une tâche « question » n'a rien changé dans l'app : le compte-rendu de secours
    // est la RÉPONSE tirée du rapport, pas un récit de modifications.
    const isQuestion = task.mode === 'question'
    const prompt = isQuestion ? [
      'Un agent autonome vient d\'explorer l\'ERP Orisha (en lecture seule) pour répondre à la question d\'un utilisateur. ',
      'Rédige la RÉPONSE destinée à l\'utilisateur, en français, SANS jargon technique ni noms de fichiers, à partir du rapport ci-dessous. ',
      'Adapte la longueur à la complexité de la question. ',
      task.status === 'blocked'
        ? 'L\'agent n\'a PAS pu répondre : explique simplement pourquoi, sans détails techniques. '
        : '',
      'Ne produis QUE la réponse, sans préambule ni titre.\n\n',
      `Question de l'utilisateur:\n${task.description || task.title || '(inconnue)'}\n\n`,
      `Rapport de l'exploration:\n${report.slice(-12000)}`,
    ].join('') : [
      'Un agent autonome vient d\'intervenir sur l\'ERP Orisha suite à un signalement utilisateur. ',
      'Rédige le compte-rendu destiné à l\'utilisateur, en français, SANS jargon technique ni noms de fichiers. ',
      'Adapte la longueur à la complexité : quelques mots pour un petit correctif, 2 à 4 phrases pour un changement plus important. ',
      'Explique ce qui a changé dans l\'app, comment le constater, et tout commentaire pertinent. ',
      task.status === 'blocked'
        ? 'L\'intervention a été BLOQUÉE : explique simplement pourquoi, sans détails techniques. '
        : '',
      'Ne produis QUE le compte-rendu, sans préambule ni titre.\n\n',
      `Signalement initial:\n${task.description || task.title || '(inconnu)'}\n\n`,
      // Fin du rapport = conclusion de l'agent (le début est du récit d'exécution).
      `Rapport technique de l'intervention:\n${report.slice(-12000)}`,
    ].join('')

    const { CLAUDECODE: _c, CLAUDE_CODE_ENTRYPOINT: _e, ...cleanEnv } = process.env
    const proc = spawn(CLAUDE_BIN, [
      '-p', '--model', 'haiku', '--effort', 'low', '--tools', '',
    ], { cwd: CWD, env: { ...cleanEnv, HOME: '/home/ec2-user' }, stdio: 'pipe' })

    proc.stdin.write(prompt)
    proc.stdin.end()

    let output = ''
    let settled = false
    const settle = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      _summarizing.delete(taskId)
      resolveP(ok)
    }
    const timer = setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, SUMMARY_TIMEOUT_MS)

    proc.stdout.on('data', chunk => { output += chunk.toString() })
    proc.stderr.on('data', () => {})
    proc.on('error', () => settle(false))
    proc.on('close', (code) => {
      const text = output.trim()
      if (code === 0 && text) {
        const updated = updateTask(taskId, { user_summary: text })
        if (updated) broadcastTask(updated)
        settle(true)
      } else {
        console.error(`🤖 Agent: génération du compte-rendu en échec (tâche ${taskId}, exit ${code})`)
        settle(false)
      }
    })
  })
}

// Rattrapage : compte-rendus manquants sur les implémentations déjà terminées
// (tâches d'avant la fonctionnalité, ou prompt personnalisé sans la section).
// Séquentiel pour ne pas empiler les subprocess ; idempotent (le résumé persisté
// n'est jamais régénéré) ; relancé au prochain démarrage en cas d'échec ponctuel.
let _backfillStarted = false
async function backfillUserSummaries() {
  if (_backfillStarted) return
  _backfillStarted = true
  const ids = readTasks()
    .filter(t => ['done', 'blocked'].includes(t.status) && !t.user_summary && (t.agent_result || '').trim())
    .map(t => t.id)
  if (!ids.length) return
  console.log(`🤖 Agent: rattrapage des compte-rendus manquants (${ids.length} tâche(s))…`)
  for (const id of ids) {
    try { await generateUserSummary(id) } catch {}
  }
  console.log('🤖 Agent: rattrapage des compte-rendus terminé')
}

// ─── Approbation d'une suggestion → tâche d'implémentation ────────────────────
export function approveBacklogItem(id, { comment = '' } = {}) {
  const item = readBacklog().find(i => i.id === id)
  if (!item) return null
  if (item.task_id) return { item, task: readTasks().find(t => t.id === item.task_id) || null }
  const { model, effort } = presetFor(item.preset)
  const now = new Date().toISOString()
  const task = {
    id: randomUUID(),
    kind: 'suggestion',
    mode: item.mode === 'question' ? 'question' : 'implement',
    backlog_id: item.id,
    title: item.text.length > 140 ? item.text.slice(0, 140) + '…' : item.text,
    description: item.text,
    context: item.context || '',
    author: item.author || '',
    model, effort,
    status: 'approved',
    priority: 0,
    messages: [],
    user_comment: comment || null,
    agent_result: null,
    user_summary: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
  }
  const tasks = readTasks()
  tasks.push(task)
  writeTasks(tasks)
  const updatedItem = updateBacklogItem(id, { task_id: task.id, processed: true })
  broadcastTask(task)
  setImmediate(kick)
  return { item: updatedItem, task }
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
export function requestReply(taskId) {
  if (!_replyQueue.includes(taskId)) _replyQueue.push(taskId)
  setImmediate(kick)
}

// runNextTask kept as a public alias for back-compat (routes call it after approve).
export function runNextTask() { kick() }

// ─── The scheduler heart: pick the next activity by priority ───────────────────
function kick() {
  if (busy) return
  if (!getSettings().enabled) return

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

    // Résumé vulgarisé : section finale demandée par le prompt d'exécution, affichée
    // en clair sur la fiche de la suggestion (le rapport technique reste en dépli).
    let user_summary = null
    const summaryIdx = agent_result.lastIndexOf(SUMMARY_SECTION_MARKER)
    if (summaryIdx !== -1) {
      user_summary = agent_result.slice(summaryIdx + SUMMARY_SECTION_MARKER.length).trim() || null
      agent_result = agent_result.slice(0, summaryIdx).trim()
    }

    const finalTask = updateTask(taskId, { status, agent_result, user_summary, completed_at: new Date().toISOString() })
    if (finalTask) broadcastTask(finalTask)

    // Section résumé absente du rapport (modèle qui a oublié la consigne) →
    // compte-rendu de secours généré a posteriori, hors slot (sans outils).
    if (!user_summary) setImmediate(() => generateUserSummary(taskId).catch(() => {}))

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

function runDetachedExecution(taskId, prompt, { model = null, effort = null, tools = EXEC_TOOLS } = {}) {
  const LOG = EXEC_LOG(taskId)
  const CODE = EXEC_CODE(taskId)
  const PROMPT = EXEC_PROMPT(taskId)

  // Clear any stale artifacts from a previous run of the same id.
  for (const f of [LOG, CODE]) { try { if (existsSync(f)) unlinkSync(f) } catch {} }
  writeFileSync(PROMPT, prompt, 'utf8')

  const { CLAUDECODE: _c, CLAUDE_CODE_ENTRYPOINT: _e, ...cleanEnv } = process.env
  // Modèle/effort issus du préréglage choisi par l'utilisateur à la soumission.
  const modelFlags = (model ? ` --model "${model}"` : '') + (effort ? ` --effort "${effort}"` : '')
  // claude reads the prompt from stdin (PROMPT file); stream-json → LOG; exit code → CODE.
  const cmd = `"${CLAUDE_BIN}" -p --output-format stream-json --verbose${modelFlags} ` +
    `--allowedTools "${tools}" < "${PROMPT}" > "${LOG}" 2>&1; echo $? > "${CODE}"`

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
  // Question : l'utilisateur veut une réponse, pas un correctif — prompt lecture
  // seule dédié (questionPrompt) + outils read-only, la réponse part dans la
  // section résumé (compte-rendu de la carte).
  const isQuestion = next.mode === 'question'

  let brief
  if (next.kind === 'suggestion') {
    // Suggestion utilisateur (bulle d'aide) : signalement + correctif instantané approuvé.
    const item = readBacklog().find(i => i.id === next.backlog_id)
    brief = [
      `${isQuestion ? 'Question' : 'Signalement'} utilisateur${next.author ? ` (par ${next.author})` : ''}${next.context ? ` depuis la page ${next.context}` : ''}:\n${next.description}`,
      !isQuestion && item?.instant_proposal ? `\n\nCorrectif proposé et APPROUVÉ par l'utilisateur (implémente dans cet esprit):\n${item.instant_proposal}` : '',
      next.user_comment ? `\n\nCommentaire de l'utilisateur à l'approbation: ${next.user_comment}` : '',
    ].join('')
  } else if (next.kind === 'proposal') {
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

  let prompt = renderTemplate(promptTemplate(isQuestion ? 'questionPrompt' : 'executionPrompt'), {
    general: generalPrompt(),
    brief,
    internalSecret,
  })
  // Filet : un prompt personnalisé qui omet la section résumé priverait les cartes
  // terminées de leur compte-rendu (ou de la réponse) — on ré-injecte la consigne.
  if (!prompt.includes(SUMMARY_SECTION_MARKER)) {
    prompt += '\n\n' + (isQuestion ? QUESTION_SUMMARY_INSTRUCTION : SUMMARY_SECTION_INSTRUCTION)
  }

  // Detached + durable: the result is recorded off a .code file, so a `pm2 restart`
  // triggered by the implementation itself can't lose the success and leave the task
  // wrongly "blocked". monitorExecution() handles streaming + finalization.
  // Question → outils lecture seule : l'agent ne peut physiquement rien implémenter.
  runDetachedExecution(next.id, prompt, {
    model: next.model, effort: next.effort,
    tools: isQuestion ? READONLY_TOOLS : EXEC_TOOLS,
  })
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

  // Rattrapage différé des compte-rendus manquants sur les cartes déjà terminées
  // (laisse le serveur finir de démarrer avant de spawner des subprocess).
  const backfillTimer = setTimeout(() => { backfillUserSummaries().catch(() => {}) }, 15_000)
  backfillTimer.unref?.()

  setImmediate(kick)
}

export function shutdownTaskRunner() {
  // Execution Claude is detached and finishes as an orphan; PID file persists for reconnect.
}
