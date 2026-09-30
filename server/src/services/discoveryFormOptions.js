// Options fixées par l’équipe lors de la création, jamais modifiables par le lien public.
export const SENSOR_ROLES = ['soil_temperature_sensor', 'outdoor_temperature_sensor', 'solar_sensor', 'rain_sensor', 'wind_sensor']
// Capteurs cochés par serre (oui/non) : un par serre cochée, sans sortie V2.
export const GREENHOUSE_SENSOR_KEYS = ['advanced_temperature_sensor']
export const EXTRA_KEYS = ['furnaces', 'valves', 'rollups', 'roofs', 'screens']
// Permissions supplémentaires : elles ne fournissent rien, elles relèvent le
// nombre d'appareils que le questionnaire client laisse déclarer. Une
// permission Chauffage = 2 fournaises de plus, Irrigation = 4 valves, Côtés
// ouvrants = 2 moteurs, Toits ouvrants = 1 toit, Toiles thermiques = 1 toile
// (aucune sans permission).
export const EXTRA_UNITS = { furnaces: 2, valves: 4, rollups: 2, roofs: 1, screens: 1 }
// Plancher d'une première permission, Helper compris : Chauffage ouvre
// jusqu'à 4 fournaises, Irrigation jusqu'à 8 valves (un Helper part de 0).
export const PERMISSION_FLOOR = { furnaces: 4, valves: 8 }
// Matériel à envoyer dans une serre, coché par Orisha (aucune question au
// client) : valve de brumisation, boîtier 110 V pour les HAF.
export const MATERIAL_KEYS = ['humidity_valve', 'humidity_haf']
// Permission Ventilation (oui/non) : louvres et ventilateurs de bout passent
// de 2 à 4 choix dans le questionnaire client.
export const FLAG_KEYS = ['ventilation']
const VENTILATION_LIMIT = { standard: 2, extended: 4 }
// Plafonds d'une serre standard (sans permission supplémentaire).
export const STANDARD_LIMITS = {
  chief_grower: { rollups: 2, furnaces: 2, valves: 4, roofs: 1, screens: 0 },
  helper: { rollups: 2, furnaces: 0, valves: 0, roofs: 0, screens: 0 },
}
const count = (v, max) => {
  const n = Number(v ?? 0)
  return Number.isInteger(n) && n >= 0 && n <= max ? n : 0
}
// Équipements supplémentaires : une quantité par serre (même ordre que les
// cartes), fixée par Orisha. L'ancien format (cases à cocher globales) ne
// portait aucune quantité : il retombe à zéro. Le matériel coché n'est gardé
// que s'il l'est.
function normalizeExtras(input) {
  if (!Array.isArray(input)) return []
  return input.slice(0, 200).map(e => ({
    ...Object.fromEntries(EXTRA_KEYS.map(key => [key, count(e?.[key], 50)])),
    ...Object.fromEntries([...FLAG_KEYS, ...MATERIAL_KEYS, ...GREENHOUSE_SENSOR_KEYS].filter(key => e?.[key] === true).map(key => [key, true])),
  }))
}
// Matériel à envoyer dans une serre.
export function greenhouseMaterials(options, index) {
  const e = normalizeExtras(options?.additional_equipment)[index] || {}
  return Object.fromEntries(MATERIAL_KEYS.map(key => [key, e[key] === true]))
}
// Capteurs cochés pour une serre.
export function greenhouseSensors(options, index) {
  const e = normalizeExtras(options?.additional_equipment)[index] || {}
  return GREENHOUSE_SENSOR_KEYS.filter(key => e[key] === true)
}
// Appareils supplémentaires permis dans une serre (Helper compris).
export function greenhouseExtras(options, index) {
  const e = normalizeExtras(options?.additional_equipment)[index] || {}
  return Object.fromEntries(EXTRA_KEYS.map(key => [key, (e[key] || 0) * EXTRA_UNITS[key]]))
}
// Nombre maximal d'appareils que le client peut déclarer dans une serre.
export function greenhouseLimits(options, index, permission) {
  const base = STANDARD_LIMITS[permission] || STANDARD_LIMITS.chief_grower
  const extras = greenhouseExtras(options, index)
  const ventilation = normalizeExtras(options?.additional_equipment)[index]?.ventilation === true
  const aerators = ventilation ? VENTILATION_LIMIT.extended : VENTILATION_LIMIT.standard
  return {
    ...Object.fromEntries(EXTRA_KEYS.map(key => {
      const limit = base[key] + extras[key]
      return [key, extras[key] && PERMISSION_FLOOR[key] ? Math.max(limit, PERMISSION_FLOOR[key] + extras[key] - EXTRA_UNITS[key]) : limit]
    })),
    louvers: aerators,
    fans: aerators,
  }
}
export function normalizeDiscoveryOptions(input = {}) {
  // Contrôleurs Internet mobiles vendus ; l'ancien format n'avait que la case.
  const mobile = input?.mobile_controllers != null ? count(input.mobile_controllers, 20) : (input?.mobile_controller === true ? 1 : 0)
  return {
    // Langue du formulaire public, choisie à la création.
    lang: input?.lang === 'en' ? 'en' : 'fr',
    mobile_controller: mobile > 0,
    mobile_controllers: mobile,
    // Contrôleurs centraux vendus en plus de celui que le site justifie.
    extra_central_controllers: count(input?.extra_central_controllers, 20),
    additional_equipment: normalizeExtras(input?.additional_equipment),
    sensors: Object.fromEntries(SENSOR_ROLES.map(role => [role, count(input?.sensors?.[role], 100)])),
  }
}
export function discoveryOptionsFromRow(row) {
  return normalizeDiscoveryOptions(row?.form_options_json ? JSON.parse(row.form_options_json) : {})
}
