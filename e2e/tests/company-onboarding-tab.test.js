const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const { randomUUID } = require('crypto')
// better-sqlite3 est dans /server/node_modules — on y accède via require absolu
// puisque les e2e n'ont pas la dépendance directement.
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// On insère une réponse d'onboarding directement en DB (pas d'API publique pour
// le faire sans Stripe Checkout réel) et on vérifie que l'onglet "Onboarding"
// apparaît bien sur la fiche entreprise et affiche le contenu attendu.
describe('CompanyDetail — onglet Onboarding affiche les réponses post-paiement', () => {
  let browser, ctx, page, db
  let companyId
  const responseId = randomUUID()
  const sessionId = `cs_test_${responseId}`

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })

    // Choisit une company existante
    const c = db.prepare(`SELECT id FROM companies WHERE deleted_at IS NULL LIMIT 1`).get()
    if (!c) throw new Error('Aucune company — impossible de tester')
    companyId = c.id

    db.prepare(`
      INSERT INTO customer_onboarding_responses (
        id, stripe_session_id, stripe_invoice_id, pending_invoice_id, company_id,
        is_new_site, farm_address_json, shipping_same_as_farm, shipping_address_json,
        network_access, wifi_ssid, wifi_password, permission_level,
        num_greenhouses, greenhouses_json, extras_json, status, submitted_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `).run(
      responseId,
      sessionId,
      'in_test_e2e',
      null,
      companyId,
      'new',
      JSON.stringify({ line1: '123 rang E2E', city: 'Saint-Hyacinthe', province: 'QC', postal_code: 'J2S 0A1', country: 'Canada' }),
      1,
      null,
      'wifi',
      'OrishaTestSSID',
      'motdepasseE2E',
      'chief_grower',
      2,
      JSON.stringify([{ name: 'Serre A', valves: 4 }, { name: 'Serre B', valves: 2 }]),
      JSON.stringify([{ role: 'mobile_controller', qty: 1, description: 'Contrôleur mobile' }]),
      'submitted',
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
    try { db?.prepare('DELETE FROM customer_onboarding_responses WHERE id=?').run(responseId) } catch {}
    db?.close()
    await browser?.close()
  })

  test('onglet Onboarding visible et affiche les données', async () => {
    await page.goto(`${URL}/companies/${companyId}`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')

    const tab = page.locator('button:has-text("Onboarding")').first()
    await tab.waitFor({ state: 'visible', timeout: 5000 })
    await tab.click()

    // En-tête de la réponse + statut soumis
    await page.waitForSelector('text=Nouveau site', { timeout: 5000 })
    await page.waitForSelector('text=Soumis', { timeout: 5000 })

    // L'item est replié par défaut quand il y a une seule réponse on l'ouvre auto.
    // On vérifie qu'on voit bien les détails attendus.
    await page.waitForSelector('text=123 rang E2E', { timeout: 5000 })
    await page.waitForSelector('text=Identique à la ferme', { timeout: 5000 })
    await page.waitForSelector('text=chief_grower', { timeout: 5000 })
    await page.waitForSelector('text=OrishaTestSSID', { timeout: 5000 })
    await page.waitForSelector('text=Serre 1', { timeout: 5000 })
    await page.waitForSelector('text=mobile_controller', { timeout: 5000 })

    assert.ok(true)
  })
})
