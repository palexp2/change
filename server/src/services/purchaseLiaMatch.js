// Appariement « facture fournisseur ↔ achat LIA ».
//
// Contexte métier : les pièces achetées sont suivies dans la table Airtable « Achats »
// (miroir ERP : purchases), où chaque ligne porte un code LIA-xxxx (purchases.at_id) et
// une pièce (products). Quand la facture du fournisseur arrive, la ligne comptabilisée
// dans QuickBooks doit porter CE code SUIVI du nom de la pièce :
//
//     LIA-1961⇥PCB Module d'activation V2
//
// Le code seul ne se lit nulle part : ni dans le grand livre du compte 14000, ni dans le
// fichier mensuel des déboursés de pièces, où il faut savoir ce qui a été acheté sans
// ouvrir la table Achats. Le nom accompagne donc toujours le code.
//
// Les lignes de la facture qui ne correspondent à aucun achat LIA (frais de transport,
// consommables, services…) sont comptabilisées telles quelles, sans code.
//
// Ce module ne fait que PROPOSER : il calcule un score par couple (ligne, achat) et ne
// réécrit la description que lorsque la concordance est nette (LIA_AUTO_THRESHOLD).
// En dessous, l'appariement reste une suggestion affichée sur la ligne du reçu, que
// l'opérateur confirme d'un clic (cf. GET /api/sale-receipts/:id/lia-matches).
//
// NOTE colonnes : les migrations 032/033/035/036 ont retiré les colonnes natives de
// `purchases` (product_id, reference, order_date, received_date, qty_ordered, unit_cost,
// notes, qty_received) au profit de champs personnalisés Airtable équivalents, gérés
// depuis /champs/purchases. Ce moteur lit désormais ces « jumeaux » :
//   - pièce liée      → nom_de_la_piece (JSON `["recXXXX"]`, résolu vers products.id via
//                        products.airtable_id — quelques lignes anciennes portent l'id brut
//                        sans enveloppe JSON, d'où le COALESCE ci-dessous)
//   - quantité commandée → quantite_commande (texte numérique)
//   - prix unitaire      → prix_unitaire_cad (texte numérique)
//   - date de commande   → date_de_commande
//   - date de réception  → cf_date_de_reception_complete (vide = à recevoir ; « 1970-01-01 »
//                          = reçu à une date inconnue, PAS « à recevoir »)
//   - notes              → notes_2
// La logique de score elle-même est inchangée : seuls les noms de colonnes SQL ont bougé.
import db from '../db/database.js'

// Séparateur entre le code et le nom de la pièce : une TABULATION, format déjà utilisé
// dans les reçus saisis à la main (« LIA-1968\tTD191-B 4G LTE dongle »).
const LIA_SEP = '\t'

// Au-dessus de SUGGEST, l'appariement est proposé sur la ligne ; en dessous, rien.
export const LIA_SUGGEST_THRESHOLD = 0.30

// Réécriture SANS confirmation : le score global ne suffit pas comme critère. Sur des
// données réelles il plafonne vers 0,7 même quand tout concorde, parce qu'un libellé
// imprimé par le fournisseur ne colle jamais mot pour mot au nom de la pièce
// (« MEAN WELL 240W 24V 10A IP67 RA » vs « LED Driver ACDC 240W 24V 10A transfo »
// = 0,41 de similarité, pour un appariement pourtant certain).
//
// « Sûr » est donc défini comme une CONJONCTION : l'argent et la quantité confirment
// tous les trois, et le libellé n'est pas étranger. Une addition de signaux faibles ne
// peut pas y suffire, contrairement à un seuil mélangé.
export const LIA_AUTO_THRESHOLD = 0.60   // plancher de sécurité, en plus de la conjonction
const AUTO_MIN_NAME = 0.30               // le libellé doit avoir un vrai recouvrement
const AUTO_MIN_AMOUNT = 0.90             // prix unitaire, montant de ligne ET quantité
// Écart minimal avec le 2e candidat : deux achats jumeaux (moteur LVM60 gauche / droit)
// ne doivent jamais être départagés sans l'œil de l'opérateur.
const AUTO_MIN_MARGIN = 0.05
// Recouvrement de libellé exigé pour écrire d'office une commande encore à recevoir,
// jugée sans le moindre montant (voie 3) : plus haut que AUTO_MIN_NAME, puisque la
// quantité est le seul autre appui.
const AUTO_PENDING_MIN_NAME = 0.35

// Concordance assez forte pour écrire la description sans demander.
//
// Deux voies mènent à la certitude, jamais une addition de signaux faibles :
//
//  1. IDENTIFICATION — la référence fabricant de la pièce (« WAU24-1800 », « G7J-2A2B-B-DC24 »)
//     ou son SKU alphanumérique figure tel quel dans le libellé de la facture. C'est un
//     identifiant, pas une ressemblance : une corroboration suffit (la quantité, ou un
//     montant, s'ils sont connus) et aucun signal connu ne doit contredire. Indispensable
//     pour les achats encore À RECEVOIR, dont le prix unitaire vaut 0 tant que la facture
//     n'est pas entrée — la voie 2 ne pouvait alors jamais conclure.
//  2. CONCORDANCE MONÉTAIRE — le libellé n'est pas étranger et le prix unitaire, le montant
//     de ligne ET la quantité se confirment tous les trois.
export function isConfidentMatch({ score, detail }, runnerUpScore = 0) {
  if (!detail) return false
  // Deux achats jumeaux (moteur LVM60 gauche / droit) ne sont jamais départagés tout seuls.
  if (score - runnerUpScore < AUTO_MIN_MARGIN) return false

  // Voie 3 — COMMANDE À RECEVOIR SANS PRIX : dans le flux Achats, le coût unitaire n'est
  // saisi qu'à la facturation. Une commande encore en vol n'a donc aucun montant à
  // confronter, et la voie 2 ne pouvait jamais conclure pour elle — or c'est précisément
  // la commande que la facture qui arrive vient régler. Exigences à la place de l'argent :
  // quantité EXACTEMENT celle commandée, libellé qui se recoupe vraiment, et l'écart
  // habituel avec le 2e candidat.
  if (detail.pending === 1 && detail.unit == null && detail.total == null) {
    return detail.qty === 1 && (detail.name ?? 0) >= AUTO_PENDING_MIN_NAME
  }

  if (detail.ident === 1) {
    // Un signal connu qui CONTREDIT l'identification (quantité ou prix qui ne collent pas)
    // rend la ligne douteuse : facture partielle, mauvais lot — l'opérateur tranche.
    for (const key of ['qty', 'unit', 'total']) {
      if (detail[key] != null && detail[key] < AUTO_MIN_AMOUNT) return false
    }
    // …et au moins un signal doit exister : une référence seule, sans quantité ni montant
    // comparables, reste une suggestion.
    return ['qty', 'unit', 'total'].some(key => detail[key] != null)
  }

  if (score < LIA_AUTO_THRESHOLD) return false
  if ((detail.name ?? 0) < AUTO_MIN_NAME) return false
  for (const key of ['unit', 'total', 'qty']) {
    if ((detail[key] ?? 0) < AUTO_MIN_AMOUNT) return false
  }
  return true
}

// Fenêtre de recherche autour de la date de facture : un achat est commandé AVANT d'être
// facturé (parfois plusieurs mois — les PCB de Fabrique Manic prennent 3 mois), et la
// date de facture peut précéder de peu la saisie de l'achat.
const WINDOW_BEFORE_DAYS = 540
const WINDOW_AFTER_DAYS = 45

/**
 * Écart en jours entre la commande d'un achat et la dépense : positif quand la commande
 * précède la dépense (le cas normal), négatif quand elle la suit. null si une date manque.
 */
export function orderGapDays(orderDate, expenseDate) {
  const a = String(orderDate || '').slice(0, 10), b = String(expenseDate || '').slice(0, 10)
  if (!a || !b) return null
  return daysBetween(a, b)
}

// Écart réception ↔ facture considéré comme « la même expédition » (le fournisseur
// facture dans les jours qui suivent l'envoi), puis borne au-delà de laquelle la
// réception n'apporte plus rien.
const RECV_NEAR_DAYS = 21
const RECV_FAR_DAYS = 180

// Recouvrement de libellé minimal sous lequel un couple est rejeté d'office, quels que
// soient les autres signaux (cf. le garde-fou dans scoreLine).
const NAME_GATE = 0.15

// Dépassement toléré entre le montant d'une ligne et le total de la commande avant
// de rejeter le couple (cf. garde-fou monétaire dans scoreLine).
const OVERBILL_VETO = 1.25

const LIA_REF = /^\s*lia-\d+/i

export const hasLiaRef = desc => LIA_REF.test(desc || '')

// Libellé d'un achat LIA : code + nom de la pièce, séparés par une tabulation. Sert
// aussi bien à l'interface (sélecteur, suggestion) qu'à la description publiée sur la
// ligne QuickBooks — c'est le même texte des deux côtés.
export function buildLiaLabel(liaRef, partName) {
  const ref = String(liaRef || '').trim()
  const name = String(partName || '').trim()
  if (!ref) return name
  return name ? `${ref}${LIA_SEP}${name}` : ref
}

// Fragment SQL commun : résout la pièce liée d'un achat vers products.airtable_id.
// `nom_de_la_piece` porte normalement un JSON `["recXXXX"]` (lien Airtable brut), mais
// quelques lignes anciennes portent directement l'id sans enveloppe — d'où le repli.
const PRODUCT_LINK_SQL = `COALESCE(
    CASE WHEN json_valid(p.nom_de_la_piece) THEN json_extract(p.nom_de_la_piece, '$[0]') END,
    p.nom_de_la_piece
  )`

// Nom de la pièce d'un achat, retrouvé par son code LIA — c'est la colonne voisine du
// code dans la table Achats (lien vers Produits). Sert à compléter une description qui
// ne porte que le code : lignes saisies à la main, ou écrites quand seul le code était
// publié.
function partNameByLiaRef(liaRef) {
  try {
    const row = db.prepare(`
      SELECT pr.name_fr, pr.name_en
      FROM purchases p LEFT JOIN products pr ON pr.airtable_id = ${PRODUCT_LINK_SQL}
      WHERE UPPER(p.at_id) = ?
      ORDER BY COALESCE(p.date_de_commande, '') DESC LIMIT 1
    `).get(String(liaRef || '').toUpperCase())
    return row?.name_fr || row?.name_en || null
  } catch {
    return null // achat introuvable : la description reste le code seul
  }
}

// Description publiée : code LIA + nom de la pièce, quelle que soit la forme saisie.
// « LIA-1961 » → « LIA-1961⇥PCB Module d'activation V2 » ; un nom déjà présent est
// conservé tel quel (le séparateur d'origine — tabulation, tiret, espace — est
// normalisé). Sans code LIA (transport, frais de service…) : inchangé.
export function completeLiaDescription(desc) {
  const s = String(desc ?? '').trim()
  const m = /^\s*(lia-\d+)(.*)$/is.exec(s)
  if (!m) return s
  const ref = m[1].toUpperCase()
  const rest = m[2].replace(/^[\s\-–—:.]+/, '').trim()
  return buildLiaLabel(ref, rest || partNameByLiaRef(ref))
}

// ─────────────────────────────── normalisation ───────────────────────────────

const deaccent = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')

export function normalizeText(s) {
  return deaccent(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

// Suffixes que la table Fournisseurs ajoute au nom QB (« Takachi USD », « Hydreon
// Corporation - USD ») et formes juridiques : ils ne distinguent pas deux fournisseurs.
const VENDOR_NOISE = new Set(['usd', 'cad', 'inc', 'ltd', 'ltee', 'llc', 'llp', 'corp', 'corporation', 'co', 'company', 'sa', 'srl', 'sarl', 'enr', 'the'])

export function normalizeVendorKey(name) {
  const tokens = normalizeText(name).split(' ').filter(t => t && !VENDOR_NOISE.has(t))
  return tokens.join(' ')
}

// Deux noms désignent le même fournisseur si leurs clés normalisées sont égales, ou si
// l'une préfixe l'autre (« fabrique manic » vs « fabrique manic electronique »).
export function sameVendor(a, b) {
  const ka = normalizeVendorKey(a), kb = normalizeVendorKey(b)
  if (!ka || !kb) return false
  return ka === kb || ka.startsWith(`${kb} `) || kb.startsWith(`${ka} `)
}

// Mots trop courants pour porter de l'information dans un libellé de pièce.
const STOP_TOKENS = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'un', 'une', 'et', 'a', 'au', 'aux', 'pour', 'avec', 'en', 'sur', 'par', 'of', 'for', 'the', 'and', 'with', 'unit', 'unitaire', 'pcs', 'pc', 'qty', 'x'])

// Singulier/pluriel : une facture écrit « Achat de PCBs et Pièces » là où la pièce
// s'appelle « PCB Module d'activation ». Sans cette normalisation, « pcbs » et « pcb »
// sont deux tokens étrangers et le garde-fou de nom rejetait le couple d'office.
// Prudence : uniquement le « s » final, et seulement sur des tokens d'au moins
// 4 caractères (« gps », « abs » ne sont pas des pluriels).
const singularize = t => (t.length >= 4 && t.endsWith('s') && !t.endsWith('ss') ? t.slice(0, -1) : t)

// Lexique FR ↔ EN des pièces. Les noms de la table Pièces sont en français (« Relais
// NC/NO », « Support relais », « Sonde DS18B20 ») alors que les factures Digikey, Mouser
// et Online Components sont en anglais, souvent abrégé (« RELAY GEN PURPOSE 4PST »,
// « W-BRACKET FOR OMRON RELAY »). Sans traduction, ces couples n'ont aucun token commun
// et tombaient sous le garde-fou de nom : rien n'était proposé, alors que la pièce est
// évidente à l'œil. Chaque entrée ramène les deux langues (et les abréviations imprimées)
// à un même token. Vocabulaire volontairement restreint aux pièces réellement achetées —
// un synonyme trop large rapprocherait des pièces distinctes.
const LEXICON = {
  relay: 'relais', relais: 'relais',
  transformer: 'transfo', xfrmr: 'transfo', transfo: 'transfo',
  switch: 'interrupteur', interrupteur: 'interrupteur',
  sensor: 'sonde', probe: 'sonde', sonde: 'sonde',
  bracket: 'support', support: 'support', socket: 'support',
  fan: 'ventilateur', ventilateur: 'ventilateur',
  connector: 'connecteur', conn: 'connecteur', connecteur: 'connecteur',
  cable: 'cable', cbl: 'cable', wire: 'cable', fil: 'cable',
  cond: 'conducteur', conducteur: 'conducteur', conductor: 'conducteur', conducteurs: 'conducteur',
  antenna: 'antenne', antenne: 'antenne', ant: 'antenne',
  motor: 'moteur', moteur: 'moteur',
  valve: 'valve',
  enclosure: 'boitier', housing: 'boitier', boitier: 'boitier', case: 'boitier',
  board: 'pcb', pcb: 'pcb',
  resistor: 'resistance', resistance: 'resistance',
  capacitor: 'condensateur', condensateur: 'condensateur',
  supply: 'alimentation', alimentation: 'alimentation', psu: 'alimentation',
  adapter: 'adaptateur', adpt: 'adaptateur', adaptateur: 'adaptateur',
  screw: 'vis', vis: 'vis',
  bearing: 'roulement', roulement: 'roulement',
  pump: 'pompe', pompe: 'pompe',
  filter: 'filtre', filtre: 'filtre',
  hose: 'boyau', boyau: 'boyau', tubing: 'boyau', tube: 'boyau',
  fuse: 'fusible', fusible: 'fusible',
  battery: 'pile', pile: 'pile',
  display: 'afficheur', afficheur: 'afficheur',
  button: 'bouton', bouton: 'bouton',
  seal: 'joint', gasket: 'joint', joint: 'joint',
  sticker: 'autocollant', decal: 'autocollant', autocollant: 'autocollant',
}

// Traduction AVANT la mise au singulier : « relais » est déjà la forme canonique, alors
// que singularize() en ferait « relai » et raterait « relay » du côté anglais.
const canonical = t => LEXICON[t] || LEXICON[singularize(t)] || singularize(t)

// VOCABULAIRE DU CÂBLE. Un distributeur écrit « Câble 18-2c BC UNSH » là où la fiche
// de la pièce dit « Fil 18 AWG 2 cond. non blindé » : deux façons de nommer exactement
// la même chose, sans un mot en commun. Trois replis suffisent à les réconcilier —
// « non blindé » compte pour UN mot (sinon le câble blindé ressemble autant au non
// blindé qu'à lui-même), « UNSH » en est l'abréviation, et « 2c » veut dire
// « 2 conducteurs ».
const SHIELDING = { unsh: 'nonblinde', unshielded: 'nonblinde', shielded: 'blinde', shld: 'blinde', blinde: 'blinde' }

export function foldCableTokens(tokens) {
  const isCable = tokens.includes('cable')
  const out = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (t === 'non' && SHIELDING[tokens[i + 1]] === 'blinde') { out.push('nonblinde'); i += 1; continue }
    if (SHIELDING[t]) { out.push(SHIELDING[t]); continue }
    const cond = isCable && /^(\d{1,2})c$/.exec(t)
    if (cond) { out.push(cond[1], 'conducteur'); continue }
    out.push(t)
  }
  return out
}

const tokenize = s => foldCableTokens(
  normalizeText(s).split(' ').filter(t => t && !STOP_TOKENS.has(t)).map(canonical),
)

// Similarité de Dice pondérée : les tokens rares (alphanumériques, ≥ 3 caractères, du
// type « td191 », « max22205 ») pèsent double — ce sont les références fabricant qui
// identifient vraiment une pièce sur une facture Digikey/Mouser.
export function tokenSimilarity(a, b) {
  const ta = tokenize(a), tb = tokenize(b)
  if (!ta.length || !tb.length) return 0
  const weight = t => (/\d/.test(t) && t.length >= 3 ? 2 : 1)
  const setB = new Map()
  for (const t of tb) setB.set(t, (setB.get(t) || 0) + 1)
  let inter = 0
  for (const t of ta) {
    const n = setB.get(t)
    if (n) { inter += weight(t); setB.set(t, n - 1) }
  }
  const sum = ta.reduce((s, t) => s + weight(t), 0) + tb.reduce((s, t) => s + weight(t), 0)
  return sum ? (2 * inter) / sum : 0
}

// ─────────────────────── références de pièce (identifiants) ───────────────────────
//
// Une facture de pièces ne recopie pas le nom Orisha de la pièce : elle imprime la
// RÉFÉRENCE FABRICANT (« WAU24-1800 », « G7J-2A2B-B-DC24 », « 759D02000 »). C'est
// l'identifiant le plus fiable dont on dispose, et il est déjà en base :
//   - `products.fabricant` / `products.manufacturier` — la référence saisie ;
//   - `products.lien_fournisseur` / `lien_fournisseur_alternatif` — l'URL Digikey /
//     Mouser / OnlineComponents de la pièce, dont le chemin contient la référence
//     (…/products/detail/triad-magnetics/WAU24-1800/4915305) et le numéro de catalogue
//     du distributeur (4915305), lui aussi imprimé sur la facture.
//
// Le SKU interne (4 chiffres) reste traité à part : il n'apparaît jamais sur une facture
// fournisseur, sauf coïncidence avec un montant.

const compact = s => normalizeText(s).replace(/ /g, '')

// Une chaîne vaut identifiant si elle est assez longue ET assez improbable : soit
// alphanumérique mixte (lettres + chiffres), soit purement numérique d'au moins
// 6 chiffres (un numéro de catalogue ne se confond pas avec une quantité ou un prix).
function isPartRef(value) {
  const c = compact(value)
  if (c.length < 5) return false
  const hasDigit = /[0-9]/.test(c), hasAlpha = /[a-z]/.test(c)
  if (hasDigit && hasAlpha) return true
  return hasDigit && c.length >= 6
}

// Segments d'URL fournisseur qui ne sont jamais des références.
const URL_NOISE = new Set(['en', 'fr', 'ca', 'us', 'www', 'products', 'product', 'productdetail', 'detail', 'catalog', 'item', 'html', 'aspx', 'php'])

function refsFromUrl(url) {
  const out = []
  const raw = String(url || '')
  if (!raw) return out
  const path = raw.split('?')[0].split('#')[0]
  for (let seg of path.split(/[/\\]/)) {
    seg = decodeURIComponent(seg || '').replace(/\.(html?|aspx|php)$/i, '')
    if (!seg || URL_NOISE.has(seg.toLowerCase())) continue
    if (seg.includes('.')) continue // domaine (digikey.ca, mouser.ca)
    if (isPartRef(seg)) out.push(seg)
    // OnlineComponents colle la référence au numéro de catalogue : « 759d02000-40678922 ».
    // Les morceaux courts sont écartés : « wau24 », tiré de « WAU24-1800 », désignerait
    // toute la famille de transfos plutôt que le modèle facturé.
    for (const part of seg.split('-')) if (compact(part).length >= 6 && isPartRef(part)) out.push(part)
  }
  return out
}

/**
 * Références identifiant la pièce d'un achat : référence fabricant saisie + celles
 * lisibles dans les URL fournisseur. Dédupliquées, forme compacte.
 */
export function partRefs(purchase = {}) {
  const out = new Set()
  // Référence propre à l'ACHAT (Airtable « Distributeur » = n° de pièce du distributeur,
  // « 2648-SC0193(9)-ND ») : c'est exactement ce que la facture Digikey imprime.
  for (const v of [purchase.part_mpn, purchase.part_mpn_alt, purchase.po_part_ref]) if (isPartRef(v)) out.add(compact(v))
  // URL de la pièce, de l'achat (« Lien web »), et celles collées dans ses notes.
  const noteUrls = String(purchase.notes || '').match(/https?:\/\/\S+/g) || []
  for (const url of [purchase.part_url, purchase.part_url_alt, purchase.po_url, ...noteUrls]) for (const r of refsFromUrl(url)) out.add(compact(r))
  return [...out]
}

// Une référence figure-t-elle dans le libellé imprimé ? Comparaison sur la forme
// compacte : la facture écrit « WAU24-1800 », « WAU241800 » ou « WAU24-1800-ND »
// (numéro Digikey) pour la même pièce.
export function refHit(description, refs = []) {
  if (!refs.length) return null
  const hay = compact(description)
  if (!hay) return null
  return refs.find(r => hay.includes(r)) || null
}

// ────────────────────────────────── scoring ──────────────────────────────────

const num = x => { const n = Number(x); return Number.isFinite(n) ? n : null }

// Proximité relative de deux montants : 1 si écart ≤ 1 %, décroît jusqu'à 0 à 25 %.
function amountScore(a, b) {
  const x = num(a), y = num(b)
  if (!x || !y || x <= 0 || y <= 0) return null
  const rel = Math.abs(x - y) / Math.max(x, y)
  if (rel <= 0.01) return 1
  if (rel >= 0.25) return 0
  return 1 - (rel - 0.01) / 0.24
}

const daysBetween = (a, b) => {
  const ta = Date.parse(a), tb = Date.parse(b)
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null
  return Math.round((tb - ta) / 86400000)
}

const lineAmount = line => num(line?.total) ?? (num(line?.unit_price) != null && num(line?.quantity) != null
  ? num(line.unit_price) * num(line.quantity) : null)

// UNITÉS QUI NE SE PARLENT PAS : le fournisseur facture au MÈTRE (« Câble 18-2c …,
// en mètres »), l'achat est suivi au PIED (« Fil 18 AWG 2 cond. (pied) »). Les mêmes
// 300 m et 984 pi semblaient alors deux quantités étrangères, et la ligne restait sans
// proposition alors que tout concordait. On convertit avant de comparer, et seulement
// quand les deux libellés NOMMENT leur unité — jamais sur un simple rapport numérique.
const M_TO_FT = 3.280839895

export function unitOfText(text) {
  const t = ` ${normalizeText(text)} `
  if (/ (m|metre|metres|meter|meters|metrique) /.test(t)) return 'm'
  if (/ (pi|pied|pieds|ft|foot|feet) /.test(t)) return 'ft'
  return null
}

// Quantité de la ligne exprimée dans l'unité de l'achat (null : rien à convertir).
export function convertQty(qty, fromUnit, toUnit) {
  if (!qty || !fromUnit || !toUnit || fromUnit === toUnit) return null
  if (fromUnit === 'm' && toUnit === 'ft') return qty * M_TO_FT
  if (fromUnit === 'ft' && toUnit === 'm') return qty / M_TO_FT
  return null
}

const lineUnitPrice = line => {
  const up = num(line?.unit_price)
  if (up) return up
  const t = num(line?.total), q = num(line?.quantity)
  return t && q ? t / q : null
}

/**
 * Score d'un couple (ligne de facture, achat LIA), dans [0, 1].
 *
 * Chaque signal n'est compté que si la donnée existe des deux côtés, et les poids sont
 * renormalisés sur les seuls signaux disponibles — un achat dont le prix unitaire n'est
 * pas encore connu (fréquent : le coût réel n'est saisi qu'à la facturation) n'est pas
 * pénalisé, il est jugé sur le nom, la quantité et la date.
 *
 * @param {Object} line    ligne extraite du reçu { description, quantity, unit_price, total }
 * @param {Object} purchase achat enrichi { lia_ref, part_name, part_sku, qty_ordered, unit_cost, order_date, ... }
 * @param {Object} ctx     { receiptDate, orderDate }
 */
export function scoreLine(line, purchase, ctx = {}) {
  const reasons = []
  const signals = []
  const detail = {}
  const add = (key, weight, value, reason) => {
    if (value == null) return
    signals.push({ weight, value })
    detail[key] = Math.round(value * 100) / 100
    if (reason && value >= 0.5) reasons.push(reason)
  }

  // Nom : description imprimée vs nom de la pièce (FR + EN). Le SKU est volontairement
  // EXCLU du texte comparé — c'est un numéro interne absent des factures, qui ne fait
  // que diluer la similarité (« RELAY GEN PURPOSE DPST 25A 24V » tombait de 0,75 à 0,67).
  // Il reste exploité séparément ci-dessous comme identifiant exact.
  const haystack = [purchase.part_name, purchase.part_name_en].filter(Boolean).join(' ')
  // Libellés APPRIS : la façon dont CE fournisseur a déjà désigné CETTE pièce sur ses
  // factures précédentes, tirée des rattachements confirmés par l'opérateur (cf.
  // learnLineAliases). Indispensable pour les fournisseurs qui ne nomment jamais la
  // pièce (« Achat de PCBs et Pièces » chez Fabrique Manic) : le nom du produit ne
  // sera jamais dans leur libellé, mais leur propre formulation, elle, se répète.
  const aliases = ctx.aliasesByPart?.get(partKey(purchase)) || []
  const nameSimDirect = tokenSimilarity(line?.description, haystack) || 0
  let aliasBest = 0, aliasLabel = null
  for (const a of aliases) {
    const sim = tokenSimilarity(line?.description, a) || 0
    if (sim > aliasBest) { aliasBest = sim; aliasLabel = a }
  }
  const nameSim = Math.max(nameSimDirect, aliasBest, 0)
  // Un SKU / une référence fabricant présent tel quel dans la description vaut une
  // concordance parfaite : c'est l'identifiant de la pièce, pas un mot du libellé.
  // Les SKU internes d'Orisha sont des nombres à 4 chiffres (1030, 1459) qui ne figurent
  // jamais sur une facture fournisseur mais peuvent s'y trouver par hasard (un montant,
  // une quantité) : seule une référence ALPHANUMÉRIQUE vaut identification.
  const sku = normalizeText(purchase.part_sku)
  const skuHit = sku.length >= 4 && /[a-z]/.test(sku) && new RegExp(`(^| )${sku}( |$)`).test(normalizeText(line?.description))
  // Référence FABRICANT (ou numéro de catalogue du distributeur) présente dans le
  // libellé : c'est l'identification la plus fiable qui existe sur une facture de
  // pièces — Digikey, Mouser et OnlineComponents impriment toujours la référence,
  // jamais le nom Orisha de la pièce.
  const refMatched = refHit(line?.description, purchase.part_refs || [])
  const identified = skuHit || !!refMatched
  const nameScore = identified ? 1 : nameSim

  // SUR QUOI REPOSE L'IDENTIFICATION de la pièce, en clair. Le nom Orisha d'une pièce
  // n'est presque jamais celui imprimé par le fournisseur : comparer les deux libellés
  // à l'œil ne prouve rien. Ce verdict dit ce qui, lui, prouve quelque chose —
  // référence fabricant, SKU, ou libellé déjà employé par CE fournisseur pour CETTE
  // pièce sur une facture passée (vocabulaire appris). L'UI l'affiche tel quel.
  const identity = refMatched
    ? { kind: 'ref', label: purchase.part_mpn || refMatched, score: 1 }
    : skuHit
      ? { kind: 'sku', label: purchase.part_sku, score: 1 }
      : (aliasBest > nameSimDirect && aliasBest >= NAME_GATE)
        ? { kind: 'alias', label: aliasLabel, score: Math.round(aliasBest * 100) / 100 }
        : nameSim >= NAME_GATE
          ? { kind: 'name', label: null, score: Math.round(nameSimDirect * 100) / 100 }
          : { kind: 'none', label: null, score: Math.round(nameSim * 100) / 100 }

  // GARDE-FOU : sans le moindre recouvrement de libellé, un couple ne peut pas être
  // proposé — même si le prix et la quantité coïncident. Sans cette garde, une facture
  // Amazon (« MoKo MagSafe Tripod Mount ») se faisait apparier à un achat de thermostat
  // au montant voisin : le prix seul n'identifie pas une pièce.
  if (!identified && nameScore < NAME_GATE) return { score: 0, reasons: [], identity, detail: { name: Math.round(nameScore * 100) / 100 } }

  const expectedTotal = num(purchase.unit_cost) && num(purchase.qty_ordered)
    ? num(purchase.unit_cost) * num(purchase.qty_ordered) : null
  const lineAmt = lineAmount(line)

  // GARDE-FOU MONÉTAIRE : quand le coût de la commande est connu, une ligne qui le
  // DÉPASSE largement ne peut pas être cette commande — une facture partielle est plus
  // petite que la commande, jamais quatre fois plus grosse. Sans cette garde, un mot
  // générique commun (« PCB » chez Fabrique Manic) suffisait à proposer une commande de
  // 2 431 $ pour une ligne de 10 230 $. Un SKU exact ou un libellé vraiment proche
  // (≥ 0,5) passe outre : c'est alors l'identification qui prime sur le montant.
  if (!identified && nameScore < 0.5 && expectedTotal && lineAmt && lineAmt > expectedTotal * OVERBILL_VETO) {
    return { score: 0, reasons: [], identity, detail: { name: Math.round(nameScore * 100) / 100, total: 0 } }
  }

  add('name', 0.45, nameScore, refMatched
    ? `référence ${purchase.part_mpn || refMatched} présente dans la description`
    : skuHit ? `SKU ${purchase.part_sku} présent dans la description` : 'libellé proche du nom de la pièce')
  // `ident` n'est pas un signal pondéré (il vaut déjà 1 sur le nom) : c'est le drapeau
  // qui ouvre la voie « identification » de l'écriture automatique (cf. isConfidentMatch).
  if (identified) detail.ident = 1

  // Prix unitaire et montant total de la ligne.
  // Quantité et unités : lues avant le prix, qui se convertit avec elles.
  const q = num(line?.quantity), qo = num(purchase.qty_ordered)
  const lineUnit = unitOfText(line?.description)
  const partUnit = unitOfText(haystack)
  const qConverted = convertQty(q, lineUnit, partUnit)

  const printedUnitPrice = lineUnitPrice(line)
  // Le prix suit l'unité : 0,86 $/m, c'est 0,26 $/pi.
  const convertedUnitPrice = printedUnitPrice && qConverted && q ? printedUnitPrice * (q / qConverted) : null
  const directUnit = amountScore(printedUnitPrice, purchase.unit_cost)
  const convUnit = amountScore(convertedUnitPrice, purchase.unit_cost)
  const unitScore = directUnit == null && convUnit == null ? null : Math.max(directUnit ?? 0, convUnit ?? 0)
  add('unit', 0.16, unitScore, 'prix unitaire concordant')
  add('total', 0.09, amountScore(lineAmt, expectedTotal), 'montant de ligne concordant')

  // Quantité : signal fort quand elle est exacte (100 unités commandées, 100 facturées).
  // Poids relevé (0,15 → 0,19) : avec le nom et la date de commande, c'est l'un des trois
  // signaux que l'opérateur veut voir trancher en premier — le prix unitaire d'un achat
  // encore à recevoir n'est souvent qu'une estimation, la quantité commandée ne l'est pas.
  if (q && qo) {
    const direct = q === qo ? 1 : (amountScore(q, qo) ?? 0)
    const converted = qConverted ? (amountScore(qConverted, qo) ?? 0) : 0
    const qScore = Math.max(direct, converted)
    const viaUnit = converted > direct
    add('qty', 0.19, qScore, viaUnit
      ? `quantité concordante une fois convertie (${q} ${lineUnit === 'm' ? 'm' : 'pi'} = ${Math.round(qConverted)} ${partUnit === 'ft' ? 'pi' : 'm'}, ${qo} commandés)`
      : `quantité ${q === qo ? 'identique' : 'proche'} (${qo} commandés)`)
  }

  // Commande encore SANS PRIX : dans le flux Achats, le coût unitaire est renseigné
  // quand la facture arrive. Une commande sans prix est donc, par construction, celle
  // qui ATTEND sa facture — c'est ce qui départage deux commandes de la même pièce
  // (l'ancienne, déjà chiffrée et facturée, contre la récente encore ouverte).
  // Signal volontairement faible : il propose, il ne conclut jamais seul (l'écriture
  // automatique exige une corroboration monétaire, cf. isConfidentMatch).
  if (!num(purchase.unit_cost)) add('open', 0.08, 1, 'commande encore sans prix — en attente de facturation')

  // À RECEVOIR : l'achat n'a pas de date de réception complète — c'est la section
  // « À recevoir » de l'interface Achats d'Airtable, celle des commandes encore en
  // vol. Une facture de pièces arrive presque toujours pour une de ces commandes,
  // d'où un signal franc (et le classement des candidats, cf. matchLines).
  if (purchase.pending_reception) add('pending', 0.10, 1, 'commande encore à recevoir')

  // RÉCEPTION : le fournisseur facture ce qu'il vient d'expédier. La date de réception
  // colle donc de très près à la date de facture (à quelques jours), là où la date de
  // COMMANDE peut la précéder de plusieurs mois. C'est le seul signal qui départage deux
  // achats jumeaux — même pièce, même quantité, prix voisin — dont l'un a été reçu en
  // mars et l'autre la semaine de la facture (cas Dubois : LIA-1877 vs LIA-1983).
  // Signal absent (achat pas encore reçu) = pas compté, pas pénalisé : une facture peut
  // précéder la réception (dépôt, précommande) et l'achat encore ouvert est déjà favorisé
  // par le signal « open ».
  if (ctx.receiptDate && purchase.received_date && String(purchase.received_date) > '1970-01-02') {
    const d = Math.abs(daysBetween(purchase.received_date, ctx.receiptDate) ?? 0)
    // 1 jusqu'à 21 jours (l'écart normal entre réception et facturation), décroissance
    // linéaire jusqu'à 0 à 180 jours.
    const recvScore = d <= RECV_NEAR_DAYS ? 1 : Math.max(0, 1 - (d - RECV_NEAR_DAYS) / (RECV_FAR_DAYS - RECV_NEAR_DAYS))
    add('recv', 0.14, recvScore, d <= RECV_NEAR_DAYS ? `reçu ${d} j avant la facture` : null)
  }

  // DATE DE COMMANDE IMPRIMÉE SUR LA FACTURE (« Date de la commande / Order Date » —
  // Digikey notamment l'imprime, distincte de la date de facture) : elle se compare
  // DIRECTEMENT à purchases.date_de_commande. C'est le signal le plus net qui existe pour
  // départager deux commandes de la MÊME pièce encore à recevoir — bien plus net que la
  // simple proximité avec la date de facture, puisque les deux dates désignent la même
  // chose. Cas réel Digikey : deux commandes de Raspberry Pi 4 (LIA-1998 commandé le
  // 17 août, LIA-2002 le 25 août) facturées séparément le 27 août — seule la date de
  // commande IMPRIMÉE sur chaque facture (17 et 20 août respectivement) les distingue,
  // la date de facture étant identique ou proche pour les deux.
  if (ctx.orderDate && purchase.order_date) {
    const d = Math.abs(daysBetween(purchase.order_date, ctx.orderDate) ?? 9999)
    const odScore = d === 0 ? 1 : Math.max(0, 1 - d / 30)
    add('order_date_match', 0.30, odScore, d === 0 ? 'date de commande imprimée identique' : (d <= 3 ? 'date de commande imprimée très proche' : null))
  } else if (ctx.receiptDate && purchase.order_date) {
    // Repli : la facture n'imprime pas de date de commande distincte — on retombe sur
    // la proximité (plus faible) entre la date de commande de l'achat et la date de
    // facture (un achat est commandé avant d'être facturé, parfois plusieurs mois avant).
    const d = daysBetween(purchase.order_date, ctx.receiptDate)
    if (d != null) {
      const dateScore = d < -WINDOW_AFTER_DAYS || d > WINDOW_BEFORE_DAYS
        ? 0
        : Math.max(0, 1 - Math.max(0, d) / WINDOW_BEFORE_DAYS)
      add('date', 0.08, dateScore, null)
    }
  }

  const totalWeight = signals.reduce((s, x) => s + x.weight, 0)
  if (!totalWeight) return { score: 0, reasons: [], identity, detail }
  let score = signals.reduce((s, x) => s + x.weight * x.value, 0) / totalWeight

  // Achat dont la facture est déjà entrée : matchReceiptItems l'écarte en amont du scoring
  // (un code consommé ne se propose pas). La pénalité ne joue donc que pour un appel direct
  // à scoreLine — classement d'un rattachement manuel, diagnostic.
  if (purchase.linked_receipts?.length) { score -= 0.10; reasons.push('déjà rattaché à une autre facture') }
  if (purchase.already_expensed) score -= 0.05

  return { score: Math.max(0, Math.min(1, score)), reasons, identity, detail }
}

// ───────────────────────────── candidats en base ─────────────────────────────

// Achats du fournisseur, dans la fenêtre de dates, enrichis du nom de pièce et des
// factures auxquelles ils sont déjà rattachés.
export function listCandidatePurchases({ company, vendorProfileId = null, excludeReceiptId = null } = {}) {
  const names = new Set()
  if (company) names.add(company)
  let qbIds = []
  if (vendorProfileId) {
    const prof = db.prepare('SELECT name, aliases, qb_vendor_id_cad, qb_vendor_id_usd FROM vendor_profiles WHERE id=? AND deleted_at IS NULL').get(vendorProfileId)
    if (prof) {
      names.add(prof.name)
      try { for (const a of JSON.parse(prof.aliases || '[]')) if (a) names.add(a) } catch {}
      qbIds = [prof.qb_vendor_id_cad, prof.qb_vendor_id_usd].filter(Boolean).map(String)
    }
  }
  const hasVendor = names.size > 0 || qbIds.length > 0

  const rows = db.prepare(`
    SELECT p.id, p.at_id, p.fournisseur AS supplier, p.supplier_vendor_name, p.supplier_qb_vendor_id,
           p.quantite_commande AS qty_ordered, p.prix_unitaire_cad AS unit_cost,
           p.date_de_commande AS order_date,
           -- « 1970-01-01 » = REÇU, date inconnue (c'est le cas de 1 700 vieux achats) :
           -- l'achat n'attend plus de facture. Le traiter comme « à recevoir » rendait tout
           -- l'historique candidat. Seule l'absence de date veut dire « à recevoir ».
           p.cf_date_de_reception_complete AS received_date,
           p.depense_line_item, p.notes_2 AS notes,
           pr.name_fr AS part_name, pr.name_en AS part_name_en, pr.sku AS part_sku,
           -- Valeur unitaire catalogue de la pièce. Sert UNIQUEMENT de POIDS quand une
           -- ligne de facture couvre plusieurs achats (cf. splitCoveredPurchases) : c'est
           -- un rapport entre pièces, jamais un montant publié — la devise du catalogue
           -- (CAD) n'a donc pas à concorder avec celle de la facture.
           COALESCE(NULLIF(CAST(pr.cout_unitaire AS REAL), 0),
                    NULLIF(CAST(pr.prix_moyen_500_derniers_jours AS REAL), 0),
                    NULLIF(CAST(pr.unit_cost AS REAL), 0)) AS part_unit_value,
           pr.fabricant AS part_mpn, pr.manufacturier AS part_mpn_alt,
           pr.lien_fournisseur AS part_url, pr.lien_fournisseur_alternatif AS part_url_alt,
           p.distributeur AS po_part_ref, p.lien_web AS po_url
    FROM purchases p
    LEFT JOIN products pr ON pr.airtable_id = ${PRODUCT_LINK_SQL}
    WHERE p.at_id IS NOT NULL AND p.at_id <> ''
  `).all()

  const linked = linkedPurchaseIndex(excludeReceiptId)

  const isVendor = r => {
    if (qbIds.length && r.supplier_qb_vendor_id && qbIds.includes(String(r.supplier_qb_vendor_id))) return true
    for (const n of names) {
      if (sameVendor(n, r.supplier_vendor_name) || sameVendor(n, r.supplier)) return true
    }
    return false
  }

  const shape = (r, otherVendor = false) => ({
    id: r.id,
    lia_ref: r.at_id,
    part_name: r.part_name,
    part_name_en: r.part_name_en,
    part_sku: r.part_sku,
    part_mpn: r.part_mpn || r.part_mpn_alt || null,
    // Références qui identifient la pièce sur une facture (fabricant + URL fournisseur).
    part_refs: partRefs({ part_mpn: r.part_mpn, part_mpn_alt: r.part_mpn_alt, part_url: r.part_url, part_url_alt: r.part_url_alt, po_part_ref: r.po_part_ref, po_url: r.po_url, notes: r.notes }),
    // Matière brute pour la lecture IA de la facture entière (purchaseLiaAi.js).
    po_part_ref: r.po_part_ref || null,
    po_url: r.po_url || null,
    notes: r.notes || null,
    qty_ordered: r.qty_ordered,
    unit_cost: r.unit_cost,
    part_unit_value: r.part_unit_value,
    order_date: r.order_date,
    received_date: r.received_date,
    // « À recevoir » : aucune date de réception complète dans Airtable — la commande
    // est encore en vol. C'est la section de l'interface Achats sur laquelle le
    // sélecteur et les suggestions sont cadrés.
    pending_reception: !r.received_date,
    // Le champ LIÉ « Fournisseurs » d'Airtable. `fournisseur` (single-select legacy
    // figé) ne contient plus qu'un identifiant brut « rec… » : jamais affiché.
    supplier: r.supplier_vendor_name || null,
    // Achat d'un AUTRE fournisseur, remonté en filet quand le fournisseur du reçu n'a
    // aucun achat candidat (cf. plus bas) : sélectionnable à la main, jamais noté.
    other_vendor: otherVendor,
    already_expensed: !!(r.depense_line_item && r.depense_line_item !== '[]'),
    linked_receipts: linked.get(r.id) || [],
    label: buildLiaLabel(r.at_id, r.part_name),
  })

  const finish = list => list
    // `consumed` : la facture de cet achat est déjà entrée. Jamais proposé automatiquement
    // (cf. matchReceiptItems), mais toujours sélectionnable à la main — un achat peut être
    // facturé en deux fois (dépôt + solde) et un rattachement erroné doit pouvoir se corriger.
    .map(c => ({ ...c, consumed: c.already_expensed || c.linked_receipts.length > 0 }))
    // Classement du sélecteur : codes libres d'abord, historique déjà facturé ensuite —
    // du plus récent au plus ancien dans chaque groupe. Tous les candidats sont, par
    // construction, « à recevoir » (cf. filtre ci-dessous) : il n'y a plus de groupe
    // intermédiaire « reçu, pas encore facturé ».
    .sort((a, b) => (rank(a) - rank(b)) || String(b.order_date || '').localeCompare(String(a.order_date || '')))

  // SCOPE STRICT « À RECEVOIR » : seuls les achats sans date de réception complète
  // (`received_date` vide — la section « À recevoir » de l'interface Achats d'Airtable)
  // sont des candidats, qu'ils soient rattachés à la main ou proposés par le moteur de
  // score. Un achat déjà reçu n'est PLUS remonté en filet quand aucun pending ne colle :
  // mieux vaut une liste vide (l'opérateur va chercher l'achat par son code) qu'une
  // proposition sur un achat qui n'attend plus de facture.
  const own = hasVendor ? rows.filter(isVendor).filter(r => !r.received_date).map(r => shape(r)) : []

  // AUTRES FOURNISSEURS : le fournisseur inscrit sur l'achat est souvent approximatif
  // (« Autre Fournisseur », distributeur au lieu du magasin). Le sélecteur présente donc
  // TOUJOURS, après ceux du fournisseur du reçu, les achats à recevoir des autres
  // fournisseurs — marqués `other_vendor`, purement manuels : jamais notés, jamais
  // proposés ni écrits d'office (cf. matchLines, splitCoveredPurchases). Cadrés « à
  // recevoir » et encore libres (ni dépense Airtable, ni autre reçu).
  const ownIds = new Set(own.map(c => c.id))
  const others = rows
    .filter(r => !r.received_date && !ownIds.has(r.id))
    .filter(r => !(r.depense_line_item && r.depense_line_item !== '[]'))
    .filter(r => !(linked.get(r.id) || []).length)
    .map(r => shape(r, true))
  return [...finish(own), ...finish(others)]
}

// Groupe d'un candidat, dans l'ordre où le sélecteur les présente.
//   0 « à recevoir »  — pas de date de réception, facture attendue (section Airtable) ;
//   2 « facturé »     — dépense déjà rattachée : historique, jamais proposé d'office.
// Tous les candidats renvoyés par listCandidatePurchases sont « à recevoir » (scope
// strict, cf. plus haut) : le groupe 1 « reçu, pas encore facturé » n'existe plus.
export const candidateTier = c => (c.consumed ? 2 : 0)
const rank = candidateTier

// Index achat → factures qui le référencent déjà (hors reçu courant). Le rattachement
// vit dans le JSON `items` du reçu : le volume (quelques centaines de reçus) permet de
// le scanner directement plutôt que de dupliquer le lien dans une table dédiée.
//
// Les documents à 0 $ sont écartés : un courriel fournisseur porte souvent la facture ET
// une pièce annexe (certificat de conformité, bordereau) que l'extracteur entre comme un
// reçu sans montant. Cette annexe rattachait le code LIA avant la vraie facture, qui se
// retrouvait ensuite sans proposition (« LIA-xxxx correspond, mais est déjà facturé »).
// Un document sans montant ne facture rien : il ne consomme plus l'achat.
export function linkedPurchaseIndex(excludeReceiptId = null) {
  const rows = db.prepare(`
    SELECT id, receipt_number, receipt_date, company, items
    FROM sale_receipts
    WHERE deleted_at IS NULL AND items LIKE '%purchase_id%'
      AND COALESCE(total, 0) <> 0
  `).all()
  const index = new Map()
  for (const r of rows) {
    if (excludeReceiptId && r.id === excludeReceiptId) continue
    let items = []
    try { items = JSON.parse(r.items || '[]') } catch { continue }
    for (const it of items) {
      if (!it?.purchase_id) continue
      if (!index.has(it.purchase_id)) index.set(it.purchase_id, [])
      index.get(it.purchase_id).push({ receipt_id: r.id, receipt_number: r.receipt_number, receipt_date: r.receipt_date, company: r.company })
    }
  }
  return index
}

// Clé de pièce d'un achat : deux achats du même produit partagent leurs libellés
// appris (une commande de PCB en mai et une autre en septembre = même pièce).
export const partKey = purchase => normalizeText(purchase?.part_name || purchase?.part_name_en || '') || null

/**
 * Libellés appris auprès d'un fournisseur : pour chaque pièce, les descriptions de
 * lignes que l'opérateur a DÉJÀ rattachées à un achat de cette pièce sur des factures
 * antérieures. C'est la mémoire du vocabulaire du fournisseur — le seul signal de nom
 * exploitable quand ses factures ne nomment pas les pièces.
 *
 * Les codes LIA eux-mêmes sont écartés : une description « LIA-1961 » n'apprend rien
 * sur le vocabulaire, elle ne ferait que se rapprocher d'elle-même.
 *
 * @returns {Map<string, string[]>} clé de pièce → libellés observés (max 8, récents d'abord)
 */
export function learnLineAliases({ candidates = [], excludeReceiptId = null } = {}) {
  const out = new Map()
  const byPurchaseId = new Map(candidates.map(c => [c.id, c]))
  if (!byPurchaseId.size) return out

  const rows = db.prepare(`
    SELECT id, items FROM sale_receipts
    WHERE deleted_at IS NULL AND items LIKE '%purchase_id%'
    ORDER BY COALESCE(receipt_date, created_at) DESC
    LIMIT 300
  `).all()

  // Toutes les pièces déjà achetées, pour relier un purchase_id historique — même
  // hors fenêtre de candidats — à sa pièce.
  const partById = new Map(db.prepare(`
    SELECT p.id, pr.name_fr AS part_name, pr.name_en AS part_name_en
    FROM purchases p LEFT JOIN products pr ON pr.airtable_id = ${PRODUCT_LINK_SQL}
  `).all().map(r => [r.id, partKey(r)]))

  for (const r of rows) {
    if (excludeReceiptId && r.id === excludeReceiptId) continue
    let items = []
    try { items = JSON.parse(r.items || '[]') } catch { continue }
    for (const it of items) {
      if (!it?.purchase_id) continue
      const key = partById.get(it.purchase_id)
      if (!key) continue
      // Le libellé imprimé par le fournisseur, conservé au rattachement
      // (source_description) puisque la description devient le code LIA.
      const desc = String(it.source_description || it.description || '').trim()
      if (!desc || hasLiaRef(desc)) continue
      const list = out.get(key) || []
      if (list.length < 8 && !list.includes(desc)) list.push(desc)
      out.set(key, list)
    }
  }
  return out
}

// ──────────────────────────────── appariement ────────────────────────────────

/**
 * Apparie les lignes d'un reçu à des achats LIA.
 *
 * Affectation gloutonne sur les couples triés par score décroissant : un achat n'est
 * pris qu'une fois PAR FACTURE (deux lignes d'une même facture ne peuvent pas désigner
 * le même achat), une ligne ne reçoit qu'un achat.
 *
 * @returns {{ lines: Array<{index, match, candidates}>, candidates: Array }}
 */
export function matchReceiptItems({ items, company, vendorProfileId = null, receiptDate = null, orderDate = null, excludeReceiptId = null, aiPicks = null }) {
  const candidates = listCandidatePurchases({ company, vendorProfileId, receiptDate, excludeReceiptId })
  // Vocabulaire appris du fournisseur (best effort : sans historique, on retombe
  // simplement sur la comparaison au nom de la pièce).
  let aliasesByPart = new Map()
  try { aliasesByPart = learnLineAliases({ candidates, excludeReceiptId }) } catch { /* pas bloquant */ }
  return matchLines({ items, candidates, receiptDate, orderDate, aliasesByPart, aiPicks })
}

/**
 * Cœur de l'appariement, sans accès à la base : les candidats et le vocabulaire appris
 * sont fournis par l'appelant. Séparé de matchReceiptItems pour que la logique de
 * sélection soit testable sur des jeux de candidats construits à la main.
 */
export function matchLines({ items, candidates = [], receiptDate = null, orderDate = null, aliasesByPart = new Map(), aiPicks = null }) {
  const list = Array.isArray(items) ? items : []
  const lines = list.map((_, index) => ({ index, match: null, candidates: [] }))
  if (!candidates.length) return { lines, candidates }
  const ctx = { receiptDate, orderDate, aliasesByPart }

  // CODES CONSOMMÉS : un achat dont la facture est déjà entrée — lien « Dépense Line item »
  // dans Airtable, ou rattachement à un autre reçu de l'ERP — n'est plus un code libre.
  // Il reste dans `candidates` (le sélecteur manuel doit permettre un dépôt + solde sur le
  // même achat, ou la correction d'un rattachement erroné), mais il n'est jamais NOTÉ :
  // aucune suggestion, aucune écriture d'office ne peut le désigner.
  // FILET AUTRE FOURNISSEUR : quand le fournisseur du reçu n'a aucun achat, la liste
  // s'ouvre à tous les achats à recevoir (cf. listCandidatePurchases). Ces achats sont
  // sélectionnables à la main mais jamais notés : un rapprochement fondé sur un autre
  // fournisseur ne peut pas être une certitude.
  //
  // SECTION « À RECEVOIR » SEULEMENT : un achat déjà reçu (date de réception, même
  // « 1970-01-01 » = reçu à une date inconnue) n'attend plus de facture — il n'est jamais
  // noté, quel que soit son âge ou la ressemblance de son nom. Cas réel : la facture DigiKey
  // du 2026-09-11 s'était vu rattacher des achats de 2025 portant le même nom de pièce.
  const scorable = candidates.filter(p => !p.other_vendor && p.pending_reception !== false)
  const openCandidates = scorable.filter(p => !p.already_expensed && !p.linked_receipts?.length)
  const consumedCandidates = scorable.filter(p => p.already_expensed || p.linked_receipts?.length)

  const pairs = []
  list.forEach((line, index) => {
    // Une ligne déjà rattachée à la main (ou déjà porteuse d'un code LIA saisi par
    // l'opérateur) n'est pas réappariée : l'automatisation ne défait jamais un choix humain.
    const locked = !!line?.purchase_id || hasLiaRef(line?.description)
    const scored = openCandidates
      .map(p => ({ purchase: p, ...scoreLine(line, p, ctx) }))
      .sort((a, b) => b.score - a.score)
    lines[index].candidates = scored.slice(0, 25)
    lines[index].locked = locked
    // CONTRÔLE DU RATTACHEMENT DÉJÀ FAIT : la ligne porte un achat (choisi par
    // l'opérateur ou écrit d'office). On rejoue le score contre CET achat pour dire à
    // l'UI sur quoi repose l'identification — la fiche n'a alors plus à deviner en
    // comparant deux libellés qui, par nature, ne se ressemblent pas.
    if (line?.purchase_id) {
      const linkedTo = candidates.find(c => String(c.id) === String(line.purchase_id))
      if (linkedTo) {
        // Le rattachement a réécrit la description en « LIA-xxxx⇥Nom de la pièce » :
        // la comparer au nom de la pièce serait circulaire. C'est le libellé IMPRIMÉ
        // par le fournisseur (conservé dans source_description) qui doit prouver
        // quelque chose.
        const printed = String(line.source_description || '').trim()
        const probe = printed ? { ...line, description: printed } : line
        const s = scoreLine(probe, linkedTo, ctx)
        lines[index].link_check = { score: Math.round(s.score * 100) / 100, identity: s.identity || null }
      }
    }
    if (locked) return

    // CADRAGE STRICT « À RECEVOIR » : `openCandidates` (donc `scored`) ne contient déjà que
    // des achats sans date de réception complète — listCandidatePurchases() ne renvoie plus
    // que ce scope (aucun filet vers un achat déjà reçu quand aucun pending ne colle : une
    // liste vide est préférable à une proposition sur un achat qui n'attend plus de facture).
    const pool = scored

    // GARDE-FOU DU RABATTEMENT : écarter les codes consommés ne doit pas faire remonter un
    // code libre MOINS pertinent à leur place. Si le meilleur achat déjà facturé colle
    // nettement mieux à la ligne que le meilleur achat libre, c'est que la ligne désigne
    // cet achat-là — la bonne réponse est « aucune proposition » (avec la mention de
    // l'achat en cause), pas un code libre plausible mais faux.
    const bestConsumed = consumedCandidates
      .map(p => ({ purchase: p, ...scoreLine(line, p, ctx) }))
      .sort((a, b) => b.score - a.score)[0]
    const best = pool[0]
    if (bestConsumed && bestConsumed.score >= LIA_SUGGEST_THRESHOLD && bestConsumed.score > (best?.score || 0) + AUTO_MIN_MARGIN) {
      lines[index].blocked_by = {
        lia_ref: bestConsumed.purchase.lia_ref,
        part_name: bestConsumed.purchase.part_name,
        score: Math.round(bestConsumed.score * 100) / 100,
        reason: bestConsumed.purchase.linked_receipts?.length ? 'déjà rattaché à une autre facture' : 'dépense déjà comptabilisée dans Airtable',
        receipts: bestConsumed.purchase.linked_receipts || [],
      }
      return
    }

    const eligible = pool.filter(s => s.score >= LIA_SUGGEST_THRESHOLD)
    if (!eligible.length) return

    // PLUSIEURS ACHATS AUSSI PLAUSIBLES (écart de score sous la marge) : on départage par
    // la date de commande la plus proche, puis la quantité, puis le montant. Égalité sur
    // les trois : aucun rattachement, la ligne est marquée « à vérifier ».
    const contenders = eligible.filter(s => s.score >= eligible[0].score - AUTO_MIN_MARGIN)
    let ranked = eligible
    let runnerUp = pool[1]?.score || 0
    if (contenders.length > 1) {
      const ref = orderDate || receiptDate
      const keys = s => {
        const gap = orderGapDays(s.purchase.order_date, ref)
        const q = num(line?.quantity), qo = num(s.purchase.qty_ordered)
        const amt = lineAmount(line)
        const expected = num(s.purchase.unit_cost) && qo ? num(s.purchase.unit_cost) * qo : null
        return [
          gap == null ? Infinity : Math.abs(gap),
          q && qo ? Math.abs(q - qo) : Infinity,
          amt != null && expected != null ? Math.abs(amt - expected) : Infinity,
        ]
      }
      const cmp = (a, b) => {
        const ka = keys(a), kb = keys(b)
        for (let k = 0; k < ka.length; k++) if (ka[k] !== kb[k]) return ka[k] - kb[k]
        return 0
      }
      const sorted = [...contenders].sort(cmp)
      if (cmp(sorted[0], sorted[1]) === 0) {
        lines[index].review = { reason: 'egalite', lia_refs: sorted.filter(c => cmp(c, sorted[0]) === 0).map(c => c.purchase.lia_ref) }
        return
      }
      // Le départage tient lieu d'écart : le gagnant n'est pas pénalisé par un jumeau
      // qu'une date plus proche a écarté. Les autres conditions de certitude
      // (isConfidentMatch) restent exigées.
      ranked = [sorted[0], ...eligible.filter(s => !contenders.includes(s))]
      runnerUp = eligible.find(s => !contenders.includes(s))?.score || 0
    }
    for (const s of ranked) pairs.push({ index, runnerUp, ...s })
  })

  // LECTURE DE LA FACTURE ENTIÈRE (purchaseLiaAi.js) : l'IA recoupe les indices — marque,
  // modèle, capacité, tension, n° distributeur, quantité, ce que les autres lignes ont
  // pris — là où le score ci-dessus compare des libellés mot pour mot. Sa proposition :
  //   - confirme le meilleur achat du score → il garde sa place, avec les indices ;
  //   - remplace une proposition fondée sur le seul libellé (jamais une référence
  //     fabricant ou un SKU identifiés, qui restent prioritaires) ;
  //   - comble une ligne sans proposition, ou départage des jumeaux « à vérifier ».
  // Toujours parmi les achats libres à recevoir de CE fournisseur.
  if (aiPicks?.size) {
    for (const [index, pick] of aiPicks) {
      const line = list[index]
      if (!line || lines[index].locked || lines[index].blocked_by) continue
      const purchase = openCandidates.find(c => c.lia_ref === pick.lia_ref)
      if (!purchase) continue
      const own = pairs.filter(p => p.index === index)
      const top = own.reduce((a, b) => (!a || b.score > a.score ? b : a), null)
      if (top?.detail?.ident === 1 && top.purchase.id !== purchase.id) continue
      const s = scoreLine(line, purchase, ctx)
      const agrees = top?.purchase.id === purchase.id
      const q = num(line?.quantity), qo = num(purchase.qty_ordered)
      for (let k = pairs.length - 1; k >= 0; k--) if (pairs[k].index === index) pairs.splice(k, 1)
      delete lines[index].review
      pairs.push({
        index,
        runnerUp: agrees ? top.runnerUp : 0,
        purchase,
        score: Math.max(s.score, pick.confidence),
        detail: { ...s.detail, ai: pick.confidence },
        identity: s.identity?.kind === 'ref' || s.identity?.kind === 'sku'
          ? s.identity
          : { kind: 'ai', label: pick.clues || null, score: pick.confidence },
        reasons: [...(pick.clues ? [`indices : ${pick.clues}`] : []), ...(s.reasons || [])],
        // Écriture d'office : l'IA très sûre ET la quantité identique, sans qu'un autre
        // achat ait été préféré par le score (jumeaux = toujours l'œil de l'opérateur).
        aiAuto: pick.confidence >= 0.9 && q != null && q === qo && (agrees || !top),
      })
    }
  }

  // DERNIER RECOURS — LA QUANTITÉ EXACTE DÉSIGNE UN SEUL ACHAT EN ATTENTE. Le vocabulaire
  // du fournisseur peut n'avoir AUCUN mot commun avec le nom Orisha de la pièce
  // (« Official Raspberry Pi microSD Card 64GB » contre « SDCIT2 - 16 GB - microSDHC »,
  // « circle stickers — motif vert » contre « Autocollant fan ») : le garde-fou du libellé
  // annule alors tout. Mais quand, parmi les achats encore à recevoir de CE fournisseur,
  // un seul a exactement la quantité facturée, il n'y a rien d'autre que ça puisse être.
  // Avec plusieurs achats ouverts, une quantité de 1 ne désigne rien (trop fréquente).
  // Proposition SEULEMENT — jamais d'écriture d'office, et le rattachement confirmé
  // apprend le libellé pour les prochaines factures.
  list.forEach((line, index) => {
    if (lines[index].locked || lines[index].blocked_by || lines[index].review?.reason === 'egalite') return
    if (pairs.some(p => p.index === index)) return
    const q = num(line?.quantity)
    if (!q || (q < 2 && openCandidates.length > 1)) return
    const sameQty = openCandidates.filter(p => num(p.qty_ordered) === q)
    if (sameQty.length !== 1) return
    const only = sameQty[0]
    pairs.push({
      index, runnerUp: 1, purchase: only, score: LIA_SUGGEST_THRESHOLD,
      detail: { qty: 1, only_pending: 1 }, identity: { kind: 'qty', label: null, score: 0 },
      reasons: [openCandidates.length === 1
        ? `seul achat encore à recevoir chez ce fournisseur, quantité identique (${q})`
        : `seul achat à recevoir chez ce fournisseur avec cette quantité (${q})`],
    })
  })

  pairs.sort((a, b) => b.score - a.score)
  const usedLines = new Set()
  const usedPurchases = new Set(list.filter(it => it?.purchase_id).map(it => it.purchase_id))
  for (const p of pairs) {
    if (usedLines.has(p.index) || usedPurchases.has(p.purchase.id)) continue
    usedLines.add(p.index)
    usedPurchases.add(p.purchase.id)
    lines[p.index].match = {
      purchase_id: p.purchase.id,
      lia_ref: p.purchase.lia_ref,
      part_name: p.purchase.part_name,
      description: buildLiaLabel(p.purchase.lia_ref, p.purchase.part_name),
      score: Math.round(p.score * 100) / 100,
      auto: !!p.aiAuto || isConfidentMatch(p, p.runnerUp),
      detail: p.detail,
      identity: p.identity || null,
      reasons: p.reasons,
      reused: p.purchase.linked_receipts,
      already_expensed: p.purchase.already_expensed,
      // Proposition venue du filet : l'achat est déjà reçu, il n'est plus dans la
      // section « À recevoir ». L'interface le dit.
      pending_reception: !!p.purchase.pending_reception,
      // Détails de l'achat servant à valider la suggestion d'un coup d'œil (équivalent
      // de ce que l'opérateur verrait dans la fiche Achats d'Airtable), sans avoir à
      // rechercher l'achat par ailleurs — cf. candidates[].
      qty_ordered: p.purchase.qty_ordered,
      unit_cost: p.purchase.unit_cost,
      order_date: p.purchase.order_date,
      supplier: p.purchase.supplier,
    }
  }
  return { lines, candidates }
}


// ───────────── une ligne de facture, plusieurs achats (découpage) ─────────────
//
// Le fournisseur ne facture pas toujours comme on achète. Advancing Alternatives
// imprime UNE ligne de 6 moteurs là où la table Achats en tient DEUX (côté gauche,
// côté droit, expédiés séparément), et met le kit eye bolt « inclus » dans la ligne
// du tuyau guide. L'achat sans ligne de facture n'a jamais de code publié dans
// QuickBooks : Airtable ne peut pas lui rattacher sa dépense, et Martin ne peut pas
// le réceptionner.
//
// On découpe donc la ligne en autant de lignes que d'achats couverts. Deux cas, et
// deux seulement — le reste est laissé tel quel :
//
//   A. UN ACHAT ORPHELIN QUE LA LIGNE DÉSIGNE. Après l'appariement, un achat du même
//      bon de commande (même date de commande que l'achat déjà porté par la ligne)
//      reste sans ligne alors que son libellé recoupe celle-ci (score ≥ seuil de
//      suggestion) : c'est la ligne qui le facture (« includes guide pipe hardware »).
//   B. LA QUANTITÉ SE CONSERVE. Une ligne sans appariement dont la quantité est
//      EXACTEMENT la somme des quantités des achats restants du même bon de commande
//      (6 = 3 + 3) : la ligne les facture tous, et aucun autre découpage n'est possible.
//
// Le montant de la ligne est réparti AU PRORATA de la valeur des pièces (quantité ×
// valeur unitaire catalogue) — un rapport, donc insensible à la devise. Sans valeur
// catalogue, le prorata se fait sur les quantités seules. Une pièce peut donc hériter
// d'un petit montant plutôt que du sien : c'est voulu, la facture ne le dit pas.
const round2 = n => Math.round((Number(n) || 0) * 100) / 100
const dayOf = d => (String(d || '').slice(0, 10) || null)

// Répartition d'un montant selon des poids, au cent près : le reste d'arrondi va à la
// plus grosse part pour que la somme retombe EXACTEMENT sur le montant de la ligne.
export function allocateAmount(total, weights) {
  const amount = round2(total)
  const w = weights.map(x => (Number(x) > 0 ? Number(x) : 0))
  const sum = w.reduce((s, x) => s + x, 0)
  const shares = sum > 0 ? w.map(x => x / sum) : w.map(() => 1 / w.length)
  const parts = shares.map(s => round2(amount * s))
  const drift = round2(amount - parts.reduce((s, x) => s + x, 0))
  if (drift) {
    let big = 0
    for (let i = 1; i < parts.length; i++) if (Math.abs(parts[i]) > Math.abs(parts[big])) big = i
    parts[big] = round2(parts[big] + drift)
  }
  return parts
}

// Poids d'un groupe d'achats : quantité × valeur catalogue quand TOUTES les pièces en
// ont une (sinon la comparaison serait faussée par celle qui vaut « 0 »), quantité sinon.
function splitWeights(purchases) {
  const qty = purchases.map(p => num(p.qty_ordered) || 1)
  const vals = purchases.map(p => num(p.part_unit_value))
  if (vals.every(v => v != null && v > 0)) return purchases.map((_, i) => qty[i] * vals[i])
  return qty
}

/**
 * Découpe les lignes qui couvrent plusieurs achats. Fonction pure : les candidats et
 * leurs scores par ligne viennent de matchLines().
 *
 * @returns {{ items: Array, splits: Array<{index, lia_refs}> }}
 */
export function splitCoveredPurchases({ items, lines = [], candidates = [] }) {
  const list = Array.isArray(items) ? items : []
  if (!list.length || !candidates.length) return { items: list, splits: [] }

  // Achat porté par chaque ligne : celui écrit sur la ligne, sinon la suggestion du
  // moteur (elle sera écrite avec le découpage — une ligne qui facture DEUX achats
  // n'est plus l'appariement ambigu que le garde-fou de marge refusait d'écrire).
  const byId = new Map(candidates.map(c => [String(c.id), c]))
  const anchors = list.map((it, i) => {
    const id = it?.purchase_id || lines?.[i]?.match?.purchase_id || null
    return id ? byId.get(String(id)) || null : null
  })

  const taken = new Set(anchors.filter(Boolean).map(a => String(a.id)))
  const orphans = candidates.filter(c => !c.other_vendor && !c.consumed && !taken.has(String(c.id)))
  if (!orphans.length) return { items: list, splits: [] }

  const groups = new Map()   // index de ligne → achats supplémentaires
  const addTo = (i, p) => { groups.set(i, [...(groups.get(i) || []), p]); taken.add(String(p.id)) }
  const scoreOn = (i, id) => lines?.[i]?.candidates?.find(c => String(c.purchase?.id) === String(id))?.score || 0

  // A. l'achat orphelin que la ligne désigne.
  for (const p of orphans) {
    if (taken.has(String(p.id))) continue
    let best = null
    list.forEach((it, i) => {
      const anchor = anchors[i]
      if (!anchor || !(lineAmount(it) > 0)) return
      if (dayOf(p.order_date) !== dayOf(anchor.order_date)) return
      const s = scoreOn(i, p.id)
      if (s < LIA_SUGGEST_THRESHOLD) return
      if (!best || s > best.score) best = { index: i, score: s }
    })
    if (best) addTo(best.index, p)
  }

  // B. la quantité se conserve sur une ligne encore sans achat.
  const left = orphans.filter(p => !taken.has(String(p.id)))
  const byDay = new Map()
  for (const p of left) {
    const d = dayOf(p.order_date)
    if (!d) continue
    byDay.set(d, [...(byDay.get(d) || []), p])
  }
  const anchorDays = new Set(anchors.filter(Boolean).map(a => dayOf(a.order_date)).filter(Boolean))
  for (const [day, group] of byDay) {
    if (group.length < 2 || !anchorDays.has(day)) continue
    const qtySum = group.reduce((s, p) => s + (num(p.qty_ordered) || 0), 0)
    if (!qtySum) continue
    const free = list
      .map((it, i) => ({ it, i }))
      .filter(({ it, i }) => !anchors[i] && !groups.has(i) && lineAmount(it) > 0 && num(it?.quantity) === qtySum)
    // Une seule ligne possible, sinon on ne sait pas laquelle porte le groupe.
    if (free.length !== 1) continue
    for (const p of group) addTo(free[0].i, p)
  }

  if (!groups.size) return { items: list, splits: [] }

  const out = []
  const splits = []
  list.forEach((it, i) => {
    const extra = groups.get(i)
    if (!extra?.length) { out.push(it); return }
    const group = [...(anchors[i] ? [anchors[i]] : []), ...extra]
      .sort((a, b) => String(a.lia_ref).localeCompare(String(b.lia_ref), 'fr', { numeric: true }))
    const parts = allocateAmount(lineAmount(it), splitWeights(group))
    const printed = it?.source_description || (hasLiaRef(it?.description) ? null : it?.description) || null
    group.forEach((p, k) => {
      const qty = num(p.qty_ordered)
      out.push({
        ...it,
        description: buildLiaLabel(p.lia_ref, p.part_name),
        source_description: printed,
        quantity: qty ?? it?.quantity ?? null,
        unit_price: qty ? round2(parts[k] / qty) : null,
        total: parts[k],
        purchase_id: p.id,
        lia_ref: p.lia_ref,
      })
    })
    splits.push({ index: i, lia_refs: group.map(p => p.lia_ref), amounts: parts })
  })
  return { items: out, splits }
}

/**
 * Applique les appariements CERTAINS (score ≥ LIA_AUTO_THRESHOLD) aux lignes : la
 * description devient « LIA-xxxx⇥Nom de la pièce » et la ligne mémorise l'achat.
 * Les appariements incertains ne touchent à rien — ils restent des suggestions.
 *
 * @returns {{ items: Array, applied: Array }} nouvelles lignes + résumé des réécritures
 */
export function applyAutoMatches(items, lines) {
  const list = Array.isArray(items) ? items : []
  const applied = []
  const next = list.map((it, i) => {
    const m = lines?.[i]?.match
    if (!m?.auto) return it
    applied.push({ index: i, lia_ref: m.lia_ref, score: m.score, from: it?.description || '' })
    // source_description = libellé imprimé par le fournisseur, conservé avant d'être
    // remplacé par le libellé LIA : il n'est plus publié, mais il alimente les libellés
    // appris (learnLineAliases) et reste consultable dans la fiche.
    return {
      ...it,
      source_description: it?.source_description || it?.description || null,
      description: m.description,
      purchase_id: m.purchase_id,
      lia_ref: m.lia_ref,
    }
  })
  return { items: next, applied }
}

/**
 * Point d'entrée de l'extraction : apparie puis applique les certitudes. Best effort —
 * toute erreur (achats indisponibles, données partielles) laisse les lignes intactes.
 */
export function autoLinkReceiptItems({ items, company, vendorProfileId = null, receiptDate = null, orderDate = null, excludeReceiptId = null, aiPicks = null }) {
  try {
    const { lines, candidates } = matchReceiptItems({ items, company, vendorProfileId, receiptDate, orderDate, excludeReceiptId, aiPicks })
    const applied = applyAutoMatches(items, lines)
    // Une ligne peut facturer PLUSIEURS achats (moteur gauche + droit, pièce « incluse ») :
    // elle est alors découpée, chaque achat recevant sa part du montant.
    const split = splitCoveredPurchases({ items: applied.items, lines, candidates })
    for (const s of split.splits) {
      console.log(`Appariement LIA: ligne ${s.index} découpée en ${s.lia_refs.length} achats (${s.lia_refs.join(', ')}) — ${s.amounts.join(' / ')}`)
    }
    return { items: split.items, applied: applied.applied, splits: split.splits }
  } catch (e) {
    console.warn(`Appariement LIA indisponible: ${e.message}`)
    return { items: Array.isArray(items) ? items : [], applied: [], splits: [] }
  }
}
