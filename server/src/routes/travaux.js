// Routes de la page /travaux : file de prompts, suggestions de l'agent, travaux
// récurrents. Validation manuelle, erreurs uniformes { error }.
import { Router } from 'express'
import { execFile, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { requireAdmin } from '../middleware/auth.js'
import { TZ, shiftDate } from '../utils/datetime.js'
import {
  listPrompts, getPrompt, createPrompt, updatePrompt, deletePrompt,
  reorderPrompts, moveToFront, advanceQueue, listMessages, replyToPrompt,
  steerPrompt, getQueuePauseState, pauseQueue, resumeQueue, PROMPT_SPACES,
} from '../services/promptQueue.js'
import {
  listSuggestions, acceptSuggestion, dismissSuggestion, deleteSuggestion,
  addSuggestion, runSuggestionEngines, SUGGESTION_KINDS,
  getSuggestion, listSuggestionMessages, askSuggestion, isAnswering,
} from '../services/workSuggestions.js'
import {
  listRecurringTasks, listCompletions, createRecurringTask, updateRecurringTask,
  deleteRecurringTask, setCompletion, CADENCES, OWNERS,
  weekKeyToDay, describeWeek, weekOptions, localDay,
} from '../services/recurringWork.js'
import {
  listIdeas, createIdea, updateIdea, deleteIdea, reorderIdeas, promoteIdea,
} from '../services/workIdeas.js'
import { KNOWN_MODELS } from '../services/agentModel.js'
import {
  getSettings, setSettings, isRunnerBusy, findAgentTask,
  getRunningQuestionCount, getMaxParallelQuestions, stopRunningTask,
  getRunningExecutionCount, getExecLaneCount,
} from '../services/taskRunner.js'
import { spellfix, MAX_SPELLFIX_LENGTH } from '../services/textSpellfix.js'
import { DEFAULT_REVIEW_CRITERIA, MAX_REVIEW_CRITERIA_LENGTH, normalizeReviewCriteria } from '../services/appReview.js'

const execFileAsync = promisify(execFile)
const router = Router()
router.use(requireAdmin)

// ─── Compteur de lignes de code de Boréal ─────────────────────────────────────
// Fichiers suivis par git (client, serveur, partagé), lignes non vides. Lecture
// asynchrone + cache 10 min : le serveur est mono-thread, ne pas le figer.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const LOC_DIRS = ['client/src', 'server/src', 'server/scripts', 'shared']
const LOC_EXT = /\.(jsx?|mjs|cjs|css|py)$/
const LOC_TTL_MS = 10 * 60_000
let locCache = null
let locPending = null

async function countLinesOfCode() {
  const { stdout } = await execFileAsync('git', ['ls-files', '-z', '--', ...LOC_DIRS], { cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024 })
  const files = stdout.split('\0').filter(f => LOC_EXT.test(f))
  let lines = 0, count = 0
  for (const f of files) {
    try {
      const text = await readFile(path.join(REPO_ROOT, f), 'utf8')
      for (const l of text.split('\n')) if (l.trim()) lines++
      count++
    } catch { /* fichier supprimé non commité : ignoré */ }
  }
  const history = await locHistory(lines).catch(() => [])
  return { lines, files: count, at: new Date().toISOString(), history }
}

// Historique quotidien sur 1 an : les diffs git (awk, hors du thread Node) donnent
// le solde de lignes non vides de chaque commit ; on remonte depuis le compte
// actuel. Deltas des commits mis en cache par HEAD.
const LOC_AWK = `
/^C [0-9]/ { if (d != "") print d, n; d = $2; n = 0; next }
/^diff --git / { h = 0; ok = ($NF ~ /${LOC_EXT.source}/); next }
/^@@/ { h = 1; next }
h && ok && /^\\+/ { if (substr($0, 2) ~ /[^ \\t\\r]/) n++; next }
h && ok && /^-/ { if (substr($0, 2) ~ /[^ \\t\\r]/) n--; next }
END { if (d != "") print d, n }`
const DIFF_OPTS = ['--no-renames', '-p', '--no-color', '--no-ext-diff']
let commitDeltas = null // { head, rows: [[day, delta]] } du plus récent au plus ancien

function gitDeltas(gitArgs, prefix = '') {
  return new Promise((resolve, reject) => {
    const git = spawn('git', gitArgs, { cwd: REPO_ROOT, env: { ...process.env, TZ } })
    const awk = spawn('awk', [LOC_AWK])
    let out = ''
    if (prefix) awk.stdin.write(prefix)
    git.stdout.pipe(awk.stdin)
    git.on('error', reject)
    awk.on('error', reject)
    awk.stdout.on('data', c => { out += c })
    awk.on('close', code => code ? reject(new Error(`awk ${code}`))
      : resolve(out.trim().split('\n').filter(Boolean).map(l => { const [d, n] = l.split(' '); return [d, Number(n)] })))
  })
}

async function locHistory(current) {
  const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT })
  const head = stdout.trim()
  if (commitDeltas?.head !== head) {
    commitDeltas = { head, rows: await gitDeltas(['log', '--first-parent', '--diff-merges=first-parent', ...DIFF_OPTS,
      '--format=C %cd', '--date=format-local:%Y-%m-%d', '--', ...LOC_DIRS]) }
  }
  const wt = (await gitDeltas(['diff', 'HEAD', ...DIFF_OPTS, '--', ...LOC_DIRS], 'C 0000-00-00\n'))[0]?.[1] || 0
  // Fin de journée de chaque jour de commit (le plus récent du jour l'emporte).
  const endOfDay = new Map()
  let running = current - wt
  for (const [day, delta] of commitDeltas.rows) {
    if (!endOfDay.has(day)) endOfDay.set(day, running)
    running -= delta
  }
  const today = localDay()
  const first = commitDeltas.rows.at(-1)?.[0]
  const points = []
  let value = null
  const known = [...endOfDay.keys()].sort()
  let k = 0
  for (let i = 364; i >= 0; i--) {
    const day = shiftDate(today, -i)
    while (k < known.length && known[k] <= day) value = endOfDay.get(known[k++])
    if (!first || day < first) continue
    points.push([day, i === 0 ? current : value])
  }
  return points
}

router.get('/code-stats', async (req, res) => {
  try {
    if (!locCache || Date.now() - Date.parse(locCache.at) > LOC_TTL_MS) {
      locPending ||= countLinesOfCode().finally(() => { locPending = null })
      locCache = await locPending
    }
    res.json(locCache)
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// ─── Utilisation du CPU de la machine ─────────────────────────────────────────
// % occupé entre deux relevés des compteurs os.cpus() (tous cœurs). Le premier
// appel mesure sur 300 ms sans bloquer ; ensuite, delta depuis l'appel précédent.
function cpuTimes() {
  let idle = 0, total = 0
  for (const c of os.cpus()) {
    const t = c.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  return { idle, total }
}
let cpuPrev = null
let cpuLast = null

router.get('/cpu', async (req, res) => {
  if (!cpuPrev) {
    cpuPrev = cpuTimes()
    await new Promise(r => setTimeout(r, 300))
  }
  const now = cpuTimes()
  const dTotal = now.total - cpuPrev.total
  if (dTotal > 0) {
    cpuLast = Math.max(0, Math.min(100, Math.round((1 - (now.idle - cpuPrev.idle) / dTotal) * 100)))
    cpuPrev = now
  }
  res.json({ percent: cpuLast ?? 0, cores: os.cpus().length, load: os.loadavg().map(v => Math.round(v * 100) / 100) })
})

// ─── File de prompts ──────────────────────────────────────────────────────────

/**
 * « running » côté file ne veut PAS dire « Claude travaille dessus » : l'item a été
 * remis à l'ordonnanceur, qui ne démarre qu'une implémentation PAR FILE (et au plus
 * getMaxParallelQuestions() questions). Deux réponses envoyées coup sur coup dans
 * deux fils d'une même file donnaient donc deux cartes « en cours » alors qu'une
 * seule avançait. On distingue l'état réel de la tâche agent :
 *   'executing' → le process Claude tourne pour cet item
 *   'waiting'   → dans la file de l'ordonnanceur, en attente d'un poste libre
 */
function runState(p, task) {
  if (p.status !== 'running') return null
  // Tâche introuvable = exécution perdue : advanceQueue la réconciliera au prochain
  // passage. En attendant, ne pas prétendre que ça tourne.
  if (!task) return 'waiting'
  return task.status === 'in_progress' ? 'executing' : 'waiting'
}

/**
 * Voie d'exécution d'un item : les questions ont la leur (lecture seule, parallèle),
 * les implémentations partagent UNE file servie par plusieurs postes. C'est
 * cette voie qui définit « avec qui » un item se dispute un poste — donc son rang
 * d'attente affiché.
 */
function laneOf(p) {
  return (p.mode === 'question' && !p.same_context) ? 'question' : 'exec'
}

/**
 * Question en attente : stockée en JSON sur la colonne, rendue au front en objet
 * { question, options[] }. Un JSON illisible (écriture d'une version antérieure)
 * dégrade en question sans choix plutôt que de casser la page.
 */
function parseQuestion(raw) {
  if (!raw) return null
  try {
    const q = JSON.parse(raw)
    if (!q?.question) return null
    return { question: String(q.question), options: Array.isArray(q.options) ? q.options.map(String) : [] }
  } catch {
    return { question: String(raw), options: [] }
  }
}

// Pages citées par le rapport d'implémentation : `client/src/pages/Foo.jsx` → `Foo`.
// Le front en déduit la route (voir COMPONENT_TO_ROUTE dans PageLink.jsx).
function pagesFromReport(report) {
  if (!report) return []
  const names = new Set()
  for (const m of String(report).matchAll(/client\/src\/pages\/(\w+)\.jsx/g)) names.add(m[1])
  return [...names]
}

// Le compte-rendu vit sur la tâche agent : on le rapatrie sur l'item pour que la
// page n'ait pas à croiser deux sources (et reste lisible après un /clear).
function withResult(p) {
  const task = p.agent_task_id ? findAgentTask(p.agent_task_id) : null
  return {
    ...p,
    pending_question: parseQuestion(p.pending_question),
    user_summary: task?.user_summary || null,
    agent_status: task?.status || null,
    // Modèle qui a VRAIMENT tourné (Auto résolu, ou repli de quota) : la colonne
    // « Modèle » l'affiche même quand l'item a été laissé en « Auto ».
    run_model: task?.run_model || null,
    // Fichiers touchés par une exécution qui n'a pas fini proprement (arrêtée,
    // bloquée) : la carte s'en sert pour proposer un nettoyage à la suppression.
    touched_files: task?.touched_files || [],
    // Repris tel quel par <PageLink> côté front pour retrouver la section modifiée
    // (route de signalement, ou à défaut déduite du rapport d'implémentation).
    context: task?.context || null,
    // Le rapport brut de l'agent ne part PLUS dans la liste : à lui seul il pesait
    // 1,5 Mo sur les 3,5 Mo de la réponse, pour un seul usage à l'écran — deviner la
    // page modifiée. On envoie donc juste les pages qu'il cite (<PageLink>).
    agent_pages: pagesFromReport(task?.agent_result),
    run_state: runState(p, task),
    // Bornes de l'exécution réelle (pas de la remise à l'ordonnanceur) : colonne
    // « Temps » du tableau.
    run_started_at: task?.started_at || null,
    run_completed_at: task?.completed_at || null,
    lane: laneOf(p),
    // Le fil est joint à la liste : quelques messages courts par tâche, ça évite un
    // aller-retour par carte pour l'afficher.
    messages: listMessages(p.id),
  }
}

/**
 * Rang d'attente affiché sur les cartes (« 2e à partir »), calculé par voie : un item
 * ne se compare qu'à ceux qui lui disputent le même poste. Les items déjà remis à
 * l'ordonnanceur passent avant ceux encore en file côté page.
 */
function withWaitRank(rows) {
  const counters = {}
  const waiting = rows
    // Un item à départ différé (start_at à venir) ne dispute aucun poste avant son
    // heure : lui donner un rang ferait mentir « 2e à partir » sur les autres.
    .filter(p => (p.run_state === 'waiting' || p.status === 'queued')
      && !(p.start_at && Date.parse(p.start_at) > Date.now()))
    .sort((a, b) => {
      const ai = a.run_state === 'waiting' ? 0 : 1
      const bi = b.run_state === 'waiting' ? 0 : 1
      if (ai !== bi) return ai - bi
      // Déjà remis à l'ordonnanceur : l'ordre est celui de la remise (started_at est
      // horodaté au moment où l'item lui est passé), pas la position dans la page.
      if (!ai) return String(a.started_at || '').localeCompare(String(b.started_at || ''))
      return (a.position - b.position) || a.created_at.localeCompare(b.created_at)
    })
  const ranks = new Map()
  for (const p of waiting) ranks.set(p.id, counters[p.lane] = (counters[p.lane] || 0) + 1)
  return rows.map(p => ({ ...p, wait_rank: ranks.get(p.id) || null }))
}

/**
 * Item « vivant » : il occupe la file ou attend une décision de l'utilisateur.
 * Lisible sur la ligne BRUTE (pending_question encore en JSON) comme sur la ligne
 * hydratée — c'est ce qui permet de trier avant d'hydrater.
 */
function isActivePrompt(p) {
  if (['running', 'queued', 'paused'].includes(p.status)) return true
  if (!['done', 'blocked'].includes(p.status)) return false
  const q = typeof p.pending_question === 'string' ? parseQuestion(p.pending_question) : p.pending_question
  return !!q?.question
}

router.get('/prompts', (req, res) => {
  const space = req.query.space || null
  if (space && !PROMPT_SPACES.includes(space)) return res.status(400).json({ error: 'space invalide' })
  // `active=1` : uniquement la file vivante, sans l'historique terminé et ses fils.
  // La réponse complète pèse plusieurs centaines de Ko — trop lourde pour le
  // panneau rapide, ouvert depuis n'importe quelle page de l'ERP.
  const activeOnly = req.query.active === '1' || req.query.active === 'true'
  // Les rangs d'attente se calculent sur TOUTES les files (l'exécuteur est partagé :
  // « 2e à partir » doit compter les items de l'autre file aussi), puis on ne rend
  // que la file demandée. Sans `space`, tout (rétro-compatible).
  // Le tri « vivant » se fait AVANT l'hydratation : elle coûte une lecture de
  // tâche agent et un fil de messages par item, et l'historique en compte des
  // centaines dont ce point d'entrée ne rendra rien. Les rangs d'attente ne
  // portent que sur des items vivants (running/queued), ils sont donc identiques.
  const rows = activeOnly ? listPrompts({ activeOnly: true }).filter(isActivePrompt) : listPrompts()
  const prompts = withWaitRank(rows.map(withResult))
    .filter(p => !space || p.space === space)
  const pause = getQueuePauseState()
  res.json({
    prompts,
    agent_enabled: !!getSettings().enabled,
    // Pause manuelle de la file : rien ne démarre tant qu'elle tient.
    queue_paused: pause.paused,
    queue_paused_at: pause.paused_at,
    queue_paused_reason: pause.reason,
    // Pause posée par le garde-fou de quota : elle se lèvera d'elle-même dès que le
    // quota Claude remonte (quotaGuard.js).
    queue_paused_by_quota: pause.by_quota,
    runner_busy: isRunnerBusy(),
    // Voie lecture seule : les questions tournent en parallèle d'un chantier.
    running_questions: getRunningQuestionCount(),
    max_parallel_questions: getMaxParallelQuestions(),
    // Quatre files d'implémentation : combien avancent, sur combien de postes.
    running_implementations: getRunningExecutionCount(),
    exec_lanes: getExecLaneCount(),
  })
})

// Autocorrecteur de la fenêtre « Modifier le système » : renvoie le texte
// corrigé (ou l'original si la correction est refusée par le garde-fou).
router.post('/spellfix', async (req, res) => {
  const text = String(req.body?.text ?? '')
  if (text.length > MAX_SPELLFIX_LENGTH) return res.status(400).json({ error: 'texte trop long' })
  try {
    res.json({ text: await spellfix(text) })
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

router.post('/prompts', (req, res) => {
  const { title, prompt, mode, preset, status, priority, space, model, start_at } = req.body || {}
  if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: 'prompt requis' })
  if (mode && !['implement', 'question'].includes(mode)) return res.status(400).json({ error: 'mode invalide' })
  // 'auto' = calibre jugé par le modèle à partir de la demande (voir promptPreset.js).
  if (preset && !['auto', 'fast', 'standard', 'deep'].includes(preset)) return res.status(400).json({ error: 'preset invalide' })
  if (status && !['queued', 'paused'].includes(status)) return res.status(400).json({ error: 'status invalide' })
  if (space && !PROMPT_SPACES.includes(space)) return res.status(400).json({ error: 'space invalide' })
  // Modèle choisi pour CETTE demande (sélecteur de la fenêtre « Modifier le système »).
  // Absent = on suit le modèle du préréglage, donc le modèle préféré de l'agent.
  if (model && !KNOWN_MODELS.includes(String(model).toLowerCase())) {
    return res.status(400).json({ error: `modèle invalide — choix possibles : ${KNOWN_MODELS.join(', ')}` })
  }
  // Départ différé (« ce soir, 19 h ») : instant ISO envoyé par le client, qui seul
  // connaît l'heure locale de l'utilisateur. Une heure déjà passée est ignorée par
  // createPrompt — l'item part alors normalement.
  if (start_at && Number.isNaN(Date.parse(start_at))) return res.status(400).json({ error: 'start_at invalide' })
  // Reprendre le contexte du précédent était un choix manuel — retiré : un item
  // créé de zéro part toujours avec un contexte neuf. La vraie continuité (réponse,
  // relance fauchée) passe par `follow_up`, décidé automatiquement, pas ici.
  const created = createPrompt({
    title, prompt, mode, preset, status, space, model, start_at,
    // Coché à la création : l'item passe devant la file (même effet que le bouton
    // « Passer en premier », sans avoir à le cliquer après coup).
    priority: !!priority,
    created_by: req.user?.id || null,
  })
  // Rien ne tourne → l'item part tout de suite ; sinon il attend son tour.
  advanceQueue()
  res.status(201).json(withResult(getPrompt(created.id)))
})

router.patch('/prompts/:id', (req, res) => {
  const updated = updatePrompt(req.params.id, req.body || {})
  if (!updated) return res.status(404).json({ error: 'introuvable' })
  advanceQueue()
  res.json(withResult(updated))
})

router.delete('/prompts/:id', (req, res) => {
  if (!deletePrompt(req.params.id)) return res.status(404).json({ error: 'introuvable' })
  res.json({ ok: true })
})

router.post('/prompts/reorder', (req, res) => {
  const { ids } = req.body || {}
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids requis' })
  // reorderPrompts se charge lui-même de rendre à l'ordonnanceur les items qu'il lui
  // a repris ; un simple changement de priorité ne déclenche donc rien.
  res.json({ prompts: withWaitRank(reorderPrompts(ids).map(withResult)) })
})

router.post('/prompts/:id/first', (req, res) => {
  const p = moveToFront(req.params.id)
  if (!p) return res.status(404).json({ error: 'introuvable' })
  advanceQueue()
  res.json(withResult(p))
})

// Fil de discussion d'une tâche.
router.get('/prompts/:id/messages', (req, res) => {
  if (!getPrompt(req.params.id)) return res.status(404).json({ error: 'introuvable' })
  res.json({ messages: listMessages(req.params.id) })
})

// Réponse de l'humain → relance de la tâche avec ce complément. `placement` choisit
// le moment : 'front' (défaut) = repart tout de suite, avant le reste de la file ;
// 'back' = retourne en FIN de file et repartira quand son tour reviendra.
router.post('/prompts/:id/reply', (req, res) => {
  const { text, placement } = req.body || {}
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text requis' })
  if (placement && !['front', 'back'].includes(placement)) return res.status(400).json({ error: 'placement invalide' })
  const out = replyToPrompt(req.params.id, { text, userId: req.user?.id || null, placement })
  if (!out) return res.status(404).json({ error: 'introuvable' })
  if (out.error === 'running') {
    return res.status(409).json({ error: 'la tâche est en cours d\'exécution — réponds quand elle a rendu la main' })
  }
  if (out.error) return res.status(400).json({ error: 'réponse vide' })
  res.status(201).json(withResult(out.prompt))
})

// Message envoyé PENDANT l'exécution (steering, comme dans Claude Code) : livré à
// Claude en cours de tâche sans l'interrompre. `delivered` dit par quelle voie :
// 'live' (l'exécution tourne, le hook le glisse au prochain outil) ou 'queued'
// (la tâche attend son tour, le message est intégré au brief avant le départ).
router.post('/prompts/:id/message', (req, res) => {
  const { text } = req.body || {}
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text requis' })
  const out = steerPrompt(req.params.id, { text, userId: req.user?.id || null })
  if (!out) return res.status(404).json({ error: 'introuvable' })
  if (out.error === 'not-running') {
    return res.status(409).json({ error: 'la tâche a rendu la main — utilise « Répondre et relancer »' })
  }
  if (out.error) return res.status(400).json({ error: 'message vide' })
  res.status(201).json({ ...withResult(out.prompt), delivered: out.delivered })
})

// Arrêt d'un item EN COURS D'EXÉCUTION (statut agent 'in_progress' — pas 'waiting'
// dans la file de l'ordonnanceur, où c'est mettre de côté/reprendre qu'il faut). Le
// process est tué tout de suite ; la carte repasse à 'blocked' (agent_status
// 'stopped') dès que le poll de monitorExecution détecte la mort du process.
router.post('/prompts/:id/stop', (req, res) => {
  const p = getPrompt(req.params.id)
  if (!p) return res.status(404).json({ error: 'introuvable' })
  if (!p.agent_task_id) return res.status(409).json({ error: 'rien à arrêter' })
  const out = stopRunningTask(p.agent_task_id)
  if (!out.ok) return res.status(409).json({ error: out.error })
  res.json({ ok: true })
})

// Relance manuelle de l'ordonnanceur (bouton « Lancer la file »). `reason` dit
// pourquoi rien n'a démarré : file vide, agent désactivé, ou exécution en cours.
router.post('/prompts/advance', (req, res) => {
  const { started, startedCount, reason } = advanceQueue()
  res.json({ started: started ? withResult(started.prompt) : null, startedCount, reason })
})

// ─── Pause de la file ─────────────────────────────────────────────────────────
// Bouton assumé (pas d'autosave) : mettre la file en pause / la reprendre est une
// action à effet réel — elle décide si des exécutions Claude démarrent ou non.
// La pause n'interrompt JAMAIS l'exécution en cours : elle bloque seulement les
// départs, donc reprendre repart exactement où la file s'était arrêtée.

router.get('/queue/pause', (req, res) => {
  res.json(getQueuePauseState())
})

router.post('/queue/pause', (req, res) => {
  const { paused, reason } = req.body || {}
  if (typeof paused !== 'boolean') return res.status(400).json({ error: 'paused (booléen) requis' })
  const out = paused ? pauseQueue({ reason: reason || null }) : resumeQueue()
  res.json(out)
})

// ─── Suggestions de l'agent ───────────────────────────────────────────────────

function reviewSettings() {
  return { criteria: getSettings().appReviewCriteria || '', defaultCriteria: DEFAULT_REVIEW_CRITERIA, maxLength: MAX_REVIEW_CRITERIA_LENGTH }
}
router.get('/review-settings', (req, res) => res.json(reviewSettings()))
router.put('/review-settings', (req, res) => {
  let criteria
  try { criteria = normalizeReviewCriteria(req.body?.criteria) } catch (error) {
    return res.status(400).json({ error: error.message })
  }
  setSettings({ appReviewCriteria: criteria })
  res.json(reviewSettings())
})

router.get('/suggestions', (req, res) => {
  const status = req.query.status || null
  const kind = req.query.kind || null
  const source = req.query.source || null
  if (source && !['legacy', 'app_review'].includes(source)) return res.status(400).json({ error: 'source invalide' })
  if (status && !['new', 'accepted', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: 'status invalide' })
  }
  if (kind && !SUGGESTION_KINDS.includes(kind)) return res.status(400).json({ error: 'kind invalide' })
  res.json({ suggestions: listSuggestions({ status, kind, source }) })
})

router.post('/suggestions', (req, res) => {
  const { title, prompt, rationale, area, kind } = req.body || {}
  if (!title || !prompt) return res.status(400).json({ error: 'title et prompt requis' })
  if (kind && !SUGGESTION_KINDS.includes(kind)) return res.status(400).json({ error: 'kind invalide' })
  const created = addSuggestion({ title, prompt, rationale, area, kind })
  if (!created) return res.status(409).json({ error: 'suggestion déjà présente' })
  res.status(201).json(created)
})

router.post('/suggestions/:id/accept', (req, res) => {
  const space = req.body?.space || 'finance'
  if (!PROMPT_SPACES.includes(space)) return res.status(400).json({ error: 'space invalide' })
  const out = acceptSuggestion(req.params.id, {
    userId: req.user?.id || null,
    overridePrompt: req.body?.prompt || null,
    priority: !!req.body?.priority,
    // La suggestion rejoint la file de la section d'où elle est acceptée.
    space,
  })
  if (!out) return res.status(404).json({ error: 'introuvable' })
  advanceQueue()
  res.json(out)
})

router.post('/suggestions/:id/dismiss', (req, res) => {
  const s = dismissSuggestion(req.params.id, req.body?.reason || null)
  if (!s) return res.status(404).json({ error: 'introuvable' })
  res.json(s)
})

router.delete('/suggestions/:id', (req, res) => {
  deleteSuggestion(req.params.id)
  res.json({ ok: true })
})

// Fil de discussion d'une suggestion : « dis-m'en plus » avant de décider. Rien ne
// s'exécute par ce chemin — c'est un échange en lecture seule à côté de la carte.
router.get('/suggestions/:id/messages', (req, res) => {
  if (!getSuggestion(req.params.id)) return res.status(404).json({ error: 'introuvable' })
  res.json({ messages: listSuggestionMessages(req.params.id), pending: isAnswering(req.params.id) })
})

router.post('/suggestions/:id/messages', (req, res) => {
  const { text } = req.body || {}
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text requis' })
  const out = askSuggestion(req.params.id, { text, userId: req.user?.id || null })
  if (!out) return res.status(404).json({ error: 'introuvable' })
  if (out.error === 'busy') return res.status(409).json({ error: 'Claude est déjà en train de répondre — attends sa réponse' })
  if (out.error) return res.status(400).json({ error: 'message vide' })
  res.status(201).json(out)
})

// Passage manuel du moteur. Long (appel modèle) → on répond tout de suite et la
// page se met à jour par la diffusion temps réel quand les suggestions arrivent.
// `kind` restreint à un moteur (chantiers ou intégrations) ; sans lui, les deux.
router.post('/suggestions/generate', (req, res) => {
  const kind = req.body?.kind || null
  const source = req.body?.source || null
  if (source && source !== 'app_review') return res.status(400).json({ error: 'source invalide' })
  if (kind && !SUGGESTION_KINDS.includes(kind)) return res.status(400).json({ error: 'kind invalide' })
  runSuggestionEngines({ kind, source }).catch(e => console.error('🤖 Suggestions de travaux:', e.message))
  res.status(202).json({ ok: true })
})

// ─── Carnet d'idées ───────────────────────────────────────────────────────────
// Aucune route de cette section ne déclenche d'exécution : la seule qui touche à
// l'agent (promote) dépose l'item « de côté ».

router.get('/ideas', (req, res) => {
  res.json({ ideas: listIdeas() })
})

router.post('/ideas', (req, res) => {
  const { title, notes, tag } = req.body || {}
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'title requis' })
  res.status(201).json(createIdea({ title, notes, tag, created_by: req.user?.id || null }))
})

router.patch('/ideas/:id', (req, res) => {
  const updated = updateIdea(req.params.id, req.body || {})
  if (!updated) return res.status(404).json({ error: 'introuvable' })
  res.json(updated)
})

router.delete('/ideas/:id', (req, res) => {
  if (!deleteIdea(req.params.id)) return res.status(404).json({ error: 'introuvable' })
  res.json({ ok: true })
})

router.post('/ideas/reorder', (req, res) => {
  const { ids } = req.body || {}
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids requis' })
  res.json({ ideas: reorderIdeas(ids) })
})

// Passage à l'action : crée un item de file « de côté » (jamais lancé d'office).
router.post('/ideas/:id/promote', (req, res) => {
  const space = req.body?.space || 'finance'
  if (!PROMPT_SPACES.includes(space)) return res.status(400).json({ error: 'space invalide' })
  const out = promoteIdea(req.params.id, { userId: req.user?.id || null, prompt: req.body?.prompt || null, space })
  if (!out) return res.status(404).json({ error: 'introuvable' })
  res.status(out.already ? 200 : 201).json(out)
})

// ─── Travaux récurrents ───────────────────────────────────────────────────────

// `week=2026-W33` déplace l'ancre de lecture : les périodes de toutes les
// cadences sont recalculées à partir de cette semaine (une clé inconnue retombe
// silencieusement sur la semaine courante — un signet périmé ne doit rien casser).
router.get('/recurring', (req, res) => {
  const owner = req.query.owner || null
  const asked = req.query.week ? weekKeyToDay(req.query.week) : null
  const anchor = asked || localDay()
  const week = describeWeek(anchor)
  res.json({
    tasks: listRecurringTasks({ owner, includeInactive: req.query.all === '1', date: anchor }),
    cadences: CADENCES,
    week,
    weeks: weekOptions({ include: week.key }),
  })
})

router.post('/recurring', (req, res) => {
  const { label, cadence, owner, day_hint, notes, due_date, due_day } = req.body || {}
  if (!label || !String(label).trim()) return res.status(400).json({ error: 'label requis' })
  if (cadence && !CADENCES.includes(cadence)) return res.status(400).json({ error: 'cadence invalide' })
  if (owner && !OWNERS.includes(owner)) return res.status(400).json({ error: 'propriétaire invalide' })
  res.status(201).json(createRecurringTask({ label, cadence, owner, day_hint, notes, due_date, due_day }))
})

router.patch('/recurring/:id', (req, res) => {
  const updated = updateRecurringTask(req.params.id, req.body || {})
  if (!updated) return res.status(404).json({ error: 'introuvable' })
  res.json(updated)
})

router.delete('/recurring/:id', (req, res) => {
  if (!deleteRecurringTask(req.params.id)) return res.status(404).json({ error: 'introuvable' })
  res.json({ ok: true })
})

// Cochage par période : { done, period_key?, note? }. Sans period_key, la période
// courante de la cadence du travail.
router.post('/recurring/:id/completion', (req, res) => {
  const { done, period_key, note } = req.body || {}
  if (typeof done !== 'boolean') return res.status(400).json({ error: 'done (booléen) requis' })
  const out = setCompletion(req.params.id, {
    done, periodKey: period_key || null, note: note || null,
    userId: req.user?.id || null,
  })
  if (!out) return res.status(404).json({ error: 'introuvable' })
  if (out.invalid) return res.status(400).json({ error: `période invalide pour cette cadence : ${out.period_key}` })
  res.json(out)
})

router.get('/recurring/:id/completions', (req, res) => {
  res.json({ completions: listCompletions(req.params.id) })
})

export default router
