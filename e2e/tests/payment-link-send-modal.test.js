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

// Vérifie le flux d'envoi du lien de paiement :
//  1. Le bouton "Envoyer par email" ouvre la modale d'édition (To / Sujet / Message)
//     pré-remplie depuis /email-defaults.
//  2. Le clic "Envoyer" ouvre une modale de CONFIRMATION du side effect listant
//     explicitement l'adresse destinataire.
//  3. Après confirmation, un toast d'annulation (barre 10 s) apparaît et l'envoi
//     réel n'est déclenché qu'à la fin du compte à rebours (avec les overrides).
//  4. Le bouton "Annuler" du toast empêche tout appel /send.
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

  // Ouvre la modale d'envoi et renvoie le locator du champ "to".
  async function openSendModal() {
    await page.goto(`${URL}/factures/${pendingId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')
    const sendBtn = page.locator('button:has-text("Envoyer par email")').first()
    await sendBtn.waitFor({ state: 'visible', timeout: 5000 })
    await sendBtn.click()
    await page.waitForSelector('text=Envoyer le lien de paiement', { timeout: 5000 })
    const toInput = page.locator('input[type="email"]').first()
    await toInput.waitFor({ state: 'visible', timeout: 5000 })
    return toInput
  }

  test('Envoyer → confirmation → toast 10 s → envoi des overrides à la fin du compte à rebours', async () => {
    const toInput = await openSendModal()

    // Pré-remplissage — on scope les champs à la modale (la page a d'autres
    // <textarea>/<input> par ailleurs).
    const dialog = page.locator('[role="dialog"]')
    assert.equal(await toInput.inputValue(), 'client-e2e@orisha.test')
    const subjectInput = dialog.locator('input[type="text"]').first()
    assert.match(await subjectInput.inputValue(), /Facture Orisha/)
    const messageArea = dialog.locator('textarea').first()
    assert.match(await messageArea.inputValue(), /Bonjour/)

    // Modifie les champs
    await toInput.fill('autre@orisha.test')
    await subjectInput.fill('Sujet personnalisé E2E')
    await messageArea.fill('Message custom E2E.\n\nDeuxième paragraphe.')

    // Intercepte /send (réponse simulée pour ne pas dépendre de Gmail).
    let sentBody = null
    let sendCount = 0
    await page.route('**/api/stripe-invoices/*/send', async route => {
      sendCount++
      try { sentBody = JSON.parse(route.request().postData() || '{}') } catch { sentBody = {} }
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

    // Clic "Envoyer" de la modale → la modale de CONFIRMATION doit apparaître.
    await page.locator('button:has-text("Envoyer")').last().click()
    await page.waitForSelector('text=Confirmer l\'envoi du courriel', { timeout: 5000 })
    // La confirmation doit lister explicitement l'adresse destinataire.
    assert.ok(
      await page.locator('text=autre@orisha.test').count() > 0,
      'la modale de confirmation doit afficher l\'adresse destinataire',
    )
    // Aucun envoi tant qu'on n'a pas confirmé.
    assert.equal(sendCount, 0, 'aucun /send avant confirmation')

    // Confirme l'envoi (bouton "Envoyer" de la modale de confirmation).
    await page.locator('button:has-text("Envoyer")').last().click()

    // Le toast d'annulation (barre 10 s) doit apparaître, et /send ne doit PAS
    // encore avoir été appelé.
    await page.locator('[data-testid="undo-send-toast"]').waitFor({ state: 'visible', timeout: 5000 })
    assert.equal(sendCount, 0, '/send ne doit pas partir avant la fin du compte à rebours')

    // À la fin du compte à rebours, l'envoi part : on attend le toast de succès
    // (émis seulement après l'appel API terminé).
    await page.locator('text=Courriel envoyé à autre@orisha.test').first().waitFor({ state: 'visible', timeout: 14000 })
    assert.equal(sendCount, 1)
    assert.equal(sentBody.to, 'autre@orisha.test')
    assert.equal(sentBody.subject, 'Sujet personnalisé E2E')
    assert.match(sentBody.message, /Message custom E2E\./)
    assert.match(sentBody.message, /Deuxième paragraphe\./)
  })

  test('Annuler dans le toast empêche tout appel /send', async () => {
    const toInput = await openSendModal()
    await toInput.fill('annule@orisha.test')

    let sendCount = 0
    await page.route('**/api/stripe-invoices/*/send', async route => {
      sendCount++
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
    })

    // Envoyer → confirmer.
    await page.locator('button:has-text("Envoyer")').last().click()
    await page.waitForSelector('text=Confirmer l\'envoi du courriel', { timeout: 5000 })
    await page.locator('button:has-text("Envoyer")').last().click()

    // Toast visible → on clique "Annuler".
    const toast = page.locator('[data-testid="undo-send-toast"]')
    await toast.waitFor({ state: 'visible', timeout: 5000 })
    await page.locator('[data-testid="undo-send-cancel"]').click()

    // Toast disparaît + message "Envoi annulé".
    await toast.waitFor({ state: 'hidden', timeout: 5000 })
    await page.locator('text=Envoi annulé').first().waitFor({ state: 'visible', timeout: 5000 })

    // Au-delà du compte à rebours (10 s), aucun /send ne doit avoir été émis.
    await page.waitForTimeout(11000)
    assert.equal(sendCount, 0, 'aucun /send après annulation')
  })
})
