// Fiche entreprise : toutes les sections sont désormais empilées et affichées
// en même temps (plus d'onglets qui masquent le contenu). Le sélecteur latéral
// devient un scroll-spy : l'entrée surlignée suit la position de défilement, et
// un clic sur une entrée fait défiler jusqu'à la section correspondante.
//
// Test 100 % lecture seule : aucun record créé ni modifié.

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const COMPANY_ID = '6365031a-97b1-4a76-80cd-e989c0e2334a'

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 20000 })
}

// Positionne le haut de la section `key` juste sous le haut du conteneur de
// défilement (<main>), sans passer par la molette : les sous-tableaux captent
// le scroll de la souris.
async function scrollSectionToTop(page, key) {
  await page.evaluate((k) => {
    const main = document.querySelector('main')
    const el = document.querySelector(`[data-section="${k}"]`)
    if (!main || !el) throw new Error('conteneur ou section introuvable: ' + k)
    const delta = el.getBoundingClientRect().top - main.getBoundingClientRect().top
    main.scrollTop = main.scrollTop + delta - 20
    main.dispatchEvent(new Event('scroll'))
  }, key)
  await page.waitForTimeout(400)
}

function navLink(page, key) {
  return page.locator(`[data-section-link="${key}"]`)
}

describe('CompanyDetail — sections empilées + scroll-spy', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } })
    page = await ctx.newPage()
    await login(page)
    await page.goto(`${URL}/companies/${COMPANY_ID}`, { waitUntil: 'networkidle' })
    await page.locator('[data-testid="company-section-nav"]').waitFor({ state: 'visible', timeout: 20000 })
    await page.locator('[data-section="info"]').waitFor({ state: 'visible', timeout: 20000 })
  })

  after(async () => { await browser?.close() })

  test('toutes les sections sont rendues simultanément', async () => {
    const keys = await page.$$eval('[data-section]', els => els.map(e => e.getAttribute('data-section')))
    // Les 12 sections de base sont toujours là (+ achats/onboarding/qualification
    // selon l'entreprise).
    for (const expected of ['info', 'contacts', 'interactions', 'projets', 'commandes', 'envois', 'retours', 'support', 'numéros de série', 'factures', 'abonnements', 'tâches']) {
      assert.ok(keys.includes(expected), `section « ${expected} » absente du DOM (sections trouvées: ${keys.join(', ')})`)
    }

    // Le sélecteur latéral liste exactement les mêmes sections, dans le même ordre.
    const navKeys = await page.$$eval('[data-section-link]', els => els.map(e => e.getAttribute('data-section-link')))
    assert.deepEqual(navKeys, keys, 'ordre du sélecteur ≠ ordre des sections dans la page')

    // Deux sections éloignées ont bien leur contenu monté en même temps :
    // le tableau des contacts ET celui des factures existent sans changer d'onglet.
    await page.locator('[data-section="contacts"] [data-testid], [data-section="contacts"] table, [data-section="contacts"] .card, [data-section="contacts"] div').first().waitFor({ state: 'attached', timeout: 10000 })
    const facturesContent = await page.locator('[data-section="factures"]').innerText()
    const contactsContent = await page.locator('[data-section="contacts"]').innerText()
    assert.ok(contactsContent.trim().length > 0, 'section contacts vide')
    assert.ok(facturesContent.trim().length > 0, 'section factures vide')
  })

  test('au chargement, le sélecteur pointe sur la première section', async () => {
    assert.equal(await navLink(page, 'info').getAttribute('data-active'), 'true')
  })

  test('le sélecteur suit le défilement (scroll-spy)', async () => {
    for (const key of ['commandes', 'factures', 'tâches']) {
      await scrollSectionToTop(page, key)
      await page.waitForFunction(
        k => document.querySelector(`[data-section-link="${k}"]`)?.getAttribute('data-active') === 'true',
        key,
        { timeout: 5000 },
      ).catch(() => {})
      assert.equal(
        await navLink(page, key).getAttribute('data-active'),
        'true',
        `après défilement jusqu'à « ${key} », le sélecteur ne le surligne pas`,
      )
      // Une seule entrée active à la fois.
      assert.equal(await page.locator('[data-section-link][data-active="true"]').count(), 1)
    }
  })

  test('le sélecteur reste visible pendant le défilement (position collante)', async () => {
    await scrollSectionToTop(page, 'tâches')
    const nav = page.locator('[data-testid="company-section-nav"]')
    await nav.waitFor({ state: 'visible' })
    const box = await nav.boundingBox()
    assert.ok(box && box.y >= 0 && box.y < 400, `sélecteur hors écran après défilement (y=${box && box.y})`)
  })

  test('cliquer une entrée fait défiler jusqu\'à la section', async () => {
    // On repart du haut, puis on clique une section plus bas.
    await scrollSectionToTop(page, 'info')
    await navLink(page, 'support').click()

    // Le défilement est animé : on attend que la position se stabilise.
    let last = -1
    for (let i = 0; i < 20; i++) {
      await page.waitForTimeout(150)
      const pos = await page.evaluate(() => document.querySelector('main').scrollTop)
      if (pos === last) break
      last = pos
    }

    const { offset, atBottom } = await page.evaluate(() => {
      const main = document.querySelector('main')
      const el = document.querySelector('[data-section="support"]')
      return {
        offset: el.getBoundingClientRect().top - main.getBoundingClientRect().top,
        atBottom: main.scrollHeight - main.scrollTop - main.clientHeight < 6,
      }
    })
    // Tolérance : si le conteneur est déjà en butée basse, la section ne peut pas
    // remonter davantage.
    assert.ok(
      Math.abs(offset) < 60 || atBottom,
      `la section support n'est pas en haut du conteneur (offset ${offset}px, butée basse: ${atBottom})`,
    )
    assert.equal(await navLink(page, 'support').getAttribute('data-active'), 'true')
  })
})
