// Travaux récurrents (page /travaux, onglet « Travaux récurrents »).
//
// Remplace le fichier Travaux_OS_ML du Drive : au lieu de recopier le bloc de la
// semaine précédente et de rayer des lignes dans un document, chaque travail est
// une ligne durable (hebdo / mensuel / trimestriel / annuel / ad hoc) qu'on coche
// PAR PÉRIODE. Cocher « CTB les transactions » cette semaine n'efface donc rien :
// la case se rouvre d'elle-même la semaine suivante.
import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { broadcastAll } from './realtime.js'
import { localDay, dayDiff as daysBetween } from '../utils/datetime.js'
export { localDay, daysBetween }

export const CADENCES = ['bihebdo', 'hebdo', 'mensuel', 'trimestriel', 'annuel', 'adhoc']
// Propriétaires possibles d'un travail = les deux sections de la page (AL, ML).
// Un travail se réassigne d'une section à l'autre ; toute autre valeur le rendrait
// invisible (aucune section ne l'afficherait).
export const OWNERS = ['AL', 'ML']

// ─── Deux fois par semaine (cadence « bihebdo ») ──────────────────────────────
//
// Certains travaux (comptabiliser les transactions, payer les fournisseurs,
// mettre à jour le fichier du maintien du solde) se font DEUX fois par semaine :
// le mardi et le samedi. Une case hebdomadaire ne peut pas raconter ça — cochée
// le mardi, elle reste cochée le samedi et le travail du samedi passe pour fait.
//
// La semaine est donc coupée en deux créneaux, chacun coché séparément :
//   • créneau 1 « mardi »  → lundi au vendredi  (clé `2026-W33-1`)
//   • créneau 2 « samedi » → samedi au dimanche (clé `2026-W33-2`)
//
// Les deux créneaux tiennent dans la même semaine ISO, donc le sélecteur de
// semaine continue de tout ancrer. Concrètement : coché le mardi, le travail se
// re-décoche de lui-même le samedi ; coché le samedi, il repart le lundi suivant
// pour le mardi. Aucun compteur, aucun cron — c'est la date qui décide.
export const BIWEEKLY_SLOTS = [
  { slot: 1, label: 'mardi', from: 0, to: 4, due: 1 },  // lundi → vendredi, dû le mardi
  { slot: 2, label: 'samedi', from: 5, to: 6, due: 5 }, // samedi → dimanche, dû le samedi
]

/** Index 0-6 du jour dans sa semaine ISO (lundi = 0, dimanche = 6). */
function weekdayIndex(dayIso) {
  const [y, m, d] = dayIso.split('-').map(Number)
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7
}

/** Créneau bi-hebdomadaire d'un jour civil (1 = mardi, 2 = samedi). */
function slotForDay(dayIso) {
  const i = weekdayIndex(dayIso)
  return BIWEEKLY_SLOTS.find(s => i >= s.from && i <= s.to) || BIWEEKLY_SLOTS[0]
}

/** `2026-W33-2` → le créneau correspondant, `null` si la clé n'en désigne aucun. */
export function slotFromKey(periodKey) {
  const m = /^(\d{4}-W\d{2})-([12])$/.exec(String(periodKey || ''))
  return m ? { week_key: m[1], ...BIWEEKLY_SLOTS[Number(m[2]) - 1] } : null
}

/** Semaine ISO d'une date civile → { year, week }. Lundi = premier jour. */
export function isoWeek(dayIso) {
  const [y, m, d] = dayIso.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  // Jeudi de la semaine courante : son année est, par définition ISO, l'année de la semaine.
  const dayNum = (date.getUTCDay() + 6) % 7 // lundi=0
  date.setUTCDate(date.getUTCDate() - dayNum + 3)
  const isoYear = date.getUTCFullYear()
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4))
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3)
  const week = 1 + Math.round((date - firstThursday) / (7 * 86400_000))
  return { year: isoYear, week }
}

/**
 * Clé de période d'une cadence à une date donnée. C'est l'unité de cochage :
 * hebdo → '2026-W32', mensuel → '2026-08', trimestriel → '2026-Q3',
 * annuel → '2026', ad hoc → 'adhoc' (une seule occurrence, jamais réouverte).
 */
export function periodKeyFor(cadence, date = new Date()) {
  const day = typeof date === 'string' ? date : localDay(date)
  const [y, m] = day.split('-').map(Number)
  switch (cadence) {
    case 'hebdo': {
      const { year, week } = isoWeek(day)
      return `${year}-W${String(week).padStart(2, '0')}`
    }
    // Deux clés par semaine : la semaine ISO, suffixée du créneau (mardi/samedi).
    case 'bihebdo': {
      const { year, week } = isoWeek(day)
      return `${year}-W${String(week).padStart(2, '0')}-${slotForDay(day).slot}`
    }
    case 'mensuel':     return `${y}-${String(m).padStart(2, '0')}`
    case 'trimestriel': return `${y}-Q${Math.floor((m - 1) / 3) + 1}`
    case 'annuel':      return String(y)
    default:            return 'adhoc'
  }
}

// ─── Semaines (navigation) ────────────────────────────────────────────────────
// La page se consulte semaine par semaine : la clé de semaine ISO sert d'ancre,
// et TOUTES les cadences sont recalculées à partir du lundi de cette semaine
// (une semaine d'août appartient au mois d'août, au T3, à 2026…). Choisir une
// autre semaine ne « recopie » rien : la liste des travaux est la même, seul
// l'état de cochage change de période — c'est ce qui fait qu'une nouvelle
// semaine repart automatiquement avec tous les travaux à faire.

function addDays(dayIso, n) {
  const [y, m, d] = dayIso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}

/** Lundi (`YYYY-MM-DD`) de la semaine ISO contenant `dayIso`. */
export function weekStart(dayIso) {
  const [y, m, d] = dayIso.split('-').map(Number)
  const date = new Date(Date.UTC(y, m - 1, d))
  return addDays(dayIso, -((date.getUTCDay() + 6) % 7))
}

/**
 * `2026-W33` → lundi de cette semaine (`YYYY-MM-DD`). Retourne `null` si la clé
 * est malformée ou désigne une semaine 53 qui n'existe pas cette année-là.
 */
export function weekKeyToDay(key) {
  const m = /^(\d{4})-W(\d{1,2})$/.exec(String(key || ''))
  if (!m) return null
  const year = Number(m[1])
  const week = Number(m[2])
  if (week < 1 || week > 53) return null
  // La semaine 1 est, par définition ISO, celle qui contient le 4 janvier.
  const jan4 = new Date(Date.UTC(year, 0, 4))
  const day = addDays(jan4.toISOString().slice(0, 10), -((jan4.getUTCDay() + 6) % 7) + (week - 1) * 7)
  return periodKeyFor('hebdo', day) === `${year}-W${String(week).padStart(2, '0')}` ? day : null
}

const dayMonth = new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'short', timeZone: 'UTC' })

/** Une semaine décrite pour le sélecteur : clé, bornes, libellé lisible. */
export function describeWeek(dayIso, today = localDay()) {
  const start = weekStart(dayIso)
  const end = addDays(start, 6)
  const key = periodKeyFor('hebdo', start)
  const { week } = isoWeek(start)
  const fmt = d => dayMonth.format(new Date(`${d}T00:00:00Z`)).replace('.', '')
  return {
    key,
    week,
    start,
    end,
    year: Number(end.slice(0, 4)),
    label: `Semaine ${week} · ${fmt(start)} au ${fmt(end)} ${end.slice(0, 4)}`,
    short_label: `Semaine ${week}`,
    is_current: key === periodKeyFor('hebdo', today),
  }
}

/**
 * Semaines proposées dans le menu : quelques semaines en arrière (pour rattraper
 * un cochage oublié) et en avant (préparer la semaine qui vient).
 */
export function weekOptions({ back = 12, forward = 2, date = new Date(), include = null } = {}) {
  const today = typeof date === 'string' ? date : localDay(date)
  const current = weekStart(today)
  const out = []
  for (let i = back; i >= -forward; i--) out.push(describeWeek(addDays(current, -7 * i), today))
  // Une semaine demandée hors de la fenêtre reste sélectionnable (lien partagé,
  // signet) : sinon le menu afficherait une semaine absente de ses propres options.
  if (include && !out.some(w => w.key === include)) {
    const day = weekKeyToDay(include)
    if (day) out.push(describeWeek(day, today))
    out.sort((a, b) => (a.start < b.start ? -1 : 1))
  }
  return out
}

/** Libellé lisible de la période courante, pour l'en-tête de chaque section. */
export function periodLabel(cadence, date = new Date()) {
  const day = typeof date === 'string' ? date : localDay(date)
  const [y, m] = day.split('-').map(Number)
  const monthName = new Intl.DateTimeFormat('fr-CA', { month: 'long', timeZone: 'UTC' })
    .format(new Date(Date.UTC(y, m - 1, 1)))
  switch (cadence) {
    // Un bi-hebdomadaire se coche par créneau, mais la SECTION couvre la semaine
    // entière (les deux cases sont sur la même ligne) : même libellé qu'un hebdo.
    case 'hebdo':
    case 'bihebdo':     return `semaine ${isoWeek(day).week}`
    case 'mensuel':     return `${monthName} ${y}`
    case 'trimestriel': return `T${Math.floor((m - 1) / 3) + 1} ${y}`
    case 'annuel':      return String(y)
    default:            return 'à faire une fois'
  }
}

// ─── Échéance dans la période, et rattrapage de la période précédente ─────────
//
// Deux problèmes distincts, qui se règlent ensemble :
//
// 1. « Payer Visa CAD et USD » est dû le 25. Tant qu'elle n'est qu'une ligne
//    parmi d'autres dans la section « Mensuel », rien ne dit qu'elle devient
//    urgente — d'où `due_day` (jour du mois) et un statut d'échéance calculé.
// 2. Une tâche mensuelle se fait souvent au début du mois SUIVANT. Cocher le
//    3 août marquait alors août, alors que le travail fait était celui de
//    juillet — et juillet restait « à faire » sans que personne ne le voie.
//    D'où les périodes de rattrapage : tant qu'un mois terminé n'est pas coché,
//    il reste proposé, nommément, sous la ligne du travail. On coche « juillet »
//    ou « août », jamais « le mois courant, on verra bien ».

const DUE_SOON_DAYS = 5
// Le rattrapage ne concerne QUE les cadences longues : pour l'hebdo, reculer
// d'une semaine dans le sélecteur fait déjà le travail, et trois semaines de
// retard afficheraient plus de rappels que de travaux.
const CATCHUP_CADENCES = new Set(['mensuel', 'trimestriel', 'annuel'])
const CATCHUP_DEPTH = 3

/** Bornes civiles d'une période (`{ start, end }`), ou `null` (adhoc / clé invalide). */
export function periodRange(cadence, periodKey) {
  const key = String(periodKey || '')
  let m
  if (cadence === 'hebdo') {
    const start = weekKeyToDay(key)
    return start ? { start, end: addDays(start, 6) } : null
  }
  if (cadence === 'bihebdo') {
    const slot = slotFromKey(key)
    const monday = slot && weekKeyToDay(slot.week_key)
    return monday ? { start: addDays(monday, slot.from), end: addDays(monday, slot.to) } : null
  }
  if (cadence === 'mensuel' && (m = /^(\d{4})-(\d{2})$/.exec(key))) {
    const [y, mo] = [Number(m[1]), Number(m[2])]
    if (mo < 1 || mo > 12) return null
    return { start: `${m[1]}-${m[2]}-01`, end: new Date(Date.UTC(y, mo, 0)).toISOString().slice(0, 10) }
  }
  if (cadence === 'trimestriel' && (m = /^(\d{4})-Q([1-4])$/.exec(key))) {
    const y = Number(m[1])
    const first = (Number(m[2]) - 1) * 3 + 1
    return {
      start: `${m[1]}-${String(first).padStart(2, '0')}-01`,
      end: new Date(Date.UTC(y, first + 2, 0)).toISOString().slice(0, 10),
    }
  }
  if (cadence === 'annuel' && /^\d{4}$/.test(key)) return { start: `${key}-01-01`, end: `${key}-12-31` }
  return null
}

/** Période précédente d'une cadence (`2026-08` → `2026-07`), `null` si adhoc. */
export function previousPeriodKey(cadence, periodKey) {
  const r = periodRange(cadence, periodKey)
  if (!r) return null
  // Un jour avant le début de la période retombe forcément dans la précédente.
  return periodKeyFor(cadence, addDays(r.start, -1))
}

/** Recule une clé de période de `n` pas (pour `period_offset`). `n` ≤ 0 = clé inchangée. */
export function shiftPeriodKey(cadence, periodKey, n) {
  let key = periodKey
  for (let i = 0; i < n && key; i++) key = previousPeriodKey(cadence, key)
  return key
}

/**
 * Date d'échéance d'une période mensuelle quand un jour du mois est fixé. Le
 * jour est ramené au dernier jour du mois (« le 31 » en février = le 28/29),
 * sinon l'échéance tomberait dans le mois suivant.
 */
export function periodDueDate(cadence, periodKey, dueDay) {
  if (cadence !== 'mensuel' || !dueDay) return null
  const r = periodRange('mensuel', periodKey)
  if (!r) return null
  const day = Math.min(Math.max(1, Number(dueDay) || 0), Number(r.end.slice(8)))
  return day ? `${periodKey}-${String(day).padStart(2, '0')}` : null
}

/** Écart en jours civils entre deux dates `YYYY-MM-DD` (b - a). */
/**
 * État d'échéance affiché sur la ligne : `overdue` (dépassée), `due_soon`
 * (aujourd'hui ou dans les 5 jours), `upcoming`, ou `null` (déjà cochée, ou
 * aucune échéance connue).
 */
export function dueInfo({ cadence, periodKey, dueDay, done, today = localDay() }) {
  const due_date = periodDueDate(cadence, periodKey, dueDay)
  if (!due_date) return { due_date: null, days_until_due: null, due_status: null }
  const days_until_due = daysBetween(today, due_date)
  const due_status = done ? null
    : days_until_due < 0 ? 'overdue'
    : days_until_due <= DUE_SOON_DAYS ? 'due_soon'
    : 'upcoming'
  return { due_date, days_until_due, due_status }
}

/**
 * Périodes terminées, encore non cochées, à proposer en rattrapage sous la
 * ligne. Fonction pure (l'état de cochage arrive par `isDone`) : c'est elle qui
 * décide qu'un mois est « en retard », donc elle se teste seule.
 *
 * Deux garde-fous : une période encore en cours n'est jamais un retard, et on
 * ne remonte pas avant la création du travail — sinon un travail ajouté
 * aujourd'hui naîtrait avec trois mois de retard imaginaire.
 */
export function catchUpPeriods({
  cadence, periodKey, isDone, createdDay = null, dueDay = null,
  today = localDay(), depth = CATCHUP_DEPTH,
}) {
  if (!CATCHUP_CADENCES.has(cadence)) return []
  const out = []
  let key = periodKey
  for (let i = 0; i < depth; i++) {
    key = previousPeriodKey(cadence, key)
    const r = key && periodRange(cadence, key)
    if (!r) break
    if (createdDay && r.end < createdDay) break // le travail n'existait pas encore
    if (r.end >= today) continue                // période pas encore terminée
    if (isDone(key)) continue
    out.push({
      period_key: key,
      period_label: periodLabel(cadence, r.start),
      due_date: periodDueDate(cadence, key, dueDay),
      ends_on: r.end,
    })
  }
  return out
}

// ─── Lecture ──────────────────────────────────────────────────────────────────

// « Fait par » = propriétaire de la section, pas l'utilisateur connecté : les
// sessions du poste sont partagées (Antoine coche souvent depuis la session de
// Michel), alors que chacun ne coche que les travaux de sa propre section. Le
// `done_by` (user de la session) reste stocké en DB à titre de trace, mais
// n'est plus affiché.
const OWNER_NAMES = { AL: 'Antoine', ML: 'Michel' }
function doneByName(task, completion) {
  if (!completion) return null
  return OWNER_NAMES[task.owner] || completion.session_user_name || null
}

/**
 * Les deux créneaux d'un bi-hebdomadaire pour la semaine ancrée, décrits ligne
 * par ligne pour l'affichage : clé, libellé, bornes, état de cochage.
 *
 * `is_current` désigne le créneau qu'on est en train de vivre (donc jamais dans
 * une semaine passée ou à venir), `is_past` un créneau terminé et encore vide —
 * c'est ce qui distingue « pas encore fait » de « raté ».
 */
export function biweeklyOccurrences({ weekKey, isDone, today = localDay() }) {
  const monday = weekKeyToDay(weekKey)
  if (!monday) return []
  const todaySlot = periodKeyFor('bihebdo', today)
  return BIWEEKLY_SLOTS.map(s => {
    const period_key = `${weekKey}-${s.slot}`
    const start = addDays(monday, s.from)
    const end = addDays(monday, s.to)
    const c = isDone(period_key)
    return {
      period_key,
      slot: s.slot,
      label: s.label,
      start,
      end,
      due_date: addDays(monday, s.due),
      done: !!c,
      done_at: c?.done_at || null,
      is_current: period_key === todaySlot,
      is_past: end < today,
    }
  })
}

/**
 * Travaux actifs, enrichis de l'état de la période courante : `period_key`,
 * `done`, `done_at`, `done_by_name`. Une tâche ad hoc déjà cochée reste cochée.
 *
 * Cas particulier des bi-hebdomadaires : la ligne porte DEUX cases (`occurrences`),
 * et n'est « faite » que lorsque les deux créneaux de la semaine le sont — sinon
 * cocher le mardi ferait disparaître de la liste le travail du samedi.
 */
export function listRecurringTasks({ owner = null, includeInactive = false, date = new Date() } = {}) {
  const where = ['deleted_at IS NULL']
  const params = []
  if (owner) { where.push('owner=?'); params.push(owner) }
  if (!includeInactive) where.push('active=1')
  const rows = db.prepare(`
    SELECT * FROM recurring_tasks WHERE ${where.join(' AND ')}
    ORDER BY CASE cadence WHEN 'bihebdo' THEN 0 WHEN 'hebdo' THEN 1 WHEN 'mensuel' THEN 2
                          WHEN 'trimestriel' THEN 3 WHEN 'annuel' THEN 4 ELSE 5 END, priority DESC, position, created_at
  `).all(...params)

  const completion = db.prepare(`
    SELECT c.done_at, c.note, u.name AS session_user_name
    FROM recurring_task_completions c
    LEFT JOIN users u ON u.id = c.done_by
    WHERE c.task_id=? AND c.period_key=?
  `)
  const today = localDay()
  return rows.map(t => {
    if (t.cadence === 'bihebdo') return biweeklyTask(t, { date, today, completion })
    // period_offset décale la période « courante » en arrière (travaux qui ne se
    // font qu'une fois le mois terminé) : la ligne affiche alors directement la
    // période décalée, plus besoin d'un rattrapage pour dire la même chose.
    const period_key = shiftPeriodKey(t.cadence, periodKeyFor(t.cadence, date), t.period_offset || 0)
    const c = completion.get(t.id, period_key)
    const done = !!c
    return {
      ...t,
      period_key,
      period_label: periodLabel(t.cadence, periodRange(t.cadence, period_key)?.start || date),
      done,
      done_at: c?.done_at || null,
      done_by_name: doneByName(t, c),
      done_note: c?.note || null,
      ...dueInfo({ cadence: t.cadence, periodKey: period_key, dueDay: t.due_day, done, today }),
      // Mois (trimestres, années) terminés et jamais cochés : c'est le travail
      // de juillet qu'on coche début août, nommément, plutôt que celui d'août.
      catch_up: catchUpPeriods({
        cadence: t.cadence,
        periodKey: period_key,
        dueDay: t.due_day,
        createdDay: (t.created_at || '').slice(0, 10) || null,
        today,
        isDone: key => !!completion.get(t.id, key),
      }),
    }
  })
}

/**
 * Ligne d'un travail bi-hebdomadaire pour la semaine ancrée. `period_key` reste
 * la case « par défaut » (celle du créneau en cours si on regarde la semaine
 * courante, sinon le premier créneau) : le client coche explicitement l'une ou
 * l'autre, mais l'API garde un comportement sensé sans clé.
 */
function biweeklyTask(t, { date, today, completion }) {
  const weekKey = periodKeyFor('hebdo', date)
  const occurrences = biweeklyOccurrences({
    weekKey, today, isDone: key => completion.get(t.id, key) || null,
  }).map(o => {
    const c = completion.get(t.id, o.period_key)
    return { ...o, done_by_name: doneByName(t, c) }
  })
  const current = occurrences.find(o => o.is_current) || occurrences[0]
  const lastDone = [...occurrences].reverse().find(o => o.done)
  return {
    ...t,
    period_key: current.period_key,
    period_label: periodLabel('bihebdo', date),
    occurrences,
    // « Fait » = les DEUX créneaux de la semaine : tant qu'il en reste un, la
    // ligne appartient à ce qui reste à faire.
    done: occurrences.every(o => o.done),
    done_at: lastDone?.done_at || null,
    done_by_name: lastDone?.done_by_name || null,
    done_note: null,
    due_date: null, days_until_due: null, due_status: null,
    catch_up: [],
  }
}

/** Historique de cochage d'un travail (les 30 dernières périodes). */
export function listCompletions(taskId) {
  const task = db.prepare('SELECT * FROM recurring_tasks WHERE id=?').get(taskId)
  return db.prepare(`
    SELECT c.*, u.name AS session_user_name
    FROM recurring_task_completions c
    LEFT JOIN users u ON u.id = c.done_by
    WHERE c.task_id=? ORDER BY c.done_at DESC LIMIT 30
  `).all(taskId).map(c => ({ ...c, done_by_name: task ? doneByName(task, c) : c.session_user_name }))
}

// ─── Écriture ─────────────────────────────────────────────────────────────────

function broadcast() { broadcastAll({ type: 'travaux:recurring:updated' }) }

export function createRecurringTask({
  label, cadence = 'hebdo', owner = 'AL', day_hint = null, notes = null,
  due_date = null, due_day = null, source = 'manuel',
}) {
  const text = String(label || '').trim()
  if (!text) throw new Error('label requis')
  if (!CADENCES.includes(cadence)) throw new Error('cadence invalide')
  const id = newRecordId()
  const pos = (db.prepare(`SELECT MAX(position) AS m FROM recurring_tasks WHERE deleted_at IS NULL`).get()?.m ?? 0) + 1
  db.prepare(`
    INSERT INTO recurring_tasks (id, label, cadence, owner, day_hint, notes, due_date, due_day, position, source)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(id, text, cadence, owner, day_hint, notes, due_date, cleanDueDay(due_day), pos, source)
  broadcast()
  return db.prepare('SELECT * FROM recurring_tasks WHERE id=?').get(id)
}

const EDITABLE = ['label', 'cadence', 'owner', 'day_hint', 'notes', 'due_date', 'due_day', 'active', 'position', 'priority', 'period_offset']

/** Jour du mois validé (1-31), ou `null` — champ vidé, valeur farfelue. */
function cleanDueDay(v) {
  if (v === null || v === undefined || v === '') return null
  const n = Math.trunc(Number(v))
  return Number.isFinite(n) && n >= 1 && n <= 31 ? n : null
}

export function updateRecurringTask(id, patch) {
  const row = db.prepare('SELECT * FROM recurring_tasks WHERE id=? AND deleted_at IS NULL').get(id)
  if (!row) return null
  const sets = []
  const vals = []
  for (const [k, v] of Object.entries(patch)) {
    if (!EDITABLE.includes(k)) continue
    if (k === 'cadence' && !CADENCES.includes(v)) continue
    if (k === 'owner' && !OWNERS.includes(v)) continue
    sets.push(`${k}=?`)
    vals.push(
      k === 'active' || k === 'priority' ? (v ? 1 : 0) :
      k === 'due_day' ? cleanDueDay(v) :
      k === 'period_offset' ? Math.max(0, Math.trunc(Number(v)) || 0) :
      v
    )
  }
  if (!sets.length) return row
  db.prepare(`UPDATE recurring_tasks SET ${sets.join(', ')}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
    .run(...vals, id)
  broadcast()
  return db.prepare('SELECT * FROM recurring_tasks WHERE id=?').get(id)
}

export function deleteRecurringTask(id) {
  const row = db.prepare('SELECT id FROM recurring_tasks WHERE id=? AND deleted_at IS NULL').get(id)
  if (!row) return false
  db.prepare(`UPDATE recurring_tasks SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(id)
  broadcast()
  return true
}

// ─── Seed depuis Travaux_OS_ML (Drive) ────────────────────────────────────────
// Contenu repris du document Travaux_OS_ML.docx (sections « AL » et « Mike »), qui
// n'est plus la source de vérité : l'ERP l'est. Le seed est idempotent par id
// stable — un travail supprimé ou renommé ici ne réapparaît pas au redémarrage.
const SEED = [
  // Antoine Lambert
  // Ces trois-là se font le mardi ET le samedi — d'où la cadence bi-hebdomadaire
  // (deux cases par semaine). Pas de day_hint : les créneaux le disent déjà.
  { owner: 'AL', cadence: 'bihebdo', slug: 'ctb-transactions', label: 'CTB les transactions + concilier les comptes bancaires et de cartes de crédit' },
  { owner: 'AL', cadence: 'bihebdo', slug: 'payer-fournisseurs', label: 'Payer les comptes fournisseurs',
    notes: 'Mastercard : paiement pré-programmé le 4-5 du mois. Garder le solde sous 10 000 $ (limite de crédit 15 000 $).' },
  { owner: 'AL', cadence: 'bihebdo', slug: 'maintien-solde-disponible', label: 'Mettre à jour le fichier « Maintien du solde disponible »' },
  { owner: 'AL', cadence: 'hebdo', slug: 'depenses-emilie', label: "Compiler les dépenses pour le suivi budgétaire d'Émilie", day_hint: 'mardi' },
  { owner: 'AL', cadence: 'hebdo', slug: 'remettre-20k-epargne', label: 'Remettre 20 k$ dans le compte Épargne' },
  { owner: 'AL', cadence: 'mensuel', slug: 'payer-visa', label: 'Payer Visa CAD et Visa USD', day_hint: 'le 25', due_day: 25,
    notes: 'Un rappel Slack automatique existe déjà (automation « Rappel de paiement des cartes »).' },
  // Ces trois-là se font APRÈS la fin du mois qu'elles décrivent (déboursés,
  // relevés, écritures de fin de mois) : period_offset:1 fait afficher direct
  // « août » tout septembre, plutôt qu'une ligne « septembre » à côté d'un
  // rattrapage « août » qui répétait la même chose sous une autre forme.
  { owner: 'AL', cadence: 'mensuel', slug: 'debourses-gui', label: 'Fournir à Gui les déboursés en pièces pour le mois', period_offset: 1 },
  { owner: 'AL', cadence: 'mensuel', slug: 'releves-bancaires-drive', label: 'Télécharger les relevés bancaires sur le Drive',
    notes: 'Relevé Mastercard disponible vers le 15-17 du mois.', period_offset: 1 },
  { owner: 'AL', cadence: 'mensuel', slug: 'ej-mensuelle', label: "E/J mensuelle (crédit d'impôt RSDE, Pari, subvention LB, FPA)",
    notes: 'Voir la page « Écritures de fin de mois ».', period_offset: 1 },
  { owner: 'AL', cadence: 'trimestriel', slug: 'rapport-taxes-rq', label: 'Produire le rapport de taxes (Revenu Québec)',
    notes: 'Trimestre au 30 septembre : à produire avant le 31 octobre. Envoyer le paiement au moins 5 jours avant la date limite.' },

  // Michel / Mike
  { owner: 'ML', cadence: 'hebdo', slug: 'revision-operations', label: 'Faire la révision des opérations de la semaine' },
  { owner: 'ML', cadence: 'hebdo', slug: 'analyse-stock-airtable-qb', label: 'Analyse hebdomadaire des catégories de stock Airtable/QB + E/J hebdo' },
  { owner: 'ML', cadence: 'hebdo', slug: 'analyse-rapide-ef', label: 'Faire une analyse rapide des EF' },
  { owner: 'ML', cadence: 'hebdo', slug: 'verif-depenses-emilie', label: "S'assurer qu'AL a compilé les dépenses pour le suivi budgétaire d'Émilie" },
  { owner: 'ML', cadence: 'mensuel', slug: 'verif-debourses-gui', label: "S'assurer qu'AL a fourni à Gui les déboursés en pièces pour le mois" },
  { owner: 'ML', cadence: 'trimestriel', slug: 'declaration-tps-tvq', label: 'Faire la déclaration de TPS et TVQ du trimestre' },
  { owner: 'ML', cadence: 'trimestriel', slug: 'conversion-usd-cad', label: 'Convertir les USD en CAD pour les comptes concernés (BNC USD, Venn USD)' },
  { owner: 'ML', cadence: 'annuel', slug: 'dossier-fin-annee', label: "Faire le suivi du dossier de fin d'année pour le comptable" },
  { owner: 'ML', cadence: 'adhoc', slug: 'tableau-fournitures-taxables', label: 'Mettre à jour le tableau sommaire des fournitures taxables ou non' },
  { owner: 'ML', cadence: 'adhoc', slug: 'ecart-abonnements-stripe-qb', label: "Suivi de l'écart de revenus d'abonnements mensuels entre Stripe et QB" },
]

export function seedRecurringWork() {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO recurring_tasks (id, label, cadence, owner, day_hint, notes, due_day, period_offset, position, source)
    VALUES (?,?,?,?,?,?,?,?,?,'travaux_os_ml')
  `)
  // Le jour d'échéance est arrivé après le seed initial : les lignes existent
  // déjà, donc INSERT OR IGNORE ne les toucherait pas. On le pose une fois, et
  // seulement sur une ligne jamais retouchée à la main (updated_at = created_at)
  // — vider le champ volontairement ne doit pas le voir revenir au redémarrage.
  const backfill = db.prepare(`
    UPDATE recurring_tasks SET due_day=?
    WHERE id=? AND due_day IS NULL AND deleted_at IS NULL
      AND (updated_at IS NULL OR updated_at = created_at)
  `)
  let added = 0
  const run = db.transaction(() => {
    SEED.forEach((t, i) => {
      const id = `rt-${t.owner.toLowerCase()}-${t.slug}`
      const info = insert.run(id, t.label, t.cadence, t.owner, t.day_hint || null, t.notes || null, t.due_day || null, t.period_offset || 0, i + 1)
      if (info.changes) added++
      else if (t.due_day) backfill.run(t.due_day, id)
    })
  })
  run()
  if (added) console.log(`✅ Travaux récurrents seedés (${added} nouveau(x))`)
  migrateToBiweekly()
  migratePeriodOffset()
}

// period_offset est arrivé après le seed initial : ces lignes existent déjà,
// INSERT OR IGNORE ne les touche pas. On le pose une fois, sur une ligne
// jamais retouchée à la main — même garde que le backfill de due_day.
const RETRO_MONTHLY_IDS = ['rt-al-debourses-gui', 'rt-al-releves-bancaires-drive', 'rt-al-ej-mensuelle']

function migratePeriodOffset() {
  const backfill = db.prepare(`
    UPDATE recurring_tasks SET period_offset=1
    WHERE id=? AND period_offset=0 AND deleted_at IS NULL
      AND (updated_at IS NULL OR updated_at = created_at)
  `)
  let moved = 0
  db.transaction(() => {
    for (const id of RETRO_MONTHLY_IDS) moved += backfill.run(id).changes
  })()
  if (moved) console.log(`✅ ${moved} travail(aux) mensuel(s) recalé(s) sur le mois précédent`)
}

// Bascule unique hebdo → bi-hebdomadaire des trois travaux qui se font le mardi
// et le samedi. Les lignes existent déjà (INSERT OR IGNORE ne les touche pas),
// il faut donc les convertir explicitement — mais une seule fois : la garde
// `updated_at = created_at` (ligne jamais retouchée à la main) tombe d'elle-même
// puisque la conversion touche la ligne. Repasser un de ces travaux en
// hebdomadaire dans l'interface tient donc, même après un redémarrage.
const BIWEEKLY_MIGRATION_IDS = [
  'rt-al-ctb-transactions',
  'rt-al-payer-fournisseurs',
  'rt-al-maintien-solde-disponible',
]

function migrateToBiweekly() {
  const convert = db.prepare(`
    UPDATE recurring_tasks
    SET cadence='bihebdo', day_hint=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=? AND cadence='hebdo' AND deleted_at IS NULL
      AND (updated_at IS NULL OR updated_at = created_at)
  `)
  // Les cochages déjà faits portent une clé de semaine (`2026-W33`) qui ne veut
  // plus rien dire pour cette cadence : on les rattache au créneau du mardi,
  // sinon l'historique des semaines passées repartirait vide.
  const rekey = db.prepare(`
    UPDATE recurring_task_completions SET period_key = period_key || '-1'
    WHERE task_id=? AND period_key GLOB '[0-9][0-9][0-9][0-9]-W[0-9][0-9]'
  `)
  let moved = 0
  db.transaction(() => {
    for (const id of BIWEEKLY_MIGRATION_IDS) {
      if (!convert.run(id).changes) continue
      rekey.run(id)
      moved++
    }
  })()
  if (moved) console.log(`✅ ${moved} travail(aux) passé(s) à deux fois par semaine (mardi et samedi)`)
}

/**
 * Coche / décoche un travail pour une période. `periodKey` par défaut = période
 * courante ; le décochage supprime la ligne de complétion (rien à conserver).
 */
/** Une clé de période est-elle cohérente avec la cadence ? (`adhoc` n'en a qu'une.) */
export function isValidPeriodKey(cadence, periodKey) {
  if (cadence === 'adhoc') return periodKey === 'adhoc'
  return !!periodRange(cadence, periodKey)
}

export function setCompletion(taskId, { done, periodKey = null, userId = null, note = null } = {}) {
  const task = db.prepare('SELECT * FROM recurring_tasks WHERE id=? AND deleted_at IS NULL').get(taskId)
  if (!task) return null
  const key = periodKey || periodKeyFor(task.cadence)
  // Le client coche désormais des périodes passées (rattrapage, semaine choisie) :
  // une clé qui ne correspond pas à la cadence écrirait une complétion fantôme,
  // invisible dans toutes les listes. On refuse plutôt que d'écrire à côté.
  if (!isValidPeriodKey(task.cadence, key)) return { invalid: true, period_key: key }
  if (done) {
    db.prepare(`
      INSERT INTO recurring_task_completions (id, task_id, period_key, done_by, note)
      VALUES (?,?,?,?,?)
      ON CONFLICT(task_id, period_key) DO UPDATE SET
        done_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), done_by=excluded.done_by, note=excluded.note
    `).run(newRecordId(), taskId, key, userId, note)
  } else {
    db.prepare('DELETE FROM recurring_task_completions WHERE task_id=? AND period_key=?').run(taskId, key)
  }
  broadcast()
  return { task_id: taskId, period_key: key, done: !!done }
}
