import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTestApp, listen, closeServer, createTestUser, db } from '../test-helpers/testApp.js'
import productsRouter from './products.js'
import { createPurchasesFromPo } from '../services/productPurchase.js'

const { base, server } = await listen(buildTestApp({ '/api/products': productsRouter }))
after(() => closeServer(server))
const { token } = createTestUser()
const realFetch = globalThis.fetch
db.exec(`ALTER TABLE purchases ADD COLUMN nom_de_la_piece TEXT;
  ALTER TABLE purchases ADD COLUMN quantite_commande REAL;
  ALTER TABLE purchases ADD COLUMN date_de_commande TEXT;
  ALTER TABLE purchases ADD COLUMN notes_2 TEXT;
  ALTER TABLE purchases ADD COLUMN fournisseur TEXT;`)
// Colonnes du miroir Airtable lues par le calcul FIFO (services/fifoCost.js).
for (const column of ['at_id', 'cf_date_de_reception_complete', 'override_prix_unitaire_paye_cad', 'prix_unitaire_facture_cad', 'prix_unitaire_cad']) {
  try { db.exec(`ALTER TABLE purchases ADD COLUMN ${column} TEXT`) } catch {}
}
for (const column of ['deleted_at', 'manufacturier']) { try { db.exec(`ALTER TABLE products ADD COLUMN ${column} TEXT`) } catch {} }
db.prepare("INSERT INTO connector_oauth (id,connector,account_key,access_token) VALUES ('at','airtable','test','test-token')").run()
db.prepare("INSERT INTO airtable_module_config (module,base_id,table_id,field_map) VALUES ('achats','test-base','test-achats','{}')").run()
for (const [column, field] of Object.entries({ nom_de_la_piece: 'Nom de la pièce', quantite_commande: 'Quantité commandé', date_de_commande: 'Date de commande', notes_2: 'Notes', fournisseur: 'Fournisseur' })) {
  db.prepare(`INSERT INTO airtable_field_mappings (id,module,erp_table,column_name,airtable_field_name)
    VALUES (?,'achats','purchases',?,?)`).run(column, column, field)
}
db.prepare("INSERT INTO companies (id,name) VALUES ('supplier-company','Principal')").run()
db.prepare(`INSERT INTO products (id,name_fr,airtable_id,supplier_company_id,order_qty)
  VALUES ('piece','Pièce','recProduct00000001','supplier-company',5)`).run()
db.prepare(`INSERT INTO products (id,name_fr,airtable_id) VALUES ('other','Autre','recProduct00000002')`).run()
db.prepare(`INSERT INTO airtable_vendor_links (airtable_id,name,qb_vendor_id)
  VALUES ('recVendor000000001','Principal','qb-1'), ('recVendor000000002','Dernier','qb-2')`).run()

async function request(method, path, body, authenticated = true) {
  const response = await realFetch(`${base}/api/products/${path}`, {
    method, headers: { ...(authenticated ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

let airtableSequence = 0
function mockAirtable(t, fail = false) {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(String(url), 'https://api.airtable.com/v0/test-base/test-achats')
    assert.equal(options.method, 'POST')
    const fields = JSON.parse(options.body).fields
    calls.push(fields)
    if (fail) return new Response(JSON.stringify({ error: { message: 'Test indisponible' } }), { status: 422 })
    return new Response(JSON.stringify({ id: `recPurchase${String(++airtableSequence).padStart(6, '0')}`, fields }))
  })
  return calls
}

test('création liée au produit : quantité, fournisseur, note et date transmis à Airtable', async t => {
  const calls = mockAirtable(t)
  const result = await request('POST', 'piece/purchases', { quantity: 2.5, supplier_id: 'recVendor000000001', notes: ' Livraison groupée ' })
  assert.equal(result.status, 201, JSON.stringify(result.body))
  assert.equal(result.body.airtable.status, 'success')
  assert.equal(result.body.supplier_company_id, 'supplier-company')
  assert.equal(result.body.notes_2, 'Livraison groupée')
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    'Nom de la pièce': ['recProduct00000001'], 'Quantité commandé': 2.5,
    Fournisseur: ['recVendor000000001'], Notes: 'Livraison groupée', 'Date de commande': new Date().toISOString().slice(0, 10),
  })
  const list = await request('GET', 'piece/purchases')
  assert.ok(list.body.data.some(p => p.id === result.body.id))
  const retry = await request('POST', `piece/purchases/${result.body.id}/sync`, {})
  assert.equal(retry.body.airtable.status, 'success')
  assert.equal(calls.length, 1)
  assert.equal((await request('POST', `other/purchases/${result.body.id}/sync`, {})).status, 404)
})

test('fournisseur principal prioritaire, sinon dernier achat et fournisseur texte', async () => {
  db.prepare(`INSERT INTO purchases (id,nom_de_la_piece,date_de_commande,supplier_vendor_name,supplier_qb_vendor_id)
    VALUES ('previous','["recProduct00000001"]','2099-01-01','Dernier','qb-2')`).run()
  assert.equal((await request('GET', 'piece/purchases/prefill')).body.supplier_id, 'recVendor000000001')
  db.prepare("UPDATE products SET supplier_company_id=NULL WHERE id='piece'").run()
  assert.equal((await request('GET', 'piece/purchases/prefill')).body.supplier_id, 'recVendor000000002')
  db.prepare("UPDATE products SET supplier=' Principal ' WHERE id='piece'").run()
  assert.equal((await request('GET', 'piece/purchases/prefill')).body.supplier_id, 'recVendor000000001')
  assert.equal((await request('GET', 'other/purchases/prefill')).body.supplier_id, '')
})

test('validation avant insertion et authentification obligatoire', async () => {
  const count = () => db.prepare('SELECT count(*) AS n FROM purchases').get().n
  const before = count()
  for (const quantity of [0, -1, '', null, 'abc']) {
    assert.equal((await request('POST', 'piece/purchases', { quantity, supplier_id: 'recVendor000000001' })).status, 400)
  }
  assert.equal((await request('POST', 'piece/purchases', { quantity: 1, supplier_id: 'inconnu' })).status, 400)
  assert.equal((await request('POST', 'missing/purchases', { quantity: 1 })).status, 404)
  assert.equal((await request('POST', 'piece/purchases', {}, false)).status, 401)
  db.prepare("UPDATE products SET airtable_id=NULL WHERE id='other'").run()
  assert.equal((await request('POST', 'other/purchases', { quantity: 1, supplier_id: 'recVendor000000001' })).status, 400)
  db.prepare("UPDATE airtable_field_mappings SET import_disabled=1 WHERE column_name='notes_2'").run()
  assert.equal((await request('POST', 'piece/purchases', { quantity: 1, supplier_id: 'recVendor000000001' })).status, 400)
  db.prepare("UPDATE airtable_field_mappings SET import_disabled=0 WHERE column_name='notes_2'").run()
  assert.equal(count(), before)
})

test('échec Airtable visible et tracé ; relance sur le même achat local', async t => {
  const failedCalls = mockAirtable(t, true)
  const result = await request('POST', 'piece/purchases', { quantity: 3, supplier_id: 'recVendor000000002', notes: 'À conserver' })
  assert.equal(result.status, 201)
  assert.equal(result.body.airtable.status, 'error')
  assert.equal(failedCalls.length, 1)
  assert.equal(result.body.notes_2, 'À conserver')
  assert.ok(db.prepare("SELECT id FROM sync_log WHERE module='achats' AND status='error' AND error_message LIKE ?").get(`%${result.body.id}%`))
  const count = db.prepare('SELECT count(*) AS n FROM purchases').get().n
  t.mock.restoreAll()
  const successCalls = mockAirtable(t)
  assert.equal((await request('POST', `piece/purchases/${result.body.id}/sync`, {})).body.airtable.status, 'success')
  assert.equal(successCalls.length, 1)
  assert.equal(db.prepare('SELECT count(*) AS n FROM purchases').get().n, count)
})

test('envoi d’un PO : un achat par ligne liée au catalogue, pas de doublon au renvoi', async t => {
  const calls = mockAirtable(t)
  const po = { po_number: '4242', date: '2026-09-20', items: [
    { product_id: 'piece', product: 'Pièce', qty: 4 },
    { product_id: null, product: ' pièce ', qty: 2 },
    { product_id: 'other', product: 'Autre', qty: 1 },
    { product_id: null, product: 'Inconnue', qty: 1 },
    { product_id: 'piece', product: 'Pièce', qty: 0 },
  ] }
  const result = await createPurchasesFromPo(po, 'piece')
  assert.equal(result.purchase_ids.length, 2, JSON.stringify(result))
  assert.deepEqual(result.purchases_skipped, { no_product: 1, zero_qty: 1, already_created: 0, not_linked: 1, no_supplier: 0, error: 0 })
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0], {
    'Nom de la pièce': ['recProduct00000001'], 'Quantité commandé': 4,
    Fournisseur: ['recVendor000000001'], Notes: 'PO 4242', 'Date de commande': '2026-09-20',
  })
  const again = await createPurchasesFromPo({ ...po, items: po.items.slice(0, 1) }, 'piece')
  assert.equal(again.purchase_ids.length, 0)
  assert.equal(again.purchases_skipped.already_created, 1)
})
