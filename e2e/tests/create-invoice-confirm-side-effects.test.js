// Cliquer « Créer la facture » dans CreateInvoiceModal ne doit PAS créer
// immédiatement la facture Stripe : une modale de confirmation des side effects
// doit d'abord s'afficher (règle CLAUDE.md « confirmation des side effects »).
//
// Ce test NE confirme jamais la création — il vérifie uniquement qu'aucun
// POST /stripe-invoices n'est émis tant que l'utilisateur n'a pas confirmé.
// Donc aucun enregistrement Stripe/DB n'est créé : pas de cleanup nécessaire.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

describe('CreateInvoiceModal — confirmation des side effects avant création Stripe', () => {
  let browser, ctx, page, companyId

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    // Trouve une entreprise dont l'adresse de livraison a une province
    // (sinon le bouton « Créer la facture » est désactivé).
    companyId = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const r = await fetch('/erp/api/companies?limit=all', { headers: { Authorization: `Bearer ${tok}` } })
      const j = await r.json()
      const companies = (j.data || j || [])
      for (const c of companies.slice(0, 80)) {
        try {
          const sr = await fetch(`/erp/api/stripe-invoices/companies/${c.id}/shipping-province`, { headers: { Authorization: `Bearer ${tok}` } })
          if (!sr.ok) continue
          const ship = await sr.json()
          if (ship && ship.province) return c.id
        } catch { /* ignore */ }
      }
      return null
    })
    assert.ok(companyId, 'devrait trouver une entreprise avec une province de livraison')
  })

  after(async () => { await browser?.close() })

  test('« Créer la facture » ouvre la modale de confirmation et ne crée rien sans confirmation', async () => {
    // Sentinelle : tout POST /stripe-invoices (= création réelle) lève une erreur.
    let createCalled = false
    await page.route('**/api/stripe-invoices', route => {
      if (route.request().method() === 'POST') createCalled = true
      route.continue()
    })

    await page.goto(`${URL}/companies/${companyId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')

    // Ouvre le menu « Nouvelle facture » → « Créer une nouvelle facture »
    await page.click('button:has-text("Nouvelle facture")')
    await page.click('button:has-text("Créer une nouvelle facture")')

    // La modale principale s'ouvre
    await page.locator('h2:has-text("Nouvelle facture Stripe")').waitFor({ state: 'visible', timeout: 10000 })

    // Attend que le chargement de l'adresse se termine (bouton actif)
    const submitBtn = page.locator('button:has-text("Créer la facture")')
    await submitBtn.waitFor({ state: 'visible', timeout: 10000 })
    await page.waitForFunction(() => {
      const btns = Array.from(document.querySelectorAll('button'))
      const b = btns.find(x => x.textContent?.includes('Créer la facture'))
      return b && !b.disabled
    }, { timeout: 10000 })

    // Remplit une ligne valide : description (qté = 1 par défaut)
    const descInput = page.locator('input[placeholder*="Description ou produit"]').first()
    await descInput.fill(`E2E confirm test ${Date.now()}`)

    // Clic sur « Créer la facture » → doit ouvrir la confirmation, PAS créer
    await submitBtn.click()

    const confirm = page.locator('[data-testid="confirm-create-invoice"]')
    await confirm.waitFor({ state: 'visible', timeout: 10000 })

    // La modale liste explicitement le side effect Stripe
    const confirmText = await confirm.innerText()
    assert.match(confirmText, /facture\s+Stripe/i, 'la confirmation doit mentionner la facture Stripe')
    assert.match(confirmText, /sera créée dans Stripe/i, 'la confirmation doit décrire la création dans Stripe')
    // Montant formaté présent (un nombre suivi de $)
    assert.match(confirmText, /\d[\d\s.,]*\$/, 'la confirmation doit afficher un montant')

    // sendEmail est coché par défaut → le side effect d'envoi email doit être listé
    assert.match(confirmText, /envoi par email/i, 'la confirmation doit lister l\'envoi par email quand la case est cochée')

    // Aucune création n'a été déclenchée
    assert.equal(createCalled, false, 'aucun POST /stripe-invoices ne doit partir avant confirmation')

    // Annuler ferme la confirmation sans rien créer
    await confirm.locator('button:has-text("Annuler")').click()
    await confirm.waitFor({ state: 'hidden', timeout: 5000 })
    assert.equal(createCalled, false, 'annuler ne doit rien créer')
  })

  test('décocher « Envoyer par email » retire le side effect d\'envoi de la confirmation', async () => {
    let createCalled = false
    await page.route('**/api/stripe-invoices', route => {
      if (route.request().method() === 'POST') createCalled = true
      route.continue()
    })

    await page.goto(`${URL}/companies/${companyId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')
    await page.click('button:has-text("Nouvelle facture")')
    await page.click('button:has-text("Créer une nouvelle facture")')
    await page.locator('h2:has-text("Nouvelle facture Stripe")').waitFor({ state: 'visible', timeout: 10000 })
    await page.waitForFunction(() => {
      const b = Array.from(document.querySelectorAll('button')).find(x => x.textContent?.includes('Créer la facture'))
      return b && !b.disabled
    }, { timeout: 10000 })

    // Décoche « Envoyer par email »
    await page.locator('input[type="checkbox"]').first().uncheck()

    await page.locator('input[placeholder*="Description ou produit"]').first().fill(`E2E confirm test ${Date.now()}`)
    await page.locator('button:has-text("Créer la facture")').click()

    const confirm = page.locator('[data-testid="confirm-create-invoice"]')
    await confirm.waitFor({ state: 'visible', timeout: 10000 })
    const confirmText = await confirm.innerText()
    assert.doesNotMatch(confirmText, /envoi par email/i, 'sans la case cochée, aucun side effect email ne doit être listé')
    assert.match(confirmText, /draft/i, 'doit indiquer que la facture reste en draft')

    assert.equal(createCalled, false, 'aucune création avant confirmation')
    await confirm.locator('button:has-text("Annuler")').click()
  })
})
