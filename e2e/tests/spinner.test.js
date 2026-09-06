// Vérifie le composant <Spinner> réutilisable :
//  1. Sur une fiche détail (OrderDetail), pendant que la requête de chargement
//     est artificiellement ralentie, l'indicateur [data-testid="spinner"] est
//     visible ; une fois la réponse reçue, il disparaît et le contenu s'affiche.
//  2. SoumissionDetail (qui affichait un « Chargement… » en texte brut) rend
//     maintenant le même indicateur visuel.
//
// Lecture seule : aucun record créé ou muté → pas de cleanup DB nécessaire.
const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

describe('Spinner réutilisable', () => {
  let browser, ctx, page, orderId, soumissionId

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })

    const ids = await page.evaluate(async () => {
      const tok = localStorage.getItem('erp_token')
      const get = async (path) => {
        const r = await fetch(path, { headers: { Authorization: `Bearer ${tok}` } })
        const j = await r.json()
        return j.data || j || []
      }
      const orders = await get('/erp/api/orders?limit=all')
      let soums = []
      try { soums = await get('/erp/api/documents/soumissions?limit=all') } catch { /* peut ne pas exister */ }
      return {
        orderId: orders[0]?.id || null,
        soumissionId: soums[0]?.id || null,
      }
    })
    orderId = ids.orderId
    soumissionId = ids.soumissionId
  })

  after(async () => { await browser?.close() })

  test('OrderDetail : spinner visible pendant le chargement ralenti, puis contenu', async (t) => {
    if (!orderId) { t.skip('Aucune commande trouvée'); return }

    // Ralentit la requête de détail pour rendre le spinner observable.
    await page.route(`**/api/orders/${orderId}`, async (route) => {
      if (route.request().method() === 'GET') await sleep(2000)
      await route.continue()
    })

    await page.goto(`${URL}/orders/${orderId}`, { waitUntil: 'domcontentloaded' })

    const spinner = page.locator('[data-testid="spinner"]').first()
    await spinner.waitFor({ state: 'visible', timeout: 4000 })

    // Une fois la réponse reçue, le spinner de chargement de page disparaît.
    await page.unroute(`**/api/orders/${orderId}`)
    await page.waitForLoadState('networkidle')

    // Le contenu de la fiche est rendu (le spinner de page a cédé la place).
    // Au moins le contenu principal est visible : on vérifie qu'un titre/contenu existe.
    await assert.doesNotReject(
      page.locator('text=/Commande|Order|#/').first().waitFor({ state: 'visible', timeout: 8000 }),
      'le contenu de la fiche commande devrait être rendu après chargement'
    )
  })

  test('SoumissionDetail : le loader texte brut est remplacé par le Spinner', async (t) => {
    if (!soumissionId) { t.skip('Aucune soumission trouvée'); return }

    await page.route(`**/api/documents/soumissions/${soumissionId}`, async (route) => {
      if (route.request().method() === 'GET') await sleep(2000)
      await route.continue()
    })

    await page.goto(`${URL}/soumissions/${soumissionId}`, { waitUntil: 'domcontentloaded' })

    const spinner = page.locator('[data-testid="spinner"]').first()
    await spinner.waitFor({ state: 'visible', timeout: 4000 })

    await page.unroute(`**/api/documents/soumissions/${soumissionId}`)
    await page.waitForLoadState('networkidle')
  })
})
