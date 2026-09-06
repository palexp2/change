const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Flow "Nouvelle entreprise" depuis le dropdown Nouvel appel :
// 1. Click "Nouvel appel" → bouton "Nouvelle entreprise" visible AU-DESSUS de la barre de recherche
// 2. Click → company vide créée + qualification_call créé attaché → iframe ouvert avec editable_farm=1
// 3. Open slide view → #qa-farm n'est PAS readonly (alors qu'il l'est en mode entreprise existante)
// 4. Tape un nom dans #qa-farm dans la slide view → broadcast → iframe → PATCH companies.name
// 5. Vérifie en DB que companies.name a bien été mis à jour
// 6. Cleanup : supprime le call ET la company créés
describe('Nouvel appel — flow Nouvelle entreprise', () => {
  let browser, ctx, page, db
  let createdCompanyId = null
  let createdCallId = null

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
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
      try { db.prepare('DELETE FROM qualification_calls WHERE id = ?').run(createdCallId) } catch {}
    }
    if (createdCompanyId) {
      try { db.prepare('DELETE FROM companies WHERE id = ?').run(createdCompanyId) } catch {}
    }
    db?.close()
    await browser?.close()
  })

  test('Nouvelle entreprise crée company vide + call éditable, farm name autosave companies.name', async () => {
    await page.goto(`${URL}/qualification-call`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')

    await page.waitForSelector('h1:has-text("Appels de qualification")', { timeout: 8000 })
    await page.locator('button:has-text("Nouvel appel")').first().click()

    // Bouton "Nouvelle entreprise" doit apparaître AU-DESSUS de la barre de recherche.
    // On vérifie visuellement la position relative.
    const nouvelleBtn = page.locator('button:has-text("Nouvelle entreprise")').first()
    await nouvelleBtn.waitFor({ state: 'visible', timeout: 5000 })
    const searchInput = page.locator('input[placeholder*="Rechercher une entreprise"]')
    await searchInput.waitFor({ state: 'visible', timeout: 5000 })
    const btnBox = await nouvelleBtn.boundingBox()
    const searchBox = await searchInput.boundingBox()
    assert.ok(btnBox && searchBox, 'Bouton et search doivent avoir une bounding box')
    assert.ok(btnBox.y < searchBox.y, '"Nouvelle entreprise" doit être au-dessus de la barre de recherche')

    // Snapshot des companies AVANT clic pour identifier celle qui sera créée
    const beforeIds = new Set(db.prepare('SELECT id FROM companies').all().map(r => r.id))

    await nouvelleBtn.click()

    // L'iframe charge avec editable_farm=1
    const frameLoc = page.frameLocator('iframe[title="Guide d\'appel de qualification"]')
    await frameLoc.locator('#assistant-panel').waitFor({ state: 'visible', timeout: 10000 })

    // Identifie la company nouvellement créée
    const allCompanies = db.prepare('SELECT id, name FROM companies').all()
    const newCompany = allCompanies.find(c => !beforeIds.has(c.id))
    assert.ok(newCompany, 'Une nouvelle company doit avoir été créée')
    createdCompanyId = newCompany.id
    assert.equal(newCompany.name, '', 'La company doit être créée avec un nom vide')

    // Identifie le call attaché
    const callRow = db.prepare(`
      SELECT id FROM qualification_calls WHERE company_id = ?
      ORDER BY created_at DESC LIMIT 1
    `).get(createdCompanyId)
    assert.ok(callRow, 'Un qualification_call doit avoir été créé pour cette company')
    createdCallId = callRow.id

    // Vérifie que l'URL de l'iframe contient editable_farm=1
    const iframeEl = await page.locator('iframe[title="Guide d\'appel de qualification"]').first()
    const src = await iframeEl.getAttribute('src')
    assert.match(src, /editable_farm=1/, 'L\'URL de l\'iframe doit contenir editable_farm=1')

    // Ouvre la slide view popup pour atteindre slide-0 (formulaire)
    const [slidePage] = await Promise.all([
      page.waitForEvent('popup', { timeout: 5000 }),
      frameLoc.locator('#open-assistant').click(),
    ])
    await slidePage.waitForLoadState('domcontentloaded')
    await slidePage.locator('#qa-farm').waitFor({ state: 'visible', timeout: 5000 })

    // En mode editable_farm=1, le champ farm doit être éditable (pas readonly)
    const isReadonly = await slidePage.locator('#qa-farm').evaluate(el => el.hasAttribute('readonly'))
    assert.equal(isReadonly, false, '#qa-farm doit être éditable quand editable_farm=1')

    // Tape un nom de ferme et déclenche save (blur)
    const farmName = `E2E Farm ${Date.now()}`
    await slidePage.locator('#qa-farm').fill(farmName)
    await slidePage.locator('#qa-contact').click() // blur qa-farm → broadcast → iframe → PATCH
    await page.waitForTimeout(1500) // laisse passer broadcast + debounce + PATCH

    // Vérifie en DB que companies.name a été mis à jour
    const updated = db.prepare('SELECT name FROM companies WHERE id = ?').get(createdCompanyId)
    assert.equal(updated.name, farmName, 'companies.name doit avoir été mis à jour avec le farm name tapé')
  })
})
