import { greenhouseSideVentsOnly } from './discoveryEquipment.js'
import { greenhouseLimits } from './discoveryFormOptions.js'

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
    if (limits.roofs && g.has_roof_vents === true) {
      if (!['110', '240', '24_dc'].includes(g.roof_motor_voltage)) errors.push(`${name} : indiquez la tension du moteur du toit ouvrant.`)
      if (typeof g.has_roof_inverter !== 'boolean') errors.push(`${name} : indiquez si vous avez déjà l’inverseur du toit ouvrant.`)
      if (g.has_roof_inverter === true) {
        if (!['harnois_8ze141l', 'vre_mc21', 'other'].includes(g.roof_inverter_type)) errors.push(`${name} : choisissez la marque et le modèle de l’inverseur.`)
        if (g.roof_inverter_type === 'other' && (!String(g.roof_inverter_brand || '').trim() || !String(g.roof_inverter_model || '').trim())) errors.push(`${name} : précisez la marque et le modèle de l’inverseur.`)
      }
      if (g.has_roof_inverter === false && g.roof_motor_voltage === '240' && typeof g.roof_motor_ridder_rw240 !== 'boolean') errors.push(`${name} : précisez si le moteur est un Ridder RW240, 1 phase, 5 fils.`)
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
    if (response.form_options?.humidity_retention) {
      if (typeof g.humidity_valve !== 'boolean' || typeof g.humidity_haf !== 'boolean') errors.push(`${name} : complétez les options de conservation de l’humidité.`)
    }
  }
  return errors
}
