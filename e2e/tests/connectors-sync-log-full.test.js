const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Connecteurs — journal de synchronisation au complet', () => {
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

  test('clic sur "Journal de synchronisation" demande limit=all et liste toutes les entrées', async () => {
    // Capture every /sync-log request to verify the limit param. Attach BEFORE navigation
    // so we don't miss the initial closed-state fetch.
    const calls = []
    page.on('request', req => {
      const u = req.url()
      if (u.includes('/api/connectors/sync-log')) calls.push(u)
    })

    await page.goto(`${URL}/connectors`, { waitUntil: 'networkidle' })

    const panelBtn = page.locator('button:has-text("Journal de synchronisation")').first()
    await panelBtn.waitFor({ state: 'visible', timeout: 5000 })

    // The initial closed-state fetch should have already happened during goto
    const closedCalls = calls.filter(u => u.includes('limit=50'))
    assert.ok(closedCalls.length >= 1, `le panneau fermé doit charger limit=50 (calls: ${calls.join(', ')})`)

    // Open the panel; the open-state load should fire a fresh request with limit=all
    const allReqWait = page.waitForResponse(
      r => r.url().includes('/api/connectors/sync-log') && r.url().includes('limit=all') && r.status() === 200,
      { timeout: 5000 }
    )
    await panelBtn.click()
    await allReqWait

    // Verify the meta line shows N entrées and the 7-day note
    const meta = page.locator('text=/\\d+ entrée/').first()
    await meta.waitFor({ state: 'visible', timeout: 3000 })
    const metaText = await meta.textContent()
    assert.match(metaText, /7 derniers jours/, `meta line doit mentionner "7 derniers jours" (got: "${metaText}")`)

    // Pull the count from the meta line and confirm it matches the rendered <tbody> rows
    const m = metaText.match(/(\d+) entrée/)
    assert.ok(m, `impossible d'extraire le compte d'entrées depuis "${metaText}"`)
    const declared = parseInt(m[1], 10)

    // Empty journal: nothing more to verify
    if (declared === 0) return

    const rowCount = await page.locator('table tbody tr').count()
    assert.equal(rowCount, declared, `nombre de lignes rendues (${rowCount}) doit égaler le compte annoncé (${declared})`)

    // Headers include both Date and Heure
    const headers = await page.locator('table thead th').allTextContents()
    assert.deepEqual(headers.slice(0, 2), ['Date', 'Heure'], `en-têtes doivent commencer par Date,Heure (got: ${headers.join(',')})`)

    // First row's Date and Heure cells must render real values, not "Invalid Date"
    const firstDate = await page.locator('table tbody tr').first().locator('td').nth(0).textContent()
    const firstClock = await page.locator('table tbody tr').first().locator('td').nth(1).textContent()
    assert.ok(firstDate && !firstDate.includes('Invalid'), `cellule Date invalide: "${firstDate}"`)
    assert.ok(firstClock && !firstClock.includes('Invalid'), `cellule Heure invalide: "${firstClock}"`)
    // Heure cell is fr-CA HH:MM:SS — accept any digit-colon pattern
    assert.match(firstClock, /\d{1,2}\s*[h:]\s*\d{2}/, `cellule Heure ne ressemble pas à une heure: "${firstClock}"`)
  })
})
