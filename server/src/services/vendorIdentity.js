// Identité du fournisseur d'un document : alias de raisons sociales, et reconnaissance
// déterministe de la boutique Amazon.
//
// POURQUOI un module à part : la canonisation ne sert plus seulement à l'extraction.
// Le chemin de publication (findOrCreateVendor) doit lui aussi canoniser AVANT de créer
// un fournisseur — sinon une variante de raison sociale crée un doublon dans QB.

// Alias de fournisseurs : nom imprimé sur le document → nom canonique à enregistrer.
// « Groupe Alliances et Privilèges » (marque NovoXpress) correspond au fournisseur
// « Novo Express » dans notre liste QB — on enregistre donc CE nom exact pour que le
// rapprochement du fournisseur QB tombe juste à la publication.
const VENDOR_ALIASES = [
  { match: /alliances?\s*(?:et|&)\s*privil|novo\s*xpress/i, name: 'Novo Express' },
  // Les factures FedEx portent la raison sociale « Federal Express Canada Corporation »,
  // qui ne partage aucun token avec le vendor QB « FedEx » — le rapprochement flou du
  // client échouait et proposait de créer un doublon.
  { match: /fed\s*ex(?!\w)|federal\s+express/i, name: 'FedEx' },
  // Amazon : AWS est une entité DISTINCTE (testée en premier — « Amazon Web Services
  // Canada, Inc. », « AWS »…). Tout le reste (« Amazon », « Amazon.com.ca ULC »,
  // « Amazon Marketplace », « Amazon Prime »…) est TOUJOURS le fournisseur de la
  // boutique « Amazon.ca » — l'extraction proposait de créer un fournisseur par
  // variante de raison sociale.
  // « HONG KONG YANGHUI INFORMATION TECHNOLOGY LIMITED » est la raison sociale qui
  // facture pour PCBWay (décision de Charles, 2026-09-22) — aucun mot en commun.
  { match: /yang\s*hui|pcb\s*way/i, name: 'PCBWay' },
  { match: /amazon\s*web\s*services|(?<!\w)aws(?!\w)/i, name: 'Amazon Web Services' },
  { match: /(?<!\w)amazon(?!\w)/i, name: 'Amazon.ca' },
]

export const AMAZON_STORE_VENDOR = 'Amazon.ca'

export function canonicalVendorName(name) {
  if (!name) return name
  for (const a of VENDOR_ALIASES) if (a.match.test(name)) return a.name
  return name
}

// ── Boutique Amazon : reconnaissance par la FORME du document ─────────────────
// Une facture de la boutique Amazon porte la raison sociale du VENDEUR TIERS
// (« Sold by / Vendu par : AMERICA UGREEN LIMITED ») : lue au pied de la lettre, elle
// crée un fournisseur par marchand du marketplace. Or c'est Amazon qui facture, et
// notre fournisseur est « Amazon.ca », toujours.
// Signature du gabarit Amazon : numéro de commande 123-1234567-1234567, ASIN, renvoi
// vers amazon.ca/amazon.com. AWS est exclu — c'est une autre entité.
const AWS_DOC = /amazon\s*web\s*services|aws\.amazon\.com|\baws\b/i
const AMAZON_WORD = /(?<!\w)amazon(?!\w)|amazon\.(?:ca|com)/i
const AMAZON_SHAPE = [
  /\bASIN\s*[:#]/i,                       // référence catalogue Amazon
  /\b\d{3}-\d{7}-\d{7}\b/,                // numéro de commande Amazon
  /amazon\.(?:ca|com)(?:\/|\b)/i,         // renvoi au site
  /amazon\s*(?:marketplace|business|prime)/i,
]

// Le document est-il une facture/commande de la boutique Amazon ? `text` = texte brut
// des pages (pdftotext). Conservateur : il faut le mot « amazon » ET un marqueur de
// gabarit, et pas de signature AWS.
export function isAmazonStoreDocument(text) {
  const t = String(text || '')
  if (!t.trim()) return false
  if (AWS_DOC.test(t)) return false
  if (!AMAZON_WORD.test(t)) return false
  return AMAZON_SHAPE.some(re => re.test(t))
}
