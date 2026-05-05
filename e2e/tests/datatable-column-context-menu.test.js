// Vérifie que le clic-droit sur l'entête d'une colonne d'un DataTable ouvre un
// menu contextuel offrant Grouper / Filtrer / Trier / Cacher.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const ROW_SEL = 'div[style*="display: grid"][style*="position: absolute"]'

describe('DataTable — menu contextuel sur entête de colonne', () => {
  let browser, ctx, page
  let viewSnapshot = null  // { id, sort, filters, visible_columns, group_by }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    // Snapshot de la vue active de "factures" pour restauration après tests
    viewSnapshot = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/views/factures', { headers: { Authorization: `Bearer ${tok}` } })
      const data = await r.json()
      const lastId = localStorage.getItem('erp_lastView_factures')
      const pill = (data.pills || []).find(p => String(p.id) === String(lastId)) || (data.pills || [])[0]
      if (!pill) return null
      return {
        id: pill.id,
        sort: pill.sort || [],
        filters: pill.filters || [],
        visible_columns: pill.visible_columns || [],
        group_by: pill.group_by || null,
      }
    })
  })

  after(async () => {
    if (viewSnapshot && page) {
      try {
        await page.evaluate(async (snap) => {
          const tok = localStorage.getItem('erp_token')
          await fetch(`/erp/api/views/factures/pills/${snap.id}`, {
            method: 'PUT',
            headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              sort: snap.sort, filters: snap.filters,
              visible_columns: snap.visible_columns, group_by: snap.group_by,
            }),
          })
        }, viewSnapshot)
      } catch {}
    }
    await browser?.close()
  })

  async function openContextOnEntreprise() {
    await page.goto(URL + '/factures', { waitUntil: 'networkidle' })
    await page.waitForSelector(ROW_SEL, { timeout: 15000 })
    // Pour s'assurer que la colonne « Entreprise » est visible, on peut utiliser
    // le panneau Champs pour l'activer si elle ne l'est pas. Par défaut elle est visible.
    const header = page.locator('div.cursor-grab', { hasText: 'Entreprise' }).first()
    await header.click({ button: 'right' })
    // Attendre l'apparition du menu (4 actions principales)
    await page.waitForSelector('text=Grouper par cette colonne', { timeout: 5000 })
  }

  test('le menu apparaît avec les 4 actions principales', async () => {
    await openContextOnEntreprise()
    for (const label of [
      'Grouper par cette colonne',
      'Filtrer cette colonne',
      'Trier croissant',
      'Trier décroissant',
      'Cacher cette colonne',
    ]) {
      const found = await page.locator(`text=${label}`).first().isVisible()
      assert.ok(found, `option "${label}" absente du menu`)
    }
    // ferme via Escape (clic ailleurs pour fermer)
    await page.keyboard.press('Escape')
    await page.mouse.click(50, 50)
  })

  test('action Trier décroissant applique un tri', async () => {
    await openContextOnEntreprise()
    await page.click('text=Trier décroissant')
    // Le badge de tri (sorts.length) apparaît sur le bouton "Trier" du toolbar
    const sortBtn = page.locator('button[data-panel-btn="sort"]')
    const badge = sortBtn.locator('span')
    await page.waitForTimeout(300)
    const badgeText = await badge.first().innerText().catch(() => '')
    assert.equal(badgeText.trim(), '1', `badge du bouton Trier devrait être 1, got "${badgeText}"`)
  })

  test('action Cacher retire la colonne', async () => {
    await page.goto(URL + '/factures', { waitUntil: 'networkidle' })
    await page.waitForSelector(ROW_SEL, { timeout: 15000 })
    // Capture la liste des entêtes avant
    const headersBefore = await page.locator('div.cursor-grab').allInnerTexts()
    assert.ok(headersBefore.some(t => /Entreprise/i.test(t)), 'colonne Entreprise absente avant le test')

    const header = page.locator('div.cursor-grab', { hasText: 'Entreprise' }).first()
    await header.click({ button: 'right' })
    await page.click('text=Cacher cette colonne')
    await page.waitForTimeout(300)

    const headersAfter = await page.locator('div.cursor-grab').allInnerTexts()
    assert.ok(!headersAfter.some(t => /^Entreprise$/i.test(t.trim())), 'colonne Entreprise toujours présente après "Cacher"')

    // Restauration : ré-affiche la colonne Entreprise via le panneau Champs
    await page.click('button[data-panel-btn="fields"]')
    await page.waitForTimeout(200)
    // checkbox associée au label Entreprise
    const cbLabel = page.locator('label', { hasText: /^Entreprise$/ }).first()
    await cbLabel.click()
    await page.keyboard.press('Escape')
  })

  test('action Filtrer ouvre le panneau filtre avec une règle ajoutée', async () => {
    await page.goto(URL + '/factures', { waitUntil: 'networkidle' })
    await page.waitForSelector(ROW_SEL, { timeout: 15000 })

    // Capture badge initial du bouton Filtrer (peut être > 0 si la vue a déjà
    // des filtres sauvegardés)
    const filterBtn = page.locator('button[data-panel-btn="filter"]')
    const initialBadge = parseInt(await filterBtn.locator('span').first().innerText().catch(() => '0'), 10) || 0

    const header = page.locator('div.cursor-grab', { hasText: 'Entreprise' }).first()
    await header.click({ button: 'right' })
    await page.waitForSelector('text=Filtrer cette colonne', { timeout: 5000 })
    await page.click('text=Filtrer cette colonne')

    // Le panneau Filtres s'ouvre
    await page.waitForSelector('text=Filtres', { timeout: 3000 })
    const newBadge = parseInt(await filterBtn.locator('span').first().innerText().catch(() => '0'), 10) || 0
    assert.equal(newBadge, initialBadge + 1, `badge passe de ${initialBadge} à ${initialBadge + 1}, got ${newBadge}`)
  })

  test('action Grouper applique le groupBy', async () => {
    await page.goto(URL + '/factures', { waitUntil: 'networkidle' })
    await page.waitForSelector(ROW_SEL, { timeout: 15000 })
    const header = page.locator('div.cursor-grab', { hasText: 'Statut' }).first()
    await header.click({ button: 'right' })
    await page.click('text=Grouper par cette colonne')
    await page.waitForTimeout(400)
    // Le bouton "Grouper" devient actif (classe brand-50/brand-700)
    const groupBtn = page.locator('button[data-panel-btn="group"]')
    const cls = await groupBtn.getAttribute('class')
    assert.match(cls, /brand-50|brand-700/, `bouton Grouper devrait être actif, classes: ${cls}`)
  })
})
