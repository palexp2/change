import db from '../db/database.js'
import { normalizeVendorKey } from './vendorProfiles.js'

// ─── Période de service (abonnements & services récurrents) ────────────────────
//
// Une facture d'abonnement doit porter la PÉRIODE COUVERTE, pas seulement sa date
// d'émission (« Google Workspace — juillet 2026 »), pour qu'en fin d'année on sache
// quelle facture couvre quel mois. Le prompt d'extraction demande déjà le champ
// `service_period`, mais l'IA l'oublie régulièrement — et une facture publiée sans
// période est une facture à recorriger à la main dans QuickBooks.
//
// Ce module est le FILET DÉTERMINISTE derrière le prompt. Trois sources, par ordre
// de confiance décroissant :
//   1. la période extraite par l'IA (elle a lu le document) ;
//   2. une période IMPRIMÉE sur le document, retrouvée par regex dans le texte du PDF
//      et dans les descriptions d'articles (« Billing period: Jul 1 – Jul 31, 2026 »,
//      « Engagement 1 juin - 30 juin », « du 15/07/2026 au 14/08/2026 ») ;
//   3. à défaut, le CYCLE DE FACTURATION déclaré dans /abonnements-fournisseurs
//      (table `vendor_subscriptions` : fréquence, jour de facturation, « Mois passé »
//      vs « Mois à venir ») appliqué à la date de la facture.
//
// La source 3 est une déduction : elle n'est appliquée que si le fournisseur a un
// abonnement ACTIF *et* que la facture ressemble bien à cet abonnement (libellé de
// service récurrent ou montant du même ordre) — cf. looksLikeSubscriptionInvoice.

const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
const MONTHS_ABBR = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.']

const norm = s => String(s || '')
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

// ─── Arithmétique de dates en triplets {y,m,d} (m = 1-12) ─────────────────────
// Volontairement sans objet Date local : tout se joue en dates civiles, aucune
// conversion de fuseau ne doit décaler un 1er du mois sur le 31 précédent.

const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate()
const clampDay = (y, m, d) => Math.min(Math.max(d, 1), daysInMonth(y, m))
const toKey = ({ y, m, d }) => y * 10000 + m * 100 + d
const addMonths = ({ y, m, d }, n) => {
  const total = (y * 12 + (m - 1)) + n
  const ny = Math.floor(total / 12)
  const nm = (total % 12) + 1
  return { y: ny, m: nm, d: clampDay(ny, nm, d) }
}
const addDays = ({ y, m, d }, n) => {
  const dt = new Date(Date.UTC(y, m - 1, d + n))
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() }
}

export function parseIsoDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || '').trim())
  if (!m) return null
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3])
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null
  return { y, m: mo, d }
}

// ─── Libellés ─────────────────────────────────────────────────────────────────

// Période bornée par deux dates INCLUSIVES → libellé concis français :
//   1er → dernier jour d'un même mois        → « juillet 2026 »
//   mois civils consécutifs                  → « juillet–septembre 2026 »
//   année civile complète                    → « année 2026 »
//   sinon                                    → « 15 juil. – 14 août 2026 »
export function formatPeriodRange(start, end) {
  if (!start || !end || toKey(end) < toKey(start)) return null
  const wholeMonths = start.d === 1 && end.d === daysInMonth(end.y, end.m)
  if (wholeMonths) {
    if (start.y === end.y && start.m === end.m) return `${MONTHS_FR[start.m - 1]} ${start.y}`
    if (start.y === end.y && start.m === 1 && end.m === 12) return `année ${start.y}`
    if (start.y === end.y) return `${MONTHS_FR[start.m - 1]}–${MONTHS_FR[end.m - 1]} ${start.y}`
    return `${MONTHS_ABBR[start.m - 1]} ${start.y} – ${MONTHS_ABBR[end.m - 1]} ${end.y}`
  }
  const left = start.y === end.y
    ? `${start.d} ${MONTHS_ABBR[start.m - 1]}`
    : `${start.d} ${MONTHS_ABBR[start.m - 1]} ${start.y}`
  return `${left} – ${end.d} ${MONTHS_ABBR[end.m - 1]} ${end.y}`
}

// ─── Annotation des libellés ──────────────────────────────────────────────────

// Période de service (abonnements, télécom, licences…) suffixée aux descriptions
// d'articles : « Abonnement Slack — juillet 2026 ». L'IA la met déjà par ligne quand
// elle la voit (et par ligne c'est plus fin : prorata + mois d'avance), mais elle
// l'oublie souvent alors qu'elle a bien rempli "service_period" — ce filet garantit
// que chaque ligne porte la période. On ne touche pas à une ligne qui la mentionne
// déjà (comparaison insensible à la casse/accents/ponctuation).
export function annotateItemsWithPeriod(items, period) {
  const list = Array.isArray(items) ? items : []
  const label = (period || '').trim()
  if (!label || !list.length) return list
  const target = norm(label)
  if (!target) return list
  return list.map(it => {
    const desc = (it?.description || '').trim()
    // Ligne qui date déjà quelque chose (période propre posée par l'IA — prorata,
    // mois d'avance — ou millésime dans le libellé) : on n'empile pas une 2e période
    // par-dessus. La période globale reste de toute façon dans le mémo.
    if (!desc || norm(desc).includes(target) || PERIOD_HINT.test(norm(desc))) return it
    return { ...it, description: `${desc} — ${label}` }
  })
}

// Même principe pour la description principale : la période fait partie de la phrase
// (« Abonnement Slack — juillet 2026 ») au lieu de vivre dans un champ séparé. C'est
// cette description qui devient le mémo QuickBooks : la période y est donc lisible
// telle quelle, sans ligne « Période : … » ajoutée en queue.
export function annotateDescriptionWithPeriod(description, period) {
  const desc = (description || '').trim()
  const label = (period || '').trim()
  if (!desc || !label) return desc || null
  if (norm(desc).includes(norm(label)) || PERIOD_HINT.test(norm(desc))) return desc
  return `${desc} — ${label}`
}

// Indice qu'une description porte déjà une date/période : nom de mois (FR ou EN,
// abrégé ou non), année à 4 chiffres, ou trimestre — sur la forme normalisée
// (minuscules, sans accents, ponctuation → espaces).
const MONTH_TOKENS = 'janvier|janv|jan|fevrier|fevr|fev|feb|mars|mar|avril|avr|apr|mai|may|juin|jun|juillet|juil|jul|aout|august|aug|septembre|sept|sep|octobre|oct|novembre|nov|decembre|dec'
const PERIOD_HINT = new RegExp(`\\b(?:${MONTH_TOKENS})\\b|\\b(?:19|20)\\d{2}\\b|\\bt[1-4] (?:19|20)\\d{2}\\b`)

// ─── 2. Période imprimée sur le document ──────────────────────────────────────

const MONTH_WORDS = [
  ['janvier', 'janv', 'jan', 'january'],
  ['fevrier', 'fevr', 'fev', 'feb', 'february'],
  ['mars', 'mar', 'march'],
  ['avril', 'avr', 'apr', 'april'],
  ['mai', 'may'],
  ['juin', 'jun', 'june'],
  ['juillet', 'juil', 'jul', 'july'],
  ['aout', 'aug', 'august'],
  ['septembre', 'sept', 'sep', 'september'],
  ['octobre', 'oct', 'october'],
  ['novembre', 'nov', 'november'],
  ['decembre', 'dec', 'december'],
]
const MONTH_INDEX = new Map()
MONTH_WORDS.forEach((words, i) => words.forEach(w => MONTH_INDEX.set(w, i + 1)))
const MONTH_RE = [...MONTH_INDEX.keys()].sort((a, b) => b.length - a.length).join('|')

// Un jalon de date dans une phrase de période. Trois formes acceptées :
//   2026-07-01 · 01/07/2026 (jour/mois, format canadien-français) · 1 juil 2026 / jul 1 2026
const DATE_RE = `(?:\\d{4} \\d{1,2} \\d{1,2}|\\d{1,2} \\d{1,2} \\d{4}|\\d{1,2} (?:${MONTH_RE})(?: \\d{4})?|(?:${MONTH_RE}) \\d{1,2}(?: \\d{4})?)`

// Parse un jalon déjà normalisé (minuscules, séparateurs → espaces).
function parseLoose(token, fallbackYear) {
  const t = token.trim()
  let m = /^(\d{4}) (\d{1,2}) (\d{1,2})$/.exec(t)
  if (m) return { y: +m[1], m: +m[2], d: +m[3] }
  m = /^(\d{1,2}) (\d{1,2}) (\d{4})$/.exec(t)
  // Jour/mois par défaut (usage canadien-français) ; un 2e nombre > 12 trahit un
  // document en mois/jour (US) et inverse la lecture.
  if (m) return +m[2] > 12 ? { y: +m[3], m: +m[1], d: +m[2] } : { y: +m[3], m: +m[2], d: +m[1] }
  m = new RegExp(`^(\\d{1,2}) (${MONTH_RE})(?: (\\d{4}))?$`).exec(t)
  if (m) return { y: m[3] ? +m[3] : fallbackYear, m: MONTH_INDEX.get(m[2]), d: +m[1] }
  m = new RegExp(`^(${MONTH_RE}) (\\d{1,2})(?: (\\d{4}))?$`).exec(t)
  if (m) return { y: m[3] ? +m[3] : fallbackYear, m: MONTH_INDEX.get(m[1]), d: +m[2] }
  return null
}

const valid = p => p && p.y >= 2000 && p.y <= 2100 && p.m >= 1 && p.m <= 12 && p.d >= 1 && p.d <= daysInMonth(p.y, p.m)

// Cherche une période EXPLICITEMENT imprimée dans un texte (texte du PDF, descriptions
// d'articles…). Deux formes : une phrase introduite par un mot-clé de période, ou un
// intervalle « du X au Y ». Rien trouvé → null (on n'invente pas).
export function findPeriodInText(text, receiptDate = null) {
  const src = norm(text)
  if (!src) return null
  const fallbackYear = parseIsoDate(receiptDate)?.y || new Date().getUTCFullYear()
  const SEP = '(?:au?|a|to|jusqu au|through|thru|until|till)'
  const KEY = '(?:periode(?: de)?(?: facturation| service| couverte| d abonnement)?|billing period|service period|subscription period|coverage period|periode du|engagement|abonnement|cycle de facturation|billing cycle|for the period)'
  // La normalisation a effacé la ponctuation : le tiret d'un intervalle « 1 juin -
  // 30 juin » n'existe plus. Après un mot-clé de période, le séparateur est donc
  // facultatif ; sans mot-clé, on exige « du … au … » pour ne pas ramasser deux dates
  // sans rapport.
  const patterns = [
    new RegExp(`${KEY}[a-z ]{0,20}?(${DATE_RE})(?: ${SEP})? (${DATE_RE})`),
    new RegExp(`\\b(?:du|from) (${DATE_RE}) ${SEP} (${DATE_RE})`),
  ]
  for (const re of patterns) {
    const m = re.exec(src)
    if (!m) continue
    let start = parseLoose(m[1], fallbackYear)
    let end = parseLoose(m[2], fallbackYear)
    if (!valid(start) || !valid(end)) continue
    // « 15 déc – 14 janv » sans millésime sur la borne de fin : l'année roule.
    if (toKey(end) < toKey(start) && end.y === start.y) end = { ...end, y: end.y + 1 }
    if (toKey(end) < toKey(start)) continue
    // Garde-fou : une « période » de plus de 18 mois n'en est pas une (on est
    // probablement tombé sur deux dates sans rapport).
    if ((end.y * 12 + end.m) - (start.y * 12 + start.m) > 18) continue
    return formatPeriodRange(start, end)
  }
  return null
}

// ─── 3. Cycle de facturation déclaré (/abonnements-fournisseurs) ──────────────

// Abonnements actifs du fournisseur. Match sur le nom normalisé : le nom de
// l'abonnement doit être un PRÉFIXE du nom extrait (« Google » ⊂ « Google LLC »,
// « Bell » ⊂ « Bell Canada »), jamais l'inverse — sinon une facture « Amazon »
// (matériel) hériterait du cycle de « Amazon Web Services ». Entre plusieurs
// préfixes valides, le plus long gagne (« Bell Mobilité » plutôt que « Bell »).
const CORPORATE_SUFFIXES = new Set(['com', 'ca', 'io', 'ai', 'net', 'org', 'inc', 'ltd', 'llc', 'corp', 'co', 'sa', 'srl', 'gmbh'])

export function matchSubscriptions(company, rows) {
  const key = normalizeVendorKey(company)
  if (!key) return []
  const matches = (rows || []).filter(r => {
    const k = normalizeVendorKey(r.vendor)
    if (!k) return false
    if (key.startsWith(k)) return true
    // Tolérance inverse pour un suffixe purement corporatif/TLD côté abonnement
    // (« MANYCHAT.COM » pour une facture « Manychat ») — jamais pour un vrai
    // qualificatif de produit (« Amazon Web Services » vs « Amazon »).
    return k.startsWith(key) && CORPORATE_SUFFIXES.has(k.slice(key.length))
  })
  if (!matches.length) return []
  const best = Math.max(...matches.map(r => normalizeVendorKey(r.vendor).length))
  return matches.filter(r => normalizeVendorKey(r.vendor).length === best)
}

export function findActiveSubscriptions(company) {
  if (!normalizeVendorKey(company)) return []
  return matchSubscriptions(company, db.prepare('SELECT * FROM vendor_subscriptions WHERE deleted_at IS NULL AND active = 1').all())
}

// Convention de couverture déclarée sur l'abonnement : facturé d'avance (« Mois à
// venir » / « Année à venir ») ou à terme échu (« Mois passé »). Rien de reconnu →
// null : sans savoir de quel côté du cycle on est, on ne déduit pas.
function coverageDirection(sub) {
  const p = norm(sub?.period)
  if (!p) return null
  if (p.includes('venir') || p.includes('avance') || p.includes('advance')) return 'advance'
  if (p.includes('passe') || p.includes('echu') || p.includes('arrear')) return 'arrears'
  return null
}

// Début du cycle de facturation englobant la facture : l'occurrence du jour de
// facturation la plus récente au moment de la facture. Tolérance de 4 jours en avant —
// une facture émise le 31 juillet pour un cycle qui débute le 1er août appartient au
// cycle d'août (cas Google Workspace, facturé le dernier jour du mois couvert).
function cycleAnchor(receipt, sub, frequencyMonths) {
  const day = Number(sub.billing_day) || 0
  if (!day) return null
  const limit = addDays(receipt, 4)
  let candidates
  if (frequencyMonths === 12) {
    const month = Number(sub.billing_month) || 0
    if (!month) return null
    candidates = [-1, 0, 1].map(n => ({ y: receipt.y + n, m: month, d: clampDay(receipt.y + n, month, day) }))
  } else {
    candidates = [-1, 0, 1].map(n => addMonths({ y: receipt.y, m: receipt.m, d: 1 }, n))
      .map(({ y, m }) => ({ y, m, d: clampDay(y, m, day) }))
  }
  const eligible = candidates.filter(c => toKey(c) <= toKey(limit))
  if (!eligible.length) return null
  return eligible.reduce((a, b) => (toKey(b) > toKey(a) ? b : a))
}

// La facture ressemble-t-elle à une facture de CET abonnement ? Le fournisseur peut
// aussi nous vendre du ponctuel (matériel, frais uniques) : on ne colle une période
// que si le libellé évoque un service récurrent, si le plan de l'abonnement se lit
// dans les lignes, ou si le montant est du même ordre que l'abonnement.
const RECURRING_WORDS = /abonnement|subscription|forfait|licence|license|plan|hebergement|hosting|service mensuel|service annuel|renouvellement|renewal|workspace|membership|cotisation|maintenance|support|infonuagique|cloud/
export function looksLikeSubscriptionInvoice(receipt, sub) {
  const haystack = norm([
    receipt.general_description,
    ...(Array.isArray(receipt.items) ? receipt.items.map(i => i?.description) : []),
  ].filter(Boolean).join(' '))
  if (RECURRING_WORDS.test(haystack)) return true
  const plan = norm(sub.plan)
  if (plan && plan.length > 3 && haystack.includes(plan)) return true
  const amount = Number(sub.amount) || 0
  const total = Number(receipt.total) || 0
  if (amount > 0 && total > 0 && Math.abs(total - amount) / amount <= 0.25) return true
  // Abonnement à montant variable (consommation) : le montant ne prouve rien, mais le
  // fournisseur n'est facturé QUE pour ce service → on accepte.
  return !!Number(sub.variable)
}

// Période déduite du cycle déclaré pour un abonnement actif du fournisseur.
// `knownSubs` (tests) : abonnements injectés au lieu d'être lus en base.
export function derivePeriodFromSubscription(receipt, knownSubs = null) {
  const date = parseIsoDate(receipt?.receipt_date)
  if (!date) return null
  let subs = knownSubs
  if (!subs) {
    try { subs = findActiveSubscriptions(receipt.company) } catch { return null }
  }
  const labels = new Set()
  for (const sub of subs) {
    const months = norm(sub.frequency) === 'annuel' ? 12 : 1
    const direction = coverageDirection(sub)
    if (!direction) continue
    if (!looksLikeSubscriptionInvoice(receipt, sub)) continue
    const anchor = cycleAnchor(date, sub, months)
    if (!anchor) continue
    // Facturé d'avance : le cycle qui commence à l'ancre. À terme échu : celui qui
    // vient de se terminer, donc décalé d'une période en arrière.
    const start = direction === 'advance' ? anchor : addMonths(anchor, -months)
    const end = addDays(addMonths(start, months), -1)
    const label = formatPeriodRange(start, end)
    if (label) labels.add(label)
  }
  // Deux abonnements actifs qui ne s'accordent pas sur la période : on s'abstient.
  return labels.size === 1 ? [...labels][0] : null
}

// ─── Résolution ───────────────────────────────────────────────────────────────

// `receipt` : { company, receipt_date, general_description, items, total }
// `aiPeriod` : la période retournée par l'extraction (prioritaire).
// `sourceText` : texte brut du document (pdftotext), optionnel.
// Retourne { period, source } — source ∈ 'ai' | 'document' | 'subscription' | null.
export function resolveServicePeriod(receipt, aiPeriod = null, sourceText = null) {
  const ai = (aiPeriod || '').trim()
  if (ai) return { period: ai, source: 'ai' }
  const itemText = (Array.isArray(receipt?.items) ? receipt.items.map(i => i?.description) : [])
    .filter(Boolean).join(' | ')
  const printed = findPeriodInText([receipt?.general_description, itemText, sourceText].filter(Boolean).join('\n'), receipt?.receipt_date)
  if (printed) return { period: printed, source: 'document' }
  const derived = derivePeriodFromSubscription(receipt || {})
  if (derived) return { period: derived, source: 'subscription' }
  return { period: null, source: null }
}

// Dernier filet, AVANT publication dans QuickBooks : un reçu extrait sans période (IA
// muette, ou reçu extrait avant l'arrivée de cette chaîne) ne doit pas partir dans QB
// sans sa période — la corriger après coup dans QuickBooks coûte bien plus cher.
// Remplit `service_period` et intègre la période aux libellés (description principale
// + lignes d'articles), exactement comme le fait l'extraction. Idempotent : ne touche
// à rien si la période est déjà là. `rec` est muté pour l'appelant.
export function ensureServicePeriodForReceipt(rec) {
  if (!rec || (rec.service_period || '').trim()) return null
  // Facture de transport multi-expéditions : ponctuelle par nature, pas de période.
  try {
    const raw = JSON.parse(rec.raw_data || '{}')
    if (Array.isArray(raw.shipments) && raw.shipments.some(s => s && Number(s.total))) return null
  } catch {}
  const items = Array.isArray(rec.items) ? rec.items : JSON.parse(rec.items || '[]')
  const { period, source } = resolveServicePeriod({ ...rec, items })
  if (!period) return null
  const description = annotateDescriptionWithPeriod(rec.general_description, period)
  const annotated = annotateItemsWithPeriod(items, period)
  db.prepare(`
    UPDATE sale_receipts
    SET service_period=?, general_description=?, items=?,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id=? AND deleted_at IS NULL
  `).run(period, description, JSON.stringify(annotated), rec.id)
  rec.service_period = period
  rec.general_description = description
  rec.items = JSON.stringify(annotated)
  console.log(`Reçu ${rec.id} : période « ${period} » ajoutée avant publication QB (${source})`)
  return { period, source, items: annotated, general_description: description }
}
