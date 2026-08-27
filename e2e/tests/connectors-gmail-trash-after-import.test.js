const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Connecteur Gmail — toggle « Corbeille après import »', () => {
  let browser, ctx, page, token
  // La config est partagée (connector_config) : on capture la valeur d'origine
  // et on la restaure en after() pour ne rien écraser.
  let originalValue = null

  async function apiGet(path) {
    return page.evaluate(async ({ path, token }) => {
      const r = await fetch(`/erp/api${path}`, { headers: { Authorization: `Bearer ${token}` } })
      return r.json()
    }, { path, token })
  }

  async function apiPutConfig(value) {
    return page.evaluate(async ({ token, value }) => {
      const r = await fetch('/erp/api/connectors/config/google', {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_trash_after_import_mailboxes: value }),
      })
      return r.ok
    }, { token, value })
  }

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

    const data = await apiGet('/connectors')
    originalValue = data?.config?.google?.invoice_trash_after_import_mailboxes ?? null
  })

  after(async () => {
    // Restaure la config d'origine ('[]' si la clé n'existait pas : la route PUT
    // fait un upsert, on ne peut pas supprimer la clé — une liste vide est
    // strictement équivalente à l'absence de clé côté serveur).
    if (page && token) await apiPutConfig(originalValue ?? '[]')
    await browser?.close()
  })

  test('le toggle est visible, s\'active avec autosave et persiste côté serveur', async () => {
    await page.goto(`${URL}/connectors`, { waitUntil: 'networkidle' })
    await page.locator('button:has-text("Gmail")').first().click()

    const label = page.locator('label:has-text("Corbeille après import")').first()
    await label.waitFor({ state: 'visible', timeout: 5000 })

    // Email du compte de la ligne qui porte ce toggle
    const row = label.locator('xpath=ancestor::div[contains(@class,"justify-between")][1]')
    const accountEmail = (await row.locator('span').first().textContent()).trim().toLowerCase()
    assert.ok(accountEmail.includes('@'), `email de compte introuvable: ${accountEmail}`)

    const checkbox = label.locator('input[type="checkbox"]')
    const wasChecked = await checkbox.isChecked()

    // Case autosave : .click() puis validation par poll API (pas le DOM immédiat)
    await checkbox.click()

    let persisted = null
    for (let i = 0; i < 20; i++) {
      const data = await apiGet('/connectors')
      const raw = data?.config?.google?.invoice_trash_after_import_mailboxes || '[]'
      let list = []
      try { list = JSON.parse(raw) } catch {}
      const nowIncluded = list.includes(accountEmail)
      if (nowIncluded === !wasChecked) { persisted = list; break }
      await page.waitForTimeout(250)
    }
    assert.ok(persisted !== null, 'le toggle n\'a pas été persisté côté serveur après 5s')

    // Re-toggle pour revenir à l'état initial (le after() restaure de toute façon)
    await checkbox.click()
    await page.waitForTimeout(500)
  })
})
