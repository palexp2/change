// Le ménage : deux règles qui posent la même question sont un doublon, quel
// que soit leur nom — c'est justement là qu'ils se cachent.
import { describe, it, before, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { initTestDb, db } from '../../test-helpers/testApp.js'
import { housekeeping, archiveRules, restoreRules } from './housekeeping.js'
import { invalidateBankRulesCache } from './store.js'

const rule = (id, o = {}) => {
  db.prepare(`INSERT INTO bank_rules (id, name, direction, label_pattern, conditions, created_at)
    VALUES (?,?,?,?,?,?)`)
    .run(id, o.name || id, o.direction || 'sortie', o.label_pattern || null, o.conditions || null, o.created_at || '2026-01-01')
}

describe('housekeeping', () => {
  before(() => { initTestDb() })
  beforeEach(() => { db.exec('DELETE FROM bank_rules'); db.exec('DELETE FROM bank_transactions'); invalidateBankRulesCache() })

  const lot = (data, key) => data.lots.find((l) => l.key === key)

  it('reconnaît deux règles de noms différents qui posent la même condition', () => {
    const c = JSON.stringify({ mode: 'all', terms: [{ field: 'label', op: 'contains', value: 'LC2' }] })
    rule('a', { name: 'MARGE CRÉDIT DESJ.', conditions: c, created_at: '2026-01-01' })
    rule('b', { name: 'Întérêts marge Desjardins', conditions: c, created_at: '2026-02-01' })
    const dup = lot(housekeeping(), 'duplicates')
    // La plus ancienne reste, la seconde est à ranger.
    assert.equal(dup.items.length, 1)
    assert.equal(dup.items[0].id, 'b')
    assert.match(dup.items[0].why, /MARGE CRÉDIT DESJ/)
  })

  it('range à part celles dont les conditions n\'ont pas survécu à l\'export', () => {
    rule('x', { name: 'FRAIS BNC 1', label_pattern: 'FORFAIT"},{"ruleType":1,"value":"PACKAGE FEE"}' })
    const data = housekeeping()
    assert.equal(lot(data, 'unreadable').items.length, 1)
    assert.equal(lot(data, 'duplicates'), undefined)
  })

  it('signale celles dont le libellé n\'apparaît nulle part', () => {
    rule('y', { name: 'PRIMACO', label_pattern: 'primaco' })
    assert.equal(lot(housekeeping(), 'no_trace').items[0].name, 'PRIMACO')
  })

  it('ranger désactive, ne supprime pas — et se défait', () => {
    rule('z', { name: 'Z', label_pattern: 'zzz zzz' })
    archiveRules(['z'])
    assert.equal(db.prepare('SELECT active FROM bank_rules WHERE id=?').get('z').active, 0)
    assert.ok(db.prepare('SELECT deleted_at FROM bank_rules WHERE id=?').get('z').deleted_at == null)
    restoreRules(['z'])
    assert.equal(db.prepare('SELECT active FROM bank_rules WHERE id=?').get('z').active, 1)
  })
})
