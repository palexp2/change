// Alerte « la banque ne parle plus ».
//
// Une connexion bancaire ne tombe pas en panne bruyamment : elle se tait. Du
// 2 au 6 septembre 2026, la BNC n'a plus rien livré à Plaid — aucune erreur,
// aucun écran rouge, simplement plus de transactions. Tout ce qui en dépend
// (rapprochement, solde de la projection, débit de la paie) travaillait sur
// des données figées sans le dire.
//
// Ce passage regarde la seule chose qui compte : depuis quand la BANQUE a
// livré pour la dernière fois (`last_successful_update` chez Plaid), pas
// depuis quand NOUS avons demandé. Au-delà du seuil, il notifie dans Boréal
// et, si un canal Slack est configuré, sur Slack.
import db from '../db/database.js'
import { listItems, itemHealth } from '../connectors/plaid.js'
import { createNotification } from './notifications.js'
import { logSystemRun } from './systemAutomations.js'
import { postSlack } from './slack.js'

export const PLAID_SILENCE_AUTOMATION_ID = 'sys_plaid_silence_alert'

export const PLAID_SILENCE_DEFAULT_CONFIG = {
  // Une banque livre normalement plusieurs fois par jour. 36 h laisse passer
  // une fin de semaine creuse sans crier ; au-delà, c'est anormal.
  silence_hours: '36',
  // Anti-spam : une même connexion ne re-notifie pas avant ce délai.
  repeat_hours: '24',
  // Qui est prévenu dans Boréal : rôles, séparés par des virgules. Les rôles
  // existants sont admin, sales, support, ops — la comptabilité est tenue par
  // des admins, d'où ce défaut.
  notify_roles: 'admin',
  // Canal Slack (nom de la variable d'env). Vide = notification Boréal seule.
  slack_webhook_env: 'SLACK_WEBHOOK_TREASURY',
}

export function getSilenceConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get(PLAID_SILENCE_AUTOMATION_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch {}
  const merged = { ...PLAID_SILENCE_DEFAULT_CONFIG }
  for (const k of Object.keys(PLAID_SILENCE_DEFAULT_CONFIG)) {
    if (cfg[k] != null && String(cfg[k]).trim() !== '') merged[k] = String(cfg[k]).trim()
  }
  return merged
}

const hoursSince = iso => (Date.now() - new Date(iso).getTime()) / 3600e3

// Combien de temps en mots, sans précision inutile : « 4 jours », « 38 h ».
export function humanDuration(hours) {
  if (!Number.isFinite(hours)) return '?'
  if (hours < 48) return `${Math.round(hours)} h`
  return `${Math.round(hours / 24)} jours`
}

// Décision pure, testable : cette connexion mérite-t-elle une alerte ?
// `reauth` passe avant le silence — une autorisation expirée ne se répare pas
// toute seule, et le message n'est pas le même.
export function silenceVerdict(health, { silenceHours, now = Date.now() } = {}) {
  if (!health) return { alert: false }
  if (health.health_error) return { alert: false, reason: `état illisible : ${health.health_error}` }
  if (health.needs_reauth) {
    return { alert: true, kind: 'reauth', institution: health.institution_name, hours: null }
  }
  const last = health.last_successful_update
  if (!last) return { alert: false, reason: 'jamais livré' }
  const h = (now - new Date(last).getTime()) / 3600e3
  if (h < silenceHours) return { alert: false, hours: h }
  return { alert: true, kind: 'silence', institution: health.institution_name, hours: h, since: last }
}

function alertText(v) {
  if (v.kind === 'reauth') {
    return {
      title: `${v.institution} : connexion à réautoriser`,
      body: 'La banque demande une nouvelle autorisation. Tant qu\'elle n\'est pas refaite, aucune transaction n\'arrive : le rapprochement, le solde de la projection et le débit de la paie travaillent sur des données figées.',
    }
  }
  return {
    title: `${v.institution} : plus rien depuis ${humanDuration(v.hours)}`,
    body: `Dernière livraison le ${String(v.since).slice(0, 10)}. Les transactions n'arrivent plus : rapprochement, solde de trésorerie et débit de la paie sont figés depuis. Essayer « Réveiller la banque » sur la page Connecteurs ; si ça ne donne rien, refaire la connexion.`,
  }
}

function recipients(cfg) {
  const roles = cfg.notify_roles.split(',').map(r => r.trim()).filter(Boolean)
  if (!roles.length) return []
  const marks = roles.map(() => '?').join(',')
  return db.prepare(
    `SELECT id FROM users WHERE role IN (${marks}) AND deleted_at IS NULL AND COALESCE(active, 1) = 1`
  ).all(...roles).map(r => r.id)
}

// Dernière alerte envoyée pour cette connexion (anti-spam), lue dans les
// notifications déjà posées — pas de table de plus à tenir.
function lastAlertHours(itemId) {
  const row = db.prepare(
    `SELECT MAX(created_at) c FROM notifications WHERE type = ?`
  ).get(`plaid_silence:${itemId}`)
  return row?.c ? hoursSince(row.c) : Infinity
}

export async function checkPlaidSilence({ force = false, trigger = 'planifié' } = {}) {
  const t0 = Date.now()
  const cfg = getSilenceConfig()
  const silenceHours = Number(cfg.silence_hours) || 36
  const repeatHours = Number(cfg.repeat_hours) || 24
  const out = { checked: [], alerted: [], skipped: [] }

  try {
    for (const item of listItems()) {
      let health
      try {
        health = await itemHealth(item.itemId)
      } catch (e) {
        health = { institution_name: item.institution_name, health_error: e?.response?.data?.error_message || e.message }
      }
      const v = silenceVerdict(health, { silenceHours })
      out.checked.push({
        institution: health.institution_name || item.itemId,
        last_successful_update: health.last_successful_update || null,
        hours: v.hours != null ? Math.round(v.hours) : null,
        alert: !!v.alert, kind: v.kind || null, reason: v.reason || null,
      })
      if (!v.alert) continue
      const since = lastAlertHours(item.itemId)
      if (!force && since < repeatHours) {
        out.skipped.push({ institution: v.institution, reason: `déjà signalé il y a ${humanDuration(since)}` })
        continue
      }
      const { title, body } = alertText(v)
      for (const userId of recipients(cfg)) {
        createNotification({ userId, type: `plaid_silence:${item.itemId}`, title, body, link: '/connectors' })
      }
      const env = cfg.slack_webhook_env
      if (env && process.env[env]) {
        try {
          await postSlack(process.env[env], `⚠️ ${title}\n${body}`)
        } catch (e) {
          out.slack_error = e.message
        }
      }
      out.alerted.push({ institution: v.institution, kind: v.kind, hours: v.hours != null ? Math.round(v.hours) : null })
    }

    const summary = out.alerted.length
      ? out.alerted.map(a => a.kind === 'reauth' ? `${a.institution} : à réautoriser` : `${a.institution} : muette depuis ${humanDuration(a.hours)}`).join(' · ')
      : `${out.checked.length} connexion(s) à jour`
    // Journal silencieux quand tout va bien : une banque qui parle n'est pas
    // une nouvelle.
    if (out.alerted.length || out.skipped.length) {
      logSystemRun(PLAID_SILENCE_AUTOMATION_ID, {
        status: 'success', duration_ms: Date.now() - t0, triggerData: { trigger }, result: summary,
      })
    }
    return { ...out, summary }
  } catch (e) {
    logSystemRun(PLAID_SILENCE_AUTOMATION_ID, {
      status: 'error', duration_ms: Date.now() - t0, triggerData: { trigger }, error: e,
    })
    throw e
  }
}
