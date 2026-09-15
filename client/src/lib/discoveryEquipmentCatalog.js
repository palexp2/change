export const SENSOR_PRODUCTS = [
  ['soil_temperature_sensor', 'Capteur de température du sol'],
  ['outdoor_temperature_sensor', 'Capteur de température extérieure'],
  ['advanced_temperature_sensor', 'Capteur de température avancé'],
  ['solar_sensor', 'Capteur solaire'],
  ['rain_sensor', 'Capteur de pluie'],
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
export const EQUIPMENT_PRODUCT_GROUPS = [
  { label: 'Permissions JWT', products: JWT_PRODUCTS, productType: 'JWT', help: 'Une permission par fonction et par serre, à programmer dans le contrôleur central au montage. Prévention des maladies incluse en Chef de culture, exclue en Helper.' },
  { label: 'Contrôle et accessoires', products: [
    ['activation_v2', 'Module d’activation V2'], ['side_vent_module', 'Module côtés ouvrants'],
    ['side_vent_controller_24v', 'Contrôleur côtés 24 VDC'], ['fan_box_110v', 'Boîtier 110 V ventilateur'],
    ['valve', 'Valve d’irrigation'], ['valve_wire_nuts', 'Marette pour valve (2 unités)'],
    ['backup_thermostat', 'Thermostat de secours'], ['thermostat_wire', 'Filage thermostat'],
    ['mobile_controller_ca', 'Contrôleur Internet mobile · Canada'],
    ['mobile_controller_us', 'Contrôleur Internet mobile · États-Unis'],
    ['central_controller', 'Contrôleur central'],
  ] },
  { label: 'Filage par appareil', products: wireProducts },
  { label: 'Louvres', products: [
    ...['110', '24', '12'].flatMap(voltage => [
      [`louver_spring_loaded_${voltage}`, `Louvre seule spring loaded · ${voltage} V`],
      ...(voltage === '110' ? [] : [[`louver_open_close_${voltage}`, `Louvre seule open/close · ${voltage} V`]]),
      // Louvre + ventilateur : 110 V seulement, les autres voltages ne sont pas proposés.
      ...(voltage === '110' ? [[`louver_with_fan_${voltage}`, `Louvre spring loaded + ventilateur · ${voltage} V`]] : []),
    ]),
  ] },
  { label: 'Conservation de l’humidité', products: [['humidity_valve', 'Valve de conservation de l’humidité'], ['humidity_haf', 'HAF de conservation de l’humidité']] },
  { label: 'Capteurs', products: SENSOR_PRODUCTS },
]
export const EQUIPMENT_PRODUCTS = EQUIPMENT_PRODUCT_GROUPS.flatMap(g => g.products)
export const EQUIPMENT_LABELS = Object.fromEntries(EQUIPMENT_PRODUCTS)

export const EQUIPMENT_OUTPUTS = [
  ['louver_spring_loaded', 'Louvre seule spring loaded'], ['louver_open_close', 'Louvre seule open/close'],
  ['louver_with_fan', 'Louvre spring loaded + ventilateur'],
  ['humidity_valve', 'Valve de conservation de l’humidité'], ['humidity_haf', 'HAF de conservation de l’humidité'],
]
