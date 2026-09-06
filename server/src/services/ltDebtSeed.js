// Seed des dettes à long terme qui manquaient à la page /dettes-lt : le prêt DEC
// (contribution remboursable, 0 %) et le prêt FLI de la Ville de Québec.
//
// Les paramètres viennent des documents officiels du Drive partagé « Dettes à
// LT » (lus le 2026-08-09) :
//   • DEC 600072453 — avis de versement final du 2025-11-05 : contribution
//     remboursable de 200 000 $, sans intérêt, 71 versements de 2 777,78 $ du
//     1er nov. 2028 au 1er sept. 2034 puis 2 777,62 $ le 1er oct. 2034.
//   • Ville de Québec DEV-2024-1492 (FLI) — calendrier de remboursement 12868 du
//     2025-08-11 : 250 000 $ à 6,5 %, mensuel le 11, moratoire capital+intérêts
//     d'août 2025 à janvier 2026 (intérêts capitalisés : solde porté à
//     258 235,83 $), puis 4 664,11 $/mois du 2026-02-11 au 2031-07-11.
//
// Les soldes concordent avec QuickBooks au 2026-08-09 : #27400 DEC = 200 000 $,
// #27500 Ville de Québec - FLI = 238 376,61 $ (soit le solde de la cédule après
// le versement du 2026-07-11 — les 6 versements déjà passés sont donc seedés
// comme comptabilisés, rattachés à leur dépense QB).
//
// Idempotent et non destructif : rien n'est recréé ni écrasé si la ligne existe.
import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { generateSchedule } from './ltDebtSchedule.js'

export const DEC_DEBT_ID = 'ltdebt_dec'
export const VILLE_QC_DEBT_ID = 'ltdebt_ville_quebec'

const DEBTS = [
  {
    id: DEC_DEBT_ID,
    label: 'Prêt DEC',
    lender: 'Développement économique Canada',
    loan_number: '600072453',
    principal: 200000,
    qb_debt_acctnum: '27400',
    qb_interest_acctnum: '79200',
    qb_bank_acctnum: '10000',
    annual_rate: 0,
    payment_frequency: 'monthly',
    payment_amount: 2777.78,
    notes: 'Contribution remboursable sans intérêt. Premier versement dû 36 mois après la fin '
      + 'du projet (11 octobre 2025) : 71 versements de 2 777,78 $ du 1er nov. 2028 au 1er sept. '
      + '2034, puis 2 777,62 $ le 1er oct. 2034. Source : avis de versement final DEC du '
      + '2025-11-05 (Drive « Dettes à LT / DEC »).',
    schedule: {
      opening_balance: 200000,
      annual_rate: 0,
      frequency: 'monthly',
      payment_amount: 2777.78,
      first_payment_date: '2028-11-01',
    },
    booked: {},
  },
  {
    id: VILLE_QC_DEBT_ID,
    label: 'Prêt Ville de Québec (FLI)',
    lender: 'Ville de Québec',
    loan_number: 'DEV-2024-1492',
    principal: 250000,
    qb_debt_acctnum: '27500',
    qb_interest_acctnum: '79200',
    qb_bank_acctnum: '10000',
    annual_rate: 6.5,
    payment_frequency: 'monthly',
    payment_amount: 4664.11,
    notes: 'FLI 250 000 $ à 6,5 % (calendrier 12868). Moratoire capital + intérêts du 2025-08-11 '
      + "au 2026-01-11 : les intérêts ont été capitalisés (8 235,83 $, JE QB du 2026-03-31), d'où "
      + "un solde d'ouverture de 258 235,83 $ au premier versement. À NOTER : en plus du versement "
      + 'de 4 664,11 $, la Ville prélève 1 250 $ de frais chaque 11 février (comptabilisés en '
      + '#79000 Frais paiements / bancaires) — ces frais ne font pas partie de la cédule '
      + 'capital + intérêts et sont à passer à part.',
    schedule: {
      opening_balance: 258235.83,
      annual_rate: 6.5,
      frequency: 'monthly',
      payment_amount: 4664.11,
      first_payment_date: '2026-02-11',
    },
    // Versements déjà sortis de la banque et comptabilisés à la main dans QB
    // avant la bascule vers l'ERP → date de cédule : Id de la dépense QB.
    booked: {
      '2026-02-11': '16279',
      '2026-03-11': '16551',
      '2026-04-11': '16879',
      '2026-05-11': '17286',
      '2026-06-11': '17521',
      '2026-07-11': '17688',
    },
  },
]

// Sorties récurrentes de la projection de trésorerie. `ends_on` borne la
// récurrente à la fin de la cédule, `starts_on` retarde son apparition (DEC ne
// sort pas un sou avant nov. 2028).
const RECURRING = [
  {
    debtId: DEC_DEBT_ID,
    label: 'Dette DEC',
    amount: 2777.78,
    day_of_month: 1,
    starts_on: '2028-11-01',
    ends_on: '2034-10-01',
    notes: 'Contribution remboursable DEC — voir la cédule de remboursement (/dettes-lt).',
  },
  {
    debtId: VILLE_QC_DEBT_ID,
    label: 'Dette Ville de Québec',
    amount: 4664.11,
    day_of_month: 11,
    starts_on: null,
    ends_on: '2031-07-11',
    notes: 'Voir la cédule de remboursement. Les 1 250 $ de frais annuels du 11 février sont en sus.',
  },
]

function seedDebt(def) {
  if (db.prepare('SELECT id FROM lt_debts WHERE id = ?').get(def.id)) return 0
  const { rows, error } = generateSchedule(def.schedule)
  if (error) throw new Error(`Cédule ${def.label} : ${error}`)

  const stamp = new Date().toISOString()
  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO lt_debts (id, label, lender, loan_number, currency, principal,
        qb_debt_acctnum, qb_interest_acctnum, qb_bank_acctnum, active, notes,
        annual_rate, payment_frequency, payment_amount)
      VALUES (?,?,?,?,'CAD',?,?,?,?,1,?,?,?,?)
    `).run(def.id, def.label, def.lender, def.loan_number, def.principal,
      def.qb_debt_acctnum, def.qb_interest_acctnum, def.qb_bank_acctnum, def.notes,
      def.annual_rate, def.payment_frequency, def.payment_amount)

    const insert = db.prepare(`
      INSERT INTO lt_debt_payments (id, debt_id, seq, payment_date, principal, interest,
        balance_after, source, qb_txn_id, qb_txn_type, pushed_at, notes)
      VALUES (?,?,?,?,?,?,?,'import',?,?,?,?)
    `)
    rows.forEach((r, i) => {
      const qbId = def.booked[r.payment_date] || null
      insert.run(newRecordId(), def.id, i + 1, r.payment_date, r.principal, r.interest,
        r.balance_after, qbId, qbId ? 'purchase' : null, qbId ? stamp : null,
        qbId ? 'Versement passé à la main dans QuickBooks avant la bascule vers l’ERP' : null)
    })
  })
  tx()
  return rows.length
}

function seedRecurring(def) {
  const debt = db.prepare('SELECT id FROM lt_debts WHERE id = ? AND deleted_at IS NULL').get(def.debtId)
  if (!debt) return false
  const existing = db.prepare(
    'SELECT * FROM recurring_outflows WHERE label = ? AND deleted_at IS NULL'
  ).get(def.label)
  if (existing) {
    // Récurrente déjà saisie à la main : on ne touche ni au montant ni à la
    // cadence, on ne fait que poser les bornes manquantes.
    if (existing.starts_on == null && existing.ends_on == null && (def.starts_on || def.ends_on)) {
      db.prepare(`
        UPDATE recurring_outflows SET starts_on = ?, ends_on = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
      `).run(def.starts_on, def.ends_on, existing.id)
      return true
    }
    return false
  }
  db.prepare(`
    INSERT INTO recurring_outflows (id, label, amount, frequency, day_of_month, active, notes, starts_on, ends_on, amount_entered_at)
    VALUES (?,?,?,'monthly',?,1,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `).run(newRecordId(), def.label, def.amount, def.day_of_month, def.notes, def.starts_on, def.ends_on)
  return true
}

// Libellés tels qu'ils PARAISSENT au relevé BNC (vérifiés sur les mouvements
// de mai à août 2026) : « Dpa Entreprise Bdc », « COMPTE DIVERS / VILLE DE
// QUEBEC ». Ils servent à reconnaître le versement quand l'argent sort — ce
// que « l'écriture existe dans QuickBooks » ne dit pas. Posés une seule fois,
// sur une dette qui n'en a pas : l'utilisateur peut ensuite les corriger.
const BANK_LABELS = { BDC: 'BDC', 'Ville de Québec': 'VILLE DE QUEBEC' }

function seedBankLabels() {
  const rows = db.prepare("SELECT id, label, lender FROM lt_debts WHERE bank_label_pattern IS NULL AND deleted_at IS NULL").all()
  const done = []
  for (const r of rows) {
    const hit = Object.entries(BANK_LABELS).find(([k]) => `${r.label} ${r.lender || ''}`.toLowerCase().includes(k.toLowerCase()))
    if (!hit) continue
    db.prepare('UPDATE lt_debts SET bank_label_pattern=? WHERE id=?').run(hit[1], r.id)
    done.push(r.label)
  }
  return done
}

export function seedLtDebts() {
  const created = []
  for (const def of DEBTS) {
    const n = seedDebt(def)
    if (n) created.push(`${def.label} (${n} versements)`)
  }
  for (const def of RECURRING) {
    if (seedRecurring(def)) created.push(`récurrente « ${def.label} »`)
  }
  const labelled = seedBankLabels()
  if (labelled.length) created.push(`libellés bancaires (${labelled.join(', ')})`)
  if (created.length) console.log(`[lt-debts] seed : ${created.join(', ')}`)
  return created
}
