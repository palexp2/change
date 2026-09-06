// Les panneaux de la ViewToolbar (Champs, Filtrer, Trier…) sont rendus via
// portal en position fixed : ils ne doivent plus être clippés par le
// `overflow-hidden` du card DataTable quand la fenêtre est très petite.
// Test read-only : on ouvre les panneaux et on vérifie leur géométrie sans
// modifier aucune configuration de vue.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('ViewToolbar — panneaux non clippés en petite fenêtre', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    // Fenêtre volontairement très petite : avant le fix, le panneau était
    // coupé par le bas du card DataTable (overflow-hidden).
    ctx = await browser.newContext({ viewport: { width: 900, height: 450 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => { await browser?.close() })

  test('le panneau Champs déborde du card et reste entièrement dans le viewport', async () => {
    await page.goto(URL + '/orders', { waitUntil: 'domcontentloaded' })
    await page.locator('button', { hasText: /^Champs/ }).first().click()

    const panel = page.locator('[data-viewtoolbar-panel]')
    await panel.waitFor({ timeout: 5000 })

    // Rendu via portal directement dans <body> (donc hors du card overflow-hidden)
    const parentTag = await panel.evaluate(el => el.parentElement.tagName)
    assert.equal(parentTag, 'BODY', 'le panneau doit être rendu en portal dans <body>')

    const box = await panel.boundingBox()
    const vp = page.viewportSize()
    assert.ok(box, 'le panneau doit avoir une bounding box')
    assert.ok(box.y >= 0, `le haut du panneau doit être visible (y=${box.y})`)
    assert.ok(box.x >= 0, `le bord gauche doit être visible (x=${box.x})`)
    assert.ok(box.x + box.width <= vp.width + 1, `le panneau ne doit pas dépasser à droite (${box.x + box.width} > ${vp.width})`)
    assert.ok(box.y + box.height <= vp.height + 1, `le panneau ne doit pas dépasser en bas (${box.y + box.height} > ${vp.height})`)

    // Hit-test près du bas du panneau : prouve qu'il est réellement affiché
    // (un élément clippé par overflow-hidden n'est pas hit-testable là).
    const bottomVisible = await page.evaluate(([x, y]) => {
      const el = document.elementFromPoint(x, y)
      return !!el?.closest('[data-viewtoolbar-panel]')
    }, [box.x + box.width / 2, box.y + box.height - 8])
    assert.ok(bottomVisible, 'le bas du panneau doit être visible et cliquable')

    // Interagir dans le panneau (portal) ne doit pas le fermer — la recherche
    // est locale au panneau, aucune config de vue n'est modifiée.
    await panel.locator('input[placeholder="Rechercher..."]').click()
    await panel.locator('input[placeholder="Rechercher..."]').fill('zzz_introuvable')
    await page.waitForTimeout(150)
    assert.ok(await panel.isVisible(), 'cliquer/taper dans le panneau ne doit pas le fermer')

    // Clic hors du panneau → fermeture
    await page.mouse.click(vp.width - 10, vp.height - 10)
    await page.waitForTimeout(200)
    assert.equal(await panel.count(), 0, 'un clic extérieur doit fermer le panneau')
  })

  test('le panneau Filtrer (560px) est clampé horizontalement en fenêtre étroite', async () => {
    await page.setViewportSize({ width: 620, height: 450 })
    await page.goto(URL + '/orders', { waitUntil: 'domcontentloaded' })
    await page.locator('button', { hasText: /^Filtrer/ }).first().click()

    const panel = page.locator('[data-viewtoolbar-panel]')
    await panel.waitFor({ timeout: 5000 })

    const box = await panel.boundingBox()
    const vp = page.viewportSize()
    assert.ok(box.x >= 0, `le bord gauche doit rester visible (x=${box.x})`)
    assert.ok(box.x + box.width <= vp.width + 1, `le panneau Filtrer ne doit pas dépasser à droite (${box.x + box.width} > ${vp.width})`)

    // Fermer sans rien modifier (aucun filtre ajouté → pas d'autosave de pill)
    await page.keyboard.press('Escape')
    await page.mouse.click(vp.width - 10, vp.height - 10)
    await page.waitForTimeout(200)
    await page.setViewportSize({ width: 900, height: 450 })
  })
})
