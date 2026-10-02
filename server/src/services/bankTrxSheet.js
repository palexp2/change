// Le FORMAT du classeur TRX_Orisha : en-têtes, colonnes, dates, montants,
// couleurs, plan de déduplication.
//
// Ce module lisait le fichier toutes les 20 minutes et en importait les lignes.
// CE SENS EST MORT depuis le 2026-09-15 : les relevés entrent par le dépôt de
// fichiers (services/bankStatementImport.js) et c'est Boréal qui ÉCRIT le
// classeur (services/trxSheetMirror.js). L'audit QuickBooks qui vivait ici est
// devenu le moteur unique services/bankQbVerify.js.
//
// Ce qui reste ici, ce sont les utilitaires de format — dont dépendent le dépôt
// de relevés ET le miroir sortant. D'où un fichier conservé, et vidé de sa sync.
//
// L'historique (2024 → juillet 2026) a été importé avec des descriptions
// parfois composées différemment : la déduplication se fait par
// (date, montant signé) et non par libellé — voir planImportFromCounts.
import db from '../db/database.js'
import { parseAmount } from './bankReconciliation.js'
import { shiftDate } from '../utils/datetime.js'
import { extractForeignAmount, extractCheckNumber, normalizeBankState } from './bankTxnFacts.js'

export const TRX_SHEET_AUTOMATION_ID = 'sys_bank_trx_sheet'

export const TRX_SHEET_DEFAULT_CONFIG = {
  file_id: '1zztgXO-Z6b0I4bGmP5TcyCXMbT-X3cjBjGG2z4ccUug', // TRX_Orisha (Google Sheet natif depuis le 2026-09-15)
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
  // Méthodes d'appariement QuickBooks posées SANS demander (les autres
  // deviennent des propositions à confirmer — services/bankProposals/).
  // Vider la liste coupe tout appariement automatique.
  auto_apply_methods: 'exact,conversion',
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

// Les comptes dont le relevé note les achats en POSITIF (cartes Visa
// Desjardins). Une seule table de vérité pour le sens du montant : la sync du
// fichier et le dépôt de relevés (services/bankStatementImport.js) la partagent.
export const ACCOUNTS_WITH_INVERTED_STATEMENT = new Set(
  Object.values(TAB_SPECS).filter((s) => s.invert).map((s) => s.account)
)

export function statementInvertsSign(accountName) {
  return ACCOUNTS_WITH_INVERTED_STATEMENT.has(accountName)
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

// Une couleur verte ou jaune est une affirmation : « c'est dans QuickBooks ».
export const COLOR_MEANS_IN_QB = new Set(['vert', 'jaune'])

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
export function findHeader(rows) {
  let found = -1
  for (let i = 0; i < Math.min(rows.length, 12); i++) {
    const cells = Array.from(rows[i] || [], strip)
    if (cells.some((c) => /^date/.test(c)) && cells.some((c) => MONEY_HEADER.test(c))) found = i
  }
  return found
}

export function mapColumns(headerCells) {
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
    // La colonne « X » du classeur : Charles y met un X pour dire à Michel
    // qu'il veut sa relecture (« Trx non révisée (Mike) » dans la légende).
    if (cols.review == null && /^x$/.test(c)) cols.review = i
    // « Commentaires ML » / « Commentaires AL/ML » : l'annotation de Michel,
    // synchronisée dans les deux sens avec le commentaire de la ligne dans Boréal.
    if (cols.comment == null && /^commentaire/.test(c)) cols.comment = i
  })
  if (cols.description == null && cols.category != null) cols.description = cols.category
  return cols
}

// Montant signé d'une ligne : négatif = argent qui sort du compte.
// Renvoie aussi les intérêts de la marge de crédit quand la ligne en porte.
function rowAmount(row, cols, spec) {
  let amount = null
  let interestCad = null
  if (cols.interest != null || cols.advance != null || cols.remb != null) {
    // Marge de crédit. Les INTÉRÊTS ne bougent pas le solde utilisé — le
    // fichier le dit : « Remboursement automatique de 19 686,89 $ » porte
    // 686,89 $ d'intérêts et 19 000 $ de remboursement, et le solde ne recule
    // que de 19 000 $. Les intérêts sortent du compte courant avec le capital,
    // dans un seul débit de 19 686,89 $. On ne les compte donc pas ici ; ils
    // repartent à part, pour que l'écriture puisse être coupée.
    const interest = cols.interest != null ? parseTrxAmount(row[cols.interest]) : null
    const advance = cols.advance != null ? parseTrxAmount(row[cols.advance]) : null
    const remb = cols.remb != null ? parseTrxAmount(row[cols.remb]) : null
    if (interest == null && advance == null && remb == null) return null
    interestCad = interest ? Math.abs(interest) : null
    amount = (advance || 0) - Math.abs(remb || 0)
    if (!amount) return { amount: null, interest: interestCad }
    if (spec?.invert) amount = -amount
    return { amount: Math.round(amount * 100) / 100, interest: interestCad }
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
  return { amount: Math.round(amount * 100) / 100, interest: interestCad }
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
export function tabDescending(dates) {
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
    const money = rowAmount(row, cols, spec)
    const amount = money?.amount ?? null
    if (amount == null) {
      // Une ligne de marge qui ne porte QUE des intérêts ne déplace pas le
      // solde : ce n'est pas un montant illisible, c'est une ligne sans
      // mouvement. Le débit du compte courant, lui, porte ces intérêts.
      if (money?.interest) continue
      if (warnings.length < 8) warnings.push(`ligne ${r + 1} : date ${txnDate} mais montant illisible`)
      continue
    }
    let description = String(row[cols.description] ?? '').trim()
    // Onglets Venn : Description + Transaction Type (+ Status si non complété),
    // comme l'historique déjà en base (« STRIPE — Inbound Transfer »). Le type
    // reste AUSSI dans sa propre colonne : concaténé, il n'était plus
    // exploitable pour préparer l'écriture.
    let txnType = cols.type != null ? String(row[cols.type] ?? '').trim() || null : null
    // L'état à la banque, lu tel quel dans la colonne « Statut » du fichier. Il
    // reste AUSSI collé au libellé : la clé de dédup en dépend, la retirer
    // ferait réimporter tout l'historique en double.
    const bankState = normalizeBankState(cols.status != null ? row[cols.status] : null)
    if (cols.type != null) {
      const type = txnType || ''
      if (type && strip(type) !== strip(description)) description = description ? `${description} — ${type}` : type
      const status = String(row[cols.status] ?? '').trim()
      if (status && !/^complete/i.test(strip(status))) description += ` — ${status}`
    }
    // La catégorie de la banque n'est retenue que si elle dit autre chose que
    // la description (elle lui sert parfois de repli — voir mapColumns).
    let bankCategory = cols.category != null && cols.category !== cols.description
      ? String(row[cols.category] ?? '').trim() || null
      : null
    const details = cols.details != null ? (String(row[cols.details] ?? '').trim() || null) : null
    const reference = cols.reference != null ? (String(row[cols.reference] ?? '').trim() || null) : null
    const foreign = extractForeignAmount(`${description} ${details || ''}`)
    out.push({
      txn_date: txnDate,
      sheet_color: colorAt ? rowColor(colorAt, r, cols) : null,
      description: description || null,
      details,
      reference,
      amount,
      // Seulement quand la ligne en porte : les onglets ordinaires n'ont pas
      // de colonne d'intérêts, et l'objet émis est comparé tel quel en test.
      ...(money.interest ? { interest_cad: money.interest } : {}),
      balance: cols.balance != null ? parseTrxAmount(row[cols.balance]) : null,
      bank_category: bankCategory,
      txn_type: txnType,
      check_number: extractCheckNumber(description, reference),
      orig_currency: foreign?.currency || null,
      orig_amount: foreign ? (amount < 0 ? -foreign.amount : foreign.amount) : null,
      bank_state: bankState,
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

// Ce qui est DÉJÀ en base sur un compte, compté par signature (date|montant
// signé) — la même monnaie que planImportFromCounts. Les lignes soft-deleted
// comptent : une transaction supprimée à la main ne doit pas ressusciter.
// Partagé avec le dépôt de relevés (services/bankStatementImport.js).
export function existingSignatureCounts(accountId, since) {
  return new Map(
    db.prepare(`
      SELECT txn_date || '|' || printf('%.2f', amount) AS sig, COUNT(*) AS n
      FROM bank_transactions WHERE account_id=? AND txn_date >= ? GROUP BY sig
    `).all(accountId, since).map((r) => [r.sig, r.n])
  )
}

// ── Lecture du fichier : COUPÉE le 2026-09-15 ────────────────────────────────
//
// Ce module lisait TRX_Orisha.xlsx toutes les 20 minutes et en importait les
// lignes. Ce sens est mort : les relevés entrent maintenant par le dépôt de
// fichiers (services/bankStatementImport.js) et c'est Boréal qui ÉCRIT le
// classeur (services/trxSheetMirror.js). Relire ce qu'on vient d'écrire n'a
// plus de sens, et l'audit QuickBooks qui vivait ici est devenu le moteur
// unique services/bankQbVerify.js.
//
// Ce qui reste : les UTILITAIRES DE FORMAT du classeur (en-têtes, colonnes,
// dates, montants, couleurs, plan de déduplication). Le dépôt de relevés et le
// miroir sortant en dépendent tous les deux — c'est pourquoi le fichier n'est
// pas supprimé.
//
// `COLOR_MEANS_IN_QB` et `bank_transactions.sheet_color` restent lus par
// deriveStatus() : ce sont des données HISTORIQUES figées (2024-2025), plus
// personne ne peint de couleur à la main. Les retirer ferait régresser des
// centaines de lignes au statut « à traiter ».
