const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie que la sidebar du guide d'appel, en mode assistant, contient
// désormais deux items Step 0 (Qualification + Discovery) que le vendeur peut
// utiliser pour naviguer. La vue client (popup) garde sa sidebar à 6 étapes.
describe('Guide d\'appel — sidebar avec Step 0 (Qualification + Discovery)', () => {
  let browser, ctx, page, db
  let companyId, companyName
  let createdCallId = null

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
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

  test('vue assistant : sidebar a 8 items dont 2 Step 0, vue client : 6 items', async () => {
    // ── Crée un appel
    await page.goto(`${URL}/qualification-call`, { waitUntil: 'domcontentloaded' })
    await page.waitForLoadState('networkidle')
    await page.locator('button:has-text("Nouvel appel")').first().click()
    await page.fill('input[placeholder*="Rechercher une entreprise"]', companyName)
    await page.waitForTimeout(150)
    await page.locator(`button:has-text("${companyName}")`).first().click()

    const frame = page.frameLocator('iframe[title="Guide d\'appel de qualification"]')
    await frame.locator('#assistant-panel').waitFor({ state: 'visible', timeout: 10000 })

    // Cleanup ID dès que l'iframe est là
    const fresh = db.prepare(`
      SELECT id FROM qualification_calls
      WHERE company_id = ? AND airtable_record_id LIKE 'local_%'
      ORDER BY created_at DESC LIMIT 1
    `).get(companyId)
    if (fresh) createdCallId = fresh.id

    // ── Vue assistant : sidebar doit avoir 8 nav-items
    const assistantNavItems = await frame.locator('#nav .nav-item').count()
    assert.equal(assistantNavItems, 8, 'Vue assistant doit avoir 8 items (Qualification + Discovery + 6 visibles)')

    // Les deux premiers doivent être Step 0 (class is-step-zero, num-text "0")
    const firstNum = await frame.locator('#nav .nav-item').nth(0).locator('.num-text').textContent()
    const secondNum = await frame.locator('#nav .nav-item').nth(1).locator('.num-text').textContent()
    assert.equal(firstNum.trim(), '0', 'Premier item nav doit afficher 0 (Qualification)')
    assert.equal(secondNum.trim(), '0', 'Deuxième item nav doit afficher 0 (Discovery)')

    const firstText = await frame.locator('#nav .nav-item').nth(0).locator('.nav-text').textContent()
    const secondText = await frame.locator('#nav .nav-item').nth(1).locator('.nav-text').textContent()
    assert.equal(firstText.trim(), 'Qualification')
    assert.equal(secondText.trim(), 'Discovery')

    // Le 3e item doit être Introduction avec num "0" (Step 0 partagé pour le vendeur ET le client)
    const thirdNum = await frame.locator('#nav .nav-item').nth(2).locator('.num-text').textContent()
    const thirdText = await frame.locator('#nav .nav-item').nth(2).locator('.nav-text').textContent()
    assert.equal(thirdNum.trim(), '0')
    assert.equal(thirdText.trim(), 'Introduction')

    // Le 4e item doit être How we help avec num "1" (premier vrai step compté)
    const fourthNum = await frame.locator('#nav .nav-item').nth(3).locator('.num-text').textContent()
    const fourthText = await frame.locator('#nav .nav-item').nth(3).locator('.nav-text').textContent()
    assert.equal(fourthNum.trim(), '1')
    assert.equal(fourthText.trim(), 'How we help')

    // ── Click sur Discovery doit naviguer cur à 1 et garder assistant-panel visible
    await frame.locator('#nav .nav-item').nth(1).click()
    await page.waitForTimeout(200)
    const isActive = await frame.locator('#nav .nav-item').nth(1).evaluate(el => el.classList.contains('active'))
    assert.ok(isActive, 'L\'item Discovery doit devenir actif après le clic')

    // L'eyebrow de slide-1 doit dire « Step 0 · Discovery »
    const eyebrow1 = await frame.locator('#slide-1 .step-eyebrow').textContent()
    assert.equal(eyebrow1.trim(), 'Step 0 · Discovery')

    // Slides toujours hidden (le formulaire reste dans la popup)
    assert.ok(await frame.locator('#slide-0').isHidden(), 'slide-0 doit rester hidden en assistant')
    assert.ok(await frame.locator('#slide-1').isHidden(), 'slide-1 doit rester hidden en assistant')

    // ── Boutons Back / Next visibles et cliquables dans la vue assistant
    const backBtn = frame.locator('#prev')
    const nextBtn = frame.locator('#next')
    await backBtn.waitFor({ state: 'visible', timeout: 3000 })
    await nextBtn.waitFor({ state: 'visible', timeout: 3000 })
    assert.equal((await backBtn.textContent()).trim(), '← Back')

    // On est sur Discovery (cur=1). Back doit ramener sur Qualification (cur=0).
    await backBtn.click()
    await page.waitForTimeout(200)
    const qualifActive = await frame.locator('#nav .nav-item').nth(0).evaluate(el => el.classList.contains('active'))
    assert.ok(qualifActive, 'Après Back, Qualification doit être active')
    // À cur=0, Back doit être disabled
    assert.ok(await backBtn.isDisabled(), 'Back doit être disabled sur le premier item')

    // Next doit avancer cur de 0 → 1 (Discovery)
    await nextBtn.click()
    await page.waitForTimeout(200)
    const discoveryActive = await frame.locator('#nav .nav-item').nth(1).evaluate(el => el.classList.contains('active'))
    assert.ok(discoveryActive, 'Après Next, Discovery doit être active')

    // ── Vue client (popup) : le DOM de la sidebar ne doit contenir que les 6 étapes.
    // Le sidebar est CSS-hidden en focus mode mais le DOM est construit — on vérifie
    // donc le contenu DOM, pas la visibilité.
    const [slidePage] = await Promise.all([
      page.waitForEvent('popup'),
      frame.locator('#open-assistant').click(),
    ])
    await slidePage.waitForLoadState('domcontentloaded')
    await slidePage.waitForFunction(() => document.querySelectorAll('#nav .nav-item').length > 0, null, { timeout: 5000 })
    const clientNavCount = await slidePage.locator('#nav .nav-item').count()
    assert.equal(clientNavCount, 6, 'Vue client doit garder 6 items (sans Qualification ni Discovery)')

    // Premier item de la vue client = Introduction (num 0, Step 0)
    const clientFirstNum = await slidePage.locator('#nav .nav-item').nth(0).locator('.num-text').textContent()
    const clientFirstText = await slidePage.locator('#nav .nav-item').nth(0).locator('.nav-text').textContent()
    assert.equal(clientFirstNum.trim(), '0')
    assert.equal(clientFirstText.trim(), 'Introduction')

    // Second item de la vue client = How we help avec num 1
    const clientSecondNum = await slidePage.locator('#nav .nav-item').nth(1).locator('.num-text').textContent()
    const clientSecondText = await slidePage.locator('#nav .nav-item').nth(1).locator('.nav-text').textContent()
    assert.equal(clientSecondNum.trim(), '1')
    assert.equal(clientSecondText.trim(), 'How we help')

    await slidePage.close()
  })
})
