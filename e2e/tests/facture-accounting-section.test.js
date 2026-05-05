const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const FACTURE_ID = '9e045250-9767-4675-a54c-ffb0b7094d10' // TDGMEWE0-0002

describe('FactureDetail — Section État comptable QuickBooks', () => {
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

  test('La section État comptable s\'affiche sur la fiche facture', async () => {
    await page.goto(`${URL}/factures/${FACTURE_ID}`, { waitUntil: 'domcontentloaded' })
    const section = page.getByTestId('facture-accounting-section')
    await section.waitFor({ state: 'visible', timeout: 10000 })
    await assert.doesNotReject(section.getByText(/État comptable QuickBooks/).waitFor({ state: 'visible', timeout: 5000 }))
    await assert.doesNotReject(section.getByText(/Encaissée/).waitFor({ state: 'visible', timeout: 5000 }))
    await assert.doesNotReject(section.getByText(/Revenu perçu d'avance/).waitFor({ state: 'visible', timeout: 5000 }))
    await assert.doesNotReject(section.getByText(/Vente constatée/).waitFor({ state: 'visible', timeout: 5000 }))
  })

  test('API /qb-state répond avec checks[] pour une facture qui a deferred_revenue_qb_ref', async () => {
    const res = await page.evaluate(async (id) => {
      const token = localStorage.getItem('erp_token')
      const r = await fetch(`/erp/api/projets/factures/${id}/qb-state`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      const body = await r.json()
      return { status: r.status, body }
    }, FACTURE_ID)
    assert.equal(res.status, 200, `qb-state status: ${res.status} ${JSON.stringify(res.body)}`)
    assert.equal(res.body.facture_id, FACTURE_ID)
    assert.equal(res.body.document_number, 'TDGMEWE0-0002')
    assert.ok(Array.isArray(res.body.checks), 'checks doit être un tableau')
    const deferred = res.body.checks.find(c => c.kind === 'deferred_revenue')
    assert.ok(deferred, 'un check deferred_revenue est attendu')
    assert.ok(['exists', 'missing', 'line_missing', 'unsupported', 'error'].includes(deferred.qb_status),
      `qb_status valide: ${deferred.qb_status}`)
  })

  test('Le bouton "Vérifier dans QB" déclenche un appel et affiche le résultat', async () => {
    await page.goto(`${URL}/factures/${FACTURE_ID}`, { waitUntil: 'domcontentloaded' })
    const verify = page.getByTestId('verify-qb-btn')
    await verify.waitFor({ state: 'visible', timeout: 10000 })
    await verify.click()
    // Attend l'affichage du timestamp de vérification (preuve que le call a abouti)
    await page.waitForSelector('text=/Vérifié dans QuickBooks le/', { timeout: 15000 })
  })

  test('La modale "Effacer la référence locale" liste les colonnes effacées', async () => {
    await page.goto(`${URL}/factures/${FACTURE_ID}`, { waitUntil: 'domcontentloaded' })
    const clearBtn = page.getByTestId('clear-deferred-btn')
    await clearBtn.waitFor({ state: 'visible', timeout: 10000 })
    await clearBtn.click()
    await page.waitForSelector('text=/Effacer le passif local 23900/', { timeout: 5000 })
    // Vérifie que la modale liste les colonnes
    await page.waitForSelector('text=/deferred_revenue_at/', { timeout: 5000 })
    await page.waitForSelector('text=/deferred_revenue_qb_ref/', { timeout: 5000 })
    // Annulation — pas de modification
    await page.click('button:has-text("Annuler")')
  })
})
