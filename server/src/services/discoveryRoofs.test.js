import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discoveryAnswerErrors } from './discoveryAnswerValidation.js'
import { calculateDiscoveryEquipment } from './discoveryEquipment.js'
import { roofInverterSupplyKey } from '../../../client/src/lib/discoveryRoofs.js'

const base = { permission_level: 'chief_grower', has_louvers: false, has_roof_vents: true, num_roof_vents: 1, roof_motor_voltage: '24_dc', has_roof_inverter: false }
const errors = (patch, roofs = 1) => discoveryAnswerErrors({ form_options: { additional_equipment: [{ roofs }] }, greenhouses: [{ ...base, ...patch }] })
test('admissibilité : 24 V DC et Ridder RW240 exact seulement', () => {
  for (const [voltage, ridder, expected] of [['24_dc', null, 'possible'], ['110', true, 'customer'], ['240', true, 'possible'], ['240', false, 'customer']]) {
    const g = { ...base, roof_motor_voltage: voltage, roof_motor_ridder_rw240: ridder }
    assert.equal(roofInverterSupplyKey(g), `roofs.supply_${expected}`)
    assert.deepEqual(errors(g), [])
  }
  assert.equal(roofInverterSupplyKey({ ...base, roof_motor_voltage: '240' }), '')
  assert.ok(errors({ roof_motor_voltage: '240' }).length)
})
test('inverseur existant : les deux modèles et la marque/modèle libre', () => {
  for (const type of ['harnois_8ze141l', 'vre_mc21', 'unknown']) assert.deepEqual(errors({ has_roof_inverter: true, roof_inverter_type: type }), [])
  assert.ok(errors({ has_roof_inverter: true, roof_inverter_type: 'other', roof_inverter_brand: '  ' }).length)
  assert.deepEqual(errors({ has_roof_inverter: true, roof_inverter_type: 'other', roof_inverter_brand: 'Marque', roof_inverter_model: 'Modèle' }), [])
  assert.ok(errors({ has_roof_inverter: null }).length)
  // Avec un inverseur, la tension n'est pas demandée.
  assert.deepEqual(errors({ has_roof_inverter: true, roof_inverter_type: 'vre_mc21', roof_motor_voltage: '' }), [])
  assert.ok(errors({ roof_motor_voltage: '' }).length)
  // « Je ne sais pas » : rien d'autre à demander.
  assert.deepEqual(errors({ has_roof_inverter: 'unknown', roof_motor_voltage: '' }), [])
})
test('aucun toit et Helper : aucune précision exigée', () => {
  assert.deepEqual(errors({ has_roof_vents: false, num_roof_vents: 0, roof_motor_voltage: '' }, 0), [])
  assert.deepEqual(errors({ permission_level: 'helper', roof_motor_voltage: '' }, 0), [])
  // Helper avec une permission Toits ouvrants : la motorisation est demandée.
  assert.ok(errors({ permission_level: 'helper', roof_motor_voltage: '' }).length)
})
test('permissions : relèvent les plafonds sans rien fournir ni exiger', () => {
  const opts = { additional_equipment: [{ furnaces: 1, valves: 1, rollups: 0, roofs: 0 }] }
  // Helper sans réponse : aucun appareil ajouté d'office.
  const empty = { form_options: opts, greenhouses: [{ permission_level: 'helper', has_side_vents: false }] }
  assert.deepEqual(discoveryAnswerErrors(empty), [])
  assert.equal(calculateDiscoveryEquipment(empty).greenhouses[0].slots, 0)
  // Helper qui déclare 2 fournaises et 3 zones : comptées.
  const helper = { form_options: opts, greenhouses: [{ permission_level: 'helper', has_side_vents: false, furnaces: [{}, {}], irrigation_zones: 3 }] }
  assert.equal(calculateDiscoveryEquipment(helper).greenhouses[0].slots, 5)
  // Sans permission, les réponses d'un Helper ne comptent pas.
  assert.equal(calculateDiscoveryEquipment({ ...helper, form_options: {} }).greenhouses[0].slots, 0)
  // Chef : aucun minimum imposé.
  assert.deepEqual(discoveryAnswerErrors({ form_options: opts, greenhouses: [{ permission_level: 'chief_grower', has_louvers: false, furnaces: [], irrigation_zones: 0 }] }), [])
})
test('plusieurs toits : réponses propres à chacun', () => {
  const two = { num_roof_vents: 2, has_roof_inverter: true, roof_inverter_type: 'vre_mc21' }
  assert.ok(errors({ ...two, extra_roof_vents: [] }, 1).some(e => e.includes('toit ouvrant #2')))
  const g = { ...base, ...two, extra_roof_vents: [{ has_roof_inverter: false, roof_motor_voltage: '24_dc' }] }
  assert.deepEqual(errors(g, 1), [])
  const r = calculateDiscoveryEquipment({ form_options: { additional_equipment: [{ roofs: 1 }] }, greenhouses: [g] })
  const qty = role => r.items.filter(i => i.role === role).reduce((s, i) => s + i.qty, 0)
  assert.equal(qty('roof_inverter_wire'), 1)
  assert.equal(qty('side_vent_controller_24v'), 1)
  assert.equal(r.greenhouses[0].slots, 4)
})
test('toile thermique : mêmes questions et même matériel que le toit, avec la permission seulement', () => {
  const g = { permission_level: 'chief_grower', has_louvers: false, has_roof_vents: false, num_roof_vents: 0, thermal_screen: { has_roof_vents: true, num_roof_vents: 1, has_roof_inverter: false, roof_motor_voltage: '' } }
  const resp = screens => ({ form_options: { additional_equipment: [{ screens }] }, greenhouses: [g] })
  // Sans permission, rien n'est demandé ni compté.
  assert.deepEqual(discoveryAnswerErrors(resp(0)), [])
  assert.equal(calculateDiscoveryEquipment(resp(0)).greenhouses[0].slots, 0)
  assert.ok(discoveryAnswerErrors(resp(1)).some(e => e.includes('toile thermique')))
  g.thermal_screen.roof_motor_voltage = '24_dc'
  assert.deepEqual(discoveryAnswerErrors(resp(1)), [])
  const r = calculateDiscoveryEquipment(resp(1))
  assert.equal(r.items.filter(i => i.role === 'side_vent_controller_24v').reduce((s, i) => s + i.qty, 0), 1)
  assert.equal(r.greenhouses[0].slots, 2)
})
