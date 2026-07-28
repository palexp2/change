const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Chaque achat publié sur QuickBooks expose un lien « Ouvrir dans QuickBooks » :
// colonne QB dans la liste + badge « Publié » cliquable. Lecture seule — aucun
// record créé ni modifié.
describe('AchatsFournisseurs — lien QuickBooks sur les factures/dépenses', () => {
  let browser, ctx, page

  const apiFetch = (path) => page.evaluate(async (path) => {
    const tok = localStorage.getItem('erp_token')
    const r = await fetch(`/erp/api${path}`, { headers: { Authorization: `Bearer ${tok}` } })
    return { status: r.status, body: await r.json().catch(() => null) }
  }, path)

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => { await browser?.close() })

  test('l\'API expose qb_url sur les achats liés à QB', async () => {
    await page.goto(`${URL}/achats-fournisseurs`, { waitUntil: 'domcontentloaded' })
    const r = await apiFetch('/achats-fournisseurs?limit=50')
    assert.equal(r.status, 200)
    const linked = r.body.data.filter(a => a.quickbooks_id)
    assert.ok(linked.length > 0, 'aucun achat lié à QB dans la première page')
    for (const a of linked) {
      assert.ok(a.qb_url && a.qb_url.includes('qbo.intuit.com'), `qb_url manquant/invalide sur ${a.id}`)
      assert.ok(a.qb_url.includes(a.type === 'bill' ? '/app/bill' : '/app/expense'), `slug d'URL inattendu : ${a.qb_url}`)
    }
  })

  test('la liste affiche la colonne QB avec lien « Ouvrir dans QuickBooks »', async () => {
    // DataTable est un grid en <div> — on attend directement le premier lien QB.
    const link = page.locator('a[title="Ouvrir dans QuickBooks"]').first()
    await link.waitFor({ state: 'visible', timeout: 15000 })
    const href = await link.getAttribute('href')
    assert.ok(href.includes('qbo.intuit.com'), `href inattendu : ${href}`)
    assert.equal(await link.getAttribute('target'), '_blank')
  })
})
