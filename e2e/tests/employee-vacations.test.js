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

  test('ajouter une vacance, basculer en "Sans solde", la modifier et la supprimer', async () => {
    await page.goto(`${URL}/employees/${employeeId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid="add-vacation"]', { timeout: 10000 })

    // snapshot: count before
    const before = await authedFetch(page, `/vacations?employee_id=${employeeId}`)
    const countBefore = (before.body.data || []).length

    // click "Ajouter"
    await page.click('[data-testid="add-vacation"]')
    await page.waitForSelector('[data-testid="vacations-table"]', { timeout: 5000 })

    // la nouvelle ligne est en haut ; récupérer son id
    const newRow = page.locator('[data-testid="vacations-table"] tbody tr').first()
    const rowId = await newRow.getAttribute('data-vacation-id')
    assert.ok(rowId, 'la nouvelle ligne doit avoir un data-vacation-id')
    createdIds.push(rowId)

    // vérifier les valeurs par défaut (date du jour, payé=1)
    const paidDefault = await newRow.locator('[data-testid="vacation-paid"]').inputValue()
    assert.strictEqual(paidDefault, '1', 'paid doit être à 1 par défaut (Congé payé)')

    // modifier les dates
    await newRow.locator('[data-testid="vacation-start"]').fill('2026-06-15')
    await newRow.locator('[data-testid="vacation-end"]').fill('2026-06-22')
    // basculer en "Sans solde"
    await newRow.locator('[data-testid="vacation-paid"]').selectOption('0')
    // notes
    await newRow.locator('[data-testid="vacation-notes"]').fill('Vacances test Playwright')
    // trigger blur + debounce
    await page.locator('h1').first().click()
    await page.waitForTimeout(900)

    // vérifier côté serveur
    const check = await authedFetch(page, `/vacations?employee_id=${employeeId}`)
    const saved = (check.body.data || []).find(v => v.id === rowId)
    assert.ok(saved, 'la vacance doit être retournée par le serveur')
    assert.strictEqual(saved.start_date, '2026-06-15')
    assert.strictEqual(saved.end_date, '2026-06-22')
    assert.strictEqual(saved.paid, 0, 'paid doit être persisté à 0 (sans solde)')
    assert.strictEqual(saved.notes, 'Vacances test Playwright')
    assert.strictEqual((check.body.data || []).length, countBefore + 1, 'le count doit avoir augmenté de 1')

    // supprimer la ligne via le bouton (modale confirm)
    page.once('dialog', d => d.accept())
    // on utilise le ConfirmProvider custom — intercepter son bouton confirmer
    await newRow.locator('[data-testid="vacation-delete"]').click()
    // accepter la modale de confirmation (fallback selon pattern)
    const confirmBtn = page.locator('button:has-text("Supprimer"), button:has-text("Confirmer")').last()
    if (await confirmBtn.count()) {
      try { await confirmBtn.click({ timeout: 2000 }) } catch {}
    }
    await page.waitForTimeout(600)

    const after = await authedFetch(page, `/vacations?employee_id=${employeeId}`)
    const stillThere = (after.body.data || []).find(v => v.id === rowId)
    assert.ok(!stillThere, 'la vacance doit avoir été supprimée')
    // retirer de createdIds pour ne pas retenter la suppression
    const idx = createdIds.indexOf(rowId)
    if (idx >= 0) createdIds.splice(idx, 1)
  })
})
