// Connecteurs — le sous-titre nomme l'application « Boréal », pas « l'ERP ».
//
// Demande utilisateur : « À Boréal, pas à l'ERP. » sur le sous-titre de
// /admin/connecteurs.
//
// Test en LECTURE SEULE : navigation + assertions de texte, aucun record créé
// ni configuration écrasée → rien à nettoyer.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

describe('Connecteurs — sous-titre « à Boréal »', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)
  })

  after(async () => { await browser?.close() })

  test('le sous-titre dit « Intégrez vos outils externes à Boréal »', async () => {
    await page.goto(URL + '/admin/connecteurs', { waitUntil: 'networkidle' })
    await page.waitForSelector('h2:has-text("Connecteurs")', { timeout: 10000 })

    await page.waitForSelector('text=Intégrez vos outils externes à Boréal', { timeout: 10000 })

    assert.equal(await page.locator('text=Intégrez vos outils externes à l\'ERP').count(), 0,
      'l\'ancien sous-titre « … à l\'ERP » ne doit plus apparaître')
  })
})
