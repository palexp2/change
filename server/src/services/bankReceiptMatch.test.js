// Barème de détection d'une pièce (extracteur ou achat) face à un débit.
// Tests purs : scoreDoc ne touche pas la base, tout est dans `doc` et `ctx`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { scoreDoc, convertAmount, confidenceFromScore, parseOrigAmount, signCompatible } from './bankReceiptMatch.js'

const TXN = { amount: -250.75, txn_date: '2026-09-10', description: 'ACHAT DKC*DIGI-KEY CORP', details: null, reference: null }

function doc(over = {}) {
  return {
    type: 'receipt', id: '1', company: 'Digi-Key Corporation', names: ['Digi-Key Corporation'],
    patterns: [], date: '2026-09-08', order_date: null, due_date: null,
    total: 250.75, bank_charged_total: null, currency: 'CAD', doc_number: null,
    card_last4: null, payment_method: null, status: 'done', quickbooks_id: null,
    archived: false, taken: false, ...over,
  }
}
function ctx(over = {}) {
  return { rate: 1.372, text: [TXN.description, TXN.details, TXN.reference].filter(Boolean).join(' '), accountCurrency: 'CAD', accountLast4: null, ...over }
}

test('nom tronqué au relevé + montant exact = certitude', () => {
  const r = scoreDoc(TXN, doc(), ctx())
  assert.ok(r.score >= 85, `score ${r.score}`)
  assert.equal(r.nameHit, true)
  assert.ok(r.reasons.includes('montant exact'))
})

test('même montant mais autre fournisseur : proposé, pas certain', () => {
  const r = scoreDoc(TXN, doc({ company: 'Mouser Electronics', names: ['Mouser Electronics'] }), ctx())
  assert.equal(r.nameHit, false)
  assert.ok(r.score < 85, `score ${r.score}`)
  assert.ok(r.score >= 40)
})

test('pièce en USD débitée en CAD', () => {
  const txn = { ...TXN, amount: -137.20 }
  const r = scoreDoc(txn, doc({ total: 100, currency: 'USD' }), ctx())
  assert.ok(r.reasons.some(x => x.startsWith('montant exact une fois converti')))
  assert.ok(r.score >= 55)
})

test('montant débité au compte prime sur le total', () => {
  const txn = { ...TXN, amount: -138.04 }
  const r = scoreDoc(txn, doc({ total: 100, currency: 'USD', bank_charged_total: 138.04 }), ctx())
  assert.ok(r.reasons.includes('montant débité au compte'))
  assert.ok(r.score >= 100)
})

test('pièce postérieure au débit', () => {
  const r = scoreDoc(TXN, doc({ date: '2026-09-25' }), ctx())
  assert.ok(r.reasons.includes('pièce postérieure au débit'))
  assert.ok(r.score < 85, `score ${r.score}`)
})

test('numéro de la pièce au relevé sauve un montant faux', () => {
  const txn = { ...TXN, amount: -99.99, description: 'PAIEMENT INV 88213' }
  const r = scoreDoc(txn, doc({ doc_number: 'INV-88213' }), ctx({ text: txn.description }))
  assert.ok(r.reasons.includes('numéro de la pièce au relevé'))
  assert.ok(r.score >= 40)
})

test('les 4 chiffres de la carte ne suffisent jamais seuls', () => {
  const txn = { ...TXN, amount: -12.34, description: 'ACHAT 8842' }
  const r = scoreDoc(txn, doc({ company: 'Inconnu', names: ['Inconnu'], card_last4: '8842', payment_method: 'Carte de crédit' }), ctx({ text: txn.description }))
  assert.ok(r.score < 40, `score ${r.score}`)
})

test('pièce déjà liée ailleurs : affichée mais jamais automatique', () => {
  const r = scoreDoc(TXN, doc({ taken: true }), ctx())
  const sure = scoreDoc(TXN, doc(), ctx())
  assert.equal(sure.score - r.score, 40)
  assert.ok(confidenceFromScore({ ...r, verdict: 'sure', taken: true }) < 0.8)
})

test('un motif de profil fournisseur vaut le nom en clair', () => {
  const txn = { ...TXN, description: 'PAIEMENT PREAUT 0098231' }
  const r = scoreDoc(txn, doc({ company: 'Hydro-Québec', names: ['Hydro-Québec'], patterns: ['PREAUT 0098231'] }), ctx({ text: txn.description }))
  assert.ok(r.reasons.includes('motif du profil fournisseur au relevé'))
  assert.equal(r.nameHit, true)
})

test('lecture non terminée : la pièce reste visible, décotée', () => {
  const r = scoreDoc(TXN, doc({ status: 'pending' }), ctx())
  assert.ok(r.reasons.includes('lecture non terminée'))
  assert.ok(r.score >= 40)
})

test('confidenceFromScore plafonne tout ce qui n’est pas sûr', () => {
  assert.ok(confidenceFromScore({ score: 120, verdict: 'probable', nameHit: true }) <= 0.79)
  assert.ok(confidenceFromScore({ score: 120, verdict: 'sure', nameHit: false }) <= 0.79)
  assert.ok(confidenceFromScore({ score: 107, verdict: 'sure', nameHit: true }) >= 0.8)
})

test('convertAmount dans les deux sens', () => {
  assert.equal(convertAmount(100, 'USD', 'CAD', 1.37), 137)
  assert.equal(convertAmount(137, 'CAD', 'USD', 1.37), 100)
  assert.equal(convertAmount(100, 'USD', 'CAD', null), null)
})

// ── Achats en devise sur une carte CAD (cas Anthropic du 2026-09-18) ────────
const ANTH = { amount: -150.72, txn_date: '2026-09-18', description: 'ANTHROPIC SAN FRANCISCO CA USA CA Montant initial en devise USD 105,00', details: null, reference: null }
const anthDoc = (over = {}) => doc({ company: 'Anthropic', names: ['Anthropic'], date: '2026-09-18', total: 105, currency: 'CAD', ...over })

test('montant initial lu au libellé BNC ou dans les colonnes', () => {
  assert.deepEqual(parseOrigAmount(ANTH), { currency: 'USD', amount: 105 })
  assert.deepEqual(parseOrigAmount({ description: 'X Montant initial en devise EUR 1 234,56' }), { currency: 'EUR', amount: 1234.56 })
  assert.deepEqual(parseOrigAmount({ orig_currency: 'usd', orig_amount: -42.5 }), { currency: 'USD', amount: 42.5 })
  assert.equal(parseOrigAmount({ description: 'ACHAT' }), null)
})

test('montant initial au relevé = total de la pièce : certitude, même pièce notée CAD', () => {
  const c = ctx({ rate: 1.4002, text: ANTH.description, orig: parseOrigAmount(ANTH) })
  const r = scoreDoc(ANTH, anthDoc(), c)
  assert.ok(r.reasons.includes('montant initial USD au relevé'))
  assert.ok(r.score >= 85, `score ${r.score}`)
})

test('pièce notée CAD qui tombe juste une fois lue en USD', () => {
  const txn = { ...ANTH, amount: -147.04, description: 'ANTHROPIC SAN FRANCISCO CA USA CA' }
  const r = scoreDoc(txn, anthDoc(), ctx({ rate: 1.4002, text: txn.description }))
  assert.ok(r.reasons.includes('pièce sans doute en USD'))
  assert.ok(r.score >= 55, `score ${r.score}`)
  const exact = scoreDoc({ ...txn, amount: -147.02 }, anthDoc({ currency: 'USD' }), ctx({ rate: 1.4002, text: txn.description }))
  assert.ok(exact.score > r.score)
})

test('converti + ~2,5 % de frais de change de la carte', () => {
  const txn = { ...ANTH, description: 'ANTHROPIC SAN FRANCISCO' }
  const r = scoreDoc(txn, anthDoc({ currency: 'USD' }), ctx({ rate: 1.4002, text: txn.description }))
  assert.ok(r.reasons.includes('converti + ~2,5 % de frais de change'))
  const near = scoreDoc({ ...txn, amount: -148.2 }, anthDoc({ currency: 'USD' }), ctx({ rate: 1.4002, text: txn.description }))
  assert.ok(near.reasons.includes('montant proche une fois converti'))
  assert.ok(r.score > near.score)
})

// ── Entrées d'argent payées par une pièce négative (cas ARC du 2026-09-22) ───
test('signCompatible : sortie = pièce positive, entrée = pièce négative', () => {
  assert.equal(signCompatible(-10, 10), true)
  assert.equal(signCompatible(-10, 0), true)
  assert.equal(signCompatible(-10, -10), false)
  assert.equal(signCompatible(10, -10), true)
  assert.equal(signCompatible(10, 10), false)
  assert.equal(signCompatible(0, 10), false)
})

test('remboursement d’impôt : montant exact + libellé gouvernemental = certitude', () => {
  const txn = { amount: 121215.70, txn_date: '2026-09-22', description: 'REMB. IMPOT', details: 'CANADA', reference: null }
  const d = doc({ company: 'Agence du revenu du Canada', names: ['Agence du revenu du Canada'], date: '2026-09-16', total: -121215.70 })
  const r = scoreDoc(txn, d, ctx({ text: 'REMB. IMPOT CANADA' }))
  assert.ok(r.reasons.includes('montant exact'))
  assert.ok(r.reasons.includes('libellé gouvernemental au relevé'))
  assert.equal(r.nameHit, true)
  assert.ok(r.score >= 85, `score ${r.score}`)
})
