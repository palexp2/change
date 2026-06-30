// Factures de transport MULTI-EXPÉDITIONS (NovoXpress / Groupe Alliances et Privilèges,
// ou toute messagerie qui facture plusieurs envois avec des taxes PAR expédition).
//
// Problème : ces factures appliquent une taxe différente selon la destination de chaque
// envoi (Québec → TPS+TVQ, export É-U → détaxé, certaines provinces → TPS seule + une
// taxe provinciale, parfois aucune taxe). Le sommaire de la 1re page écrase tout en
// quelques lignes de type de frais et ne capte que les taxes du Québec — ce qui perd la
// ventilation et casse l'invariant subtotal + taxes = total.
//
// Ce module reconstruit, de façon DÉTERMINISTE (pas via l'IA), des lignes d'articles
// regroupées par CODE DE TAXE récupérable, prêtes pour la publication QB par ligne :
//  - Portion RÉCUPÉRABLE seulement (Orisha est inscrite TPS fédérale + TVQ Québec ; la
//    TVH/HST est fédérale-administrée donc récupérable). La TVQ/QST hors-Québec ou une PST
//    provinciale à laquelle on n'est pas inscrit n'est PAS récupérable.
//  - La taxe NON récupérable est repliée dans le coût de la dépense (ligne sans code de
//    taxe), conformément au traitement comptable : on ne réclame que ce qu'on peut réclamer.
//
// Sortie : { items:[{description, quantity, unit_price, total, tax_code_name}], subtotal,
// tps, tvq, other_taxes, total }. `tax_code_name` est un NOM de code QB (résolu en Id par
// l'appelant) ou null (ligne sans taxe : export détaxé, sans-taxe, ou taxe à coder à la main).

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

// Libellé d'une ligne regroupée par code de taxe.
function groupLabel(key) {
  switch (key) {
    case 'TPS/TVQ QC - 9,975': return 'Transport — Québec (TPS/TVQ)'
    case 'TPS':                return 'Transport — TPS récupérable'
    case 'TVQ QC - 9,975':     return 'Transport — TVQ'
    case '__hst__':            return 'Transport — TVH/HST (code à confirmer)'
    case '__detaxe__':         return 'Transport — Export (détaxé)'
    case '__notax__':          return 'Transport — sans taxe (hors champ)'
    default:                   return 'Transport'
  }
}

export function buildTransportInvoice(shipments, { registrations } = {}) {
  const reg = { ...DEFAULT_REGISTRATIONS, ...(registrations || {}) }
  const list = (Array.isArray(shipments) ? shipments : []).filter(s => s && Number(s.total))

  const groups = new Map() // key -> { codeName, ht }
  let tps = 0, tvq = 0, otherTaxes = 0, nonRecoverable = 0

  for (const sh of list) {
    const taxes = Array.isArray(sh.taxes) ? sh.taxes : []
    const totalTax = round2(taxes.reduce((s, t) => s + (Number(t?.amount) || 0), 0))
    const ht = round2((Number(sh.total) || 0) - totalTax)

    const kinds = new Set()
    for (const t of taxes) {
      const kind = classifyTax(t?.label)
      const amt = Number(t?.amount) || 0
      const recoverable = kind === 'gst' || (kind === 'qst' && reg.qst) || (kind === 'hst' && reg.hst)
      if (!recoverable) { nonRecoverable = round2(nonRecoverable + amt); continue }
      kinds.add(kind)
      if (kind === 'gst') tps = round2(tps + amt)
      else if (kind === 'qst') tvq = round2(tvq + amt)
      else if (kind === 'hst') otherTaxes = round2(otherTaxes + amt)
    }

    // Code de taxe récupérable de cette expédition → clé de regroupement.
    let key, codeName
    if (kinds.has('gst') && kinds.has('qst')) { codeName = 'TPS/TVQ QC - 9,975'; key = codeName }
    else if (kinds.has('hst')) { codeName = null; key = '__hst__' } // code QB à confirmer
    else if (kinds.has('gst')) { codeName = 'TPS'; key = codeName }
    else if (kinds.has('qst')) { codeName = 'TVQ QC - 9,975'; key = codeName }
    else if (isForeign(sh.destination_country)) { codeName = 'Détaxé'; key = '__detaxe__' }
    // Domestique sans taxe facturée (ex. envoi QC où le transporteur n'a pas chargé de
    // taxe) → Hors champ : le transport n'est pas une fourniture exonérée (≠ services
    // financiers), et aucune taxe n'a été perçue → on le sort du champ plutôt que de
    // réclamer un crédit. (Voir aussi le commentaire dans groupLabel.)
    else { codeName = 'Hors champ'; key = '__notax__' }

    const g = groups.get(key) || { codeName, ht: 0 }
    g.ht = round2(g.ht + ht)
    groups.set(key, g)
  }

  const items = []
  for (const [key, g] of groups) {
    items.push({ description: groupLabel(key), quantity: null, unit_price: null, total: g.ht, tax_code_name: g.codeName })
  }
  if (nonRecoverable > 0) {
    // Taxe provinciale non récupérable → repliée dans le coût (aucun code de taxe).
    items.push({ description: 'Taxe provinciale non récupérable', quantity: null, unit_price: null, total: nonRecoverable, tax_code_name: null })
  }

  const subtotal = round2(items.reduce((s, it) => s + (Number(it.total) || 0), 0))
  const total = round2(subtotal + tps + tvq + otherTaxes)
  return { items, subtotal, tps, tvq, other_taxes: otherTaxes, total }
}
