const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('AutomationDetail — aperçu du courriel', () => {
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

  test('API GET /automations/sys_installation_followup/email-preview retourne subject + bodyHtml (FR)', async () => {
    const res = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/automations/sys_installation_followup/email-preview?language=French', {
        headers: { Authorization: `Bearer ${token}` },
      })
      return { status: r.status, body: await r.json() }
    })
    assert.strictEqual(res.status, 200)
    assert.strictEqual(res.body.available, true)
    assert.strictEqual(res.body.kind, 'system')
    assert.ok(res.body.subject && /installation/i.test(res.body.subject), `sujet attendu contient "installation", got "${res.body.subject}"`)
    assert.ok(res.body.bodyHtml && res.body.bodyHtml.includes('<body'), 'bodyHtml doit contenir un body HTML')
    assert.strictEqual(res.body.language, 'French')
  })

  test('API language=English retourne un sujet en anglais', async () => {
    const body = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/automations/sys_installation_followup/email-preview?language=English', {
        headers: { Authorization: `Bearer ${token}` },
      })
      return r.json()
    })
    assert.match(body.subject, /installation/i)
    assert.strictEqual(body.language, 'English')
    // Subject must differ from French version
    assert.notStrictEqual(body.subject, "Comment s'est passé l'installation ?")
  })

  test('API pour une automation non-email (script custom) renvoie available=false', async () => {
    // Find any non-email automation (script or field_rule non-email)
    const target = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const list = await fetch('/erp/api/automations', { headers: { Authorization: `Bearer ${token}` } }).then(r => r.json())
      return list.find(a => a.kind !== 'field_rule' && !['sys_installation_followup', 'sys_shipment_tracking_email'].includes(a.id))
    })
    if (!target) {
      // No such automation exists — skip gracefully
      return
    }
    const body = await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/automations/${id}/email-preview`, { headers: { Authorization: `Bearer ${token}` } })
      return r.json()
    }, target.id)
    assert.strictEqual(body.available, false)
    assert.ok(body.reason, 'doit fournir une raison')
  })

  test('UI : la section "Aperçu du courriel" s\'affiche sur sys_installation_followup', async () => {
    await page.goto(`${URL}/automations/sys_installation_followup`, { waitUntil: 'networkidle' })
    // Attendre le header de section
    const header = page.locator('h2:has-text("Aperçu du courriel")')
    await header.waitFor({ state: 'visible', timeout: 10000 })
    // L'iframe d'aperçu doit être présent et chargé
    const frame = page.frameLocator('iframe[title="Aperçu courriel"]')
    // Cherche un mot attendu du template (bouton "Super c'est fait !" en FR)
    await frame.locator('text=/Super|Great/').first().waitFor({ state: 'visible', timeout: 5000 })
  })
})
