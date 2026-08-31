import test from 'node:test'
import assert from 'node:assert/strict'
import { generateTotp } from './totp.js'
import { parseInvoiceLinks, parseCardDate, parseCardTotal } from './amazon.js'
import { amountMatches, dateMatches, selectDocuments, isDue } from './invoiceNeeds.js'
import { stripBankNoise } from './vendorFromBankLabel.js'
import { parseSessionPayload, sessionCoversDomain } from './session.js'
// index.js ouvre la base au chargement : on n'importe ici que le collecteur.
import simplex, { parseSimplexDate, parseSimplexAmount, parseSimplexRows } from './simplex.js'

// Vecteur officiel RFC 6238 (secret ASCII « 12345678901234567890 », T = 59 s).
test('generateTotp suit le vecteur RFC 6238', () => {
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
  assert.equal(generateTotp(secret, { at: 59_000 }), '287082')
  assert.equal(generateTotp(secret, { at: 1111111109_000 }), '081804')
})

test('generateTotp rejette un secret non base32', () => {
  assert.throws(() => generateTotp('pas-un-secret!'), /base32/)
})

test('parseSessionPayload accepte un export Cookie-Editor', () => {
  const state = parseSessionPayload(JSON.stringify([
    { name: 'wixSession', value: 'abc', domain: '.wix.com', path: '/', httpOnly: true, secure: true, sameSite: 'no_restriction', expirationDate: 1800000000 },
  ]), 'wix.com')
  assert.equal(state.cookies.length, 1)
  assert.deepEqual(state.cookies[0], {
    name: 'wixSession', value: 'abc', domain: '.wix.com', path: '/',
    expires: 1800000000, httpOnly: true, secure: true, sameSite: 'None',
  })
  assert.ok(sessionCoversDomain(state, 'wix.com'))
})

test('parseSessionPayload accepte un storageState Playwright', () => {
  const state = parseSessionPayload(JSON.stringify({
    cookies: [{ name: 'a', value: 'b', domain: '.wix.com', path: '/', expires: -1 }],
    origins: [{ origin: 'https://manage.wix.com', localStorage: [] }],
  }))
  assert.equal(state.cookies[0].expires, -1)
  assert.equal(state.origins.length, 1)
})

test('parseSessionPayload accepte un en-tête brut et applique le domaine', () => {
  const state = parseSessionPayload('a=1; b=2', 'wix.com')
  assert.equal(state.cookies.length, 2)
  assert.equal(state.cookies[0].domain, 'wix.com')
})

test('parseSessionPayload refuse un collage inutilisable', () => {
  assert.throws(() => parseSessionPayload(''), /Rien à importer/)
  assert.throws(() => parseSessionPayload('{cassé'), /JSON invalide/)
  assert.throws(() => parseSessionPayload('[]', 'wix.com'), /Aucun cookie/)
})

test('sessionCoversDomain repère une session du mauvais portail', () => {
  const state = parseSessionPayload('a=1', 'amazon.ca')
  assert.equal(sessionCoversDomain(state, 'wix.com'), false)
})

test('parseCardDate lit les deux locales de la carte de commande', () => {
  assert.equal(parseCardDate('Order placed August 20, 2026 Total $38.18'), '2026-08-20')
  assert.equal(parseCardDate('Commande effectuée le 20 août 2026'), '2026-08-20')
  assert.equal(parseCardDate('rien ici'), null)
})

test('parseCardTotal prend le total de commande, pas le prix des articles', () => {
  // Cas réel : le prix de l'article (CA$19.99) suit le total dans la carte.
  const card = 'Order placed August 20, 2026 Total $22.98 Ship to Orisha Order no. 701-6420342-8661839 Invoice IMAGAME Lot de 50 CA$19.99'
  assert.equal(parseCardTotal(card), 22.98)
  assert.equal(parseCardTotal('Total 1 126,45 $'), 1126.45)
  assert.equal(parseCardTotal('Ship to Orisha'), null)
})

test('parseInvoiceLinks donne un identifiant stable malgré l’uuid volatil', () => {
  // Amazon régénère l'uuid à chaque appel du popover : deux appels successifs
  // doivent produire les mêmes slots, sinon la dédup ne mord jamais.
  const html = (u1, u2) => `
    <a href="/gp/css/summary/print.html?orderID=701-1">Printable Order Summary</a>
    <a href="/documents/download/${u1}/invoice.pdf">Invoice</a>
    <a href="/documents/download/${u2}/invoice.pdf">Credit note</a>
    <a href="/gp/help/customer/display.html?ref=x">Request Invoice</a>`
  const a = parseInvoiceLinks(html('aaa-111', 'bbb-222'))
  const b = parseInvoiceLinks(html('ccc-333', 'ddd-444'))
  assert.deepEqual(a.map(d => d.slot), ['facture', 'note-de-credit'])
  assert.deepEqual(a.map(d => d.slot), b.map(d => d.slot))
})

test('parseInvoiceLinks rend vide quand le vendeur n’a publié aucune facture', () => {
  assert.deepEqual(parseInvoiceLinks('<a href="/gp/help/customer/display.html">Request Invoice</a>'), [])
  assert.deepEqual(parseInvoiceLinks(''), [])
})

test('stripBankNoise retire code de terminal, queue géographique et suffixe TRX', () => {
  assert.equal(stripBankNoise('AMZN MKTP CA*5A2507RG0 TORONTO       ON  CAN ON'), 'amzn mktp ca toronto')
  assert.equal(stripBankNoise('CHATBASE TORONTO ON — -31.05'), 'chatbase toronto on')
  assert.equal(stripBankNoise('GRAMMARLY CO*YEX2ZP8   SAN FRANCISCO CA'), 'grammarly co san francisco')
})

test('amountMatches : exact, marge relative, hors tolérance, devise', () => {
  const need = { amount: -38.18, currency: 'CAD' }
  assert.equal(amountMatches(need, { amount: 38.18, currency: 'CAD' }).exact, true)
  const near = amountMatches(need, { amount: 38.60, currency: 'CAD' })
  assert.equal(near.ok, true)
  assert.equal(near.exact, false)
  assert.equal(amountMatches(need, { amount: 45, currency: 'CAD' }).ok, false)
  // Devise différente : jamais apparié tout seul (terrain de bank_charged_total).
  assert.equal(amountMatches(need, { amount: 38.18, currency: 'USD' }).reason, 'devise différente')
  assert.equal(amountMatches(need, { amount: null }).reason, 'montant inconnu')
})

test('dateMatches : le débit suit la facture, jamais loin devant', () => {
  const need = { txn_date: '2026-08-20' }
  assert.equal(dateMatches(need, { date: '2026-08-18' }), true)
  assert.equal(dateMatches(need, { date: '2026-08-22' }), true)
  assert.equal(dateMatches(need, { date: '2026-08-01' }), false)
  assert.equal(dateMatches(need, { date: null }), true)
})

test('selectDocuments sert les concordances exactes avant la marge de 2 %', () => {
  const needs = [
    { id: 'n1', amount: -38.18, currency: 'CAD', txn_date: '2026-08-20' },
    { id: 'n2', amount: -38.60, currency: 'CAD', txn_date: '2026-08-20' },
  ]
  const docs = [{ externalId: 'd1', amount: 38.18, currency: 'CAD', date: '2026-08-20' }]
  const { picks, unmatched } = selectDocuments(needs, docs)
  // n2 est à 1,1 % de d1, mais d1 appartient à n1 au cent près.
  assert.equal(picks.length, 1)
  assert.equal(picks[0].need.id, 'n1')
  assert.equal(unmatched[0].need.id, 'n2')
  assert.equal(unmatched[0].reason, 'introuvable')
})

test('selectDocuments refuse de deviner entre deux factures au même montant', () => {
  const needs = [{ id: 'n1', amount: -43.10, currency: 'USD', txn_date: '2026-08-21' }]
  const docs = [
    { externalId: 'd1', amount: 43.10, currency: 'USD', date: '2026-08-21' },
    { externalId: 'd2', amount: 43.10, currency: 'USD', date: '2026-08-19' },
  ]
  const { picks, unmatched } = selectDocuments(needs, docs)
  assert.equal(picks.length, 0)
  assert.equal(unmatched[0].reason, 'ambigue')
})

test('parseSimplexDate lit les trois formats du portail Simplex', () => {
  assert.equal(parseSimplexDate('Facture du 2026-07-31 · 128,74 $'), '2026-07-31')
  assert.equal(parseSimplexDate('Invoice July 31, 2026'), '2026-07-31')
  assert.equal(parseSimplexDate('31 juillet 2026'), '2026-07-31')
  // Un jour > 12 tranche l'ordre ; sinon jj/mm (locale CA du compte).
  assert.equal(parseSimplexDate('31/07/2026'), '2026-07-31')
  assert.equal(parseSimplexDate('05/07/2026'), '2026-07-05')
  assert.equal(parseSimplexDate('rien ici'), null)
})

test('parseSimplexAmount lit les deux écritures du dollar', () => {
  assert.equal(parseSimplexAmount('Total 128,74 $'), 128.74)
  assert.equal(parseSimplexAmount('Total $1,284.05'), 1284.05)
  assert.equal(parseSimplexAmount('aucun montant'), null)
})

test('parseSimplexRows préfère le numéro de facture à la date comme identifiant', () => {
  // Le numéro est le seul identifiant stable : la date peut changer de format
  // avec la locale du compte, et deux factures peuvent porter la même.
  const docs = parseSimplexRows([
    { index: 0, href: '/Invoice/Download/9912', text: 'Télécharger', row: 'Invoice INV-9912 2026-07-31 128,74 $' },
    { index: 1, href: '', text: '', row: 'Facture 2026-06-30 131,02 $' },
    { index: 2, href: '', text: '', row: 'Solde du compte' },
  ])
  assert.deepEqual(docs.map(d => d.externalId), ['simplex:9912', 'simplex:2026-06-30'])
  assert.equal(docs[0].amount, 128.74)
  assert.equal(docs[0].date, '2026-07-31')
  assert.equal(docs[0].href, '/Invoice/Download/9912')
  // Ligne sans lien : c'est son index qui permettra de la recliquer.
  assert.equal(docs[1].index, 1)
  assert.equal(docs[1].currency, 'CAD')
})

test('parseSimplexRows dédoublonne la même facture vue en lien et en ligne', () => {
  const docs = parseSimplexRows([
    { index: 0, href: '/Invoice/Download/9912', text: 'PDF', row: 'INV-9912 2026-07-31 128,74 $' },
    { index: 1, href: '', text: '', row: 'Invoice INV-9912 2026-07-31 128,74 $' },
  ])
  assert.equal(docs.length, 1)
  assert.equal(docs[0].href, '/Invoice/Download/9912')
})

test('le collecteur Simplex respecte le contrat attendu par l’orchestrateur', () => {
  assert.equal(simplex.label, 'Simplex Wireless')
  assert.equal(typeof simplex.list, 'function')
  assert.ok(simplex.fields.username && simplex.fields.password)
})

test('isDue espace les nouvelles tentatives puis abandonne', () => {
  const t0 = Date.parse('2026-08-20T00:00:00Z')
  assert.equal(isDue({ status: 'en_attente' }, t0), true)
  assert.equal(isDue({ status: 'trouvee' }, t0), false)
  assert.equal(isDue({ status: 'sans_collecteur' }, t0), false)
  const day = 86400000
  assert.equal(isDue({ status: 'introuvable', attempts: 1, last_attempt_at: '2026-08-19T00:00:00Z' }, t0), true)
  assert.equal(isDue({ status: 'introuvable', attempts: 2, last_attempt_at: '2026-08-19T00:00:00Z' }, t0), false)
  assert.equal(isDue({ status: 'introuvable', attempts: 2, last_attempt_at: '2026-08-19T00:00:00Z' }, t0 + 3 * day), true)
  assert.equal(isDue({ status: 'introuvable', attempts: 3, last_attempt_at: '2026-08-01T00:00:00Z' }, t0), false)
})
