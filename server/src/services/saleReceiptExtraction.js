import { readFileSync } from 'fs'
import { spawnSync } from 'child_process'
import db from '../db/database.js'
import { emitEntity } from './realtimeEmitters.js'
import { logSync } from './syncLog.js'
import { buildTransportInvoice } from './transportInvoice.js'
import { buildVendorExtractionContext, findVendorProfile, computeDueDate } from './vendorProfiles.js'
import { TRANSACTION_TYPES, getTransactionType } from './fiscalStatus.js'
import { resolveServicePeriod, annotateItemsWithPeriod, annotateDescriptionWithPeriod } from './servicePeriod.js'
import { autoLinkReceiptItems } from './purchaseLiaMatch.js'
import { applyAwsInvoice } from './awsInvoice.js'
import { applyMealTaxCodeNames, reconcileMealAmounts, isTipLine } from './mealReceipt.js'
import { round2Safe as round2 } from '../utils/money.js'

// Ré-exportés ici pour compatibilité : ces filets vivent désormais dans servicePeriod.js
// (le moteur de période complet), qui est aussi utilisé au moment de la publication QB.
export { annotateItemsWithPeriod, annotateDescriptionWithPeriod }

const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp']


// Référentiel des types de transaction fiscaux (fiscalStatus.js) injecté dans le
// prompt : l'IA classe le document d'après son CONTENU (nature de l'achat, pays de
// l'émetteur, taxes réellement facturées) — signal « document » du résolveur de
// détection fiscale (fiscalDetection.js), toujours à confirmer par l'opérateur.
const TX_TYPE_CATALOG = TRANSACTION_TYPES
  .filter(t => t.side !== 'vente')
  .map(t => `- "${t.key}" : ${t.label}. ${t.note}`)
  .join('\n')

const SYSTEM_PROMPT = `Tu es un assistant spécialisé dans l'extraction de données de reçus, factures et relevés que NOTRE entreprise a REÇUS de ses fournisseurs/marchands.

CONTEXTE CRITIQUE — qui est qui sur le document :
- NOTRE entreprise (l'ACHETEUR, le destinataire de la facture) s'appelle « Automatisation Orisha Inc » (variantes : « Orisha », « Orisha Inc », « Automatisation Orisha »). C'est NOUS. Notre adresse est « 1535 ch. Sainte-Foy, bureau 220, Québec QC G1S 2P1 ».
- Le champ "company" doit TOUJOURS contenir le nom du FOURNISSEUR / MARCHAND / ÉMETTEUR du document — l'entité à qui nous avons payé, celle qui a émis la facture. Ce n'est JAMAIS « Orisha » ni aucune de ses variantes : Orisha est l'acheteur, pas le vendeur.
- Notre nom (Orisha) apparaît souvent bien en évidence en haut du document parce qu'il est le DESTINATAIRE (sous « Facturé à / Vendu à / Livré à / Bill to / Ship to », ou à côté de l'adresse de Québec ci-dessus). Ne te laisse pas piéger : ce n'est pas l'émetteur.
- Pour trouver le vrai émetteur, cherche : le logo / l'en-tête de marque, le pied de page, les mentions « Émis par / Vendu par / Payable à », le numéro de téléphone de marque, le site web ou le domaine d'un courriel (ex. « bell.ca » → Bell ; « 310-BELL » → Bell), les coordonnées du marchand. Déduis le nom du marchand de ces indices même s'il n'est pas écrit en toutes lettres comme raison sociale.
- Ne mets "company" = null que si, après avoir vraiment cherché, aucun émetteur distinct d'Orisha n'est identifiable.
- Le champ "address" doit être l'adresse du FOURNISSEUR/MARCHAND (l'émetteur), pas notre adresse de Québec.

Extrait toutes les informations disponibles et retourne un JSON valide avec exactement cette structure:
{
  "receipt_date": "YYYY-MM-DD ou null",
  "order_date": "YYYY-MM-DD — date de la COMMANDE imprimée sur le document (« Date de la commande », « Order Date », « PO Date »), distincte de la date de facture, ou null si absente",
  "company": "nom du fournisseur/marchand qui a émis le document — jamais Orisha — ou null",
  "address": "adresse du fournisseur/marchand (l'émetteur) ou null",
  "receipt_number": "numéro de reçu/facture ou null",
  "general_description": "résumé d'UNE seule ligne décrivant l'objet PRINCIPAL du document — ce qui a été acheté, en termes généraux — ou null",
  "service_period": "période de service couverte par la facture, libellé concis, ou null",
  "items": [{"description": "...", "quantity": 1, "unit_price": 0.00, "total": 0.00}],
  "shipments": [{"carrier": "...", "destination_province": "QC|ON|...|null", "destination_country": "CA|US|...", "total": 0.00, "taxes": [{"label": "TPS|TVQ|TVH|PST|...", "amount": 0.00}]}],
  "subtotal": 0.00,
  "tps": 0.00,
  "tvq": 0.00,
  "other_taxes": 0.00,
  "discount_amount": 0.00,
  "freight_amount": 0.00,
  "total": 0.00,
  "payment_method": "méthode de paiement ou null",
  "currency": "CAD ou USD — voir la RÈGLE DEVISE, ne pas mettre CAD par défaut",
  "due_date": "YYYY-MM-DD ou null",
  "payment_terms_days": 0,
  "transaction_type": "clé de classification fiscale TPS/TVQ (voir la règle dédiée) ou null",
  "notes": "autres informations pertinentes ou null"
}

RÈGLE — "order_date" (date de la commande) :
- Certains fournisseurs (Digikey notamment) impriment une « Date de la commande / Order Date » DISTINCTE de la « Date de facturation / Invoice Date » — la commande a pu être passée plusieurs jours ou semaines avant que cette expédition partielle soit facturée. Capture cette date exacte : elle sert à rapprocher automatiquement la ligne du bon de commande interne correspondant (cf. règle quantité/prix unitaire ci-dessous), en particulier quand plusieurs commandes de la même pièce sont en cours.
- Si le document n'imprime qu'une seule date (pas de distinction commande/facture), laisse "order_date" à null.

RÈGLE — TERMES DE PAIEMENT ET ÉCHÉANCE :
- "due_date" : la date d'échéance de paiement IMPRIMÉE sur le document (« Due date », « Date d'échéance », « Payable avant le… »). null si aucune date d'échéance explicite.
- "payment_terms_days" : le délai de paiement en JOURS si le document mentionne des termes (« Payment due 21 days from date of invoice » → 21 ; « Net 30 » → 30 ; « Terms: Net 45 » → 45 ; « payable à réception » → 0). 0 si aucun terme mentionné.
- Si seuls les termes sont imprimés (pas de date d'échéance explicite), laisse "due_date" à null — elle sera calculée automatiquement depuis la date du document.

RÈGLE — "general_description" (objet principal du document) :
- C'est une SEULE phrase courte qui résume ce qui a été acheté, en termes généraux — la description principale de la facture, PAS la liste des articles. Ex. : « Pièces de plomberie », « Abonnement logiciel mensuel », « Matériel électronique et câblage », « Location d'équipement de chantier ».
- Si le document ne contient qu'un seul article ou un seul type de produit/service, reprends-le tel quel. S'il y a plusieurs articles, donne la catégorie/le thème qui les regroupe — ne les énumère pas.
- N'y mets jamais les montants, les quantités ni le numéro de facture. Reste sous ~80 caractères.

RÈGLE — "service_period" (période couverte par la facture) :
- Beaucoup de factures couvrent une PÉRIODE de service plutôt qu'un achat ponctuel : abonnements logiciels/SaaS, télécom et cellulaires, hébergement, licences, assurances, loyers, contrats d'entretien, frais de service mensuels. Trouve cette période et écris-la dans "service_period".
- Cherche partout : « Période de facturation », « Billing period », « Service period », « Pour la période du … au … », « Jul 1 – Jul 31, 2026 », « Abonnement du 15/07 au 14/08 », « Mois de juillet », un cycle indiqué à côté du montant récurrent, ou les dates de début/fin de cycle imprimées dans l'en-tête ou sur la ligne d'article.
- Format CONCIS, en français :
  - période alignée sur un mois civil complet → « juillet 2026 » ;
  - plusieurs mois complets → « juillet–septembre 2026 » (ou « déc. 2026 – févr. 2027 ») ;
  - période à cheval sur deux mois → « 15 juil. – 14 août 2026 » ;
  - année complète → « année 2026 » ; trimestre → « T3 2026 ».
- N'INVENTE PAS de période : si le document ne couvre pas une période de service (achat de matériel, pièces, repas, transport ponctuel…) ou si aucune période n'est identifiable, mets null. La date de facture seule n'est PAS une période.
- Quand une période existe, elle doit se LIRE directement dans les descriptions, pas seulement dans "service_period" : ajoute-la en suffixe à la fin de la "general_description" ET à la fin de la "description" des articles concernés, sous la forme « … — juillet 2026 » (ex. general_description : « Abonnement téléphonie IP — juillet 2026 »). Si des lignes couvrent des périodes DIFFÉRENTES (ex. prorata du mois en cours + mois suivant d'avance), mets la période propre à chaque ligne dans SA description, et dans "service_period" la période globale couverte par la facture.

RÈGLE — QUANTITÉ ET PRIX UNITAIRE DE CHAQUE LIGNE (NE JAMAIS OMETTRE) :
- "quantity" et "unit_price" sont OBLIGATOIRES dès que le document les imprime, même dans une colonne étroite, abrégée (« Qté », « Qty », « Ship Qty », « Units », « Ea », « x100 ») ou collée au libellé (« PCB Module x 100 », « 100 un. @ 89,91 »). Ne les laisse à null QUE si le document n'affiche vraiment ni quantité ni prix unitaire pour cette ligne (frais forfaitaire, service au montant global).
- La quantité est le NOMBRE D'UNITÉS FACTURÉES sur cette ligne, jamais un numéro d'article, un code, une taille de lot imprimée dans le nom de la pièce, ni un poids. Reste un nombre nu (100, pas « 100 pcs »).
- Cohérence : quantity × unit_price doit égaler items[].total (à un cent près). Si la facture n'imprime que deux des trois valeurs, DÉDUIS la troisième et écris-la (total ÷ quantité = prix unitaire).
- Ces deux champs servent à rapprocher automatiquement la ligne du bon de commande interne correspondant (une commande de 100 unités se reconnaît à sa ligne de 100 unités). Une quantité omise alors qu'elle est imprimée fait échouer ce rapprochement : relis la ligne avant de mettre null.

RÈGLES DE COHÉRENCE DES MONTANTS (TRÈS IMPORTANT — vérifie le calcul avant de répondre) :
- "subtotal" est le montant HORS TAXES (HT). L'invariant doit TOUJOURS tenir : subtotal + tps + tvq + other_taxes = total. Refais le calcul et ajuste les montants pour qu'il soit exact (à un cent près).
- Ne mets JAMAIS subtotal = total quand il y a des taxes (tps ou tvq > 0). Si aucun sous-total HT explicite n'est affiché, calcule-le : subtotal = total - tps - tvq - other_taxes.
- FACTURES AMAZON et autres marchands à PRIX TAXES INCLUSES : le prix par article et le sous-total affichés peuvent déjà contenir la taxe. Dans ce cas, ramène "subtotal" au vrai HT (total - taxes) — n'inscris pas le montant taxes-incluses comme sous-total, sinon la taxe est comptée deux fois en comptabilité.
- FACTURES DE TÉLÉCOM MULTI-LIGNES (Bell Mobilité, Telus, Vidéotron…) : chaque numéro de téléphone a sa page, terminée par un « Total frais courants » qui INCLUT DÉJÀ ses TPS/TVQ. N'inscris JAMAIS ces totaux par numéro comme items[].total. Utilise les frais HORS TAXES de chaque numéro (total du numéro - ses taxes), et vérifie que la somme des lignes égale le « Frais mensuels » HT du sommaire de la 1re page (ex. Bell : 4 numéros à 47,77/47,77/47,77/53,52 taxes comprises → sommaire « Frais mensuels 171,20 » + taxes 25,63 = total 196,83 ; les lignes doivent totaliser 171,20, pas 196,83).
- "items[].total" est le montant HORS TAXES de la ligne ; la somme des items[].total doit égaler subtotal. N'inscris JAMAIS une ligne de taxe (TPS, GST, TVQ, QST, TVH/HST) comme un article : les taxes vont uniquement dans tps / tvq / other_taxes.
- LIGNES DE CRÉDIT / PRORATION (changement de forfait en cours de cycle : Stripe, Anthropic, OpenAI, Google Workspace…) : une ligne « Unused time on… », « Crédit », « Credit », « Remise », « Rabais », « Proration » RETRANCHE du sous-total. Son "total" doit être NÉGATIF, même si la facture l'imprime sans signe dans une colonne à part. Exemple : « Remaining time on 3 × Team plan » 512,91 et « Unused time on 2 × Team plan » 341,94 avec un sous-total imprimé de 170,97 → items = [512,91 ; -341,94] (512,91 - 341,94 = 170,97). Vérifie toujours que la somme signée des items[].total retombe EXACTEMENT sur le sous-total imprimé ; si ta somme dépasse le sous-total, c'est qu'une ligne est un crédit et doit passer en négatif.
- tps = taxe fédérale (TPS/GST, 5 %). tvq = taxe du Québec (TVQ/QST, 9,975 %) ou PST provinciale. other_taxes = toute autre taxe. Une taxe combinée TVH/HST d'une autre province va dans other_taxes.

RÈGLE — ESCOMPTE ET TRANSPORT GLOBAUX SUR UN ACHAT DE PLUSIEURS PIÈCES (ex. CT Greenhouse, fournisseurs de pièces qui appliquent une remise en % ou des frais de port sur l'ensemble de la commande) :
- Quand la facture applique un ESCOMPTE global (remise en % ou en $ sur l'ensemble de la commande, « discount ») et/ou des FRAIS DE TRANSPORT globaux (« shipping », « freight »), et que ce montant n'est PAS déjà ventilé comme sa propre ligne d'article, NE l'intègre PAS dans items[].total : laisse chaque ligne d'article à son plein montant (prix pièce × quantité), AVANT escompte/transport.
- Renseigne plutôt "discount_amount" (montant total de l'escompte, en positif, 0 si aucun) et "freight_amount" (montant total des frais de transport globaux, en positif, 0 si aucun). Le système répartit ensuite ce montant AU PRORATA du poids de chaque pièce automatiquement — n'essaie pas de le faire toi-même ligne par ligne.
- Dans ce cas précis, "subtotal" reste la somme des items[].total AVANT escompte/transport — l'invariant subtotal+taxes=total peut alors ne PAS tenir, c'est normal et attendu. "total" demeure le MONTANT TOTAL DÛ réellement imprimé sur la facture (après escompte/transport).

RÈGLE — POURBOIRE (repas au restaurant, traiteur, livraison de repas) :
- Un reçu de restaurant arrive souvent en DEUX coupons photographiés côte à côte : l'ADDITION (les plats, le sous-total, la TPS, la TVQ, un « TOTAL » taxes incluses) et le coupon du TERMINAL de paiement (« MONTANT », « POURBOIRE », « TOTAL », approbation de la carte). Lis les DEUX : ce sont deux parties du même reçu, pas deux reçus.
- Le POURBOIRE (« POURBOIRE », « TIP », « Gratuity », « Frais de service ») n'apparaît que sur le coupon du terminal. Il doit devenir un ARTICLE à part entière dans "items", avec la description exacte « Pourboire », quantity et unit_price à null, et "total" = le montant du pourboire.
- Le pourboire n'est JAMAIS taxé : "tps", "tvq" et "other_taxes" restent EXACTEMENT ceux imprimés sur l'addition (ils ne portent que sur les plats). N'ajoute pas de taxe sur le pourboire et ne recalcule pas les taxes sur le sous-total augmenté.
- "subtotal" = plats hors taxes + pourboire (le pourboire est déjà hors taxes). "total" = le montant RÉELLEMENT DÉBITÉ, c'est-à-dire le TOTAL du coupon du terminal (montant de l'addition + pourboire) — pas le TOTAL de l'addition. Exemple : plats 56,00 + TPS 2,80 + TVQ 5,59 = 64,39 d'addition, pourboire 10,08 → items = plats + une ligne « Pourboire » 10,08 ; subtotal = 66,08 ; tps = 2,80 ; tvq = 5,59 ; total = 74,47.
- Si le coupon du terminal montre un pourboire à 0,00 $ ou n'existe pas, n'ajoute aucune ligne « Pourboire ».

RÈGLE — DEVISE ("currency", à trancher AVANT de répondre — CAD n'est PAS la valeur par défaut) :
- Ordre de priorité : (1) un code de devise IMPRIMÉ sur le document (« USD », « CAD », « US$ », « $ CA », « Amounts in US dollars », « Currency: USD ») fait foi ; (2) sinon, la devise habituelle de l'émetteur indiquée dans le répertoire interne des fournisseurs ci-dessus ; (3) sinon, le PAYS de l'émetteur : adresse américaine (ex. « Chicago, IL », « San Francisco, CA », « Delaware »), aucune taxe canadienne facturée et aucun numéro de TPS/TVQ → "USD".
- Un simple « $ » n'est PAS une preuve de dollars canadiens. Une facture d'un fournisseur SaaS / de services américain libellée en « $ » est en dollars US sauf mention canadienne explicite (TPS/TVQ facturées, adresse canadienne, « CAD », « CDN$ »).
- La devise est comptabilisée telle quelle : la mettre à CAD sur une facture américaine fait publier une dépense au mauvais montant. En cas d'hésitation entre CAD et USD pour un émetteur étranger, choisis "USD" et signale-le dans "notes".

RÈGLE — FACTURES BI-DEVISES (deux colonnes de montants, ex. « USD 62.69   CAD 89.35 ») :
- Certaines factures impriment CHAQUE montant dans DEUX devises côte à côte : la devise de FACTURATION et l'équivalent converti dans la devise de PAIEMENT (souvent avec un taux affiché, « 1 USD = 1.4252 CAD »). C'est fréquent chez les fournisseurs infonuagiques et les services américains facturant au Canada.
- Dans ce cas, choisis UNE seule colonne et n'en sors JAMAIS : subtotal, tps, tvq, other_taxes et total doivent tous provenir de la MÊME devise, et "currency" doit être le code de CETTE colonne. Panacher les colonnes (montants d'une devise + code de l'autre) fausse silencieusement la conversion en comptabilité.
- Par défaut, prends la devise de FACTURATION (celle des montants détaillés ligne par ligne, celle du taux de change affiché), pas l'équivalent converti. Si le répertoire des fournisseurs ci-dessus indique une devise habituelle pour cet émetteur, prends CELLE-LÀ.
- Vérifie l'invariant sur la colonne retenue : subtotal + tps + tvq + other_taxes = total, tous dans la même devise.

RÈGLE — FACTURES DE TRANSPORT MULTI-EXPÉDITIONS (NovoXpress / Groupe Alliances et Privilèges, ou toute messagerie listant plusieurs expéditions avec des taxes PAR expédition) :
- Quand le document détaille PLUSIEURS expéditions, chacune avec ses propres frais ET ses propres taxes (TPS/TVQ calculées envoi par envoi, souvent une page par expédition), n'utilise PAS le sommaire de la 1re page pour "items". Remplis plutôt "shipments" : UNE entrée par expédition, avec le transporteur/service, la PROVINCE et le PAYS de DESTINATION (la destination réelle du colis, pas l'expéditeur), le TOTAL de l'expédition, et la liste de SES taxes {label, amount} telles qu'imprimées (TPS, TVQ, TVH/HST, PST…). Le "label" doit refléter le type de taxe affiché.
- Une expédition sans aucune taxe affichée a "taxes": []. Une expédition vers les États-Unis / hors Canada a généralement "taxes": [] (export).
- CRÉDITS / RETOURS : les sections de crédits (ex. « UPS - Crédits », « Sommaire des Crédits », montants négatifs) font partie de la facture. Chaque crédit devient AUSSI une entrée de "shipments", avec un "total" NÉGATIF (et ses taxes négatives le cas échéant) et la destination de l'envoi crédité. Ne les saute JAMAIS : sans eux le total ne balance pas.
- AUTRES FRAIS : tout frais du document qui n'est rattaché à aucune expédition (frais de compte, frais administratifs, ajustement global…) devient aussi une entrée de "shipments" : "carrier" = le libellé du frais, destination_province/country = null ou "CA", et ses taxes telles qu'imprimées.
- VÉRIFICATION OBLIGATOIRE : la somme des "total" de toutes les entrées de "shipments" (crédits négatifs inclus) doit égaler le MONTANT TOTAL DÛ affiché sur la facture (à un cent près). Si ça ne balance pas, tu as manqué une expédition, un crédit ou un frais — relis TOUTES les pages (les crédits sont souvent sur la dernière page) et corrige avant de répondre.
- Dans ce cas, laisse "items" vide ([]) : les lignes seront reconstruites automatiquement par regroupement par province/pays de destination. Donne quand même subtotal/tps/tvq/other_taxes globaux, et mets "total" = le MONTANT TOTAL DÛ imprimé sur la facture.
- Si le document N'est PAS de ce type (un seul achat, pas de ventilation par expédition), laisse "shipments" absent ou vide ([]) et remplis "items" normalement.

RÈGLE — "transaction_type" (classification fiscale TPS/TVQ du document) :
- Classe le document dans UN des types suivants et retourne la CLÉ exacte (entre guillemets ci-dessous). Base-toi sur la nature de l'achat, le pays/la province de l'ÉMETTEUR, l'endroit d'où le bien est expédié, et les taxes RÉELLEMENT facturées sur le document :
${TX_TYPE_CATALOG}
- Cohérence obligatoire avec les taxes du document : un type au statut Taxable suppose que des taxes (TPS et/ou TVQ) sont facturées ; un type Détaxé/Exonéré/Hors-champ suppose 0 $ de taxe. Si ta classification contredit les montants que tu as extraits, reconsidère-la.
- Indices utiles : fournisseur canadien qui facture TPS + TVQ → "achat_local_taxable" (ou "repas_representation" si restaurant/traiteur/livraison de repas). Fournisseur étranger, aucune taxe → "achat_etranger_bien_etranger" pour un bien physique expédié de l'étranger, "achat_num_etranger_non_inscrit" pour un service numérique. Fournisseur numérique (SaaS/cloud) qui facture 0 $ en mentionnant nos numéros de TPS/TVQ, « reverse charge » ou « tax exempt » → "achat_num_inscrit_b2b_exempte". Douanes/courtier qui perçoit la TPS 5 % seule à l'importation → "achat_pieces_etranger_douane".
- En cas de doute réel entre plusieurs types, mets null — ne devine pas.

DOCUMENT MULTIPAGE :
- Le document peut comporter PLUSIEURS pages (plusieurs images et/ou plusieurs pages de PDF). Elles forment UN SEUL reçu/facture. Consolide TOUTES les pages en un seul JSON : fusionne les articles de chaque page dans le tableau "items", et prends les totaux (subtotal/tps/tvq/total) du document complet (généralement sur la dernière page). Ne produis pas un objet par page.

Retourne UNIQUEMENT le JSON, sans texte supplémentaire ni balises markdown.
Si une valeur est inconnue, utilise null pour les chaînes et 0 pour les nombres.`

const MIME_MAP = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp' }

// Extraction IA d'un document pouvant comporter PLUSIEURS pages.
// `pages` : tableau [{ filePath, fileExt }] dans l'ordre des pages. Les images sont
// envoyées comme image_url (vision), les PDF sont convertis en texte (pdftotext) et
// concaténés. Tout est regroupé dans un seul message → un seul JSON consolidé.
// `vendorContext` (optionnel) : liste des fournisseurs connus (vendorProfiles.js)
// injectée en contexte pour canoniser "company" et trancher la devise.
export async function extractWithOpenAI(pages, vendorContext = null) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY non configuré')

  const list = Array.isArray(pages) ? pages : [pages]
  if (!list.length) throw new Error('Aucune page à extraire')

  const content = [
    { type: 'text', text: `Voici un document (reçu, facture ou relevé) que nous avons reçu d'un fournisseur, comportant ${list.length} page${list.length > 1 ? 's' : ''}. Extrait toutes les données disponibles en consolidant l'ensemble des pages en UN SEUL reçu. Le champ "company" est le fournisseur/marchand émetteur, jamais Orisha (qui est notre entreprise, le destinataire).` },
  ]
  if (vendorContext) content.push({ type: 'text', text: vendorContext })
  const pdfTexts = []
  list.forEach((p, idx) => {
    if (IMAGE_EXT.includes(p.fileExt)) {
      const base64 = readFileSync(p.filePath).toString('base64')
      const mime = MIME_MAP[p.fileExt] || 'image/jpeg'
      content.push({ type: 'image_url', image_url: { url: `data:${mime};base64,${base64}`, detail: 'high' } })
    } else {
      const result = spawnSync('pdftotext', ['-layout', p.filePath, '-'], { encoding: 'utf8', timeout: 30000 })
      const t = result.stdout?.trim() || ''
      if (t) pdfTexts.push(`[Page ${idx + 1}]\n${t}`)
    }
  })

  const hasImage = content.some(c => c.type === 'image_url')
  if (pdfTexts.length) {
    // Les factures de transport multi-expéditions dépassent facilement 12 000 caractères
    // (une expédition détaillée par bloc, 6+ pages) — tronquer perdait les dernières
    // expéditions et cassait la réconciliation. gpt-4o encaisse 40 000 sans problème.
    content.push({ type: 'text', text: `Contenu textuel des pages PDF :\n\n${pdfTexts.join('\n\n').slice(0, 40000)}` })
  }
  if (!hasImage && !pdfTexts.length) throw new Error('Impossible d\'extraire le contenu du document')

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content },
  ]

  // Réconciliation des factures de transport : si la somme des expéditions extraites ne
  // retombe pas sur le montant total dû, l'IA a manqué (ou dupliqué) une expédition, un
  // crédit ou un frais. On lui renvoie l'écart CHIFFRÉ et on la fait recommencer — le
  // prompt seul ne suffit pas (facture 250954 : expédition de 137,52 $ sautée malgré la
  // consigne « VÉRIFICATION OBLIGATOIRE »). On garde la meilleure tentative.
  // Même réconciliation pour les factures ORDINAIRES : la somme des items[].total doit
  // retomber sur la base HORS TAXES imprimée. Bell Mobilité (août 2026) : les « Québec
  // 911 taxe municipale » de 0,55 $ par numéro avaient été oubliées → lignes à 169,00 $
  // pour un HT de 171,20 $, et la fiche affichait 194,63 $ au lieu de 196,83 $.
  let best = null
  const imbalanceOf = e => (shipmentsImbalance(e) || itemsImbalance(e))
  for (let attempt = 0; attempt <= SHIPMENT_RECONCILE_RETRIES; attempt++) {
    const { extracted, replyText } = await callOpenAI(apiKey, messages)
    const shipDelta = shipmentsImbalance(extracted)
    const delta = shipDelta || itemsImbalance(extracted)
    if (best === null || Math.abs(delta) < Math.abs(imbalanceOf(best))) best = extracted
    if (Math.abs(delta) <= 0.02 || attempt === SHIPMENT_RECONCILE_RETRIES) break
    messages.push({ role: 'assistant', content: replyText })
    messages.push({
      role: 'user',
      content: shipDelta
        ? buildImbalanceCorrection(extracted, shipDelta)
        : buildItemsImbalanceCorrection(extracted, delta),
    })
  }
  // Texte brut des pages PDF joint à l'extraction (non persisté) : il sert de filet
  // pour retrouver une période de service imprimée que l'IA aurait laissée de côté
  // (cf. servicePeriod.js). Retiré avant l'écriture de raw_data.
  if (best && pdfTexts.length) {
    Object.defineProperty(best, '_sourceText', { value: pdfTexts.join('\n\n').slice(0, 40000), enumerable: false })
  }
  return best
}

const SHIPMENT_RECONCILE_RETRIES = 2

// Écart entre le montant total dû extrait et la somme des expéditions extraites.
// 0 si le document n'est pas une facture de transport (pas de shipments) ou si aucun
// total imprimé n'a été extrait (rien à réconcilier).
export function shipmentsImbalance(extracted) {
  const ships = Array.isArray(extracted?.shipments) ? extracted.shipments.filter(s => s && Number(s.total)) : []
  if (!ships.length) return 0
  const printed = round2(Number(extracted.total) || 0)
  if (!printed) return 0
  const sum = round2(ships.reduce((s, x) => s + Number(x.total), 0))
  return round2(printed - sum)
}

// Base HORS TAXES imprimée sur le document : le sous-total quand il réconcilie avec le
// total (subtotal + taxes = total), sinon total - taxes (sous-total lu taxes incluses).
// Même convention qu'au push QB (computeReceiptHtBase) : le TOTAL imprimé fait foi.
export function printedHtBase({ subtotal, tps, tvq, other_taxes, total }) {
  const taxes = round2((Number(tps) || 0) + (Number(tvq) || 0) + (Number(other_taxes) || 0))
  const tot = round2(Number(total) || 0)
  const sub = round2(Number(subtotal) || 0)
  if (tot > 0 && taxes > 0) {
    return Math.abs(round2(sub + taxes - tot)) <= 0.02 ? sub : round2(tot - taxes)
  }
  return sub > 0 ? sub : tot
}

// Écart entre la base HT imprimée et la somme des lignes d'articles extraites. 0 quand
// il n'y a rien à réconcilier (facture de transport → shipments, aucune ligne chiffrée,
// aucun montant imprimé). Une somme trop BASSE = frais oubliés (taxe municipale 911,
// frais de service…), trop HAUTE = ligne en double ou montant taxes incluses.
export function itemsImbalance(extracted) {
  if (Array.isArray(extracted?.shipments) && extracted.shipments.some(s => s && Number(s.total))) return 0
  const list = Array.isArray(extracted?.items) ? extracted.items.filter(it => it && it.total != null) : []
  if (!list.length) return 0
  const base = printedHtBase(extracted || {})
  if (!base) return 0
  const sum = round2(list.reduce((s, it) => s + (Number(it.total) || 0), 0))
  // Lignes lues taxes incluses : traité à part (normalizeTaxInclusiveLines), pas ici.
  const tot = round2(Number(extracted.total) || 0)
  if (tot && Math.abs(round2(sum - tot)) <= 0.02 && Math.abs(round2(base - tot)) > 0.02) return 0
  return round2(base - sum)
}

export function buildItemsImbalanceCorrection(extracted, delta) {
  const list = extracted.items.filter(it => it && it.total != null)
  const sum = round2(list.reduce((s, it) => s + (Number(it.total) || 0), 0))
  const base = printedHtBase(extracted)
  const missed = delta > 0
  return `ERREUR DE RÉCONCILIATION — ta réponse ne balance pas. La somme des "total" de tes ${list.length} lignes d'articles donne ${sum.toFixed(2)} $, mais la base HORS TAXES de la facture est ${base.toFixed(2)} $ (total ${round2(Number(extracted.total) || 0).toFixed(2)} $ moins les taxes). Il ${missed ? `manque ${delta.toFixed(2)} $ : tu as sauté un ou plusieurs frais (frais de service, taxe municipale 911, frais d'accès réseau, frais uniques…) ou une ligne entière` : `y a ${Math.abs(delta).toFixed(2)} $ en trop : une ligne est en double, ou tu as inscrit des montants TAXES INCLUSES au lieu des montants hors taxes`}. Relis TOUTES les pages une par une, ${missed ? `trouve chaque frais absent de ta liste (cherche un ou des montants totalisant ${delta.toFixed(2)} $)` : 'corrige les montants ou retire les doublons'}, puis retourne le JSON COMPLET corrigé (toutes les lignes, pas seulement les corrections), au même format que précédemment.`
}

export function buildImbalanceCorrection(extracted, delta) {
  const ships = extracted.shipments.filter(s => s && Number(s.total))
  const sum = round2(ships.reduce((s, x) => s + Number(x.total), 0))
  const missed = delta > 0
  return `ERREUR DE RÉCONCILIATION — ta réponse ne balance pas. La somme des "total" de tes ${ships.length} entrées de "shipments" donne ${sum.toFixed(2)} $, mais le MONTANT TOTAL DÛ imprimé sur la facture est ${round2(Number(extracted.total)).toFixed(2)} $. Il ${missed ? `manque ${delta.toFixed(2)} $ : tu as sauté une ou plusieurs expéditions, crédits ou frais` : `y a ${Math.abs(delta).toFixed(2)} $ en trop : tu as compté une expédition en double ou inventé une entrée`}. Relis TOUTES les pages du document une par une, ${missed ? `trouve chaque expédition/crédit/frais absent de ta liste (cherche en particulier un ou des montants totalisant ${delta.toFixed(2)} $)` : 'retire les doublons'}, puis retourne le JSON COMPLET corrigé (toutes les expéditions, pas seulement les corrections), au même format que précédemment.`
}

async function callOpenAI(apiKey, messages) {
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    // 4000 tokens : une facture de transport à 30+ expéditions produit un JSON bien
    // au-delà des 2000 tokens historiques (réponse tronquée → JSON invalide).
    body: JSON.stringify({ model: 'gpt-4o', messages, max_tokens: 4000, temperature: 0 }),
  })

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}))
    throw new Error(err.error?.message || `OpenAI HTTP ${resp.status}`)
  }

  const data = await resp.json()
  const replyText = data.choices?.[0]?.message?.content?.trim() || ''
  const cleaned = replyText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim()
  return { extracted: JSON.parse(cleaned), replyText }
}

// Consolidation « article LIA unique » : quand un reçu contient EXACTEMENT UN article
// dont la description commence par un code LIA (« LIA-1968 … »), les autres lignes
// (transport, frais de carte, etc.) sont des frais rattachés à cet article — on les
// fusionne dans la ligne LIA : un seul item, au montant TOTAL des lignes, qui garde la
// description LIA verbatim. Les libellés des lignes de frais sont jetés.
//
// On ne touche à RIEN dès qu'il y a PLUSIEURS articles LIA (plusieurs codes/produits) :
// chaque ligne reste alors distincte. Idem s'il n'y a aucun article LIA ou une seule ligne.
const LIA_REF = /^\s*lia-\d+/i

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
  { match: /amazon\s*web\s*services|(?<!\w)aws(?!\w)/i, name: 'Amazon Web Services' },
  { match: /(?<!\w)amazon(?!\w)/i, name: 'Amazon.ca' },
]

export function canonicalVendorName(name) {
  if (!name) return name
  for (const a of VENDOR_ALIASES) if (a.match.test(name)) return a.name
  return name
}

export function consolidateSoleLiaItem(items) {
  const list = Array.isArray(items) ? items : []
  if (list.length <= 1) return list
  const liaItems = list.filter(it => LIA_REF.test(it?.description || ''))
  if (liaItems.length !== 1) return list
  const lineAmount = it => Number(it?.total) || (Number(it?.unit_price) * Number(it?.quantity)) || 0
  const total = Math.round(list.reduce((s, it) => s + lineAmount(it), 0) * 100) / 100
  // Le rattachement à l'achat LIA (purchase_id / lia_ref) survit à la fusion : c'est la
  // même ligne, au montant total.
  const { purchase_id, lia_ref } = liaItems[0]
  return [{ description: liaItems[0].description, quantity: null, unit_price: null, total, ...(purchase_id ? { purchase_id, lia_ref } : {}) }]
}

// Factures de proration (Stripe & co) : le crédit de l'ancien forfait (« Unused time
// on N × … ») est imprimé sans signe, dans une colonne à part. L'IA le recopiait donc
// en positif et la somme des lignes dépassait le sous-titre imprimé (512,91 + 341,94
// = 854,85 au lieu de 512,91 - 341,94 = 170,97). Filet : quand la somme des lignes
// dépasse le sous-total ET que passer les lignes de crédit en négatif retombe
// exactement sur le sous-total imprimé, on inverse leur signe.
const CREDIT_LINE = /^\s*unused\s+time\b|\bunused\s+time\s+on\b|\bcr[eé]dit\b|\bcredit\b|\bremise\b|\brabais\b|\bproration\b|\bprorata\b/i

export function reconcileCreditLines(items, subtotal) {
  const list = Array.isArray(items) ? items : []
  const target = Number(subtotal)
  if (!list.length || !Number.isFinite(target)) return list
  const amount = it => Number(it?.total) || 0
  const sum = list.reduce((s, it) => s + amount(it), 0)
  if (Math.abs(round2(sum - target)) <= 0.02) return list
  const credits = list.filter(it => CREDIT_LINE.test(it?.description || '') && amount(it) > 0)
  if (!credits.length) return list
  const flipped = round2(sum - 2 * credits.reduce((s, it) => s + amount(it), 0))
  if (Math.abs(round2(flipped - target)) > 0.02) return list
  return list.map(it => {
    if (!credits.includes(it)) return it
    const total = round2(-amount(it))
    const unit = Number(it?.unit_price)
    return { ...it, total, ...(Number.isFinite(unit) && unit > 0 ? { unit_price: round2(-unit) } : {}) }
  })
}

// Factures dont les LIGNES sont imprimées TAXES INCLUSES alors que la TPS/TVQ sont
// détaillées à part — cas Bell Mobilité (une page par numéro de téléphone, chacune
// terminée par un « Total frais courants » qui contient déjà ses taxes) et des
// marchands à prix TTC (Amazon). L'IA recopie ces montants dans items[].total et pose
// subtotal = leur somme : le sous-total vaut alors le TOTAL de la facture, et le total
// dérivé (sous-total + taxes) part 25,63 $ trop haut (Bell août 2026 : 222,46 $ affiché
// au lieu de 196,83 $).
// Filet déterministe : quand la somme des lignes retombe sur le TOTAL imprimé (et pas
// sur la base HT), les lignes sont TTC → on les ramène au prorata sur total - taxes.
// Le total imprimé reste la vérité (même convention qu'au push, cf. computeReceiptHtBase).
function rescaleLineAmounts(amounts, target) {
  const sum = amounts.reduce((s, a) => s + a, 0)
  if (!sum) return amounts
  const scaled = amounts.map(a => round2(a * target / sum))
  const diff = round2(target - scaled.reduce((s, a) => s + a, 0))
  if (diff !== 0 && scaled.length) {
    // L'écart d'arrondi va sur la plus grosse ligne (la moins déformée en relatif).
    let idx = 0
    scaled.forEach((a, i) => { if (Math.abs(a) > Math.abs(scaled[idx])) idx = i })
    scaled[idx] = round2(scaled[idx] + diff)
  }
  return scaled
}

// Filet DÉTERMINISTE de dernier recours : après les tentatives de correction de l'IA,
// la somme des lignes doit égaler la base HT — sinon la fiche (qui dérive le total des
// lignes) affiche un total différent du montant réellement facturé. On matérialise
// l'écart résiduel en une ligne visible et éditable plutôt que de laisser la fiche
// mentir. Au-delà de 25 % de la base, l'extraction est trop abîmée pour être rafistolée :
// on laisse tel quel (l'écart reste visible dans la fiche) et on trace.
const RESIDUAL_LINE_DESCRIPTION = 'Autres frais figurant sur la facture'

export function reconcileItemsResidual(items, htBase) {
  const list = Array.isArray(items) ? items : []
  const priced = list.filter(it => it && it.total != null)
  const base = round2(htBase)
  if (!priced.length || !base) return null
  const sum = round2(priced.reduce((s, it) => s + (Number(it.total) || 0), 0))
  const delta = round2(base - sum)
  if (Math.abs(delta) <= 0.02) return null
  if (Math.abs(delta) > Math.abs(base) * 0.25) return { items: list, delta, applied: false }
  return {
    items: [...list, { description: RESIDUAL_LINE_DESCRIPTION, quantity: null, unit_price: null, total: delta }],
    delta,
    applied: true,
  }
}

// Escompte et/ou transport GLOBAUX appliqués à un achat de PLUSIEURS pièces (ex. CT
// Greenhouse) sans ligne dédiée sur la facture : le système comptable (onglet « Pro
// rata transport » du fichier CTB - Suivi) les répartit AU PRORATA du montant de
// chaque pièce (avant escompte/transport) — Total final ligne = Montant pièce +
// Transport alloué - Escompte alloué, chaque terme alloué proportionnellement au poids
// de la ligne. C'est mathématiquement équivalent à mettre chaque ligne à l'échelle vers
// la cible (montant pièces - escompte + transport) : on réutilise rescaleLineAmounts.
//
// Portée volontairement limitée : factures de PIÈCES (compte 14000) à PLUSIEURS lignes
// à comptabiliser (plusieurs pièces/codes LIA distincts). Une facture à UNE seule pièce
// (une ligne, un code LIA) n'a rien à répartir : tout l'escompte/transport revient de
// toute façon à cette unique ligne — pas de prorata à faire.
export function reconcileDiscountFreightProrata(items, { discount = 0, freight = 0 } = {}) {
  const list = Array.isArray(items) ? items : []
  const priced = list.filter(it => it && it.total != null)
  if (priced.length <= 1) return null
  const disc = round2(Number(discount) || 0)
  const frt = round2(Number(freight) || 0)
  if (!disc && !frt) return null
  const sum = round2(priced.reduce((s, it) => s + (Number(it.total) || 0), 0))
  if (!sum) return null
  const target = round2(sum - disc + frt)
  const scaled = rescaleLineAmounts(priced.map(it => Number(it.total) || 0), target)
  let k = 0
  const next = list.map(it => {
    if (!it || it.total == null) return it
    const amount = scaled[k++]
    const qty = Number(it.quantity)
    return { ...it, total: amount, ...(Number.isFinite(qty) && qty > 0 ? { unit_price: round2(amount / qty) } : {}) }
  })
  return { items: next, subtotal: target }
}

export function normalizeTaxInclusiveLines({ items, subtotal, tps, tvq, other_taxes, total }) {
  const taxes = round2((Number(tps) || 0) + (Number(tvq) || 0) + (Number(other_taxes) || 0))
  const tot = round2(Number(total) || 0)
  if (taxes <= 0 || tot <= 0) return null
  const ht = round2(tot - taxes)
  const near = (a, b) => Math.abs(round2(a - b)) <= 0.02
  const list = Array.isArray(items) ? items : []
  const priced = list.filter(it => it && it.total != null)
  if (priced.length) {
    const sum = round2(priced.reduce((s, it) => s + (Number(it.total) || 0), 0))
    // Lignes déjà HT (somme ≈ base HT) ou incohérence d'un autre genre → on ne touche à rien.
    if (!near(sum, tot) || near(sum, ht)) return null
    const scaled = rescaleLineAmounts(priced.map(it => Number(it.total) || 0), ht)
    let k = 0
    const next = list.map(it => {
      if (!it || it.total == null) return it
      const amount = scaled[k++]
      const qty = Number(it.quantity)
      return {
        ...it,
        total: amount,
        ...(Number.isFinite(qty) && qty > 0 ? { unit_price: round2(amount / qty) } : {}),
      }
    })
    return { items: next, subtotal: ht, lineSum: sum }
  }
  // Aucune ligne chiffrée : seul le sous-total peut être TTC.
  if (near(round2(Number(subtotal) || 0), tot) && !near(round2(Number(subtotal) || 0), ht)) {
    return { items: list, subtotal: ht, lineSum: null }
  }
  return null
}

function fetchSaleReceiptRow(id) {
  const row = db.prepare('SELECT * FROM sale_receipts WHERE id=?').get(id)
  if (!row) return null
  return { ...row, items: JSON.parse(row.items || '[]') }
}

// `pages` (optionnel) : tableau [{ filePath, fileExt }] pour un document multipage.
// Rétrocompat : si `pages` est absent, on retombe sur le couple { filePath, fileExt }
// (page unique) utilisé par les ingestions email/Amazon.
//
// `trigger` : origine de l'extraction pour le sync_log ('manual' = upload/re-extract
// déclenché par un opérateur ; 'scheduled' = ingestion automatique Gmail/Amazon).
// L'appel reste fire-and-forget côté appelants : on trace ici (succès comme échec)
// pour que tout coût OpenAI et toute mise en status='error' soit visible dans sync_log.
export async function runExtractionAndUpdate({ saleReceiptId, filePath, fileExt, pages, userId = null, trigger = 'manual' }) {
  const startedAt = Date.now()
  try {
    // Si la ligne a été supprimée pendant que l'extraction tournait, on s'arrête
    // proprement : évite un appel OpenAI inutile et un UPDATE sur une ligne masquée.
    const existing = db.prepare('SELECT deleted_at FROM sale_receipts WHERE id=?').get(saleReceiptId)
    if (!existing || existing.deleted_at) return
    const pageList = Array.isArray(pages) && pages.length ? pages : [{ filePath, fileExt }]
    // Répertoire fournisseurs en contexte — best effort : table vide ou en erreur,
    // l'extraction fonctionne sans.
    let vendorContext = null
    try { vendorContext = buildVendorExtractionContext() } catch {}
    let extracted = await extractWithOpenAI(pageList, vendorContext)

    // Facture Amazon Web Services : chaque montant y est imprimé dans DEUX devises
    // (USD facturé / CAD payé). L'IA panache l'une avec l'autre — on réancre donc
    // montants, devise, période et numéro de facture sur la colonne USD, lue
    // déterministiquement dans le texte du PDF. Voir awsInvoice.js pour la
    // convention comptable (toujours USD, fournisseur « Amazon Web Services - USD »).
    let awsItems = null
    const aws = applyAwsInvoice(extracted, [], extracted._sourceText)
    if (aws.applied) {
      const sourceText = extracted._sourceText
      extracted = aws.extracted
      if (sourceText) Object.defineProperty(extracted, '_sourceText', { value: sourceText, enumerable: false })
      awsItems = aws.items
      console.log(`Extraction ${saleReceiptId}: facture AWS ${aws.parsed.invoiceNumber} normalisée en USD — ${aws.parsed.subtotal} + ${aws.parsed.tps} + ${aws.parsed.tvq} = ${aws.parsed.total} USD (${aws.parsed.cadTotal ?? '?'} CAD au taux ${aws.parsed.fxRate ?? '?'})`)
    }

    // Facture de transport multi-expéditions : on reconstruit les lignes par code de
    // taxe (récupérable seulement, PST non récupérable repliée dans la dépense) et on
    // recompose subtotal/taxes/total à partir des expéditions — voir transportInvoice.js.
    const shipments = Array.isArray(extracted.shipments)
      ? extracted.shipments.filter(s => s && Number(s.total))
      : []
    let items, amounts = null
    if (shipments.length) {
      const built = buildTransportInvoice(shipments)
      // Pré-remplit le code de taxe QB par ligne (résolution par nom). QB injoignable ou
      // nom absent → tax_code_id null (l'opérateur choisit ; le regroupement reste fait).
      // Le sentinel « aucune taxe » (NO_TAX_CODE) n'est pas un nom QB à résoudre : il est
      // stocké tel quel pour forcer une ligne sans code de taxe à la publication.
      const NO_TAX_CODE = '__none__'
      let nameToId = new Map()
      try {
        const { resolveTaxCodeIdsByName } = await import('./quickbooks.js')
        const realNames = built.items.map(it => it.tax_code_name).filter(n => n && n !== NO_TAX_CODE)
        nameToId = await resolveTaxCodeIdsByName(realNames)
      } catch (e) {
        console.warn(`Transport extraction ${saleReceiptId}: résolution codes QB indisponible (${e.message}) — codes laissés vides`)
      }
      items = built.items.map(it => ({
        description: it.description,
        quantity: null,
        unit_price: null,
        total: it.total,
        tax_code_id: it.tax_code_name === NO_TAX_CODE
          ? NO_TAX_CODE
          : (it.tax_code_name ? (nameToId.get(it.tax_code_name) || null) : null),
      }))
      // Le total stocké reste le « Montant total dû » IMPRIMÉ sur la facture (ancrage de
      // réconciliation), pas le total recomposé : si la reconstruction par expéditions ne
      // boucle pas dessus (expédition, crédit ou frais manqué à l'extraction), l'écart
      // reste VISIBLE dans l'UI (indicateur « reçu : X $ » sur la ligne Total) au lieu
      // d'être maquillé par un total auto-cohérent mais faux.
      const printedTotal = round2(Number(extracted.total) || 0)
      if (printedTotal && Math.abs(printedTotal - built.total) > 0.02) {
        console.warn(`Transport extraction ${saleReceiptId}: expéditions recomposées = ${built.total} $ ≠ montant dû ${printedTotal} $ — expédition/crédit/frais probablement manqué`)
      }
      amounts = { subtotal: built.subtotal, tps: built.tps, tvq: built.tvq, other_taxes: built.other_taxes, total: printedTotal || built.total }
    } else {
      items = awsItems || extracted.items || []
    }
    // Nom fournisseur : alias codés en dur d'abord, puis nom canonique du profil
    // fournisseur si le nom extrait y correspond (casse/accents/alias près).
    let company = canonicalVendorName(extracted.company) || null
    // Profil fournisseur : rattaché dès l'extraction — le profil est aussi utilisé
    // comme filet pour les termes de paiement (Net N mémorisé) quand le document ne
    // les imprime pas. La résolution du nom canonique passe aussi par ses alias.
    let profile = null
    try { profile = findVendorProfile(company) } catch {}
    if (profile) company = profile.name

    if (!shipments.length) {
      // Achats LIA : les lignes qui correspondent à un achat de la table Achats
      // (même fournisseur, prix/quantité/nom concordants) prennent la description
      // « LIA-xxxx<TAB>Nom de la pièce » attendue en comptabilité. Les appariements
      // incertains ne sont PAS écrits ici : ils sont proposés dans la fiche du reçu
      // (GET /api/sale-receipts/:id/lia-matches). Le fournisseur doit être résolu avant.
      const linked = autoLinkReceiptItems({
        items,
        company,
        vendorProfileId: profile?.id || null,
        receiptDate: extracted.receipt_date || null,
        orderDate: extracted.order_date || null,
        excludeReceiptId: saleReceiptId,
      })
      items = linked.items
      if (linked.applied.length) {
        console.log(`Extraction ${saleReceiptId}: ${linked.applied.length} ligne(s) rattachée(s) à un achat LIA — ${linked.applied.map(a => `${a.lia_ref} (${a.score})`).join(', ')}`)
      }
      // Fusionne les frais dans la ligne LIA quand il n'y a qu'un seul article LIA.
      items = consolidateSoleLiaItem(items)
      // Crédits de proration imprimés sans signe → passés en négatif pour que la somme
      // des lignes retombe sur le sous-total imprimé.
      const signed = reconcileCreditLines(items, extracted.subtotal)
      if (signed !== items) {
        console.log(`Extraction ${saleReceiptId}: ligne(s) de crédit passée(s) en négatif — somme des lignes réalignée sur le sous-total ${extracted.subtotal} $`)
        items = signed
      }
      // Escompte / transport globaux (achat de plusieurs pièces, ex. CT Greenhouse) :
      // répartis au prorata du montant de chaque pièce — système « Pro rata transport »
      // du fichier CTB - Suivi. Le sous-total dérivé (somme des lignes ajustées) devient
      // alors la vraie base HT (subtotal + taxes = total imprimé tient à nouveau).
      const discFreight = reconcileDiscountFreightProrata(items, {
        discount: extracted.discount_amount,
        freight: extracted.freight_amount,
      })
      if (discFreight) {
        items = discFreight.items
        amounts = {
          subtotal: discFreight.subtotal,
          tps: extracted.tps || 0,
          tvq: extracted.tvq || 0,
          other_taxes: extracted.other_taxes || 0,
          total: extracted.total || 0,
        }
        console.log(`Extraction ${saleReceiptId}: escompte/transport réparti au prorata des lignes (sous-total ramené à ${discFreight.subtotal} $) — répartition CTB « Pro rata transport »`)
      }
    }
    // Période de service. Les factures de transport (shipments) sont ponctuelles par
    // nature — jamais de période. Sinon : période extraite par l'IA, sinon période
    // imprimée retrouvée dans le texte du document, sinon cycle de facturation déclaré
    // dans /abonnements-fournisseurs (cf. servicePeriod.js). Le fournisseur doit être
    // résolu AVANT (la déduction par abonnement se fait sur le nom canonique).
    const resolvedPeriod = shipments.length
      ? { period: null, source: null }
      : resolveServicePeriod(
        { company, receipt_date: extracted.receipt_date, general_description: extracted.general_description, items, total: extracted.total },
        extracted.service_period,
        extracted._sourceText,
      )
    const servicePeriod = resolvedPeriod.period
    if (servicePeriod && resolvedPeriod.source !== 'ai') {
      console.log(`Extraction ${saleReceiptId}: période « ${servicePeriod} » déduite (${resolvedPeriod.source}) — absente de l'extraction IA`)
    }
    // Abonnements / services récurrents : chaque ligne porte la période couverte.
    if (!shipments.length) items = annotateItemsWithPeriod(items, servicePeriod)
    const extractedTerms = Number.isInteger(extracted.payment_terms_days) && extracted.payment_terms_days > 0
      ? extracted.payment_terms_days : null
    const termsDays = extractedTerms ?? profile?.payment_terms_days ?? null
    const dueDate = computeDueDate({
      dueDate: extracted.due_date || null,
      receiptDate: extracted.receipt_date || null,
      termsDays,
    })
    // Classification fiscale proposée par l'IA — validée contre le référentiel (clé
    // inconnue ou type « vente » → ignorée). Signal « document » de fiscalDetection.js.
    const aiTxType = getTransactionType(extracted.transaction_type)
    const extractedTxType = aiTxType && aiTxType.side !== 'vente' ? extracted.transaction_type : null

    // Repas / représentation : configuration comptable toujours identique — le pourboire
    // est « Hors champ » (jamais taxé) et le repas « TPS/TVQ repas » (CTI/RTI 50 %). On
    // pose les codes PAR LIGNE dès l'extraction et on recale le total sur le montant
    // réellement débité (addition + pourboire). Voir mealReceipt.js.
    if (!shipments.length && (extractedTxType === 'repas_representation' || (items || []).some(it => isTipLine(it?.description)))) {
      const named = applyMealTaxCodeNames(items)
      if (named.applied) {
        let nameToId = new Map()
        try {
          const { resolveTaxCodeIdsByName } = await import('./quickbooks.js')
          nameToId = await resolveTaxCodeIdsByName(named.items.map(it => it.tax_code_name))
        } catch (e) {
          console.warn(`Repas ${saleReceiptId}: résolution codes QB indisponible (${e.message}) — codes laissés vides`)
        }
        items = named.items.map(({ tax_code_name, ...it }) => ({
          ...it,
          tax_code_id: it.tax_code_id || (tax_code_name ? (nameToId.get(tax_code_name) || null) : null),
        }))
      }
      const base = amounts || {
        subtotal: extracted.subtotal || 0, tps: extracted.tps || 0, tvq: extracted.tvq || 0,
        other_taxes: extracted.other_taxes || 0, total: extracted.total || 0,
      }
      const fixed = reconcileMealAmounts({ items, ...base })
      if (fixed) {
        amounts = { ...base, ...fixed }
        console.log(`Repas ${saleReceiptId}: pourboire hors champ — total recalé à ${amounts.total} $ (addition ${base.total} $ + pourboire)`)
      }
      // Mémo QB professionnel : « Repas corporatif » plutôt que le nom du restaurant ou
      // le résumé littéral produit par l'IA — ce sont systématiquement des dépenses de
      // représentation d'affaires, le mémo doit le refléter côté comptabilité.
      extracted.general_description = company ? `Repas corporatif — ${company}` : 'Repas corporatif'
    }
    // Dernier filet avant écriture : lignes/sous-total imprimés taxes incluses
    // (Bell Mobilité, Amazon…) ramenés à la base HT — sinon le total dérivé côté fiche
    // (somme des lignes + taxes) compte la taxe deux fois.
    {
      const base = amounts || {
        subtotal: extracted.subtotal || 0, tps: extracted.tps || 0, tvq: extracted.tvq || 0,
        other_taxes: extracted.other_taxes || 0, total: extracted.total || 0,
      }
      const inclusive = normalizeTaxInclusiveLines({ items, ...base })
      if (inclusive) {
        items = inclusive.items
        amounts = { ...base, subtotal: inclusive.subtotal }
        console.log(`Extraction ${saleReceiptId}: montants taxes incluses détectés (${inclusive.lineSum ?? base.subtotal} $ = total) — base HT ramenée à ${inclusive.subtotal} $ pour un total de ${round2(base.total)} $`)
      }
      // Lignes incomplètes malgré les relances de l'IA (frais oubliés) : l'écart devient
      // une ligne, sinon la fiche dérive un total ≠ montant facturé.
      if (!shipments.length) {
        const current = amounts || base
        const residual = reconcileItemsResidual(items, printedHtBase(current))
        if (residual?.applied) {
          items = residual.items
          console.warn(`Extraction ${saleReceiptId}: lignes incomplètes de ${residual.delta} $ — ligne « ${RESIDUAL_LINE_DESCRIPTION} » ajoutée pour retomber sur ${round2(current.total)} $`)
        } else if (residual) {
          console.error(`Extraction ${saleReceiptId}: somme des lignes hors base HT de ${residual.delta} $ (>25 %) — extraction à vérifier manuellement`)
        }
      }
    }
    db.prepare(`
      UPDATE sale_receipts SET
        status='done',
        receipt_date=?, order_date=?, company=?, address=?, receipt_number=?, general_description=?, service_period=?,
        subtotal=?, tps=?, tvq=?, other_taxes=?, total=?,
        payment_method=?, currency=?, items=?, raw_data=?,
        due_date=?, payment_terms_days=?, vendor_profile_id=?, extracted_transaction_type=?,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id=? AND deleted_at IS NULL
    `).run(
      extracted.receipt_date || null,
      extracted.order_date || null,
      company,
      extracted.address || null,
      extracted.receipt_number || null,
      // La période est intégrée à la description principale (« … — juillet 2026 »)
      // plutôt que présentée à part : c'est cette phrase qui devient le mémo QB.
      annotateDescriptionWithPeriod(extracted.general_description, servicePeriod),
      servicePeriod,
      amounts ? amounts.subtotal : (extracted.subtotal || 0),
      amounts ? amounts.tps : (extracted.tps || 0),
      amounts ? amounts.tvq : (extracted.tvq || 0),
      amounts ? amounts.other_taxes : (extracted.other_taxes || 0),
      amounts ? amounts.total : (extracted.total || 0),
      extracted.payment_method || null,
      extracted.currency || 'CAD',
      JSON.stringify(items),
      JSON.stringify(extracted),
      dueDate,
      termsDays,
      profile?.id || null,
      extractedTxType,
      saleReceiptId,
    )
    // Détection d'anomalies (doublons, montant hors norme, devise) dès l'extraction —
    // best effort : une erreur ici ne doit pas faire échouer l'extraction.
    try {
      const { syncReceiptAnomalies } = await import('./transactionAnomalies.js')
      syncReceiptAnomalies(saleReceiptId)
    } catch (e) {
      console.warn(`Anomaly scan ${saleReceiptId}: ${e.message}`)
    }
    const updated = fetchSaleReceiptRow(saleReceiptId)
    if (updated) emitEntity('sale_receipt', 'updated', saleReceiptId, updated, userId)
    logSync('sale_receipt_extraction', trigger, { status: 'success', modified: 1, durationMs: Date.now() - startedAt })
  } catch (err) {
    console.error('Receipt extraction error:', err.message)
    db.prepare(`UPDATE sale_receipts SET status='error', error_message=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=? AND deleted_at IS NULL`)
      .run(err.message, saleReceiptId)
    const errored = fetchSaleReceiptRow(saleReceiptId)
    if (errored && !errored.deleted_at) emitEntity('sale_receipt', 'updated', saleReceiptId, errored, userId)
    logSync('sale_receipt_extraction', trigger, { status: 'error', error: `${saleReceiptId}: ${err.message}`, durationMs: Date.now() - startedAt })
  }
}
