export function roofInverterSupplyKey(g) {
  // Toits déclarés par le client ou ajoutés en extra : seule la réponse sur l'inverseur compte.
  if (g.has_roof_inverter !== false) return ''
  if (g.roof_motor_voltage === '24_dc' || (g.roof_motor_voltage === '240' && g.roof_motor_ridder_rw240 === true)) return 'roofs.supply_possible'
  if (g.roof_motor_voltage === '110' || (g.roof_motor_voltage === '240' && g.roof_motor_ridder_rw240 === false)) return 'roofs.supply_customer'
  return ''
}
