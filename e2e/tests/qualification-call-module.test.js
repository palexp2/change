const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie le flow complet du module Appels de qualification :
// 1. Login → /qualification-call
// 2. La page affiche un DataTable des appels existants + bouton "Nouvel appel"
// 3. Click "Nouvel appel" → dropdown avec search → sélectionne une entreprise
// 4. L'iframe charge le guide HTML en mode assistant (formulaire CACHÉ — slide-0/1 display:none)
// 5. Click "Open slide view ↗" → popup ouvre la vue client (formulaire visible)
// 6. Tape dans #qa-2 dans la popup → broadcast → iframe → autosave en DB
// 7. Coche un pain point dans la popup → broadcast → iframe → autosave (pain_points JSON)
// 8. Vérifie en DB que la valeur est persistée et rattachée à la bonne company
// 9. Retour à la liste → la nouvelle ligne apparaît dans le DataTable
// 10. Nettoie le record créé par le test
describe('Module Appels de qualification — flow complet', () => {
  let browser, ctx, page, db
  let companyId, companyName
  let createdCallId = null

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
    // Cible une company existante au nom prévisible
    const row = db.prepare(`
      SELECT id, name FROM companies
      WHERE name IS NOT NULL AND name != ''
      ORDER BY name LIMIT 1
    `).get()
    if (!row) throw new Error('Aucune company en DB')
    companyId = row.id
    companyName = row.name

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
    db?.close()
    await browser?.close()
  })

  test('création d\'un appel, autosave d\'un champ texte et d\'un pain point', async () => {
    await page.goto(`${URL}/qualification-call`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')

    // En-tête de page (titre pluriel) + bouton Nouvel appel visibles
    await page.waitForSelector('h1:has-text("Appels de qualification")', { timeout: 8000 })
    const newCallBtn = page.locator('button:has-text("Nouvel appel")').first()
    await newCallBtn.waitFor({ state: 'visible', timeout: 5000 })

    // Ouvre le dropdown, recherche la company, clique
    await newCallBtn.click()
    await page.waitForSelector('input[placeholder*="Rechercher une entreprise"]', { timeout: 5000 })
    await page.fill('input[placeholder*="Rechercher une entreprise"]', companyName)
    await page.waitForTimeout(150)
    const item = page.locator(`button:has-text("${companyName}")`).first()
    await item.waitFor({ state: 'visible', timeout: 5000 })
    await item.click()

    // L'iframe doit apparaître. On attend que l'assistant-panel soit visible
    // (le formulaire slide-0 est volontairement caché en mode assistant).
    const frameLoc = page.frameLocator('iframe[title="Guide d\'appel de qualification"]')
    await frameLoc.locator('#assistant-panel').waitFor({ state: 'visible', timeout: 10000 })

    // Capture l'id du record fraîchement créé pour le cleanup. On le fait dès que
    // l'iframe est là, AVANT toute assertion qui pourrait planter, sinon un test
    // qui échoue laisse un orphelin en DB.
    const fresh = db.prepare(`
      SELECT id FROM qualification_calls
      WHERE company_id = ? AND airtable_record_id LIKE 'local_%'
      ORDER BY created_at DESC LIMIT 1
    `).get(companyId)
    if (fresh) createdCallId = fresh.id

    // En mode assistant, slide-0 (Your farm) et slide-1 (Discovery) doivent être
    // hidden — le vendeur ne voit que les scripts/battlecards, pas le formulaire.
    const slide0Hidden = await frameLoc.locator('#slide-0').isHidden()
    const slide1Hidden = await frameLoc.locator('#slide-1').isHidden()
    assert.ok(slide0Hidden, 'slide-0 (Your farm) doit être hidden en vue assistant')
    assert.ok(slide1Hidden, 'slide-1 (Discovery) doit être hidden en vue assistant')

    // Pour remplir le formulaire on doit ouvrir la slide view via le bouton dédié.
    // Le clic appelle window.open() → popup. Playwright capture le popup via l'event.
    const [slidePage] = await Promise.all([
      page.waitForEvent('popup', { timeout: 5000 }),
      frameLoc.locator('#open-assistant').click(),
    ])
    await slidePage.waitForLoadState('domcontentloaded')
    // En vue client, slide-0 est l'unique slide visible au démarrage.
    await slidePage.locator('#qa-farm').waitFor({ state: 'visible', timeout: 5000 })

    // Le farm name est pré-rempli (URL ?company_name=…) dans la slide view aussi.
    for (let i = 0; i < 20; i++) {
      const v = await slidePage.locator('#qa-farm').inputValue()
      if (v === companyName) break
      await slidePage.waitForTimeout(150)
    }
    const farmVal = await slidePage.locator('#qa-farm').inputValue()
    assert.equal(farmVal, companyName, 'Le champ Farm name doit être pré-rempli avec le nom de l\'entreprise')

    // Tape une motivation unique dans la slide view → BroadcastChannel sync →
    // iframe (vue assistant) → postMessage save → React parent → PATCH DB.
    const motivation = `__test_motivation_${Date.now()}`
    await slidePage.locator('#qa-2').fill(motivation)
    // Blur pour forcer le push immédiat côté iframe
    await slidePage.locator('#qa-1').click()
    // Attend le broadcast + debounce + PATCH
    await page.waitForTimeout(1500)

    // Coche un pain point dans la slide view (slide-1 = Discovery).
    // On navigue d'abord vers slide-1 via le clic sur l'item de nav "Discovery".
    // En vue client, la sidebar nav fait goTo(1) → slide-1 devient .visible.
    // Discovery est marqué hidden:true dans labels, donc pas dans la nav. On utilise
    // les raccourcis clavier — ou directement on rend slide-1 visible programmatiquement.
    await slidePage.evaluate(() => {
      // goTo(1) est défini dans le scope du script — appel direct.
      // eslint-disable-next-line no-undef
      if (typeof goTo === 'function') goTo(1)
    })
    await slidePage.locator('#discovery-list').waitFor({ state: 'visible', timeout: 3000 })
    await slidePage.locator('[data-pain="crop_yields"]').click()
    await page.waitForTimeout(1500)

    // Vérifie en DB : un seul record pour cette company avec cette motivation
    const dbRow = db.prepare(`
      SELECT id, company_id, motivation_today, pain_points, contact_full_name
      FROM qualification_calls
      WHERE company_id = ? AND motivation_today = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(companyId, motivation)
    assert.ok(dbRow, 'Le record qualification_call doit avoir été créé et la motivation persistée')
    assert.equal(dbRow.id, createdCallId, 'L\'id capté à la création doit correspondre au record persisté')
    assert.equal(dbRow.company_id, companyId)
    assert.equal(dbRow.motivation_today, motivation)

    // pain_points est stocké en JSON
    let pains = []
    try { pains = JSON.parse(dbRow.pain_points || '[]') } catch {}
    assert.ok(Array.isArray(pains) && pains.includes('crop_yields'),
      'Le pain point crop_yields doit être présent en DB')

    // Retour à la liste — la nouvelle ligne doit apparaître dans le DataTable
    await page.locator('button:has-text("Retour à la liste")').click()
    await page.waitForLoadState('networkidle')
    await page.waitForSelector(`text=${motivation}`, { timeout: 5000 })
  })
})
