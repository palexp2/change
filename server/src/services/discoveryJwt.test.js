import test from 'node:test'
import assert from 'node:assert/strict'
import { calculateDiscoveryEquipment } from './discoveryEquipment.js'
import { JWT_PRODUCTS, isJwtProduct } from '../../../client/src/lib/discoveryEquipmentCatalog.js'

const products = Object.fromEntries(JWT_PRODUCTS.map(([role]) => [role, role]))
const permissions = result => result.items.filter(i => i.role.startsWith('jwt_'))
const calc = (greenhouses, options = {}, extra = {}) => calculateDiscoveryEquipment({ greenhouses, form_options: options, ...extra }, { products, outputs: { louver_spring_loaded: 1 } })

test('JWT : une permission par fonction et par serre, ventilation partagée sans sorties V2 supplémentaires', () => {
  const greenhouse = {
    permission_level: 'chief_grower', irrigation_zones: 4, furnaces: [{}, {}], num_fans: 2,
    has_louvers: true, louvers: [{ voltage: '110', control_type: 'spring_loaded', has_fan: false }],
  }
  const result = calc([greenhouse, greenhouse], { additional_equipment: [{ humidity_valve: true }, { humidity_haf: true }] })
  assert.equal(permissions(result).length, 10)
  assert(result.orderItems.every(i => i.qty === 2))
  assert.deepEqual(result.orderItems.map(i => i.role).sort(), Object.keys(products).sort())
  assert(result.greenhouses.every(g => g.slots === 10 && g.activation_modules === 3))
  assert(result.orderItems.every(i => /Serre #1.*Serre #2/.test(i.label) && /programmer.*montage/.test(i.label)))
})

test('JWT : un toit ouvrant déclaré par le client demande la ventilation partagée, à vérifier', () => {
  const result = calc([{ permission_level: 'chief_grower', has_roof_vents: true, num_roof_vents: 1 }])
  assert(permissions(result).some(i => i.role === 'jwt_advanced_ventilation'))
  assert(result.warnings.some(w => w.code === 'roof_review'))
})

test('JWT : prévention systématique en Chef de culture, aucune permission avancée en Helper', () => {
  const result = calc([
    { permission_level: 'chief_grower' },
    { permission_level: 'helper', irrigation_zones: 4, furnaces: [{}], has_louvers: true, num_fans: 2, has_roof_vents: true, has_side_vents: true, num_side_vent_motors: 2 },
  ], { additional_equipment: [{ humidity_valve: true }] })
  assert.deepEqual(permissions(result).map(i => [i.role, i.greenhouse]), [['jwt_humidity_conservation', 1], ['jwt_disease_prevention', 1]])
  assert(result.greenhouses[1].items.some(i => i.role === 'side_vent_module'))
  assert.deepEqual(permissions(calc([{}], {}, { permission_level: 'chief_grower' })).map(i => i.role), ['jwt_disease_prevention'])
  assert.deepEqual(permissions(calc([{}], {}, { permission_level: 'helper' })), [])
  assert.deepEqual(permissions(calc([])), [])
})

test('JWT : besoins indépendants, humidité achetée même sans accessoires à fournir', () => {
  for (const [answer, role] of [
    [{ irrigation_zones: 3, needs_orisha_valves: false }, 'jwt_irrigation'],
    [{ furnaces: [{}] }, 'jwt_heating'],
    [{ num_fans: 2 }, 'jwt_advanced_ventilation'],
    [{ has_louvers: true }, 'jwt_advanced_ventilation'],
    [{ has_roof_vents: true }, 'jwt_advanced_ventilation'],
  ]) assert.deepEqual(permissions(calc([answer])).map(i => [i.role, i.qty]), [[role, 1]])
  assert.deepEqual(permissions(calc([{}], { additional_equipment: [{ humidity_haf: true }] })).map(i => i.role), ['jwt_humidity_conservation'])
  assert.deepEqual(permissions(calc([{}], { humidity_retention: true })), [])
  assert.deepEqual(permissions(calc([{ irrigation_zones: 0, furnaces: [], num_fans: 0, has_louvers: false, has_roof_vents: false }])), [])
})

test('JWT : les associations manquantes sont visibles et le type se base sur le catalogue', () => {
  const result = calculateDiscoveryEquipment({ greenhouses: [{ permission_level: 'chief_grower', irrigation_zones: 1 }] })
  assert(result.unconfigured.includes('jwt_irrigation'))
  assert(result.unconfigured.includes('jwt_disease_prevention'))
  assert.deepEqual(result.orderItems, [])
  assert(isJwtProduct({ type: 'JWT' }))
  assert(isJwtProduct({ type: ' jwt ' }))
  assert(!isJwtProduct({ type: 'Pièce', name_fr: 'JWT' }))
  assert(!isJwtProduct(null))
})
