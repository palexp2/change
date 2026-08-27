// Abonnements fournisseurs (SaaS et charges récurrentes).
//
// Le registre ERP (page Abonnements fournisseurs) est LA référence — l'ancien
// onglet Abonnements du Google Sheets « CTB - Suivi » a été abandonné.
//
// Deux responsabilités :
// 1. Calcul des charges attendues (dates prévues selon fréquence + jour de
//    facturation).
// 2. Croisement « charge attendue ↔ dépense constatée ». Une dépense constatée
//    vient de DEUX sources, pas seulement des reçus :
//      - un reçu ingéré (sale_receipts) — comptabilisé s'il porte un quickbooks_id ;
//      - un achat fournisseur (achats_fournisseurs), miroir des Bills/Purchases
//        QuickBooks — beaucoup d'abonnements sont saisis directement dans QB via
//        le flux bancaire, sans reçu dans l'ERP.
//    Sans la source QB, la quasi-totalité des abonnements payés par carte
//    ressortaient en « reçu manquant » alors qu'ils étaient bel et bien
//    comptabilisés.
//
// Quatre issues par charge attendue :
//   - comptabilisée (reçu poussé OU transaction QB) → rien à signaler ;
//   - `to_book` : trace trouvée mais pas encore dans QB → à comptabiliser ;
//   - `likely_booked` : rien au nom exact, mais le rapprochement approfondi
//     (voir plus bas) trouve une dépense QB très probablement la même, sous un
//     AUTRE nom de fournisseur ou hors de la fenêtre attendue → à confirmer ;
//   - `missing` : aucune trace, même après le rapprochement approfondi.
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { normalizeVendorKey, strippedVendorKey, LEGAL_SUFFIXES } from './vendorProfiles.js'

// ── Charges attendues ────────────────────────────────────────────────────────

const isoDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// Jour de facturation borné à la fin du mois (31 → 28/29/30 selon le mois).
function chargeDateFor(year, monthIdx0, day) {
  const lastDay = new Date(year, monthIdx0 + 1, 0).getDate()
  return new Date(year, monthIdx0, Math.min(day, lastDay), 12)
}

// Dates de charge attendues (ISO YYYY-MM-DD, plus récente d'abord) pour un
// abonnement, jusqu'à aujourd'hui inclus.
// - Mensuel + billing_day : une date par mois sur `lookbackMonths` mois.
// - Annuel + billing_month/billing_day : la dernière occurrence passée.
// - Infos de facturation absentes → [] (non vérifiable).
export function computeExpectedCharges(sub, { today = new Date(), lookbackMonths = 2 } = {}) {
  const day = Number(sub.billing_day)
  if (!Number.isInteger(day) || day < 1 || day > 31) return []
  const out = []
  if (sub.frequency === 'Mensuel') {
    for (let i = 0; i <= lookbackMonths; i++) {
      const d = chargeDateFor(today.getFullYear(), today.getMonth() - i, day)
      if (d <= today) out.push(isoDate(d))
    }
    return out.slice(0, lookbackMonths)
  }
  if (sub.frequency === 'Annuel') {
    const month = Number(sub.billing_month)
    if (!Number.isInteger(month) || month < 1 || month > 12) return []
    let d = chargeDateFor(today.getFullYear(), month - 1, day)
    if (d > today) d = chargeDateFor(today.getFullYear() - 1, month - 1, day)
    return [isoDate(d)]
  }
  return []
}

// ── Rapprochement des noms de fournisseur ────────────────────────────────────

// Deux clés fournisseur matchent si identiques, ou si l'une contient l'autre
// (≥ 4 caractères) — « OpenAI » ↔ « Open AI », « Linode » ↔ « Linode Akamai ».
export function vendorKeysMatch(a, b) {
  if (!a || !b) return false
  if (a === b) return true
  if (a.length >= 4 && b.includes(a)) return true
  if (b.length >= 4 && a.includes(b)) return true
  return false
}

// QuickBooks impose UN vendor par devise : le même fournisseur y apparaît
// suffixé (« Celonis USD », « Wix – USD », « Apilayer Data Products - USD »).
// La clé de rapprochement retire ce suffixe de devise (en fin de nom seulement,
// pour ne pas amputer un « USD Bank ») puis les suffixes légaux.
const CURRENCY_TOKENS = new Set(['usd', 'cad', 'eur', 'euro', 'gbp'])

export function subscriptionVendorKey(name) {
  const tokens = String(name || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
  while (tokens.length > 1 && CURRENCY_TOKENS.has(tokens[tokens.length - 1])) tokens.pop()
  return strippedVendorKey(tokens.join(' '))
}

function keysFor(name) {
  return { norm: normalizeVendorKey(name), stripped: subscriptionVendorKey(name) }
}

function parseAliases(raw) {
  try {
    const v = JSON.parse(raw || '[]')
    return Array.isArray(v) ? v.filter(Boolean).map(String) : []
  } catch { return [] }
}

// Index clé → id de profil fournisseur, construit sur le nom canonique ET les
// alias appris. C'est le point de synchronisation avec /fournisseurs : ajouter
// un alias sur la fiche d'un profil suffit à rapprocher un abonnement d'un nom
// QuickBooks qui ne se ressemble pas (« CIRCLE.SO » ↔ « CircleCo Inc. USD »).
// Une clé peut désigner PLUSIEURS profils (l'alias appris sur un profil peut être
// le nom canonique d'un autre) : l'index garde donc un ensemble d'ids, sinon le
// premier profil rencontré confisquait la clé et le rapprochement échouait en
// silence — un alias fraîchement posé restait sans effet.
export function buildProfileIndex(profiles) {
  const byKey = new Map()
  for (const p of profiles || []) {
    for (const n of [p.name, ...parseAliases(p.aliases)]) {
      for (const k of [normalizeVendorKey(n), subscriptionVendorKey(n)]) {
        if (!k) continue
        if (!byKey.has(k)) byKey.set(k, new Set())
        byKey.get(k).add(p.id)
      }
    }
  }
  return byKey
}

function profileIdsFor(keys, index) {
  const out = new Set()
  for (const k of [keys.norm, keys.stripped]) {
    for (const id of index.get(k) || []) out.add(id)
  }
  return out
}

const firstProfileId = (keys, index) => [...profileIdsFor(keys, index)][0] || null

function vendorsMatch(subKeys, subProfileIds, chargeKeys, index) {
  if (vendorKeysMatch(subKeys.norm, chargeKeys.norm)) return true
  if (vendorKeysMatch(subKeys.stripped, chargeKeys.stripped)) return true
  if (!subProfileIds.size) return false
  for (const id of profileIdsFor(chargeKeys, index)) {
    if (subProfileIds.has(id)) return true
  }
  return false
}

// ── Rapprochement approfondi ─────────────────────────────────────────────────
//
// Le rapprochement strict ci-dessus (noms identiques, contenus l'un dans l'autre,
// ou même profil fournisseur) rate les fournisseurs que QuickBooks porte sous un
// autre nom : « CIRCLE.SO » ↔ « CircleCo Inc. USD », « Amazon Prime » ↔ « Amazon.ca ».
// Résultat : des charges déclarées « aucune trace » alors que la dépense est bel et
// bien comptabilisée. Avant de conclure, on repasse donc sur les dépenses
// comptabilisées avec deux signaux plus souples :
//   1. le NOM — tous les jetons significatifs (hors devise, forme juridique,
//      domaine) se répondent DE PART ET D'AUTRE, ou l'orthographe est voisine
//      (distance d'édition ≤ 2) ;
//   2. le MONTANT — égal, ou égal aux taxes près, ou au change près.
// Un nom voisin SEUL ne suffit pas : le montant (ou la date pile) doit corroborer.
// Et un jeton commun ne fait pas un nom voisin — « Amazon Prime » n'est PAS
// « Amazon.ca », pas plus que « Amazon Web Services » : même groupe, services
// distincts. D'où l'exigence de couverture mutuelle des jetons.
// À l'inverse, pour un abonnement ANNUEL, une dépense du MÊME fournisseur juste à
// côté de la fenêtre signale une cédule mal réglée, pas une dépense manquante.
// Le verdict n'est jamais un masquage silencieux : statut `likely_booked` + la
// pièce trouvée, et l'humain tranche — en retenant le nom QuickBooks (autre nom)
// ou en corrigeant la cédule (date décalée), selon la nature du constat.

// Jetons de fin de nom qui ne portent pas d'information d'identité.
const TLD_TOKENS = new Set(['com', 'net', 'org', 'io', 'ai', 'co', 'so', 'to', 'ca',
  'app', 'dev', 'me', 'us', 'tv', 'xyz', 'fr', 'uk'])

// Jetons significatifs d'un nom : sans devise, sans forme juridique, sans
// extension de domaine (« CIRCLE.SO » → ['circle'], « Amazon.ca » → ['amazon']).
// L'extension n'est retirée que si elle suit un point collé — « Open AI » garde
// donc son « ai ».
export function meaningfulTokens(name) {
  const raw = String(name || '')
  const domainTokens = new Set(
    [...raw.matchAll(/\.([a-z]{2,4})(?![a-z0-9])/gi)]
      .map(m => m[1].toLowerCase())
      .filter(t => TLD_TOKENS.has(t))
  )
  return raw
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length >= 3 && !CURRENCY_TOKENS.has(t) && !LEGAL_SUFFIXES.has(t) && !domainTokens.has(t))
}

// Distance d'édition, abandonnée dès qu'elle dépasse `max` (pas besoin d'aller plus loin).
export function editDistance(a, b, max = 2) {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    let best = i
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
      if (cur[j] < best) best = cur[j]
    }
    if (best > max) return max + 1
    prev = cur
  }
  return prev[b.length]
}

// Un jeton en rejoint-il un autre ? Identique, ou préfixe commun d'au moins
// 4 caractères (« circle » ↔ « circleco »).
const tokenJoins = (x, y) => x === y ||
  (x.length >= 4 && y.length >= 4 && (x.startsWith(y) || y.startsWith(x)))

const allCovered = (a, b) => a.every(x => b.some(y => tokenJoins(x, y)))

// Ressemblance souple entre deux noms : { level: 'token'|'fuzzy', detail } ou null.
//
// La couverture doit être MUTUELLE : chaque jeton significatif d'un côté trouve
// son correspondant en face. Un simple jeton en commun ne suffit pas — c'est ce
// qui faisait passer « Amazon Prime » pour « Amazon.ca » : deux services
// distincts d'un même groupe, dont l'un facture des marchandises et l'autre un
// abonnement. « prime » ne trouve personne en face → ce n'est pas le même
// fournisseur, même si un montant concorde par hasard.
export function looseNameMatch(subName, chargeName) {
  const a = meaningfulTokens(subName)
  const b = meaningfulTokens(chargeName)
  if (!a.length || !b.length) return null
  if (allCovered(a, b) && allCovered(b, a)) {
    return { level: 'token', detail: a.join(' ') }
  }
  const ka = a.join('')
  const kb = b.join('')
  if (Math.min(ka.length, kb.length) >= 5) {
    const d = editDistance(ka, kb, 2)
    if (d <= 2) return { level: 'fuzzy', detail: `distance ${d}` }
  }
  return null
}

// Facteurs qui expliquent légitimement un écart entre le montant de l'abonnement
// et celui de la transaction QuickBooks.
const TAX_FACTORS = [
  { label: 'exact', f: 1 },
  { label: 'taxes', f: 1.05 },      // TPS seule
  { label: 'taxes', f: 1.13 },      // TVH Ontario
  { label: 'taxes', f: 1.14975 },   // TPS + TVQ
  { label: 'taxes', f: 1.15 },      // TVH Atlantique
]
const FX_MIN = 1.25
const FX_MAX = 1.45
const RATIO_TOL = 0.03

// Comment le montant constaté s'explique-t-il par le montant attendu ?
// → 'exact' | 'taxes' | 'change' | 'change+taxes' | null (inexplicable).
// Le change n'est envisagé que si les devises diffèrent (ou sont inconnues) :
// sinon un simple facteur 1,35 ferait passer n'importe quoi pour un match.
export function amountMatchKind(expected, actual, { expectedCurrency, actualCurrency } = {}) {
  const e = Number(expected)
  const a = Number(actual)
  if (!(e > 0) || !(a > 0)) return null
  const ratio = a / e
  for (const { label, f } of TAX_FACTORS) {
    if (Math.abs(ratio / f - 1) <= RATIO_TOL) return label
    if (Math.abs(ratio * f - 1) <= RATIO_TOL) return label
  }
  const sameCurrency = expectedCurrency && actualCurrency &&
    String(expectedCurrency).toUpperCase() === String(actualCurrency).toUpperCase()
  if (sameCurrency) return null
  for (const { label, f } of TAX_FACTORS) {
    const inFxBand = r => r >= FX_MIN * f * (1 - RATIO_TOL) && r <= FX_MAX * f * (1 + RATIO_TOL)
    if (inFxBand(ratio) || inFxBand(1 / ratio)) return label === 'exact' ? 'change' : 'change+taxes'
  }
  return null
}

const OFF_WINDOW_DAYS = 120 // abonnements annuels seulement

// Force du signal « montant » et du signal « date » dans le choix de la meilleure
// pièce : entre deux dépenses Amazon plausibles, celle du jour attendu gagne.
const amountScore = kind => ({ exact: 3, taxes: 2.5, change: 1.5, 'change+taxes': 1 }[kind] || 0)
const proximityScore = days => 1.5 * Math.max(0, 1 - days / 30)

const daysBetween = (a, b) => Math.round(Math.abs(new Date(a + 'T12:00:00') - new Date(b + 'T12:00:00')) / 86400000)

function evidenceFrom(charge, { nameMatch, amountMatch, inWindow, expected }) {
  return {
    vendor: charge.vendor,
    date: charge.date,
    amount: charge.amount ?? null,
    currency: charge.currency || null,
    kind: charge.kind,
    id: charge.id,
    name_match: nameMatch,          // 'token' | 'fuzzy' | 'same'
    amount_match: amountMatch,      // 'exact' | 'taxes' | 'change' | 'change+taxes' | null
    in_window: inWindow,
    days_off: daysBetween(charge.date, expected),
    // Deux constats radicalement différents, à ne jamais confondre :
    //   'other_name' — MÊME date, AUTRE nom de fournisseur dans QuickBooks.
    //                  Se corrige en retenant le nom (alias).
    //   'off_window' — MÊME fournisseur, mais facturé à une autre date que celle
    //                  de la cédule. Se corrige en corrigeant la cédule ; poser
    //                  un alias n'y changerait rien.
    reason: nameMatch === 'same' ? 'off_window' : 'other_name',
  }
}

// Meilleure pièce probable pour une charge attendue restée sans correspondance
// stricte. `others` = dépenses comptabilisées d'AUTRES fournisseurs (nom strict
// différent) ; `mine` = celles du même fournisseur, hors fenêtre.
function deepMatch(sub, expected, { others, mineBooked, fromIso, toIso }) {
  const candidates = []
  for (const c of others) {
    if (c.date < fromIso || c.date > toIso) continue
    const nm = looseNameMatch(sub.vendor, c.vendor)
    if (!nm) continue
    const am = amountMatchKind(sub.amount, c.amount, {
      expectedCurrency: sub.currency, actualCurrency: c.currency,
    })
    const days = daysBetween(c.date, expected)
    // Nom seulement voisin : il faut un second signal. Soit le montant s'explique,
    // soit la dépense tombe pile à la date attendue (± 2 jours) — deux fournisseurs
    // sans lien qui partagent un mot ET le jour de facturation, c'est improbable.
    if (!am && days > 2) continue
    candidates.push({
      score: amountScore(am) + (nm.level === 'token' ? 1 : 0.5) + proximityScore(days),
      evidence: evidenceFrom(c, { nameMatch: nm.level, amountMatch: am, inWindow: true, expected }),
    })
  }
  // Abonnement annuel : une dépense du MÊME fournisseur à côté de la fenêtre
  // signale une cédule mal réglée, pas une dépense manquante. Interdit au
  // mensuel — la charge voisine y serait celle d'un autre mois.
  if (sub.frequency === 'Annuel') {
    for (const c of mineBooked) {
      if (c.date >= fromIso && c.date <= toIso) continue
      const days = daysBetween(c.date, expected)
      if (days > OFF_WINDOW_DAYS) continue
      const am = amountMatchKind(sub.amount, c.amount, {
        expectedCurrency: sub.currency, actualCurrency: c.currency,
      })
      candidates.push({
        score: amountScore(am) + 1 + Math.max(0, 1 - days / OFF_WINDOW_DAYS),
        evidence: evidenceFrom(c, { nameMatch: 'same', amountMatch: am, inWindow: false, expected }),
      })
    }
  }
  if (!candidates.length) return null
  candidates.sort((a, b) => b.score - a.score)
  return candidates[0].evidence
}

// ── Croisement charges attendues ↔ dépenses constatées ───────────────────────

// `charges` = [{ vendor, date, booked, kind: 'receipt'|'achat', id }].
// Une charge attendue est signalée si sa date est passée d'au moins `graceDays`
// et qu'aucune dépense COMPTABILISÉE du fournisseur n'existe dans
// [attendue − windowBefore, attendue + windowAfter].
export function crossCheckCharges(subs, charges, {
  today = new Date(), graceDays = 5, windowBefore = 10, windowAfter = 30, lookbackMonths = 2,
  profileIndex = new Map(),
} = {}) {
  const prepared = []
  for (const c of charges) {
    if (!c.vendor || !c.date) continue
    prepared.push({ ...c, date: String(c.date).slice(0, 10), keys: keysFor(c.vendor) })
  }
  const cutoff = new Date(today)
  cutoff.setDate(cutoff.getDate() - graceDays)

  const out = []
  for (const sub of subs) {
    const subKeys = keysFor(sub.vendor)
    const subProfileIds = profileIdsFor(subKeys, profileIndex)
    const mine = prepared.filter(c => vendorsMatch(subKeys, subProfileIds, c.keys, profileIndex))
    const mineBooked = mine.filter(c => c.booked)
    // Dépenses comptabilisées des AUTRES fournisseurs : matière première du
    // rapprochement approfondi (le même fournisseur sous un autre nom QuickBooks).
    const mineSet = new Set(mine)
    const others = prepared.filter(c => c.booked && !mineSet.has(c))
    const lastReceipt = mine.filter(c => c.kind === 'receipt').map(c => c.date).sort().pop() || null
    const lastBooked = mineBooked.map(c => c.date).sort().pop() || null

    for (const expected of computeExpectedCharges(sub, { today, lookbackMonths })) {
      if (new Date(expected + 'T12:00:00') > cutoff) continue
      const from = new Date(expected + 'T12:00:00'); from.setDate(from.getDate() - windowBefore)
      const to = new Date(expected + 'T12:00:00'); to.setDate(to.getDate() + windowAfter)
      const fromIso = isoDate(from)
      const toIso = isoDate(to)
      const inWindow = mine.filter(c => c.date >= fromIso && c.date <= toIso)
      if (inWindow.some(c => c.booked)) continue // déjà comptabilisé → rien à signaler
      const pending = inWindow[0] || null
      // Rien de strict : deuxième passe, plus fouillée, avant de crier au manque.
      const evidence = pending ? null : deepMatch(sub, expected, { others, mineBooked, fromIso, toIso })
      out.push({
        subscription_id: sub.id,
        vendor: sub.vendor,
        expected_date: expected,
        amount: sub.amount,
        amount_label: sub.amount_label,
        currency: sub.currency,
        frequency: sub.frequency,
        payment_method: sub.payment_method,
        cancel_url: sub.cancel_url || null,
        // 'to_book'       : la dépense existe dans l'ERP mais n'est pas dans QB.
        // 'likely_booked' : dépense QB très probablement la même, sous un autre
        //                   nom de fournisseur ou hors fenêtre — à confirmer.
        // 'missing'       : aucune trace, même après le rapprochement approfondi.
        status: pending ? 'to_book' : (evidence ? 'likely_booked' : 'missing'),
        pending_kind: pending?.kind || null,
        pending_id: pending?.id || null,
        // Pièce trouvée par le rapprochement approfondi (null si `missing`).
        evidence,
        last_receipt_date: lastReceipt,
        last_booked_date: lastBooked,
        // false = aucun profil fournisseur ne correspond : le croisement ne
        // repose que sur la ressemblance des noms, donc moins fiable.
        profile_matched: subProfileIds.size > 0,
      })
    }
  }
  out.sort((a, b) => (a.expected_date < b.expected_date ? 1 : -1))
  return out
}

// Compat : croisement contre les seuls reçus ([{company, receipt_date}]).
export function crossCheckReceipts(subs, receipts, options = {}) {
  const charges = receipts.map((r, i) => ({
    vendor: r.company, date: r.receipt_date, booked: true, kind: 'receipt', id: r.id || `r${i}`,
  }))
  return crossCheckCharges(subs, charges, options)
}

export function findMissingReceipts(options = {}) {
  const subs = db.prepare(`
    SELECT * FROM vendor_subscriptions
    WHERE deleted_at IS NULL AND active = 1
  `).all()
  // Reçus des 14 derniers mois (couvre le lookback annuel + fenêtres).
  // Le montant sert de corroboration au rapprochement approfondi.
  const receipts = db.prepare(`
    SELECT id, company, receipt_date, quickbooks_id, total, currency FROM sale_receipts
    WHERE deleted_at IS NULL AND company IS NOT NULL AND receipt_date IS NOT NULL
      AND receipt_date >= strftime('%Y-%m-%d', 'now', '-14 months')
  `).all()
  // Miroir QuickBooks (Bills + Purchases importés par services/quickbooks.js).
  const achats = db.prepare(`
    SELECT id, vendor, date_achat, quickbooks_id, total_cad, currency FROM achats_fournisseurs
    WHERE vendor IS NOT NULL AND date_achat >= strftime('%Y-%m-%d', 'now', '-14 months')
  `).all()
  const profiles = db.prepare(`
    SELECT id, name, aliases FROM vendor_profiles WHERE deleted_at IS NULL
  `).all()

  const charges = [
    ...receipts.map(r => ({
      vendor: r.company, date: r.receipt_date, booked: !!r.quickbooks_id, kind: 'receipt', id: r.id,
      amount: r.total, currency: r.currency,
    })),
    ...achats.map(a => ({
      vendor: a.vendor, date: a.date_achat, booked: !!a.quickbooks_id, kind: 'achat', id: a.id,
      amount: a.total_cad, currency: a.currency,
    })),
  ]
  return crossCheckCharges(subs, charges, { profileIndex: buildProfileIndex(profiles), ...options })
}

// ── Apprentissage : « c'est le même fournisseur » ────────────────────────────
//
// Confirmer une piste `likely_booked` enregistre le nom QuickBooks comme alias du
// profil fournisseur. Dès lors le rapprochement STRICT reconnaît le nom (via
// buildProfileIndex) : la charge disparaît de la liste, et les analyses futures
// n'ont plus besoin de la deuxième passe pour ce fournisseur.
export function linkSubscriptionVendorAlias(sub, qbVendorName) {
  const alias = String(qbVendorName || '').trim()
  if (!alias) throw new Error('vendor requis')
  const profiles = db.prepare('SELECT id, name, aliases FROM vendor_profiles WHERE deleted_at IS NULL').all()
  const index = buildProfileIndex(profiles)
  const byId = new Map(profiles.map(p => [p.id, p]))

  // 1. Profil du fournisseur de l'abonnement → on lui ajoute le nom QuickBooks.
  let profile = byId.get(firstProfileId(keysFor(sub.vendor), index)) || null
  let added = alias
  // 2. Sinon, profil portant le nom QuickBooks → on lui ajoute le nom de l'abonnement.
  if (!profile) {
    profile = byId.get(firstProfileId(keysFor(alias), index)) || null
    if (profile) added = sub.vendor
  }
  // 3. Sinon, création du profil au nom de l'abonnement, avec le nom QB en alias.
  if (!profile) {
    const name = String(sub.vendor).trim()
    const existing = db.prepare('SELECT id, name, aliases, deleted_at FROM vendor_profiles WHERE LOWER(TRIM(name)) = LOWER(?)').get(name)
    if (existing) {
      // Le UNIQUE sur `name` couvre aussi les profils supprimés : on réactive.
      db.prepare('UPDATE vendor_profiles SET deleted_at = NULL WHERE id = ?').run(existing.id)
      profile = existing
    } else {
      const id = randomUUID()
      db.prepare('INSERT INTO vendor_profiles (id, name, aliases) VALUES (?,?,?)').run(id, name, '[]')
      profile = { id, name, aliases: '[]' }
    }
  }

  const aliases = parseAliases(profile.aliases)
  const known = new Set(aliases.map(a => normalizeVendorKey(a)).concat(normalizeVendorKey(profile.name)))
  if (!known.has(normalizeVendorKey(added))) aliases.push(added)
  db.prepare(`UPDATE vendor_profiles SET aliases = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
    .run(JSON.stringify(aliases), profile.id)
  return { ok: true, profile_id: profile.id, profile_name: profile.name, aliases }
}
