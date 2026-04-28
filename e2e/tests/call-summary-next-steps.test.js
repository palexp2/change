const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Appels — résumé + prochaines étapes', () => {
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

  test('API /interactions/:id retourne call_summary + call_next_steps', async () => {
    // Find an interaction whose call has a summary
    const data = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/interactions?limit=50', { headers: { Authorization: `Bearer ${token}` } })
      const j = await r.json()
      const callItems = (j.interactions || []).filter(i => i.type === 'call')
      // get full record for the first 5 to find one with a summary
      for (const ci of callItems.slice(0, 10)) {
        const full = await fetch(`/erp/api/interactions/${ci.id}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
        if (full.call_summary) return full
      }
      return null
    })
    assert.ok(data, 'au moins un appel doit avoir un summary (backfill effectué)')
    assert.ok(typeof data.call_summary === 'string' && data.call_summary.length > 0)
    // next_steps may be null for calls with no actions — only assert it's a string when present
    if (data.call_next_steps) assert.ok(data.call_next_steps.includes('-'), 'next_steps formatté en bullets')
  })

  test('UI ContactDetail affiche Résumé sur le timeline pour un appel ayant un summary', async () => {
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    // Find a contact_id whose interaction (call) has a summary
    const contactId = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const j = await fetch('/erp/api/interactions?limit=50', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      const calls = (j.interactions || []).filter(i => i.type === 'call' && i.contact_id)
      for (const c of calls.slice(0, 15)) {
        const full = await fetch(`/erp/api/interactions/${c.id}`, { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
        if (full.call_summary) return full.contact_id
      }
      return null
    })
    assert.ok(contactId, 'un appel avec summary attaché à un contact doit exister')
    await page.goto(`${URL}/contacts/${contactId}`, { waitUntil: 'domcontentloaded' })
    // Click on a timeline item with type 'call' to open the detail modal
    await page.locator('text=/Philippe Chabot/').first().waitFor({ timeout: 10000 })
    // Find the call item and click it (the timeline shows audio for calls)
    const callBubble = page.locator('audio[src*="/calls/"]').first()
    await callBubble.waitFor({ timeout: 5000 })
    // Click the parent bubble (audio is inside a bubble that has onclick)
    await callBubble.locator('xpath=ancestor::*[@role="button" or contains(@class,"cursor-pointer")][1]').first().click({ timeout: 3000 }).catch(() => {})
    // Detail modal should now show "Résumé" header
    const summaryVisible = await page.locator('text=/Résumé/').first().waitFor({ timeout: 8000 }).then(() => true).catch(() => false)
    assert.ok(summaryVisible, "le bloc 'Résumé' doit être visible dans la modal détail")
    assert.deepStrictEqual(errors, [], 'aucune erreur JS')
  })
})
