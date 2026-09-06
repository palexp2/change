const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie le picker LinkedRecordField sur FactureDetail (company_id) :
// délier → état vide, ré-attacher → autosave, navigation via le chip.
describe('FactureDetail — picker entreprise (LinkedRecordField)', () => {
  let browser, ctx, page, token, factureId, originalCompanyId, targetCompany
  const FIELD = '[data-testid="linked-record-field-company_id"]'

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

    // Une facture qui a déjà une entreprise — on capture l'original pour pouvoir restaurer.
    // Filtre les pending_invoices (source='pending') qui ne sont pas patchables.
    const factures = await page.evaluate(async (tok) => {
      const r = await fetch('/erp/api/projets/factures?limit=all', { headers: { Authorization: `Bearer ${tok}` } })
      const j = await r.json()
      return (j.data || []).filter(f => f.company_id && f.invoice_id).slice(0, 1)
    }, token)
    assert.ok(factures.length > 0, 'au moins une facture liée à une entreprise est requise')
    factureId = factures[0].id
    originalCompanyId = factures[0].company_id

    // Une autre entreprise vers laquelle re-pointer
    const companies = await page.evaluate(async (tok) => {
      const r = await fetch('/erp/api/companies/lookup', { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    }, token)
    targetCompany = companies.find(c => c.id !== originalCompanyId)
    assert.ok(targetCompany, 'une seconde entreprise est requise')
  })

  after(async () => {
    if (factureId && originalCompanyId) {
      await page.evaluate(async ({ tok, id, cid }) => {
        await fetch(`/erp/api/projets/factures/${id}`, {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ company_id: cid }),
        })
      }, { tok: token, id: factureId, cid: originalCompanyId })
    }
    await browser?.close()
  })

  test('Le picker affiche le chip de l\'entreprise actuelle', async () => {
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    const field = page.locator(FIELD)
    await field.waitFor({ timeout: 10000 })
    assert.equal(await field.getAttribute('data-state'), 'selected', 'doit afficher le chip')
    await field.locator('[data-testid="linked-record-link"]').waitFor({ timeout: 5000 })
  })

  test('Le x délie → état vide + DB à null', async () => {
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    const field = page.locator(FIELD)
    await field.waitFor({ timeout: 5000 })
    await field.locator('[data-testid="linked-record-clear"]').click()
    await page.waitForFunction(
      sel => document.querySelector(sel)?.getAttribute('data-state') === 'empty',
      FIELD,
      { timeout: 5000 }
    )
    const fresh = await page.evaluate(async ({ tok, id }) => {
      const r = await fetch(`/erp/api/projets/factures/${id}`, { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    }, { tok: token, id: factureId })
    assert.equal(fresh.company_id, null, 'company_id doit être null en DB')
  })

  test('Le + ouvre le portail recherchable et permet de re-lier', async () => {
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    const field = page.locator(FIELD)
    await field.locator('[data-testid="linked-record-add"]').click()
    const portal = page.locator('#linked-record-portal')
    await portal.waitFor({ timeout: 5000 })
    await portal.locator('input[placeholder="Rechercher..."]').fill(targetCompany.name.slice(0, Math.min(6, targetCompany.name.length)))
    await portal.locator('button', { hasText: targetCompany.name }).first().click()
    await page.waitForFunction(
      sel => document.querySelector(sel)?.getAttribute('data-state') === 'selected',
      FIELD,
      { timeout: 5000 }
    )
    const fresh = await page.evaluate(async ({ tok, id }) => {
      const r = await fetch(`/erp/api/projets/factures/${id}`, { headers: { Authorization: `Bearer ${tok}` } })
      return r.json()
    }, { tok: token, id: factureId })
    assert.equal(fresh.company_id, targetCompany.id, 'company_id mis à jour en DB')
  })

  test('Le chip est cliquable et navigue vers /companies/:id', async () => {
    await page.goto(`${URL}/factures/${factureId}`, { waitUntil: 'networkidle' })
    const field = page.locator(FIELD)
    await field.waitFor({ timeout: 5000 })
    const href = await field.locator('[data-testid="linked-record-link"]').getAttribute('href')
    assert.ok(href.endsWith(`/companies/${targetCompany.id}`), `href doit pointer vers /companies/${targetCompany.id}`)
    await field.locator('[data-testid="linked-record-link"]').click()
    await page.waitForURL(new RegExp(`/companies/${targetCompany.id}`), { timeout: 5000 })
  })
})
