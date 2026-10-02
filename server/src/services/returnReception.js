/**
 * Réception d'un article de retour — les règles viennent d'Airtable.
 *
 * La RAISON DU RETOUR dit dans quelle étagère poser l'article. Règle de
 * Martin Audesse (2026-10-01) : « Fin d'abonnement = reconditionnement. Tous
 * les autres dans l'étagère d'analyse » — raison vide ou inconnue comprise.
 *
 *   Fin d'abonnement → reconditionnement + PA avisé
 *   Retour de garantie avec échange différé → analyse + séance
 *   Le client à changé d'idée → analyse + PA avisé
 *   tout le reste → analyse
 *
 * Les phrases sont celles qu'Airtable affichait depuis 2023.
 */

const ANALYSE = "SVP place l'article dans l'étagère d'analyse."
const RECONDITIONNEMENT = "SVP place l'article dans l'étagère de reconditionnement."
const SEANCE = "L'item sera analysé, réparé, nettoyé et renvoyé lors de la prochaine séance d'analyse."
const PA_AVISE = 'PA a été avisé de la réception de cet item.'

const INSTRUCTIONS_PAR_RAISON = {
  "Fin d'abonnement": [RECONDITIONNEMENT, PA_AVISE],
  'Retour de garantie avec échange différé': [ANALYSE, SEANCE],
  "Le client à changé d'idée": [ANALYSE, PA_AVISE],
}

const instructionParts = (returnReason) =>
  INSTRUCTIONS_PAR_RAISON[String(returnReason || '').trim()] || [ANALYSE]

/** Étagère visée : 'analyse' | 'reconditionnement'. */
export function receptionShelf(returnReason) {
  return instructionParts(returnReason)[0] === RECONDITIONNEMENT ? 'reconditionnement' : 'analyse'
}

/** La phrase affichée au réceptionniste après un scan. */
export function receptionInstruction(returnReason, person) {
  // Un utilisateur Boréal arrive en nom complet : on salue par le prénom.
  const who = String(person || '').trim().split(/\s+/)[0]
  const salut = who ? `Bonjour ${who}, ` : ''
  return salut + instructionParts(returnReason).join(' ')
}

/**
 * L'article d'un retour désigné par un code scanné. Le pistolet lit d'abord une
 * étiquette de numéro de série ; à défaut (article sans série), le SKU du
 * produit. Un article déjà reçu ne prend pas la place d'un article en attente
 * quand deux lignes portent le même produit.
 *
 * `items` : lignes de return_items enrichies de `serial_number` et `sku`.
 */
export function matchReturnItem(items, code) {
  const c = String(code || '').trim().toLowerCase()
  if (!c) return null
  const eq = (v) => String(v || '').trim().toLowerCase() === c
  const bySerial = (items || []).find(i => eq(i.serial_number))
  if (bySerial) return bySerial
  const bySku = (items || []).filter(i => eq(i.sku))
  return bySku.find(i => !i.received_at) || bySku[0] || null
}
