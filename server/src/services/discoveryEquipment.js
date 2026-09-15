import { normalizeDiscoveryOptions, SENSOR_ROLES } from './discoveryFormOptions.js'
import { JWT_ROLES } from '../../../client/src/lib/discoveryEquipmentCatalog.js'

// Règles de dimensionnement du System Builder. Délibérément sans DB : elles
// restent testables et ne permettent jamais de mutualiser un module entre deux
// serres.

export const OUTPUT_ROLES = ['louver_spring_loaded', 'louver_open_close', 'louver_with_fan', 'humidity_valve', 'humidity_haf']
export const EQUIPMENT_ROLES = [
  ...JWT_ROLES,
  ...['110', '24', '12'].flatMap(v => ['louver_spring_loaded', ...(v === '110' ? ['louver_with_fan'] : ['louver_open_close'])].map(type => `${type}_${v}`)),
  'humidity_valve', 'humidity_haf',
  'activation_v2', 'side_vent_module', 'side_vent_controller_24v',
  'fan_box_110v', 'valve', 'mobile_controller_ca', 'mobile_controller_us', 'central_controller', ...SENSOR_ROLES,
  ...['motor', 'furnace', 'valve'].flatMap(device => (device === 'valve' ? [15, 25, 'per_foot'] : [25, 50, 75, 100, 'per_foot']).map(length => `${device}_wire_${length}`)), 'valve_wire_nuts', 'backup_thermostat', 'thermostat_wire',
]

// Le contrôleur Internet mobile se décline en deux produits (modem + forfait
// cellulaire par pays). Le rôle est choisi sur l'adresse de livraison, à défaut
// celle de la ferme ; tout ce qui n'est pas les États-Unis reste le produit CA.
const US_COUNTRIES = new Set(['us', 'usa', 'u s a', 'united states', 'united states of america', 'etats unis', 'etats unis d amerique'])
export function mobileControllerRole(country) {
  const norm = String(country || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]+/g, ' ').trim()
  return US_COUNTRIES.has(norm) ? 'mobile_controller_us' : 'mobile_controller_ca'
}
function responseCountry(response) {
  const addr = response?.shipping_same_as_farm === true ? response?.farm_address : (response?.shipping_address || response?.farm_address)
  return addr?.country || response?.farm_address?.country || null
}
// Repli sur l'ancien rôle unique tant que les deux produits par pays ne sont pas
// associés dans l'éditeur de formulaire.
const LEGACY_PRODUCT_ROLE = { mobile_controller_ca: 'mobile_controller', mobile_controller_us: 'mobile_controller' }

function add(items, role, qty, greenhouse, note = '') {
  if (!qty) return
  items.push({ role, qty, greenhouse, note })
}

function continuousWire(items, feet, greenhouse, device, quantity = 1) {
  const n = Math.max(0, Number(feet) || 0)
  if (!n) return
  const preset = (device === 'valve' ? [15, 25] : [25, 50, 75, 100]).find(x => x === n)
  add(items, preset ? `${device}_wire_${preset}` : `${device}_wire_per_foot`, (n === preset ? 1 : n) * quantity, greenhouse)
  if (device === 'valve' && !preset) add(items, 'valve_wire_nuts', 2 * quantity, greenhouse)
}

// Libellé d'une ligne de commande regroupée : « Serre #1 · Louvre #1, Louvre #2 ;
// Serre #2 · Louvre #1 ». Les provenances sans note se réduisent à leur en-tête.
function orderLineLabel(sources) {
  const groups = []
  for (const source of sources) {
    const head = source.greenhouse ? `Serre #${source.greenhouse}` : 'Site'
    let group = groups.find(g => g.head === head)
    if (!group) groups.push(group = { head, notes: [] })
    if (source.note && !group.notes.includes(source.note)) group.notes.push(source.note)
  }
  return groups.map(g => (g.notes.length ? `${g.head} · ${g.notes.join(', ')}` : g.head)).join(' ; ')
}

// Une serre de niveau Helper n'automatise que ses côtés ouvrants : ventilateurs,
// louvres, humidité, fournaises et valves ne lui sont ni demandés (le formulaire
// public ne pose pas ces questions), ni dimensionnés ici.
export function greenhouseSideVentsOnly(greenhouse, response) {
  return (greenhouse?.permission_level || response?.permission_level) === 'helper'
}

export function calculateDiscoveryEquipment(response, rules = {}) {
  const options = normalizeDiscoveryOptions(response?.form_options)
  const warnings = []
  const perGreenhouse = []
  for (const [index, g] of (response?.greenhouses || []).entries()) {
    const greenhouse = index + 1
    const helperOnly = greenhouseSideVentsOnly(g, response)
    const furnaces = helperOnly ? [] : (Array.isArray(g.furnaces) ? g.furnaces : [])
    const valves = helperOnly ? 0 : Math.max(0, Number(g.irrigation_zones) || 0)
    const fans = helperOnly ? 0 : Math.min(2, Math.max(0, Number(g.num_fans) || 0))
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
    if (g.has_louvers && !helperOnly) {
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
        if (type === 'louver_with_fan' && louvre.voltage !== '110') {
          outputsUnknown = true
          warnings.push({ greenhouse, code: 'louver_review', message: `${note} : Louvre spring loaded + ventilateur · ${louvre.voltage} V n’est pas proposé par Orisha. Configuration à vérifier.` })
          continue
        }
        addControlled(`${type}_${louvre.voltage}`, 1, type, note)
        if (louvre.control_type === 'open_close' && louvre.has_fan) {
          outputsUnknown = true
          warnings.push({ greenhouse, code: 'louver_review', message: `${note} : le contrôle séparé du ventilateur associé à une louvre open/close n’est pas proposé par Orisha. Configuration à vérifier.` })
        }
      }
    }
    if (options.humidity_retention && !helperOnly) {
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
    // La réponse est une plage (« 1 HP et moins » / « plus de 1 HP ») ; les
    // réponses d'avant ne portent que le nombre exact, qui la donne encore.
    if (fans === 2) {
      const upToOneHp = g.fans_hp_range ? g.fans_hp_range === 'up_to_1' : Number(g.fans_combined_hp) <= 1
      add(items, 'fan_box_110v', upToOneHp ? 1 : 2, greenhouse)
    }

    if (valves && g.needs_orisha_valves) add(items, 'valve', valves, greenhouse)
    // La longueur demandée s'applique à chaque valve de la serre.
    if (valves) continuousWire(items, g.valve_control_wire_feet, greenhouse, 'valve', valves)
    for (const furnace of furnaces) {
      continuousWire(items, furnace.control_wire_feet, greenhouse, 'furnace')
      if (furnace.backup_thermostat === false) {
        add(items, 'backup_thermostat', 1, greenhouse)
        add(items, 'thermostat_wire', 1, greenhouse)
      }
    }
    // Permissions par fonction et par serre, indépendantes du nombre
    // d'appareils et des sorties V2. La ventilation avancée est partagée.
    if (!helperOnly) {
      const note = 'JWT à programmer dans le contrôleur central au montage'
      if (valves) add(items, 'jwt_irrigation', 1, greenhouse, note)
      if (furnaces.length) add(items, 'jwt_heating', 1, greenhouse, note)
      if (g.has_louvers || fans || g.has_roof_vents === true) add(items, 'jwt_advanced_ventilation', 1, greenhouse, note)
      if (options.humidity_retention) add(items, 'jwt_humidity_conservation', 1, greenhouse, note)
      if ((g.permission_level || response?.permission_level) === 'chief_grower') add(items, 'jwt_disease_prevention', 1, greenhouse, note)
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
  if (options.mobile_controller || (response?.is_new_site !== 'add_to_existing' && response?.network_access === 'mobile_controller')) add(siteItems, mobileControllerRole(responseCountry(response)), 1, null)
  for (const role of SENSOR_ROLES) add(siteItems, role, options.sensors[role], null)
  const items = [...perGreenhouse.flatMap(x => x.items), ...siteItems]
  const products = Object.entries(rules?.products || {})
    .filter(([, id]) => typeof id === 'string' && id)
    .reduce((acc, [role, product_id]) => ({ ...acc, [role]: product_id }), {})
  const productFor = role => products[role] || products[LEGACY_PRODUCT_ROLE[role]] || null
  // Une ligne de commande par produit : trois louvres identiques donnent qty 3,
  // pas trois lignes de 1. La provenance (serre, n° de louvre) survit dans le
  // libellé, le détail par serre reste dans `greenhouses[].items`.
  const orderItems = []
  const byProduct = new Map()
  for (const item of items) {
    const product_id = productFor(item.role)
    if (!product_id) continue
    const line = byProduct.get(product_id)
    if (line) {
      line.qty += item.qty
      line.sources.push(item)
      if (line.greenhouse !== item.greenhouse) line.greenhouse = null
    } else {
      const fresh = { role: item.role, qty: item.qty, greenhouse: item.greenhouse, product_id, sources: [item] }
      byProduct.set(product_id, fresh)
      orderItems.push(fresh)
    }
  }
  for (const line of orderItems) line.label = orderLineLabel(line.sources)
  const unconfigured = [...new Set(items.filter(i => !productFor(i.role)).map(i => i.role))]
  if (unconfigured.includes('central_controller')) {
    warnings.push({ greenhouse: null, code: 'central_controller_missing', message: 'Associez le produit Contrôleur central dans le Form builder avant de créer la commande.' })
  }
  return { greenhouses: perGreenhouse, siteItems, items, orderItems, orderNotes, unconfigured, warnings, calculationComplete: warnings.length === 0 }
}
