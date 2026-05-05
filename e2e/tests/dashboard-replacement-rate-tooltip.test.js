const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Régression : le tooltip du graphique « Taux de remplacement » affichait le mois
// précédent à cause d'un parsing UTC de "YYYY-MM-01" suivi d'un toLocaleDateString
// en heure locale (Montréal = UTC-4/-5 → minuit UTC retombe la veille).
describe('Dashboard — tooltip "Taux de remplacement" (mois affiché)', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      timezoneId: 'America/Montreal',
    })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('hover sur chaque point → libellé long du même mois', async () => {
    await page.goto(`${URL}/`, { waitUntil: 'networkidle' })

    // Construit la grille des 12 derniers mois côté test (mêmes clés que le composant).
    const months = []
    const now = new Date()
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      const expected = d.toLocaleDateString('fr-CA', { month: 'long', year: 'numeric' })
      months.push({ key, expected })
    }

    // Scroll la section dans la vue
    const firstGroup = page.locator(`[data-testid="replacement-month-${months[0].key}"]`)
    await firstGroup.waitFor({ state: 'attached', timeout: 10000 })
    await firstGroup.scrollIntoViewIfNeeded()

    for (const { key, expected } of months) {
      const group = page.locator(`[data-testid="replacement-month-${key}"]`)
      // Hover sur le rect transparent qui couvre toute la colonne (cible large).
      await group.locator('rect').hover()

      // Le tooltip n'a pas de testid mais c'est l'unique <text> contenant un nom de mois en toutes lettres.
      // On lit le contenu textuel du <text> qui suit le rect du tooltip.
      const tooltipMonth = await page.locator(`text="${expected}"`).first().textContent({ timeout: 2000 })
      assert.equal(
        tooltipMonth.trim().toLowerCase(),
        expected.toLowerCase(),
        `pour la clé ${key}, le tooltip doit afficher "${expected}"`
      )
    }
  })
})
