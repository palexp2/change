const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie le correctif central du composant Modal partagé (Modal.jsx) :
//   1. Fermeture sur la touche Échap
//   2. Autofocus du premier champ à l'ouverture
//   3. Focus-trap (Tab depuis le dernier élément revient au premier)
// On teste contre la modale "Nouveau contact" (Contacts.jsx) qui :
//   - utilise le composant Modal partagé
//   - n'a PAS de prop autoFocus dans son form (donc l'autofocus testé vient
//     bien de notre code, pas d'un attribut React local)
//   - ne crée AUCUN record tant qu'on ne soumet pas → pas de cleanup nécessaire
describe('Modal partagée — Échap, autofocus, focus-trap', () => {
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

  async function openContactModal() {
    await page.goto(`${URL}/contacts`, { waitUntil: 'networkidle' })
    await page.click('button:has-text("Nouveau contact")')
    const modal = page.locator('.fixed.inset-0.z-50 .bg-white.rounded-2xl').filter({
      hasText: 'Nouveau contact',
    }).first()
    await modal.waitFor({ state: 'visible', timeout: 5000 })
    return modal
  }

  test('autofocus : le premier champ (Prénom) reçoit le focus à l\'ouverture', async () => {
    const modal = await openContactModal()
    // Laisse le rAF d'autofocus s'exécuter
    await page.waitForTimeout(150)

    // L'élément actif doit être le premier <input> de la modale (le champ Prénom)
    const isFirstInputFocused = await modal.evaluate((el) => {
      const firstInput = el.querySelector('input')
      return firstInput && document.activeElement === firstInput
    })
    assert.equal(isFirstInputFocused, true, 'le premier input devrait avoir le focus')

    // Cleanup : refermer
    await page.keyboard.press('Escape')
    await modal.waitFor({ state: 'hidden', timeout: 3000 })
  })

  test('Échap : ferme la modale', async () => {
    const modal = await openContactModal()
    await page.keyboard.press('Escape')
    await modal.waitFor({ state: 'hidden', timeout: 3000 })
    assert.equal(await modal.count(), 0, 'la modale devrait être fermée après Échap')
  })

  test('focus-trap : Tab depuis le dernier élément revient au premier', async () => {
    const modal = await openContactModal()
    await page.waitForTimeout(150)

    // Focus explicitement le dernier élément focusable (le bouton Enregistrer)
    await modal.evaluate((el) => {
      const focusables = el.querySelectorAll(
        'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
      )
      const last = focusables[focusables.length - 1]
      last.focus()
    })

    // Tab depuis le dernier élément doit cycler vers le premier (focus-trap)
    await page.keyboard.press('Tab')
    await page.waitForTimeout(50)

    const wrappedToFirst = await modal.evaluate((el) => {
      const focusables = el.querySelectorAll(
        'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
      )
      const first = focusables[0]
      return document.activeElement === first
    })
    assert.equal(wrappedToFirst, true, 'Tab depuis le dernier élément devrait revenir au premier (focus-trap)')

    // Et Shift+Tab depuis le premier doit revenir au dernier
    const wrappedToLast = await modal.evaluate((el) => {
      const focusables = el.querySelectorAll(
        'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
      )
      focusables[0].focus()
      return focusables.length
    })
    assert.ok(wrappedToLast > 1, 'plusieurs éléments focusables attendus')
    await page.keyboard.press('Shift+Tab')
    await page.waitForTimeout(50)
    const atLast = await modal.evaluate((el) => {
      const focusables = el.querySelectorAll(
        'a[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),textarea:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])',
      )
      const last = focusables[focusables.length - 1]
      return document.activeElement === last
    })
    assert.equal(atLast, true, 'Shift+Tab depuis le premier élément devrait aller au dernier')

    // Cleanup
    await page.keyboard.press('Escape')
    await modal.waitFor({ state: 'hidden', timeout: 3000 })
  })
})
