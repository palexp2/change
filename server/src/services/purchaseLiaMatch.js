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

// Nom de la pièce d'un achat, retrouvé par son code LIA — c'est la colonne voisine du
// code dans la table Achats (lien vers Produits). Sert à compléter une description qui
// ne porte que le code : lignes saisies à la main, ou écrites quand seul le code était
// publié.
function partNameByLiaRef(liaRef) {
  try {
    const row = db.prepare(`
      SELECT pr.name_fr, pr.name_en
      FROM purchases p LEFT JOIN products pr ON pr.id = p.product_id
      WHERE UPPER(p.at_id) = ?
      ORDER BY COALESCE(p.order_date, '') DESC LIMIT 1
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
}

// Traduction AVANT la mise au singulier : « relais » est déjà la forme canonique, alors
// que singularize() en ferait « relai » et raterait « relay » du côté anglais.
const canonical = t => LEXICON[t] || LEXICON[singularize(t)] || singularize(t)

const tokenize = s => normalizeText(s).split(' ').filter(t => t && !STOP_TOKENS.has(t)).map(canonical)

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
  for (const v of [purchase.part_mpn, purchase.part_mpn_alt]) if (isPartRef(v)) out.add(compact(v))
  for (const url of [purchase.part_url, purchase.part_url_alt]) for (const r of refsFromUrl(url)) out.add(compact(r))
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
  const nameSim = Math.max(
    tokenSimilarity(line?.description, haystack),
    ...aliases.map(a => tokenSimilarity(line?.description, a)),
    0,
  )
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

  // GARDE-FOU : sans le moindre recouvrement de libellé, un couple ne peut pas être
  // proposé — même si le prix et la quantité coïncident. Sans cette garde, une facture
  // Amazon (« MoKo MagSafe Tripod Mount ») se faisait apparier à un achat de thermostat
  // au montant voisin : le prix seul n'identifie pas une pièce.
  if (!identified && nameScore < NAME_GATE) return { score: 0, reasons: [], detail: { name: Math.round(nameScore * 100) / 100 } }

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
    return { score: 0, reasons: [], detail: { name: Math.round(nameScore * 100) / 100, total: 0 } }
  }

  add('name', 0.45, nameScore, refMatched
    ? `référence ${purchase.part_mpn || refMatched} présente dans la description`
    : skuHit ? `SKU ${purchase.part_sku} présent dans la description` : 'libellé proche du nom de la pièce')
  // `ident` n'est pas un signal pondéré (il vaut déjà 1 sur le nom) : c'est le drapeau
  // qui ouvre la voie « identification » de l'écriture automatique (cf. isConfidentMatch).
  if (identified) detail.ident = 1

  // Prix unitaire et montant total de la ligne.
  const unitScore = amountScore(lineUnitPrice(line), purchase.unit_cost)
  add('unit', 0.16, unitScore, 'prix unitaire concordant')
  add('total', 0.09, amountScore(lineAmt, expectedTotal), 'montant de ligne concordant')

  // Quantité : signal fort quand elle est exacte (100 unités commandées, 100 facturées).
  // Poids relevé (0,15 → 0,19) : avec le nom et la date de commande, c'est l'un des trois
  // signaux que l'opérateur veut voir trancher en premier — le prix unitaire d'un achat
  // encore à recevoir n'est souvent qu'une estimation, la quantité commandée ne l'est pas.
  const q = num(line?.quantity), qo = num(purchase.qty_ordered)
  if (q && qo) {
    const qScore = q === qo ? 1 : (amountScore(q, qo) ?? 0)
    add('qty', 0.19, qScore, `quantité ${q === qo ? 'identique' : 'proche'} (${qo} commandés)`)
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
  if (ctx.receiptDate && purchase.received_date) {
    const d = Math.abs(daysBetween(purchase.received_date, ctx.receiptDate) ?? 0)
    // 1 jusqu'à 21 jours (l'écart normal entre réception et facturation), décroissance
    // linéaire jusqu'à 0 à 180 jours.
    const recvScore = d <= RECV_NEAR_DAYS ? 1 : Math.max(0, 1 - (d - RECV_NEAR_DAYS) / (RECV_FAR_DAYS - RECV_NEAR_DAYS))
    add('recv', 0.14, recvScore, d <= RECV_NEAR_DAYS ? `reçu ${d} j avant la facture` : null)
  }

  // DATE DE COMMANDE IMPRIMÉE SUR LA FACTURE (« Date de la commande / Order Date » —
  // Digikey notamment l'imprime, distincte de la date de facture) : elle se compare
  // DIRECTEMENT à purchases.order_date. C'est le signal le plus net qui existe pour
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
  if (!totalWeight) return { score: 0, reasons: [], detail }
  let score = signals.reduce((s, x) => s + x.weight * x.value, 0) / totalWeight

  // Achat dont la facture est déjà entrée : matchReceiptItems l'écarte en amont du scoring
  // (un code consommé ne se propose pas). La pénalité ne joue donc que pour un appel direct
  // à scoreLine — classement d'un rattachement manuel, diagnostic.
  if (purchase.linked_receipts?.length) { score -= 0.10; reasons.push('déjà rattaché à une autre facture') }
  if (purchase.already_expensed) score -= 0.05

  return { score: Math.max(0, Math.min(1, score)), reasons, detail }
}

// ───────────────────────────── candidats en base ─────────────────────────────

// Achats du fournisseur, dans la fenêtre de dates, enrichis du nom de pièce et des
// factures auxquelles ils sont déjà rattachés.
export function listCandidatePurchases({ company, vendorProfileId = null, receiptDate = null, excludeReceiptId = null } = {}) {
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
  if (!names.size && !qbIds.length) return []

  const rows = db.prepare(`
    SELECT p.id, p.at_id, p.supplier, p.supplier_vendor_name, p.supplier_qb_vendor_id,
           p.qty_ordered, p.unit_cost, p.order_date, p.received_date, p.status,
           p.depense_line_item, p.notes,
           pr.name_fr AS part_name, pr.name_en AS part_name_en, pr.sku AS part_sku,
           pr.fabricant AS part_mpn, pr.manufacturier AS part_mpn_alt,
           pr.lien_fournisseur AS part_url, pr.lien_fournisseur_alternatif AS part_url_alt
    FROM purchases p
    LEFT JOIN products pr ON pr.id = p.product_id
    WHERE p.at_id IS NOT NULL AND p.at_id <> ''
  `).all()

  const dateFloor = receiptDate ? new Date(Date.parse(receiptDate) - WINDOW_BEFORE_DAYS * 86400000).toISOString().slice(0, 10) : null
  const dateCeil = receiptDate ? new Date(Date.parse(receiptDate) + WINDOW_AFTER_DAYS * 86400000).toISOString().slice(0, 10) : null

  const linked = linkedPurchaseIndex(excludeReceiptId)

  const inWindow = r => {
    if (!dateFloor || !r.order_date) return true
    return r.order_date >= dateFloor && r.order_date <= dateCeil
  }
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
    part_refs: partRefs({ part_mpn: r.part_mpn, part_mpn_alt: r.part_mpn_alt, part_url: r.part_url, part_url_alt: r.part_url_alt }),
    qty_ordered: r.qty_ordered,
    unit_cost: r.unit_cost,
    order_date: r.order_date,
    received_date: r.received_date,
    // « À recevoir » : aucune date de réception complète dans Airtable — la commande
    // est encore en vol. C'est la section de l'interface Achats sur laquelle le
    // sélecteur et les suggestions sont cadrés.
    pending_reception: !r.received_date,
    status: r.status,
    supplier: r.supplier_vendor_name || r.supplier,
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
    // Classement du sélecteur : « à recevoir » d'abord, puis les commandes reçues dont
    // la facture n'est pas encore entrée, puis l'historique déjà facturé — du plus
    // récent au plus ancien dans chaque groupe.
    .sort((a, b) => (rank(a) - rank(b)) || String(b.order_date || '').localeCompare(String(a.order_date || '')))

  const own = rows.filter(isVendor).filter(inWindow).map(r => shape(r))
  if (own.length) return finish(own)

  // FILET « AUCUN ACHAT CHEZ CE FOURNISSEUR » : le fournisseur inscrit sur l'achat est
  // souvent approximatif (« Autre Fournisseur », distributeur au lieu du magasin), et le
  // cadrage par fournisseur laisse alors la ligne sans aucun code à choisir. Plutôt que
  // de rendre une liste vide, on ouvre la recherche à TOUS les achats encore à recevoir,
  // tous fournisseurs confondus — ils sont marqués `other_vendor` et restent purement
  // manuels : rien n'est proposé ni écrit d'office sur la foi d'un autre fournisseur.
  const pending = rows
    .filter(r => !r.received_date)
    .filter(r => !(r.depense_line_item && r.depense_line_item !== '[]'))
    .filter(r => !(linked.get(r.id) || []).length)
    .map(r => shape(r, true))
  return finish(pending)
}

// Groupe d'un candidat, dans l'ordre où le sélecteur les présente.
//   0 « à recevoir »  — pas de date de réception, facture attendue (section Airtable) ;
//   1 « reçu »        — marchandise arrivée, facture pas encore entrée ;
//   2 « facturé »     — dépense déjà rattachée : historique, jamais proposé d'office.
export const candidateTier = c => (c.consumed ? 2 : c.pending_reception ? 0 : 1)
const rank = candidateTier

// Index achat → factures qui le référencent déjà (hors reçu courant). Le rattachement
// vit dans le JSON `items` du reçu : le volume (quelques centaines de reçus) permet de
// le scanner directement plutôt que de dupliquer le lien dans une table dédiée.
export function linkedPurchaseIndex(excludeReceiptId = null) {
  const rows = db.prepare(`
    SELECT id, receipt_number, receipt_date, company, items
    FROM sale_receipts
    WHERE deleted_at IS NULL AND items LIKE '%purchase_id%'
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
    FROM purchases p LEFT JOIN products pr ON pr.id = p.product_id
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
export function matchReceiptItems({ items, company, vendorProfileId = null, receiptDate = null, orderDate = null, excludeReceiptId = null }) {
  const candidates = listCandidatePurchases({ company, vendorProfileId, receiptDate, excludeReceiptId })
  // Vocabulaire appris du fournisseur (best effort : sans historique, on retombe
  // simplement sur la comparaison au nom de la pièce).
  let aliasesByPart = new Map()
  try { aliasesByPart = learnLineAliases({ candidates, excludeReceiptId }) } catch { /* pas bloquant */ }
  return matchLines({ items, candidates, receiptDate, orderDate, aliasesByPart })
}

/**
 * Cœur de l'appariement, sans accès à la base : les candidats et le vocabulaire appris
 * sont fournis par l'appelant. Séparé de matchReceiptItems pour que la logique de
 * sélection soit testable sur des jeux de candidats construits à la main.
 */
export function matchLines({ items, candidates = [], receiptDate = null, orderDate = null, aliasesByPart = new Map() }) {
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
  const scorable = candidates.filter(p => !p.other_vendor)
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
    if (locked) return

    // CADRAGE « À RECEVOIR » : une facture de pièces règle presque toujours une commande
    // encore en vol — la section « À recevoir » de l'interface Achats d'Airtable. Ce sont
    // ces achats-là, et eux seuls, qu'on propose tant que l'un d'eux tient la route.
    // Le reste (commandes déjà reçues mais pas encore facturées) ne sert que de filet,
    // quand aucune commande en attente ne ressemble à la ligne : la facture qui arrive
    // après que la réception a été cochée est un cas courant (Simplex, Digikey), et la
    // laisser sans code obligerait à rouvrir tout l'historique à la main. Les achats
    // DÉJÀ FACTURÉS, eux, ne sont jamais notés (cf. openCandidates).
    // Le cadrage reste strict : tant qu'un achat À RECEVOIR tient la route, c'est lui (et
    // lui seul) qui est proposé — jamais un achat déjà reçu à sa place. C'est la quantité
    // commandée qui doit départager deux commandes de la même pièce encore en vol, pas un
    // repli vers l'historique reçu (cf. calibrage qty ci-dessous : cas réel Digikey où
    // LIA-1999, qté 2 exacte, avait été écarté par une donnée Airtable corrompue plutôt
    // que par ce cadrage — une fois la donnée corrigée, le score qty tranche seul).
    const scoredPending = scored.filter(s => s.purchase.pending_reception)
    const usePending = (scoredPending[0]?.score || 0) >= LIA_SUGGEST_THRESHOLD
    const pool = usePending ? scoredPending : scored

    // GARDE-FOU DU RABATTEMENT : écarter les codes consommés ne doit pas faire remonter un
    // code libre MOINS pertinent à leur place. Si le meilleur achat déjà facturé colle
    // nettement mieux à la ligne que le meilleur achat libre, c'est que la ligne désigne
    // cet achat-là — la bonne réponse est « aucune proposition » (avec la mention de
    // l'achat en cause), pas un code libre plausible mais faux. Cas réel Dubois : la valve
    // Rainbird de juillet étant déjà facturée, le moteur proposait une valve Irritrol de
    // 2025 restée libre.
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

    // L'écart au 2e candidat de la MÊME ligne conditionne l'écriture automatique.
    const runnerUp = pool[1]?.score || 0
    for (const s of pool) if (s.score >= LIA_SUGGEST_THRESHOLD) pairs.push({ index, runnerUp, ...s })
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
      auto: isConfidentMatch(p, p.runnerUp),
      detail: p.detail,
      reasons: p.reasons,
      reused: p.purchase.linked_receipts,
      already_expensed: p.purchase.already_expensed,
      // Proposition venue du filet : l'achat est déjà reçu, il n'est plus dans la
      // section « À recevoir ». L'interface le dit.
      pending_reception: !!p.purchase.pending_reception,
    }
  }
  return { lines, candidates }
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
export function autoLinkReceiptItems({ items, company, vendorProfileId = null, receiptDate = null, orderDate = null, excludeReceiptId = null }) {
  try {
    const { lines } = matchReceiptItems({ items, company, vendorProfileId, receiptDate, orderDate, excludeReceiptId })
    return applyAutoMatches(items, lines)
  } catch (e) {
    console.warn(`Appariement LIA indisponible: ${e.message}`)
    return { items: Array.isArray(items) ? items : [], applied: [] }
  }
}
