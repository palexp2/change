// Projection de trésorerie du compte BNC CAD.
//
// Remplace le fichier « Maintien du solde disponible BNC » : à partir du
// dernier solde disponible réel saisi (page Trésorerie), projette le solde
// jour par jour sur l'horizon en combinant :
//   - les factures fournisseurs CAD à payer (achats_fournisseurs, type bill),
//     payées à leur date d'échéance (échéance passée → aujourd'hui) ;
//   - les sorties récurrentes configurables (paie, loyer, Mastercard, AGA,
//     dettes Ville de Québec / BDC…) de la table recurring_outflows ;
//   - les payouts Stripe CAD à venir (arrival_date) en entrées.
//
// RIGUEUR — rentrées certaines uniquement : un solde négatif coûte cher (frais
// + intérêts BNC), donc la projection canonique (scénario `certain`, défaut)
// ne compte en entrée QUE l'argent déjà encaissé par Stripe et en route vers
// la banque (payouts pending/in_transit). Les encaissements clients projetés
// (src_ar) et les renouvellements d'abonnements (src_mrr) sont des ESTIMATIONS
// — un client peut payer en retard ou pas du tout, un abonnement peut churner
// — et ne sont inclus que dans les scénarios indicatifs `realistic` /
// `pessimistic`, jamais dans l'alerte ni le virement suggéré.
//
// L'automation système `sys_treasury_alert` vérifie chaque jour (et à chaque
// saisie de solde) si le solde projeté passe sous le seuil configuré. Le calcul
// et le journal restent complets, mais SLACK NE PARLE QUE POUR UN DÉCOUVERT
// IMMINENT : solde projeté NÉGATIF d'ici `slack_negative_days` (défaut 3 j) —
// avec le virement suggéré (procédure Venn). Demande explicite de l'utilisateur
// (11 août 2026) : le canal comptabilité doit recevoir le moins d'alertes
// possible. Tout le reste (point bas sous le seuil, négatif plus lointain,
// écart de réconciliation, solde de saisie périmé) est loggé et affiché sur la
// page Trésorerie sans notification. Repli sur l'ancien comportement (seuil
// d'ici `slack_urgent_days`) en mettant `slack_negative_only` à 0.
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'
import { qbEntityUrl } from '../connectors/quickbooks.js'
import { paymentEvents, achatIdsWithPayment, coveredBillIds, recurringCoverage, autoClearFromBank } from './treasuryPayments.js'
import { learnedRecurringMap, bankConfirmedOutflows } from './treasuryLearning.js'
import { sendSlackWebhook } from './slack.js'

export const TREASURY_AUTOMATION_ID = 'sys_treasury_alert'

export const TREASURY_DEFAULT_CONFIG = {
  threshold: '5000',        // seuil d'alerte (CAD)
  horizon_days: '42',       // horizon d'affichage de la projection (jours)
  // Sources de projection activables. src_ar / src_mrr sont des ESTIMATIONS :
  // elles n'apparaissent que dans les scénarios indicatifs (realistic /
  // pessimistic), jamais dans le scénario `certain` qui pilote l'alerte et le
  // virement suggéré. Les défauts des autres évitent les doubles comptes avec
  // les sorties récurrentes déjà configurées (recurring_outflows) : paie,
  // loyer, Mastercard, AGA et dettes Ville de Québec / BDC y sont déjà.
  src_ar: '1',              // encaissements clients estimés (factures « À payer », CAD) — vue indicative seulement
  src_mrr: '1',             // renouvellements d'abonnements Stripe estimés (MRR, CAD) — vue indicative seulement
  src_lt_debts: '0',        // cédules de dettes LT — OFF : doublerait « Dette BDC / Ville de Québec » des récurrents
  src_vendor_subs: '0',     // abonnements fournisseurs CAD — OFF : la plupart passent par les cartes (relevé Mastercard déjà récurrent)
  // Délai bancaire entre le paiement Stripe d'une facture client et l'arrivée
  // au compte BNC (payout) — ajouté au délai de paiement historique du client.
  ar_settle_days: '2',
  // Fraîcheur exigée de la donnée Stripe pour qu'un payout compte comme une
  // rentrée certaine. Au-delà, le statut « en route » n'est plus une preuve
  // (le payout a pu être annulé sans qu'on le sache) : il est écarté de la
  // projection et rapporté. La synchro tourne 2×/jour — 48 h laisse de la marge
  // sans jamais compter de l'argent sur une donnée d'une autre semaine.
  payout_stale_hours: '48',
  // Fenêtre d'ACTION : la trésorerie est gérée au fur et à mesure — seuls les
  // prochains jours comptent pour l'alerte et le virement suggéré. Le point bas
  // au-delà de cette fenêtre est affiché à titre indicatif seulement.
  alert_horizon_days: '14',
  // ── Bruit Slack (canal comptabilité) ──────────────────────────────────────
  // Le canal comptabilité ne doit recevoir QUE du découvert imminent (demande
  // utilisateur du 11 août 2026). Avec slack_negative_only=1 :
  //   - « sous le seuil de confort » ne notifie JAMAIS (journal + page seulement) ;
  //   - un solde NÉGATIF notifie seulement s'il tombe d'ici slack_negative_days.
  // Mettre à 0 pour revenir au comportement historique (seuil franchi d'ici
  // slack_urgent_days, + tout négatif de la fenêtre d'action).
  slack_negative_only: '1',
  slack_negative_days: '3',
  // Fenêtre d'URGENCE de l'ancien mode (slack_negative_only=0) : Slack ne parle
  // que si le solde passe sous le seuil dans les N prochains jours. Toute la
  // fenêtre d'action (alert_horizon_days) reste évaluée et loggée, seul l'envoi
  // Slack est restreint.
  slack_urgent_days: '2',
  // Fraîcheur du solde saisi : au-delà de ce nombre de jours sans nouvelle
  // saisie, la projection est considérée périmée (tuile ambre sur la page
  // Trésorerie). Rappel loggé seulement — pas de Slack : c'est de l'hygiène de
  // saisie, pas une urgence. Mettre à '1' pour réactiver l'envoi Slack.
  stale_reminder_slack: '0',
  balance_stale_days: '7',
  // ── Apprentissage sur le relevé bancaire ──────────────────────────────────
  // Les montants et jours saisis des récurrentes sont des arrondis de gestion
  // (paie 25 000 $ pour 21 à 24,8 k$ réels, loyer le 1er pour un débit le 3-4).
  // À '1', la projection utilise ce que le compte BNC montre vraiment sur les
  // learn_months derniers mois : montant = médiane des 3 dernières occurrences,
  // jour = jour réel s'il est PLUS TÔT que le jour saisi (prudence). Voir
  // services/treasuryLearning.js. Mettre à '0' pour revenir aux saisies seules.
  learn_from_bank: '1',
  learn_months: '6',
  // À '1', une sortie encore projetée mais retrouvée au relevé est retirée de la
  // projection sans intervention (remplace le bouton « déjà sorti »).
  auto_clear_from_bank: '1',
  // Réconciliation : écart toléré (CAD, valeur absolue) entre le solde réel
  // saisi et le solde que la projection annonçait pour ce jour-là. Au-delà,
  // l'écart est journalisé (et visible sur la page Trésorerie). Pas de Slack :
  // la réconciliation ne doit envoyer AUCUNE alerte dans le canal comptabilité
  // (demande utilisateur du 11 août 2026). Mettre variance_slack à 1 pour
  // réactiver l'envoi.
  variance_tolerance: '500',
  variance_slack: '0',
  // Dégradation qui court-circuite l'anti-spam de 20 h : si le point bas de la
  // fenêtre d'action recule de plus de ce montant depuis la dernière alerte, on
  // réalerte. Sans ça, une alerte du matin faisait taire toute aggravation de la
  // journée (incident du 1er août 2026 : la saisie du solde de l'après-midi a
  // été avalée par le throttle, aucun Slack, aucune trace).
  escalate_delta: '2000',
  // Webhook Slack (DM Antoine Lambert) — nom de la variable d'env dans server/.env.
  slack_webhook_env: 'SLACK_WEBHOOK_TREASURY',
  // ── Carte de crédit d'opération (cédule de paiements) ──────────────────────
  // La Mastercard sert à payer une partie des fournisseurs : au-delà d'un
  // certain solde, on ne peut plus s'en servir avant que le paiement
  // pré-programmé du 5 soit passé. La cédule prévient AVANT de charger la carte.
  // Jour de la séance de paiement des fournisseurs (1 = lundi … 7 = dimanche).
  // Mardi : ce jour-là on règle tout ce qui échoit avant le mercredi suivant.
  pay_weekday: '2',
  mc_account: 'MasterCard BNC',   // nom du compte carte (bank_accounts.name)
  mc_alert_threshold: '10000',    // solde projeté au-delà duquel on avertit
  mc_limit: '15000',              // limite de la carte
}

export function getTreasuryConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get(TREASURY_AUTOMATION_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch {}
  const merged = { ...TREASURY_DEFAULT_CONFIG }
  for (const k of Object.keys(TREASURY_DEFAULT_CONFIG)) {
    if (cfg[k] != null && String(cfg[k]).trim() !== '') merged[k] = String(cfg[k]).trim()
  }
  return merged
}

// ── Expansion des récurrences ────────────────────────────────────────────────

const isoDate = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const parseDay = s => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''))
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) : null
}

// Occurrences (ISO) d'une sortie récurrente dans [from, to] inclus.
// - weekly/biweekly/quarterly : cadence 7/14 jours ou 3 mois depuis anchor_date.
// - monthly : chaque mois au day_of_month (borné à la fin du mois).
// starts_on / ends_on resserrent la fenêtre : une récurrente qui ne démarre que
// plus tard (versements DEC à partir du 1er nov. 2028) ou qui s'arrête à la fin
// d'une cédule ne produit rien en dehors de ses bornes.
export function expandRecurring(r, fromIso, toIso) {
  let from = parseDay(fromIso), to = parseDay(toIso)
  if (!from || !to) return []
  const startsOn = parseDay(r.starts_on)
  const endsOn = parseDay(r.ends_on)
  if (startsOn && startsOn > from) from = startsOn
  if (endsOn && endsOn < to) to = endsOn
  if (from > to) return []
  const out = []
  if (r.frequency === 'monthly') {
    const day = Number(r.day_of_month)
    if (!Number.isInteger(day) || day < 1 || day > 31) return []
    for (let d = new Date(from.getFullYear(), from.getMonth(), 1, 12); d <= to; d.setMonth(d.getMonth() + 1)) {
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
      const occ = new Date(d.getFullYear(), d.getMonth(), Math.min(day, last), 12)
      if (occ >= from && occ <= to) out.push(isoDate(occ))
    }
    return out
  }
  const anchor = parseDay(r.anchor_date)
  if (!anchor) return []
  if (r.frequency === 'weekly' || r.frequency === 'biweekly') {
    const step = r.frequency === 'weekly' ? 7 : 14
    const msPerDay = 24 * 3600 * 1000
    const diff = Math.floor((from - anchor) / msPerDay)
    const offset = ((diff % step) + step) % step
    const first = new Date(from)
    first.setDate(first.getDate() + (offset === 0 ? 0 : step - offset))
    for (let d = new Date(first); d <= to; d.setDate(d.getDate() + step)) out.push(isoDate(d))
    return out
  }
  if (r.frequency === 'quarterly') {
    for (let d = new Date(anchor); d <= to; d.setMonth(d.getMonth() + 3)) {
      if (d >= from) out.push(isoDate(d))
    }
    return out
  }
  return []
}

// Récurrente à montant variable (ex. relevé Mastercard) : le montant saisi ne
// vaut que pour UNE occurrence — la première qui suit la date de saisie. Une
// fois cette occurrence passée, le montant est périmé et doit être ressaisi.
// Retourne la date (ISO) à projeter dans [fromIso, toIso], ou null si le
// montant est périmé, hors fenêtre, ou n'a jamais été saisi.
export function variableOccurrence(r, fromIso, toIso) {
  const enteredDay = String(r.amount_entered_at || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(enteredDay)) return null
  const target = expandRecurring(r, enteredDay, toIso)[0] || null
  return target && target >= fromIso ? target : null
}

// Début de la fenêtre « encore dû » : le jour de la saisie du solde, qui peut
// être antérieur à aujourd'hui. Tout mouvement daté à partir de ce jour n'est
// pas encore reflété dans le solde saisi et reste donc à venir.
export function pendingWindowStart(balanceNotedAt, fromIso) {
  if (!balanceNotedAt) return fromIso
  const d = new Date(balanceNotedAt)
  if (Number.isNaN(d.getTime())) return fromIso
  const day = isoDate(d)
  return day < fromIso ? day : fromIso
}

// Date de projection d'un mouvement : aujourd'hui s'il est en retard (daté
// avant aujourd'hui mais toujours dû), sinon sa propre date. Même règle pour
// les factures et les récurrentes — l'asymétrie entre les deux est ce qui a
// fait disparaître le loyer du 1er août 2026 de la projection du lendemain.
export function projectAt(date, fromIso) {
  return date < fromIso ? { date: fromIso, late: true, original_date: date } : { date }
}

// ── Projection ───────────────────────────────────────────────────────────────

// Cœur pur : à partir d'un solde de départ et d'événements datés (+entrée /
// −sortie), produit la série quotidienne. `events` = [{date, amount, label, kind}].
export function buildProjection({ startBalance, fromIso, toIso, events }) {
  const byDate = new Map()
  for (const e of events) {
    if (e.date < fromIso || e.date > toIso) continue
    if (!byDate.has(e.date)) byDate.set(e.date, [])
    byDate.get(e.date).push(e)
  }
  const days = []
  let balance = Number(startBalance) || 0
  let min = { balance, date: fromIso }
  const cur = parseDay(fromIso), end = parseDay(toIso)
  for (let d = new Date(cur); d <= end; d.setDate(d.getDate() + 1)) {
    const date = isoDate(d)
    const evts = byDate.get(date) || []
    const delta = evts.reduce((s, e) => s + e.amount, 0)
    balance = Math.round((balance + delta) * 100) / 100
    if (balance < min.balance) min = { balance, date }
    days.push({ date, events: evts, delta: Math.round(delta * 100) / 100, balance })
  }
  return { days, min_balance: min.balance, min_date: min.date }
}

// ── Rentrées certaines ───────────────────────────────────────────────────────
//
// Ce qui a le droit d'entrer dans la projection du solde :
//   - `in_transit` : Stripe a émis le virement, il est en route, la date
//     d'arrivée est fixée — c'est de l'argent déjà parti du solde Stripe ;
//   - `pending`    : payout créé et programmé par Stripe (encaissements déjà
//     réglés, mis de côté pour le prochain virement) ;
//   - `paid`       : déjà versé, mais daté après le solde noté — il n'est pas
//     encore dans le solde de départ, il doit donc être compté.
// Tout le reste est écarté ET rapporté :
//   - `failed` / `canceled`, ou un `failure_code` posé sur un payout encore
//     marqué en route (Stripe pose le code avant que le statut ne suive) ;
//   - donnée périmée : si la synchro Stripe n'a pas tourné depuis
//     `payout_stale_hours`, un payout annulé entre-temps serait encore compté
//     « en route ». Sans nouvelle de Stripe, on ne compte pas son argent.
// Décision, pour UN payout : compté ou écarté, et pourquoi. Pur — la règle qui
// protège le solde projeté doit pouvoir être testée sans base de données.
export function payoutCertainty(payout, { stale = false, ageHours = null, staleHours = 48, hasSync = true } = {}) {
  if (payout.failure_code) {
    return { counted: false, reason: `Stripe signale un échec (${payout.failure_code})` }
  }
  if (stale) {
    return {
      counted: false,
      reason: hasSync
        ? `donnée Stripe non rafraîchie depuis ${Math.round(ageHours)} h (seuil ${staleHours} h) — statut « ${payout.status} » non confirmé`
        : 'aucune synchronisation Stripe enregistrée — statut non confirmé',
    }
  }
  return {
    counted: true,
    certainty: payout.status === 'paid' ? 'versé par Stripe'
      : payout.status === 'in_transit' ? 'en route vers la banque'
        : 'programmé par Stripe',
  }
}

export function certainPayouts({ fromIso, toIso, balanceDayIso = null, cfg = getTreasuryConfig(), now = new Date() }) {
  const rows = db.prepare(`
    SELECT stripe_id, amount, arrival_date, status, failure_code, synced_at FROM stripe_payouts
    WHERE status IN ('pending', 'in_transit', 'paid') AND LOWER(COALESCE(currency, 'cad')) = 'cad'
      AND amount > 0 AND arrival_date >= ? AND arrival_date <= ?
  `).all(fromIso, toIso)

  // Fraîcheur : le payout le plus récemment synchronisé, toutes devises — c'est
  // la preuve que la connexion Stripe répond encore.
  const lastSync = db.prepare('SELECT MAX(synced_at) AS at FROM stripe_payouts').get()?.at || null
  const staleHours = Math.max(1, Number(cfg.payout_stale_hours) || 48)
  const ageHours = lastSync ? (now - new Date(lastSync)) / 3600000 : null
  const stale = ageHours == null || ageHours > staleHours

  const counted = []
  const excluded = []
  const already_in_balance = []
  for (const p of rows) {
    const base = {
      stripe_id: p.stripe_id, amount: Number(p.amount),
      date: String(p.arrival_date).slice(0, 10), status: p.status,
    }
    // Déjà versé ET arrivé au plus tard le jour du solde noté : cet argent est
    // DANS le solde de départ. L'ajouter le compterait deux fois — même
    // asymétrie que pour les virements entrants (une sortie en retard se
    // reprojette, une entrée déjà encaissée jamais).
    if (p.status === 'paid' && balanceDayIso && base.date <= balanceDayIso) {
      already_in_balance.push(base)
      continue
    }
    const verdict = payoutCertainty(p, { stale, ageHours, staleHours, hasSync: !!lastSync })
    if (verdict.counted) counted.push({ ...base, certainty: verdict.certainty })
    else excluded.push({ ...base, reason: verdict.reason })
  }
  return {
    counted, excluded, already_in_balance,
    stripe_synced_at: lastSync,
    stale,
    total_counted: r2c(counted.reduce((s, p) => s + p.amount, 0)),
    total_excluded: r2c(excluded.reduce((s, p) => s + p.amount, 0)),
  }
}

const r2c = n => Math.round(n * 100) / 100

// Re-synchronise les payouts Stripe si la donnée a dépassé le seuil de
// fraîcheur. Silencieux si Stripe n'est pas configuré — la prudence de
// certainPayouts prend alors le relais.
async function refreshStalePayouts(cfg) {
  const lastSync = db.prepare('SELECT MAX(synced_at) AS at FROM stripe_payouts').get()?.at || null
  const staleHours = Math.max(1, Number(cfg.payout_stale_hours) || 48)
  if (lastSync && (Date.now() - new Date(lastSync).getTime()) / 3600000 <= staleHours) return false
  const { syncStripePayouts, isStripeConfigured } = await import('./stripe.js')
  if (!isStripeConfigured?.()) return false
  await syncStripePayouts({ fullHistory: false })
  return true
}

// ── Statistiques de délai de paiement par client ─────────────────────────────

// Percentile (0..1) d'un tableau trié ascendant.
const percentile = (sorted, p) => sorted.length
  ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))]
  : null

// Délais historiques paid_at − due_date (jours) des factures payées, par
// client + global. Le délai capture tout le cycle réel (retard client +
// settlement Stripe étant reflété séparément via ar_settle_days).
// Retourne { global: {median, p90, n}, byCompany: Map(company_id → idem) }.
export function clientPaymentDelayStats() {
  const rows = db.prepare(`
    SELECT company_id, CAST(ROUND(julianday(paid_at) - julianday(due_date)) AS INTEGER) AS delay
    FROM factures
    WHERE status = 'Payé' AND paid_at IS NOT NULL AND due_date IS NOT NULL
      AND julianday(paid_at) - julianday(due_date) BETWEEN -60 AND 365
  `).all()
  const all = []
  const byCompanyRaw = new Map()
  for (const r of rows) {
    all.push(r.delay)
    if (r.company_id) {
      if (!byCompanyRaw.has(r.company_id)) byCompanyRaw.set(r.company_id, [])
      byCompanyRaw.get(r.company_id).push(r.delay)
    }
  }
  all.sort((a, b) => a - b)
  const stats = arr => ({ median: percentile(arr, 0.5), p90: percentile(arr, 0.9), n: arr.length })
  const byCompany = new Map()
  for (const [cid, arr] of byCompanyRaw) {
    arr.sort((a, b) => a - b)
    // Moins de 3 factures payées : l'historique du client n'est pas significatif.
    if (arr.length >= 3) byCompany.set(cid, stats(arr))
  }
  return { global: stats(all), byCompany }
}

// ── Sources d'événements optionnelles ────────────────────────────────────────

// Encaissements clients : factures « À payer » CAD, projetées à
// due_date + délai historique du client (médiane en réaliste, p90 en
// pessimiste, fallback global) + délai de settlement Stripe→BNC.
function buildArEvents({ scenario, settleDays, today }) {
  const open = db.prepare(`
    SELECT f.id, f.document_number, f.due_date, f.document_date, f.balance_due, f.company_id, c.name AS company_name
    FROM factures f LEFT JOIN companies c ON c.id = f.company_id
    WHERE f.status = 'À payer' AND f.balance_due > 0 AND COALESCE(f.currency, 'CAD') = 'CAD'
  `).all()
  if (!open.length) return []
  const delays = clientPaymentDelayStats()
  const pick = s => (scenario === 'pessimistic' ? s?.p90 : s?.median)
  const fallback = pick(delays.global) ?? 0
  const events = []
  for (const f of open) {
    const base = f.due_date || f.document_date
    if (!base) continue
    const delay = (pick(delays.byCompany.get(f.company_id)) ?? fallback) + settleDays
    const d = parseDay(base)
    d.setDate(d.getDate() + Math.max(0, delay))
    // Encaissement attendu déjà passé → projeté demain (jamais rétroactif).
    const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1)
    const date = isoDate(d < tomorrow ? tomorrow : d)
    events.push({
      date, amount: Number(f.balance_due),
      label: `${f.company_name || 'Client'}${f.document_number ? ` · ${f.document_number}` : ''}`,
      kind: 'ar', ref: f.id,
    })
  }
  return events
}

// Renouvellements d'abonnements Stripe (MRR) : chaque abonnement actif CAD
// génère une entrée mensuelle au jour d'anniversaire de start_date, décalée du
// settlement Stripe→BNC. Les 7 premiers jours sont exclus : ces encaissements
// sont déjà couverts par les payouts pending/in_transit projetés par ailleurs.
function buildMrrEvents({ fromIso, toIso, settleDays, today }) {
  const subs = db.prepare(`
    SELECT id, company_id, amount_monthly, start_date,
           (SELECT name FROM companies WHERE id = subscriptions.company_id) AS company_name
    FROM subscriptions
    WHERE status IN ('active', 'past_due') AND COALESCE(currency, 'CAD') = 'CAD' AND amount_monthly > 0
  `).all()
  const skipUntil = new Date(today); skipUntil.setDate(skipUntil.getDate() + 7)
  const events = []
  for (const s of subs) {
    const anchor = parseDay(s.start_date)
    if (!anchor) continue
    const day = anchor.getDate()
    const from = parseDay(fromIso), to = parseDay(toIso)
    for (let d = new Date(from.getFullYear(), from.getMonth(), 1, 12); d <= to; d.setMonth(d.getMonth() + 1)) {
      const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()
      const occ = new Date(d.getFullYear(), d.getMonth(), Math.min(day, last), 12)
      occ.setDate(occ.getDate() + settleDays)
      if (occ < from || occ > to || occ <= skipUntil) continue
      events.push({
        date: isoDate(occ), amount: Number(s.amount_monthly),
        label: `Abonnement ${s.company_name || 'client'}`, kind: 'mrr', ref: s.id,
      })
    }
  }
  return events
}

// Versements de dettes LT à venir (cédules lt_debt_payments, montants exacts).
// ⚠️ Ne pas activer en même temps que les récurrentes « Dette BDC » / « Dette
// Ville de Québec » — double compte garanti.
function buildLtDebtEvents({ fromIso, toIso }) {
  const rows = db.prepare(`
    SELECT p.id, p.payment_date, p.principal, p.interest, d.label
    FROM lt_debt_payments p JOIN lt_debts d ON d.id = p.debt_id
    WHERE p.deleted_at IS NULL AND d.deleted_at IS NULL AND COALESCE(d.currency, 'CAD') = 'CAD'
      AND p.payment_date >= ? AND p.payment_date <= ?
  `).all(fromIso, toIso)
  return rows.map(p => ({
    date: String(p.payment_date).slice(0, 10),
    amount: -(Number(p.principal) + Number(p.interest)),
    label: `Dette ${p.label}`, kind: 'lt_debt', ref: p.id,
  }))
}

// Charges attendues des abonnements fournisseurs CAD actifs (billing_day /
// billing_month). ⚠️ La plupart passent par les cartes : le relevé Mastercard
// récurrent les couvre déjà — n'activer que si les récurrentes correspondantes
// sont ajustées.
function buildVendorSubEvents({ fromIso, toIso }) {
  const subs = db.prepare(`
    SELECT id, vendor, plan, amount, frequency, billing_day, billing_month
    FROM vendor_subscriptions
    WHERE deleted_at IS NULL AND active = 1 AND COALESCE(currency, 'CAD') = 'CAD' AND amount > 0
  `).all()
  const from = parseDay(fromIso), to = parseDay(toIso)
  const events = []
  for (const s of subs) {
    const day = Math.min(28, Math.max(1, Number(s.billing_day) || 1))
    for (let d = new Date(from.getFullYear(), from.getMonth(), 1, 12); d <= to; d.setMonth(d.getMonth() + 1)) {
      if (s.frequency === 'Annuel' && Number(s.billing_month) && d.getMonth() + 1 !== Number(s.billing_month)) continue
      const occ = new Date(d.getFullYear(), d.getMonth(), day, 12)
      if (occ < from || occ > to) continue
      events.push({
        date: isoDate(occ), amount: -Number(s.amount),
        label: `${s.vendor}${s.plan ? ` (${s.plan})` : ''}`, kind: 'vendor_sub', ref: s.id,
      })
    }
  }
  return events
}

// Regroupe des événements de même kind par jour en un seul événement agrégé.
// `labelFor(n)` construit le libellé à partir du nombre d'événements du jour ;
// un jour à événement unique garde son libellé d'origine.
export function aggregateByDay(events, labelFor) {
  const byDate = new Map()
  for (const e of events) {
    if (!byDate.has(e.date)) byDate.set(e.date, [])
    byDate.get(e.date).push(e)
  }
  const out = []
  for (const [date, evts] of byDate) {
    if (evts.length === 1) { out.push(evts[0]); continue }
    out.push({
      date,
      amount: Math.round(evts.reduce((s, e) => s + e.amount, 0) * 100) / 100,
      label: labelFor(evts.length),
      kind: evts[0].kind,
      ref: null,
      details: evts.map(e => ({ label: e.label, amount: e.amount, ref: e.ref })),
    })
  }
  return out
}

// Scénarios :
//   - `certain` (défaut) : rentrées SÛRES uniquement (payouts Stripe déjà en
//     transit) + toutes les sorties. C'est la base de l'alerte, du point bas
//     et du virement suggéré — jamais d'argent espéré.
//   - `realistic` / `pessimistic` : ajoutent les rentrées ESTIMÉES (AR selon
//     les délais historiques médian/p90, MRR) à titre indicatif seulement.
export function computeProjection({ days = null, today = new Date(), scenario = 'certain' } = {}) {
  const cfg = getTreasuryConfig()
  const on = k => cfg[k] === '1' || cfg[k] === 'true'
  const horizon = Math.min(120, Math.max(7, Number(days) || Number(cfg.horizon_days) || 42))
  const fromIso = isoDate(today)
  const end = new Date(today); end.setDate(end.getDate() + horizon)
  const toIso = isoDate(end)

  const balanceRow = db.prepare(
    'SELECT * FROM treasury_balances ORDER BY noted_at DESC LIMIT 1'
  ).get() || null

  // ── Fenêtre « encore dû » ──────────────────────────────────────────────────
  // Le solde saisi photographie le compte à sa DATE DE SAISIE. Tout mouvement
  // daté à partir de ce jour-là n'est donc pas encore reflété dedans et reste
  // dû, même si sa date est déjà passée au moment où l'on projette.
  //
  // Sans cette règle, un mouvement tombant entre la saisie et aujourd'hui
  // s'évaporait de la projection : c'est l'incident du 1er août 2026 (solde
  // saisi le samedi 1er, loyer du 1er = 6 115,89 $ disparu dès le dimanche
  // matin, projection remontée de +6 116 $ et alerte rétrogradée en « veille »).
  // Les factures avaient déjà la bonne règle (échéance passée → reprojetée
  // aujourd'hui) ; les récurrentes non. L'asymétrie est corrigée ici.
  const pendingFromIso = pendingWindowStart(balanceRow?.noted_at, fromIso)
  const balanceDayIso = balanceRow ? isoDate(new Date(balanceRow.noted_at)) : fromIso
  // Mouvement en retard → reprojeté aujourd'hui : l'argent est encore à sortir,
  // sauf si l'utilisateur a confirmé qu'il avait déjà passé au compte.
  const clearedKeys = new Set(db.prepare('SELECT event_key FROM treasury_cleared_events').all().map(r => r.event_key))
  const dated = (date, base) => {
    const event_key = `${base.kind}:${base.ref || '-'}:${date}`
    const at = projectAt(date, fromIso)
    if (at.late && clearedKeys.has(event_key)) return null
    return { ...base, ...at, event_key }
  }

  const events = []
  const push = e => { if (e) events.push(e) }

  // Factures fournisseurs CAD à payer → payées à la date d'échéance (processus
  // réel — l'ancienne « règle du mardi » du CTB - Suivi projetait trop tôt).
  // Échéance déjà passée : sortie projetée aujourd'hui (toujours due).
  const bills = db.prepare(`
    SELECT id, vendor, due_date, balance_due_cad, quickbooks_id FROM achats_fournisseurs
    WHERE type = 'bill' AND status NOT IN ('Payée', 'Annulée', 'Brouillon')
      AND balance_due_cad > 0 AND COALESCE(currency, 'CAD') = 'CAD'
  `).all()
  // Facture déjà payée par un paiement émis : c'est le paiement (avec sa date de
  // sortie réelle) qui compte, sinon le même dollar sortirait deux fois.
  const paidAchats = achatIdsWithPayment()
  // Deuxième filet : un paiement en attente au même fournisseur, même montant et
  // date proche couvre la facture même sans lien achat_id (paiement importé
  // avant l'ingestion de la facture, ou lié par erreur à une vieille facture
  // payée — Dubois Agrinovation 830,77 $ sortait deux fois le 9 août 2026).
  // Exposées dans covered_bills pour que la page puisse l'expliquer.
  const openBills = bills.filter(b => b.due_date && !paidAchats.has(b.id))
  const allOpenBillIds = new Set(bills.map(b => b.id))
  const pendingOut = db.prepare(`
    SELECT id, label, amount, payment_date, achat_id FROM treasury_payments
    WHERE deleted_at IS NULL AND cleared_at IS NULL AND direction = 'out'
      AND COALESCE(account, 'BNC CAD') = ? AND COALESCE(currency, 'CAD') = 'CAD'
  `).all(TREASURY_BANK_ACCOUNT)
  const billCover = coveredBillIds(openBills,
    // Un paiement lié à une facture ouverte la couvre déjà (paidAchats) — il ne
    // doit pas en absorber une deuxième.
    pendingOut.filter(p => !p.achat_id || !allOpenBillIds.has(p.achat_id)))
  const covered_bills = []
  for (const b of openBills) {
    const cover = billCover.get(b.id)
    if (cover) {
      covered_bills.push({
        label: b.vendor, date: String(b.due_date).slice(0, 10), amount: -Number(b.balance_due_cad),
        payment_id: cover.payment_id, payment_label: cover.payment_label, payment_date: cover.payment_date,
      })
      continue
    }
    push(dated(String(b.due_date).slice(0, 10), {
      amount: -Number(b.balance_due_cad),
      label: b.vendor || 'Facture fournisseur', kind: 'bill', ref: b.id,
      // Lien direct vers l'écriture QuickBooks (null si pas encore publiée).
      qb_url: b.quickbooks_id ? qbEntityUrl('bill', b.quickbooks_id) : null,
    }))
  }

  // Sorties récurrentes configurées.
  const recurring = db.prepare(
    'SELECT * FROM recurring_outflows WHERE deleted_at IS NULL AND active = 1'
  ).all()
  // ── Ce que le compte dit vraiment ─────────────────────────────────────────
  // Les montants saisis sont des arrondis de gestion. Le relevé BNC connaît le
  // montant et le jour RÉELS de chaque prélèvement : on projette ceux-là (voir
  // services/treasuryLearning.js). Chaque substitution est tracée dans
  // `learned` pour rester lisible sur la page.
  const learnMonths = Math.min(24, Math.max(2, Number(cfg.learn_months) || 6))
  const learnedMap = on('learn_from_bank')
    ? learnedRecurringMap({ months: learnMonths, today })
    : new Map()
  const learned = []
  // Occurrences remplacées par la vraie facture / le vrai paiement du fournisseur
  // (recurring_outflows.vendor_match) — exposées pour que la page l'explique.
  const covered_recurring = []
  for (const raw of recurring) {
    const lrn = learnedMap.get(raw.id) || null
    // Montant appris : il remplace la saisie. Cas particulier des montants
    // variables (relevé Mastercard) : quand la saisie est périmée, l'ancienne
    // règle EXCLUAIT la sortie de la projection — un trou silencieux dans les
    // dépenses. L'historique fournit alors une estimation, signalée comme telle.
    const staleVariable = raw.variable_amount && !variableOccurrence(raw, pendingFromIso, toIso)
    const learnedAmount = lrn?.amount || null
    const r = {
      ...raw,
      amount: learnedAmount || raw.amount,
      day_of_month: lrn?.day || raw.day_of_month,
      // Un montant estimé depuis l'historique se projette comme un mensuel
      // normal : la sortie existe, seul son montant exact est inconnu.
      variable_amount: staleVariable && learnedAmount ? 0 : raw.variable_amount,
    }
    if (lrn) {
      learned.push({
        id: raw.id, label: raw.label,
        from: lrn.configured_amount, to: r.amount,
        from_day: lrn.configured_day, to_day: lrn.day || null,
        n: lrn.n, last_seen: lrn.last_seen,
        estimated: !!(staleVariable && learnedAmount),
      })
    }
    if (!(Number(r.amount) > 0)) continue
    const base = {
      amount: -Number(r.amount), label: r.label, kind: 'recurring', ref: r.id,
      learned: lrn ? { from: lrn.configured_amount, n: lrn.n } : null,
    }
    const dates = r.variable_amount
      // Montant valable pour une seule occurrence (voir variableOccurrence).
      ? [variableOccurrence(r, pendingFromIso, toIso)].filter(Boolean)
      : expandRecurring(r, pendingFromIso, toIso)
    for (const date of dates) {
      const cover = r.vendor_match ? recurringCoverage(r.vendor_match, date) : null
      if (cover) {
        covered_recurring.push({
          label: r.label, date, amount: -Number(r.amount),
          covered_by: cover.by, covered_label: cover.label, covered_amount: cover.amount, covered_date: cover.date,
        })
        continue
      }
      push(dated(date, base))
    }
  }

  // Paiements et virements émis mais pas encore passés à la banque (onglet
  // Pmt_Suivi) : virement Interac du week-end, chèque post-daté, renflouement
  // Venn → BNC. Même règle de retard que les factures — tant que ce n'est pas
  // passé au compte, c'est encore à sortir.
  // Asymétrie VOULUE entre sorties et entrées : une sortie encore dûe est
  // reprojetée (au pire la projection est trop basse — prudence), mais un
  // virement entrant daté avant la saisie du solde est déjà DANS le solde saisi ;
  // le recompter gonflerait la trésorerie de 20 000 $ imaginaires.
  for (const e of paymentEvents({ fromIso: pendingFromIso, toIso })) {
    if (e.amount > 0 && e.date <= balanceDayIso) continue
    // Une entrée ici est un virement DÉJÀ ÉMIS, constaté à la main (Venn → BNC,
    // épargne → chèque) : c'est un fait, pas une prévision.
    push(dated(e.date, e.amount > 0 ? { ...e, certain: true, certainty: 'virement émis, constaté à la main' } : e))
  }

  // ── Rentrées : uniquement de l'argent CERTAIN ──────────────────────────────
  // Un payout Stripe compté à tort est bien plus coûteux qu'un payout oublié :
  // il gonfle le solde projeté et fait rater un découvert. On ne compte donc
  // qu'un virement que Stripe a DÉJÀ décidé — argent sorti du solde Stripe,
  // en route vers la banque, avec une date d'arrivée annoncée — et seulement
  // si l'information est fraîche. Tout ce qui est écarté est rapporté
  // (`excluded_inflows`), jamais silencieux.
  const inflowCheck = certainPayouts({ fromIso, toIso, balanceDayIso, cfg })
  for (const p of inflowCheck.counted) {
    events.push({
      date: p.date, amount: p.amount, label: 'Payout Stripe', kind: 'payout', ref: p.stripe_id,
      certain: true, certainty: p.certainty,
    })
  }

  // Sources optionnelles (toggles src_* de la config — voir défauts et
  // avertissements anti-double-compte dans TREASURY_DEFAULT_CONFIG).
  // Les rentrées ESTIMÉES (AR, MRR) sont exclues du scénario `certain` quels
  // que soient les toggles : seul l'argent déjà en route compte pour l'alerte.
  const settleDays = Math.max(0, Number(cfg.ar_settle_days) || 0)
  const estimates = scenario !== 'certain'
  const sources = {
    ar: estimates && on('src_ar') ? buildArEvents({ scenario, settleDays, today }) : [],
    mrr: estimates && on('src_mrr') && scenario !== 'pessimistic'
      ? buildMrrEvents({ fromIso, toIso, settleDays, today }) : [],
    lt_debt: on('src_lt_debts') ? buildLtDebtEvents({ fromIso, toIso }) : [],
    vendor_sub: on('src_vendor_subs') ? buildVendorSubEvents({ fromIso, toIso }) : [],
  }
  // Les entrées AR/MRR sont agrégées par jour (une pastille « Encaissements
  // clients (n) » plutôt que n pastilles) — sinon la vue du dashboard est
  // encombrée, surtout par les dizaines de petits renouvellements d'abonnement.
  // Marquées `estimated` : le front les distingue visuellement des rentrées sûres.
  events.push(...aggregateByDay(sources.ar, n => `Encaissements clients (${n} facture${n > 1 ? 's' : ''})`).map(e => ({ ...e, estimated: true })))
  events.push(...aggregateByDay(sources.mrr, n => `Abonnements Stripe (${n} renouvellement${n > 1 ? 's' : ''})`).map(e => ({ ...e, estimated: true })))
  events.push(...sources.lt_debt, ...sources.vendor_sub)

  // ── Sorties en retard déjà passées au compte ───────────────────────────────
  // Une sortie datée depuis la saisie du solde est reprojetée aujourd'hui par
  // prudence. Mais si le relevé BNC montre le débit correspondant, elle EST
  // sortie : la garder gonfle les sorties à venir et fait reculer le point bas
  // pour rien. Le relevé confirme, l'utilisateur n'a plus rien à cocher.
  const lateEvents = events.filter(e => e.late)
  const auto_cleared = []
  let projectedEvents = events
  if (on('auto_clear_from_bank') && lateEvents.length) {
    const confirmed = bankConfirmedOutflows(lateEvents, { today })
    if (confirmed.size) {
      projectedEvents = events.filter(e => !(e.late && confirmed.has(e.event_key)))
      for (const e of lateEvents) {
        const hit = confirmed.get(e.event_key)
        if (!hit) continue
        auto_cleared.push({
          label: e.label, amount: e.amount, kind: e.kind, ref: e.ref,
          original_date: e.original_date, event_key: e.event_key,
          bank_date: hit.date, bank_amount: hit.amount, bank_label: hit.description,
        })
      }
    }
  }

  const projection = buildProjection({
    startBalance: balanceRow ? balanceRow.balance : 0,
    fromIso, toIso, events: projectedEvents,
  })

  const threshold = Number(cfg.threshold) || 0
  // Fenêtre d'action : point bas et virement suggéré sur les N prochains jours
  // seulement — c'est elle qui pilote l'alerte. Le point bas plein horizon
  // reste exposé à titre indicatif.
  const actionDays = Math.min(horizon, Math.max(1, Number(cfg.alert_horizon_days) || 14))
  const action_window = actionWindowStats(projection.days, actionDays, threshold)

  // Premiers franchissements sur TOUT l'horizon : plus parlants qu'un point bas
  // sur fenêtre fixe — « le solde passe sous le seuil le X ».
  const first_below_threshold = projection.days.find(d => d.balance < threshold) || null
  const first_negative = projection.days.find(d => d.balance < 0) || null

  // Fraîcheur du solde saisi : sans saisie récente, toute la projection dérive.
  const staleDays = Math.max(1, Number(cfg.balance_stale_days) || 7)
  const balanceAgeDays = balanceRow
    ? Math.floor((today - new Date(balanceRow.noted_at)) / (24 * 3600 * 1000))
    : null

  return {
    generated_at: new Date().toISOString(),
    scenario,
    sources_enabled: {
      ar: on('src_ar'), mrr: on('src_mrr'),
      lt_debts: on('src_lt_debts'), vendor_subs: on('src_vendor_subs'),
    },
    balance_entry: balanceRow,
    balance_day: balanceDayIso,
    // Mouvements datés entre la saisie du solde et aujourd'hui, donc encore dus
    // et reprojetés aujourd'hui. Affichés à part : c'est exactement la catégorie
    // qui disparaissait silencieusement avant le 3 août 2026.
    late_events: projectedEvents.filter(e => e.late).map(e => ({
      label: e.label, amount: e.amount, kind: e.kind, ref: e.ref,
      original_date: e.original_date, event_key: e.event_key,
    })),
    // Sorties retirées de la projection parce que le relevé les montre passées.
    // Trace visible : rien ne disparaît en silence de la projection.
    auto_cleared,
    // Montants / jours substitués par l'historique bancaire (apprentissage).
    learned,
    balance_age_days: balanceAgeDays,
    balance_stale_days: staleDays,
    balance_stale: balanceAgeDays == null || balanceAgeDays >= staleDays,
    horizon_days: horizon,
    threshold,
    ...projection,
    action_window,
    first_below_threshold: first_below_threshold && { date: first_below_threshold.date, balance: first_below_threshold.balance },
    first_negative: first_negative && { date: first_negative.date, balance: first_negative.balance },
    // Rétro-compat : le virement suggéré top-level = celui de la fenêtre d'action.
    suggested_transfer: action_window.suggested_transfer,
    // Paiements émis en attente de passage à la banque (le « vert » du fichier
    // Pmt_Suivi) : ce sont eux qui rendaient un virement Interac invisible.
    pending_payments: events.filter(e => e.kind === 'payment').map(e => ({
      id: e.ref, label: e.label, amount: e.amount, date: e.date,
      original_date: e.original_date || null, achat_id: e.achat_id || null,
    })),
    covered_recurring,
    covered_bills,
    // Rentrées : ce qui est compté et POURQUOI c'est sûr, ce qui est écarté et
    // pourquoi. Le solde projeté ne doit jamais reposer sur de l'argent supposé.
    inflows: {
      counted: inflowCheck.counted,
      excluded: inflowCheck.excluded,
      total_counted: inflowCheck.total_counted,
      total_excluded: inflowCheck.total_excluded,
      stripe_synced_at: inflowCheck.stripe_synced_at,
      stripe_stale: inflowCheck.stale,
    },
    counts: {
      bills: bills.length, recurring: recurring.length, payouts: inflowCheck.counted.length,
      ar: sources.ar.length, mrr: sources.mrr.length,
      lt_debt: sources.lt_debt.length, vendor_sub: sources.vendor_sub.length,
    },
  }
}

// ── Passé réel : mouvements bancaires déjà passés au compte ──────────────────
// La projection ne connaît que l'avenir (elle repart d'aujourd'hui). Le passé
// réel vient du relevé bancaire importé dans le rapprochement (/rapprochement) :
// c'est la seule source de vérité sur ce qui est VRAIMENT sorti et entré chaque
// jour. Même forme que `days` de la projection ({date, events, delta}) pour que
// la liste et le calendrier de la page Trésorerie affichent les deux sans
// traitement particulier.
//
// Pas de solde de clôture : le compte BNC CAD est balayé chaque jour par la
// marge de crédit (DEBOURSE / REMB. MCR), son solde bancaire tourne autour de
// 0 $ et n'a rien à voir avec le « solde disponible » projeté. Ce qui est
// comparable jour à jour, c'est le flux — entrées, sorties, net.
// Le compte est balayé chaque jour par la marge de crédit : « DEBOURSE MCR »
// (tirage) et « REMB. MCR » / « REMB, MCR » (remboursement) ne sont ni des
// dépenses ni des rentrées, seulement le va-et-vient avec la marge — 864 k$
// tirés contre 832 k$ remboursés depuis 2024. Comptés dans les totaux, ils
// écrasent tout : le net d'une journée tombe à ±0,50 $ et « ce qui est sorti »
// devient illisible. Ils restent listés (c'est le relevé), mais hors totaux.
// « INTERETS MCR » n'est PAS un transfert : c'est un vrai frais, il compte.
const MARGIN_RE = /^(?:deboursé?|debourse|remb)[.,]?\s*mcr$/i
export const TREASURY_BANK_ACCOUNT = 'BNC CAD'

// ── Couche « attendu » du passé ──────────────────────────────────────────────
// Le relevé bancaire est importé à la main (/rapprochement) : les derniers jours
// n'y sont jamais encore. Sans cette couche, une sortie déjà tombée disparaît de
// TOUTE la page : la projection repart d'aujourd'hui (elle ne regarde jamais en
// arrière) et le passé ne connaît que le relevé. C'est ce qui rendait le loyer du
// 1er août invisible dès le 2 — le même trou que l'incident du 1er août 2026,
// vu depuis le passé cette fois.
//
// On reprojette donc dans la fenêtre passée ce que l'ERP savait devoir tomber,
// puis on l'apparie au relevé :
//   - apparié      → le mouvement réel suffit (il porte le libellé attendu) ;
//   - non apparié et postérieur à la couverture du relevé → « attendu » ;
//   - non apparié dans une période couverte → « absent du relevé » : soit le
//     prélèvement n'a pas eu lieu, soit son montant a changé — à vérifier.
//
// Volontairement limité aux mouvements dont la DATE est connue d'avance :
// récurrentes et payouts Stripe arrivés. Les factures fournisseurs sont exclues
// — leur date de paiement réelle n'a rien à voir avec l'échéance, elles
// produiraient un « absent du relevé » systématique.
const MATCH_DAY_WINDOW = 3
const dayDiff = (a, b) => Math.abs((parseDay(a) - parseDay(b)) / (24 * 3600 * 1000))
// Élargit une borne de n jours : le relevé doit être lu au-delà de la fenêtre
// demandée pour que l'appariement à ±MATCH_DAY_WINDOW jours ait de la matière.
// Sans ça, la modale d'une journée (from = to) déclarait « absent du relevé » un
// prélèvement pourtant passé le surlendemain.
const padDay = (iso, n) => {
  const d = parseDay(iso)
  if (!d) return String(iso).slice(0, 10)
  d.setDate(d.getDate() + n)
  return isoDate(d)
}
// Tolérance d'appariement : 1 % ou 1 $, le plus grand (frais bancaires, arrondi).
const amountsMatch = (a, b) => Math.abs(Math.abs(a) - Math.abs(b)) <= Math.max(1, Math.abs(b) * 0.01)

// Statut d'un mouvement attendu qui n'a pas été retrouvé au relevé. Quatre
// natures très différentes, qu'il ne faut surtout pas confondre :
//   - `cleared`          : confirmé sorti à la main (bouton « déjà sorti ») ;
//   - `still_due`        : daté à partir de la saisie du solde → la projection le
//                          reprojette aujourd'hui, il est déjà compté ailleurs ;
//   - `pending_statement`: le relevé n'est pas importé jusque-là (normal) ;
//   - `missing`          : introuvable dans une période couverte → anomalie
//                          (prélèvement non passé, ou montant changé).
export function expectedStatus(exp, { coverageTo = null, balanceDay = null, cleared = null } = {}) {
  const key = exp.event_key || `${exp.kind}:${exp.ref || '-'}:${exp.date}`
  if (cleared?.has(key)) return 'cleared'
  if (balanceDay && exp.date >= balanceDay) return 'still_due'
  if (coverageTo && exp.date > coverageTo) return 'pending_statement'
  return 'missing'
}

// Écart relatif toléré au second passage : le montant d'une récurrente est un
// ARRONDI de gestion (paie 25 000 $ pour 21 542,85 $ réellement débités, dette
// BDC 8 874 $ pour 8 658,52 $). Sans ce passage, ces mouvements pourtant bien
// passés au compte étaient déclarés « absents du relevé » chaque quinzaine et
// l'alerte perdait tout crédit. Apparié mais signalé : c'est l'occasion de
// corriger le montant de la récurrente.
const LOOSE_MATCH_RATIO = 0.25

// Apparie les mouvements attendus aux mouvements réels du relevé, en deux
// passages (les appariements francs d'abord, pour ne pas qu'un appariement
// approximatif vole le mouvement d'un autre attendu) :
//   1. montant à 1 % / 1 $ près, date à ±MATCH_DAY_WINDOW jours ;
//   2. même fenêtre de date, montant à LOOSE_MATCH_RATIO près, le candidat le
//      plus proche — marqué `approx` avec l'écart.
// Un mouvement réel ne sert qu'une fois. Pur : rien n'est muté.
// Retourne { matched: [[réel, attendu, {approx, variance}]], unmatched: [attendu+statut] }.
export function reconcileExpected(expectedEvents, actualEvents, opts = {}) {
  const used = new Set()
  const matched = []
  const candidates = exp => actualEvents
    .map((a, i) => ({ a, i }))
    .filter(({ a, i }) => !used.has(i) && a.kind !== 'margin' && !a.expected
      && Math.sign(a.amount) === Math.sign(exp.amount)
      && dayDiff(a.date, exp.date) <= MATCH_DAY_WINDOW)
  const take = (exp, { a, i }, approx) => {
    used.add(i)
    matched.push([a, exp, { approx, variance: Math.round((a.amount - exp.amount) * 100) / 100 }])
  }

  let rest = expectedEvents
  for (const pass of ['exact', 'loose']) {
    const remaining = []
    for (const exp of rest) {
      const pool = candidates(exp)
      const hit = pass === 'exact'
        ? pool.find(({ a }) => amountsMatch(exp.amount, a.amount))
        // Le plus proche en montant, dans la limite de l'écart relatif toléré.
        : pool
          .filter(({ a }) => Math.abs(a.amount - exp.amount) <= Math.abs(exp.amount) * LOOSE_MATCH_RATIO)
          .sort((x, y) => Math.abs(x.a.amount - exp.amount) - Math.abs(y.a.amount - exp.amount))[0]
      if (hit) take(exp, hit, pass === 'loose')
      else remaining.push(exp)
    }
    rest = remaining
  }

  const unmatched = rest.map(exp => ({
    ...exp, expected: true,
    event_key: exp.event_key || `${exp.kind}:${exp.ref || '-'}:${exp.date}`,
    expected_status: expectedStatus(exp, opts),
  }))
  return { matched, unmatched }
}

export function expectedPastEvents({ fromIso, toIso }) {
  const events = []
  const recurring = db.prepare(
    'SELECT * FROM recurring_outflows WHERE deleted_at IS NULL AND active = 1'
  ).all()
  for (const r of recurring) {
    if (!(Number(r.amount) > 0)) continue
    const base = { amount: -Number(r.amount), label: r.label, kind: 'recurring', ref: r.id }
    const dates = r.variable_amount
      // Montant valable pour une seule occurrence (voir variableOccurrence).
      ? [variableOccurrence(r, fromIso, toIso)].filter(Boolean)
      : expandRecurring(r, fromIso, toIso)
    for (const date of dates) {
      // Même règle que la projection : quand la vraie facture / le vrai paiement
      // du fournisseur existe, la récurrente n'est que sa doublure. Sans ça le
      // 1er août 2026 affichait « Loyer 6 115,89 » ET « Les Jardins d'Inverness
      // 5 748,75 » — les 11 864,64 $ fantômes de l'incident, cette fois dans le passé.
      if (r.vendor_match && recurringCoverage(r.vendor_match, date)) continue
      events.push({ ...base, date })
    }
  }
  // Paiements émis dans la fenêtre (passés à la banque ou non) : ils portent une
  // date de sortie certaine, c'est exactement ce que le passé doit montrer — un
  // virement Interac du 1er août n'apparaissait sinon nulle part avant que le
  // relevé ne soit importé.
  const pmts = db.prepare(`
    SELECT id, payment_date, direction, amount, label, cleared_at FROM treasury_payments
    WHERE deleted_at IS NULL AND COALESCE(account, 'BNC CAD') = ? AND COALESCE(currency, 'CAD') = 'CAD'
      AND payment_date >= ? AND payment_date <= ?
  `).all(TREASURY_BANK_ACCOUNT, fromIso, toIso)
  for (const p of pmts) {
    events.push({
      date: String(p.payment_date).slice(0, 10),
      amount: p.direction === 'in' ? Number(p.amount) : -Number(p.amount),
      label: p.label || 'Paiement', kind: 'payment', ref: p.id,
    })
  }
  // Payouts Stripe déjà versés : entrées dont la date est certaine.
  const payouts = db.prepare(`
    SELECT stripe_id, amount, arrival_date FROM stripe_payouts
    WHERE status = 'paid' AND LOWER(COALESCE(currency, 'cad')) = 'cad'
      AND arrival_date >= ? AND arrival_date <= ?
  `).all(fromIso, toIso)
  for (const p of payouts) {
    events.push({
      date: String(p.arrival_date).slice(0, 10), amount: Number(p.amount),
      label: 'Payout Stripe', kind: 'payout', ref: p.stripe_id,
    })
  }
  return events.sort((a, b) => a.date.localeCompare(b.date))
}

export function computeActuals({ from, to, expected = true } = {}) {
  const account = db.prepare(
    'SELECT id, name FROM bank_accounts WHERE name = ? AND deleted_at IS NULL'
  ).get(TREASURY_BANK_ACCOUNT) || null
  // Sans compte bancaire (ou sans relevé importé), la couche « attendu » reste
  // seule : mieux vaut annoncer le loyer non confirmé que rien du tout.
  const cov = account ? db.prepare(`
    SELECT MIN(txn_date) AS from_date, MAX(txn_date) AS to_date FROM bank_transactions
    WHERE account_id = ? AND deleted_at IS NULL
  `).get(account.id) || {} : {}
  const rows = !account ? [] : db.prepare(`
    SELECT id, txn_date, description, reference, amount, status, matched_type, matched_id,
           qb_txn_type, qb_txn_id
    FROM bank_transactions
    WHERE account_id = ? AND deleted_at IS NULL AND txn_date >= ? AND txn_date <= ?
    ORDER BY txn_date, created_at
  `).all(account.id, padDay(from, -MATCH_DAY_WINDOW), padDay(to, MATCH_DAY_WINDOW))

  // Libellé lisible : le document apparié quand il existe (fournisseur, client,
  // payout), sinon le libellé brut du relevé.
  const achat = db.prepare('SELECT vendor, quickbooks_id, type FROM achats_fournisseurs WHERE id=?')
  const receipt = db.prepare('SELECT company, quickbooks_id, quickbooks_type FROM sale_receipts WHERE id=?')
  const payout = db.prepare('SELECT stripe_id FROM stripe_payouts WHERE id=?')
  const byDate = new Map()
  for (const t of rows) {
    let label = (t.description || '').trim() || 'Mouvement bancaire'
    let ref = null, kind = MARGIN_RE.test(label) ? 'margin' : 'bank'
    if (t.matched_type === 'achat' && t.matched_id) {
      const doc = achat.get(t.matched_id)
      if (doc) { label = doc.vendor || label; kind = 'bill'; ref = t.matched_id }
    } else if (t.matched_type === 'receipt' && t.matched_id) {
      const doc = receipt.get(t.matched_id)
      if (doc) { label = doc.company || label; kind = 'receipt'; ref = t.matched_id }
    } else if (t.matched_type === 'stripe_payout' && t.matched_id) {
      // La fiche payout s'ouvre par stripe_id ; le rapprochement stocke l'id interne.
      label = 'Payout Stripe'; kind = 'payout'
      ref = payout.get(t.matched_id)?.stripe_id || null
    }
    const date = String(t.txn_date).slice(0, 10)
    if (!byDate.has(date)) byDate.set(date, [])
    byDate.get(date).push({
      date, amount: Number(t.amount), label, kind, ref,
      actual: true,
      txn_id: t.id,
      bank_label: (t.description || '').trim() || null,
      status: t.status,
      qb_url: t.qb_txn_type && t.qb_txn_id ? qbEntityUrl(t.qb_txn_type, t.qb_txn_id) : null,
    })
  }

  // ── Appariement de l'attendu au relevé ─────────────────────────────────────
  const coverageTo = cov.to_date || null
  const fromDay = String(from).slice(0, 10), toDay = String(to).slice(0, 10)
  if (expected) {
    // Un mouvement attendu peut déjà être pris en charge ailleurs sur la page :
    //   - daté à partir de la saisie du solde → la projection le reprojette
    //     aujourd'hui (bandeau ambre « encore dû ») : on le dit ici plutôt que
    //     de crier « absent du relevé » sur le même mouvement ;
    //   - confirmé « déjà sorti » à la main → il n'est plus attendu.
    const balanceRow = db.prepare('SELECT noted_at FROM treasury_balances ORDER BY noted_at DESC LIMIT 1').get()
    const balanceDay = balanceRow ? isoDate(new Date(balanceRow.noted_at)) : null
    const cleared = new Set(db.prepare('SELECT event_key FROM treasury_cleared_events').all().map(r => r.event_key))
    // Un paiement coché « passé à la banque » est confirmé sorti : il ne doit pas
    // être annoncé « absent du relevé » quand le relevé n'est pas encore importé.
    for (const p of db.prepare(`
      SELECT id, payment_date FROM treasury_payments
      WHERE deleted_at IS NULL AND cleared_at IS NOT NULL AND payment_date >= ? AND payment_date <= ?
    `).all(fromDay, toDay)) cleared.add(`payment:${p.id}:${String(p.payment_date).slice(0, 10)}`)
    const { matched, unmatched } = reconcileExpected(
      expectedPastEvents({ fromIso: fromDay, toIso: toDay }),
      [...byDate.values()].flat(),
      { coverageTo, balanceDay, cleared },
    )
    // Le mouvement réel porte désormais le nom de ce qu'on attendait : le relevé
    // dit « PAIEMENT PREAUTORISE », l'utilisateur cherche « Loyer ». Un
    // appariement approximatif expose en plus le montant attendu et l'écart —
    // c'est le signal « le montant de la récurrente est à ajuster ».
    for (const [hit, exp, m] of matched) {
      hit.expected_label = exp.label
      hit.expected_kind = exp.kind
      hit.expected_ref = exp.ref
      if (m.approx) {
        hit.expected_amount = exp.amount
        hit.expected_variance = m.variance
      }
    }
    for (const exp of unmatched) {
      if (!byDate.has(exp.date)) byDate.set(exp.date, [])
      byDate.get(exp.date).push(exp)
    }
  }

  // Les jours de marge (lus au-delà de la fenêtre pour l'appariement seulement)
  // ne sortent pas d'ici : la réponse couvre exactement [from, to].
  const days = [...byDate.entries()]
    .filter(([date]) => date >= fromDay && date <= toDay)
    .sort((a, b) => a[0].localeCompare(b[0])).map(([date, events]) => {
    const real = events.filter(e => !e.expected && e.kind !== 'margin')
    const inflow = real.filter(e => e.amount > 0).reduce((s, e) => s + e.amount, 0)
    const outflow = real.filter(e => e.amount < 0).reduce((s, e) => s + e.amount, 0)
    const margin = events.filter(e => e.kind === 'margin' && !e.expected).reduce((s, e) => s + e.amount, 0)
    // Attendu non confirmé : compté à part du réel, jamais mélangé dedans — le
    // relevé reste la seule vérité, l'attendu n'est qu'un rappel de ce qui doit
    // (ou devait) tomber.
    // « encore dû » est déjà compté dans la projection d'aujourd'hui et
    // « cleared » a été confirmé sorti : listés, mais hors totaux de l'attendu,
    // sinon le même dollar serait compté deux fois sur la page.
    const exp = events.filter(e => e.expected && ['pending_statement', 'missing'].includes(e.expected_status))
    const expIn = exp.filter(e => e.amount > 0).reduce((s, e) => s + e.amount, 0)
    const expOut = exp.filter(e => e.amount < 0).reduce((s, e) => s + e.amount, 0)
    const r2 = n => Math.round(n * 100) / 100
    return {
      date, events,
      delta: r2(inflow + outflow),
      inflow: r2(inflow),
      outflow: r2(outflow),
      // Va-et-vient avec la marge de crédit, hors totaux (voir MARGIN_RE).
      margin: r2(margin),
      expected_inflow: r2(expIn),
      expected_outflow: r2(expOut),
      expected_delta: r2(expIn + expOut),
      expected_missing: exp.filter(e => e.expected_status === 'missing').length,
      actual: true,
    }
  })
  return {
    account: account ? { id: account.id, name: account.name } : null, days,
    coverage_from: cov.from_date || null, coverage_to: coverageTo,
  }
}

// Point bas et virement suggéré sur les `windowDays` premiers jours d'une série
// quotidienne. Virement arrondi au 1000 $ supérieur (procédure : « le montant
// requis et + »).
export function actionWindowStats(days, windowDays, threshold) {
  const slice = days.slice(0, windowDays + 1)
  let min = { balance: Infinity, date: null }
  for (const d of slice) if (d.balance < min.balance) min = { balance: d.balance, date: d.date }
  if (!Number.isFinite(min.balance)) min = { balance: 0, date: null }
  const shortfall = threshold - min.balance
  return {
    days: windowDays,
    min_balance: min.balance,
    min_date: min.date,
    suggested_transfer: shortfall > 0 ? Math.ceil(shortfall / 1000) * 1000 : 0,
  }
}

// ── Snapshots (mémoire du passé) ─────────────────────────────────────────────
// La projection est recalculée à partir d'aujourd'hui : sans photo persistée,
// il est impossible de savoir après coup ce que le système annonçait un jour
// donné — donc impossible de diagnostiquer un écart. Une photo est prise à
// chaque exécution de l'alerte (cron quotidien + saisie de solde).

export function saveSnapshot(proj, trigger) {
  const id = randomUUID()
  db.prepare(`
    INSERT INTO treasury_snapshots (
      id, snapshot_date, trigger, scenario, balance_entry_id, start_balance, balance_noted_at,
      threshold, min_balance, min_date, action_days, action_min_balance, action_min_date,
      first_negative_date, first_negative_balance, suggested_transfer, days
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    id, proj.days[0]?.date || null, trigger || null, proj.scenario,
    proj.balance_entry?.id || null, proj.balance_entry?.balance ?? null, proj.balance_entry?.noted_at || null,
    proj.threshold, proj.min_balance, proj.min_date,
    proj.action_window.days, proj.action_window.min_balance, proj.action_window.min_date,
    proj.first_negative?.date || null, proj.first_negative?.balance ?? null,
    proj.action_window.suggested_transfer,
    JSON.stringify(proj.days),
  )
  // Une photo pèse quelques kilo-octets (série quotidienne complète) et il en
  // naît 2-3 par jour : au-delà d'un an l'intérêt de post-mortem est nul.
  db.prepare(`DELETE FROM treasury_snapshots WHERE created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-400 days')`).run()
  return id
}

// Dernière photo prise STRICTEMENT avant `beforeIso` (timestamp ISO).
export function lastSnapshotBefore(beforeIso) {
  return db.prepare(
    'SELECT * FROM treasury_snapshots WHERE created_at < ? ORDER BY created_at DESC LIMIT 1'
  ).get(beforeIso) || null
}

// Solde que la photo `snap` annonçait pour le jour `dayIso` (null hors horizon).
export function predictedBalanceFor(snap, dayIso) {
  if (!snap) return null
  let days = []
  try { days = JSON.parse(snap.days || '[]') } catch { return null }
  const hit = days.find(d => d.date === dayIso)
  return hit ? hit.balance : null
}

// ── Réconciliation prévu / réel ──────────────────────────────────────────────
// Un solde saisi est la vérité terrain : le comparer à ce que la projection
// annonçait pour ce jour-là révèle immédiatement tout mouvement que l'ERP ne
// connaissait pas (facture pas encore synchronisée de QB, prélèvement inconnu,
// récurrente manquante…). C'est le contrôle qui manquait le 1er août 2026.
export function reconcileBalanceEntry(entryId) {
  const entry = db.prepare('SELECT * FROM treasury_balances WHERE id = ?').get(entryId)
  if (!entry) return null
  const snap = lastSnapshotBefore(entry.noted_at)
  const dayIso = isoDate(new Date(entry.noted_at))
  const predicted = predictedBalanceFor(snap, dayIso)
  if (predicted == null) {
    db.prepare('UPDATE treasury_balances SET predicted_balance = NULL, variance = NULL, predicted_from = ? WHERE id = ?')
      .run(snap?.created_at || null, entryId)
    return { entry, predicted: null, variance: null, snapshot: snap }
  }
  const variance = Math.round((Number(entry.balance) - predicted) * 100) / 100
  db.prepare('UPDATE treasury_balances SET predicted_balance = ?, variance = ?, predicted_from = ? WHERE id = ?')
    .run(predicted, variance, snap.created_at, entryId)
  // Mouvements que la photo attendait entre sa date et le jour de la saisie :
  // les candidats naturels pour expliquer l'écart.
  let expected = []
  try {
    expected = JSON.parse(snap.days || '[]')
      .filter(d => d.date >= snap.snapshot_date && d.date <= dayIso)
      .flatMap(d => (d.events || []).map(e => ({ date: d.date, label: e.label, amount: e.amount, kind: e.kind })))
  } catch {}
  return { entry, predicted, variance, snapshot: snap, expected }
}

// ── Alerte ───────────────────────────────────────────────────────────────────

function fmtCad(n) {
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(n)
}

// « 2026-08-08 » → « 8 août » (date-only, sans conversion de fuseau)
function fmtDateFr(isoDate) {
  const [y, m, d] = String(isoDate).split('-').map(Number)
  if (!y || !m || !d) return String(isoDate)
  return new Intl.DateTimeFormat('fr-CA', { day: 'numeric', month: 'long', timeZone: 'UTC' })
    .format(new Date(Date.UTC(y, m - 1, d)))
}

// Décide si la situation mérite un envoi Slack — fonction pure (testable), la
// seule porte du canal comptabilité pour la trésorerie.
//
// Mode par défaut (`slack_negative_only` ≠ '0') : SEUL un solde projeté NÉGATIF
// d'ici `slack_negative_days` jours (défaut 3) notifie. Un point bas sous le
// seuil de confort, ou un découvert plus lointain, restent en VEILLE — visibles
// sur la page Trésorerie et dans le journal de l'automation, jamais sur Slack.
//
// Mode historique (`slack_negative_only` = '0') : seuil franchi d'ici
// `slack_urgent_days`, tout négatif de la fenêtre d'action, ou un négatif
// nouveau/plus proche que la photo précédente.
export function evaluateSlackUrgency(proj, cfg, prevSnap = null) {
  const aw = proj.action_window
  if (String(cfg.slack_negative_only ?? '1') !== '0') {
    const negDays = Math.max(0, Number(cfg.slack_negative_days ?? 3))
    const negSoon = proj.days.slice(0, negDays + 1).find(d => d.balance < 0) || null
    // uw sert au message et au virement suggéré : sur la fenêtre du découvert.
    const uw = actionWindowStats(proj.days, negDays, proj.threshold)
    return {
      urgent: !!negSoon,
      mode: 'negative_only',
      urgentDays: negDays,
      uw,
      reason: negSoon
        ? `découvert ${fmtCad(negSoon.balance)} le ${negSoon.date} (d'ici ${negDays} j)`
        : null,
      watch: negSoon ? null : (proj.first_negative
        ? `négatif ${fmtCad(proj.first_negative.balance)} le ${proj.first_negative.date}, au-delà de la fenêtre de ${negDays} j`
        : `point bas ${fmtCad(aw.min_balance)} le ${aw.min_date} (${aw.days} j) sous le seuil ${fmtCad(proj.threshold)} mais jamais négatif`),
    }
  }
  const urgentDays = Math.max(0, Number(cfg.slack_urgent_days ?? 2))
  const uw = actionWindowStats(proj.days, urgentDays, proj.threshold)
  const negativeInAction = proj.days.slice(0, aw.days + 1).some(d => d.balance < 0)
  const newNegative = !!proj.first_negative && (
    !prevSnap?.first_negative_date || proj.first_negative.date < prevSnap.first_negative_date
  )
  const urgent = uw.min_balance < proj.threshold || negativeInAction || newNegative
  return {
    urgent,
    mode: 'threshold',
    urgentDays,
    uw,
    reason: !urgent ? null : (newNegative && !negativeInAction && uw.min_balance >= proj.threshold
      ? `négatif ${fmtCad(proj.first_negative.balance)} le ${proj.first_negative.date} (hors fenêtre d'action, 1re notification)`
      : `urgence : ${fmtCad(uw.min_balance)} le ${uw.min_date} (d'ici ${urgentDays} j)`),
    watch: urgent ? null : `${aw.min_balance < proj.threshold
      ? `point bas ${fmtCad(aw.min_balance)} le ${aw.min_date} (${aw.days} j) sous le seuil ${fmtCad(proj.threshold)}`
      : `négatif ${fmtCad(proj.first_negative.balance)} le ${proj.first_negative.date} (hors fenêtre d'action de ${aw.days} j, déjà notifié)`}, ` +
      `mais rien sous le seuil ni de négatif d'ici ${urgentDays} j`,
  }
}

// Vérifie le solde projeté et alerte si sous le seuil. Anti-spam : au plus une
// alerte par 20 h (basé sur automation_logs). `force` court-circuite l'anti-spam.
export async function checkTreasuryAlert({ force = false, trigger = 'schedule' } = {}) {
  const t0 = Date.now()
  try {
    if (!isSystemAutomationActive(TREASURY_AUTOMATION_ID)) return { skipped: 'inactive' }
    const cfg = getTreasuryConfig()
    // Un paiement retrouvé au relevé cesse d'être projeté : on coche d'abord,
    // sinon l'alerte compte une deuxième fois une sortie déjà passée.
    try { autoClearFromBank({ accountName: TREASURY_BANK_ACCOUNT }) } catch {}
    // Rafraîchir Stripe quand la donnée des payouts a vieilli : sans ça, une
    // rentrée certaine serait écartée par prudence (projection trop basse) ou,
    // pire, un payout annulé resterait compté. L'alerte est le bon moment —
    // c'est elle qui décide s'il faut virer de l'argent.
    try { await refreshStalePayouts(cfg) } catch (e) { console.error('treasury: refresh payouts:', e.message) }
    // Alerte TOUJOURS sur le scénario certain : pas d'argent espéré au dénominateur.
    const proj = computeProjection({ scenario: 'certain' })
    // L'alerte ne regarde que la fenêtre d'action (gestion au fur et à mesure) :
    // un point bas lointain n'est pas actionnable et ne doit pas réveiller.
    const aw = proj.action_window
    // Un négatif projeté n'importe où sur l'horizon rend la situation alertable,
    // même si la fenêtre d'action reste confortable : la paie aux deux semaines
    // crée régulièrement un trou juste au-delà de 14 jours, qui restait
    // totalement muet (visible sur la page, jamais notifié).
    const below = aw.min_balance < proj.threshold || !!proj.first_negative

    // Photo AVANT d'enregistrer la nouvelle : sert à mesurer la dégradation.
    const prevSnap = lastSnapshotBefore(new Date().toISOString())
    saveSnapshot(proj, trigger)
    // Aggravation depuis la dernière photo : recul du point bas au-delà du
    // seuil de dégradation, ou apparition d'un négatif là où il n'y en avait
    // pas. Court-circuite l'anti-spam de 20 h — c'est précisément une
    // aggravation intra-journée qui a été avalée le 1er août 2026.
    const escalateDelta = Math.max(0, Number(cfg.escalate_delta) || 0)
    const worsened = !!prevSnap && (
      Number(aw.min_balance) < Number(prevSnap.action_min_balance) - escalateDelta ||
      (!!proj.first_negative && !prevSnap.first_negative_date)
    )

    // Rappel « solde périmé » : la projection ne vaut que si le solde réel est
    // saisi régulièrement. Throttle indépendant de l'alerte de seuil (20 h).
    let staleReminder = false
    if (proj.balance_stale) {
      const recentReminder = force ? null : db.prepare(`
        SELECT 1 FROM automation_logs
        WHERE automation_id = ? AND status = 'success' AND result LIKE 'RAPPEL%'
          AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-20 hours')
        LIMIT 1
      `).get(TREASURY_AUTOMATION_ID)
      if (!recentReminder) {
        const ageTxt = proj.balance_age_days == null
          ? 'aucun solde jamais saisi'
          : `dernier solde saisi il y a ${proj.balance_age_days} j (${String(proj.balance_entry.noted_at).slice(0, 10)})`
        const reminder =
          `:hourglass_flowing_sand: *Trésorerie BNC* — ${ageTxt}. ` +
          `La projection est périmée : noter le solde disponible réel sur la page Trésorerie.`
        // Log-only par défaut : la tuile ambre de la page Trésorerie suffit,
        // un rappel de saisie n'est pas une urgence et spammait le canal.
        let sent = 'journal seulement (stale_reminder_slack=0)'
        if (cfg.stale_reminder_slack === '1' && cfg.slack_webhook_env) {
          await sendSlackWebhook(cfg.slack_webhook_env, reminder)
          sent = `Slack (${cfg.slack_webhook_env})`
        }
        logSystemRun(TREASURY_AUTOMATION_ID, {
          status: 'success', duration_ms: Date.now() - t0, triggerData: { trigger },
          result: `RAPPEL — ${ageTxt} (seuil de fraîcheur ${proj.balance_stale_days} j) · envoyé : ${sent}`,
        })
        staleReminder = true
      }
    }

    if (!below) {
      logSystemRun(TREASURY_AUTOMATION_ID, {
        status: 'success', duration_ms: Date.now() - t0, triggerData: { trigger },
        result: `OK — point bas ${fmtCad(aw.min_balance)} le ${aw.min_date} sur ${aw.days} j (seuil ${fmtCad(proj.threshold)})`,
      })
      return { ok: true, alerted: false, stale_reminder: staleReminder, projection: proj }
    }

    // Décision d'envoi Slack (voir evaluateSlackUrgency) : par défaut, seul un
    // découvert projeté d'ici slack_negative_days jours notifie.
    const urg = evaluateSlackUrgency(proj, cfg, prevSnap)
    const { urgent, uw } = urg
    if (!urgent) {
      logSystemRun(TREASURY_AUTOMATION_ID, {
        status: 'success', duration_ms: Date.now() - t0, triggerData: { trigger },
        result: `VEILLE — ${urg.watch} → pas d'envoi Slack`,
      })
      return { ok: true, alerted: false, watch: true, projection: proj }
    }

    // Anti-spam 20 h — mais JAMAIS silencieux : la suppression est journalisée
    // (avant le 3 août 2026, la branche throttlée sortait sans écrire une ligne,
    // donc sans aucune trace de ce que la projection annonçait à ce moment-là),
    // et une aggravation matérielle la court-circuite.
    if (!force && !worsened) {
      const recent = db.prepare(`
        SELECT 1 FROM automation_logs
        WHERE automation_id = ? AND status = 'success' AND result LIKE 'ALERTE%'
          AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-20 hours')
        LIMIT 1
      `).get(TREASURY_AUTOMATION_ID)
      if (recent) {
        logSystemRun(TREASURY_AUTOMATION_ID, {
          status: 'success', duration_ms: Date.now() - t0, triggerData: { trigger },
          result: `THROTTLE — situation toujours alertable (point bas ${fmtCad(aw.min_balance)} le ${aw.min_date}` +
            `${proj.first_negative ? `, négatif le ${proj.first_negative.date}` : ''}) mais alerte déjà envoyée dans les 20 h ` +
            `et pas d'aggravation > ${fmtCad(escalateDelta)} → pas de nouvel envoi Slack`,
        })
        return { ok: true, alerted: false, throttled: true, projection: proj }
      }
    }

    // Le montant suggéré reste celui de la fenêtre d'action (14 j) : on vire une
    // fois de quoi tenir, pas juste de quoi passer les 2 prochains jours.
    // Le négatif projeté passe en tête : c'est l'information qui déclenche
    // l'action, et le point bas de la fenêtre d'urgence peut être encore positif.
    const headline = proj.first_negative
      ? `solde *NÉGATIF* ${fmtCad(proj.first_negative.balance)} le ${fmtDateFr(proj.first_negative.date)}`
      : `solde projeté ${fmtCad(uw.min_balance)} le ${fmtDateFr(uw.min_date)} (seuil ${fmtCad(proj.threshold)})`
    // Le virement de la fenêtre d'action vaut 0 quand le trou est juste au-delà
    // de 14 jours : on suggère alors de quoi couvrir ce trou, sinon le message
    // dirait « virer 0 $ » en annonçant un découvert.
    const transfer = aw.suggested_transfer > 0
      ? aw.suggested_transfer
      : proj.first_negative
        ? Math.ceil((proj.threshold - proj.first_negative.balance) / 1000) * 1000
        : 0
    const message =
      `:rotating_light: *Trésorerie BNC* — ${headline}.\n` +
      `Virer *${fmtCad(transfer)}* Venn → BNC (garder min 15 000 USD dans Venn)` +
      (aw.suggested_transfer > 0 ? '' : ` d'ici le ${fmtDateFr(proj.first_negative.date)}`) + '.' +
      (worsened ? `\n:arrow_down: Aggravation depuis la dernière vérification : point bas ${fmtCad(prevSnap.action_min_balance)} → ${fmtCad(aw.min_balance)}.` : '') +
      (proj.late_events.length
        ? `\n:clock3: ${proj.late_events.length} mouvement(s) daté(s) après la saisie du solde et encore dû(s) : ` +
          `${proj.late_events.map(e => `${e.label} ${fmtCad(e.amount)} (${e.original_date})`).join(', ')}.`
        : '') +
      // Rentrée écartée = solde projeté volontairement pessimiste : à dire,
      // sinon le virement suggéré paraît trop gros sans raison.
      (proj.inflows?.excluded?.length
        ? `\n:mag: ${fmtCad(proj.inflows.total_excluded)} de rentrée(s) Stripe NON comptée(s) faute de certitude : ` +
          `${proj.inflows.excluded.map(p => `${fmtCad(p.amount)} le ${p.date} (${p.reason})`).join(', ')}.`
        : '')

    let sent = 'aucun canal configuré'
    if (cfg.slack_webhook_env) {
      await sendSlackWebhook(cfg.slack_webhook_env, message)
      sent = `Slack (${cfg.slack_webhook_env})`
    }

    logSystemRun(TREASURY_AUTOMATION_ID, {
      status: 'success', duration_ms: Date.now() - t0, triggerData: { trigger },
      result: `ALERTE — ${urg.reason} · ` +
        `point bas ${fmtCad(aw.min_balance)} le ${aw.min_date} (${aw.days} j), ` +
        `virement suggéré ${fmtCad(transfer)}${worsened ? ' · aggravation depuis la dernière photo' : ''} · envoyé : ${sent}`,
    })
    return { ok: true, alerted: true, sent, stale_reminder: staleReminder, projection: proj }
  } catch (e) {
    logSystemRun(TREASURY_AUTOMATION_ID, {
      status: 'error', duration_ms: Date.now() - t0, triggerData: { trigger }, error: e,
    })
    console.error('treasury.checkTreasuryAlert:', e.message)
    return { error: e.message }
  }
}

// Réconcilie une saisie de solde contre la dernière projection et alerte si
// l'écart dépasse la tolérance. À appeler AVANT checkTreasuryAlert (qui prend
// une nouvelle photo) : la comparaison doit se faire sur la photo précédente.
//
// Un écart négatif = de l'argent est sorti sans que l'ERP le sache (facture pas
// encore synchronisée de QuickBooks, prélèvement inconnu, récurrente manquante).
// Un écart positif = la projection comptait une sortie qui n'a pas eu lieu, ou
// une rentrée non prévue. Les deux méritent un coup d'œil : c'est le seul
// contrôle qui ferme la boucle entre ce que le système croit et la banque.
export async function checkBalanceVariance(entryId, { trigger = 'saisie solde' } = {}) {
  const t0 = Date.now()
  try {
    const rec = reconcileBalanceEntry(entryId)
    if (!rec || rec.variance == null) return { ok: true, alerted: false, reason: 'aucune projection antérieure à comparer' }
    const cfg = getTreasuryConfig()
    const tol = Math.max(0, Number(cfg.variance_tolerance) || 0)
    const dayIso = isoDate(new Date(rec.entry.noted_at))
    if (Math.abs(rec.variance) <= tol) {
      logSystemRun(TREASURY_AUTOMATION_ID, {
        status: 'success', duration_ms: Date.now() - t0, triggerData: { trigger },
        result: `RÉCONCILIATION OK — solde réel ${fmtCad(rec.entry.balance)} le ${dayIso} vs projeté ${fmtCad(rec.predicted)} ` +
          `(écart ${fmtCad(rec.variance)}, tolérance ${fmtCad(tol)})`,
      })
      return { ok: true, alerted: false, ...rec }
    }
    const sign = rec.variance < 0 ? 'de moins' : 'de plus'
    const message =
      `:mag: *Trésorerie BNC — écart de réconciliation* : solde réel ${fmtCad(rec.entry.balance)} le ${fmtDateFr(dayIso)}, ` +
      `projeté ${fmtCad(rec.predicted)} → *${fmtCad(Math.abs(rec.variance))} ${sign}* que prévu.\n` +
      (rec.variance < 0
        ? 'Un mouvement inconnu de l\'ERP est passé au compte (facture pas encore synchronisée, prélèvement non enregistré).'
        : 'Une sortie prévue n\'a pas eu lieu, ou une rentrée non prévue est arrivée.') +
      ` Vérifier l'historique sur la page Trésorerie.`
    // Journal seulement par défaut : l'écart de réconciliation est de l'hygiène
    // de données, pas un découvert — il n'a plus sa place dans le canal
    // comptabilité (variance_slack=1 pour réactiver l'envoi).
    let sent = `journal seulement (variance_slack=${cfg.variance_slack ?? '0'})`
    if (cfg.variance_slack === '1' && cfg.slack_webhook_env) {
      await sendSlackWebhook(cfg.slack_webhook_env, message)
      sent = `Slack (${cfg.slack_webhook_env})`
    }
    logSystemRun(TREASURY_AUTOMATION_ID, {
      status: 'success', duration_ms: Date.now() - t0, triggerData: { trigger },
      result: `ÉCART — solde réel ${fmtCad(rec.entry.balance)} le ${dayIso} vs projeté ${fmtCad(rec.predicted)} ` +
        `(écart ${fmtCad(rec.variance)} > tolérance ${fmtCad(tol)}) · envoyé : ${sent}`,
    })
    return { ok: true, alerted: true, sent, ...rec }
  } catch (e) {
    logSystemRun(TREASURY_AUTOMATION_ID, {
      status: 'error', duration_ms: Date.now() - t0, triggerData: { trigger }, error: e,
    })
    console.error('treasury.checkBalanceVariance:', e.message)
    return { error: e.message }
  }
}

// Diagnostic (bouton de la page automation) : projection sans envoi.
export async function diagnoseTreasury() {
  const proj = computeProjection({ scenario: 'certain' })
  const cfg = getTreasuryConfig()
  const balanceInfo = proj.balance_entry
    ? `solde saisi ${fmtCad(proj.balance_entry.balance)} le ${String(proj.balance_entry.noted_at).slice(0, 10)}` +
      ` (il y a ${proj.balance_age_days} j${proj.balance_stale ? ` — ⚠️ périmé, seuil ${proj.balance_stale_days} j` : ''})`
    : '⚠️ aucun solde saisi (page Trésorerie)'
  const aw = proj.action_window
  return {
    summary: `${aw.min_balance < proj.threshold ? '🔴' : '✅'} Point bas ${fmtCad(aw.min_balance)} le ${aw.min_date} sur la fenêtre d'action de ${aw.days} j ` +
      `(seuil ${fmtCad(proj.threshold)}) · plein horizon ${proj.horizon_days} j : ${fmtCad(proj.min_balance)} le ${proj.min_date} (indicatif) — ${balanceInfo} · ` +
      `${proj.counts.bills} facture(s), ${proj.counts.recurring} récurrente(s), ${proj.counts.payouts} payout(s) certain(s)` +
      (proj.inflows?.excluded?.length ? ` · ⚠️ ${fmtCad(proj.inflows.total_excluded)} de rentrée(s) écartée(s) faute de certitude` : '') +
      (aw.suggested_transfer > 0 ? ` · virement suggéré ${fmtCad(aw.suggested_transfer)}` : '') +
      (cfg.slack_webhook_env ? '' : ' · ℹ️ aucun webhook Slack configuré (alerte loggée seulement)'),
  }
}
