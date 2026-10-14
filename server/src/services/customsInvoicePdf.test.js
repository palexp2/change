// Facture commerciale (douane) : contenu selon le cas, et valeur d'un envoi
// identique à celle de la déclaration Novoxpress. DB jetable (testEnv.js).
import '../test-helpers/testEnv.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { initSchema } from '../db/schema.js'
import db from '../db/database.js'
import { normalizeCountry, shipmentCustomsValueCad } from './novoxpress.js'
import {
  customsInvoiceModel, partyFromAddressCtx, shipmentCustomsInvoice, buildCustomsInvoicePdf, ORISHA_PARTY, COPIES,
} from './customsInvoicePdf.js'

initSchema()
// Colonnes nées de champs personnalisés en prod, absentes d'un schéma vierge.
for (const ddl of [
  'ALTER TABLE products ADD COLUMN cout_unitaire REAL',
  'ALTER TABLE shipments ADD COLUMN deleted_at TEXT',
  'ALTER TABLE shipments ADD COLUMN d_envoi TEXT',
  'ALTER TABLE order_items ADD COLUMN item_type TEXT',
  'ALTER TABLE order_items ADD COLUMN shipment_id TEXT',
  'ALTER TABLE order_items ADD COLUMN shipped_unit_cost REAL',
]) { try { db.exec(ddl) } catch { /* déjà là */ } }

const US_CLIENT = partyFromAddressCtx({
  company_name: 'Bruce Glen Farm', address_line1: '12 Farm Rd', address_city: 'Albany',
  address_province: 'NY', address_postal_code: '12207', address_country: 'United States',
  address_contact_phone: '5185550100', address_contact_email: 'farm@example.com',
})

test('pays normalisés', () => {
  for (const v of ['United States', 'USA', 'U.S.', 'États-Unis', 'us']) assert.equal(normalizeCountry(v), 'US')
  assert.equal(normalizeCountry('Canada'), 'CA')
  assert.equal(normalizeCountry(''), 'CA')
  assert.equal(normalizeCountry('Mexico'), 'MX')
})

test('client au Canada → aucun document', () => {
  const client = partyFromAddressCtx({ company_name: 'Ferme QC', address_country: 'Canada' })
  assert.equal(customsInvoiceModel({ kind: 'shipment', invoiceNumber: '1', client, valueCad: 10 }), null)
  assert.equal(customsInvoiceModel({ kind: 'return', invoiceNumber: '1', client }), null)
})

test('retour : valeur 0, ni Importer of Record ni courtier, client exportateur', () => {
  const m = customsInvoiceModel({ kind: 'return', invoiceNumber: 'RMA-1', client: US_CLIENT, valueCad: 999 })
  assert.equal(m.title, 'RETURN COMMERCIAL INVOICE')
  assert.equal(m.line.unitPrice, 0)
  assert.equal(m.line.total, 0)
  assert.equal(m.importerOfRecord, null)
  assert.equal(m.broker, null)
  assert.equal(m.exporter.name, 'Bruce Glen Farm')
  assert.equal(m.consignee, ORISHA_PARTY)
  assert.equal(m.line.origin, 'CA')
  assert.match(m.currencyNote, /customs purposes only/)
  assert.match(m.declaration, /Return of goods/)
})

test('envoi de remplacement : titre retour, déclaration réparation', () => {
  const m = customsInvoiceModel({ kind: 'shipment', isReplacement: true, invoiceNumber: '1', client: US_CLIENT, valueCad: 5 })
  assert.equal(m.title, 'RETURN COMMERCIAL INVOICE')
  assert.match(m.declaration, /after reparation/)
  assert.ok(m.importerOfRecord && m.broker)
})

test('envoi US : blocs Importer of Record et courtier, valeur = déclaration Novoxpress', async () => {
  db.prepare("INSERT INTO companies (id, name) VALUES ('co-us', 'Bruce Glen Farm')").run()
  db.prepare(`INSERT INTO adresses (id, company_id, line1, city, province, postal_code, country)
    VALUES ('ad-us', 'co-us', '12 Farm Rd', 'Albany', 'NY', '12207', 'États-Unis')`).run()
  db.prepare("INSERT INTO products (id, name_fr, unit_cost) VALUES ('p1', 'Contrôleur', 412.3)").run()
  db.prepare("INSERT INTO orders (id, order_number, company_id) VALUES ('o-us', 'T-1', 'co-us')").run()
  db.prepare("INSERT INTO order_items (id, order_id, product_id, qty, item_type) VALUES ('oi1', 'o-us', 'p1', 2, 'Facturable')").run()
  db.prepare("INSERT INTO shipments (id, order_id, address_id) VALUES ('s-us', 'o-us', 'ad-us')").run()

  const value = shipmentCustomsValueCad('s-us')
  assert.equal(value, Math.ceil(2 * 412.3))
  const m = shipmentCustomsInvoice('s-us')
  assert.equal(m.title, 'COMMERCIAL INVOICE')
  assert.equal(m.line.total, value)
  assert.equal(m.line.unitPrice, value)
  assert.equal(m.importerOfRecord, ORISHA_PARTY)
  assert.match(m.broker, /Axxess International/)
  assert.equal(m.exporter, ORISHA_PARTY)
  assert.equal(m.consignee.country, 'US')
  assert.equal(m.line.origin, 'CA')
  assert.equal(m.invoiceNumber, 's-us')

  const pdf = await buildCustomsInvoicePdf(m)
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF')
  assert.equal((pdf.toString('latin1').match(/\/Type \/Page\b/g) || []).length, COPIES)
})

test('envoi canadien → null', () => {
  db.prepare("INSERT INTO adresses (id, company_id, line1, city, country) VALUES ('ad-ca', 'co-us', '1 rue X', 'Québec', 'Canada')").run()
  db.prepare("INSERT INTO shipments (id, order_id, address_id) VALUES ('s-ca', 'o-us', 'ad-ca')").run()
  assert.equal(shipmentCustomsInvoice('s-ca'), null)
})
