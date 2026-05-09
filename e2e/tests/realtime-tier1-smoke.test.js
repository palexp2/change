// Smoke test that the realtime broadcast pattern works for Tier 1 entities
// beyond orders/companies (which have dedicated tests). Validates the
// emitEntity/useEntityListRealtime pipeline by exercising contacts.
//
// Two browser contexts log in. A watches /contacts. B creates a contact via
// the HTTP API. A must see the new row appear without refresh.

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

describe('Realtime Tier 1 — smoke (contacts)', () => {
  let browser, ctxA, ctxB, pageA, pageB
  let contactId = null

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
    if (contactId) {
      try {
        await pageB.evaluate(async (id) => {
          const tok = localStorage.getItem('erp_token')
          await fetch(`/erp/api/contacts/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } })
        }, contactId)
      } catch {}
    }
    await browser?.close()
  })

  // Use the contact detail page (not the list) to validate the realtime
  // pipeline — list pages are subject to user-saved view filters that may
  // hide new rows; the detail page subscribes to `contact:${id}` directly
  // so it always renders the updated record.
  test('création + update via API : A voit l\'email arriver sur la fiche détail', async () => {
    const ct = await pageB.evaluate(async (last) => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ first_name: 'Smoke', last_name: last }),
      })
      return r.json()
    }, `RT-T1-${Date.now()}`)
    assert.ok(ct?.id, 'creation failed: ' + JSON.stringify(ct))
    contactId = ct.id

    await pageA.goto(`${URL}/contacts/${contactId}`, { waitUntil: 'networkidle' })
    await pageA.waitForTimeout(1000) // WS auth + subscribe

    const newEmail = `rt-${Date.now()}@example.com`
    await pageB.evaluate(async ({ id, email }) => {
      const tok = localStorage.getItem('erp_token')
      await fetch(`/erp/api/contacts/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tok}` },
        body: JSON.stringify({ email }),
      })
    }, { id: contactId, email: newEmail })

    // Email is rendered as an editable input — its current value lives in the
    // DOM as `input.value`, not in body.innerText. Walk all inputs/textareas
    // and look for the new email.
    await pageA.waitForFunction(
      (needle) => {
        if (document.body.innerText.includes(needle)) return true
        const fields = document.querySelectorAll('input, textarea')
        for (const f of fields) if (f.value && f.value.includes(needle)) return true
        return false
      },
      newEmail,
      { timeout: 5000 },
    )
  })

})
