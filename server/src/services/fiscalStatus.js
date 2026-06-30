// Référentiel des statuts fiscaux TPS/TVQ — source : Google Sheet
// « Sommaire_Statut fiscal des taxes » (compta Orisha). Encode la correspondance
// TYPE DE TRANSACTION → STATUT FISCAL → CODE DE TAXE QUICKBOOKS attendu, pour
// vérifier qu'un reçu/facture est comptabilisé avec le bon code avant de le publier.
//
// Pourquoi c'est nécessaire : Détaxé, Exonéré et Hors-champ donnent tous 0 $ de
// taxe mais sont TROIS codes QB distincts qui tombent dans des cases différentes du
// rapport de taxes. La déduction « par montants TPS/TVQ » ne sait pas les distinguer
// (elle ne voit que des $), d'où des publications « hors champ » silencieuses (ex.
// café Amazon publié Hors-champ au lieu de Détaxé). On valide donc le code contre le
// TYPE de transaction, pas seulement contre les montants.
//
// Les `codes` sont des NOMS de code de taxe QB (pas des Id — les Id varient selon le
// fichier QB). Le premier de la liste est le code recommandé (bouton « Corriger »).
// Noms vérifiés contre la QB de prod le 2026-06-23 :
//   Détaxé(4) · Exonéré(3) · Hors champ(2) · TPS(5) · TPS/TVQ QC - 9,975(8)
//   · TVQ QC - 9,975(9) · TPS/TVQ repas(15)

// Définitions des 4 statuts (table 2 du Sheet) — affichées en aide.
export const FISCAL_STATUS = {
  taxable:    { label: 'Taxable',    definition: 'Fourniture assujettie à la TPS/TVQ au taux applicable. Taxe facturée, CTI/RTI réclamables.' },
  detaxe:     { label: 'Détaxé',     definition: 'Fourniture taxable au taux de 0 %. Aucune taxe facturée, mais CTI/RTI réclamables (ex. exportations, aliments de base).' },
  exonere:    { label: 'Exonéré',    definition: 'Fourniture non taxable et NON admissible aux CTI/RTI (services financiers, assurances…).' },
  hors_champ: { label: 'Hors-champ', definition: "Hors du champ d'application de la loi TPS/TVQ — aucune notion de taux. N'entre pas dans les cases du rapport de taxes." },
}

// Type de transaction → statut + code(s) QB acceptable(s) + commentaire (du Sheet).
// `side` : 'achat' (dépense), 'vente' (revenu) ou 'both'. La section Extraction de
// données comptabilise des dépenses → les types 'achat'/'both' sont mis en avant.
export const TRANSACTION_TYPES = [
  // ── Achats / dépenses ──────────────────────────────────────────────────────
  {
    key: 'achat_local_taxable', side: 'achat', status: 'taxable',
    label: 'Achat local taxable (TPS + TVQ)',
    codes: ['TPS/TVQ QC - 9,975', 'TPS', 'TVQ QC - 9,975'],
    note: "Achat courant auprès d'un fournisseur canadien qui facture la TPS et la TVQ. CTI/RTI à 100 %.",
  },
  {
    key: 'repas_representation', side: 'achat', status: 'taxable',
    label: 'Repas et frais de représentation (CTI/RTI 50 %)',
    codes: ['TPS/TVQ repas'],
    note: 'Restaurant, traiteur, divertissement engagés pour les affaires. Récupération limitée à 50 % de la TPS/TVQ → code QB « TPS/TVQ repas ». Le pourboire est hors-champ.',
  },
  {
    key: 'evenements_employes', side: 'achat', status: 'taxable',
    label: 'Événement pour tous les employés',
    codes: ['TPS/TVQ QC - 9,975'],
    note: "Fête de Noël, activité d'équipe où tous les employés sont invités (max 6/an). CTI/RTI à 100 %.",
  },
  {
    key: 'loyer', side: 'achat', status: 'taxable',
    label: 'Loyer (commercial)',
    codes: ['TPS/TVQ QC - 9,975'],
    note: 'Loyer commercial taxable. CTI/RTI à 100 %.',
  },
  {
    key: 'achat_pieces_etranger_douane', side: 'achat', status: 'taxable',
    label: "Achat de pièces à l'étranger — importation / douanes (TPS seule)",
    codes: ['TPS'],
    note: "Volet importation au passage en douane : TPS 5 % seulement (perçue par l'ASFC ou le fournisseur, ex. Digikey). CTI à 100 %.",
  },
  {
    key: 'achat_etranger_bien_canada', side: 'achat', status: 'taxable',
    label: 'Achat fournisseur étranger — bien stocké au Canada (modèle Amazon)',
    codes: ['TPS/TVQ QC - 9,975'],
    note: 'Le bien est expédié depuis le Canada : traité comme une vente locale, le fournisseur facture TPS + TVQ. CTI/RTI à 100 %.',
  },
  {
    key: 'achat_num_inscrit_taxe', side: 'achat', status: 'taxable',
    label: 'Service numérique — fournisseur inscrit, taxes facturées',
    codes: ['TPS/TVQ QC - 9,975', 'TPS', 'TVQ QC - 9,975'],
    note: "Fournisseur numérique inscrit qui a facturé la TPS et/ou la TVQ (exemption B2B non appliquée, n° TPS/TVQ non fournis).",
  },
  {
    key: 'produits_alimentaires_base', side: 'achat', status: 'detaxe',
    label: 'Produits alimentaires de base (ex. café pour la cuisine)',
    codes: ['Détaxé'],
    note: "Aliments de base achetés à l'épicerie (ou Amazon) : détaxés (0 %). ⚠️ S'ils sont achetés chez Tim Hortons, Starbucks, etc., c'est plutôt « Repas et frais de représentation » (taxable).",
  },
  {
    key: 'achat_num_inscrit_b2b_exempte', side: 'achat', status: 'detaxe',
    label: 'Service numérique — fournisseur inscrit, exemption B2B (nos n° fournis)',
    codes: ['Détaxé'],
    note: "Exemption B2B appliquée parce qu'Orisha a fourni ses n° de TPS/TVQ (ex. Google). 0 % facturé.",
  },
  {
    key: 'transport_export', side: 'achat', status: 'detaxe',
    label: "Transport d'un produit à l'étranger (origine Canada)",
    codes: ['Détaxé'],
    note: 'Tout service de transport de marchandises dont le point de départ est au Canada et la destination hors Canada est automatiquement détaxé.',
  },
  {
    key: 'courtage_export', side: 'both', status: 'detaxe',
    label: "Frais de courtage liés à une exportation de produits d'Orisha",
    codes: ['Détaxé'],
    note: 'Courtage en douane fourni par une entreprise canadienne (ex. Axxess International) pour une marchandise expédiée aux USA : détaxé.',
  },
  {
    key: 'assurances', side: 'achat', status: 'exonere',
    label: 'Assurances',
    codes: ['Exonéré'],
    note: 'Services financiers → exonérés. Aucun CTI/RTI.',
  },
  {
    key: 'frais_conversion', side: 'achat', status: 'exonere',
    label: 'Frais de conversion / change de devises',
    codes: ['Exonéré'],
    note: 'Opérations de change et conversion de devises = services financiers → exonérés.',
  },
  {
    key: 'achat_pieces_etranger_fournisseur', side: 'achat', status: 'hors_champ',
    label: "Achat de pièces à l'étranger — facture du fournisseur (volet vente)",
    codes: ['Hors champ'],
    note: "Le fournisseur étranger n'est pas assujetti à la collecte des taxes. (Le volet importation/douane est traité séparément, voir le type douanes.)",
  },
  {
    key: 'achat_num_etranger_non_inscrit', side: 'achat', status: 'hors_champ',
    label: 'Service numérique — fournisseur étranger NON inscrit TPS/TVQ',
    codes: ['Hors champ'],
    note: "Fournisseur étranger non inscrit au régime canadien : la transaction est hors-champ.",
  },
  {
    key: 'achat_etranger_bien_etranger', side: 'achat', status: 'hors_champ',
    label: "Achat fournisseur étranger — bien stocké à l'étranger (modèle douanes)",
    codes: ['Hors champ'],
    note: "Bien expédié depuis l'étranger : la facture du fournisseur est hors-champ (la TPS est perçue à part, en douane).",
  },
  {
    key: 'salaires', side: 'achat', status: 'hors_champ',
    label: 'Salaires',
    codes: ['Hors champ'],
    note: 'Les salaires ne sont pas des fournitures commerciales — hors du cadre de la loi.',
  },
  {
    key: 'remboursement_dette', side: 'both', status: 'hors_champ',
    label: "Remboursement d'une dette (capital)",
    codes: ['Hors champ'],
    note: "Remboursement de capital : pas une fourniture → hors-champ. La part intérêts est un service financier exonéré (à comptabiliser séparément).",
  },
  {
    key: 'subvention', side: 'both', status: 'hors_champ',
    label: 'Subvention',
    codes: ['Hors champ'],
    note: 'Aucune contrepartie commerciale → hors-champ.',
  },
  // ── Ventes / revenus (rares dans la section Extraction, fournis pour complétude) ──
  {
    key: 'vente_abo_qc', side: 'vente', status: 'taxable',
    label: 'Vente / Abonnement au Québec',
    codes: ['TPS/TVQ QC - 9,975'],
    note: 'Vente taxable au Québec : TPS 5 % + TVQ 9,975 %.',
  },
  {
    key: 'vente_abo_usa', side: 'vente', status: 'detaxe',
    label: 'Vente / Abonnement aux USA (export)',
    codes: ['Détaxé'],
    note: 'Produits et services exportés : détaxés (0 %), CTI/RTI réclamables.',
  },
  {
    key: 'vente_abo_premieres_nations', side: 'vente', status: 'detaxe',
    label: 'Vente / Abonnement aux Premières Nations',
    codes: ['Détaxé'],
    note: 'Exemption sous conditions (livraison sur réserve + attestation de la bande). Détaxé.',
  },
]

const TYPE_BY_KEY = new Map(TRANSACTION_TYPES.map(t => [t.key, t]))

export function getTransactionType(key) {
  return key ? TYPE_BY_KEY.get(key) || null : null
}

// Liste exposée au client (sans logique de suggestion). Inclut le libellé du statut.
export function listTransactionTypes() {
  return TRANSACTION_TYPES.map(t => ({
    key: t.key,
    label: t.label,
    side: t.side,
    status: t.status,
    statusLabel: FISCAL_STATUS[t.status]?.label || t.status,
    statusDefinition: FISCAL_STATUS[t.status]?.definition || '',
    codes: t.codes,
    recommendedCode: t.codes[0],
    note: t.note,
  }))
}

// Valide un code de taxe (NOM QB) contre le type de transaction choisi.
// selectedCodeName === null/'' (aucune taxe) ne matche jamais : chaque type exige un
// code précis (y compris les statuts 0 % Détaxé/Exonéré/Hors champ).
export function validateTaxCodeAgainstType(typeKey, selectedCodeName) {
  const type = getTransactionType(typeKey)
  if (!type) return { ok: false, unknownType: true }
  const expected = type.codes
  const ok = !!selectedCodeName && expected.includes(selectedCodeName)
  return {
    ok,
    typeLabel: type.label,
    status: type.status,
    statusLabel: FISCAL_STATUS[type.status]?.label || type.status,
    expectedCodes: expected,
    recommendedCode: expected[0],
    selectedCodeName: selectedCodeName || null,
    note: type.note,
  }
}

// Indices fournisseurs (table 4 du Sheet + journal des corrections). Clés = motif
// recherché (insensible casse/accents) dans le nom du fournisseur.
const VENDOR_HINTS = [
  { match: /\bgoogle\b/, type: 'achat_num_inscrit_b2b_exempte' },
  { match: /axxess/, type: 'courtage_export' },
  { match: /digikey|mouser/, type: 'achat_pieces_etranger_douane' },
  { match: /fedex|purolator|\bups\b|\bdhl\b|nationex|canpar|postes canada|canada post/, type: 'transport_export' },
  { match: /desjardins|\bvisa\b|mastercard|\bbanque\b|\bbank\b/, type: 'remboursement_dette' },
  { match: /assurance|insurance/, type: 'assurances' },
  { match: /starbucks|tim hortons|mcdonald|restaurant|\bresto\b|traiteur|uber eats|doordash|skip the dishes/, type: 'repas_representation' },
]

// Fournisseurs numériques connus (table 4) — le statut dépend des taxes facturées.
const DIGITAL_VENDORS = /anthropic|openai|open ai|\bwix\b|adobe|linode|ionos|hubspot|quickbooks|microsoft|\baws\b|amazon web|cloudflare|notion|slack|zoom|github|atlassian|figma/

function normalize(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

// Suggère un type de transaction à partir du fournisseur, des montants de taxe et de
// la description. Conservateur : retourne null quand aucun indice fiable (l'utilisateur
// choisit alors manuellement). La suggestion est TOUJOURS à confirmer côté UI.
export function suggestTransactionType({ company, currency, tps, tvq, generalDescription, items } = {}) {
  const name = normalize(company)
  const desc = normalize(generalDescription)
  const itemsText = normalize(Array.isArray(items) ? items.map(i => i && i.description).join(' ') : '')
  const haystack = `${name} ${desc} ${itemsText}`
  const hasTax = (Number(tps) || 0) > 0 || (Number(tvq) || 0) > 0

  // Café / produits d'épicerie chez un détaillant générique → aliments de base détaxés.
  if (/\bcafe\b|\bcoffee\b|epicerie|grocery/.test(haystack) && !/starbucks|tim hortons|restaurant/.test(haystack)) {
    return 'produits_alimentaires_base'
  }

  for (const h of VENDOR_HINTS) {
    if (h.match.test(name)) return h.type
  }

  if (DIGITAL_VENDORS.test(name)) {
    return hasTax ? 'achat_num_inscrit_taxe' : 'achat_num_inscrit_b2b_exempte'
  }

  // Repérage générique d'un repas par la description.
  if (/\brepas\b|\bdiner\b|\bdejeuner\b|\bsouper\b|\blunch\b|\bdinner\b/.test(haystack)) {
    return 'repas_representation'
  }

  // Cas courant : fournisseur canadien qui facture TPS+TVQ → achat local taxable.
  const cur = (currency || 'CAD').toUpperCase()
  if (hasTax && cur === 'CAD') return 'achat_local_taxable'

  // Aucune taxe + devise étrangère : trop ambigu (hors-champ vs détaxé vs exonéré).
  return null
}
