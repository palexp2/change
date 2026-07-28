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
// L'automation système `sys_treasury_alert` vérifie chaque jour (et à chaque
// saisie de solde) si le solde projeté passe sous le seuil configuré et envoie
// une alerte Slack avec le virement suggéré (procédure Venn).
import db from '../db/database.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'
import { qbEntityUrl } from '../connectors/quickbooks.js'

export const TREASURY_AUTOMATION_ID = 'sys_treasury_alert'

export const TREASURY_DEFAULT_CONFIG = {
  threshold: '5000',        // seuil d'alerte (CAD)
  horizon_days: '42',       // horizon d'affichage de la projection (jours)
  // Fenêtre d'ACTION : la trésorerie est gérée au fur et à mesure — seuls les
  // prochains jours comptent pour l'alerte et le virement suggéré. Le point bas
  // au-delà de cette fenêtre est affiché à titre indicatif seulement.
  alert_horizon_days: '14',
  // Fraîcheur du solde saisi : au-delà de ce nombre de jours sans nouvelle
  // saisie, la projection est considérée périmée (rappel Slack + tuile ambre).
  balance_stale_days: '7',
  // Webhook Slack (DM Antoine Lambert) — nom de la variable d'env dans server/.env.
  slack_webhook_env: 'SLACK_WEBHOOK_TREASURY',
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
export function expandRecurring(r, fromIso, toIso) {
  const from = parseDay(fromIso), to = parseDay(toIso)
  if (!from || !to) return []
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

export function computeProjection({ days = null, today = new Date() } = {}) {
  const cfg = getTreasuryConfig()
  const horizon = Math.min(120, Math.max(7, Number(days) || Number(cfg.horizon_days) || 42))
  const fromIso = isoDate(today)
  const end = new Date(today); end.setDate(end.getDate() + horizon)
  const toIso = isoDate(end)

  const balanceRow = db.prepare(
    'SELECT * FROM treasury_balances ORDER BY noted_at DESC LIMIT 1'
  ).get() || null

  const events = []

  // Factures fournisseurs CAD à payer → payées à la date d'échéance (processus
  // réel — l'ancienne « règle du mardi » du CTB - Suivi projetait trop tôt).
  // Échéance déjà passée : sortie projetée aujourd'hui (toujours due).
  const bills = db.prepare(`
    SELECT id, vendor, due_date, balance_due_cad, quickbooks_id FROM achats_fournisseurs
    WHERE type = 'bill' AND status NOT IN ('Payée', 'Annulée', 'Brouillon')
      AND balance_due_cad > 0 AND COALESCE(currency, 'CAD') = 'CAD'
  `).all()
  for (const b of bills) {
    if (!b.due_date) continue
    const prog = b.due_date >= fromIso ? new Date(`${b.due_date}T12:00:00`) : new Date(today)
    events.push({
      date: isoDate(prog), amount: -Number(b.balance_due_cad),
      label: b.vendor || 'Facture fournisseur', kind: 'bill', ref: b.id,
      // Lien direct vers l'écriture QuickBooks (null si pas encore publiée).
      qb_url: b.quickbooks_id ? qbEntityUrl('bill', b.quickbooks_id) : null,
    })
  }

  // Sorties récurrentes configurées.
  const recurring = db.prepare(
    'SELECT * FROM recurring_outflows WHERE deleted_at IS NULL AND active = 1'
  ).all()
  for (const r of recurring) {
    if (!(Number(r.amount) > 0)) continue
    if (r.variable_amount) {
      // Montant valable pour une seule occurrence (voir variableOccurrence).
      const date = variableOccurrence(r, fromIso, toIso)
      if (date) events.push({ date, amount: -Number(r.amount), label: r.label, kind: 'recurring', ref: r.id })
      continue
    }
    for (const date of expandRecurring(r, fromIso, toIso)) {
      events.push({ date, amount: -Number(r.amount), label: r.label, kind: 'recurring', ref: r.id })
    }
  }

  // Payouts Stripe CAD à venir (dépôt BNC).
  const payouts = db.prepare(`
    SELECT stripe_id, amount, arrival_date FROM stripe_payouts
    WHERE status IN ('pending', 'in_transit') AND LOWER(COALESCE(currency, 'cad')) = 'cad'
      AND arrival_date >= ? AND arrival_date <= ?
  `).all(fromIso, toIso)
  for (const p of payouts) {
    events.push({ date: String(p.arrival_date).slice(0, 10), amount: Number(p.amount), label: 'Payout Stripe', kind: 'payout', ref: p.stripe_id })
  }

  const projection = buildProjection({
    startBalance: balanceRow ? balanceRow.balance : 0,
    fromIso, toIso, events,
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
    balance_entry: balanceRow,
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
    counts: { bills: bills.length, recurring: recurring.length, payouts: payouts.length },
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

// ── Alerte ───────────────────────────────────────────────────────────────────

async function sendSlackWebhook(envName, text) {
  const url = process.env[envName]
  if (!url) throw new Error(`Variable d'environnement manquante : ${envName}`)
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (!resp.ok) throw new Error(`Slack HTTP ${resp.status}`)
}

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

// Vérifie le solde projeté et alerte si sous le seuil. Anti-spam : au plus une
// alerte par 20 h (basé sur automation_logs). `force` court-circuite l'anti-spam.
export async function checkTreasuryAlert({ force = false, trigger = 'schedule' } = {}) {
  const t0 = Date.now()
  try {
    if (!isSystemAutomationActive(TREASURY_AUTOMATION_ID)) return { skipped: 'inactive' }
    const cfg = getTreasuryConfig()
    const proj = computeProjection({})
    // L'alerte ne regarde que la fenêtre d'action (gestion au fur et à mesure) :
    // un point bas lointain n'est pas actionnable et ne doit pas réveiller.
    const aw = proj.action_window
    const below = aw.min_balance < proj.threshold

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
        let sent = 'aucun canal configuré'
        if (cfg.slack_webhook_env) {
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

    if (!force) {
      const recent = db.prepare(`
        SELECT 1 FROM automation_logs
        WHERE automation_id = ? AND status = 'success' AND result LIKE 'ALERTE%'
          AND created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-20 hours')
        LIMIT 1
      `).get(TREASURY_AUTOMATION_ID)
      if (recent) return { ok: true, alerted: false, throttled: true, projection: proj }
    }

    const message =
      `:rotating_light: *Trésorerie BNC* — solde projeté ${fmtCad(aw.min_balance)} le ${fmtDateFr(aw.min_date)} (seuil ${fmtCad(proj.threshold)}).\n` +
      `Virer *${fmtCad(aw.suggested_transfer)}* Venn → BNC (garder min 15 000 USD dans Venn).`

    let sent = 'aucun canal configuré'
    if (cfg.slack_webhook_env) {
      await sendSlackWebhook(cfg.slack_webhook_env, message)
      sent = `Slack (${cfg.slack_webhook_env})`
    }

    logSystemRun(TREASURY_AUTOMATION_ID, {
      status: 'success', duration_ms: Date.now() - t0, triggerData: { trigger },
      result: `ALERTE — point bas ${fmtCad(aw.min_balance)} le ${aw.min_date} (${aw.days} j), virement suggéré ${fmtCad(aw.suggested_transfer)} · envoyé : ${sent}`,
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

// Diagnostic (bouton de la page automation) : projection sans envoi.
export async function diagnoseTreasury() {
  const proj = computeProjection({})
  const cfg = getTreasuryConfig()
  const balanceInfo = proj.balance_entry
    ? `solde saisi ${fmtCad(proj.balance_entry.balance)} le ${String(proj.balance_entry.noted_at).slice(0, 10)}` +
      ` (il y a ${proj.balance_age_days} j${proj.balance_stale ? ` — ⚠️ périmé, seuil ${proj.balance_stale_days} j` : ''})`
    : '⚠️ aucun solde saisi (page Trésorerie)'
  const aw = proj.action_window
  return {
    summary: `${aw.min_balance < proj.threshold ? '🔴' : '✅'} Point bas ${fmtCad(aw.min_balance)} le ${aw.min_date} sur la fenêtre d'action de ${aw.days} j ` +
      `(seuil ${fmtCad(proj.threshold)}) · plein horizon ${proj.horizon_days} j : ${fmtCad(proj.min_balance)} le ${proj.min_date} (indicatif) — ${balanceInfo} · ` +
      `${proj.counts.bills} facture(s), ${proj.counts.recurring} récurrente(s), ${proj.counts.payouts} payout(s)` +
      (aw.suggested_transfer > 0 ? ` · virement suggéré ${fmtCad(aw.suggested_transfer)}` : '') +
      (cfg.slack_webhook_env ? '' : ' · ℹ️ aucun webhook Slack configuré (alerte loggée seulement)'),
  }
}
