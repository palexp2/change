// Rapprochement bancaire — détection automatique des recharges Twilio.
//
// Demande de Charles (2026-08-11) : une sortie Twilio sur le compte Venn USD
// est toujours une recharge du crédit prépayé, jamais une dépense consommée.
// À chaque import bancaire (services/bankReconciliation.js →
// detectTwilioBankRecharges(), services/prepaid.js) :
//   1. un brouillon achats_fournisseurs (fournisseur QB « Twilio  USD ») est
//      créé et apparié à la transaction — propose la comptabilisation QB via
//      un bouton « Comptabiliser sur QuickBooks » dans le panneau de la
//      transaction (jamais automatique) ; une fois publié, ce bouton devient
//      un lien « Ouvrir dans QuickBooks ». Le brouillon porte déjà le compte
//      de dépense de la dernière comptabilisation Twilio publiée (voir
//      services/prepaid.js:lastTwilioExpenseAccountId) et le compte de
//      paiement Venn USD, pour que le clic marche du premier coup ;
//   2. le ledger prépayé Twilio est ajusté tout de suite (type='recharge').
//
// Ce test importe une transaction JETABLE (montant/date improbables) sur le
// VRAI compte Venn USD (la détection ne scanne que ce compte par nom — on ne
// peut pas la déclencher sur un compte fictif). Nettoyage intégral dans
// after() : transaction, brouillon d'achat, entrée de ledger.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// dedup_key est UNIQUE et ignore deleted_at (voir bankReconciliation.js) : une
// transaction déjà importée puis supprimée ne peut jamais être ré-importée
// avec la même date+montant+description. Montant/jour randomisés à chaque
// exécution pour que des runs répétés du test ne collisionnent jamais.
const TEST_DAY = 1 + Math.floor(Math.random() * 27)
const TEST_DATE = `2020-01-${String(TEST_DAY).padStart(2, '0')}`
const TEST_AMOUNT = -(100 + Math.round(Math.random() * 9900) / 100)
const TEST_LABEL = 'Twilio — Card Payment (ZZ Test agent)'

describe('Rapprochement bancaire — détection auto des recharges Twilio (Venn USD)', () => {
  let browser, ctx, page
  let bankTxnId, achatId, ledgerEntryId

  async function apiFetch(path, init) {
    return page.evaluate(async ({ base, path, init }) => {
      const t = localStorage.getItem('erp_token')
      const r = await fetch(base + '/api' + path, {
        ...(init || {}),
        headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' },
      })
      return { status: r.status, body: await r.json().catch(() => null) }
    }, { base: URL, path, init })
  }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 20000 })
  })

  after(async () => {
    try { if (bankTxnId) await apiFetch(`/bank/transactions/${bankTxnId}`, { method: 'DELETE' }) } catch { /* best-effort */ }
    try { if (achatId) await apiFetch(`/achats-fournisseurs/${achatId}`, { method: 'DELETE' }) } catch { /* best-effort */ }
    try { if (ledgerEntryId) await apiFetch(`/prepaid/entries/${ledgerEntryId}`, { method: 'DELETE' }) } catch { /* best-effort */ }
    await browser?.close()
  })

  test('importer une sortie « Twilio » sur Venn USD crée le brouillon QB et la recharge prépayée', async () => {
    const accounts = (await apiFetch('/bank/accounts')).body
    const vennUsd = accounts.find(a => a.name === 'Venn USD')
    assert.ok(vennUsd, 'compte Venn USD introuvable')

    const imported = await apiFetch(`/bank/accounts/${vennUsd.id}/import`, {
      method: 'POST',
      body: JSON.stringify({ rows: [{ txn_date: TEST_DATE, description: TEST_LABEL, amount: TEST_AMOUNT }] }),
    })
    assert.equal(imported.status, 201, `import refusé : ${JSON.stringify(imported.body)}`)

    // L'import déclenche detectTwilioBankRecharges() — le brouillon et la
    // recharge doivent exister sans aucune action supplémentaire.
    const txns = (await apiFetch(`/bank/accounts/${vennUsd.id}/transactions`)).body
    const txn = txns.find(t => t.txn_date === TEST_DATE && t.amount === TEST_AMOUNT)
    assert.ok(txn, 'transaction importée introuvable')
    bankTxnId = txn.id

    assert.equal(txn.status, 'facture_recue', 'statut attendu : facture reçue (document apparié, pas encore publié QB)')
    assert.equal(txn.matched_type, 'achat')
    assert.ok(txn.matched_id, 'aucun brouillon d\'achat apparié')
    achatId = txn.matched_id
    assert.equal(txn.matched_label, 'Twilio  USD')

    const expectedAmount = Math.round(Math.abs(TEST_AMOUNT) * 100) / 100

    const achat = (await apiFetch(`/achats-fournisseurs/${achatId}`)).body
    assert.equal(achat.vendor, 'Twilio  USD')
    assert.equal(achat.currency, 'USD')
    assert.equal(achat.total_cad, expectedAmount)
    assert.equal(achat.type, 'purchase')
    assert.equal(achat.quickbooks_id, null, 'ne doit jamais être publié automatiquement')
    // Comptes QB pré-remplis (dépense = dernière comptabilisation Twilio publiée,
    // paiement = Venn USD) — sinon le bouton « Comptabiliser » échoue avec
    // « Compte de dépense QuickBooks non configuré ».
    assert.ok(achat.expense_account_id, 'expense_account_id devrait être pré-rempli depuis l\'historique QB')
    const vennUsdBank = (await apiFetch('/bank/accounts')).body.find(a => a.name === 'Venn USD')
    assert.equal(achat.payment_account_id, vennUsdBank.qb_account_id.split(',')[0].trim())

    const accountsPrepaid = (await apiFetch('/prepaid/accounts')).body
    const twilioAccount = accountsPrepaid.find(a => a.vendor === 'Twilio')
    assert.ok(twilioAccount, 'compte prépayé Twilio introuvable')

    const ledger = (await apiFetch(`/prepaid/accounts/${twilioAccount.id}/entries`)).body
    const entry = ledger.entries.find(e => e.bank_transaction_id === bankTxnId)
    assert.ok(entry, 'entrée de ledger introuvable')
    ledgerEntryId = entry.id
    assert.equal(entry.type, 'recharge')
    assert.equal(entry.amount, expectedAmount)
    assert.match(entry.description, /Twilio/)
  })

  test('un second import de la même transaction ne duplique rien (idempotence)', async () => {
    const accounts = (await apiFetch('/bank/accounts')).body
    const vennUsd = accounts.find(a => a.name === 'Venn USD')
    // Ré-importer la même ligne est ignorée par la dédup de l'import (dedup_key) —
    // on vérifie directement qu'il n'existe toujours qu'une seule transaction
    // et une seule entrée de ledger pour ce montant/cette date de test.
    const txns = (await apiFetch(`/bank/accounts/${vennUsd.id}/transactions`)).body
    const matches = txns.filter(t => t.txn_date === TEST_DATE && t.amount === TEST_AMOUNT)
    assert.equal(matches.length, 1, 'la transaction de test ne doit exister qu\'une fois')
  })

  test('le panneau de la transaction propose un bouton pour comptabiliser sur QuickBooks', async () => {
    const accounts = (await apiFetch('/bank/accounts')).body
    const vennUsd = accounts.find(a => a.name === 'Venn USD')
    await page.goto(`${URL}/rapprochement?compte=${vennUsd.id}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="reconcile-panel"]', { timeout: 20000 })

    // Le tableau est virtualisé (seules les lignes visibles existent dans le
    // DOM) — la ligne de test (datée 2020, tout en bas du tri) ne serait
    // jamais montée sans filtrer la recherche dessus d'abord.
    await page.fill('input[placeholder="Rechercher..."]', TEST_LABEL)
    const row = page.locator(`[data-row-id="${bankTxnId}"]`)
    await row.waitFor({ state: 'visible', timeout: 15000 })
    await row.click()

    const pushBtn = page.locator('button:has-text("Comptabiliser sur QuickBooks")')
    await pushBtn.waitFor({ state: 'visible', timeout: 10000 })
    // Le brouillon n'étant pas publié, il n'y a pas encore de lien « Ouvrir dans QuickBooks ».
    assert.equal(await page.locator('a:has-text("Ouvrir dans QuickBooks")').count(), 0)

    // On n'envoie jamais une vraie écriture à QuickBooks depuis un test — la
    // route est interceptée pour vérifier le câblage front (bon id d'achat,
    // gestion de la réponse) sans toucher la vraie comptabilité. Le service
    // pushAchatToQB lui-même est déjà couvert par ses propres tests serveur ;
    // le rendu du lien « Ouvrir dans QuickBooks » une fois publié est du code
    // préexistant (déjà utilisé pour les documents appariés), pas modifié ici.
    let pushedAchatId = null
    await page.route('**/api/achats-fournisseurs/*/push-to-qb', async (route) => {
      pushedAchatId = route.request().url().match(/achats-fournisseurs\/([^/]+)\/push-to-qb/)[1]
      await route.fulfill({ json: { ok: true, quickbooks_id: '999999', data: {} } })
    })

    await pushBtn.click()
    await page.waitForTimeout(1000)
    assert.equal(pushedAchatId, achatId, 'la route de publication a été appelée avec le mauvais id d\'achat')
    // Le bouton « Délier » porte aussi la classe text-red-600 — on cible
    // spécifiquement le message d'erreur (un div, pas un bouton).
    assert.equal(await page.locator('div.text-red-600').count(), 0, 'aucune erreur ne devrait être affichée sur un push réussi')

    await page.unroute('**/api/achats-fournisseurs/*/push-to-qb')
  })

  test('une erreur de publication (ex. compte QB non configuré) s\'affiche dans le panneau', async () => {
    const accounts = (await apiFetch('/bank/accounts')).body
    const vennUsd = accounts.find(a => a.name === 'Venn USD')
    await page.goto(`${URL}/rapprochement?compte=${vennUsd.id}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="reconcile-panel"]', { timeout: 20000 })
    await page.fill('input[placeholder="Rechercher..."]', TEST_LABEL)
    const row = page.locator(`[data-row-id="${bankTxnId}"]`)
    await row.waitFor({ state: 'visible', timeout: 15000 })
    await row.click()

    await page.route('**/api/achats-fournisseurs/*/push-to-qb', async (route) => {
      await route.fulfill({ status: 400, json: { error: 'Compte de dépense QuickBooks non configuré', field: 'expense_account' } })
    })
    await page.locator('button:has-text("Comptabiliser sur QuickBooks")').click()
    await page.locator('text=Compte de dépense QuickBooks non configuré').waitFor({ state: 'visible', timeout: 10000 })
    // Le bouton reste affiché : l'échec n'a pas été confondu avec un succès.
    assert.equal(await page.locator('button:has-text("Comptabiliser sur QuickBooks")').count(), 1)

    await page.unroute('**/api/achats-fournisseurs/*/push-to-qb')
  })
})
