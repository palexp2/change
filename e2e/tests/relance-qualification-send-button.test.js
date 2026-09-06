const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie l'UI du bouton "Envoyer" sur la page Relance Qualification :
//  - Bouton visible sur chaque carte d'email
//  - Disabled si pas de contact avec courriel
//  - Ouvre une modale de confirmation listant destinataire, sujet, aperçu corps
//  - "Annuler" referme sans envoyer
//  - Backend /send/:qcId rejette un qcId inexistant (route bien montée)
//
// Note: on n'envoie PAS de vrai courriel pour ne pas polluer le compte Gmail
// et ne pas dépendre d'une connexion Google côté CI. La logique d'envoi est
// vérifiée par le 404 de la route + par symétrie avec stripe-invoices.js.
describe('RelanceQualification — bouton Envoyer + modale', () => {
  let browser, ctx, page, db
  let firstCompanyName

  before(async () => {
    db = new Database(DB_PATH, { readonly: true })
    // On veut une company avec QC + Quote Sent + contact avec email + draft IA
    // déjà généré (sinon le bouton Envoyer est disabled — il faut un email pour
    // l'envoyer). Si aucune ne matche, le test est ignoré.
    const candidate = db.prepare(`
      SELECT c.id, c.name
      FROM qualification_calls q
      JOIN companies c ON c.id = q.company_id
      JOIN contacts ct ON ct.company_id = c.id AND ct.email IS NOT NULL AND ct.email <> ''
      JOIN email_relance_drafts d ON d.qc_id = q.id
      WHERE q.company_id IS NOT NULL AND c.lifecycle_phase = 'Quote Sent'
      GROUP BY c.id
      ORDER BY c.name
      LIMIT 1
    `).get()
    if (!candidate) throw new Error('Aucune company QC + Quote Sent + contact email + draft — test impossible. Génère au moins un courriel IA sur la page Relance Qualification.')
    firstCompanyName = candidate.name

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
    db?.close()
    await browser?.close()
  })

  test('bouton Envoyer visible + modale de confirmation s\'ouvre + Annuler referme', async () => {
    await page.goto(`${URL}/relance-qualification`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')

    // Au moins un bouton Envoyer doit être présent
    const sendBtn = page.locator('button:has-text("Envoyer")').first()
    await sendBtn.waitFor({ state: 'visible', timeout: 10000 })

    // Cible la carte de la company qui a un contact avec email — son bouton
    // doit être activé (pas disabled)
    const card = page.locator('article', { hasText: firstCompanyName }).first()
    await card.waitFor({ state: 'visible', timeout: 10000 })
    const cardSendBtn = card.locator('button:has-text("Envoyer")').first()
    const isDisabled = await cardSendBtn.isDisabled()
    assert.equal(isDisabled, false, `Le bouton Envoyer pour ${firstCompanyName} doit être actif (contact a un email)`)

    // Capture le sujet courant de la carte pour vérifier qu'il apparaît dans la modale
    const cardSubject = await card.locator('input[type="text"]').first().inputValue()
    assert.ok(cardSubject && cardSubject.length > 0, 'La carte doit avoir un sujet')

    // Ouvre la modale
    await cardSendBtn.click()

    // Modale visible avec les éléments attendus
    await page.locator('h3:has-text("Envoyer le courriel")').waitFor({ state: 'visible', timeout: 5000 })
    await page.locator('label:has-text("Destinataire")').waitFor({ state: 'visible', timeout: 5000 })
    await page.locator('text=Expéditeur').waitFor({ state: 'visible', timeout: 5000 })
    await page.locator('text=Aperçu du corps').waitFor({ state: 'visible', timeout: 5000 })

    // Destinataire est un input éditable, pré-rempli avec l'email du contact
    const recipientInput = page.locator('input[type="email"]')
    await recipientInput.waitFor({ state: 'visible', timeout: 5000 })
    const initialRecipient = await recipientInput.inputValue()
    assert.ok(initialRecipient.includes('@'), `Destinataire initial doit être un email (vu: ${initialRecipient})`)

    // L'input doit être modifiable
    await recipientInput.fill('autre.adresse@exemple.com')
    assert.equal(await recipientInput.inputValue(), 'autre.adresse@exemple.com')

    // Validation : adresse invalide → message d'erreur
    await recipientInput.fill('pas-un-email')
    await page.locator('text=Adresse courriel invalide').waitFor({ state: 'visible', timeout: 3000 })

    // Restaurer une adresse valide
    await recipientInput.fill(initialRecipient)

    // Expéditeur : doit afficher le compte Gmail réel OU 'Aucun compte Gmail connecté'
    // Le test user claude@orisha.io n'a pas de Gmail connecté → on s'attend au message d'erreur.
    await page.locator('text=Aucun compte Gmail connecté').waitFor({ state: 'visible', timeout: 5000 })

    // Le sujet courant de la carte doit apparaître dans la modale
    await page.locator(`text=${cardSubject}`).first().waitFor({ state: 'visible', timeout: 5000 })

    // Bouton "Envoyer maintenant" doit être DISABLED car pas de compte Gmail connecté
    const confirmBtn = page.locator('button:has-text("Envoyer maintenant")')
    await confirmBtn.waitFor({ state: 'visible', timeout: 5000 })
    assert.equal(await confirmBtn.isDisabled(), true, 'Confirm doit être disabled sans compte Gmail connecté')

    // Annuler referme la modale sans envoyer
    await page.locator('button:has-text("Annuler")').click()
    await page.locator('h3:has-text("Envoyer le courriel")').waitFor({ state: 'hidden', timeout: 5000 })
  })

  test('backend /send/:qcId retourne 404 sur qcId inexistant (route montée)', async () => {
    const result = await page.evaluate(async () => {
      const tk = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/email-relance/send/qc-inexistant-xxx', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + tk, 'Content-Type': 'application/json' },
        body: '{}',
      })
      return { status: r.status, body: await r.json().catch(() => ({})) }
    })
    assert.equal(result.status, 404, 'qcId inexistant doit retourner 404')
    assert.ok(result.body.error, 'Réponse doit contenir un champ error')
  })
})
