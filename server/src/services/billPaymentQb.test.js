// Ce qui est vérifié ici : qu'on n'envoie dans QuickBooks que ce dont on est
// sûr, et que l'écriture envoyée dit exactement ce que le paiement dit. Aucun
// appel réseau — paiements, factures et comptes sont fournis à la main.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  eligibility, buildBillPaymentPayload, billPaymentMemo, billStatusFromQb, mainQbAccount,
  billPaymentApplies, BILL_PAYMENT_DEFAULT_CONFIG,
} from './billPaymentQb.js'

const P = (over = {}) => ({
  id: 'p1', direction: 'out', amount: 1250.5, currency: 'CAD', account: 'BNC CAD',
  payment_date: '2026-09-16', achat_id: 'a1', invoice_number: 'INV-77', method: 'interac',
  reference: null, source: 'schedule', deleted_at: null, qb_billpayment_id: null, ...over,
})
const B = (over = {}) => ({
  id: 'a1', type: 'bill', quickbooks_id: '4821', currency: 'CAD', vendor: 'Dubois Agrinovation',
  vendor_invoice_number: 'INV-77', total_cad: 1250.5, ...over,
})
const A = (over = {}) => ({ id: 'acc1', name: 'BNC CAD', kind: 'bank', qb_account_id: '61', ...over })
const QB = (over = {}) => ({ Id: '4821', TotalAmt: 1250.5, Balance: 1250.5, VendorRef: { value: '77' }, ...over })

// ── Éligibilité ──────────────────────────────────────────────────────────────

test('un paiement de facture publiée, même devise, sur un compte connu part', () => {
  assert.equal(eligibility(P(), B(), A(), { qbBalance: 1250.5 }).ok, true)
})

test('un paiement partiel part quand même — QuickBooks laisse la facture ouverte', () => {
  assert.equal(eligibility(P({ amount: 500 }), B(), A(), { qbBalance: 1250.5 }).ok, true)
})

test('rien ne part sans facture liée', () => {
  const out = eligibility(P({ achat_id: null }), null, A())
  assert.equal(out.ok, false)
  assert.match(out.reason, /Aucune facture/)
})

test('une facture pas encore publiée dans QuickBooks ne peut pas être réglée là-bas', () => {
  const out = eligibility(P(), B({ quickbooks_id: null }), A())
  assert.equal(out.ok, false)
  assert.match(out.reason, /pas encore publiée/)
})

test('une dépense QuickBooks est déjà payée : rien à solder', () => {
  assert.equal(eligibility(P(), B({ type: 'purchase' }), A()).ok, false)
})

test('devises différentes : refusé, jamais converti en silence', () => {
  const out = eligibility(P({ currency: 'CAD' }), B({ currency: 'USD' }), A())
  assert.equal(out.ok, false)
  assert.match(out.reason, /USD.*CAD|CAD.*USD/)
})

test('un montant supérieur au solde dû est refusé, pas tronqué', () => {
  const out = eligibility(P({ amount: 2000 }), B(), A(), { qbBalance: 1250.5 })
  assert.equal(out.ok, false)
  assert.match(out.reason, /supérieur au solde/)
})

test('une facture déjà soldée chez QuickBooks ne reçoit pas un second paiement', () => {
  assert.equal(eligibility(P(), B(), A(), { qbBalance: 0 }).ok, false)
})

test('un compte sans correspondance QuickBooks bloque l’envoi', () => {
  const out = eligibility(P({ account: 'Venn CAD' }), B(), A({ name: 'Venn CAD', qb_account_id: null }))
  assert.equal(out.ok, false)
  assert.match(out.reason, /sans correspondance/)
})

test('un encaissement n’est pas un règlement de facture', () => {
  assert.equal(eligibility(P({ direction: 'in' }), B(), A()).ok, false)
})

test('un paiement VENU de QuickBooks ou du fichier de suivi n’y retourne pas', () => {
  assert.equal(eligibility(P({ source: 'qb' }), B(), A()).ok, false)
  assert.equal(eligibility(P({ source: 'import' }), B(), A()).ok, false)
})

test('une origine désactivée dans les automatisations est écartée', () => {
  const cfg = { ...BILL_PAYMENT_DEFAULT_CONFIG, enabled_sources: 'manual' }
  assert.equal(eligibility(P({ source: 'schedule' }), B(), A(), { config: cfg }).ok, false)
  assert.equal(eligibility(P({ source: 'manual' }), B(), A(), { config: cfg }).ok, true)
})

test('le règlement par carte se coupe sans toucher au reste', () => {
  const card = A({ name: 'MasterCard BNC', kind: 'card', qb_account_id: '66' })
  assert.equal(eligibility(P({ account: 'MasterCard BNC' }), B(), card).ok, true)
  const cfg = { ...BILL_PAYMENT_DEFAULT_CONFIG, allow_card_accounts: '0' }
  assert.equal(eligibility(P({ account: 'MasterCard BNC' }), B(), card, { config: cfg }).ok, false)
})

test('un paiement déjà envoyé ne repart pas', () => {
  assert.equal(eligibility(P({ qb_billpayment_id: '900' }), B(), A()).ok, false)
})

// Décision de Charles (2026-09-16) : l'historique n'est pas rattrapé. Ces
// factures-là ont déjà été réglées à la main dans QuickBooks — les repousser
// créerait un second paiement sur la même facture.
test('un paiement d’avant la mise en service ne part jamais', () => {
  const cfg = { ...BILL_PAYMENT_DEFAULT_CONFIG, since_date: '2026-09-16' }
  assert.equal(eligibility(P({ payment_date: '2026-09-15' }), B(), A(), { config: cfg }).ok, false)
  assert.equal(eligibility(P({ payment_date: '2026-09-16' }), B(), A(), { config: cfg }).ok, true)
})

test('la ligne ne parle de QuickBooks que si l’envoi la concerne', () => {
  const cfg = { ...BILL_PAYMENT_DEFAULT_CONFIG, since_date: '2026-09-16' }
  assert.equal(billPaymentApplies(P(), { config: cfg }), true)
  assert.equal(billPaymentApplies(P({ payment_date: '2026-08-01' }), { config: cfg }), false)
  assert.equal(billPaymentApplies(P({ achat_id: null }), { config: cfg }), false)
  assert.equal(billPaymentApplies(P({ direction: 'in' }), { config: cfg }), false)
  assert.equal(billPaymentApplies(P({ source: 'qb' }), { config: cfg }), false)
})

// ── Charge utile ─────────────────────────────────────────────────────────────

test('l’écriture pointe la bonne facture, pour le montant du paiement, à sa date', () => {
  const p = buildBillPaymentPayload({ bill: B(), qbBill: QB(), payment: P(), account: A() })
  assert.equal(p.TotalAmt, 1250.5)
  assert.equal(p.TxnDate, '2026-09-16')
  assert.equal(p.VendorRef.value, '77')
  assert.deepEqual(p.Line[0].LinkedTxn[0], { TxnId: '4821', TxnType: 'Bill' })
  assert.equal(p.Line[0].Amount, 1250.5)
})

test('compte bancaire → chèque, carte de crédit → carte', () => {
  const bank = buildBillPaymentPayload({ bill: B(), qbBill: QB(), payment: P(), account: A() })
  assert.equal(bank.PayType, 'Check')
  assert.equal(bank.CheckPayment.BankAccountRef.value, '61')
  assert.equal(bank.CheckPayment.PrintStatus, 'NotSet')
  assert.equal(bank.CreditCardPayment, undefined)

  const card = buildBillPaymentPayload({
    bill: B(), qbBill: QB(), payment: P({ account: 'MasterCard BNC' }),
    account: A({ name: 'MasterCard BNC', kind: 'card', qb_account_id: '66' }),
  })
  assert.equal(card.PayType, 'CreditCard')
  assert.equal(card.CreditCardPayment.CCAccountRef.value, '66')
  assert.equal(card.CheckPayment, undefined)
})

test('un compte ERP qui couvre deux comptes QuickBooks utilise le principal', () => {
  assert.equal(mainQbAccount({ qb_account_id: '234,168' }), '234')
  const p = buildBillPaymentPayload({
    bill: B({ currency: 'USD' }), qbBill: QB({ CurrencyRef: { value: 'USD' }, ExchangeRate: 1.37 }),
    payment: P({ currency: 'USD', account: 'BNC USD' }),
    account: A({ name: 'BNC USD', qb_account_id: '234,168' }),
  })
  assert.equal(p.CheckPayment.BankAccountRef.value, '234')
  assert.equal(p.CurrencyRef.value, 'USD')
  assert.equal(p.ExchangeRate, 1.37)
})

test('le taux de change n’est posé que s’il y en a un', () => {
  const p = buildBillPaymentPayload({ bill: B(), qbBill: QB({ CurrencyRef: { value: 'CAD' }, ExchangeRate: 1 }), payment: P(), account: A() })
  assert.equal(p.ExchangeRate, undefined)
})

test('le mémo dit la facture et le moyen réel, que QuickBooks ne sait pas nommer', () => {
  assert.equal(billPaymentMemo(P({ reference: 'A12' }), B()), 'Facture INV-77 · interac · réf. A12')
  assert.equal(billPaymentMemo(P({ invoice_number: null, method: null, reference: null }), B({ vendor_invoice_number: null, bill_number: null })), null)
})

// ── Retour du statut ─────────────────────────────────────────────────────────

test('le statut de la facture suit le solde renvoyé par QuickBooks', () => {
  assert.equal(billStatusFromQb({ TotalAmt: 100, Balance: 0 }), 'Payée')
  assert.equal(billStatusFromQb({ TotalAmt: 100, Balance: 40 }), 'Payée partiellement')
  assert.equal(billStatusFromQb({ TotalAmt: 100, Balance: 100, DueDate: '2020-01-01' }), 'En retard')
  assert.equal(billStatusFromQb({ TotalAmt: 100, Balance: 100, DueDate: '2099-01-01' }), 'Reçue')
})
