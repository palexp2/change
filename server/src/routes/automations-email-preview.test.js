// Tests de la route GET /api/automations/:id/email-preview, ciblés sur la
// gestion d'une config corrompue (action_config JSON invalide).
//
// DB SQLite jetable (test-helpers/testApp.js) — pas la prod. On insère
// directement des automations field_rule/email en DB temp pour reproduire le
// cas "action_config non parsable" qui ne peut PAS être créé via l'API (la
// route de création fait JSON.stringify avant insert).
// IMPORT EN PREMIER : initialise le schéma avant que automations.js (et sa
// chaîne de services qui prepare() au top-level) ne soit évalué. Ne pas
// réordonner sous l'import de automations.js.
import '../test-helpers/initSchemaPreload.js'
import automationsRouter from './automations.js'

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import {
  buildTestApp, listen, makeToken, db, apiFetch, closeServer,
} from '../test-helpers/testApp.js'

let base, server, adminToken
const createdIds = []

before(async () => {
  const app = buildTestApp({ '/api/automations': automationsRouter })
  ;({ server, base } = await listen(app))
  adminToken = makeToken({ role: 'admin' }).token
})

after(async () => {
  // Nettoyage : retirer les automations insérées par ce test de la DB temp.
  for (const id of createdIds) {
    try { db.prepare('DELETE FROM automations WHERE id = ?').run(id) } catch {}
  }
  await closeServer(server)
})

function insertAutomation({ action_config }) {
  const id = `e2e-prev-${randomUUID()}`
  createdIds.push(id)
  // INSERT direct (et non via l'API) : c'est le seul moyen de stocker un
  // action_config littéralement non-JSON, ce que la route POST interdit.
  db.prepare(`
    INSERT INTO automations
      (id, name, kind, trigger_type, trigger_config, action_type, action_config, active)
    VALUES (?, ?, 'field_rule', 'field_change', ?, 'email', ?, 1)
  `).run(
    id,
    `E2E preview ${id}`,
    JSON.stringify({ erp_table: 'companies', column: 'name', op: 'not_null' }),
    action_config,
  )
  return id
}

test('email-preview : action_config corrompu → 400 + invalid_config', async () => {
  const id = insertAutomation({ action_config: '{ ceci nest pas du JSON' })
  const { status, body } = await apiFetch(base, adminToken, 'GET', `/api/automations/${id}/email-preview`)
  assert.equal(status, 400, `attendu 400, reçu ${status} (${JSON.stringify(body)})`)
  assert.equal(body.available, false)
  assert.equal(body.invalid_config, true)
  assert.match(body.error, /corrompue|JSON/i)
})

test('email-preview : action_config valide → pas de 400 parse (no regression)', async () => {
  const id = insertAutomation({ action_config: JSON.stringify({ subject: 'Bonjour', bodyHtml: '<p>Hi</p>' }) })
  const { status, body } = await apiFetch(base, adminToken, 'GET', `/api/automations/${id}/email-preview`)
  // DB temp vide → aucun candidat companies → branche "available:true, sample:false".
  assert.equal(status, 200, `attendu 200, reçu ${status} (${JSON.stringify(body)})`)
  assert.equal(body.available, true)
  assert.notEqual(body.invalid_config, true)
})
