// Robot « Rapprocher » QuickBooks — la logique pure, sans navigateur.
//
// Qu'est-ce qu'il faut cocher dans l'écran « Rapprocher » ? Les écritures dont
// la ligne de relevé est verte dans Boréal (status='rapproche'). Le lien se fait
// par l'id QuickBooks (bank_transactions.qb_txn_id) ; l'écran n'expose pas
// toujours cet id, on retombe alors sur montant exact + date ±4 jours, chaque
// ligne ne servant qu'une fois. Une coche déjà posée (par Charles) n'est jamais
// retirée : on ne produit que des coches à AJOUTER.

const round2 = n => Math.round(n * 100) / 100
const DAY = 86_400_000
const days = (a, b) => Math.round(Math.abs(Date.parse(a) - Date.parse(b)) / DAY)
const sameAmount = (a, b) => a != null && b != null && Math.abs(a - b) < 0.005

// « 1 234,56 $ », « $1,234.56 », « -12.34 », « (12,34) » → nombre. null si ce
// n'est pas un montant.
export function parseMoney(raw) {
  let s = String(raw ?? '').replace(/[\s\u00a0\u202f$]/g, '').replace(/CAD|USD/gi, '')
  if (!s) return null
  let neg = false
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1) }
  if (/^[-−–]/.test(s)) { neg = true; s = s.slice(1) }
  if (/[-−–]$/.test(s)) { neg = true; s = s.slice(0, -1) }
  if (!/^\d[\d.,]*$/.test(s)) return null
  const lastDot = s.lastIndexOf('.')
  const lastComma = s.lastIndexOf(',')
  const decAt = Math.max(lastDot, lastComma)
  let n
  if (decAt >= 0 && s.length - decAt - 1 <= 2 && s.length - decAt - 1 > 0) {
    n = Number(`${s.slice(0, decAt).replace(/[.,]/g, '')}.${s.slice(decAt + 1)}`)
  } else {
    n = Number(s.replace(/[.,]/g, ''))
  }
  if (!Number.isFinite(n)) return null
  return round2(neg ? -n : n)
}

// Ordre jour/mois d'un ensemble de dates d'écran « 14/09/2026 » : un premier
// nombre > 12 tranche pour jour-mois, un second > 12 pour mois-jour.
export function detectDateOrder(samples) {
  let dmy = 0, mdy = 0
  for (const raw of samples || []) {
    const s = String(raw || '').trim()
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return 'ymd'
    const m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/)
    if (!m) continue
    if (Number(m[1]) > 12) dmy++
    if (Number(m[2]) > 12) mdy++
  }
  if (dmy && !mdy) return 'dmy'
  if (mdy && !dmy) return 'mdy'
  return null
}

const MONTHS = {
  janv: 1, jan: 1, fevr: 2, fev: 2, feb: 2, mars: 3, mar: 3, avr: 4, apr: 4, mai: 5, may: 5, juin: 6, jun: 6,
  juil: 7, jul: 7, aout: 8, aug: 8, sept: 9, sep: 9, oct: 10, nov: 11, dec: 12,
}

// Date affichée → AAAA-MM-JJ. `order` vient de detectDateOrder ; null = on
// suppose jour-mois (réglage québécois) quand rien ne tranche.
export function parseScreenDate(raw, order = null) {
  const s = String(raw || '').trim()
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})$/)
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3]
    const [d, mo] = order === 'mdy' ? [m[2], m[1]] : [m[1], m[2]]
    if (Number(mo) > 12 || Number(d) > 31) return null
    return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  }
  const norm = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\./g, '')
  const month = w => MONTHS[w] ?? MONTHS[w.slice(0, 4)] ?? MONTHS[w.slice(0, 3)]
  const iso = (y, mo, d) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`
  m = norm.match(/^(\d{1,2})\s+([a-z]+)\s+(\d{4})$/)
  if (m && month(m[2])) return iso(m[3], month(m[2]), m[1])
  m = norm.match(/^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})$/)
  if (m && month(m[1])) return iso(m[3], month(m[1]), m[2])
  return null
}

// Date ISO → texte à saisir dans le champ « Date de fin », selon son format
// (placeholder « aaaa-mm-jj », « jj/mm/aaaa », « mm/dd/yyyy »… ou une date
// déjà affichée à l'écran).
export function formatDateFor(pattern, iso) {
  const [y, mo, d] = String(iso).split('-')
  const p = String(pattern || '').toLowerCase()
  if (/^\d{4}-\d{2}-\d{2}/.test(p) || /^(aaaa|yyyy)-/.test(p)) return `${y}-${mo}-${d}`
  const sep = (p.match(/[/.-]/) || ['/'])[0]
  if (/^(mm|m)[/.-]/.test(p)) return `${mo}${sep}${d}${sep}${y}`
  if (/^(jj|dd|j|d)[/.-]/.test(p)) return `${d}${sep}${mo}${sep}${y}`
  const order = detectDateOrder([p])
  if (order === 'mdy') return `${mo}${sep}${d}${sep}${y}`
  if (order === 'dmy') return `${d}${sep}${mo}${sep}${y}`
  return `${y}-${mo}-${d}`
}

// Solde de fin tel que QuickBooks l'attend : une carte demande le solde DÛ,
// positif ; Boréal le voit comme un actif (négatif = dû).
export function endingBalanceFor(kind, printedSigned) {
  if (printedSigned == null) return null
  return round2(kind === 'card' ? -printedSigned : printedSigned)
}

/**
 * Ce que le robot doit attendre à l'écran, à partir des lignes vertes.
 * @param {object[]} targets  lignes Boréal { id, txn_date, amount, qb_txn_id, description }
 * @param {object[]} ledger   grand livre QB du compte { qbId, date, amount, cleared }
 * @returns {{ expected: object[], alreadyReconciled: number }}
 *   expected : { qbId, date, amount, borealIds } — une entrée par ligne d'écran attendue
 */
export function buildExpected(targets, ledger = [], { graceDays = 4 } = {}) {
  const byId = new Map()
  for (const e of ledger) {
    if (!e.qbId) continue
    if (!byId.has(e.qbId)) byId.set(e.qbId, [])
    byId.get(e.qbId).push(e)
  }
  const groups = new Map()
  const loose = []
  for (const t of targets) {
    const id = t.qb_txn_id ? String(t.qb_txn_id) : null
    if (!id) { loose.push(t); continue }
    if (!groups.has(id)) groups.set(id, [])
    groups.get(id).push(t)
  }

  const expected = []
  let alreadyReconciled = 0
  const usedLedger = new Set()
  for (const [qbId, rows] of groups) {
    const entries = byId.get(qbId) || []
    // Déjà rapprochée dans QuickBooks (« R ») : elle n'est plus à l'écran.
    if (entries.some(e => e.cleared === 'R')) { alreadyReconciled += rows.length; continue }
    const borealIds = rows.map(r => r.id)
    if (entries.length) {
      for (const e of entries) { usedLedger.add(e); expected.push({ qbId, date: e.date, amount: e.amount, borealIds }) }
    } else {
      // Écriture hors du grand livre de ce compte (portée ailleurs) : on attend
      // ce que dit le relevé, sans garantie de la trouver.
      const date = rows.map(r => r.txn_date).sort().at(-1)
      expected.push({ qbId, date, amount: round2(rows.reduce((s, r) => s + r.amount, 0)), borealIds })
    }
  }
  // Lignes vertes sans lien QuickBooks : si une écriture déjà « R » du grand
  // livre leur correspond, elles sont déjà rapprochées là-bas.
  const reconciledPool = ledger.filter(e => e.cleared === 'R' && !usedLedger.has(e))
  for (const t of loose) {
    const i = reconciledPool.findIndex(e => sameAmount(e.amount, t.amount) && days(e.date, t.txn_date) <= graceDays)
    if (i >= 0) { reconciledPool.splice(i, 1); alreadyReconciled++; continue }
    expected.push({ qbId: null, date: t.txn_date, amount: t.amount, borealIds: [t.id] })
  }
  return { expected, alreadyReconciled }
}

/**
 * Apparie les lignes d'écran aux écritures attendues.
 * @param {object[]} screenRows { key, date, amount (signé, ou null), abs, checked, ids: string[] }
 * @param {object[]} expected   sortie de buildExpected (entrées déjà consommées retirées par l'appelant)
 * @returns {{ matches: {key, expectedIndex, checked}[], unmatchedScreen: object[] }}
 */
export function matchScreen(screenRows, expected, { endDate = null, graceDays = 4 } = {}) {
  const rows = screenRows.filter(r => !endDate || !r.date || r.date <= endDate)
  const freeRows = new Set(rows.map(r => r.key))
  const freeExp = new Set(expected.map((_, i) => i))
  const matches = []
  const take = (row, i) => { freeRows.delete(row.key); freeExp.delete(i); matches.push({ key: row.key, expectedIndex: i, checked: !!row.checked }) }
  const amountOk = (row, e) => (row.amount != null ? sameAmount(row.amount, e.amount) : sameAmount(row.abs, Math.abs(e.amount)))

  // 1. Par id QuickBooks lu dans l'écran.
  for (const row of rows) {
    if (!row.ids?.length) continue
    const i = [...freeExp].find(j => expected[j].qbId && row.ids.includes(expected[j].qbId) && amountOk(row, expected[j]))
      ?? [...freeExp].find(j => expected[j].qbId && row.ids.includes(expected[j].qbId))
    if (i != null) take(row, i)
  }
  // 2. Montant exact + date la plus proche (±graceDays).
  const order = [...freeExp].sort((a, b) => String(expected[a].date).localeCompare(String(expected[b].date)))
  for (const i of order) {
    const e = expected[i]
    let best = null
    for (const row of rows) {
      if (!freeRows.has(row.key) || !row.date || !amountOk(row, e)) continue
      const d = days(row.date, e.date)
      if (d > graceDays) continue
      if (!best || d < best.d) best = { row, d }
    }
    if (best) take(best.row, i)
  }
  return { matches, unmatchedScreen: rows.filter(r => freeRows.has(r.key)) }
}
