import { test } from 'node:test'
import assert from 'node:assert/strict'
import { calculateDiscoveryEquipment, EQUIPMENT_ROLES, OUTPUT_ROLES } from './discoveryEquipment.js'
import { EQUIPMENT_PRODUCTS, EQUIPMENT_OUTPUTS } from '../../../client/src/lib/discoveryEquipmentCatalog.js'
import { normalizeDiscoveryOptions } from './discoveryFormOptions.js'
import { discoveryAnswerErrors } from './discoveryAnswerValidation.js'

const outputs = { louver_spring_loaded: 1, louver_open_close: 2, louver_with_fan: 1, humidity_valve: 1, humidity_haf: 1 }
const calc = (greenhouses, options = {}, rules = {}) => calculateDiscoveryEquipment({ greenhouses, form_options: options }, { outputs, ...rules })

test('distance : un seul contrôleur par site éloigné ; un nouveau site a toujours le sien', () => {
  for (const is_new_site of ['new', 'add_to_existing']) {
    for (const within_central_controller_range of [true, false, null, undefined, 'false']) {
      const response = { is_new_site, within_central_controller_range, greenhouses: [] }
      const result = calculateDiscoveryEquipment(response, { products: { central_controller: 'CENTRAL' } })
      const required = is_new_site === 'new' || within_central_controller_range === false
      const missing = is_new_site === 'add_to_existing' && typeof within_central_controller_range !== 'boolean'
      assert.deepEqual(result.orderItems.map(i => [i.product_id, i.qty]), required ? [['CENTRAL', 1]] : [])
      assert.equal(result.orderNotes.length, is_new_site === 'add_to_existing' && within_central_controller_range === false ? 1 : 0)
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

test('valves : un câble standard par valve dans l’aperçu et la commande', () => {
  for (const feet of [15, 25, '25']) {
    for (const needs_orisha_valves of [true, false]) {
      const role = `valve_wire_${feet}`
      const r = calc([{ irrigation_zones: 4, valve_control_wire_feet: feet, needs_orisha_valves }], {}, { products: { [role]: 'WIRE' } })
      assert.deepEqual(r.greenhouses[0].items.filter(i => i.role.startsWith('valve_wire')), [
        { role, qty: 4, greenhouse: 1, note: '' },
      ])
      assert.deepEqual(r.orderItems.map(i => [i.product_id, i.qty]), [['WIRE', 4]])
    }
  }
})

test('valves : longueurs personnalisées et marettes multipliées par valve', () => {
  const r = calc([{ irrigation_zones: 4, valve_control_wire_feet: 43 }], {}, {
    products: { valve_wire_per_foot: 'WIRE', valve_wire_nuts: 'NUTS' },
  })
  assert.deepEqual(r.orderItems.map(i => [i.product_id, i.qty]), [['WIRE', 43], ['WIRE', 43], ['WIRE', 43], ['WIRE', 43], ['NUTS', 8]])
})

test('fil au pied : une ligne par fournaise, pas le total', () => {
  const r = calc([{ furnaces: Array(4).fill({ control_wire_feet: 150 }) }], {}, { products: { furnace_wire_per_foot: 'W' } })
  assert.deepEqual(r.orderItems.map(i => [i.product_id, i.qty]), [['W', 150], ['W', 150], ['W', 150], ['W', 150]])
})

test('valves : cumul des câbles par serre, sans filage pour zéro valve ou Helper', () => {
  const r = calc([
    { irrigation_zones: 4, valve_control_wire_feet: 25 },
    { irrigation_zones: 2, valve_control_wire_feet: 25 },
    { irrigation_zones: 0, valve_control_wire_feet: 25 },
    { irrigation_zones: 4, valve_control_wire_feet: 25, permission_level: 'helper' },
  ], {}, { products: { valve_wire_25: 'WIRE' } })
  assert.deepEqual(r.items.filter(i => i.role === 'valve_wire_25').map(i => [i.greenhouse, i.qty]), [[1, 4], [2, 2]])
  assert.deepEqual(r.orderItems.map(i => [i.product_id, i.qty]), [['WIRE', 6]])
})

test('marettes : deux pièces par valve avec filage personnalisé, séparées par serre', () => {
  const productId = '1c66e98f-1877-4a29-a4c1-fdfdb9f38ae2'
  const r = calc([
    { irrigation_zones: 1, valve_control_wire_feet: 43 },
    { irrigation_zones: 2, valve_control_wire_feet: 50 },
    { irrigation_zones: 1, valve_control_wire_feet: 25 },
    { irrigation_zones: 0, valve_control_wire_feet: 43 },
  ], {}, { products: { valve_wire_nuts: productId } })
  assert.deepEqual(r.items.filter(i => i.role === 'valve_wire_nuts'), [
    { role: 'valve_wire_nuts', qty: 2, greenhouse: 1, note: '' },
    { role: 'valve_wire_nuts', qty: 4, greenhouse: 2, note: '' },
  ])
  // Un seul produit à la commande : les deux serres se cumulent sur une ligne.
  assert.deepEqual(r.orderItems.map(i => [i.product_id, i.qty, i.greenhouse, i.label]), [[productId, 6, null, 'Serre #1 ; Serre #2']])
})

test('commande : les produits identiques tiennent sur une seule ligne', () => {
  const louver = { voltage: '110', control_type: 'spring_loaded', has_fan: false }
  const r = calc([{ has_louvers: true, louvers: [louver, louver, louver] }, { has_louvers: true, louvers: [louver] }], {}, {
    products: { louver_spring_loaded_110: 'BOITIER110', activation_v2: 'V2' },
  })
  assert.deepEqual(r.orderItems.map(i => [i.product_id, i.qty]), [['BOITIER110', 4], ['V2', 2]])
  assert.equal(r.orderItems[0].label, 'Serre #1 · Louvre #1, Louvre #2, Louvre #3 ; Serre #2 · Louvre #1')
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
    { voltage: '110', control_type: 'spring_loaded', has_fan: true },
    { voltage: '12', control_type: 'open_close', has_fan: false },
  ]
  const r = calc([{ has_louvers: true, louvers: louvres }])
  assert.deepEqual(r.items.filter(i => i.role.startsWith('louver')).map(i => i.role), ['louver_spring_loaded_110', 'louver_open_close_24', 'louver_with_fan_110', 'louver_open_close_12'])
  assert.equal(r.greenhouses[0].slots, 6)
  assert.equal(r.greenhouses[0].activation_modules, 2)
})

test('module d’activation : le détail des sorties se recompte', () => {
  const louver = { voltage: '110', control_type: 'spring_loaded', has_fan: false }
  const g = calc([{ has_louvers: true, louvers: [louver, louver], furnaces: [{}], irrigation_zones: 2 }]).greenhouses[0]
  assert.equal(g.slot_sources.reduce((n, s) => n + s.slots, 0), g.slots)
  assert.deepEqual(g.slot_sources.find(s => s.label === 'Zone d’irrigation'), { label: 'Zone d’irrigation', qty: 2, slots: 2 })
  assert.equal(g.slot_sources.find(s => s.label.startsWith('Louvre seule spring loaded')).qty, 2)
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
    assert.equal(r.greenhouses[0].slots_partial, true)
    assert.equal(r.greenhouses[0].activation_modules, 1)
    assert.deepEqual(r.items.map(i => i.role), [`louver_open_close_${voltage}`, 'activation_v2', 'jwt_advanced_ventilation'])
    assert.deepEqual(r.orderItems.map(i => i.product_id), ['LOUVRE'])
    assert(!r.unconfigured.includes('louver_fan_control'))
    assert.equal(r.warnings.length, 1)
    assert.equal(r.warnings[0].code, 'louver_review')
    assert.match(r.warnings[0].message, /contrôle séparé.*n’est pas proposé par Orisha/)
  }
})

test('louvre spring loaded avec ventilateur hors 110 V : retirée et jamais ajoutée, même avec un ancien produit configuré', () => {
  for (const voltage of ['24', '12']) {
    assert(!EQUIPMENT_ROLES.includes(`louver_with_fan_${voltage}`))
    assert(!EQUIPMENT_PRODUCTS.some(([role]) => role === `louver_with_fan_${voltage}`))
    const r = calc([{ has_louvers: true, louvers: [{ voltage, control_type: 'spring_loaded', has_fan: true }] }], {}, { products: { [`louver_with_fan_${voltage}`]: 'OLD' } })
    assert.equal(r.calculationComplete, false)
    assert.equal(r.greenhouses[0].slots, null)
    assert.equal(r.greenhouses[0].activation_modules, null)
    assert.deepEqual(r.items.map(i => i.role), ['jwt_advanced_ventilation'])
    assert.deepEqual(r.orderItems, [])
    assert.equal(r.warnings[0].code, 'louver_review')
    assert.match(r.warnings[0].message, new RegExp(`${voltage} V n’est pas proposé par Orisha`))
  }
})

test('louvres : les autres combinaisons restent disponibles', () => {
  for (const voltage of ['110', '24', '12']) {
    for (const control_type of ['spring_loaded', 'open_close']) {
      for (const has_fan of [false, true]) {
        if (voltage !== '110' && control_type === 'spring_loaded' && has_fan) continue
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

test('brumisation et HAF : cochés par Orisha par serre, une sortie V2 chacun', () => {
  // Les anciennes réponses du client ne fournissent plus rien.
  assert(!calc([{ humidity_valve: true, humidity_haf: true }], { humidity_retention: true }).items.some(i => i.role.startsWith('humidity_')))
  const r = calc([{}, {}], { additional_equipment: [{ humidity_valve: true, humidity_haf: true }, { humidity_haf: true }] })
  assert.deepEqual(r.greenhouses.map(g => g.items.filter(i => i.role.startsWith('humidity_')).map(i => [i.role, i.qty])), [[['humidity_valve', 1], ['humidity_haf', 1]], [['humidity_haf', 1]]])
  assert.deepEqual(r.greenhouses.map(g => g.slots), [2, 1])
  assert.equal(r.calculationComplete, true)
})

test('les capteurs sont comptés une fois au site, sans sorties V2 par serre', () => {
  const r = calc([{}, {}], { sensors: { soil_temperature_sensor: 3, outdoor_temperature_sensor: 1, advanced_temperature_sensor: 2, solar_sensor: 1, rain_sensor: 1 } })
  assert.equal(r.siteItems.length, 4)
  assert.equal(r.siteItems.find(i => i.role === 'soil_temperature_sensor').qty, 3)
  assert(r.siteItems.every(i => i.greenhouse === null))
  assert(r.greenhouses.every(g => g.slots === 0))
})

test('le capteur de température avancé se coche par serre, sans sortie V2', () => {
  const r = calc([{}, {}], { additional_equipment: [{ advanced_temperature_sensor: true }, {}] })
  assert.deepEqual(r.greenhouses.map(g => g.items.filter(i => i.role === 'advanced_temperature_sensor').map(i => i.qty)), [[1], []])
  assert(!r.siteItems.some(i => i.role === 'advanced_temperature_sensor'))
  assert(r.greenhouses.every(g => g.slots === 0))
})

test('mobile acheté ou requis : une seule unité, pas de double comptage', () => {
  for (const [bought, network] of [[true, null], [false, 'mobile_controller'], [true, 'mobile_controller']]) {
    const r = calculateDiscoveryEquipment({ greenhouses: [], form_options: { mobile_controller: bought }, network_access: network })
    assert.equal(r.siteItems.filter(i => i.role.startsWith('mobile_controller')).length, 1)
  }
  assert.equal(calculateDiscoveryEquipment({ network_access: 'ethernet' }).siteItems.length, 0)
})

test('plusieurs contrôleurs mobiles achetés : la quantité suit', () => {
  const qty = options => calculateDiscoveryEquipment({ greenhouses: [], form_options: options }).siteItems.find(i => i.role.startsWith('mobile_controller'))?.qty ?? 0
  assert.equal(qty({ mobile_controllers: 3 }), 3)
  assert.equal(qty({ mobile_controllers: 0, mobile_controller: true }), 0)
  assert.equal(qty({ mobile_controller: true }), 1)
})

test('contrôleur mobile : deux produits selon le pays, avec repli sur l’ancien rôle unique', () => {
  const mobile = (address, products) => {
    const r = calculateDiscoveryEquipment({ greenhouses: [], form_options: { mobile_controller: true }, ...address }, { products })
    return [r.siteItems[0].role, r.orderItems[0]?.product_id ?? null]
  }
  const byCountry = { mobile_controller_ca: 'CA', mobile_controller_us: 'US' }
  assert.deepEqual(mobile({ shipping_address: { country: 'Canada' } }, byCountry), ['mobile_controller_ca', 'CA'])
  assert.deepEqual(mobile({}, byCountry), ['mobile_controller_ca', 'CA'])
  for (const country of ['USA', 'United States', 'États-Unis', 'u.s.a.']) {
    assert.deepEqual(mobile({ shipping_address: { country } }, byCountry), ['mobile_controller_us', 'US'])
  }
  // Livraison identique à la ferme : le pays vient de la ferme.
  assert.deepEqual(mobile({ shipping_same_as_farm: true, farm_address: { country: 'USA' }, shipping_address: null }, byCountry), ['mobile_controller_us', 'US'])
  // Association héritée (rôle unique) : toujours honorée tant que les deux produits ne sont pas associés.
  assert.deepEqual(mobile({ shipping_address: { country: 'USA' } }, { mobile_controller: 'LEGACY' }), ['mobile_controller_us', 'LEGACY'])
  assert.deepEqual(calculateDiscoveryEquipment({ greenhouses: [], form_options: { mobile_controller: true } }, { products: {} }).unconfigured, ['mobile_controller_ca'])
})

test('modules séparés par serre et sorties 0 explicitement configurées acceptées', () => {
  const r = calc([{ num_fans: 1 }, { num_fans: 1 }])
  assert.equal(r.items.filter(i => i.role === 'activation_v2').reduce((n, i) => n + i.qty, 0), 2)
})

test('deux ventilateurs : la plage de puissance donne le nombre de boîtes', () => {
  const boxes = g => calc([{ num_fans: 2, ...g }]).items.filter(i => i.role === 'fan_box_110v').reduce((n, i) => n + i.qty, 0)
  assert.equal(boxes({ fans_hp_range: 'up_to_1' }), 1)
  assert.equal(boxes({ fans_hp_range: 'over_1' }), 2)
  // Réponses d'avant la plage : le nombre exact de HP la donne encore.
  assert.equal(boxes({ fans_combined_hp: 0.75 }), 1)
  assert.equal(boxes({ fans_combined_hp: 2 }), 2)
  assert.equal(boxes({ fans_combined_hp: 'Je ne sais pas' }), 2)
})

test('validation des réponses visibles, autre voltage précisé accepté', () => {
  const g = { has_louvers: true, louvers: [{ voltage: 'other', voltage_other: '208 V', control_type: 'open_close', has_fan: true }] }
  assert.deepEqual(discoveryAnswerErrors({ greenhouses: [g] }), [])
  // « Autre / Je ne sais pas » : l'image ne porte aucun voltage, rien de plus
  // n'est exigé du client — le vérificateur l'appellera.
  assert.deepEqual(discoveryAnswerErrors({ greenhouses: [{ has_louvers: true, louvers: [{ control_type: 'other', voltage: '', has_fan: false }] }] }), [])
  assert(discoveryAnswerErrors({ greenhouses: [{ ...g, louvers: [{}] }] }).length)
  // Brumisation et HAF ne sont plus demandés au client.
  assert.deepEqual(discoveryAnswerErrors({ greenhouses: [{ has_louvers: false }], form_options: { humidity_retention: true } }), [])
})

test('serre Helper : seuls les côtés ouvrants sont automatisés', () => {
  const g = {
    permission_level: 'helper', has_side_vents: true, length: 100, num_side_vent_motors: 2,
    // Réponses héritées d'avant la règle : elles ne doivent plus rien dimensionner.
    num_fans: 2, fans_combined_hp: 2, has_louvers: true, louvers: [{ voltage: '24', control_type: 'spring_loaded', has_fan: false }],
    humidity_valve: true, humidity_haf: true, humidity_haf_count: 3,
    furnaces: [{ control_wire_feet: 25 }], irrigation_zones: 2, needs_orisha_valves: true,
  }
  const r = calc([g], { humidity_retention: true })
  assert.deepEqual(r.items.map(i => i.role).sort(), ['motor_wire_25', 'side_vent_module', 'temp_humidity_sensor'])
  assert.equal(r.greenhouses[0].slots, 0)
  // Les questions n'étant pas posées à une serre Helper, rien n'est exigé.
  assert.deepEqual(discoveryAnswerErrors({ greenhouses: [{ permission_level: 'helper' }], form_options: { humidity_retention: true } }), [])
  assert.deepEqual(discoveryAnswerErrors({ permission_level: 'helper', greenhouses: [{}] }), [])
})

test('options : quantités de capteurs bornées et clés inconnues ignorées', () => {
  const options = normalizeDiscoveryOptions({ mobile_controller: 'false', sensors: { rain_sensor: -1, solar_sensor: 1.5, soil_temperature_sensor: '2', unknown: 9 } })
  assert.equal(options.mobile_controller, false)
  assert.equal(options.sensors.rain_sensor, 0)
  assert.equal(options.sensors.solar_sensor, 0)
  assert.equal(options.sensors.soil_temperature_sensor, 2)
  assert(!('unknown' in options.sensors))
})

test('options : capteurs de vent et contrôleurs centraux additionnels à la commande', () => {
  const r = calculateDiscoveryEquipment({ is_new_site: 'new', network_access: 'ethernet', greenhouses: [], form_options: { extra_central_controllers: '2', sensors: { wind_sensor: 3 } } }, { products: { central_controller: 'p-cc', wind_sensor: 'p-wind' } })
  assert.equal(r.orderItems.find(l => l.product_id === 'p-cc').qty, 3)
  assert.equal(r.orderItems.find(l => l.product_id === 'p-wind').qty, 3)
  assert.equal(r.orderNotes.length, 1)
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
    assert.deepEqual(r.items.map(i => i.role), ['jwt_advanced_ventilation'])
    assert.deepEqual(r.orderItems, [])
    assert.deepEqual(r.unconfigured, ['jwt_advanced_ventilation'])
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
      // Minimum pour la louvre connue, marqué partiel.
      assert.equal(r.greenhouses[1].slots_partial, true)
      assert.equal(r.greenhouses[1].activation_modules, 1)
      assert.match(r.items.find(i => i.role === 'activation_v2').note, /minimum/)
      assert.deepEqual(r.items.filter(i => i.role.startsWith('louver')).map(i => i.note), ['Louvre #1'])
      assert.deepEqual(r.warnings.map(w => [w.greenhouse, w.code]), [[2, 'louver_call_client']])
      assert.match(r.warnings[0].message, /Louvre #2.*appeler le client/)
      greenhouses[1].louvers[1] = { voltage: has_fan ? '110' : '24', control_type: 'spring_loaded', has_fan }
      assert.equal(calc(greenhouses).calculationComplete, true)
      assert.deepEqual(calc(greenhouses).warnings, [])
    }
  }
})

test('moteurs du client avec inverseurs : 2 sorties par inverseur, pas de module de côtés', () => {
  const base = { greenhouses: [{ permission_level: 'helper', has_side_vents: true, num_side_vent_motors: 2, length: 150, has_existing_side_vent_motors: true, side_has_inverters: true }] }
  const perMotor = calculateDiscoveryEquipment({ ...base, greenhouses: [{ ...base.greenhouses[0], side_inverter_ratio: 'per_motor' }] })
  assert.ok(!perMotor.items.some(i => i.role === 'side_vent_module'))
  assert.equal(perMotor.items.find(i => i.role === 'activation_v2')?.note, '4 sorties')
  const perTwo = calculateDiscoveryEquipment({ ...base, greenhouses: [{ ...base.greenhouses[0], side_inverter_ratio: 'per_two' }] })
  assert.equal(perTwo.items.find(i => i.role === 'activation_v2')?.note, '2 sorties')
  for (const [r, qty] of [[perMotor, 2], [perTwo, 1]]) {
    assert.ok(!r.items.some(i => i.role === 'motor_wire_25'))
    assert.equal(r.items.find(i => i.role === 'side_inverter_wire')?.qty, qty)
  }
  const fallback = calculateDiscoveryEquipment({ ...base, greenhouses: [{ ...base.greenhouses[0], side_inverter_ratio: 'per_motor' }] }, { products: { roof_inverter_wire: 'W' } })
  assert.deepEqual(fallback.orderItems.map(l => [l.product_id, l.qty]), [['W', 2]])
})

test('moteurs du client sans inverseur : module de côtés pour 2 moteurs, contrôleur 24 V par moteur au-delà de 200 pi', () => {
  const g = { permission_level: 'helper', has_side_vents: true, num_side_vent_motors: 2, has_existing_side_vent_motors: true, side_has_inverters: false }
  const short = calculateDiscoveryEquipment({ greenhouses: [{ ...g, length: 150 }] })
  assert.equal(short.items.find(i => i.role === 'side_vent_module')?.qty, 1)
  const long = calculateDiscoveryEquipment({ greenhouses: [{ ...g, length: 250 }] })
  assert.equal(long.items.find(i => i.role === 'side_vent_controller_24v')?.qty, 2)
  assert.ok(!long.items.some(i => i.role === 'side_vent_module'))
})

test('toits ouvrants : équipement selon le moteur et l’inverseur', () => {
  const roof = extra => calculateDiscoveryEquipment({ greenhouses: [{ permission_level: 'chief_grower', has_roof_vents: true, num_roof_vents: 1, ...extra }] })
  const roles = r => r.items.map(i => i.role)
  const withInverter = roof({ roof_motor_voltage: '110', has_roof_inverter: true })
  assert(roles(withInverter).includes('roof_inverter_wire'))
  assert.equal(withInverter.greenhouses[0].slots, 2)
  const customerSupplies = roof({ roof_motor_voltage: '240', roof_motor_ridder_rw240: false, has_roof_inverter: false })
  assert(roles(customerSupplies).includes('roof_inverter_wire'))
  assert(!customerSupplies.warnings.some(w => w.code === 'roof_review'))
  const dc = roof({ roof_motor_voltage: '24_dc', has_roof_inverter: false })
  assert(roles(dc).includes('side_vent_controller_24v') && !roles(dc).includes('roof_inverter_wire'))
  const ridder = roof({ roof_motor_voltage: '240', roof_motor_ridder_rw240: true, has_roof_inverter: false })
  assert(roles(ridder).includes('roof_inverter_ridder') && roles(ridder).includes('roof_inverter_wire'))
  assert(roof({}).warnings.some(w => w.code === 'roof_review'))
})

test('inverseur du client : produit associé à son modèle, un par inverseur', () => {
  const products = { inverter_extra_roof_harnois_8ze141l_1: 'p1', inverter_extra_side_8ze133ldc_1: 'p1' }
  const calc = g => calculateDiscoveryEquipment({ greenhouses: [{ permission_level: 'chief_grower', ...g }] }, { products })
  const roof = { has_roof_vents: true, num_roof_vents: 2, roof_motor_voltage: '110', has_roof_inverter: true }
  const harnois = calc({ ...roof, roof_inverter_type: 'harnois_8ze141l' })
  assert.deepEqual(harnois.orderItems.map(l => [l.product_id, l.qty]), [['p1', 2]])
  assert.deepEqual(calc({ ...roof, roof_inverter_type: 'harnois_8ze142l' }).orderItems, harnois.orderItems)
  assert.equal(calc({ ...roof, roof_inverter_type: 'vre_mc21' }).orderItems.length, 0)
  assert.deepEqual(calc({ ...roof, has_roof_inverter: false }).orderItems, [])
  const side = calc({ has_side_vents: true, num_side_vent_motors: 3, has_existing_side_vent_motors: true, side_has_inverters: true, side_inverter_ratio: 'per_two', side_inverter_model: '8ZE133LDC' })
  assert.deepEqual(side.orderItems.map(l => [l.product_id, l.qty]), [['p1', 2]])
  assert.deepEqual(side.unconfigured.filter(r => r.startsWith('inverter_extra')), [])
})

test('nouveau site : contrôleur central sauf Internet mobile, coaxial pour le Wi-Fi à 350 pi', () => {
  const roles = r => r.siteItems.map(i => i.role)
  assert(roles(calculateDiscoveryEquipment({ is_new_site: 'new', network_access: 'wifi_250', greenhouses: [] })).includes('central_controller'))
  const coax = roles(calculateDiscoveryEquipment({ is_new_site: 'new', network_access: 'wifi_350_coax', greenhouses: [] }))
  assert(coax.includes('central_controller') && coax.includes('coax_antenna_kit'))
  const mobile = roles(calculateDiscoveryEquipment({ is_new_site: 'new', network_access: 'mobile_controller', greenhouses: [] }))
  assert(!mobile.includes('central_controller'))
  const optionMobile = roles(calculateDiscoveryEquipment({ is_new_site: 'new', network_access: 'ethernet', form_options: { mobile_controller: true }, greenhouses: [] }))
  assert(!optionMobile.includes('central_controller'))
})

test('site existant à plus de 350 pi : accès réseau comme un nouveau site', () => {
  const roles = network => calculateDiscoveryEquipment({ is_new_site: 'add_to_existing', within_central_controller_range: false, network_access: network, greenhouses: [] }).siteItems.map(i => i.role)
  const mobile = roles('mobile_controller')
  assert(!mobile.includes('central_controller') && mobile.some(r => r.startsWith('mobile_controller')))
  const coax = roles('wifi_350_coax')
  assert(coax.includes('central_controller') && coax.includes('coax_antenna_kit'))
  // À portée du contrôleur existant, une vieille réponse réseau ne compte plus.
  const near = calculateDiscoveryEquipment({ is_new_site: 'add_to_existing', within_central_controller_range: true, network_access: 'mobile_controller', greenhouses: [] }).siteItems
  assert.equal(near.length, 0)
})

test('moteurs et tuyaux guides fournis par Orisha : un de chaque par côté', () => {
  const roles = g => calculateDiscoveryEquipment({ greenhouses: [{ has_side_vents: true, length: 100, num_side_vent_motors: 2, ...g }] }).items
    .filter(i => ['side_vent_motor_left', 'side_vent_motor_right', 'guide_pipe', 'guide_pipe_hanging_kit'].includes(i.role)).map(i => `${i.role}:${i.qty}`).sort()
  assert.deepEqual(roles({ has_existing_side_vent_motors: false, guide_pipes_state: 'needed' }), ['guide_pipe:2', 'guide_pipe_hanging_kit:2', 'side_vent_motor_left:1', 'side_vent_motor_right:1'])
  assert.deepEqual(roles({ num_side_vent_motors: 1, has_existing_side_vent_motors: false, guide_pipes_state: 'present' }), ['side_vent_motor_left:1'])
  assert.deepEqual(roles({ has_existing_side_vent_motors: true, guide_pipes_state: 'present' }), [])
  assert.deepEqual(roles({ has_existing_side_vent_motors: true, guide_pipes_state: 'needed' }), ['guide_pipe:2', 'guide_pipe_hanging_kit:2'])

})

test('tuyau de côté entre 1 5/16 et 1 1/2 po : un adaptateur par moteur', () => {
  const adapters = g => calculateDiscoveryEquipment({ greenhouses: [{ has_side_vents: true, length: 100, num_side_vent_motors: 2, has_existing_side_vent_motors: false, side_pipe_type: 'steel_O', ...g }] }).items
    .filter(i => i.role === 'side_pipe_adapter').reduce((n, i) => n + i.qty, 0)
  assert.equal(adapters({ side_pipe_diameter: '1 1/2"' }), 2)
  assert.equal(adapters({ side_pipe_diameter: '1 1/2"', num_side_vent_motors: 1 }), 1)
  assert.equal(adapters({ side_pipe_diameter: '1 5/16"' }), 0)
})

test('tuyaux guides « Je ne sais pas » : rien fourni, appeler le client', () => {
  const r = calculateDiscoveryEquipment({ greenhouses: [{ has_side_vents: true, length: 100, num_side_vent_motors: 2, has_existing_side_vent_motors: true, guide_pipes_state: 'unknown' }] })
  assert.equal(r.items.some(i => i.role.startsWith('guide_pipe')), false)
  assert.ok(r.warnings.some(w => w.code === 'guide_pipes_call_client'))
})

test('chef de culture : un capteur de vent et un boîtier météo par commande, jamais en Helper', () => {
  const products = { wind_sensor: 'WIND', weather_box: 'BOX' }
  const lines = gh => calc(gh, { sensors: { wind_sensor: 2 } }, { products }).orderItems.filter(i => ['WIND', 'BOX'].includes(i.product_id)).map(i => [i.product_id, i.qty])
  assert.deepEqual(lines([{ permission_level: 'chief_grower' }, { permission_level: 'chief_grower' }, { permission_level: 'helper' }]), [['WIND', 3], ['BOX', 1]])
  assert.deepEqual(lines([{ permission_level: 'helper' }]), [['WIND', 2]])
})

test('capteur de température et d’humidité : un par serre Helper ou Chef de culture', () => {
  const r = calculateDiscoveryEquipment({ greenhouses: [{ permission_level: 'chief_grower' }, { permission_level: 'helper' }, {}] }, { products: { temp_humidity_sensor: 'TH' } })
  assert.deepEqual(r.items.filter(i => i.role === 'temp_humidity_sensor').map(i => i.greenhouse), [1, 2])
  assert.deepEqual(r.orderItems.filter(i => i.product_id === 'TH').map(i => i.qty), [2])
})

test('capteur de température avancé : remplace le capteur de température et d’humidité de la serre', () => {
  const r = calc([{ permission_level: 'chief_grower' }, { permission_level: 'helper' }], { additional_equipment: [{ advanced_temperature_sensor: true }, {}] })
  const roles = r.greenhouses.map(g => g.items.map(i => i.role).filter(role => ['temp_humidity_sensor', 'advanced_temperature_sensor'].includes(role)))
  assert.deepEqual(roles, [['advanced_temperature_sensor'], ['temp_humidity_sensor']])
})
