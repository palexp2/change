// Budget marketing → Google Sheet « Budget marketing (Boréal) ».
//
// Charles, 2026-10-13 : ce qui est tranché dans la page Budget marketing (et
// envoyé à Émilie le mardi) doit se retrouver dans un Google Sheet à l'image de
// l'ancien « Annual Marketing budget » (onglet « 2026 Réel ») : un bloc par
// catégorie QB (ligne d'en-tête jaune + une ligne par fournisseur), une paire
// Budget | Réel par mois, colonnes Total, ligne Total en bas.
//
// Sens unique : Boréal réécrit l'onglet de chaque année financière à chaque
// changement (décision, règle, budget). Une saisie à la main dans le fichier est
// écrasée au passage suivant — le fichier est un miroir, pas une source.
// Le fichier est CRÉÉ par Boréal au premier passage (scope drive.file / sheets)
// et son id est rangé dans la config de l'automation.
import db from '../db/database.js'
import { getSheetsClient } from '../connectors/google.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'
import { fiscalMonths, getMarketingSyncConfig } from './marketingBudget.js'
import { localDay } from '../utils/datetime.js'

export const MARKETING_SHEET_AUTOMATION_ID = 'sys_marketing_budget_sheet'
export const MARKETING_SHEET_DEFAULT_CONFIG = {
  spreadsheet_id: '',
  google_account_email: 'michel@orisha.io',
  title: 'Annual Marketing budget',
}

export function getMarketingSheetConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get(MARKETING_SHEET_AUTOMATION_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch {}
  const merged = { ...MARKETING_SHEET_DEFAULT_CONFIG }
  for (const k of Object.keys(merged)) {
    if (cfg[k] != null && String(cfg[k]).trim() !== '') merged[k] = String(cfg[k]).trim()
  }
  return merged
}

export const sheetUrl = id => (id ? `https://docs.google.com/spreadsheets/d/${id}/edit` : null)

function saveSpreadsheetId(id) {
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get(MARKETING_SHEET_AUTOMATION_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch {}
  cfg.spreadsheet_id = id
  db.prepare('UPDATE automations SET action_config=? WHERE id=?').run(JSON.stringify(cfg), MARKETING_SHEET_AUTOMATION_ID)
}

function googleAccountId(email) {
  const row = db.prepare(
    "SELECT id FROM connector_oauth WHERE connector='google' AND account_email=? AND refresh_token IS NOT NULL",
  ).get(email)
  return row?.id || null
}

// ── Mise en page : clone de l'onglet « 2026 Réel » de l'ancien fichier ──────
// (teintes, polices, libellés, ordre des blocs relevés cellule par cellule —
// Charles, 2026-10-13 : « vraiment comme un clone, pour qu'Émilie se retrouve »).

const hex = h => ({ red: parseInt(h.slice(1, 3), 16) / 255, green: parseInt(h.slice(3, 5), 16) / 255, blue: parseInt(h.slice(5, 7), 16) / 255 })
const GREEN = hex('#108000'), WHITE = hex('#ffffff'), GREY = hex('#eceef1'), LIGHT = hex('#f9f9f9'),
  YELLOW = hex('#ffff00'), BLACK = hex('#000000'), SLATE = hex('#6b6c72'), NAVY = hex('#334960'), MUTED = hex('#576475')
const MONEY = { type: 'CURRENCY', pattern: '"$"#,##0' }
const greenBorder = { style: 'SOLID', width: 1, color: GREEN }

const MONTH_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const monthTitle = m => MONTH_EN[Number(m.slice(5, 7)) - 1]

// Blocs de l'ancien fichier, dans son ordre. « Miscelanious » (« QB: à
// déterminer ») reçoit les repas 75930, seul compte suivi qu'il n'avait pas.
export const SHEET_BLOCKS = [
  { acctnum: '75915', name: 'Partners', qb: 'Quickbooks: #75915 Partenaires', note: 'Équivalent en matériels et échange de services' },
  { acctnum: '75910', name: 'Design + Content', qb: 'QB: incl. dans #75910 Consultants' },
  { acctnum: '75925', name: 'Conferences + Events', qb: 'QB: #75925 Événements/Conférences', note: '4 événements' },
  { acctnum: '75920', name: 'Ads', qb: 'QB: #75920 Publicité et promotion' },
  { acctnum: '75930', name: 'Miscelanious', qb: 'QB: #75930 Repas aux fins de promotion' },
]

// Colonnes : A marge, B catégorie, C-D marges, E libellé, puis Budget|Réel × 12
// mois (F…AC), puis Total Budget | Total Réel (AD, AE).
const FIRST = 5
const NCOLS = FIRST + 24 + 2
export function colLetter(i) {
  let s = ''
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s
  return s
}
const budgetCol = k => FIRST + 2 * k
const realCol = k => FIRST + 2 * k + 1
const TOTAL_B = FIRST + 24, TOTAL_R = FIRST + 25

const txt = (v, fmt = {}) => ({ userEnteredValue: { stringValue: String(v) }, userEnteredFormat: fmt })
const num = (v, fmt = {}) => (v == null || v === '' ? { userEnteredFormat: fmt } : { userEnteredValue: { numberValue: Number(v) }, userEnteredFormat: fmt })
const formula = (f, fmt = {}) => ({ userEnteredValue: { formulaValue: f }, userEnteredFormat: fmt })
const tf = (o = {}) => ({ fontFamily: 'Arial', ...o })
const fmt = (o, text = {}) => ({ verticalAlignment: 'MIDDLE', ...o, textFormat: tf(text) })
const blankRow = () => Array.from({ length: NCOLS }, () => ({}))
const dollars = n => `${Math.round(n)}$`

// Grille d'une année financière. blocks = SHEET_BLOCKS + lines
// [{ vendor, budget: {mois: n}, real: {mois: n} }] (vendor '' = budget du compte
// sans nom, comme la rangée Ads de l'ancien fichier). Pure — testée.
export function buildFyGrid(months, blocks) {
  const rows = [], heights = [], merges = []
  const head = align => fmt({ backgroundColor: GREEN, horizontalAlignment: align, borders: { top: greenBorder, bottom: greenBorder, left: greenBorder, right: greenBorder } },
    { foregroundColor: WHITE, fontSize: 11 })

  const r1 = blankRow().map(() => ({ userEnteredFormat: head('CENTER') }))
  const r2 = blankRow().map(() => ({ userEnteredFormat: head('CENTER') }))
  for (const r of [r1, r2]) {
    r[0] = { userEnteredFormat: fmt({ backgroundColor: GREEN }, { bold: true, fontSize: 12, foregroundColor: BLACK }) }
    r[2] = { userEnteredFormat: fmt({ backgroundColor: GREEN }, { bold: true, fontSize: 11, foregroundColor: BLACK }) }
  }
  r1[4] = txt('Expenses', fmt({ backgroundColor: GREEN, horizontalAlignment: 'LEFT' }, { foregroundColor: WHITE, fontSize: 18 }))
  months.forEach((m, k) => {
    r1[budgetCol(k)] = txt(monthTitle(m), head('CENTER'))
    merges.push([0, budgetCol(k), 1, budgetCol(k) + 2])
    r2[budgetCol(k)] = txt('Budget', head('CENTER')); r2[realCol(k)] = txt('Réel', head('CENTER'))
  })
  r1[TOTAL_B] = txt('Total', head('CENTER')); merges.push([0, TOTAL_B, 1, TOTAL_B + 2])
  r2[TOTAL_B] = txt('Budget', head('CENTER')); r2[TOTAL_R] = txt('Réel', head('CENTER'))
  rows.push(r1, r2); heights.push(51, 51)

  const grey = (v, bold = false, size = 12) => (v
    ? txt(v, fmt({ backgroundColor: GREY, horizontalAlignment: 'RIGHT', wrapStrategy: 'WRAP' }, { bold, fontSize: size, foregroundColor: SLATE }))
    : { userEnteredFormat: fmt({ backgroundColor: GREY, horizontalAlignment: 'RIGHT' }, { bold, fontSize: size, foregroundColor: SLATE }) })
  const pairSum = (r, real) => `=${months.map((_, k) => `${colLetter(real ? realCol(k) : budgetCol(k))}${r}`).join('+')}`
  const headerRows = []
  let budgetAll = 0

  for (const b of blocks) {
    const lines = b.lines.length >= 2 ? b.lines : [...b.lines, ...Array(2 - b.lines.length).fill({ vendor: '', budget: {}, real: {} })]
    const hr = rows.length + 1, first = hr + 1, last = hr + lines.length
    headerRows.push(hr)
    const total = lines.reduce((s, l) => s + Object.values(l.budget).reduce((a, v) => a + v, 0), 0)
    budgetAll += total

    const h = blankRow()
    h[0] = grey('', true); h[1] = grey(b.name); h[2] = grey('', true, 11)
    h[3] = { userEnteredFormat: fmt({ backgroundColor: LIGHT, horizontalAlignment: 'RIGHT' }, { bold: true, fontSize: 11, foregroundColor: BLACK }) }
    h[4] = txt(b.qb, fmt({ backgroundColor: YELLOW, horizontalAlignment: 'LEFT' }, { bold: true, fontSize: 10, foregroundColor: SLATE }))
    months.forEach((_, k) => {
      const B = colLetter(budgetCol(k)), R = colLetter(realCol(k))
      h[budgetCol(k)] = formula(`=SUM(${B}${first}:${B}${last})`, fmt({ numberFormat: MONEY, horizontalAlignment: 'RIGHT', ...(k === 0 ? { backgroundColor: LIGHT } : {}) }, { fontSize: 11, foregroundColor: BLACK }))
      h[realCol(k)] = formula(`=SUM(${R}${first}:${R}${last})`, fmt({ numberFormat: MONEY, horizontalAlignment: 'RIGHT', backgroundColor: YELLOW }, { fontSize: 11, foregroundColor: BLACK }))
    })
    h[TOTAL_B] = formula(pairSum(hr, false), fmt({ numberFormat: MONEY, horizontalAlignment: 'RIGHT' }, { fontSize: 16, foregroundColor: BLACK }))
    h[TOTAL_R] = formula(pairSum(hr, true), fmt({ numberFormat: MONEY, horizontalAlignment: 'RIGHT', backgroundColor: YELLOW }, { fontSize: 16, foregroundColor: BLACK }))
    rows.push(h); heights.push(51)

    lines.forEach((l, i) => {
      const r = rows.length + 1
      const line = blankRow()
      line[0] = grey('', true)
      line[1] = grey(i === 0 ? `Budget : ${dollars(total)}` : i === 1 && b.note ? b.note : '')
      line[2] = grey('', true, 11)
      line[3] = { userEnteredFormat: fmt({ horizontalAlignment: 'RIGHT' }, { bold: true, fontSize: 11, foregroundColor: NAVY }) }
      line[4] = txt(l.vendor, fmt({ horizontalAlignment: 'LEFT' }, { fontSize: 10, foregroundColor: NAVY }))
      const small = fmt({ numberFormat: MONEY, horizontalAlignment: 'RIGHT' }, { fontSize: 9, foregroundColor: MUTED })
      months.forEach((m, k) => {
        line[budgetCol(k)] = num(l.budget[m] || null, small)
        line[realCol(k)] = num(l.real[m] || null, small)
      })
      const tot = fmt({ numberFormat: MONEY, horizontalAlignment: 'RIGHT' }, { fontSize: 9, foregroundColor: BLACK })
      line[TOTAL_B] = formula(pairSum(r, false), tot)
      line[TOTAL_R] = formula(pairSum(r, true), tot)
      rows.push(line); heights.push(i === 1 && b.note ? 43 : 26)
    })
    rows.push([]); heights.push(21)
  }

  const tr = blankRow()
  tr[0] = grey('', true); tr[1] = grey(`Total Budget : ${dollars(budgetAll)}`); tr[2] = grey('', true, 11)
  tr[3] = { userEnteredFormat: fmt({ horizontalAlignment: 'RIGHT' }, { bold: true, fontSize: 11, foregroundColor: NAVY }) }
  tr[4] = txt('Total:', fmt({ backgroundColor: LIGHT, horizontalAlignment: 'LEFT' }, { fontSize: 16, foregroundColor: BLACK }))
  const sumHeaders = c => `=SUM(${headerRows.map(r => `${colLetter(c)}${r}`).join(',')})`
  months.forEach((_, k) => {
    tr[budgetCol(k)] = formula(sumHeaders(budgetCol(k)), fmt({ numberFormat: MONEY, horizontalAlignment: 'RIGHT', ...(k === 0 ? { backgroundColor: LIGHT } : {}) }, { fontSize: k === 0 ? 13 : 12, foregroundColor: BLACK }))
    tr[realCol(k)] = formula(sumHeaders(realCol(k)), fmt({ numberFormat: MONEY, horizontalAlignment: 'RIGHT', backgroundColor: YELLOW }, { fontSize: k === 0 ? 13 : 12, foregroundColor: BLACK }))
  })
  tr[TOTAL_B] = formula(sumHeaders(TOTAL_B), fmt({ numberFormat: MONEY, horizontalAlignment: 'RIGHT' }, { fontSize: 16, foregroundColor: BLACK }))
  tr[TOTAL_R] = formula(sumHeaders(TOTAL_R), fmt({ numberFormat: MONEY, horizontalAlignment: 'RIGHT', backgroundColor: YELLOW }, { fontSize: 16, foregroundColor: BLACK }))
  rows.push(tr); heights.push(51)
  return { rows, heights, merges }
}

// Rangées par compte : lignes détaillées (budget + réel saisis), fournisseurs
// des dépenses validées (même nom → même rangée), et budget du compte sans nom.
function linesFor(months) {
  const [first, last] = [months[0], months[months.length - 1]]
  const out = {}
  const line = (acctnum, name) => {
    const list = (out[acctnum] ||= [])
    let v = list.find(x => x.vendor.toLowerCase() === name.trim().toLowerCase())
    if (!v) { v = { vendor: name.trim(), budget: {}, real: {} }; list.push(v) }
    return v
  }
  const add = (o, m, n) => { if (n) o[m] = Math.round(((o[m] || 0) + n) * 100) / 100 }
  for (const i of db.prepare(`
    SELECT acctnum, label, month, budget, real FROM marketing_budget_items
    WHERE deleted_at IS NULL AND month BETWEEN ? AND ? ORDER BY created_at, rowid
  `).all(first, last)) { const v = line(i.acctnum, i.label); add(v.budget, i.month, i.budget); add(v.real, i.month, i.real) }
  for (const r of db.prepare(`
    SELECT acctnum, COALESCE(NULLIF(TRIM(vendor), ''), 'Sans fournisseur') AS vendor,
           substr(txn_date, 1, 7) AS month, SUM(amount) AS total
    FROM marketing_expenses
    WHERE status='relevant' AND deleted_at IS NULL AND substr(txn_date, 1, 7) BETWEEN ? AND ?
    GROUP BY acctnum, vendor, month ORDER BY MIN(txn_date)
  `).all(first, last)) add(line(r.acctnum, r.vendor).real, r.month, r.total)
  for (const b of db.prepare(`
    SELECT acctnum, month, budget FROM marketing_budget_lines WHERE deleted_at IS NULL AND month BETWEEN ? AND ?
  `).all(first, last)) add(line(b.acctnum, '').budget, b.month, b.budget)
  return out
}

// Années financières à tenir : de celle de start_date à celle d'aujourd'hui.
export function fiscalYearsToMirror(startDate, today) {
  const fyOf = d => (Number(d.slice(5, 7)) >= 4 ? Number(d.slice(0, 4)) : Number(d.slice(0, 4)) - 1)
  const out = []
  for (let y = fyOf(startDate); y <= fyOf(today); y++) out.push(String(y))
  return out
}
export const fyTabTitle = fy => `${fy} Réel`

async function writeFyTab(sheets, spreadsheetId, existing, fy) {
  const title = fyTabTitle(fy)
  let sheetId = existing.find(s => s.properties.title === title)?.properties.sheetId
  if (sheetId == null) {
    const res = await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addSheet: { properties: { title } } }] } })
    sheetId = res.data.replies[0].addSheet.properties.sheetId
  }
  const months = fiscalMonths(fy)
  const byAcct = linesFor(months)
  const { rows, heights, merges } = buildFyGrid(months, SHEET_BLOCKS.map(b => ({ ...b, lines: byAcct[b.acctnum] || [] })))
  const nRows = Math.max(rows.length + 5, 40)
  const widths = [17, 145, 15, 15, 174, ...Array(24).fill(64), 113, 113]
  const requests = [
    { updateSheetProperties: { properties: { sheetId, gridProperties: { rowCount: nRows, columnCount: NCOLS, frozenRowCount: 2, frozenColumnCount: 0 } }, fields: 'gridProperties(rowCount,columnCount,frozenRowCount,frozenColumnCount)' } },
    { unmergeCells: { range: { sheetId } } },
    { updateCells: { range: { sheetId, startRowIndex: 0, endRowIndex: nRows, startColumnIndex: 0, endColumnIndex: NCOLS },
      rows: rows.map(values => ({ values })), fields: 'userEnteredValue,userEnteredFormat' } },
    ...merges.map(([r0, c0, r1, c1]) => ({ mergeCells: { range: { sheetId, startRowIndex: r0, endRowIndex: r1, startColumnIndex: c0, endColumnIndex: c1 }, mergeType: 'MERGE_ALL' } })),
    ...widths.map((px, i) => ({ updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: i, endIndex: i + 1 }, properties: { pixelSize: px }, fields: 'pixelSize' } })),
    ...heights.map((px, i) => ({ updateDimensionProperties: { range: { sheetId, dimension: 'ROWS', startIndex: i, endIndex: i + 1 }, properties: { pixelSize: px }, fields: 'pixelSize' } })),
  ]
  await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } })
  return title
}

// Onglets d'avant Boréal (« Expenses (Révisé Sept 2024) », « 2025 ») : copiés
// tels quels de l'ancien fichier une seule fois, puis laissés en paix.
const ORIGINAL_FILE = '1T7SJrnb4Wipxq-uxUtL_AtTdFfCXrc68wZTBds4es80'
const STATIC_TABS = ['Expenses (Révisé Sept 2024)', '2025']
async function copyStaticTabs(sheets, spreadsheetId, existing) {
  const missing = STATIC_TABS.filter(t => !existing.some(s => s.properties.title === t))
  if (!missing.length) return []
  const src = await sheets.spreadsheets.get({ spreadsheetId: ORIGINAL_FILE, fields: 'sheets(properties(sheetId,title))' })
  const copied = []
  for (const t of missing) {
    const s = src.data.sheets.find(x => x.properties.title === t)
    if (!s) continue
    const res = await sheets.spreadsheets.sheets.copyTo({ spreadsheetId: ORIGINAL_FILE, sheetId: s.properties.sheetId, requestBody: { destinationSpreadsheetId: spreadsheetId } })
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ updateSheetProperties: { properties: { sheetId: res.data.sheetId, title: t }, fields: 'title' } }] } })
    copied.push(t)
  }
  return copied
}

// Réécrit le fichier. `force` ignore l'interrupteur de l'automation (bouton).
export async function mirrorMarketingBudgetSheet({ trigger = 'auto', force = false } = {}) {
  const t0 = Date.now()
  try {
    if (!force && !isSystemAutomationActive(MARKETING_SHEET_AUTOMATION_ID)) return { skipped: 'inactive' }
    const cfg = getMarketingSheetConfig()
    const accountId = googleAccountId(cfg.google_account_email)
    if (!accountId) throw new Error(`Compte Google ${cfg.google_account_email} non connecté (page Connecteurs)`)
    const sheets = await getSheetsClient(accountId)
    let spreadsheetId = cfg.spreadsheet_id
    let created = false
    if (!spreadsheetId) {
      const res = await sheets.spreadsheets.create({ requestBody: { properties: { title: cfg.title, locale: 'en_US', timeZone: 'America/New_York' } } })
      spreadsheetId = res.data.spreadsheetId
      saveSpreadsheetId(spreadsheetId)
      created = true
    }
    const meta = await sheets.spreadsheets.get({ spreadsheetId, fields: 'properties(title),sheets(properties(sheetId,title))' })
    // Même nom et même locale que l'ancien fichier ($3,000 et non 3 000 $).
    await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ updateSpreadsheetProperties: {
      properties: { title: cfg.title, locale: 'en_US', timeZone: 'America/New_York' }, fields: 'title,locale,timeZone' } }] } })
    const existing = meta.data.sheets || []
    const copied = await copyStaticTabs(sheets, spreadsheetId, existing)
    // Depuis la plus ancienne donnée : le fichier annuel remonte avant la lecture QB.
    const oldest = db.prepare('SELECT MIN(month) AS m FROM marketing_budget_items WHERE deleted_at IS NULL').get()?.m
    const start = [getMarketingSyncConfig().start_date, oldest && `${oldest}-01`].filter(Boolean).sort()[0]
    const fys = fiscalYearsToMirror(start, localDay())
    const tabs = []
    for (const fy of fys) tabs.push(await writeFyTab(sheets, spreadsheetId, existing, fy))
    // Ordre de l'ancien fichier ; la feuille vide de création et les onglets de
    // l'ancienne mise en page (« 2026-27 ») disparaissent.
    const now = (await sheets.spreadsheets.get({ spreadsheetId, fields: 'sheets(properties(sheetId,title))' })).data.sheets
    const order = [...STATIC_TABS, ...tabs]
    const requests = []
    for (const sh of now) {
      const t = sh.properties.title
      if (/^\d{4}-\d{2}$/.test(t) || /^(Feuille|Sheet) ?1$/.test(t)) requests.push({ deleteSheet: { sheetId: sh.properties.sheetId } })
    }
    order.forEach((t, index) => {
      const sh = now.find(x => x.properties.title === t)
      if (sh) requests.push({ updateSheetProperties: { properties: { sheetId: sh.properties.sheetId, index }, fields: 'index' } })
    })
    if (requests.length) await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } })
    const result = `${created ? 'Fichier créé · ' : ''}${copied.length ? `onglets copiés : ${copied.join(', ')} · ` : ''}onglet(s) ${tabs.join(', ')} réécrit(s) · ${sheetUrl(spreadsheetId)}`
    logSystemRun(MARKETING_SHEET_AUTOMATION_ID, { status: 'success', duration_ms: Date.now() - t0, triggerData: { trigger }, result })
    return { ok: true, spreadsheet_id: spreadsheetId, url: sheetUrl(spreadsheetId), tabs, result }
  } catch (e) {
    logSystemRun(MARKETING_SHEET_AUTOMATION_ID, { status: 'error', duration_ms: Date.now() - t0, triggerData: { trigger }, error: e })
    console.error('marketing budget sheet:', e.message)
    return { error: e.message }
  }
}

// Plusieurs clics de tri d'affilée → un seul passage, 5 s après le dernier.
let timer = null
export function scheduleMarketingSheetMirror(trigger = 'changement') {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { timer = null; mirrorMarketingBudgetSheet({ trigger }).catch(() => {}) }, 5000)
  timer.unref?.()
}

