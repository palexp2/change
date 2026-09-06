// Régression : ouvrir la bulle d'aide (« Modifier le système ») pendant qu'un
// panneau latéral (RecordPeekDrawer) est déjà ouvert affichait mal la modale —
// le drawer, porté par createPortal directement sous <body>, recouvrait la
// modale à z-index égal (50) car celle-ci restait imbriquée sous #root.
// Modal.jsx porte désormais sa modale sous <body> lui aussi (comme le drawer),
// ce qui garantit qu'elle s'empile au-dessus du drawer déjà ouvert.
//
// Lecture seule : aucun texte n'est soumis (bulle annulée), donc rien à
// nettoyer/restaurer.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('FeedbackFab — modale au-dessus d\'un panneau latéral déjà ouvert', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => { await browser?.close() })

  test('la modale reste utilisable quand un drawer de fiche est ouvert', async () => {
    await page.goto(`${URL}/tickets`, { waitUntil: 'networkidle' })
    const firstRow = page.locator('[data-row-id]').first()
    await firstRow.waitFor({ timeout: 10000 })
    await firstRow.locator('.font-medium').first().click()
    await page.locator('[data-testid="record-peek-drawer"]').waitFor({ timeout: 8000 })

    // Ouvre la bulle d'aide par-dessus le drawer déjà ouvert.
    await page.click('[data-testid="feedback-fab"]')
    const textarea = page.locator('[data-testid="feedback-fab-text"]')
    await textarea.waitFor({ state: 'visible', timeout: 5000 })

    // Le centre du champ de texte de la modale doit résoudre vers le champ
    // lui-même — si le drawer recouvrait la modale, ce serait le drawer.
    const covering = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="feedback-fab-text"]')
      const r = el.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return el.contains(hit) || el === hit
    })
    assert.ok(covering, 'le champ de texte de la modale doit être au premier plan, pas recouvert par le drawer')

    // Vérif fonctionnelle : Playwright échoue si un autre élément intercepte
    // le clic (ex. l'overlay du drawer par-dessus la modale).
    await textarea.fill('Test régression modale au-dessus du drawer (annulé, non envoyé)')
    await page.click('button:has-text("Annuler")')
    await textarea.waitFor({ state: 'hidden', timeout: 3000 })

    // Le drawer, lui, doit être resté ouvert : fermer la modale ne doit rien
    // affecter d'autre.
    assert.equal(await page.locator('[data-testid="record-peek-drawer"]').count(), 1,
      'le drawer reste ouvert après fermeture de la modale')
  })
})
