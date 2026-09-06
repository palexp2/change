// Lien de suivi public d'un envoi, déduit du libellé du transporteur.
// Le libellé est celui écrit à l'achat de l'étiquette (« Canada Post »,
// « Nationex »…) ou saisi à la main sur la fiche : on matche donc sur une
// sous-chaîne, pas sur une valeur exacte. Retourne null si le transporteur
// est inconnu ou le numéro de suivi absent — l'appelant affiche alors le
// numéro sans lien.
export function trackingUrl(carrier, trackingNumber) {
  if (!trackingNumber) return null
  const c = (carrier || '').toLowerCase()
  const n = encodeURIComponent(trackingNumber)
  if (c.includes('purolator')) return `https://www.purolator.com/en/ship-track/tracking-summary.page?pin=${n}`
  if (c.includes('fedex')) return `https://www.fedex.com/fedextrack/?trknbr=${n}`
  if (c.includes('ups')) return `https://www.ups.com/track?tracknum=${n}`
  if (c.includes('dhl')) return `https://www.dhl.com/en/express/tracking.html?AWB=${n}`
  if (c.includes('postes canada') || c.includes('canada post') || c.includes('canadapost') || c.includes('cp')) {
    return `https://www.canadapost-postescanada.ca/track-reperage/fr#/search?searchFor=${n}`
  }
  if (c.includes('canpar')) return `https://www.canpar.com/en/tracking/track.htm?barcode=${n}`
  if (c.includes('gls')) return `https://gls-group.eu/EU/en/parcel-tracking?match=${n}`
  if (c.includes('nationex')) return `https://nationex.com/reperage/${n}`
  if (c.includes('loomis')) return `https://www.loomis-express.com/tracking?trackingNumbers=${n}`
  return null
}

export default trackingUrl
