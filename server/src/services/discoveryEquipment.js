import { normalizeDiscoveryOptions, SENSOR_ROLES } from './discoveryFormOptions.js'

// Règles de dimensionnement du System Builder. Délibérément sans DB : elles
// restent testables et ne permettent jamais de mutualiser un module entre deux
// serres.

export const OUTPUT_ROLES = ['louver_spring_loaded', 'louver_open_close', 'louver_with_fan', 'humidity_valve', 'humidity_haf']
export const EQUIPMENT_ROLES = [
  ...['110', '24', '12'].flatMap(v => ['louver_spring_loaded', ...(v === '110' ? [] : ['louver_open_close']), ...(v === '12' ? [] : ['louver_with_fan'])].map(type => `${type}_${v}`)),
  'humidity_valve', 'humidity_haf',
  'activation_v2', 'side_vent_module', 'side_vent_controller_24v',
  'fan_box_110v', 'valve', 'mobile_controller', 'central_controller', ...SENSOR_ROLES,
  ...['motor', 'furnace', 'valve'].flatMap(device => (device === 'valve' ? [15, 25, 'per_foot'] : [25, 50, 75, 100, 'per_foot']).map(length => `${device}_wire_${length}`)), 'valve_wire_nuts', 'backup_thermostat', 'thermostat_wire',
]

function add(items, role, qty, greenhouse, note = '') {
  if (!qty) return
  items.push({ role, qty, greenhouse, note })
}

function continuousWire(items, feet, greenhouse, device) {
  const n = Math.max(0, Number(feet) || 0)
  if (!n) return
  const preset = (device === 'valve' ? [15, 25] : [25, 50, 75, 100]).find(x => x === n)
  add(items, preset ? `${device}_wire_${preset}` : `${device}_wire_per_foot`, n === preset ? 1 : n, greenhouse)
  if (device === 'valve' && !preset) add(items, 'valve_wire_nuts', 2, greenhouse)
}

export function calculateDiscoveryEquipment(response, rules = {}) {
  const options = normalizeDiscoveryOptions(response?.form_options)
  const warnings = []
  const perGreenhouse = []
  for (const [index, g] of (response?.greenhouses || []).entries()) {
    const greenhouse = index + 1
    const furnaces = Array.isArray(g.furnaces) ? g.furnaces : []
    const valves = Math.max(0, Number(g.irrigation_zones) || 0)
    const fans = Math.min(2, Math.max(0, Number(g.num_fans) || 0))
    const motors = g.has_side_vents ? Math.max(0, Number(g.num_side_vent_motors) || 0) : 0
    let slots = furnaces.length + valves + fans
    const items = []
    let outputsUnknown = false
    function addControlled(role, qty, outputRole = role, note = '') {
      add(items, role, qty, greenhouse, note)
      if (!qty) return
      const configured = rules.outputs?.[outputRole]
      if (!Number.isInteger(configured) || configured < 0 || configured > 8) {
        outputsUnknown = true
        warnings.push({ greenhouse, code: 'outputs_missing', role: outputRole, message: `Nombre de sorties V2 à définir pour ${outputRole}.` })
      } else slots += qty * configured
    }
    if (g.has_louvers) {
      const louvers = Array.isArray(g.louvers) ? g.louvers : []
      if (!louvers.length) {
        outputsUnknown = true
        warnings.push({ greenhouse, code: 'louver_review', message: 'Les louvres sont déclarées, mais leurs caractéristiques manquent.' })
      }
      for (const [i, entry] of louvers.entries()) {
        const louvre = entry || {}
        const note = `Louvre #${i + 1}`
        if (louvre.control_type === 'other') {
          outputsUnknown = true
          warnings.push({ greenhouse, code: 'louver_call_client', message: `${note} : type de commande « Autre / Je ne sais pas » — appeler le client pour préciser la commande.` })
          continue
        }
        if (!['110', '24', '12'].includes(louvre.voltage) || !['spring_loaded', 'open_close'].includes(louvre.control_type) || typeof louvre.has_fan !== 'boolean') {
          outputsUnknown = true
          warnings.push({ greenhouse, code: 'louver_review', message: `${note} : voltage ou commande à vérifier${louvre.voltage_other ? ` (${louvre.voltage_other})` : ''}.` })
          continue
        }
        const type = louvre.control_type === 'open_close' ? 'louver_open_close' : louvre.has_fan ? 'louver_with_fan' : 'louver_spring_loaded'
        if (type === 'louver_open_close' && louvre.voltage === '110') {
          outputsUnknown = true
          warnings.push({ greenhouse, code: 'louver_review', message: `${note} : la commande ouvrir/fermer en 110 V n’est pas proposée par Orisha. Configuration à vérifier.` })
          continue
        }
        if (type === 'louver_with_fan' && louvre.voltage === '12') {
          outputsUnknown = true
          warnings.push({ greenhouse, code: 'louver_review', message: `${note} : Louvre spring loaded + ventilateur · 12 V n’est pas proposé par Orisha. Configuration à vérifier.` })
          continue
        }
        addControlled(`${type}_${louvre.voltage}`, 1, type, note)
        if (louvre.control_type === 'open_close' && louvre.has_fan) {
          outputsUnknown = true
          warnings.push({ greenhouse, code: 'louver_review', message: `${note} : le contrôle séparé du ventilateur associé à une louvre open/close n’est pas proposé par Orisha. Configuration à vérifier.` })
        }
      }
    }
    if (options.humidity_retention) {
      if (g.humidity_valve === true) addControlled('humidity_valve', 1)
      const qty = Number(g.humidity_haf_count)
      if (g.humidity_haf === true && Number.isInteger(qty) && qty > 0 && qty <= 100) addControlled('humidity_haf', qty)
    }

    if (g.has_side_vents) {
      if (Number(g.length) > 200) {
        add(items, 'side_vent_controller_24v', motors, greenhouse)
        slots += motors * 2
      } else add(items, 'side_vent_module', Math.ceil(motors / 2), greenhouse)
      // Le filage moteur est toujours un câble continu de 25 pi / serre.
      if (motors) add(items, 'motor_wire_25', 1, greenhouse, 'Filage moteurs')
    }

    if (!outputsUnknown) add(items, 'activation_v2', Math.ceil(slots / 4), greenhouse, `${slots} sorties`)
    // Le ventilateur est existant : boîte seulement, jamais ventilateur ni filage.
    if (fans === 1) add(items, 'fan_box_110v', 1, greenhouse)
    if (fans === 2) add(items, 'fan_box_110v', Number(g.fans_combined_hp) <= 1 ? 1 : 2, greenhouse)

    if (valves && g.needs_orisha_valves) add(items, 'valve', valves, greenhouse)
    if (valves) continuousWire(items, g.valve_control_wire_feet, greenhouse, 'valve')
    for (const furnace of furnaces) {
      continuousWire(items, furnace.control_wire_feet, greenhouse, 'furnace')
      if (furnace.backup_thermostat === false) {
        add(items, 'backup_thermostat', 1, greenhouse)
        add(items, 'thermostat_wire', 1, greenhouse)
      }
    }
    perGreenhouse.push({ greenhouse, slots: outputsUnknown ? null : slots, activation_modules: outputsUnknown ? null : Math.ceil(slots / 4), items })
  }
  const siteItems = []
  const orderNotes = []
  if (response?.is_new_site === 'add_to_existing') {
    if (response.within_central_controller_range === false) {
      add(siteItems, 'central_controller', 1, null)
      orderNotes.push('Les contrôleurs centraux de ce client doivent être programmés en mode multi-contrôleurs.')
    } else if (response.within_central_controller_range !== true && !options.mobile_controller) {
      // Question non posée quand un contrôleur internet mobile est à la commande.
      warnings.push({ greenhouse: null, code: 'controller_distance_missing', message: 'Indiquez si les serres seront situées à 250 pi ou moins du contrôleur central.' })
    }
  }
  if (options.mobile_controller || (response?.is_new_site !== 'add_to_existing' && response?.network_access === 'mobile_controller')) add(siteItems, 'mobile_controller', 1, null)
  for (const role of SENSOR_ROLES) add(siteItems, role, options.sensors[role], null)
  const items = [...perGreenhouse.flatMap(x => x.items), ...siteItems]
  const products = Object.entries(rules?.products || {})
    .filter(([, id]) => typeof id === 'string' && id)
    .reduce((acc, [role, product_id]) => ({ ...acc, [role]: product_id }), {})
  const orderItems = items.filter(i => products[i.role]).map(i => ({ ...i, product_id: products[i.role] }))
  const unconfigured = [...new Set(items.filter(i => !products[i.role]).map(i => i.role))]
  if (unconfigured.includes('central_controller')) {
    warnings.push({ greenhouse: null, code: 'central_controller_missing', message: 'Associez le produit Contrôleur central dans le Form builder avant de créer la commande.' })
  }
  return { greenhouses: perGreenhouse, siteItems, items, orderItems, orderNotes, unconfigured, warnings, calculationComplete: warnings.length === 0 }
}
