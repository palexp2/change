import { test } from 'node:test'
import assert from 'node:assert/strict'
import { monthEndEntriesDone } from './monthEndTask.js'

test('un mois sans aucune provision publiée n\'est pas terminé', () => {
  assert.equal(monthEndEntriesDone('2099-01'), false)
})
