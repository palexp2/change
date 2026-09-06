const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

// Le réordonnancement des champs a été retiré de la page de configuration des
// champs (/champs/:table) — pour TOUTES les tables : plus de poignée de drag,
// plus de ligne `draggable`, plus d'appel PATCH .../native/order.
//
// Lecture seule : le test tente un glisser-déposer entre deux lignes et vérifie
// justement que RIEN n'est enregistré (l'ordre affiché ne bouge pas et aucune
// requête d'ordre ne part). Aucun record ni aucune configuration n'est modifié.
describe('Configuration des champs — plus de réordonnancement', () => {
  let browser, ctx, page
  const orderCalls = []

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1500, height: 900 } })
    page = await ctx.newPage()
    // Filet : toute tentative d'enregistrement d'ordre de champs est capturée.
    page.on('request', r => {
      if (/\/native\/order/.test(r.url())) orderCalls.push(`${r.method()} ${r.url()}`)
    })
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

  // Le contexte du signalement : /champs/projects.
  test('/champs/projects : aucune poignée, aucune ligne draggable', async () => {
    await openFields('projects')

    const rows = page.locator('[data-testid^="fieldcfg-row-"]')
    assert.ok(await rows.count() > 3, 'la liste des champs doit être peuplée')
    assert.equal(
      await page.locator('[data-testid^="fieldcfg-row-"][draggable="true"]').count(), 0,
      'plus aucune ligne de champ ne doit être déplaçable'
    )
    // Poignée cherchée DANS les lignes de champs seulement : la barre latérale
    // garde la sienne (réordonnancement de la navigation, hors sujet).
    assert.equal(
      await page.locator('[data-testid^="fieldcfg-row-"] [title="Glisser pour réordonner"]').count(), 0,
      'la poignée de drag doit avoir disparu des lignes de champs'
    )
    // Le texte d'aide ne doit plus inviter à glisser les champs.
    const help = await page.locator('body').innerText()
    assert.ok(!/Glissez les champs/i.test(help), "plus d'invitation « Glissez les champs »")
  })

  test('un glisser-déposer entre deux champs ne change ni n’enregistre l’ordre', async () => {
    await openFields('projects')
    const rows = page.locator('[data-testid^="fieldcfg-row-"]')
    const idOf = async i => rows.nth(i).getAttribute('data-testid')
    const before2 = [await idOf(0), await idOf(1), await idOf(2)]

    // Tentative réelle de glisser la 3e ligne sur la 1re.
    await rows.nth(2).dragTo(rows.nth(0))
    await page.waitForTimeout(1200)

    const after2 = [await idOf(0), await idOf(1), await idOf(2)]
    assert.deepEqual(after2, before2, "l'ordre affiché ne doit pas bouger")
    assert.deepEqual(orderCalls, [], 'aucun enregistrement d’ordre ne doit être envoyé')
  })

  test('les autres tables non plus : orders, contacts, tickets, tasks', async () => {
    for (const table of ['orders', 'contacts', 'tickets', 'tasks']) {
      await openFields(table)
      assert.ok(
        await page.locator('[data-testid^="fieldcfg-row-"]').count() > 0,
        `${table} : la liste des champs doit être peuplée`
      )
      assert.equal(
        await page.locator('[data-testid^="fieldcfg-row-"][draggable="true"]').count(), 0,
        `${table} : plus aucune ligne déplaçable`
      )
      assert.equal(
        await page.locator('[data-testid^="fieldcfg-row-"] [title="Glisser pour réordonner"]').count(), 0,
        `${table} : plus de poignée de drag`
      )
    }
    assert.deepEqual(orderCalls, [], 'aucun enregistrement d’ordre sur aucune table')
  })

  test('les colonnes restent réordonnables depuis les en-têtes de la table', async () => {
    // On ne retire que la page de configuration : l'ordre des colonnes se règle
    // toujours dans la table elle-même (en-têtes DataTable, draggable).
    await page.goto(URL + '/projects', { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('div[draggable="true"]', { timeout: 25000 })
    assert.ok(await page.locator('div[draggable="true"]').count() > 0)
  })
})
