const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Test lecture seule — aucun record créé, aucune config modifiée.
describe('Dashboard — Trésorerie vs limite de marge de crédit', () => {
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

  test('L\'endpoint /api/dashboard/bank-accounts renvoie treasury, credit_limit et des soldes convertis en CAD', async () => {
    const data = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/dashboard/bank-accounts?refresh=1', { headers: { Authorization: `Bearer ${tok}` } })
      return { status: r.status, body: await r.json() }
    })

    if (data.status === 502) {
      console.warn('QB indisponible (502) — test toléré')
      return
    }
    assert.equal(data.status, 200, `attendu 200, reçu ${data.status}`)
    const b = data.body
    assert.equal(typeof b.treasury, 'number', 'treasury manquant')
    assert.equal(b.credit_limit, 360000, 'credit_limit doit valoir 360000')
    assert.equal(b.currency, 'CAD', 'les totaux doivent être exprimés en CAD')
    assert.ok(Array.isArray(b.accounts) && b.accounts.length > 0, 'accounts[] vide')

    // Chaque compte porte un balance_cad ; pour les comptes CAD il égale balance.
    for (const a of b.accounts) {
      assert.equal(typeof a.balance_cad, 'number', `balance_cad manquant sur ${a.name}`)
      if (a.currency === 'CAD') {
        assert.equal(a.balance_cad, a.balance, `compte CAD ${a.name} : balance_cad ≠ balance`)
      }
    }

    // Les comptes en devise étrangère avec solde non nul doivent être convertis
    // à un taux ≠ 1 dès que le taux de change est disponible.
    const foreign = b.accounts.filter(a => a.currency !== 'CAD' && a.balance !== 0)
    for (const a of foreign) {
      const rate = (b.exchange_rates || {})[a.currency]
      if (rate) {
        const expected = Math.round(a.balance * rate * 100) / 100
        assert.equal(a.balance_cad, expected, `conversion incohérente sur ${a.name}`)
      }
    }

    // treasury = somme des balance_cad (banques + cartes/marges, signées).
    const sum = Math.round(b.accounts.reduce((s, a) => s + a.balance_cad, 0) * 100) / 100
    assert.ok(Math.abs(sum - b.treasury) < 0.02, `treasury (${b.treasury}) ≠ somme des balance_cad (${sum})`)
    assert.equal(b.totals.net, b.treasury, 'totals.net doit égaler treasury')
  })

  test('La section Trésorerie affiche le montant et la jauge par rapport à la limite de 360 000 $', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Tableau de bord")', { timeout: 10000 })

    const card = page.locator('[data-testid="section-bank-accounts"]')
    await card.waitFor({ timeout: 10000 })
    await card.scrollIntoViewIfNeeded()

    // Si la carte est repliée, la déplier.
    const panel = page.locator('[data-testid="dashboard-bank-accounts"]')
    if (!(await panel.isVisible().catch(() => false))) {
      await card.locator('h2').first().click()
    }

    await page.locator('[data-testid="dashboard-treasury"], :text("Impossible de charger les soldes")').first()
      .waitFor({ timeout: 20000 })
    const cardText = await card.innerText()
    if (cardText.includes('Impossible de charger les soldes')) {
      console.warn('QB indisponible — test toléré')
      return
    }

    // Le montant affiché correspond au treasury renvoyé par l'API.
    const api = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/dashboard/bank-accounts', { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    })
    const shown = await page.locator('[data-testid="treasury-amount"]').innerText()
    const normalize = s => s.replace(/[\s  ]/g, '').replace(',', '.').replace(/[^0-9.-]/g, '')
    assert.ok(Math.abs(Number(normalize(shown)) - api.treasury) < 0.02,
      `montant affiché « ${shown} » ≠ treasury API ${api.treasury}`)

    // Le coussin vs la limite de marge est affiché avec la bonne valeur.
    assert.ok(/360\s?000/.test(cardText.replace(/[  ]/g, ' ')), 'la limite de 360 000 $ n\'apparaît pas')
    const headroomShown = await page.locator('[data-testid="treasury-headroom"]').innerText()
    const expectedHeadroom = api.treasury + api.credit_limit
    assert.ok(Math.abs(Number(normalize(headroomShown.split('·')[0])) - expectedHeadroom) < 0.02,
      `coussin affiché « ${headroomShown} » ≠ ${expectedHeadroom}`)
  })
})
