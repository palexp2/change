// /paiements-emis — bouton discret « Synchroniser la feuille ».
//
// Demande de Charles : pouvoir relire l'onglet Pmt_Suivi du fichier
// « CTB - Suivi » d'un clic pour que « À passer à la banque » reprenne ce qui a
// été ajouté dans le Google Sheet. L'action existait, mais enterrée dans le
// menu « ⋯ » sous le libellé technique « Importer Pmt_Suivi ».
//
// Le test vérifie que le bouton est VISIBLE sans ouvrir de menu, qu'il déclenche
// bien l'import de la feuille, qu'il recharge la liste, et qu'il dit ce qui s'est
// passé (y compris « rien de nouveau »).
//
// Aucun record n'est touché : le POST /treasury/payments/import-sheet est
// intercepté (page.route) et satisfait par une réponse factice — la vraie route
// irait lire Drive et écrirait dans treasury_payments.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Paiements émis — bouton « Synchroniser la feuille »', () => {
  let browser, ctx, page
  // Corps renvoyé à la place du vrai import, réglé par chaque test.
  let fakeResult = { created: 0, updated: 0, parsed: 0, sheet_rows: 0, since: '2026-01-01' }
  const importCalls = []
  const listCalls = []

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1600, height: 1200 } })
    page = await ctx.newPage()

    // L'import réel lit Google Drive et écrit des paiements : jamais en test.
    await page.route(/\/erp\/api\/treasury\/payments\/import-sheet$/, async route => {
      importCalls.push(JSON.parse(route.request().postData() || '{}'))
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fakeResult) })
    })
    page.on('request', r => {
      if (/\/erp\/api\/treasury\/payments\?/.test(r.url())) listCalls.push(r.url())
    })

    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    await page.goto(`${URL}/paiements-emis?onglet=pending`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="payments-tab-pending"]', { timeout: 20000 })
  })

  after(async () => {
    // Rien à nettoyer : aucun appel réel n'a été laissé passer.
    await browser?.close()
  })

  test('le bouton est visible dans la page, sans ouvrir le menu « ⋯ »', async () => {
    const btn = page.locator('[data-testid="payments-sync-sheet"]')
    await btn.waitFor({ state: 'visible', timeout: 10000 })
    assert.match(await btn.innerText(), /Synchroniser la feuille/i)

    // L'ancienne entrée technique du menu n'existe plus (une seule porte).
    await page.click('[data-testid="payments-more-menu"]')
    await page.waitForSelector('[data-testid="payments-more-menu-panel"]', { timeout: 5000 })
    assert.equal(await page.locator('[data-testid="payments-import-sheet"]').count(), 0,
      'l\'entrée « Importer Pmt_Suivi » du menu doit avoir disparu')
    // Refermer par le voile (pas de clic dans le panneau : on déclencherait
    // l'appariement au relevé bancaire).
    await page.mouse.click(5, 5)
    await page.waitForSelector('[data-testid="payments-more-menu-panel"]', { state: 'detached', timeout: 5000 })
  })

  test('un clic synchronise la feuille, recharge la liste et annonce le résultat', async () => {
    fakeResult = { created: 2, updated: 5, parsed: 7, sheet_rows: 120, since: '2026-01-01' }
    importCalls.length = 0
    listCalls.length = 0

    await page.click('[data-testid="payments-sync-sheet"]')

    await page.waitForFunction(() => document.body.innerText.includes('Feuille synchronisée'), null, { timeout: 20000 })
    const body = await page.locator('body').innerText()
    assert.ok(/2 paiement\(s\) ajouté\(s\), 5 mis à jour/.test(body), `toast attendu, vu : ${body.slice(0, 400)}`)

    assert.equal(importCalls.length, 1, 'un seul import déclenché')
    // Le plancher d'import n'est plus codé en dur dans la page : il vient de la
    // configuration de l'automation sys_pmt_suivi_sheet (since_date), que le
    // serveur applique quand la requête n'en impose pas.
    assert.equal(importCalls[0].since, undefined,
      'la page laisse le serveur choisir le plancher (configuration de l\'automation)')

    // La section « À passer à la banque » se remet à jour toute seule.
    await page.waitForFunction(() => true)
    assert.ok(listCalls.some(u => /status=pending/.test(u)),
      `la liste des paiements doit être rechargée, vu : ${JSON.stringify(listCalls)}`)
  })

  test('rien de nouveau dans la feuille = message explicite, pas de silence', async () => {
    fakeResult = { created: 0, updated: 0, parsed: 0, sheet_rows: 120, since: '2026-01-01' }
    importCalls.length = 0

    await page.click('[data-testid="payments-sync-sheet"]')
    await page.waitForFunction(() => document.body.innerText.includes('rien de nouveau'), null, { timeout: 20000 })
    assert.equal(importCalls.length, 1)
  })
})
