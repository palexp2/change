import { normalizeDiscoveryOptions, greenhouseLimits, SENSOR_ROLES } from './discoveryFormOptions.js'
import { JWT_ROLES, EQUIPMENT_LABELS } from '../../../client/src/lib/discoveryEquipmentCatalog.js'

// Règles de dimensionnement du System Builder. Délibérément sans DB : elles
// restent testables et ne permettent jamais de mutualiser un module entre deux
// serres.

export const OUTPUT_ROLES = ['louver_spring_loaded', 'louver_open_close', 'louver_with_fan', 'humidity_valve', 'humidity_haf']
export const EQUIPMENT_ROLES = [
  ...JWT_ROLES,
  ...['110', '24', '12'].flatMap(v => ['louver_spring_loaded', ...(v === '110' ? ['louver_with_fan'] : ['louver_open_close'])].map(type => `${type}_${v}`)),
  'humidity_valve', 'humidity_haf',
  'activation_v2', 'side_vent_module', 'side_vent_controller_24v', 'side_vent_motor_left', 'side_vent_motor_right', 'guide_pipe', 'guide_pipe_hanging_kit', 'roof_inverter_ridder', 'roof_inverter_wire',
  'fan_box_110v', 'valve', 'mobile_controller_ca', 'mobile_controller_us', 'central_controller', 'coax_antenna_kit', ...SENSOR_ROLES,
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
// louvres et humidité ne lui sont jamais demandés. Fournaises, valves et toits
// seulement si Orisha lui a donné une permission supplémentaire.
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
    const limits = greenhouseLimits(options, index, g.permission_level || response?.permission_level)
    const furnaces = limits.furnaces ? (Array.isArray(g.furnaces) ? g.furnaces : []) : []
    const valves = limits.valves ? Math.max(0, Number(g.irrigation_zones) || 0) : 0
    const fans = helperOnly ? 0 : Math.min(2, Math.max(0, Number(g.num_fans) || 0))
    const motors = g.has_side_vents ? Math.max(0, Number(g.num_side_vent_motors) || 0) : 0
    let slots = 0
    // Ce qui consomme les sorties V2, pour que l'on puisse recompter les modules.
    const slotSources = []
    function useSlots(label, qty, perUnit) {
      if (!qty || !perUnit) return
      slots += qty * perUnit
      const source = slotSources.find(s => s.label === label)
      if (source) { source.qty += qty; source.slots += qty * perUnit } else slotSources.push({ label, qty, slots: qty * perUnit })
    }
    useSlots('Fournaise', furnaces.length, 1)
    useSlots('Zone d’irrigation', valves, 1)
    useSlots('Ventilateur', fans, 1)
    const items = []
    let outputsUnknown = false
    // Toits ouvrants déclarés par le client.
    const roofs = limits.roofs && g.has_roof_vents === true ? Math.max(1, Number(g.num_roof_vents) || 0) : 0
    // Par toit : inverseur du client (déjà là, ou à fournir par lui pour un
    // 110 V / 240 V autre que Ridder) → 2 sorties + filage vers le module ;
    // moteur 24 V DC sans inverseur → contrôleur 24 V (2 sorties) ; Ridder
    // RW240 sans inverseur → inverseur Orisha + 2 sorties + filage.
    if (roofs) {
      const v = g.roof_motor_voltage
      const ridder = v === '240' && g.roof_motor_ridder_rw240 === true
      if (g.has_roof_inverter === true || (g.has_roof_inverter === false && (v === '110' || (v === '240' && g.roof_motor_ridder_rw240 === false)))) {
        useSlots('Toit ouvrant · inverseur', roofs, 2)
        add(items, 'roof_inverter_wire', roofs, greenhouse, 'Toits ouvrants')
      } else if (g.has_roof_inverter === false && v === '24_dc') {
        add(items, 'side_vent_controller_24v', roofs, greenhouse, 'Toits ouvrants')
        useSlots('Toit ouvrant · contrôleur 24 VDC', roofs, 2)
      } else if (g.has_roof_inverter === false && ridder) {
        add(items, 'roof_inverter_ridder', roofs, greenhouse)
        add(items, 'roof_inverter_wire', roofs, greenhouse, 'Toits ouvrants')
        useSlots('Toit ouvrant · inverseur Ridder', roofs, 2)
      } else {
        outputsUnknown = true
        warnings.push({ greenhouse, code: 'roof_review', message: `${roofs} toit(s) ouvrant(s) : moteur ou inverseur non précisé, à vérifier avant de créer la commande.` })
      }
    }
    function addControlled(role, qty, outputRole = role, note = '') {
      add(items, role, qty, greenhouse, note)
      if (!qty) return
      const configured = rules.outputs?.[outputRole]
      if (!Number.isInteger(configured) || configured < 0 || configured > 8) {
        outputsUnknown = true
        warnings.push({ greenhouse, code: 'outputs_missing', role: outputRole, message: `Nombre de sorties V2 à définir pour ${outputRole}.` })
      } else useSlots(EQUIPMENT_LABELS[role] || role, qty, configured)
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
      // HAF du client : un relais 110 V + ses sorties, peu importe leur nombre.
      if (g.humidity_haf === true) addControlled('humidity_haf', 1)
    }

    if (g.has_side_vents) {
      // Moteurs du client déjà en place avec inverseurs : chaque inverseur prend
      // 2 sorties d'un module d'activation. Sans inverseur, règle habituelle :
      // contrôleur 24 V par moteur au-delà de 200 pi, sinon un module pour 2 moteurs.
      if (g.has_existing_side_vent_motors === true && g.side_has_inverters === true) {
        const inverters = g.side_inverter_ratio === 'per_two' ? Math.ceil(motors / 2) : motors
        useSlots('Inverseur côtés ouvrants', inverters, 2)
      } else if (Number(g.length) > 200) {
        add(items, 'side_vent_controller_24v', motors, greenhouse)
        useSlots('Côté ouvrant · contrôleur 24 VDC', motors, 2)
      } else add(items, 'side_vent_module', Math.ceil(motors / 2), greenhouse)
      // Le filage moteur est toujours un câble continu de 25 pi / serre.
      if (motors) add(items, 'motor_wire_25', 1, greenhouse, 'Filage moteurs')
      // Client sans moteurs : un moteur par côté, gauche et droit en alternance
      // (le formulaire ne dit pas de quel côté est un moteur seul : gauche).
      // Sans tuyaux guides : un tuyau et un kit de suspension par côté.
      if (g.has_existing_side_vent_motors === false) {
        add(items, 'side_vent_motor_left', Math.ceil(motors / 2), greenhouse)
        add(items, 'side_vent_motor_right', Math.floor(motors / 2), greenhouse)
      }
      if (g.guide_pipes_state === 'needed') {
        add(items, 'guide_pipe', motors, greenhouse)
        add(items, 'guide_pipe_hanging_kit', motors, greenhouse)
      }
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

    // Le client dit combien de valves il veut (1 à 4) ; les anciennes réponses n'ont que les zones.
    if (valves && g.needs_orisha_valves) add(items, 'valve', Math.min(valves, Number(g.orisha_valves_count) || valves), greenhouse)
    // La longueur demandée s'applique à chaque valve de la serre.
    if (valves) continuousWire(items, g.valve_control_wire_feet, greenhouse, 'valve', valves)
    for (const furnace of furnaces) {
      continuousWire(items, furnace.control_wire_feet, greenhouse, 'furnace')
      // true = « J’ai besoin d’un thermostat de secours ».
      if (furnace.backup_thermostat === true) {
        add(items, 'backup_thermostat', 1, greenhouse)
        add(items, 'thermostat_wire', 1, greenhouse)
      }
    }
    // Permissions par fonction et par serre, indépendantes du nombre
    // d'appareils et des sorties V2. La ventilation avancée est partagée.
    {
      const note = 'JWT à programmer dans le contrôleur central au montage'
      if (valves) add(items, 'jwt_irrigation', 1, greenhouse, note)
      if (furnaces.length) add(items, 'jwt_heating', 1, greenhouse, note)
      if ((!helperOnly && (g.has_louvers || fans)) || roofs) add(items, 'jwt_advanced_ventilation', 1, greenhouse, note)
      if (options.humidity_retention && !helperOnly) add(items, 'jwt_humidity_conservation', 1, greenhouse, note)
      if ((g.permission_level || response?.permission_level) === 'chief_grower') add(items, 'jwt_disease_prevention', 1, greenhouse, note)
    }
    perGreenhouse.push({ greenhouse, slots: outputsUnknown ? null : slots, activation_modules: outputsUnknown ? null : Math.ceil(slots / 4), slot_sources: outputsUnknown ? [] : slotSources, items })
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
  const mobile = options.mobile_controller || (response?.is_new_site !== 'add_to_existing' && response?.network_access === 'mobile_controller')
  if (mobile) add(siteItems, mobileControllerRole(responseCountry(response)), 1, null)
  // Nouveau site : un contrôleur central, sauf si le contrôleur Internet mobile
  // en tient lieu ; Wi-Fi à 350 pi : antenne et câble coaxial promis au client.
  if (response?.is_new_site === 'new') {
    if (!mobile) add(siteItems, 'central_controller', 1, null)
    if (response.network_access === 'wifi_350_coax') add(siteItems, 'coax_antenna_kit', 1, null)
  }
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
