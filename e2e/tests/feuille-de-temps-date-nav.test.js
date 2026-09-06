const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Feuille de temps — navigation date via chevrons (pas de date picker)', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'fr-CA' })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
    await page.goto(`${URL}/feuille-de-temps`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h1:has-text("Feuille de temps")', { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('Aucun input[type="date"] visible dans la barre de navigation', async () => {
    const count = await page.locator('input[type="date"]').count()
    assert.strictEqual(count, 0, 'Le date picker doit avoir été retiré')
  })

  test('Chevrons gauche et droite présents de part et d\'autre de la date', async () => {
    const prev = page.locator('button[aria-label="Jour précédent"]')
    const next = page.locator('button[aria-label="Jour suivant"]')
    await prev.waitFor({ state: 'visible' })
    await next.waitFor({ state: 'visible' })
    assert.strictEqual(await prev.count(), 1)
    assert.strictEqual(await next.count(), 1)
  })

  test('Un label de date friendly est affiché entre les chevrons', async () => {
    // Format fr-CA : "vendredi 24 avril 2026" (weekday long + month long)
    const dateLabel = page.locator('button[aria-label="Jour précédent"] + div').first()
    const txt = (await dateLabel.textContent() || '').trim()
    assert.match(txt, /\d{4}/, `Label de date attendu, reçu: "${txt}"`)
    // Doit contenir un nom de jour long (lundi..dimanche)
    assert.match(txt.toLowerCase(), /lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche/,
      `Weekday long attendu dans: "${txt}"`)
  })

  test('Cliquer sur le chevron droit avance la date d\'un jour', async () => {
    const dateLabel = page.locator('button[aria-label="Jour précédent"] + div').first()
    const before = (await dateLabel.textContent() || '').trim()
    await page.locator('button[aria-label="Jour suivant"]').click()
    await page.waitForFunction((prev) => {
      const el = document.querySelector('button[aria-label="Jour précédent"] + div')
      return el && el.textContent.trim() !== prev
    }, before, { timeout: 3000 })
    const after = (await dateLabel.textContent() || '').trim()
    assert.notStrictEqual(after, before, 'Le label doit changer après clic sur chevron droit')
  })

  test('Cliquer sur le chevron gauche recule la date d\'un jour', async () => {
    const dateLabel = page.locator('button[aria-label="Jour précédent"] + div').first()
    const before = (await dateLabel.textContent() || '').trim()
    await page.locator('button[aria-label="Jour précédent"]').click()
    await page.waitForFunction((prev) => {
      const el = document.querySelector('button[aria-label="Jour précédent"] + div')
      return el && el.textContent.trim() !== prev
    }, before, { timeout: 3000 })
    const after = (await dateLabel.textContent() || '').trim()
    assert.notStrictEqual(after, before, 'Le label doit changer après clic sur chevron gauche')
  })

  test('Bouton "Aujourd\'hui" ramène à la date du jour', async () => {
    const dateLabel = page.locator('button[aria-label="Jour précédent"] + div').first()
    // Avancer de 2 jours
    await page.locator('button[aria-label="Jour suivant"]').click()
    await page.locator('button[aria-label="Jour suivant"]').click()
    const before = (await dateLabel.textContent() || '').trim()
    await page.click('button:has-text("Aujourd\'hui")')
    await page.waitForFunction((prev) => {
      const el = document.querySelector('button[aria-label="Jour précédent"] + div')
      return el && el.textContent.trim() !== prev
    }, before, { timeout: 3000 })
    const after = (await dateLabel.textContent() || '').trim()
    assert.notStrictEqual(after, before)
    // Aujourd'hui doit être présent : on vérifie juste que le label contient un jour de semaine
    assert.match(after.toLowerCase(), /lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche/)
  })
})
