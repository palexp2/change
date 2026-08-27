// Jours d'ouverture des banques — sert à DATER un paiement fournisseur.
//
// Règle de la maison : une facture se paie le DERNIER jour de son échéance —
// l'argent reste au compte le plus longtemps possible. Si ce jour-là les banques
// sont fermées (fin de semaine ou jour férié), le paiement est daté du jour
// ouvrable PRÉCÉDENT : payer après l'échéance, c'est payer en retard.
//
// Les fériés retenus sont ceux d'une banque à charte fédérale opérant au Québec
// (Banque Nationale, Desjardins) : les jours fériés généraux du Code canadien du
// travail + la Fête nationale du Québec. Un férié qui tombe une fin de semaine
// est reporté au lundi suivant (règle du Code canadien du travail), qui compte
// donc lui aussi comme jour de fermeture.

const dayOnly = v => String(v || '').slice(0, 10)

export const todayIso = () => new Date().toLocaleDateString('en-CA')

export const shiftDays = (iso, n) => {
  const d = new Date(`${dayOnly(iso)}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

// 0 = dimanche … 6 = samedi. Midi UTC : à l'abri des fuseaux et de l'heure avancée.
export const weekdayOf = iso => new Date(`${dayOnly(iso)}T12:00:00Z`).getUTCDay()

export const isWeekend = iso => weekdayOf(iso) === 0 || weekdayOf(iso) === 6

const iso = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

// Pâques (algorithme grégorien anonyme) — ancre du Vendredi saint.
export function easterSunday(year) {
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return iso(year, month, day)
}

// n-ième `dow` du mois (dow : 0 = dimanche).
const nthWeekday = (year, month, dow, n) => {
  const first = weekdayOf(iso(year, month, 1))
  return iso(year, month, 1 + ((dow - first + 7) % 7) + (n - 1) * 7)
}

// Lundi qui précède le 25 mai : Journée nationale des patriotes (= Victoria Day).
const patriotes = (year) => {
  const may25 = iso(year, 5, 25)
  return shiftDays(may25, -(((weekdayOf(may25) - 1) + 7) % 7 || 7))
}

// Fériés de l'année, `YYYY-MM-DD` → libellé. Les fériés à date fixe tombant une
// fin de semaine sont AUSSI fermés le lundi suivant (jour de reprise).
export function bankHolidays(year) {
  const easter = easterSunday(year)
  const fixed = [
    [iso(year, 1, 1), "Jour de l'An"],
    [iso(year, 6, 24), 'Fête nationale du Québec'],
    [iso(year, 7, 1), 'Fête du Canada'],
    [iso(year, 9, 30), 'Journée de la vérité et de la réconciliation'],
    [iso(year, 11, 11), 'Jour du Souvenir'],
    [iso(year, 12, 25), 'Noël'],
    [iso(year, 12, 26), 'Lendemain de Noël'],
  ]
  const map = new Map([
    [shiftDays(easter, -2), 'Vendredi saint'],
    [patriotes(year), 'Journée nationale des patriotes'],
    [nthWeekday(year, 9, 1, 1), 'Fête du Travail'],
    [nthWeekday(year, 10, 1, 2), 'Action de grâce'],
    ...fixed,
  ])
  // Reprise : le premier jour de semaine libre qui suit un férié de fin de semaine.
  for (const [date, label] of fixed) {
    if (!isWeekend(date)) continue
    let d = shiftDays(date, 1)
    for (let i = 0; i < 7 && (isWeekend(d) || map.has(d)); i++) d = shiftDays(d, 1)
    if (!map.has(d)) map.set(d, `${label} (reporté)`)
  }
  return map
}

// Cache par année : la liste ne change jamais dans une session.
const cache = new Map()
const holidaysFor = (year) => {
  if (!cache.has(year)) cache.set(year, bankHolidays(year))
  return cache.get(year)
}

// Libellé du férié, ou null si les banques sont ouvertes ce jour-là.
export function holidayName(date) {
  const d = dayOnly(date)
  if (!d) return null
  return holidaysFor(Number(d.slice(0, 4))).get(d) || null
}

export const isBankDay = date => !!dayOnly(date) && !isWeekend(date) && !holidayName(date)

// Ce jour-là s'il est ouvrable, sinon le jour ouvrable précédent.
export function bankDayOnOrBefore(date) {
  let d = dayOnly(date)
  if (!d) return d
  for (let i = 0; i < 10 && !isBankDay(d); i++) d = shiftDays(d, -1)
  return d
}

// Date à laquelle on paie une facture qui échoit le `due` :
//   due      — l'échéance est ouvrable : on paie ce jour-là, pas avant.
//   weekend  — l'échéance tombe une fin de semaine : jour ouvrable précédent.
//   holiday  — l'échéance est fériée : jour ouvrable précédent (`holiday` = lequel).
//   late     — l'échéance est passée : le plus tôt possible, donc aujourd'hui.
//   none     — facture sans échéance : aujourd'hui.
export function payDateForDue(due, today = todayIso()) {
  const d = dayOnly(due)
  const now = dayOnly(today)
  if (!d) return { date: now, reason: 'none', due: null, holiday: null }
  const date = bankDayOnOrBefore(d)
  const holiday = holidayName(d)
  if (date < now) return { date: now, reason: 'late', due: d, holiday, closed: date }
  return {
    date,
    reason: date === d ? 'due' : (holiday ? 'holiday' : 'weekend'),
    due: d,
    holiday,
  }
}
