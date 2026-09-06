// Travaux récurrents — « Fait par » = propriétaire de la section.
//
// Les sessions du poste sont partagées : Antoine cochait ses travaux depuis la
// session de Michel et la ligne affichait « Fait par Michel Lambert ». Comme
// chacun ne coche que les travaux de sa propre section (AL / ML), l'attribution
// fiable est le propriétaire du travail, pas l'utilisateur connecté. Ce test
// coche un travail jetable dans chaque section depuis la session claude@ et
// vérifie que l'attribution suit la section, jamais la session.
//
// Aucun record réel n'est touché : deux travaux jetables (labels horodatés),
// décochés puis supprimés dans after().

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const STAMP = Date.now()
const LABEL_AL = `E2E fait-par AL ${STAMP}`
const LABEL_ML = `E2E fait-par ML ${STAMP}`

async function login(page) {
  await page.goto(URL + '/login', { waitUntil: 'domcontentloaded' })
  await page.fill('input[type="email"]', EMAIL)
  await page.fill('input[type="password"]', PASS)
  await page.click('button:has-text("Se connecter")')
  await page.waitForURL(u => !u.toString().includes('/login'), { timeout: 15000 })
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

/** Ligne d'un travail récurrent (hook data-task-id posé par RecurringRow). */
function rowFor(page, id) {
  return page.locator(`[data-task-id="${id}"]`)
}

/**
 * Cocher retire la ligne de la liste à faire : elle se lit sous « N faits ».
 * Le repli est mémorisé d'une section à l'autre, donc on ne clique que si le
 * bloc est fermé (sinon le second appel le refermerait).
 */
async function openDone(page, cadence, taskId) {
  const block = page.locator(`[data-testid="recurring-done-${cadence}"]`)
  const row = block.locator(`[data-task-id="${taskId}"]`)
  return waitFor(async () => {
    if (await row.count()) return true
    // Ne cliquer QUE si le bloc est fermé : cliquer parce que la ligne n'est
    // pas encore arrivée (liste en cours de rechargement) le refermerait.
    if (!(await block.count())) {
      const toggle = page.locator(`[data-testid="recurring-done-toggle-${cadence}"]`)
      if (await toggle.count()) await toggle.click()
    }
    return false
  }, { label: `bloc « faits » (${cadence}) déplié` })
}

describe('Travaux récurrents — « Fait par » suit la section, pas la session', () => {
  let browser, ctx, page
  let taskAl = null
  let taskMl = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)
    taskAl = await apiFetch(page, 'POST', '/travaux/recurring', { label: LABEL_AL, cadence: 'hebdo', owner: 'AL' })
    taskMl = await apiFetch(page, 'POST', '/travaux/recurring', { label: LABEL_ML, cadence: 'hebdo', owner: 'ML' })
    assert.ok(taskAl?.id && taskMl?.id, 'travaux jetables créés')
  })

  after(async () => {
    // Décocher d'abord (supprime les lignes de complétion), puis retirer les
    // travaux jetables — la DB de test est la DB de prod.
    if (page) {
      for (const t of [taskAl, taskMl]) {
        if (!t?.id) continue
        await apiFetch(page, 'POST', `/travaux/recurring/${t.id}/completion`, { done: false })
        await apiFetch(page, 'DELETE', `/travaux/recurring/${t.id}`)
      }
    }
    await browser?.close()
  })

  test('cocher dans la section Antoine → « Fait par Antoine », peu importe la session', async () => {
    await page.goto(URL + '/travaux?onglet=recurrents', { waitUntil: 'domcontentloaded' })
    const row = rowFor(page, taskAl.id)
    await row.waitFor({ timeout: 15000 })
    // Case autosave : .click() (pas .check()), validation par poll API.
    await row.locator('input[type="checkbox"]').click()

    const t = await waitFor(async () => {
      const { tasks } = await apiGet(page, '/travaux/recurring?owner=AL')
      const x = tasks.find(x => x.id === taskAl.id)
      return x?.done ? x : null
    }, { label: 'complétion AL enregistrée' })
    assert.equal(t.done_by_name, 'Antoine', 'attribué au propriétaire de la section, pas à la session claude@')

    // Cocher retire la ligne de la liste à faire : l'attribution se lit
    // désormais en dépliant « N faits » sous la section.
    await openDone(page, 'hebdo', taskAl.id)
    await page.locator(`[data-testid="recurring-done-hebdo"] [data-task-id="${taskAl.id}"]`)
      .locator('text=Fait par Antoine').waitFor({ timeout: 15000 })
  })

  test('cocher dans la section Michel → « Fait par Michel »', async () => {
    await page.click('button:has-text("Michel (ML)")')
    const row = rowFor(page, taskMl.id)
    await row.waitFor({ timeout: 15000 })
    await row.locator('input[type="checkbox"]').click()

    const t = await waitFor(async () => {
      const { tasks } = await apiGet(page, '/travaux/recurring?owner=ML')
      const x = tasks.find(x => x.id === taskMl.id)
      return x?.done ? x : null
    }, { label: 'complétion ML enregistrée' })
    assert.equal(t.done_by_name, 'Michel')

    await openDone(page, 'hebdo', taskMl.id)
    await page.locator(`[data-testid="recurring-done-hebdo"] [data-task-id="${taskMl.id}"]`)
      .locator('text=Fait par Michel').waitFor({ timeout: 15000 })
  })

  test('l\'historique de cochage porte la même attribution', async () => {
    const { completions } = await apiGet(page, `/travaux/recurring/${taskAl.id}/completions`)
    assert.ok(completions.length >= 1, 'au moins une complétion')
    assert.equal(completions[0].done_by_name, 'Antoine')
  })
})
