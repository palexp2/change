// Calendrier de paie : paie aux deux semaines, fin de période le samedi, et
// jours fériés du Québec (Loi sur les normes du travail) + le 26 décembre.
// Pas d'accès DB : la route fournit la dernière fin de période connue.

const DAY = 86400000

const toISO = d => d.toISOString().slice(0, 10)
const utc = (y, m, d) => new Date(Date.UTC(y, m - 1, d))
const addDays = (d, n) => new Date(d.getTime() + n * DAY)

// Dimanche de Pâques (algorithme grégorien anonyme).
function easter(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  return utc(y, month, ((h + l - 7 * m + 114) % 31) + 1)
}

// n-ième lundi du mois.
function nthMonday(y, m, n) {
  const first = utc(y, m, 1)
  return addDays(first, ((8 - first.getUTCDay()) % 7) + (n - 1) * 7)
}

// Lundi précédant le 25 mai (Journée nationale des patriotes).
function patriotes(y) {
  const d = utc(y, 5, 24)
  return addDays(d, -((d.getUTCDay() + 6) % 7))
}

// Jours fériés chômés d'une année, ramenés au jour ouvrable observé : un férié
// à date fixe tombé un samedi ou un dimanche est reporté au prochain jour de
// semaine libre (25-26 déc. un samedi-dimanche → lundi 27, mardi 28).
export function quebecHolidays(y) {
  const fixed = [
    ['Jour de l\'an', utc(y, 1, 1)],
    ['Fête nationale', utc(y, 6, 24)],
    ['Fête du Canada', utc(y, 7, 1)],
    ['Noël', utc(y, 12, 25)],
    ['Lendemain de Noël', utc(y, 12, 26)],
  ]
  const movable = [
    ['Vendredi saint', addDays(easter(y), -2)],
    ['Journée nationale des patriotes', patriotes(y)],
    ['Fête du Travail', nthMonday(y, 9, 1)],
    ['Action de grâces', nthMonday(y, 10, 2)],
  ]
  const taken = new Set(movable.map(([, d]) => toISO(d)))
  const out = movable.map(([name, d]) => ({ name, date: toISO(d) }))
  for (const [name, d0] of fixed) {
    let d = d0
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6 || taken.has(toISO(d))) d = addDays(d, 1)
    taken.add(toISO(d))
    out.push({ name, date: toISO(d) })
  }
  return out.sort((a, b) => a.date.localeCompare(b.date))
}

// Fériés observés compris dans [start, end] (dates ISO incluses).
export function holidaysInPeriod(start, end) {
  const years = new Set([Number(start.slice(0, 4)), Number(end.slice(0, 4))])
  // Un férié de fin décembre reporté peut glisser sur l'année suivante.
  const list = [...years].flatMap(y => [...quebecHolidays(y - 1), ...quebecHolidays(y)])
  const seen = new Set()
  return list.filter(h => h.date >= start && h.date <= end && !seen.has(h.date) && seen.add(h.date))
}

// Période suivante : 14 jours après la dernière fin de période connue ; sans
// historique, la période qui se termine le prochain samedi (aujourd'hui inclus).
export function nextPaiePeriod(lastPeriodEnd, today = new Date()) {
  let end
  if (lastPeriodEnd) {
    end = addDays(new Date(`${lastPeriodEnd.slice(0, 10)}T00:00:00Z`), 14)
    // Une fin historique décalée est ramenée au samedi suivant.
    end = addDays(end, (6 - end.getUTCDay() + 7) % 7)
  } else {
    const t = utc(today.getFullYear(), today.getMonth() + 1, today.getDate())
    end = addDays(t, (6 - t.getUTCDay() + 7) % 7)
  }
  const start = addDays(end, -13)
  const periodStart = toISO(start)
  const periodEnd = toISO(end)
  const holidays = holidaysInPeriod(periodStart, periodEnd)
  return {
    period_start: periodStart,
    period_end: periodEnd,
    // Correction des FdT : le mardi suivant la fin de période, 11 h.
    timesheets_deadline: `${toISO(addDays(end, 3))}T11:00`,
    nb_holiday_days: holidays.length,
    holidays,
  }
}
