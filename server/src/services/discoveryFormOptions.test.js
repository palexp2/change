import test from 'node:test'
import assert from 'node:assert/strict'
import { greenhouseLimits } from './discoveryFormOptions.js'

const withHeating = n => ({ additional_equipment: [{ furnaces: n }] })

test('permission Chauffage : jusqu’à 4 fournaises, 2 au Helper', () => {
  assert.equal(greenhouseLimits(withHeating(1), 0, 'helper').furnaces, 2)
  assert.equal(greenhouseLimits(withHeating(1), 0, 'chief_grower').furnaces, 4)
  assert.equal(greenhouseLimits(withHeating(0), 0, 'helper').furnaces, 0)
  assert.equal(greenhouseLimits(withHeating(0), 0, 'chief_grower').furnaces, 2)
  assert.equal(greenhouseLimits(withHeating(2), 0, 'helper').furnaces, 4)
})

const withIrrigation = n => ({ additional_equipment: [{ valves: n }] })

test('permission Irrigation : jusqu’à 8 valves, 4 au Helper', () => {
  assert.equal(greenhouseLimits(withIrrigation(1), 0, 'helper').valves, 4)
  assert.equal(greenhouseLimits(withIrrigation(1), 0, 'chief_grower').valves, 8)
  assert.equal(greenhouseLimits(withIrrigation(0), 0, 'helper').valves, 0)
  assert.equal(greenhouseLimits(withIrrigation(0), 0, 'chief_grower').valves, 4)
  assert.equal(greenhouseLimits(withIrrigation(2), 0, 'helper').valves, 8)
})

test('permission Ventilation : louvres et ventilateurs de 2 à 4', () => {
  assert.equal(greenhouseLimits({ additional_equipment: [{}] }, 0, 'chief_grower').louvers, 2)
  assert.equal(greenhouseLimits({ additional_equipment: [{}] }, 0, 'chief_grower').fans, 2)
  assert.equal(greenhouseLimits({ additional_equipment: [{ ventilation: true }] }, 0, 'chief_grower').louvers, 4)
  assert.equal(greenhouseLimits({ additional_equipment: [{ ventilation: true }] }, 0, 'chief_grower').fans, 4)
})
