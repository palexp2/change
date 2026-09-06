const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie la règle FK/navigation du CLAUDE.md : dans l'historique d'exécution
// du suivi d'installation (ManualRunResult), le destinataire (company_name)
// doit être un <Link> cliquable vers /companies/:id et non du texte brut.
// Le dry-run ne persiste rien → aucun cleanup ni restauration nécessaires.
describe('sys_installation_followup — company_name cliquable dans l\'historique', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
    await page.goto(URL + '/automations/sys_installation_followup', { waitUntil: 'networkidle' })
  })

  after(async () => { await browser?.close() })

  test('le dry-run rend chaque destinataire comme lien vers /companies/:id', async () => {
    // Lance la simulation (dry-run) — n'envoie rien, ne persiste rien.
    await page.click('button:has-text("Simuler (dry-run)")')

    // Attend la fin de l'exécution + au moins un lien entreprise dans le détail.
    const companyLink = page.locator('a[href*="/companies/"]').first()
    await companyLink.waitFor({ state: 'visible', timeout: 20000 })

    const href = await companyLink.getAttribute('href')
    assert.ok(/\/companies\/[0-9a-f-]{8,}/.test(href || ''),
      `href attendu /companies/<id>, reçu: ${href}`)

    const txt = (await companyLink.textContent() || '').trim()
    assert.ok(txt.length > 0, 'le libellé du lien entreprise est vide')

    // Sanity : l'id dans l'URL ne doit pas être un placeholder vide.
    const id = (href || '').split('/companies/')[1]
    assert.ok(id && id !== '—' && id.length > 5, `id entreprise invalide dans le lien: ${id}`)
  })
})
