// Données simulées : aucune connexion ni écriture dans l'ERP réel.
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const { readFile } = require('node:fs/promises')
const path = require('node:path')

let browser
before(async () => { browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] }) })
after(async () => { await browser?.close() })

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function setup(t, options = {}) {
  const context = await browser.newContext({ locale: 'fr-CA', timezoneId: 'America/Toronto' })
  t.after(() => context.close())
  const page = await context.newPage()
  await page.clock.install({ time: new Date('2026-09-10T14:00:00Z') })
  const user = { id: 'weekly-test', name: 'Test semaine', role: 'admin' }
  const token = `test.${Buffer.from(JSON.stringify(user)).toString('base64')}.test`
  await context.addInitScript(value => localStorage.setItem('erp_token', value), token)
  const writes = []
  const weeks = new Map([
    ['weekly-test:2026-09-07', { id: 'week-1', user_id: user.id, week_start: '2026-09-07', minutes: 2100 }],
    ['weekly-test:2026-08-31', { id: 'week-2', user_id: user.id, week_start: '2026-08-31', minutes: 1800 }],
    ['other:2026-09-07', { id: 'week-3', user_id: 'other', week_start: '2026-09-07', minutes: 1200 }],
  ])
  const days = [{ id: 'day-1', user_id: user.id, date: '2026-09-08', mode: 'simple', start_time: null, end_time: null, entries: [] }]
  const controls = { failGet: options.failGet, failSave: false, delaySave: 0, delayGet: options.delayGet || 0 }
  await page.routeWebSocket('**/*', socket => socket.close())
  await page.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== 'http://erp.test') return route.abort()
    if (url.pathname.startsWith('/erp/api/')) {
      const endpoint = url.pathname.slice('/erp/api'.length)
      const method = route.request().method()
      const body = method === 'GET' ? null : route.request().postDataJSON()
      const target = body?.user_id || url.searchParams.get('user_id') || user.id
      let data = []
      let status = 200
      if (method !== 'GET') writes.push({ endpoint, body })
      if (endpoint === '/timesheets/preferences') data = { default_mode: options.mode || 'week', user_id: target }
      else if (endpoint === '/timesheets/day') data = days.find(d => d.date === url.searchParams.get('date')) || null
      else if (endpoint === '/timesheets') data = { data: days }
      else if (endpoint === '/timesheets/weeks') data = { data: [...weeks.values()].filter(w => w.user_id === target) }
      else if (endpoint === '/timesheets/week') {
        const date = body?.date || url.searchParams.get('date')
        if (method === 'PUT') {
          await pause(controls.delaySave)
          if (controls.failSave) { status = 409; data = { error: 'Cette semaine contient déjà des heures saisies au jour.' } }
          else { data = { id: `week-${date}`, user_id: target, week_start: date, minutes: body.minutes }; weeks.set(`${target}:${date}`, data) }
        } else {
          data = weeks.get(`${target}:${date}`) || null
          await pause(controls.delayGet)
          if (controls.failGet) { status = 500; data = { error: 'Chargement indisponible' } }
        }
      } else if (endpoint === '/admin/users') data = [user, { id: 'other', name: 'Autre employé' }]
      else if (endpoint === '/bootstrap') data = { tables: {}, snapshot_ts: new Date().toISOString() }
      else if (endpoint === '/bootstrap/delta') data = { changes: {}, snapshot_ts: new Date().toISOString() }
      return route.fulfill({ status, json: data })
    }
    const relative = url.pathname.startsWith('/erp/assets/') ? url.pathname.slice('/erp/'.length) : 'index.html'
    const contentType = relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : 'text/html'
    await route.fulfill({ body: await readFile(path.join(__dirname, '../../client/dist', relative)), contentType })
  })
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  t.after(() => assert.deepEqual(errors, [], 'aucune erreur JavaScript'))
  await page.goto('http://erp.test/erp/feuille-de-temps')
  return { page, writes, controls }
}

async function inputHours(page, value) {
  const input = page.getByLabel('Heures de la semaine', { exact: true })
  await input.fill(value)
  await input.press('Enter')
  return input
}
async function waitValue(page, value) {
  await page.waitForFunction(v => document.querySelector('#week-hours')?.value === v && !document.querySelector('#week-hours')?.disabled, value)
}

test('heures entières, décimales et durées explicites ; validation et remise à zéro', async t => {
  const { page, writes } = await setup(t)
  await waitValue(page, '35:00')
  for (const [raw, minutes, displayed] of [['40', 2400, '40:00'], ['37,5', 2250, '37:30'], ['36.5', 2190, '36:30'], ['37:30', 2250, '37:30'], ['90m', 90, '1:30'], ['168', 10080, '168:00'], ['', 0, '0:00']]) {
    await inputHours(page, raw)
    await waitValue(page, displayed)
    assert.equal(writes.at(-1).body.minutes, minutes, raw)
    assert.equal(writes.at(-1).body.date, '2026-09-07')
  }
  const count = writes.length
  for (const invalid of ['169', '-1', '37:60', 'abc']) {
    const input = await inputHours(page, invalid)
    assert.equal(await input.getAttribute('aria-invalid'), 'true')
    assert.equal(writes.length, count)
  }
})

test('historique : formulaire et surbrillance adaptés, préférence conservée', async t => {
  const { page, writes } = await setup(t, { mode: 'simple' })
  await page.getByTestId('history-week-row-2026-09-07').click()
  await waitValue(page, '35:00')
  assert.equal(await page.getByTestId('history-week-row-2026-09-07').getAttribute('data-active'), 'true')
  await page.getByRole('button', { name: 'Cette semaine', exact: true }).waitFor()
  await page.getByTestId('history-day-row-2026-09-08').click()
  await page.getByRole('button', { name: 'Jour suivant', exact: true }).waitFor()
  assert.equal(await page.getByTestId('week-form').count(), 0)
  assert.equal(await page.getByTestId('history-week-row-2026-09-07').getAttribute('data-active'), 'false')
  assert.equal(await page.getByTestId('history-day-row-2026-09-08').getAttribute('data-active'), 'true')
  assert.deepEqual(writes, [], 'consulter ne modifie aucune préférence ni journée')
})

test('navigation hebdomadaire, chargement et réponse tardive de sauvegarde', async t => {
  const { page, controls } = await setup(t, { delayGet: 400 })
  await page.getByText('Chargement de la semaine…', { exact: true }).waitFor()
  assert.equal(await page.getByTestId('week-form').count(), 0)
  await waitValue(page, '35:00')
  controls.delaySave = 800
  await inputHours(page, '40')
  await page.getByRole('button', { name: 'Semaine précédente', exact: true }).click()
  await waitValue(page, '30:00')
  await pause(900)
  await waitValue(page, '30:00')
  assert.match(await page.getByTestId('period-label').innerText(), /31 août.*6 septembre 2026/)
  await page.getByRole('button', { name: 'Cette semaine', exact: true }).click()
  await waitValue(page, '40:00')
})

test('erreur de chargement : réessai ; enregistrement refusé : retour à la valeur enregistrée', async t => {
  const { page, controls } = await setup(t, { failGet: true })
  await page.getByText('Impossible de charger cette semaine.', { exact: true }).waitFor()
  assert.equal(await page.getByTestId('week-form').count(), 0)
  controls.failGet = false
  await page.getByRole('button', { name: 'Réessayer', exact: true }).click()
  await waitValue(page, '35:00')
  controls.failSave = true
  await inputHours(page, '40')
  await page.getByText('Cette semaine contient déjà des heures saisies au jour.', { exact: true }).waitFor()
  await waitValue(page, '35:00')
})

test('changement d’employé pendant une sauvegarde : chaque total reste sur son compte', async t => {
  const { page, controls, writes } = await setup(t)
  await waitValue(page, '35:00')
  controls.delaySave = 700
  await inputHours(page, '40')
  await page.getByTestId('user-picker').getByRole('button').click()
  await page.getByRole('button', { name: 'Autre employé', exact: true }).click()
  await waitValue(page, '20:00')
  assert.equal(writes.find(w => w.endpoint === '/timesheets/week').body.user_id, 'weekly-test')
  await inputHours(page, '25')
  await waitValue(page, '25:00')
  assert.equal(writes.at(-1).body.user_id, 'other')
})
