// Tests du watcher de constat de vente. Read-only contre la vraie DB : exerce le
// chargement de la condition configurable (trigger_config de sys_revenue_recognition)
// et le matcher — mode shipments, mode factures avec champ personnalisé (vue
// factures_v) et fallback sur config invalide. Aucune écriture, aucun POST QB.

import test from 'node:test'
import assert from 'node:assert/strict'

import db from '../db/database.js'
import { loadTriggerConfig, buildTriggerMatcher } from './revenueRecognitionWatcher.js'

test('loadTriggerConfig expose une condition éditable (colonne présente)', () => {
  const tc = loadTriggerConfig()
  assert.ok(tc.column || tc.conditions, 'la config doit porter une condition (column ou conditions)')
})

test('mode shipments (défaut) : id inexistant → null, order_id exposé sur un vrai match', () => {
  const matcher = buildTriggerMatcher({ erp_table: 'shipments', column: 'status', op: 'eq', value: 'Envoyé' })
  assert.equal(matcher.mode, 'shipments')
  assert.deepEqual(matcher.watchedTables, ['shipments'])
  assert.equal(matcher.match('shp-inexistant-test'), null)
  const sample = db.prepare("SELECT id FROM shipments WHERE status = 'Envoyé' LIMIT 1").get()
  if (!sample) return // base sans envoi « Envoyé » — skip silencieux
  const hit = matcher.match(sample.id)
  assert.ok(hit, 'l\'envoi échantillon doit matcher')
  assert.ok('order_id' in hit, 'le mode shipments doit exposer order_id')
})

test('mode factures : condition sur colonne physique, tables surveillées élargies', () => {
  const matcher = buildTriggerMatcher({ erp_table: 'factures', column: 'status', op: 'not_null' })
  assert.equal(matcher.mode, 'factures')
  assert.deepEqual(matcher.watchedTables, ['factures', 'orders', 'shipments'])
  assert.equal(matcher.match('fact-inexistante-test'), null)
})

test('mode factures : condition sur un champ personnalisé passe par la vue factures_v', () => {
  // cf_* actif sur factures — la vue factures_v le matérialise. Skip si aucun.
  const cf = db.prepare(
    "SELECT column_name FROM custom_fields WHERE erp_table = 'factures' AND deleted_at IS NULL LIMIT 1"
  ).get()
  if (!cf) return
  const matcher = buildTriggerMatcher({ erp_table: 'factures', column: cf.column_name, op: 'not_null' })
  // Une facture dont le champ custom est renseigné doit matcher (read-only).
  const sample = db.prepare(
    `SELECT id FROM factures_v WHERE ${cf.column_name} IS NOT NULL AND ${cf.column_name} != '' LIMIT 1`
  ).get()
  if (!sample) return
  const hit = matcher.match(sample.id)
  assert.ok(hit, 'la facture échantillon doit matcher via la vue')
  assert.equal(hit.id, sample.id)
})

test('config invalide → buildTriggerMatcher lève (le caller retombe sur le défaut)', () => {
  assert.throws(() => buildTriggerMatcher({ erp_table: 'factures', column: 'no such col', op: 'eq', value: 'x' }))
  assert.throws(() => buildTriggerMatcher({ erp_table: 'factures', column: 'cf_champ_inexistant_test', op: 'not_null' }))
})
