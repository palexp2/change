// Travaux récurrents — navigation par semaine + « cocher fait disparaître ».
//
// Ce que ce test verrouille :
//  1. cocher un travail le RETIRE de la liste à faire (il ne reste pas rayé) et
//     il se retrouve sous « N faits », d'où on peut le décocher ;
//  2. la semaine suivante repart avec le travail hebdomadaire À FAIRE — c'est
//     tout l'intérêt d'une liste qui se vide : elle doit se remplir à nouveau ;
//  3. un travail « à faire une fois » coché ne revient PAS la semaine suivante ;
//  4. le menu de semaines (recherchable) déplace bien l'ancre de lecture.
//
// Aucun record réel n'est touché : deux travaux jetables (labels horodatés),
// cochés uniquement dans la semaine courante, décochés puis supprimés dans after().

const { test, describe, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
const EMAIL = process.env.ERP_EMAIL || 'claude@orisha.io'
const PASS = process.env.ERP_PASS
if (!PASS) throw new Error('ERP_PASS env var required')

const STAMP = Date.now()
const LABEL_HEBDO = `E2E semaine hebdo ${STAMP}`
const LABEL_ADHOC = `E2E semaine adhoc ${STAMP}`

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

describe('Travaux récurrents — semaine choisie et cochage qui vide la liste', () => {
  let browser, ctx, page
  let hebdo = null
  let adhoc = null
  let currentWeek = null
  let nextWeek = null

  before(async () => {
    browser = await chromium.launch()
    ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 } })
    page = await ctx.newPage()
    await login(page)
    hebdo = await apiFetch(page, 'POST', '/travaux/recurring', { label: LABEL_HEBDO, cadence: 'hebdo', owner: 'AL' })
    adhoc = await apiFetch(page, 'POST', '/travaux/recurring', { label: LABEL_ADHOC, cadence: 'adhoc', owner: 'AL' })
    assert.ok(hebdo?.id && adhoc?.id, 'travaux jetables créés')

    const out = await apiGet(page, '/travaux/recurring?owner=AL')
    currentWeek = out.week
    const i = out.weeks.findIndex(w => w.key === currentWeek.key)
    nextWeek = out.weeks[i + 1]
    assert.ok(currentWeek?.key && nextWeek?.key, 'semaine courante + suivante proposées')
  })

  after(async () => {
    if (page) {
      // Décocher la période courante (et 'adhoc'), puis retirer les travaux :
      // la DB de test est la DB de prod.
      for (const t of [hebdo, adhoc]) {
        if (!t?.id) continue
        await apiFetch(page, 'POST', `/travaux/recurring/${t.id}/completion`, { done: false })
        await apiFetch(page, 'POST', `/travaux/recurring/${t.id}/completion`, { done: false, period_key: currentWeek?.key })
        await apiFetch(page, 'DELETE', `/travaux/recurring/${t.id}`)
      }
    }
    await browser?.close()
  })

  test('la semaine courante est l\'ancre par défaut, et le service la décrit', async () => {
    assert.match(currentWeek.key, /^\d{4}-W\d{2}$/)
    assert.equal(currentWeek.is_current, true)
    const { tasks } = await apiGet(page, `/travaux/recurring?owner=AL&week=${currentWeek.key}`)
    const t = tasks.find(x => x.id === hebdo.id)
    assert.equal(t.period_key, currentWeek.key, 'le travail hebdo est coché sur la semaine ancrée')
  })

  test('cocher retire la ligne de la liste à faire, et « N faits » la retrouve', async () => {
    await page.goto(URL + '/travaux?onglet=recurrents', { waitUntil: 'domcontentloaded' })
    const row = rowFor(page, hebdo.id)
    await row.waitFor({ timeout: 15000 })
    // Case autosave : .click() (pas .check()), validation par poll API.
    await row.locator('input[type="checkbox"]').click()

    await waitFor(async () => {
      const { tasks } = await apiGet(page, '/travaux/recurring?owner=AL')
      return tasks.find(x => x.id === hebdo.id)?.done
    }, { label: 'complétion enregistrée' })

    // Le fondu dure ~320 ms, puis la ligne quitte la liste à faire.
    await waitFor(async () => (await rowFor(page, hebdo.id).count()) === 0, { label: 'ligne retirée de la liste' })

    await page.click('[data-testid="recurring-done-toggle-hebdo"]')
    const doneRow = page.locator(`[data-testid="recurring-done-hebdo"] [data-task-id="${hebdo.id}"]`)
    await doneRow.waitFor({ timeout: 10000 })
    assert.equal(await doneRow.getAttribute('data-done'), '1')
  })

  test('la semaine suivante repart avec le travail hebdomadaire à faire', async () => {
    await page.click('[data-testid="recurring-week-next"]')
    await waitFor(async () => (await page.getAttribute('[data-testid="recurring-week"]', 'data-week')) === nextWeek.key,
      { label: 'ancre déplacée sur la semaine suivante' })

    const row = rowFor(page, hebdo.id)
    await row.waitFor({ timeout: 10000 })
    assert.equal(await row.getAttribute('data-done'), '0', 'le hebdo revient à faire la semaine suivante')

    // …et le serveur dit la même chose : cochage de la semaine courante seulement.
    const { tasks } = await apiGet(page, `/travaux/recurring?owner=AL&week=${nextWeek.key}`)
    const t = tasks.find(x => x.id === hebdo.id)
    assert.equal(t.done, false)
    assert.equal(t.period_key, nextWeek.key)
  })

  test('un travail « à faire une fois » coché ne revient pas la semaine suivante', async () => {
    await page.click('[data-testid="recurring-week-today"]')
    await waitFor(async () => (await page.getAttribute('[data-testid="recurring-week"]', 'data-week')) === currentWeek.key,
      { label: 'retour à la semaine courante' })

    const row = rowFor(page, adhoc.id)
    await row.waitFor({ timeout: 10000 })
    await row.locator('input[type="checkbox"]').click()
    await waitFor(async () => {
      const { tasks } = await apiGet(page, '/travaux/recurring?owner=AL')
      return tasks.find(x => x.id === adhoc.id)?.done
    }, { label: 'complétion adhoc enregistrée' })
    await waitFor(async () => (await rowFor(page, adhoc.id).count()) === 0, { label: 'adhoc retiré de la liste' })

    await page.click('[data-testid="recurring-week-next"]')
    await waitFor(async () => (await page.getAttribute('[data-testid="recurring-week"]', 'data-week')) === nextWeek.key,
      { label: 'semaine suivante' })
    // Le hebdo est là (à faire), l'adhoc non — c'est la différence qu'on veut voir.
    await rowFor(page, hebdo.id).waitFor({ timeout: 10000 })
    assert.equal(await rowFor(page, adhoc.id).count(), 0, 'l\'adhoc coché ne réapparaît pas')
  })

  test('le menu de semaines est recherchable et déplace l\'ancre', async () => {
    await page.click('[data-testid="recurring-week"]')
    await page.locator('[data-testid="recurring-week-menu"]').waitFor({ timeout: 5000 })
    await page.fill('[data-testid="recurring-week-menu"] input', String(currentWeek.week))
    await page.click(`[data-week-option="${currentWeek.key}"]`)
    await waitFor(async () => (await page.getAttribute('[data-testid="recurring-week"]', 'data-week')) === currentWeek.key,
      { label: 'semaine choisie dans le menu' })
  })
})
