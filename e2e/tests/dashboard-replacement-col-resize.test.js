const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Largeur des colonnes du tableau détaillé « Taux de remplacement » :
// glisser le bord droit d'un en-tête redimensionne la colonne, le choix est
// mémorisé au rechargement, et « Réinitialiser les largeurs » rétablit.
// Aucune donnée métier n'est touchée : la préférence vit en localStorage,
// et le after() nettoie la clé écrite par le test.
describe('Dashboard — largeur des colonnes du détail des remplacements', () => {
  let browser, ctx, page

  const openTable = async () => {
    await page.goto(`${URL}/`, { waitUntil: 'networkidle' })
    const toggle = page.locator('button', { hasText: /\d+ lignes? de remplacement|\d+ lignes? pour / })
    await toggle.first().waitFor({ timeout: 20000 })
    await toggle.first().scrollIntoViewIfNeeded()
    if (await page.locator('[data-testid="replacement-items-table"]').count() === 0) {
      await toggle.first().click()
    }
    await page.locator('[data-testid="replacement-items-table"]').waitFor({ timeout: 5000 })
  }

  const headerWidth = key =>
    page.locator(`[data-testid="replacement-col-${key}"]`).evaluate(el => el.getBoundingClientRect().width)

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, timezoneId: 'America/Montreal' })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => {
    // Restaure la préférence de largeurs (clé écrite par le test).
    try {
      await page.evaluate(() => {
        for (const k of Object.keys(localStorage)) {
          if (k.startsWith('dashboard_replacement_cols_')) localStorage.removeItem(k)
        }
      })
    } catch {}
    await browser?.close()
  })

  test('glisser la poignée élargit la colonne, le choix survit au rechargement, le reset rétablit', async () => {
    await openTable()

    const before = await headerWidth('company')
    assert.ok(before > 0, 'colonne « Client » introuvable')

    // Poignée de resize : dernier enfant de l'en-tête, collée au bord droit.
    const th = page.locator('[data-testid="replacement-col-company"]')
    const box = await th.boundingBox()
    await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width - 3 + 120, box.y + box.height / 2, { steps: 10 })
    await page.mouse.up()

    const after = await headerWidth('company')
    assert.ok(after > before + 80, `attendu ~+120px (avant ${before}, après ${after})`)

    // Le lien de réinitialisation apparaît dès qu'une largeur est personnalisée.
    const reset = page.locator('[data-testid="replacement-cols-reset"]')
    await reset.waitFor({ timeout: 3000 })

    // Persistance : la préférence est relue au rechargement de la page.
    await openTable()
    const reloaded = await headerWidth('company')
    assert.ok(Math.abs(reloaded - after) < 5, `largeur non conservée (${after} → ${reloaded})`)

    // Réinitialisation → retour à la largeur d'origine, et le lien disparaît.
    await page.locator('[data-testid="replacement-cols-reset"]').click()
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="replacement-cols-reset"]'),
      { timeout: 3000 }
    )
    const restored = await headerWidth('company')
    assert.ok(Math.abs(restored - before) < 5, `largeur non rétablie (attendu ${before}, reçu ${restored})`)
  })
})
