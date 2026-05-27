const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie que slide-3 (How we help) génère une slide par challenge coché.
// On charge la page guide en standalone (sans le parent React) pour isoler
// la logique multi-slide. Token JWT récupéré via login standard.
describe('Guide d\'appel — How we help : une slide par challenge coché', () => {
  let browser, ctx, token

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    const loginPage = await ctx.newPage()
    await loginPage.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await loginPage.fill('input[type="email"]', EMAIL)
    await loginPage.fill('input[type="password"]', PASS)
    await loginPage.click('button:has-text("Se connecter")')
    await loginPage.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    token = await loginPage.evaluate(() => localStorage.getItem('erp_token'))
    if (!token) throw new Error('Impossible de récupérer le JWT')
    await loginPage.close()
  })

  after(async () => {
    await browser?.close()
  })

  test('vue assistant : N nav-items help-sub nommés par challenge ; sub-pagination en client', async () => {
    // --- 1) Vue assistant (par défaut, sans ?view=client) : N help-sub items ---
    const aPage = await ctx.newPage()
    aPage.on('pageerror', err => console.log('PAGE ERROR:', err.message))
    aPage.on('console', msg => { if (msg.type() === 'error') console.log('CONSOLE ERROR:', msg.text()) })
    await aPage.goto(`${URL}/qualification-call-guide/index.html?token=${token}`, { waitUntil: 'domcontentloaded' })
    await aPage.waitForFunction(() => typeof getHelpPainsOrdered === 'function', null, { timeout: 5000 })

    // Coche 2 pains : tied_to_farm (rank 1) + crop_yields (rank 3)
    // Les li sont dans slide-1 (display:none en assistant) ; .click() suffit ici
    // car on opère dans le contexte JS de la page (pas Playwright visibility check).
    await aPage.evaluate(() => {
      document.querySelector('#discovery-list li[data-pain="crop_yields"]').click()
      document.querySelector('#discovery-list li[data-pain="tied_to_farm"]').click()
    })
    await aPage.waitForTimeout(200)

    const checkedPains = await aPage.locator('#discovery-list li.checked').evaluateAll(els => els.map(el => el.dataset.pain))
    assert.deepEqual(checkedPains.sort(), ['crop_yields', 'tied_to_farm'].sort(), '2 pains cochés attendus')

    const helpSubCount = await aPage.locator('.nav-item.help-sub').count()
    assert.equal(helpSubCount, 2, 'vue assistant : 2 nav-items help-sub')

    const labels = await aPage.locator('.nav-item.help-sub .nav-text').allTextContents()
    // Ordre par rank : tied_to_farm (1) < crop_yields (3)
    assert.equal(labels[0].trim(), 'Feeling tied to the farm and unable to step away')
    assert.equal(labels[1].trim(), 'Increasing crop yields')

    // Décocher tout → 1 seul help-sub item avec le label générique "How we help"
    await aPage.evaluate(() => {
      document.querySelector('#discovery-list li[data-pain="crop_yields"]').click()
      document.querySelector('#discovery-list li[data-pain="tied_to_farm"]').click()
    })
    await aPage.waitForTimeout(150)
    const fallbackCount = await aPage.locator('.nav-item.help-sub').count()
    assert.equal(fallbackCount, 1, 'fallback 0 pain : 1 seul help-sub item')
    const fallbackLabel = await aPage.locator('.nav-item.help-sub .nav-text').first().textContent()
    assert.equal(fallbackLabel.trim(), 'How we help')
    await aPage.close()

    // --- 2) Vue client (?view=client) : sub-pagination Next à travers les N pains ---
    const cPage = await ctx.newPage()
    await cPage.goto(`${URL}/qualification-call-guide/index.html?view=client&token=${token}`, { waitUntil: 'domcontentloaded' })
    await cPage.waitForFunction(() => typeof getHelpPainsOrdered === 'function', null, { timeout: 5000 })

    // Coche 2 pains (slide-1 pas visible → click via JS)
    await cPage.evaluate(() => {
      document.querySelector('#discovery-list li[data-pain="crop_yields"]').click()
      document.querySelector('#discovery-list li[data-pain="tied_to_farm"]').click()
    })
    await cPage.waitForTimeout(150)

    // Vue client : pas de help-sub class, juste un nav-item "How we help"
    const popupHelpSub = await cPage.locator('.nav-item.help-sub').count()
    assert.equal(popupHelpSub, 0, 'vue client : pas de help-sub class')
    const popupHowItems = await cPage.locator('.nav-item[data-idx="3"]').count()
    assert.equal(popupHowItems, 1, 'vue client : un seul nav-item How we help')

    // Navigue vers slide-3
    await cPage.evaluate(() => goTo(3))
    await cPage.locator('#slide-3.visible').waitFor({ state: 'visible', timeout: 3000 })

    // Premier pain (tied_to_farm) affiché
    let bullets = await cPage.locator('#how-bullets .how-bullet').allTextContents()
    assert.equal(bullets.length, 2, '2 bullets : primary + secondary')
    assert.equal(bullets[0].trim(), 'Monitor and control everything from your phone, wherever you are.')
    assert.equal(bullets[1].trim(), 'Irrigation runs automatically. No timer to adjust, no one to train, no need to stay.')

    // Next → toujours sur slide-3 mais pain suivant (crop_yields)
    await cPage.evaluate(() => changeSlide(1))
    await cPage.waitForTimeout(150)
    const stillOn3 = await cPage.locator('#slide-3.visible').count()
    assert.equal(stillOn3, 1, 'Next 1 : reste sur slide-3 (sub-pagination)')
    bullets = await cPage.locator('#how-bullets .how-bullet').allTextContents()
    assert.equal(bullets[0].trim(), 'Constant micro-adjustments, every two minutes, so your plants are always in their productive zone.')

    // Next encore → passe à slide-4
    await cPage.evaluate(() => changeSlide(1))
    await cPage.waitForTimeout(150)
    const onSlide4 = await cPage.locator('#slide-4.visible').count()
    assert.equal(onSlide4, 1, 'Next 2 : passe à slide-4')

    // Prev → revient sur slide-3 sur le DERNIER pain
    await cPage.evaluate(() => changeSlide(-1))
    await cPage.waitForTimeout(150)
    bullets = await cPage.locator('#how-bullets .how-bullet').allTextContents()
    assert.equal(bullets[0].trim(), 'Constant micro-adjustments, every two minutes, so your plants are always in their productive zone.',
      'Prev depuis slide-4 : revient sur le dernier pain')

    await cPage.close()
  })
})
