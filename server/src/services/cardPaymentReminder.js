// Rappel mensuel « payer les cartes de crédit » (Visa CAD + Visa USD).
//
// Les soldes de cartes ont une échéance réelle vers le 26-27 du mois ; la date
// cible retenue est le 24, pour garder une marge. Le rappel
// n'est pas envoyé « X jours avant » : il est envoyé le DERNIER jour travaillé
// (mardi ou samedi) qui tombe encore à temps — c'est-à-dire le dernier mardi/
// samedi <= 25. Sinon un rappel envoyé un jour non travaillé se perd, et un
// rappel quotidien pendant une semaine spamme le canal.
//
// Exemples (jours travaillés : mardi + samedi, échéance le 25) :
//   août 2026    → 24 = lundi              → rappel le samedi 22
//   sept. 2026   → 24 = jeudi              → rappel le mardi 22
//   oct. 2026    → 24 = samedi             → rappel le samedi 24
//
// Le scan tourne tous les matins (cron dans index.js) et ne fait rien les
// autres jours — ni envoi ni log, pour ne pas noyer le journal de l'automation.
import db from '../db/database.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'

export const CARD_REMINDER_AUTOMATION_ID = 'sys_card_payment_reminder'

// Fuseau de référence : les jours travaillés sont ceux de l'utilisateur, pas
// ceux du serveur (qui tourne en UTC).
const TZ = 'America/Toronto'

export const CARD_REMINDER_DEFAULT_CONFIG = {
  cards: 'Visa CAD, Visa USD',   // libellés listés dans le rappel
  // Date CIBLE de paiement (jour du mois). L'échéance réelle des cartes est le
  // 26-27 ; on vise le 24 pour garder une marge.
  due_day: '24',
  work_days: '2,6',              // jours travaillés (0 = dimanche … 6 = samedi)
  // DM Slack perso d'Antoine Lambert (webhook dédié, distinct du canal compta).
  slack_webhook_env: 'SLACK_WEBHOOK_PERSO',
}

// Repli si le webhook perso n'est pas encore configuré : le rappel part quand
// même (mieux vaut un rappel sur le canal compta que pas de rappel du tout),
// mais le journal de l'automation le signale bruyamment.
const FALLBACK_WEBHOOK_ENV = 'SLACK_WEBHOOK_TREASURY'

export function getCardReminderConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get(CARD_REMINDER_AUTOMATION_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch {}
  const merged = { ...CARD_REMINDER_DEFAULT_CONFIG }
  for (const k of Object.keys(CARD_REMINDER_DEFAULT_CONFIG)) {
    if (cfg[k] != null && String(cfg[k]).trim() !== '') merged[k] = String(cfg[k]).trim()
  }
  return merged
}

// ── Calendrier ───────────────────────────────────────────────────────────────

/** Date civile (fuseau TZ) d'un instant, en `YYYY-MM-DD`. */
export function localDay(date = new Date(), timeZone = TZ) {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
}

// Un jour civil est manipulé comme un Date à midi UTC : pas de dérive de fuseau
// sur les additions de jours, et getUTCDay() donne le bon jour de semaine.
const dayToDate = iso => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''))
  return m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12)) : null
}
const dateToDay = d => d.toISOString().slice(0, 10)

export function parseWorkDays(spec) {
  const set = new Set(
    String(spec || '')
      .split(/[,\s]+/)
      .filter(s => /^\d+$/.test(s))
      .map(s => Number(s))
      .filter(n => Number.isInteger(n) && n >= 0 && n <= 6)
  )
  return set.size ? set : new Set([2, 6])
}

/** Prochain jour travaillé strictement après `dayIso`. */
export function nextWorkDay(dayIso, workDays) {
  const d = dayToDate(dayIso)
  if (!d) return null
  for (let i = 0; i < 7; i++) {
    d.setUTCDate(d.getUTCDate() + 1)
    if (workDays.has(d.getUTCDay())) return dateToDay(d)
  }
  return null
}

/**
 * `dayIso` est-il le dernier jour travaillé encore à temps pour l'échéance ?
 * Vrai si : jour travaillé, jour du mois <= dueDay, et le prochain jour
 * travaillé dépasse l'échéance (jour du mois > dueDay ou mois suivant).
 */
export function isReminderDay(dayIso, { dueDay, workDays }) {
  const d = dayToDate(dayIso)
  if (!d || !workDays.has(d.getUTCDay())) return false
  if (d.getUTCDate() > dueDay) return false
  const next = nextWorkDay(dayIso, workDays)
  if (!next) return false
  const nd = dayToDate(next)
  return nd.getUTCMonth() !== d.getUTCMonth() || nd.getUTCDate() > dueDay
}

/** Prochaine date de rappel à partir de `fromDayIso` (inclus). */
export function nextReminderDay(fromDayIso, opts) {
  const d = dayToDate(fromDayIso)
  if (!d) return null
  for (let i = 0; i < 400; i++) {
    const iso = dateToDay(d)
    if (isReminderDay(iso, opts)) return iso
    d.setUTCDate(d.getUTCDate() + 1)
  }
  return null
}

// Date d'échéance du mois de `dayIso` (bornée à la fin du mois).
function dueDateOf(dayIso, dueDay) {
  const d = dayToDate(dayIso)
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()
  return dateToDay(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), Math.min(dueDay, last), 12)))
}

const daysBetween = (a, b) => Math.round((dayToDate(b) - dayToDate(a)) / 86400000)

// « 2026-08-25 » → « mardi 25 août »
function fmtDateFr(dayIso) {
  const d = dayToDate(dayIso)
  if (!d) return String(dayIso)
  return new Intl.DateTimeFormat('fr-CA', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' }).format(d)
}

// ── Envoi ────────────────────────────────────────────────────────────────────

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

export function buildReminderMessage({ dayIso, cards, dueDay, workDays }) {
  const due = dueDateOf(dayIso, dueDay)
  const delta = daysBetween(dayIso, due)
  const next = nextWorkDay(dayIso, workDays)
  const appUrl = (process.env.APP_URL || 'https://customer.orisha.io').replace(/\/$/, '')
  // « à payer d'ici » et non « échéance » : due_day est une date CIBLE que se
  // fixe l'utilisateur (le 24), volontairement en avance sur l'échéance réelle
  // des cartes (26-27) pour garder une marge.
  const echeance = delta <= 0
    ? `à payer *aujourd'hui* (${fmtDateFr(due)})`
    : `à payer d'ici le *${fmtDateFr(due)}* (dans ${delta} j)`
  // La phrase « dernier jour travaillé à temps » n'est vraie que le jour du
  // rappel — un envoi forcé (bouton « Exécuter ») ne doit pas l'affirmer.
  const urgence = isReminderDay(dayIso, { dueDay, workDays })
    ? ` Dernier jour travaillé à temps : *aujourd'hui* (le prochain, ${fmtDateFr(next)}, serait en retard).`
    : ''
  return (
    `:credit_card: *Cartes à payer — ${cards}*\n` +
    `${echeance}.${urgence}\n` +
    `<${appUrl}/erp/comptabilite|Dashboard comptabilité> · <${appUrl}/erp/fournisseurs/abonnements|Abonnements fournisseurs>`
  )
}

// Déjà envoyé ce mois-ci ? (idempotence : un seul rappel par mois, même si le
// cron est rejoué ou le serveur redémarre plusieurs fois dans la journée)
function alreadySentThisMonth(dayIso) {
  const monthPrefix = dayIso.slice(0, 7)
  return !!db.prepare(`
    SELECT 1 FROM automation_logs
    WHERE automation_id = ? AND status = 'success' AND result LIKE 'RAPPEL%'
      AND substr(created_at, 1, 7) = ?
    LIMIT 1
  `).get(CARD_REMINDER_AUTOMATION_ID, monthPrefix)
}

/**
 * Scan quotidien. N'envoie (et ne logge) que le jour du rappel.
 * `force` court-circuite le test de date et l'idempotence mensuelle.
 */
export async function checkCardPaymentReminder({ force = false, trigger = 'schedule', today = null } = {}) {
  const t0 = Date.now()
  try {
    if (!isSystemAutomationActive(CARD_REMINDER_AUTOMATION_ID)) return { skipped: 'inactive' }
    const cfg = getCardReminderConfig()
    const dueDay = Math.min(31, Math.max(1, Number(cfg.due_day) || 25))
    const workDays = parseWorkDays(cfg.work_days)
    const dayIso = today || localDay()

    if (!force) {
      if (!isReminderDay(dayIso, { dueDay, workDays })) return { ok: true, sent: false, reason: 'pas le jour du rappel' }
      if (alreadySentThisMonth(dayIso)) return { ok: true, sent: false, reason: 'déjà envoyé ce mois-ci' }
    }

    const message = buildReminderMessage({ dayIso, cards: cfg.cards, dueDay, workDays })
    let sent = 'aucun canal configuré'
    if (cfg.slack_webhook_env) {
      const target = process.env[cfg.slack_webhook_env]
        ? cfg.slack_webhook_env
        : (process.env[FALLBACK_WEBHOOK_ENV] ? FALLBACK_WEBHOOK_ENV : cfg.slack_webhook_env)
      await sendSlackWebhook(target, message)
      sent = target === cfg.slack_webhook_env
        ? `Slack (${target})`
        : `⚠️ Slack (${target}) — repli, ${cfg.slack_webhook_env} non configuré dans server/.env`
    }
    // Seul un envoi planifié porte le préfixe RAPPEL : c'est lui qui consomme
    // l'idempotence du mois. Un envoi manuel (bouton « Exécuter ») ne doit pas
    // faire sauter le vrai rappel à venir.
    const scheduled = isReminderDay(dayIso, { dueDay, workDays })
    logSystemRun(CARD_REMINDER_AUTOMATION_ID, {
      status: 'success', duration_ms: Date.now() - t0, triggerData: { trigger, day: dayIso },
      result: `${scheduled ? 'RAPPEL' : 'ENVOI MANUEL'} — ${cfg.cards} à payer d'ici le ${dueDay} (${dayIso}) · envoyé : ${sent}`,
    })
    return { ok: true, sent: true, channel: sent, message }
  } catch (e) {
    logSystemRun(CARD_REMINDER_AUTOMATION_ID, {
      status: 'error', duration_ms: Date.now() - t0, triggerData: { trigger }, error: e,
    })
    console.error('cardPaymentReminder:', e.message)
    return { error: e.message }
  }
}

/** Diagnostic (bouton « Simuler ») : prochaine date de rappel + message, sans envoi. */
export function diagnoseCardPaymentReminder() {
  const cfg = getCardReminderConfig()
  const dueDay = Math.min(31, Math.max(1, Number(cfg.due_day) || 25))
  const workDays = parseWorkDays(cfg.work_days)
  const dayIso = localDay()
  const next = nextReminderDay(dayIso, { dueDay, workDays })
  const preview = buildReminderMessage({ dayIso: next, cards: cfg.cards, dueDay, workDays })
  const upcoming = []
  let cursor = next
  for (let i = 0; i < 3 && cursor; i++) {
    upcoming.push(fmtDateFr(cursor))
    cursor = nextReminderDay(nextWorkDay(cursor, workDays), { dueDay, workDays })
  }
  return {
    summary:
      `Prochain rappel : ${fmtDateFr(next)}${next === dayIso ? " (aujourd'hui)" : ''} · ` +
      `${cfg.cards} · date cible le ${dueDay} · jours travaillés ${[...workDays].sort().join(',')} · ` +
      (process.env[cfg.slack_webhook_env]
        ? `canal : ${cfg.slack_webhook_env}`
        : `⚠️ ${cfg.slack_webhook_env} absent de server/.env — repli sur ${FALLBACK_WEBHOOK_ENV}`),
    prochains: upcoming,
    apercu: preview,
  }
}
