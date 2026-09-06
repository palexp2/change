const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Le tableau de /champs/:table porte maintenant une ligne d'en-tête qui nomme
// ses colonnes (#, Nom, Type, Origine, [Sens, Champ Airtable], Actions).
//
// Lecture seule : aucun champ n'est renommé, créé ni supprimé — le test se
// contente de charger la page et de mesurer les colonnes. Rien à nettoyer.
describe('Configuration des champs — en-têtes de colonnes', () => {
  let browser, ctx, page

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
  })

  after(async () => { await browser?.close() })

  async function openFields(table) {
    await page.goto(`${URL}/champs/${table}`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('[data-testid^="fieldcfg-row-"]', { timeout: 25000 })
  }

  // Le contexte du signalement : /champs/tickets.
  test('/champs/tickets : la liste des champs est surmontée d’un en-tête', async () => {
    await openFields('tickets')
    const header = page.locator('[data-testid="fieldcfg-header"]')
    await header.waitFor({ timeout: 10000 })
    const txt = (await header.innerText()).toLowerCase()
    for (const label of ['nom', 'type', 'origine', 'actions']) {
      assert.ok(txt.includes(label), `l'en-tête doit nommer la colonne « ${label} » (vu : ${txt})`)
    }
    // L'en-tête est bien AU-DESSUS de la première ligne de champ.
    const hb = await header.boundingBox()
    const rb = await page.locator('[data-testid^="fieldcfg-row-"]').first().boundingBox()
    assert.ok(hb.y + hb.height <= rb.y + 1, 'l’en-tête doit précéder la première ligne')
  })

  test('la colonne « Nom » de l’en-tête s’aligne sur les champs de saisie', async () => {
    await openFields('tickets')
    const nameHeader = page.locator('[data-testid="fieldcfg-header"] > span').nth(1)
    const firstInput = page.locator('[data-testid^="fieldcfg-name-"]').first()
    const h = await nameHeader.boundingBox()
    const i = await firstInput.boundingBox()
    assert.ok(Math.abs(h.x - i.x) <= 2, `en-tête Nom à ${h.x}, champ à ${i.x} — doivent s’aligner`)
    assert.ok(Math.abs(h.width - i.width) <= 2, `largeurs : ${h.width} vs ${i.width}`)
  })

  test('les actions restent alignées d’une ligne à l’autre', async () => {
    await openFields('tickets')
    const edits = page.locator('[data-testid^="fieldcfg-edit-"]')
    const n = Math.min(await edits.count(), 6)
    assert.ok(n >= 2, 'au moins deux lignes de champs attendues')
    const xs = []
    for (let i = 0; i < n; i++) xs.push((await edits.nth(i).boundingBox()).x)
    for (const x of xs) {
      assert.ok(Math.abs(x - xs[0]) <= 2, `bouton « modifier » désaligné : ${xs.join(', ')}`)
    }
  })

  test('table branchée sur Airtable : en-tête « Sens » et « Champ Airtable » alignés', async () => {
    await openFields('projects')
    const header = page.locator('[data-testid="fieldcfg-header"]')
    await header.waitFor({ timeout: 10000 })
    const txt = (await header.innerText()).toLowerCase()
    assert.ok(txt.includes('champ airtable'), `en-tête sans « Champ Airtable » (vu : ${txt})`)
    assert.ok(txt.includes('sens'), `en-tête sans « Sens » (vu : ${txt})`)

    // Le picker Airtable de la première ligne tombe sous son en-tête.
    const spans = header.locator('> span')
    const at = page.locator('[data-testid^="fieldcfg-airtable-"]').first()
    await at.waitFor({ timeout: 25000 })
    const hb = await spans.nth(await spans.count() - 2).boundingBox()
    const cb = await at.boundingBox()
    assert.ok(Math.abs(hb.x - cb.x) <= 2, `en-tête Airtable à ${hb.x}, colonne à ${cb.x}`)
  })

  // L'en-tête doit décrire exactement ce que les lignes affichent : la colonne
  // « Champ Airtable » est annoncée si et seulement si les lignes la portent, et
  // TOUTES les lignes la portent alors (sinon elles se décalent entre elles).
  test('en-tête et lignes concordent sur plusieurs tables', async () => {
    for (const table of ['tickets', 'tasks', 'orders', 'contacts']) {
      await openFields(table)
      const header = page.locator('[data-testid="fieldcfg-header"]')
      await header.waitFor({ timeout: 10000 })
      const announced = (await header.innerText()).toLowerCase().includes('champ airtable')
      const rows = await page.locator('[data-testid^="fieldcfg-row-"]').count()
      const cells = await page.locator('[data-testid^="fieldcfg-airtable-"]').count()
      assert.equal(
        announced, cells > 0,
        `${table} : en-tête « Champ Airtable » ${announced ? 'annoncé' : 'absent'} mais ${cells} cellule(s)`
      )
      if (announced) {
        assert.equal(cells, rows, `${table} : ${cells} cellules Airtable pour ${rows} lignes — colonnes décalées`)
      }
    }
  })
})
