/**
 * Le dossier de préparation d'une écriture, à partir d'une ligne de relevé.
 *
 * Jusqu'ici l'ERP proposait quatre valeurs (fournisseur, compte, taxe, mémo) et
 * l'humain complétait le reste. Ce qui manquait n'était pourtant pas des
 * devinettes supplémentaires : c'était de l'information qu'on possédait déjà et
 * qu'on jetait — la catégorie de la banque, le numéro de chèque, le montant
 * d'origine en devise, les taxes RÉELLEMENT facturées sur le document apparié,
 * les conditions de paiement du profil, le type d'écriture habituel.
 *
 * Règle du dossier : **chaque champ porte sa source**, en français, telle
 * qu'elle s'affiche (« profil (motif) », « habitude : 7 fois sur 8 »,
 * « facture 88214012 », « relevé »). Un champ sans source reste VIDE — on ne
 * devine jamais en silence. C'est ce dossier que le rail affiche, que la
 * proposition `vendor_expense` portera, et que le bouton publie.
 *
 * Lecture seule : rien n'est écrit, rien n'est publié.
 */
import db from '../db/database.js'
import { mainQbAccount } from '../utils/qbBankAccount.js'
import { resolveProfileByName, profileDefaultsForCurrency } from './vendorProfiles.js'
import { resolveVendorFromBankLabel } from './scrapers/vendorFromBankLabel.js'
import { txnFacts } from './bankTxnFacts.js'
import { ruleForTxn } from './bankRules/store.js'
import { learnedFromLabel } from './bankLabelMemory.js'
import { qbHabitFor } from './bankQbHabit.js'

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100

// Le sentinel « pas de taxe » des profils : une décision explicite, à
// distinguer d'un profil qui n'a simplement rien appris.
export const NO_TAX = '__none__'

const txnLabel = (t) => (t?.details || '').trim() || (t?.description || '').trim() || ''


// ── L'habitude : comment on a comptabilisé ce fournisseur jusqu'ici ─────────

// On ne regarde QUE les achats réellement publiés dans QuickBooks : un
// brouillon n'est pas une habitude. Renvoie les valeurs par fréquence
// décroissante, et dit si l'usage est constant — c'est cette contradiction que
// l'utilisateur doit trancher.
const MONTH_RE = /(?:^|\s)(janvier|janv|f[ée]vrier|f[ée]vr?|mars|avril|avr|mai|juin|juillet|juil|ao[ûu]t|septembre|sept|octobre|oct|novembre|nov|d[ée]cembre|d[ée]c)\.?(?=\s|$|,)/i
const MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']

// « Loyer octobre 2026 » pour une ligne du 2026-10-05.
export function monthlyMemo(prefix, day) {
  if (prefix == null || !/^\d{4}-\d{2}/.test(day || '')) return null
  const text = `${MONTHS_FR[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`
  return prefix ? `${prefix[0].toUpperCase()}${prefix.slice(1)} ${text}` : `${text[0].toUpperCase()}${text.slice(1)}`
}

let publishedVendors = null
export function vendorHistory(vendorName, { limit = 24, amount = null } = {}) {
  let name = String(vendorName || '').trim()
  if (!name) return null
  // QuickBooks écrit souvent le nom sans accents (« Societe Immobiliere
  // Quebourg ») là où la fiche les porte : on retrouve la graphie publiée.
  const fold = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()
  const exact = db.prepare('SELECT 1 FROM achats_fournisseurs WHERE LOWER(TRIM(vendor)) = LOWER(TRIM(?)) AND quickbooks_id IS NOT NULL LIMIT 1').get(name)
  if (!exact) {
    const key = fold(name)
    if (!publishedVendors || Date.now() - publishedVendors.at > 60_000) {
      publishedVendors = { at: Date.now(), list: db.prepare('SELECT DISTINCT vendor FROM achats_fournisseurs WHERE quickbooks_id IS NOT NULL AND vendor IS NOT NULL').all().map((r) => r.vendor) }
    }
    const alt = publishedVendors.list.find((v) => fold(v) === key)
    if (alt) name = alt
  }
  const rows = db.prepare(`
    SELECT expense_account_id, tax_code_id, qb_memo, description, payment_method, lines, date_achat, type, total_cad
    FROM achats_fournisseurs
    WHERE LOWER(TRIM(vendor)) = LOWER(TRIM(?)) AND quickbooks_id IS NOT NULL
    ORDER BY date_achat DESC, created_at DESC
    LIMIT ?
  `).all(name, limit)
  if (!rows.length) return null

  // Un achat ancien porte son compte de dépense dans `lines[0].account_id`
  // plutôt que dans la colonne — même repli que prepaid.js.
  const accountOfRow = (r) => {
    if (r.expense_account_id) return r.expense_account_id
    try {
      const first = JSON.parse(r.lines || '[]')[0]
      return first?.account_id || null
    } catch { return null }
  }

  const tally = (values) => {
    const counts = new Map()
    for (const v of values) {
      if (v == null || v === '') continue
      counts.set(v, (counts.get(v) || 0) + 1)
    }
    return [...counts.entries()]
      .map(([value, n]) => ({ value, n }))
      .sort((a, b) => b.n - a.n)
  }

  const expenseAccounts = tally(rows.map(accountOfRow))
  const taxCodes = tally(rows.map((r) => r.tax_code_id || NO_TAX))
  // Un mémo n'est une HABITUDE que s'il s'est répété. Les libellés uniques
  // (titre de produit Amazon, numéro de facture) n'en sont pas : les proposer
  // remplirait le champ d'un texte sans rapport avec la nouvelle dépense.
  const memos = tally(rows.map((r) => (r.qb_memo || r.description || '').trim()))
    .filter((m) => m.n >= 2 && m.value.length <= 80 && !looksLikeBankLabel(m.value))
  // Un mémo qui nomme le MOIS (« Loyer mai », « Août 2026 ») : l'habitude est
  // le patron, pas le texte. On garde le mot qui précède le mois, s'il revient.
  const recent = rows.slice(0, 8).map((r) => (r.qb_memo || r.description || '').trim())
  const monthHits = recent.map((m) => MONTH_RE.exec(m)).filter(Boolean)
  let monthlyPrefix = null
  if (monthHits.length >= 3) {
    const pre = tally(monthHits.map((h) => h.input.slice(0, h.index).trim().toLowerCase()))
    monthlyPrefix = pre[0]?.value && pre[0].n >= 2 ? pre[0].value : ''
  }
  const paymentMethods = tally(rows.map((r) => r.payment_method))
  const types = tally(rows.map((r) => r.type))

  // Le contexte départage un fournisseur à plusieurs comptes (Bell : téléphone
  // OU internet) : les achats passés au MÊME montant (±10 %) disent lequel,
  // s'ils sont unanimes.
  let byAmount = null
  const amt = Math.abs(Number(amount) || 0)
  if (amt > 0 && expenseAccounts.length > 1) {
    const near = rows.filter((r) => Math.abs(Math.abs(Number(r.total_cad) || 0) - amt) <= amt * 0.1)
    const t = tally(near.map(accountOfRow))
    if (t.length === 1) byAmount = { value: t[0].value, n: t[0].n }
  }

  return {
    count: rows.length,
    last_date: rows[0].date_achat,
    by_amount: byAmount,
    expense_accounts: expenseAccounts,
    tax_codes: taxCodes,
    memos: memos.slice(0, 3),
    monthly_prefix: monthlyPrefix,
    payment_methods: paymentMethods,
    types,
    // « Constant » = un seul compte de dépense ET un seul code de taxe sur tout
    // l'historique retenu. Sinon l'UI affiche le partage des voix.
    consistent: expenseAccounts.length <= 1 && taxCodes.length <= 1,
  }
}

// Repli quand aucun profil ne reconnaît le libellé : chercher un fournisseur
// déjà utilisé dont le nom apparaît tel quel dans le libellé du relevé.
export function vendorFromPastPurchases(label) {
  const l = String(label || '').toLowerCase()
  if (l.length < 3) return null
  const rows = db.prepare(`
    SELECT DISTINCT vendor FROM achats_fournisseurs
    WHERE vendor IS NOT NULL AND TRIM(vendor) <> '' AND quickbooks_id IS NOT NULL
      AND date_achat >= date('now', '-18 months')
  `).all()
  let best = null
  for (const { vendor } of rows) {
    const v = String(vendor).toLowerCase().trim()
    if (v.length < 4) continue
    if (l.includes(v) && (!best || v.length > best.length)) best = String(vendor).trim()
  }
  return best
}

// Un libellé de relevé recopié tel quel dans un achat passé n'est pas un mémo :
// le mémo publié doit dire la NATURE de la dépense, pas la ville, le pays, le
// numéro d'autorisation ni le montant d'origine. On les reconnaît à leurs
// marques — colonnes alignées à coups d'espaces, mention de devise d'origine.
function looksLikeBankLabel(value) {
  const v = String(value || '')
  if (/(montant initial en devise|original amount for currency)/i.test(v)) return true
  if (/\s{3,}/.test(v)) return true
  return false
}

// Comment le dossier cite une habitude : « habitude : 7 fois sur 8 » dit à la
// fois d'où vient la valeur ET à quel point elle est sûre.
function habitSource(entry, total) {
  if (!entry) return null
  return entry.n >= total ? `habitude (${total} fois sur ${total})` : `habitude : ${entry.n} fois sur ${total}`
}

// ── Le document apparié, quand il en existe un ─────────────────────────────

// Les taxes RÉELLEMENT facturées valent mieux qu'un taux nominal appliqué au
// montant du relevé : un document peut être partiellement détaxé, porter une
// taxe d'un autre régime, ou arrondir autrement que le calcul théorique.
function documentFor(txn) {
  if (!txn?.matched_id) return null
  if (txn.matched_type === 'receipt') {
    const r = db.prepare('SELECT * FROM sale_receipts WHERE id=?').get(txn.matched_id)
    if (!r) return null
    let extra = {}
    try { extra = JSON.parse(r.raw_data || '{}') || {} } catch {}
    const tax = round2((r.tps || 0) + (r.tvq || 0) + (r.other_taxes || 0))
    return {
      kind: 'receipt',
      id: r.id,
      label: r.receipt_number ? `facture ${r.receipt_number}` : 'facture appariée',
      number: r.receipt_number || null,
      vendor: (r.company || '').trim() || null,
      currency: r.currency || null,
      total: r.total ?? null,
      tax: tax > 0 ? tax : null,
      tax_breakdown: tax > 0 ? { tps: r.tps || 0, tvq: r.tvq || 0, autres: r.other_taxes || 0 } : null,
      memo: (extra.general_description || '').trim() || null,
      service_period: extra.service_period || null,
      terms_days: extra.payment_terms_days ?? null,
      due_date: extra.due_date || null,
      payment_method: r.payment_method || null,
    }
  }
  if (txn.matched_type === 'achat') {
    const a = db.prepare('SELECT * FROM achats_fournisseurs WHERE id=?').get(txn.matched_id)
    if (!a) return null
    const number = a.vendor_invoice_number || a.bill_number || null
    return {
      kind: 'achat',
      id: a.id,
      label: number ? `achat ${number}` : 'achat apparié',
      number,
      vendor: (a.vendor || '').trim() || null,
      currency: a.currency || null,
      total: a.total_cad ?? null,
      tax: a.tax_cad > 0 ? round2(a.tax_cad) : null,
      tax_breakdown: null,
      memo: (a.qb_memo || a.description || '').trim() || null,
      service_period: null,
      terms_days: null,
      due_date: a.due_date || null,
      payment_method: a.payment_method || null,
      expense_account_id: a.expense_account_id || null,
      tax_code_id: a.tax_code_id || null,
    }
  }
  return null
}

const addDays = (iso, days) => {
  if (!iso || !Number.isFinite(Number(days))) return null
  const d = new Date(`${iso}T00:00:00Z`)
  if (Number.isNaN(d.getTime())) return null
  d.setUTCDate(d.getUTCDate() + Number(days))
  return d.toISOString().slice(0, 10)
}

/**
 * Le dossier complet d'une ligne : date, fournisseur, montant, taxes, comptes,
 * mémo, pièce, devise — chacun avec sa source.
 *
 * @param txn      ligne de `bank_transactions`
 * @param account  son compte (`bank_accounts`)
 * @param options  { rule } — la règle bancaire qui s'applique (tranche 7) ;
 *                 elle prime sur le profil, jamais sur un document apparié.
 */
export function buildEntryDraft(txn, account, { rule = undefined, vendor: chosenVendor = null, learn = {} } = {}) {
  // Une règle non fournie se cherche : c'est le point d'accroche des règles
  // bancaires. `null` explicite = ne pas en chercher (aperçu, tests).
  if (rule === undefined) {
    try { rule = ruleForTxn(txn) } catch { rule = null }
  }
  // Un autre bénéficiaire que celui de la règle : la règle ne parle plus de cette ligne.
  const norm = (v) => String(v || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim()
  if (chosenVendor && rule?.vendor_name && norm(rule.vendor_name) !== norm(chosenVendor)) rule = null
  const label = txnLabel(txn)
  const currency = account?.currency || 'CAD'
  const facts = txnFacts(txn)
  const doc = documentFor(txn)

  // — Fournisseur : la règle, puis le motif déclaré au profil, puis le document,
  //   puis un achat passé dont le nom apparaît tel quel dans le libellé.
  const hit = resolveVendorFromBankLabel(label)
  let vendor = null; let vendorSource = null
  // Le bénéficiaire choisi à l'écran passe devant tout : c'est SON habitude
  // qu'on veut relire (catégorie, taxe, mémo).
  if (chosenVendor) { vendor = String(chosenVendor).trim(); vendorSource = 'bénéficiaire choisi' }
  if (!vendor && rule?.vendor_name) { vendor = rule.vendor_name; vendorSource = `règle « ${rule.name} »` }
  // Ce qu'on a déjà fait pour ce même libellé : la preuve la plus directe,
  // devant le motif d'une fiche — elle porte aussi la graphie QuickBooks
  // (« GitHub USD » sur un compte en dollars américains).
  let learned = null
  try { learned = learn === false ? null : learnedFromLabel(txn, account, learn) } catch { learned = null }
  // Rien côté ERP : ce que QuickBooks a fait des lignes passées au même libellé
  // (dépenses saisies directement dans QuickBooks, sans achat dans l'ERP).
  if (!learned?.vendor && learn !== false && txn?.amount < 0) {
    try {
      const h = qbHabitFor(txn, { before: learn?.before || null })
      if (h?.strong && h.kind === 'expense' && h.vendor) {
        learned = { vendor: h.vendor, expense_account_id: h.account_id, tax_code_id: h.tax_code_id, memo: null, qb_type: null,
          source: h.source, sources: { expense_account_id: h.source, tax_code_id: h.source } }
      }
    } catch { /* mémoire QuickBooks indisponible */ }
  }
  if (!vendor && learned?.vendor) { vendor = learned.vendor; vendorSource = learned.source }
  // La mémoire ne parle que de SON fournisseur : un autre bénéficiaire choisi la fait taire.
  if (learned?.vendor && norm(learned.vendor) !== norm(vendor)) learned = null
  const fromMemory = !!learned?.vendor && vendorSource === learned.source
  if (!vendor && hit?.profile?.name) { vendor = hit.profile.name; vendorSource = `profil (${hit.via})` }
  if (!vendor && doc?.vendor) { vendor = doc.vendor; vendorSource = doc.label }
  if (!vendor) {
    const past = vendorFromPastPurchases(label)
    if (past) { vendor = past; vendorSource = 'achat passé du même fournisseur' }
  }

  // La fiche se cherche sur un nom APPROCHANT : le libellé de la banque et les achats
  // passés portent rarement le nom canonique, et sans la fiche on perdait ses défauts
  // (compte, taxe, type, échéance). Le nom retenu devient celui de la fiche — c'est lui
  // que le champ « Fournisseur » doit afficher, sélectionné, pas la graphie du relevé.
  const profile = vendor ? resolveProfileByName(vendor) : null
  // La graphie d'origine reste utile : les achats passés sont classés sous elle,
  // pas sous le nom de la fiche.
  const rawVendor = vendor
  if (profile && !chosenVendor && !rule?.vendor_name && !fromMemory && !doc?.vendor && profile.name !== vendor) {
    vendorSource = `${vendorSource} → fiche « ${profile.name} »`
    vendor = profile.name
  }
  const defaults = profileDefaultsForCurrency(profile, currency) || {}
  const hOpts = { amount: txn?.amount }
  const history = (vendor ? vendorHistory(vendor, hOpts) : null)
    || (rawVendor && rawVendor !== vendor ? vendorHistory(rawVendor, hOpts) : null)
  const n = history?.count || 0

  const field = (value, source) => (value == null || value === '' || !source ? { value: null, source: null } : { value, source })

  // — Compte de dépense : document, règle, profil, habitude. La catégorie de la
  //   banque ne remplit rien (aucune correspondance n'existe au plan comptable),
  //   mais elle est affichée comme indice quand tout le reste est muet.
  const expense = doc?.expense_account_id ? field(doc.expense_account_id, doc.label)
    : rule?.expense_account_id ? field(rule.expense_account_id, `règle « ${rule.name} »`)
      : learned?.expense_account_id ? field(learned.expense_account_id, learned.sources.expense_account_id)
      : defaults.expense_account_id ? field(defaults.expense_account_id, 'profil du fournisseur')
        : history?.by_amount ? field(history.by_amount.value, `habitude au même montant (${history.by_amount.n} fois)`)
          : field(history?.expense_accounts?.[0]?.value, habitSource(history?.expense_accounts?.[0], n))

  // — Code de taxe : `__none__` est une décision, pas un vide, et remonte tel quel.
  const taxCode = doc?.tax_code_id ? field(doc.tax_code_id, doc.label)
    : rule?.tax_code_id ? field(rule.tax_code_id, `règle « ${rule.name} »`)
      : learned?.tax_code_id ? field(learned.tax_code_id, learned.sources.tax_code_id)
      : defaults.tax_code_id ? field(defaults.tax_code_id, 'profil du fournisseur')
        : field(history?.tax_codes?.[0]?.value, habitSource(history?.tax_codes?.[0], n))

  // — Taxe : le montant FACTURÉ quand un document existe. Sinon rien : le taux
  //   nominal se calcule à l'écran, sous les yeux de l'humain, pas ici.
  const tax = doc?.tax != null ? field(doc.tax, doc.label) : field(null, null)

  // — Mode de paiement : l'habitude fait foi. Un numéro de chèque ne transforme
  //   PAS l'écriture en chèque — une sortie bancaire se comptabilise en dépense
  //   (décision de Charles), le numéro sert de pièce.
  const payMethod = history?.payment_methods?.[0]?.value
    ? field(history.payment_methods[0].value, habitSource(history.payment_methods[0], n))
    : field(account?.kind === 'card' ? 'Carte de crédit' : 'Comptant', 'compte du relevé')

  // — Type d'écriture QuickBooks : dépense au comptant, ou facture fournisseur
  //   quand c'est ainsi qu'on traite ce fournisseur.
  const qbType = rule?.qb_type ? field(rule.qb_type, `règle « ${rule.name} »`)
    : defaults.qb_type ? field(defaults.qb_type, 'profil du fournisseur')
      : learned?.qb_type ? field(learned.qb_type, learned.sources.qb_type)
      : field(history?.types?.[0]?.value, habitSource(history?.types?.[0], n))

  // — Numéro de pièce : celui du DOCUMENT, ou du chèque. Jamais `txn.reference`,
  //   qui est un numéro de transaction bancaire et n'a rien à faire là.
  const docNumber = doc?.number ? field(doc.number, doc.label)
    : facts.check ? field(facts.check, `chèque n° ${facts.check} au relevé`)
      : field(null, null)

  // — Mémo : court, la nature de la dépense. Le libellé brut du relevé n'en est
  //   pas un (il porte la ville, le pays, le numéro d'autorisation).
  const memo = doc?.memo ? field(doc.memo, doc.label)
    : rule?.memo ? field(rule.memo, `règle « ${rule.name} »`)
      : history?.monthly_prefix != null ? field(monthlyMemo(history.monthly_prefix, txn?.txn_date), 'habitude : le mois payé')
        : learned?.memo ? field(learned.memo, learned.sources.memo)
        : field(history?.memos?.[0]?.value, habitSource(history?.memos?.[0], n))

  const termsDays = doc?.terms_days != null ? field(doc.terms_days, doc.label)
    : field(defaults.payment_terms_days, 'profil du fournisseur')

  const fields = {
    date: field(txn?.txn_date, 'relevé'),
    vendor: field(vendor, vendorSource),
    total: field(round2(Math.abs(txn?.amount || 0)) || null, 'relevé'),
    tax,
    expense_account_id: expense,
    tax_code_id: taxCode,
    payment_account_id: defaults.payment_account_id
      ? field(defaults.payment_account_id, 'profil du fournisseur')
      : field(mainQbAccount(account), 'compte du relevé'),
    payment_method: payMethod,
    qb_type: qbType,
    doc_number: docNumber,
    memo,
    terms_days: termsDays,
    due_date: doc?.due_date
      ? field(doc.due_date, doc.label)
      : field(addDays(txn?.txn_date, termsDays.value), termsDays.source && `échéance : ${termsDays.value} j après la date du relevé`),
  }

  // Ce que le relevé dit et qui ne remplit aucun champ, mais aide à trancher.
  const hints = []
  if (txn?.bank_category) hints.push({ label: 'Catégorie de la banque', value: txn.bank_category })
  if (txn?.txn_type) hints.push({ label: 'Type au relevé', value: txn.txn_type })
  if (facts.check) hints.push({ label: 'Chèque n°', value: facts.check })
  if (doc?.service_period) hints.push({ label: 'Période de service', value: doc.service_period })
  // Un « montant initial en devise CAD » sur un compte en dollars canadiens ne
  // dit rien (taux 1) : c'est du bruit, pas un indice.
  if (facts.foreign && facts.foreign.currency !== currency) {
    const cad = round2(Math.abs(txn?.amount || 0))
    const rate = facts.foreign.amount ? round2(cad / Math.abs(facts.foreign.amount)) : null
    hints.push({
      label: 'Montant d\'origine',
      value: `${Math.abs(facts.foreign.amount).toFixed(2)} ${facts.foreign.currency}${rate ? ` · taux ${rate}` : ''}`,
    })
  }

  // Les deux champs sans lesquels rien ne peut être publié.
  const missing = ['vendor', 'expense_account_id'].filter((k) => !fields[k].value)

  return {
    txn_id: txn?.id || null,
    label,
    currency,
    document: doc ? { kind: doc.kind, id: doc.id, label: doc.label, total: doc.total, currency: doc.currency, tax_breakdown: doc.tax_breakdown } : null,
    foreign: facts.foreign,
    fields,
    hints,
    history,
    vendor_profile_id: profile?.id || null,
    // La catégorie comptable écrite en toutes lettres sur la fiche (« 14000 Pièces ») :
    // quand la fiche ne pointe pas encore de compte QuickBooks, le formulaire s'en sert
    // pour choisir le compte qui porte ce numéro.
    vendor_category: profile?.qb_category || null,
    rule: rule ? { id: rule.id, name: rule.name, action: rule.action || null, splits: rule.splits || null } : null,
    missing,
    ready: missing.length === 0,
  }
}
