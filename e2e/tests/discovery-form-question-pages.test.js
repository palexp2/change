// Parcours public avec réponses API simulées : aucun enregistrement de production.
const { test, before, after } = require('node:test')
const assert = require('node:assert/strict')
const { chromium } = require('playwright')
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

test('site existant : distance immédiatement après le type, réponse obligatoire et persistée', async t => {
  const { page, state } = await openForm(t, { response: { shipping_address: { line1: '10 rue Test', province: 'QC' } }, schema: { custom: [{ id: 'order-extra', section: 'order_type', label: 'Votre référence', type: 'text' }] } })
  await page.getByText('Ajouter à un site de production existant qui a déjà Orisha', { exact: true }).click()
  await next(page, 'controller_distance')
  assert.equal(await page.getByRole('button', { name: 'Suivant' }).isDisabled(), true)
  await page.getByText('Non', { exact: true }).click()
  assert.ok(await page.getByText(/mode multi-contrôleurs/).isVisible())
  await next(page, 'custom:order-extra')
  assert.equal(state.response.within_central_controller_range, false)
  await back(page, 'controller_distance')
  assert.equal(await page.getByRole('radio', { name: 'Non', exact: true }).isChecked(), true)
  await page.getByText('Oui', { exact: true }).click()
  assert.ok(await page.getByText('Aucun nouveau contrôleur central à fournir.', { exact: true }).isVisible())
  await next(page, 'custom:order-extra')
  assert.equal(state.response.within_central_controller_range, true)
  await page.reload()
  await page.locator('[data-question-page]').waitFor()
  await next(page, 'controller_distance')
  assert.equal(await page.getByRole('radio', { name: 'Oui', exact: true }).isChecked(), true)
  await back(page, 'order_type')
  await page.getByText('Un nouveau site de production avec Orisha', { exact: true }).click()
  await next(page, 'custom:order-extra')
  await next(page, 'farm_address')
})

test('une question, validation, retour arrière, branches et sauvegarde avant envoi', async t => {
  const { page, state } = await openForm(t, { response: { farm_address: { line1: '10 rue Test', province: 'QC' }, shipping_address: { line1: '20 rue Test', province: 'QC' } }, schema: { custom: [
    { id: 'intro', section: 'intro', label: 'Votre référence', type: 'text', required: true },
    { id: 'end', section: 'end', label: 'Un commentaire', type: 'text' },
  ] } })
  assert.equal(await current(page), 'custom:intro')
  assert.equal(await page.getByRole('button', { name: 'Suivant' }).isDisabled(), true)
  await control(page).fill('Client test')
  await next(page, 'order_type')
  await page.getByText('Un nouveau site de production avec Orisha', { exact: true }).click()
  assert.equal(await current(page), 'order_type')
  assert.equal(await page.getByText('Adresse de la ferme', { exact: true }).count(), 0)
  await next(page, 'farm_address')
  await next(page, 'shipping_same')
  await page.getByText('Non, différente', { exact: true }).click()
  await next(page, 'shipping_address')
  await back(page, 'shipping_same')
  await page.getByText('Oui, même adresse', { exact: true }).click()
  await next(page, 'network')
  await page.getByText('Oui — Wi-Fi à moins de 250 pi avec ligne de vue', { exact: true }).click()
  await next(page, 'wifi_ssid')
  await control(page).fill('Serres')
  await next(page, 'wifi_password')
  await control(page).fill('test-only-password')
  await next(page, 'greenhouse:0:side_vents')
  await page.getByRole('radio', { name: '2 côtés ouvrants' }).check({ force: true })
  await next(page, 'greenhouse:0:existing_motors')
  assert.equal(await page.getByRole('button', { name: 'Suivant' }).isDisabled(), true)
  await page.getByText("J'ai besoin de moteurs", { exact: true }).click()
  await next(page, 'greenhouse:0:length_range')
  await control(page).selectOption('over_200')
  await next(page, 'greenhouse:0:length')
  assert.equal(await page.getByRole('button', { name: 'Suivant' }).isDisabled(), true)
  await control(page).fill('200')
  assert.equal(await page.getByRole('button', { name: 'Suivant' }).isDisabled(), true)
  await control(page).fill('250')
  await next(page, 'greenhouse:0:side_vent_height')
  await back(page, 'greenhouse:0:length')
  await control(page).fill('200')
  await back(page, 'greenhouse:0:length_range')
  await back(page, 'greenhouse:0:existing_motors')
  await back(page, 'greenhouse:0:side_vents')
  await page.getByRole('radio', { name: 'Aucun côté ouvrant' }).check({ force: true })
  await next(page, 'greenhouse:0:louvers')
  await page.getByRole('radio', { name: 'Aucune louvre' }).check({ force: true })
  await next(page, 'greenhouse:0:fans')
  await control(page).selectOption('0')
  await next(page, 'custom:end')
  await control(page).fill('Fin du formulaire')
  await next(page, 'submit')
  await back(page, 'custom:end')
  assert.equal(await control(page).inputValue(), 'Fin du formulaire')
  await next(page, 'submit')
  await page.getByRole('button', { name: 'Soumettre', exact: true }).click()
  await page.getByRole('heading', { name: 'Informations enregistrées' }).waitFor()
  assert.equal(state.submitted, true)
  assert.equal(state.response.custom_answers.intro, 'Client test')
  assert.equal(state.response.wifi_ssid, 'Serres')
  assert.equal(state.response.greenhouses[0].length, '200')
  assert.equal(await page.locator('[data-question-page]').count(), 0)
})

test('détails de chaque équipement et questions conditionnelles, sur mobile', async t => {
  const { page, state } = await openForm(t, { viewport: { width: 390, height: 844 }, response: {
    is_new_site: 'add_to_existing', within_central_controller_range: true, shipping_address: { line1: '10 rue Test', province: 'QC' }, num_greenhouses: 2,
    form_options: { humidity_retention: true },
    greenhouses: [
      { permission_level: 'chief_grower', length_range: 'up_to_200', has_side_vents: true, num_side_vent_motors: 2, side_pipe_type: 'steel_O', guide_pipes_state: 'present', has_existing_side_vent_motors: true, num_fans: '2', has_louvers: true, louvers: [{ voltage: 'other', voltage_other: '240 V', control_type: 'open_close', has_fan: true }, { voltage: '24', control_type: 'spring_loaded', has_fan: false }], humidity_valve: false, humidity_haf: true, humidity_haf_count: 2, has_furnaces: true, num_furnaces: 2, furnaces: [{ brand: 'Modine', model: 'PDP' }, { brand: 'Autre', model: 'Autre' }], irrigation_zones: 2, needs_orisha_valves: false },
      { permission_level: 'helper', has_side_vents: false, has_louvers: false, humidity_valve: false, humidity_haf: false },
    ],
  }, schema: { custom: [
    { id: 'sides', section: 'greenhouse', label: 'Détails des côtés', required: true, visibleIf: { match: 'all', rules: [{ field: 'has_side_vents', op: 'eq', value: 'yes' }] } },
    { id: 'chief', section: 'greenhouse_chief', label: 'Détails Chief', type: 'text' },
  ] } })
  // Le formulaire reprend à la première question sans réponse : on remonte au
  // début pour dérouler le parcours complet.
  const previous = page.getByRole('button', { name: 'Précédent', exact: true })
  while (await previous.isEnabled()) {
    const id = await current(page)
    await previous.click()
    await page.waitForFunction(x => document.querySelector('[data-question-page]')?.dataset.questionPage !== x, id)
  }
  const visited = []
  while (await current(page) !== 'submit') {
    const id = await current(page)
    visited.push(id)
    assert.ok(visited.length < 100, 'le parcours doit se terminer')
    if (id.startsWith('greenhouse:')) {
      // Un groupe de boutons radio (et sa case « Je ne sais pas ») reste une
      // seule question : seuls les contrôles autonomes sont comptés.
      assert.ok(await page.locator('[data-question-page] input:not([data-dont-know]):not([type=radio]), [data-question-page] select, [data-question-page] textarea').count() <= 1, `${id} affiche plusieurs questions`)
    }
    if (id === 'greenhouse:0:custom:sides') {
      assert.equal(await page.getByRole('button', { name: 'Suivant' }).isDisabled(), true)
      await control(page).fill('Deux côtés')
    }
    await answerIfBlocked(page)
    await next(page)
  }
  for (const id of ['motor_brand', 'motor_model', 'louver:0:type', 'louver:1:fan', 'furnace:0:brand', 'furnace:1:model_other', 'haf_count', 'valve_wire', 'valve_model', 'custom:sides', 'custom:chief']) assert.ok(visited.includes(`greenhouse:0:${id}`), `page manquante : ${id}`)
  assert.ok(visited.indexOf('greenhouse:0:side_vents') < visited.indexOf('greenhouse:0:length_range'))
  assert.equal(visited[visited.indexOf('greenhouse:0:side_vents') + 1], 'greenhouse:0:existing_motors')
  for (const id of ['side_vent_height', 'side_pipe_type', 'side_pipe_diameter', 'side_pipe_diameter:other']) assert.ok(!visited.includes(`greenhouse:0:${id}`), `question inutile avec moteurs existants : ${id}`)
  assert.ok(!visited.includes('greenhouse:1:existing_motors'))
  assert.ok(!visited.includes('greenhouse:0:length'))
  assert.ok(!visited.includes('greenhouse:1:length_range'))
  assert.ok(!visited.includes('greenhouse:1:length'))
  assert.ok(!visited.includes('greenhouse:1:custom:sides'))
  assert.ok(!visited.includes('greenhouse:1:custom:chief'))
  assert.ok(!visited.includes('greenhouse_count'))
  assert.ok(!visited.includes('network'))
  assert.equal(await page.getByRole('button', { name: 'Soumettre' }).isEnabled(), true)
  assert.equal(state.response.greenhouses[0].custom.sides, 'Deux côtés')
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false)
})

test('échec de sauvegarde : reste sur la question, puis permet de réessayer', async t => {
  const { page, state } = await openForm(t)
  state.failSave = true
  await page.getByText('Un nouveau site de production avec Orisha', { exact: true }).click()
  await page.getByRole('button', { name: 'Suivant' }).click()
  await page.getByText('Enregistrement indisponible', { exact: true }).first().waitFor()
  assert.equal(await current(page), 'order_type')
  state.failSave = false
  await next(page, 'farm_address')
  assert.equal(state.response.is_new_site, 'new')
})

test('ancien lien après paiement : nombre de serres et contrôleur mobile', async t => {
  const { page } = await openForm(t, { legacy: true, locked: false, mobile: true, response: { is_new_site: 'new', farm_address: { line1: '10 rue Test', province: 'QC' }, shipping_same_as_farm: true } })
  await next(page, 'farm_address')
  await next(page, 'shipping_same')
  await next(page, 'mobile')
  await next(page, 'greenhouse_count')
  await control(page).fill('2')
  await next(page, 'greenhouse:0:side_vents')
  await back(page, 'greenhouse_count')
  assert.equal(await control(page).inputValue(), '2')
})

test('type de louvre : les combinaisons en images, « autre » sauvegardé et soumis', async t => {
  const { page, state } = await openForm(t, { response: {
    is_new_site: 'add_to_existing', within_central_controller_range: true,
    shipping_address: { line1: '10 rue Test', province: 'QC' },
    greenhouses: [{ permission_level: 'chief_grower', has_side_vents: false, num_fans: '0', has_louvers: true, louvers: [{ has_fan: false }], humidity_valve: false, humidity_haf: false, has_furnaces: false, irrigation_zones: 0, needs_orisha_valves: false }],
  } })
  while (await current(page) !== 'greenhouse:0:louver:0:type') await next(page)
  // Une seule question : voltage et commande ne font qu'une, en images.
  assert.equal(await page.locator('[data-question-page] input[type=radio]').count(), 3)
  assert.equal(await page.getByRole('button', { name: 'Suivant', exact: true }).isDisabled(), true)
  await page.getByRole('radio', { name: 'Spring loaded 110 V', exact: true }).check({ force: true })
  await next(page, 'greenhouse:0:louver:0:fan')
  assert.equal(state.response.greenhouses[0].louvers[0].voltage, '110')
  assert.equal(state.response.greenhouses[0].louvers[0].control_type, 'spring_loaded')
  await back(page, 'greenhouse:0:louver:0:type')
  const other = page.getByRole('radio', { name: 'Autre / Je ne sais pas', exact: true })
  assert.equal(await page.getByRole('radio', { name: 'Spring loaded 110 V', exact: true }).isChecked(), true)
  await other.check({ force: true })
  await next(page, 'greenhouse:0:louver:0:fan')
  while (await current(page) !== 'submit') await next(page)
  await page.getByRole('button', { name: 'Soumettre', exact: true }).click()
  await page.getByRole('heading', { name: 'Informations enregistrées' }).waitFor()
  assert.equal(state.submitted, true)
  assert.equal(state.response.greenhouses[0].louvers[0].control_type, 'other')
  assert.equal(state.response.greenhouses[0].louvers[0].voltage, '')
})

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`fournaises : trois images, détails et sauvegarde (${viewport.width}px)`, async t => {
    const firstFurnace = { brand: 'Modine', model: 'Existant', control_wire_feet: '25', backup_thermostat: true }
    const { page, state } = await openForm(t, { viewport, response: {
      is_new_site: 'add_to_existing', within_central_controller_range: true,
      shipping_address: { line1: '10 rue Test', province: 'QC' },
      greenhouses: [{ permission_level: 'chief_grower', has_side_vents: false, num_fans: '0', has_louvers: false, furnaces: [firstFurnace], irrigation_zones: 0, needs_orisha_valves: false }],
    } })
    const reachFurnaces = async () => {
      for (let i = 0; i < 30 && await current(page) !== 'greenhouse:0:furnaces'; i++) {
        await answerIfBlocked(page)
        await next(page)
      }
      assert.equal(await current(page), 'greenhouse:0:furnaces')
    }
    const choose = async label => {
      const radio = page.getByRole('radio', { name: label, exact: true })
      await radio.locator('..').locator('svg').click()
      assert.equal(await radio.isChecked(), true)
    }
    await reachFurnaces()
    assert.match(await page.locator('[data-question-page] legend').innerText(), /^Combien y a-t-il de fournaises à automatiser dans cette serre:/)
    assert.equal(await page.locator('[data-question-page] input[type=radio]').count(), 3)
    assert.equal(await page.locator('[data-question-page] select').count(), 0)
    assert.equal(await page.getByRole('button', { name: 'Suivant' }).isDisabled(), true)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true)

    await page.screenshot({ path: `/tmp/erp-furnaces-${viewport.width}.png` })
    await choose('2')
    await next(page, 'greenhouse:0:furnace:0:brand')
    assert.equal(state.response.greenhouses[0].has_furnaces, true)
    assert.equal(state.response.greenhouses[0].num_furnaces, 2)
    assert.deepEqual(state.response.greenhouses[0].furnaces, [firstFurnace, {}])
    await back(page, 'greenhouse:0:furnaces')
    assert.equal(await page.getByRole('radio', { name: '2', exact: true }).isChecked(), true)
    await choose('1')
    await next(page, 'greenhouse:0:furnace:0:brand')
    assert.equal(state.response.greenhouses[0].num_furnaces, 1)
    assert.deepEqual(state.response.greenhouses[0].furnaces, [firstFurnace])
    await back(page, 'greenhouse:0:furnaces')
    await choose('Aucune')
    await next(page, 'greenhouse:0:irrigation_zones')
    assert.equal(state.response.greenhouses[0].has_furnaces, false)
    assert.equal(state.response.greenhouses[0].num_furnaces, 0)
    assert.deepEqual(state.response.greenhouses[0].furnaces, [])

    await page.reload()
    await page.locator('[data-question-page]').waitFor()
    // Le formulaire reprend à la première réponse manquante ou à l’envoi.
    for (let i = 0; i < 15 && await current(page) !== 'greenhouse:0:furnaces'; i++) {
      const previous = await current(page)
      await page.getByRole('button', { name: 'Précédent', exact: true }).click()
      await page.waitForFunction(id => document.querySelector('[data-question-page]')?.dataset.questionPage !== id, previous)
    }
    assert.equal(await current(page), 'greenhouse:0:furnaces')
    assert.equal(await page.getByRole('radio', { name: 'Aucune', exact: true }).isChecked(), true)
    // Les flèches du clavier permettent aussi de sélectionner une image.
    await page.getByRole('radio', { name: 'Aucune', exact: true }).focus()
    await page.keyboard.press('ArrowRight')
    assert.equal(await page.getByRole('radio', { name: '1', exact: true }).isChecked(), true)
    await next(page, 'greenhouse:0:furnace:0:brand')
    assert.deepEqual(state.response.greenhouses[0].furnaces, [{}])
  })
}

for (const zones of [4, 5, 9]) {
  test(`irrigation : ${zones} zones, envoi sans page de paiement`, async t => {
    const { page, state } = await openForm(t, { response: {
      is_new_site: 'add_to_existing', within_central_controller_range: true,
      shipping_address: { line1: '10 rue Test', province: 'QC' },
      valve_blocks_needed: Math.max(0, Math.ceil((zones - 4) / 4)), valve_blocks_paid: false,
      greenhouses: [{ permission_level: 'chief_grower', has_side_vents: false, num_fans: '0', has_louvers: false, has_furnaces: false, irrigation_zones: zones, needs_orisha_valves: true, valve_control_wire_feet: '25' }],
    } })
    const checkoutRequests = []
    page.on('request', request => { if (request.url().includes('valve-blocks-checkout')) checkoutRequests.push(request.url()) })
    const previous = page.getByRole('button', { name: 'Précédent', exact: true })
    while (await previous.count()) {
      const id = await current(page)
      await previous.click()
      await page.waitForFunction(x => document.querySelector('[data-question-page]')?.dataset.questionPage !== x, id)
    }
    const visited = []
    while (await current(page) !== 'submit') {
      const id = await current(page)
      visited.push(id)
      assert.ok(visited.length < 60)
      assert.notEqual(id, 'valve_payment')
      if (id === 'greenhouse:0:irrigation_zones') {
        assert.equal(await page.getByText('Un vendeur vous contactera pour vos zones d’irrigation supplémentaires.', { exact: true }).count(), zones > 4 ? 1 : 0)
      }
      await answerIfBlocked(page)
      await next(page)
    }
    assert.ok(visited.includes('greenhouse:0:irrigation_zones'))
    await page.getByRole('button', { name: 'Soumettre', exact: true }).click()
    await page.getByRole('heading', { name: 'Informations enregistrées' }).waitFor()
    assert.equal(state.submitted, true)
    assert.equal(state.response.greenhouses[0].irrigation_zones, zones)
    assert.equal(await page.getByText('Un vendeur vous contactera pour vos zones d’irrigation supplémentaires.', { exact: true }).count(), zones > 4 ? 1 : 0)
    assert.deepEqual(checkoutRequests, [])
  })
}
