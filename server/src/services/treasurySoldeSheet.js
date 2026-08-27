// Synchronisation du Google Sheet « Maintien du solde disponible BNC » vers la
// projection de trésorerie de l'ERP.
//
// L'utilisateur continue de tenir ce fichier à la main (onglet « Compte
// chèque ») : solde disponible réel, paiements planifiés avec solde courant, et
// bloc « Sorties récurrentes ». Le FICHIER FAIT FOI — la sync lit le Sheet
// (export Drive xlsx, comme Pmt_Suivi : l'API Sheets n'est pas activée sur le
// projet Cloud), le compare à ce que l'ERP projette déjà, rapporte chaque
// différence et applique les ajustements :
//   - solde réel du fichier plus récent / différent → nouvelle saisie de solde
//     (source 'solde_sheet'), avec la même réconciliation et alerte qu'une
//     saisie manuelle ;
//   - paiement planifié que l'ERP ne projette pas déjà (ni facture à
//     l'échéance, ni récurrente, ni paiement émis) → paiement projeté créé
//     (idempotent par import_key 'soldesheet:…') ;
//   - ligne retirée du fichier alors que la date du paiement est passée →
//     le paiement est marqué « passé à la banque » automatiquement (Charles
//     retire la ligne et met le solde à jour quand le mouvement passe) — ça
//     vaut aussi pour un paiement saisi dans l'ERP que le fichier couvrait ;
//     ligne retirée pour une date FUTURE → plan modifié, le paiement importé
//     est retiré de la projection (un paiement né dans l'ERP n'est jamais
//     détruit) ;
//   - bloc « Sorties récurrentes » → montants / jours des récurrentes ERP
//     alignés sur le fichier, récurrentes mensuelles manquantes créées.
// Ce qui ne peut pas être ajusté sans risque de double compte (ligne couverte
// par une facture ou une récurrente, récurrente ERP absente du fichier…) est
// seulement RAPPORTÉ — visible sur la page Comptabilité et dans le journal de
// l'automation sys_treasury_solde_sheet.
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { logSync } from './syncLog.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'
import { fetchPmtSuiviGrid } from './pmtSuiviImport.js'
import { createPayment, findAchatForPayment, setCleared } from './treasuryPayments.js'

export const SOLDE_SHEET_AUTOMATION_ID = 'sys_treasury_solde_sheet'

// Cadence de la sync automatique : une fois par heure, à l'heure pile
// (cron dans index.js). Exposée à l'UI pour que la cadence soit lisible sur la
// page Comptabilité plutôt que devinée.
export const SOLDE_SHEET_INTERVAL_MINUTES = 60

export const SOLDE_SHEET_DEFAULT_CONFIG = {
  spreadsheet_id: '1ETlbHIcwClZTiskwQh8PWYuDxZGwqJBKU-0p2iWoxgo', // Maintien du solde disponible BNC
  sheet_name: 'Compte chèque',
  google_account_email: 'pap@orisha.io',
  // Fenêtre (jours) pour considérer qu'une facture / récurrente / paiement ERP
  // couvre déjà une ligne du fichier (même sortie, date légèrement décalée).
  match_window_days: '10',
  // Alerte Slack sur les anomalies de LECTURE du fichier : désactivée (demande
  // utilisateur du 11 août 2026 — le canal comptabilité ne reçoit plus que le
  // découvert imminent). Les anomalies restent en rouge/ambre sur la page
  // Comptabilité et dans le journal. Mettre à '1' pour réactiver l'envoi.
  slack_anomalies: '0',
}

export function getSoldeSheetConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get(SOLDE_SHEET_AUTOMATION_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch {}
  const merged = { ...SOLDE_SHEET_DEFAULT_CONFIG }
  for (const k of Object.keys(SOLDE_SHEET_DEFAULT_CONFIG)) {
    if (cfg[k] != null && String(cfg[k]).trim() !== '') merged[k] = String(cfg[k]).trim()
  }
  return merged
}

// ── Parsing (pur, testable) ──────────────────────────────────────────────────

const strip = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
const r2 = n => Math.round(Number(n) * 100) / 100

// Le fichier mélange les formats : « 14,518.14 » (anglais, virgule = milliers)
// et « 6 115,89 » (français, virgule = décimale). parseAmount de Pmt_Suivi
// supprime toutes les virgules et lirait « 6 115,89 » comme 611 589 — d'où ce
// parseur dédié : une virgule suivie d'exactement 2 chiffres en fin de nombre
// (et sans point ailleurs) est une décimale, sinon un séparateur de milliers.
export function parseMoney(v) {
  let raw = String(v ?? '').trim()
  if (!raw) return null
  const neg = /^\(.*\)$/.test(raw) || /^-/.test(raw)
  raw = raw.replace(/[()$]/g, '').replace(/usd|cad/gi, '').replace(/[\s\u00a0\u202f]/g, '').replace(/^-/, '')
  if (!raw) return null
  if (raw.includes('.')) raw = raw.replace(/,/g, '')
  else if (/,\d{2}$/.test(raw)) raw = raw.replace(/,(\d{2})$/, '.$1').replace(/,/g, '')
  else raw = raw.replace(/,/g, '')
  const n = Number(raw)
  if (!Number.isFinite(n) || n === 0) return null
  return neg ? -r2(n) : r2(n)
}

// ── Lecture des cellules : la valeur BRUTE d'abord ───────────────────────────
//
// Le fichier est MIS EN FORME : la cellule du solde vaut 37590.83 mais s'affiche
// « 37,591 » (format #,##0), et « Mastercard 1,073 » vaut en réalité 1072.86.
// Lire le texte affiché — ce que faisait la première version — introduisait donc
// jusqu'à 0,50 $ d'erreur PAR LIGNE sur un solde qui doit être juste au cent
// près, sans le moindre signal. Les dates, elles, sont des numéros de série
// Excel (46238 = 4 août 2026) affichés « 4 August ».
//
// Règle : valeur brute quand elle existe, texte formaté en repli (le fichier
// contient aussi de vraies chaînes — « 6 115,89 », « (voir le relevé) »).

// Jours entre le 1899-12-30 (époque Excel) et le 1970-01-01 (époque Unix).
const EXCEL_EPOCH_DAYS = 25569
// Bornes de plausibilité d'un numéro de série : 1954 → 2119. Un montant qui
// tomberait par erreur dans une colonne de date ne doit pas devenir une date.
const SERIAL_MIN = 20000
const SERIAL_MAX = 80000

export function excelSerialToIso(serial) {
  const n = Math.floor(Number(serial))
  if (!Number.isFinite(n) || n < SERIAL_MIN || n > SERIAL_MAX) return null
  const d = new Date((n - EXCEL_EPOCH_DAYS) * 86400000)
  if (Number.isNaN(d.getTime())) return null
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

// Montant d'une cellule : le nombre brut fait foi, le texte affiché sert de
// repli. 0 = cellule vide (le fichier n'a aucune ligne à 0 $).
export function cellMoney(rawVal, textVal) {
  if (typeof rawVal === 'number' && Number.isFinite(rawVal)) return rawVal === 0 ? null : r2(rawVal)
  const text = textVal == null || textVal === '' ? rawVal : textVal
  return parseMoney(text)
}

// Date d'une cellule : numéro de série ou Date brute d'abord, texte en repli.
export function cellDate(rawVal, textVal, todayIso) {
  if (rawVal instanceof Date && !Number.isNaN(rawVal.getTime())) {
    return `${rawVal.getUTCFullYear()}-${pad2(rawVal.getUTCMonth() + 1)}-${pad2(rawVal.getUTCDate())}`
  }
  if (typeof rawVal === 'number') {
    const iso = excelSerialToIso(rawVal)
    if (iso) return iso
  }
  const text = textVal == null || textVal === '' ? rawVal : textVal
  return parseSheetDate(text, todayIso)
}

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7,
  august: 8, september: 9, october: 10, november: 11, december: 12,
  janvier: 1, fevrier: 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7,
  aout: 8, septembre: 9, octobre: 10, novembre: 11, decembre: 12,
  jan: 1, feb: 2, mar: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9,
  oct: 10, nov: 11, dec: 12, fev: 2, avr: 4, juil: 7,
}

const pad2 = n => String(n).padStart(2, '0')

// « 4 August » / « August 4 » / « 4 août 2026 » / « 04/08/2026 » (jour/mois) /
// « 2026-08-04 » → ISO. Sans année, on choisit celle (n−1, n, n+1) qui rapproche
// le plus la date d'aujourd'hui — le fichier est une projection court terme.
export function parseSheetDate(v, todayIso) {
  const raw = strip(v)
  if (!raw) return null
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(raw)
  if (m) return `${m[3]}-${pad2(m[2])}-${pad2(m[1])}`
  m = /^(\d{1,2})(?:er)?\s+([a-z]+)\.?\s*(\d{4})?$/.exec(raw) || null
  let day, monthName, year
  if (m) { day = Number(m[1]); monthName = m[2]; year = m[3] ? Number(m[3]) : null }
  else {
    m = /^([a-z]+)\.?\s+(\d{1,2})(?:er)?\s*,?\s*(\d{4})?$/.exec(raw)
    if (!m) return null
    monthName = m[1]; day = Number(m[2]); year = m[3] ? Number(m[3]) : null
  }
  const month = MONTHS[monthName]
  if (!month || day < 1 || day > 31) return null
  if (year) return `${year}-${pad2(month)}-${pad2(day)}`
  const today = new Date(`${todayIso}T12:00:00Z`)
  let best = null
  for (const y of [today.getUTCFullYear() - 1, today.getUTCFullYear(), today.getUTCFullYear() + 1]) {
    const cand = new Date(Date.UTC(y, month - 1, day, 12))
    if (Number.isNaN(cand.getTime()) || cand.getUTCMonth() !== month - 1) continue
    const dist = Math.abs(cand - today)
    if (!best || dist < best.dist) best = { iso: `${y}-${pad2(month)}-${pad2(day)}`, dist }
  }
  return best ? best.iso : null
}

// ── Vérification par la chaîne du fichier ────────────────────────────────────
//
// La colonne « Solde disponible » du fichier N'EST PAS une donnée de plus :
// c'est le contrôle. Chaque cellule y vaut « solde de la ligne précédente −
// montant de la ligne » (formule D2 = F2−B2, D3 = D2−B3…). En rejouant ce
// calcul on vérifie CHAQUE ligne lue : si le résultat ne retombe pas sur le
// chiffre du fichier, c'est qu'on a mal lu un montant, ou qu'une ligne du
// fichier nous a échappé. Une lecture qui « marche » sans être vérifiée n'a
// aucune valeur sur un solde aussi important — c'est ce contrôle qui rend la
// sync fiable plutôt que plausible.
//
// Après une rupture on se ré-ancre sur le chiffre du fichier : une seule erreur
// ne doit pas faire passer toutes les lignes suivantes pour fausses.
// Pur, testable. Mute `verified` sur chaque ligne de `planned`.
export function verifySoldeChain(balance, planned) {
  const breaks = []
  let anchor = balance?.amount ?? null
  let checked = 0
  let unverified = 0
  // Solde d'ouverture tel que le fichier l'implique (1re ligne chaînée) : c'est
  // la valeur exacte, même si la cellule du solde est affichée arrondie.
  const first = planned.find(l => l.running_balance != null) || null
  const impliedOpening = first && first === planned[0]
    ? r2(first.running_balance + (first.credit ? -first.amount : first.amount))
    : null

  let balanceSuspect = false
  for (const line of planned) {
    const signed = line.credit ? line.amount : -line.amount
    if (anchor == null || line.running_balance == null) {
      line.verified = false
      unverified++
      if (anchor != null) anchor = r2(anchor + signed)
      continue
    }
    const expected = r2(anchor + signed)
    const delta = r2(line.running_balance - expected)
    if (Math.abs(delta) <= 0.005) {
      line.verified = true
      checked++
    } else {
      line.verified = false
      // Rupture sur la toute première ligne chaînée : c'est le solde
      // d'ouverture qui est en cause, pas le montant de la ligne.
      if (!breaks.length && line === planned[0]) balanceSuspect = true
      breaks.push({
        row: line.row, vendor: line.vendor, amount: line.amount,
        expected, actual: line.running_balance, delta,
      })
    }
    anchor = line.running_balance
  }
  return {
    ok: breaks.length === 0,
    checked,
    unverified,
    breaks,
    balance_suspect: balanceSuspect,
    implied_opening: impliedOpening,
    opening_delta: impliedOpening != null && balance?.amount != null
      ? r2(impliedOpening - balance.amount) : null,
    // Dernier solde annoncé par le fichier (sa propre projection).
    final_balance: anchor,
    final_date: planned.length ? planned[planned.length - 1].date : null,
  }
}

// Analyse la grille de l'onglet « Compte chèque ». Quatre blocs sur la même
// feuille : paiements planifiés (Fournisseur | Montant | Date du paiement |
// Solde disponible), solde disponible réel (Solde disponible | Date, colonnes de
// droite), sorties récurrentes (Jour approx | Montant | Description) et cédule
// de paie (Paie | Montant aprox).
//
// `raw` = grille des valeurs brutes (même indexation que `rows`) — voir
// cellMoney / cellDate. Absente, la lecture retombe sur le texte affiché et une
// anomalie le signale : les montants sont alors arrondis à l'affichage.
export function parseSoldeSheet(rows, { todayIso, raw = [] }) {
  // Array.from : les grilles xlsx sont des tableaux creux (trous, pas des
  // nulls) — .map sauterait les trous et laisserait des undefined.
  const header = rows.findIndex(r => {
    const cells = Array.from(r || [], c => strip(c))
    return cells.includes('fournisseur') && cells.some(c => c.startsWith('montant'))
  })
  if (header < 0) throw new Error('Onglet Compte chèque : ligne d\'en-têtes introuvable (« Fournisseur »)')
  const head = Array.from(rows[header] || [], c => strip(c))
  const cols = {
    vendor: head.indexOf('fournisseur'),
    amount: head.findIndex(c => c.startsWith('montant')),
    date: head.findIndex(c => c.startsWith('date du paiement')),
    balance: head.findIndex(c => c.startsWith('solde disponible')),
  }
  if (cols.date < 0) cols.date = head.findIndex((c, i) => c === 'date' && i > cols.amount)
  for (const k of ['vendor', 'amount', 'date']) {
    if (cols[k] < 0) throw new Error(`Onglet Compte chèque : colonne « ${k} » introuvable`)
  }

  // Accès cellule : brut d'abord, texte affiché en repli.
  const rawAt = (r, c) => (raw[r] || [])[c]
  const txtAt = (r, c) => (rows[r] || [])[c]
  const money = (r, c) => cellMoney(rawAt(r, c), txtAt(r, c))
  const date = (r, c) => cellDate(rawAt(r, c), txtAt(r, c), todayIso)
  const hasRaw = Array.isArray(raw) && raw.length > 0

  // Bloc solde réel : la 2e paire « Solde disponible | Date » de la ligne
  // d'en-têtes, à droite du tableau des paiements.
  let balance = null
  const balCol = head.findIndex((c, i) => c.startsWith('solde disponible') && i > cols.balance)
  if (balCol >= 0) {
    const dateCol = head.findIndex((c, i) => c === 'date' && i > balCol)
    for (let r = header + 1; r < Math.min(rows.length, header + 12); r++) {
      const amount = money(r, balCol)
      if (amount == null) continue
      balance = { amount, date: dateCol >= 0 ? date(r, dateCol) : null, row: r + 1 }
      break
    }
  }

  // Paiements planifiés.
  const planned = []
  const unparsed = []
  let blanks = 0
  for (let r = header + 1; r < rows.length && blanks < 12; r++) {
    const vendor = String(txtAt(r, cols.vendor) ?? '').trim()
    const amount = money(r, cols.amount)
    if (!vendor && amount == null) { blanks++; continue }
    blanks = 0
    const when = date(r, cols.date)
    if (!vendor || amount == null || !when) {
      unparsed.push({
        row: r + 1, vendor: vendor || null, amount,
        date: String(txtAt(r, cols.date) ?? '').trim() || null,
        // Ce qui manque, dit explicitement : c'est ce que l'utilisateur doit
        // corriger dans le fichier pour que la sortie soit enfin comptée.
        missing: [!vendor && 'fournisseur', amount == null && 'montant', !when && 'date'].filter(Boolean),
      })
      continue
    }
    planned.push({
      row: r + 1,
      vendor, amount: Math.abs(amount), date: when,
      running_balance: cols.balance >= 0 ? money(r, cols.balance) : null,
      credit: amount < 0,
      verified: false,
    })
  }

  // Bloc « Sorties récurrentes ».
  const recurring = []
  let recHeaderRow = -1, recCol = -1
  for (let r = 0; r < Math.min(rows.length, 40) && recHeaderRow < 0; r++) {
    const idx = (rows[r] || []).findIndex(c => strip(c).startsWith('jour approx'))
    if (idx >= 0) { recHeaderRow = r; recCol = idx }
  }
  if (recHeaderRow >= 0) {
    let recBlanks = 0
    for (let r = recHeaderRow + 1; r < rows.length && recBlanks < 6; r++) {
      const label = String(txtAt(r, recCol + 2) ?? '').trim()
      const amountRaw = String(txtAt(r, recCol + 1) ?? '').trim()
      if (!label && !amountRaw) { recBlanks++; continue }
      recBlanks = 0
      if (!label || /besoin d'attention/.test(strip(label))) continue
      const dayCell = String(txtAt(r, recCol) ?? '').trim()
      const day = /^\d{1,2}$/.test(dayCell) ? Number(dayCell) : null
      const amount = money(r, recCol + 1)
      recurring.push({
        label, day, row: r + 1,
        amount: amount != null ? Math.abs(amount) : null,
        // « (voir le relevé) » et compagnie : montant variable, connu au relevé.
        variable: amount == null && !!amountRaw,
      })
    }
  }

  // Bloc « Paie » (colonnes de droite : date | montant approximatif) — la
  // cédule de paie réelle, aux deux semaines. C'est la plus grosse sortie du
  // compte : la cadence de l'ERP doit être vérifiée contre cette liste, sinon
  // un décalage d'une semaine déplace 25 000 $ dans la projection.
  const payroll = []
  let payHeaderRow = -1, payCol = -1
  for (let r = 0; r < Math.min(rows.length, 40) && payHeaderRow < 0; r++) {
    const cells = Array.from(rows[r] || [], c => strip(c))
    const idx = cells.findIndex((c, i) => c === 'paie' && String(cells[i + 1] || '').startsWith('montant'))
    if (idx >= 0) { payHeaderRow = r; payCol = idx }
  }
  if (payHeaderRow >= 0) {
    let payBlanks = 0
    for (let r = payHeaderRow + 1; r < rows.length && payBlanks < 6; r++) {
      const when = date(r, payCol)
      const amount = money(r, payCol + 1)
      if (!when && amount == null) { payBlanks++; continue }
      payBlanks = 0
      if (!when || amount == null) continue
      payroll.push({ date: when, amount: Math.abs(amount), row: r + 1 })
    }
  }

  const chain = verifySoldeChain(balance, planned)

  // ── Anomalies : ce qu'on n'a PAS pu lire de façon sûre ──────────────────────
  // Rien ne doit être avalé en silence. Une ligne illisible, c'est une sortie
  // d'argent absente de la projection — exactement le mécanisme qui a produit
  // les 11 864 $ fantômes du 1er août 2026, en pire : personne ne le voit.
  const anomalies = []
  const fmt = n => Number(n).toFixed(2).replace('.', ',')
  if (!hasRaw) {
    anomalies.push({
      code: 'valeurs_brutes_absentes', severity: 'warn', row: null,
      text: 'Valeurs brutes du fichier illisibles : montants lus tels qu\'affichés, donc arrondis. Solde et lignes peuvent être faux de quelques cents.',
    })
  }
  if (!balance || balance.amount == null) {
    anomalies.push({
      code: 'solde_introuvable', severity: 'error', row: null,
      text: 'Solde disponible introuvable dans le fichier — la projection reste sur la dernière valeur connue.',
    })
  } else if (!balance.date) {
    anomalies.push({
      code: 'solde_sans_date', severity: 'warn', row: balance.row,
      text: `Solde ${fmt(balance.amount)} $ sans date lisible — daté d'aujourd'hui par défaut.`,
    })
  }
  for (const u of unparsed) {
    anomalies.push({
      code: 'ligne_illisible', severity: 'error', row: u.row,
      text: `Ligne ${u.row}${u.vendor ? ` « ${u.vendor} »` : ''}${u.amount != null ? ` ${fmt(Math.abs(u.amount))} $` : ''} : ` +
        `${u.missing.join(' et ')} illisible${u.missing.length > 1 ? 's' : ''}` +
        `${u.date ? ` (date écrite « ${u.date} »)` : ''} — cette sortie n'est PAS comptée dans la projection.`,
    })
  }
  for (const b of chain.breaks) {
    anomalies.push({
      code: 'chaine_rompue', severity: 'error', row: b.row,
      text: `Ligne ${b.row} « ${b.vendor} » ${fmt(b.amount)} $ : le solde du fichier annonce ${fmt(b.actual)} $ ` +
        `alors que le calcul donne ${fmt(b.expected)} $ (écart ${fmt(b.delta)} $) — lecture non fiable, ligne non appliquée.`,
    })
  }
  if (chain.unverified > 0) {
    anomalies.push({
      code: 'lignes_non_verifiees', severity: 'warn', row: null,
      text: `${chain.unverified} ligne(s) sans solde courant dans le fichier : montant non recoupable par la chaîne.`,
    })
  }
  // Fichier pas rafraîchi : le solde est la donnée la plus périssable de tout
  // le système — 4 jours sans mise à jour et la projection dérive.
  if (balance?.date && balance.date < shiftDay(todayIso, -4)) {
    anomalies.push({
      code: 'fichier_perime', severity: 'warn', row: balance.row,
      text: `Le solde du fichier date du ${balance.date} — mettre à jour le fichier pour que la projection reste juste.`,
    })
  }

  return { balance, planned, recurring, payroll, unparsed, chain, anomalies, has_raw: hasRaw }
}

// Décale une date ISO de n jours (calendrier UTC — dates sans heure).
function shiftDay(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`)
  if (Number.isNaN(d.getTime())) return iso
  d.setUTCDate(d.getUTCDate() + n)
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`
}

// ── Rapprochement avec ce que l'ERP projette déjà ───────────────────────────

const vendorKey = s => strip(s).replace(/[^a-z0-9]/g, '')
const labelsMatch = (a, b) => {
  const ka = vendorKey(a), kb = vendorKey(b)
  return !!ka && !!kb && (ka.includes(kb) || kb.includes(ka))
}
const amountsClose = (a, b, pct = 0.01) => Math.abs(a - b) <= Math.max(1, Math.abs(b) * pct)
const dayDiff = (a, b) => Math.abs(Math.round((new Date(`${a}T12:00:00Z`) - new Date(`${b}T12:00:00Z`)) / 86400000))

const importKey = (vendor, amount, rank) => `soldesheet:${vendorKey(vendor)}|${r2(amount).toFixed(2)}|${rank}`

// Jour local (fuseau du serveur) d'un timestamp ISO — même convention que la
// projection (isoDate de treasury.js).
const localDay = ts => {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return null
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

// Décision quand plus aucune ligne du fichier ne couvre un paiement en attente.
// Le fichier fait foi : Charles retire une ligne quand le mouvement est passé à
// la banque (et met le solde réel à jour), ou quand le plan change. Pur — testé
// dans treasurySoldeSheet.test.js.
//   - sheetSeenAt NULL → 'keep' : soit le fichier n'a jamais couvert ce
//     paiement (on ne devine pas sur une absence), soit l'utilisateur vient de
//     décocher « Passé » à la main (setCleared remet sheet_seen_at à NULL) et
//     on ne re-coche pas par-dessus sa décision ;
//   - date du paiement passée → 'clear' : le mouvement est passé, on coche ;
//   - date future → 'remove' pour une ligne importée du fichier (le plan a
//     changé), 'keep' pour un paiement né dans l'ERP (jamais détruit).
export function goneLineOutcome({ paymentDate, sheetSeenAt, fromSheet }, todayIso) {
  if (!sheetSeenAt) return 'keep'
  if (String(paymentDate).slice(0, 10) <= todayIso) return 'clear'
  return fromSheet ? 'remove' : 'keep'
}

// Compare le fichier à l'état ERP et retourne le plan d'ajustements + les
// différences non ajustables. Lecture seule — l'application est dans
// syncSoldeSheet (séparation pour le dry-run / bouton « Simuler »).
export function diffSoldeSheet(parsed, { todayIso, windowDays = 10 }) {
  // stamp : paiements en attente couverts par une ligne du fichier À CETTE sync
  // — applyPlan pose sheet_seen_at dessus. C'est ce qui autorise, plus tard, le
  // cochage automatique quand la ligne disparaît (goneLineOutcome).
  const plan = { balance: null, payments: [], recurring: [], payroll: [], stamp: [] }
  const chain = parsed.chain || { ok: true, breaks: [], balance_suspect: false }
  // Lignes dont la chaîne du fichier contredit le montant lu : on ne crée ni ne
  // modifie rien à partir d'elles — mieux vaut une différence rapportée qu'un
  // faux mouvement dans la projection du solde.
  const brokenRows = new Set(chain.breaks.map(b => b.row))

  // ── Solde réel ─────────────────────────────────────────────────────────────
  const latest = db.prepare('SELECT * FROM treasury_balances ORDER BY noted_at DESC LIMIT 1').get() || null
  if (!parsed.balance || parsed.balance.amount == null) {
    plan.balance = { action: 'missing', detail: 'Solde introuvable dans le fichier' }
  } else if (chain.balance_suspect) {
    // La 1re ligne du fichier ne retombe pas sur son propre solde courant : le
    // solde d'ouverture lui-même est douteux. On ne l'importe pas — un solde de
    // départ faux fausse TOUTE la projection.
    plan.balance = {
      action: 'suspect', sheet: parsed.balance,
      erp: latest ? { balance: latest.balance, noted_at: latest.noted_at } : null,
      detail: `Le solde ${parsed.balance.amount.toFixed(2)} $ ne concorde pas avec la 1re ligne du fichier ` +
        `(elle implique ${chain.implied_opening != null ? chain.implied_opening.toFixed(2) : '?'} $) — non importé`,
    }
  } else {
    const sheetDay = parsed.balance.date || todayIso
    const latestDay = latest ? localDay(latest.noted_at) : null
    const sameDayEntries = db.prepare(
      "SELECT * FROM treasury_balances WHERE noted_at >= ? ORDER BY noted_at DESC"
    ).all(`${sheetDay}T00:00:00.000Z`).filter(b => localDay(b.noted_at) === sheetDay)
    // Tolérance au CENT : les valeurs brutes du fichier sont exactes, un écart
    // de 0,17 $ est un vrai écart (et l'ancienne tolérance de 1 $ masquait
    // justement l'erreur d'arrondi de lecture qu'elle était censée absorber).
    const duplicate = sameDayEntries.find(b => Math.abs(b.balance - parsed.balance.amount) <= 0.005)
    if (duplicate) {
      plan.balance = { action: 'match', sheet: parsed.balance, erp: { balance: duplicate.balance, noted_at: duplicate.noted_at } }
    } else if (latestDay && sheetDay < latestDay) {
      plan.balance = {
        action: 'stale_sheet', sheet: parsed.balance,
        erp: { balance: latest.balance, noted_at: latest.noted_at },
        detail: `Le fichier date du ${sheetDay}, l'ERP a une saisie plus récente (${latestDay}) — rien à faire`,
      }
    } else {
      // Fichier plus récent, ou même jour avec un solde différent : le fichier
      // fait foi. noted_at en fin de journée locale pour que la saisie du
      // fichier prime sur une saisie manuelle du même jour.
      let notedAt = `${sheetDay}T22:00:00.000Z`
      if (latest && latest.noted_at >= notedAt) {
        notedAt = new Date(new Date(latest.noted_at).getTime() + 1000).toISOString()
      }
      plan.balance = {
        action: 'insert', sheet: parsed.balance, noted_at: notedAt,
        erp: latest ? { balance: latest.balance, noted_at: latest.noted_at } : null,
      }
    }
  }

  // ── Paiements planifiés ────────────────────────────────────────────────────
  const existingSheetPmts = db.prepare(
    "SELECT * FROM treasury_payments WHERE import_key LIKE 'soldesheet:%' AND deleted_at IS NULL"
  ).all()
  const otherPendingPmts = db.prepare(`
    SELECT * FROM treasury_payments
    WHERE deleted_at IS NULL AND cleared_at IS NULL AND direction = 'out'
      AND COALESCE(account, 'BNC CAD') = 'BNC CAD' AND COALESCE(currency, 'CAD') = 'CAD'
      AND (import_key IS NULL OR import_key NOT LIKE 'soldesheet:%')
  `).all()
  const openBills = db.prepare(`
    SELECT id, vendor, due_date, balance_due_cad, total_cad FROM achats_fournisseurs
    WHERE type = 'bill' AND status NOT IN ('Payée', 'Annulée', 'Brouillon')
      AND balance_due_cad > 0 AND COALESCE(currency, 'CAD') = 'CAD'
      AND id NOT IN (SELECT achat_id FROM treasury_payments WHERE achat_id IS NOT NULL AND deleted_at IS NULL)
  `).all()
  const activeRecurring = db.prepare(
    'SELECT * FROM recurring_outflows WHERE deleted_at IS NULL AND active = 1'
  ).all()

  // ── Appariement ligne du fichier ↔ paiement déjà importé ───────────────────
  // Deux passages, pour ne jamais confondre « la ligne a changé » avec « la
  // ligne a disparu » : la clé d'import contient le montant, donc corriger un
  // montant dans le fichier faisait disparaître la clé — le paiement était
  // alors coché « passé à la banque » (mensonge : rien n'était sorti) et un
  // second créé. Le 2e passage ré-apparie par fournisseur et met à jour.
  const outLines = parsed.planned.filter(l => !l.credit) // note de crédit : pas une sortie
  const ranks = new Map()
  for (const line of outLines) {
    const base = `${vendorKey(line.vendor)}|${r2(line.amount).toFixed(2)}`
    const rank = (ranks.get(base) || 0) + 1
    ranks.set(base, rank)
    line.key = importKey(line.vendor, line.amount, rank)
  }
  const seenKeys = new Set(outLines.map(l => l.key))
  const takenPmtIds = new Set()
  const pending = []
  for (const line of outLines) {
    const existing = existingSheetPmts.find(p => p.import_key === line.key && !takenPmtIds.has(p.id))
    if (!existing) { pending.push(line); continue }
    takenPmtIds.add(existing.id)
    if (existing.cleared_at) {
      plan.payments.push({ action: 'already_cleared', line, payment_id: existing.id })
    } else if (String(existing.payment_date).slice(0, 10) !== line.date) {
      plan.stamp.push(existing.id)
      plan.payments.push({ action: 'update_date', line, payment_id: existing.id, from: existing.payment_date, key: line.key })
    } else {
      plan.stamp.push(existing.id)
      plan.payments.push({ action: 'unchanged', line, payment_id: existing.id })
    }
  }

  for (const line of pending) {
    const key = line.key
    // Ligne contredite par la chaîne du fichier : rapportée, jamais appliquée.
    if (brokenRows.has(line.row)) {
      plan.payments.push({ action: 'report_unverified', line, detail: 'montant contredit par le solde courant du fichier' })
      continue
    }

    // Même fournisseur, ligne déjà importée dont le montant (ou la date) a été
    // corrigé dans le fichier → mise à jour, pas suppression + recréation.
    const rematch = existingSheetPmts.find(p =>
      !takenPmtIds.has(p.id) && !p.cleared_at && !seenKeys.has(p.import_key)
      && labelsMatch(p.label, line.vendor))
    if (rematch) {
      takenPmtIds.add(rematch.id)
      plan.stamp.push(rematch.id)
      plan.payments.push({
        action: 'update_line', line, payment_id: rematch.id, key,
        from: { amount: rematch.amount, date: String(rematch.payment_date).slice(0, 10) },
      })
      continue
    }

    // Déjà projeté par un paiement émis (saisi à la main ou importé de Pmt_Suivi) ?
    const pmt = otherPendingPmts.find(p =>
      amountsClose(p.amount, line.amount) && dayDiff(p.payment_date, line.date) <= windowDays
      && (labelsMatch(p.label, line.vendor) || Math.abs(p.amount - line.amount) <= 0.01))
    if (pmt) {
      plan.stamp.push(pmt.id)
      plan.payments.push({ action: 'covered_by_payment', line, payment_id: pmt.id, payment_label: pmt.label, payment_date: pmt.payment_date })
      continue
    }

    // Déjà projeté par une facture fournisseur à son échéance ?
    const bill = openBills.find(b =>
      (amountsClose(b.balance_due_cad, line.amount) || amountsClose(b.total_cad, line.amount))
      && b.due_date && dayDiff(String(b.due_date).slice(0, 10), line.date) <= windowDays
      && (labelsMatch(b.vendor, line.vendor) || amountsClose(b.balance_due_cad, line.amount, 0.001)))
    if (bill) {
      const due = String(bill.due_date).slice(0, 10)
      if (dayDiff(due, line.date) <= 2) {
        plan.payments.push({ action: 'covered_by_bill', line, achat_id: bill.id, due_date: due })
      } else {
        // Le fichier paie la facture à une autre date que l'échéance : le
        // fichier fait foi — paiement lié à la facture (qui la remplace dans la
        // projection à la date du fichier).
        plan.payments.push({ action: 'reschedule_bill', line, achat_id: bill.id, due_date: due, key })
      }
      continue
    }

    // Déjà projeté par une sortie récurrente (paie, loyer, dettes…) ? On ne crée
    // rien : la récurrente couvre l'occurrence, créer un paiement doublerait la
    // sortie (la couverture par paiement exige vendor_match sur la récurrente).
    const rec = activeRecurring.find(r =>
      (labelsMatch(r.label, line.vendor) || (Number(r.amount) > 0 && amountsClose(Number(r.amount), line.amount, 0.02)))
      && recurringOccursNear(r, line.date, windowDays))
    if (rec) {
      plan.payments.push({ action: 'covered_by_recurring', line, recurring_id: rec.id, recurring_label: rec.label })
      continue
    }

    // Sortie que l'ERP ne connaît pas : c'est exactement la catégorie qui a
    // produit les 11 864 $ fantômes du 1er août 2026 — on l'ajoute.
    plan.payments.push({ action: 'create', line, key, achat_id: findAchatForPayment({ label: line.vendor, amount: line.amount, payment_date: line.date }) })
  }

  // ── Lignes disparues du fichier ────────────────────────────────────────────
  // Date passée → le mouvement est passé à la banque (cochage automatique) ;
  // date future → plus attendue, retirée de la projection.
  //
  // Ces deux actions RETIRENT une sortie de la projection : ce sont les seules
  // qui peuvent faire monter le solde projeté, donc les seules qui peuvent
  // mener à un découvert imprévu. Elles exigent une lecture sûre :
  //   - chaîne du fichier rompue → on ne sait plus quelles lignes existent
  //     vraiment : tout est suspendu et rapporté ;
  //   - ligne illisible au même fournisseur → la ligne n'a pas disparu, elle
  //     est juste incompréhensible : on garde la sortie.
  const unreadableVendors = (parsed.unparsed || []).map(u => u.vendor).filter(Boolean)
  const suspendReducing = !chain.ok
  const goneReason = p => {
    if (suspendReducing) return 'la chaîne du solde du fichier est rompue — lecture non fiable'
    const hit = unreadableVendors.find(v => labelsMatch(v, p.label))
    return hit ? `une ligne illisible du fichier porte le même fournisseur (« ${hit} »)` : null
  }
  for (const p of existingSheetPmts) {
    if (seenKeys.has(p.import_key) || takenPmtIds.has(p.id) || p.cleared_at) continue
    const outcome = goneLineOutcome(
      { paymentDate: p.payment_date, sheetSeenAt: p.sheet_seen_at, fromSheet: true }, todayIso)
    if (outcome === 'keep') continue
    const line = { vendor: p.label, amount: p.amount, date: String(p.payment_date).slice(0, 10) }
    const blocked = goneReason(p)
    plan.payments.push(blocked
      ? { action: 'report_held', line, payment_id: p.id, would: outcome, detail: blocked }
      : { action: outcome, payment_id: p.id, line })
  }

  // Paiements nés dans l'ERP (saisis à la main, créés par une facture payée,
  // importés de Pmt_Suivi) que le fichier couvrait à une sync précédente
  // (sheet_seen_at posé) et ne couvre plus, avec une date passée : la ligne a
  // été retirée parce que le mouvement est passé — on coche « passé à la
  // banque » à leur place. C'est exactement le clic que l'utilisateur faisait
  // à la main sur /paiements-emis.
  const coveredNow = new Set(plan.stamp)
  for (const p of otherPendingPmts) {
    if (coveredNow.has(p.id)) continue
    const outcome = goneLineOutcome(
      { paymentDate: p.payment_date, sheetSeenAt: p.sheet_seen_at, fromSheet: false }, todayIso)
    if (outcome !== 'clear') continue
    const line = { vendor: p.label, amount: p.amount, date: String(p.payment_date).slice(0, 10) }
    const blocked = goneReason(p)
    plan.payments.push(blocked
      ? { action: 'report_held', line, payment_id: p.id, would: 'clear', detail: blocked }
      : { action: 'clear', payment_id: p.id, line })
  }

  // ── Lignes illisibles : l'ERP les connaît-il par ailleurs ? ────────────────
  // Une ligne du fichier qu'on ne sait pas lire est une alerte — mais crier au
  // loup quand la sortie est DÉJÀ projetée (facture fournisseur, récurrente,
  // paiement émis) userait l'alerte jusqu'à ce que plus personne ne la lise. On
  // cherche donc la sortie ailleurs dans l'ERP, sans contrainte de date
  // (justement, la date est ce qui manque), et on ne compte comme « non
  // comptée » que ce qui n'existe vraiment nulle part.
  plan.unreadable = []
  for (const u of parsed.unparsed || []) {
    if (u.amount == null || !u.vendor) { plan.unreadable.push({ ...u, covered_by: null }); continue }
    const amount = Math.abs(u.amount)
    const bill = openBills.find(b => labelsMatch(b.vendor, u.vendor)
      && (amountsClose(b.balance_due_cad, amount) || amountsClose(b.total_cad, amount)))
    const pmt = !bill && [...otherPendingPmts, ...existingSheetPmts].find(p =>
      !p.cleared_at && labelsMatch(p.label, u.vendor) && amountsClose(p.amount, amount))
    const rec = !bill && !pmt && activeRecurring.find(r =>
      labelsMatch(r.label, u.vendor) && Number(r.amount) > 0 && amountsClose(Number(r.amount), amount, 0.02))
    plan.unreadable.push({
      ...u,
      covered_by: bill ? { kind: 'bill', label: bill.vendor, date: String(bill.due_date || '').slice(0, 10) }
        : pmt ? { kind: 'payment', label: pmt.label, date: String(pmt.payment_date).slice(0, 10) }
          : rec ? { kind: 'recurring', label: rec.label, date: null } : null,
    })
  }

  // ── Sorties récurrentes ────────────────────────────────────────────────────
  const matchedRecurringIds = new Set()
  for (const row of parsed.recurring) {
    // Libellé d'abord ; sinon montant + jour identiques (« Dette Ville de Qc »
    // du fichier = « Dette Ville de Québec » de l'ERP).
    const rec = activeRecurring.find(r => labelsMatch(r.label, row.label))
      || (row.amount != null && activeRecurring.find(r =>
        amountsClose(Number(r.amount), row.amount, 0.001)
        && (!row.day || Number(r.day_of_month) === row.day)))
      || null
    if (rec) matchedRecurringIds.add(rec.id)
    if (!rec) {
      if (row.day && row.amount != null) {
        plan.recurring.push({ action: 'create', row })
      } else {
        plan.recurring.push({ action: 'report_unmatched', row, detail: 'Absente de l\'ERP mais jour ou montant illisible — à créer à la main' })
      }
      continue
    }
    if (row.variable) {
      plan.recurring.push({ action: 'match', row, recurring_id: rec.id, detail: 'Montant variable dans le fichier (relevé)' })
      continue
    }
    if (rec.frequency !== 'monthly') {
      const diff = row.amount != null && !amountsClose(Number(rec.amount), row.amount, 0.001)
      plan.recurring.push({
        action: diff ? 'report_diff' : 'match', row, recurring_id: rec.id,
        detail: diff ? `Montant fichier ${row.amount} $ ≠ ERP ${rec.amount} $ (récurrente ${rec.frequency}, non ajustée automatiquement)` : null,
      })
      continue
    }
    const updates = {}
    if (row.amount != null && Math.abs(Number(rec.amount) - row.amount) > 0.005) updates.amount = row.amount
    if (row.day && Number(rec.day_of_month) !== row.day) updates.day_of_month = row.day
    if (Object.keys(updates).length) {
      plan.recurring.push({ action: 'update', row, recurring_id: rec.id, recurring_label: rec.label, updates, previous: { amount: rec.amount, day_of_month: rec.day_of_month } })
    } else {
      plan.recurring.push({ action: 'match', row, recurring_id: rec.id })
    }
  }
  for (const r of activeRecurring) {
    if (matchedRecurringIds.has(r.id)) continue
    plan.recurring.push({
      action: 'report_missing_in_sheet', recurring_id: r.id,
      row: { label: r.label, amount: r.amount, day: r.day_of_month },
      detail: 'Configurée dans l\'ERP mais absente du bloc « Sorties récurrentes » du fichier',
    })
  }

  // ── Cédule de paie ─────────────────────────────────────────────────────────
  // 25 000 $ aux deux semaines : c'est de loin la plus grosse sortie, et
  // l'ERP la déduit d'une simple date d'ancrage. Si la cadence dérive d'une
  // semaine, la projection déplace 25 000 $ — assez pour transformer un solde
  // confortable en découvert. Le fichier liste les dates réelles : on s'aligne
  // dessus (le fichier fait foi), et l'écart est rapporté.
  const payDates = (parsed.payroll || []).map(p => p.date).filter(Boolean).sort()
  const futurePay = payDates.filter(d => d >= todayIso)
  if (futurePay.length) {
    const rec = activeRecurring.find(r => r.frequency === 'biweekly' && labelsMatch(r.label, 'paie'))
    if (!rec) {
      plan.payroll.push({
        action: 'report_no_recurring', dates: futurePay.slice(0, 3),
        detail: `Cédule de paie du fichier (prochaine le ${futurePay[0]}) sans récurrente « Paie » aux deux semaines dans l'ERP`,
      })
    } else {
      // Cadence de l'ERP sur la même fenêtre que le fichier.
      const erpDates = expandBiweekly(rec.anchor_date, todayIso, futurePay[futurePay.length - 1])
      const missing = futurePay.filter(d => !erpDates.includes(d))
      if (missing.length) {
        plan.payroll.push({
          action: 'update_anchor', recurring_id: rec.id, anchor_date: futurePay[0],
          previous: { anchor_date: String(rec.anchor_date || '').slice(0, 10), next: erpDates[0] || null },
          dates: futurePay.slice(0, 3),
          detail: `Cadence de paie décalée : le fichier annonce le ${futurePay[0]}, l'ERP le ${erpDates[0] || '—'}`,
        })
      } else {
        plan.payroll.push({ action: 'match', recurring_id: rec.id, dates: futurePay.slice(0, 3) })
      }
      const sheetAmount = (parsed.payroll.find(p => p.date === futurePay[0]) || {}).amount
      if (sheetAmount != null && Math.abs(Number(rec.amount) - sheetAmount) > 0.005) {
        plan.payroll.push({
          action: 'update_amount', recurring_id: rec.id, amount: sheetAmount,
          previous: { amount: Number(rec.amount) },
          detail: `Montant de paie du fichier ${sheetAmount.toFixed(2)} $ ≠ ERP ${Number(rec.amount).toFixed(2)} $`,
        })
      }
    }
  }

  return plan
}

// Occurrences aux deux semaines depuis `anchor`, dans [fromIso, toIso].
function expandBiweekly(anchor, fromIso, toIso) {
  const a = String(anchor || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(a)) return []
  const out = []
  const d = new Date(`${a}T12:00:00Z`)
  const end = new Date(`${toIso}T12:00:00Z`)
  while (d < new Date(`${fromIso}T12:00:00Z`)) d.setUTCDate(d.getUTCDate() + 14)
  while (d <= end) {
    out.push(`${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`)
    d.setUTCDate(d.getUTCDate() + 14)
  }
  return out
}

// La récurrente a-t-elle une occurrence proche de la date donnée ?
function recurringOccursNear(rec, dateIso, windowDays) {
  if (rec.frequency === 'monthly') {
    const day = Number(rec.day_of_month)
    if (!Number.isInteger(day)) return false
    const d = new Date(`${dateIso}T12:00:00Z`)
    for (const delta of [-1, 0, 1]) {
      const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + delta, 1, 12))
      const last = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0)).getUTCDate()
      const occ = `${m.getUTCFullYear()}-${pad2(m.getUTCMonth() + 1)}-${pad2(Math.min(day, last))}`
      if (dayDiff(occ, dateIso) <= windowDays) return true
    }
    return false
  }
  const anchor = String(rec.anchor_date || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) return false
  const step = rec.frequency === 'weekly' ? 7 : rec.frequency === 'biweekly' ? 14 : null
  if (step) {
    const diff = Math.round((new Date(`${dateIso}T12:00:00Z`) - new Date(`${anchor}T12:00:00Z`)) / 86400000)
    const rem = ((diff % step) + step) % step
    return Math.min(rem, step - rem) <= Math.min(windowDays, Math.floor(step / 2))
  }
  return false // quarterly : trop rare pour un rapprochement fiable, rapporté à part
}

// ── Application ──────────────────────────────────────────────────────────────

function applyPlan(plan, { userId = null } = {}) {
  const applied = { balance: null, payments: { created: 0, updated: 0, removed: 0, cleared: 0 }, recurring: { created: 0, updated: 0 } }

  if (plan.balance?.action === 'insert') {
    const id = randomUUID()
    db.prepare('INSERT INTO treasury_balances (id, balance, noted_at, created_by, source) VALUES (?,?,?,?,?)')
      .run(id, r2(plan.balance.sheet.amount), plan.balance.noted_at, userId, 'solde_sheet')
    applied.balance = id
  }

  const removeStmt = db.prepare(`
    UPDATE treasury_payments SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
  `)
  const dateStmt = db.prepare(`
    UPDATE treasury_payments SET payment_date = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
  `)
  // Ligne corrigée dans le fichier (montant et/ou date) : on met à jour le
  // paiement existant — et sa clé d'import, qui contient le montant.
  const lineStmt = db.prepare(`
    UPDATE treasury_payments SET payment_date = ?, amount = ?, import_key = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
  `)
  for (const p of plan.payments) {
    if (p.action === 'create' || p.action === 'reschedule_bill') {
      createPayment({
        payment_date: p.line.date, direction: 'out', amount: p.line.amount,
        currency: 'CAD', account: 'BNC CAD', label: p.line.vendor,
        achat_id: p.achat_id || null,
        notes: 'Importé du fichier « Maintien du solde disponible BNC »',
        source: 'import', import_key: p.key,
        // Couvert par sa propre ligne du fichier dès la naissance : autorise le
        // cochage automatique quand la ligne disparaîtra (goneLineOutcome).
        sheet_seen_at: new Date().toISOString(),
      }, userId)
      applied.payments.created++
    } else if (p.action === 'update_date') {
      dateStmt.run(p.line.date, p.payment_id)
      applied.payments.updated++
    } else if (p.action === 'update_line') {
      lineStmt.run(p.line.date, r2(p.line.amount), p.key, p.payment_id)
      applied.payments.updated++
    } else if (p.action === 'remove') {
      removeStmt.run(p.payment_id)
      applied.payments.removed++
    } else if (p.action === 'clear') {
      // La ligne a quitté le fichier et la date est passée : l'argent est sorti
      // du compte — même effet que le clic « Passé » sur /paiements-emis.
      setCleared(p.payment_id, true, { source: 'sheet' })
      applied.payments.cleared++
    }
  }

  // Marque « couvert par le fichier à cette sync » — le droit d'être coché
  // automatiquement plus tard. Ne touche jamais un paiement déjà passé.
  const stampStmt = db.prepare(`
    UPDATE treasury_payments SET sheet_seen_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ? AND deleted_at IS NULL AND cleared_at IS NULL
  `)
  for (const id of new Set(plan.stamp || [])) stampStmt.run(id)

  for (const r of plan.recurring) {
    if (r.action === 'create') {
      db.prepare(`
        INSERT INTO recurring_outflows (id, label, amount, frequency, day_of_month, notes, active)
        VALUES (?,?,?,'monthly',?,?,1)
      `).run(randomUUID(), r.row.label, r2(r.row.amount), r.row.day, 'Créée depuis le fichier « Maintien du solde disponible BNC »')
      applied.recurring.created++
    } else if (r.action === 'update') {
      const sets = []
      const args = []
      if ('amount' in r.updates) { sets.push('amount = ?'); args.push(r2(r.updates.amount)) }
      if ('day_of_month' in r.updates) { sets.push('day_of_month = ?'); args.push(r.updates.day_of_month) }
      db.prepare(`UPDATE recurring_outflows SET ${sets.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
        .run(...args, r.recurring_id)
      applied.recurring.updated++
    }
  }

  for (const p of plan.payroll || []) {
    if (p.action === 'update_anchor') {
      db.prepare(`UPDATE recurring_outflows SET anchor_date = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
        .run(p.anchor_date, p.recurring_id)
      applied.recurring.updated++
    } else if (p.action === 'update_amount') {
      db.prepare(`UPDATE recurring_outflows SET amount = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
        .run(r2(p.amount), p.recurring_id)
      applied.recurring.updated++
    }
  }

  return applied
}

// Résumé lisible du plan : ce qui a été ajusté et ce qui diffère sans être
// ajustable. C'est ce que la page Comptabilité et le journal affichent.
export function summarizePlan(plan, { applied = null } = {}) {
  const differences = []
  if (plan.balance?.action === 'insert') {
    differences.push({
      kind: 'balance', adjusted: !!applied,
      text: `Solde du fichier ${plan.balance.sheet.amount.toFixed(2)} $ (${plan.balance.sheet.date || '?'})` +
        (plan.balance.erp ? ` ≠ dernière saisie ERP ${plan.balance.erp.balance.toFixed(2)} $` : ' — aucune saisie ERP') +
        (applied ? ' → saisie importée' : ''),
    })
  } else if (plan.balance?.action === 'suspect') {
    differences.push({ kind: 'balance', adjusted: false, text: plan.balance.detail })
  }
  for (const p of plan.payments) {
    const l = p.line
    if (p.action === 'create') {
      differences.push({ kind: 'payment', adjusted: !!applied, text: `${l.vendor} ${l.amount.toFixed(2)} $ le ${l.date} : absent de la projection ERP${applied ? ' → paiement projeté créé' : ''}` })
    } else if (p.action === 'reschedule_bill') {
      differences.push({ kind: 'payment', adjusted: !!applied, text: `${l.vendor} ${l.amount.toFixed(2)} $ : le fichier le paie le ${l.date}, l'ERP projetait l'échéance ${p.due_date}${applied ? ' → date du fichier retenue' : ''}` })
    } else if (p.action === 'update_date') {
      differences.push({ kind: 'payment', adjusted: !!applied, text: `${l.vendor} ${l.amount.toFixed(2)} $ : déplacé au ${l.date} dans le fichier (était ${String(p.from).slice(0, 10)})${applied ? ' → ajusté' : ''}` })
    } else if (p.action === 'remove') {
      differences.push({ kind: 'payment', adjusted: !!applied, text: `${l.vendor} ${Number(l.amount).toFixed(2)} $ (${l.date}) : retiré du fichier${applied ? ' → retiré de la projection' : ''}` })
    } else if (p.action === 'clear') {
      differences.push({ kind: 'payment', adjusted: !!applied, text: `${l.vendor} ${Number(l.amount).toFixed(2)} $ (${l.date}) : retiré du fichier et date passée${applied ? ' → marqué « passé à la banque »' : ' → serait marqué « passé à la banque »'}` })
    } else if (p.action === 'update_line') {
      const parts = []
      if (Math.abs(Number(p.from.amount) - l.amount) > 0.005) parts.push(`montant ${Number(p.from.amount).toFixed(2)} $ → ${l.amount.toFixed(2)} $`)
      if (p.from.date !== l.date) parts.push(`date ${p.from.date} → ${l.date}`)
      differences.push({ kind: 'payment', adjusted: !!applied, text: `${l.vendor} : ligne corrigée dans le fichier (${parts.join(', ') || 'aucun changement'})${applied ? ' → paiement mis à jour' : ''}` })
    } else if (p.action === 'report_unverified') {
      differences.push({ kind: 'payment', adjusted: false, text: `${l.vendor} ${Number(l.amount).toFixed(2)} $ (ligne ${l.row}) : ${p.detail} — non appliqué, à corriger dans le fichier` })
    } else if (p.action === 'report_held') {
      differences.push({
        kind: 'payment', adjusted: false,
        text: `${l.vendor} ${Number(l.amount).toFixed(2)} $ (${l.date}) : ${p.would === 'clear' ? 'serait marqué « passé à la banque »' : 'serait retiré de la projection'} ` +
          `mais l'action est suspendue — ${p.detail}. La sortie reste comptée (prudence).`,
      })
    }
  }
  for (const r of plan.recurring) {
    if (r.action === 'update') {
      const parts = []
      if ('amount' in r.updates) parts.push(`montant ${Number(r.previous.amount).toFixed(2)} $ → ${r.updates.amount.toFixed(2)} $`)
      if ('day_of_month' in r.updates) parts.push(`jour ${r.previous.day_of_month ?? '?'} → ${r.updates.day_of_month}`)
      differences.push({ kind: 'recurring', adjusted: !!applied, text: `Récurrente « ${r.recurring_label} » : ${parts.join(', ')}${applied ? ' → ajustée' : ''}` })
    } else if (r.action === 'create') {
      differences.push({ kind: 'recurring', adjusted: !!applied, text: `Récurrente « ${r.row.label} » (${r.row.amount.toFixed(2)} $ le ${r.row.day}) : absente de l'ERP${applied ? ' → créée' : ''}` })
    } else if (r.action === 'report_diff' || r.action === 'report_unmatched' || r.action === 'report_missing_in_sheet') {
      differences.push({ kind: 'recurring', adjusted: false, text: `Récurrente « ${r.row.label} » : ${r.detail}` })
    }
  }
  for (const p of plan.payroll || []) {
    if (p.action === 'update_anchor') {
      differences.push({ kind: 'payroll', adjusted: !!applied, text: `Paie : ${p.detail}${applied ? ` → cadence alignée sur le fichier (${p.anchor_date})` : ''}` })
    } else if (p.action === 'update_amount') {
      differences.push({ kind: 'payroll', adjusted: !!applied, text: `Paie : ${p.detail}${applied ? ' → montant aligné sur le fichier' : ''}` })
    } else if (p.action === 'report_no_recurring') {
      differences.push({ kind: 'payroll', adjusted: false, text: p.detail })
    }
  }
  return differences
}

// ── Contrôles de bout en bout ────────────────────────────────────────────────

// Le fichier tient sa propre projection (dernière cellule « Solde disponible »).
// La comparer au solde que l'ERP projette au même jour est le contrôle le plus
// parlant qui soit : deux calculs indépendants sur les mêmes faits. L'écart est
// normal (l'ERP compte en plus les rentrées sûres et les factures que le fichier
// n'a pas), mais il doit rester explicable — affiché, jamais caché.
async function crossCheckAgainstProjection(chain) {
  if (!chain?.final_date || chain.final_balance == null) return null
  try {
    const { computeProjection } = await import('./treasury.js')
    const today = new Date()
    const days = Math.ceil((new Date(`${chain.final_date}T12:00:00Z`) - new Date(today.toISOString().slice(0, 10) + 'T12:00:00Z')) / 86400000)
    if (!Number.isFinite(days) || days < 0) return null
    const proj = computeProjection({ days: Math.max(7, days + 1), scenario: 'certain' })
    const day = proj.days.find(d => d.date === chain.final_date)
    if (!day) return null
    return {
      date: chain.final_date,
      sheet_balance: r2(chain.final_balance),
      erp_balance: r2(day.balance),
      delta: r2(day.balance - chain.final_balance),
    }
  } catch { return null }
}

// Anomalies de la dernière exécution enregistrée (pour ne notifier que le neuf).
function lastRunAnomalies() {
  const last = db.prepare(`
    SELECT result FROM automation_logs WHERE automation_id = ? AND status = 'success'
    ORDER BY created_at DESC LIMIT 1
  `).get(SOLDE_SHEET_AUTOMATION_ID)
  if (!last?.result) return []
  try {
    const parsed = JSON.parse(last.result)
    return Array.isArray(parsed?.anomalies) ? parsed.anomalies : []
  } catch { return [] }
}

const anomalyKey = a => `${a.code}|${a.row ?? '-'}|${a.text}`

// Slack sur toute anomalie de lecture NOUVELLE — DÉSACTIVÉ par défaut
// (slack_anomalies=0) : le canal comptabilité ne reçoit plus que le découvert
// imminent. Le bandeau rouge/ambre de la page Comptabilité et le journal de
// l'automation restent la voie de signalement.
async function notifyNewAnomalies(anomalies, previous) {
  if (getSoldeSheetConfig().slack_anomalies !== '1') return
  const fresh = anomalies.filter(a => a.severity === 'error'
    && !previous.some(p => anomalyKey(p) === anomalyKey(a)))
  if (!fresh.length) return
  try {
    const { getTreasuryConfig } = await import('./treasury.js')
    const envName = getTreasuryConfig().slack_webhook_env
    const url = envName ? process.env[envName] : null
    if (!url) return
    const text = ':warning: *Fichier « Maintien du solde disponible BNC » — lecture incomplète*\n' +
      fresh.map(a => `• ${a.text}`).join('\n') +
      '\nCorriger le fichier : tant que la ligne est illisible, la sortie n\'entre pas dans la projection du solde.'
    await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
    })
  } catch (e) {
    console.error('treasurySoldeSheet.notifyNewAnomalies:', e.message)
  }
}

// ── Sync complète ────────────────────────────────────────────────────────────

export async function syncSoldeSheet({ trigger = 'manual', apply = true, userId = null } = {}) {
  const t0 = Date.now()
  const cfg = getSoldeSheetConfig()
  const todayIso = new Date().toISOString().slice(0, 10)
  try {
    const { rows, raw } = await fetchPmtSuiviGrid({
      googleAccountEmail: cfg.google_account_email,
      fileId: cfg.spreadsheet_id,
      tab: cfg.sheet_name,
    })
    const parsed = parseSoldeSheet(rows, { todayIso, raw })
    const plan = diffSoldeSheet(parsed, { todayIso, windowDays: Number(cfg.match_window_days) || 10 })
    const applied = apply ? applyPlan(plan, { userId }) : null
    const differences = summarizePlan(plan, { applied })

    // Nouvelle saisie de solde importée : même chaîne qu'une saisie manuelle —
    // réconciliation prévu/réel puis vérification d'alerte (asynchrone).
    if (applied?.balance) {
      const { reconcileBalanceEntry, checkBalanceVariance, checkTreasuryAlert } = await import('./treasury.js')
      reconcileBalanceEntry(applied.balance)
      checkBalanceVariance(applied.balance, { trigger: 'import solde sheet' })
        .then(() => checkTreasuryAlert({ trigger: 'import solde sheet' }))
        .catch(() => {})
    }

    const modified = applied
      ? (applied.balance ? 1 : 0) + applied.payments.created + applied.payments.updated
        + applied.payments.removed + applied.payments.cleared
        + applied.recurring.created + applied.recurring.updated
      : 0
    // Santé de la LECTURE, distincte du succès technique de la sync : le fichier
    // peut être téléchargé sans erreur et rester incompréhensible. C'est cette
    // valeur que la page Comptabilité affiche en rouge/ambre — une sync « OK »
    // qui a silencieusement sauté une sortie de 3 391 $ n'est pas un succès.
    const previousAnomalies = lastRunAnomalies()
    // Une ligne illisible déjà projetée par ailleurs reste une anomalie (le
    // fichier doit être corrigé) mais pas une urgence : le dollar est compté.
    const anomalies = parsed.anomalies.map(a => {
      if (a.code !== 'ligne_illisible') return a
      const hit = (plan.unreadable || []).find(u => u.row === a.row)
      if (!hit?.covered_by) return a
      const src = { bill: 'une facture fournisseur', payment: 'un paiement émis', recurring: 'une sortie récurrente' }[hit.covered_by.kind]
      return {
        ...a, severity: 'warn',
        text: a.text.replace(/— cette sortie n'est PAS comptée dans la projection\.$/,
          `— déjà projetée par ${src} (« ${hit.covered_by.label} »${hit.covered_by.date ? `, ${hit.covered_by.date}` : ''}), ` +
          'donc comptée ; corriger quand même le fichier pour que la date fasse foi.'),
      }
    })
    const uncovered = (plan.unreadable || []).filter(u => !u.covered_by && u.amount != null)
    const errors = anomalies.filter(a => a.severity === 'error')
    const warns = anomalies.filter(a => a.severity === 'warn')
    const health = errors.length ? 'error' : warns.length ? 'warn' : 'ok'
    const chain = parsed.chain
    const result = {
      summary: (apply ? '' : 'Simulation : ') +
        `${parsed.planned.length} ligne(s) lues · ${chain.checked}/${parsed.planned.length} vérifiée(s) par la chaîne du fichier · ` +
        `${differences.length} différence(s)` + (apply ? ` · ${modified} ajustement(s) appliqué(s)` : ' détectée(s)') +
        (errors.length ? ` · ⚠️ ${errors.length} anomalie(s) de lecture` : ''),
      health,
      anomalies,
      chain: {
        ok: chain.ok, checked: chain.checked, unverified: chain.unverified,
        breaks: chain.breaks, final_balance: chain.final_balance, final_date: chain.final_date,
      },
      balance: plan.balance && { action: plan.balance.action, sheet: parsed.balance, erp: plan.balance.erp || null },
      differences,
      unparsed: parsed.unparsed,
      // Argent que le fichier annonce mais que la projection NE COMPTE PAS
      // (ligne illisible). Chiffré, pas seulement listé : c'est le montant dont
      // le solde projeté est optimiste — l'ordre de grandeur du risque.
      not_counted: {
        total: r2(uncovered.reduce((s, u) => s + Math.abs(Number(u.amount) || 0), 0)),
        lines: uncovered.map(u => ({ row: u.row, vendor: u.vendor, amount: Math.abs(u.amount) })),
      },
      cross_check: await crossCheckAgainstProjection(chain),
      applied,
    }
    logSync('treasury:solde-sheet', trigger === 'scheduled' ? 'scheduled' : 'manual',
      { status: 'success', modified, durationMs: Date.now() - t0 })
    logSystemRun(SOLDE_SHEET_AUTOMATION_ID, { status: 'success', result, duration_ms: Date.now() - t0, triggerData: { trigger, apply } })
    // Une anomalie de lecture ne doit JAMAIS rester dans un journal que personne
    // ne lit : Slack dès qu'elle apparaît (une fois — tant qu'elle persiste à
    // l'identique, le bandeau de la page suffit).
    if (apply) await notifyNewAnomalies(anomalies, previousAnomalies)
    return result
  } catch (e) {
    logSync('treasury:solde-sheet', trigger === 'scheduled' ? 'scheduled' : 'manual',
      { status: 'error', error: e.message, durationMs: Date.now() - t0 })
    logSystemRun(SOLDE_SHEET_AUTOMATION_ID, { status: 'error', error: e, duration_ms: Date.now() - t0, triggerData: { trigger, apply } })
    throw e
  }
}

// État pour la page Comptabilité : automation active ? dernière exécution ?
export function soldeSheetStatus() {
  const auto = db.prepare('SELECT active FROM automations WHERE id = ? AND system = 1').get(SOLDE_SHEET_AUTOMATION_ID)
  const last = db.prepare(`
    SELECT status, result, error, created_at FROM automation_logs
    WHERE automation_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(SOLDE_SHEET_AUTOMATION_ID) || null
  let result = null
  if (last?.result) { try { result = JSON.parse(last.result) } catch { result = { summary: last.result } } }
  return {
    active: !!(auto && auto.active),
    every_minutes: SOLDE_SHEET_INTERVAL_MINUTES,
    next_run_at: nextSoldeSheetRunAt(),
    last_run: last ? { status: last.status, executed_at: last.created_at, error: last.error, ...((result && typeof result === 'object') ? result : {}) } : null,
  }
}

// Prochaine exécution planifiée : l'heure pile suivante (cron '0 * * * *').
export function nextSoldeSheetRunAt() {
  const d = new Date()
  d.setUTCMinutes(0, 0, 0)
  d.setUTCHours(d.getUTCHours() + 1)
  return d.toISOString()
}

// Minutes écoulées depuis la dernière exécution (null si aucune) — sert au
// rattrapage au démarrage : un serveur redémarré ou arrêté plus d'une heure ne
// doit pas faire sauter un créneau.
export function minutesSinceLastSoldeSheetRun() {
  const last = db.prepare(`
    SELECT created_at FROM automation_logs WHERE automation_id = ?
    ORDER BY created_at DESC LIMIT 1
  `).get(SOLDE_SHEET_AUTOMATION_ID)
  if (!last?.created_at) return null
  const t = Date.parse(last.created_at)
  if (Number.isNaN(t)) return null
  return (Date.now() - t) / 60000
}

// Sync horaire (index.js) — coupe-circuit si l'automation est désactivée.
export async function scheduledSoldeSheetSync() {
  if (!isSystemAutomationActive(SOLDE_SHEET_AUTOMATION_ID)) return
  await syncSoldeSheet({ trigger: 'scheduled', apply: true })
}

// Rattrapage au démarrage : ne relance QUE si le dernier passage remonte à plus
// d'une heure (sinon un pm2 restart resynchroniserait à chaque fois et noierait
// le journal de l'automation).
export async function catchUpSoldeSheetSync() {
  if (!isSystemAutomationActive(SOLDE_SHEET_AUTOMATION_ID)) return
  const mins = minutesSinceLastSoldeSheetRun()
  if (mins !== null && mins < SOLDE_SHEET_INTERVAL_MINUTES) return
  await syncSoldeSheet({ trigger: 'scheduled (rattrapage démarrage)', apply: true })
}
