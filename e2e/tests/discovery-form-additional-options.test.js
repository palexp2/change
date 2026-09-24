// API simulée : aucune lecture ni écriture des données de production.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

test('création : quantités supplémentaires saisies par serre et transmises au formulaire', async t => {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  await context.routeWebSocket('**/ws**', () => {})
  const token = `test.${Buffer.from(JSON.stringify({ id: 'test', name: 'Test', role: 'admin' })).toString('base64')}.test`
  await context.addInitScript(token => localStorage.setItem('erp_token', token), token)
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  let submitted
  await page.route('**/api/**', async route => {
    const request = route.request()
    const endpoint = new URL(request.url()).pathname.replace(/^\/erp\/api/, '')
    if (endpoint === '/discovery-forms' && request.method() === 'POST') {
      submitted = request.postDataJSON()
      return route.fulfill({ status: 201, json: { id: 'fixture' } })
    }
    if (endpoint === '/companies/lookup') return route.fulfill({ json: [{ id: 'company', name: 'Serres Test' }] })
    if (endpoint.startsWith('/discovery-forms')) return route.fulfill({ json: { rows: [] } })
    if (endpoint.startsWith('/bootstrap')) return route.fulfill({ json: { tables: {}, snapshot_ts: new Date().toISOString() } })
    if (endpoint.startsWith('/views/')) return route.fulfill({ json: { config: { visible_columns: ['company_name'], default_sort: [] }, pills: [], dynamicFields: [] } })
    if (endpoint.includes('/preferences')) return route.fulfill({ json: {} })
    return route.fulfill({ json: { data: [], total: 0 } })
  })
  await page.goto((process.env.ERP_URL || 'http://localhost:3004/erp') + '/discovery-forms')
  await page.getByRole('button', { name: 'Nouveau formulaire', exact: true }).click()
  await page.getByTestId('linked-record-add').click()
  await page.getByRole('button', { name: 'Serres Test', exact: true }).click()
  await page.getByRole('spinbutton', { name: 'Chef de culture', exact: true }).fill('2')
  await page.getByRole('spinbutton', { name: 'Helper', exact: true }).fill('1')
  assert.equal(await page.getByRole('checkbox', { name: 'Fournaises', exact: true }).count(), 0)
  assert.equal(await page.getByRole('spinbutton', { name: 'Serre #1 · Chauffage', exact: true }).inputValue(), '0')
  await page.getByRole('spinbutton', { name: 'Serre #1 · Chauffage', exact: true }).fill('2')
  await page.getByRole('spinbutton', { name: 'Serre #2 · Toits ouvrants', exact: true }).fill('3')
  await page.getByRole('spinbutton', { name: 'Serre #3 · Côtés ouvrants', exact: true }).fill('4')
  await page.getByRole('spinbutton', { name: 'Serre #3 · Irrigation', exact: true }).fill('1')
  await page.screenshot({ path: '/tmp/discovery-additional-options-modal.png', fullPage: true })
  await page.getByRole('button', { name: 'Créer et ouvrir', exact: true }).click()
  await page.getByRole('button', { name: 'Créer et ouvrir', exact: true }).waitFor({ state: 'hidden' })
  assert.deepEqual(submitted.form_options.additional_equipment, [
    { furnaces: 2, valves: 0, rollups: 0, roofs: 0 },
    { furnaces: 0, valves: 0, rollups: 0, roofs: 3 },
    { furnaces: 0, valves: 1, rollups: 4, roofs: 0 },
  ])
  assert.equal(submitted.chief_count, 2)
  assert.equal(submitted.helper_count, 1)
  assert.deepEqual(errors, [])
})
