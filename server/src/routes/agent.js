import { Router } from 'express'
import { randomUUID, timingSafeEqual } from 'crypto'
import { readFileSync, writeFileSync, renameSync } from 'fs'
import { resolve } from 'path'
import { fileURLToPath } from 'url'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { AGENT_INTERNAL_SECRET } from '../config/secrets.js'
import { getClaudeUsage } from '../services/claudeUsage.js'
import { KNOWN_MODELS } from '../services/agentModel.js'
import {
  runNextTask, isRunnerBusy, getCurrentTaskId, getCurrentActivity, getStreamBuffer,
  getSettings, setSettings, readBacklog, addBacklogItem, deleteBacklogItem,
  updateBacklogItem, generateInstantProposal, approveBacklogItem,
  requestReply, PROMPT_TEMPLATE_DEFAULTS, DEFAULT_GENERAL_PROMPT,
  getSessionLimitResetAt, getAgentModelState,
} from '../services/taskRunner.js'

function safeEqualSecret(provided, expected) {
  if (!provided || !expected) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

const router = Router()

// Path to the file-based task queue (must match taskRunner.js).
// Resolves to the repo root /home/ec2-user/erp/agent-tasks.json (versioned + backed up).
const TASKS_FILE = resolve(fileURLToPath(import.meta.url), '../../../../agent-tasks.json')
const TASKS_TMP  = TASKS_FILE + '.tmp'

// Instructions projet de l'agent (repo root /home/ec2-user/erp/CLAUDE.md).
const CLAUDE_MD_FILE = resolve(fileURLToPath(import.meta.url), '../../../../CLAUDE.md')
const CLAUDE_MD_TMP  = CLAUDE_MD_FILE + '.tmp'

function readTasks() {
  try { return JSON.parse(readFileSync(TASKS_FILE, 'utf8')) } catch { return [] }
}
function writeTasks(tasks) {
  writeFileSync(TASKS_TMP, JSON.stringify(tasks, null, 2) + '\n', 'utf8')
  renameSync(TASKS_TMP, TASKS_FILE)
}

function sortTasks(tasks) {
  return [...tasks].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))
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
  const now = new Date().toISOString()
  const task = {
    id: randomUUID(), description, status: 'pending', priority,
    user_comment: null, agent_result: null, messages: [],
    created_at: now, updated_at: now, completed_at: null,
  }
  const tasks = readTasks()
  tasks.push(task)
  writeTasks(tasks)
  res.status(201).json(task)
})

// All routes below require authentication
router.use(requireAuth)

// ─── Global on/off toggle + prompts éditables ─────────────────────────────────
// `defaults` accompagne les valeurs courantes pour que le front puisse proposer un
// bouton « Réinitialiser » (un champ vidé retombe sur le défaut côté serveur).
router.get('/settings', (req, res) => res.json({
  ...getSettings(),
  defaults: { generalPrompt: DEFAULT_GENERAL_PROMPT, ...PROMPT_TEMPLATE_DEFAULTS },
}))
router.put('/settings', (req, res) => {
  const patch = {}
  if ('enabled' in req.body) patch.enabled = !!req.body.enabled
  if ('autoApprove' in req.body) patch.autoApprove = !!req.body.autoApprove
  // Modèle préféré de l'agent (sélecteur du bandeau quotas) — valeur fermée.
  if ('preferredModel' in req.body) {
    const model = String(req.body.preferredModel || '').toLowerCase()
    if (!KNOWN_MODELS.includes(model)) {
      return res.status(400).json({ error: `preferredModel invalide — choix possibles : ${KNOWN_MODELS.join(', ')}` })
    }
    patch.preferredModel = model
  }
  for (const key of ['generalPrompt', 'instantPrompt', 'conversationPrompt', 'executionPrompt', 'questionPrompt']) {
    if (key in req.body) patch[key] = String(req.body[key] ?? '')
  }
  res.json(setSettings(patch))
})

// ─── Instructions projet (CLAUDE.md) ──────────────────────────────────────────
// Réservé aux admins (lecture + écriture). Écriture atomique (.tmp + rename).
// Note : le repo est versionné — un `git pull` (deploy.sh) écrase les modifs non
// committées. Le front affiche un avertissement en conséquence.
router.get('/claude-md', requireAdmin, (req, res) => {
  try {
    res.json({ content: readFileSync(CLAUDE_MD_FILE, 'utf8') })
  } catch (err) {
    res.status(500).json({ error: 'Impossible de lire CLAUDE.md : ' + err.message })
  }
})
router.put('/claude-md', requireAdmin, (req, res) => {
  if (typeof req.body.content !== 'string') {
    return res.status(400).json({ error: 'content (string) required' })
  }
  try {
    writeFileSync(CLAUDE_MD_TMP, req.body.content, 'utf8')
    renameSync(CLAUDE_MD_TMP, CLAUDE_MD_FILE)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: 'Impossible d\'écrire CLAUDE.md : ' + err.message })
  }
})

// ─── Suggestions (bulle d'aide / page agent) ──────────────────────────────────
router.get('/backlog', (req, res) => res.json(readBacklog()))
router.post('/backlog', (req, res) => {
  const text = (req.body.text || '').trim()
  if (!text) return res.status(400).json({ error: 'text required' })
  // Toujours opus/effort élevé, implémentation directe sans proposition ni
  // approbation — file d'attente automatique via le runner si occupé (busy).
  // mode='question' : l'agent répond (lecture seule) au lieu d'implémenter.
  // 600 : la route + le descriptif de l'élément cliqué (FeedbackFab, ≤400 chars).
  const item = addBacklogItem(text, {
    context: String(req.body.context || '').slice(0, 600),
    author: req.user?.name || req.user?.email || '',
    preset: 'deep',
    mode: req.body.mode === 'question' ? 'question' : 'implement',
  })
  const { item: updatedItem } = approveBacklogItem(item.id) || {}
  res.status(201).json(updatedItem || item)
})
// Relancer une proposition instantanée en échec.
router.post('/backlog/:id/retry', (req, res) => {
  const item = updateBacklogItem(req.params.id, { instant_status: 'generating', instant_proposal: null })
  if (!item) return res.status(404).json({ error: 'not found' })
  setImmediate(() => generateInstantProposal(item.id))
  res.json(item)
})
// Approuver le correctif proposé → crée la tâche d'implémentation (préréglage
// modèle/effort de la suggestion) et réveille le runner.
router.post('/backlog/:id/approve', (req, res) => {
  const result = approveBacklogItem(req.params.id, { comment: (req.body?.comment || '').trim() })
  if (!result) return res.status(404).json({ error: 'not found' })
  res.json(result)
})
router.delete('/backlog/:id', (req, res) => { deleteBacklogItem(req.params.id); res.json({ ok: true }) })

// ─── Tasks / proposals ────────────────────────────────────────────────────────
router.get('/tasks', (req, res) => res.json(sortTasks(readTasks())))

// Manual task (auto-approved — legacy "Nouvelle tâche" path)
router.post('/tasks', (req, res) => {
  const { description, priority = 0 } = req.body
  if (!description) return res.status(400).json({ error: 'description required' })
  const now = new Date().toISOString()
  const task = {
    id: randomUUID(), description, status: 'approved', priority,
    user_comment: null, agent_result: null, messages: [],
    created_at: now, updated_at: now, completed_at: null,
  }
  const tasks = readTasks()
  tasks.push(task)
  writeTasks(tasks)
  res.status(201).json(task)
  setImmediate(runNextTask)
})

// PATCH — status changes (approve/reject), comment, priority…
router.patch('/tasks/:id', (req, res) => {
  const tasks = readTasks()
  const idx = tasks.findIndex(t => t.id === req.params.id)
  if (idx === -1) return res.status(404).json({ error: 'not found' })

  // started_at/completed_at : corrigeables via API (aussi utilisés par les seeds E2E
  // pour afficher la durée d'exécution sans lancer une vraie exécution).
  // user_summary : résumé non technique affiché sur les cartes terminées (aussi
  // utilisé par les seeds E2E pour simuler une implémentation complétée).
  // mode ('implement' | 'question') : corrigeable via API (aussi utilisé par les
  // seeds E2E pour simuler une carte question répondue).
  const allowed = ['status', 'user_comment', 'agent_result', 'user_summary', 'priority', 'description', 'feedback', 'started_at', 'completed_at', 'mode']
  const task = { ...tasks[idx] }
  for (const key of allowed) {
    if (key in req.body) task[key] = req.body[key]
  }
  // Appréciation de l'implémentation (1 à 5 étoiles, null = retirée).
  if ('rating' in req.body) {
    const r = req.body.rating
    if (r !== null && !(Number.isInteger(r) && r >= 1 && r <= 5)) {
      return res.status(400).json({ error: 'rating doit être un entier de 1 à 5 ou null' })
    }
    task.rating = r
  }
  if (req.body.status === 'done' && tasks[idx].status !== 'done') {
    task.completed_at = new Date().toISOString()
  }
  task.updated_at = new Date().toISOString()
  tasks[idx] = task
  writeTasks(tasks)
  res.json(task)

  // "Approuver & coder" → status=approved kicks the runner (gated by the global toggle).
  if (req.body.status === 'approved') setImmediate(runNextTask)
})

// POST a conversation message on a proposal → triggers a read-only reply.
router.post('/tasks/:id/message', (req, res) => {
  const text = (req.body.text || '').trim()
  if (!text) return res.status(400).json({ error: 'text required' })
  const tasks = readTasks()
  const idx = tasks.findIndex(t => t.id === req.params.id)
  if (idx === -1) return res.status(404).json({ error: 'not found' })

  const task = { ...tasks[idx] }
  task.messages = [...(task.messages || []), { role: 'user', text, at: new Date().toISOString() }]
  if (task.status === 'pending') task.status = 'in_discussion'
  task.updated_at = new Date().toISOString()
  tasks[idx] = task
  writeTasks(tasks)
  res.json(task)

  requestReply(task.id) // agent replies live (read-only), independent of the hourly clock
})

// GET /api/agent/usage — quotas de l'abonnement Claude (fenêtre glissante de 5 h,
// total hebdomadaire, plafond hebdo d'un modèle) + jetons consommés, agrégés depuis
// les transcriptions locales de Claude Code. Résultat mis en cache 60 s.
//
// On y joint l'état de l'ordonnanceur : quand une exécution s'est heurtée au quota,
// le runner se met en pause tout seul jusqu'à la réinitialisation. Sans cette
// information, la page Travaux montrait une file immobile sans dire pourquoi.
router.get('/usage', async (req, res) => {
  try {
    const usage = await getClaudeUsage()
    const at = getSessionLimitResetAt()
    res.json({
      ...usage,
      schedulerLimitResetAt: at > Date.now() ? new Date(at).toISOString() : null,
      // Modèle de l'agent : le préféré (fable), celui réellement actif (opus quand le
      // plafond hebdomadaire de fable est épuisé) et les quotas par modèle en cours.
      agentModel: getAgentModelState(),
    })
  } catch (err) {
    res.status(500).json({ error: 'Impossible de calculer l\'utilisation Claude : ' + err.message })
  }
})

// GET /api/agent/runner/status
router.get('/runner/status', (req, res) => {
  res.json({ busy: isRunnerBusy(), currentTaskId: getCurrentTaskId(), activity: getCurrentActivity() })
})

// GET buffered stream chunks for a task
router.get('/tasks/:id/stream-log', (req, res) => {
  res.json({ chunks: getStreamBuffer(req.params.id) })
})

// DELETE a task
router.delete('/tasks/:id', (req, res) => {
  const tasks = readTasks()
  writeTasks(tasks.filter(t => t.id !== req.params.id))
  res.json({ ok: true })
})

export default router
