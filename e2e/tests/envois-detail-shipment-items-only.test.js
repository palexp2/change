// Vérifie que la fiche d'un envoi liste UNIQUEMENT les articles assignés à cet
// envoi (order_items.shipment_id), et non toute la commande.
//
// Cas de référence : ENV-1609 (envoi du 1 juin) appartient à une commande de
// ~23 lignes, mais un seul article y est expédié — le « Kit eye bolt ». La fiche
// doit afficher 1 ligne, sous le titre « Articles de l'envoi » (pas le fallback
// « Articles de la commande »).
//
// Lecture seule : aucun record créé, aucune config modifiée → pas de cleanup.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Envoi ENV-1609 — stable, déjà en DB (synced Airtable)
const ENV_1609_ID = '8cee15d1-2882-4bb5-a89a-4c058b53d83f'

describe('Fiche envoi — liste les articles de l\'envoi, pas toute la commande', () => {
  let browser, ctx, page, pageErrors

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    pageErrors = []
    page.on('pageerror', err => pageErrors.push(err.message))
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
  })

  after(async () => { await browser?.close() })

  test('ENV-1609 n\'affiche que le Kit eye bolt', async () => {
    await page.goto(`${URL}/envois/${ENV_1609_ID}`, { waitUntil: 'networkidle' })

    // Le titre de la section doit être « Articles de l'envoi » (pas le fallback commande)
    const heading = page.locator('h2', { hasText: /Articles de l'envoi/ })
    await heading.waitFor({ state: 'visible', timeout: 10000 })
    const headingText = await heading.textContent()
    assert.ok(
      /Articles de l'envoi \(1\)/.test(headingText),
      `Titre attendu « Articles de l'envoi (1) », reçu : ${headingText}`,
    )

    // Exactement une ligne d'article dans le tableau de cette section
    const card = heading.locator('xpath=ancestor::div[contains(@class,"card")][1]')
    const rows = card.locator('tbody tr')
    await rows.first().waitFor({ state: 'visible', timeout: 5000 })
    assert.equal(await rows.count(), 1, 'doit afficher exactement 1 article')

    // Et c'est bien le Kit eye bolt (sku 1543)
    const rowText = await rows.first().textContent()
    assert.ok(/eye bolt/i.test(rowText), `ligne attendue « eye bolt », reçu : ${rowText}`)
    assert.ok(/1543/.test(rowText), `sku 1543 attendu, reçu : ${rowText}`)

    assert.deepEqual(pageErrors, [], 'aucune erreur JS de page')
  })
})
