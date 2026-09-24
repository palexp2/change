// Options fixées par l’équipe lors de la création, jamais modifiables par le lien public.
export const SENSOR_ROLES = ['soil_temperature_sensor', 'outdoor_temperature_sensor', 'advanced_temperature_sensor', 'solar_sensor', 'rain_sensor']
export const EXTRA_KEYS = ['furnaces', 'valves', 'rollups', 'roofs']
// Permissions supplémentaires : elles ne fournissent rien, elles relèvent le
// nombre d'appareils que le questionnaire client laisse déclarer. Une
// permission Chauffage = 2 fournaises de plus, Irrigation = 4 valves, Côtés
// ouvrants = 2 moteurs, Toits ouvrants = 1 toit.
export const EXTRA_UNITS = { furnaces: 2, valves: 4, rollups: 2, roofs: 1 }
// Plafonds d'une serre standard (sans permission supplémentaire).
export const STANDARD_LIMITS = {
  chief_grower: { rollups: 2, furnaces: 2, valves: 4, roofs: 1 },
  helper: { rollups: 2, furnaces: 0, valves: 0, roofs: 0 },
}
const count = (v, max) => {
  const n = Number(v ?? 0)
  return Number.isInteger(n) && n >= 0 && n <= max ? n : 0
}
// Équipements supplémentaires : une quantité par serre (même ordre que les
// cartes), fixée par Orisha. L'ancien format (cases à cocher globales) ne
// portait aucune quantité : il retombe à zéro.
function normalizeExtras(input) {
  if (!Array.isArray(input)) return []
  return input.slice(0, 200).map(e => Object.fromEntries(EXTRA_KEYS.map(key => [key, count(e?.[key], 50)])))
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
  return Object.fromEntries(EXTRA_KEYS.map(key => [key, base[key] + extras[key]]))
}
export function normalizeDiscoveryOptions(input = {}) {
  return {
    mobile_controller: input?.mobile_controller === true,
    humidity_retention: input?.humidity_retention === true,
    additional_equipment: normalizeExtras(input?.additional_equipment),
    sensors: Object.fromEntries(SENSOR_ROLES.map(role => [role, count(input?.sensors?.[role], 100)])),
  }
}
export function discoveryOptionsFromRow(row) {
  return normalizeDiscoveryOptions(row?.form_options_json ? JSON.parse(row.form_options_json) : {})
}
