import { roofVentAnswers, thermalScreen } from './discoveryRoofs.js'
import { sideVentOther, sideVentsOnly } from './discoveryFormSchema.js'

// Réponses « Je ne sais pas » encore présentes dans un System builder : tant
// qu'il en reste une, la commande ne peut pas être créée (fiche et serveur).
// Partagé avec server/src/routes/discovery-forms.js — pas de dépendance navigateur.

const DONT_KNOW = 'Je ne sais pas'
const isUnknown = v => v === DONT_KNOW || v === 'unknown'

// `questionLabel(id)` : libellé d'une question ajoutée dans l'éditeur (calque).
// Retourne [{ greenhouse: n | null, label }], dans l'ordre de la fiche.
export function unknownAnswers(response, { questionLabel = () => 'Autre réponse' } = {}) {
  const out = []
  const add = (greenhouse, label) => out.push({ greenhouse, label })
  // Serres à portée du contrôleur existant : le Wi-Fi n'est pas demandé.
  const nearExisting = response?.is_new_site === 'add_to_existing' && response.within_central_controller_range === true
  if (!nearExisting && response?.wifi_ssid === DONT_KNOW) add(null, 'Wi-Fi')
  else if (!nearExisting && response?.wifi_password === DONT_KNOW) add(null, 'Mot de passe Wi-Fi')
  for (const [id, v] of Object.entries(response?.custom_answers || {})) if (isUnknown(v)) add(null, questionLabel(id))

  ;(Array.isArray(response?.greenhouses) ? response.greenhouses : []).forEach((g, i) => {
    const n = i + 1
    // Côté « Autre » : les réponses roll-up ne servent plus.
    const rollup = !sideVentOther(g)
    if (g.has_side_vents === true && rollup) {
      if (!(g.has_existing_side_vent_motors && g.side_has_inverters === true) && (g.side_vent_height_range === 'unknown' || g.side_vent_height === DONT_KNOW)) add(n, 'Hauteur côtés')
      if (g.side_pipe_type === 'unknown') add(n, 'Tuyau de côté')
      if (g.side_pipe_diameter === DONT_KNOW) add(n, 'Diamètre côté')
      if (!g.has_existing_side_vent_motors && g.guide_pipes_state === 'unknown') add(n, 'Tuyaux guides')
      if (!g.has_existing_side_vent_motors && g.guide_pipe_diameter === DONT_KNOW && !['needed', 'unknown'].includes(g.guide_pipes_state) && !g.wants_compatible_guide_pipes) add(n, 'Diamètre guides')
    }
    if (g.has_existing_side_vent_motors && rollup) {
      if (g.side_has_inverters === 'unknown') add(n, 'Inverseurs')
      else if (g.side_has_inverters === true && (g.side_inverter_ratio === 'unknown' || g.side_inverter_model === DONT_KNOW)) add(n, 'Inverseurs')
      if (g.side_has_inverters !== true && g.side_vent_motor_choice === 'unknown') add(n, 'Marque moteurs')
    }
    roofVentAnswers(g, { legacy: true }).forEach((r, j, all) => {
      if (r?.has_roof_inverter === 'unknown') add(n, `Inverseur déjà présent${all.length > 1 ? ` · #${j + 1}` : ''}`)
      else if (r?.has_roof_inverter === true && r.roof_inverter_type === 'unknown') add(n, `Modèle d’inverseur${all.length > 1 ? ` · #${j + 1}` : ''}`)
    })
    roofVentAnswers(thermalScreen(g)).forEach((r, j, all) => {
      if (r?.has_roof_inverter === 'unknown' || (r?.has_roof_inverter === true && r.roof_inverter_type === 'unknown')) add(n, `Inverseur toile thermique${all.length > 1 ? ` · #${j + 1}` : ''}`)
    })
    // Louvres : non demandées à une serre Helper. « Je ne sais pas » = type `other`.
    if (!sideVentsOnly(g.permission_level || response.permission_level) && g.has_louvers) {
      const louvers = Array.isArray(g.louvers) ? g.louvers : []
      louvers.forEach((l, j) => { if (l?.control_type === 'other') add(n, `Louvre${louvers.length > 1 ? ` #${j + 1}` : ''}`) })
    }
    if (Number(g.num_fans) === 2 && (g.fans_hp_range === DONT_KNOW || (!g.fans_hp_range && g.fans_combined_hp === DONT_KNOW))) add(n, 'Puissance ventilateurs')
    ;(Array.isArray(g.furnaces) ? g.furnaces : []).forEach((f, j) => {
      if (f?.dry_contact_24v === 'unknown') add(n, `Fournaise #${j + 1}`)
      if (f?.control_wire_range === 'unknown') add(n, `Filage fournaise #${j + 1}`)
    })
    for (const [id, v] of Object.entries(g.custom || {})) if (isUnknown(v)) add(n, questionLabel(id))
  })
  return out
}
