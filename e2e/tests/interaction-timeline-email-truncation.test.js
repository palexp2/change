const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Nouveau flux : la timeline ressemble à un fil de messagerie.
// Le corps des emails s'affiche inline par défaut (stripé de la chaîne de
// reply et de la signature). Cliquer sur une bulle ouvre une modale avec tous
// les détails (date précise, from, to, contact) et un bouton pour révéler la
// chaîne et la signature.
describe('Timeline interactions — affichage thread-like avec modale détail', () => {
  let browser, ctx, page, contactId

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    // Trouver un contact dont au moins un email contient une portion quotée
    contactId = await page.evaluate(async () => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/interactions?limit=all', { headers: { Authorization: `Bearer ${token}` } })
      const all = (await r.json()).interactions || []
      const emails = all.filter(i => i.type === 'email' && i.contact_id)
      for (const e of emails) {
        const body = await fetch(`/erp/api/interactions/${e.id}/email-body`, { headers: { Authorization: `Bearer ${token}` } })
        if (!body.ok) continue
        const data = await body.json()
        if (data.body_html && data.body_html.includes('gmail_quote')) return e.contact_id
      }
      return null
    })
    if (!contactId) throw new Error('Aucun contact avec un email contenant gmail_quote trouvé')
  })

  after(async () => { await browser?.close() })

  test('corps des emails affiché inline par défaut, sans quote ni signature', async () => {
    await page.goto(`${URL}/contacts/${contactId}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('text=/Courriel/', { timeout: 10000 })

    // Le corps doit apparaître inline dans la bulle — pas besoin de cliquer
    // sur "Voir le contenu" (qui n'existe plus).
    const inlineIframe = page.locator('iframe').first()
    await inlineIframe.waitFor({ state: 'visible', timeout: 5000 })

    const stripped = await inlineIframe.evaluate(el => el.contentDocument?.body?.innerHTML || '')
    assert.ok(stripped.length > 0, 'iframe inline doit avoir du contenu')
    assert.ok(!/gmail_quote/.test(stripped), 'pas de gmail_quote inline')
    assert.ok(!/gmail_signature/.test(stripped), 'pas de gmail_signature inline')

    // Le bouton "Voir le contenu" ne doit plus exister
    assert.equal(
      await page.locator('button:has-text("Voir le contenu")').count(),
      0,
      'bouton "Voir le contenu" ne devrait plus exister',
    )
  })

  test('clic sur la bulle ouvre une modale avec détails et toggle chaîne/signature', async () => {
    await page.goto(`${URL}/contacts/${contactId}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('text=/Courriel/', { timeout: 10000 })

    // Cliquer sur la première bulle Courriel
    // On vise le conteneur cliquable (rounded-2xl avec cursor-pointer)
    const firstBubble = page.locator('[class*="cursor-pointer"]:has-text("Courriel")').first()
    await firstBubble.click()

    // Modale ouverte
    const modalTitle = page.locator('h2:has-text("Courriel")')
    await modalTitle.waitFor({ state: 'visible', timeout: 3000 })

    // Les champs détails From/À sont présents dans la modale
    await page.locator('dt:has-text("De")').first().waitFor({ state: 'visible' })
    await page.locator('dt:has-text("À")').first().waitFor({ state: 'visible' })
    await page.locator('dt:has-text("Date")').first().waitFor({ state: 'visible' })

    // Bouton pour afficher la chaîne et signature
    const toggle = page.locator('button:has-text("Afficher chaîne et signature")').first()
    await toggle.waitFor({ state: 'visible', timeout: 3000 })
    await toggle.click()

    // Après clic, le bouton change de libellé
    await page.locator('button:has-text("Masquer chaîne et signature")').first()
      .waitFor({ state: 'visible', timeout: 2000 })
  })
})
