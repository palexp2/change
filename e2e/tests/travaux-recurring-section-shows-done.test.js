// Travaux récurrents — une section sans « à faire » montre quand même ses travaux.
//
// Antoine cherchait « Compiler les dépenses pour le suivi budgétaire d'Émilie »
// dans sa section (Antoine / AL) et ne voyait rien : le travail lui appartient
// bien, mais une fois coché pour la semaine il quittait la liste à faire et se
// repliait sous le petit compteur « 1 fait » — la section se lisait donc comme
// vide, comme si le travail n'était pas le sien.
//
// Règle vérifiée ici : quand il ne reste RIEN à faire dans une cadence, les
// lignes cochées sont dépliées d'office ; tant qu'il reste du travail, elles
// restent repliées (le comportement d'origine : cocher fait disparaître la
// ligne). Le repli manuel continue de primer.
//
// Aucun record réel n'est modifié : deux travaux jetables « annuels » dans la
// section AL (cadence sans travail réel), décochés puis supprimés dans after().
// Le travail réel d'Émilie n'est que LU (présence dans la section Antoine).

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const STAMP = Date.now()
const LABEL_A = `E2E section-vide A ${STAMP}`
const LABEL_B = `E2E section-vide B ${STAMP}`
const EMILIE = "Compiler les dépenses pour le suivi budgétaire d'Émilie"

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 20000 })
}

function apiFetch(page, method, p, body) {
  return page.evaluate(async ({ method, path, body }) => {
    const tok = localStorage.getItem('erp_token')
    const opts = { method, headers: { Authorization: `Bearer ${tok}` } }
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body) }
    const r = await fetch('/erp/api' + path, opts)
    return r.json()
  }, { method, path: p, body })
}
const apiGet = (page, p) => apiFetch(page, 'GET', p)

async function waitFor(fn, { timeout = 25000, label = 'condition' } = {}) {
  const start = Date.now()
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() - start > timeout) throw new Error(`timeout: ${label}`)
    await new Promise(r => setTimeout(r, 300))
  }
}

/** Coche (autosave : .click(), pas .check()) et attend la confirmation serveur. */
async function check(page, id, done = true) {
  const row = page.locator(`[data-task-id="${id}"]`).first()
  await row.waitFor({ timeout: 45000 })
  const box = row.locator('input[type="checkbox"]')
  if (await box.isChecked() !== done) await box.click()
  await waitFor(async () => {
    const { tasks } = await apiGet(page, '/travaux/recurring?owner=AL')
    return tasks.find(t => t.id === id)?.done === done
  }, { label: `complétion ${id} = ${done}` })
}

const openPage = page => page.goto(URL + '/travaux?onglet=recurrents', { waitUntil: 'domcontentloaded' })

describe('Travaux récurrents — les travaux cochés restent visibles quand la section est vide', () => {
  let browser, ctx, page
  let a = null
  let b = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)
    a = await apiFetch(page, 'POST', '/travaux/recurring', { label: LABEL_A, cadence: 'annuel', owner: 'AL' })
    b = await apiFetch(page, 'POST', '/travaux/recurring', { label: LABEL_B, cadence: 'annuel', owner: 'AL' })
    assert.ok(a?.id && b?.id, 'travaux jetables créés')
  })

  after(async () => {
    if (page) {
      for (const t of [a, b]) {
        if (!t?.id) continue
        await apiFetch(page, 'POST', `/travaux/recurring/${t.id}/completion`, { done: false })
        await apiFetch(page, 'DELETE', `/travaux/recurring/${t.id}`)
      }
    }
    await browser?.close()
  })

  test("le travail d'Émilie appartient bien à la section Antoine", async () => {
    const { tasks } = await apiGet(page, '/travaux/recurring?owner=AL')
    const t = tasks.find(x => x.label === EMILIE)
    assert.ok(t, "« Compiler les dépenses… d'Émilie » listé dans la section Antoine (AL)")
    assert.equal(t.owner, 'AL')

    // Et il se lit à l'écran dans la section Antoine, coché ou non.
    await openPage(page)
    const row = page.locator(`[data-task-id="${t.id}"]`)
    await row.waitFor({ timeout: 45000 })
    assert.equal(await row.locator('input[type="text"], input:not([type])').first().inputValue(), EMILIE)
  })

  test('il reste du travail dans la cadence → les cochés restent repliés', async () => {
    await openPage(page)
    await check(page, a.id, true) // b reste à faire
    await openPage(page)
    await page.locator(`[data-task-id="${b.id}"]`).waitFor({ timeout: 45000 })
    assert.equal(
      await page.locator('[data-testid="recurring-done-annuel"]').count(), 0,
      'bloc « faits » replié tant qu\'il reste du travail',
    )
    assert.equal(
      await page.locator(`[data-testid="recurring-done-toggle-annuel"]`).count(), 1,
      'le compteur « 1 fait » est là pour le déplier',
    )
  })

  test('plus rien à faire → les travaux cochés sont visibles sans un clic', async () => {
    await check(page, b.id, true)
    await openPage(page)
    const done = page.locator('[data-testid="recurring-done-annuel"]')
    await done.waitFor({ timeout: 45000 })
    await done.locator(`[data-task-id="${a.id}"]`).waitFor({ timeout: 20000 })
    await done.locator(`[data-task-id="${b.id}"]`).waitFor({ timeout: 20000 })
  })

  test('le repli manuel prime toujours', async () => {
    await page.locator('[data-testid="recurring-done-toggle-annuel"]').click()
    await waitFor(
      async () => (await page.locator('[data-testid="recurring-done-annuel"]').count()) === 0,
      { label: 'bloc « faits » refermé à la main' },
    )
  })
})
