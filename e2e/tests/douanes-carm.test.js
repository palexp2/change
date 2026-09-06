// Douanes — ASFC (CARM) : onglet « Douanes (ASFC) » des Comptes prépayés
// (/comptes-prepayes?onglet=douanes), import idempotent du relevé,
// lien vers les reçus de l'extracteur. Les transactions de test portent des
// montants improbables (98 76x xxx $) pour ne jamais s'apparier à un vrai reçu,
// et sont supprimées dans after().
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const MARKER = `E2E-CARM-${Date.now()}`

describe('Douanes — relevé CARM (ASFC)', () => {
  let browser, ctx, page
  const createdIds = []

  const apiFetch = (path, opts = {}) => page.evaluate(async ({ path, opts }) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch(`/erp/api${path}`, {
      ...opts,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}`, ...(opts.headers || {}) },
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }, { path, opts })

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => {
    // Cleanup — supprime toutes les transactions du marqueur, même si un test a échoué.
    try {
      const r = await apiFetch('/carm/transactions')
      for (const t of (r.body?.transactions || [])) {
        if (String(t.transaction_number || '').startsWith(MARKER)) {
          await apiFetch(`/carm/transactions/${t.id}`, { method: 'DELETE' })
        }
      }
    } catch {}
    await browser?.close()
  })

  test('l\'ancienne URL /douanes redirige vers l\'onglet des comptes prépayés', async () => {
    await page.goto(URL + '/douanes', { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(
      () => location.pathname.endsWith('/comptes-prepayes') && location.search.includes('onglet=douanes'),
      null, { timeout: 15000 })
    await page.waitForSelector('h1:has-text("Comptes prépayés")', { timeout: 15000 })
    await page.waitForSelector('[data-testid="douanes-panel"]', { timeout: 15000 })
    await page.waitForSelector('[data-testid="douanes-table"]', { timeout: 15000 })
  })

  test('les trois onglets des comptes prépayés cohabitent', async () => {
    await page.goto(URL + '/comptes-prepayes', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="tab-douanes"]', { timeout: 15000 })
    // Onglet par défaut = soldes fournisseurs, pas de douanes affichées.
    assert.equal(await page.locator('[data-testid="douanes-panel"]').count(), 0)
    await page.click('[data-testid="tab-douanes"]')
    await page.waitForSelector('[data-testid="douanes-table"]', { timeout: 15000 })
    assert.ok((await page.url()).includes('onglet=douanes'), 'l\'onglet doit se refléter dans l\'URL')
    await page.click('[data-testid="tab-fpa"]')
    await page.waitForSelector('[data-testid="fpa-continuity"]', { timeout: 15000 })
    assert.equal(await page.locator('[data-testid="douanes-panel"]').count(), 0)
  })

  test('import API : création puis idempotence au ré-import', async () => {
    const text = [
      'Transaction Date,Transaction Type,Transaction Number,Amount,Balance',
      `2026-07-15,Commercial Accounting Declaration,${MARKER}-1,"9,876,543.21","9,876,543.21"`,
      `2026-07-25,Payment,${MARKER}-2,"(9,876,543.21)",0.00`,
    ].join('\n')
    const first = await apiFetch('/carm/import', { method: 'POST', body: JSON.stringify({ text }) })
    assert.equal(first.status, 200)
    assert.equal(first.body.created, 2, `2 créations attendues : ${JSON.stringify(first.body)}`)
    assert.equal(first.body.errors.length, 0)

    const again = await apiFetch('/carm/import', { method: 'POST', body: JSON.stringify({ text }) })
    assert.equal(again.body.created, 0, 'ré-import : aucune création attendue')
    assert.equal(again.body.skipped, 2)

    const list = await apiFetch('/carm/transactions')
    const mine = list.body.transactions.filter(t => String(t.transaction_number || '').startsWith(MARKER))
    assert.equal(mine.length, 2)
    createdIds.push(...mine.map(t => t.id))
    const decl = mine.find(t => t.transaction_number === `${MARKER}-1`)
    assert.equal(decl.amount, 9876543.21)
    assert.equal(decl.balance, 9876543.21)
    const pay = mine.find(t => t.transaction_number === `${MARKER}-2`)
    assert.equal(pay.amount, -9876543.21)
  })

  test('les transactions importées apparaissent dans le tableau', async () => {
    await page.goto(URL + '/comptes-prepayes?onglet=douanes', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector(`[data-testid="douanes-table"] >> text=${MARKER}-1`, { timeout: 15000 })
    await page.waitForSelector(`[data-testid="douanes-table"] >> text=${MARKER}-2`, { timeout: 15000 })
  })

  test('import par l\'UI : coller une ligne et importer', async () => {
    await page.click('[data-testid="douanes-import-open"]')
    await page.waitForSelector('[data-testid="douanes-import-text"]', { timeout: 10000 })
    await page.fill('[data-testid="douanes-import-text"]',
      `2026-08-01\tInterest\t${MARKER}-3\t9 876 001,99\t9 876 001,99`)
    await page.click('[data-testid="douanes-import-submit"]')
    await page.waitForSelector(`[data-testid="douanes-table"] >> text=${MARKER}-3`, { timeout: 15000 })
  })

  test('import par l\'UI : glisser-déposer un fichier CSV importe correctement', async () => {
    await page.click('[data-testid="douanes-import-open"]')
    await page.waitForSelector('[data-testid="douanes-import-dropzone"]', { timeout: 10000 })
    const csv = [
      'Transaction Date,Transaction Type,Transaction Number,Amount,Balance',
      `2026-08-05,Interest,${MARKER}-4,"9,876,002.50","9,876,002.50"`,
    ].join('\n')
    const dataTransfer = await page.evaluateHandle((content) => {
      const dt = new DataTransfer()
      const file = new File([content], 'releve-carm.csv', { type: 'text/csv' })
      dt.items.add(file)
      return dt
    }, csv)
    await page.dispatchEvent('[data-testid="douanes-import-dropzone"]', 'drop', { dataTransfer })
    await page.waitForSelector('[data-testid="douanes-import-preview"]', { timeout: 10000 })
    await page.click('[data-testid="douanes-import-submit"]')
    await page.waitForSelector(`[data-testid="douanes-table"] >> text=${MARKER}-4`, { timeout: 15000 })
  })

  test('une transaction déliée à la main n\'est pas ré-appariée par l\'auto-match', async () => {
    const list = await apiFetch('/carm/transactions')
    const t = list.body.transactions.find(x => x.transaction_number === `${MARKER}-3`)
    assert.ok(t, 'transaction -3 introuvable')
    const un = await apiFetch(`/carm/transactions/${t.id}/unlink`, { method: 'POST', body: '{}' })
    assert.equal(un.status, 200)
    assert.equal(un.body.match_source, 'dissocié')
    // Un GET relance l'auto-match : la ligne dissociée doit rester sans reçu.
    const after2 = await apiFetch('/carm/transactions')
    const t2 = after2.body.transactions.find(x => x.id === t.id)
    assert.equal(t2.sale_receipt_id, null)
  })

  test('classification automatique : nature, ventilation et payeur à l\'import', async () => {
    const text = [
      'Date de transaction,Type de transaction,Numéro de transaction,Description détaillée,Fournisseur,Montant',
      `2026-07-18,Evaluation (B3),${MARKER}-10,Recettes TPS sur importation,Federal Express Canada,"9,876,010.00"`,
      `2026-07-18,Evaluation (B3),${MARKER}-11,Droit à l'importation,Federal Express Canada,"9,876,011.00"`,
      `2026-07-20,Lot de paiements,${MARKER}-12,Encaissement,Federal Express Canada,"(9,876,010.00)"`,
      `2026-07-21,Lot de cartes,${MARKER}-13,Paiement entrant,Automatisation Orisha Inc.,"(9,876,011.00)"`,
    ].join('\n')
    const imp = await apiFetch('/carm/import', { method: 'POST', body: JSON.stringify({ text }) })
    assert.equal(imp.status, 200)
    assert.equal(imp.body.created, 4, `4 créations attendues : ${JSON.stringify(imp.body)}`)

    const list = await apiFetch('/carm/transactions')
    const by = n => list.body.transactions.find(t => t.transaction_number === `${MARKER}-${n}`)
    // La « description détaillée » donne la ventilation, sans aucune saisie.
    assert.equal(by(10).kind, 'tps')
    assert.equal(by(10).gst_amount, 9876010)
    assert.equal(by(10).duty_amount, 0)
    assert.equal(by(11).kind, 'droits')
    assert.equal(by(11).duty_amount, 9876011)
    // Le fournisseur du relevé dit qui paie ; un encaissement de courtier n'est
    // jamais comptabilisé ici (sa facture porte déjà la dépense et la TPS).
    assert.equal(by(12).payer, 'courtier')
    assert.equal(by(12).broker, 'FedEx')
    assert.equal(by(12).posting_state, 'non_comptabilise')
    assert.ok(String(by(12).skip_reason).startsWith('via_courtier'), by(12).skip_reason)
    assert.equal(by(10).posting_state, 'non_comptabilise', 'la charge réglée par FedEx est neutralisée')
    // Notre versement, lui, part dans QuickBooks.
    assert.equal(by(13).payer, 'nous')
    assert.equal(by(13).posting_state, 'a_comptabiliser')
    // Et il lettre la charge qu'il règle.
    const alloc = list.body.allocations.filter(a => a.payment_txn_id === by(13).id)
    assert.equal(alloc.length, 1)
    assert.equal(alloc[0].charge_txn_id, by(11).id)
  })

  test('aperçu des écritures : un groupe par déclaration, aucune écriture posée', async () => {
    const prev = await apiFetch('/carm/postings/preview')
    assert.equal(prev.status, 200)
    const list = await apiFetch('/carm/transactions')
    const paiement = list.body.transactions.find(t => t.transaction_number === `${MARKER}-13`)
    const groupe = prev.body.groups.find(g => g.line_ids.includes(paiement.id))
    assert.ok(groupe, 'le versement doit apparaître dans la proposition')
    assert.equal(groupe.entity, 'purchase')
    assert.equal(groupe.total, 9876011)
    assert.deepEqual(groupe.blockers, [])
    // Rien n'a été écrit : la ligne est toujours « à comptabiliser ».
    const after2 = await apiFetch('/carm/transactions')
    assert.equal(after2.body.transactions.find(t => t.id === paiement.id).posting_state, 'a_comptabiliser')
    assert.equal(after2.body.transactions.find(t => t.id === paiement.id).qb_txn_id, null)
  })

  test('une ventilation saisie à la main n\'est pas réécrite par le moteur', async () => {
    const list = await apiFetch('/carm/transactions')
    const t = list.body.transactions.find(x => x.transaction_number === `${MARKER}-10`)
    const up = await apiFetch(`/carm/transactions/${t.id}`, {
      method: 'PATCH', body: JSON.stringify({ duty_amount: 10, gst_amount: 9876000 }),
    })
    assert.equal(up.status, 200)
    assert.equal(up.body.split_source, 'manuel')
    const after2 = await apiFetch('/carm/transactions')
    const t2 = after2.body.transactions.find(x => x.id === t.id)
    assert.equal(t2.duty_amount, 10, 'la saisie manuelle survit au recalcul')
    assert.equal(t2.gst_amount, 9876000)
  })

  test('la modale de comptabilisation s\'ouvre et liste les écritures', async () => {
    await page.goto(URL + '/comptes-prepayes?onglet=douanes', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="douanes-post-open"]', { timeout: 15000 })
    await page.click('[data-testid="douanes-post-open"]')
    await page.waitForSelector('[data-testid="douanes-post-submit"]', { timeout: 15000 })
    await page.waitForSelector('[data-testid="douanes-posting-group"]', { timeout: 15000 })
    // On ne confirme JAMAIS en e2e : le bouton écrirait dans la vraie QuickBooks.
    await page.keyboard.press('Escape')
  })

  test('suppression douce via API', async () => {
    const list = await apiFetch('/carm/transactions')
    const mine = list.body.transactions.filter(t => String(t.transaction_number || '').startsWith(MARKER))
    for (const t of mine) {
      const del = await apiFetch(`/carm/transactions/${t.id}`, { method: 'DELETE' })
      assert.equal(del.status, 200)
    }
    const check = await apiFetch('/carm/transactions')
    assert.equal(check.body.transactions.filter(t => String(t.transaction_number || '').startsWith(MARKER)).length, 0)
  })
})
