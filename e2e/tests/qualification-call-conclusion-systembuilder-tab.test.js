const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie qu'à l'étape Conclusion (slide index 7) de la vue assistant :
//  1. le step-zero expose 2 onglets : Script (contenu actuel) + System builder ;
//  2. l'onglet System builder génère un lien Fillout pré-rempli à partir des
//     données de l'appel (email de reçu par défaut, nom de ferme, serres achetées),
//     les autres params d'équipement à 0 et project_id vide ;
//  3. modifier l'email régénère le lien.

describe('Conclusion : onglet System builder', () => {
  let browser, ctx, page, db
  let createdCompanyId = null
  let createdCallId = null

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
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
    if (createdCallId) {
      try { db.prepare('DELETE FROM qualification_calls WHERE id = ?').run(createdCallId) } catch {}
    }
    if (createdCompanyId) {
      try { db.prepare('DELETE FROM companies WHERE id = ?').run(createdCompanyId) } catch {}
    }
    db?.close()
    await browser?.close()
  })

  test('Script + System builder, lien Fillout pré-rempli, switch + maj email', async () => {
    await page.goto(`${URL}/qualification-call`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')

    const beforeIds = new Set(db.prepare('SELECT id FROM companies').all().map(r => r.id))
    await page.locator('button:has-text("Nouvel appel")').first().click()
    await page.locator('button:has-text("Nouvelle entreprise")').first().click()

    const frameLoc = page.frameLocator('iframe[title="Guide d\'appel de qualification"]')
    await frameLoc.locator('#assistant-panel').waitFor({ state: 'visible', timeout: 10000 })

    const newCompany = db.prepare('SELECT id FROM companies').all().find(c => !beforeIds.has(c.id))
    if (newCompany) createdCompanyId = newCompany.id
    const callRow = db.prepare('SELECT id FROM qualification_calls WHERE company_id = ? ORDER BY created_at DESC LIMIT 1').get(createdCompanyId)
    if (callRow) createdCallId = callRow.id

    // Prépare l'état : 1 chief + 1 helper achetés, nom de ferme, email de reçu.
    await frameLoc.locator('#assistant-panel').evaluate(() => {
      // eslint-disable-next-line no-undef
      quoteState.chief = 1
      // eslint-disable-next-line no-undef
      quoteState.helper = 1
      const farm = document.getElementById('qa-farm')
      if (farm) { farm.removeAttribute('readonly'); farm.value = 'E2E Farm SB' }
      window.__receiptEmail = 'e2e-sb@example.com'
      // eslint-disable-next-line no-undef
      if (typeof goTo === 'function') goTo(7)
    })
    await page.waitForTimeout(400)

    const stepZero = frameLoc.locator('.step-zero[data-tab-set="conclusion"]').first()
    await stepZero.waitFor({ state: 'visible', timeout: 5000 })

    // 1. Deux onglets, bons labels.
    const tabCount = await stepZero.locator('.step-tab').count()
    assert.equal(tabCount, 2, `Conclusion doit avoir exactement 2 onglets, a ${tabCount}`)
    const scriptTab = stepZero.locator('.step-tab[data-tab="script"]')
    const sbTab = stepZero.locator('.step-tab[data-tab="systembuilder"]')
    assert.equal((await scriptTab.textContent()).trim(), 'Script', 'label onglet Script')
    assert.equal((await sbTab.textContent()).trim(), 'System builder', 'label onglet System builder')

    // System builder actif par défaut : "Payment" (onglet Script) masqué.
    const paymentSubhead = stepZero.locator('.step-subhead', { hasText: 'Payment' }).first()
    assert.equal(await paymentSubhead.isVisible().catch(() => false), false, '"Payment" masqué par défaut (System builder actif)')

    // L'onglet Script reste accessible et affiche bien "Payment".
    await scriptTab.click()
    await page.waitForTimeout(200)
    assert.ok(await paymentSubhead.isVisible(), 'sous-titre "Payment" visible sous l\'onglet Script')

    // 2. Retour sur System builder.
    await sbTab.click()
    await page.waitForTimeout(200)
    assert.equal(await paymentSubhead.isVisible().catch(() => false), false, '"Payment" masqué quand System builder actif')

    // Email pré-rempli avec l'email de reçu.
    const emailInput = stepZero.locator('#sb-email')
    assert.ok(await emailInput.isVisible(), 'champ email System builder visible')
    assert.equal(await emailInput.inputValue(), 'e2e-sb@example.com', 'email pré-rempli = email de reçu')

    // Lien généré conforme à la formule.
    const link = stepZero.locator('#sb-link')
    const href = await link.getAttribute('href')
    const checks = [
      'https://forms.fillout.com/t/roRLoV4Nnwus?',
      'email=e2e-sb%40example.com',
      'project_id=&farm_name=', // project_id vide
      'farm_name=E2E%20Farm%20SB',
      'greenhouse1=chief',
      'greenhouse2=helper',
      'greenhouse3=none',
      'lte=0',
      'force_custom=0',
      'heating1=0',
      'wind_protection=0',
      'rain_protection=0',
    ]
    for (const c of checks) {
      assert.ok(href.includes(c), `le lien doit contenir "${c}" — lien: ${href}`)
    }

    // 3. Modifier l'email régénère le lien.
    await emailInput.fill('changed@example.com')
    await page.waitForTimeout(150)
    const href2 = await link.getAttribute('href')
    assert.ok(href2.includes('email=changed%40example.com'), `lien mis à jour avec le nouvel email — lien: ${href2}`)
    assert.ok(!href2.includes('email=e2e-sb%40example.com'), 'ancien email retiré du lien')

    // 4. Avec ≤3 unités, pas d'avertissement de débordement.
    const overflow = stepZero.locator('#sb-overflow')
    assert.equal(await overflow.isVisible().catch(() => false), false, 'pas d\'avertissement avec 2 unités (1 chief + 1 helper)')

    // 4b. Avec ≤3 unités, le champ note "serres en surplus" est masqué.
    const notesBlock = stepZero.locator('#sb-notes-block')
    assert.equal(await notesBlock.isVisible().catch(() => false), false, 'champ note masqué avec ≤3 serres')

    // 5. Au-delà de 3 unités, avertir des Chief/Helper non inclus (4 chief + 1 helper
    //    → 3 serres remplies de chief, débordent : 1 Chief et 1 Helper).
    await frameLoc.locator('#assistant-panel').evaluate(() => {
      // eslint-disable-next-line no-undef
      quoteState.chief = 4
      // eslint-disable-next-line no-undef
      quoteState.helper = 1
      // eslint-disable-next-line no-undef
      updateSystemBuilderLink()
    })
    await page.waitForTimeout(150)
    assert.ok(await overflow.isVisible(), 'avertissement visible avec 5 unités')
    const warnTxt = await overflow.textContent()
    assert.ok(warnTxt.includes('1 Chief'), `avertissement mentionne 1 Chief — texte: ${warnTxt}`)
    assert.ok(warnTxt.includes('1 Helper'), `avertissement mentionne 1 Helper — texte: ${warnTxt}`)
    const href3 = await link.getAttribute('href')
    assert.ok(href3.includes('greenhouse1=chief') && href3.includes('greenhouse2=chief') && href3.includes('greenhouse3=chief'),
      `les 3 serres sont chief — lien: ${href3}`)

    // 5b. Au-delà de 3 serres, le champ note apparaît, pré-rempli du gabarit.
    assert.ok(await notesBlock.isVisible(), 'champ note visible avec >3 serres')
    const notes = stepZero.locator('#sb-notes')
    const notesVal = await notes.inputValue()
    assert.ok(notesVal.startsWith('Permissions:'), `gabarit par défaut chargé — début: ${notesVal.slice(0, 40)}`)
    assert.ok(notesVal.includes('Customs fees'), 'gabarit contient la section Customs fees')
    assert.ok(notesVal.includes('Wi-Fi network password'), 'gabarit contient la section Wi-Fi')

    // 5c. Éditer la note → autosave (postMessage → parent → API) → persistée.
    //     On vérifie via l'API (source de vérité côté serveur) plutôt qu'une 2e
    //     connexion SQLite, qui ne voit pas toujours l'écriture WAL du serveur.
    const marker = 'E2E EDIT ' + Date.now()
    const edited = notesVal + '\n\n' + marker
    await notes.fill(edited)
    await notes.blur()
    // Laisse le temps au flush parent (debounce 500ms) + round-trip API, puis lit.
    const persistedNotes = await page.evaluate(async ({ id, mark }) => {
      const token = localStorage.getItem('erp_token')
      for (let i = 0; i < 30; i++) {
        const r = await fetch(`/erp/api/qualification-calls/${id}`, { headers: { Authorization: 'Bearer ' + token } })
        const d = await r.json()
        if ((d.system_builder_notes || '').includes(mark)) return d.system_builder_notes
        await new Promise(res => setTimeout(res, 200))
      }
      return null
    }, { id: createdCallId, mark: marker })
    assert.ok(persistedNotes && persistedNotes.includes(marker), 'note persistée côté serveur après édition')
    assert.ok(persistedNotes.startsWith('Permissions:'), 'la note persistée conserve le gabarit édité')

    // 6. Bouton "Send email" → confirmation du side effect (sans envoyer).
    //    On NE confirme PAS : un envoi réel partirait via Postmark (vraie prod).
    const sendBtn = stepZero.locator('#sb-send')
    assert.ok(await sendBtn.isVisible(), 'bouton "Send email" visible')
    await sendBtn.click()
    await page.waitForTimeout(150)
    const confirmBox = stepZero.locator('#sb-confirm')
    assert.ok(await confirmBox.isVisible(), 'la confirmation du side effect s\'affiche')
    const confirmTxt = await stepZero.locator('#sb-confirm-text').textContent()
    assert.ok(confirmTxt.includes('changed@example.com'), `confirmation mentionne le destinataire — texte: ${confirmTxt}`)
    assert.ok(confirmTxt.includes('info@orisha.io'), `confirmation mentionne l'expéditeur info@orisha.io — texte: ${confirmTxt}`)
    // Annuler : pas d'envoi.
    await stepZero.locator('#sb-send-cancel').click()
    await page.waitForTimeout(100)
    assert.equal(await confirmBox.isVisible().catch(() => false), false, 'la confirmation se ferme à l\'annulation')

    // 7. La route serveur est montée et valide l'entrée : email invalide → 400
    //    (aucun email envoyé).
    const status = await page.evaluate(async ({ base, id }) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`${base}/api/qualification-calls/${id}/send-system-builder-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ email: 'not-an-email', link: 'https://forms.fillout.com/t/x' }),
      })
      return r.status
    }, { base: URL, id: createdCallId })
    assert.equal(status, 400, 'email invalide rejeté par la route (400, pas d\'envoi)')
  })
})
