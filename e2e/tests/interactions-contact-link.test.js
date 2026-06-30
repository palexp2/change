const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie que la colonne contact_name du tableau des interactions rend un
// <Link> vers /contacts/:id (règle FK), et non un simple texte.
// Test purement lecture : aucun record créé ni config modifiée → pas de cleanup.
describe('Interactions — colonne contact_name cliquable', () => {
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

  test('le nom du contact est un lien vers /contacts/:id', async () => {
    // Récupère la liste via API pour trouver une interaction qui porte un contact_id
    const listResp = page.waitForResponse(
      r => /\/api\/interactions\?/.test(r.url()) && r.ok(),
      { timeout: 15000 }
    )
    await page.goto(`${URL}/interactions`, { waitUntil: 'domcontentloaded' })
    const list = await (await listResp).json()
    const withContact = list.interactions.find(r => r.contact_id && r.contact_name?.trim())

    if (!withContact) {
      // Pas de donnée avec contact lié : on ne peut pas valider le rendu — on le signale.
      assert.fail('Aucune interaction avec contact_id+contact_name en DB pour valider le lien')
    }

    // La vue active par défaut peut porter des filtres masquant toutes les lignes.
    // On bascule sur la vue sans filtre « Toutes les interactions » (sélection de
    // pill = état local localStorage, non persisté côté serveur → pas de mutation
    // de config à restaurer).
    const allPill = page.locator('button:has-text("Tou"), [role="tab"]:has-text("Tou")').filter({ hasText: /int.ractions/i }).first()
    if (await allPill.count()) {
      await allPill.click().catch(() => {})
    }

    // Attendre que le tableau soit rendu, puis localiser le lien contact dans la colonne
    await page.waitForSelector('a[href*="/contacts/"]', { timeout: 10000 })
    const link = page.locator(`a[href$="/contacts/${withContact.contact_id}"]`).first()
    await link.waitFor({ timeout: 10000 })
    const href = await link.getAttribute('href')
    assert.ok(href.endsWith(`/contacts/${withContact.contact_id}`), `href pointe vers la fiche contact (${href})`)

    // Cliquer doit naviguer vers la fiche contact sans ouvrir le panneau détail interaction
    await link.click()
    await page.waitForURL(u => u.toString().includes(`/contacts/${withContact.contact_id}`), { timeout: 10000 })
    assert.ok(page.url().includes(`/contacts/${withContact.contact_id}`), 'navigation vers la fiche contact')
  })
})
