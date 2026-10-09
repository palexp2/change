import test from 'node:test'
import assert from 'node:assert/strict'
import { db, initTestDb } from '../test-helpers/testApp.js'
import { seedSystemAutomations } from './systemAutomations.js'
import { systemFromSoumissionItems, ensureSoumissionSystemBuilder, AUTOMATION_ID } from './soumissionSystemBuilder.js'
import { linkFactureToProject, projectIdFromStripeMetadata } from './stripeProjectLink.js'

initTestDb()
;(await import('../db/migrations/124-subscription-partnership-marks.js')).up(db)
// Colonnes perdues par le rebuild de document_items sur une DB vierge (présentes en prod).
try { db.exec('ALTER TABLE document_items ADD COLUMN group_name TEXT') } catch {}

const item = (group_name, sku, role, qty = 1, extra = {}) => ({ group_name, sku, role, qty, name_fr: extra.name_fr || sku, ...extra })

test('lignes de soumission → serres, extras par serre et du site', () => {
  const built = systemFromSoumissionItems([
    item('Serre 1', 'SVC-002', 'chief_grower'),
    item('Serre 1', 'SVC-011', null, 2),
    item('Serre 1', 'SVC-009', null),
    item('Serre 2', 'SVC-001', 'helper'),
    item('Serre 2', 'SVC-008', null),
    item('Serre 2', 'SVC-012', null),
    item('Serre 2', null, null, 1, { name_fr: 'Capteur de sol' }),
    item('Pour toute la ferme', 'SVC-003', 'mobile_controller'),
    item('Pour toute la ferme', 'SVC-016', null, 2),
    item('Pour toute la ferme', 'SVC-018', null),
    item('Pour toute la ferme', null, null, 3, { catalog_product_id: null, description_fr: 'Câble spécial' }),
  ], { lang: 'en' })
  assert.deepEqual(built.greenhouses, [{ permission_level: 'chief_grower' }, { permission_level: 'helper' }])
  const [a, b] = built.form_options.additional_equipment
  assert.equal(a.furnaces, 2)
  assert.equal(a.ventilation, true)
  assert.equal(b.valves, 1)
  assert.equal(b.advanced_temperature_sensor, true)
  assert.equal(built.form_options.lang, 'en')
  assert.equal(built.form_options.mobile_controllers, 1)
  assert.equal(built.form_options.extra_central_controllers, 1)
  assert.equal(built.form_options.sensors.solar_sensor, 2)
  assert.equal(built.form_options.sensors.soil_temperature_sensor, 1)
  assert.deepEqual(built.notes, ['Câble spécial × 3 (Pour toute la ferme)'])
})

test('un seul System builder par paiement, rien si l’automation est désactivée', () => {
  seedSystemAutomations()
  db.prepare('INSERT INTO companies (id, name) VALUES (?, ?)').run('sb-co', 'Ferme SB')
  db.prepare("INSERT INTO products (id, sku, name_fr, role, active) VALUES ('sb-chief', 'SVC-002', 'Chef de culture', 'chief_grower', 1)").run()
  db.prepare("INSERT INTO soumissions (id, company_id, language, quote_number) VALUES ('sb-s', 'sb-co', 'French', 42)").run()
  db.prepare("INSERT INTO document_items (id, document_type, document_id, catalog_product_id, qty, group_name) VALUES ('sb-i', 'soumission', 'sb-s', 'sb-chief', 1, 'Serre 1')").run()

  const session = { id: 'cs_test_sb', invoice: 'in_1', subscription: null, metadata: { erp_soumission_id: 'sb-s' } }
  const first = ensureSoumissionSystemBuilder({ soumissionId: 'sb-s', session, source: 'webhook' })
  assert.ok(first.public_token)
  assert.equal(first.soumission_id, 'sb-s')
  assert.equal(first.company_id, 'sb-co')
  assert.equal(JSON.parse(first.greenhouses_json).length, 1)
  const again = ensureSoumissionSystemBuilder({ soumissionId: 'sb-s', session, source: 'redirect' })
  assert.equal(again.id, first.id)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM customer_onboarding_responses WHERE soumission_id='sb-s'").get().n, 1)

  db.prepare('UPDATE automations SET active=0 WHERE id=?').run(AUTOMATION_ID)
  assert.equal(ensureSoumissionSystemBuilder({ soumissionId: 'sb-s', session: { ...session, id: 'cs_test_sb2' }, source: 'redirect' }), null)
  db.prepare('UPDATE automations SET active=1 WHERE id=?').run(AUTOMATION_ID)
})

test('le projet de la soumission suit le System builder et la facture Stripe', () => {
  db.prepare("INSERT INTO projects (id, name, company_id) VALUES ('sb-p', 'Projet SB', 'sb-co')").run()
  db.prepare("INSERT INTO soumissions (id, company_id, project_id, language) VALUES ('sb-s2', 'sb-co', 'sb-p', 'French')").run()
  db.prepare("INSERT INTO document_items (id, document_type, document_id, catalog_product_id, qty, group_name) VALUES ('sb-i2', 'soumission', 'sb-s2', 'sb-chief', 1, 'Serre 1')").run()
  const form = ensureSoumissionSystemBuilder({ soumissionId: 'sb-s2', session: { id: 'cs_test_sb3', metadata: { erp_soumission_id: 'sb-s2' } }, source: 'webhook' })
  assert.equal(form.project_id, 'sb-p')

  // Facture d'abonnement : les métadonnées arrivent via parent.subscription_details.
  db.prepare("INSERT INTO factures (id, invoice_id, company_id) VALUES ('sb-f', 'in_sb', 'sb-co')").run()
  const invoice = { id: 'in_sb', metadata: {}, parent: { subscription_details: { metadata: { erp_soumission_id: 'sb-s2', erp_project_id: 'sb-p' } } } }
  assert.equal(linkFactureToProject('sb-f', invoice), 'sb-p')
  assert.equal(db.prepare("SELECT project_id FROM factures WHERE id='sb-f'").get().project_id, 'sb-p')
  // Un lien déjà posé n'est jamais écrasé ; un projet inconnu retombe sur la soumission.
  assert.equal(projectIdFromStripeMetadata({ erp_project_id: 'inexistant', erp_soumission_id: 'sb-s2' }), 'sb-p')
  db.prepare("INSERT INTO projects (id, name, company_id) VALUES ('sb-p2', 'Autre', 'sb-co')").run()
  db.prepare("UPDATE factures SET project_id='sb-p2' WHERE id='sb-f'").run()
  assert.equal(linkFactureToProject('sb-f', invoice), null)
  assert.equal(db.prepare("SELECT project_id FROM factures WHERE id='sb-f'").get().project_id, 'sb-p2')
})
