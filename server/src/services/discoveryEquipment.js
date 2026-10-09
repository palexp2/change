import { normalizeDiscoveryOptions, greenhouseLimits, greenhouseMaterials, greenhouseSensors, greenhouseHasTempSensor, MATERIAL_KEYS, SENSOR_ROLES, GREENHOUSE_SENSOR_KEYS } from './discoveryFormOptions.js'
import { JWT_ROLES, EQUIPMENT_LABELS, INVERTER_EXTRA_ROLES, inverterExtraRole } from '../../../client/src/lib/discoveryEquipmentCatalog.js'
import { roofVentAnswers, thermalScreen } from '../../../client/src/lib/discoveryRoofs.js'
import { sideVentOther } from '../../../client/src/lib/discoveryFormSchema.js'

// Règles de dimensionnement du System Builder. Délibérément sans DB : elles
// restent testables et ne permettent jamais de mutualiser un module entre deux
// serres.

// Capteurs logés dans le boîtier météo (la sonde de sol va en serre).
const WEATHER_SENSOR_ROLES = ['outdoor_temperature_sensor', 'solar_sensor', 'rain_sensor', 'wind_sensor']

export const OUTPUT_ROLES =['louver_spring_loaded', 'louver_open_close', 'louver_with_fan']
export const EQUIPMENT_ROLES = [
  ...JWT_ROLES,
  ...['110', '24', '12'].flatMap(v => ['louver_spring_loaded', ...(v === '110' ? ['louver_with_fan'] : ['louver_open_close'])].map(type => `${type}_${v}`)), 'louver_time_delay_box',
  'humidity_valve', 'humidity_haf',
  'activation_v2', 'side_vent_module', 'side_vent_controller_24v', 'side_vent_motor_left', 'side_vent_motor_right', 'side_pipe_adapter', 'guide_pipe', 'guide_pipe_hanging_kit', 'roof_inverter_ridder', 'roof_inverter_wire', 'side_inverter_wire',
  'fan_box_110v', 'valve', 'mobile_controller_ca', 'mobile_controller_us', 'central_controller', 'coax_antenna_kit', ...SENSOR_ROLES, ...GREENHOUSE_SENSOR_KEYS, 'weather_box', 'temp_humidity_sensor', ...INVERTER_EXTRA_ROLES,
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
// associés dans l'éditeur de formulaire. Filage d'inverseur de côté : même câble
// inverseur → module que celui des toits, tant qu'aucun produit propre n'est associé.
const LEGACY_PRODUCT_ROLE = { mobile_controller_ca: 'mobile_controller', mobile_controller_us: 'mobile_controller', side_inverter_wire: 'roof_inverter_wire' }

export const MANUAL_ROLE = 'product:'

function add(items, role, qty, greenhouse, note = '') {
  if (!qty) return
  items.push({ role, qty, greenhouse, note })
}

function continuousWire(items, feet, greenhouse, device, quantity = 1) {
  const n = Math.max(0, Number(feet) || 0)
  if (!n) return
  const preset = (device === 'valve' ? [15, 25] : [25, 50, 75, 100]).find(x => x === n)
  // Au pied : une entrée (et une ligne de commande) par appareil, de la
  // longueur demandée — pas une seule ligne du total.
  if (preset) add(items, `${device}_wire_${preset}`, quantity, greenhouse)
  else for (let k = 0; k < quantity; k++) add(items, `${device}_wire_per_foot`, n, greenhouse)
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
// louvres ne lui sont jamais demandés. Fournaises, valves et toits
// seulement si Orisha lui a donné une permission supplémentaire.
export function greenhouseSideVentsOnly(greenhouse, response) {
  return (greenhouse?.permission_level || response?.permission_level) === 'helper'
}

export function hasChiefGrower(response) {
  return (response?.greenhouses || []).some(g => (g.permission_level || response?.permission_level) === 'chief_grower')
}

export function calculateDiscoveryEquipment(response, rules = {}) {
  const options = normalizeDiscoveryOptions(response?.form_options)
  const products = Object.entries(rules?.products || {})
    .filter(([, id]) => typeof id === 'string' && id)
    .reduce((acc, [role, product_id]) => ({ ...acc, [role]: product_id }), {})
  // `product:<id>` : produit choisi à la main sur la fiche (côté ouvrant « Autre »).
  const productFor = role => (role.startsWith(MANUAL_ROLE) ? role.slice(MANUAL_ROLE.length) : products[role] || products[LEGACY_PRODUCT_ROLE[role]] || null)
  // Inverseur déjà chez le client : le produit associé à son modèle, un par
  // inverseur. Rien n'est associé → rien à envoyer, sans avertissement.
  function addInverterExtras(items, kind, model, qty, greenhouse, note) {
    if (!model) return
    const role = inverterExtraRole(kind, String(model))
    if (productFor(role)) add(items, role, qty, greenhouse, note)
  }
  const warnings = []
  const perGreenhouse = []
  for (const [index, g] of (response?.greenhouses || []).entries()) {
    const greenhouse = index + 1
    const helperOnly = greenhouseSideVentsOnly(g, response)
    const limits = greenhouseLimits(options, index, g.permission_level || response?.permission_level)
    const furnaces = limits.furnaces ? (Array.isArray(g.furnaces) ? g.furnaces : []) : []
    const valves = limits.valves ? Math.max(0, Number(g.irrigation_zones) || 0) : 0
    const fans = helperOnly ? 0 : Math.min(limits.fans, Math.max(0, Number(g.num_fans) || 0))
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
    // Toiles thermiques (permission seulement) : mêmes réponses, même matériel,
    // rangées dans `thermal_screen`.
    const screen = thermalScreen(g)
    const screens = limits.screens && screen.has_roof_vents === true ? Math.max(1, Number(screen.num_roof_vents) || 0) : 0
    // Par toit : inverseur du client (déjà là, ou à fournir par lui pour un
    // 110 V / 240 V autre que Ridder) → 2 sorties + filage vers le module ;
    // moteur 24 V DC sans inverseur → contrôleur 24 V (2 sorties) ; Ridder
    // RW240 sans inverseur → inverseur Orisha + 2 sorties + filage.
    // Chaque toit a ses propres réponses (voir `roofVentAnswers`).
    for (const [total, rec, one, many, what] of [[roofs, g, 'Toit ouvrant', 'Toits ouvrants', 'toit(s) ouvrant(s)'], [screens, screen, 'Toile thermique', 'Toiles thermiques', 'toile(s) thermique(s)']]) {
      if (!total) continue
      const answers = roofVentAnswers({ ...rec, num_roof_vents: total }, { legacy: rec === g })
      let unknownRoofs = 0
      for (const [i, r] of answers.entries()) {
        const note = total > 1 ? `${one} #${i + 1}` : many
        const v = r.roof_motor_voltage
        const ridder = v === '240' && r.roof_motor_ridder_rw240 === true
        if (r.has_roof_inverter === true || (r.has_roof_inverter === false && (v === '110' || (v === '240' && r.roof_motor_ridder_rw240 === false)))) {
          useSlots(`${one} · inverseur`, 1, 2)
          add(items, 'roof_inverter_wire', 1, greenhouse, note)
          if (r.has_roof_inverter === true) addInverterExtras(items, 'roof', r.roof_inverter_type, 1, greenhouse, note)
        } else if (r.has_roof_inverter === false && v === '24_dc') {
          add(items, 'side_vent_controller_24v', 1, greenhouse, note)
          useSlots(`${one} · contrôleur 24 VDC`, 1, 2)
        } else if (r.has_roof_inverter === false && ridder) {
          add(items, 'roof_inverter_ridder', 1, greenhouse, total > 1 || rec !== g ? note : '')
          add(items, 'roof_inverter_wire', 1, greenhouse, note)
          useSlots(`${one} · inverseur Ridder`, 1, 2)
        } else unknownRoofs++
      }
      if (unknownRoofs) {
        outputsUnknown = true
        warnings.push({ greenhouse, code: rec === g ? 'roof_review' : 'screen_review', message: `${unknownRoofs} ${what} : moteur ou inverseur non précisé, à vérifier avant de créer la commande.` })
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
        // 24 V + ventilateur : boîtier de louvre avec time delay, en plus du boîtier 24 V.
        if (type === 'louver_open_close' && louvre.has_fan && louvre.voltage === '24') add(items, 'louver_time_delay_box', 1, greenhouse, note)
        else if (louvre.control_type === 'open_close' && louvre.has_fan) {
          outputsUnknown = true
          warnings.push({ greenhouse, code: 'louver_review', message: `${note} : le contrôle séparé du ventilateur associé à une louvre open/close n’est pas proposé par Orisha. Configuration à vérifier.` })
        }
      }
    }
    // Matériel coché par Orisha : une sortie V2 chacun. HAF du client : un seul
    // boîtier 110 V, peu importe leur nombre.
    const materials = greenhouseMaterials(options, index)
    for (const role of MATERIAL_KEYS) {
      if (!materials[role]) continue
      add(items, role, 1, greenhouse)
      useSlots(EQUIPMENT_LABELS[role], 1, 1)
    }

    if (sideVentOther(g)) {
      // Côté ouvrant « Autre » : rien n'est déduit. Orisha choisit sur la fiche
      // le matériel à envoyer et les sorties V2 qu'il prend ; sans ce nombre,
      // la commande attend.
      const manual = g.side_vent_manual || {}
      for (const it of Array.isArray(manual.items) ? manual.items : []) {
        if (it?.product_id) add(items, `${MANUAL_ROLE}${it.product_id}`, Math.max(0, Number(it.qty) || 0), greenhouse, 'Côtés ouvrants')
      }
      const manualSlots = manual.slots === '' || manual.slots == null ? NaN : Number(manual.slots)
      if (Number.isInteger(manualSlots) && manualSlots >= 0) useSlots('Côtés ouvrants · autre', 1, manualSlots)
      else {
        outputsUnknown = true
        warnings.push({ greenhouse, code: 'side_vent_manual', message: 'Côtés ouvrants « Autre » : choisissez le matériel à envoyer et le nombre de sorties V2.' })
      }
    } else if (g.has_side_vents) {
      // Moteurs du client déjà en place avec inverseurs : chaque inverseur prend
      // 2 sorties d'un module d'activation. Sans inverseur, règle habituelle :
      // contrôleur 24 V par moteur au-delà de 200 pi, sinon un module pour 2 moteurs.
      // Avec inverseurs : un fil par inverseur, jamais le filage moteur.
      const sideInverters = g.has_existing_side_vent_motors === true && g.side_has_inverters === true
      if (sideInverters) {
        const inverters = g.side_inverter_ratio === 'per_two' ? Math.ceil(motors / 2) : motors
        useSlots('Inverseur côtés ouvrants', inverters, 2)
        add(items, 'side_inverter_wire', inverters, greenhouse, 'Côtés ouvrants')
        addInverterExtras(items, 'side', g.side_inverter_model, inverters, greenhouse, 'Côtés ouvrants')
      } else if (Number(g.length) > 200) {
        add(items, 'side_vent_controller_24v', motors, greenhouse)
        useSlots('Côté ouvrant · contrôleur 24 VDC', motors, 2)
      } else add(items, 'side_vent_module', Math.ceil(motors / 2), greenhouse)
      // Le filage moteur est toujours un câble continu de 25 pi / serre.
      if (motors && !sideInverters) add(items, 'motor_wire_25', 1, greenhouse, 'Filage moteurs')
      // Client sans moteurs : un moteur par côté, gauche et droit en alternance
      // (le formulaire ne dit pas de quel côté est un moteur seul : gauche).
      // Sans tuyaux guides : un tuyau et un kit de suspension par côté.
      if (g.has_existing_side_vent_motors === false) {
        add(items, 'side_vent_motor_left', Math.ceil(motors / 2), greenhouse)
        add(items, 'side_vent_motor_right', Math.floor(motors / 2), greenhouse)
        // Tuyau d'acier entre 1 5/16 et 1 1/2 po : un adaptateur par moteur.
        if (g.side_pipe_diameter === '1 1/2"') add(items, 'side_pipe_adapter', motors, greenhouse, 'Tuyau 1 5/16 à 1 1/2 po')
      }
      // Moteurs déjà en place : leurs tuyaux guides aussi (la question n'est plus posée).
      if (g.has_existing_side_vent_motors !== true && g.guide_pipes_state === 'needed') {
        add(items, 'guide_pipe', motors, greenhouse)
        add(items, 'guide_pipe_hanging_kit', motors, greenhouse)
      } else if (g.has_existing_side_vent_motors !== true && g.guide_pipes_state === 'unknown') {
        warnings.push({ greenhouse, code: 'guide_pipes_call_client', message: 'Tuyaux guides « Je ne sais pas » — appeler le client pour savoir s’il faut les fournir.' })
      }
    }

    // Sorties incomplètes : on montre quand même le minimum pour les sorties
    // connues (la commande reste bloquée par l'avertissement).
    const partial = outputsUnknown && slots > 0
    const known = !outputsUnknown || partial
    if (known) add(items, 'activation_v2', Math.ceil(slots / 4), greenhouse, partial ? `${slots} sorties connues, minimum` : `${slots} sorties`)
    // Le ventilateur est existant : boîte seulement, jamais ventilateur ni filage.
    if (fans === 1) add(items, 'fan_box_110v', 1, greenhouse)
    // La réponse est une plage (« 1 HP et moins » / « plus de 1 HP ») ; les
    // réponses d'avant ne portent que le nombre exact, qui la donne encore.
    if (fans === 2) {
      const upToOneHp = g.fans_hp_range ? g.fans_hp_range === 'up_to_1' : Number(g.fans_combined_hp) <= 1
      add(items, 'fan_box_110v', upToOneHp ? 1 : 2, greenhouse)
    }
    // Permission Ventilation (3 ou 4 ventilateurs) : une boîte par ventilateur.
    if (fans > 2) add(items, 'fan_box_110v', fans, greenhouse)

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
      if (materials.humidity_valve || materials.humidity_haf) add(items, 'jwt_humidity_conservation', 1, greenhouse, note)
      if ((g.permission_level || response?.permission_level) === 'chief_grower') add(items, 'jwt_disease_prevention', 1, greenhouse, note)
    }
    // Un capteur de température et d'humidité par serre, Helper comme Chef de
    // culture — remplacé (pas doublé) par le capteur avancé s'il est choisi,
    // omis si la serre a déjà sa sonde.
    const sensors = greenhouseSensors(options, index)
    if (['helper', 'chief_grower'].includes(g.permission_level || response?.permission_level) && !sensors.includes('advanced_temperature_sensor') && !greenhouseHasTempSensor(options, index)) add(items, 'temp_humidity_sensor', 1, greenhouse)
    for (const role of sensors) add(items, role, 1, greenhouse)
    perGreenhouse.push({ greenhouse, slots: known ? slots : null, activation_modules: known ? Math.ceil(slots / 4) : null, slots_partial: partial, slot_sources: known ? slotSources : [], items })
  }
  const siteItems = []
  const orderNotes = []
  // Serres à plus de 350 pi du contrôleur existant : un nouveau contrôleur, et
  // la question de l'accès réseau posée comme à un nouveau site.
  const farFromExisting = response?.is_new_site === 'add_to_existing' && response.within_central_controller_range === false
  const asksNetwork = response?.is_new_site === 'new' || farFromExisting
  const mobile = options.mobile_controller || (response?.is_new_site !== 'add_to_existing' && response?.network_access === 'mobile_controller')
    || (farFromExisting && response.network_access === 'mobile_controller')
  if (response?.is_new_site === 'add_to_existing') {
    if (farFromExisting) {
      if (!mobile) add(siteItems, 'central_controller', 1, null)
      orderNotes.push('Les contrôleurs centraux de ce client doivent être programmés en mode multi-contrôleurs.')
    } else if (response.within_central_controller_range !== true && !options.mobile_controller) {
      // Question non posée quand un contrôleur internet mobile est à la commande.
      warnings.push({ greenhouse: null, code: 'controller_distance_missing', message: 'Indiquez si les serres seront situées à 250 pi ou moins du contrôleur central.' })
    }
  }
  if (mobile) add(siteItems, mobileControllerRole(responseCountry(response)), options.mobile_controllers || 1, null)
  // Nouveau site : un contrôleur central, sauf si le contrôleur Internet mobile
  // en tient lieu ; Wi-Fi à 350 pi : antenne et câble coaxial promis au client.
  if (response?.is_new_site === 'new' && !mobile) add(siteItems, 'central_controller', 1, null)
  if (asksNetwork && response.network_access === 'wifi_350_coax') add(siteItems, 'coax_antenna_kit', 1, null)
  if (options.extra_central_controllers) {
    add(siteItems, 'central_controller', options.extra_central_controllers, null, 'Contrôleur additionnel')
    const note = 'Les contrôleurs centraux de ce client doivent être programmés en mode multi-contrôleurs.'
    if (!orderNotes.includes(note)) orderNotes.push(note)
  }
  for (const role of SENSOR_ROLES) add(siteItems, role, options.sensors[role], null)
  // Au moins une serre Chef de culture : un capteur de vent et un boîtier météo
  // pour le site, en plus des capteurs achetés. Site existant : le capteur de
  // vent seulement si le client a répondu qu'il en a besoin (ou n'a pas répondu).
  // Le boîtier météo n'accompagne qu'au moins un capteur météo envoyé.
  if (hasChiefGrower(response)) {
    if (!(response.is_new_site === 'add_to_existing' && response.needs_wind_sensor === false)) add(siteItems, 'wind_sensor', 1, null, 'Chef de culture')
    if (siteItems.some(i => WEATHER_SENSOR_ROLES.includes(i.role))) add(siteItems, 'weather_box', 1, null, 'Chef de culture')
  }
  const items = [...perGreenhouse.flatMap(x => x.items), ...siteItems]
  // Une ligne de commande par produit : trois louvres identiques donnent qty 3,
  // pas trois lignes de 1. La provenance (serre, n° de louvre) survit dans le
  // libellé, le détail par serre reste dans `greenhouses[].items`.
  const orderItems = []
  const byProduct = new Map()
  for (const item of items) {
    const product_id = productFor(item.role)
    if (!product_id) continue
    const line = item.role.endsWith('_wire_per_foot') ? null : byProduct.get(product_id)
    if (line) {
      line.qty += item.qty
      line.sources.push(item)
      if (line.greenhouse !== item.greenhouse) line.greenhouse = null
    } else {
      const fresh = { role: item.role, qty: item.qty, greenhouse: item.greenhouse, product_id, sources: [item] }
      if (!item.role.endsWith('_wire_per_foot')) byProduct.set(product_id, fresh)
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
