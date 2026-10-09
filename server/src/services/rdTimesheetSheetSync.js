// Feuille de temps R&D : lignes R&D de Boréal vues comme l'onglet de la
// feuille mensuelle du Drive (grille « Mois », une ligne par personne × jour).
//
// La synchronisation dans les deux sens avec la feuille du Drive a été retirée
// (demande de Pierre-Alexandre Papillon, 2026-10-07) : Boréal n'écrit plus dans
// la feuille et n'y relit plus les heures saisies. Seule la lecture de l'onglet
// du mois précédent subsiste, pour proposer des descriptions dans la grille.
import xlsx from 'xlsx'
import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { findTimesheetFile, readTimesheetWorkbook } from './rdTimesheetImport.js'
import { monthEndAutomationConfig } from './monthEndAutomation.js'

export const RD_PROJECTS = ['Fiabilité', 'Intelligence de contrôle']

// ── Lecture d'un onglet ────────────────────────────────────────────────────

export const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase()
const round2 = n => Math.round((Number(n) || 0) * 100) / 100

export function canonicalProject(raw) {
  const v = norm(raw)
  if (!v) return ''
  const hit = RD_PROJECTS.find(p => norm(p) === v)
  if (hit) return hit
  if (v.startsWith('fiab')) return 'Fiabilité'
  if (v.startsWith('intel')) return 'Intelligence de contrôle'
  return String(raw).trim()
}

function excelSerialToIso(n) {
  const d = new Date(Math.round((Number(n) - 25569) * 86400000))
  return d.toISOString().slice(0, 10)
}

export function cellDate(v) {
  if (v == null || v === '') return null
  if (typeof v === 'number' && v > 30000 && v < 80000) return excelSerialToIso(v)
  const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})/.exec(String(v).trim())
  if (!m) return null
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
}

function cellNumber(v) {
  if (v == null || v === '') return 0
  if (typeof v === 'number') return v
  const n = Number(String(v).replace(',', '.').replace(/\s/g, ''))
  return Number.isFinite(n) ? n : 0
}

// `rows` = sheet_to_json(header: 1, blankrows: true), `firstRow` = numéro de
// ligne (1-indexé) de rows[0]. Colonnes retrouvées par leur en-tête : le
// gabarit varie d'un onglet à l'autre (Charles a deux colonnes d'heures).
export function parseTab(rows, firstRow = 1) {
  let headerIdx = -1
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    if ((rows[i] || []).some(c => norm(c).includes('heures rsde'))) { headerIdx = i; break }
  }
  if (headerIdx < 0) return null
  const header = rows[headerIdx].map(norm)
  const cols = {
    date: Math.max(0, header.findIndex(c => c.startsWith('date'))),
    hours: header.findIndex(c => c.includes('heures rsde')),
    desc: header.findIndex(c => c.includes('description')),
    project: header.findIndex(c => c === 'projet'),
  }
  const days = new Map()
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i] || []
    const date = cellDate(r[cols.date])
    if (!date || days.has(date)) continue
    days.set(date, {
      row: firstRow + i,
      hours: round2(cellNumber(r[cols.hours])),
      desc: cols.desc >= 0 ? String(r[cols.desc] ?? '').trim() : '',
      project: cols.project >= 0 ? canonicalProject(r[cols.project]) : '',
    })
  }
  return { headerRow: firstRow + headerIdx, cols, days }
}

// ── Côté Boréal ────────────────────────────────────────────────────────────

function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}
function weekStartOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z')
  return addDays(dateStr, -d.getUTCDay())
}
// Ligne d'une semaine déclarée d'un seul chiffre → [[date, minutes]…]. Sans
// jour attitré, ses heures sont réparties également du lundi au vendredi
// (demande de Pierre-Alexandre Papillon, 2026-10-07 ; avant : tout le lundi).
export function weekEntryDays(weekStart, sheetDate, minutes) {
  const m = Number(minutes) || 0
  if (sheetDate) return [[sheetDate, m]]
  const base = Math.floor(m / 5)
  return [1, 2, 3, 4, 5].map((n, i) => [addDays(weekStart, n), base + (i < m % 5 ? 1 : 0)])
}
function monthDays(month) {
  const [y, m] = month.split('-').map(Number)
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return Array.from({ length: n }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`)
}

// Valeur Boréal de chaque jour du mois pour une personne : { date → {hours, desc, project} }.
export function borealMonthValues(userId, month) {
  const from = `${month}-01`
  const to = `${month}-31`
  const parts = new Map()
  const push = (date, minutes, desc, project) => {
    if (!parts.has(date)) parts.set(date, [])
    parts.get(date).push({ minutes: Number(minutes) || 0, desc: String(desc || '').trim(), project: project || '' })
  }
  for (const e of db.prepare(`
    SELECT d.date, e.duration_minutes, e.description, COALESCE(e.rsde_project, ac.rsde_project) AS rsde_project
    FROM timesheet_entries e
    JOIN timesheet_days d ON d.id = e.day_id
    LEFT JOIN activity_codes ac ON ac.id = e.activity_code_id
    WHERE d.user_id = ? AND d.deleted_at IS NULL AND d.date >= ? AND d.date <= ? AND e.rsde = 1
    ORDER BY e.sort_order, e.created_at
  `).all(userId, from, to)) push(e.date, e.duration_minutes, e.description, e.rsde_project)
  for (const e of db.prepare(`
    SELECT w.week_start, e.sheet_date, e.duration_minutes, e.description, ac.rsde_project
    FROM timesheet_week_entries e
    JOIN timesheet_weeks w ON w.id = e.week_id
    LEFT JOIN activity_codes ac ON ac.id = e.activity_code_id
    WHERE w.user_id = ? AND w.deleted_at IS NULL AND e.rsde = 1
      AND w.week_start >= ? AND w.week_start <= ?
    ORDER BY e.sort_order, e.created_at
  `).all(userId, addDays(from, -7), to)) {
    for (const [date, minutes] of weekEntryDays(e.week_start, e.sheet_date, e.duration_minutes)) {
      if (date >= from && date <= to && minutes) push(date, minutes, e.description, e.rsde_project)
    }
  }
  const out = new Map()
  for (const [date, list] of parts) {
    const minutes = list.reduce((s, p) => s + p.minutes, 0)
    if (!minutes) continue
    const byProject = {}
    for (const p of list) if (p.project) byProject[p.project] = (byProject[p.project] || 0) + p.minutes
    const project = Object.entries(byProject).sort((a, b) => b[1] - a[1])[0]?.[0] || ''
    const desc = [...new Set(list.map(p => p.desc).filter(Boolean))].join(' ; ')
    out.set(date, { hours: round2(minutes / 60), desc, project })
  }
  return out
}

// Code d'activité pour une ligne venue de la feuille : celui que la personne
// emploie déjà pour ce projet (PA garde « ERP »), sinon « R&D · {projet} ».
export function codeForProject(userId, project) {
  const p = project || 'Fiabilité'
  const used = db.prepare(`
    SELECT e.activity_code_id AS id FROM timesheet_entries e
    JOIN timesheet_days d ON d.id = e.day_id
    JOIN activity_codes ac ON ac.id = e.activity_code_id
    WHERE d.user_id = ? AND d.deleted_at IS NULL AND ac.rsde_project = ? AND ac.active = 1 AND ac.deleted_at IS NULL
    ORDER BY d.date DESC LIMIT 1
  `).get(userId, p)
  if (used) return used.id
  const named = db.prepare(`SELECT id FROM activity_codes WHERE name = ? AND deleted_at IS NULL`).get(`R&D · ${p}`)
  if (named) return named.id
  return db.prepare(`SELECT id FROM activity_codes WHERE rsde_project = ? AND deleted_at IS NULL ORDER BY active DESC LIMIT 1`).get(p)?.id
    || db.prepare(`SELECT id FROM activity_codes WHERE name = 'R&D · Fiabilité' AND deleted_at IS NULL`).get()?.id
    || null
}

// Recopie la valeur de la feuille dans Boréal pour une personne × un jour.
// Retourne null si fait, sinon la raison du refus.
export function applySheetValueToBoreal(userId, date, value) {
  const minutes = Math.round((Number(value.hours) || 0) * 60)
  const week = db.prepare(`SELECT * FROM timesheet_weeks WHERE user_id = ? AND week_start = ? AND deleted_at IS NULL`).get(userId, weekStartOf(date))
  const weekHasContent = week && (Number(week.minutes) > 0
    || db.prepare('SELECT 1 FROM timesheet_week_entries WHERE week_id = ?').get(week.id))
  const codeId = minutes > 0 ? codeForProject(userId, value.project) : null

  if (weekHasContent) {
    // Semaine déclarée d'un seul chiffre : la ligne R&D va dans la semaine.
    db.transaction(() => {
      // Une ligne répartie sur la semaine touche ce jour : on la découpe d'abord
      // en une ligne par jour, pour ne remplacer que celle de `date`.
      const insWeek = db.prepare(`INSERT INTO timesheet_week_entries (id, week_id, sort_order, description, activity_code_id, duration_minutes, rsde, sheet_date)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?)`)
      for (const e of db.prepare('SELECT * FROM timesheet_week_entries WHERE week_id = ? AND rsde = 1 AND sheet_date IS NULL').all(week.id)) {
        const parts = weekEntryDays(week.week_start, null, e.duration_minutes)
        if (!parts.some(([d]) => d === date)) continue
        for (const [d, m] of parts) if (m) insWeek.run(newRecordId(), week.id, e.sort_order, e.description, e.activity_code_id, m, d)
        db.prepare('DELETE FROM timesheet_week_entries WHERE id = ?').run(e.id)
      }
      db.prepare('DELETE FROM timesheet_week_entries WHERE week_id = ? AND rsde = 1 AND sheet_date = ?').run(week.id, date)
      if (minutes > 0) {
        const next = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM timesheet_week_entries WHERE week_id = ?').get(week.id).n
        db.prepare(`INSERT INTO timesheet_week_entries (id, week_id, sort_order, description, activity_code_id, duration_minutes, rsde, sheet_date)
          VALUES (?, ?, ?, ?, ?, ?, 1, ?)`).run(newRecordId(), week.id, next, value.desc || null, codeId, minutes, date)
      }
    })()
    return null
  }

  let day = db.prepare('SELECT * FROM timesheet_days WHERE user_id = ? AND date = ? AND deleted_at IS NULL').get(userId, date)
  if (day && (day.status === 'approved' || day.status === 'submitted')) return 'journée soumise ou approuvée'
  if (!day && minutes === 0) return null
  db.transaction(() => {
    if (!day) {
      const id = newRecordId()
      db.prepare(`INSERT INTO timesheet_days (id, user_id, date, mode) VALUES (?, ?, ?, 'simple')`).run(id, userId, date)
      day = { id }
    }
    db.prepare('DELETE FROM timesheet_entries WHERE day_id = ? AND rsde = 1').run(day.id)
    if (minutes > 0) {
      const next = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM timesheet_entries WHERE day_id = ?').get(day.id).n
      db.prepare(`INSERT INTO timesheet_entries (id, day_id, sort_order, description, activity_code_id, duration_minutes, rsde, rsde_project)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?)`).run(newRecordId(), day.id, next, value.desc || null, codeId, minutes, canonicalProject(value.project) || null)
    }
    db.prepare(`UPDATE timesheet_days SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(day.id)
  })()
  return null
}

// Personne qui remplit la feuille du Drive : son nom est celui d'un onglet
// importé ces deux derniers mois. C'est elle qui voit la grille « Mois ».
export function isRdSheetMember(userId) {
  const u = db.prepare('SELECT name FROM users WHERE id = ?').get(userId)
  if (!u?.name) return false
  const d = new Date()
  const since = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)).toISOString().slice(0, 7)
  const target = norm(u.name)
  return db.prepare(`SELECT DISTINCT employee_name FROM rd_month_hours WHERE month >= ? AND deleted_at IS NULL`).all(since)
    .some(r => norm(r.employee_name) === target)
}

// Grille du mois d'une personne, comme son onglet de la feuille : une ligne
// par jour, arrivée/départ/pause de la journée + valeur R&D agrégée.
export function rdMonthGrid(userId, month) {
  const boreal = borealMonthValues(userId, month)
  const days = new Map(db.prepare(`
    SELECT d.id, d.date, d.start_time, d.end_time, d.break_minutes, d.status,
      (SELECT COUNT(*) FROM timesheet_entries e WHERE e.day_id = d.id AND e.rsde = 1) AS rd_lines
    FROM timesheet_days d WHERE d.user_id = ? AND d.deleted_at IS NULL AND d.date >= ? AND d.date <= ?
  `).all(userId, `${month}-01`, `${month}-31`).map(d => [d.date, d]))
  return monthDays(month).map(date => {
    const d = days.get(date)
    const v = boreal.get(date)
    return {
      date,
      day_id: d?.id || null,
      start_time: d?.start_time || null,
      end_time: d?.end_time || null,
      break_minutes: d?.break_minutes || 0,
      status: d?.status || null,
      hours: v?.hours || 0,
      desc: v?.desc || '',
      project: v?.project || '',
      rd_lines: d?.rd_lines || 0,
    }
  })
}

// Description + projet remplis le mois précédent, du plus fréquent au moins
// fréquent : proposés dans la grille du mois (demande de Charles, 2026-10-03).
// Boréal d'abord ; sinon l'onglet de la personne dans la feuille du mois
// précédent (lu une fois par heure — les mois d'avant la synchro ne sont que là).
const suggestionCache = new Map()
function prevMonthOf(month) {
  const [y, m] = month.split('-').map(Number)
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`
}
function rankPairs(values) {
  const counts = new Map()
  values.forEach((v, i) => {
    if (!v || !(v.hours > 0) || !(v.desc || v.project)) return
    const desc = String(v.desc || '').replace(/\s+/g, ' ').trim()
    const key = `${desc}\u0000${v.project}`
    const c = counts.get(key) || { desc, project: v.project, count: 0, last: 0 }
    c.count++; c.last = i
    counts.set(key, c)
  })
  // Une description vide ne propose rien d'utile : en dernier.
  return [...counts.values()].sort((a, b) => (!a.desc - !b.desc) || b.count - a.count || b.last - a.last).slice(0, 8)
    .map(({ desc, project, count }) => ({ desc, project, count }))
}
export async function rdSuggestions(userId, month) {
  const prev = prevMonthOf(month)
  const fromBoreal = rankPairs([...borealMonthValues(userId, prev).entries()].sort().map(([, v]) => v))
  if (fromBoreal.length) return fromBoreal
  const key = `${userId}|${prev}`
  const hit = suggestionCache.get(key)
  if (hit && Date.now() - hit.at < 3600_000) return hit.list
  let list = []
  try {
    const u = db.prepare('SELECT name FROM users WHERE id = ?').get(userId)
    const account = resolveAccount(monthEndAutomationConfig().googleAccountEmail)
    if (u?.name && account) {
      const { drive, file } = await findTimesheetFile(prev, { googleAccountEmail: account.account_email })
      if (file) {
        const wb = await readTimesheetWorkbook(drive, file)
        const tab = wb.SheetNames.find(t => norm(t) === norm(u.name))
        if (tab) {
          const ws = wb.Sheets[tab]
          const parsed = parseTab(xlsx.utils.sheet_to_json(ws, { header: 1, blankrows: true, raw: true, defval: '' }))
          if (parsed) list = rankPairs([...parsed.days.entries()].sort().map(([, v]) => v))
        }
      }
    }
  } catch { /* Drive indisponible : pas de proposition, la grille reste utilisable */ }
  suggestionCache.set(key, { at: Date.now(), list })
  return list
}

// ── Côté Drive ─────────────────────────────────────────────────────────────

function resolveAccount(email) {
  if (email) {
    const row = db.prepare(`SELECT * FROM connector_oauth WHERE connector='google' AND account_email = ? AND refresh_token IS NOT NULL`).get(email)
    if (row) return row
  }
  return db.prepare(`SELECT * FROM connector_oauth WHERE connector='google' AND refresh_token IS NOT NULL ORDER BY updated_at DESC LIMIT 1`).get() || null
}

// ── Détail par jour (/heures-rsde) ─────────────────────────────────────────

// Classeur du mois lu au Drive, gardé 1 h : changer d'onglet dans la page ne
// relance pas la lecture.
const monthTabsCache = new Map()
async function driveMonthTabs(month) {
  const hit = monthTabsCache.get(month)
  if (hit && Date.now() - hit.at < 3600_000) return hit.tabs
  const tabs = new Map()
  try {
    const account = resolveAccount(monthEndAutomationConfig().googleAccountEmail)
    if (account) {
      const { drive, file } = await findTimesheetFile(month, { googleAccountEmail: account.account_email })
      if (file) {
        const wb = await readTimesheetWorkbook(drive, file)
        for (const name of wb.SheetNames) {
          const parsed = parseTab(xlsx.utils.sheet_to_json(wb.Sheets[name], { header: 1, blankrows: true, raw: true, defval: '' }))
          if (parsed) tabs.set(norm(name), parsed.days)
        }
      }
    }
  } catch { /* Drive indisponible : seules les heures saisies dans Boréal s'affichent */ }
  monthTabsCache.set(month, { at: Date.now(), tabs })
  return tabs
}

// Heures R&D de chaque jour du mois, par personne du tableau annuel (et toute
// personne ayant saisi du R&D dans Boréal ce mois-là). Deux sources : Boréal
// et l'onglet de la personne dans la feuille du mois ; on garde celle dont le
// total est le plus proche du tableau annuel, pour que le détail tombe juste.
export async function rdMonthDays(month) {
  const people = new Map()
  for (const r of db.prepare(`
    SELECT employee_name, contractor, hours FROM rd_month_hours WHERE month = ? AND deleted_at IS NULL
  `).all(month)) people.set(norm(r.employee_name), { employee_name: r.employee_name, contractor: !!r.contractor, total: Number(r.hours) || 0 })
  const users = db.prepare(`SELECT id, name FROM users WHERE name IS NOT NULL AND deleted_at IS NULL`).all()
  const userByName = new Map(users.map(u => [norm(u.name), u.id]))
  for (const u of db.prepare(`
    SELECT DISTINCT u.name FROM timesheet_entries e
    JOIN timesheet_days d ON d.id = e.day_id JOIN users u ON u.id = d.user_id
    WHERE e.rsde = 1 AND d.deleted_at IS NULL AND d.date >= ? AND d.date <= ? AND u.name IS NOT NULL
  `).all(`${month}-01`, `${month}-31`)) {
    if (!people.has(norm(u.name))) people.set(norm(u.name), { employee_name: u.name, contractor: false, total: null })
  }
  const tabs = [...people.values()].some(p => p.total != null) ? await driveMonthTabs(month) : new Map()
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Montreal' })
  const sumOf = values => [...values].reduce((s, [d, v]) => s + (d <= today ? Number(v.hours) || 0 : 0), 0)
  const out = []
  for (const [key, { total, ...p }] of people) {
    const userId = userByName.get(key)
    const candidates = [
      ['boreal', userId ? borealMonthValues(userId, month) : new Map()],
      ['drive', tabs.get(key) || new Map()],
    ].filter(([, v]) => sumOf(v) > 0)
    if (total != null) candidates.sort((a, b) => Math.abs(sumOf(a[1]) - total) - Math.abs(sumOf(b[1]) - total))
    const [source, values] = candidates[0] || [null, new Map()]
    const days = monthDays(month).map(date => {
      // Comme l'import : les jours à venir pré-remplis dans la feuille ne comptent pas.
      const v = source === 'drive' && date > today ? null : values.get(date)
      return { date, hours: v?.hours || 0, desc: v?.desc || '', project: v?.project || '' }
    })
    out.push({ ...p, source, days })
  }
  out.sort((a, b) => (a.contractor - b.contractor) || a.employee_name.localeCompare(b.employee_name, 'fr'))
  return { month, people: out }
}
