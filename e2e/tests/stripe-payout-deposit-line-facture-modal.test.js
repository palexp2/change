const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Même payout de référence utilisé par stripe-payout-deposit-line-accounts —
// il contient des charges (vers facture en_xxx) et donc au moins une ligne
// avec un factureId résolvable côté lineRefs.
const PAYOUT_ID = 'po_1TN0ZxEO122sMsbJJwo1bfpS'

describe('Preview deposit — lignes facture cliquables (modale)', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1600, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('preview-deposit renvoie lineRefs parallèle à deposit.Line', async () => {
    const data = await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      const res = await fetch(`/erp/api/stripe-payouts/${id}/preview-deposit`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      return res.json()
    }, PAYOUT_ID)

    assert.ok(data.deposit?.Line?.length > 0, 'aucune ligne dans le deposit')
    assert.ok(Array.isArray(data.lineRefs), 'lineRefs absent ou non-array')
    assert.equal(data.lineRefs.length, data.deposit.Line.length,
      `lineRefs.length (${data.lineRefs.length}) ≠ deposit.Line.length (${data.deposit.Line.length})`)

    // Au moins une ligne doit avoir un factureId résolu (revenus/refunds).
    const withFacture = data.lineRefs.filter(r => r && r.factureId)
    assert.ok(withFacture.length > 0,
      `aucune ligne avec factureId — refs reçus: ${JSON.stringify(data.lineRefs.slice(0, 5))}`)

    // Sanity : la 1re ligne avec facture doit avoir customerName et btType.
    const sample = withFacture[0]
    assert.ok(sample.btType, `btType manquant dans ref: ${JSON.stringify(sample)}`)
  })

  test('UI : cliquer sur une ligne ouvre la modale facture', async () => {
    await page.goto(`${URL}/stripe-payouts/${PAYOUT_ID}`, { waitUntil: 'networkidle' })
    await page.waitForSelector('h1', { timeout: 10000 })

    await page.click('button:has-text("Aperçu Deposit")')
    await page.waitForSelector('text=Aperçu Deposit', { timeout: 8000 })

    // Ouvrir le <details> "Lignes du Deposit"
    const summary = page.locator('summary:has-text("Lignes du Deposit")').first()
    await summary.click()

    // Trouver la première ligne avec un lien facture (boutons rendus par PreviewPanel)
    const factureLink = page.locator('[data-testid="deposit-line-facture-link"]').first()
    await factureLink.waitFor({ timeout: 5000 })
    const factureId = await factureLink.getAttribute('data-facture-id')
    assert.ok(factureId, 'pas de data-facture-id sur le lien')

    await factureLink.click()

    // La modale doit afficher le détail de la facture
    const modal = page.locator('[data-testid="facture-quick-view"]')
    await modal.waitFor({ timeout: 5000 })

    const modalText = await modal.innerText()
    // Les libellés sont stylés `uppercase` via CSS → innerText renvoie majuscules.
    assert.ok(/TOTAL/i.test(modalText), `modale ne contient pas "Total" — texte: ${modalText.slice(0, 200)}`)
    assert.ok(/SOLDE/i.test(modalText), `modale ne contient pas "Solde" — texte: ${modalText.slice(0, 200)}`)
    assert.ok(/DEVISE/i.test(modalText), `modale ne contient pas "Devise"`)
    // ID Stripe doit être présent (in_xxx, ch_xxx, re_xxx…)
    assert.ok(/[a-z]{2,3}_[A-Za-z0-9]+/.test(modalText), 'aucun id Stripe visible dans la modale')

    // Le lien "Ouvrir la fiche complète" doit pointer vers /factures/<id>
    const fullLink = page.locator('a:has-text("Ouvrir la fiche complète")').first()
    const href = await fullLink.getAttribute('href')
    assert.ok(href && href.includes(`/factures/${factureId}`),
      `href de "Ouvrir la fiche complète" inattendu: ${href}`)
  })
})
