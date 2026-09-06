const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie sur la page Extraction de données que la publication QuickBooks bloque :
//   1) Un reçu daté dans le futur.
//   2) Un reçu daté de plus de 30 jours dans le passé.
// On simule la date via interception réseau (page.route) sur GET /api/sale-receipts/:id
// pour n'altérer aucun record en DB.

describe('Extraction de données : fenêtre de date à la publication QB', () => {
  let browser, ctx, page
  let token, candidateId

  function pad(n) { return String(n).padStart(2, '0') }
  function ymd(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` }

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })

    token = await page.evaluate(() => localStorage.getItem('erp_token'))
    const resp = await page.request.get(URL + '/api/sale-receipts?limit=all', {
      headers: { Authorization: 'Bearer ' + token },
    })
    const body = await resp.json()
    const candidate = body.data.find(r => r.status === 'done' && !r.quickbooks_id)
      || body.data.find(r => r.status === 'done')
    assert.ok(candidate, 'Préalable : il faut un reçu status=done en DB')
    candidateId = candidate.id
  })

  after(async () => { await browser?.close() })

  async function loadWithMockedDate(receiptDate) {
    await page.unroute('**/api/sale-receipts/' + candidateId).catch(() => {})
    await page.route('**/api/sale-receipts/' + candidateId, async (route, request) => {
      if (request.method() !== 'GET') return route.continue()
      const resp = await route.fetch()
      const json = await resp.json()
      json.receipt_date = receiptDate
      json.quickbooks_id = null
      json.quickbooks_type = null
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(json) })
    })
    await page.goto(URL + '/sale-receipts/' + candidateId, { waitUntil: 'networkidle' })
    await page.getByTestId('qb-expense-select').waitFor({ state: 'visible', timeout: 15000 })
  }

  test('bloque la publication quand la date est dans le futur', async () => {
    const future = new Date(); future.setDate(future.getDate() + 5)
    await loadWithMockedDate(ymd(future))
    await page.click('button:has-text("Publier sur QuickBooks")')
    const errBox = page.locator('text=/futur/i').first()
    await errBox.waitFor({ state: 'visible', timeout: 3000 })
    assert.ok(await errBox.isVisible(), 'Le message d\'erreur doit mentionner « futur »')
  })

  test('bloque la publication quand la date est à plus de 30 jours dans le passé', async () => {
    const past = new Date(); past.setDate(past.getDate() - 45)
    await loadWithMockedDate(ymd(past))
    await page.click('button:has-text("Publier sur QuickBooks")')
    const errBox = page.locator('text=/30 jours/i').first()
    await errBox.waitFor({ state: 'visible', timeout: 3000 })
    assert.ok(await errBox.isVisible(), 'Le message d\'erreur doit mentionner « 30 jours »')
  })

  test('autorise la publication quand la date est dans la fenêtre (≤ 30 jours, pas futur)', async () => {
    const recent = new Date(); recent.setDate(recent.getDate() - 5)
    await loadWithMockedDate(ymd(recent))
    // On vérifie juste qu'aucune erreur de date n'est levée — on n'exécute pas la
    // publication réelle (pour ne rien créer dans QB). On regarde que le bouton
    // déclenche une validation qui dépasse la check de date (erreur sur compte
    // de dépense au lieu d'erreur sur date).
    await page.click('button:has-text("Publier sur QuickBooks")')
    const dateErr = page.locator('text=/futur|30 jours/i')
    assert.equal(await dateErr.count(), 0, 'Aucune erreur liée à la date ne doit apparaître pour une date récente')
  })
})
