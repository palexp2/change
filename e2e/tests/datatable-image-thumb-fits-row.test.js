// Vignettes d'image des DataTables — taille par rapport à la hauteur de ligne.
//
// Les images des tableaux devaient être *légèrement* plus petites que la ligne :
// certaines faisaient exactement la hauteur de ligne (32px) voire plus (40px),
// et débordaient. Toutes passent désormais par <TableThumb> (28px pour une ligne
// de 32px). Ce test vérifie sur deux tableaux réels que chaque vignette tient
// dans sa ligne sans être ridiculement petite.
// Test 100% lecture seule : aucune donnée n'est créée ni modifiée.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Entreprise signalée par l'utilisateur (onglet « N° de série », 40 numéros
// avec image produit).
const COMPANY_ID = '6365031a-97b1-4a76-80cd-e989c0e2334a'

describe('DataTable — vignettes plus petites que la hauteur de ligne', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1600, height: 950 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => {
    await browser?.close()
  })

  // Mesure, pour chaque ligne visible contenant une <img>, la hauteur de la
  // vignette et celle de la ligne.
  async function measure() {
    return page.evaluate(() => {
      const out = []
      for (const row of document.querySelectorAll('[data-row-id]')) {
        const rowH = row.getBoundingClientRect().height
        if (!rowH) continue
        for (const img of row.querySelectorAll('img')) {
          const r = img.getBoundingClientRect()
          if (!r.height) continue
          out.push({
            rowH,
            imgH: r.height,
            imgW: r.width,
            thumb: img.dataset.testid === 'table-thumb',
            src: img.getAttribute('src'),
          })
        }
      }
      return out
    })
  }

  function assertFits(measures, where) {
    assert.ok(measures.length > 0, `au moins une vignette doit être visible (${where})`)
    // 1) Aucune image ne dépasse — ni n'égale — la hauteur de sa ligne.
    for (const m of measures) {
      assert.ok(
        m.imgH < m.rowH,
        `${where} — vignette ${m.imgH}px >= hauteur de ligne ${m.rowH}px (${m.src})`,
      )
    }
    // 2) Les vignettes carrées (<TableThumb>) restent *légèrement* plus petites
    //    que la ligne : pas d'image riquiqui. Les images à ratio libre
    //    (champs custom, `object-contain`) peuvent être plus basses si elles
    //    sont larges — seule la règle (1) leur est opposable.
    const thumbs = measures.filter(m => m.thumb)
    assert.ok(thumbs.length > 0, `au moins une vignette carrée doit être visible (${where})`)
    for (const m of thumbs) {
      assert.ok(
        m.imgH >= m.rowH - 6,
        `${where} — vignette ${m.imgH}px trop petite pour une ligne de ${m.rowH}px (${m.src})`,
      )
    }
  }

  test('tableau Produits — la colonne Image tient dans la ligne', async () => {
    await page.goto(`${URL}/products`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')
    await page.locator('[data-row-id]').first().waitFor({ state: 'visible', timeout: 20000 })
    await page.locator('[data-row-id] img').first().waitFor({ state: 'visible', timeout: 20000 })

    assertFits(await measure(), 'produits')
  })

  test('fiche entreprise — vignettes des numéros de série', async () => {
    await page.goto(`${URL}/companies/${COMPANY_ID}`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')
    await page.click('button:has-text("N° de série")')
    await page.locator('[data-row-id]').first().waitFor({ state: 'visible', timeout: 20000 })
    await page.locator('[data-row-id] img').first().waitFor({ state: 'visible', timeout: 20000 })

    assertFits(await measure(), 'numéros de série')
  })
})
