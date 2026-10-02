import test from 'node:test'
import assert from 'node:assert/strict'
import { db, initTestDb } from '../test-helpers/testApp.js'
import { autoLinkStripeFacture } from './stripeProjectLink.js'

initTestDb()

const facture = (id, extra = {}) => db.prepare(`
  INSERT INTO factures (id, invoice_id, company_id, project_id, subscription_id, customer_email)
  VALUES (@id, @inv, @company_id, @project_id, @subscription_id, @customer_email)
`).run({ id, inv: `in_${id}`, company_id: null, project_id: null, subscription_id: null, customer_email: null, ...extra })
const row = id => db.prepare('SELECT company_id, project_id FROM factures WHERE id=?').get(id)

test('facture Stripe : entreprise par courriel du contact, puis son seul projet', () => {
  db.prepare("INSERT INTO companies (id, name) VALUES ('al-co', 'Ferme Alpha')").run()
  db.prepare("INSERT INTO contacts (id, first_name, last_name, email, company_id) VALUES ('al-ct', 'Jo', 'A', 'Jo@Alpha.ca', 'al-co')").run()
  db.prepare("INSERT INTO projects (id, name, company_id) VALUES ('al-p', 'Serre', 'al-co')").run()
  facture('al-f', { customer_email: 'jo@alpha.ca ' })
  const linked = autoLinkStripeFacture('al-f', { metadata: {} })
  assert.equal(linked.company.id, 'al-co')
  assert.equal(linked.project.id, 'al-p')
  assert.deepEqual(row('al-f'), { company_id: 'al-co', project_id: 'al-p' })
})

test('facture Stripe : plusieurs projets → projet des autres factures de l’abonnement, sinon vide', () => {
  db.prepare("INSERT INTO companies (id, name) VALUES ('be-co', 'Ferme Beta')").run()
  db.prepare("INSERT INTO projects (id, name, company_id) VALUES ('be-p1', 'A', 'be-co'), ('be-p2', 'B', 'be-co')").run()
  db.prepare("INSERT INTO subscriptions (id, company_id, stripe_id) VALUES ('be-s', 'be-co', 'sub_be')").run()
  facture('be-old', { company_id: 'be-co', project_id: 'be-p2', subscription_id: 'be-s' })
  facture('be-new', { subscription_id: 'be-s' })
  autoLinkStripeFacture('be-new', { metadata: {}, customer_name: 'Ferme Beta' })
  assert.deepEqual(row('be-new'), { company_id: 'be-co', project_id: 'be-p2' })
  facture('be-one', { company_id: 'be-co' })
  assert.deepEqual(autoLinkStripeFacture('be-one', { metadata: {} }), {})
  assert.equal(row('be-one').project_id, null)
})

test('facture Stripe : jamais d’écrasement ni de lien sur un candidat ambigu', () => {
  db.prepare("INSERT INTO companies (id, name) VALUES ('ga-c1', 'Gamma'), ('ga-c2', 'Gamma')").run()
  facture('ga-f', { customer_email: 'nobody@x.io' })
  assert.deepEqual(autoLinkStripeFacture('ga-f', { metadata: {}, customer_name: 'gamma' }), {})
  facture('ga-g', { company_id: 'ga-c2', project_id: 'be-p1' })
  autoLinkStripeFacture('ga-g', { metadata: {}, customer_email: 'jo@alpha.ca' })
  assert.deepEqual(row('ga-g'), { company_id: 'ga-c2', project_id: 'be-p1' })
})
