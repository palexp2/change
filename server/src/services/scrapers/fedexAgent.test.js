import test from 'node:test'
import assert from 'node:assert/strict'
import { PDFDocument, StandardFonts } from 'pdf-lib'
import { isFedexUrl, parseDecision, observedInvoices, validateFedexPdf, applyFedexAction, listFedexWithAgent } from './fedexAgent.js'
import { launchContext } from './browser.js'

async function pdf(number, label = 'Invoice Number:') {
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  doc.addPage().drawText(`FedEx ${label} ${number}`, { x: 50, y: 700, font, size: 16 })
  return Buffer.from(await doc.save())
}

test('navigation limitée aux vrais domaines HTTPS FedEx', () => {
  for (const url of ['https://www.fedex.com/a', 'https://login.fedex.com/']) assert.ok(isFedexUrl(url))
  for (const url of ['http://fedex.com', 'https://fedex.com.evil.test', 'https://evilfedex.com', 'https://user:pass@fedex.com', 'file:///tmp/x', 'https://fedex.com:8080']) assert.equal(isFedexUrl(url), false)
  assert.throws(() => parseDecision('{"action":"evaluate","code":"evil"}'))
})

test('seules les factures observées, numérotées et dans la période sont retenues', () => {
  const row = 'Invoice 812345678 2026-09-12 $12.00'
  const observation = { frames: [{ text: row + '\nInvoice 912345678 2025-09-12 $12.00' }] }
  assert.equal(observedInvoices([row], observation, '2026-08-01')[0].externalId, 'fedex:812345678')
  assert.throws(() => observedInvoices(['Invoice 111111111 2026-09-12 $12.00'], observation, '2026-08-01'))
  assert.deepEqual(observedInvoices(['Invoice 912345678 2025-09-12 $12.00'], observation, '2026-08-01'), [])
})

test('un PDF différent ou une page HTML ne peuvent remplacer la facture demandée', async () => {
  const buffer = await pdf('812-345-678')
  assert.equal(await validateFedexPdf(buffer, '812345678'), buffer)
  const activity = await pdf('A2-746-26580', 'Activity Number:')
  assert.equal(await validateFedexPdf(activity, '274626580'), activity)
  await assert.rejects(validateFedexPdf(activity, '274626581'), /ne confirme pas/)
  await assert.rejects(validateFedexPdf(buffer, '912345678'), /ne confirme pas/)
  await assert.rejects(validateFedexPdf(Buffer.from('<html>login</html>'), '812345678'), /PDF valide/)
})

test('paiement interdit et mot de passe saisi une seule fois dans un champ sécurisé', async () => {
  const fills = []
  const frame = { url: () => 'https://www.fedex.com/', locator: () => ({ fill: async v => fills.push(v) }) }
  const refs = new Map([
    ['pay', { ref: 'pay', label: 'Pay', tag: 'button', frame }],
    ['pwd', { ref: 'pwd', label: 'Password', tag: 'input', type: 'password', frame }],
    ['search', { ref: 'search', label: 'Search', tag: 'input', type: 'text', frame }],
  ])
  const ctx = { credentials: { password: 'secret-value' } }, state = { secrets: {} }
  await assert.rejects(applyFedexAction({ action: 'click', ref: 'pay' }, refs, ctx, state), /non autorisée/)
  await assert.rejects(applyFedexAction({ action: 'secret', ref: 'search', secret: 'password' }, refs, ctx, state), /champ sécurisé/)
  await applyFedexAction({ action: 'secret', ref: 'pwd', secret: 'password' }, refs, ctx, state)
  assert.deepEqual(fills, ['secret-value'])
  await assert.rejects(applyFedexAction({ action: 'secret', ref: 'pwd', secret: 'password' }, refs, ctx, state), /déjà tentée/)
})

test('parcours navigateur : liste paginée, nouveaux libellés, téléchargement vérifié et PDF précédent rejeté', { timeout: 30000 }, async () => {
  const { browser, context } = await launchContext()
  try {
    const buffer = await pdf('812345678')
    const date = new Date().toISOString().slice(0, 10)
    await context.route('https://www.fedex.com/**', route => {
      const url = new URL(route.request().url())
      if (url.pathname === '/invoice.pdf') return route.fulfill({ contentType: 'application/pdf', headers: { 'content-disposition': 'attachment; filename=invoice.pdf' }, body: buffer })
      let body = url.pathname === '/page2'
        ? `<p>Invoice 912345678 ${date} $24.00</p><a href="/invoice.pdf">Obtenir document B</a>`
        : `<p>Invoice 812345678 ${date} $12.00</p><a href="/page2">Archives suivantes</a><a href="/invoice.pdf">Obtenir document A</a>`
      if (url.pathname !== '/page2') body += `<div id="consent"></div><script>document.querySelector('#consent').attachShadow({mode:'open'}).innerHTML='<button onclick="this.getRootNode().host.remove()">Reject cookies</button>'</script>`
      return route.fulfill({ contentType: 'text/html', body })
    })
    const page = await context.newPage(), snapshots = []
    let phase = 0, downloads = 0
    const decide = async obs => {
      const controls = obs.frames.flatMap(f => f.controls)
      const consent = controls.find(c => c.label === 'Reject cookies')
      if (consent) return { action: 'click', ref: consent.ref }
      if (obs.goal.includes('Télécharger')) {
        if (++downloads > 2) return { action: 'done' }
        return { action: 'click', ref: controls.find(c => c.label.startsWith('Obtenir')).ref }
      }
      phase++
      if (phase === 1 || phase === 3) return { action: 'invoices', rows: [obs.frames[0].text.split('\n')[0]] }
      if (phase === 2) return { action: 'click', ref: controls.find(c => c.label === 'Archives suivantes').ref }
      return { action: 'done' }
    }
    const docs = await listFedexWithAgent({ page, context, lookbackDays: 30, log() {}, snapshot: async name => snapshots.push(name) }, { decide })
    assert.equal(docs.length, 2)
    assert.equal((await docs[0].fetch()).subarray(0, 5).toString(), '%PDF-')
    await assert.rejects(docs[1].fetch(), /Aucun PDF vérifié/)
    assert.ok(snapshots.some(s => s.includes('912345678-blocage')))
  } finally { await browser.close() }
})

test('le budget arrête une boucle et conserve une capture', { timeout: 15000 }, async () => {
  const { browser, context } = await launchContext()
  try {
    await context.route('https://www.fedex.com/**', route => route.fulfill({ contentType: 'text/html', body: '<p>Chargement</p>' }))
    const page = await context.newPage(), snapshots = []
    await assert.rejects(listFedexWithAgent({ page, context, log() {}, snapshot: async name => snapshots.push(name) },
      { maxSteps: 1, decide: async () => ({ action: 'wait' }) }), /limite de temps ou d’étapes/)
    assert.ok(snapshots.includes('fedex-agent-blocage'))
  } finally { await browser.close() }
})

test('nouvelle grille FedEx : références exactes, numéro avec tirets, date de facture et montant initial', () => {
  const row = { ref: 'rf0-1', text: '6252-9337-5 2-702-42730 12/24/2025 12/09/2025 $245.04 $0.00 USD',
    headers: ['ACCOUNT NUMBER', 'INVOICE NUMBER', 'DUE DATE', 'INVOICE DATE', 'ORIGINAL AMOUNT DUE', 'CURRENT BALANCE', 'CURRENCY'],
    cells: ['6252-9337-5', '2-702-42730', '12/24/2025', '12/09/2025', '$245.04', '$0.00', 'USD'] }
  const observation = { frames: [{ text: row.text, invoiceRows: [row] }] }
  const [doc] = observedInvoices(['rf0-1'], observation, '2025-01-01')
  assert.equal(doc.number, '270242730')
  assert.equal(doc.date, '2025-12-09')
  assert.equal(doc.amount, 245.04)
  assert.equal(doc.currency, 'USD')
  assert.throws(() => observedInvoices(['rf0-99'], observation, '2025-01-01'))
})

test('PDF généré en blob dans un nouvel onglet : récupéré et vérifié', { timeout: 20000 }, async () => {
  const { browser, context } = await launchContext()
  try {
    const encoded = (await pdf('812345678')).toString('base64')
    const row = `Invoice 812345678 ${new Date().toISOString().slice(0, 10)} $12.00`
    await context.route('https://www.fedex.com/**', route => route.fulfill({ contentType: 'text/html',
      body: `<p>${row}</p><button onclick="window.open(window.URL.createObjectURL(new Blob([Uint8Array.from(atob('${encoded}'),c=>c.charCodeAt(0))],{type:'application/pdf'})))">Show PDF</button>` }))
    const page = await context.newPage()
    let listed = false
    const docs = await listFedexWithAgent({ page, context, lookbackDays: 30, log() {}, snapshot: async () => {} }, {
      decide: async obs => {
        if (obs.goal.includes('Télécharger')) return { action: 'click', ref: obs.frames[0].controls[0].ref }
        if (!listed) { listed = true; return { action: 'invoices', rows: [row] } }
        return { action: 'done' }
      },
    })
    const buffer = await docs[0].fetch()
    assert.equal(buffer.subarray(0, 5).toString(), '%PDF-')
  } finally { await browser.close() }
})
