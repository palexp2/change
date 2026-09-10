// Options fixées par l’équipe lors de la création, jamais modifiables par le lien public.
export const SENSOR_ROLES = ['soil_temperature_sensor', 'outdoor_temperature_sensor', 'advanced_temperature_sensor', 'solar_sensor', 'rain_sensor']
export function normalizeDiscoveryOptions(input = {}) {
  return {
    mobile_controller: input?.mobile_controller === true,
    humidity_retention: input?.humidity_retention === true,
    sensors: Object.fromEntries(SENSOR_ROLES.map(role => {
      const n = Number(input?.sensors?.[role] ?? 0)
      return [role, Number.isInteger(n) && n >= 0 && n <= 100 ? n : 0]
    })),
  }
}
export function discoveryOptionsFromRow(row) {
  return normalizeDiscoveryOptions(row?.form_options_json ? JSON.parse(row.form_options_json) : {})
}
