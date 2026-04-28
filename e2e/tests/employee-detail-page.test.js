const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('EmployeeDetail — fiche employé sur page dédiée', () => {
  let browser, ctx, page
  let employeeId
  let original = {}

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    const pick = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/employees?limit=50', { headers: { Authorization: `Bearer ${token}` } })
      const data = await r.json()
      const first = (data.data || data)[0]
      if (!first) return null
      return { id: first.id, issues: first.issues, hours_per_week: first.hours_per_week }
    })
    assert.ok(pick, 'au moins un employé est nécessaire pour ce test')
    employeeId = pick.id
    original = pick
  })

  after(async () => {
    if (employeeId) {
      await page.evaluate(async ({ id, orig }) => {
        const token = localStorage.getItem('erp_token')
        await fetch(`/erp/api/employees/${id}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ issues: orig.issues, hours_per_week: orig.hours_per_week }),
        })
      }, { id: employeeId, orig: original })
    }
    await browser?.close()
  })

  test('le clic sur une ligne navigue vers /employees/:id (pas de modale)', async () => {
    await page.goto(`${URL}/employees`, { waitUntil: 'domcontentloaded' })
    // attendre que les lignes du DataTable soient rendues (divs avec cursor-pointer)
    await page.waitForSelector('.cursor-pointer.hover\\:bg-slate-50', { timeout: 10000 })
    await page.locator('.cursor-pointer.hover\\:bg-slate-50').first().click()

    await page.waitForURL(u => /\/employees\/[^/]+$/.test(u.toString()), { timeout: 5000 })

    // la page détail est bien un rendu inline (pas une modale overlay)
    const h1 = await page.locator('h1').first().textContent()
    assert.ok(h1 && h1.trim().length > 0, 'un titre employé doit être affiché')

    // au moins une section de la fiche doit être visible
    await page.waitForSelector('text=Identité', { timeout: 3000 })
  })

  test('autosave — modifier un champ texte (issues) persiste', async () => {
    await page.goto(`${URL}/employees/${employeeId}`, { waitUntil: 'domcontentloaded' })
    // attendre que la page soit chargée (sections visibles)
    await page.waitForSelector('textarea', { timeout: 10000 })

    const marker = `e2e-autosave-${Date.now()}`
    // chercher le textarea "Problèmes"
    const textarea = page.locator('label:has-text("Problèmes")').locator('..').locator('textarea').first()
    await textarea.waitFor({ timeout: 5000 })
    await textarea.fill(marker)
    // blur pour déclencher flush immédiat (onChange + debounce 400ms)
    await page.locator('h1').first().click()
    await page.waitForTimeout(900)

    const confirmed = await page.evaluate(async ({ id }) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/employees/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      const j = await r.json()
      return j.issues
    }, { id: employeeId })
    assert.strictEqual(confirmed, marker, "la modification du champ 'Problèmes' doit être persistée")
  })

  test('autosave — modifier un champ number (hours_per_week) persiste', async () => {
    await page.goto(`${URL}/employees/${employeeId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('input[type="number"]', { timeout: 10000 })

    const input = page.locator('label:has-text("Heures par semaine")').locator('..').locator('input[type="number"]').first()
    await input.waitFor({ timeout: 5000 })
    await input.fill('37.5')
    await page.locator('h1').first().click()
    await page.waitForTimeout(900)

    const confirmed = await page.evaluate(async ({ id }) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/employees/${id}`, { headers: { Authorization: `Bearer ${token}` } })
      const j = await r.json()
      return j.hours_per_week
    }, { id: employeeId })
    assert.strictEqual(Number(confirmed), 37.5, 'hours_per_week doit être persisté à 37.5')
  })

  test('le bouton retour ramène sur /employees', async () => {
    await page.goto(`${URL}/employees/${employeeId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('h1', { timeout: 10000 })
    await page.locator('button:has(svg.lucide-arrow-left)').first().click()
    await page.waitForURL(u => {
      const s = u.toString()
      return s.endsWith('/employees') || s.includes('/employees?')
    }, { timeout: 5000 })
  })
})
