// Travaux récurrents — cadence « deux fois par semaine » (mardi et samedi).
//
// Ce que ce test verrouille :
//  1. un travail bi-hebdomadaire porte DEUX cases, mardi et samedi ;
//  2. cocher le mardi laisse le samedi à faire — la ligne reste dans la liste
//     (c'est tout l'intérêt : le travail du samedi ne passe pas pour fait) ;
//  3. les deux cases cochées, la ligne rejoint « N faits » ;
//  4. la semaine suivante repart avec les DEUX cases vides.
//
// Aucun record réel n'est touché : un travail jetable (label horodaté), coché
// uniquement sur ses propres créneaux, décoché puis supprimé dans after().

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const LABEL = `E2E deux fois par semaine ${Date.now()}`

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

const rowFor = (page, id) => page.locator(`[data-task-id="${id}"]`)
const occFor = (page, id, key) => page.locator(`[data-occurrence="${id}:${key}"]`)

describe('Travaux récurrents — deux fois par semaine (mardi et samedi)', () => {
  let browser, ctx, page
  let task = null
  let currentWeek = null
  let nextWeek = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)
    task = await apiFetch(page, 'POST', '/travaux/recurring', { label: LABEL, cadence: 'bihebdo', owner: 'AL' })
    assert.ok(task?.id, 'travail jetable créé')

    const out = await apiGet(page, '/travaux/recurring?owner=AL')
    currentWeek = out.week
    const i = out.weeks.findIndex(w => w.key === currentWeek.key)
    nextWeek = out.weeks[i + 1]
    assert.ok(currentWeek?.key && nextWeek?.key, 'semaine courante + suivante proposées')
  })

  after(async () => {
    if (page && task?.id) {
      // La DB de test est la DB de prod : on décoche les deux créneaux des deux
      // semaines touchées avant de retirer le travail.
      for (const wk of [currentWeek?.key, nextWeek?.key]) {
        if (!wk) continue
        for (const slot of [1, 2]) {
          await apiFetch(page, 'POST', `/travaux/recurring/${task.id}/completion`, { done: false, period_key: `${wk}-${slot}` })
        }
      }
      await apiFetch(page, 'DELETE', `/travaux/recurring/${task.id}`)
    }
    await browser?.close()
  })

  test('le service décrit deux créneaux par semaine, mardi puis samedi', async () => {
    const { tasks } = await apiGet(page, `/travaux/recurring?owner=AL&week=${currentWeek.key}`)
    const t = tasks.find(x => x.id === task.id)
    assert.ok(t, 'le travail est listé')
    assert.deepEqual(t.occurrences.map(o => o.label), ['mardi', 'samedi'])
    assert.deepEqual(t.occurrences.map(o => o.period_key), [`${currentWeek.key}-1`, `${currentWeek.key}-2`])
    assert.deepEqual(t.occurrences.map(o => o.done), [false, false])
    assert.equal(t.done, false)
  })

  test('cocher le mardi laisse le samedi à faire — la ligne reste dans la liste', async () => {
    await page.goto(URL + '/travaux?onglet=recurrents', { waitUntil: 'domcontentloaded' })
    const row = rowFor(page, task.id)
    await row.waitFor({ timeout: 15000 })

    // Case autosave : .click() (pas .check()), validation par poll API.
    await occFor(page, task.id, `${currentWeek.key}-1`).locator('input[type="checkbox"]').click()

    const t = await waitFor(async () => {
      const { tasks } = await apiGet(page, `/travaux/recurring?owner=AL&week=${currentWeek.key}`)
      const x = tasks.find(y => y.id === task.id)
      return x?.occurrences?.[0]?.done ? x : null
    }, { label: 'mardi enregistré' })
    assert.equal(t.occurrences[1].done, false, 'le samedi reste à faire')
    assert.equal(t.done, false, 'le travail n\'est pas « fait » tant qu\'il reste un créneau')

    // La ligne ne quitte PAS la liste à faire : c'est le comportement demandé.
    await page.waitForTimeout(1000)
    assert.equal(await rowFor(page, task.id).count(), 1, 'la ligne reste visible pour le samedi')
    assert.equal(await occFor(page, task.id, `${currentWeek.key}-1`).getAttribute('data-done'), '1')
    assert.equal(await occFor(page, task.id, `${currentWeek.key}-2`).getAttribute('data-done'), '0')
  })

  test('les deux créneaux cochés, la ligne rejoint « N faits »', async () => {
    await occFor(page, task.id, `${currentWeek.key}-2`).locator('input[type="checkbox"]').click()

    await waitFor(async () => {
      const { tasks } = await apiGet(page, `/travaux/recurring?owner=AL&week=${currentWeek.key}`)
      return tasks.find(x => x.id === task.id)?.done
    }, { label: 'samedi enregistré' })
    await waitFor(async () => (await rowFor(page, task.id).count()) === 0, { label: 'ligne retirée de la liste' })

    await page.click('[data-testid="recurring-done-toggle-bihebdo"]')
    const doneRow = page.locator(`[data-testid="recurring-done-bihebdo"] [data-task-id="${task.id}"]`)
    await doneRow.waitFor({ timeout: 10000 })
    assert.equal(await doneRow.getAttribute('data-done'), '1')
  })

  test('la semaine suivante repart avec les deux cases vides', async () => {
    await page.click('[data-testid="recurring-week-next"]')
    await waitFor(async () => (await page.getAttribute('[data-testid="recurring-week"]', 'data-week')) === nextWeek.key,
      { label: 'ancre déplacée sur la semaine suivante' })

    const row = rowFor(page, task.id)
    await row.waitFor({ timeout: 10000 })
    assert.equal(await row.getAttribute('data-done'), '0')
    assert.equal(await occFor(page, task.id, `${nextWeek.key}-1`).getAttribute('data-done'), '0')
    assert.equal(await occFor(page, task.id, `${nextWeek.key}-2`).getAttribute('data-done'), '0')

    const { tasks } = await apiGet(page, `/travaux/recurring?owner=AL&week=${nextWeek.key}`)
    const t = tasks.find(x => x.id === task.id)
    assert.deepEqual(t.occurrences.map(o => o.done), [false, false], 'rien n\'est reporté d\'une semaine à l\'autre')
  })

  test('les trois travaux du mardi et du samedi ont bien basculé', async () => {
    const { tasks } = await apiGet(page, '/travaux/recurring?owner=AL&all=1')
    for (const id of ['rt-al-ctb-transactions', 'rt-al-payer-fournisseurs', 'rt-al-maintien-solde-disponible']) {
      const t = tasks.find(x => x.id === id)
      assert.ok(t, `${id} présent`)
      assert.equal(t.cadence, 'bihebdo', `${id} se fait deux fois par semaine`)
      assert.equal(t.occurrences.length, 2)
    }
  })
})
