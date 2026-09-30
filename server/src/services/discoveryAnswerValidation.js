import { greenhouseSideVentsOnly } from './discoveryEquipment.js'
import { greenhouseLimits } from './discoveryFormOptions.js'
import { roofVentAnswers, thermalScreen } from '../../../client/src/lib/discoveryRoofs.js'

// `hasMobileController` : un contrôleur central internet mobile est déjà à la
// commande (option du formulaire, ou produit détecté sur la facture Stripe).
// Il fournit un nouveau contrôleur central : la question de la distance au
// contrôleur existant n'est alors pas posée, donc jamais exigée.
export function discoveryAnswerErrors(response, { hasMobileController = false } = {}) {
  const errors = []
  const mobileController = hasMobileController || response.form_options?.mobile_controller === true
  if (response.is_new_site === 'add_to_existing' && !mobileController && typeof response.within_central_controller_range !== 'boolean') {
    errors.push('Indiquez si les serres seront situées à 250 pi ou moins du contrôleur central.')
  }
  for (const [i, g] of (response.greenhouses || []).entries()) {
    const name = `Serre #${i + 1}`
    const helperOnly = greenhouseSideVentsOnly(g, response)
    // Toits ouvrants : posés au chef de culture, ou au Helper qui a reçu une
    // permission Toits ouvrants.
    const limits = greenhouseLimits(response.form_options, i, g.permission_level || response.permission_level)
    // Chaque toit ouvrant a ses propres réponses. Toiles thermiques (permission
    // seulement) : mêmes questions, rangées dans `thermal_screen`.
    for (const [limit, rec, what, whatOf] of [[limits.roofs, g, 'toit ouvrant', 'du toit ouvrant'], [limits.screens, thermalScreen(g), 'toile thermique', 'de la toile thermique']]) {
      const roofAnswers = limit ? roofVentAnswers(rec) : []
      for (const [j, r] of roofAnswers.entries()) {
        const roof = roofAnswers.length > 1 ? `${name}, ${what} #${j + 1}` : rec === g ? name : `${name}, ${what}`
        if (typeof r.has_roof_inverter !== 'boolean' && r.has_roof_inverter !== 'unknown') errors.push(`${roof} : indiquez si vous avez déjà l’inverseur ${whatOf}.`)
        // La tension ne se demande qu'à qui n'a pas d'inverseur.
        if (r.has_roof_inverter === false && !['110', '240', '24_dc'].includes(r.roof_motor_voltage)) errors.push(`${roof} : indiquez la tension du moteur ${whatOf}.`)
        if (r.has_roof_inverter === true) {
          if (!['harnois_8ze141l', 'harnois_8ze142l', 'vre_mc21', 'other', 'unknown'].includes(r.roof_inverter_type)) errors.push(`${roof} : choisissez la marque et le modèle de l’inverseur.`)
          if (r.roof_inverter_type === 'other' && (!String(r.roof_inverter_brand || '').trim() || !String(r.roof_inverter_model || '').trim())) errors.push(`${roof} : précisez la marque et le modèle de l’inverseur.`)
        }
        if (r.has_roof_inverter === false && r.roof_motor_voltage === '240' && typeof r.roof_motor_ridder_rw240 !== 'boolean') errors.push(`${roof} : précisez si le moteur est un Ridder RW240, 1 phase, 5 fils.`)
      }
    }
    // Serre Helper : ni louvres ni humidité ne lui sont demandées.
    if (helperOnly) continue
    if (typeof g.has_louvers !== 'boolean') errors.push(`${name} : indiquez la présence de louvres.`)
    if (g.has_louvers) {
      if (!Array.isArray(g.louvers) || !g.louvers.length || g.louvers.length > 50) errors.push(`${name} : indiquez entre 1 et 50 louvres.`)
      for (const [j, l] of (Array.isArray(g.louvers) ? g.louvers : []).entries()) {
        if (l?.voltage === '110' && l.control_type === 'open_close') errors.push(`${name}, louvre #${j + 1} : la commande ouvrir/fermer en 110 V n’est pas proposée par Orisha.`)
        // Commande « Autre / Je ne sais pas » : aucun voltage n'est demandé au
        // client, il sera appelé.
        if (!l || !['spring_loaded', 'open_close', 'other'].includes(l.control_type) || typeof l.has_fan !== 'boolean'
          || (l.control_type !== 'other' && (!['110', '24', '12', 'other'].includes(l.voltage) || (l.voltage === 'other' && !String(l.voltage_other || '').trim())))) errors.push(`${name}, louvre #${j + 1} : complétez le type de louvre et le ventilateur associé.`)
      }
    }
  }
  return errors
}
