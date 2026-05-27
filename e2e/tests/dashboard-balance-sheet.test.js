const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Dashboard — Bilan QuickBooks', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('La section Bilan QuickBooks s\'affiche avec des comptes et au moins un total', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Tableau de bord")', { timeout: 10000 })

    const card = page.locator('[data-testid="section-balance-sheet"]')
    await card.waitFor({ timeout: 10000 })

    // Attendre la fin du chargement (le panneau remplace "Chargement…")
    await page.locator('[data-testid="dashboard-balance-sheet"], :text("Impossible de charger le bilan")').first()
      .waitFor({ timeout: 20000 })

    const text = await card.innerText()
    // Si la connexion QB est down on tolère l'erreur — sinon, on attend du contenu structuré
    if (text.includes('Impossible de charger le bilan')) {
      console.warn('QB indisponible — test toléré')
      return
    }

    // Un bilan QB renvoie toujours au moins ces grandes sections (en anglais ou en français selon la locale du compte QB)
    const hasAssets = /ASSETS|Actif/i.test(text)
    const hasLiabOrEquity = /LIABILITIES|EQUITY|Passif|Capitaux/i.test(text)
    assert.ok(hasAssets, 'aucune section Actifs/Assets trouvée — contenu: ' + text.slice(0, 500))
    assert.ok(hasLiabOrEquity, 'aucune section Passif/Capitaux/Liabilities/Equity trouvée')

    // Au moins une valeur monétaire formatée
    const hasMoney = /\d[\d\s ]*[,.]\d{2}/.test(text)
    assert.ok(hasMoney, 'aucun montant formaté affiché — contenu: ' + text.slice(0, 500))
  })

  test('L\'endpoint /api/dashboard/balance-sheet renvoie une structure rows[] valide', async () => {
    const data = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/dashboard/balance-sheet', { headers: { Authorization: `Bearer ${tok}` } })
      return { status: r.status, body: await r.json() }
    })

    if (data.status === 502) {
      console.warn('QB indisponible (502) — test toléré')
      return
    }
    assert.equal(data.status, 200, `attendu 200, reçu ${data.status}`)
    assert.ok(Array.isArray(data.body.rows), 'rows[] manquant')
    assert.ok(data.body.rows.length > 0, 'rows[] vide')
    assert.ok(typeof data.body.currency === 'string', 'currency manquant')

    // Au moins un noeud doit être une section avec un total numérique
    function hasSectionWithTotal(rows) {
      for (const r of rows) {
        if (r.kind === 'section' && typeof r.total === 'number') return true
        if (r.children && hasSectionWithTotal(r.children)) return true
      }
      return false
    }
    assert.ok(hasSectionWithTotal(data.body.rows), 'aucune section avec total trouvée dans l\'arbre')
  })
})
