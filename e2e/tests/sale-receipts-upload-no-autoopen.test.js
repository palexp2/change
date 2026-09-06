const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Vérifie qu'après avoir déposé un document dans la zone d'upload de la page
// « Extraction de données », on RESTE sur la liste : pas de navigation auto
// vers la fiche détail. Le document apparaît simplement dans le tableau.

// 1x1 PNG transparent (valide pour multer + filtre de format)
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

describe('Extraction de données : upload sans ouverture auto', () => {
  let browser, ctx, page
  let token, createdId

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 10000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))
  })

  after(async () => {
    // Cleanup : supprime le reçu créé par le test, même en cas d'échec.
    if (createdId) {
      await page.request.delete(URL + '/api/sale-receipts/' + createdId, {
        headers: { Authorization: 'Bearer ' + token },
      })
    }
    await browser?.close()
  })

  test('déposer un document l\'ajoute à la liste et reste sur /sale-receipts', async () => {
    await page.goto(URL + '/sale-receipts', { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Extraction de données")', { timeout: 10000 })

    // Compte de reçus avant upload (via API pour fiabilité)
    const before = await page.request.get(URL + '/api/sale-receipts?limit=all', {
      headers: { Authorization: 'Bearer ' + token },
    })
    const idsBefore = new Set(((await before.json()).data || []).map(r => String(r.id)))

    // Dépose le fichier via l'input caché de la zone d'upload
    const fileName = `e2e-no-autoopen-${Date.now()}.png`
    const input = page.locator('[data-testid="upload-zone"] input[type="file"]')
    await input.setInputFiles({ name: fileName, mimeType: 'image/png', buffer: PNG_1x1 })

    // L'upload se fait, la liste recharge — mais l'URL NE DOIT PAS changer vers une fiche détail.
    // On laisse le temps au POST + reload de la liste de s'exécuter.
    await page.waitForTimeout(4000)

    assert.doesNotMatch(
      page.url(),
      /\/sale-receipts\/[^/]+$/,
      `On doit rester sur la liste, pas ouvrir la fiche. URL vue : ${page.url()}`
    )
    assert.match(page.url(), /\/sale-receipts$/, `URL doit rester /sale-receipts, vu : ${page.url()}`)

    // Le nouveau reçu existe bien en DB et n'était pas là avant
    const afterResp = await page.request.get(URL + '/api/sale-receipts?limit=all', {
      headers: { Authorization: 'Bearer ' + token },
    })
    const rowsAfter = (await afterResp.json()).data || []
    const created = rowsAfter.find(r => !idsBefore.has(String(r.id)))
    assert.ok(created, 'Un nouveau reçu doit avoir été créé par l\'upload')
    createdId = created.id
  })
})
