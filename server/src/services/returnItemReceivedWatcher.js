// returnItemReceivedWatcher — import fusionné des automatisations Airtable
// #5 (« Réception d'un retour ») et #6 (« Changement d'état du numéro de
// série lors de la réception »). Les deux se déclenchent sur la même
// condition (received_at + received_by renseignés sur un return_items) et ne
// sont que deux effets indépendants du même évènement — regroupées ici pour
// éviter deux watchers redondants sur le même tail de change_log.
//
// Le statut du # de série est passé en blocs (auto_return_serial_status,
// services/returnSerialStatusFlow.js) : il ne se règle plus ici.
//
// Effets, par branche de return_reason :
//  - « garantie échange différé »  → instructions longues
//  - « garantie échange immédiat » → instructions courtes
//  - « changé d'idée » / « fin d'abonnement » → instructions reconditionnement
//    + Slack (rembourser/désabonner le client) — une alerte par retour, pas
//    par article ; destinataire réglable sur la fiche de l'automation
//    ; « fin d'abonnement » avise en plus Philippe (sub_end_slack_channel),
//    lien vers le retour, une fois par retour
//  - « erreur de commande » / « équipement de courtoisie » → instructions
//    reconditionnement, sans Slack
//  - toute autre valeur (catch-all, y compris vide) → Slack seul, aucune
//    instruction ni changement de statut
//
// `instructions_pour_le_receptionniste` est une colonne Airtable synced sur
// return_items — gelée au boot (schema.js) pour ne pas se faire écraser au
// sync suivant.

import db from '../db/database.js'
import { sendSlack } from './slack.js'
import { logSystemRun, isSystemAutomationActive } from './systemAutomations.js'
import { createChangeLogWatcher } from './changeLogWatcher.js'
import { returnCompanyId } from './returnCompany.js'
import { APP_URL } from '../config/appUrl.js'

const POLL_MS = 5000
const BATCH = 200
export const RETURN_RECEIVED_ID = 'sys_return_item_received'

// Destinataire de l'alerte. SLACK_WEBHOOK_RETOURS n'a jamais existé dans
// server/.env : chaque alerte partait sur #comptabilité avec un préfixe
// « n'est pas configuré ». On passe par le bot Slack, en privé à PA par défaut
// (« PA a été avisé » dans les instructions au réceptionniste).
export const RETURN_RECEIVED_DEFAULT_CONFIG = {
  slack_channel: 'pap@orisha.io',
  slack_webhook_url: '',
  slack_webhook_env: '',
  // Fin d'abonnement réceptionnée → Philippe (demande de P.-A. Papillon, 2026-10-13).
  sub_end_slack_channel: 'philippe@orisha.io',
  // Textes des messages ; {retour} = numéro, entreprise et lien du retour.
  msg_refund: "Un retour parce qu'un client a changé d'idée ou un retour de désabonnement est arrivé. SVP prendre les actions nécessaires pour rembourser le client ou le désabonner et s'il y a lieu changer sa phase du cycle de vie. Retour : {retour}",
  msg_unknown: 'Réception d\'un retour sans justification. Retour : {retour}',
  msg_sub_end: "Un retour de fin d'abonnement a été réceptionné. Retour : {retour}",
}

// Fenêtre dans laquelle les articles d'un même retour reçus ensemble ne
// produisent qu'UNE alerte (un retour de 3 sondes en envoyait 3 identiques).
const GROUP_WINDOW_MS = 12 * 3600 * 1000

export function getReturnReceivedConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get(RETURN_RECEIVED_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch {}
  const merged = { ...RETURN_RECEIVED_DEFAULT_CONFIG }
  for (const k of Object.keys(merged)) {
    if (cfg[k] != null && String(cfg[k]).trim() !== '') merged[k] = String(cfg[k]).trim()
  }
  return merged
}

const DEFERRED = 'Retour de garantie avec échange différé'
const IMMEDIATE = 'Retour de garantie avec échange immédiat'
const CHANGED_MIND = "Le client à changé d'idée"
const SUB_END = "Fin d'abonnement"
const ORDER_ERROR = 'Erreur de commande'
const COURTESY = "Retour d'équipement de courtoisie"

function instructionsFor(reason, receivedBy) {
  const who = String(receivedBy || '').trim().split(/\s+/)[0]
  if (reason === DEFERRED) {
    return `Bonjour ${who}, SVP place l'article dans l'étagère d'analyse. L'item sera analysé, réparé, nettoyé et renvoyé lors de la prochaine séance d'analyse.`
  }
  if (reason === IMMEDIATE) {
    return `Bonjour ${who}, SVP place l'article dans l'étagère d'analyse.`
  }
  if (reason === CHANGED_MIND || reason === SUB_END) {
    return `Bonjour ${who}, SVP place l'article dans l'étagère de reconditionnement. PA a été avisé de la réception de cet item.`
  }
  if (reason === ORDER_ERROR || reason === COURTESY) {
    return `Bonjour ${who}, SVP place l'article dans l'étagère de reconditionnement.`
  }
  return null
}

const SLACK_REASONS = new Set([CHANGED_MIND, SUB_END])
const KNOWN_REASONS = new Set([DEFERRED, IMMEDIATE, CHANGED_MIND, SUB_END, ORDER_ERROR, COURTESY])

// Catégorie d'alerte d'un article : 'refund' (changé d'idée / désabonnement),
// 'unknown' (raison non reconnue) ou null (pas d'alerte).
function alertKind(reason) {
  if (SLACK_REASONS.has(reason)) return 'refund'
  if (!KNOWN_REASONS.has(reason)) return 'unknown'
  return null
}

// Un autre article du même retour, de la même catégorie, a-t-il déjà donné
// lieu à l'alerte récemment ?
function alreadyAlerted(item, kind) {
  const since = new Date(Date.now() - GROUP_WINDOW_MS).toISOString()
  const siblings = db.prepare(`
    SELECT return_reason FROM return_items
     WHERE return_id = ? AND id != ? AND reception_processed_at >= ?
  `).all(item.return_id, item.id, since)
  return siblings.some(s => alertKind(s.return_reason) === kind)
}

// Un autre article du même retour, de même raison, a-t-il déjà été traité récemment ?
function alreadyProcessedReason(item, reason) {
  const since = new Date(Date.now() - GROUP_WINDOW_MS).toISOString()
  return !!db.prepare(`
    SELECT 1 FROM return_items
     WHERE return_id = ? AND id != ? AND reception_processed_at >= ? AND return_reason = ?
     LIMIT 1
  `).get(item.return_id, item.id, since, reason)
}

function returnLabel(item) {
  const ret = db.prepare('SELECT * FROM returns WHERE id = ?').get(item.return_id) || {}
  const number = ret.cf_de_retour || item.return_id
  const companyId = item.company_id || returnCompanyId(item.return_id)
  const company = companyId ? db.prepare('SELECT name FROM companies WHERE id = ?').get(companyId)?.name : null
  const count = db.prepare(`
    SELECT COUNT(*) AS n FROM return_items
     WHERE return_id = ? AND received_at IS NOT NULL AND received_by IS NOT NULL
  `).get(item.return_id).n
  return `${number}${company ? ` — ${company}` : ''}${count > 1 ? ` (${count} articles)` : ''}\n${APP_URL}/erp/retours/${item.return_id}`
}

async function processReturnItem(id) {
  const item = db.prepare('SELECT * FROM return_items WHERE id = ?').get(id)
  if (!item || item.reception_processed_at) return
  if (!item.received_at || !item.received_by) return

  const instructions = instructionsFor(item.return_reason, item.received_by)
  if (instructions) {
    db.prepare(`UPDATE return_items SET instructions_pour_le_receptionniste = ? WHERE id = ?`).run(instructions, id)
  }

  const kind = alertKind(item.return_reason)
  const grouped = kind && alreadyAlerted(item, kind)
  const msgCfg = getReturnReceivedConfig()
  const fill = tpl => tpl.replaceAll('{retour}', returnLabel(item))
  let slackText = null
  if (kind && !grouped) {
    slackText = fill(kind === 'refund' ? msgCfg.msg_refund : msgCfg.msg_unknown)
  }

  const subEndText = item.return_reason === SUB_END && !alreadyProcessedReason(item, SUB_END)
    ? fill(msgCfg.msg_sub_end)
    : null

  // Claim avant l'envoi : les articles suivants du même retour voient celui-ci
  // déjà traité et ne renvoient pas la même alerte.
  db.prepare(`UPDATE return_items SET reception_processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(id)

  let slackError = null
  let sentTo = null
  if (slackText) {
    const cfg = getReturnReceivedConfig()
    try {
      const sent = await sendSlack({
        channel: cfg.slack_channel || null,
        url: cfg.slack_webhook_url || null,
        envName: cfg.slack_webhook_env || null,
        text: slackText,
      })
      if (!sent.sent) throw new Error(`aucun canal Slack joignable (${sent.missing || 'non configuré'})`)
      sentTo = cfg.slack_channel || sent.env || 'webhook'
    } catch (e) {
      slackError = e.message
    }
  }

  let subEndError = null
  let subEndTo = null
  if (subEndText) {
    const cfg = getReturnReceivedConfig()
    if (cfg.sub_end_slack_channel) {
      try {
        const sent = await sendSlack({ channel: cfg.sub_end_slack_channel, text: subEndText })
        if (!sent.sent) throw new Error(`aucun canal Slack joignable (${sent.missing || 'non configuré'})`)
        subEndTo = cfg.sub_end_slack_channel
      } catch (e) {
        subEndError = e.message
      }
    }
  }

  const base = `Item ${id} reçu (raison: ${item.return_reason || '—'})`
  const subEndNote = subEndTo ? ` — fin d'abonnement → ${subEndTo}` : ''
  const errors = [
    slackError && `alerte Slack non envoyée : ${slackError}`,
    subEndError && `avis fin d'abonnement non envoyé : ${subEndError}`,
  ].filter(Boolean)
  logSystemRun(RETURN_RECEIVED_ID, {
    status: errors.length ? 'error' : 'success',
    ...(errors.length
      ? { error: `${base} — ${errors.join(' ; ')}` }
      : { result: `${base}${sentTo ? ` — alerte Slack → ${sentTo}` : grouped ? ' — alerte déjà envoyée pour ce retour' : ''}${subEndNote}` }),
    triggerData: { return_item_id: id, return_id: item.return_id, return_reason: item.return_reason },
  })
}

const watcher = createChangeLogWatcher({
  name: 'returnItemReceivedWatcher',
  intervalMs: POLL_MS,
  tables: 'return_items',
  batchSize: BATCH,
  isEnabled: () => isSystemAutomationActive(RETURN_RECEIVED_ID),
  automationId: RETURN_RECEIVED_ID,
  onRows: async (rows, { advance }) => {
    for (const row of rows) {
      advance(row.id)
      await processReturnItem(row.record_id)
    }
  },
})

export function startReturnItemReceivedWatcher() { watcher.start() }
