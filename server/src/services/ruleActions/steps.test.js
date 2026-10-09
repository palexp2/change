import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderTemplate } from './steps.js'

test('jetons : champ du déclencheur et sortie d’une étape', () => {
  const row = { name: 'Serre A', total: 12 }
  const outputs = [{ nombre: 3, first: { email: 'a@b.c' } }]
  assert.equal(renderTemplate('{{name}} · {{etape1.nombre}} · {{ etape1.first.email }}', row, outputs), 'Serre A · 3 · a@b.c')
  assert.equal(renderTemplate('{{absent}}|{{etape2.x}}', row, outputs), '|')
  assert.throws(() => renderTemplate('<script>x</script>', row, outputs))
})
