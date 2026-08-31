// Synchronisation automatique du fichier TRX_Orisha.xlsx (Drive) vers le
// rapprochement bancaire de l'ERP.
//
// L'utilisateur colle les relevés de ses 11 comptes dans ce fichier (un onglet
// par compte, les lignes récentes en haut). Cette sync lit le fichier toutes
// les heures, importe les transactions nouvelles dans bank_transactions (mêmes
// tables que l'import par collage de /rapprochement), relance le matching
// automatique et la liaison QuickBooks, puis AUDITE chaque compte contre le
// grand livre QB : toute transaction du relevé sans écriture QB (et
// inversement) devient une anomalie, avec une tentative d'explication
// (décalage de date, écart de montant ≈ frais/conversion, doublon possible,
// facture manquante). Les nouvelles anomalies sont alertées sur Slack.
//
// L'historique (2024 → juillet 2026) a été importé avant cette sync avec des
// descriptions parfois composées différemment : la déduplication de la fenêtre
// de chevauchement se fait donc par (date, montant signé) et non par libellé —
// voir planImportFromCounts.
import xlsx from 'xlsx'
import db from '../db/database.js'
import { getDriveClient } from '../connectors/google.js'
import { logSync } from './syncLog.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'
import { importTransactions, autoMatchAccount, refreshStatuses, parseAmount } from './bankReconciliation.js'
import { buildLedgerIndex, searchAccount, persistMatches, verifyConversions, MATCH_LABELS } from './bankQbSearch.js'
import { sendSlackWebhook } from './slack.js'
import { shiftDate, daysBetween as dayDiff } from '../utils/datetime.js'

export const TRX_SHEET_AUTOMATION_ID = 'sys_bank_trx_sheet'

export const TRX_SHEET_DEFAULT_CONFIG = {
  file_id: '1fRE0c1zv5zks70pwzgpojB7LZz-V5lHR', // TRX_Orisha.xlsx
  google_account_email: 'michel@orisha.io',
  // Plancher d'import : jamais de ligne avant cette date (l'historique du
  // fichier est déjà en base, importé en 2026 avec un autre formatage).
  since_date: '2026-07-01',
  // Fenêtre re-scannée avant la dernière transaction connue de chaque compte
  // (les banques ajoutent parfois des lignes antidatées).
  overlap_days: '7',
  // Une ligne « à traiter » plus vieille que ça devient une anomalie
  // « sans document » (facture probablement manquante).
  anomaly_age_days: '7',
  // Fenêtre de l'audit croisé relevé ↔ grand livre QuickBooks.
  audit_window_days: '45',
  // Délai de grâce avant de déclarer un écart relevé ↔ QB (le temps normal de
  // comptabilisation d'une transaction fraîche).
  audit_grace_days: '4',
  // AUCUNE alerte Slack par défaut (demande utilisateur du 11 août 2026) : le
  // rapprochement bancaire ne doit rien envoyer dans le canal comptabilité. Les
  // anomalies restent visibles sur la page Rapprochement bancaire et dans le
  // journal de l'automation. Mettre à '1' pour réactiver l'envoi.
  slack_anomalies: '0',
  slack_webhook_env: 'SLACK_WEBHOOK_TREASURY',
}

export function getTrxSheetConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get(TRX_SHEET_AUTOMATION_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch {}
  const merged = { ...TRX_SHEET_DEFAULT_CONFIG }
  for (const k of Object.keys(TRX_SHEET_DEFAULT_CONFIG)) {
    if (cfg[k] != null && String(cfg[k]).trim() !== '') merged[k] = String(cfg[k]).trim()
  }
  return merged
}

// ── Onglets du fichier → comptes ERP ─────────────────────────────────────────

// invert : les relevés Visa Desjardins notent les achats en positif ; l'ERP
// suit l'argent (sortie = négatif), comme l'historique déjà importé.
const TAB_SPECS = {
  'bnc cad': { account: 'BNC CAD' },
  'bnc usd': { account: 'BNC USD' },
  'bnc epargne': { account: 'BNC Épargne' },
  'mastercard': { account: 'MasterCard BNC' },
  'desj cad': { account: 'Desjardins CAD' },
  'desj usd': { account: 'Desjardins USD' },
  'marge desj': { account: 'Marge Desjardins' },
  'visa cad': { account: 'VISA Desjardins CAD', invert: true },
  'visa usd': { account: 'VISA Desjardins USD', invert: true },
  'venn usd': { account: 'Venn USD' },
  'venn cad': { account: 'Venn CAD' },
}

const strip = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

export function specForTab(tabName) {
  return TAB_SPECS[strip(tabName)] || null
}

// ── Couleurs du fichier = statut déclaré à la main ───────────────────────────
//
// Légende reprise telle quelle des onglets (« Factures retracées »,
// « Comptabilisées », « Rapprochées avec la banque », « Pas encore ctb ») :
// c'est Michel qui colorie, et sa couleur fait autorité sur ce que l'ERP
// arrive à déduire tout seul. Les deux autres couleurs de la légende
// (CC0000 « Trx non révisée », FF9900 « Rendu à cette trx ») sont des repères
// de lecture, pas des statuts — volontairement absentes.
export const SHEET_COLORS = {
  '92D050': 'vert',   // comptabilisée ET rapprochée avec la banque
  'FFFF00': 'jaune',  // comptabilisée, pas encore rapprochée
  '00B0F0': 'bleu',   // facture retracée, pas encore comptabilisée
  'F7CAAC': 'rouge',  // pas encore comptabilisée
  'E6B8AF': 'rouge',
  'F4CCCC': 'rouge',
}

export const SHEET_COLOR_LABELS = {
  vert: 'Rapprochée avec la banque (fichier)',
  jaune: 'Comptabilisée (fichier)',
  bleu: 'Facture retracée (fichier)',
  rouge: 'Pas encore comptabilisée (fichier)',
}

// Une couleur verte ou jaune est une affirmation : « c'est dans QuickBooks ».
export const COLOR_MEANS_IN_QB = new Set(['vert', 'jaune'])

// Accès aux remplissages d'un onglet, indexé comme la grille de
// sheet_to_json({header:1}) — même origine (coin haut-gauche de !ref).
export function colorReader(sheet) {
  if (!sheet || !sheet['!ref']) return () => null
  const range = xlsx.utils.decode_range(sheet['!ref'])
  return (r, c) => {
    const cell = sheet[xlsx.utils.encode_cell({ r: range.s.r + r, c: range.s.c + c })]
    if (!cell || cell.s?.patternType !== 'solid') return null
    return SHEET_COLORS[String(cell.s.fgColor?.rgb || '').toUpperCase()] || null
  }
}

// ── Parsing (pur, testable) ──────────────────────────────────────────────────

// Tirets unicode (le site Desjardins produit U+2011) et signes moins → '-',
// puis parseAmount du rapprochement (parenthèses, CR/DB, virgule décimale…).
export function parseTrxAmount(raw) {
  if (raw == null) return null
  return parseAmount(String(raw).replace(/[‐-―−]/g, '-').replace(/^\s*\+/, ''))
}

const MONTHS = {
  jan: 1, janv: 1, fev: 2, feb: 2, mar: 3, mars: 3, avr: 4, apr: 4, mai: 5, may: 5,
  jun: 6, juin: 6, jul: 7, juil: 7, aou: 8, aug: 8, sep: 9, sept: 9, oct: 10,
  nov: 11, dec: 12,
}
const pad2 = (n) => String(n).padStart(2, '0')

function monthFromWord(word) {
  const key = strip(word).replace(/\./g, '')
  return MONTHS[key] || MONTHS[key.slice(0, 4)] || MONTHS[key.slice(0, 3)] || null
}

// Une date de relevé porte-t-elle son année ? Les relevés Desjardins n'en ont
// pas (« 18 AOÛ18 Août ») — et un onglet descend sur PLUSIEURS années.
export function hasExplicitYear(raw) {
  const s = strip(raw)
  return /^\d{4}-/.test(s) || /(?:^|\D)(?:19|20)\d{2}(?:\D|$)/.test(s)
}

// Un relevé décrit le passé : sans année explicite (« 3 AOÛ3 Août » de
// Desjardins), on prend l'année la plus récente qui ne place pas la date dans
// le futur (tolérance de 7 jours pour les autorisations de carte).
function inferYear(month, day, todayIso) {
  const year = Number(todayIso.slice(0, 4))
  const candidate = `${year}-${pad2(month)}-${pad2(day)}`
  const limit = shiftDate(todayIso, 7)
  return candidate <= limit ? candidate : `${year - 1}-${pad2(month)}-${pad2(day)}`
}

// Formats rencontrés dans le fichier : ISO, « 8/1/2026 » (Visa USD, mois/jour)
// vs « 01/08/2026 » (jour/mois) — départagés par le vote de l'onglet —,
// « 3 AOÛ 2026 », « 3 AOÛ3 Août » (Desjardins, sans année), « 29 Apr, 2025 ».
export function parseTrxDate(raw, { todayIso, monthFirst = false } = {}) {
  const s = strip(raw)
  if (!s) return null
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s)
  if (m) return `${m[1]}-${pad2(m[2])}-${pad2(m[3])}`
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/.exec(s)
  if (m) {
    const a = Number(m[1]); const b = Number(m[2]); const y = m[3]
    let day; let month
    if (a > 12) { day = a; month = b } // sans ambiguïté
    else if (b > 12) { day = b; month = a }
    else if (monthFirst) { month = a; day = b }
    else { day = a; month = b }
    if (month < 1 || month > 12 || day < 1 || day > 31) return null
    return `${y}-${pad2(month)}-${pad2(day)}`
  }
  // « 3 aou… » / « 29 apr, 2025 » — le mot de mois s'arrête au premier chiffre
  // (« 3 aou3 aout » → « aou »).
  m = /^(\d{1,2})(?:er)?\s*([a-z]{3,10})/.exec(s)
  let day = null; let month = null
  if (m) { day = Number(m[1]); month = monthFromWord(m[2]) }
  if (!month) {
    m = /^([a-z]{3,10})\.?\s+(\d{1,2})/.exec(s)
    if (m) { month = monthFromWord(m[1]); day = Number(m[2]) }
  }
  if (!month || !day || day < 1 || day > 31) return null
  const y = /(?:^|\D)((?:19|20)\d{2})(?:\D|$)/.exec(s.slice(String(day).length))
  if (y) return `${y[1]}-${pad2(month)}-${pad2(day)}`
  return inferYear(month, day, todayIso || new Date().toISOString().slice(0, 10))
}

// Détection de la ligne d'entêtes : une cellule « date » + une cellule de
// montant. On garde la DERNIÈRE candidate du haut de l'onglet — plusieurs
// onglets traînent une ancienne ligne d'entêtes au-dessus de la vraie.
const MONEY_HEADER = /(^|\W)(montant|amount|retrait|depot|debit|credit|avance)/
function findHeader(rows) {
  let found = -1
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const cells = Array.from(rows[i] || [], strip)
    if (cells.some((c) => /^date/.test(c)) && cells.some((c) => MONEY_HEADER.test(c))) found = i
  }
  return found
}

function mapColumns(headerCells) {
  const cols = {}
  headerCells.forEach((raw, i) => {
    const c = strip(raw)
    if (!c) return
    if (cols.date == null && /^date/.test(c)) cols.date = i
    if (cols.description == null && /description/.test(c)) cols.description = i
    // BNC : « Autres détails » porte la nature réelle (« NOVO EXPRESS ») là où
    // « Description » reste générique (« PMTS ENTREPRISES »).
    if (cols.details == null && /autres? *details?/.test(c)) cols.details = i
    if (cols.category == null && /categorie/.test(c)) cols.category = i
    if (cols.reference == null && /reference|numero de transaction|no ref/.test(c)) cols.reference = i
    if (cols.type == null && /transaction type|^type/.test(c)) cols.type = i
    if (cols.status == null && /^statu[st]/.test(c)) cols.status = i
    if (cols.debit == null && /^(retrait|debit)/.test(c)) cols.debit = i
    if (cols.credit == null && /^(depot|credit)/.test(c)) cols.credit = i
    if (cols.amount == null && /^(montant|amount)/.test(c)) cols.amount = i
    if (cols.interest == null && /^interet/.test(c)) cols.interest = i
    if (cols.advance == null && /^avance/.test(c)) cols.advance = i
    if (cols.remb == null && /^remb/.test(c)) cols.remb = i
    if (cols.balance == null && /^(solde|balance)/.test(c)) cols.balance = i
  })
  if (cols.description == null && cols.category != null) cols.description = cols.category
  return cols
}

// Montant signé d'une ligne : négatif = argent qui sort du compte.
function rowAmount(row, cols, spec) {
  let amount = null
  if (cols.interest != null || cols.advance != null || cols.remb != null) {
    // Marge de crédit : intérêts et avances augmentent le solde utilisé (+),
    // les remboursements le réduisent (−) — même convention que l'historique.
    const interest = cols.interest != null ? parseTrxAmount(row[cols.interest]) : null
    const advance = cols.advance != null ? parseTrxAmount(row[cols.advance]) : null
    const remb = cols.remb != null ? parseTrxAmount(row[cols.remb]) : null
    if (interest == null && advance == null && remb == null) return null
    amount = (interest || 0) + (advance || 0) - Math.abs(remb || 0)
  } else if (cols.amount != null && parseTrxAmount(row[cols.amount]) != null) {
    amount = parseTrxAmount(row[cols.amount])
  } else {
    const debit = cols.debit != null ? parseTrxAmount(row[cols.debit]) : null
    const credit = cols.credit != null ? parseTrxAmount(row[cols.credit]) : null
    if (debit == null && credit == null) return null
    amount = (credit != null ? Math.abs(credit) : 0) - (debit != null ? Math.abs(debit) : 0)
  }
  if (amount == null || amount === 0) return null
  if (spec?.invert) amount = -amount
  return Math.round(amount * 100) / 100
}

// Couleur d'une ligne : celle de la cellule du MONTANT (c'est elle que Michel
// colorie), à défaut celle d'une autre colonne de données. On ne regarde que
// les colonnes cartographiées — la légende et les blocs de notes vivent dans
// les colonnes de droite et coloreraient toutes les lignes en vert.
function rowColor(colorAt, rowIdx, cols) {
  const money = ['amount', 'debit', 'credit', 'interest', 'advance', 'remb']
  const rest = ['date', 'description', 'details', 'balance', 'reference']
  for (const group of [money, rest]) {
    for (const key of group) {
      if (cols[key] == null) continue
      const color = colorAt(rowIdx, cols[key])
      if (color) return color
    }
  }
  return null
}

// Ancrage de l'année sur la ligne PRÉCÉDENTE.
//
// Sans ça, « 18 AOÛ » lu au milieu d'un onglet qui descend jusqu'en 2025 était
// daté de l'année en cours : douze lignes de juillet-août 2025 (dont deux
// réceptions EDI de 100 000 $ et 50 000 $) se sont retrouvées dupliquées en
// 2026, introuvables dans QuickBooks — c'était l'intégralité des anomalies
// restantes du 22 août 2026. Un relevé est trié chronologiquement : dès que la
// date sort de l'ordre du tableau, elle appartient à l'année précédente (ou
// suivante si l'onglet monte).
function anchorYear(iso, prev, descending) {
  if (!prev) return iso
  let out = iso
  for (let i = 0; i < 3; i++) {
    if (descending ? out <= prev : out >= prev) break
    const y = Number(out.slice(0, 4)) + (descending ? -1 : 1)
    out = `${y}${out.slice(4)}`
  }
  return out
}

// Sens de lecture de l'onglet, voté sur les dates naïvement parsées : les
// relevés collés sont tantôt du plus récent au plus ancien, tantôt l'inverse.
function tabDescending(dates) {
  let down = 0
  let up = 0
  for (let i = 1; i < dates.length; i++) {
    if (dates[i] === dates[i - 1]) continue
    if (dates[i] < dates[i - 1]) down++
    else up++
  }
  return down >= up
}

// Grille d'un onglet → { rows, warnings }. rows : { txn_date, description,
// details, reference, amount, balance }, dans l'ordre du fichier
// (récent → ancien).
export function parseTrxTab(rows, spec, { todayIso, colorAt } = {}) {
  const today = todayIso || new Date().toISOString().slice(0, 10)
  const headerIdx = findHeader(rows)
  if (headerIdx < 0) return { rows: [], warnings: ['ligne d\'entêtes introuvable'] }
  const cols = mapColumns(Array.from(rows[headerIdx] || []))
  if (cols.date == null) return { rows: [], warnings: ['colonne date introuvable'] }

  // Vote jour/mois vs mois/jour sur les dates numériques ambiguës de l'onglet
  // (Visa USD est en « 7/27/2026 », les autres en jour/mois).
  let dayVotes = 0; let monthVotes = 0
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const m = /^(\d{1,2})[/-](\d{1,2})[/-]\d{4}/.exec(strip((rows[r] || [])[cols.date]))
    if (!m) continue
    if (Number(m[1]) > 12) dayVotes++
    else if (Number(m[2]) > 12) monthVotes++
  }
  const monthFirst = monthVotes > dayVotes

  // Premier passage : dates naïves, uniquement pour connaître le sens de
  // l'onglet (récent → ancien, ou l'inverse).
  const naive = []
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const d = parseTrxDate((rows[r] || [])[cols.date], { todayIso: today, monthFirst })
    if (d) naive.push(d)
  }
  const descending = tabDescending(naive)

  const out = []
  const warnings = []
  let prevDate = null
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r] || []
    let txnDate = parseTrxDate(row[cols.date], { todayIso: today, monthFirst })
    if (!txnDate) continue // ligne vide, note, sous-entête…
    // L'année n'est ancrée que quand le relevé ne la donne pas.
    if (!hasExplicitYear(row[cols.date])) txnDate = anchorYear(txnDate, prevDate, descending)
    prevDate = txnDate
    const amount = rowAmount(row, cols, spec)
    if (amount == null) {
      if (warnings.length < 8) warnings.push(`ligne ${r + 1} : date ${txnDate} mais montant illisible`)
      continue
    }
    let description = String(row[cols.description] ?? '').trim()
    // Onglets Venn : Description + Transaction Type (+ Status si non complété),
    // comme l'historique déjà en base (« STRIPE — Inbound Transfer »).
    if (cols.type != null) {
      const type = String(row[cols.type] ?? '').trim()
      if (type && strip(type) !== strip(description)) description = description ? `${description} — ${type}` : type
      const status = String(row[cols.status] ?? '').trim()
      if (status && !/^complete/i.test(strip(status))) description += ` — ${status}`
    }
    out.push({
      txn_date: txnDate,
      sheet_color: colorAt ? rowColor(colorAt, r, cols) : null,
      description: description || null,
      details: cols.details != null ? (String(row[cols.details] ?? '').trim() || null) : null,
      reference: cols.reference != null ? (String(row[cols.reference] ?? '').trim() || null) : null,
      amount,
      balance: cols.balance != null ? parseTrxAmount(row[cols.balance]) : null,
    })
  }
  return { rows: out, warnings }
}

// ── Plan d'import (dédup tolérante sur la fenêtre de chevauchement) ─────────

// L'historique en base vient d'imports antérieurs aux libellés parfois
// composés autrement : on ne peut pas dédupliquer par description. Signature =
// (date, montant signé) ; si le fichier a N occurrences d'une signature et la
// base M, seules les N−M dernières sont importées. Pur — testé isolément.
export function planImportFromCounts(sheetRows, existingCounts, { maxDate = null } = {}) {
  const seen = new Map()
  const toInsert = []
  let skipped = 0
  for (const row of sheetRows) {
    // Une ligne datée dans le futur est un paiement programmé (AccèsD) ou un
    // collage en cours : rien n'est encore passé au compte, on n'importe pas.
    if (maxDate && row.txn_date > maxDate) { skipped++; continue }
    const sig = `${row.txn_date}|${row.amount.toFixed(2)}`
    const idx = seen.get(sig) || 0
    seen.set(sig, idx + 1)
    if (idx < (existingCounts.get(sig) || 0)) { skipped++; continue }
    toInsert.push(row)
  }
  return { toInsert, skipped }
}

function planImport(account, parsedRows, cfg) {
  const last = db.prepare(
    'SELECT MAX(txn_date) AS mx FROM bank_transactions WHERE account_id=? AND deleted_at IS NULL'
  ).get(account.id)?.mx || null
  const overlap = Number(cfg.overlap_days) || 7
  let since = cfg.since_date
  if (last && shiftDate(last, -overlap) > since) since = shiftDate(last, -overlap)
  const recent = parsedRows.filter((r) => r.txn_date >= since)
  // Les lignes soft-deleted comptent : une transaction supprimée à la main ne
  // doit pas ressusciter à chaque sync.
  const existing = new Map(
    db.prepare(`
      SELECT txn_date || '|' || printf('%.2f', amount) AS sig, COUNT(*) AS n
      FROM bank_transactions WHERE account_id=? AND txn_date >= ? GROUP BY sig
    `).all(account.id, since).map((r) => [r.sig, r.n])
  )
  // Tolérance d'un jour pour les fuseaux (une trx « de demain » vue depuis UTC).
  const maxDate = shiftDate(new Date().toISOString().slice(0, 10), 1)
  const { toInsert, skipped } = planImportFromCounts(recent, existing, { maxDate })
  return { since, considered: recent.length, toInsert, skipped }
}

// Report du fichier vers les transactions déjà en base, apparié par
// (date, montant signé) comme la dédup — une ligne du fichier par transaction,
// dans l'ordre :
//   • « Autres détails », colonne arrivée après l'import de l'historique ;
//   • la COULEUR de la ligne, qui change au fil du temps (Michel repeint une
//     ligne rouge en vert quand il l'a comptabilisée) — donc toujours
//     réécrite, pas seulement quand elle est vide.
function backfillSheetMeta(accountId, parsedRows) {
  const rows = db.prepare(`
    SELECT id, txn_date, amount, details, sheet_color FROM bank_transactions
    WHERE account_id=? AND deleted_at IS NULL
    ORDER BY txn_date, rowid
  `).all(accountId)
  if (!rows.length) return { details: 0, colors: 0 }
  const bySig = new Map()
  for (const t of rows) {
    const sig = `${t.txn_date}|${t.amount.toFixed(2)}`
    if (!bySig.has(sig)) bySig.set(sig, [])
    bySig.get(sig).push(t)
  }
  const updDetails = db.prepare('UPDATE bank_transactions SET details=?, updated_at=? WHERE id=?')
  const updColor = db.prepare('UPDATE bank_transactions SET sheet_color=?, updated_at=? WHERE id=?')
  const now = new Date().toISOString()
  let details = 0
  let colors = 0
  const tx = db.transaction(() => {
    for (const row of parsedRows) {
      const queue = bySig.get(`${row.txn_date}|${row.amount.toFixed(2)}`)
      if (!queue?.length) continue
      const t = queue.shift()
      if (row.details && !t.details) { updDetails.run(row.details, now, t.id); details++ }
      if ((row.sheet_color || null) !== (t.sheet_color || null)) {
        updColor.run(row.sheet_color || null, now, t.id)
        colors++
      }
    }
  })
  tx()
  return { details, colors }
}

// ── Lecture du fichier ───────────────────────────────────────────────────────

async function fetchWorkbook(cfg) {
  const acc = cfg.google_account_email
    ? db.prepare("SELECT id FROM connector_oauth WHERE connector='google' AND account_email=?").get(cfg.google_account_email)
    : db.prepare("SELECT id FROM connector_oauth WHERE connector='google' ORDER BY updated_at DESC LIMIT 1").get()
  if (!acc) throw new Error(`Compte Google ${cfg.google_account_email || ''} non connecté (page Connecteurs)`)
  const drive = await getDriveClient(acc.id)
  // TRX_Orisha est un vrai .xlsx dans le Drive (pas un Google Sheet) : on le
  // télécharge tel quel ; si le fichier est un jour converti en Sheet, on
  // retombe sur l'export.
  let buffer
  try {
    const res = await drive.files.get({ fileId: cfg.file_id, alt: 'media' }, { responseType: 'arraybuffer' })
    buffer = Buffer.from(res.data)
  } catch (e) {
    if (!/only files with binary content|fileNotDownloadable|Use Export/i.test(String(e.message))) throw e
    const res = await drive.files.export(
      { fileId: cfg.file_id, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
      { responseType: 'arraybuffer' },
    )
    buffer = Buffer.from(res.data)
  }
  // cellStyles : le fichier code le statut de chaque ligne par la COULEUR de la
  // cellule du montant (voir SHEET_COLORS) — c'est la seule source de vérité sur
  // ce que Michel a réellement comptabilisé et rapproché.
  return xlsx.read(buffer, { type: 'buffer', cellStyles: true })
}

// ── Audit relevé ↔ grand livre QuickBooks ────────────────────────────────────
//
// L'audit ne dit plus « absente de QuickBooks » dès qu'un appariement naïf
// échoue : il passe par la recherche approfondie (bankQbSearch.js) puis lit la
// COULEUR posée dans le fichier pour décider si l'écart est une anomalie ou du
// travail en cours :
//
//   vert / jaune introuvable dans QB → ANOMALIE (contradiction : Michel
//     affirme que c'est comptabilisé, l'écriture est introuvable) ;
//   bleu / rouge / sans couleur introuvable → « à comptabiliser » : l'état de
//     travail normal, listé à part et jamais alerté ;
//   écriture QB compensée (is_cleared C/R) absente du relevé → ANOMALIE (QB
//     dit que l'argent est passé à la banque, le relevé ne le montre pas) ;
//   écriture QB non compensée absente du relevé → chèque non encaissé ou
//     paiement post-daté : normal, ignoré.

const fmt = (n) => `${Number(n).toFixed(2)} $`

// Explication d'une ligne de relevé introuvable : on cherche ce qui S'EN
// APPROCHE dans le grand livre pour donner une piste plutôt qu'un constat.
function explainMissingBank(txn, unmatchedQb) {
  const near = unmatchedQb
    .map((e) => ({ e, gap: dayDiff(txn.txn_date, e.date), diff: Math.abs(Math.abs(e.amount) - Math.abs(txn.amount)) }))
    .sort((a, b) => (a.diff - b.diff) || (a.gap - b.gap))[0]
  if (near && near.diff < 0.011) {
    return `Écriture QB au même montant le ${near.e.date}, à ${Math.round(near.gap)} j — trop loin pour être appariée automatiquement : même transaction avec une date erronée d'un côté, ou vraie écriture manquante`
  }
  if (near && near.diff <= Math.max(5, Math.abs(txn.amount) * 0.05)) {
    return `Écriture QB de ${fmt(near.e.amount)} le ${near.e.date}${near.e.name ? ` (${near.e.name})` : ''} — ${fmt(near.diff)} d'écart, frais ou conversion ?`
  }
  if (txn.sheet_color === 'vert') {
    return 'Marquée « rapprochée avec la banque » dans le fichier, mais aucune écriture QuickBooks ne correspond — sur ce compte ni sur les autres, à ±30 jours, montant exact ou approché'
  }
  return 'Marquée « comptabilisée » dans le fichier, mais aucune écriture QuickBooks ne correspond'
}

function explainMissingQb(entry, unmatchedBank) {
  const near = unmatchedBank
    .map((t) => ({ t, gap: dayDiff(t.txn_date, entry.date), diff: Math.abs(Math.abs(t.amount) - Math.abs(entry.amount)) }))
    .sort((a, b) => (a.diff - b.diff) || (a.gap - b.gap))[0]
  if (near && near.diff < 0.011) {
    return `Ligne de relevé au même montant le ${near.t.txn_date} — même transaction, date à corriger d'un côté`
  }
  return 'QuickBooks la dit passée à la banque (compensée) mais elle n\'apparaît pas au relevé — mauvais compte, ou compensée à tort dans QuickBooks'
}

function clearStaleLinks(unmatchedBank) {
  const stale = unmatchedBank.filter((t) => !t.virtual && t.qb_txn_id)
  if (!stale.length) return 0
  const clear = db.prepare(`
    UPDATE bank_transactions
    SET qb_txn_type=NULL, qb_txn_id=NULL, qb_match_method=NULL, qb_match_delta=NULL,
        qb_match_account=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id=?
  `)
  db.transaction(() => { for (const t of stale) clear.run(t.id) })()
  return stale.length
}

// Audit d'un compte contre l'index de grand livre partagé.
// `extraTxns` : lignes du fichier pas encore importées (mode simulation).
export async function auditAccountVsQb(account, cfg, { index, extraTxns = [], apply = false } = {}) {
  const todayIso = new Date().toISOString().slice(0, 10)
  const windowDays = Number(cfg.audit_window_days) || 45
  const graceDays = Number(cfg.audit_grace_days) || 4
  const from = shiftDate(todayIso, -windowDays)
  const cutoff = shiftDate(todayIso, -graceDays)

  const bankTxns = db.prepare(`
    SELECT id, txn_date, COALESCE(NULLIF(details,''), description) AS description, details, reference,
           amount, status, matched_id, sheet_color, qb_txn_id
    FROM bank_transactions
    WHERE account_id=? AND deleted_at IS NULL AND status != 'ignore' AND txn_date >= ?
    ORDER BY txn_date
  `).all(account.id, from)
  extraTxns.forEach((r, i) => {
    if (r.txn_date >= from) {
      bankTxns.push({
        id: `à-importer-${i}`, txn_date: r.txn_date, description: r.details || r.description,
        details: r.details, reference: r.reference, amount: r.amount, status: 'a_traiter',
        matched_id: null, sheet_color: r.sheet_color || null, qb_txn_id: null, virtual: true,
      })
    }
  })

  const { matches, unmatchedBank, unmatchedQb } = searchAccount(account, bankTxns, index)
  // Une conversion de devise n'est retenue comme telle qu'après vérification du
  // taux sur la transaction QuickBooks elle-même.
  await verifyConversions(matches, new Map(bankTxns.map((t) => [t.id, t])))
  let linked = 0
  if (apply) {
    linked = persistMatches(new Map([...matches].filter(([id]) => !String(id).startsWith('à-importer-'))))
    // Un lien posé par un passage antérieur sur une ligne que la recherche
    // approfondie ne retrouve PLUS pointe vers une écriture supprimée dans QB
    // ou vers un mauvais appariement : on l'efface plutôt que de laisser un
    // lien mort à côté d'une anomalie « introuvable dans QuickBooks ».
    clearStaleLinks(unmatchedBank)
    refreshStatuses(account.id)
  }

  const anomalies = []
  const toBook = []
  const gaps = []

  for (const [txnId, m] of matches) {
    // Une conversion vérifiée n'a pas d'écart : montant × taux retombe sur la
    // ligne de relevé. Rien à signaler, le taux vit sur la transaction.
    if (!m.delta) continue
    const t = bankTxns.find((x) => x.id === txnId)
    gaps.push({
      account_id: account.id, account_name: account.name, txn_id: t.virtual ? null : t.id,
      date: t.txn_date, amount: t.amount, label: t.description || '(sans description)',
      delta: m.delta, rate: m.rate || null, verified: !!m.verified,
      qb_date: m.entries[0].date, qb_name: m.entries[0].name || null,
      qb_entity: m.entries[0].entity || null, qb_id: m.entries[0].qbId || null,
      method: m.method, method_label: MATCH_LABELS[m.method] || m.method,
    })
  }

  // Une ligne introuvable dont la JUMELLE (même montant, ±3 jours, même compte)
  // est appariée, elle, n'est presque jamais une écriture manquante : c'est la
  // même transaction entrée deux fois dans l'ERP (le fichier a été recollé avec
  // une date décalée d'un jour, et la dédup se fait sur date + montant).
  const twinMatched = (t) => bankTxns.some((o) => o.id !== t.id && matches.has(o.id)
    && Math.abs(o.amount - t.amount) < 0.011 && dayDiff(o.txn_date, t.txn_date) <= 3)
  // Aller-retour du même jour : l'argent entre et ressort (réception EDI
  // aussitôt virée à la marge). Si les DEUX jambes manquent, c'est un mouvement
  // de passage, pas deux écritures oubliées.
  const washPair = (t) => unmatchedBank.find((o) => o.id !== t.id
    && Math.abs(o.amount + t.amount) < 0.011 && dayDiff(o.txn_date, t.txn_date) <= 1)

  for (const t of unmatchedBank) {
    if (t.txn_date > cutoff) continue // trop fraîche : délai normal de saisie
    const base = {
      account_id: account.id, account_name: account.name, txn_id: t.virtual ? null : t.id,
      date: t.txn_date, amount: t.amount, label: t.description || '(sans description)',
      sheet_color: t.sheet_color || null,
    }
    if (COLOR_MEANS_IN_QB.has(t.sheet_color)) {
      const wash = washPair(t)
      if (twinMatched(t)) {
        anomalies.push({
          ...base,
          key: `doublon_releve|${account.id}|${t.id}`,
          kind: 'doublon_releve',
          explanation: 'Une ligne du même montant à ±3 jours est, elle, appariée à QuickBooks — cette ligne-ci est probablement le même mouvement saisi deux fois (fichier recollé avec une date décalée). À supprimer ou à ignorer après vérification du solde.',
        })
      } else {
        anomalies.push({
          ...base,
          key: `comptabilisee_introuvable|${account.id}|${t.id}`,
          kind: 'comptabilisee_introuvable',
          explanation: wash
            ? `Aller-retour du même jour avec ${fmt(wash.amount)} (« ${(wash.description || '').slice(0, 40)} ») : aucune des deux jambes n'est dans QuickBooks — mouvement de passage jamais comptabilisé`
            : explainMissingBank(t, unmatchedQb),
        })
      }
    } else {
      toBook.push({
        ...base,
        key: `a_comptabiliser|${account.id}|${t.id}`,
        kind: 'a_comptabiliser',
        age_days: Math.round(dayDiff(todayIso, t.txn_date)),
        explanation: t.sheet_color === 'bleu'
          ? 'Facture retracée dans le fichier, pas encore comptabilisée'
          : (t.matched_id
            ? 'Un document ERP est apparié mais rien dans QuickBooks — document pas encore poussé'
            : 'Pas encore comptabilisée et aucun document ERP apparié'),
      })
    }
  }

  let uncleared = 0
  for (const e of unmatchedQb) {
    // L'index du grand livre déborde volontairement la fenêtre du relevé (pour
    // rattraper les dates décalées) : hors fenêtre, il n'y a tout simplement
    // pas de ligne de relevé chargée à apparier — ce n'est pas un écart.
    if (e.date < from || e.date > cutoff) continue
    // Non compensée = saisie dans QB, jamais vue à la banque (chèque non
    // encaissé, paiement post-daté) : ce n'est pas un écart de rapprochement.
    if (e.cleared !== 'C' && e.cleared !== 'R') { uncleared++; continue }
    anomalies.push({
      key: `qb_sans_releve|${account.id}|${e.entity || e.type}:${e.qbId}|${e.amount.toFixed(2)}`,
      kind: 'qb_sans_releve',
      account_id: account.id,
      account_name: account.name,
      date: e.date,
      amount: e.amount,
      label: `${e.type || 'Écriture QB'}${e.name ? ` — ${e.name}` : ''}`,
      qb_entity: e.entity,
      qb_id: e.qbId,
      explanation: explainMissingQb(e, unmatchedBank),
    })
  }

  const methods = {}
  for (const [, m] of matches) methods[m.method] = (methods[m.method] || 0) + 1
  return {
    anomalies, to_book: toBook, gaps, methods, linked,
    bank_count: bankTxns.length,
    ledger_count: (index.byAccount.get(account.id) || []).length,
    matched: matches.size,
    qb_uncleared: uncleared,
  }
}

// ── Slack ────────────────────────────────────────────────────────────────────

const KIND_LABEL = {
  doublon_releve: 'probablement saisie deux fois au relevé',
  comptabilisee_introuvable: 'déclarée comptabilisée au fichier, introuvable dans QuickBooks',
  qb_sans_releve: 'compensée dans QuickBooks, absente du relevé',
}

function buildSlackMessage(newAnomalies) {
  const lines = [`:bank: *Rapprochement bancaire — ${newAnomalies.length} nouvelle(s) anomalie(s)* (fichier TRX_Orisha ↔ ERP ↔ QuickBooks)`]
  for (const a of newAnomalies.slice(0, 12)) {
    lines.push(`• *${a.account_name}* · ${a.date} · ${fmt(a.amount)} · ${a.label} — ${KIND_LABEL[a.kind] || a.kind}\n    ↳ ${a.explanation}`)
  }
  if (newAnomalies.length > 12) lines.push(`… et ${newAnomalies.length - 12} autre(s).`)
  lines.push('Détail : page Rapprochement bancaire de l\'ERP.')
  return lines.join('\n')
}

// Clés d'anomalies du dernier VRAI passage (les simulations ne comptent pas,
// sinon un « Simuler » étoufferait l'alerte Slack du passage suivant).
function previousAnomalyKeys() {
  const rows = db.prepare(`
    SELECT result FROM automation_logs
    WHERE automation_id = ? AND status = 'success'
      AND COALESCE(json_extract(trigger_data, '$.apply'), 1) = 1
    ORDER BY created_at DESC LIMIT 1
  `).all(TRX_SHEET_AUTOMATION_ID)
  const keys = new Set()
  for (const r of rows) {
    try {
      for (const a of JSON.parse(r.result || '{}').anomalies || []) keys.add(a.key)
    } catch {}
  }
  return keys
}

// ── Sync complète ────────────────────────────────────────────────────────────

export async function syncTrxSheet({ trigger = 'manual', apply = true, userId = null } = {}) {
  const t0 = Date.now()
  const cfg = getTrxSheetConfig()
  const todayIso = new Date().toISOString().slice(0, 10)
  try {
    const wb = await fetchWorkbook(cfg)
    const accounts = db.prepare('SELECT * FROM bank_accounts WHERE deleted_at IS NULL').all()
    const byName = new Map(accounts.map((a) => [strip(a.name), a]))
    const previousKeys = apply ? previousAnomalyKeys() : new Set()

    const tabs = []
    const pending = []
    const anomalies = []
    const toBook = []
    const gaps = []
    let imported = 0
    let autoMatched = 0
    let qbLinked = 0

    for (const tabName of wb.SheetNames) {
      const spec = specForTab(tabName)
      const account = spec ? byName.get(strip(spec.account)) : null
      if (!account) {
        tabs.push({ tab: tabName, status: 'ignoré', detail: spec ? `compte « ${spec.account} » introuvable` : 'onglet non mappé à un compte' })
        continue
      }
      const grid = xlsx.utils.sheet_to_json(wb.Sheets[tabName], { header: 1, blankrows: true, raw: false })
      const parsed = parseTrxTab(grid, spec, { todayIso, colorAt: colorReader(wb.Sheets[tabName]) })
      const plan = planImport(account, parsed.rows, cfg)
      const entry = {
        tab: tabName,
        account: account.name,
        parsed: parsed.rows.length,
        since: plan.since,
        new: plan.toInsert.length,
        already_imported: plan.skipped,
        warnings: parsed.warnings,
      }
      if (apply && plan.toInsert.length) {
        const res = importTransactions(account.id, plan.toInsert, userId)
        entry.imported = res.inserted
        imported += res.inserted
        const auto = autoMatchAccount(account.id)
        entry.auto_matched = auto.matched
        autoMatched += auto.matched
      }
      if (apply) {
        const filled = backfillSheetMeta(account.id, parsed.rows)
        if (filled.details) entry.details_backfilled = filled.details
        if (filled.colors) entry.colors_backfilled = filled.colors
        refreshStatuses(account.id)
        // La liaison QB n'est plus faite ici par l'ancien appariement strict
        // (montant exact, ±4 j, même compte) : l'audit ci-dessous la fait avec
        // la recherche approfondie, qui trouve strictement plus. Deux matchers
        // en parallèle se contredisaient sur les mêmes lignes.
      }
      pending.push({ account, entry, extraTxns: apply ? [] : plan.toInsert })
      tabs.push(entry)
    }

    // Audit croisé relevé ↔ grand livre, une fois toutes les tablettes importées :
    // l'index du grand livre est construit UNE seule fois pour tous les comptes,
    // ce qui permet de retrouver le virement interne comptabilisé du côté de
    // l'autre compte (et évite 11 fois le même appel QuickBooks).
    const auditable = pending.filter((p) => p.account.qb_account_id)
    if (auditable.length) {
      const windowDays = Number(cfg.audit_window_days) || 45
      const from = shiftDate(todayIso, -(windowDays + 35)) // marge pour les dates décalées
      let index = null
      try {
        index = await buildLedgerIndex(auditable.map((p) => p.account), from, shiftDate(todayIso, 5))
      } catch (e) {
        auditable.forEach((p) => { p.entry.audit_error = e.message })
      }
      for (const p of auditable) {
        if (!index) break
        try {
          const audit = await auditAccountVsQb(p.account, cfg, { index, extraTxns: p.extraTxns, apply })
          p.entry.audit = {
            matched: audit.matched, bank: audit.bank_count, qb: audit.ledger_count,
            anomalies: audit.anomalies.length, a_comptabiliser: audit.to_book.length,
            methodes: audit.methods,
          }
          qbLinked += audit.linked
          anomalies.push(...audit.anomalies)
          toBook.push(...audit.to_book)
          gaps.push(...audit.gaps)
        } catch (e) {
          p.entry.audit_error = e.message
        }
      }
    }
    const byDateDesc = (a, b) => (a.date < b.date ? 1 : -1)
    anomalies.sort(byDateDesc)
    toBook.sort(byDateDesc)
    gaps.sort(byDateDesc)

    // Slack : DÉSACTIVÉ par défaut (slack_anomalies=0) — le rapprochement
    // bancaire n'alerte plus le canal comptabilité, les anomalies vivent sur la
    // page Rapprochement bancaire et dans le journal ci-dessous. Si réactivé :
    // uniquement les anomalies jamais vues au passage précédent, jamais en
    // simulation, et une erreur d'envoi est rapportée plutôt qu'avalée (leçon de
    // l'incident trésorerie du 1er août).
    let slack = null
    const newAnomalies = anomalies.filter((a) => !previousKeys.has(a.key))
    if (apply && newAnomalies.length && cfg.slack_anomalies !== '1') {
      slack = `${newAnomalies.length} nouvelle(s) anomalie(s) — aucune alerte Slack (slack_anomalies=0)`
    } else if (apply && newAnomalies.length) {
      try {
        await sendSlackWebhook(cfg.slack_webhook_env, buildSlackMessage(newAnomalies))
        slack = `${newAnomalies.length} nouvelle(s) anomalie(s) alertée(s) sur Slack`
      } catch (e) {
        slack = `ÉCHEC de l'alerte Slack : ${e.message}`
      }
    }

    const result = {
      summary: (apply
        ? `${imported} transaction(s) importée(s) · ${autoMatched} appariée(s) auto · ${qbLinked} liée(s) à QB · ${anomalies.length} anomalie(s)`
        : `Simulation : ${tabs.reduce((s, t) => s + (t.new || 0), 0)} transaction(s) à importer · ${anomalies.length} anomalie(s)`)
        + (newAnomalies.length ? ` (${newAnomalies.length} nouvelle(s))` : '')
        + (toBook.length ? ` · ${toBook.length} à comptabiliser` : ''),
      tabs,
      anomalies,
      to_book: toBook,
      gaps,
      new_anomaly_keys: newAnomalies.map((a) => a.key),
      slack,
    }
    logSync('bank:trx-sheet', trigger === 'scheduled' ? 'scheduled' : 'manual',
      { status: 'success', modified: imported, durationMs: Date.now() - t0 })
    logSystemRun(TRX_SHEET_AUTOMATION_ID, { status: 'success', result, duration_ms: Date.now() - t0, triggerData: { trigger, apply } })
    return result
  } catch (e) {
    logSync('bank:trx-sheet', trigger === 'scheduled' ? 'scheduled' : 'manual',
      { status: 'error', error: e.message, durationMs: Date.now() - t0 })
    logSystemRun(TRX_SHEET_AUTOMATION_ID, { status: 'error', error: e, duration_ms: Date.now() - t0, triggerData: { trigger, apply } })
    throw e
  }
}

// État pour la page Rapprochement : automation active ? dernier passage ?
export function trxSheetStatus() {
  const auto = db.prepare('SELECT active FROM automations WHERE id = ? AND system = 1').get(TRX_SHEET_AUTOMATION_ID)
  const last = db.prepare(`
    SELECT status, result, error, created_at FROM automation_logs
    WHERE automation_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(TRX_SHEET_AUTOMATION_ID) || null
  let result = null
  if (last?.result) { try { result = JSON.parse(last.result) } catch { result = { summary: last.result } } }
  return {
    active: !!(auto && auto.active),
    last_run: last ? { status: last.status, executed_at: last.created_at, error: last.error, ...((result && typeof result === 'object') ? result : {}) } : null,
  }
}

// Sync aux 20 minutes (index.js) — coupe-circuit si l'automation est
// désactivée. À cette cadence un passage lent (Drive + grand livre QB des 11
// comptes) peut déborder sur le suivant : on saute alors le tour plutôt que de
// lancer deux imports concurrents sur les mêmes lignes.
let trxSheetSyncRunning = false
export async function scheduledTrxSheetSync() {
  if (!isSystemAutomationActive(TRX_SHEET_AUTOMATION_ID)) return
  if (trxSheetSyncRunning) return
  trxSheetSyncRunning = true
  try {
    await syncTrxSheet({ trigger: 'scheduled', apply: true })
  } finally { trxSheetSyncRunning = false }
}
