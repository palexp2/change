const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

async function authedFetch(page, path, opts = {}) {
  return page.evaluate(async ({ path, opts }) => {
    const token = localStorage.getItem('erp_token')
    const headers = { Authorization: `Bearer ${token}`, ...(opts.headers || {}) }
    if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json'
    const r = await fetch('/erp/api' + path, { ...opts, headers })
    const ct = r.headers.get('content-type') || ''
    const body = ct.includes('application/json') ? await r.json() : await r.text()
    return { status: r.status, body }
  }, { path, opts })
}

describe('EmployeeDetail — section Vacances', () => {
  let browser, ctx, page
  let employeeId
  const createdIds = []

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    const pick = await authedFetch(page, '/employees?limit=50')
    const first = (pick.body.data || pick.body)[0]
    assert.ok(first, 'au moins un employé est nécessaire pour ce test')
    employeeId = first.id
  })

  after(async () => {
    for (const id of createdIds) {
      try { await authedFetch(page, `/vacations/${id}`, { method: 'DELETE' }) } catch {}
    }
    await browser?.close()
  })

  test('ajouter une vacance par le « + » du tableau, puis la supprimer par clic droit', async () => {
    await page.goto(`${URL}/employees/${employeeId}`, { waitUntil: 'domcontentloaded' })
    const addBtn = page.locator('[data-testid="vacation-balance"] ~ * [data-testid="datatable-add-record"]').first()
    await addBtn.waitFor({ timeout: 10000 })

    const before = await authedFetch(page, `/vacations?employee_id=${employeeId}`)
    const idsBefore = new Set((before.body.data || []).map(v => v.id))

    await addBtn.click()
    await page.waitForTimeout(800)

    const check = await authedFetch(page, `/vacations?employee_id=${employeeId}`)
    const created = (check.body.data || []).find(v => !idsBefore.has(v.id))
    assert.ok(created, 'une vacance doit avoir été créée')
    createdIds.push(created.id)
    assert.strictEqual(created.paid, 1, 'paid doit être à 1 par défaut (Congé payé)')

    // clic droit sur la ligne neuve → « Supprimer » → confirmer
    await page.keyboard.press('Escape')
    const row = page.locator(`[data-row-id="${created.id}"]`).first()
    await row.click({ button: 'right' })
    await page.click('[data-testid="rowmenu-delete"]')
    const confirmBtn = page.locator('button:has-text("Supprimer"), button:has-text("Confirmer")').last()
    try { await confirmBtn.click({ timeout: 2000 }) } catch {}
    await page.waitForTimeout(600)

    const after = await authedFetch(page, `/vacations?employee_id=${employeeId}`)
    assert.ok(!(after.body.data || []).some(v => v.id === created.id), 'la vacance doit avoir été supprimée')
    createdIds.splice(createdIds.indexOf(created.id), 1)
  })
})
