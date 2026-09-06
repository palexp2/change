const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Régression : après un upload sur « Extraction de données », le document
// fraîchement téléversé doit APPARAÎTRE dans le tableau sans rechargement
// manuel de la page. Le rechargement de la liste tapait le cache de requêtes
// (TTL 30 s) rempli au montage de la page, et cette réponse d'avant l'upload
// écrasait l'état — le nouveau document restait invisible.

// 1x1 PNG transparent (valide pour multer + filtre de format)
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

describe('Extraction de données : la liste se rafraîchit après un upload', () => {
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
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))
  })

  after(async () => {
    // Cleanup : supprime le reçu créé par le test, même en cas d'échec.
    if (createdId) {
      await page.request.delete(URL + '/api/sale-receipts/' + createdId, {
        headers: { Authorization: 'Bearer ' + token },
      }).catch(() => {})
    }
    await browser?.close()
  })

  test('le document téléversé apparaît dans le tableau sans reload', async () => {
    await page.goto(URL + '/sale-receipts', { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Extraction de données")', { timeout: 15000 })
    // Le montage de la page peuple le cache de la liste : c'est cette entrée
    // obsolète qui masquait le nouveau document.
    await page.waitForSelector('input[placeholder="Rechercher..."]', { timeout: 15000 })

    const idsBefore = new Set(
      (await (await page.request.get(URL + '/api/sale-receipts?limit=all', {
        headers: { Authorization: 'Bearer ' + token },
      })).json()).data.map(r => String(r.id))
    )

    const fileName = `e2e-refresh-${Date.now()}.png`
    await page.locator('[data-testid="upload-zone"] input[type="file"]')
      .setInputFiles({ name: fileName, mimeType: 'image/png', buffer: PNG_1x1 })

    // Attendre la fin du téléversement (le spinner de la zone disparaît).
    await page.waitForSelector('text=Téléversement en cours…', { state: 'detached', timeout: 30000 })

    // Récupérer l'id créé tôt pour garantir le cleanup même si l'assertion échoue.
    const rowsAfter = (await (await page.request.get(URL + '/api/sale-receipts?limit=all', {
      headers: { Authorization: 'Bearer ' + token },
    })).json()).data
    const created = rowsAfter.find(r => !idsBefore.has(String(r.id)))
    assert.ok(created, "L'upload doit avoir créé un reçu côté serveur")
    createdId = created.id

    // Filtrer le tableau sur le nom du fichier (searchFields inclut
    // original_name) : la ligne doit être présente dans l'état de la liste,
    // donc rendue — sans jamais recharger la page.
    await page.fill('input[placeholder="Rechercher..."]', fileName)

    const row = page.locator(`[data-row-id="${createdId}"]`)
    await row.waitFor({ state: 'visible', timeout: 15000 })
    assert.equal(await page.locator('[data-row-id]').count(), 1, 'Seule la ligne du fichier téléversé doit rester après filtrage')
    assert.match(await row.innerText(), new RegExp(fileName), 'La ligne doit afficher le nom du fichier téléversé')

    // Aucune navigation : on est toujours sur la liste.
    assert.match(page.url(), /\/sale-receipts$/, `URL doit rester /sale-receipts, vu : ${page.url()}`)
  })
})
