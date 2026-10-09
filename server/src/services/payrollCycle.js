// Cycle de paie (travail récurrent « Paie » d'Antoine, page /travaux).
//
// Les paies sont aux deux semaines, période du dimanche au samedi. Antoine
// PRÉPARE la paie le lundi qui suit la fin de période et la SOUMET à Nethris le
// mardi. Le cycle n'est écrit nulle part : on le lit dans les dernières paies
// (table `paies`, miroir d'Airtable) — la plus récente fin de période sert
// d'ancre, l'écart le plus fréquent entre deux fins donne l'intervalle. Toutes
// les paies à venir (ou passées) se déduisent ensuite par pas de cet intervalle.
import db from '../db/database.js'
import { quebecHolidays } from './paieSchedule.js'

const DEFAULT_INTERVAL = 14
// Décalage en jours depuis la fin de période (samedi) : lundi, puis mardi.
export const PAY_STEPS = [
  { step: 1, label: 'préparer', offset: 2 },
  { step: 2, label: 'Nethris', offset: 3 },
]

function addDays(dayIso, n) {
  const [y, m, d] = dayIso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10)
}
function diffDays(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400_000)
}

/** Ancre + intervalle déduits d'une liste de fins de période (pure, testable). */
export function cycleFromPeriodEnds(ends) {
  const sorted = [...new Set((ends || []).filter(e => /^\d{4}-\d{2}-\d{2}$/.test(e || '')))].sort()
  if (!sorted.length) return null
  const counts = {}
  for (let i = 1; i < sorted.length; i++) {
    const d = diffDays(sorted[i - 1], sorted[i])
    if (d > 0) counts[d] = (counts[d] || 0) + 1
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]
  return { anchor_end: sorted.at(-1), interval: best ? Number(best[0]) : DEFAULT_INTERVAL }
}

let cache = null
/** Cycle courant lu dans les 10 dernières paies (cache 5 min). */
export function detectPayCycle() {
  if (cache && Date.now() - cache.at < 300_000) return cache.cycle
  let cycle = null
  try {
    const ends = db.prepare(`SELECT period_end FROM paies WHERE period_end IS NOT NULL ORDER BY period_end DESC LIMIT 10`)
      .all().map(r => String(r.period_end).slice(0, 10))
    cycle = cycleFromPeriodEnds(ends)
  } catch { cycle = null }
  cache = { at: Date.now(), cycle }
  return cycle
}

/** Paie (fin de période) dont la soumission tombe le `day` ou juste après. */
export function payPeriodOnOrAfter(cycle, day) {
  if (!cycle) return null
  const last = PAY_STEPS.at(-1).offset
  const k = Math.ceil(diffDays(cycle.anchor_end, addDays(day, -last)) / cycle.interval)
  return describePay(cycle, addDays(cycle.anchor_end, k * cycle.interval))
}

// Jours fériés observés (Québec) : un an autour de la date suffit.
const holidayCache = new Map()
export function holidayOn(day) {
  const y = Number(day.slice(0, 4))
  if (!holidayCache.has(y)) holidayCache.set(y, new Map(quebecHolidays(y).map(h => [h.date, h.name])))
  return holidayCache.get(y).get(day) || null
}
const isWeekend = d => [0, 6].includes(new Date(`${d}T00:00:00Z`).getUTCDay())
const isOff = d => isWeekend(d) || !!holidayOn(d)
function previousBusinessDay(d) {
  let x = d
  while (isOff(x)) x = addDays(x, -1)
  return x
}

/**
 * Étapes d'une paie, fériés compris : une étape qui tombe un jour férié est
 * DEVANCÉE au jour ouvrable précédent (Nethris ne dépose rien un férié et
 * exige deux jours ouvrables avant la date payable). La soumission est placée
 * d'abord, la préparation toujours avant elle.
 */
export function describePay(cycle, end) {
  const dates = []
  for (let i = PAY_STEPS.length - 1; i >= 0; i--) {
    let d = previousBusinessDay(addDays(end, PAY_STEPS[i].offset))
    if (dates[0] && d >= dates[0]) d = previousBusinessDay(addDays(dates[0], -1))
    dates.unshift(d)
  }
  return {
    end,
    start: addDays(end, -(cycle.interval - 1)),
    steps: PAY_STEPS.map((s, i) => {
      const usual = addDays(end, s.offset)
      return {
        ...s, date: dates[i], period_key: `${end}-${s.step}`,
        moved_from: dates[i] !== usual ? usual : null,
        holiday: dates[i] !== usual ? holidayOn(usual) || holidayOn(addDays(end, PAY_STEPS.at(-1).offset)) : null,
      }
    }),
  }
}

/** Fériés observés entre deux dates (incluses), pour le calendrier. */
export function holidaysBetween(from, to) {
  const out = []
  for (let d = from; d <= to; d = addDays(d, 1)) { const n = holidayOn(d); if (n) out.push({ date: d, name: n }) }
  return out
}

/** Paies de `from` (inclus) à `to` — pour le calendrier. */
export function payCalendar(cycle, from, to) {
  const out = []
  let p = payPeriodOnOrAfter(cycle, from)
  while (p && p.steps[0].date <= to && out.length < 20) {
    out.push(p)
    p = describePay(cycle, addDays(p.end, cycle.interval))
  }
  return out
}

/** `2026-10-10-2` → { end, step } ; `null` si la clé n'est pas une étape de paie. */
export function parsePayKey(key) {
  const m = /^(\d{4}-\d{2}-\d{2})-([12])$/.exec(String(key || ''))
  return m ? { end: m[1], step: PAY_STEPS[Number(m[2]) - 1] } : null
}

export function _resetPayCycleCache() { cache = null }
