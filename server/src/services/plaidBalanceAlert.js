// Alerte « le solde de la projection ne bouge plus ».
//
// Histoire de ce passage : il surveillait d'abord les TRANSACTIONS livrées par
// la banque (silence du 2 au 6 septembre 2026). Depuis le 12 septembre, Plaid
// n'apporte plus les transactions du tout — c'est le fichier TRX_Orisha qui
// alimente le rapprochement — et l'alerte criait pour un silence voulu.
// Décision de Charles le 2026-09-29 : ne surveiller QUE ce qui dépend encore
// de la banque connectée, le SOLDE que lit la projection de trésorerie.
//
// Deux choses peuvent le figer, et une seule d'entre elles se voit :
//  1. une autorisation expirée (la banque redemande de se connecter) ;
//  2. la lecture qui ne passe plus, sans erreur — le dernier solde connu reste
//     alors affiché comme s'il était d'aujourd'hui.
import db from '../db/database.js'
import { listItems, itemHealth } from '../connectors/plaid.js'
import { createNotification } from './notifications.js'
import { logSystemRun } from './systemAutomations.js'
import { postSlack } from './slack.js'

export const PLAID_BALANCE_AUTOMATION_ID = 'sys_plaid_silence_alert'

export const PLAID_BALANCE_DEFAULT_CONFIG = {
  // Le solde est relu toutes les 10 minutes et ré-inscrit au moins toutes les
  // 6 heures. Au-delà de 8 h sans lecture, ce n'est plus un creux : c'est cassé.
  stale_hours: '8',
  // Anti-spam : on ne re-signale pas la même chose avant ce délai.
  repeat_hours: '24',
  // Qui est prévenu dans Boréal : rôles, séparés par des virgules.
  notify_roles: 'admin',
  // Canal Slack (nom de la variable d'env). Vide = notification Boréal seule.
  // DM d'Antoine Lambert, plus le canal comptabilité (demande du 2026-10-06).
  slack_webhook_env: 'SLACK_WEBHOOK_PERSO',
}

export function getBalanceAlertConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get(PLAID_BALANCE_AUTOMATION_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch {}
  const merged = { ...PLAID_BALANCE_DEFAULT_CONFIG }
  for (const k of Object.keys(PLAID_BALANCE_DEFAULT_CONFIG)) {
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

// Dernière lecture du solde par la banque : la date qui compte est celle de la
// CONFIRMATION (la banque a redit le même montant), pas celle de l'inscription
// — un solde stable est relu sans créer de ligne.
export function lastBankBalance() {
  const row = db.prepare(`
    SELECT balance, noted_at, confirmed_at,
           COALESCE(confirmed_at, noted_at) AS read_at
    FROM treasury_balances
    WHERE source = 'plaid'
    ORDER BY read_at DESC LIMIT 1
  `).get()
  return row || null
}

// Décision pure, testable : le solde lu est-il encore frais ?
export function balanceVerdict(last, { staleHours, now = Date.now() } = {}) {
  if (!last?.read_at) return { alert: true, kind: 'jamais', hours: null }
  const h = (now - new Date(last.read_at).getTime()) / 3600e3
  if (h < staleHours) return { alert: false, hours: h, read_at: last.read_at, balance: last.balance }
  return { alert: true, kind: 'stale', hours: h, read_at: last.read_at, balance: last.balance }
}

// Une autorisation expirée ne se répare jamais toute seule : elle passe avant.
export function reauthVerdict(health) {
  if (!health) return { alert: false }
  if (health.health_error) return { alert: false, reason: `état illisible : ${health.health_error}` }
  if (health.needs_reauth) return { alert: true, institution: health.institution_name }
  return { alert: false }
}

function staleText(v) {
  if (v.kind === 'jamais') {
    return {
      title: 'Solde bancaire : aucune lecture',
      body: 'Aucun solde n\'a jamais été lu au compte. La projection de trésorerie n\'a pas de point de départ fiable.',
    }
  }
  return {
    title: `Solde bancaire figé depuis ${humanDuration(v.hours)}`,
    body: `Dernière lecture le ${String(v.read_at).slice(0, 16).replace('T', ' à ')} (${v.balance} $). La projection de trésorerie et l'écart de solde travaillent sur ce montant tant que la lecture ne repart pas — essayer « Réveiller la banque » sur la page Connecteurs.`,
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

// Dernière alerte de ce type (anti-spam), lue dans les notifications déjà
// posées — pas de table de plus à tenir.
function lastAlertHours(type) {
  const row = db.prepare('SELECT MAX(created_at) c FROM notifications WHERE type = ?').get(type)
  return row?.c ? hoursSince(row.c) : Infinity
}

async function notify({ type, title, body, cfg, force, repeatHours, out }) {
  const since = lastAlertHours(type)
  if (!force && since < repeatHours) {
    out.skipped.push({ title, reason: `déjà signalé il y a ${humanDuration(since)}` })
    return
  }
  for (const userId of recipients(cfg)) {
    createNotification({ userId, type, title, body, link: '/connectors' })
  }
  const env = cfg.slack_webhook_env
  if (env && process.env[env]) {
    try { await postSlack(process.env[env], `⚠️ ${title}\n${body}`) } catch (e) { out.slack_error = e.message }
  }
  out.alerted.push({ title })
}

export async function checkBalanceFreshness({ force = false, trigger = 'planifié' } = {}) {
  const t0 = Date.now()
  const cfg = getBalanceAlertConfig()
  const staleHours = Number(cfg.stale_hours) || 8
  const repeatHours = Number(cfg.repeat_hours) || 24
  const out = { alerted: [], skipped: [], connections: [] }

  try {
    // 1. Autorisation expirée : rien ne sera lu tant qu'elle n'est pas refaite.
    for (const item of listItems()) {
      let health
      try {
        health = await itemHealth(item.itemId)
      } catch (e) {
        health = { institution_name: item.institution_name, health_error: e?.response?.data?.error_message || e.message }
      }
      const v = reauthVerdict(health)
      out.connections.push({
        institution: health.institution_name || item.itemId,
        needs_reauth: !!health.needs_reauth,
        reason: v.reason || null,
      })
      if (!v.alert) continue
      await notify({
        type: `plaid_reauth:${item.itemId}`,
        title: `${v.institution} : connexion à réautoriser`,
        body: 'La banque demande une nouvelle autorisation. Tant qu\'elle n\'est pas refaite, le solde n\'est plus relu et la projection de trésorerie reste sur le dernier montant connu.',
        cfg, force, repeatHours, out,
      })
    }

    // 2. Le solde lui-même : la seule chose que la projection consomme.
    const last = lastBankBalance()
    const v = balanceVerdict(last, { staleHours })
    out.balance = { read_at: v.read_at || null, hours: v.hours != null ? Math.round(v.hours) : null, amount: v.balance ?? null, alert: !!v.alert }
    if (v.alert) {
      const { title, body } = staleText(v)
      await notify({ type: 'treasury_balance_stale', title, body, cfg, force, repeatHours, out })
    }

    const summary = out.alerted.length
      ? out.alerted.map(a => a.title).join(' · ')
      : `Solde lu il y a ${humanDuration(v.hours)}${v.balance != null ? ` (${v.balance} $)` : ''}`
    // Journal silencieux quand tout va bien : un solde à jour n'est pas une
    // nouvelle.
    if (out.alerted.length || out.skipped.length) {
      logSystemRun(PLAID_BALANCE_AUTOMATION_ID, {
        status: 'success', duration_ms: Date.now() - t0, triggerData: { trigger }, result: summary,
      })
    }
    return { ...out, summary }
  } catch (e) {
    logSystemRun(PLAID_BALANCE_AUTOMATION_ID, {
      status: 'error', duration_ms: Date.now() - t0, triggerData: { trigger }, error: e,
    })
    throw e
  }
}
