const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Bug : le bouton « Sondage » restait désactivé après l'ajout d'un contact à
// un billet qui n'en avait pas — il fallait recharger la page pour que
// l'éligibilité (calculée côté serveur à partir du contact) se remette à
// jour. Ce test ajoute un contact via le picker de la fiche, sans recharger,
// et vérifie que le bouton se débloque.
describe('TicketDetail — bouton Sondage se débloque après ajout d\'un contact', () => {
  let browser, ctx, page, token, ticketId, contactId

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))

    const suffix = Date.now()
    const ticketRes = await page.evaluate(async (tok) => {
      const r = await fetch('/erp/api/tickets', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: `E2E survey unlock ${Date.now()}`, type: 'Support', status: 'Waiting on us' }),
      })
      return { status: r.status, data: await r.json() }
    }, token)
    assert.equal(ticketRes.status, 201, `create ticket: ${JSON.stringify(ticketRes.data)}`)
    ticketId = ticketRes.data.id

    const contactRes = await page.evaluate(async ({ tok, suffix }) => {
      const r = await fetch('/erp/api/contacts', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          first_name: 'E2ESurvey',
          last_name: `Unlock${suffix}`,
          mobile: '5145550199',
          language: 'French',
        }),
      })
      return { status: r.status, data: await r.json() }
    }, { tok: token, suffix })
    assert.equal(contactRes.status, 201, `create contact: ${JSON.stringify(contactRes.data)}`)
    contactId = contactRes.data.id
  })

  after(async () => {
    if (ticketId) {
      await page.evaluate(async ({ tok, id }) => {
        await fetch(`/erp/api/tickets/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } })
      }, { tok: token, id: ticketId })
    }
    if (contactId) {
      await page.evaluate(async ({ tok, id }) => {
        await fetch(`/erp/api/contacts/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${tok}` } })
      }, { tok: token, id: contactId })
    }
    await browser?.close()
  })

  test('ajouter un contact sans recharger débloque le bouton Sondage', async () => {
    await page.goto(`${URL}/tickets/${ticketId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')

    const surveyBtn = page.locator('[data-testid="ticket-survey-button"]')
    await surveyBtn.waitFor({ state: 'visible', timeout: 10000 })
    assert.equal(await surveyBtn.isDisabled(), true, 'le bouton doit être désactivé sans contact')

    // Ajoute le contact via le picker du champ "Contact" de la fiche.
    const contactField = page.locator('[data-testid="linked-record-field-contact_id"]')
    await contactField.locator('[data-testid="linked-record-add"]').click()
    const portal = page.locator('#linked-record-portal')
    await portal.waitFor({ state: 'visible', timeout: 5000 })
    await portal.locator('input[placeholder="Rechercher..."]').fill('E2ESurvey')
    await portal.locator(`button:has-text("E2ESurvey")`).first().click()

    // Attend la confirmation de sauvegarde (le champ affiche le nom lié).
    await page.locator('[data-testid="linked-record-link"]').waitFor({ state: 'visible', timeout: 5000 })

    // Sans aucun rechargement de page, le bouton doit maintenant être actif.
    await page.waitForFunction(() => {
      const btn = document.querySelector('[data-testid="ticket-survey-button"]')
      return btn && !btn.disabled
    }, null, { timeout: 5000 })

    assert.equal(await surveyBtn.isDisabled(), false, 'le bouton doit être débloqué après ajout du contact, sans reload')
  })
})
