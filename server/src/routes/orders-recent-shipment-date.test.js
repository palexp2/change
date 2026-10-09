import '../test-helpers/testEnv.js'
import test from 'node:test'
import assert from 'node:assert/strict'
import { apiFetch, buildTestApp, closeServer, createTestUser, db, initTestDb, listen } from '../test-helpers/testApp.js'
import { initChangeLog } from '../db/changeLog.js'
import { regenerateView } from '../services/customFieldsView.js'
import { up } from '../db/migrations/080-orders-recent-shipment-date.js'
import bootstrapRouter from './bootstrap.js'
import { applyFilterGroup } from '../../../client/src/lib/tableFilters.js'

test('Envoyé 30 dernier jours suit la date affichée des envois', async t => {
  initTestDb()
  for (const table of ['orders', 'shipments']) db.exec(`ALTER TABLE ${table} ADD COLUMN deleted_at TEXT`)
  initChangeLog()
  db.prepare(`INSERT INTO custom_fields
    (id, erp_table, name, column_name, type, kind, result_type,
     rollup_target_table, rollup_target_fk, rollup_target_column, rollup_agg)
    VALUES ('recent-shipment-date', 'orders', 'Date de l’envoi le plus récent',
      'cf_date_de_l_envoi_le_plus_recent', 'text', 'rollup', 'date',
      'shipments', 'order_id', 'shipped_at', 'MAX')`).run()
  db.prepare("INSERT INTO orders (id,order_number,status) VALUES ('black-creek',1072,'Envoyé'), ('other',1073,'En attente')").run()
  const recent = new Date(Date.now() - 86400000).toISOString()
  const old = new Date(Date.now() - 40 * 86400000).toISOString()
  const future = new Date(Date.now() + 86400000).toISOString()
  db.prepare("INSERT INTO shipments (id,order_id,created_at) VALUES ('env-1725','black-creek',?)").run(recent)
  regenerateView('orders')
  const row = () => db.prepare("SELECT * FROM orders_v WHERE id='black-creek'").get()
  const filters = { conjunction: 'AND', rules: [
    { field: 'status', op: 'is_any_of', value: ['Envoyé', "Envoyé aujourd'hui"] },
    { field: 'cf_date_de_l_envoi_le_plus_recent', op: 'last_n_days', value: 30 },
  ] }
  assert.equal(applyFilterGroup(row(), filters), false, 'reproduit le signalement')

  const { token } = createTestUser()
  const { server, base } = await listen(buildTestApp({ '/api/bootstrap': bootstrapRouter }))
  t.after(() => closeServer(server))
  const since = new Date(Date.now() - 60_000).toISOString()
  const delta = async () => {
    const response = await apiFetch(base, token, 'GET', `/api/bootstrap/delta?since=${since}`)
    assert.equal(response.status, 200)
    const table = response.body.tables.orders
    return table ? table.upsert.map(row => Object.fromEntries(table.columns.map((c, i) => [c, row[i]]))) : []
  }
  // Les parents de rollup passent aussi par change_log_rollup (triggers chr_*).
  const clearLog = () => db.exec('DELETE FROM change_log; DELETE FROM change_log_rollup')
  const date = () => row().cf_date_de_l_envoi_le_plus_recent

  await t.test('corrige et rattrape la commande déjà en cache sans changer ses données', async () => {
    clearLog()
    assert.equal(up(db).corrected_fields, 1)
    assert.equal(date(), recent)
    assert.equal(applyFilterGroup((await delta()).find(r => r.id === 'black-creek'), filters), true)
    assert.equal(db.prepare("SELECT shipped_at FROM shipments WHERE id='env-1725'").get().shipped_at, null)
    assert.equal(applyFilterGroup({ ...row(), status: 'En attente' }, filters), false)
  })

  await t.test('exclut les dates anciennes, futures et les commandes sans envoi', async () => {
    for (const value of [old, future]) {
      clearLog()
      db.prepare("UPDATE shipments SET created_at=? WHERE id='env-1725'").run(value)
      assert.equal(applyFilterGroup((await delta())[0], filters), false)
    }
    db.prepare("UPDATE shipments SET created_at=? WHERE id='env-1725'").run(recent)
    assert.equal(applyFilterGroup({ ...row(), cf_date_de_l_envoi_le_plus_recent: null }, filters), false)
  })

  await t.test('retient le dernier envoi et actualise après suppression ou restauration', async () => {
    clearLog()
    db.prepare("INSERT INTO shipments (id,order_id,created_at) VALUES ('older','black-creek',?)").run(old)
    assert.equal((await delta())[0].cf_date_de_l_envoi_le_plus_recent, recent)
    clearLog()
    db.prepare("UPDATE shipments SET deleted_at=? WHERE id='env-1725'").run(recent)
    assert.equal((await delta())[0].cf_date_de_l_envoi_le_plus_recent, old)
    clearLog()
    db.prepare("UPDATE shipments SET deleted_at=NULL WHERE id='env-1725'").run()
    assert.equal((await delta())[0].cf_date_de_l_envoi_le_plus_recent, recent)
  })

  await t.test('un déplacement actualise les deux commandes et une suppression vide la date', async () => {
    clearLog()
    db.prepare("UPDATE shipments SET order_id='other' WHERE id='env-1725'").run()
    const rows = await delta()
    assert.deepEqual(rows.map(r => r.id).sort(), ['black-creek', 'other'])
    assert.equal(date(), old)
    clearLog()
    db.prepare("DELETE FROM shipments WHERE id='older'").run()
    assert.equal((await delta())[0].cf_date_de_l_envoi_le_plus_recent, null)
  })

  await t.test('réexécution et import identique ne créent aucun rafraîchissement', async () => {
    clearLog()
    assert.equal(up(db).corrected_fields, 0)
    db.prepare("UPDATE shipments SET created_at=created_at WHERE id='env-1725'").run()
    assert.deepEqual(await delta(), [])
  })
})
