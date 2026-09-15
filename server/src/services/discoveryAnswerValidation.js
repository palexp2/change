import { greenhouseSideVentsOnly } from './discoveryEquipment.js'

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
    // Serre Helper : côtés ouvrants seulement — ni louvres ni humidité ne lui
    // sont demandées, donc rien à exiger ici.
    if (greenhouseSideVentsOnly(g, response)) continue
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
      if (g.humidity_haf && (!Number.isInteger(Number(g.humidity_haf_count)) || Number(g.humidity_haf_count) < 1 || Number(g.humidity_haf_count) > 100)) errors.push(`${name} : indiquez entre 1 et 100 HAF.`)
    }
  }
  return errors
}
