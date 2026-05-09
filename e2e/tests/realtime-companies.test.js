// Realtime collab on /companies and /companies/:id.
// Two contexts log in. A watches the list (and a detail). B mutates via API.
// A must see the change live.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

describe('Realtime — collab live sur /companies', () => {
  let browser, ctxA, ctxB, pageA, pageB
  let createdId = null

  before(async () => {
    browser = await chromium.launch()
    ctxA = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    ctxB = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    pageA = await ctxA.newPage()
    pageB = await ctxB.newPage()
    await login(pageA)
    await login(pageB)
  })

  after(async () => {
    if (createdId) {
      try {
        await pageB.evaluate(async (id) => {
          const tok = localStorage.getItem('erp_token')
          await fetch(`/erp/api/companies/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } })
        }, createdId)
      } catch {}
    }
    await browser?.close()
  })

  test('création par B → apparaît dans la table A', async () => {
    await pageA.goto(URL + '/companies', { waitUntil: 'networkidle' })
    await pageA.waitForTimeout(1500) // let WS authenticate + subscribe (companies list is bigger, takes longer to load)

    const uniqueName = `RT-Test-${Date.now()}`
    // Set lifecycle_phase=Customer so the row passes the user's "Clients" pill
    // filter (the default saved view for many ERP users).
    const co = await pageB.evaluate(async (name) => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/companies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ name, lifecycle_phase: 'Customer' }),
      })
      return r.json()
    }, uniqueName)
    assert.ok(co?.id, 'creation failed: ' + JSON.stringify(co))
    createdId = co.id

    // 10s leeway: companies table holds 6500+ rows and DataTable virtualizes —
    // re-render after a state mutation can be slower than for orders (~150 rows).
    await pageA.locator(`text="${uniqueName}"`).first().waitFor({ state: 'visible', timeout: 10000 })
  })

  test('update sur fiche détail (CompanyDetail) — B édite, A voit', async () => {
    if (!createdId) return
    // A opens the detail page.
    await pageA.goto(`${URL}/companies/${createdId}`, { waitUntil: 'networkidle' })
    await pageA.waitForTimeout(500)

    // B updates the name field.
    const newName = `RT-Renamed-${Date.now()}`
    await pageB.evaluate(async ({ id, name }) => {
      const tok = localStorage.getItem('erp_token')
      await fetch(`/erp/api/companies/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ name }),
      })
    }, { id: createdId, name: newName })

    // A's detail page should now show the new name.
    await pageA.waitForFunction(
      (needle) => document.body.innerText.includes(needle),
      newName,
      { timeout: 3000 },
    )
  })
})
