const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Ce test ne déconnecte JAMAIS un vrai compte OAuth (ce serait irréversible et
// casserait une intégration de prod). Il vérifie uniquement que la modale de
// confirmation s'affiche avec les side effects listés, puis ANNULE — et que
// AUCUN DELETE /connectors/accounts/:id n'est émis pendant ce flux.
describe('Connecteurs — confirmation avant déconnexion OAuth', () => {
  let browser, ctx, page
  let disconnectCalls = []

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    // Surveille tout appel de déconnexion réel — il ne doit jamais partir.
    page.on('request', (req) => {
      if (req.method() === 'DELETE' && /\/connectors\/accounts\/\d+/.test(req.url())) {
        disconnectCalls.push(req.url())
      }
    })
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('Gmail : la poubelle ouvre une modale de confirmation, Annuler ne déconnecte pas', async () => {
    disconnectCalls = []
    await page.goto(`${URL}/connectors`, { waitUntil: 'networkidle' })

    await page.locator('button:has-text("Gmail")').first().click()
    await page.locator('button:has-text("Connecter un autre compte")').waitFor({ state: 'visible', timeout: 5000 })

    // La poubelle (title="Déconnecter") n'existe que s'il y a un compte connecté.
    const trash = page.locator('button[title="Déconnecter"]')
    if (await trash.count() === 0) {
      // Pas de compte Gmail sur ce tenant — rien à confirmer, test non applicable.
      return
    }

    await trash.first().click()

    // La modale de confirmation doit apparaître avec le titre et les side effects.
    const dialog = page.getByRole('dialog')
    await dialog.waitFor({ state: 'visible', timeout: 5000 })
    await assert.doesNotReject(dialog.getByRole('heading', { name: 'Déconnecter le compte Google' }).waitFor({ timeout: 3000 }))
    const body = await dialog.innerText()
    assert.match(body, /tokens OAuth chiffrés/i, 'side effect "tokens OAuth" absent de la modale')
    assert.match(body, /synchronisation Gmail\/Drive/i, 'side effect "sync Gmail/Drive" absent de la modale')

    // Annuler — aucune déconnexion ne doit se produire.
    await dialog.locator('button:has-text("Annuler")').click()
    await dialog.waitFor({ state: 'hidden', timeout: 3000 })
    assert.equal(disconnectCalls.length, 0, `déconnexion réelle déclenchée: ${disconnectCalls.join(', ')}`)

    // Le compte est toujours là.
    assert.ok(await page.locator('button[title="Déconnecter"]').count() > 0, 'le compte Gmail a disparu après Annuler')
  })

  test('QuickBooks : la poubelle ouvre une modale de confirmation, Annuler ne déconnecte pas', async () => {
    disconnectCalls = []
    await page.goto(`${URL}/connectors`, { waitUntil: 'networkidle' })

    await page.locator('button:has-text("QuickBooks")').first().click()

    // Reconnecter n'apparaît que si QB est connecté → sinon pas de poubelle à tester.
    const reconnect = page.locator('button:has-text("Reconnecter")')
    if (await reconnect.count() === 0) {
      return
    }
    await reconnect.first().waitFor({ state: 'visible', timeout: 5000 })

    const trash = page.locator('button[title="Déconnecter"]')
    assert.ok(await trash.count() > 0, 'poubelle de déconnexion QB absente alors que QB est connecté')

    await trash.first().click()

    const dialog = page.getByRole('dialog')
    await dialog.waitFor({ state: 'visible', timeout: 5000 })
    await assert.doesNotReject(dialog.getByRole('heading', { name: 'Déconnecter QuickBooks' }).waitFor({ timeout: 3000 }))
    const body = await dialog.innerText()
    assert.match(body, /tokens OAuth chiffrés/i, 'side effect "tokens OAuth" absent de la modale')
    assert.match(body, /reçus\/dépôts\/dépenses|publication/i, 'side effect publication QB absent de la modale')

    await dialog.locator('button:has-text("Annuler")').click()
    await dialog.waitFor({ state: 'hidden', timeout: 3000 })
    assert.equal(disconnectCalls.length, 0, `déconnexion réelle déclenchée: ${disconnectCalls.join(', ')}`)

    assert.ok(await page.locator('button:has-text("Reconnecter")').count() > 0, 'le compte QuickBooks a disparu après Annuler')
  })
})
