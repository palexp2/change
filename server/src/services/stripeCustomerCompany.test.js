import '../test-helpers/testEnv.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { db, initTestDb } from '../test-helpers/testApp.js'
import { linkStripeCustomerByEmail, companyIdForStripeCustomer } from './stripeCustomerCompany.js'

test('client Stripe du site web : rattaché par courriel, entreprise créée au besoin', () => {
  initTestDb()
  for (const [t, c] of [['companies', 'stripe_customer_id'], ['companies', 'deleted_at'], ['contacts', 'deleted_at']]) {
    try { db.exec(`ALTER TABLE ${t} ADD COLUMN ${c} TEXT`) } catch {}
  }
  db.prepare("INSERT INTO companies (id, name, stripe_customer_id) VALUES ('co1', 'Ferme', NULL), ('co2', 'Serre', 'cus_old')").run()
  db.prepare(`INSERT INTO contacts (id, first_name, last_name, email, company_id) VALUES
    ('c1', 'Ann', 'A', 'Ann@ferme.ca', 'co1'),
    ('c2', 'Bob', 'B', 'bob@serre.ca', 'co2'),
    ('c3', 'Cy', 'Seul', 'cy@x.ca', NULL)`).run()

  assert.equal(linkStripeCustomerByEmail({ id: 'cus_1', email: ' ann@FERME.ca' }).companyId, 'co1')
  assert.equal(companyIdForStripeCustomer('cus_1'), 'co1')

  // Entreprise déjà liée à un autre client Stripe → client secondaire.
  assert.equal(linkStripeCustomerByEmail({ id: 'cus_2', email: 'bob@serre.ca' }).companyId, 'co2')
  assert.equal(companyIdForStripeCustomer('cus_2'), 'co2')
  assert.equal(db.prepare("SELECT stripe_customer_id FROM companies WHERE id='co2'").get().stripe_customer_id, 'cus_old')

  // Contact sans entreprise → entreprise créée et liée.
  const r = linkStripeCustomerByEmail({ id: 'cus_3', email: 'cy@x.ca', name: 'Ferme Cy', currency: 'cad' })
  assert.equal(r.created, true)
  assert.equal(db.prepare('SELECT name FROM companies WHERE id=?').get(r.companyId).name, 'Ferme Cy')
  assert.equal(db.prepare("SELECT company_id FROM contacts WHERE id='c3'").get().company_id, r.companyId)
  assert.equal(companyIdForStripeCustomer('cus_3'), r.companyId)

  // Courriel inconnu → contact + entreprise créés.
  const n = linkStripeCustomerByEmail({ id: 'cus_4', email: 'dan@neuf.ca', name: 'Dan Le Neuf' })
  assert.equal(n.created, true)
  const nc = db.prepare("SELECT first_name, last_name, company_id FROM contacts WHERE email='dan@neuf.ca'").get()
  assert.deepEqual({ ...nc }, { first_name: 'Dan', last_name: 'Le Neuf', company_id: n.companyId })

  // Contact lié à deux entreprises → l'entreprise principale.
  db.prepare("INSERT INTO companies (id, name) VALUES ('co3', 'Autre')").run()
  db.prepare("INSERT INTO contact_companies (id, contact_id, company_id, is_primary) VALUES ('l1', 'c1', 'co3', 0)").run()
  assert.equal(linkStripeCustomerByEmail({ id: 'cus_5', email: 'ann@ferme.ca' }).companyId, 'co1')

  assert.equal(linkStripeCustomerByEmail({ id: 'cus_6' }), null)
})
