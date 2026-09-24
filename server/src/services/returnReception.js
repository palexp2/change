/**
 * Réception d'un article de retour — les règles viennent d'Airtable.
 *
 * Dans Airtable, chaque article reçu porte une phrase « Instructions pour le
 * réceptionniste » qui dit dans quelle étagère poser l'article. Relevé le
 * 2026-09-15 sur les 452 articles qui en portent une : la RAISON DU RETOUR la
 * détermine à 100 %, sans une seule exception.
 *
 *   Retour de garantie avec échange immédiat → étagère d'analyse
 *   Retour de garantie avec échange différé  → étagère d'analyse + séance
 *   Fin d'abonnement / Le client à changé d'idée → reconditionnement + PA avisé
 *   Erreur de commande / Retour d'équipement de courtoisie → reconditionnement
 *
 * Les phrases sont recopiées au caractère près : c'est ce que l'équipe lit
 * depuis 2023. Une raison inconnue (ou vide) ne se devine pas — l'article est
 * reçu quand même, mais sans étagère.
 */

const ANALYSE = "SVP place l'article dans l'étagère d'analyse."
const RECONDITIONNEMENT = "SVP place l'article dans l'étagère de reconditionnement."
const SEANCE = "L'item sera analysé, réparé, nettoyé et renvoyé lors de la prochaine séance d'analyse."
const PA_AVISE = 'PA a été avisé de la réception de cet item.'

const INSTRUCTIONS_PAR_RAISON = {
  'Retour de garantie avec échange immédiat': [ANALYSE],
  'Retour de garantie avec échange différé': [ANALYSE, SEANCE],
  "Fin d'abonnement": [RECONDITIONNEMENT, PA_AVISE],
  "Le client à changé d'idée": [RECONDITIONNEMENT, PA_AVISE],
  'Erreur de commande': [RECONDITIONNEMENT],
  "Retour d'équipement de courtoisie": [RECONDITIONNEMENT],
}

/** Étagère visée : 'analyse' | 'reconditionnement' | null (raison inconnue). */
export function receptionShelf(returnReason) {
  const parts = INSTRUCTIONS_PAR_RAISON[String(returnReason || '').trim()]
  if (!parts) return null
  return parts[0] === ANALYSE ? 'analyse' : 'reconditionnement'
}

/** La phrase affichée au réceptionniste après un scan. */
export function receptionInstruction(returnReason, person) {
  const who = String(person || '').trim()
  const salut = who ? `Bonjour ${who}, ` : ''
  const parts = INSTRUCTIONS_PAR_RAISON[String(returnReason || '').trim()]
  if (!parts) return `${salut}article reçu. Étagère à déterminer.`
  return salut + parts.join(' ')
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
