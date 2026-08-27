import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pickAchatForPayment, coveredBillIds, resolveAccountsFromNote } from './treasuryPayments.js'

// ── pickAchatForPayment ──────────────────────────────────────────────────────
// Scénario Dubois Agrinovation (9 août 2026) : le paiement de 830,77 $ s'était
// lié à la première facture au montant voisin dans l'ordre de la table — une
// facture de 2020 à 837,01 $ — au lieu de la facture exacte du 9 août.

const dubois2020 = { id: 'old', vendor: 'Dubois Agrinovation', total_cad: 837.01, balance_due_cad: 837.01, due_date: '2020-02-14' }
const dubois2026 = { id: 'new', vendor: 'Dubois Agrinovation', total_cad: 830.77, balance_due_cad: 830.77, due_date: '2026-08-09' }

test('meilleure candidate : montant exact avant montant voisin, peu importe l\'ordre', () => {
  const pmt = { label: 'Dubois Agrinovation', amount: 830.77, payment_date: '2026-08-09' }
  assert.equal(pickAchatForPayment([dubois2020, dubois2026], pmt)?.id, 'new')
  assert.equal(pickAchatForPayment([dubois2026, dubois2020], pmt)?.id, 'new')
})

test('à montant égal : échéance la plus proche de la date du paiement', () => {
  const a = { id: 'a', vendor: 'Fournisseur X', total_cad: 500, balance_due_cad: 500, due_date: '2026-06-01' }
  const b = { id: 'b', vendor: 'Fournisseur X', total_cad: 500, balance_due_cad: 500, due_date: '2026-08-10' }
  assert.equal(pickAchatForPayment([a, b], { label: 'Fournisseur X', amount: 500, payment_date: '2026-08-09' })?.id, 'b')
})

test('libellés qui se contiennent (normalisés), sinon aucun lien', () => {
  assert.equal(pickAchatForPayment([dubois2026], { label: 'DUBOIS', amount: 830.77 })?.id, 'new')
  assert.equal(pickAchatForPayment([dubois2026], { label: 'Novoxpress', amount: 830.77 }), null)
})

test('montant réglant le solde dû d\'une facture partiellement payée', () => {
  const partial = { id: 'p', vendor: 'Fournisseur Y', total_cad: 1000, balance_due_cad: 400, due_date: '2026-08-15' }
  const full = { id: 'f', vendor: 'Fournisseur Y', total_cad: 402, balance_due_cad: 402, due_date: '2026-08-15' }
  // 402 $ exact sur la facture f ; 400 $ = solde dû de p.
  assert.equal(pickAchatForPayment([partial, full], { label: 'Fournisseur Y', amount: 400, payment_date: '2026-08-15' })?.id, 'p')
})

// ── coveredBillIds ───────────────────────────────────────────────────────────
// Filet de la projection : la facture ouverte du 9 août ne doit pas se projeter
// EN PLUS du paiement en attente qui la règle, même si le lien achat_id manque
// ou pointe vers une vieille facture payée.

const billAug9 = { id: 'bill-9', vendor: 'Dubois Agrinovation', due_date: '2026-08-09', balance_due_cad: 830.77 }

test('facture couverte par un paiement au même fournisseur, montant et date proches', () => {
  const pmts = [{ id: 'pmt-1', label: 'Dubois Agrinovation', amount: 830.77, payment_date: '2026-08-09', achat_id: null }]
  const covered = coveredBillIds([billAug9], pmts)
  assert.deepEqual(covered.get('bill-9'), { payment_id: 'pmt-1', payment_label: 'Dubois Agrinovation', payment_date: '2026-08-09' })
})

test('tolérances : 1 % / 1 $ sur le montant, fenêtre de jours sur la date', () => {
  const near = [{ id: 'p', label: 'Dubois Agrinovation', amount: 828.5, payment_date: '2026-08-15', achat_id: null }]
  assert.ok(coveredBillIds([billAug9], near).has('bill-9'))
  const wrongAmount = [{ id: 'p', label: 'Dubois Agrinovation', amount: 700, payment_date: '2026-08-09', achat_id: null }]
  assert.ok(!coveredBillIds([billAug9], wrongAmount).has('bill-9'))
  const tooFar = [{ id: 'p', label: 'Dubois Agrinovation', amount: 830.77, payment_date: '2026-08-25', achat_id: null }]
  assert.ok(!coveredBillIds([billAug9], tooFar).has('bill-9'))
  const otherVendor = [{ id: 'p', label: 'Novoxpress', amount: 830.77, payment_date: '2026-08-09', achat_id: null }]
  assert.ok(!coveredBillIds([billAug9], otherVendor).has('bill-9'))
})

test('un paiement ne couvre qu\'une seule facture', () => {
  const twin = { ...billAug9, id: 'bill-9b', due_date: '2026-08-10' }
  const pmts = [{ id: 'pmt-1', label: 'Dubois Agrinovation', amount: 830.77, payment_date: '2026-08-09', achat_id: null }]
  const covered = coveredBillIds([billAug9, twin], pmts)
  assert.ok(covered.has('bill-9'))
  assert.ok(!covered.has('bill-9b'))
})

// ── resolveAccountsFromNote ──────────────────────────────────────────────────
// « De quel compte on paie ce fournisseur » est noté en texte libre sur le
// profil (« Master », « Visa USD », « Desjardins »…, hérité du répertoire
// Fournisseurs_Particularités). C'est le seul indice pour un fournisseur jamais
// encore payé depuis l'ERP : il doit se traduire en compte réel, ou en RIEN
// quand il est ambigu (mieux vaut le défaut que le mauvais compte).

const ACCOUNTS = [
  { name: 'BNC CAD', currency: 'CAD', kind: 'bank' },
  { name: 'BNC USD', currency: 'USD', kind: 'bank' },
  { name: 'BNC Épargne', currency: 'CAD', kind: 'bank' },
  { name: 'MasterCard BNC', currency: 'CAD', kind: 'card' },
  { name: 'Desjardins CAD', currency: 'CAD', kind: 'bank' },
  { name: 'Desjardins USD', currency: 'USD', kind: 'bank' },
  { name: 'Marge Desjardins', currency: 'CAD', kind: 'bank' },
  { name: 'VISA Desjardins CAD', currency: 'CAD', kind: 'card' },
  { name: 'VISA Desjardins USD', currency: 'USD', kind: 'card' },
  { name: 'Venn USD', currency: 'USD', kind: 'bank' },
  { name: 'Venn CAD', currency: 'CAD', kind: 'bank' },
]
const resolve = note => resolveAccountsFromNote(note, ACCOUNTS)

test('note de compte : le compte qui ajoute le moins de mots gagne', () => {
  assert.deepEqual(resolve('Master'), { CAD: 'MasterCard BNC' })
  // « Desjardins » seul ≠ « VISA Desjardins » ni « Marge Desjardins ».
  assert.deepEqual(resolve('Desjardins'), { CAD: 'Desjardins CAD', USD: 'Desjardins USD' })
  assert.deepEqual(resolve('BNC'), { CAD: 'BNC CAD', USD: 'BNC USD' })
})

test('note de compte : la devise nommée restreint le résultat', () => {
  assert.deepEqual(resolve('Visa USD'), { USD: 'VISA Desjardins USD' })
  assert.deepEqual(resolve('BNC USD'), { USD: 'BNC USD' })
  assert.deepEqual(resolve('Venn USD'), { USD: 'Venn USD' })
})

test('note de compte : parenthèses ignorées, première option d\'un « ou »', () => {
  assert.deepEqual(resolve('Master (pré-autorisé)'), { CAD: 'MasterCard BNC' })
  assert.deepEqual(resolve('Master (par tél.)'), { CAD: 'MasterCard BNC' })
  assert.deepEqual(resolve('Visa USD ou Chèque USD'), { USD: 'VISA Desjardins USD' })
})

test('note de compte ambiguë ou inconnue : aucun compte proposé', () => {
  assert.deepEqual(resolve('BNC Venn'), {})
  assert.deepEqual(resolve('Comptant/Débit/Crédit'), {})
  assert.deepEqual(resolve('Carte de crédit à PA'), {})
  assert.deepEqual(resolve(''), {})
  assert.deepEqual(resolve(null), {})
})
