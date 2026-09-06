const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie que le champ Address du guide de qualification (slide-0, vue client)
// fait des appels au proxy /api/places/* (legacy Google Places API) et reçoit
// au moins une prédiction d'autocomplete pour une adresse connue.
describe('Guide d\'appel — autocomplete d\'adresse via /api/places (legacy)', () => {
  let browser, ctx, page, db
  let companyId, companyName
  let createdCallId = null
  let originalAddress = null
  // Capturé pour restauration : sélectionner une suggestion Places dans le guide
  // d'appel persiste désormais les composants structurés dans `adresses`
  // (address_type='Ferme'). Si la company avait déjà une row Ferme, on la sauve
  // pour la remettre dans son état initial après le test.
  let originalFermeAddress = null
  let originalFermeExisted = false

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
    const row = db.prepare(`
      SELECT id, name, address FROM companies
      WHERE name IS NOT NULL AND name != ''
      ORDER BY name LIMIT 1
    `).get()
    if (!row) throw new Error('Aucune company en DB')
    companyId = row.id
    companyName = row.name
    // Capture l'adresse originale pour restauration (cf. CLAUDE.md règle
    // « sauvegarder/restaurer les configurations utilisateur écrasées »).
    originalAddress = row.address || null
    const existingFerme = db.prepare(
      "SELECT id, line1, city, province, postal_code, country FROM adresses WHERE company_id=? AND address_type='Ferme' ORDER BY created_at DESC LIMIT 1"
    ).get(companyId)
    if (existingFerme) {
      originalFermeExisted = true
      originalFermeAddress = existingFerme
    }

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
      try {
        db.prepare('DELETE FROM qualification_calls WHERE id = ?').run(createdCallId)
      } catch {}
    }
    // Restaure l'adresse originale de la company (le test peut l'avoir écrasée
    // via l'autocomplete sélectionné). DB direct car l'API companies update est
    // déjà testée par d'autres specs.
    if (originalAddress !== null) {
      try {
        db.prepare('UPDATE companies SET address = ? WHERE id = ?').run(originalAddress, companyId)
      } catch {}
    } else {
      try {
        db.prepare('UPDATE companies SET address = NULL WHERE id = ?').run(companyId)
      } catch {}
    }
    // Restaure la row Ferme dans `adresses` à son état initial. Si elle existait
    // → reset des champs structurés. Sinon → DELETE de la row créée par le test.
    if (originalFermeExisted && originalFermeAddress) {
      try {
        db.prepare(`UPDATE adresses SET line1=?, city=?, province=?, postal_code=?, country=? WHERE id=?`)
          .run(
            originalFermeAddress.line1,
            originalFermeAddress.city,
            originalFermeAddress.province,
            originalFermeAddress.postal_code,
            originalFermeAddress.country,
            originalFermeAddress.id,
          )
      } catch {}
    } else {
      try {
        db.prepare("DELETE FROM adresses WHERE company_id=? AND address_type='Ferme'").run(companyId)
      } catch {}
    }
    db?.close()
    await browser?.close()
  })

  test('autocomplete renvoie des prédictions et la sélection remplit l\'input', async () => {
    await page.goto(`${URL}/qualification-call`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')
    await page.locator('button:has-text("Nouvel appel")').first().click()
    await page.fill('input[placeholder*="Rechercher une entreprise"]', companyName)
    await page.waitForTimeout(150)
    await page.locator(`button:has-text("${companyName}")`).first().click()

    const frame = page.frameLocator('iframe[title="Guide d\'appel de qualification"]')
    await frame.locator('#assistant-panel').waitFor({ state: 'visible', timeout: 10000 })

    const fresh = db.prepare(`
      SELECT id FROM qualification_calls
      WHERE company_id = ? AND airtable_record_id LIKE 'local_%'
      ORDER BY created_at DESC LIMIT 1
    `).get(companyId)
    if (fresh) createdCallId = fresh.id

    // Vue assistant masque slide-0 → on ouvre la slide view popup pour atteindre
    // le champ #qa-address.
    const [slidePage] = await Promise.all([
      page.waitForEvent('popup', { timeout: 5000 }),
      frame.locator('#open-assistant').click(),
    ])
    await slidePage.waitForLoadState('domcontentloaded')
    await slidePage.locator('#qa-address').waitFor({ state: 'visible', timeout: 5000 })

    // Tape une adresse de test et attend que le dropdown se peuple.
    await slidePage.locator('#qa-address').fill('')
    await slidePage.locator('#qa-address').type('123 rue Sherbrooke Montréal', { delay: 30 })

    // Attend la requête /api/places/autocomplete + render dropdown
    const suggestions = slidePage.locator('#qa-address-suggestions.is-open li')
    await suggestions.first().waitFor({ state: 'visible', timeout: 5000 })
    const count = await suggestions.count()
    assert.ok(count > 0, `Au moins une prédiction attendue, reçu ${count}`)

    const firstText = (await suggestions.first().textContent() || '').trim()
    assert.match(firstText.toLowerCase(), /sherbrooke/,
      `La première prédiction doit contenir "sherbrooke", reçu "${firstText}"`)

    // Clique la première suggestion → /api/places/details → l'input se remplit
    // avec formatted_address et le marqueur "✓ Vérifié" apparaît.
    await suggestions.first().click()
    await slidePage.waitForTimeout(800)

    const finalValue = await slidePage.locator('#qa-address').inputValue()
    assert.match(finalValue.toLowerCase(), /sherbrooke/,
      `L'input doit être rempli avec l'adresse sélectionnée, reçu "${finalValue}"`)

    // Le statut "verified" doit apparaître après sélection via Places.
    const verified = await slidePage.locator('#qa-address-status').evaluate(
      el => el.classList.contains('is-verified')
    )
    assert.equal(verified, true, 'Le marqueur ✓ doit être actif après sélection autocomplete')
  })
})
