const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const { randomUUID } = require('crypto')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie que le bouton "Envoyer par email" sur une facture pending ouvre la
// nouvelle modale d'édition (To / Sujet / Message) pré-remplie depuis
// /email-defaults, et que la requête de send envoie bien les champs custom.
describe('FactureDetail — modale d\'envoi du lien de paiement', () => {
  let browser, ctx, page, db
  let companyId
  let pendingId
  let originalCompanyEmail

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
    const co = db.prepare(`SELECT id, email FROM companies WHERE deleted_at IS NULL LIMIT 1`).get()
    if (!co) throw new Error('Aucune company — impossible de tester')
    companyId = co.id
    originalCompanyEmail = co.email
    // Force un email connu pour le test
    db.prepare(`UPDATE companies SET email='client-e2e@orisha.test' WHERE id=?`).run(companyId)

    pendingId = randomUUID()
    db.prepare(`
      INSERT INTO pending_invoices (id, company_id, currency, items_json,
        shipping_province, shipping_country, due_days, status, created_by)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(
      pendingId, companyId, 'CAD',
      JSON.stringify([{ qty: 1, unit_price: 1234.56, description: 'Test ligne E2E' }]),
      'QC', 'Canada', 30, 'draft', null,
    )

    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => {
    try {
      if (pendingId) db.prepare('DELETE FROM pending_invoices WHERE id=?').run(pendingId)
      if (companyId) db.prepare('UPDATE companies SET email=? WHERE id=?').run(originalCompanyEmail, companyId)
    } catch {}
    db?.close()
    await browser?.close()
  })

  test('clic sur Envoyer ouvre la modale, champs pré-remplis et send envoie les overrides', async () => {
    await page.goto(`${URL}/factures/${pendingId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')

    const sendBtn = page.locator('button:has-text("Envoyer par email")').first()
    await sendBtn.waitFor({ state: 'visible', timeout: 5000 })
    await sendBtn.click()

    // Modale visible + pré-remplie
    await page.waitForSelector('text=Envoyer le lien de paiement', { timeout: 5000 })
    const toInput = page.locator('input[type="email"]').first()
    await toInput.waitFor({ state: 'visible', timeout: 5000 })
    const toValue = await toInput.inputValue()
    assert.equal(toValue, 'client-e2e@orisha.test', `Devrait pré-remplir avec l'email de la company, vu : "${toValue}"`)

    const subjectInput = page.locator('input[type="text"]').first()
    const subjectVal = await subjectInput.inputValue()
    assert.match(subjectVal, /Facture Orisha/, `Sujet par défaut attendu, vu : "${subjectVal}"`)

    const messageArea = page.locator('textarea')
    const messageVal = await messageArea.inputValue()
    assert.match(messageVal, /Bonjour/, `Le message doit commencer par "Bonjour", vu : "${messageVal.slice(0, 80)}"`)

    // Modifie les champs
    await toInput.fill('autre@orisha.test')
    await subjectInput.fill('Sujet personnalisé E2E')
    await messageArea.fill('Message custom E2E.\n\nDeuxième paragraphe.')

    // Intercepte la requête /send pour vérifier le body
    let sentBody = null
    await page.route('**/api/stripe-invoices/*/send', async route => {
      const req = route.request()
      try { sentBody = JSON.parse(req.postData() || '{}') } catch { sentBody = {} }
      // Répond succès simulé pour ne pas dépendre de Gmail
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ok: true,
          pending_invoice_id: pendingId,
          email: { sent_to: 'autre@orisha.test', from: 'noreply@orisha.io', message_id: 'mock' },
        }),
      })
    })

    await page.locator('button:has-text("Envoyer")').last().click()
    await page.waitForFunction(() => !document.querySelector('h2')?.textContent?.includes('Envoyer le lien de paiement'), null, { timeout: 5000 })

    assert.ok(sentBody, 'La requête /send devrait avoir été interceptée')
    assert.equal(sentBody.to, 'autre@orisha.test')
    assert.equal(sentBody.subject, 'Sujet personnalisé E2E')
    assert.match(sentBody.message, /Message custom E2E\./)
    assert.match(sentBody.message, /Deuxième paragraphe\./)
  })
})
