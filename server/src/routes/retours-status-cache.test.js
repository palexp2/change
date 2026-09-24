import '../test-helpers/testEnv.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { apiFetch, buildTestApp, closeServer, createTestUser, db, initTestDb, listen } from '../test-helpers/testApp.js'
import { initChangeLog } from '../db/changeLog.js'
import { up as configureStatus } from '../db/migrations/069-retours-statut-en-transit.js'
import { up as refreshReturnStatus } from '../db/migrations/079-retours-status-cache.js'
import bootstrapRouter from './bootstrap.js'

test('les deltas des retours suivent les réceptions sans modification du parent', async t => {
  initTestDb()
  db.exec('ALTER TABLE returns ADD COLUMN deleted_at TEXT')
  initChangeLog()
  db.prepare(`INSERT INTO custom_fields (id, erp_table, name, column_name, type, kind)
    VALUES ('test-return-status', 'returns', 'Statut', 'cf_statut', 'text', 'formula')`).run()
  configureStatus(db)
  db.prepare("INSERT INTO returns (id) VALUES ('rma-desert'), ('rma-other')").run()
  db.prepare("INSERT INTO return_items (id, return_id) VALUES ('item-desert', 'rma-desert')").run()

  const { token } = createTestUser()
  const { server, base } = await listen(buildTestApp({ '/api/bootstrap': bootstrapRouter }))
  t.after(() => closeServer(server))

  // Une tranche isolée évite de confondre un changement d'article avec une
  // écriture précédente sur le retour. Toutes les données sont dans la DB test.
  const since = new Date(Date.now() - 60_000).toISOString()
  const delta = async () => {
    const response = await apiFetch(base, token, 'GET', `/api/bootstrap/delta?since=${since}`)
    assert.equal(response.status, 200)
    const table = response.body.tables.returns
    return table ? table.upsert.map(row => Object.fromEntries(table.columns.map((c, i) => [c, row[i]]))) : []
  }
  const status = rows => Object.fromEntries(rows.map(row => [row.id, row.cf_statut]))
  const clearLog = () => db.prepare('DELETE FROM change_log').run()

  await t.test('reproduit le statut figé avant la correction', async () => {
    clearLog()
    db.prepare("UPDATE return_items SET received_at='2026-09-21' WHERE id='item-desert'").run()
    assert.equal(db.prepare("SELECT cf_statut FROM returns_v WHERE id='rma-desert'").get().cf_statut, 'Analyse complétée')
    assert.deepEqual(await delta(), [])
  })

  await t.test('rattrape les retours déjà en cache', async () => {
    refreshReturnStatus(db)
    assert.deepEqual(status(await delta()), { 'rma-desert': 'Analyse complétée', 'rma-other': 'Aucun item à retourner' })
  })

  await t.test('annulation puis réception : le delta transporte le nouveau statut', async () => {
    clearLog()
    db.prepare("UPDATE return_items SET received_at=NULL WHERE id='item-desert'").run()
    assert.deepEqual(status(await delta()), { 'rma-desert': 'En transit' })
    clearLog()
    db.prepare("UPDATE return_items SET received_at='2026-09-21' WHERE id='item-desert'").run()
    assert.deepEqual(status(await delta()), { 'rma-desert': 'Analyse complétée' })
  })

  await t.test('un import identique ne rafraîchit pas inutilement le retour', async () => {
    clearLog()
    db.prepare("UPDATE return_items SET received_at=received_at WHERE id='item-desert'").run()
    assert.deepEqual(await delta(), [])
  })

  await t.test('un déplacement rafraîchit les deux retours', async () => {
    clearLog()
    db.prepare("UPDATE return_items SET return_id='rma-other' WHERE id='item-desert'").run()
    assert.deepEqual(status(await delta()), { 'rma-desert': 'Aucun item à retourner', 'rma-other': 'Analyse complétée' })
  })

  await t.test('ajout et suppression actualisent le nombre d’articles à recevoir', async () => {
    clearLog()
    db.prepare("INSERT INTO return_items (id, return_id) VALUES ('item-new', 'rma-other')").run()
    assert.deepEqual(status(await delta()), { 'rma-other': 'En transit' })
    clearLog()
    db.prepare("DELETE FROM return_items WHERE id='item-new'").run()
    assert.deepEqual(status(await delta()), { 'rma-other': 'Analyse complétée' })
  })
})
