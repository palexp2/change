const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie la nouvelle UX de la page Extraction de données :
//   1) /sale-receipts affiche une liste DataTable avec UploadZone + bouton caméra
//      dans le haut (pas la sidebar+detail split).
//   2) Un clic sur une ligne ouvre /sale-receipts/:id (URL unique).
//   3) La fiche détail expose des chevrons prev/next qui naviguent vers les
//      reçus voisins dans l'ordre de la liste.

describe('Extraction de données : liste + détail avec nav prev/next', () => {
  let browser, ctx, page
  let token, ids

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    token = await page.evaluate(() => localStorage.getItem('erp_token'))
    const resp = await page.request.get(URL + '/api/sale-receipts?limit=all', {
      headers: { Authorization: 'Bearer ' + token },
    })
    const body = await resp.json()
    ids = (body.data || []).map(r => String(r.id))
    assert.ok(ids.length >= 2, 'Préalable : au moins 2 reçus en DB pour tester prev/next')
  })

  after(async () => { await browser?.close() })

  test('la page liste affiche un DataTable avec upload zone et bouton caméra', async () => {
    await page.goto(URL + '/sale-receipts', { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Extraction de données")', { timeout: 10000 })

    await page.getByTestId('upload-zone').waitFor({ state: 'visible', timeout: 5000 })
    await page.getByTestId('open-webcam').waitFor({ state: 'visible', timeout: 5000 })

    // DataTable rend un <table> ; au moins 2 lignes visibles
    const rows = page.locator('.cursor-pointer.border-slate-100')
    await rows.first().waitFor({ state: 'visible', timeout: 10000 })
    assert.ok(await rows.count() >= 2, 'Au moins 2 lignes de reçus dans la table')
  })

  test('cliquer une ligne navigue vers /sale-receipts/:id', async () => {
    await page.goto(URL + '/sale-receipts', { waitUntil: 'networkidle' })
    await page.locator('.cursor-pointer.border-slate-100').first().waitFor({ state: 'visible', timeout: 10000 })
    const firstRow = page.locator('.cursor-pointer.border-slate-100').first()
    await firstRow.click({ position: { x: 20, y: 10 } })
    await page.waitForFunction(() => /\/sale-receipts\/[^/]+$/.test(location.pathname), null, { timeout: 10000 })
    assert.match(page.url(), /\/sale-receipts\/[^/]+$/, `URL doit ressembler à /sale-receipts/:id, vu : ${page.url()}`)
  })

  test('chevrons prev/next naviguent entre reçus voisins', async () => {
    // Clear de l'ordre mémorisé pour tester le fallback "liste complète" et
    // garantir que les ids voisins sont ceux du backend.
    await page.evaluate(() => sessionStorage.removeItem('sale_receipts:nav_ids'))
    // On part du 2e reçu pour avoir un prev ET un next disponibles
    const middleId = ids[1]
    await page.goto(URL + '/sale-receipts/' + middleId, { waitUntil: 'networkidle' })

    const prevBtn = page.getByTestId('receipt-prev')
    const nextBtn = page.getByTestId('receipt-next')
    await prevBtn.waitFor({ state: 'visible', timeout: 10000 })
    await nextBtn.waitFor({ state: 'visible', timeout: 5000 })

    // Précédent → ids[0]
    await prevBtn.click()
    await page.waitForURL(URL + '/sale-receipts/' + ids[0], { timeout: 5000 })

    // Suivant → ids[1] (retour au milieu)
    await page.getByTestId('receipt-next').click()
    await page.waitForURL(URL + '/sale-receipts/' + ids[1], { timeout: 5000 })
  })

  test('la navigation chevrons est limitée à la vue mémorisée', async () => {
    // On simule une vue restreinte à 2 reçus (par ex. après filtrage) en
    // écrivant directement dans sessionStorage la sous-liste correspondante.
    const subset = [ids[0], ids[1]]
    await page.goto(URL + '/sale-receipts/' + subset[0], { waitUntil: 'networkidle' })
    await page.evaluate(arr => sessionStorage.setItem('sale_receipts:nav_ids', JSON.stringify(arr)), subset)
    // Reload pour que la fiche relise sessionStorage
    await page.reload({ waitUntil: 'networkidle' })

    // Au début de la sous-liste : prev désactivé, next actif
    await page.getByTestId('receipt-prev').waitFor({ state: 'visible', timeout: 10000 })
    assert.equal(await page.getByTestId('receipt-prev').isDisabled(), true, 'prev doit être désactivé en début de vue')
    await page.getByTestId('receipt-next').click()
    await page.waitForURL(URL + '/sale-receipts/' + subset[1], { timeout: 5000 })

    // À la fin de la sous-liste : next désactivé (même si la DB contient d'autres reçus après)
    assert.equal(await page.getByTestId('receipt-next').isDisabled(), true, 'next doit être désactivé en fin de vue, même si d\'autres reçus existent en DB')
  })
})
