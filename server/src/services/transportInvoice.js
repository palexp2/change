// Factures de transport MULTI-EXPÉDITIONS (NovoXpress / Groupe Alliances et Privilèges,
// ou toute messagerie qui facture plusieurs envois avec des taxes PAR expédition).
//
// Problème : ces factures appliquent une taxe différente selon la destination de chaque
// envoi (Québec → TPS+TVQ, export É-U → détaxé, provinces TVH → taux 13/14/15 % selon la
// province, provinces PST → TPS seule + une taxe provinciale, parfois aucune taxe). Le
// sommaire de la 1re page écrase tout en quelques lignes de type de frais — ce qui perd
// la ventilation et casse l'invariant subtotal + taxes = total.
//
// Ce module reconstruit, de façon DÉTERMINISTE (pas via l'IA), des lignes d'articles
// regroupées PAR PROVINCE / PAYS DE DESTINATION, prêtes pour la publication QB par ligne :
//  - Une ligne par province de destination (le code de taxe QB dépend de la province :
//    QC → TPS/TVQ, ON → TVH ON, NB → TVH N.-B. 2016, etc.) et une ligne par pays d'export.
//  - Portion RÉCUPÉRABLE seulement (Orisha est inscrite TPS fédérale + TVQ Québec ; la
//    TVH/HST est fédérale-administrée donc récupérable). La TVQ/QST hors-Québec ou une PST
//    provinciale à laquelle on n'est pas inscrit n'est PAS récupérable.
//  - La taxe NON récupérable est repliée dans le coût de la dépense (ligne sans code de
//    taxe, par province), conformément au traitement comptable.
//  - Les CRÉDITS / retours (expéditions à total négatif) se soustraient dans le groupe de
//    leur destination — indispensable pour boucler au « Montant total dû » de la facture.
//
// Sortie : { items:[{description, quantity, unit_price, total, tax_code_name}], subtotal,
// tps, tvq, other_taxes, total }. `tax_code_name` est un NOM de code QB (résolu en Id par
// l'appelant) ou null (code à choisir à la main, ex. TVH d'une province inconnue — la
// ligne suit alors le code global du document tant que l'opérateur n'a pas tranché).
//
// NB : chaque ligne DOIT porter un code QB. Le sentinel « aucune taxe » (__none__, ligne
// sans TaxCodeRef) est refusé par QB sur un Bill dès que les autres lignes ont un code
// (erreur 6000 « Tous les articles ont besoin d'un taux de taxe ») — les montants qu'on
// ne réclame pas reçoivent donc « Hors champ » (0 %, hors des cases du rapport de taxes).

const round2 = n => Math.round((Number(n) || 0) * 100) / 100

function norm(s) {
  return (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
}

// Réduit un libellé de taxe à ses lettres (« T.P.S. » → « tps », « T.V.Q. » → « tvq »).
function taxKey(label) {
  return norm(label).replace(/[^a-z]/g, '')
}

// Classe une taxe d'expédition d'après son libellé.
// gst = TPS fédérale · qst = TVQ Québec · hst = TVH combinée · pst = taxe provinciale
// séparée (BC/SK/MB…) · other = inconnue (traitée prudemment comme non récupérable).
export function classifyTax(label) {
  const k = taxKey(label)
  if (k.includes('tvq') || k.includes('qst')) return 'qst'
  if (k.includes('tvh') || k.includes('hst')) return 'hst'
  if (k.includes('pst') || k.includes('rst') || k.includes('tvp')) return 'pst'
  if (k.includes('tps') || k.includes('gst')) return 'gst'
  return 'other'
}

// Inscriptions fiscales d'Orisha (récupérabilité). qst=true car inscrite au Québec ;
// hst=true car la TVH est fédérale-administrée (un inscrit TPS la récupère). La PST des
// autres provinces n'est jamais récupérable (on n'y est pas inscrit).
const DEFAULT_REGISTRATIONS = { qst: true, hst: true }

function isForeign(country) {
  const c = norm(country).replace(/[^a-z]/g, '')
  return !!c && c !== 'ca' && c !== 'can' && c !== 'canada'
}

const PROVINCE_NAMES = {
  QC: 'Québec', ON: 'Ontario', BC: 'Colombie-Britannique', AB: 'Alberta',
  SK: 'Saskatchewan', MB: 'Manitoba', NB: 'Nouveau-Brunswick', NS: 'Nouvelle-Écosse',
  PE: 'Î.-P.-É.', NL: 'Terre-Neuve-et-Labrador', YT: 'Yukon', NT: 'T.N.-O.', NU: 'Nunavut',
}

// Code de taxe QB (NOM exact du fichier QB de prod, vérifié 2026-07-11) pour la TVH de
// chaque province harmonisée. Les taux diffèrent (ON 13 %, N.-É. 14 %, NB/Î.-P.-É./T.-N.-L.
// 15 %) → JAMAIS fusionner deux provinces TVH sur une même ligne.
const HST_CODE_BY_PROVINCE = {
  ON: 'TVH ON',
  NB: 'TVH N.-B. 2016',
  NS: 'TVH N.S.',
  PE: 'TVH Î.-P.-É. 2016',
  NL: 'TVH T.-N.-L. 2016',
}

// Normalise une province en code à 2 lettres (l'IA est censée émettre « QC|ON|… »,
// mais on tolère un nom complet). Retourne null si non reconnue.
function provinceCode(value) {
  const raw = (value || '').trim()
  if (!raw) return null
  const two = raw.toUpperCase().replace(/[^A-Z]/g, '')
  if (two.length === 2 && PROVINCE_NAMES[two]) return two
  const n = norm(raw).replace(/[^a-z]/g, '')
  for (const [code, name] of Object.entries(PROVINCE_NAMES)) {
    if (norm(name).replace(/[^a-z]/g, '') === n) return code
  }
  return null
}

// Libellé d'un pays d'export (regroupement par pays de destination).
function countryLabel(country) {
  const c = norm(country).replace(/[^a-z]/g, '')
  if (c === 'us' || c === 'usa' || c === 'unitedstates' || c === 'etatsunis') return 'É.-U.'
  return (country || '').trim().toUpperCase() || 'étranger'
}

export function buildTransportInvoice(shipments, { registrations } = {}) {
  const reg = { ...DEFAULT_REGISTRATIONS, ...(registrations || {}) }
  const list = (Array.isArray(shipments) ? shipments : []).filter(s => s && Number(s.total))

  const groups = new Map()          // key -> { description, codeName, ht }
  const nonRecoverable = new Map()  // province (code ou null) -> montant PST/taxe inconnue
  let tps = 0, tvq = 0, otherTaxes = 0

  for (const sh of list) {
    const taxes = Array.isArray(sh.taxes) ? sh.taxes : []
    const totalTax = round2(taxes.reduce((s, t) => s + (Number(t?.amount) || 0), 0))
    const ht = round2((Number(sh.total) || 0) - totalTax)
    const prov = provinceCode(sh.destination_province)
    const provName = prov ? PROVINCE_NAMES[prov] : null

    const kinds = new Set()
    for (const t of taxes) {
      const kind = classifyTax(t?.label)
      const amt = Number(t?.amount) || 0
      const recoverable = kind === 'gst' || (kind === 'qst' && reg.qst) || (kind === 'hst' && reg.hst)
      if (!recoverable) {
        nonRecoverable.set(prov, round2((nonRecoverable.get(prov) || 0) + amt))
        continue
      }
      kinds.add(kind)
      if (kind === 'gst') tps = round2(tps + amt)
      else if (kind === 'qst') tvq = round2(tvq + amt)
      else if (kind === 'hst') otherTaxes = round2(otherTaxes + amt)
    }

    // Groupe (par province/pays de destination) + code de taxe QB de cette expédition.
    let key, codeName, description
    if (kinds.has('gst') && kinds.has('qst')) {
      codeName = 'TPS/TVQ QC - 9,975'; key = 'qc'
      description = 'Transport — Québec (TPS/TVQ)'
    } else if (kinds.has('hst')) {
      // Le taux TVH varie par province → une ligne PAR province, chacune son code QB.
      codeName = prov ? (HST_CODE_BY_PROVINCE[prov] || null) : null
      key = `hst:${prov || '?'}`
      description = provName
        ? `Transport — ${provName} (TVH${codeName ? '' : ' — code à confirmer'})`
        : 'Transport — TVH (province inconnue, code à confirmer)'
    } else if (kinds.has('gst')) {
      codeName = 'TPS'; key = `gst:${prov || '?'}`
      description = provName ? `Transport — ${provName} (TPS)` : 'Transport — TPS récupérable'
    } else if (kinds.has('qst')) {
      codeName = 'TVQ QC - 9,975'; key = 'qst'
      description = 'Transport — TVQ'
    } else if (isForeign(sh.destination_country)) {
      codeName = 'Détaxé'
      const label = countryLabel(sh.destination_country)
      key = `export:${label}`
      description = `Transport — Export ${label} (détaxé)`
    // Domestique sans taxe facturée (ex. envoi où le transporteur n'a pas chargé de
    // taxe) → Hors champ : le transport n'est pas une fourniture exonérée (≠ services
    // financiers), et aucune taxe n'a été perçue → on le sort du champ plutôt que de
    // réclamer un crédit.
    } else {
      codeName = 'Hors champ'; key = `notax:${prov || '?'}`
      description = provName
        ? `Transport — ${provName} sans taxe (hors champ)`
        : 'Transport — sans taxe (hors champ)'
    }

    const g = groups.get(key) || { description, codeName, ht: 0 }
    g.ht = round2(g.ht + ht)
    groups.set(key, g)
  }

  const items = []
  for (const g of groups.values()) {
    items.push({ description: g.description, quantity: null, unit_price: null, total: g.ht, tax_code_name: g.codeName })
  }
  for (const [prov, amt] of nonRecoverable) {
    if (!amt) continue
    // Taxe provinciale non récupérable → repliée dans le coût, code « Hors champ » :
    // 0 % (QB ne rajoute rien par-dessus) et hors des cases du rapport de taxes (on ne
    // réclame rien). Ni null (hériterait du code global du document → taxe rajoutée par
    // QB), ni sans code (« __none__ » : refusé par QB en publication par ligne, cf. NB
    // d'en-tête).
    const suffix = prov ? ` (${PROVINCE_NAMES[prov]})` : ''
    items.push({ description: `Taxe provinciale non récupérable${suffix}`, quantity: null, unit_price: null, total: amt, tax_code_name: 'Hors champ' })
  }

  const subtotal = round2(items.reduce((s, it) => s + (Number(it.total) || 0), 0))
  const total = round2(subtotal + tps + tvq + otherTaxes)
  return { items, subtotal, tps, tvq, other_taxes: otherTaxes, total }
}
