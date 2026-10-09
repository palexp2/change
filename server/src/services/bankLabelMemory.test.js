// La mémoire du relevé : ce qu'on a déjà fait pour ce libellé remplit la ligne
// suivante. Tests sur la DB jetable du harnais.
import { describe, it, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { initTestDb, db } from '../test-helpers/testApp.js'
import { labelKey, learnedFromLabel, invalidateLabelMemory } from './bankLabelMemory.js'
import { buildEntryDraft } from './bankEntryDraft.js'
import { invalidateBankLabelCache } from './scrapers/vendorFromBankLabel.js'

const BNC = 'acct-mem-cad'
const ACCT = { id: BNC, currency: 'CAD', kind: 'bank' }
let seq = 0

function past({ label, amount, vendor, account = '248', tax = null, memo = null, date = '2026-08-01', erp = false }) {
  const id = `mem-${++seq}`
  db.prepare(`INSERT INTO achats_fournisseurs (id, type, date_achat, vendor, description, qb_memo, payment_method,
      amount_cad, tax_cad, total_cad, currency, status, expense_account_id, tax_code_id, quickbooks_id)
    VALUES (?, 'purchase', ?, ?, ?, ?, 'Comptant', ?, 0, ?, 'CAD', 'Approuvé', ?, ?, ?)`)
    .run(`a-${id}`, date, vendor, memo, memo, -amount, -amount, account, tax, `qb-${id}`)
  db.prepare(`INSERT INTO bank_transactions (id, account_id, txn_date, description, amount, dedup_key, status,
      matched_type, matched_id, qb_txn_type, qb_txn_id)
    VALUES (?, ?, ?, ?, ?, ?, 'rapproche', ?, ?, ?, ?)`)
    .run(`t-${id}`, BNC, date, label, amount, `k-${id}`, erp ? 'achat' : null, erp ? `a-${id}` : null,
      erp ? null : 'expense', erp ? null : `qb-${id}`)
}

const line = (label, amount, date = '2026-10-01') => ({ id: `new-${++seq}`, account_id: BNC, txn_date: date, description: label, amount })

describe('labelKey', () => {
  it('retire les codes de terminal, la géographie et le montant d\'origine', () => {
    assert.equal(labelKey({ description: 'AMZN MKTP CA*BG4S06WX0 TORONTO       ON  CAN ON' }), 'amzn mktp ca toronto')
    assert.equal(labelKey({ description: 'CLAUDE.AI SUBSCRIPTION SAN FRANCISCO CA  USA CA Montant initial en devise CAD 32,19' }),
      labelKey({ description: 'CLAUDE.AI SUBSCRIPTION SAN FRANCISCO CA  USA CA' }))
  })
  it('garde le marchand après l\'astérisque', () => {
    assert.match(labelKey({ description: 'PAYPAL *TAKACHIELEC' }), /takachielec/)
  })
})

describe('learnedFromLabel', () => {
  before(() => { initTestDb(); db.prepare("INSERT OR REPLACE INTO bank_accounts (id, name, kind, currency) VALUES (?, 'BNC', 'bank', 'CAD')").run(BNC) })
  beforeEach(() => {
    db.prepare('DELETE FROM bank_transactions').run()
    db.prepare('DELETE FROM achats_fournisseurs').run()
    invalidateLabelMemory(); invalidateBankLabelCache()
  })

  it('un libellé qui revient remplit fournisseur, compte, taxe et mémo', () => {
    for (const d of ['2026-07-01', '2026-08-01', '2026-09-01']) past({ label: 'DT NETHRIS PAIE', amount: -5200, vendor: 'Salaires', tax: '__none__', memo: 'Paie', date: d })
    const draft = buildEntryDraft(line('DT NETHRIS PAIE', -5300), ACCT, { rule: null })
    assert.equal(draft.fields.vendor.value, 'Salaires')
    assert.equal(draft.fields.vendor.source, 'déjà fait 3 fois pour ce libellé')
    assert.equal(draft.fields.expense_account_id.value, '248')
    assert.equal(draft.fields.memo.value, 'Paie')
  })

  it('un libellé d\'emballage ne parle que des fois au même montant', () => {
    for (const d of ['2026-07-01', '2026-08-01', '2026-09-01']) past({ label: 'VIREMENT INTERAC', amount: -862.31, vendor: 'Inverness', date: d })
    assert.equal(learnedFromLabel(line('VIREMENT INTERAC', -395), ACCT), null)
    assert.equal(learnedFromLabel(line('VIREMENT INTERAC', -862.31), ACCT).vendor, 'Inverness')
  })

  it('une seule liaison au grand livre, sans le nom au libellé, ne suffit pas', () => {
    past({ label: 'GOOGLE *SERVICES HALIFAX NS CAN NS', amount: -2, vendor: 'FedEx' })
    assert.equal(learnedFromLabel(line('GOOGLE *SERVICES HALIFAX NS CAN NS', -2), ACCT)?.vendor ?? null, null)
  })

  it('un vote partagé le dit dans la source', () => {
    for (let i = 0; i < 3; i++) past({ label: 'AMAZON.CA TORONTO ON CAN ON', amount: -50, vendor: 'Amazon.ca', account: '40', date: `2026-0${6 + i}-01` })
    past({ label: 'AMAZON.CA TORONTO ON CAN ON', amount: -50, vendor: 'Amazon.ca', account: '71', date: '2026-05-01' })
    const m = learnedFromLabel(line('AMAZON.CA TORONTO ON CAN ON', -50), ACCT)
    assert.equal(m.expense_account_id, '40')
    assert.equal(m.sources.expense_account_id, 'déjà fait 3 fois sur 4 pour ce libellé')
  })
})
