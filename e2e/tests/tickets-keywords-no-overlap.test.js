const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Les pastilles de la colonne « Mots clés » débordaient de leur ligne
// (flex-wrap dans une cellule de hauteur fixe) et se superposaient à l'en-tête
// et aux lignes voisines. Test 100 % lecture seule : aucun record créé ni
// modifié, on se contente de parcourir les vues existantes.
describe('Billets : les mots-clés ne se chevauchent pas', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 20000 })
  })

  after(async () => { await browser?.close() })

  test('plusieurs mots-clés restent sur une seule ligne, dans les bornes de la ligne', async () => {
    await page.goto(URL + '/tickets', { waitUntil: 'networkidle' })
    await page.waitForSelector('[data-testid^="col-header-"]', { timeout: 15000 })
    await page.waitForTimeout(1500)

    // Cherche, parmi les lignes rendues, une cellule « Mots clés » avec au
    // moins deux pastilles, et renvoie leurs géométries.
    const probe = () => page.evaluate(() => {
      const heads = [...document.querySelectorAll('[data-testid^="col-header-"]')].map(h => h.textContent.trim())
      const idx = heads.findIndex(h => h.toLowerCase().startsWith('mots'))
      if (idx < 0) return { hasCol: false, found: false }
      for (const r of document.querySelectorAll('[data-row-id]')) {
        const cells = [...r.children]
        const cell = cells[cells.length - (heads.length - idx)]
        if (!cell) continue
        const badges = [...cell.querySelectorAll('span')]
        if (badges.length < 2) continue
        return {
          hasCol: true,
          found: true,
          title: cells[0].textContent.trim(),
          row: r.getBoundingClientRect().toJSON(),
          badges: badges.map(b => ({ t: b.textContent.trim(), r: b.getBoundingClientRect().toJSON() })),
        }
      }
      return { hasCol: true, found: false }
    })

    // Onglets de vues : boutons de la barre d'onglets (classe `-mb-px`).
    // Les sélectionner ne fait que ré-écrire leurs propres filtres (idempotent).
    const viewTabs = page.locator('button[class*="-mb-px"]')
    const viewCount = await viewTabs.count()
    assert.ok(viewCount > 0, 'aucune vue sur /tickets')

    let data = null
    for (let i = 0; i < viewCount && !data; i++) {
      await viewTabs.nth(i).click()
      await page.waitForTimeout(1200)
      let res = await probe()
      if (!res.hasCol) continue
      // Lignes virtualisées : on fait défiler pour en charger d'autres.
      for (let s = 0; s < 6 && !res.found; s++) {
        const scrolled = await page.evaluate(() => {
          const el = [...document.querySelectorAll('div.overflow-auto')].find(d => d.scrollHeight > d.clientHeight + 10)
          if (!el) return false
          const before = el.scrollTop
          el.scrollTop = before + el.clientHeight
          return el.scrollTop > before
        })
        if (!scrolled) break
        await page.waitForTimeout(500)
        res = await probe()
      }
      if (res.found) data = res
    }

    assert.ok(data, 'aucune ligne avec >= 2 mots-clés visible dans les vues de /tickets')

    const { badges, row } = data

    // a) toutes les pastilles sur la même ligne visuelle
    const tops = badges.map(b => b.r.top)
    const spread = Math.max(...tops) - Math.min(...tops)
    assert.ok(spread <= 1, `${data.title} : pastilles réparties sur plusieurs lignes (écart ${spread}px) — ${badges.map(b => b.t).join(' | ')}`)

    // b) aucune pastille ne déborde verticalement de sa ligne de tableau
    for (const b of badges) {
      assert.ok(b.r.top >= row.top - 1 && b.r.bottom <= row.bottom + 1,
        `pastille « ${b.t} » hors de sa ligne (badge ${b.r.top}-${b.r.bottom}, ligne ${row.top}-${row.bottom})`)
    }

    // c) aucune pastille n'en recouvre une autre
    const sorted = [...badges].sort((a, b) => a.r.left - b.r.left)
    for (let i = 1; i < sorted.length; i++) {
      assert.ok(sorted[i].r.left >= sorted[i - 1].r.right - 0.5,
        `« ${sorted[i - 1].t} » et « ${sorted[i].t} » se chevauchent`)
    }
  })
})
