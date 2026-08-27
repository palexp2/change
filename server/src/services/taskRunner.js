import { spawn } from 'child_process'
import { readFileSync, writeFileSync, appendFileSync, renameSync, existsSync, unlinkSync, readdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import { broadcastAll } from './realtime.js'
import { AGENT_INTERNAL_SECRET } from '../config/secrets.js'
import {
  AGENT_MODEL, KNOWN_MODELS, modelChain, resolveModel, chainAvailableAt,
  noteModelLimit, nextLimitExpiryAt, purgeExpiredLimits, fetchLimitScope,
  syncScopedModelLimit, agentModelState, preferredAgentModel, setPreferredAgentModel,
} from './agentModel.js'

// ─── Paths (must match what the running server already uses) ──────────────────
// Resolves to the repo root /home/ec2-user/erp/ (versioned + backed up by WIP snapshots).
const TASKS_FILE    = resolve(fileURLToPath(import.meta.url), '../../../../agent-tasks.json')
const TASKS_TMP     = TASKS_FILE + '.tmp'
const DATA_DIR      = dirname(TASKS_FILE)
const BACKLOG_FILE  = resolve(DATA_DIR, 'agent-backlog.json')
const SETTINGS_FILE = resolve(DATA_DIR, 'agent-settings.json')
const PID_FILE      = resolve(fileURLToPath(import.meta.url), '../../../../.agent-pid')
// Voie lecture seule : un fichier PID PAR tâche (plusieurs questions tournent en
// parallèle, un fichier unique serait écrasé et le suivi viserait le mauvais
// process). Volontairement distinct de .agent-pid, que deploy.sh surveille : une
// question ne modifie rien, elle ne doit pas retarder un déploiement.
const QPID_FILE     = id => resolve(fileURLToPath(import.meta.url), `../../../../.agent-qpid-${id}`)
const CLAUDE_BIN    = '/home/ec2-user/.local/bin/claude'
const CWD           = '/home/ec2-user/erp'

// Per-execution durable artifacts (ignored by git). The detached exec Claude writes
// its stream + exit code HERE, not to the parent's stdout pipe — so a `pm2 restart`
// (mandatory after server changes) can't lose the result or SIGPIPE-kill the child.
const EXEC_LOG    = id => resolve(DATA_DIR, `.agent-exec-${id}.log`)
const EXEC_CODE   = id => resolve(DATA_DIR, `.agent-exec-${id}.code`)
const EXEC_PROMPT = id => resolve(DATA_DIR, `.agent-exec-${id}.prompt`)
// Steering en cours de tâche : les messages envoyés depuis la carte /travaux
// PENDANT une exécution sont déposés ici (une ligne JSON par message), et le hook
// agent-steer-hook.mjs (PostToolUse/Stop, branché via --settings) les livre à
// Claude au fil de l'exécution — comme un message tapé en direct dans Claude Code.
const EXEC_INBOX  = id => resolve(DATA_DIR, `.agent-exec-${id}.inbox`)
const STEER_SETTINGS = resolve(fileURLToPath(import.meta.url), '../../../scripts/agent-steer-hooks.json')

// ─── Tunables (settled during the design grilling) ────────────────────────────
const EXEC_TIMEOUT_MS    = 30 * 60_000  // hard kill an execution after 30 min

// ─── Plafonds de ressources d'une exécution (incident du 2026-08-27) ─────────
// Une seule exécution `effort: high` a saturé la machine (2 vCPU / 8 Go) : +350
// processus, mémoire engagée à 98,7 %, page cache écrasé, iowait 44 %, load 61.
// La box est restée wedgée 1 h 34 après que la tâche soit passée à `done` — il a
// fallu un force stop depuis la console AWS. `setsid --fork` rendait l'exécution
// immune au treekill de pm2 (voulu) mais aussi impossible à contenir ou à tuer
// entièrement : vite, `node --test` et chromium créent leurs propres groupes de
// processus, donc `kill(-pid)` les laissait tous vivants.
//
// L'exécution tourne donc maintenant dans une unité systemd transitoire de
// l'utilisateur, ce qui donne un cgroup v2 englobant TOUT le sous-arbre. Le
// processus reste reparenté sur le user manager (donc toujours hors de portée du
// treekill de pm2), et un seul `systemctl --user kill` suffit à tout nettoyer.
const EXEC_MEMORY_MAX  = '3G'    // au-delà : OOM-kill de la seule exécution, pas de la box
const EXEC_MEMORY_HIGH = '2500M' // throttling progressif avant le mur
const EXEC_SWAP_MAX    = '1G'    // le swap est un filet, pas un terrain de jeu
const EXEC_CPU_QUOTA   = '150%'  // laisse ~0,5 cœur à erp-server + nginx
const EXEC_TASKS_MAX   = 256     // borne l'explosion de processus (l'incident : +350)

/**
 * Nom d'unité systemd déterministe — reconstructible sans plomberie d'état.
 *
 * Le lane 'recover' n'est pas un lane de démarrage : c'est le rattachement à une
 * exécution orpheline après un redémarrage du serveur. Elle a été lancée en 'exec',
 * donc c'est ce nom d'unité qu'il faut viser, sinon le kill de timeout tape à côté.
 */
function execUnitName(taskId, lane = 'exec') {
  const startLane = lane === 'recover' ? 'exec' : lane
  return `erp-agent-${startLane}-${taskId}.service`
}
const READONLY_TIMEOUT_MS = 8 * 60_000  // conversation read-only turns
const INSTANT_TIMEOUT_MS = 3 * 60_000   // proposition instantanée (sans outils, réponse courte)
const READONLY_TOOLS = 'Read,Glob,Grep' // truly read-only — no Bash/Write/Edit
const EXEC_TOOLS     = 'Bash,Read,Write,Edit,Glob,Grep'

// ─── Préréglages modèle / effort (choisis par l'utilisateur à la soumission) ──
// Appliqués à la proposition instantanée ET à l'exécution du correctif.
// « Approfondi » (le défaut de la file de travaux) tourne sur le modèle PRÉFÉRÉ de
// l'agent (fable par défaut, changeable depuis le bandeau quotas — clé
// `preferredModel` d'agent-settings.json), avec repli automatique quand son quota
// hebdomadaire est épuisé — voir agentModel.js. Le modèle inscrit sur la tâche reste
// le modèle SOUHAITÉ ; celui réellement utilisé est résolu au démarrage de
// l'exécution (champ `run_model`).
export const PRESETS = {
  fast:     { model: 'haiku',      effort: 'low',    label: 'Rapide' },
  standard: { model: 'sonnet',     effort: 'medium', label: 'Standard' },
  deep:     { model: AGENT_MODEL,  effort: 'high',   label: 'Approfondi' },
}
export function presetFor(key) {
  const p = PRESETS[key] || PRESETS.standard
  // « Approfondi » suit le modèle préféré courant, pas le fable figé du littéral.
  return p === PRESETS.deep ? { ...p, model: preferredAgentModel() } : p
}

// Repli maximal par tâche : la longueur de la chaîne moins le modèle préféré. Garde-fou
// anti-boucle — une détection de quota qui se déclencherait à tort ne peut pas relancer
// la même tâche indéfiniment.
function maxFallbacksFor(model) { return Math.max(0, modelChain(model).length - 1) }

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
// Toujours très court : 1-2 phrases MAX, sauf si la complexité l'exige vraiment
// (l'utilisateur a explicitement demandé des réponses courtes, à répéter sans relâche).
export const SUMMARY_SECTION_MARKER = '=== RÉSUMÉ UTILISATEUR ==='
export const SUMMARY_SECTION_INSTRUCTION = [
  'Puis termine IMPÉRATIVEMENT ta réponse par une section délimitée EXACTEMENT ainsi:\n',
  SUMMARY_SECTION_MARKER, '\n',
  'Suivie d\'un TRÈS court compte-rendu en français destiné à l\'utilisateur qui a signalé le problème, SANS jargon technique ni noms de fichiers. ',
  'Maximum 1 à 2 phrases, sauf si la complexité du changement rend une explication plus longue vraiment nécessaire (cas rare). ',
  'Explique ce qui a changé dans l\'app et comment le constater, en gardant ça bref. ',
  'Si la tâche est bloquée, explique en une phrase pourquoi.',
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

// ─── Question de l'agent à l'humain ──────────────────────────────────────────
// Une exécution tourne détachée, sans terminal : elle ne peut PAS afficher un
// choix et attendre. Avant, elle devinait (ou finissait « bloquée » avec la
// question noyée dans le compte-rendu). Elle émet donc une section finale
// optionnelle, lue par finalize() et posée sur l'item de file : la carte affiche
// la question avec ses choix, et un clic répond dans le fil — ce qui relance la
// tâche avec la réponse. Section OPTIONNELLE : ne rien émettre est le cas normal.
export const QUESTION_MARKER = '=== QUESTION UTILISATEUR ==='
export const ASK_USER_INSTRUCTION = [
  '\n\nEnfin, UNIQUEMENT si une décision ne t\'appartient pas et qu\'aucune hypothèse raisonnable ne permet de trancher ',
  '(deux comportements également défendables, une règle métier que seul l\'utilisateur connaît), ajoute TOUT À LA FIN ',
  'une dernière section délimitée EXACTEMENT ainsi:\n',
  QUESTION_MARKER, '\n',
  'Suivie d\'un objet JSON sur une seule ligne: {"question":"la question en français, sans jargon","options":["choix 1","choix 2"]}\n',
  'Deux à quatre options, chacune une réponse complète et actionnable (pas « oui »/« non » nus). ',
  'N\'émets cette section que si tu attends VRAIMENT une réponse : le travail est mis en attente de l\'utilisateur. ',
  'Si tu as pu trancher toi-même, n\'écris pas cette section du tout.',
].join('')

/**
 * Détache la section question du rapport. Renvoie { text, question } où `text` est
 * le rapport sans la section. Tolérant : si le JSON est mal formé, la question brute
 * est conservée sans options — mieux vaut une question sans boutons que rien.
 */
export function extractPendingQuestion(raw) {
  const text = String(raw || '')
  const idx = text.lastIndexOf(QUESTION_MARKER)
  if (idx === -1) return { text, question: null }
  const body = text.slice(idx + QUESTION_MARKER.length).trim()
  const head = text.slice(0, idx).trim()
  if (!body) return { text: head, question: null }

  // Le modèle enrobe parfois le JSON dans un bloc de code : on prend le premier
  // objet accoladé du corps, sinon on retombe sur le texte brut.
  const json = body.match(/\{[\s\S]*\}/)
  if (json) {
    try {
      const parsed = JSON.parse(json[0])
      const q = String(parsed.question || '').trim()
      // JSON valide mais sans question : il n'y a rien à demander. Ne PAS retomber sur
      // le repli texte, qui afficherait le JSON brut à l'utilisateur comme question.
      if (!q) return { text: head, question: null }
      const options = Array.isArray(parsed.options)
        ? parsed.options.map(o => String(o).trim()).filter(Boolean).slice(0, 4)
        : []
      return { text: head, question: { question: q, options } }
    } catch { /* repli texte brut ci-dessous */ }
  }
  const plain = body.replace(/```\w*|```/g, '').trim()
  return { text: head, question: plain ? { question: plain, options: [] } : null }
}

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

// ERP_AGENT_RUN=1 est posé sur CHAQUE spawn de claude ci-dessous (voir les quatre
// sites `env:`). Les hooks Stop/Notification de ~/.claude/settings.json héritent de
// cet environnement : slack-notify.sh sort en silence quand la variable est là.
// Sans ce marqueur, une tâche lancée par n'importe quel utilisateur depuis la bulle
// d'aide envoyait « Tâche terminée » dans le DM Slack d'Antoine. Le recap des items
// de la file de prompts est envoyé par le serveur (voir promptQueue.js), pas par le hook.

// ─── Single global slot ───────────────────────────────────────────────────────
// Exactly ONE Claude activity runs at a time (execution / conversation / generation),
// because everything edits or reads the live working tree — no isolation.
// Priority: execution > conversation > generation.
let busy = false
let currentTaskId = null
let currentActivity = null     // 'execution' | 'conversation'
let _currentProc = null
const _replyQueue = []         // proposal ids awaiting a conversation reply

// ─── Voie lecture seule parallèle (tâches « question ») ───────────────────────
// Une question n'a que Read/Glob/Grep : elle ne peut modifier ni fichier, ni DB,
// ni redémarrer le serveur. Elle tourne donc HORS du slot global — jusqu'à
// MAX_PARALLEL_QUESTIONS en même temps, y compris pendant une implémentation, ce
// qui évite qu'une simple question attende la fin d'un chantier.
// Contrepartie assumée : une question lancée pendant une implémentation peut lire
// l'arbre à mi-chemin d'une modification. Acceptable pour une réponse en lecture
// seule ; c'est pourquoi l'implémentation, elle, reste strictement séquentielle.
const MAX_PARALLEL_QUESTIONS = 2
const _questionRuns = new Set()   // ids des tâches question en cours

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

// ─── Steering : message de l'utilisateur pendant une exécution ────────────────
// Dépose le message dans l'inbox de l'exécution ; le hook PostToolUse/Stop de la
// tâche le livrera à Claude après le prochain outil (ou juste avant la fin).
// Refuse si l'exécution ne tourne pas — un message déposé pour rien serait perdu.
export function sendSteeringMessage(taskId, text) {
  const clean = String(text || '').trim()
  if (!clean) return false
  const task = readTasks().find(t => t.id === taskId)
  if (!task || task.status !== 'in_progress') return false
  appendFileSync(EXEC_INBOX(taskId), JSON.stringify({ text: clean, at: new Date().toISOString() }) + '\n', 'utf8')
  // Le message apparaît aussi dans le flux live de la tâche : celui qui regarde
  // l'exécution voit ce qui vient d'être glissé à Claude.
  appendStreamChunk(taskId, { kind: 'user', text: clean })
  return true
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

// Message FINAL de l'exécution, tel que Claude le rend dans l'événement `result` du
// stream-json. C'est là que vit la section « RÉSUMÉ UTILISATEUR » : sur les longues
// exécutions, les événements `assistant` intermédiaires peuvent ne pas la contenir
// (dernier tour rendu uniquement dans le result), d'où un compte-rendu introuvable.
function extractResultText(transcript) {
  let last = ''
  for (const line of transcript.split('\n')) {
    if (!line.includes('"result"')) continue
    try {
      const evt = JSON.parse(line)
      if (evt.type === 'result' && typeof evt.result === 'string' && evt.result.trim()) last = evt.result
    } catch {}
  }
  return last
}

// Identifiant de session Claude d'une exécution, lu dans le transcript stream-json
// (chaque événement le porte). Conservé sur la tâche pour qu'un item de la file
// marqué « même contexte » puisse reprendre la session avec --resume.
function extractSessionId(transcript) {
  for (const line of transcript.split('\n')) {
    if (!line.includes('session_id')) continue
    try {
      const evt = JSON.parse(line)
      if (evt.session_id) return evt.session_id
    } catch {}
  }
  return null
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
    // Pause de la file de travaux (page /travaux) — distincte de `enabled`, qui coupe
    // TOUT l'agent (y compris les signalements de la bulle d'aide). En pause, aucune
    // nouvelle exécution de la file ne démarre ; celle qui tourne va au bout.
    queuePaused: false,
    queuePausedAt: null,
    queuePausedReason: null,
    generalPrompt: DEFAULT_GENERAL_PROMPT,
    instantPrompt: DEFAULT_INSTANT_PROMPT,
    conversationPrompt: DEFAULT_CONVERSATION_PROMPT,
    executionPrompt: DEFAULT_EXECUTION_PROMPT,
    questionPrompt: DEFAULT_QUESTION_PROMPT,
    // Modèle préféré de l'agent (sélecteur du bandeau quotas) — voir agentModel.js.
    preferredModel: AGENT_MODEL,
    ...readJson(SETTINGS_FILE, {}),
  }
}
export function setSettings(patch) {
  const next = { ...getSettings(), ...patch }
  writeJson(SETTINGS_FILE, next)
  // Le résolveur de modèle (agentModel.js) vit en mémoire : on le tient aligné sur le
  // réglage persisté pour que le changement s'applique dès la prochaine exécution.
  if ('preferredModel' in patch) setPreferredAgentModel(next.preferredModel)
  broadcastAll({ type: 'agent:settings:updated', settings: next })
  // Turning the agent ON may unblock queued work.
  if (next.enabled) setImmediate(kick)
  return next
}

// Au démarrage : recharge le modèle préféré persisté (le résolveur est en mémoire,
// un redémarrage l'aurait sinon remis sur le défaut fable).
setPreferredAgentModel(getSettings().preferredModel)

// ─── Pause de la file de travaux ──────────────────────────────────────────────
// Bouton « Pause » de la page /travaux : rien de nouveau ne part, l'exécution en
// cours finit normalement (donc aucun travail perdu, aucun jeton gaspillé à
// refaire ce qui était commencé). La reprise redémarre exactement là où la file
// s'était arrêtée — l'item suivant n'a jamais été lancé, il n'a rien à rattraper.
export function isQueuePaused() { return !!getSettings().queuePaused }

export function setQueuePaused(paused, { reason = null } = {}) {
  const next = setSettings({
    queuePaused: !!paused,
    queuePausedAt: paused ? new Date().toISOString() : null,
    queuePausedReason: paused ? (reason || null) : null,
  })
  if (!paused) setImmediate(kick)
  return {
    paused: !!next.queuePaused,
    pausedAt: next.queuePausedAt || null,
    reason: next.queuePausedReason || null,
  }
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
  const { model: wanted, effort } = presetFor(item.preset)
  const model = resolveModel(wanted) || wanted
  const prompt = renderTemplate(promptTemplate('instantPrompt'), {
    general: generalPrompt(),
    text: item.text,
    context: item.context || '(inconnue)',
  })

  const { CLAUDECODE: _c, CLAUDE_CODE_ENTRYPOINT: _e, ...cleanEnv } = process.env
  const proc = spawn(CLAUDE_BIN, [
    '-p', '--model', model, '--effort', effort, '--tools', '',
  ], { cwd: CWD, env: { ...cleanEnv, HOME: '/home/ec2-user', ERP_AGENT_RUN: '1' }, stdio: 'pipe' })

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

// ─── Appel Claude sans outils (hors slot global) ──────────────────────────────
// Aucun outil autorisé → aucune interaction avec l'arbre de travail : ces appels
// tournent en parallèle d'une exécution sans risque de lire un fichier à moitié
// écrit. Utilisé par le moteur de suggestions, qui reçoit son contexte tout cuit
// (git log, journaux) plutôt que d'explorer le repo lui-même.
export function runToollessClaude({ prompt, model: wanted = 'sonnet', effort = 'medium', timeoutMs = 4 * 60_000 }) {
  return new Promise((resolveP) => {
    // Même résolution que les exécutions : un quota de modèle épuisé emprunte le repli
    // au lieu de faire échouer l'appel.
    const model = resolveModel(wanted) || wanted
    const { CLAUDECODE: _c, CLAUDE_CODE_ENTRYPOINT: _e, ...cleanEnv } = process.env
    const proc = spawn(CLAUDE_BIN, [
      '-p', '--model', model, '--effort', effort, '--tools', '',
    ], { cwd: CWD, env: { ...cleanEnv, HOME: '/home/ec2-user', ERP_AGENT_RUN: '1' }, stdio: 'pipe' })

    proc.stdin.write(prompt)
    proc.stdin.end()

    let output = ''
    let settled = false
    const settle = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolveP(v) } }
    const timer = setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, timeoutMs)

    proc.stdout.on('data', c => { output += c.toString() })
    proc.stderr.on('data', () => {})
    proc.on('error', () => settle({ code: -1, text: '' }))
    proc.on('close', (code) => settle({ code, text: output.trim() }))
  })
}

// ─── Compte-rendu utilisateur de secours (a posteriori, sans outils) ───────────
// Deux cas alimentent ce chemin : une exécution dont le modèle a oublié la section
// « RÉSUMÉ UTILISATEUR », et les tâches terminées AVANT l'ajout du compte-rendu
// (rattrapage au démarrage — voir backfillUserSummaries). Aucun outil autorisé →
// tourne hors slot global, en parallèle de tout le reste, comme la proposition
// instantanée.
const SUMMARY_TIMEOUT_MS = 3 * 60_000
const _summarizing = new Map()

/**
 * Compte-rendu de secours, déduplicé : plusieurs appelants peuvent l'attendre en
 * même temps (le finalize de la tâche ET la file de travaux, qui refuse de figer un
 * placeholder dans son fil) — ils partagent la MÊME exécution et la même promesse.
 */
export function generateUserSummary(taskId) {
  const inflight = _summarizing.get(taskId)
  if (inflight) return inflight
  const p = runUserSummary(taskId).finally(() => _summarizing.delete(taskId))
  _summarizing.set(taskId, p)
  return p
}

function runUserSummary(taskId) {
  return new Promise((resolveP) => {
    const task = readTasks().find(t => t.id === taskId)
    if (!task || task.user_summary || !['done', 'blocked'].includes(task.status)) return resolveP(false)
    const report = (task.agent_result || '').trim()
    if (!report || report === '(terminé sans rapport)') return resolveP(false)

    // Une tâche « question » n'a rien changé dans l'app : le compte-rendu de secours
    // est la RÉPONSE tirée du rapport, pas un récit de modifications.
    const isQuestion = task.mode === 'question'
    const prompt = isQuestion ? [
      'Un agent autonome vient d\'explorer l\'ERP Orisha (en lecture seule) pour répondre à la question d\'un utilisateur. ',
      'Rédige la RÉPONSE destinée à l\'utilisateur, en français, SANS jargon technique ni noms de fichiers, à partir du rapport ci-dessous. ',
      'Sois aussi concis que possible — une ou deux phrases courtes suffisent si elles répondent à la question. ',
      task.status === 'blocked'
        ? 'L\'agent n\'a PAS pu répondre : une phrase pour expliquer pourquoi, sans détails techniques. '
        : '',
      // Même garde-fou que pour les implémentations : pas de réponse inventée à partir
      // d'un rapport coupé net.
      'INTERDIT d\'inventer : n\'affirme que ce que le rapport établit. ',
      'Si le rapport ne contient pas la réponse (exploration interrompue), dis simplement que la recherche n\'a pas abouti et qu\'il faut relancer. ',
      'Ne produis QUE la réponse, sans préambule ni titre.\n\n',
      `Question de l'utilisateur:\n${task.description || task.title || '(inconnue)'}\n\n`,
      `Rapport de l'exploration:\n${report.slice(-12000)}`,
    ].join('') : [
      'Un agent autonome vient d\'intervenir sur l\'ERP Orisha suite à un signalement utilisateur. ',
      'Rédige le compte-rendu destiné à l\'utilisateur, en français, SANS jargon technique ni noms de fichiers. ',
      'Sois aussi concis que possible — une seule phrase peut suffire. Deux phrases maximum pour un changement plus important. ',
      'Explique ce qui a changé dans l\'app, comment le constater, et tout commentaire pertinent. ',
      task.status === 'blocked'
        ? 'L\'intervention a été BLOQUÉE : une phrase pour expliquer pourquoi, sans détails techniques. '
        : '',
      // Garde-fou anti-fabulation : un rapport coupé net (quota épuisé, process tué) ne
      // montre que le début de l'investigation. Sans cette consigne, le modèle
      // extrapolait un « c'est intégré, allez voir » pour du travail jamais terminé.
      'INTERDIT d\'inventer ou de supposer : n\'affirme un changement que si le rapport le montre explicitement. ',
      'Si le rapport ne montre que le début du travail (exploration, intention, aucune modification confirmée), dis-le franchement : ',
      'que le travail a été interrompu avant d\'aboutir, que rien ne garantit qu\'il soit fait, et qu\'il faut le relancer. ',
      'Ne produis QUE le compte-rendu, sans préambule ni titre.\n\n',
      `Signalement initial:\n${task.description || task.title || '(inconnu)'}\n\n`,
      // Fin du rapport = conclusion de l'agent (le début est du récit d'exécution).
      `Rapport technique de l'intervention:\n${report.slice(-12000)}`,
    ].join('')

    const { CLAUDECODE: _c, CLAUDE_CODE_ENTRYPOINT: _e, ...cleanEnv } = process.env
    const proc = spawn(CLAUDE_BIN, [
      '-p', '--model', 'haiku', '--effort', 'low', '--tools', '',
    ], { cwd: CWD, env: { ...cleanEnv, HOME: '/home/ec2-user', ERP_AGENT_RUN: '1' }, stdio: 'pipe' })

    proc.stdin.write(prompt)
    proc.stdin.end()

    let output = ''
    let settled = false
    const settle = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
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
/** Nombre de questions en cours dans la voie lecture seule (0 à MAX_PARALLEL_QUESTIONS). */
export function getRunningQuestionCount() { return _questionRuns.size }
export function getMaxParallelQuestions() { return MAX_PARALLEL_QUESTIONS }
export function getCurrentTaskId() { return currentTaskId }
export function getCurrentActivity() { return currentActivity }

// ─── Quotas Claude épuisés ────────────────────────────────────────────────────
// « You've hit your session limit · resets 3:40am (UTC) » : ce n'est PAS un échec de
// la tâche, c'est un quota épuisé. Le marquer « bloqué » brûlait toute la file en
// quelques secondes (chaque item repartait, mourait aussitôt, et affichait un message
// d'erreur trompeur).
//
// Deux réactions selon le plafond touché (attribution dans handleLimitHit, registre
// par modèle dans agentModel.js) :
//   • plafond propre au modèle (le hebdo de fable) → la tâche repart aussitôt sur le
//     modèle de repli (opus). Rien ne s'arrête, et fable reprend la main à sa réinit.
//   • plafond de compte (fenêtre de 5 h, hebdo tous modèles) → l'item retourne en file,
//     l'ordonnanceur se met en pause, et tout repart tout seul à l'heure dite.
const LIMIT_RE = /(?:hit your (?:session|usage|weekly) limit|usage limit reached|limit will reset)/i
const RESET_RE = /reset(?:s)?(?:\s+at)?\s+(\d{1,2}):(\d{2})\s*(am|pm)?\s*(?:\(([^)]{1,20})\))?/i

let _limitTimer = null

/**
 * Instant de reprise quand l'ordonnanceur est VRAIMENT à l'arrêt, c'est-à-dire quand
 * même le modèle de repli est à sec (0 sinon). Le plafond hebdomadaire de fable seul ne
 * compte pas : le travail continue sur opus, la file n'est pas en pause.
 */
export function getSessionLimitResetAt() { return chainAvailableAt(preferredAgentModel()) }

/** État du modèle de l'agent (préféré / actif / quotas épuisés) — exposé par /agent/usage. */
export function getAgentModelState() { return agentModelState(preferredAgentModel()) }

/**
 * Reconnaît le message de quota dans la sortie d'une exécution et en déduit l'heure de
 * reprise. Heure lue en UTC (c'est ce que le CLI imprime) ; à défaut d'heure lisible on
 * repousse d'une heure — jamais de reprise immédiate, qui rebrûlerait la file.
 */
/**
 * Signal structuré du stream : chaque exécution émet des `rate_limit_event` portant
 * `rate_limit_info.status` et `resetsAt` (epoch secondes). Bien plus fiable que la
 * phrase d'erreur — on le lit en priorité, et seul un statut non-« allowed » compte.
 */
export function detectRateLimitEvent(transcript, now = Date.now()) {
  let hit = null
  for (const line of String(transcript || '').split('\n')) {
    if (!line.includes('rate_limit_info')) continue
    try {
      const info = JSON.parse(line)?.rate_limit_info
      if (!info?.status) continue
      // Le DERNIER état connu gagne : un refus suivi d'un retour à « allowed » (fenêtre
      // réinitialisée en cours d'exécution) ne doit pas mettre l'ordonnanceur en pause.
      if (info.status === 'allowed' || info.status === 'allowed_warning') { hit = null; continue }
      const resetAt = Number(info.resetsAt) > 0 ? Number(info.resetsAt) * 1000 : now + 60 * 60_000
      hit = { resetAt, label: `${new Date(resetAt).toISOString().slice(11, 16)} UTC` }
    } catch {}
  }
  return hit
}

export function detectSessionLimit(text, now = Date.now()) {
  const s = String(text || '')
  if (!LIMIT_RE.test(s)) return null
  const m = RESET_RE.exec(s)
  if (!m) return { resetAt: now + 60 * 60_000, label: 'dans une heure' }
  let h = parseInt(m[1], 10) % 12
  const min = parseInt(m[2], 10)
  if ((m[3] || '').toLowerCase() === 'pm') h += 12
  if (!m[3] && parseInt(m[1], 10) === 12) h = 12          // « 12:30 » sans am/pm = midi
  const d = new Date(now)
  const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, min, 0, 0)
  const resetAt = at > now ? at : at + 24 * 3600_000       // heure déjà passée → demain
  return { resetAt, label: `${String(h).padStart(2, '0')}:${m[2]} UTC` }
}

/**
 * Enregistre un quota épuisé. `models` = le seul modèle concerné (plafond propre au
 * modèle → le repli prend la suite) ou tous (plafond de compte → plus rien ne passe).
 */
function noteLimit(models, { resetAt, label }, { source = 'run' } = {}) {
  const changed = noteModelLimit(models, { resetAt, label, source })
  if (!changed) return
  const stalled = chainAvailableAt(preferredAgentModel())
  if (stalled) {
    const mins = Math.round((stalled - Date.now()) / 60_000)
    console.warn(`🤖 Agent: quotas Claude épuisés (${[].concat(models).join(', ')}) — ordonnanceur en pause ${mins} min (reprise ${label})`)
  } else {
    console.warn(`🤖 Agent: quota ${[].concat(models).join(', ')} épuisé jusqu'à ${label} — bascule sur le modèle de repli`)
  }
  broadcastAll({
    type: 'agent:limit',
    resetAt: stalled ? new Date(stalled).toISOString() : null,
    model: getAgentModelState(),
  })
  rearmLimitTimer()
}

/**
 * Un seul minuteur pour tous les quotas : il se réarme sur la PROCHAINE
 * réinitialisation connue. À son déclenchement, les marques périmées tombent et la file
 * repart — que ce soit fable qui revienne (retour au modèle préféré) ou le dernier
 * repli (sortie de pause).
 */
function rearmLimitTimer() {
  if (_limitTimer) { clearTimeout(_limitTimer); _limitTimer = null }
  const at = nextLimitExpiryAt()
  if (!at) return
  _limitTimer = setTimeout(() => {
    _limitTimer = null
    purgeExpiredLimits()
    console.log('🤖 Agent: quota Claude réinitialisé — reprise de la file')
    kick()
    import('./promptQueue.js').then(m => m.advanceQueue()).catch(() => {})
    rearmLimitTimer()
  }, Math.max(1000, at - Date.now() + 30_000))
  _limitTimer.unref?.()
}

/**
 * Exécution avortée faute de quota. Deux issues :
 *
 *   • le plafond ne visait QUE le modèle utilisé (typiquement le hebdo de fable) et un
 *     repli reste disponible → la tâche repart TOUT DE SUITE sur le modèle suivant. Rien
 *     n'attend, l'utilisateur voit juste le travail reprendre sur opus.
 *   • plus aucun modèle n'a de quota → ancien comportement : la tâche retourne en file,
 *     l'ordonnanceur se met en pause jusqu'à la réinitialisation, aucun compte-rendu
 *     trompeur n'est écrit.
 */
async function handleLimitHit(taskId, limit, sessionId) {
  const task = readTasks().find(t => t.id === taskId) || {}
  const wanted = task.model || preferredAgentModel()
  const ranModel = task.run_model || wanted
  const scope = await fetchLimitScope()
  noteLimit(scope === 'account' ? KNOWN_MODELS : [ranModel], limit)

  const hops = task.model_fallbacks || 0
  const fallback = resolveModel(wanted)
  if (scope === 'model' && fallback && fallback !== ranModel && hops < maxFallbacksFor(wanted)) {
    // Repli immédiat : la tâche redevient « approved » et kick() la relance aussitôt
    // (releaseSlot enchaîne). Le modèle SOUHAITÉ reste inscrit tel quel — c'est
    // resolveModel qui choisit au démarrage, donc fable reprend la main dès son retour.
    const retried = updateTask(taskId, {
      status: 'approved',
      agent_result: `(quota ${ranModel} épuisé jusqu'à ${limit.label} — reprise immédiate sur ${fallback})`,
      user_summary: null,
      run_model: null,
      model_fallbacks: hops + 1,
      session_id: sessionId || null,
      completed_at: null,
    })
    console.warn(`🤖 Agent: tâche ${taskId} relancée sur ${fallback} (quota ${ranModel} épuisé jusqu'à ${limit.label})`)
    if (retried) broadcastTask(retried)
    return
  }

  const isQueue = task.kind === 'queue'
  const deferred = updateTask(taskId, {
    // Item de file : c'est la file qui le relancera (nouvelle tâche) → celle-ci sort
    // du jeu. Suggestion/backlog : le runner la reprendra lui-même.
    status: isQueue ? 'cancelled' : 'approved',
    agent_result: `(limite de session Claude atteinte — reprise automatique à ${limit.label})`,
    user_summary: null,
    run_model: null,
    session_id: sessionId || null,
    completed_at: null,
  })
  if (deferred) {
    broadcastTask(deferred)
    setImmediate(() => {
      import('./promptQueue.js')
        .then(m => m.onAgentTaskDeferred(deferred, limit))
        .catch(e => console.error('🤖 File de travaux: report impossible —', e.message))
    })
  }
}

// ─── Public scheduling API ────────────────────────────────────────────────────
export function requestReply(taskId) {
  if (!_replyQueue.includes(taskId)) _replyQueue.push(taskId)
  setImmediate(kick)
}

// runNextTask kept as a public alias for back-compat (routes call it after approve).
export function runNextTask() { kick() }

// ─── The scheduler heart: pick the next activity by priority ───────────────────
function kick() {
  if (!getSettings().enabled) return

  // File de travaux en pause : ses tâches restent « approved » sans démarrer. Le reste
  // de l'agent (signalements de la bulle d'aide, réponses de conversation) continue —
  // la pause vise la consommation de jetons des chantiers, pas l'app entière.
  const tasks = readTasks().filter(t => !(isQueuePaused() && t.kind === 'queue'))
  const byPriority = (a, b) => (b.priority - a.priority) || a.created_at.localeCompare(b.created_at)
  // Quota épuisé : une tâche n'attend QUE si son modèle et tous ses replis sont à sec
  // (un timer relance kick à la réinitialisation). Le plafond hebdomadaire de fable
  // laisse donc la file tourner sur opus.
  const hasModel = t => !!resolveModel(t.model || preferredAgentModel())

  // 1. Voie lecture seule : les questions démarrent même si une implémentation
  // tourne, jusqu'à MAX_PARALLEL_QUESTIONS simultanées.
  for (const q of tasks.filter(t => t.status === 'approved' && t.mode === 'question' && hasModel(t)).sort(byPriority)) {
    if (_questionRuns.size >= MAX_PARALLEL_QUESTIONS) break
    executeTask(q, { lane: 'question' })
  }

  if (busy) return

  // 2. Implémentation : une seule à la fois, elle édite l'arbre de travail réel.
  const nextExec = tasks
    .filter(t => t.status === 'approved' && t.mode !== 'question' && hasModel(t))
    .sort(byPriority)[0]
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
    ], { cwd: CWD, env: { ...cleanEnv, HOME: '/home/ec2-user', ERP_AGENT_RUN: '1' }, stdio: 'pipe' })

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
// `lane` : 'exec' (slot global, fichier PID unique), 'question' (voie parallèle
// lecture seule, un fichier PID par tâche — voir QPID_FILE) ou 'recover'
// (récupération d'une exécution orpheline dont le slot est déjà tenu par une AUTRE
// tâche : on lit ses artefacts et on écrit son résultat, sans toucher au slot ni au
// fichier PID, qui appartiennent à l'exécution en cours).
export function monitorExecution(taskId, knownPid = null, { lane = 'exec' } = {}) {
  const LOG = EXEC_LOG(taskId)
  const CODE = EXEC_CODE(taskId)
  const pidFile = lane === 'question' ? QPID_FILE(taskId) : (lane === 'recover' ? null : PID_FILE)
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
    let raw = ''
    try { if (existsSync(LOG)) raw = readFileSync(LOG, 'utf8') } catch {}
    const text = extractAssistantText(raw)
    const sessionId = extractSessionId(raw)

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

    // Quota Claude épuisé : la tâche n'a pas échoué, elle n'a pas pu travailler. On la
    // remet en file, on met l'ordonnanceur en pause jusqu'à la réinitialisation, et on
    // n'écrit NI compte-rendu trompeur NI message d'erreur.
    const limit = detectRateLimitEvent(raw) || detectSessionLimit(agent_result)
    if (limit) {
      // Attribution asynchrone (quotas de l'abonnement) → repli sur un autre modèle ou
      // report. Le slot reste tenu le temps de trancher, puis cleanup() le libère.
      handleLimitHit(taskId, limit, sessionId).catch(e => {
        console.error('🤖 Agent: traitement du quota en échec —', e.message)
      }).finally(cleanup)
      return
    }

    // Question à l'humain : détachée AVANT le résumé. La section question vient après
    // celle du résumé dans le rapport ; l'extraction du résumé prenant tout jusqu'à la
    // fin, la laisser en place la collerait dans le compte-rendu au lieu de la poser
    // comme question à répondre.
    let pending_question = null
    {
      const cut = extractPendingQuestion(agent_result)
      agent_result = cut.text
      pending_question = cut.question
    }

    // Résumé vulgarisé : section finale demandée par le prompt d'exécution, affichée
    // en clair sur la fiche de la suggestion (le rapport technique reste en dépli).
    let user_summary = null
    const summaryIdx = agent_result.lastIndexOf(SUMMARY_SECTION_MARKER)
    if (summaryIdx !== -1) {
      user_summary = agent_result.slice(summaryIdx + SUMMARY_SECTION_MARKER.length).trim() || null
      agent_result = agent_result.slice(0, summaryIdx).trim()
    } else {
      // Section absente du récit concaténé : on la cherche dans le message final du
      // stream (événement `result`), qui la porte quand les événements `assistant`
      // ne l'ont pas véhiculée. Évite un compte-rendu « manquant » alors que le
      // modèle l'avait bien écrit.
      const cutResult = extractPendingQuestion(extractResultText(raw))
      const resultText = cutResult.text
      if (!pending_question) pending_question = cutResult.question
      const i = resultText.lastIndexOf(SUMMARY_SECTION_MARKER)
      if (i !== -1) {
        user_summary = resultText.slice(i + SUMMARY_SECTION_MARKER.length).trim() || null
        const head = resultText.slice(0, i).trim()
        if (head && !agent_result.includes(head)) {
          agent_result = agent_result === '(terminé sans rapport)' ? head : `${agent_result}\n\n${head}`
        }
      }
    }

    // Message de steering jamais consommé (envoyé dans les toutes dernières secondes,
    // ou pendant une exécution morte) : Claude ne l'a pas vu. On le pose sur la tâche
    // pour que la file de travaux relance immédiatement avec ce complément.
    let missed_user_message = null
    try {
      if (existsSync(EXEC_INBOX(taskId))) {
        missed_user_message = readFileSync(EXEC_INBOX(taskId), 'utf8')
          .split('\n').filter(l => l.trim())
          .map(l => { try { return String(JSON.parse(l).text || '').trim() } catch { return l.trim() } })
          .filter(Boolean).join('\n') || null
      }
    } catch {}

    const finalTask = updateTask(taskId, {
      status, agent_result, user_summary,
      pending_question,
      missed_user_message,
      session_id: sessionId || null,
      completed_at: new Date().toISOString(),
    })
    if (finalTask) broadcastTask(finalTask)

    // File de prompts : l'item passe à done/blocked, le recap part dans le DM Slack
    // et l'item suivant est mis en route. Import dynamique — promptQueue crée des
    // tâches via ce module, l'import statique serait circulaire.
    if (finalTask) {
      setImmediate(() => {
        import('./promptQueue.js')
          .then(m => m.onAgentTaskFinalized(finalTask))
          .catch(e => console.error('🤖 File de prompts: suite impossible —', e.message))
      })
    }

    // Section résumé absente du rapport (modèle qui a oublié la consigne) →
    // compte-rendu de secours généré a posteriori, hors slot (sans outils).
    if (!user_summary) setImmediate(() => generateUserSummary(taskId).catch(() => {}))

    cleanup()
  }

  // Artefacts de l'exécution + libération du slot. Partagé par les deux sorties de
  // finalize (tâche terminée, ou reportée pour quota épuisé).
  function cleanup() {
    try { unlinkSync(LOG) } catch {}
    try { unlinkSync(CODE) } catch {}
    try { unlinkSync(EXEC_PROMPT(taskId)) } catch {}
    try { unlinkSync(EXEC_INBOX(taskId)) } catch {}
    // Le fichier PID de la voie exec est PARTAGÉ : on ne le supprime que s'il porte
    // encore CETTE tâche. Sinon on effacerait le suivi d'une exécution qui vient de
    // démarrer (ou, pour un lane 'recover', de celle qui tourne vraiment) — et le
    // prochain redémarrage déclarerait « bloquée » une tâche parfaitement vivante.
    if (pidFile && pidFileTaskId(pidFile) === taskId) { try { unlinkSync(pidFile) } catch {} }
    setTimeout(() => streamBuffers.delete(taskId), 120_000).unref?.()
    if (lane === 'recover') {
      // Récupération hors slot : rien à libérer, rien à relancer ici.
    } else if (lane === 'question') {
      // Voie parallèle : rien à libérer côté slot global, on rend juste sa place
      // dans la voie lecture seule et on regarde s'il y a une autre question.
      _questionRuns.delete(taskId)
      setImmediate(kick)
    } else {
      releaseSlot()
    }
  }

  function currentPid() {
    if (knownPid) return knownPid
    if (!pidFile) return null
    // Le fichier PID de la voie exec peut avoir été réécrit par une autre tâche :
    // ne lire son PID que s'il porte bien celle qu'on suit.
    try {
      const [pidStr, id] = readFileSync(pidFile, 'utf8').trim().split('\n')
      if (id && id !== taskId) return null
      return parseInt(pidStr, 10)
    } catch { return null }
  }

  const poll = setInterval(() => {
    drainLog()
    // Primary signal: the wrapper wrote the exit code → done/blocked by code.
    if (existsSync(CODE)) { finalize(); return }
    // Hard timeout: kill the whole detached group, mark blocked.
    if (Date.now() - startedAt > EXEC_TIMEOUT_MS) {
      killExecutionTree(taskId, lane, currentPid())
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

/**
 * Tue une exécution ET toute sa descendance.
 *
 * `systemctl --user kill` frappe le cgroup de l'unité, donc les petits-enfants qui
 * ont créé leur propre groupe de processus (vite, node --test, chromium) — c'est
 * précisément ce que `kill(-pid)` laissait survivre lors de l'incident du
 * 2026-08-27. Le `kill(-pid)` reste en second rideau pour le chemin de repli
 * setsid, qui n'a pas d'unité.
 */
function killExecutionTree(taskId, lane, pid) {
  const unit = execUnitName(taskId, lane)
  try {
    spawn('systemctl', ['--user', 'kill', '--signal=SIGKILL', unit], {
      stdio: 'ignore',
      env: {
        ...process.env,
        XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || '/run/user/1000',
        DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS || 'unix:path=/run/user/1000/bus',
      },
    }).unref()
  } catch {}
  if (pid) { try { process.kill(-pid, 'SIGKILL') } catch {} }
}

function runDetachedExecution(taskId, prompt, {
  model = null, effort = null, tools = EXEC_TOOLS, resumeSessionId = null, lane = 'exec',
} = {}) {
  const LOG = EXEC_LOG(taskId)
  const CODE = EXEC_CODE(taskId)
  const PROMPT = EXEC_PROMPT(taskId)

  // Clear any stale artifacts from a previous run of the same id.
  for (const f of [LOG, CODE, EXEC_INBOX(taskId)]) { try { if (existsSync(f)) unlinkSync(f) } catch {} }
  writeFileSync(PROMPT, prompt, 'utf8')

  const { CLAUDECODE: _c, CLAUDE_CODE_ENTRYPOINT: _e, ...cleanEnv } = process.env
  // Modèle/effort issus du préréglage choisi par l'utilisateur à la soumission.
  const modelFlags = (model ? ` --model "${model}"` : '') + (effort ? ` --effort "${effort}"` : '')
  // --resume : l'item de file marqué « même contexte » poursuit la session Claude de
  // l'item précédent au lieu de repartir à zéro. Une session introuvable (purgée,
  // machine redémarrée) fait échouer le démarrage → l'item repart proprement d'un
  // contexte neuf, voir le repli dans promptQueue.startPrompt().
  const resumeFlag = resumeSessionId ? ` --resume "${resumeSessionId}"` : ''
  // Voie question : fichier PID par tâche ; voie exec : le fichier PID unique, celui
  // que deploy.sh consulte pour attendre la fin d'une exécution.
  const pidFile = lane === 'question' ? QPID_FILE(taskId) : PID_FILE

  // ⚠️ `setsid --fork` n'est PAS cosmétique : pm2 tourne en `treekill: true` (défaut) et
  // tue TOUT le sous-arbre du serveur à chaque `pm2 restart erp-server`. Sans la coupure
  // de lignée, chaque exécution mourait au premier redémarrage — y compris celui que
  // l'agent lance lui-même après une modif serveur (CLAUDE.md l'exige), donc il se
  // décapitait au moment de valider son propre travail : rapport tronqué à la première
  // phrase, et compte-rendu inventé par-dessus. setsid meurt aussitôt, le wrapper est
  // réadopté par init (ppid 1) et devient invisible pour treekill.
  //
  // Corollaire : le pid renvoyé par spawn() est celui de setsid, éphémère et inutile.
  // C'est donc le wrapper qui écrit SON pid dans le fichier PID, dès sa première ligne.
  // claude reads the prompt from stdin (PROMPT file); stream-json → LOG; exit code → CODE.
  // --settings : branche le hook de steering (voir EXEC_INBOX) sur CETTE exécution.
  // Le hook est inerte sans ERP_AGENT_TASK_ID, donc sans effet ailleurs.
  const cmd = `printf '%s\\n%s\\n' "$$" "${taskId}" > "${pidFile}"; ` +
    `"${CLAUDE_BIN}" -p --output-format stream-json --verbose${modelFlags}${resumeFlag} ` +
    `--settings "${STEER_SETTINGS}" ` +
    `--allowedTools "${tools}" < "${PROMPT}" > "${LOG}" 2>&1; echo $? > "${CODE}"`

  // XDG_RUNTIME_DIR / DBUS_SESSION_BUS_ADDRESS explicites : systemd-run --user en a
  // besoin pour joindre le user manager, et un `pm2 resurrect` au boot peut démarrer
  // erp-server sans ces variables.
  const execEnv = {
    ...cleanEnv,
    HOME: '/home/ec2-user',
    ERP_AGENT_RUN: '1',
    ERP_AGENT_TASK_ID: taskId,
    XDG_RUNTIME_DIR: cleanEnv.XDG_RUNTIME_DIR || '/run/user/1000',
    DBUS_SESSION_BUS_ADDRESS: cleanEnv.DBUS_SESSION_BUS_ADDRESS || 'unix:path=/run/user/1000/bus',
  }

  // Unité transitoire : le cgroup contient tout le sous-arbre (claude, vite,
  // node --test, chromium…). --collect nettoie l'unité même en échec, sinon les
  // units failed s'accumulent et le même nom devient inutilisable.
  const unit = execUnitName(taskId, lane)
  const systemdArgs = [
    '--user', `--unit=${unit}`, '--collect', '--quiet',
    `--property=MemoryMax=${EXEC_MEMORY_MAX}`,
    `--property=MemoryHigh=${EXEC_MEMORY_HIGH}`,
    `--property=MemorySwapMax=${EXEC_SWAP_MAX}`,
    `--property=CPUQuota=${EXEC_CPU_QUOTA}`,
    `--property=TasksMax=${EXEC_TASKS_MAX}`,
    `--property=WorkingDirectory=${CWD}`,
    'bash', '-c', cmd,
  ]

  const proc = spawn('systemd-run', systemdArgs, {
    cwd: CWD, env: execEnv, detached: true, stdio: 'ignore',
  })

  // Repli : sur une machine sans systemd --user utilisable, on ne veut pas perdre la
  // capacité d'exécuter — on retombe sur l'ancien setsid, sans plafond.
  //
  // Deux chemins d'échec distincts, et le second est le piège : `systemd-run` peut
  // sortir en code non nul SANS émettre 'error' (bus utilisateur injoignable, nom
  // d'unité refusé, propriété inconnue). Sans ce garde, l'exécution ne démarrerait
  // jamais et rien ne le dirait — le poll attendrait juste un .code qui n'arrive pas.
  let fellBack = false
  const fallbackToSetsid = (why) => {
    if (fellBack) return
    fellBack = true
    console.warn(`🤖 Agent: systemd-run inutilisable (${why}) — repli setsid SANS plafond de ressources (tâche ${taskId})`)
    const fb = spawn('setsid', ['--fork', 'bash', '-c', cmd], {
      cwd: CWD, env: execEnv, detached: true, stdio: 'ignore',
    })
    fb.on('error', (e) => console.error(`🤖 Agent: spawn de repli en échec: ${e.message}`))
    fb.unref()
  }
  proc.once('error', (e) => fallbackToSetsid(e.message))
  proc.once('exit', (code) => { if (code !== 0) fallbackToSetsid(`code ${code}`) })
  proc.unref()

  // knownPid volontairement absent : le vrai pid arrive par le fichier, quelques
  // millisecondes plus tard (currentPid() le relit à chaque tour de poll).
  monitorExecution(taskId, null, { lane })
}

// ─── Execution ────────────────────────────────────────────────────────────────
// lane 'exec' : read-write, prend le slot global (une seule à la fois).
// lane 'question' : lecture seule, hors slot, jusqu'à MAX_PARALLEL_QUESTIONS.
function executeTask(next, { lane = 'exec' } = {}) {
  if (lane === 'question') {
    _questionRuns.add(next.id)
  } else {
    busy = true
    currentTaskId = next.id
    currentActivity = 'execution'
  }

  // Modèle réellement utilisable : le modèle souhaité s'il a du quota, sinon son repli
  // (fable → opus). `run_model` garde la trace de ce qui a VRAIMENT tourné — c'est lui
  // qu'on attribue si l'exécution se heurte à un plafond.
  const wanted = next.model || preferredAgentModel()
  const runModel = resolveModel(wanted) || wanted
  if (runModel !== wanted) {
    console.log(`🤖 Agent: tâche ${next.id} lancée sur ${runModel} (quota ${wanted} épuisé)`)
  }

  // started_at : horodate le passage en in_progress pour alimenter le compteur de
  // temps écoulé côté UI (timer live pendant l'exécution, durée totale une fois terminée).
  const task = updateTask(next.id, {
    status: 'in_progress', started_at: new Date().toISOString(), run_model: runModel,
  })
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
  // Droit de poser une question — réservé aux items de la file de travaux : ce sont
  // les seuls dont la carte sait afficher la question et récolter la réponse. Une
  // tâche de la bulle d'aide qui la poserait parlerait dans le vide.
  if (next.work_prompt_id) prompt += ASK_USER_INSTRUCTION

  // Detached + durable: the result is recorded off a .code file, so a `pm2 restart`
  // triggered by the implementation itself can't lose the success and leave the task
  // wrongly "blocked". monitorExecution() handles streaming + finalization.
  // Question → outils lecture seule : l'agent ne peut physiquement rien implémenter.
  runDetachedExecution(next.id, prompt, {
    model: runModel, effort: next.effort,
    tools: isQuestion ? READONLY_TOOLS : EXEC_TOOLS,
    resumeSessionId: next.resume_session_id || null,
    lane,
  })
}

// ─── Création d'une tâche prête à exécuter (file de prompts) ───────────────────
// La file de travaux passe par ici plutôt que d'écrire dans agent-tasks.json
// elle-même : l'ordonnanceur, la diffusion temps réel et le format de tâche
// restent la propriété de ce module.
export function enqueueAgentTask({
  title, description, kind = 'queue', mode = 'implement', model = preferredAgentModel(),
  effort = 'high', priority = 0, author = '', work_prompt_id = null,
  resume_session_id = null,
}) {
  const now = new Date().toISOString()
  const task = {
    id: randomUUID(),
    kind,
    mode: mode === 'question' ? 'question' : 'implement',
    title: title || (description || '').slice(0, 140),
    description: description || '',
    context: '',
    author,
    model, effort,
    status: 'approved',
    priority,
    messages: [],
    user_comment: null,
    agent_result: null,
    user_summary: null,
    work_prompt_id,
    resume_session_id,
    created_at: now,
    updated_at: now,
    started_at: null,
    completed_at: null,
  }
  const tasks = readTasks()
  tasks.push(task)
  writeTasks(tasks)
  broadcastTask(task)
  setImmediate(kick)
  return task
}

export function findAgentTask(id) { return readTasks().find(t => t.id === id) || null }

/**
 * Retouche d'une tâche remise à l'ordonnanceur mais PAS ENCORE démarrée : c'est ce
 * qui rend le prompt d'un item « en attente » réellement modifiable. Refuse dès que
 * la tâche a quitté l'état « approved » — une exécution lancée lit son prompt une
 * fois pour toutes, la retoucher donnerait une carte qui ment.
 *
 * Pas de course possible : executeTask() passe la tâche à `in_progress` de façon
 * synchrone AVANT de lancer le process, donc `status === 'approved'` garantit ici
 * qu'aucun Claude ne tourne pour elle.
 */
export function updatePendingAgentTask(id, patch = {}) {
  if (!id) return false
  const task = readTasks().find(t => t.id === id)
  if (!task || task.status !== 'approved') return false
  const allowed = ['title', 'description', 'model', 'effort', 'mode']
  const updates = {}
  for (const k of allowed) if (patch[k] !== undefined) updates[k] = patch[k]
  if (!Object.keys(updates).length) return true
  const updated = updateTask(id, updates)
  if (updated) broadcastTask(updated)
  return true
}

/**
 * Reprise d'une tâche jamais démarrée : la file de travaux la retire de
 * l'ordonnanceur pour redonner la main à l'utilisateur (réordonner, mettre de côté,
 * supprimer). Même garantie que ci-dessus : refuse si l'exécution a commencé.
 */
export function cancelPendingAgentTask(id) {
  if (!id) return false
  const task = readTasks().find(t => t.id === id)
  if (!task || task.status !== 'approved') return false
  const updated = updateTask(id, {
    status: 'cancelled',
    completed_at: new Date().toISOString(),
    agent_result: '(reprise dans la file avant tout démarrage)',
  })
  if (updated) broadcastTask(updated)
  return true
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

/** Tâche inscrite dans un fichier PID (2e ligne), ou null. */
function pidFileTaskId(file) {
  try { return readFileSync(file, 'utf8').trim().split('\n')[1] || null } catch { return null }
}

/**
 * PID du wrapper d'une exécution, retrouvé dans la table des process — sans passer par
 * `.agent-pid`. Ce fichier est unique pour toute la voie exec : il peut avoir été
 * écrasé (démarrage d'une autre tâche) ou supprimé (suite de tests serveur, qui s'en
 * sert comme fixture) alors que le wrapper tourne toujours. Se fier à lui seul faisait
 * déclarer « bloquée » au démarrage suivant une exécution parfaitement vivante — et,
 * pire, libérait le slot : une seconde implémentation démarrait par-dessus la première,
 * dans le même arbre de travail.
 */
function livePidForTask(taskId) {
  let fallback = null
  for (const d of (() => { try { return readdirSync('/proc') } catch { return [] } })()) {
    if (!/^\d+$/.test(d)) continue
    let cmd = ''
    try { cmd = readFileSync(`/proc/${d}/cmdline`, 'utf8') } catch { continue }
    if (!cmd.includes(`.agent-exec-${taskId}`)) continue
    // Le wrapper bash (celui qui écrit le .code) fait foi ; le claude fils sert de repli.
    if (cmd.includes('printf')) return parseInt(d, 10)
    fallback = parseInt(d, 10)
  }
  return fallback
}

export function initTaskRunner() {
  // Reconnect to an orphaned execution Claude from a previous server instance.
  // monitorExecution() finalizes off the durable .code file, so an exec that finished
  // successfully WHILE the server was restarting (e.g. it ran `pm2 restart erp-server`
  // itself) is correctly marked DONE — not blocked. If the child already finished, the
  // first poll detects the .code file immediately; if it's still running, we tail it; if
  // it crashed without a .code file, it's marked blocked.
  // Les tâches dont on a repris le suivi ne doivent PAS être marquées bloquées
  // plus bas — elles tournent encore (ou viennent de finir, le .code fait foi).
  const reconnected = new Set()

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
        reconnected.add(taskId)
        monitorExecution(taskId, pid || null)
      }
    } catch {}
    if (!reconnected.size) {
      // Stale PID file (task already finalized / gone) → clean up its artifacts.
      try {
        const taskId = readFileSync(PID_FILE, 'utf8').trim().split('\n')[1]
        if (taskId) { for (const f of [EXEC_LOG(taskId), EXEC_CODE(taskId), EXEC_PROMPT(taskId), EXEC_INBOX(taskId)]) { try { unlinkSync(f) } catch {} } }
      } catch {}
      try { unlinkSync(PID_FILE) } catch {}
    }
  }

  // Même reprise pour la voie lecture seule, mais un fichier PID par tâche : une
  // question orpheline se rattache indépendamment de l'implémentation en cours.
  for (const f of (() => { try { return readdirSync(DATA_DIR) } catch { return [] } })()) {
    const m = f.match(/^\.agent-qpid-(.+)$/)
    if (!m) continue
    const taskId = m[1]
    const full = resolve(DATA_DIR, f)
    let pid = null
    try { pid = parseInt(readFileSync(full, 'utf8').trim().split('\n')[0], 10) } catch {}
    const t = readTasks().find(x => x.id === taskId)
    if (t && t.status === 'in_progress') {
      console.log(`🤖 Agent: question orpheline détectée (PID ${pid}, tâche ${taskId}) — reprise du suivi…`)
      _questionRuns.add(taskId)
      reconnected.add(taskId)
      monitorExecution(taskId, pid || null, { lane: 'question' })
    } else {
      try { unlinkSync(full) } catch {}
      for (const g of [EXEC_LOG(taskId), EXEC_CODE(taskId), EXEC_PROMPT(taskId), EXEC_INBOX(taskId)]) { try { unlinkSync(g) } catch {} }
    }
  }

  // Reprise SANS fichier PID : le .agent-pid a pu être écrasé/supprimé pendant
  // l'exécution. Avant de déclarer quoi que ce soit bloqué, on cherche les preuves
  // durables — le .code écrit par le wrapper, ou le wrapper lui-même dans la table
  // des process. Une exécution vivante garde le slot ; une exécution déjà finie est
  // finalisée sur son code de sortie (donc « terminée » si elle a réussi).
  for (const t of readTasks()) {
    if (t.status !== 'in_progress' || reconnected.has(t.id)) continue
    const pid = livePidForTask(t.id)
    if (!pid && !existsSync(EXEC_CODE(t.id))) continue
    reconnected.add(t.id)
    if (!busy) {
      console.log(`🤖 Agent: exécution ${pid ? 'vivante' : 'terminée'} retrouvée sans fichier PID (tâche ${t.id}) — reprise du suivi…`)
      busy = true
      currentTaskId = t.id
      currentActivity = 'execution'
      monitorExecution(t.id, pid || null)
    } else {
      // Le slot est déjà tenu par une autre exécution : on récupère seulement le
      // résultat de celle-ci, sans toucher au slot ni au fichier PID.
      console.log(`🤖 Agent: résultat récupéré hors slot pour la tâche ${t.id}`)
      monitorExecution(t.id, pid || null, { lane: 'recover' })
    }
  }

  // Exécution déclarée bloquée par un démarrage précédent alors que son wrapper avait
  // fini proprement : ses artefacts sont encore là, le vrai résultat est récupérable.
  for (const t of readTasks()) {
    if (t.status !== 'blocked' || reconnected.has(t.id)) continue
    if (!existsSync(EXEC_CODE(t.id)) || !existsSync(EXEC_LOG(t.id))) continue
    if (livePidForTask(t.id)) continue
    console.log(`🤖 Agent: tâche ${t.id} déclarée bloquée à tort — résultat récupéré depuis ses artefacts`)
    reconnected.add(t.id)
    monitorExecution(t.id, null, { lane: 'recover' })
  }

  // An execution interrupted by a server restart is marked BLOCKED (needs a human),
  // never silently re-approved. Re-approving created a runaway: an execution that
  // ran `pm2 restart erp-server` would be re-queued on every boot and loop forever.
  const tasks = readTasks()
  let changed = false
  for (const t of tasks) {
    if (t.status === 'in_progress' && !reconnected.has(t.id)) {
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

  // Quota hebdomadaire propre au modèle (fable) : lu directement dans les quotas de
  // l'abonnement pour basculer sur le repli AVANT de jeter une exécution dans le mur —
  // et pour revenir à fable dès que son plafond est réinitialisé. Toutes les 5 min ;
  // la lecture est mise en cache 60 s côté claudeUsage, donc le coût est négligeable.
  const syncLimits = () => syncScopedModelLimit()
    .then(changed => { if (changed) { rearmLimitTimer(); kick() } })
    .catch(() => {})
  setTimeout(syncLimits, 5_000).unref?.()
  setInterval(syncLimits, 5 * 60_000).unref?.()

  setImmediate(kick)
}

export function shutdownTaskRunner() {
  // Execution Claude is detached and finishes as an orphan; PID file persists for reconnect.
}
