// Conformité tâche « Indicateur d'autosave unifié » : le composant partagé
// SaveStatus (client/src/components/SaveStatus.jsx) doit afficher « Sauvegarde… »
// pendant la requête puis « Sauvegardé » après succès, sur les fiches détail en
// autosave (ProductDetail, CompanyDetail, ContactDetail).
//
// Ce test édite un champ texte d'un produit et vérifie que l'indicateur
// « Sauvegardé » apparaît. Il MODIFIE un record existant → il lit la valeur
// d'origine avant et la RESTAURE dans after() (règle CLAUDE.md « sauvegarder/
// restaurer les configurations écrasées par les tests E2E »).

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const API = URL.replace(/\/erp\/?$/, '') + '/api'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
}

async function apiToken() {
  const r = await fetch(API + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASS }),
  })
  return (await r.json()).token
}

describe('SaveStatus — indicateur d\'autosave unifié', () => {
  let browser, page, token, auth
  let productId, originalManufacturier

  before(async () => {
    token = await apiToken()
    auth = { headers: { Authorization: 'Bearer ' + token } }

    const list = await (await fetch(API + '/products?limit=all', auth)).json()
    const items = list.items || list.data || list
    const p = (Array.isArray(items) ? items : []).find(x => x.id)
    assert.ok(p, 'aucun produit trouvé')
    productId = p.id
    // Valeur d'origine à restaurer en fin de test.
    const full = await (await fetch(API + '/products/' + productId, auth)).json()
    originalManufacturier = full.manufacturier ?? ''

    browser = await chromium.launch()
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await login(page)
  })

  after(async () => {
    // Restaure toujours la valeur d'origine, même si le test a échoué.
    if (productId !== undefined) {
      await fetch(API + '/products/' + productId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
        body: JSON.stringify({ manufacturier: originalManufacturier }),
      }).catch(() => {})
    }
    if (browser) await browser.close()
  })

  test('édition d\'un champ → « Sauvegardé » apparaît dans le header', async () => {
    await page.goto(`${URL}/products/${productId}`, { waitUntil: 'domcontentloaded' })

    // Le champ texte « Nom fabricant » est visible par défaut sur l'onglet Informations.
    const label = page.locator('label:text-is("Nom fabricant")')
    await label.first().waitFor({ state: 'visible', timeout: 10000 })
    const input = label.first().locator('xpath=following-sibling::input[1]')
    await input.waitFor({ state: 'visible', timeout: 10000 })

    await input.fill(`E2E test ${Date.now()}`)

    // L'indicateur unifié doit confirmer la sauvegarde (debounce 300ms + requête).
    const saved = page.locator('text=Sauvegardé')
    await saved.first().waitFor({ state: 'visible', timeout: 10000 })
    assert.ok(await saved.first().isVisible(), 'l\'indicateur « Sauvegardé » est affiché')
  })
})
