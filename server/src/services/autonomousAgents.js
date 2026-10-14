// Agents autonomes (page /travaux, onglet « Agents »).
//
// Un agent = une mission écrite en clair (« inspecte telle partie du code, corrige
// ce qui cloche ») et des heures de réveil. À chaque réveil, il dépose UN item dans
// la file de travaux : c'est la file qui l'exécute, avec ses garde-fous habituels
// (un poste à la fois, pause, quota). L'historique des passages est donc la file
// elle-même — chaque item porte `autonomous_agent_id`.
//
// Pas de rattrapage en rafale : seul le DERNIER créneau échu compte, et seulement
// s'il date de moins de CATCH_UP_MS (un serveur arrêté toute la nuit ne relance pas
// trois passages au réveil). Un passage encore en file ou en attente de réponse
// bloque le suivant : un agent ne s'empile jamais sur lui-même.
import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { broadcastAll } from './realtime.js'
import { TZ, localDay, naiveLocalToUtcIso } from '../utils/datetime.js'
import { createPrompt, advanceQueue } from './promptQueue.js'

const CATCH_UP_MS = 3 * 3600_000
const DEFAULT_RUNS_PER_DAY = 2

function broadcast() { broadcastAll({ type: 'travaux:agents:updated' }) }

export function parseHours(value) {
  let arr = value
  if (typeof value === 'string') { try { arr = JSON.parse(value) } catch { arr = [] } }
  if (!Array.isArray(arr)) return []
  return [...new Set(arr.map(Number).filter(h => Number.isInteger(h) && h >= 0 && h <= 23))].sort((a, b) => a - b)
}

function hydrate(row) {
  if (!row) return null
  return { ...row, run_hours: parseHours(row.run_hours), enabled: !!row.enabled }
}

const SELECT = `
  SELECT a.*,
    p.status AS last_prompt_status, p.title AS last_prompt_title,
    (SELECT COUNT(*) FROM work_prompts w WHERE w.autonomous_agent_id = a.id AND w.deleted_at IS NULL) AS run_count
  FROM autonomous_agents a
  LEFT JOIN work_prompts p ON p.id = a.last_prompt_id
  WHERE a.deleted_at IS NULL`

export function listAgents() {
  return db.prepare(`${SELECT} ORDER BY a.created_at`).all().map(hydrate)
}

export function getAgent(id) {
  return hydrate(db.prepare(`${SELECT} AND a.id=?`).get(id))
}

export function createAgent({ name = '', instructions = '', run_hours = null, runs_per_day = null, created_by = null } = {}) {
  const id = newRecordId()
  const given = runs_per_day == null ? parseHours(run_hours) : []
  const hours = given.length ? given : planHours(runs_per_day ?? DEFAULT_RUNS_PER_DAY)
  db.prepare(`INSERT INTO autonomous_agents (id, name, instructions, run_hours, created_by) VALUES (?,?,?,?,?)`)
    .run(id, String(name || '').trim(), String(instructions || '').trim(), JSON.stringify(hours), created_by)
  broadcast()
  return getAgent(id)
}

export function updateAgent(id, patch = {}) {
  const row = getAgent(id)
  if (!row) return null
  const sets = []
  const vals = []
  if ('name' in patch) { sets.push('name=?'); vals.push(String(patch.name || '').trim()) }
  if ('instructions' in patch) { sets.push('instructions=?'); vals.push(String(patch.instructions || '').trim()) }
  // « N fois par jour » : le serveur choisit les heures.
  if ('runs_per_day' in patch) { sets.push('run_hours=?'); vals.push(JSON.stringify(planHours(patch.runs_per_day, id))) }
  else if ('run_hours' in patch) { sets.push('run_hours=?'); vals.push(JSON.stringify(parseHours(patch.run_hours))) }
  if ('enabled' in patch) { sets.push('enabled=?'); vals.push(patch.enabled ? 1 : 0) }
  if (!sets.length) return row
  db.prepare(`UPDATE autonomous_agents SET ${sets.join(', ')}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
    .run(...vals, id)
  broadcast()
  return getAgent(id)
}

export function deleteAgent(id) {
  const r = db.prepare(`UPDATE autonomous_agents SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND deleted_at IS NULL`).run(id)
  if (r.changes) broadcast()
  return r.changes > 0
}

function localHour(date, tz = TZ) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(date))
}

/**
 * `count` heures réparties sur 24 h, décalées vers les heures les plus calmes :
 * `load[h]` = activité de la file à l'heure h, `taken` = heures déjà prises par
 * les autres agents (on évite qu'ils se réveillent ensemble).
 */
export function pickHours(count, { load = [], taken = [] } = {}) {
  const n = Math.max(1, Math.min(24, Math.round(Number(count)) || 1))
  const step = 24 / n
  const busy = new Set(parseHours(taken))
  let best = null
  for (let o = 0; o < Math.ceil(step); o++) {
    const hours = parseHours(Array.from({ length: n }, (_, i) => Math.round(o + i * step) % 24))
    const score = hours.reduce((s, h) => s + (load[h] || 0) + (busy.has(h) ? 1000 : 0), 0)
    if (!best || score < best.score) best = { hours, score }
  }
  return best.hours
}

/** Heures opportunes pour un agent : file la moins chargée sur 30 jours. */
function planHours(count, excludeId = null) {
  const load = Array(24).fill(0)
  const since = new Date(Date.now() - 30 * 86400_000).toISOString()
  const rows = db.prepare(`
    SELECT created_at AS t FROM work_prompts WHERE autonomous_agent_id IS NULL AND deleted_at IS NULL AND created_at >= ?
    UNION ALL
    SELECT started_at AS t FROM work_prompts WHERE started_at >= ?`).all(since, since)
  for (const r of rows) { const d = new Date(r.t); if (!isNaN(d)) load[localHour(d)]++ }
  const taken = listAgents().filter(a => a.id !== excludeId && a.enabled).flatMap(a => a.run_hours)
  return pickHours(count, { load, taken })
}

/**
 * Dernier créneau échu (instant UTC en ms) d'une liste d'heures locales, au plus
 * tard `now` — aujourd'hui, sinon hier. null si aucune heure.
 */
export function lastSlot(hours, now = new Date()) {
  const hs = parseHours(hours)
  if (!hs.length) return null
  const today = localDay(now)
  const h = localHour(now)
  const pick = [...hs].reverse().find(x => x <= h)
  const day = pick != null ? today : localDay(new Date(now.getTime() - 86400_000))
  const hour = pick != null ? pick : hs[hs.length - 1]
  const iso = naiveLocalToUtcIso(`${day}T${String(hour).padStart(2, '0')}:00:00`)
  const t = Date.parse(iso)
  // Garde pour les bascules d'heure : un créneau « dans le futur » n'est pas échu.
  return t > now.getTime() ? null : t
}

/**
 * Vrai si l'agent doit se réveiller maintenant : actif, mission non vide, un
 * créneau échu depuis moins de CATCH_UP_MS, postérieur à sa création et à son
 * dernier passage, et aucun passage précédent encore en cours.
 */
export function isDue(agent, now = new Date()) {
  if (!agent?.enabled || !String(agent.instructions || '').trim()) return false
  const slot = lastSlot(agent.run_hours, now)
  if (slot == null || now.getTime() - slot > CATCH_UP_MS) return false
  const since = Math.max(Date.parse(agent.last_run_at || 0) || 0, Date.parse(agent.created_at || 0) || 0)
  if (slot <= since) return false
  return !isBusy(agent)
}

function isBusy(agent) {
  if (!agent.last_prompt_id) return false
  const p = db.prepare(`SELECT status, pending_question FROM work_prompts WHERE id=? AND deleted_at IS NULL`).get(agent.last_prompt_id)
  if (!p) return false
  return ['queued', 'running', 'paused'].includes(p.status) || (!!p.pending_question && p.status !== 'cancelled')
}

/** Brief autoportant : la session qui l'exécute ne connaît que ce texte. */
export function buildAgentBrief(agent, now = new Date()) {
  return [
    `Agent autonome « ${agent.name || 'sans nom'} » — passage planifié du ${localDay(now)}.`,
    '',
    'Mission (rédigée par l\'équipe) :',
    String(agent.instructions || '').trim(),
    '',
    'Cadre :',
    '- Inspecte uniquement la partie de l\'app visée par la mission.',
    '- Corrige toi-même ce qui est clairement un défaut (bug, incohérence, code mort, règle du CLAUDE.md non respectée).',
    '- Rien à corriger : dis-le en une ligne, ne modifie rien.',
    '- Ne change aucune règle métier sans demander : dans le doute, pose la question.',
    '- Ne touche jamais server/.env, la base erp.db en direct, ni agent-tasks.json.',
    '- Après une modif : entrée dans client/src/data/changelog.json (sans `requester`), `cd client && npm run build` si client/src a bougé, `server/scripts/restart.sh` si server/src a bougé.',
  ].join('\n')
}

/** Dépose un passage dans la file. `force` = bouton « Lancer » (ignore les heures). */
export function runAgent(agent, { now = new Date(), force = false } = {}) {
  if (!agent) return null
  if (!force && !isDue(agent, now)) return null
  if (force && isBusy(agent)) return { busy: true }
  const prompt = createPrompt({
    title: `🤖 ${agent.name || 'Agent autonome'}`,
    prompt: buildAgentBrief(agent, now),
    mode: 'implement',
    preset: 'auto',
  })
  db.prepare(`UPDATE work_prompts SET autonomous_agent_id=? WHERE id=?`).run(agent.id, prompt.id)
  db.prepare(`UPDATE autonomous_agents SET last_run_at=?, last_prompt_id=? WHERE id=?`)
    .run(now.toISOString(), prompt.id, agent.id)
  broadcast()
  return { prompt_id: prompt.id }
}

/** Passage de l'horloge : réveille les agents dus. `dryRun` = liste sans déposer. */
export function tickAutonomousAgents({ now = new Date(), dryRun = false } = {}) {
  const due = listAgents().filter(a => isDue(a, now))
  if (dryRun) return { dus: due.map(a => a.name || a.id) }
  const launched = []
  for (const a of due) {
    try {
      const out = runAgent(a, { now })
      if (out?.prompt_id) launched.push(a.name || a.id)
    } catch (e) {
      console.error(`🤖 Agent autonome ${a.id}:`, e.message)
    }
  }
  if (launched.length) advanceQueue()
  return { lances: launched }
}
