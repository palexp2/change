const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'https://customer.orisha.io/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// La zone d'import de « Extraction de données » accepte plusieurs fichiers à la
// fois : chaque fichier devient un DOCUMENT distinct (pas des pages d'un même
// document). On vérifie qu'un setInputFiles de 3 fichiers crée 3 reçus.

// 1x1 PNG transparent (valide pour multer + filtre de format)
const PNG_1x1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
)

describe('Extraction de données : import de plusieurs documents à la fois', () => {
  let browser, ctx, page
  let token
  const createdIds = []

  async function listIds() {
    const res = await page.request.get(URL + '/api/sale-receipts?limit=all', {
      headers: { Authorization: 'Bearer ' + token },
    })
    return (await res.json()).data
  }

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
    // Cleanup : supprime les reçus créés par le test, même en cas d'échec.
    for (const id of createdIds) {
      await page.request.delete(URL + '/api/sale-receipts/' + id, {
        headers: { Authorization: 'Bearer ' + token },
      }).catch(() => {})
    }
    await browser?.close()
  })

  test('la zone accepte le multiple et crée un document par fichier', async () => {
    await page.goto(URL + '/sale-receipts', { waitUntil: 'networkidle' })
    await page.waitForSelector('h1:has-text("Extraction de données")', { timeout: 15000 })
    await page.waitForSelector('input[placeholder="Rechercher..."]', { timeout: 15000 })

    const input = page.locator('[data-testid="upload-zone"] input[type="file"]')
    assert.ok(await input.evaluate(el => el.multiple), "L'input de la zone d'import doit accepter plusieurs fichiers")

    const stamp = Date.now()
    const names = [1, 2, 3].map(n => `e2e-multi-${stamp}-${n}.png`)
    const idsBefore = new Set((await listIds()).map(r => String(r.id)))

    await input.setInputFiles(names.map(name => ({ name, mimeType: 'image/png', buffer: PNG_1x1 })))

    // Fin du téléversement : le libellé de progression disparaît.
    await page.waitForSelector('[data-testid="upload-progress"]', { state: 'detached', timeout: 60000 })

    // Récupérer les ids créés tôt pour garantir le cleanup même si une
    // assertion échoue ensuite.
    const rowsAfter = await listIds()
    const created = rowsAfter.filter(r => !idsBefore.has(String(r.id)))
    createdIds.push(...created.map(r => r.id))

    assert.equal(created.length, 3, `3 documents distincts doivent être créés, vu : ${created.length}`)
    const createdNames = created.map(r => r.original_name).sort()
    assert.deepEqual(createdNames, [...names].sort(), 'Chaque fichier doit devenir un document portant son propre nom')

    // Les 3 lignes sont visibles dans le tableau sans rechargement de la page.
    await page.fill('input[placeholder="Rechercher..."]', `e2e-multi-${stamp}`)
    for (const id of createdIds) {
      await page.locator(`[data-row-id="${id}"]`).waitFor({ state: 'visible', timeout: 15000 })
    }
    assert.equal(await page.locator('[data-row-id]').count(), 3, 'Le tableau doit montrer les 3 documents importés')

    assert.match(page.url(), /\/sale-receipts$/, `URL doit rester /sale-receipts, vu : ${page.url()}`)
  })
})
