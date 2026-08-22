import test from 'node:test'
import assert from 'node:assert/strict'
import { searchAccount, detectSign, subsetSum, labelAffinity, amountTolerance, fxRate, verifyConversions } from './bankQbSearch.js'

const ACCOUNT = { id: 'acc-desj', name: 'Desjardins CAD', qb_account_id: '100' }
const OTHER = { id: 'acc-marge', name: 'Marge Desjardins', qb_account_id: '200' }

// Fabrique une entrée de grand livre.
const e = (over) => ({
  accountId: ACCOUNT.id, accountName: ACCOUNT.name, qbAccountId: '100',
  date: '2026-08-01', amount: -100, foreign: null, type: 'Dépense', entity: 'expense',
  qbId: '1', name: null, memo: null, docNum: null, cleared: 'R', ...over,
})
const t = (over) => ({ id: 'b1', txn_date: '2026-08-01', amount: -100, description: null, details: null, reference: null, ...over })

const indexOf = (own, others = []) => ({
  byAccount: new Map([[ACCOUNT.id, own], [OTHER.id, others]]),
  all: [...own, ...others],
})

test('montant exact, date exacte', () => {
  const { matches } = searchAccount(ACCOUNT, [t()], indexOf([e()]))
  assert.equal(matches.get('b1').method, 'exact')
  assert.equal(matches.get('b1').delta, 0)
})

test('date décalée jusqu\'à 30 jours — l\'ancien seuil de 4 jours créait de faux « absent de QB »', () => {
  const { matches } = searchAccount(ACCOUNT, [t()], indexOf([e({ date: '2026-08-14' })]))
  assert.equal(matches.get('b1').method, 'fenetre')
  const trop = searchAccount(ACCOUNT, [t()], indexOf([e({ date: '2026-10-01' })]))
  assert.equal(trop.matches.size, 0)
})

test('montant en devise du compte (compte USD, grand livre en CAD)', () => {
  const { matches } = searchAccount(ACCOUNT, [t({ amount: -50 })], indexOf([e({ amount: -68.9, foreign: -50 })]))
  assert.equal(matches.get('b1').method, 'devise')
})

test('écart de frais ou conversion : apparié, écart conservé', () => {
  const { matches } = searchAccount(ACCOUNT, [t({ amount: -1000 })], indexOf([e({ amount: -1012 })]))
  const m = matches.get('b1')
  assert.equal(m.method, 'tolerance')
  assert.equal(m.delta, -12)
  assert.equal(amountTolerance(-1000), 20)
  // Au-delà de la tolérance, rien n'est apparié à tort.
  const loin = searchAccount(ACCOUNT, [t({ amount: -1000 })], indexOf([e({ amount: -1400 })]))
  assert.equal(loin.matches.size, 0)
})

test('appariement global : la meilleure ligne prend l\'écriture, pas la première venue', () => {
  // Trois « Dépôt de marge » de 1 000 $, une seule écriture QB le 11 août.
  const bank = [
    t({ id: 'b1', txn_date: '2026-08-01', amount: 1000 }),
    t({ id: 'b2', txn_date: '2026-08-11', amount: 1000 }),
    t({ id: 'b3', txn_date: '2026-08-21', amount: 1000 }),
  ]
  const { matches, unmatchedBank } = searchAccount(ACCOUNT, bank, indexOf([e({ date: '2026-08-11', amount: 1000 })]))
  assert.equal(matches.size, 1)
  assert.ok(matches.has('b2')) // la plus proche en date, pas b1
  assert.deepEqual(unmatchedBank.map((x) => x.id), ['b1', 'b3'])
})

test('virement interne comptabilisé sur l\'AUTRE compte', () => {
  const autre = [{ ...e({ amount: -50000, name: 'Virement MC2' }), accountId: OTHER.id, accountName: OTHER.name, qbAccountId: '200' }]
  const { matches } = searchAccount(ACCOUNT, [t({ amount: -50000, description: 'Virement-remboursement /à 0101247-MC2' })], indexOf([], autre))
  assert.equal(matches.get('b1').method, 'autre_compte')
  assert.equal(matches.get('b1').entries[0].accountName, 'Marge Desjardins')
})

test('l\'autre compte porte le mouvement en sens inverse', () => {
  const autre = [{ ...e({ amount: 50000, name: 'Virement' }), accountId: OTHER.id, accountName: OTHER.name }]
  const { matches } = searchAccount(ACCOUNT, [t({ amount: -50000, description: 'Virement à MC2' })], indexOf([], autre))
  assert.equal(matches.get('b1').method, 'autre_compte')
})

test('agrégat : une ligne de relevé = plusieurs écritures QB', () => {
  const own = [e({ qbId: '1', amount: -60 }), e({ qbId: '2', amount: -40, date: '2026-08-02' })]
  const { matches } = searchAccount(ACCOUNT, [t({ amount: -100 })], indexOf(own))
  const m = matches.get('b1')
  assert.equal(m.method, 'agregat')
  assert.equal(m.entries.length, 2)
})

test('agrégat inverse : plusieurs lignes du relevé = une écriture QB', () => {
  const bank = [t({ id: 'b1', amount: -60 }), t({ id: 'b2', amount: -40, txn_date: '2026-08-02' })]
  const { matches } = searchAccount(ACCOUNT, bank, indexOf([e({ amount: -100 })]))
  assert.equal(matches.get('b1').method, 'agregat_inverse')
  assert.equal(matches.get('b2').method, 'agregat_inverse')
})

test('orientation du signe déduite (relevé de carte inversé)', () => {
  const bank = [t({ amount: 100 }), t({ id: 'b2', amount: 250, txn_date: '2026-08-03' })]
  const ledger = [e({ amount: -100 }), e({ qbId: '2', amount: -250, date: '2026-08-03' })]
  assert.equal(detectSign(bank, ledger), -1)
  const { matches } = searchAccount(ACCOUNT, bank, indexOf(ledger))
  assert.equal(matches.size, 2)
})

test('le libellé départage sans jamais suffire à apparier seul', () => {
  assert.equal(labelAffinity({ description: 'AMAZON.CA*R42HG7 TORONTO ON' }, { name: 'Amazon.ca' }), 1)
  assert.equal(labelAffinity({ description: 'PAIEMENT INTERNET' }, { name: 'Hydro-Québec' }), 0)
  // Libellés opposés, montant et date exacts : l'appariement se fait quand même.
  const { matches } = searchAccount(ACCOUNT, [t({ description: 'ZZZZ' })], indexOf([e({ name: 'Hydro-Québec' })]))
  assert.equal(matches.get('b1').method, 'exact')
})

test('subsetSum ne renvoie que des sous-ensembles d\'au moins deux éléments', () => {
  assert.equal(subsetSum([{ amount: -100 }], -100, 4), null)
  assert.equal(subsetSum([{ amount: -60 }, { amount: -40 }], -100, 4).length, 2)
  assert.equal(subsetSum([{ amount: -60 }, { amount: -30 }], -100, 4), null)
})

test('conversion de devise : appariée sur le taux, jamais sur le montant', () => {
  // 15 000 USD virés côté QuickBooks = 20 992,50 CAD au relevé (taux 1,3995).
  const own = [e({ amount: 15000, type: 'Virement', date: '2026-07-14' })]
  const bank = [t({ amount: 20992.5, txn_date: '2026-07-14', description: 'Exchanged from USD — Currency Conversion' })]
  const m = searchAccount(ACCOUNT, bank, indexOf(own)).matches.get('b1')
  assert.equal(m.method, 'conversion')
  assert.equal(m.rate, 1.4)
  assert.equal(m.delta, 5992.5) // écart apparent, tant que le taux n'est pas vérifié
  // Hors plage de taux plausible : aucun appariement.
  assert.equal(fxRate(20992.5, 5000), null)
  assert.equal(fxRate(20992.5, -15000), null) // sens opposé
  // Une ligne ordinaire (ni conversion annoncée, ni virement) n'est pas appariée
  // par ressemblance de rapport.
  const ordinaire = searchAccount(ACCOUNT, [t({ amount: -140, description: 'AMAZON' })],
    indexOf([e({ amount: -100, type: 'Dépense' })]))
  assert.equal(ordinaire.matches.size, 0)
})

test('la vérification du taux annule l\'écart apparent d\'une conversion', async () => {
  // QuickBooks enregistre le virement en USD avec son taux ; le rapport
  // GeneralLedger affiche 15 000 des DEUX côtés, alors que le compte CAD a bien
  // reçu 20 992,50 $. Sans vérification, ça ressemblait à 5 992,50 $ manquants.
  const own = [e({ amount: 15000, type: 'Virement', entity: 'transfer', qbId: '17709', date: '2026-07-14' })]
  const bank = [t({ amount: 20992.5, txn_date: '2026-07-14', description: 'Exchanged from USD — Currency Conversion' })]
  const { matches } = searchAccount(ACCOUNT, bank, indexOf(own))
  await verifyConversions(matches, new Map(bank.map((x) => [x.id, x])),
    async () => ({ Amount: 15000, ExchangeRate: 1.3995 }))
  const m = matches.get('b1')
  assert.equal(m.verified, true)
  assert.equal(m.rate, 1.3995)
  assert.equal(m.delta, 0)

  // Taux qui ne retombe pas sur la ligne : l'écart reste, il sera signalé.
  const { matches: m2 } = searchAccount(ACCOUNT, bank, indexOf(own))
  await verifyConversions(m2, new Map(bank.map((x) => [x.id, x])),
    async () => ({ Amount: 15000, ExchangeRate: 1.2 }))
  assert.equal(m2.get('b1').verified, false)
  assert.ok(m2.get('b1').delta > 0)
})
