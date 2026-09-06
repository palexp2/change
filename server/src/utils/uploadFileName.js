/**
 * Nom de fichier téléversé : décodage et normalisation.
 *
 * Le problème. multipart/form-data ne transporte pas de charset pour l'en-tête
 * `filename` ; busboy — et donc multer (option `defParamCharset`, défaut
 * `'latin1'`) — lit ces octets comme du latin1. Un nom accentué envoyé en UTF-8
 * par le navigateur ressort donc en mojibake : « Capture d’écran … à 09.49 »
 * devient « Capture dâ€™eÌcran … aÌ€ 09.49 ». Les uploads passent tous par
 * `defParamCharset: 'utf8'` (constante ci-dessous) pour couper le mal à la
 * racine.
 *
 * Deux corrections restent utiles à l'écriture, d'où `normalizeUploadName` :
 *  - filet de sécurité : un nom qui arrive déjà en mojibake (ingestion FTP,
 *    connecteur tiers, ancienne route) est redécodé ;
 *  - macOS envoie ses noms en NFD (« e » + accent combinant). Ça s'affiche bien
 *    mais ne se compare ni ne se cherche comme le « é » que tout le reste de
 *    l'app produit — on ramène tout en NFC.
 */

/** Valeur à passer à multer pour que `file.originalname` soit de l'UTF-8. */
export const UPLOAD_PARAM_CHARSET = 'utf8'

/**
 * Redécode une chaîne dont les octets UTF-8 ont été lus comme du latin1.
 * Ne touche à rien si l'hypothèse ne tient pas (chaîne hors latin1, octets qui
 * ne forment pas de l'UTF-8 valide) : un vrai « Café.png » latin1 reste intact,
 * ses octets ne composant aucune séquence UTF-8 valide.
 */
export function repairLatin1Mojibake(name) {
  if (typeof name !== 'string' || !/[À-ÿ]/.test(name)) return name
  const bytes = Buffer.from(name, 'latin1')
  if (bytes.toString('latin1') !== name) return name // caractères hors latin1 → déjà correct
  const decoded = bytes.toString('utf8')
  if (decoded === name || decoded.includes('�')) return name
  if (!Buffer.from(decoded, 'utf8').equals(bytes)) return name // décodage non réversible
  return decoded
}

/** Nom de fichier prêt à stocker : mojibake réparé, accents en NFC. */
export function normalizeUploadName(name) {
  if (typeof name !== 'string' || name === '') return name
  return repairLatin1Mojibake(name).normalize('NFC')
}
