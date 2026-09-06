const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const Database = require('/home/ec2-user/erp/server/node_modules/better-sqlite3')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'pap@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')
const DB_PATH = process.env.ERP_DB_PATH || '/home/ec2-user/erp/server/data/erp.db'

// Vérifie le toggle import_disabled d'un champ Airtable depuis la modale sync
// projets : (1) endpoint exclut les champs hardcodés, (2) désactiver NULL-ifie
// la colonne, (3) ré-activer permet la prochaine sync de repopuler.
describe('Sync Airtable projets — toggle import par champ', () => {
  let browser, ctx, page, token, db
  let testFieldName, testColumnName
  let snapshotValuesByProjectId
  let originalDisabled

  before(async () => {
    db = new Database(DB_PATH, { readonly: false })
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } })
    page = await ctx.newPage()
    await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
    await page.fill('input[type="email"]', EMAIL)
    await page.fill('input[type="password"]', PASS)
    await page.click('button:has-text("Se connecter")')
    await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
    token = await page.evaluate(() => localStorage.getItem('erp_token'))

    // Choisit un champ Airtable dynamique avec une colonne ERP existante et
    // au moins quelques valeurs non-null pour vérifier le NULL-ify.
    const r = await page.evaluate(async (tok) => {
      const res = await fetch('/erp/api/connectors/airtable/projets/airtable-fields', { headers: { Authorization: `Bearer ${tok}` } })
      return res.json()
    }, token)
    const candidates = (r.fields || []).filter(f => f.column_name && f.column_name !== '__pending__')
    let picked = null
    for (const f of candidates) {
      const cnt = db.prepare(
        `SELECT COUNT(*) c FROM projects WHERE ${f.column_name} IS NOT NULL AND ${f.column_name} != ''`
      ).get().c
      if (cnt > 0) { picked = f; break }
    }
    assert.ok(picked, 'Devrait trouver un champ Airtable importé avec des valeurs non-null')
    testFieldName = picked.airtable_field_name
    testColumnName = picked.column_name
    originalDisabled = picked.import_disabled

    // Snapshot des valeurs pour pouvoir restaurer
    snapshotValuesByProjectId = new Map()
    for (const row of db.prepare(`SELECT id, ${testColumnName} AS v FROM projects WHERE ${testColumnName} IS NOT NULL`).all()) {
      snapshotValuesByProjectId.set(row.id, row.v)
    }
  })

  after(async () => {
    // Restaure le flag + les valeurs
    try {
      if (testFieldName) {
        await page.evaluate(async ({ tok, name, dis }) => {
          await fetch('/erp/api/connectors/airtable/projets/airtable-field-disabled', {
            method: 'POST',
            headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ airtable_field_name: name, disabled: dis }),
          })
        }, { tok: token, name: testFieldName, dis: originalDisabled })
      }
      if (testColumnName && snapshotValuesByProjectId) {
        const stmt = db.prepare(`UPDATE projects SET ${testColumnName}=? WHERE id=?`)
        for (const [pid, v] of snapshotValuesByProjectId) stmt.run(v, pid)
      }
    } catch {}
    db?.close()
    await browser?.close()
  })

  test('endpoint exclut les champs hardcodés', async () => {
    const r = await page.evaluate(async (tok) => {
      const res = await fetch('/erp/api/connectors/airtable/projets/airtable-fields', { headers: { Authorization: `Bearer ${tok}` } })
      return res.json()
    }, token)
    const names = (r.fields || []).map(f => f.airtable_field_name)
    for (const hc of (r.hardcoded || [])) {
      assert.ok(!names.includes(hc), `Le champ hardcodé "${hc}" ne doit PAS apparaître dans la liste`)
    }
  })

  test('désactiver un champ NULL-ifie la colonne', async () => {
    const before = db.prepare(
      `SELECT COUNT(*) c FROM projects WHERE ${testColumnName} IS NOT NULL`,
    ).get().c
    assert.ok(before > 0, 'pré-condition : la colonne doit avoir des valeurs')

    await page.evaluate(async ({ tok, name }) => {
      const res = await fetch('/erp/api/connectors/airtable/projets/airtable-field-disabled', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ airtable_field_name: name, disabled: true }),
      })
      return res.json()
    }, { tok: token, name: testFieldName })

    const after = db.prepare(
      `SELECT COUNT(*) c FROM projects WHERE ${testColumnName} IS NOT NULL`,
    ).get().c
    assert.equal(after, 0, `Toutes les valeurs de ${testColumnName} doivent être NULL après désactivation`)

    // Le flag doit être set côté field_defs
    const def = db.prepare(
      "SELECT import_disabled FROM airtable_field_defs WHERE erp_table='projects' AND airtable_field_name=?",
    ).get(testFieldName)
    assert.equal(def.import_disabled, 1)
  })

  test('refuse de désactiver un champ hardcodé', async () => {
    const r = await page.evaluate(async (tok) => {
      const res = await fetch('/erp/api/connectors/airtable/projets/airtable-field-disabled', {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ airtable_field_name: 'ID', disabled: true }),
      })
      return { status: res.status, body: await res.json() }
    }, token)
    assert.equal(r.status, 400)
    assert.match(r.body.error || '', /hardcodé/)
  })

  test('disabled-columns endpoint reflète l\'état', async () => {
    // Le champ est désactivé depuis le test précédent
    const r = await page.evaluate(async (tok) => {
      const res = await fetch('/erp/api/connectors/airtable/disabled-columns/projects', { headers: { Authorization: `Bearer ${tok}` } })
      return res.json()
    }, token)
    const cols = (r.columns || []).map(c => c.column_name)
    assert.ok(cols.includes(testColumnName), `disabled-columns devrait inclure ${testColumnName}, vu : ${cols.join(', ')}`)
  })
})
