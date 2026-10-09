export const SENSOR_PRODUCTS = [
  ['soil_temperature_sensor', 'Capteur de température du sol'],
  ['outdoor_temperature_sensor', 'Capteur de température extérieure'],
  ['solar_sensor', 'Capteur solaire'],
  ['rain_sensor', 'Capteur de pluie'],
  ['wind_sensor', 'Capteur de vent'],
]
export const JWT_PRODUCTS = [
  ['jwt_irrigation', 'JWT · Irrigation'],
  ['jwt_heating', 'JWT · Chauffage'],
  ['jwt_advanced_ventilation', 'JWT · Louvres, ventilateurs et toits ouvrants'],
  ['jwt_humidity_conservation', 'JWT · Conservation de l’humidité'],
  ['jwt_disease_prevention', 'JWT · Prévention des maladies'],
]
export const JWT_ROLES = JWT_PRODUCTS.map(([role]) => role)
export const isJwtProduct = product => String(product?.type || '').trim().toUpperCase() === 'JWT'
const wireProducts = ['motor', 'furnace', 'valve'].flatMap((device, i) =>
  (device === 'motor' ? [25] : device === 'valve' ? [15, 25, 'per_foot'] : [25, 50, 75, 100, 'per_foot']).map(length => [`${device}_wire_${length}`, `Filage ${['moteur', 'fournaise', 'valve'][i]} · ${length === 'per_foot' ? (device === 'valve' ? 'longueur personnalisée (au pied)' : 'au pied') : `${length} pi`}`]))
// Inverseur que le client a déjà : le produit à envoyer en plus selon son modèle
// (clé = réponse du formulaire). Aucun produit choisi → rien n'est ajouté.
export const INVERTER_MODELS = [
  ['roof', 'harnois_8ze141l', 'Toit · Harnois 8ZE141L'], ['roof', 'vre_mc21', 'Toit · VRE MC21'],
  ['side', '8ZE133L', 'Côtés · 8ZE133L'], ['side', '8ZE133LDC', 'Côtés · 8ZE133LDC'],
]
// Modèle qui reçoit exactement les produits d'un autre.
const INVERTER_MODEL_ALIASES = { roof: { harnois_8ze142l: 'harnois_8ze141l' } }
// Suffixe « _1 » gardé : c'est la clé des associations déjà enregistrées.
export const inverterExtraRole = (kind, model) => `inverter_extra_${kind}_${(INVERTER_MODEL_ALIASES[kind]?.[model.toLowerCase()] || model).toLowerCase()}_1`
const inverterExtraProducts = INVERTER_MODELS.map(([kind, model, label]) => [inverterExtraRole(kind, model), label])
export const INVERTER_EXTRA_ROLES = inverterExtraProducts.map(([role]) => role)
export const EQUIPMENT_PRODUCT_GROUPS = [
  { label: 'Permissions JWT', products: JWT_PRODUCTS, productType: 'JWT', help: 'Une permission par fonction et par serre, à programmer dans le contrôleur central au montage. Prévention des maladies incluse en Chef de culture, exclue en Helper.' },
  { label: 'Contrôle et accessoires', products: [
    ['activation_v2', 'Module d’activation V2'], ['side_vent_module', 'Module côtés ouvrants'],
    ['side_vent_controller_24v', 'Contrôleur côtés 24 VDC'], ['side_vent_motor_left', 'Moteur côté ouvrant · gauche'], ['side_vent_motor_right', 'Moteur côté ouvrant · droit'],
    ['side_pipe_adapter', 'Adaptateur tuyau de côté 1 5/16 à 1 1/2 po'],
    ['guide_pipe', 'Tuyau guide'], ['guide_pipe_hanging_kit', 'Guide pipe hanging kit'], ['fan_box_110v', 'Boîtier 110 V ventilateur'],
    ['roof_inverter_ridder', 'Inverseur pour moteur de toit Ridder RW240'], ['roof_inverter_wire', 'Filage inverseur de toit → module d’activation'],
    ['side_inverter_wire', 'Filage inverseur de côté → module d’activation'],
    ['valve', 'Valve d’irrigation'], ['valve_wire_nuts', 'Marette pour valve (2 unités)'],
    ['backup_thermostat', 'Thermostat de secours'], ['thermostat_wire', 'Filage thermostat'],
    ['mobile_controller_ca', 'Contrôleur Internet mobile · Canada'],
    ['mobile_controller_us', 'Contrôleur Internet mobile · États-Unis'],
    ['central_controller', 'Contrôleur central'],
    ['coax_antenna_kit', 'Antenne + câble coaxial (Wi-Fi à 350 pi)'],
  ] },
  { label: 'Inverseur du client', products: inverterExtraProducts, help: 'Envoyé en plus, un par inverseur.' },
  { label: 'Filage par appareil', products: wireProducts },
  { label: 'Louvres', products: [
    ...['110', '24', '12'].flatMap(voltage => [
      [`louver_spring_loaded_${voltage}`, `Louvre seule spring loaded · ${voltage} V`],
      ...(voltage === '110' ? [] : [[`louver_open_close_${voltage}`, `Louvre seule open/close · ${voltage} V`]]),
      // Louvre + ventilateur : 110 V seulement, les autres voltages ne sont pas proposés.
      ...(voltage === '110' ? [[`louver_with_fan_${voltage}`, `Louvre spring loaded + ventilateur · ${voltage} V`]] : []),
    ]),
    // Louvre open/close 24 V + ventilateur : envoyé en plus du boîtier 24 V.
    ['louver_time_delay_box', 'Boîtier de louvre avec time delay · 24 V + ventilateur'],
  ] },
  { label: 'Brumisation et HAF', products: [['humidity_valve', 'Valve de brumisation'], ['humidity_haf', 'Boîtier 110 V pour HAF']] },
  // Chef de culture : un capteur de vent et un boîtier météo par commande, en plus des capteurs achetés.
  { label: 'Capteurs', products: [...SENSOR_PRODUCTS, ['advanced_temperature_sensor', 'Capteur de température avancé'], ['weather_box', 'Boîtier météo'], ['temp_humidity_sensor', 'Capteur de température et d’humidité']], help: 'Chef de culture : 1 capteur de vent ajouté d’office, + 1 boîtier météo s’il y a au moins un capteur météo. 1 capteur de température et d’humidité par serre (Helper ou Chef de culture), sauf si le capteur avancé le remplace ou si la serre a déjà sa sonde.' },
]
export const EQUIPMENT_PRODUCTS = EQUIPMENT_PRODUCT_GROUPS.flatMap(g => g.products)
export const EQUIPMENT_LABELS = Object.fromEntries(EQUIPMENT_PRODUCTS)

export const EQUIPMENT_OUTPUTS = [
  ['louver_spring_loaded', 'Louvre seule spring loaded'], ['louver_open_close', 'Louvre seule open/close'],
  ['louver_with_fan', 'Louvre spring loaded + ventilateur'],
]
