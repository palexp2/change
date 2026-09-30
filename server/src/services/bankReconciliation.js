// Rapprochement bancaire — remplace le fichier TRX_Orisha.xlsx.
//
// Chaque compte (onglet du xlsx) devient un bank_account ; les relevés sont
// importés par collage (tab-séparé depuis Excel ou le site de la banque), puis
// un moteur de matching apparie chaque transaction aux documents de l'ERP
// (achats_fournisseurs, sale_receipts, stripe_payouts). Le statut — l'ancien
// code couleur peint à la main — est dérivé automatiquement :
//   a_traiter (rouge) → facture_recue (bleu) → comptabilise (jaune) → rapproche (vert).
import { createHash } from 'crypto'
import { newRecordId } from '../utils/recordId.js'
import db from '../db/database.js'
import { alignReceiptDatesForAccount, alignReceiptDate } from './receiptBankDate.js'
import { producePaymentClears, producePaieDebits } from './bankProposals/producers.js'
import { reconcileAndPersist } from './bankProposals/store.js'
import { dedupeClaims } from './bankProposals/model.js'
import { detectBankReceipts } from './wageSubsidyReceipts.js'
import { detectTwilioBankRecharges } from './prepaid.js'
import { shiftDate, daysBetween } from '../utils/datetime.js'
import { isSystemAutomationActive } from './systemAutomations.js'
import { BANK_DEBIT_LINK_AUTOMATION_ID } from './bankDebitLink.js'
import { txnFacts, normalizeBankState } from './bankTxnFacts.js'
import { touchBankTxns } from './realtimeEmitters.js'
import { usdCadRateLookup } from './fx.js'
import { findDocCandidates, confidenceFromScore } from './bankReceiptMatch.js'

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
    insert.run(newRecordId(), a.name, a.kind, a.currency, a.account_number || null, a.institution || null, i)
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
  // Marge de crédit Desjardins : trois colonnes au lieu d'une. Les INTÉRÊTS ne
  // bougent pas le solde utilisé (le fichier de suivi le montre : un
  // remboursement de 19 686,89 $ = 686,89 $ d'intérêts + 19 000 $ de capital,
  // et le solde ne recule que de 19 000 $) — ils sortent du compte courant
  // avec le capital, en un seul débit.
  { role: 'interest', re: /^int[ée]r[êe]t/i },
  { role: 'advance', re: /^avance/i },
  { role: 'remb', re: /^remb/i },
  { role: 'balance', re: /solde|balance/i },
  // L'état à la banque, tel que le portail l'imprime (« En attente »,
  // « Autorisée », « Completed ») : c'est la SEULE source fiable de cette
  // information — l'ERP ne peut pas la déduire d'une ligne de relevé.
  { role: 'bank_state', re: /^statu[ts]|^[ée]tat(\s|$)/i },
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

// Tableau de cellules (déjà découpé) → { rows, errors }. Le collage tab-séparé,
// un CSV et un onglet de classeur arrivent tous ici : seul le découpage diffère.
// rows : { txn_date, description, details, reference, amount (signé, négatif = sortie), balance }.
export function parseStatementTable(table) {
  if (!table?.length) return { rows: [], errors: ['Texte vide'], columns: [] }
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
      columns: [],
    }
  }
  const col = {}
  roles.forEach((role, idx) => { if (role && !(role in col)) col[role] = idx })
  // Quelles colonnes de montant le tableau portait : un relevé à colonne
  // « Montant » unique n'a pas dit son sens, un relevé Débit/Crédit si. Le
  // dépôt de relevés s'en sert pour savoir s'il doit inverser le signe.
  const columns = Object.keys(col)
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
    let interestCad = null
    if (col.advance != null || col.remb != null || col.interest != null) {
      const advance = col.advance != null ? parseAmount(cells[col.advance]) : null
      const remb = col.remb != null ? parseAmount(cells[col.remb]) : null
      const interest = col.interest != null ? parseAmount(cells[col.interest]) : null
      interestCad = interest ? Math.abs(interest) : null
      const moved = (advance ? Math.abs(advance) : 0) - (remb ? Math.abs(remb) : 0)
      // Ligne d'intérêts seuls : rien n'a bougé au compte, pas de transaction.
      if (!moved && interestCad) continue
      if (moved) amount = moved
    }
    if (amount == null && col.amount != null) amount = parseAmount(cells[col.amount])
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
      ...(interestCad ? { interest_cad: interestCad } : {}),
      balance: col.balance != null ? parseAmount(cells[col.balance]) : null,
      bank_state: col.bank_state != null ? normalizeBankState(cells[col.bank_state]) : null,
    })
  }
  return { rows, errors, columns }
}

// L'ÉTAT D'UNE LIGNE DÉJÀ EN BASE. Un export du portail redéposé n'apporte
// souvent aucune transaction neuve — mais il apporte du neuf quand même : un
// achat « En attente » la semaine dernière est « Autorisée » cette semaine.
// L'appariement se fait sur (date, montant), la même monnaie que la dédup du
// dépôt de relevés : les libellés, eux, ne se formulent jamais deux fois pareil.
export function applyStatesFromRows(accountId, rows) {
  const withState = (rows || []).filter((r) => r?.bank_state)
  if (!withState.length) return 0
  const update = db.prepare(`
    UPDATE bank_transactions SET bank_state=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id=? AND COALESCE(bank_state,'') <> ?
  `)
  const used = new Set()
  let changed = 0
  for (const row of withState) {
    const hits = db.prepare(`
      SELECT id, bank_state FROM bank_transactions
      WHERE account_id=? AND deleted_at IS NULL AND txn_date=?
        AND ABS(amount - ?) < 0.005
      ORDER BY created_at
    `).all(accountId, row.txn_date, row.amount)
    const hit = hits.find((h) => !used.has(h.id))
    if (!hit) continue
    used.add(hit.id)
    changed += update.run(row.bank_state, hit.id, row.bank_state).changes
  }
  return changed
}

// L'ACHAT EN ATTENTE QUI CHANGE DE DATE. La BNC date parfois l'autorisation
// quelques jours après l'attente (Premier Farnell : « En attente » le 18,
// « Autorisée » le 23, même montant). La dédup (date, montant) n'y voit que du
// neuf et la ligne entrait deux fois. Une ligne passée du document retrouve
// ici la ligne en attente qu'elle remplace : même compte, même montant exact,
// même marchand, datée 0 à 7 jours avant — et que ce document ne liste plus en
// attente à cette date. Rend Map(index de ligne → id de la ligne en attente).
const PENDING_DRIFT_DAYS = 7
export function merchantKey(description) {
  const m = String(description || '').toLowerCase().match(/[a-z0-9]{3,}/)
  return m ? m[0] : ''
}
export function findSupersededPending(accountId, rows) {
  const out = new Map()
  const list = rows || []
  const stillPending = new Set(list
    .filter((r) => r?.bank_state === 'en_attente')
    .map((r) => `${r.txn_date}|${Number(r.amount).toFixed(2)}`))
  const find = db.prepare(`
    SELECT id, txn_date, description FROM bank_transactions
    WHERE account_id=? AND deleted_at IS NULL AND bank_state='en_attente'
      AND ABS(amount - ?) < 0.005 AND txn_date < ? AND txn_date >= date(?, ?)
    ORDER BY txn_date, created_at
  `)
  // Sa version passée déjà en base : le doublon existe déjà, ne rien déplacer.
  const already = db.prepare(`
    SELECT 1 FROM bank_transactions
    WHERE account_id=? AND txn_date=? AND ABS(amount - ?) < 0.005 AND COALESCE(bank_state,'') <> 'en_attente'
  `)
  const used = new Set()
  list.forEach((row, i) => {
    if (!row?.bank_state || row.bank_state === 'en_attente' || !row.txn_date || !Number(row.amount)) return
    if (already.get(accountId, row.txn_date, row.amount)) return
    const key = merchantKey(row.description)
    if (!key) return
    const hit = find.all(accountId, row.amount, row.txn_date, row.txn_date, `-${PENDING_DRIFT_DAYS} days`)
      .find((h) => !used.has(h.id)
        && merchantKey(h.description) === key
        && !stillPending.has(`${h.txn_date}|${Number(row.amount).toFixed(2)}`))
    if (!hit) return
    used.add(hit.id)
    out.set(i, hit.id)
  })
  return out
}

// La ligne en attente prend la date, la référence et l'état de sa version
// passée : c'est la même transaction, et le prochain relevé la reconnaîtra.
export function promoteSupersededPending(accountId, rows, superseded = findSupersededPending(accountId, rows)) {
  const update = db.prepare(`
    UPDATE bank_transactions
    SET txn_date=?, reference=COALESCE(?, reference), bank_state=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id=? AND bank_state='en_attente'
  `)
  let changed = 0
  for (const [i, id] of superseded) {
    const row = rows[i]
    changed += update.run(row.txn_date, row.reference || null, row.bank_state, id).changes
  }
  if (changed) touchBankTxns([...superseded.values()])
  return changed
}

export function parseStatementText(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '')
  return parseStatementTable(lines.map((l) => l.split('\t')))
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
  const batchId = newRecordId()
  const insert = db.prepare(`
    INSERT OR IGNORE INTO bank_transactions
      (id, account_id, txn_date, description, details, reference, amount, balance, dedup_key, import_batch_id, sheet_color,
       bank_category, txn_type, check_number, orig_currency, orig_amount, bank_state, interest_cad)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `)
  let inserted = 0
  const counters = new Map()
  const tx = db.transaction(() => {
    for (const row of rows) {
      if (!Number(row.amount)) continue // ligne à 0 $ : rien à rapprocher
      const sig = [row.txn_date, row.amount, (row.description || '').toLowerCase(), (row.reference || '').toLowerCase()].join('|')
      const occurrence = counters.get(sig) || 0
      counters.set(sig, occurrence + 1)
      // Les faits du relevé (catégorie, type, chèque, devise d'origine) ne sont
      // pas dans la clé de dédup : ils décrivent la ligne, ils ne l'identifient
      // pas. Un collage manuel qui ne les porte pas les relit du libellé.
      const facts = txnFacts(row)
      const res = insert.run(
        newRecordId(), accountId, row.txn_date, row.description, row.details || null, row.reference,
        row.amount, row.balance, dedupKey(accountId, row, occurrence), batchId,
        row.sheet_color || null,
        row.bank_category || null,
        row.txn_type || null,
        row.check_number || facts.check || null,
        row.orig_currency || facts.foreign?.currency || null,
        row.orig_amount ?? (facts.foreign ? (row.amount < 0 ? -facts.foreign.amount : facts.foreign.amount) : null),
        // L'état à la banque n'est écrit que si le document le dit. Le déduire
        // (« elle est là, donc elle est passée ») a déjà mis « Autorisée » sur
        // des achats encore en attente.
        row.bank_state || null,
        // Les intérêts d'une marge de crédit, payés avec le capital dans le
        // même débit du compte courant : gardés pour couper l'écriture.
        row.interest_cad || null,
      )
      inserted += res.changes
      // Ligne déjà en base : le document peut quand même apporter du neuf —
      // un achat « En attente » la semaine dernière est « Autorisée » cette
      // semaine. On ne met à jour que cet état, rien d'autre.
      if (!res.changes && row.bank_state) {
        db.prepare(`
          UPDATE bank_transactions SET bank_state=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
          WHERE dedup_key=? AND deleted_at IS NULL AND COALESCE(bank_state,'') <> ?
        `).run(row.bank_state, dedupKey(accountId, row, occurrence), row.bank_state)
      }
    }
    db.prepare(`
      INSERT INTO bank_import_batches (id, account_id, row_count, inserted_count, duplicate_count, created_by)
      VALUES (?,?,?,?,?,?)
    `).run(batchId, accountId, rows.length, inserted, rows.length - inserted, userId || null)
  })
  tx()
  runPostImportHooks(accountId, { source: 'bank' })
  return { batchId, rowCount: rows.length, inserted, duplicates: rows.length - inserted }
}

// Une ligne à 0 $ (autorisation annulée, carte vérifiée…) n'a rien à
// rapprocher : elle sort de la liste. Jamais une ligne déjà liée à quelque chose.
export function purgeZeroAmountTxns(accountId = null) {
  return db.prepare(`
    UPDATE bank_transactions SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE deleted_at IS NULL AND COALESCE(amount, 0) = 0
      AND qb_txn_id IS NULL AND matched_id IS NULL AND transfer_txn_id IS NULL
      ${accountId ? 'AND account_id = ?' : ''}
  `).run(...(accountId ? [accountId] : [])).changes
}

// Effets de bord communs à toute source qui alimente bank_transactions
// (collage manuel, sync TRX_Orisha, Plaid — voir services/plaidSync.js) :
// appariement des paiements émis, détection subventions et recharges Twilio.
// Aucun ne doit faire échouer l'import appelant.
export function runPostImportHooks(accountId, { source: _source = 'bank' } = {}) {
  try { purgeZeroAmountTxns(accountId) } catch (e) { console.error('purgeZeroAmountTxns:', e.message) }
  // Les paiements émis, la paie et les versements de dettes ne se cochent plus
  // tout seuls : ils PROPOSENT, et c'est un clic qui écrit. Les gestes
  // explicites (bouton « apparier au relevé », fiche de dette) écrivent encore
  // directement — voir services/bankProposals/producers.js.
  try {
    const account = db.prepare('SELECT name FROM bank_accounts WHERE id=?').get(accountId)
    if (account) {
      const props = [
        ...producePaymentClears({ accountName: account.name, accountId }),
        ...producePaieDebits(),
      ]
      reconcileAndPersist(dedupeClaims(props), { kinds: ['payment_clear', 'paie_debit'] })
      import('./bankProposals/autoAccept.js').then((m) => m.autoAcceptSafe())
        .catch(e => console.error('bankReconciliation.autoAccept:', e.message))
    }
  } catch (e) {
    console.error('bankReconciliation.proposeClears:', e.message)
  }
  try {
    detectBankReceipts()
  } catch (e) {
    console.error('bankReconciliation.detectBankReceipts:', e.message)
  }
  try {
    detectTwilioBankRecharges()
  } catch (e) {
    console.error('bankReconciliation.detectTwilioBankRecharges:', e.message)
  }
  // Chaque ligne appariée à un document apprend à la fiche du fournisseur le
  // visage qu'il prend au relevé — c'est ce qui le fera reconnaître la fois
  // suivante AVANT d'avoir sa facture (services/vendorLearning.js).
  // Import paresseux : vendorLearning remonte jusqu'ici (normalizeLabel), un
  // import statique fermerait le cycle.
  import('./vendorLearning.js')
    .then(({ learnBankLabelsFromMatches }) => {
      const r = learnBankLabelsFromMatches()
      if (r.learned.length) {
        console.log(`vendorLearning: ${r.learned.length} motif(s) de relevé appris — ${r.learned.map(l => `${l.vendor} « ${l.pattern} »`).join(', ')}`)
      }
    })
    .catch(e => console.error('bankReconciliation.learnBankLabels:', e.message))
  // Sorties déjà connues de l'ERP qui viennent d'apparaître au relevé : le
  // débit de la paie, les versements de dettes. Asynchrone et non bloquant —
  // l'import ne doit jamais attendre (ni échouer sur) ce rattachement.
  if (isSystemAutomationActive(BANK_DEBIT_LINK_AUTOMATION_ID)) {
    import('./bankProposals/producers.js')
      .then(async ({ produceDebtPayments }) => {
        reconcileAndPersist(await produceDebtPayments(), { kinds: ['debt_payment'] })
        const { autoAcceptSafe } = await import('./bankProposals/autoAccept.js')
        await autoAcceptSafe()
      })
      .catch(e => console.error('bankReconciliation.proposeDebtPayments:', e.message))
  }
  // Une sortie d'argent fraîchement importée attend sa facture DÈS MAINTENANT :
  // sans ça la liste « Factures manquantes » ne la voyait qu'au passage de nuit,
  // et un débit arrivé le matin restait invisible toute la journée.
  // Import paresseux : invoiceNeeds lit la configuration du relevé, qui remonte
  // jusqu'ici — un import statique fermerait le cycle.
  import('./scrapers/invoiceNeeds.js')
    .then(({ refreshInvoiceNeeds }) => refreshInvoiceNeeds())
    .catch(e => console.error('bankReconciliation.refreshInvoiceNeeds:', e.message))
  // De nouvelles lignes : le fichier de suivi Google les reçoit sans qu'on
  // appuie sur quoi que ce soit.
  import('./trxSheetMirror.js').then((m) => m.mirrorOnChange('import')).catch(() => {})
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

// Les profils fournisseurs sont relus à chaque tournée de matching : le cache
// qui vivait ici n'a plus de lecteur depuis que la notation des pièces les
// charge elle-même. On garde l'invalidation, appelée par 5 endroits.
export function invalidateVendorProfilesCache() {}

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

  // La pièce, notée par bankReceiptMatch, dans les deux sens : une sortie se
  // paie par une facture, une entrée par une pièce négative (remboursement
  // d'impôt, note de crédit). Même barème, même barre.
  const account = db.prepare('SELECT * FROM bank_accounts WHERE id=?').get(txn.account_id)
  const docCandidates = () => findDocCandidates(txn, account, { limit: 8, excludeTxnId: txn.id }).candidates
    .map((d) => ({
      type: d.type, id: String(d.id), label: d.label,
      date: d.date, total: d.total, quickbooks_id: d.quickbooks_id,
      score: d.score, reasons: d.reasons, verdict: d.verdict,
      confidence: confidenceFromScore(d),
    }))

  if (txn.amount < 0) {
    // Sortie → la pièce : le montant au cent près
    // dans les 7 jours laissait passer les deux tiers des cas (facture nette
    // 30, achat en USD débité en CAD, frais ajoutés). La note devient une
    // confiance, et seule une pièce SÛRE avec le fournisseur reconnu au relevé
    // franchit 0,8 — la barre de l'appariement automatique n'a pas bougé.
    return docCandidates().sort((a, b) => b.confidence - a.confidence)
  } else {
    // Entrée → payout Stripe, ou la pièce négative (plus bas).
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
  if (txn.amount > 0) candidates.push(...docCandidates())
  candidates.sort((a, b) => b.confidence - a.confidence)
  return candidates
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
//
// La couleur a un temps été ignorée sur les comptes branchés à Plaid, parce
// que TRX_Orisha n'y était plus synchronisé. Il l'est de nouveau depuis le
// 2026-09-12 (la banque ne livrait pas) : la couleur redevient une preuve sur
// TOUS les comptes, comme avant.
export function deriveStatus(txn) {
  if (txn.status === 'ignore') return 'ignore'
  if (txn.reconciled_at) return 'rapproche'
  const sheetColor = txn.sheet_color
  if (sheetColor === 'vert' && txn.qb_txn_id) return 'rapproche'
  const docInQb = txn.matched_id ? !!matchedDocQbId(txn.matched_type, txn.matched_id) : false
  if (docInQb || txn.qb_txn_id || sheetColor === 'jaune') return 'comptabilise'
  // Virement interne apparié à sa contrepartie : le mouvement est identifié, il
  // ne lui manque plus que l'écriture QuickBooks — exactement l'état « facture
  // reçue » d'une dépense, sauf qu'ici la pièce n'est pas une facture.
  if (txn.transfer_txn_id || txn.matched_id || sheetColor === 'bleu') return 'facture_recue'
  return 'a_traiter'
}

// Recalcule le statut des transactions non figées d'un compte : une facture
// poussée à QB après le matching fait passer la ligne bleu → jaune sans action.
export function refreshStatuses(accountId) {
  const rows = db.prepare(`
    SELECT id, status, matched_type, matched_id, reconciled_at, sheet_color, qb_txn_id, transfer_txn_id
    FROM bank_transactions
    WHERE account_id = ? AND deleted_at IS NULL AND status NOT IN ('ignore','rapproche')
  `).all(accountId)
  const update = db.prepare(`
    UPDATE bank_transactions SET status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?
  `)
  const changedIds = []
  for (const t of rows) {
    const next = deriveStatus(t)
    if (next !== t.status) { update.run(next, t.id); changedIds.push(t.id) }
  }
  // Le point d'étranglement de TOUS les changements de statut (13 appelants, du
  // passage de vérification au « facture poussée à QB ») : c'est ici que la page
  // ouverte apprend qu'une ligne vient de passer au jaune.
  if (changedIds.length) touchBankTxns(changedIds)

  // La date d'une facture appariée est celle de son débit, pas celle imprimée
  // dessus — on la recale ici, au même point d'étranglement.
  try { alignReceiptDatesForAccount(accountId) } catch (e) { console.warn('alignReceiptDates:', e.message) }

  return changedIds.length
}

// Matching automatique : n'attache que les cas sûrs (confiance ≥ 0.8 et sans
// ambiguïté au sommet) ; le reste passe par les suggestions dans l'UI. Une
// ligne déjà rapprochée mais sans pièce est balayée elle aussi (demande de
// Charles, 2026-09-19) : elle gagne son document sans perdre son vert.
export function autoMatchAccount(accountId) {
  invalidateVendorProfilesCache()
  const txns = db.prepare(`
    SELECT * FROM bank_transactions
    WHERE account_id=? AND deleted_at IS NULL AND matched_id IS NULL
      AND status IN ('a_traiter','comptabilise','rapproche')
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

// ── Sens inverse : une facture cherche son débit ─────────────────────────────
//
// autoMatchAccount() part du relevé et cherche le document. Il ne se déclenche
// qu'à l'arrivée de transactions bancaires — une facture extraite APRÈS le
// débit (courrier Gmail, dépôt manuel, portail fournisseur) n'était donc jamais
// rattachée toute seule : la ligne restait « à traiter » alors que la pièce
// dormait dans l'ERP. Cette fonction referme la boucle depuis l'autre bout.
//
// La barre est la même que dans l'autre sens (findCandidates, ≥ 0.8, sans
// ex æquo) : concrètement, le libellé du relevé doit reconnaître le
// fournisseur. Un montant identique ne suffit jamais.
export const RECEIPT_BANK_MATCH_AUTOMATION_ID = 'sys_receipt_bank_match'

export function autoMatchReceipt(receiptId) {
  const receipt = db.prepare(`
    SELECT id, receipt_date, total, currency, status, quickbooks_type
    FROM sale_receipts WHERE id=? AND deleted_at IS NULL
  `).get(receiptId)
  if (!receipt || receipt.status !== 'done') return null
  // Un dépôt (argent reçu) est saisi en positif mais cherche une ENTRÉE.
  if (receipt.quickbooks_type === 'deposit') receipt.total = -Math.abs(receipt.total || 0)
  if (!receipt.receipt_date || !Number.isFinite(receipt.total) || Math.abs(receipt.total) < 0.011) return null

  // Déjà rattachée (à la main ou par une tournée précédente) : on ne touche pas.
  const already = db.prepare(`
    SELECT id FROM bank_transactions
    WHERE matched_type='receipt' AND matched_id=? AND deleted_at IS NULL
  `).get(String(receipt.id))
  if (already) return null

  invalidateVendorProfilesCache()
  // Le débit suit la facture — rarement l'inverse, et jamais de loin : fenêtre
  // large après la date de la pièce (net 30), étroite avant. La devise du
  // compte n'est plus exigée : une facture en USD est débitée en CAD au taux du
  // jour, c'est le filet le plus fréquent. Ce pré-filtre reste large exprès ;
  // c'est la notation (findCandidates) qui décide, et elle exige toujours que
  // le fournisseur soit reconnu au relevé.
  const rate = usdCadRateLookup()(receipt.receipt_date) || 0
  const total = Math.abs(receipt.total)
  // Une pièce négative (remboursement, note de crédit) cherche une entrée.
  const dir = receipt.total < 0 ? 1 : -1
  const tol = Math.max(2, total * 0.02)
  const from = shiftDate(receipt.receipt_date, -7)
  const to = shiftDate(receipt.receipt_date, 45)
  const txns = db.prepare(`
    SELECT t.* FROM bank_transactions t
    WHERE t.deleted_at IS NULL AND t.matched_id IS NULL AND t.transfer_txn_id IS NULL
      AND t.status IN ('a_traiter','comptabilise','rapproche') AND t.amount * :dir > 0
      AND COALESCE(t.pending, 0) = 0
      AND t.txn_date BETWEEN :from AND :to
      AND (
            ABS(ABS(t.amount) - :total) <= :tol
         OR (:rate > 0 AND ABS(ABS(t.amount) - :total * :rate) <= :tolc)
         OR (:rate > 0 AND ABS(ABS(t.amount) - :total / :rate) <= :tolc)
         -- Achat en devise sur carte : ~2,5 % de frais de change, ou montant
         -- initial écrit au relevé (la notation le relit et tranche).
         OR (:rate > 0 AND ABS(ABS(t.amount) - :total * :rate * 1.025) <= :tolc)
         OR ABS(ABS(COALESCE(t.orig_amount, 0)) - :total) <= 0.02
         OR COALESCE(t.description, '') || ' ' || COALESCE(t.details, '') LIKE '%montant initial en devise%'
      )
  `).all({ from, to, total, tol, rate, dir, tolc: Math.max(2, total * (rate || 1) * 0.02) })
  if (!txns.length) return { scanned: 0, matched: 0 }

  // Une transaction n'est retenue que si CETTE facture est son meilleur
  // candidat — pas seulement un candidat possible.
  const eligible = []
  for (const txn of txns) {
    const candidates = findCandidates(txn)
    const best = candidates[0]
    if (!best || best.type !== 'receipt' || String(best.id) !== String(receipt.id)) continue
    if (best.confidence < 0.8) continue
    if (candidates[1] && candidates[1].confidence >= best.confidence - 0.05) continue
    eligible.push({ txn, confidence: best.confidence })
  }
  // Deux débits du même montant chez le même fournisseur : on ne devine pas
  // lequel porte cette facture-là.
  if (eligible.length !== 1) return { scanned: txns.length, matched: 0, ambiguous: eligible.length > 1 }

  const { txn, confidence } = eligible[0]
  const status = deriveStatus({ ...txn, matched_type: 'receipt', matched_id: String(receipt.id) })
  db.prepare(`
    UPDATE bank_transactions
    SET matched_type='receipt', matched_id=?, match_method='auto', match_confidence=?,
        status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id=?
  `).run(String(receipt.id), confidence, status, txn.id)
  try { alignReceiptDate(String(receipt.id)) } catch (e) { console.warn('alignReceiptDate:', e.message) }
  return { scanned: txns.length, matched: 1, txnId: txn.id, accountId: txn.account_id, confidence }
}

// Transaction bancaire portant le débit d'un document — lue depuis la fiche du
// document (« où est passé l'argent ? »), sens inverse du lien matched_id.
export function bankTxnForDocument(matchedType, matchedId) {
  if (!matchedId) return null
  return db.prepare(`
    SELECT t.id, t.txn_date, t.amount, t.status, t.match_method, t.match_confidence,
           COALESCE(NULLIF(t.details, ''), t.description) AS label,
           t.account_id, a.name AS account_name, a.currency AS account_currency
    FROM bank_transactions t
    JOIN bank_accounts a ON a.id = t.account_id
    WHERE t.matched_type=? AND t.matched_id=? AND t.deleted_at IS NULL
    ORDER BY t.txn_date DESC LIMIT 1
  `).get(matchedType, String(matchedId)) || null
}
