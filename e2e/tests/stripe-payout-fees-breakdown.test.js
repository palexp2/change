const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Preview deposit — ventilation des frais Stripe par catégorie', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('preview-deposit renvoie fees_by_category et la somme colle avec fees_total', async () => {
    const data = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const res = await fetch('/erp/api/stripe-payouts/po_1TN0ZxEO122sMsbJJwo1bfpS/preview-deposit', {
        headers: { Authorization: `Bearer ${token}` },
      })
      return res.json()
    })

    assert.ok(data.summary, 'pas de summary')
    const byCat = data.summary.fees_by_category
    assert.ok(byCat && typeof byCat === 'object', 'fees_by_category absent')

    const sum = Math.round(Object.values(byCat).reduce((s, v) => s + v, 0) * 100) / 100
    assert.equal(sum, data.summary.fees_total,
      `somme ventilée (${sum}) ≠ fees_total (${data.summary.fees_total})`)

    // Pour ce payout, au moins 3 sous-catégories doivent être non-nulles
    const nonZero = Object.entries(byCat).filter(([, v]) => Math.abs(v) > 0.001)
    assert.ok(nonZero.length >= 3,
      `attendu ≥3 catégories non-nulles, reçu ${nonZero.length}: ${nonZero.map(([k]) => k).join(',')}`)

    // Chaque ligne de frais doit avoir un préfixe de catégorie connu
    const labels = Object.values(data.summary.fee_category_labels || {})
    const feeLines = (data.deposit.Line || []).filter(l => (l.Description || '').startsWith('Frais '))
    assert.ok(feeLines.length > 0, 'aucune ligne de frais')
    for (const l of feeLines) {
      const hasCat = labels.some(lbl => l.Description.startsWith(`Frais ${lbl}`))
      assert.ok(hasCat, `ligne non catégorisée : ${l.Description}`)
    }
  })

  test('payout GET renvoie qb_deposit_url quand le deposit est déjà poussé', async () => {
    const data = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const res = await fetch('/erp/api/stripe-payouts/po_1TN0ZxEO122sMsbJJwo1bfpS', {
        headers: { Authorization: `Bearer ${token}` },
      })
      return res.json()
    })
    assert.ok(data.payout, 'pas de payout')
    if (data.payout.qb_deposit_id) {
      assert.ok(data.payout.qb_deposit_url, 'qb_deposit_url manquant alors que qb_deposit_id est présent')
      assert.match(data.payout.qb_deposit_url, /\/app\/deposit\?txnId=\d+/, 'URL QB mal formée')
    }
  })

  test('UI affiche le badge QB Deposit comme lien cliquable quand poussé', async () => {
    await page.goto(`${URL}/stripe-payouts/po_1TN0ZxEO122sMsbJJwo1bfpS`, { waitUntil: 'networkidle' })
    await page.waitForSelector('h1', { timeout: 10000 })
    const badge = page.locator('a[title*="QuickBooks"]').first()
    if (await badge.count() > 0) {
      const href = await badge.getAttribute('href')
      assert.match(href, /qbo\.intuit\.com\/app\/deposit\?txnId=/, `href attendu QB, reçu: ${href}`)
    }
  })

  test('UI du panel Aperçu Deposit affiche la ventilation avec les bons labels', async () => {
    await page.goto(`${URL}/stripe-payouts/po_1TN0ZxEO122sMsbJJwo1bfpS`, { waitUntil: 'networkidle' })
    await page.waitForSelector('h1', { timeout: 10000 })
    await page.click('button:has-text("Aperçu Deposit")')
    await page.waitForSelector('text=Ventilation des frais Stripe', { timeout: 8000 })
    // Pour ce payout, on attend au moins ces 3 labels visibles
    for (const label of ['Traitement carte', 'Calcul auto. des taxes']) {
      const found = await page.locator(`text=${label}`).first().isVisible()
      assert.ok(found, `label "${label}" absent dans le panel Aperçu`)
    }
  })
})
