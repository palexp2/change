// Déclaration Novoxpress d'un retour hors Canada : toujours 1 $ (marchandise
// retournée sans valeur commerciale, cohérent avec la facture commerciale à 0 $).

import test from 'node:test'
import assert from 'node:assert/strict'

import { returnCustomsFields } from './novoxpress.js'

test('retour US → valeur déclarée 1 $, quels que soient les articles', () => {
  const f = returnCustomsFields([{ weight: '2.3', quantity: 2 }, { weight: '1' }])
  const p = f.internationalForms.product[0]
  assert.equal(p.value, '1')
  assert.equal(p.unit_weight, '7')
  assert.equal(p.hscode, '9032.10.0030')
  assert.equal(p.country, 'CA')
  assert.equal(f.reason_for_export, 'Return')
  assert.equal(f.non_delivery, 'RTS')
})
