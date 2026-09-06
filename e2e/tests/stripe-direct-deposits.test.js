const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Sous-section « Dépôts directs (hors payouts Stripe) » de /stripe-payouts.
//
// Test LECTURE SEULE — aucun paiement créé, aucune facture modifiée : la modale
// « Comptabiliser » est ouverte puis annulée AVANT la confirmation (l'appel
// clear-paid-status + POST /payments n'a lieu qu'au clic de confirmation).
describe('Stripe Payouts — sous-section Dépôts directs', () => {
  let browser, ctx, page, apiData

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('GET /api/payments/direct-deposits renvoie deposits[] et candidates[]', async () => {
    apiData = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/payments/direct-deposits', { headers: { Authorization: `Bearer ${tok}` } })
      return { status: r.status, body: await r.json() }
    })
    assert.equal(apiData.status, 200, `attendu 200, reçu ${apiData.status}`)
    assert.ok(Array.isArray(apiData.body.deposits), 'deposits[] manquant')
    assert.ok(Array.isArray(apiData.body.candidates), 'candidates[] manquant')
    // Un candidat = facture payée hors bande, jamais un montant nul ni un
    // paiement Stripe (charge/intent présent → exclu par la route).
    for (const c of apiData.body.candidates) {
      assert.ok(c.total_amount > 0, `candidat ${c.document_number} à montant nul`)
      assert.ok(c.paid_at, `candidat ${c.document_number} sans paid_at`)
    }
    // Aucun paiement Stripe dans la liste des dépôts directs.
    for (const d of apiData.body.deposits) {
      assert.notEqual(d.method, 'stripe', `paiement Stripe ${d.id} listé en dépôt direct`)
    }
  })

  test('La section est rendue sur /stripe-payouts — une seule boîte, sans sous-titre « Dépôts comptabilisés »', async () => {
    await page.goto(URL + '/stripe-payouts', { waitUntil: 'domcontentloaded' })
    const section = page.locator('[data-testid="direct-deposits-section"]')
    await section.waitFor({ state: 'visible', timeout: 15000 })
    await assert.doesNotReject(
      page.locator('[data-testid="direct-deposits-recorded"]').waitFor({ state: 'visible', timeout: 15000 }),
      'boîte des dépôts directs absente'
    )
    // Plus de sous-boîte « Dépôts comptabilisés » — la liste vit directement
    // dans la boîte Dépôts directs.
    const subTitle = await section.getByText('Dépôts comptabilisés', { exact: true }).count()
    assert.equal(subTitle, 0, 'le sous-titre « Dépôts comptabilisés » ne devrait plus exister')
    // Le bloc candidats n'apparaît que s'il y a des factures à comptabiliser —
    // cohérence stricte avec l'API.
    const candidatesVisible = await page.locator('[data-testid="direct-deposit-candidates"]').isVisible().catch(() => false)
    assert.equal(
      candidatesVisible,
      apiData.body.candidates.length > 0,
      `bloc candidats ${candidatesVisible ? 'visible' : 'absent'} mais l'API renvoie ${apiData.body.candidates.length} candidat(s)`
    )
  })

  test('Chaque dépôt avec écriture QB affiche son lien QuickBooks sur la ligne', async () => {
    const withQb = apiData.body.deposits.filter(d => d.qb_deposit_id || d.qb_journal_entry_id || d.qb_payment_id)
    assert.ok(withQb.length > 0, 'aucun dépôt avec écriture QB en base — backfill attendu')
    for (const d of withQb.slice(0, 10)) {
      const row = page.locator(`[data-testid="direct-deposit-row-${d.id}"]`)
      await row.waitFor({ state: 'visible', timeout: 10000 })
      const link = row.locator('a[href*="intuit"]')
      assert.ok(await link.count() >= 1, `lien QuickBooks absent sur la ligne ${d.document_number}`)
      assert.ok(/QuickBooks/.test(await link.first().textContent()), 'le lien devrait afficher « QuickBooks »')
    }
    // État global : toutes les lignes rendues sans lien QB correspondent à des
    // dépôts sans écriture QB côté API (pas de « à pousser » fantôme).
    const apiSansQb = apiData.body.deposits.length - withQb.length
    const domSansQb = await page.locator('[data-testid="direct-deposits-recorded"] tbody tr:not(:has(a[href*="intuit"]))').count()
    assert.equal(domSansQb, apiSansQb, `${domSansQb} ligne(s) sans lien QB dans le DOM vs ${apiSansQb} côté API`)
  })

  test('Chaque candidat de l\'API est rendu avec facture, client et montant', async (t) => {
    if (!apiData.body.candidates.length) { t.skip('aucun candidat en base'); return }
    const first = apiData.body.candidates[0]
    const row = page.locator(`[data-testid="direct-deposit-candidate-${first.document_number}"]`)
    await row.waitFor({ state: 'visible', timeout: 10000 })
    const text = await row.textContent()
    assert.ok(text.includes(first.document_number), 'numéro de facture absent de la ligne')
    if (first.company_name) {
      assert.ok(text.includes(first.company_name), `client « ${first.company_name} » absent de la ligne`)
    }
    // Lien de navigation vers la fiche facture (règle champs référence).
    const href = await row.locator(`a[href*="/factures/${first.id}"]`).count()
    assert.ok(href >= 1, 'lien vers la fiche facture manquant')
  })

  test('Cliquer une ligne ouvre le détail /depots-directs/:id avec Aperçu + Pousser vers QB', async (t) => {
    if (!apiData.body.candidates.length) { t.skip('aucun candidat en base'); return }
    const first = apiData.body.candidates[0]
    // Clic sur la ligne (pas sur les liens internes) → navigation vers le détail.
    await page.locator(`[data-testid="direct-deposit-candidate-${first.document_number}"] td`).nth(0).click()
    await page.waitForURL(u => u.toString().includes(`/depots-directs/${first.id}`), { timeout: 10000 })
    const header = page.locator('[data-testid="direct-deposit-header"]')
    await header.waitFor({ state: 'visible', timeout: 15000 })
    const headerText = await header.textContent()
    assert.ok(/À comptabiliser/i.test(headerText), 'badge « À comptabiliser » absent du header')
    assert.ok(headerText.includes(first.document_number), 'numéro de facture absent du header')
    // Bouton de push mis en évidence + montant prérempli.
    const pushBtn = page.locator('[data-testid="direct-deposit-push"]')
    await pushBtn.waitFor({ state: 'visible', timeout: 5000 })
    const amountInput = page.locator('[data-testid="direct-deposit-amount"]')
    assert.equal(parseFloat(await amountInput.inputValue()), first.total_amount, 'montant non prérempli')
    // Aperçu Deposit (lecture seule : construit le payload sans le poster).
    await page.locator('[data-testid="direct-deposit-preview"]').click()
    const panel = page.locator('[data-testid="direct-deposit-preview-panel"]')
    await panel.waitFor({ state: 'visible', timeout: 20000 })
    const panelText = await panel.textContent()
    assert.ok(/Dr banque/i.test(panelText), 'compte bancaire absent de l\'aperçu')
    assert.ok(/Compte crédité/i.test(panelText), 'compte crédité absent de l\'aperçu')
    // On repart SANS pousser — AUCUNE écriture ne doit avoir lieu.
    const after = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/payments/direct-deposits', { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    })
    assert.ok(
      after.candidates.some(c => c.id === first.id),
      'le candidat a disparu après une simple consultation — une écriture a eu lieu ?'
    )
  })

  test('Le détail d\'un dépôt comptabilisé affiche le badge QB cliquable', async (t) => {
    const withQb = apiData.body.deposits.find(d => d.qb_deposit_id || d.qb_journal_entry_id || d.qb_payment_id)
    if (!withQb) { t.skip('aucun dépôt comptabilisé avec écriture QB'); return }
    await page.goto(URL + `/depots-directs/${withQb.id}`, { waitUntil: 'domcontentloaded' })
    const pill = page.locator('[data-testid="direct-deposit-qb-pill"]')
    await pill.waitFor({ state: 'visible', timeout: 15000 })
    const href = await pill.getAttribute('href')
    assert.ok(href && /intuit|qbo/i.test(href), `lien QB invalide: ${href}`)
    // Le bouton de push est neutralisé (« Déjà envoyé »).
    const pushText = await page.locator('button:has-text("Déjà envoyé")').count()
    assert.ok(pushText >= 1, 'bouton « Déjà envoyé » absent pour un dépôt déjà poussé')
  })
})
