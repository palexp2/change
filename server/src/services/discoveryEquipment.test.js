import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calculateDiscoveryEquipment, EQUIPMENT_ROLES, OUTPUT_ROLES } from './discoveryEquipment.js'
import { EQUIPMENT_PRODUCTS, EQUIPMENT_OUTPUTS } from '../../../client/src/lib/discoveryEquipmentCatalog.js'
import { normalizeDiscoveryOptions } from './discoveryFormOptions.js'
import { discoveryAnswerErrors } from './discoveryAnswerValidation.js'

const outputs = { louver_spring_loaded: 1, louver_open_close: 2, louver_with_fan: 1, humidity_valve: 1, humidity_haf: 1 }
const calc = (greenhouses, options = {}, rules = {}) => calculateDiscoveryEquipment({ greenhouses, form_options: options }, { outputs, ...rules })

test('distance : un seul contrôleur par site éloigné, aucune incidence sur un nouveau site', () => {
  for (const is_new_site of ['new', 'add_to_existing']) {
    for (const within_central_controller_range of [true, false, null, undefined, 'false']) {
      const response = { is_new_site, within_central_controller_range, greenhouses: [] }
      const result = calculateDiscoveryEquipment(response, { products: { central_controller: 'CENTRAL' } })
      const required = is_new_site === 'add_to_existing' && within_central_controller_range === false
      const missing = is_new_site === 'add_to_existing' && typeof within_central_controller_range !== 'boolean'
      assert.deepEqual(result.orderItems.map(i => [i.product_id, i.qty]), required ? [['CENTRAL', 1]] : [])
      assert.equal(result.orderNotes.length, required ? 1 : 0)
      assert.equal(result.calculationComplete, !missing)
      assert.equal(discoveryAnswerErrors(response).length > 0, missing)
    }
  }
})

test('contrôleur internet mobile acheté : la question de la distance n’est plus exigée', () => {
  const response = { is_new_site: 'add_to_existing', greenhouses: [], form_options: { mobile_controller: true } }
  const result = calculateDiscoveryEquipment(response, { products: { central_controller: 'CENTRAL', mobile_controller: 'MOBILE' } })
  assert.equal(result.warnings.length, 0)
  assert.equal(result.calculationComplete, true)
  assert.deepEqual(result.orderItems.map(i => i.product_id), ['MOBILE'])
  assert.deepEqual(discoveryAnswerErrors(response), [])
  // Même sans l'option, un contrôleur mobile détecté sur la facture suffit.
  assert.deepEqual(discoveryAnswerErrors({ is_new_site: 'add_to_existing', greenhouses: [] }, { hasMobileController: true }), [])
})

test('filage 25 pi : produits distincts moteur, fournaise et valve, sans repli générique', () => {
  const result = calc([{ has_side_vents: true, length: 100, num_side_vent_motors: 2, furnaces: [{ control_wire_feet: 25 }], irrigation_zones: 1, valve_control_wire_feet: 25 }], {}, { products: { motor_wire_25: 'M25', furnace_wire_25: 'F25', valve_wire_25: 'V25', wire_25: 'LEGACY' } })
  assert.deepEqual(result.orderItems.filter(i => i.role.includes('_wire_')).map(i => i.product_id), ['M25', 'V25', 'F25'])
  assert(!result.items.some(i => i.role === 'wire_25'))
})

test('filage continu non standard : quantité au pied par appareil et marettes valve', () => {
  const r = calc([{ furnaces: [{ control_wire_feet: 36 }], irrigation_zones: 1, valve_control_wire_feet: 43 }])
  assert.equal(r.items.find(i => i.role === 'furnace_wire_per_foot').qty, 36)
  assert.equal(r.items.find(i => i.role === 'valve_wire_per_foot').qty, 43)
  assert.equal(r.items.find(i => i.role === 'valve_wire_nuts').qty, 2)
})

test('valves : seuls 15 et 25 pi utilisent un câble standard, sans marettes', () => {
  for (const feet of [15, '15', 25, '25']) {
    const r = calc([{ irrigation_zones: 1, valve_control_wire_feet: feet }], {}, { products: { valve_wire_15: 'V15', valve_wire_25: 'V25' } })
    assert.deepEqual(r.items.filter(i => i.role.startsWith('valve_wire')), [
      { role: `valve_wire_${feet}`, qty: 1, greenhouse: 1, note: '' },
    ])
    assert.equal(r.orderItems.find(i => i.role.startsWith('valve_wire')).product_id, `V${feet}`)
  }
})

test('valves : les autres longueurs sont au pied avec marettes, même avec un ancien produit configuré', () => {
  for (const feet of [10, 16, 24, 26, 50, 75, 100, '50', 150]) {
    const r = calc([{ irrigation_zones: 1, valve_control_wire_feet: feet }], {}, { products: { [`valve_wire_${feet}`]: 'OLD', valve_wire_per_foot: 'CUSTOM', valve_wire_nuts: 'NUTS' } })
    assert.deepEqual(r.orderItems.filter(i => i.role.startsWith('valve_wire')).map(i => [i.product_id, i.qty]), [['CUSTOM', Number(feet)], ['NUTS', 2]])
  }
  for (const feet of [undefined, '', 0]) {
    assert(!calc([{ irrigation_zones: 1, valve_control_wire_feet: feet }]).items.some(i => i.role.startsWith('valve_wire')))
  }
})

test('marettes : deux pièces par filage personnalisé, séparées par serre', () => {
  const productId = '1c66e98f-1877-4a29-a4c1-fdfdb9f38ae2'
  const r = calc([
    { irrigation_zones: 1, valve_control_wire_feet: 43 },
    { irrigation_zones: 2, valve_control_wire_feet: 50 },
    { irrigation_zones: 1, valve_control_wire_feet: 25 },
    { irrigation_zones: 0, valve_control_wire_feet: 43 },
  ], {}, { products: { valve_wire_nuts: productId } })
  assert.deepEqual(r.orderItems, [
    { role: 'valve_wire_nuts', qty: 2, greenhouse: 1, note: '', product_id: productId },
    { role: 'valve_wire_nuts', qty: 2, greenhouse: 2, note: '', product_id: productId },
  ])
})

test('fournaises : les longueurs standard existantes restent inchangées', () => {
  for (const feet of [25, 50, 75, 100]) {
    const r = calc([{ furnaces: [{ control_wire_feet: feet }] }])
    assert.equal(r.items.find(i => i.role === `furnace_wire_${feet}`).qty, 1)
  }
  assert.equal(calc([{ furnaces: [{ control_wire_feet: 15 }] }]).items.find(i => i.role === 'furnace_wire_per_foot').qty, 15)
})

test('louvres : chaque combinaison offerte utilise son produit', () => {
  const louvres = [
    { voltage: '110', control_type: 'spring_loaded', has_fan: false },
    { voltage: '24', control_type: 'open_close', has_fan: false },
    { voltage: '24', control_type: 'spring_loaded', has_fan: true },
    { voltage: '12', control_type: 'open_close', has_fan: false },
  ]
  const r = calc([{ has_louvers: true, louvers: louvres }])
  assert.deepEqual(r.items.filter(i => i.role.startsWith('louver')).map(i => i.role), ['louver_spring_loaded_110', 'louver_open_close_24', 'louver_with_fan_24', 'louver_open_close_12'])
  assert.equal(r.greenhouses[0].slots, 6)
  assert.equal(r.greenhouses[0].activation_modules, 2)
})

test('open/close avec ventilateur : aucun contrôle séparé ni total V2, même avec une ancienne configuration', () => {
  assert(!EQUIPMENT_ROLES.includes('louver_fan_control'))
  assert(!OUTPUT_ROLES.includes('louver_fan_control'))
  assert(!EQUIPMENT_PRODUCTS.some(([role]) => role === 'louver_fan_control'))
  assert(!EQUIPMENT_OUTPUTS.some(([role]) => role === 'louver_fan_control'))
  for (const voltage of ['24', '12']) {
    const r = calc([{ has_louvers: true, louvers: [{ voltage, control_type: 'open_close', has_fan: true }] }], {}, {
      products: { louver_fan_control: 'OLD', [`louver_open_close_${voltage}`]: 'LOUVRE' },
      outputs: { ...outputs, louver_fan_control: 1 },
    })
    assert.equal(r.calculationComplete, false)
    assert.equal(r.greenhouses[0].slots, null)
    assert.equal(r.greenhouses[0].activation_modules, null)
    assert.deepEqual(r.items.map(i => i.role), [`louver_open_close_${voltage}`])
    assert.deepEqual(r.orderItems.map(i => i.product_id), ['LOUVRE'])
    assert(!r.unconfigured.includes('louver_fan_control'))
    assert.equal(r.warnings.length, 1)
    assert.equal(r.warnings[0].code, 'louver_review')
    assert.match(r.warnings[0].message, /contrôle séparé.*n’est pas proposé par Orisha/)
  }
})

test('louvre spring loaded avec ventilateur 12 V : retirée et jamais ajoutée, même avec un ancien produit configuré', () => {
  assert(!EQUIPMENT_ROLES.includes('louver_with_fan_12'))
  assert(!EQUIPMENT_PRODUCTS.some(([role]) => role === 'louver_with_fan_12'))
  const r = calc([{ has_louvers: true, louvers: [{ voltage: '12', control_type: 'spring_loaded', has_fan: true }] }], {}, { products: { louver_with_fan_12: 'OLD' } })
  assert.equal(r.calculationComplete, false)
  assert.equal(r.greenhouses[0].slots, null)
  assert.equal(r.greenhouses[0].activation_modules, null)
  assert.deepEqual(r.items, [])
  assert.deepEqual(r.orderItems, [])
  assert.equal(r.warnings[0].code, 'louver_review')
  assert.match(r.warnings[0].message, /12 V n’est pas proposé par Orisha/)
})

test('louvres : les autres combinaisons restent disponibles', () => {
  for (const voltage of ['110', '24', '12']) {
    for (const control_type of ['spring_loaded', 'open_close']) {
      for (const has_fan of [false, true]) {
        if (voltage === '12' && control_type === 'spring_loaded' && has_fan) continue
        if (control_type === 'open_close' && (has_fan || voltage === '110')) continue
        const r = calc([{ has_louvers: true, louvers: [{ voltage, control_type, has_fan }] }])
        assert.equal(r.calculationComplete, true)
        for (const item of r.items.filter(i => i.role.startsWith('louver'))) {
          assert(EQUIPMENT_ROLES.includes(item.role))
          assert(EQUIPMENT_PRODUCTS.some(([role]) => role === item.role))
        }
      }
    }
  }
})

test('sorties non renseignées : aucun total V2 trompeur', () => {
  const r = calc([{ has_louvers: true, louvers: [{ voltage: '24', control_type: 'spring_loaded', has_fan: false }] }], {}, { outputs: {} })
  assert.equal(r.calculationComplete, false)
  assert.equal(r.greenhouses[0].activation_modules, null)
  assert(!r.items.some(i => i.role === 'activation_v2'))
})

test('autre voltage : aucune substitution de produit automatique', () => {
  const r = calc([{ has_louvers: true, louvers: [{ voltage: 'other', voltage_other: '208 V', control_type: 'spring_loaded', has_fan: false }] }])
  assert.equal(r.calculationComplete, false)
  assert.match(r.warnings[0].message, /208 V/)
})

test('humidité : option obligatoire, valve et HAF comptés indépendamment', () => {
  const g = { humidity_valve: true, humidity_haf: true, humidity_haf_count: 2 }
  assert(!calc([g]).items.some(i => i.role.startsWith('humidity_')))
  const r = calc([g], { humidity_retention: true })
  assert.equal(r.items.find(i => i.role === 'humidity_valve').qty, 1)
  assert.equal(r.items.find(i => i.role === 'humidity_haf').qty, 2)
  assert.equal(r.greenhouses[0].slots, 3)
})

test('les capteurs sont comptés une fois au site, sans sorties V2 par serre', () => {
  const r = calc([{}, {}], { sensors: { soil_temperature_sensor: 3, outdoor_temperature_sensor: 1, advanced_temperature_sensor: 2, solar_sensor: 1, rain_sensor: 1 } })
  assert.equal(r.siteItems.length, 5)
  assert.equal(r.siteItems.find(i => i.role === 'soil_temperature_sensor').qty, 3)
  assert(r.siteItems.every(i => i.greenhouse === null))
  assert(r.greenhouses.every(g => g.slots === 0))
})

test('mobile acheté ou requis : une seule unité, pas de double comptage', () => {
  for (const [bought, network] of [[true, null], [false, 'mobile_controller'], [true, 'mobile_controller']]) {
    const r = calculateDiscoveryEquipment({ greenhouses: [], form_options: { mobile_controller: bought }, network_access: network })
    assert.equal(r.siteItems.filter(i => i.role === 'mobile_controller').length, 1)
  }
  assert.equal(calculateDiscoveryEquipment({ network_access: 'ethernet' }).siteItems.length, 0)
})

test('modules séparés par serre et sorties 0 explicitement configurées acceptées', () => {
  const r = calc([{ num_fans: 1 }, { num_fans: 1 }])
  assert.equal(r.items.filter(i => i.role === 'activation_v2').reduce((n, i) => n + i.qty, 0), 2)
  assert.equal(calc([{ humidity_valve: true }], { humidity_retention: true }, { outputs: { humidity_valve: 0 } }).calculationComplete, true)
})

test('validation des réponses visibles, autre voltage précisé accepté', () => {
  const g = { has_louvers: true, louvers: [{ voltage: 'other', voltage_other: '208 V', control_type: 'open_close', has_fan: true }] }
  assert.deepEqual(discoveryAnswerErrors({ greenhouses: [g] }), [])
  assert(discoveryAnswerErrors({ greenhouses: [{ ...g, louvers: [{}] }] }).length)
  assert(discoveryAnswerErrors({ greenhouses: [{ has_louvers: false }], form_options: { humidity_retention: true } }).length)
  assert.deepEqual(discoveryAnswerErrors({ greenhouses: [{ has_louvers: false, humidity_valve: false, humidity_haf: false }], form_options: { humidity_retention: true } }), [])
})

test('options : quantités de capteurs bornées et clés inconnues ignorées', () => {
  const options = normalizeDiscoveryOptions({ mobile_controller: 'false', sensors: { rain_sensor: -1, solar_sensor: 1.5, soil_temperature_sensor: '2', unknown: 9 } })
  assert.equal(options.mobile_controller, false)
  assert.equal(options.sensors.rain_sensor, 0)
  assert.equal(options.sensors.solar_sensor, 0)
  assert.equal(options.sensors.soil_temperature_sensor, 2)
  assert(!('unknown' in options.sensors))
})

test('ouvrir/fermer 110 V : refusé à la soumission et sans produit même avec une ancienne association', () => {
  assert(!EQUIPMENT_ROLES.includes('louver_open_close_110'))
  assert(!EQUIPMENT_PRODUCTS.some(([role]) => role === 'louver_open_close_110'))
  for (const has_fan of [false, true]) {
    const g = { has_louvers: true, louvers: [{ voltage: '110', control_type: 'open_close', has_fan }] }
    const errors = discoveryAnswerErrors({ greenhouses: [g] })
    assert.equal(errors.length, 1)
    assert.match(errors[0], /ouvrir\/fermer en 110 V/)
    const r = calc([g], {}, { products: { louver_open_close_110: 'OLD' } })
    assert.equal(r.calculationComplete, false)
    assert.equal(r.greenhouses[0].slots, null)
    assert.equal(r.greenhouses[0].activation_modules, null)
    assert.deepEqual(r.items, [])
    assert.deepEqual(r.orderItems, [])
    assert.deepEqual(r.unconfigured, [])
    assert.equal(r.warnings[0].code, 'louver_review')
    assert.match(r.warnings[0].message, /ouvrir\/fermer en 110 V/)
  }
})

test('commande inconnue : réponse acceptée, appel ciblé et aucun équipement supposé', () => {
  for (const voltage of ['110', '24', '12', 'other']) {
    for (const has_fan of [false, true]) {
      const greenhouses = [{ has_louvers: false }, { has_louvers: true, louvers: [
        { voltage: '24', control_type: 'spring_loaded', has_fan: false },
        { voltage, voltage_other: '208 V', control_type: 'other', has_fan },
      ] }]
      assert.deepEqual(discoveryAnswerErrors({ greenhouses }), [])
      const r = calc(greenhouses)
      assert.equal(r.calculationComplete, false)
      assert.equal(r.greenhouses[1].slots, null)
      assert.deepEqual(r.items.filter(i => i.role.startsWith('louver')).map(i => i.note), ['Louvre #1'])
      assert.deepEqual(r.warnings.map(w => [w.greenhouse, w.code]), [[2, 'louver_call_client']])
      assert.match(r.warnings[0].message, /Louvre #2.*appeler le client/)
      greenhouses[1].louvers[1] = { voltage: '24', control_type: 'spring_loaded', has_fan }
      assert.equal(calc(greenhouses).calculationComplete, true)
      assert.deepEqual(calc(greenhouses).warnings, [])
    }
  }
})
