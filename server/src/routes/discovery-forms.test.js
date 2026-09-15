import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import { buildTestApp, listen, closeServer, createTestUser, db } from '../test-helpers/testApp.js'
import formsRouter from './discovery-forms.js'
import publicRouter from './customer-post-payment.js'
import schemaRouter from './discovery-form-schema.js'

const app = buildTestApp({ '/api/discovery-forms': formsRouter, '/api/customer/post-payment': publicRouter, '/api/discovery-form-schema': schemaRouter })
const { base, server } = await listen(app)
after(() => closeServer(server))
const { token } = createTestUser()
async function api(method, path, body, publicRequest = false) {
  const result = await fetch(base + '/api' + path, { method, headers: { ...(!publicRequest ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: result.status, body: await result.json() }
}

test('distance du contrôleur : validation, persistance, aperçu et commande', async () => {
  db.prepare('INSERT INTO companies (id, name) VALUES (?, ?)').run('distance-company', 'Distance fixture')
  db.prepare('INSERT INTO products (id, name_fr, active) VALUES (?, ?, 1)').run('distance-controller', 'Contrôleur central')
  for (const answer of [true, false]) {
    const created = await api('POST', '/discovery-forms', { company_id: 'distance-company', helper_count: 2 })
    const form = created.body
    const path = `/customer/post-payment/by-token/${form.public_token}`
    await api('POST', path + '/save', { is_new_site: 'add_to_existing', greenhouses: [{ has_louvers: false }, { has_louvers: false }] }, true)
    assert.equal((await api('POST', path + '/submit', undefined, true)).status, 400)
    assert.equal((await api('POST', `/discovery-forms/${form.id}/create-order`)).status, 422)
    const invalid = await api('POST', path + '/save', { within_central_controller_range: 'false' }, true)
    assert.equal(invalid.body.response.within_central_controller_range, null)
    await api('POST', path + '/save', { within_central_controller_range: !answer }, true)
    // Le choix exact (250 pi, 350 pi avec coaxial, plus loin) voyage à côté du
    // booléen qui décide du contrôleur central à fournir.
    const distance = answer ? 'coax_350' : 'no'
    const saved = await api('POST', path + '/save', { within_central_controller_range: answer, central_controller_distance: distance }, true)
    assert.equal(saved.body.response.within_central_controller_range, answer)
    assert.equal(saved.body.response.central_controller_distance, distance)
    assert.equal((await api('GET', `/discovery-forms/${form.id}`)).body.central_controller_distance, distance)
    assert.equal((await api('GET', path, undefined, true)).body.response.within_central_controller_range, answer)
    assert.equal((await api('GET', `/discovery-forms/${form.id}`)).body.within_central_controller_range, answer)
    const preview = await api('GET', `/discovery-forms/${form.id}/equipment-preview`)
    assert.equal(preview.body.calculationComplete, true)
    assert.equal(preview.body.siteItems.filter(i => i.role === 'central_controller').length, answer ? 0 : 1)
    assert.equal((await api('POST', path + '/submit', undefined, true)).status, 200)
    const order = await api('POST', `/discovery-forms/${form.id}/create-order`)
    assert.equal(order.status, 201, JSON.stringify(order.body))
    const items = db.prepare('SELECT product_id, qty FROM order_items WHERE order_id=?').all(order.body.id)
    assert.deepEqual(items, answer ? [] : [{ product_id: 'distance-controller', qty: 1 }])
    const notes = db.prepare('SELECT notes FROM orders WHERE id=?').get(order.body.id).notes
    assert.equal(notes.includes('Les contrôleurs centraux de ce client doivent être programmés en mode multi-contrôleurs.'), !answer)
    assert.ok(notes.includes(`System Builder #${form.id}`))
  }
  // Contrôleur internet mobile acheté : la question n'est pas posée, donc
  // la soumission passe sans réponse et l'aperçu reste complet.
  const mobile = await api('POST', '/discovery-forms', { company_id: 'distance-company', helper_count: 1, form_options: { mobile_controller: true } })
  const mobilePath = `/customer/post-payment/by-token/${mobile.body.public_token}`
  await api('POST', mobilePath + '/save', { is_new_site: 'add_to_existing', greenhouses: [{ has_louvers: false }] }, true)
  assert.equal((await api('GET', `/discovery-forms/${mobile.body.id}/equipment-preview`)).body.calculationComplete, true)
  assert.equal((await api('POST', mobilePath + '/submit', undefined, true)).status, 200)

  db.prepare('UPDATE products SET active=0 WHERE id=?').run('distance-controller')
  const created = await api('POST', '/discovery-forms', { company_id: 'distance-company', helper_count: 1 })
  await api('POST', `/customer/post-payment/by-token/${created.body.public_token}/save`, { is_new_site: 'add_to_existing', within_central_controller_range: false, greenhouses: [{ has_louvers: false }] }, true)
  const refused = await api('POST', `/discovery-forms/${created.body.id}/create-order`)
  assert.equal(refused.status, 422)
  assert.ok(refused.body.warnings.some(w => w.code === 'central_controller_missing'))
  const configured = await api('PUT', '/discovery-form-schema', { equipment: { products: { central_controller: 'distance-controller' } } })
  assert.equal(configured.status, 200)
  assert.equal((await api('POST', `/discovery-forms/${created.body.id}/create-order`)).status, 422)
  db.prepare('UPDATE products SET active=1 WHERE id=?').run('distance-controller')
  assert.equal((await api('POST', `/discovery-forms/${created.body.id}/create-order`)).status, 201)
})

test('options créées → lecture publique → réponses → commande, avec DB isolée', async () => {
  db.prepare('INSERT INTO companies (id, name) VALUES (?, ?)').run('discovery-company', 'Discovery fixture')
  for (const id of ['discovery-mobile', 'discovery-sensor', 'discovery-furnace-wire']) db.prepare('INSERT INTO products (id, name_fr) VALUES (?, ?)').run(id, id)
  const created = await api('POST', '/discovery-forms', { company_id: 'discovery-company', chief_count: 1, form_options: { mobile_controller: true, sensors: { soil_temperature_sensor: 2 } } })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const form = created.body
  assert.equal(form.form_options.sensors.soil_temperature_sensor, 2)
  const path = `/customer/post-payment/by-token/${form.public_token}`
  const pub = await api('GET', path, undefined, true)
  assert.equal(pub.body.detected.has_mobile_controller, true)
  assert.equal(pub.body.response.form_options.sensors.soil_temperature_sensor, 2)
  const save = await api('POST', path + '/save', { is_new_site: 'add_to_existing', within_central_controller_range: true, greenhouses: [{ permission_level: 'chief_grower', has_louvers: false, furnaces: [{ control_wire_feet: 25 }] }], form_options: { mobile_controller: false, sensors: { soil_temperature_sensor: 99 } } }, true)
  assert.equal(save.status, 200)
  assert.equal(save.body.response.form_options.sensors.soil_temperature_sensor, 2, 'le client ne modifie pas les options achetées')
  const schema = await api('PUT', '/discovery-form-schema', { equipment: { products: { mobile_controller: 'discovery-mobile', soil_temperature_sensor: 'discovery-sensor', furnace_wire_25: 'discovery-furnace-wire' }, outputs: { louver_open_close: 2, humidity_haf: 1, invalid: 100 } } })
  assert.equal(schema.status, 200)
  assert.equal(schema.body.schema.equipment.outputs.louver_open_close, 2)
  assert(!('invalid' in schema.body.schema.equipment.outputs))
  const preview = await api('GET', `/discovery-forms/${form.id}/equipment-preview`)
  assert.equal(preview.body.siteItems.length, 2)
  const order = await api('POST', `/discovery-forms/${form.id}/create-order`)
  assert.equal(order.status, 201, JSON.stringify(order.body))
  const items = db.prepare('SELECT product_id, qty, notes FROM order_items WHERE order_id=?').all(order.body.id)
  assert.equal(items.find(i => i.product_id === 'discovery-sensor').qty, 2)
  assert.equal(items.find(i => i.product_id === 'discovery-sensor').notes, 'Site')
  assert.equal(items.find(i => i.product_id === 'discovery-furnace-wire').qty, 1)
  assert.equal((await api('POST', `/discovery-forms/${form.id}/create-order`)).status, 409)
})

test('soumission refusée pour louvre incomplète et commande sans dimensionnement refusée', async () => {
  const r = await api('POST', '/discovery-forms', { company_id: 'discovery-company', helper_count: 1 })
  const form = r.body
  const path = `/customer/post-payment/by-token/${form.public_token}`
  await api('POST', path + '/save', { is_new_site: 'add_to_existing', within_central_controller_range: true, greenhouses: [{ has_louvers: true, louvers: [{}] }] }, true)
  assert.equal((await api('POST', path + '/submit', undefined, true)).status, 400)
  const order = await api('POST', `/discovery-forms/${form.id}/create-order`)
  assert.equal(order.status, 422)
  assert.equal(db.prepare('SELECT generated_order_id FROM customer_onboarding_responses WHERE id=?').get(form.id).generated_order_id, null)
})

test('images des questions : conservation, lecture publique et retour automatique', async () => {
  const { buildForm } = await import('../../../client/src/lib/discoveryFormSchema.js')
  const images = { 'greenhouse.length_label': 'pipe-c.png', 'network.prompt': 'none', 'farm.title': '../invalid.png', unknown: 'site.webp' }
  const custom = [{ id: 'image-test', label: 'Question illustrée', section: 'end', image: 'shipping.webp' }]
  const saved = await api('PUT', '/discovery-form-schema', { images, custom })
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.body.schema.images, { 'greenhouse.length_label': 'pipe-c.png', 'network.prompt': 'none' })
  const read = await api('GET', '/discovery-form-schema')
  assert.equal(read.body.schema.custom[0].image, 'shipping.webp')
  const created = await api('POST', '/discovery-forms', { company_id: 'discovery-company', helper_count: 1 })
  const pub = await api('GET', `/customer/post-payment/by-token/${created.body.public_token}`, undefined, true)
  const form = buildForm(pub.body.form_schema)
  assert.equal(form.image('greenhouse.length_label'), 'pipe-c.png')
  assert.equal(form.image('network.prompt'), 'none')
  assert.equal(form.image('farm.title'), '')
  assert.equal(form.custom('end')[0].image, 'shipping.webp')
  await api('PUT', '/discovery-form-schema', { images: {}, custom: [{ ...custom[0], image: 'none' }] })
  const reset = await api('GET', '/discovery-form-schema')
  assert.equal(buildForm(reset.body.schema).image('greenhouse.length_label'), '')
  assert.equal(buildForm(reset.body.schema).custom('end')[0].image, 'none')
})

test('dépôt d’image : validation, fichier public, sauvegarde et retrait', async () => {
  const sharp = (await import('sharp')).default
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'discovery-images-'))
  const previous = process.env.UPLOADS_PATH
  process.env.UPLOADS_PATH = dir
  async function upload(bytes, name, auth = true) {
    const data = new FormData()
    data.append('file', new Blob([bytes]), name)
    return fetch(base + '/api/discovery-form-schema/images', { method: 'POST', headers: auth ? { Authorization: `Bearer ${token}` } : {}, body: data })
  }
  try {
    const png = await sharp({ create: { width: 1800, height: 100, channels: 4, background: '#008844' } }).png().toBuffer()
    assert.equal((await upload(png, 'image.png', false)).status, 401)
    assert.equal((await upload('not an image', 'image.png')).status, 400)
    assert.equal((await upload(Buffer.alloc(10 * 1024 * 1024 + 1), 'large.png')).status, 413)
    const result = await upload(png, 'photo.png')
    assert.equal(result.status, 201)
    const { image } = await result.json()
    const publicImage = await fetch(base + image.replace(/^\/erp/, ''))
    assert.equal(publicImage.status, 200)
    assert.equal(publicImage.headers.get('content-type'), 'image/webp')
    const metadata = await sharp(Buffer.from(await publicImage.arrayBuffer())).metadata()
    assert.equal(metadata.width, 1600)
    const saved = await api('PUT', '/discovery-form-schema', { images: { 'greenhouse.length_label': image }, custom: [{ id: 'uploaded', section: 'end', label: 'Photo', image }] })
    assert.equal(saved.body.schema.images['greenhouse.length_label'], image)
    assert.equal(saved.body.schema.custom[0].image, image)
    const read = await api('GET', '/discovery-form-schema')
    const { buildForm } = await import('../../../client/src/lib/discoveryFormSchema.js')
    assert.equal(buildForm(read.body.schema).image('greenhouse.length_label'), image)
    assert.equal(buildForm(read.body.schema).custom('end')[0].image, image)
    const removed = await api('PUT', '/discovery-form-schema', { images: { 'greenhouse.length_label': 'none' } })
    assert.equal(buildForm(removed.body.schema).image('greenhouse.length_label'), 'none')
    assert.equal((await fetch(base + '/api/discovery-form-schema/images/missing.png')).status, 404)
  } finally {
    if (previous === undefined) delete process.env.UPLOADS_PATH
    else process.env.UPLOADS_PATH = previous
    await rm(dir, { recursive: true, force: true })
  }
})

test('commande de louvre inconnue : sauvegarde, envoi et signalement au vérificateur', async () => {
  db.prepare('INSERT INTO companies (id, name) VALUES (?, ?)').run('louvre-company', 'Louvre fixture')
  const created = await api('POST', '/discovery-forms', { company_id: 'louvre-company', helper_count: 1 })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const form = created.body
  const path = `/customer/post-payment/by-token/${form.public_token}`
  const greenhouses = [{ has_louvers: true, louvers: [{ voltage: '110', control_type: 'other', has_fan: false }] }]
  assert.equal((await api('POST', path + '/save', { is_new_site: 'new', greenhouses }, true)).status, 200)
  assert.equal((await api('GET', path, undefined, true)).body.response.greenhouses[0].louvers[0].control_type, 'other')
  assert.equal((await api('POST', path + '/submit', undefined, true)).status, 200)
  assert.equal((await api('GET', `/discovery-forms/${form.id}`)).body.greenhouses[0].louvers[0].control_type, 'other')
  const preview = await api('GET', `/discovery-forms/${form.id}/equipment-preview`)
  assert.equal(preview.body.calculationComplete, false)
  assert.match(preview.body.warnings.find(w => w.code === 'louver_call_client').message, /Louvre #1.*appeler le client/)
  assert.equal((await api('POST', `/discovery-forms/${form.id}/create-order`)).status, 422)
})

test('irrigation : envoi sans paiement et ancien checkout désactivé', async () => {
  db.prepare('INSERT INTO companies (id, name) VALUES (?, ?)').run('irrigation-company', 'Irrigation fixture')
  for (const zones of [[0], [4], [5], [9], [3, 3], [2, 5]]) {
    const created = await api('POST', '/discovery-forms', { company_id: 'irrigation-company', chief_count: zones.length })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const path = `/customer/post-payment/by-token/${created.body.public_token}`
    const greenhouses = zones.map(irrigation_zones => ({ permission_level: 'chief_grower', has_louvers: false, irrigation_zones }))
    const saved = await api('POST', path + '/save', { is_new_site: 'new', greenhouses }, true)
    assert.equal(saved.status, 200)
    assert.equal(saved.body.response.valve_blocks_paid, false)
    const invoicesBefore = db.prepare('SELECT COUNT(*) AS count FROM pending_invoices').get().count
    const checkout = await api('POST', path + '/valve-blocks-checkout', { pricing: 'one_time' }, true)
    assert.equal(checkout.status, 410)
    assert.equal(checkout.body.code, 'valve_blocks_sales_followup')
    assert.equal(checkout.body.checkout_url, undefined)
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM pending_invoices').get().count, invoicesBefore)
    const sent = await api('POST', path + '/submit', undefined, true)
    assert.equal(sent.status, 200, JSON.stringify(sent.body))
    assert.equal(sent.body.response.status, 'submitted')
    assert.equal(sent.body.response.extras_pending_invoice_id, null)
    const detail = await api('GET', `/discovery-forms/${created.body.id}`)
    assert.deepEqual(detail.body.greenhouses.map(g => g.irrigation_zones), zones)
    assert.equal((await api('POST', path + '/submit', undefined, true)).body.already_submitted, true)
  }
  assert.equal((await api('POST', '/customer/post-payment/by-token/missing-irrigation/valve-blocks-checkout', {}, true)).status, 404)
})

test('JWT : association typée, persistance, aperçu mixte et programmation dans la commande', async () => {
  // La colonne de corbeille est normalement ajoutée par les migrations au
  // démarrage ; ce harnais initialise uniquement schema.js sur une DB jetable.
  if (!db.pragma('table_info(products)').some(c => c.name === 'deleted_at')) db.exec('ALTER TABLE products ADD COLUMN deleted_at TEXT')
  db.prepare('INSERT INTO companies (id, name) VALUES (?, ?)').run('jwt-company', 'JWT fixture')
  for (const [id, type] of [['jwt-ventilation', 'JWT'], ['jwt-prevention', 'JWT'], ['jwt-wrong-type', 'Pièce']]) {
    db.prepare('INSERT INTO products (id, name_fr, type, active) VALUES (?, ?, ?, 1)').run(id, id, type)
  }
  for (const id of ['jwt-wrong-type', 'jwt-nonexistent']) {
    const invalid = await api('PUT', '/discovery-form-schema', { equipment: { products: { jwt_disease_prevention: id } } })
    assert.equal(invalid.status, 400, JSON.stringify(invalid.body))
  }
  const products = { jwt_advanced_ventilation: 'jwt-ventilation', jwt_disease_prevention: 'jwt-prevention' }
  assert.equal((await api('PUT', '/discovery-form-schema', { equipment: { products } })).status, 200)
  assert.deepEqual((await api('GET', '/discovery-form-schema')).body.schema.equipment.products, products)
  const created = await api('POST', '/discovery-forms', { company_id: 'jwt-company', chief_count: 2, helper_count: 1 })
  const form = created.body
  const save = await api('POST', `/customer/post-payment/by-token/${form.public_token}/save`, {
    is_new_site: 'new', greenhouses: [
      { permission_level: 'chief_grower', num_fans: 2, has_roof_vents: true },
      { permission_level: 'chief_grower' },
      { permission_level: 'helper', num_fans: 2, has_roof_vents: true },
    ],
  }, true)
  assert.equal(save.status, 200)
  const preview = await api('GET', `/discovery-forms/${form.id}/equipment-preview`)
  assert.deepEqual(preview.body.orderItems.map(i => [i.product_id, i.qty]), [['jwt-ventilation', 1], ['jwt-prevention', 2]])
  const order = await api('POST', `/discovery-forms/${form.id}/create-order`)
  assert.equal(order.status, 201)
  const items = db.prepare('SELECT product_id, qty, notes FROM order_items WHERE order_id=?').all(order.body.id)
  assert.deepEqual(items.map(i => [i.product_id, i.qty]), [['jwt-ventilation', 1], ['jwt-prevention', 2]])
  assert(items.every(i => /programmer.*contrôleur central.*montage/.test(i.notes)))
  db.prepare("UPDATE products SET type='Pièce' WHERE id='jwt-prevention'").run()
  const invalidated = await api('GET', `/discovery-forms/${form.id}/equipment-preview`)
  assert(invalidated.body.unconfigured.includes('jwt_disease_prevention'))
  assert(!invalidated.body.orderItems.some(i => i.product_id === 'jwt-prevention'))
})
