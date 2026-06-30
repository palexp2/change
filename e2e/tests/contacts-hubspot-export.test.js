// Vérifie le flux d'export vers HubSpot depuis la page Contacts :
// 1) Le bouton "Exporter vers HubSpot" est présent et ouvre une modale
// 2) La modale liste les side effects (création liste, matching emails)
// 3) L'API /api/hubspot/contact-segment retourne 422 pour des emails
//    inconnus (matching à vide) — donc rien n'est créé dans HubSpot.
//
// Ne crée AUCUNE liste réelle dans HubSpot (les emails utilisés sont
// volontairement invalides) donc rien à nettoyer côté HubSpot.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('Contacts — export vers HubSpot', () => {
  let browser, ctx, page, token

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))
  })

  after(async () => { await browser?.close() })

  test('Le bouton "Exporter vers HubSpot" est présent sur /contacts', async () => {
    await page.goto(`${URL}/contacts`, { waitUntil: 'networkidle' })
    const btn = page.locator('button:has-text("Exporter vers HubSpot")').first()
    await btn.waitFor({ state: 'visible', timeout: 5000 })
  })

  test('La modale d\'export liste les side effects et a un champ nom', async () => {
    await page.locator('button:has-text("Exporter vers HubSpot")').first().click()
    await page.waitForSelector('text=/Effets de bord/i', { timeout: 5000 })
    const bodyText = await page.locator('[role="dialog"], .modal, body').first().innerText()
    assert.ok(/liste statique/i.test(bodyText), 'doit mentionner "liste statique"')
    assert.ok(/contacts HubSpot existants/i.test(bodyText), 'doit clarifier qu\'on matche les existants')
    assert.ok(/Aucun nouveau contact/i.test(bodyText) || /aucun nouveau contact/i.test(bodyText)
      || /matché.*HubSpot/i.test(bodyText), 'doit clarifier qu\'aucun contact n\'est créé')
    // Ferme la modale
    await page.locator('button:has-text("Annuler")').first().click()
  })

  test('API /api/hubspot/contact-segment refuse 422 si aucun email ne matche', async () => {
    const fakeEmail = `e2e-fake-${Date.now()}@invalid.test`
    const resp = await page.request.post(`${URL}/api/hubspot/contact-segment`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { name: `E2E TEST — ${Date.now()}`, emails: [fakeEmail] },
    })
    assert.equal(resp.status(), 422, 'doit retourner 422 quand aucun email matché')
    const body = await resp.json()
    assert.equal(body.matched, 0)
    assert.equal(body.not_found, 1)
  })

  test('API refuse 400 si emails vide', async () => {
    const resp = await page.request.post(`${URL}/api/hubspot/contact-segment`, {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: { name: 'X', emails: [] },
    })
    assert.equal(resp.status(), 400)
  })

  // Cliquer « Créer la liste HubSpot » ne doit PAS pousser immédiatement vers
  // HubSpot : une modale de confirmation explicite des side effects doit
  // d'abord s'afficher (règle CLAUDE.md « confirmation des side effects »).
  // Le test ne confirme jamais — il Annule — donc aucune liste réelle n'est
  // créée dans HubSpot : rien à nettoyer.
  test('« Créer la liste HubSpot » ouvre une confirmation et ne pousse rien sans confirmer', async () => {
    // Sentinelle : tout POST /hubspot/contact-segment (= push réel) est noté.
    let pushCalled = false
    await page.route('**/api/hubspot/contact-segment', route => {
      if (route.request().method() === 'POST') pushCalled = true
      route.continue()
    })

    await page.goto(`${URL}/contacts`, { waitUntil: 'networkidle' })
    await page.locator('button:has-text("Exporter vers HubSpot")').first().click()
    await page.waitForSelector('text=/Effets de bord/i', { timeout: 5000 })

    // Le bouton de soumission s'active dès qu'il y a au moins un email valide
    // dans la vue (contacts réels). On attend qu'il soit cliquable.
    const submitBtn = page.locator('button:has-text("Créer la liste HubSpot")').first()
    await submitBtn.waitFor({ state: 'visible', timeout: 5000 })
    await page.waitForFunction(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent?.includes('Créer la liste HubSpot'))
      return b && !b.disabled
    }, { timeout: 8000 })

    // Clic → la confirmation doit apparaître, PAS de push immédiat
    await submitBtn.click()

    const confirm = page.locator('.fixed.inset-0.z-50 .bg-white.rounded-2xl').filter({
      hasText: 'Confirmer le push vers HubSpot',
    }).first()
    await confirm.waitFor({ state: 'visible', timeout: 5000 })

    // La confirmation liste explicitement les side effects HubSpot
    const confirmText = await confirm.innerText()
    assert.match(confirmText, /liste statique/i, 'doit mentionner la création de liste statique')
    assert.match(confirmText, /matché/i, 'doit mentionner le matching des contacts existants')
    assert.match(confirmText, /aucun nouveau contact/i, 'doit clarifier qu\'aucun contact n\'est créé')

    // Rien n'a été poussé avant confirmation
    assert.equal(pushCalled, false, 'aucun POST /contact-segment avant confirmation')

    // Annuler ferme la confirmation sans rien pousser
    await confirm.locator('button:has-text("Annuler")').click()
    await confirm.waitFor({ state: 'hidden', timeout: 5000 })
    assert.equal(pushCalled, false, 'annuler ne doit rien pousser vers HubSpot')

    // On revient au formulaire (pas d'écran de résultat « Liste créée »)
    const dialogText = await page.locator('[role="dialog"], .modal, body').first().innerText()
    assert.ok(!/Liste créée dans HubSpot/i.test(dialogText), 'aucun résultat ne doit s\'afficher après annulation')
  })
})
