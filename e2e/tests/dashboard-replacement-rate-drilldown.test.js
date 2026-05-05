const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Drill-down : cliquer sur un mois du graphique « Taux de remplacement »
// → tableau du bas filtré sur ce mois, avec un bouton « Effacer le filtre ».
describe('Dashboard — drill-down "Taux de remplacement"', () => {
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

  test('clic sur un mois → tableau filtré sur ce mois ; "Effacer" rétablit', async () => {
    await page.goto(`${URL}/`, { waitUntil: 'networkidle' })

    // Construit la liste des 12 mois (mêmes clés que le composant).
    const months = []
    const now = new Date()
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
      months.push(key)
    }

    // S'assurer que le graphique est rendu et scrollé en vue.
    const firstGroup = page.locator(`[data-testid="replacement-month-${months[0]}"]`)
    await firstGroup.waitFor({ state: 'attached', timeout: 10000 })
    await firstGroup.scrollIntoViewIfNeeded()

    // Ouvrir la liste complète des items pour récupérer un mois cible
    // (un mois qui contient effectivement au moins une ligne).
    const toggle = page.locator('button', { hasText: /\d+ lignes? de remplacement/ })
    if (await toggle.count() === 0) {
      // Pas d'items dans la fenêtre 12 mois — on peut quand même valider
      // qu'un clic sur un mois sans items rend un tableau vide avec message.
      const target = months[months.length - 1]
      await page.locator(`[data-testid="replacement-month-${target}"] rect`).click()
      await page.locator('[data-testid="replacement-filter-clear"]').waitFor({ timeout: 3000 })
      const emptyText = await page.locator('[data-testid="replacement-items-table"]').textContent()
      assert.ok(emptyText.includes('Aucun remplacement'), 'tableau vide doit afficher un message')
      return
    }

    await toggle.click()
    const table = page.locator('[data-testid="replacement-items-table"]')
    await table.waitFor({ timeout: 3000 })

    // Lis les dates d'envoi de toutes les lignes pour choisir un mois cible.
    const dateCells = await table.locator('tbody tr td:last-child').allTextContents()
    // Format affiché : YYYY-MM-DD (toLocaleDateString fr-CA)
    const monthCounts = new Map()
    for (const t of dateCells) {
      const m = t.trim().match(/^(\d{4})-(\d{2})-\d{2}$/)
      if (!m) continue
      const key = `${m[1]}-${m[2]}`
      monthCounts.set(key, (monthCounts.get(key) || 0) + 1)
    }
    if (monthCounts.size === 0) {
      // Aucune date exploitable, on s'arrête ici (test n'a rien à valider de plus)
      return
    }
    // Choisir un mois qui n'a pas TOUTES les lignes (sinon le filtre est invisible).
    const totalRows = dateCells.length
    let targetMonth = null
    let targetCount = 0
    for (const [key, count] of monthCounts.entries()) {
      if (count < totalRows) {
        targetMonth = key
        targetCount = count
        break
      }
    }
    if (!targetMonth) {
      // Tout est dans un seul mois → on prend ce mois comme cible.
      targetMonth = monthCounts.keys().next().value
      targetCount = monthCounts.get(targetMonth)
    }

    // Clic sur le mois cible
    await page.locator(`[data-testid="replacement-month-${targetMonth}"] rect`).click()

    // Le bouton « Effacer le filtre » apparaît
    const clearBtn = page.locator('[data-testid="replacement-filter-clear"]')
    await clearBtn.waitFor({ timeout: 3000 })

    // Vérifie que le nombre de lignes correspond
    const filteredRows = await table.locator('tbody tr').count()
    // Compter uniquement les rangées de données (exclure ligne "Aucun remplacement")
    const filteredDates = await table.locator('tbody tr td:last-child').allTextContents()
    const realRows = filteredDates.filter(t => /^\d{4}-\d{2}-\d{2}$/.test(t.trim())).length
    assert.equal(realRows, targetCount, `attendu ${targetCount} lignes pour ${targetMonth}, reçu ${realRows} (count brut: ${filteredRows})`)

    // Toutes les dates restantes doivent appartenir au mois cible
    for (const t of filteredDates) {
      const trimmed = t.trim()
      if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) continue
      assert.ok(trimmed.startsWith(targetMonth + '-'), `date ${trimmed} hors du mois ${targetMonth}`)
    }

    // Effacer le filtre → on revient à toutes les lignes
    await clearBtn.click()
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="replacement-filter-clear"]'),
      { timeout: 3000 }
    )
    const restoredDates = await table.locator('tbody tr td:last-child').allTextContents()
    const restoredRealRows = restoredDates.filter(t => /^\d{4}-\d{2}-\d{2}$/.test(t.trim())).length
    assert.equal(restoredRealRows, totalRows, `après effacement, attendu ${totalRows} lignes, reçu ${restoredRealRows}`)
  })
})
