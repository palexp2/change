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



test('adresses : liens avant commande, livraison distincte ou à la ferme, site existant', async () => {
  db.prepare('INSERT INTO companies (id, name) VALUES (?, ?)').run('address-company', 'Adresses fixture')
  db.prepare('INSERT INTO products (id, name_fr, active) VALUES (?, ?, 1)').run('address-controller', 'Contrôleur central')
  const farm = { line1: '12 chemin de la Ferme', city: 'Québec', province: 'QC', postal_code: 'G1R 1A1', country: 'Canada' }
  const shipping = { ...farm, line1: '34 rue du Quai' }
  // Le miroir Airtable est normalement créé au démarrage hors du harnais.
  if (!db.pragma('table_info(orders)').some(c => c.name === 'adresse_de_livraison')) db.exec('ALTER TABLE orders ADD COLUMN adresse_de_livraison TEXT')
  for (const scenario of ['distinct', 'same', 'existing', 'draft']) {
    const { body: form } = await api('POST', '/discovery-forms', { company_id: 'address-company', helper_count: 1 })
    const path = `/customer/post-payment/by-token/${form.public_token}`
    const existing = scenario === 'existing'
    const saved = await api('POST', path + '/save', {
      is_new_site: existing ? 'add_to_existing' : 'new', within_central_controller_range: true,
      greenhouses: [{ has_louvers: false }],
      ...(existing ? {} : { farm_address: farm, shipping_address: shipping, shipping_same_as_farm: scenario === 'same' }),
    }, true)
    assert.equal(saved.status, 200)
    if (scenario !== 'draft') assert.equal((await api('POST', path + '/submit', undefined, true)).status, 200)
    const detail = (await api('GET', `/discovery-forms/${form.id}`)).body
    assert.equal(detail.farm_address.line1, farm.line1)
    assert.equal(detail.shipping_address.line1, scenario === 'same' ? farm.line1 : shipping.line1)
    assert.ok(detail.farm_address_id)
    assert.ok(detail.shipping_address_id)
    if (scenario === 'same') assert.equal(detail.shipping_address_id, detail.farm_address_id)
    const created = await api('POST', `/discovery-forms/${form.id}/create-order`)
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(created.body.id)
    assert.equal(order.farm_address_id, detail.farm_address_id)
    assert.equal(order.address_id, detail.shipping_address_id)
    assert.deepEqual(JSON.parse(order.adresse_de_livraison), [detail.shipping_address_id])
    const stored = db.prepare('SELECT * FROM customer_onboarding_responses WHERE id=?').get(form.id)
    assert.equal(stored.farm_address_id, order.farm_address_id)
    assert.equal(stored.shipping_address_id, order.address_id)
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM adresses WHERE company_id=?').get('address-company').n, 2)
})

test('adresses : correction du vérificateur et préservation des autres sites', async () => {
  const { body: form } = await api('POST', '/discovery-forms', { company_id: 'address-company', helper_count: 1 })
  const path = `/customer/post-payment/by-token/${form.public_token}`
  const farm = { line1: '99 nouveau site', city: 'Lévis', province: 'QC', country: 'Canada' }
  await api('POST', path + '/save', { is_new_site: 'new', farm_address: farm, shipping_same_as_farm: true, greenhouses: [{ has_louvers: false }] }, true)
  assert.equal((await api('POST', path + '/submit', undefined, true)).status, 200)
  const detail = (await api('GET', `/discovery-forms/${form.id}`)).body
  assert.equal(detail.farm_address.line1, farm.line1)
  const oldFarm = db.prepare("SELECT * FROM adresses WHERE company_id='address-company' AND line1='12 chemin de la Ferme'").get()
  assert.ok(oldFarm, 'la première ferme et les commandes liées sont conservées')
  const invalid = await api('PATCH', `/discovery-forms/${form.id}/addresses`, { shipping_address_id: 'missing' })
  assert.equal(invalid.status, 400)
  db.prepare('INSERT INTO companies (id, name) VALUES (?, ?)').run('other-address-company', 'Autre entreprise')
  db.prepare('INSERT INTO adresses (id, company_id, line1) VALUES (?, ?, ?)').run('foreign-address', 'other-address-company', 'Adresse étrangère')
  assert.equal((await api('PATCH', `/discovery-forms/${form.id}/addresses`, { farm_address_id: 'foreign-address' })).status, 400)
  const corrected = await api('PATCH', `/discovery-forms/${form.id}/addresses`, { shipping_address_id: oldFarm.id })
  assert.equal(corrected.status, 200)
  assert.equal(corrected.body.shipping_same_as_farm, false)
  assert.equal(corrected.body.shipping_address.line1, oldFarm.line1)
  const created = await api('POST', `/discovery-forms/${form.id}/create-order`)
  assert.equal(created.status, 201)
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(created.body.id)
  assert.equal(order.address_id, oldFarm.id)
  assert.equal(order.farm_address_id, detail.farm_address_id)
  const count = db.prepare('SELECT COUNT(*) AS n FROM adresses').get().n
  assert.equal((await api('POST', `/discovery-forms/${form.id}/create-order`)).status, 409)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM adresses').get().n, count)
})


test('adresses : création directe sans soumission, absence et transaction annulée', async () => {
  db.prepare('INSERT INTO companies (id, name) VALUES (?, ?)').run('draft-address-company', 'Brouillon adresses')
  const { body: form } = await api('POST', '/discovery-forms', { company_id: 'draft-address-company', helper_count: 1 })
  const farm = { line1: '80 chemin du Test', province: 'QC', country: 'Canada' }
  await api('POST', `/customer/post-payment/by-token/${form.public_token}/save`, { is_new_site: 'new', farm_address: farm, shipping_same_as_farm: true, greenhouses: [{ has_louvers: false }] }, true)
  const preview = (await api('GET', `/discovery-forms/${form.id}`)).body
  assert.equal(preview.farm_address.line1, farm.line1)
  assert.equal(preview.shipping_address.line1, farm.line1)
  db.exec("CREATE TRIGGER reject_address_order BEFORE INSERT ON orders BEGIN SELECT RAISE(ABORT, 'test rollback'); END")
  try {
    assert.equal((await api('POST', `/discovery-forms/${form.id}/create-order`)).status, 500)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM adresses WHERE company_id=?').get('draft-address-company').n, 0)
    const stored = db.prepare('SELECT * FROM customer_onboarding_responses WHERE id=?').get(form.id)
    assert.equal(stored.generated_order_id, null)
    assert.equal(stored.farm_address_id, null)
  } finally { db.exec('DROP TRIGGER reject_address_order') }
  const created = await api('POST', `/discovery-forms/${form.id}/create-order`)
  assert.equal(created.status, 201)
  const detail = (await api('GET', `/discovery-forms/${form.id}`)).body
  assert.ok(detail.farm_address_id)
  assert.equal(detail.shipping_address_id, detail.farm_address_id)
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(created.body.id)
  assert.equal(order.address_id, detail.shipping_address_id)
  db.prepare('INSERT INTO companies (id, name) VALUES (?, ?)').run('no-address-company', 'Sans adresses')
  const empty = (await api('POST', '/discovery-forms', { company_id: 'no-address-company', helper_count: 1 })).body
  await api('POST', `/customer/post-payment/by-token/${empty.public_token}/save`, { is_new_site: 'new', greenhouses: [{ has_louvers: false }] }, true)
  const emptyOrder = await api('POST', `/discovery-forms/${empty.id}/create-order`)
  assert.equal(emptyOrder.status, 201)
  assert.equal(db.prepare('SELECT address_id FROM orders WHERE id=?').get(emptyOrder.body.id).address_id, null)
})
