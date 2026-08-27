// Rapprochement bancaire — remplace le fichier TRX_Orisha.xlsx.
//
// Chaque compte (onglet du xlsx) devient un bank_account ; les relevés sont
// importés par collage (tab-séparé depuis Excel ou le site de la banque), puis
// un moteur de matching apparie chaque transaction aux documents de l'ERP
// (achats_fournisseurs, sale_receipts, stripe_payouts). Le statut — l'ancien
// code couleur peint à la main — est dérivé automatiquement :
//   a_traiter (rouge) → facture_recue (bleu) → comptabilise (jaune) → rapproche (vert).
import { createHash, randomUUID } from 'crypto'
import db from '../db/database.js'
import { autoClearFromBank } from './treasuryPayments.js'
import { detectBankReceipts } from './wageSubsidyReceipts.js'
import { detectTwilioBankRecharges } from './prepaid.js'

// ── Seed des comptes (onglets du xlsx TRX_Orisha) ────────────────────────────

const SEED_ACCOUNTS = [
  { name: 'BNC CAD', kind: 'bank', currency: 'CAD', institution: 'BNC', account_number: '0006-10281-0310224' },
  { name: 'BNC USD', kind: 'bank', currency: 'USD', institution: 'BNC', account_number: '0006-10281-0016' },
  { name: 'BNC Épargne', kind: 'bank', currency: 'CAD', institution: 'BNC', account_number: '0006-10281-7026521' },
  { name: 'MasterCard BNC', kind: 'card', currency: 'CAD', institution: 'BNC', account_number: '5258-8186-****' },
  { name: 'Desjardins CAD', kind: 'bank', currency: 'CAD', institution: 'Desjardins' },
  { name: 'Desjardins USD', kind: 'bank', currency: 'USD', institution: 'Desjardins' },
  { name: 'Marge Desjardins', kind: 'bank', currency: 'CAD', institution: 'Desjardins' },
  { name: 'VISA Desjardins CAD', kind: 'card', currency: 'CAD', institution: 'Desjardins' },
  { name: 'VISA Desjardins USD', kind: 'card', currency: 'USD', institution: 'Desjardins' },
  { name: 'Venn USD', kind: 'bank', currency: 'USD', institution: 'Venn' },
  { name: 'Venn CAD', kind: 'bank', currency: 'CAD', institution: 'Venn' },
]

export function seedBankAccounts() {
  const insert = db.prepare(`
    INSERT OR IGNORE INTO bank_accounts (id, name, kind, currency, account_number, institution, sort_order)
    VALUES (?,?,?,?,?,?,?)
  `)
  SEED_ACCOUNTS.forEach((a, i) => {
    insert.run(randomUUID(), a.name, a.kind, a.currency, a.account_number || null, a.institution || null, i)
  })
}

// ── Parsing d'un relevé collé ────────────────────────────────────────────────

// '20 000,00', '1,234.56', '(75.42)', '-75,42 $', '73.51CR' → nombre ou null.
export function parseAmount(raw) {
  if (raw == null) return null
  let s = String(raw).replace(/[\s\u00a0\u202f$]/g, '').replace(/CAD|USD/gi, '')
  if (!s) return null
  let negative = false
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1) }
  if (/CR$/i.test(s)) { s = s.replace(/CR$/i, '') }
  if (/DB$/i.test(s)) { negative = true; s = s.replace(/DB$/i, '') }
  if (s.startsWith('-')) { negative = true; s = s.slice(1) }
  // Décimale virgule (1 234,56) vs séparateur de milliers virgule (1,234.56) :
  // la dernière ponctuation rencontrée est la décimale.
  const lastComma = s.lastIndexOf(',')
  const lastDot = s.lastIndexOf('.')
  if (lastComma > lastDot) s = s.replace(/\./g, '').replace(/,/g, '.')
  else s = s.replace(/,/g, '')
  if (!/^\d+(\.\d+)?$/.test(s)) return null
  const n = Number(s)
  if (!Number.isFinite(n)) return null
  return negative ? -n : n
}

const FR_MONTHS = {
  jan: 1, janv: 1, fev: 2, févr: 2, fevr: 2, mar: 3, mars: 3, avr: 4, mai: 5,
  juin: 6, juil: 7, aou: 8, août: 8, aout: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12, déc: 12,
}
const EN_MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
}

// Divers formats de relevés → 'YYYY-MM-DD' (date métier, sans heure) ou null.
// Les formats numériques ambigus sont lus jour/mois (banques canadiennes fr).
export function parseTxnDate(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s)
  if (m) {
    let [, a, b, y] = m
    let day = Number(a); let month = Number(b)
    if (month > 12 && day <= 12) { [day, month] = [month, day] }
    if (month < 1 || month > 12 || day < 1 || day > 31) return null
    return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }
  // '27 juil. 2026' / 'Jul 27 2026' / 'Mon Jul 27 2026 ...'
  m = /^(?:\w{3,10}\s+)?(\d{1,2})\s+([A-Za-zÀ-ÿ.]+)\s+(\d{4})/.exec(s)
  let day; let monthWord; let year
  if (m) { day = Number(m[1]); monthWord = m[2]; year = m[3] } else {
    m = /^(?:\w{3},?\s+)?([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})/.exec(s)
    if (!m) return null
    monthWord = m[1]; day = Number(m[2]); year = m[3]
  }
  const key = monthWord.toLowerCase().replace(/\./g, '').slice(0, 4)
  const month = FR_MONTHS[key] || FR_MONTHS[key.slice(0, 3)] || EN_MONTHS[key.slice(0, 3)]
  if (!month || day < 1 || day > 31) return null
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

// Mots-clés d'entêtes → rôle de colonne.
const HEADER_ROLES = [
  { role: 'date', re: /^date(\s|$)/i },
  // « Autres détails » avant « Description » : le relevé BNC a les deux, et
  // c'est le premier qui porte la nature de la transaction.
  { role: 'details', re: /autres?\s*d[ée]tails?/i },
  { role: 'description', re: /description|libell/i },
  { role: 'reference', re: /r[ée]f[ée]rence|no\s*ref/i },
  { role: 'debit', re: /d[ée]bit|retrait/i },
  { role: 'credit', re: /cr[ée]dit|d[ée]p[oô]t/i },
  { role: 'amount', re: /^montant|^amount/i },
  { role: 'balance', re: /solde|balance/i },
]

function detectHeader(cells) {
  const roles = cells.map((c) => {
    const t = String(c || '').trim()
    if (!t) return null
    const hit = HEADER_ROLES.find((h) => h.re.test(t))
    return hit ? hit.role : null
  })
  const hasDate = roles.includes('date')
  const hasMoney = roles.includes('amount') || roles.includes('debit') || roles.includes('credit')
  return hasDate && hasMoney ? roles : null
}

// Texte collé (tab-séparé, avec ligne d'entêtes) → { rows, errors }.
// rows : { txn_date, description, reference, amount (signé, négatif = sortie), balance }.
export function parseStatementText(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '')
  if (!lines.length) return { rows: [], errors: ['Texte vide'] }
  const table = lines.map((l) => l.split('\t'))
  let headerIdx = -1
  let roles = null
  for (let i = 0; i < Math.min(table.length, 12); i++) {
    const r = detectHeader(table[i])
    if (r) { headerIdx = i; roles = r; break }
  }
  if (!roles) {
    return {
      rows: [],
      errors: ["Entêtes introuvables — coller le relevé avec sa ligne d'entêtes (Date, Description, Montant ou Débit/Crédit…)"],
    }
  }
  const col = {}
  roles.forEach((role, idx) => { if (role && !(role in col)) col[role] = idx })
  const rows = []
  const errors = []
  for (let i = headerIdx + 1; i < table.length; i++) {
    const cells = table[i]
    const dateRaw = cells[col.date]
    // Lignes de légende/sous-entêtes/totaux mélangées au collage : ignorées sans erreur.
    const txnDate = parseTxnDate(dateRaw)
    if (!txnDate) {
      if (String(dateRaw || '').trim()) errors.push(`Ligne ${i + 1} : date illisible « ${String(dateRaw).slice(0, 30)} »`)
      continue
    }
    let amount = null
    if (col.amount != null) amount = parseAmount(cells[col.amount])
    if (amount == null) {
      const debit = col.debit != null ? parseAmount(cells[col.debit]) : null
      const credit = col.credit != null ? parseAmount(cells[col.credit]) : null
      if (debit != null && debit !== 0) amount = -Math.abs(debit)
      else if (credit != null) amount = Math.abs(credit)
    }
    if (amount == null) { errors.push(`Ligne ${i + 1} : montant illisible`); continue }
    rows.push({
      txn_date: txnDate,
      description: String(cells[col.description] ?? '').trim() || null,
      details: col.details != null ? (String(cells[col.details] ?? '').trim() || null) : null,
      reference: String(cells[col.reference] ?? '').trim() || null,
      amount: Math.round(amount * 100) / 100,
      balance: col.balance != null ? parseAmount(cells[col.balance]) : null,
    })
  }
  return { rows, errors }
}

// ── Import avec déduplication ────────────────────────────────────────────────

// Deux achats identiques le même jour sont légitimes : la clé inclut un rang
// d'occurrence, et l'import d'une plage qui chevauche l'existant ne ré-insère
// que les occurrences au-delà de celles déjà en base.
function dedupKey(accountId, row, occurrence) {
  const base = [accountId, row.txn_date, row.amount, (row.description || '').toLowerCase(), (row.reference || '').toLowerCase(), occurrence].join('|')
  return createHash('sha1').update(base).digest('hex')
}

export function importTransactions(accountId, rows, userId) {
  const batchId = randomUUID()
  const insert = db.prepare(`
    INSERT OR IGNORE INTO bank_transactions
      (id, account_id, txn_date, description, details, reference, amount, balance, dedup_key, import_batch_id, sheet_color)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)
  `)
  let inserted = 0
  const counters = new Map()
  const tx = db.transaction(() => {
    for (const row of rows) {
      const sig = [row.txn_date, row.amount, (row.description || '').toLowerCase(), (row.reference || '').toLowerCase()].join('|')
      const occurrence = counters.get(sig) || 0
      counters.set(sig, occurrence + 1)
      const res = insert.run(
        randomUUID(), accountId, row.txn_date, row.description, row.details || null, row.reference,
        row.amount, row.balance, dedupKey(accountId, row, occurrence), batchId,
        row.sheet_color || null
      )
      inserted += res.changes
    }
    db.prepare(`
      INSERT INTO bank_import_batches (id, account_id, row_count, inserted_count, duplicate_count, created_by)
      VALUES (?,?,?,?,?,?)
    `).run(batchId, accountId, rows.length, inserted, rows.length - inserted, userId || null)
  })
  tx()
  // Le relevé est la confirmation qu'un paiement émis est passé au compte : dès
  // qu'il arrive, les paiements retrouvés cessent d'être projetés (voir
  // services/treasuryPayments.js). Ne doit jamais faire échouer l'import.
  try {
    const account = db.prepare('SELECT name FROM bank_accounts WHERE id=?').get(accountId)
    if (account) autoClearFromBank({ accountName: account.name })
  } catch (e) {
    console.error('bankReconciliation.autoClearFromBank:', e.message)
  }
  // Détection des versements de subvention (ex. Biotalent) parmi les
  // transactions créditrices — voir services/wageSubsidyReceipts.js. Ne doit
  // jamais faire échouer l'import.
  try {
    detectBankReceipts()
  } catch (e) {
    console.error('bankReconciliation.detectBankReceipts:', e.message)
  }
  // Recharges Twilio (compte Venn USD) : propose la comptabilisation QB et
  // ajuste le ledger prépayé — voir services/prepaid.js:detectTwilioBankRecharges.
  // Ne doit jamais faire échouer l'import.
  try {
    detectTwilioBankRecharges()
  } catch (e) {
    console.error('bankReconciliation.detectTwilioBankRecharges:', e.message)
  }
  return { batchId, rowCount: rows.length, inserted, duplicates: rows.length - inserted }
}

// ── Matching transactions ↔ documents ERP ────────────────────────────────────

const DATE_WINDOW_DAYS = 7

export function normalizeLabel(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
}

// Le libellé bancaire contient-il le nom du fournisseur (ou un alias de son
// profil) ? Comparaison par tokens ≥ 3 caractères pour tolérer les troncatures
// des relevés (« DKC*DIGI-KEY CORP » ~ « Digi-Key »).
export function labelMatchesVendor(bankLabel, vendorName, aliases = []) {
  const label = normalizeLabel(bankLabel)
  if (!label) return false
  for (const name of [vendorName, ...aliases]) {
    const tokens = normalizeLabel(name).split(' ').filter((t) => t.length >= 3)
    if (tokens.length && tokens.every((t) => label.includes(t))) return true
    // Nom compacté (« digikey » dans le libellé vs « digi key » au profil).
    const compact = tokens.join('')
    if (compact.length >= 5 && label.replace(/ /g, '').includes(compact)) return true
  }
  return false
}

function daysBetween(a, b) {
  return Math.abs((new Date(`${a}T12:00:00Z`) - new Date(`${b}T12:00:00Z`)) / 86400000)
}

let vendorProfilesCache = null
function vendorProfiles() {
  if (!vendorProfilesCache) {
    vendorProfilesCache = db.prepare('SELECT name, aliases FROM vendor_profiles WHERE deleted_at IS NULL').all()
      .map((p) => {
        let aliases = []
        try { aliases = JSON.parse(p.aliases || '[]') } catch {}
        return { name: p.name, aliases }
      })
  }
  return vendorProfilesCache
}
export function invalidateVendorProfilesCache() { vendorProfilesCache = null }

// Candidats de matching pour une transaction. Retourne une liste triée par
// confiance décroissante : { type, id, label, date, total, quickbooks_id, confidence }.
export function findCandidates(txn) {
  const amountAbs = Math.abs(txn.amount)
  const tol = 0.011
  const from = shiftDate(txn.txn_date, -DATE_WINDOW_DAYS)
  const to = shiftDate(txn.txn_date, DATE_WINDOW_DAYS)
  const candidates = []
  const alreadyMatched = new Set(
    db.prepare(`
      SELECT matched_type || ':' || matched_id AS k FROM bank_transactions
      WHERE matched_id IS NOT NULL AND deleted_at IS NULL AND id != ?
    `).all(txn.id).map((r) => r.k)
  )

  if (txn.amount < 0) {
    // Sortie → achat/facture fournisseur ou reçu de vente (dépense).
    const achats = db.prepare(`
      SELECT id, vendor, date_achat, due_date, total_cad AS total, quickbooks_id
      FROM achats_fournisseurs
      WHERE ABS(ABS(total_cad) - ?) < ?
        AND (
          (date_achat BETWEEN ? AND ?)
          OR (due_date IS NOT NULL AND due_date BETWEEN ? AND ?)
        )
    `).all(amountAbs, tol, from, to, from, to)
    for (const a of achats) {
      candidates.push({
        type: 'achat', id: a.id, label: a.vendor || '(sans fournisseur)',
        date: a.date_achat, total: a.total, quickbooks_id: a.quickbooks_id,
        vendorHit: labelMatchesVendor(txn.description, a.vendor) || profileAliasHit(txn.description, a.vendor),
        dateDist: Math.min(daysBetween(txn.txn_date, a.date_achat), a.due_date ? daysBetween(txn.txn_date, a.due_date) : 99),
      })
    }
    const receipts = db.prepare(`
      SELECT id, company, receipt_date, total, quickbooks_id
      FROM sale_receipts
      WHERE deleted_at IS NULL AND status = 'done'
        AND ABS(ABS(total) - ?) < ? AND receipt_date BETWEEN ? AND ?
    `).all(amountAbs, tol, from, to)
    for (const r of receipts) {
      candidates.push({
        type: 'receipt', id: String(r.id), label: r.company || '(sans fournisseur)',
        date: r.receipt_date, total: r.total, quickbooks_id: r.quickbooks_id,
        vendorHit: labelMatchesVendor(txn.description, r.company) || profileAliasHit(txn.description, r.company),
        dateDist: daysBetween(txn.txn_date, r.receipt_date),
      })
    }
  } else {
    // Entrée → payout Stripe (ou remboursement fournisseur via achat négatif).
    const payouts = db.prepare(`
      SELECT id, amount, arrival_date, qb_deposit_id
      FROM stripe_payouts
      WHERE ABS(amount - ?) < ? AND substr(arrival_date, 1, 10) BETWEEN ? AND ?
    `).all(amountAbs, tol, from, to)
    for (const p of payouts) {
      candidates.push({
        type: 'stripe_payout', id: String(p.id), label: 'Payout Stripe',
        date: String(p.arrival_date || '').slice(0, 10), total: p.amount, quickbooks_id: p.qb_deposit_id,
        vendorHit: /stripe/i.test(txn.description || ''),
        dateDist: daysBetween(txn.txn_date, String(p.arrival_date || txn.txn_date).slice(0, 10)),
      })
    }
  }

  for (const c of candidates) {
    let conf = 0.5
    if (c.vendorHit) conf += 0.4
    if (c.dateDist <= 1) conf += 0.1
    else if (c.dateDist > 4) conf -= 0.1
    if (alreadyMatched.has(`${c.type}:${c.id}`)) conf -= 0.35
    c.confidence = Math.round(Math.min(0.99, Math.max(0.05, conf)) * 100) / 100
    delete c.vendorHit
    delete c.dateDist
  }
  candidates.sort((a, b) => b.confidence - a.confidence)
  return candidates
}

function profileAliasHit(bankLabel, vendorName) {
  const key = normalizeLabel(vendorName)
  const profile = vendorProfiles().find((p) => normalizeLabel(p.name) === key)
  if (!profile) return false
  return labelMatchesVendor(bankLabel, profile.name, profile.aliases)
}

function shiftDate(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

// ── Statuts ──────────────────────────────────────────────────────────────────

// Le document apparié est-il publié à QuickBooks ?
function matchedDocQbId(matchedType, matchedId) {
  if (!matchedType || !matchedId) return null
  if (matchedType === 'achat') {
    return db.prepare('SELECT quickbooks_id FROM achats_fournisseurs WHERE id=?').get(matchedId)?.quickbooks_id || null
  }
  if (matchedType === 'receipt') {
    return db.prepare('SELECT quickbooks_id FROM sale_receipts WHERE id=?').get(matchedId)?.quickbooks_id || null
  }
  if (matchedType === 'stripe_payout') {
    return db.prepare('SELECT qb_deposit_id FROM stripe_payouts WHERE id=?').get(matchedId)?.qb_deposit_id || null
  }
  return null
}

// Le statut d'une ligne ne dépend PAS que du document ERP : une transaction
// peut être saisie directement dans QuickBooks (paie, taxes, virements) sans
// jamais passer par une facture de l'ERP. Deux preuves valent un document :
//   • `qb_txn_id` — l'écriture QB a été retrouvée (voir bankQbSearch.js) ;
//   • `sheet_color` — la couleur que Michel a posée dans TRX_Orisha.
// Sans ça, 67 lignes vertes (comptabilisées ET rapprochées) restaient
// « à traiter » et remontaient en anomalie « facture manquante ».
export function deriveStatus(txn) {
  if (txn.status === 'ignore') return 'ignore'
  if (txn.reconciled_at) return 'rapproche'
  if (txn.sheet_color === 'vert' && txn.qb_txn_id) return 'rapproche'
  const docInQb = txn.matched_id ? !!matchedDocQbId(txn.matched_type, txn.matched_id) : false
  if (docInQb || txn.qb_txn_id || txn.sheet_color === 'jaune') return 'comptabilise'
  if (txn.matched_id || txn.sheet_color === 'bleu') return 'facture_recue'
  return 'a_traiter'
}

// Recalcule le statut des transactions non figées d'un compte : une facture
// poussée à QB après le matching fait passer la ligne bleu → jaune sans action.
export function refreshStatuses(accountId) {
  const rows = db.prepare(`
    SELECT id, status, matched_type, matched_id, reconciled_at, sheet_color, qb_txn_id
    FROM bank_transactions
    WHERE account_id = ? AND deleted_at IS NULL AND status NOT IN ('ignore','rapproche')
  `).all(accountId)
  const update = db.prepare(`
    UPDATE bank_transactions SET status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?
  `)
  let changed = 0
  for (const t of rows) {
    const next = deriveStatus(t)
    if (next !== t.status) { update.run(next, t.id); changed++ }
  }
  return changed
}

// Matching automatique : n'attache que les cas sûrs (confiance ≥ 0.8 et sans
// ambiguïté au sommet) ; le reste passe par les suggestions dans l'UI.
export function autoMatchAccount(accountId) {
  invalidateVendorProfilesCache()
  const txns = db.prepare(`
    SELECT * FROM bank_transactions
    WHERE account_id=? AND deleted_at IS NULL AND matched_id IS NULL AND status IN ('a_traiter')
  `).all(accountId)
  const update = db.prepare(`
    UPDATE bank_transactions
    SET matched_type=?, matched_id=?, match_method='auto', match_confidence=?,
        status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id=?
  `)
  let matched = 0
  const takenThisRun = new Set()
  for (const txn of txns) {
    const candidates = findCandidates(txn).filter((c) => !takenThisRun.has(`${c.type}:${c.id}`))
    const best = candidates[0]
    if (!best || best.confidence < 0.8) continue
    if (candidates[1] && candidates[1].confidence >= best.confidence - 0.05) continue
    takenThisRun.add(`${best.type}:${best.id}`)
    const status = deriveStatus({ ...txn, matched_type: best.type, matched_id: best.id })
    update.run(best.type, best.id, best.confidence, status, txn.id)
    matched++
  }
  return { scanned: txns.length, matched }
}
