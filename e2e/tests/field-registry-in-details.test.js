const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS || 'saluerlessoviets'
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

const TABLE = 'contacts'
const STAMP = Date.now()
const CF_NAME = `E2E Fiche ${STAMP}`
const RENAMED = `Courriel E2E ${STAMP}`

// Palier 5 : la fiche détail cesse d'être un registre de champs concurrent.
// Elle garde sa mise en page, mais lit le registre commun (custom_fields) pour
// les libellés, et affiche les champs perso créés par l'utilisateur.
// Par ailleurs, un rendu sur-mesure (lien vers une fiche) s'annonce comme un
// TYPE nommé — donc lisible et réversible.
//
// Aucun enregistrement n'est modifié : le test crée un champ jetable et une
// personnalisation de libellé, tous deux retirés en after().
describe('Registre des champs — fiches détail et types nommés', () => {
  let browser, ctx, page, token, db, contactId

  const api = (method, path, body) => page.evaluate(async ({ method, path, body, tok }) => {
    const r = await fetch(`/erp/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    })
    return { status: r.status, body: await r.json().catch(() => null) }
  }, { method, path, body, tok: token })

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
    contactId = db.prepare('SELECT id FROM contacts WHERE deleted_at IS NULL ORDER BY rowid LIMIT 1').get()?.id
    assert.ok(contactId, 'il faut au moins un contact pour ouvrir une fiche')
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))
  })

  after(async () => {
    try {
      for (const row of db.prepare('SELECT id, column_name FROM custom_fields WHERE erp_table=? AND name LIKE ?')
        .all(TABLE, `E2E Fiche ${STAMP}%`)) {
        db.prepare('DELETE FROM custom_fields WHERE id=?').run(row.id)
        try { db.exec(`ALTER TABLE ${TABLE} DROP COLUMN ${row.column_name}`) } catch { /* colonne virtuelle */ }
      }
      db.prepare("DELETE FROM custom_fields WHERE erp_table=? AND kind='native' AND name=?").run(TABLE, RENAMED)
    } catch { /* nettoyage best-effort */ }
    db?.close()
    await browser?.close()
  })

  test('un champ perso créé apparaît sur la fiche sans toucher au code de la page', async () => {
    const created = await api('POST', `/custom-fields/${TABLE}`, { name: CF_NAME, type: 'text' })
    assert.equal(created.status, 201, JSON.stringify(created.body))

    await page.goto(`${URL}/contacts/${contactId}`, { waitUntil: 'networkidle' })
    const row = page.locator(`[data-testid="detail-cf-${created.body.column_name}"]`)
    await row.waitFor({ timeout: 15000 })
    assert.match(await row.innerText(), new RegExp(CF_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'))
  })

  test('renommer un champ depuis le registre se voit sur la fiche', async () => {
    const res = await api('PUT', `/custom-fields/${TABLE}/native/email`, { label: RENAMED })
    assert.equal(res.status, 200, JSON.stringify(res.body))

    await page.goto(`${URL}/contacts/${contactId}`, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1500)
    // Les libellés sont rendus en capitales (classe `uppercase`) : innerText
    // renvoie le texte AFFICHÉ, pas le texte source — d'où la comparaison
    // insensible à la casse.
    const labels = (await page.$$eval(
      '.text-xs.font-medium.text-slate-400.uppercase',
      els => els.map(e => e.textContent.trim()),
    )).map(l => l.toLowerCase())
    assert.ok(labels.includes(RENAMED.toLowerCase()), `la fiche doit afficher le libellé renommé (vu: ${labels.join(', ')})`)
    assert.ok(!labels.includes('courriel'), 'l\'ancien libellé ne doit plus apparaître')

    const reset = await api('DELETE', `/custom-fields/${TABLE}/native/email`)
    assert.equal(reset.status, 200)
  })

  test('un rendu sur-mesure s\'annonce comme un type nommé', async () => {
    await page.goto(`${URL}/contacts`, { waitUntil: 'networkidle' })
    const header = page.locator('[data-testid="col-header-company_name"]')
    await header.waitFor({ timeout: 20000 })
    await header.hover()
    await page.locator('[data-testid="col-menu-btn-company_name"]').click()
    await page.locator('[data-testid="colmenu-edit-native-field"]').click()
    await page.locator('[data-testid="field-override-name"]').waitFor({ timeout: 8000 })

    const types = await page.locator('[data-testid^="field-override-type-"]').allInnerTexts()
    assert.ok(
      types.join(' | ').includes('Lien vers Entreprise'),
      `le type d'origine doit être nommé « Lien vers Entreprise » (vu: ${types.join(' | ')})`,
    )
  })
})
