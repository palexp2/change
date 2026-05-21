const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('FactureDetail — navigation prev/next via chevrons dans le header', () => {
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

  test('Les chevrons prev/next naviguent dans la liste des factures (même ordre que la liste API)', async () => {
    // Charge l'ordre canonique de la liste — c'est celui sur lequel s'appuie la nav prev/next.
    const ids = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/projets/factures?limit=all', {
        headers: { Authorization: `Bearer ${token}` },
      })
      const j = await r.json()
      return (j.data || []).map(f => String(f.id))
    })
    assert.ok(ids.length >= 3, 'au moins 3 factures requises pour tester prev + next')

    // Ouvre la deuxième facture pour avoir prev ET next actifs
    const startId = ids[1]
    const expectedPrevId = ids[0]
    const expectedNextId = ids[2]

    await page.goto(URL + '/factures/' + startId, { waitUntil: 'domcontentloaded' })
    // Attendre que la fiche soit chargée
    await page.waitForSelector('h1', { timeout: 10000 })

    // Les deux chevrons doivent être visibles et activés
    const prevBtn = page.locator('button[aria-label="Facture précédente"]')
    const nextBtn = page.locator('button[aria-label="Facture suivante"]')
    await prevBtn.waitFor({ state: 'visible', timeout: 10000 })
    await nextBtn.waitFor({ state: 'visible', timeout: 10000 })

    // Attendre que la liste soit chargée côté client (chevrons activés)
    await page.waitForFunction(() => {
      const p = document.querySelector('button[aria-label="Facture précédente"]')
      const n = document.querySelector('button[aria-label="Facture suivante"]')
      return p && n && !p.disabled && !n.disabled
    }, { timeout: 10000 })

    // Click next → URL doit changer pour expectedNextId
    await nextBtn.click()
    await page.waitForURL(u => u.toString().includes('/factures/' + expectedNextId), { timeout: 10000 })

    // Re-attendre que les chevrons soient prêts sur la nouvelle page (le prev pointe maintenant vers startId)
    await page.waitForFunction(() => {
      const p = document.querySelector('button[aria-label="Facture précédente"]')
      return p && !p.disabled
    }, { timeout: 10000 })

    // Click prev deux fois → on doit revenir à expectedPrevId
    await page.locator('button[aria-label="Facture précédente"]').click()
    await page.waitForURL(u => u.toString().includes('/factures/' + startId), { timeout: 10000 })

    await page.waitForFunction(() => {
      const p = document.querySelector('button[aria-label="Facture précédente"]')
      return p && !p.disabled
    }, { timeout: 10000 })

    await page.locator('button[aria-label="Facture précédente"]').click()
    await page.waitForURL(u => u.toString().includes('/factures/' + expectedPrevId), { timeout: 10000 })

    // Sur la première facture, prev doit être désactivé
    await page.waitForFunction(() => {
      const p = document.querySelector('button[aria-label="Facture précédente"]')
      return p && p.disabled
    }, { timeout: 10000 })
  })
})
