// Apprentissage de la projection de trésorerie à partir du relevé BNC CAD réel.
//
// POURQUOI. La projection reposait sur des montants et des jours SAISIS À LA MAIN
// (paie 25 000 $, loyer 6 115,89 $ le 1er, dette BDC 8 874 $…). Le compte, lui,
// raconte autre chose : paie 21 034 → 24 763 $ selon la quinzaine, loyer débité
// le 3-4 à 5 863,69 puis 6 115,89 $, BDC 8 658,52 $. Résultat mesuré sur les
// saisies de solde d'août 2026 : la projection annonçait 29 424 $ là où la banque
// disait 61 862 $ — un écart systématique de +32 k$ qui décrédibilise le point
// bas et le virement suggéré.
//
// Ce module lit donc le relevé (table bank_transactions, alimentée en continu par
// la sync TRX_Orisha) et en tire trois choses :
//   1. le montant et le jour RÉELS de chaque sortie récurrente (médiane des
//      dernières occurrences) → la projection cesse d'être une estimation de
//      gestion ;
//   2. la confirmation qu'une occurrence est DÉJÀ passée au compte → plus besoin
//      de cliquer « déjà sorti » sur le bandeau ambre, la banque le dit ;
//   3. les sorties récurrentes que l'ERP ne connaît pas encore (frais forfait,
//      intérêts de marge, prélèvements mensuels non modélisés) → proposées, pas
//      inventées : rien n'entre dans la projection sans un enregistrement créé.
//
// PRUDENCE. Deux règles ne bougent pas : (a) on n'apprend JAMAIS une rentrée
// (règle « rentrées certaines uniquement » du 28 juillet 2026) — uniquement des
// sorties ; (b) quand le jour appris est PLUS TARD que le jour configuré, on garde
// le jour configuré : projeter une sortie trop tôt est prudent, trop tard non.
import db from '../db/database.js'
import { expandRecurring, TREASURY_BANK_ACCOUNT } from './treasury.js'

// Va-et-vient avec la marge de crédit et transferts internes : ce n'est ni une
// dépense ni une rentrée (le compte est balayé chaque jour), et ça écraserait
// toute détection de périodicité. Même exclusion que computeActuals.
const NOISE_RE = /^(?:deboursé?|debourse|remb)[.,]?\s*mcr$|^trf\s+(?:ct|dt)\s+internet$/i

// Fenêtre d'apprentissage : 6 mois = 6 occurrences pour un mensuel, 13 pour une
// quinzaine. Assez pour une médiane, assez court pour suivre une hausse de loyer.
export const LEARN_MONTHS = 6
// Un prélèvement récurrent ne tombe pas au jour près (jours ouvrables, fériés).
const DAY_WINDOW = 5
// Écart de montant toléré pour reconnaître une occurrence. 35 % couvre la paie
// (21 k → 25 k) sans confondre deux récurrentes distinctes ; l'ambiguïté
// restante est tranchée par la date (voir le score d'appariement).
const AMOUNT_RATIO = 0.35

const isoDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const dayOf = iso => Number(String(iso).slice(8, 10))
const r2c = n => Math.round(n * 100) / 100
const median = arr => {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
const daysBetween = (a, b) => Math.round((Date.parse(`${a}T12:00:00Z`) - Date.parse(`${b}T12:00:00Z`)) / 86400000)

// Sorties réelles du compte projeté sur la fenêtre. `matched_type` non nul =
// mouvement déjà rattaché à un document de l'ERP (facture, reçu, payout) par le
// rapprochement : il est déjà projeté par sa propre source, l'inclure dans la
// détection de récurrences le compterait deux fois.
export function bankOutflows({ fromIso, toIso, includeMatched = true }) {
  const account = db.prepare(
    'SELECT id FROM bank_accounts WHERE name = ? AND deleted_at IS NULL'
  ).get(TREASURY_BANK_ACCOUNT)
  if (!account) return []
  const rows = db.prepare(`
    SELECT id, txn_date, description, amount, matched_type, matched_id
    FROM bank_transactions
    WHERE account_id = ? AND deleted_at IS NULL AND amount < 0
      AND txn_date >= ? AND txn_date <= ?
    ORDER BY txn_date
  `).all(account.id, fromIso, toIso)
  return rows
    .filter(t => !NOISE_RE.test((t.description || '').trim()))
    .filter(t => includeMatched || !t.matched_type)
    .map(t => ({
      id: t.id,
      date: String(t.txn_date).slice(0, 10),
      amount: Math.abs(Number(t.amount)),
      description: (t.description || '').trim(),
      matched: !!t.matched_type,
    }))
}

// Récurrentes actives (les seules qui alimentent la projection).
function activeRecurring() {
  return db.prepare('SELECT * FROM recurring_outflows WHERE deleted_at IS NULL AND active = 1').all()
}

// ── Appariement récurrente ↔ relevé ─────────────────────────────────────────
//
// Attribution GLOBALE et non gloutonne par récurrente : on note chaque couple
// (occurrence attendue, mouvement réel) puis on attribue les meilleurs scores
// d'abord. Sans ça, « Dette Ville de Québec » (4 664 $ le 11) s'appropriait le
// loyer (5 863 $ le 4) simplement parce qu'elle passait la première.
function scorePairs(expected, txns) {
  const pairs = []
  const maxAmount = Math.max(1, ...txns.map(t => t.amount))
  for (const exp of expected) {
    for (const t of txns) {
      const dd = Math.abs(daysBetween(t.date, exp.date))
      if (exp.variable) {
        // Récurrente à montant VARIABLE (paiement pré-programmé du relevé
        // Mastercard : 1 072 $ un mois, 10 689 $ le suivant) : le montant ne peut
        // pas servir de signature. On se fie au jour du prélèvement, resserré, et
        // on retient le plus GROS débit de la fenêtre — le paiement de carte
        // domine les frais qui l'accompagnent le même jour. Pénalité fixe pour
        // qu'une récurrente à montant connu garde la priorité sur le même débit.
        if (dd > 3) continue
        pairs.push({ exp, txn: t, score: 0.3 + dd * 0.02 + (1 - t.amount / maxAmount) * 0.2 })
        continue
      }
      if (dd > DAY_WINDOW) continue
      const ratio = Math.abs(t.amount - exp.amount) / Math.max(1, exp.amount)
      if (ratio > AMOUNT_RATIO) continue
      // Le montant tranche en premier (une récurrente est reconnaissable à son
      // montant), la date sert d'arbitre entre deux montants comparables.
      pairs.push({ exp, txn: t, score: ratio + dd * 0.02 })
    }
  }
  return pairs.sort((a, b) => a.score - b.score)
}

// Occurrences réelles retrouvées pour chaque récurrente, sur la fenêtre.
// Retourne Map(recurring_id → [{date, amount, expected_date, txn_id, description}]).
export function matchRecurringOccurrences({ recurring = activeRecurring(), months = LEARN_MONTHS, today = new Date() } = {}) {
  const toIso = isoDate(today)
  const start = new Date(today); start.setMonth(start.getMonth() - months)
  const fromIso = isoDate(start)
  const txns = bankOutflows({ fromIso, toIso })

  const expected = []
  for (const r of recurring) {
    // On apprend sur le PATRON (jour + montant configuré), même si le montant est
    // marqué variable : c'est justement pour lui qu'un historique est précieux.
    const amount = Number(r.amount) > 0 ? Number(r.amount) : null
    if (!amount) continue
    for (const date of expandRecurring(r, fromIso, toIso)) {
      expected.push({ id: r.id, date, amount, variable: !!r.variable_amount })
    }
  }

  const usedTxn = new Set()
  const usedExp = new Set()
  const out = new Map(recurring.map(r => [r.id, []]))
  for (const p of scorePairs(expected, txns)) {
    const expKey = `${p.exp.id}:${p.exp.date}`
    if (usedTxn.has(p.txn.id) || usedExp.has(expKey)) continue
    usedTxn.add(p.txn.id)
    usedExp.add(expKey)
    out.get(p.exp.id).push({
      date: p.txn.date, amount: r2c(p.txn.amount), expected_date: p.exp.date,
      txn_id: p.txn.id, description: p.txn.description,
    })
  }
  for (const list of out.values()) list.sort((a, b) => a.date.localeCompare(b.date))
  return { occurrences: out, txns, usedTxn, fromIso, toIso }
}

// Montant à projeter pour une récurrente, à partir des montants de ses
// dernières occurrences (ordre chronologique). Médiane — mais jamais MOINS que
// la dernière occurrence : une médiane retarde d'une période sur une hausse
// (loyer indexé de 5 863,69 à 6 115,89 $ en août 2026, la médiane annonçait
// encore l'ancien montant) et sous-estimer une sortie est exactement l'erreur
// qui coûte un découvert. Moins de 2 occurrences : pas de règle, on garde la
// saisie de l'utilisateur.
export function pickLearnedAmount(amounts, { variable = false } = {}) {
  if (!Array.isArray(amounts) || amounts.length < 2) return null
  // Montant VARIABLE par nature (paiement du relevé de carte : 208 $ un mois,
  // 11 801 $ le suivant) : la médiane n'estime rien du tout. La moyenne des
  // dernières occurrences est la meilleure prévision de trésorerie disponible —
  // et il vaut mille fois mieux projeter une moyenne que d'exclure la sortie,
  // comme le faisait l'ancienne règle du « montant périmé ».
  const central = variable
    ? amounts.reduce((s, a) => s + a, 0) / amounts.length
    : median(amounts)
  return r2c(Math.max(central, amounts[amounts.length - 1]))
}

// Apparie des sorties encore projetées à des débits réels (pur — testable sans
// base). Un débit ne confirme qu'une seule sortie, les plus gros d'abord : un
// gros prélèvement mal apparié coûte plus cher qu'un petit.
export function confirmAgainstTxns(events, txns) {
  const used = new Set()
  const confirmed = new Map()
  for (const e of [...events].sort((a, b) => a.amount - b.amount)) {
    const target = Math.abs(e.amount)
    const hit = txns
      .filter(t => !used.has(t.id)
        && t.date >= e.original_date
        && Math.abs(daysBetween(t.date, e.original_date)) <= DAY_WINDOW
        && Math.abs(t.amount - target) / Math.max(1, target) <= AMOUNT_RATIO)
      .sort((a, b) => Math.abs(a.amount - target) - Math.abs(b.amount - target))[0]
    if (!hit) continue
    used.add(hit.id)
    confirmed.set(e.event_key, {
      txn_id: hit.id, date: hit.date, amount: r2c(-hit.amount), description: hit.description,
    })
  }
  return confirmed
}

// Groupes de débits qui ressemblent à une cadence (pur) : montants voisins à
// 3 %, ≥ 3 occurrences dans ≥ 3 mois distincts, espacement médian mensuel
// (25-35 j) ou aux deux semaines (12-16 j).
export function periodicClusters(txns, { minAmount = 5 } = {}) {
  const clusters = []
  for (const t of [...txns].filter(t => t.amount >= minAmount).sort((a, b) => b.amount - a.amount)) {
    const c = clusters.find(c => Math.abs(c.ref - t.amount) <= Math.max(1, c.ref * 0.03))
    if (c) c.items.push(t)
    else clusters.push({ ref: t.amount, items: [t] })
  }
  const out = []
  for (const c of clusters) {
    const items = c.items.sort((a, b) => a.date.localeCompare(b.date))
    if (items.length < 3) continue
    const gaps = items.slice(1).map((it, i) => daysBetween(it.date, items[i].date))
    const gap = median(gaps)
    const frequency = gap >= 25 && gap <= 35 ? 'monthly' : (gap >= 12 && gap <= 16 ? 'biweekly' : null)
    if (!frequency) continue
    // Régularité exigée : la majorité des intervalles doit tenir dans la bande de
    // la cadence, sinon trois montants voisins tombés par hasard passeraient pour
    // une récurrence.
    const band = frequency === 'monthly' ? [25, 35] : [12, 16]
    const regular = gaps.filter(g => g >= band[0] && g <= band[1]).length
    if (regular < Math.ceil(gaps.length * 0.6)) continue
    // Un mensuel doit s'être répété sur 3 mois distincts ; une quinzaine tient
    // 4 occurrences dans 2 mois — exiger 3 mois l'aurait rendue indétectable.
    if (frequency === 'monthly' && new Set(items.map(i => i.date.slice(0, 7))).size < 3) continue
    if (frequency === 'biweekly' && items.length < 4) continue
    const amounts = items.slice(-3).map(i => i.amount)
    const counts = new Map()
    for (const i of items) counts.set(i.description, (counts.get(i.description) || 0) + 1)
    const label = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0] || 'Prélèvement récurrent'
    const amount = r2c(median(amounts))
    out.push({
      key: `${label}|${Math.round(c.ref)}`,
      label,
      amount,
      frequency,
      day_of_month: frequency === 'monthly' ? Math.round(median(items.slice(-3).map(i => dayOf(i.date)))) : null,
      anchor_date: frequency === 'biweekly' ? items[items.length - 1].date : null,
      n: items.length,
      last_seen: items[items.length - 1].date,
      dates: items.map(i => i.date),
      // Poids mensuel : ce que la projection rate aujourd'hui.
      monthly_cost: r2c(frequency === 'monthly' ? amount : amount * 26 / 12),
    })
  }
  return out.sort((a, b) => b.monthly_cost - a.monthly_cost)
}

// ── Ce que la projection doit utiliser ───────────────────────────────────────
//
// Pour chaque récurrente : le montant et le jour à projeter, appris quand
// l'historique est suffisant (≥ 2 occurrences), avec la trace de ce qui a été
// remplacé. Une seule occurrence ne fait pas une règle — on garde la saisie.
export function learnRecurring({ months = LEARN_MONTHS, today = new Date() } = {}) {
  const recurring = activeRecurring()
  const { occurrences } = matchRecurringOccurrences({ recurring, months, today })
  const out = []
  for (const r of recurring) {
    const occ = occurrences.get(r.id) || []
    const configured = Number(r.amount) > 0 ? r2c(Number(r.amount)) : null
    // Les 3 dernières occurrences : assez pour lisser un mois atypique, assez
    // peu pour suivre une indexation (loyer 5 863,69 → 6 115,89 $).
    const last3 = occ.slice(-3)
    const learnedAmount = pickLearnedAmount(last3.map(o => o.amount), { variable: !!r.variable_amount })
    const learnedDay = r.frequency === 'monthly' && last3.length >= 2
      ? Math.round(median(last3.map(o => dayOf(o.date)))) : null
    const configuredDay = r.frequency === 'monthly' ? Number(r.day_of_month) || null : null
    // Jour appris retenu seulement s'il est PLUS TÔT : projeter une sortie avant
    // qu'elle ne tombe est prudent, après ne l'est pas.
    const useDay = learnedDay && configuredDay && learnedDay < configuredDay ? learnedDay : null
    const drift = learnedAmount != null && configured != null ? r2c(learnedAmount - configured) : null
    const startsOn = String(r.starts_on || '').slice(0, 10)
    out.push({
      id: r.id,
      label: r.label,
      not_started: !!(startsOn && startsOn > isoDate(today)),
      frequency: r.frequency,
      variable_amount: !!r.variable_amount,
      configured_amount: configured,
      configured_day: configuredDay,
      learned_amount: learnedAmount,
      learned_day: learnedDay,
      apply_amount: learnedAmount,
      apply_day: useDay,
      drift,
      // Écart relatif : c'est lui qui justifie (ou non) d'afficher quoi que ce
      // soit à l'utilisateur — 1 % près, la saisie est bonne.
      drift_pct: drift != null && configured ? Math.round((drift / configured) * 1000) / 10 : null,
      n: occ.length,
      last_seen: occ.length ? occ[occ.length - 1].date : null,
      occurrences: occ,
    })
  }
  return out
}

// Vue indexée pour computeProjection : { [id]: {amount, day, n, configured_amount} }.
// N'inclut QUE ce qui change réellement la projection (écart > 1 % ou jour
// avancé), pour que « appris » reste un signal et pas un décor.
export function learnedRecurringMap(opts = {}) {
  const map = new Map()
  for (const l of learnRecurring(opts)) {
    const amountChanged = l.apply_amount != null && l.configured_amount != null
      && Math.abs(l.apply_amount - l.configured_amount) > Math.max(1, l.configured_amount * 0.01)
    if (!amountChanged && !l.apply_day) continue
    map.set(l.id, {
      amount: amountChanged ? l.apply_amount : null,
      day: l.apply_day,
      n: l.n,
      last_seen: l.last_seen,
      configured_amount: l.configured_amount,
      configured_day: l.configured_day,
      label: l.label,
    })
  }
  return map
}

// ── Confirmation « déjà sorti » par la banque ───────────────────────────────
//
// Une sortie datée avant aujourd'hui mais toujours projetée (fenêtre « encore
// dû ») est soit vraiment encore due, soit déjà passée au compte. Le relevé
// tranche : si un débit du bon ordre de grandeur existe autour de la date, la
// sortie est passée. C'est l'automatisation du bouton « déjà sorti » — le
// bandeau ambre ne subsiste que pour ce que la banque ne confirme pas.
//
// `events` = [{event_key, label, amount (négatif), original_date}].
export function bankConfirmedOutflows(events, { today = new Date() } = {}) {
  const list = events.filter(e => e.amount < 0 && e.original_date)
  if (!list.length) return new Map()
  const from = list.map(e => e.original_date).sort()[0]
  return confirmAgainstTxns(list, bankOutflows({ fromIso: from, toIso: isoDate(today) }))
}

// ── Sorties récurrentes que l'ERP ne connaît pas ────────────────────────────
//
// Regroupe les débits restants par montant voisin (± 3 %) et ne retient que ce
// qui ressemble à une cadence : ≥ 3 occurrences dans des mois distincts et
// espacement médian mensuel (25-35 j) ou aux deux semaines (12-16 j).
// PROPOSITIONS SEULEMENT : rien n'entre dans la projection avant que
// l'utilisateur ne crée la récurrente (route /treasury/learning/adopt).
export function detectUnmodeled({ months = LEARN_MONTHS, today = new Date(), minAmount = 5 } = {}) {
  const { txns, usedTxn } = matchRecurringOccurrences({ months, today })
  const known = db.prepare(`
    SELECT bank_txn_id FROM treasury_payments WHERE bank_txn_id IS NOT NULL AND deleted_at IS NULL
  `).all().map(r => r.bank_txn_id)
  const excluded = new Set([...usedTxn, ...known])
  // Un mouvement déjà rattaché à une facture / un reçu par le rapprochement est
  // déjà projeté par sa propre source : le proposer comme récurrente le
  // doublerait.
  const pool = txns.filter(t => !excluded.has(t.id) && !t.matched)
  return periodicClusters(pool, { minAmount })
}

// Vue complète pour la page : ce que la projection a corrigé, et ce qu'elle ne
// sait pas encore. Un seul appel côté client.
export function learningReport({ months = LEARN_MONTHS, today = new Date() } = {}) {
  const learned = learnRecurring({ months, today })
  const suggestions = detectUnmodeled({ months, today })
  const adjusted = learned.filter(l => l.drift != null
    && Math.abs(l.drift) > Math.max(1, (l.configured_amount || 0) * 0.01))
  return {
    months,
    generated_at: new Date().toISOString(),
    learned,
    adjusted: adjusted.map(l => ({
      id: l.id, label: l.label, from: l.configured_amount, to: l.apply_amount,
      drift: l.drift, drift_pct: l.drift_pct, n: l.n, last_seen: l.last_seen,
      from_day: l.configured_day, to_day: l.apply_day,
    })),
    // Récurrentes sans aucune trace au relevé : soit le montant est très loin de
    // la réalité, soit le prélèvement n'existe plus. À vérifier, jamais retiré
    // automatiquement.
    // Récurrente pas encore commencée (versements DEC à partir de nov. 2028) :
    // son absence au relevé est normale, ce n'est pas une anomalie.
    unseen: learned.filter(l => l.n === 0 && l.configured_amount && !l.not_started)
      .map(l => ({ id: l.id, label: l.label, amount: l.configured_amount })),
    suggestions,
    suggestions_monthly_total: r2c(suggestions.reduce((s, x) => s + x.monthly_cost, 0)),
  }
}

// Crée la récurrente correspondant à une suggestion (action explicite de
// l'utilisateur). Retourne la ligne créée.
export function adoptSuggestion(suggestion, userId = null) {
  const s = suggestion || {}
  const amount = Number(s.amount)
  if (!(amount > 0)) return { error: 'Montant invalide' }
  if (!['monthly', 'biweekly'].includes(s.frequency)) return { error: 'Fréquence invalide' }
  const id = db.prepare('SELECT lower(hex(randomblob(16))) AS id').get().id
  db.prepare(`
    INSERT INTO recurring_outflows (id, label, amount, frequency, day_of_month, anchor_date, active, notes, created_at, updated_at, amount_entered_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  `).run(
    id,
    String(s.label || 'Prélèvement récurrent').slice(0, 120),
    amount,
    s.frequency,
    s.frequency === 'monthly' ? Math.min(31, Math.max(1, Number(s.day_of_month) || 1)) : null,
    s.frequency === 'biweekly' ? String(s.anchor_date || '').slice(0, 10) || null : null,
    `Détectée au relevé BNC (${s.n || '?'} occurrences, dernière le ${s.last_seen || '?'})${userId ? '' : ''}`,
  )
  return db.prepare('SELECT * FROM recurring_outflows WHERE id = ?').get(id)
}
