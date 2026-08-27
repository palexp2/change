// Routes de la page /travaux : file de prompts, suggestions de l'agent, travaux
// récurrents. Validation manuelle, erreurs uniformes { error }.
import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
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
import {
  getSettings, isRunnerBusy, findAgentTask,
  getRunningQuestionCount, getMaxParallelQuestions,
} from '../services/taskRunner.js'

const router = Router()
router.use(requireAuth)

// ─── File de prompts ──────────────────────────────────────────────────────────

/**
 * « running » côté file ne veut PAS dire « Claude travaille dessus » : l'item a été
 * remis à l'ordonnanceur, qui ne démarre qu'une implémentation à la fois (et au plus
 * getMaxParallelQuestions() questions). Deux réponses envoyées coup sur coup dans
 * deux fils différents donnaient donc deux cartes « en cours » alors qu'une seule
 * avançait. On distingue l'état réel de la tâche agent :
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

/** Voie d'exécution d'un item : les questions ont leur propre file (parallèle). */
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

// Le compte-rendu vit sur la tâche agent : on le rapatrie sur l'item pour que la
// page n'ait pas à croiser deux sources (et reste lisible après un /clear).
function withResult(p) {
  const task = p.agent_task_id ? findAgentTask(p.agent_task_id) : null
  return {
    ...p,
    pending_question: parseQuestion(p.pending_question),
    user_summary: task?.user_summary || null,
    agent_status: task?.status || null,
    // Repris tel quel par <PageLink> côté front pour retrouver la section modifiée
    // (route de signalement, ou à défaut déduite du rapport d'implémentation).
    context: task?.context || null,
    agent_result: task?.agent_result || null,
    run_state: runState(p, task),
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
  const counters = { exec: 0, question: 0 }
  const waiting = rows
    .filter(p => p.run_state === 'waiting' || p.status === 'queued')
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
  for (const p of waiting) ranks.set(p.id, ++counters[p.lane])
  return rows.map(p => ({ ...p, wait_rank: ranks.get(p.id) || null }))
}

/** Item « vivant » : il occupe la file ou attend une décision de l'utilisateur. */
function isActivePrompt(p) {
  return ['running', 'queued', 'paused'].includes(p.status)
    || (!!p.pending_question?.question && ['done', 'blocked'].includes(p.status))
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
  const prompts = withWaitRank(listPrompts().map(withResult))
    .filter(p => !space || p.space === space)
    .filter(p => !activeOnly || isActivePrompt(p))
  const pause = getQueuePauseState()
  res.json({
    prompts,
    agent_enabled: !!getSettings().enabled,
    // Pause manuelle de la file : rien ne démarre tant qu'elle tient.
    queue_paused: pause.paused,
    queue_paused_at: pause.paused_at,
    queue_paused_reason: pause.reason,
    runner_busy: isRunnerBusy(),
    // Voie lecture seule : les questions tournent en parallèle d'un chantier.
    running_questions: getRunningQuestionCount(),
    max_parallel_questions: getMaxParallelQuestions(),
  })
})

router.post('/prompts', (req, res) => {
  const { title, prompt, mode, preset, status, priority, space } = req.body || {}
  if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: 'prompt requis' })
  if (mode && !['implement', 'question'].includes(mode)) return res.status(400).json({ error: 'mode invalide' })
  // 'auto' = calibre jugé par le modèle à partir de la demande (voir promptPreset.js).
  if (preset && !['auto', 'fast', 'standard', 'deep'].includes(preset)) return res.status(400).json({ error: 'preset invalide' })
  if (status && !['queued', 'paused'].includes(status)) return res.status(400).json({ error: 'status invalide' })
  if (space && !PROMPT_SPACES.includes(space)) return res.status(400).json({ error: 'space invalide' })
  // Reprendre le contexte du précédent était un choix manuel — retiré : un item
  // créé de zéro part toujours avec un contexte neuf. La vraie continuité (réponse,
  // relance fauchée) passe par `follow_up`, décidé automatiquement, pas ici.
  const created = createPrompt({
    title, prompt, mode, preset, status, space,
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
  res.json(paused ? pauseQueue({ reason: reason || null }) : resumeQueue())
})

// ─── Suggestions de l'agent ───────────────────────────────────────────────────

router.get('/suggestions', (req, res) => {
  const status = req.query.status || null
  const kind = req.query.kind || null
  if (status && !['new', 'accepted', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: 'status invalide' })
  }
  if (kind && !SUGGESTION_KINDS.includes(kind)) return res.status(400).json({ error: 'kind invalide' })
  res.json({ suggestions: listSuggestions({ status, kind }) })
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
  if (kind && !SUGGESTION_KINDS.includes(kind)) return res.status(400).json({ error: 'kind invalide' })
  runSuggestionEngines({ kind }).catch(e => console.error('🤖 Suggestions de travaux:', e.message))
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
