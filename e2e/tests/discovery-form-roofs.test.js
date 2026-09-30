// Parcours public avec réponses API simulées : aucun enregistrement de production.
const { test, before, after, describe } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
// Enveloppé dans describe : sous Node 18, un after() de premier niveau n'est joué
// qu'une fois la boucle vide — un navigateur ouvert l'en empêche, le test pend.
describe('discovery-form-roofs', () => {
const URL = process.env.ERP_URL || 'http://localhost:3004/erp'
let browser
before(async () => { browser = await chromium.launch({ headless: true }) })
after(async () => { await browser?.close() })

async function openForm(t, { response = {}, schema = {}, locked = true, mobile = false, legacy = false, viewport } = {}) {
  const context = await browser.newContext({ viewport: viewport || { width: 1280, height: 900 } })
  t.after(() => context.close())
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  t.after(() => assert.deepEqual(errors, []))
  const state = { response: { num_greenhouses: 1, greenhouses: [{ permission_level: 'helper' }], ...response }, saves: [], submitted: false, failSave: false }
  await page.route('**/api/customer/post-payment/**', async route => {
    const request = route.request()
    const path = new globalThis.URL(request.url()).pathname
    if (path.endsWith('/save')) {
      if (state.failSave) return route.fulfill({ status: 503, json: { error: 'Enregistrement indisponible' } })
      const patch = request.postDataJSON()
      state.saves.push(patch)
      state.response = { ...state.response, ...patch }
      return route.fulfill({ json: { response: state.response } })
    }
    if (path.endsWith('/submit')) {
      state.submitted = true
      return route.fulfill({ json: { ok: true } })
    }
    return route.fulfill({ json: { response: state.response, form_schema: schema, greenhouse_count_locked: locked, detected: { permission_level: 'helper', has_mobile_controller: mobile } } })
  })
  await page.goto(URL + (legacy ? '/customer/post-payment?session_id=cs_question_pages' : '/d/question-pages-test'))
  await page.locator('[data-question-page]').waitFor()
  return { page, state }
}
const current = page => page.locator('[data-question-page]').getAttribute('data-question-page')
async function next(page, expected) {
  const previous = await current(page)
  await page.getByRole('button', { name: 'Suivant', exact: true }).click()
  await page.waitForFunction(id => document.querySelector('[data-question-page]')?.dataset.questionPage !== id, previous)
  assert.equal(await page.locator('[data-question-page]').count(), 1)
  if (expected) assert.equal(await current(page), expected)
}
async function back(page, expected) {
  await page.getByRole('button', { name: 'Précédent', exact: true }).click()
  await page.locator(`[data-question-page="${expected}"]`).waitFor()
}
const yesNo = (page, yes) => page.getByRole('radio', { name: yes ? 'Oui' : 'Non', exact: true }).check({ force: true })
const control = page => page.locator('[data-question-page] select, [data-question-page] input:not([data-dont-know])').first()
// Toutes les questions sont obligatoires : pour traverser le formulaire, on
// répond au minimum (premier choix, ou « 1 ») à celles que le scénario ne fixe
// pas lui-même.
async function answerIfBlocked(page) {
  if (!await page.getByRole('button', { name: 'Suivant', exact: true }).isDisabled()) return
  const select = page.locator('[data-question-page] select').first()
  if (await select.count()) {
    const values = await select.locator('option').evaluateAll(os => os.map(o => o.value).filter(Boolean))
    if (values.length) return select.selectOption(values[0])
  }
  const radio = page.locator('[data-question-page] input[type=radio]').first()
  if (await radio.count()) return radio.check({ force: true })
  const field = page.locator('[data-question-page] input:not([data-dont-know]), [data-question-page] textarea').first()
  if (await field.count()) await field.fill('1')
}

test('toit ouvrant : moteur, inverseur, conditions et sauvegarde', async t => {
  const { page, state } = await openForm(t, { response: {
    is_new_site: 'add_to_existing', within_central_controller_range: true,
    shipping_address: { line1: '10 rue Test', province: 'QC' },
    form_options: { additional_equipment: [{ roofs: 2 }] },
    greenhouses: [{ permission_level: 'chief_grower', has_side_vents: false }],
  } })
  // 2 permissions Toits ouvrants : le client peut en déclarer jusqu'à 3.
  for (let i = 0; i < 30 && await current(page) !== 'greenhouse:0:roof_present'; i++) {
    await answerIfBlocked(page)
    await next(page)
  }
  assert.equal(await current(page), 'greenhouse:0:roof_present')
  // Toit en extra : « Aucun » disparaît, 1 ou 2 toits en images.
  assert.equal(await page.getByRole('radio', { name: 'Aucun toit ouvrant', exact: true }).count(), 0)
  await page.getByRole('radio', { name: '2 toits ouvrants', exact: true }).check({ force: true })
  // L'inverseur d'abord ; la tension n'est demandée qu'à qui n'en a pas.
  await next(page, 'greenhouse:0:roof_inverter')
  assert.ok(await page.getByText('2 toits ouvrants', { exact: true }).isVisible())
  await yesNo(page, false)
  await next(page, 'greenhouse:0:roof_voltage')
  await control(page).selectOption('240')
  await next(page, 'greenhouse:0:roof_ridder')
  assert.equal(await page.getByRole('button', { name: 'Suivant', exact: true }).isDisabled(), true)
  await yesNo(page, false)
  await next(page, 'greenhouse:0:roof_supply')
  assert.ok(await page.getByText(/Vous devez fournir l’inverseur/).isVisible())
  await back(page, 'greenhouse:0:roof_ridder')
  await yesNo(page, true)
  // Ridder RW240 : Orisha peut fournir l'inverseur, aucune page à ce sujet.
  await next(page, 'greenhouse:0:louvers')
  await back(page, 'greenhouse:0:roof_ridder')
  await back(page, 'greenhouse:0:roof_voltage')
  await back(page, 'greenhouse:0:roof_inverter')
  await yesNo(page, true)
  await next(page, 'greenhouse:0:roof_inverter_type')
  await page.getByRole('radio', { name: 'Je ne sais pas' }).check()
  await page.getByRole('radio', { name: /^Autre/ }).check()
  // « Autre » : marque et modèle sur la même page, tous deux obligatoires.
  assert.equal(await page.getByRole('button', { name: 'Suivant', exact: true }).isDisabled(), true)
  await page.getByLabel('Marque de l’inverseur').fill('Test marque')
  assert.equal(await page.getByRole('button', { name: 'Suivant', exact: true }).isDisabled(), true)
  await page.getByLabel('Modèle de l’inverseur').fill('Test modèle')
  await next(page, 'greenhouse:0:louvers')
  assert.equal(state.response.greenhouses[0].roof_inverter_brand, 'Test marque')
  assert.equal(state.response.greenhouses[0].roof_inverter_model, 'Test modèle')
  assert.equal(state.response.greenhouses[0].roof_motor_ridder_rw240, null)
  assert.equal(state.response.greenhouses[0].roof_motor_voltage, '')
  assert.equal(state.response.greenhouses[0].has_roof_vents, true)
  assert.equal(state.response.greenhouses[0].num_roof_vents, 2)
})
})
