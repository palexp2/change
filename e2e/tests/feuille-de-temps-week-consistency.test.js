// Données simulées : aucune connexion ni écriture dans l'ERP réel.
const { test, before, after, describe } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
const { readFile } = require('node:fs/promises')
const path = require('node:path')

describe('Semaines de la feuille de temps', () => {
let browser
before(async () => { browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] }) })
after(async () => { await browser?.close() })

const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
async function setup(t, options = {}) {
  const context = await browser.newContext({ locale: 'fr-CA', timezoneId: 'America/Toronto' })
  t.after(() => context.close())
  const page = await context.newPage()
  await page.clock.install({ time: new Date(options.now || '2026-09-10T14:00:00Z') })
  const user = { id: 'weekly-test', name: 'Test semaine', role: 'admin' }
  const token = `test.${Buffer.from(JSON.stringify(user)).toString('base64')}.test`
  await context.addInitScript(value => localStorage.setItem('erp_token', value), token)
  const writes = []
  const weeks = new Map([
    ['weekly-test:2026-09-06', { id: 'week-1', user_id: user.id, week_start: '2026-09-06', minutes: 2100 }],
    ['weekly-test:2026-08-30', { id: 'week-2', user_id: user.id, week_start: '2026-08-30', minutes: 1800 }],
    ['other:2026-09-06', { id: 'week-3', user_id: 'other', week_start: '2026-09-06', minutes: 1200 }],
  ])
  const days = options.days || [{ id: 'day-1', user_id: user.id, date: '2026-09-08', mode: 'simple', start_time: null, end_time: null, entries: [] }]
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
      if (method !== 'GET' && endpoint.startsWith('/timesheets')) writes.push({ endpoint, body })
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
    assert.equal(writes.at(-1).body.date, '2026-09-06')
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
  await page.getByTestId('history-week-row-2026-09-06').click()
  await waitValue(page, '35:00')
  assert.equal(await page.getByTestId('history-week-row-2026-09-06').getAttribute('data-active'), 'true')
  await page.getByRole('button', { name: 'Cette semaine', exact: true }).waitFor()
  await page.getByTestId('history-day-row-2026-09-08').click()
  await page.getByRole('button', { name: 'Jour suivant', exact: true }).waitFor()
  assert.equal(await page.getByTestId('week-form').count(), 0)
  assert.equal(await page.getByTestId('history-week-row-2026-09-06').getAttribute('data-active'), 'false')
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
  assert.match(await page.getByTestId('period-label').innerText(), /30 août.*5 septembre 2026/i)
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

test('historique par paie : deux semaines, bornes inclusives et total cumulé', async t => {
  const days = ['2026-08-29', '2026-08-30', '2026-09-05', '2026-09-06', '2026-09-12', '2026-09-13'].map(date => ({
    id: `day-${date}`, user_id: 'weekly-test', date, mode: 'simple', start_time: '09:00', end_time: '10:00', entries: [],
  }))
  const { page, writes } = await setup(t, { now: '2026-09-06T14:00:00Z', days })
  await waitValue(page, '35:00')
  assert.match(await page.getByTestId('period-label').innerText(), /6 septembre.*12 septembre 2026/i)
  const group = page.getByTestId('history-pay-period-2026-08-30')
  assert.match(await group.innerText(), /30 août.*12 septembre 2026/i)
  assert.equal(await group.getByTestId('history-week-row-2026-08-30').count(), 1)
  assert.equal(await group.getByTestId('history-week-row-2026-09-06').count(), 1)
  assert.equal(await group.getByTestId('history-day-row-2026-08-29').count(), 0)
  assert.equal(await group.getByTestId('history-day-row-2026-08-30').count(), 1)
  assert.equal(await group.getByTestId('history-day-row-2026-09-06').count(), 1)
  assert.equal(await group.getByTestId('history-day-row-2026-09-12').count(), 1)
  assert.equal(await group.getByTestId('history-day-row-2026-09-05').count(), 1)
  assert.equal(await group.getByTestId('history-day-row-2026-09-13').count(), 0)
  assert.equal(await group.getByTestId('history-pay-period-total').innerText(), '69,00 h')
  assert.deepEqual(await page.locator('[data-testid^="history-pay-period-2026"]').evaluateAll(nodes => nodes.map(n => n.dataset.testid)), [
    'history-pay-period-2026-09-13', 'history-pay-period-2026-08-30', 'history-pay-period-2026-08-16',
  ])
  await inputHours(page, '40')
  await waitValue(page, '40:00')
  await page.waitForFunction(() => document.querySelector('[data-testid="history-pay-period-2026-08-30"] [data-testid="history-pay-period-total"]')?.textContent === '74,00 h')
  assert.equal(writes.at(-1).body.date, '2026-09-06')
  await page.getByRole('button', { name: 'Semaine suivante', exact: true }).click()
  await waitValue(page, '0:00')
  assert.match(await page.getByTestId('period-label').innerText(), /13 septembre.*19 septembre 2026/i)
})

for (const { name, now, start, end, before, after } of [
  { name: 'passage à l’heure d’hiver', now: '2026-11-02T14:00:00Z', start: '2026-10-25', end: '2026-11-07', before: '2026-10-24', after: '2026-11-08' },
  { name: 'changement d’année', now: '2027-01-01T14:00:00Z', start: '2026-12-20', end: '2027-01-02', before: '2026-12-19', after: '2027-01-03' },
  { name: 'première période complète de l’historique', now: '2026-09-21T14:00:00Z', start: '2026-06-21', end: '2026-07-04', before: '2026-06-20', after: '2026-07-05' },
]) {
  test(`période de paie : ${name}`, async t => {
    const days = [before, start, end, after].map(date => ({
      id: `day-${date}`, user_id: 'weekly-test', date, mode: 'simple', start_time: '09:00', end_time: '10:00', entries: [],
    }))
    const { page, writes } = await setup(t, { now, days, mode: 'simple' })
    const group = page.getByTestId(`history-pay-period-${start}`)
    await group.waitFor()
    for (const date of [start, end]) assert.equal(await group.getByTestId(`history-day-row-${date}`).count(), 1)
    for (const date of [before, after]) assert.equal(await group.getByTestId(`history-day-row-${date}`).count(), 0)
    assert.equal(await group.getByTestId('history-pay-period-total').innerText(), '2,00 h')
    await group.getByTestId(`history-day-row-${end}`).click()
    await page.waitForFunction(date => document.querySelector(`[data-testid="history-day-row-${date}"]`)?.dataset.active === 'true', end)
    assert.deepEqual(writes, [])
  })
}

test('samedi reste dans la semaine débutée le dimanche précédent', async t => {
  const { page } = await setup(t, { now: '2026-09-12T14:00:00Z' })
  await waitValue(page, '35:00')
  assert.match(await page.getByTestId('period-label').innerText(), /6 septembre.*12 septembre 2026/i)
})

})
