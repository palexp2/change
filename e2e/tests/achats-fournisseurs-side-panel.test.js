const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// La fiche d'un achat fournisseur (facture/dépense) s'ouvre désormais dans un
// panneau latéral (RecordPeekDrawer) plutôt qu'une modale centrée. Lecture
// seule — ouverture/fermeture d'un achat existant, aucune donnée modifiée.
describe('AchatsFournisseurs — panneau latéral au lieu de la modale', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => { await browser?.close() })

  test('cliquer sur une ligne ouvre un panneau latéral (pas une modale centrée)', async () => {
    await page.goto(`${URL}/achats-fournisseurs`, { waitUntil: 'domcontentloaded' })
    const row = page.locator('[data-row-id]').first()
    await row.waitFor({ state: 'visible', timeout: 15000 })
    await row.click()

    const drawer = page.locator('[data-testid="record-peek-drawer"]')
    await drawer.waitFor({ state: 'visible', timeout: 10000 })

    // Le panneau est ancré au bord droit de l'écran (pas centré).
    const panel = drawer.locator('> div').nth(1)
    const box = await panel.boundingBox()
    assert.ok(box, 'boîte du panneau introuvable')
    const viewport = page.viewportSize()
    assert.ok(box.x + box.width >= viewport.width - 5, `le panneau ne colle pas au bord droit de l'écran (x=${box.x}, w=${box.width})`)
    assert.ok(box.x > 100, 'le panneau occupe toute la largeur — ce n\'est pas un panneau latéral')

    // Le titre de la fiche (facture/dépense) est bien affiché dans l'en-tête du panneau.
    const title = await page.locator('[data-testid="record-peek-title"]').innerText()
    assert.ok(/facture|dépense/i.test(title), `titre inattendu : ${title}`)

    // Aucune modale centrée classique ne doit être rendue en parallèle.
    assert.equal(await page.locator('.fixed.inset-0.z-50.flex.items-center.justify-center').count(), 0,
      'une modale centrée classique est encore rendue')

    await page.locator('[data-testid="record-peek-close"]').click()
    await drawer.waitFor({ state: 'hidden', timeout: 5000 })
  })
})
