// Origine d'une écriture : explicite (withOrigin), utilisateur de la requête,
// ou rien.
import { tmpdir } from 'os'
import { join } from 'path'
import test from 'node:test'
import assert from 'node:assert/strict'

process.env.DATABASE_PATH = join(tmpdir(), `erp-test-write-origin-${process.pid}.db`)
const db = (await import('../db/database.js')).default
const { withOrigin, takeWriteOrigin, installWriteOriginTriggers } = await import('./writeOrigin.js')
const { requestContext } = await import('../utils/requestContext.js')

db.exec(`DROP TABLE IF EXISTS returns; CREATE TABLE returns (id TEXT PRIMARY KEY, status TEXT)`)
installWriteOriginTriggers(['returns'])

test('withOrigin attribue l’écriture à l’automatisation, même après un await', async () => {
  await withOrigin('sys_x', async () => {
    await new Promise(r => setTimeout(r, 2))
    db.prepare(`INSERT INTO returns (id, status) VALUES ('r1', 'a')`).run()
  })
  assert.deepEqual({ ...takeWriteOrigin('returns', 'r1'), at: 0 }, { source: 'sys_x', user: null, at: 0 })
  assert.equal(takeWriteOrigin('returns', 'r1'), null) // consommée
})

test('requête authentifiée → utilisateur', () => {
  requestContext.run({ user: { id: 'u1' } }, () => db.prepare(`UPDATE returns SET status = 'b' WHERE id = 'r1'`).run())
  const o = takeWriteOrigin('returns', 'r1')
  assert.equal(o.user, 'u1')
  assert.equal(o.source, null)
})

test('sans contexte → aucune origine, et la dernière écriture efface la note', () => {
  withOrigin('sys_x', () => db.prepare(`UPDATE returns SET status = 'c' WHERE id = 'r1'`).run())
  db.prepare(`UPDATE returns SET status = 'd' WHERE id = 'r1'`).run()
  assert.equal(takeWriteOrigin('returns', 'r1'), null)
})
