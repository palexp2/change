// File de prompts (page /travaux, onglet « Ma file »).
//
// Remplace le va-et-vient manuel « je colle un prompt → j'attends → /clear → le
// suivant » : les prompts vivent en DB, le serveur en pousse UN à la fois dans
// l'ordonnanceur de l'agent (taskRunner), et chaque exécution part d'un contexte
// neuf — sauf les items marqués « même contexte », qui reprennent la session
// Claude du précédent via --resume. À la fin de chaque item, un recap part dans le
// DM Slack perso : c'est ce qui permet de ne plus surveiller le terminal.
//
// Un seul item « running » à la fois, garanti par advanceQueue() : l'agent n'a
// qu'un slot d'exécution (il édite l'arbre de travail réel, sans isolation).
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { broadcastAll } from './realtime.js'
import {
  enqueueAgentTask, findAgentTask, getSettings, presetFor, getMaxParallelQuestions,
  generateUserSummary, isQueuePaused, setQueuePaused,
  updatePendingAgentTask, cancelPendingAgentTask, sendSteeringMessage,
} from './taskRunner.js'
import { heuristicTitle, refineTitle, refineProjectTitle } from './promptTitle.js'
import { classifyPreset, provisionalPreset, PRESET_KEYS } from './promptPreset.js'

const APP_URL = (process.env.APP_URL || 'https://customer.orisha.io').replace(/\/$/, '')

// Items dont l'exécution avec --resume a échoué et qui ont déjà été relancés à
// contexte neuf : évite une boucle si la reprise de session échoue en boucle.
// Volontairement en mémoire — un redémarrage remet le droit à un essai, ce qui
// est sans danger (au pire une exécution de plus, jamais une boucle infinie).
const _resumeRetried = new Set()

// Questions (lecture seule) exécutables en parallèle. Doit rester ≤ la limite du
// runner (getMaxParallelQuestions) : au-delà, les items partiraient côté file mais
// attendraient un slot côté runner, et la page afficherait « en cours » à tort.
const MAX_PARALLEL_QUESTION_PROMPTS = getMaxParallelQuestions()

const SELECT = 'SELECT * FROM work_prompts WHERE deleted_at IS NULL'

// Deux files distinctes sur la même table : celle de l'Espace finance et celle de
// la section Agent. Chaque page ne voit que la sienne ; l'exécuteur est partagé.
export const PROMPT_SPACES = ['finance', 'agent']

export function listPrompts({ space = null } = {}) {
  // Un item qui attend une réponse passe devant la file : c'est le seul état où RIEN
  // n'avance sans l'utilisateur. Il serait sinon rangé dans l'historique (terminé /
  // bloqué), là où on ne regarde plus.
  const where = space ? ` AND p.space=?` : ''
  // La nature de la suggestion d'origine voyage avec l'item : la file la signale
  // d'une pastille (« Claude · Intégration »), il n'y a donc plus de raison
  // d'aller la relire dans l'onglet Suggestions.
  return db.prepare(`
    SELECT p.*, s.kind AS suggestion_kind, s.area AS suggestion_area
    FROM work_prompts p
    LEFT JOIN work_suggestions s ON s.id = p.suggestion_id
    WHERE p.deleted_at IS NULL${where} ORDER BY
    CASE WHEN p.pending_question IS NOT NULL AND p.status NOT IN ('running','cancelled') THEN 0
         ELSE CASE p.status WHEN 'running' THEN 1 WHEN 'queued' THEN 2 WHEN 'paused' THEN 3 ELSE 4 END END,
    p.position, p.created_at`).all(...(space ? [space] : []))
}

export function getPrompt(id) {
  return db.prepare(`${SELECT} AND id=?`).get(id) || null
}

// Les positions vivent PAR FILE : chaque page réordonne la sienne sans bousculer
// l'autre. Entre files, l'ordonnanceur départage par position puis created_at.
function nextPosition(space) {
  const row = db.prepare(`SELECT MAX(position) AS m FROM work_prompts WHERE deleted_at IS NULL AND space=?`).get(space)
  return (row?.m ?? 0) + 1
}

// « Prioritaire » coché à la création : l'item se dépose DEVANT la file. Les dépôts
// « en file » passent ensuite par moveToFront (qui reprend aussi les items déjà
// remis à l'ordonnanceur) ; cette position ne sert seule qu'aux dépôts en pause
// (brouillon, item de test), que moveToFront réveillerait.
//
// Le MIN doit porter sur 'running' en plus de 'queued' : l'item en tête de file
// est justement celui qui tourne. L'oublier fait recalculer un MIN trop haut
// dès qu'une exécution est en cours, et un « Passer en premier » ultérieur
// retombe alors EXACTEMENT sur la position de l'item en cours dès qu'il est
// repris en file (reclaimPending) sans que sa position n'ait bougé — deux items
// à la même position, départagés ensuite par created_at : le plus récent (souvent
// une suggestion tout juste intégrée) perd le tri et semble ne jamais avancer.
function frontPosition(space) {
  const row = db.prepare(`SELECT MIN(position) AS m FROM work_prompts WHERE deleted_at IS NULL AND status IN ('queued','running') AND space=?`).get(space)
  return (row?.m ?? 1) - 1
}

function broadcast() { broadcastAll({ type: 'travaux:prompts:updated' }) }

export function createPrompt({
  title = '', prompt, mode = 'implement', preset = 'deep',
  same_context = 0, created_by = null, suggestion_id = null, status = 'queued',
  priority = false, space = 'finance',
}) {
  const text = String(prompt || '').trim()
  if (!text) throw new Error('prompt requis')
  const id = randomUUID()
  // Titre absent = titre automatique : l'heuristique tout de suite (déterministe),
  // puis un titre modèle quelques secondes plus tard s'il tient la route. Un titre
  // saisi à la main n'est jamais touché.
  const given = String(title || '').trim()
  const label = given || heuristicTitle(text)
  // 'paused' à la création = déposé sans partir tout de suite (brouillon, ou item
  // de test qui ne doit jamais déclencher d'exécution réelle).
  const initial = status === 'paused' ? 'paused' : 'queued'
  const inSpace = PROMPT_SPACES.includes(space) ? space : 'finance'
  const cleanMode = mode === 'question' ? 'question' : 'implement'
  // Préréglage « auto » : même mécanique que le titre — un provisoire sûr tout de
  // suite (l'item est exécutable sans attendre), puis la classification modèle le
  // remplace si elle rend son verdict avant le départ. `preset` reste toujours une
  // clé concrète : c'est elle que lit l'ordonnanceur.
  const autoPreset = preset === 'auto' || !PRESET_KEYS.includes(preset)
  const chosen = autoPreset ? provisionalPreset(cleanMode) : preset
  db.prepare(`
    INSERT INTO work_prompts (id, title, prompt, status, position, same_context, mode, preset, suggestion_id, created_by, title_auto, preset_auto, space)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, label, text, initial, priority ? frontPosition(inSpace) : nextPosition(inSpace), same_context ? 1 : 0,
    cleanMode, chosen, suggestion_id, created_by,
    given ? 0 : 1, autoPreset && preset === 'auto' ? 1 : 0, inSpace)
  broadcast()
  if (!given) scheduleTitleRefine(id, text, label)
  if (preset === 'auto') schedulePresetClassify(id)
  // « Prioritaire » = vraiment le même effet que « Passer en premier » : reprendre
  // aussi les items déjà remis à l'ordonnanceur, pas seulement une position en
  // tête. Jamais sur un dépôt « de côté » (ça le réveillerait).
  if (priority && initial === 'queued') moveToFront(id)
  return getPrompt(id)
}

/**
 * Deuxième étage du titre automatique. Volontairement hors du chemin de réponse :
 * l'ajout à la file reste instantané et la carte se renomme toute seule par la
 * diffusion temps réel. On n'écrase que si le titre est resté celui de
 * l'heuristique — une retouche manuelle entre-temps gagne toujours.
 */
function scheduleTitleRefine(id, text, provisional) {
  refineTitle(text)
    .then(better => {
      if (!better || better === provisional) return
      const row = getPrompt(id)
      if (!row || !row.title_auto || row.title !== provisional) return
      db.prepare(`UPDATE work_prompts SET title=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .run(better, id)
      broadcast()
    })
    .catch(e => console.error('🤖 File de travaux: titre automatique —', e.message))
}

// ─── Titre dynamique du projet ────────────────────────────────────────────────
// Un item de la file EST un projet : sa demande d'origine plus le fil qui la
// précise. Le titre est donc re-déduit du fil à chaque fois que le projet bouge
// (réponse de l'humain, compte-rendu de l'agent, prompt réécrit) — mais seulement
// tant qu'il est automatique. Dès que l'utilisateur écrit son propre titre,
// title_auto passe à 0 et plus rien ne le touche ; vider le champ le rend au mode
// automatique.
const _refining = new Set()

function scheduleProjectTitleRefine(id) {
  if (_refining.has(id)) return              // un seul passage à la fois par projet
  const row = getPrompt(id)
  if (!row || !row.title_auto) return
  _refining.add(id)
  const before = row.title
  refineProjectTitle({ prompt: row.prompt, messages: listMessages(id), current: before })
    .then(better => {
      if (!better || better === before) return
      // Rien n'a bougé entre-temps ? (retouche manuelle, autre passage, suppression)
      const fresh = getPrompt(id)
      if (!fresh || !fresh.title_auto || fresh.title !== before) return
      db.prepare(`UPDATE work_prompts SET title=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .run(better, id)
      broadcast()
    })
    .catch(e => console.error('🤖 File de travaux: titre dynamique —', e.message))
    .finally(() => _refining.delete(id))
}

// ─── Préréglage automatique ───────────────────────────────────────────────────
// « Auto » dans le sélecteur Rapide/Standard/Approfondi : le calibre est jugé par
// le modèle à partir de la demande (voir promptPreset.js), hors du chemin de
// réponse — l'ajout à la file reste instantané, la carte se met à jour toute
// seule. On ne réécrit que si le préréglage est resté automatique entre-temps :
// un choix manuel gagne toujours, comme pour le titre.
const _classifying = new Set()

function schedulePresetClassify(id) {
  if (_classifying.has(id)) return           // un seul passage à la fois par item
  const row = getPrompt(id)
  if (!row || !row.preset_auto) return
  _classifying.add(id)
  classifyPreset({ prompt: row.prompt, mode: row.mode })
    .then(key => {
      if (!key) return
      const fresh = getPrompt(id)
      if (!fresh || !fresh.preset_auto || fresh.preset === key) return
      // L'exécution a réellement commencé ? Trop tard pour ce départ — le modèle
      // est résolu au démarrage. On laisse le provisoire, fidèle à ce qui a tourné.
      if (fresh.status === 'running' && !isPending(fresh)) return
      db.prepare(`UPDATE work_prompts SET preset=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .run(key, id)
      broadcast()
      // Item déjà confié à l'ordonnanceur mais pas parti : le calibre jugé doit
      // être celui qui s'exécutera.
      syncPendingTask(getPrompt(id))
    })
    .catch(e => console.error('🤖 File de travaux: préréglage automatique —', e.message))
    .finally(() => _classifying.delete(id))
}

const EDITABLE = ['title', 'prompt', 'mode', 'preset', 'status', 'position', 'stop_after', 'seen']

// ─── Items « en attente » : remis à l'ordonnanceur, mais pas encore démarrés ───
//
// Un item passe « running » dès qu'il est confié au runner — or celui-ci ne démarre
// qu'une implémentation à la fois. Entre les deux, l'item ne fait RIEN : il attend
// son tour. Le figer (prompt en lecture seule, ordre verrouillé, impossible de le
// mettre de côté) n'avait donc aucune justification, et bloquait la file dès que
// deux items étaient poussés coup sur coup.
//
// Deux traitements, selon ce qu'on touche :
//   • du texte / des réglages → on retouche la tâche en place (pas de va-et-vient) ;
//   • l'ordre, le statut, la suppression → on la reprend à l'ordonnanceur, l'item
//     redevient « en file » et repartira par le chemin normal.
// Les deux refusent dès que l'exécution a réellement commencé.

/** Vrai si l'item est confié au runner mais n'a pas encore démarré. */
function isPending(row) {
  if (!row || row.status !== 'running' || !row.agent_task_id) return false
  const task = findAgentTask(row.agent_task_id)
  return !!task && task.status === 'approved'
}

/**
 * Reprend l'item à l'ordonnanceur et le remet « en file » à sa place.
 * Retourne la ligne à jour, ou `row` inchangée si l'exécution a déjà commencé.
 */
function reclaimPending(row) {
  if (!isPending(row)) return row
  if (!cancelPendingAgentTask(row.agent_task_id)) return row
  db.prepare(`
    UPDATE work_prompts
    SET status='queued', agent_task_id=NULL, started_at=NULL,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?
  `).run(row.id)
  return getPrompt(row.id)
}

/** Répercute une retouche de texte / réglages sur la tâche pas encore démarrée. */
function syncPendingTask(row) {
  if (!isPending(row)) return
  const { model, effort } = presetFor(row.preset)
  updatePendingAgentTask(row.agent_task_id, {
    title: row.title,
    // Tâche « suite de conversation » (réponse relancée) : son brief est le fil,
    // pas le prompt d'origine — le réécrire avec row.prompt effacerait la réponse.
    description: row.follow_up ? buildFollowUpPrompt(row, listMessages(row.id)) : row.prompt,
    mode: row.mode, model, effort,
  })
}

export function updatePrompt(id, patch) {
  let row = getPrompt(id)
  if (!row) return null
  // Mettre de côté / réordonner un item pas encore démarré : on le reprend d'abord,
  // sinon le garde-fou « les états d'exécution appartiennent au runner » l'en empêche.
  if (patch.status !== undefined || patch.position !== undefined) row = reclaimPending(row) || row
  const sets = []
  const vals = []
  // Champ titre vidé = « rends-le automatique » : on repose l'heuristique tout de
  // suite (jamais de carte sans titre) et le fil reprend la main juste après.
  let backToAuto = false
  let frozen = false
  let reclassify = false
  for (const [k, v] of Object.entries(patch)) {
    if (!EDITABLE.includes(k)) continue
    // Le statut n'est pilotable à la main que pour mettre de côté / remettre en
    // file : les états d'exécution appartiennent au runner.
    if (k === 'status' && !['queued', 'paused', 'cancelled'].includes(v)) continue
    if (k === 'status' && row.status === 'running') continue
    // Préréglage : « auto » rend le choix au modèle (le provisoire tient la carte
    // exécutable en attendant le verdict) ; une clé concrète fige le choix.
    if (k === 'preset') {
      if (v !== 'auto' && !PRESET_KEYS.includes(v)) continue
      reclassify = v === 'auto'
      sets.push('preset=?', 'preset_auto=?')
      vals.push(v === 'auto' ? provisionalPreset(patch.mode ?? row.mode) : v, v === 'auto' ? 1 : 0)
      continue
    }
    if (k === 'title') {
      const given = String(v ?? '').trim()
      backToAuto = !given
      frozen = !!given
      sets.push('title=?', 'title_auto=?')
      vals.push(given || heuristicTitle(patch.prompt ?? row.prompt), given ? 0 : 1)
      continue
    }
    // « Lu » façon boîte mail : posé côté serveur (jamais la valeur du client) pour
    // que l'horodatage reste cohérent avec les autres colonnes datetime de la table.
    if (k === 'seen') {
      sets.push('seen_at=?')
      vals.push(v ? new Date().toISOString() : null)
      continue
    }
    sets.push(`${k}=?`)
    vals.push(['same_context', 'stop_after'].includes(k) ? (v ? 1 : 0) : v)
  }
  if (!sets.length) return row
  db.prepare(`UPDATE work_prompts SET ${sets.join(', ')}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
    .run(...vals, id)
  broadcast()
  // Le prompt réécrit change la nature du projet → titre re-déduit, sauf s'il vient
  // d'être figé à la main dans le même PATCH.
  if (backToAuto || (!frozen && patch.prompt !== undefined)) scheduleProjectTitleRefine(id)
  const updated = getPrompt(id)
  // Préréglage remis en auto, ou prompt réécrit alors qu'il l'était déjà : le
  // calibre est re-jugé — la demande n'est peut-être plus du même gabarit.
  if (reclassify || (updated?.preset_auto && patch.prompt !== undefined)) schedulePresetClassify(id)
  // Item encore en attente : ce qu'on vient de réécrire doit être ce qui partira.
  syncPendingTask(updated)
  return updated
}

export function deletePrompt(id) {
  const row = getPrompt(id)
  if (!row) return false
  // Retirer un item pas encore démarré doit aussi le retirer de l'ordonnanceur,
  // sinon il partirait quand même une fois le poste libre.
  const wasPending = isPending(row)
  if (wasPending) reclaimPending(row)
  db.prepare(`UPDATE work_prompts SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(id)
  // Item issu d'une suggestion : la retirer de la file la rend à l'onglet
  // « Suggestions » plutôt que de la perdre — on peut la rejeter pour de bon
  // depuis là, ou la remettre en file plus tard. (SQL direct : importer
  // workSuggestions ici créerait un cycle, ce module est déjà son fournisseur.)
  if (row.suggestion_id) {
    db.prepare(`
      UPDATE work_suggestions SET status='new', work_prompt_id=NULL,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND status='accepted'
    `).run(row.suggestion_id)
    broadcastAll({ type: 'travaux:suggestions:updated' })
  }
  broadcast()
  // Le poste qu'il occupait est libre : au suivant.
  if (wasPending) advanceQueue()
  return true
}

/** Réordonne la file : le tableau d'ids donne l'ordre voulu, les absents restent après. */
export function reorderPrompts(ids) {
  // Les items en attente reviennent en file avant d'être renumérotés : leur ordre de
  // départ redevient celui de la page (l'ordonnanceur, lui, sert premier arrivé).
  let reclaimed = false
  for (const id of ids) {
    const row = getPrompt(id)
    if (!isPending(row)) continue
    reclaimPending(row)
    reclaimed = true
  }
  const run = db.transaction(() => {
    ids.forEach((id, i) => {
      db.prepare(`UPDATE work_prompts SET position=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND deleted_at IS NULL`).run(i + 1, id)
    })
  })
  run()
  broadcast()
  // Rendre à l'ordonnanceur ce qu'on vient de lui reprendre, dans le nouvel ordre.
  // Uniquement dans ce cas : un simple changement de priorité ne doit RIEN lancer.
  if (reclaimed) advanceQueue()
  return listPrompts()
}

/**
 * Remet un item en tête de file (bouton « Passer en premier »).
 *
 * « Premier » veut dire LE PROCHAIN À PARTIR, pas seulement premier des items
 * encore en file : les items déjà remis à l'ordonnanceur mais pas démarrés lui
 * sont repris — sans ça ils partaient quand même avant, et « premier » mentait.
 * Ils repartiront par le chemin normal, derrière celui-ci. Puis l'item est remis
 * tout de suite à l'ordonnanceur (qui sert premier arrivé) : son rang 1 tient
 * même face à l'autre file, l'exécuteur étant partagé. File en pause ou agent
 * désactivé : simple repositionnement, rien n'est confié au runner.
 */
export function moveToFront(id) {
  let target = getPrompt(id)
  if (!target) return null
  target = reclaimPending(target)
  if (!['queued', 'paused'].includes(target.status)) return target
  // Seule SA voie le concurrence : les questions (parallèles) ne disputent pas le
  // poste d'implémentation, et réciproquement.
  const laneWhere = (target.mode === 'question' && !target.same_context)
    ? `mode='question' AND same_context=0`
    : `(mode!='question' OR same_context=1)`
  for (const row of db.prepare(`${SELECT} AND status='running' AND id!=? AND ${laneWhere}`).all(id)) {
    reclaimPending(row) // no-op si l'exécution a réellement commencé
  }
  db.prepare(`UPDATE work_prompts SET position=?, status='queued', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
    .run(frontPosition(target.space), id)
  broadcast()
  if (getSettings().enabled && !isQueuePaused()) return startPrompt(getPrompt(id)).prompt
  return getPrompt(id)
}

// ─── Ordonnancement ───────────────────────────────────────────────────────────

/**
 * État de la pause manuelle de la file, tel que rendu à la page.
 * `reason` porte le « pourquoi » quand la pause a été posée automatiquement par un
 * item marqué « arrêter après celle-ci ».
 */
export function getQueuePauseState() {
  const s = getSettings()
  return {
    paused: !!s.queuePaused,
    paused_at: s.queuePausedAt || null,
    reason: s.queuePausedReason || null,
  }
}

/**
 * Pause / reprise de la file. Aucune exécution n'est tuée : la pause empêche
 * seulement les DÉPARTS, donc reprendre relance simplement le prochain item — rien
 * n'a été refait, rien n'a été perdu.
 */
export function pauseQueue({ reason = null } = {}) {
  const state = setQueuePaused(true, { reason })
  broadcast()
  return { paused: state.paused, paused_at: state.pausedAt, reason: state.reason }
}

export function resumeQueue() {
  setQueuePaused(false)
  broadcast()
  const out = advanceQueue()
  return { ...getQueuePauseState(), started: out.started ? out.started.prompt : null, startedCount: out.startedCount }
}

/**
 * Démarre le prochain item si rien ne tourne. Retourne { started, reason } :
 * `reason` explique une non-exécution ('busy' | 'agent-disabled' | 'queue-paused' |
 * 'empty') pour que la page puisse le dire clairement au lieu de laisser croire à un
 * blocage.
 */
export function advanceQueue() {
  // 1. Réconciliation : un item resté « running » alors que sa tâche a disparu ou
  // s'est terminée (redémarrage serveur pendant l'exécution) ne doit pas geler la
  // file pour toujours. Vaut pour les deux voies.
  for (const running of db.prepare(`${SELECT} AND status='running' ORDER BY started_at`).all()) {
    const task = running.agent_task_id ? findAgentTask(running.agent_task_id) : null
    if (!task) {
      finishPrompt(running.id, { status: 'blocked', agent_result: '(tâche introuvable — exécution perdue)', user_summary: null, session_id: null })
    } else if (['done', 'blocked', 'cancelled'].includes(task.status)) {
      finishPrompt(running.id, task)
      // Clôture par réconciliation : onAgentTaskFinalized n'a pas tourné (redémarrage
      // en pleine exécution) → le fil n'a aucune réponse. On la verse a posteriori.
      setImmediate(() => { repairAgentReplies(running.id).catch(() => {}) })
    }
  }

  // 2. Pause posée à la main (ou par un item « arrêter après celle-ci ») : la
  // réconciliation ci-dessus a quand même tourné — un item fauché par un redémarrage
  // ne doit pas rester « en cours » pour l'éternité juste parce que la file dort.
  if (isQueuePaused()) return { started: null, startedCount: 0, reason: 'queue-paused' }

  if (!getSettings().enabled) return { started: null, startedCount: 0, reason: 'agent-disabled' }

  const runningRows = db.prepare(`${SELECT} AND status='running'`).all()
  const runningQuestions = runningRows.filter(r => r.mode === 'question').length
  const implRunning = runningRows.some(r => r.mode !== 'question')

  const started = []

  // 2. Questions : lecture seule → plusieurs à la fois, même pendant un chantier.
  // Un item marqué « même contexte » est volontairement exclu de la voie parallèle :
  // il doit reprendre la session de son prédécesseur, donc attendre son tour.
  const slots = MAX_PARALLEL_QUESTION_PROMPTS - runningQuestions
  if (slots > 0) {
    const questions = db.prepare(`${SELECT} AND status='queued' AND mode='question' AND same_context=0 ORDER BY position, created_at LIMIT ?`).all(slots)
    for (const q of questions) started.push(startPrompt(q))
  }

  // 3. Implémentation : une seule à la fois (elle édite l'arbre de travail réel).
  // Les positions vivent PAR FILE (finance / agent) : comparer les positions brutes
  // entre files n'aurait aucun sens. On prend donc le prochain candidat de CHAQUE
  // file selon son propre ordre, puis premier arrivé premier servi entre les files.
  if (!implRunning) {
    const next = PROMPT_SPACES
      .map(sp => db.prepare(`${SELECT} AND status IN ('queued','running') AND space=? AND (mode!='question' OR same_context=1) ORDER BY position, created_at LIMIT 1`).get(sp))
      .filter(Boolean)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0]
    if (next) started.push(startPrompt(next))
  }

  if (!started.length) {
    const anyQueued = db.prepare(`SELECT 1 FROM work_prompts WHERE deleted_at IS NULL AND status='queued' LIMIT 1`).get()
    return { started: null, startedCount: 0, reason: anyQueued ? 'busy' : 'empty' }
  }
  return { started: started[0], startedCount: started.length, reason: null }
}

/**
 * Session Claude à reprendre pour un item « même contexte » : celle de l'item qui
 * le précède dans la file (par position). On ne prend PAS « le dernier terminé » :
 * avec la voie parallèle, une question terminée entre-temps volerait le contexte.
 */
function sessionOfPrevious(row) {
  // Scopé à la même file : un item « même contexte » de la file Agent ne doit
  // jamais reprendre la session d'un item de la file finance (et inversement).
  const prev = db.prepare(`
    SELECT session_id FROM work_prompts
    WHERE deleted_at IS NULL AND session_id IS NOT NULL AND space = ?
      AND (position < ? OR (position = ? AND created_at < ?))
    ORDER BY position DESC, created_at DESC LIMIT 1
  `).get(row.space, row.position, row.position, row.created_at)
  return prev?.session_id || null
}

function startPrompt(row, { forceFresh = false } = {}) {
  const { model, effort } = presetFor(row.preset)
  // Item marqué follow_up : ce départ est la SUITE d'une conversation (réponse de
  // l'utilisateur remise en fin de file, ou relance fauchée avant d'avoir travaillé).
  // Le brief est le fil complet — autoportant — et la session de l'item lui-même
  // est reprise quand elle existe encore.
  const followUp = !!row.follow_up
  const resume = forceFresh ? null
    : followUp ? (row.session_id || null)
      : row.same_context ? sessionOfPrevious(row) : null
  const task = enqueueAgentTask({
    title: row.title,
    description: followUp ? buildFollowUpPrompt(row, listMessages(row.id)) : row.prompt,
    kind: 'queue',
    mode: row.mode,
    model, effort,
    author: followUp ? 'File de travaux (suite)' : 'File de travaux',
    work_prompt_id: row.id,
    resume_session_id: resume,
  })
  db.prepare(`
    UPDATE work_prompts
    SET status='running', agent_task_id=?, started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?
  `).run(task.id, row.id)
  broadcast()
  return { prompt: getPrompt(row.id), task }
}

function finishPrompt(id, task) {
  const status = task.status === 'done' ? 'done' : 'blocked'
  // La question éventuelle est posée sur l'item (pas sur la tâche agent, qui vit dans
  // agent-tasks.json et disparaît de la vue) : c'est la carte qui doit la montrer et
  // récolter le clic. Écrasée à chaque fin d'exécution — une exécution qui n'en pose
  // plus efface celle d'avant.
  const q = task.pending_question && task.pending_question.question
    ? JSON.stringify(task.pending_question)
    : null
  // follow_up est consommé : l'exécution qui vient de finir a lu le fil. Une
  // prochaine relance ne repartira « en suite » que si une nouvelle réponse le repose.
  // seen_at repart à NULL : une nouvelle fin d'exécution est une nouvelle réponse à
  // lire, même si la précédente avait déjà été ouverte.
  db.prepare(`
    UPDATE work_prompts
    SET status=?, session_id=COALESCE(?, session_id), pending_question=?, follow_up=0,
        seen_at=NULL,
        completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?
  `).run(status, task.session_id || null, q, id)
  broadcast()
  return getPrompt(id)
}

// ─── Fil de discussion par tâche ──────────────────────────────────────────────
// Chaque item de la file porte SA conversation. Elle survit aux exécutions
// successives et — surtout — au fait que la session Claude puisse avoir disparu :
// une relance réinjecte le fil en clair dans le prompt (voir buildFollowUpPrompt),
// donc la continuité ne dépend jamais de --resume.

export function listMessages(promptId) {
  return db.prepare(`
    SELECT m.*, u.name AS author_name
    FROM work_prompt_messages m
    LEFT JOIN users u ON u.id = m.author
    WHERE m.prompt_id=? ORDER BY m.created_at
  `).all(promptId)
}

function addMessage(promptId, { role, text, agentTaskId = null, author = null }) {
  const clean = String(text || '').trim()
  if (!clean) return null
  const id = randomUUID()
  db.prepare(`
    INSERT INTO work_prompt_messages (id, prompt_id, role, text, agent_task_id, author)
    VALUES (?,?,?,?,?,?)
  `).run(id, promptId, role, clean, agentTaskId, author)
  broadcast()
  return db.prepare('SELECT * FROM work_prompt_messages WHERE id=?').get(id)
}

/**
 * Prompt d'une relance : la demande d'origine, ce que l'agent a répondu jusqu'ici,
 * et le fil complet. Volontairement autoportant — même si --resume échoue ou que la
 * session a été purgée, la relance sait de quoi on parle.
 */
export function buildFollowUpPrompt(row, messages) {
  const thread = messages
    .map(m => `${m.role === 'user' ? 'Humain' : 'Toi'} : ${m.text}`)
    .join('\n\n')
  return [
    'Suite d\'un échange sur une tâche de la file de travaux. Le contexte ci-dessous est ',
    'peut-être déjà dans ta session ; s\'il ne l\'est pas, il suffit à reprendre le travail.\n\n',
    `=== DEMANDE INITIALE ===\n${row.prompt}\n\n`,
    `=== ÉCHANGE ===\n${thread}\n\n`,
    '=== À FAIRE MAINTENANT ===\n',
    'Réponds au DERNIER message de l\'humain et poursuis la tâche en conséquence. ',
    'Si une information te manque encore, dis précisément laquelle plutôt que de deviner.',
  ].join('')
}

/**
 * Réponse de l'humain dans le fil → relance de la tâche avec ce complément. La
 * session précédente est reprise quand elle existe (contexte intact) ; sinon le
 * fil réinjecté fait office de mémoire.
 * `placement` décide du moment de la relance :
 *   • 'front' (défaut) — tout de suite : l'item est remis à l'ordonnanceur et
 *     repart avant le reste de la file ;
 *   • 'back' — la réponse est enregistrée mais l'item retourne EN FIN de file :
 *     il repartira quand son tour reviendra, avec le fil complet en contexte.
 * Refusée pendant une exécution : le message serait perdu (l'exécution en cours ne
 * le lirait pas). L'appelant reçoit { error: 'running' } pour le dire clairement.
 */
export function replyToPrompt(id, { text, userId = null, placement = 'front' }) {
  const row = getPrompt(id)
  if (!row) return null
  if (row.status === 'running') return { error: 'running' }
  const clean = String(text || '').trim()
  if (!clean) return { error: 'empty' }

  addMessage(id, { role: 'user', text: clean, author: userId })
  const out = placement === 'back' ? requeueWithThread(row) : relaunchWithThread(row)
  // Le projet vient de bouger : c'est le moment le plus fort pour renommer, car la
  // réponse de l'humain donne le cap réel (élargissement, changement de direction).
  scheduleProjectTitleRefine(id)
  return out
}

/**
 * Relance un item avec son fil complet en contexte (le dernier message de l'humain
 * y est déjà). Chemin partagé par la réponse classique (replyToPrompt) et la
 * rattrapage d'un message de steering arrivé trop tard pour être lu en direct.
 */
function relaunchWithThread(row) {
  const messages = listMessages(row.id)
  const { model, effort } = presetFor(row.preset)
  const task = enqueueAgentTask({
    title: row.title,
    description: buildFollowUpPrompt(row, messages),
    kind: 'queue',
    mode: row.mode,
    model, effort,
    author: 'File de travaux (suite)',
    work_prompt_id: row.id,
    resume_session_id: row.session_id || null,
  })
  // follow_up=1 : si cette exécution est fauchée avant d'avoir travaillé (quota,
  // reprise de session impossible), le redémarrage saura qu'il doit repartir du
  // FIL, pas du prompt d'origine. Consommé à la fin de l'exécution (finishPrompt).
  db.prepare(`
    UPDATE work_prompts
    SET status='running', agent_task_id=?, started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        completed_at=NULL, pending_question=NULL, follow_up=1,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?
  `).run(task.id, row.id)
  broadcast()
  return { prompt: getPrompt(row.id), task }
}

/**
 * Réponse « à la fin de la file » : le fil est complété mais l'item n'est PAS
 * relancé tout de suite — il retourne en file, derrière les items déjà en attente,
 * et repartira par le chemin normal (startPrompt lit follow_up et reconstruit le
 * brief depuis le fil, en reprenant la session Claude si elle existe encore).
 */
function requeueWithThread(row) {
  db.prepare(`
    UPDATE work_prompts
    SET status='queued', position=?, follow_up=1,
        agent_task_id=NULL, started_at=NULL, completed_at=NULL, pending_question=NULL,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?
  `).run(nextPosition(row.space), row.id)
  broadcast()
  // File vide et poste libre → l'item repart tout de suite ; sinon il attend son tour.
  advanceQueue()
  return { prompt: getPrompt(row.id), queued: true }
}

/**
 * Message envoyé PENDANT que la tâche tourne (steering, comme dans Claude Code).
 * Deux livraisons selon l'état réel de la tâche agent :
 *   • 'in_progress' → déposé dans l'inbox de l'exécution, le hook le glisse à
 *     Claude après le prochain outil ('live') ;
 *   • 'approved' (remise à l'ordonnanceur, pas démarrée) → ajouté au brief de la
 *     tâche, il partira avec elle ('queued').
 * Dans les deux cas le message entre au fil — il fait partie de la conversation.
 * Retour { error: 'not-running' } si la tâche a en fait rendu la main : c'est
 * replyToPrompt (relance) qui s'applique alors.
 */
export function steerPrompt(id, { text, userId = null }) {
  const row = getPrompt(id)
  if (!row) return null
  const clean = String(text || '').trim()
  if (!clean) return { error: 'empty' }
  if (row.status !== 'running' || !row.agent_task_id) return { error: 'not-running' }
  const task = findAgentTask(row.agent_task_id)
  if (!task) return { error: 'not-running' }

  // Livraison d'abord, trace au fil ensuite : si la tâche vient de rendre la main
  // entre le chargement de la page et l'envoi, rien n'est écrit et l'appelant
  // peut proposer « Répondre et relancer » à la place.
  if (task.status === 'in_progress' && sendSteeringMessage(row.agent_task_id, clean)) {
    addMessage(id, { role: 'user', text: clean, author: userId, agentTaskId: row.agent_task_id })
    return { prompt: getPrompt(id), delivered: 'live' }
  }
  if (task.status === 'approved') {
    const marked = `${task.description}\n\n=== MESSAGE DE L'UTILISATEUR (ajouté pendant l'attente, à prendre en compte) ===\n${clean}`
    if (updatePendingAgentTask(row.agent_task_id, { description: marked })) {
      addMessage(id, { role: 'user', text: clean, author: userId, agentTaskId: row.agent_task_id })
      return { prompt: getPrompt(id), delivered: 'queued' }
    }
    // La tâche a démarré entre les deux lectures : on retente la voie directe.
    if (sendSteeringMessage(row.agent_task_id, clean)) {
      addMessage(id, { role: 'user', text: clean, author: userId, agentTaskId: row.agent_task_id })
      return { prompt: getPrompt(id), delivered: 'live' }
    }
  }
  return { error: 'not-running' }
}

/**
 * Texte versé dans le fil (et repris dans le recap Slack) à la fin d'une exécution.
 *
 * Le compte-rendu vulgarisé arrive par deux chemins : la section « RÉSUMÉ UTILISATEUR »
 * du rapport (immédiate), ou la génération de secours quand le modèle l'a oubliée
 * (quelques secondes plus tard, en subprocess). Ce deuxième chemin étant asynchrone,
 * lire task.user_summary à chaud figeait un « (terminé sans compte-rendu) » dans le
 * fil alors que le vrai compte-rendu atterrissait juste après sur la tâche. On l'attend
 * donc ici, et à défaut on rend le rapport technique — jamais un placeholder nu.
 */
export async function resolveReply(task) {
  let summary = (task.user_summary || '').trim()
  if (!summary) {
    try { await generateUserSummary(task.id) } catch { /* le repli ci-dessous prend la main */ }
    summary = (findAgentTask(task.id)?.user_summary || '').trim()
  }
  if (summary) return summary

  // Aucun compte-rendu possible (rapport vide, ou génération de secours en échec) :
  // on rend ce qu'on a plutôt que rien — le rapport brut vaut mieux qu'un silence.
  const report = (task.agent_result || '').trim()
  const clean = report && report !== '(terminé sans rapport)' ? report : ''
  if (clean) {
    const excerpt = clean.length > 2500 ? `…${clean.slice(-2500)}` : clean
    const head = task.status === 'done'
      ? 'Compte-rendu vulgarisé indisponible — voici le rapport technique brut :'
      : 'Exécution interrompue, sans compte-rendu — voici le rapport technique brut :'
    return `${head}\n\n${excerpt}`
  }
  return task.status === 'done'
    ? 'Terminé, mais l\'agent n\'a produit aucun rapport (exécution sans sortie exploitable). À relancer si le résultat n\'est pas visible dans l\'app.'
    : 'Exécution interrompue avant toute sortie (délai dépassé, processus tué ou redémarrage). À relancer.'
}

/**
 * Appelé par taskRunner quand une exécution se termine. Quatre responsabilités :
 * verser la réponse dans le fil, clore l'item, envoyer le recap Slack, lancer le suivant.
 */
export async function onAgentTaskFinalized(task) {
  if (!task || task.kind !== 'queue' || !task.work_prompt_id) return
  const row = getPrompt(task.work_prompt_id)
  if (!row) return

  // Reprise de session impossible (session purgée) : le run meurt sans rien
  // produire. On relance UNE fois à contexte neuf plutôt que de marquer bloqué.
  const producedNothing = !(task.agent_result || '').trim() && !(task.user_summary || '').trim()
  if (task.resume_session_id && task.status !== 'done' && producedNothing && !_resumeRetried.has(row.id)) {
    _resumeRetried.add(row.id)
    console.log(`🤖 File de travaux: reprise de session impossible pour « ${row.title} » — relance à contexte neuf`)
    startPrompt(row, { forceFresh: true })
    return
  }

  // Le compte-rendu entre dans le fil : c'est lui qui reste lisible (et réinjectable)
  // quand la session Claude a disparu. Le rapport technique reste sur la tâche agent.
  let reply = await resolveReply(task)
  // La question entre AUSSI dans le fil : la colonne pending_question est vidée dès
  // qu'on répond, et sans cette trace le fil montrerait une réponse sans sa question.
  // La carte n'affiche donc que les boutons de choix, pas une seconde fois le texte.
  if (task.pending_question?.question) reply += `\n\n❓ ${task.pending_question.question}`
  addMessage(row.id, { role: 'agent', text: reply, agentTaskId: task.id })

  const finished = finishPrompt(row.id, task)
  // Le compte-rendu vient d'entrer dans le fil : sur un projet qui a déjà tourné
  // plusieurs fois, il précise souvent mieux la nature du travail que la demande
  // d'origine. En arrière-plan — le recap Slack qui suit peut donc encore porter le
  // titre précédent, la carte, elle, se renomme dès que le modèle répond.
  if (row.title_auto && listMessages(row.id).length > 1) scheduleProjectTitleRefine(row.id)

  // « Arrête après celle-ci » : on pose la pause AVANT le recap et l'advanceQueue,
  // sinon l'item suivant partirait dans le même tick. Le drapeau est consommé (remis
  // à 0) pour qu'une relance de cet item plus tard ne remette pas la file en pause
  // sans qu'on l'ait redemandé.
  const stopHere = !!finished.stop_after
  if (stopHere) {
    db.prepare(`UPDATE work_prompts SET stop_after=0, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(row.id)
    pauseQueue({ reason: `Arrêt demandé après « ${finished.title} »` })
    console.log(`🤖 File de travaux: pause demandée après « ${finished.title} » — la file reprendra sur commande`)
  }

  // Message de steering arrivé dans les dernières secondes de l'exécution : il est
  // au fil, mais Claude ne l'a jamais lu. On relance tout de suite avec le fil en
  // contexte — comme si l'utilisateur avait répondu après coup. Pas de recap ici :
  // le travail n'est pas fini, il viendra à la fin de la relance. Une pause
  // demandée (« arrête après celle-ci ») garde le dernier mot : pas de relance.
  if (!stopHere && String(task.missed_user_message || '').trim()) {
    console.log(`🤖 File de travaux: message utilisateur non lu par l'exécution — relance de « ${finished.title} »`)
    relaunchWithThread(finished)
    return
  }

  try { await sendRecap(finished, task, { stopped: stopHere }) } catch (e) { console.error('🤖 File de travaux: recap Slack en échec —', e.message) }
  advanceQueue()
}

/**
 * Exécution avortée faute de quota Claude (« session limit »). L'item n'a pas échoué :
 * il n'a pas travaillé. Il retourne donc en file à sa place, sans réponse dans le fil
 * ni recap — le runner rallume tout à la réinitialisation. Un seul avis Slack par
 * fenêtre de quota, pour ne pas transformer une pause en pluie de notifications.
 */
export function onAgentTaskDeferred(task, { label = '' } = {}) {
  if (!task || task.kind !== 'queue' || !task.work_prompt_id) return
  const row = getPrompt(task.work_prompt_id)
  if (!row) return
  db.prepare(`
    UPDATE work_prompts
    SET status='queued', started_at=NULL, agent_task_id=NULL, completed_at=NULL,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?
  `).run(row.id)
  broadcast()
  notifyLimitOnce(label)
}

let _limitNotified = ''

async function notifyLimitOnce(label) {
  if (_limitNotified === label) return
  _limitNotified = label
  const url = process.env.SLACK_WEBHOOK_PERSO
  if (!url) return
  // Même règle que le recap : une ligne, rien à faire de plus que la lire.
  const text = `:hourglass_flowing_sand: *File de travaux en pause* — limite de session Claude atteinte, ` +
    `reprise à ${label || 'la réinitialisation du quota'}.`
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
  } catch (e) { console.error('🤖 File de travaux: avis de quota non envoyé —', e.message) }
}

// ─── Réparation des réponses manquantes ───────────────────────────────────────
// Deux dégâts possibles dans un fil : un placeholder figé (compte-rendu de secours
// arrivé après l'écriture du message — le bug d'origine) ou aucune réponse du tout
// (exécution close par réconciliation après un redémarrage). Les deux se réparent
// depuis la tâche agent, qui garde rapport et compte-rendu. Idempotent.
const PLACEHOLDERS = ['(terminé sans compte-rendu)', '(bloqué sans explication)']

// Sérialisé : plusieurs réconciliations peuvent la déclencher dans le même tick, et
// deux passages concurrents inséreraient deux fois la même réponse (chacun lisant le
// fil avant l'écriture de l'autre).
let _repairing = null

export function repairAgentReplies(promptId = null) {
  if (_repairing) return _repairing.then(() => runRepair(promptId))
  _repairing = runRepair(promptId).finally(() => { _repairing = null })
  return _repairing
}

async function runRepair(promptId = null) {
  let fixed = 0

  // 0. Doublons exacts (même tâche, même texte) : une réponse versée deux fois n'apporte
  // rien et brouille le fil. On garde la première.
  const dupes = db.prepare(`
    DELETE FROM work_prompt_messages WHERE id IN (
      SELECT m.id FROM work_prompt_messages m
      WHERE m.role='agent' AND m.agent_task_id IS NOT NULL AND m.created_at > (
        SELECT MIN(o.created_at) FROM work_prompt_messages o
        WHERE o.prompt_id=m.prompt_id AND o.agent_task_id=m.agent_task_id AND o.text=m.text
      )
    )
  `).run()
  if (dupes.changes) fixed += dupes.changes

  // 1. Placeholders figés — on part des MESSAGES (une même carte peut avoir plusieurs
  // exécutions, donc plusieurs réponses ; seule la dernière est pointée par la carte).
  const stuck = db.prepare(`
    SELECT m.id, m.agent_task_id FROM work_prompt_messages m
    WHERE m.role='agent' AND m.agent_task_id IS NOT NULL
      AND m.text IN (${PLACEHOLDERS.map(() => '?').join(',')})
      ${promptId ? 'AND m.prompt_id=?' : ''}
  `).all(...PLACEHOLDERS, ...(promptId ? [promptId] : []))
  for (const msg of stuck) {
    const task = findAgentTask(msg.agent_task_id)
    if (!task) continue
    const text = await resolveReply(task)
    if (!text || PLACEHOLDERS.includes(text)) continue
    db.prepare(`UPDATE work_prompt_messages SET text=? WHERE id=?`).run(text, msg.id)
    fixed++
  }

  // 2. Réponse absente : exécution close par réconciliation (redémarrage) — le fil n'a
  // rien reçu pour cette tâche.
  const rows = db.prepare(`${SELECT} AND status IN ('done','blocked') AND agent_task_id IS NOT NULL${promptId ? ' AND id=?' : ''}`)
    .all(...(promptId ? [promptId] : []))
  for (const row of rows) {
    const has = () => db.prepare(`SELECT 1 FROM work_prompt_messages WHERE prompt_id=? AND role='agent' AND agent_task_id=? LIMIT 1`)
      .get(row.id, row.agent_task_id)
    if (has()) continue
    const task = findAgentTask(row.agent_task_id)
    if (!task) continue
    const text = await resolveReply(task)
    if (!text || has()) continue        // re-vérifié après l'attente : anti-doublon
    addMessage(row.id, { role: 'agent', text, agentTaskId: row.agent_task_id })
    fixed++
  }

  if (fixed) {
    broadcast()
    console.log(`🤖 File de travaux: ${fixed} compte-rendu(s) de fil réparé(s)`)
  }
  return fixed
}

// ─── Recap Slack ──────────────────────────────────────────────────────────────

// UNE SEULE LIGNE, volontairement : le DM sert à savoir qu'une tâche est finie (ou
// qu'une question attend), pas à raconter le travail. Le compte-rendu vit dans le
// fil de la carte, dans l'ERP — c'est là qu'on le lit. Une version qui recopiait le
// compte-rendu complet a été essayée puis retirée (même raison que le hook
// ~/.claude/slack-notify.sh) : ne pas la réintroduire.
export function buildRecapMessage(prompt, task, { stopped = false } = {}) {
  const ok = prompt.status === 'done'
  // Une question en attente change la nature du message : ce n'est plus une fin à
  // constater, c'est une action à faire pour que le travail reprenne.
  const asking = !!task?.pending_question?.question
  const head = asking
    ? `:raised_hand: *Question à répondre* — ${prompt.title}`
    : `${ok ? ':white_check_mark:' : ':warning:'} *${ok ? 'Tâche terminée' : 'Tâche bloquée'}* — ${prompt.title}`
  const cta = asking ? 'Répondre' : 'Ouvrir'
  // Pause demandée sur cet item : sans ce mot, le silence de la file ressemble à
  // une panne. C'est le seul complément admis sur la ligne.
  const pause = stopped ? ' · file en pause' : ''
  return `${head} · <${APP_URL}/erp/travaux?onglet=file|${cta}>${pause}`
}

async function sendRecap(prompt, task, { stopped = false } = {}) {
  const url = process.env.SLACK_WEBHOOK_PERSO
  if (!url) {
    console.warn('🤖 File de travaux: SLACK_WEBHOOK_PERSO absent — recap non envoyé')
    return
  }
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: buildRecapMessage(prompt, task, { stopped }) }),
  })
  if (!resp.ok) throw new Error(`Slack HTTP ${resp.status}`)
}

// ─── Démarrage ────────────────────────────────────────────────────────────────
// Au boot, on réconcilie et on relance la file (un item « running » fauché par un
// redémarrage est clos par advanceQueue, puis le suivant démarre).
export function initPromptQueue() {
  const timer = setTimeout(() => {
    try { advanceQueue() } catch (e) { console.error('🤖 File de travaux: démarrage —', e.message) }
    repairAgentReplies().catch(e => console.error('🤖 File de travaux: réparation des compte-rendus —', e.message))
  }, 20_000)
  timer.unref?.()
}
