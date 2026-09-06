const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie que la grille de dates de FactureDetail (anciennement `grid grid-cols-4` figée,
// illisible en tablette) reflue désormais selon la largeur :
//   mobile (<640px)  → 1 colonne  → N lignes
//   tablette (640-1023px) → 2 colonnes
//   desktop (≥1024px) → 4 colonnes → 1 ligne
// Test purement lecture/layout : aucun record créé ni config modifiée → pas de cleanup.
describe('Fiches détail — grilles responsive (FactureDetail dates)', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('la grille de dates passe de 4 colonnes (desktop) à 1 colonne (mobile)', async () => {
    // Première facture disponible (ordre canonique de la liste)
    const ids = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/projets/factures?limit=all', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const j = await r.json()
      return (j.data || []).map(f => String(f.id))
    })
    assert.ok(ids.length >= 1, 'au moins une facture requise')

    await page.goto(URL + '/factures/' + ids[0], { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h1', { timeout: 10000 })
    // Attendre que la grille de dates soit rendue
    await page.waitForFunction(() => {
      return [...document.querySelectorAll('div.grid')].some(g =>
        g.textContent.includes('Date de facturation') && g.textContent.includes("Date d'échéance"))
    }, { timeout: 10000 })

    // Mesure le nombre de lignes occupées par les enfants directs de la grille de dates.
    const measure = async () => page.evaluate(() => {
      const grid = [...document.querySelectorAll('div.grid')].find(g =>
        g.textContent.includes('Date de facturation') && g.textContent.includes("Date d'échéance"))
      if (!grid) return null
      const kids = [...grid.children].filter(k => k.getBoundingClientRect().height > 0)
      const tops = kids.map(k => Math.round(k.getBoundingClientRect().top))
      return { childCount: kids.length, rows: new Set(tops).size }
    })

    // Desktop ≥1024px → lg:grid-cols-4 → tout sur une ligne
    await page.setViewportSize({ width: 1280, height: 900 })
    await page.waitForTimeout(200)
    const desktop = await measure()
    assert.ok(desktop && desktop.childCount >= 3, `grille de dates introuvable (childCount=${desktop?.childCount})`)
    assert.equal(desktop.rows, 1, `desktop: attendu 1 ligne, obtenu ${desktop.rows} (childCount=${desktop.childCount})`)

    // Tablette 640-1023px → sm:grid-cols-2 → plusieurs lignes
    await page.setViewportSize({ width: 820, height: 900 })
    await page.waitForTimeout(200)
    const tablet = await measure()
    assert.ok(tablet.rows > desktop.rows, `tablette: attendu plus de lignes que desktop (tablette=${tablet.rows}, desktop=${desktop.rows})`)

    // Mobile <640px → grid-cols-1 → une ligne par champ
    await page.setViewportSize({ width: 500, height: 900 })
    await page.waitForTimeout(200)
    const mobile = await measure()
    assert.ok(mobile.rows > tablet.rows, `mobile: attendu plus de lignes que tablette (mobile=${mobile.rows}, tablette=${tablet.rows})`)
    assert.equal(mobile.rows, mobile.childCount, `mobile: chaque champ devrait occuper sa propre ligne (rows=${mobile.rows}, childCount=${mobile.childCount})`)
  })
})
