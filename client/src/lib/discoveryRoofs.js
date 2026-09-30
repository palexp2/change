export function roofInverterSupplyKey(g) {
  // Toits déclarés par le client ou ajoutés en extra : seule la réponse sur l'inverseur compte.
  if (g.has_roof_inverter !== false) return ''
  if (g.roof_motor_voltage === '24_dc' || (g.roof_motor_voltage === '240' && g.roof_motor_ridder_rw240 === true)) return 'roofs.supply_possible'
  if (g.roof_motor_voltage === '110' || (g.roof_motor_voltage === '240' && g.roof_motor_ridder_rw240 === false)) return 'roofs.supply_customer'
  return ''
}

// Réponses propres à chaque toit ouvrant (inverseur, moteur).
export const ROOF_ANSWER_KEYS = ['has_roof_inverter', 'roof_motor_voltage', 'roof_motor_ridder_rw240', 'roof_inverter_type', 'roof_inverter_brand', 'roof_inverter_model']

// Un jeu de réponses par toit : le toit #1 sur la serre elle-même, les suivants
// dans `extra_roof_vents[i - 1]`, mêmes clés. `legacy` : une réponse d'avant
// (sans `extra_roof_vents`) valait pour tous les toits de la serre.
export function roofVentAnswers(g, { legacy = false } = {}) {
  const n = g?.has_roof_vents === true ? Math.max(1, Number(g.num_roof_vents) || 0) : 0
  const extra = Array.isArray(g?.extra_roof_vents) ? g.extra_roof_vents : null
  return Array.from({ length: n }, (_, i) => (i === 0 ? g : extra ? extra[i - 1] || {} : legacy ? g : {}))
}

// Toile thermique : mêmes questions que le toit ouvrant, mêmes clés, rangées
// dans `thermal_screen` de la serre (`has_roof_vents` = a une toile, etc.).
export function thermalScreen(g) {
  return g?.thermal_screen && typeof g.thermal_screen === 'object' ? g.thermal_screen : {}
}
