const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Test lecture seule — aucun record créé, aucune config modifiée.
describe('Dashboard — Trésorerie : montants en CAD seulement', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => { await browser?.close() })

  test('Chaque ligne de compte affiche un seul montant, converti en CAD', async () => {
    await page.goto(URL + '/dashboard', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h1:has-text("Tableau de bord")', { timeout: 15000 })

    const card = page.locator('[data-testid="section-bank-accounts"]')
    await card.waitFor({ timeout: 15000 })
    await card.scrollIntoViewIfNeeded()

    // Si la carte est repliée, la déplier.
    const panel = page.locator('[data-testid="dashboard-bank-accounts"]')
    if (!(await panel.isVisible().catch(() => false))) {
      await card.locator('h2').first().click()
    }

    await page.locator('[data-testid="dashboard-treasury"], :text("Impossible de charger les soldes")').first()
      .waitFor({ timeout: 30000 })
    const cardText = await card.innerText()
    if (cardText.includes('Impossible de charger les soldes')) {
      console.warn('QB indisponible — test toléré')
      return
    }

    const api = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/dashboard/bank-accounts', { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    })
    assert.ok(Array.isArray(api.accounts) && api.accounts.length, 'accounts[] vide côté API')

    // Le détail compte par compte est replié par défaut — le déplier.
    if (!(await panel.locator('[data-testid="bank-accounts-detail"]').isVisible().catch(() => false))) {
      await panel.locator('[data-testid="bank-accounts-detail-toggle"]').click()
      await panel.locator('[data-testid="bank-accounts-detail"]').waitFor({ timeout: 5000 })
    }

    // Chaque ligne = [libellé, montant] (les lignes de groupe n'ont qu'une cellule).
    const rows = await panel.locator('table tbody tr').evaluateAll(trs =>
      trs.map(tr => Array.from(tr.querySelectorAll('td')).map(td => td.textContent.trim()))
    )
    const joined = rows.map(cells => cells.join(' | ')).join('\n')

    // Plus de double affichage « devise native ≈ équivalent CAD ».
    assert.ok(!joined.includes('≈'), `un montant converti « ≈ » subsiste :\n${joined}`)
    // Le suffixe des devises étrangères (ex. « 12,34 $ US ») ne doit plus apparaître.
    assert.ok(!/\$\s?(US|AU|CN|HK|NZ|SG)/.test(joined), `un montant en devise étrangère subsiste :\n${joined}`)

    const normalize = s => s.replace(/[\s  ]/g, '').replace(',', '.').replace(/[^0-9.-]/g, '')

    // Pour chaque compte de l'API, la ligne correspondante affiche balance_cad.
    for (const a of api.accounts) {
      const row = rows.find(cells => cells.length === 2 && cells[0] === a.name)
      assert.ok(row, `ligne introuvable pour le compte « ${a.name} » — lignes lues :\n${joined}`)
      const amountCell = row[1]
      const shown = Number(normalize(amountCell))
      assert.ok(Math.abs(shown - a.balance_cad) < 0.02,
        `« ${a.name} » : montant affiché ${amountCell} ≠ balance_cad ${a.balance_cad}`)
    }

    // Au moins un compte en devise étrangère confirme la conversion (sinon simple info).
    const foreign = api.accounts.filter(a => a.currency && a.currency !== 'CAD' && a.balance !== 0)
    if (!foreign.length) console.warn('Aucun compte en devise étrangère avec solde non nul — conversion non exercée')
  })
})
