// returnItemReceivedWatcher — import fusionné des automatisations Airtable
// #5 (« Réception d'un retour ») et #6 (« Changement d'état du numéro de
// série lors de la réception »). Les deux se déclenchent sur la même
// condition (received_at + received_by renseignés sur un return_items) et ne
// sont que deux effets indépendants du même évènement — regroupées ici pour
// éviter deux watchers redondants sur le même tail de change_log.
//
// Effets, par branche de return_reason :
//  - « garantie échange différé »  → instructions longues + serial 'À analyser'
//  - « garantie échange immédiat » → instructions courtes + serial 'À analyser'
//  - « changé d'idée » / « fin d'abonnement » → instructions reconditionnement
//    + Slack (rembourser/désabonner le client)
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

const POLL_MS = 5000
const BATCH = 200
const SLACK_ENV = 'SLACK_WEBHOOK_RETOURS'

const DEFERRED = 'Retour de garantie avec échange différé'
const IMMEDIATE = 'Retour de garantie avec échange immédiat'
const CHANGED_MIND = "Le client à changé d'idée"
const SUB_END = "Fin d'abonnement"
const ORDER_ERROR = 'Erreur de commande'
const COURTESY = "Retour d'équipement de courtoisie"

function instructionsFor(reason, receivedBy) {
  const who = receivedBy || ''
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

function serialStatusFor(reason) {
  if (reason === DEFERRED || reason === IMMEDIATE) return 'À analyser'
  if (reason === CHANGED_MIND || reason === SUB_END || reason === ORDER_ERROR || reason === COURTESY) return 'À reconditionner'
  return null
}

async function processReturnItem(id) {
  const item = db.prepare('SELECT * FROM return_items WHERE id = ?').get(id)
  if (!item || item.reception_processed_at) return
  if (!item.received_at || !item.received_by) return

  const instructions = instructionsFor(item.return_reason, item.received_by)
  if (instructions) {
    db.prepare(`UPDATE return_items SET instructions_pour_le_receptionniste = ? WHERE id = ?`).run(instructions, id)
  }

  const serialStatus = serialStatusFor(item.return_reason)
  if (serialStatus && item.serial_id) {
    db.prepare(`UPDATE serial_numbers SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(serialStatus, item.serial_id)
  }

  let slackText = null
  if (item.return_reason === CHANGED_MIND || item.return_reason === SUB_END) {
    slackText = `Un retour parce qu'un client a changé d'idée ou un retour de désabonnement est arrivé. SVP prendre les actions nécessaires pour rembourser le client ou le désabonner et s'il y a lieu changer sa phase du cycle de vie. Retour : ${item.return_id}`
  } else if (![DEFERRED, IMMEDIATE, CHANGED_MIND, SUB_END, ORDER_ERROR, COURTESY].includes(item.return_reason)) {
    slackText = `Réception d'un retour sans justification. Retour : ${item.return_id}`
  }
  if (slackText) {
    await sendSlack({ envName: SLACK_ENV, text: slackText, fallbackNote: `${SLACK_ENV} n'est pas configuré — alerte réception de retour redirigée ici.` }).catch(() => {})
  }

  db.prepare(`UPDATE return_items SET reception_processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(id)

  logSystemRun('sys_return_item_received', {
    status: 'success',
    result: `Item ${id} reçu (raison: ${item.return_reason || '—'})${serialStatus ? ` — # de série → ${serialStatus}` : ''}${slackText ? ' — alerte Slack envoyée' : ''}`,
    triggerData: { return_item_id: id, return_id: item.return_id, return_reason: item.return_reason },
  })
}

const watcher = createChangeLogWatcher({
  name: 'returnItemReceivedWatcher',
  intervalMs: POLL_MS,
  tables: 'return_items',
  batchSize: BATCH,
  isEnabled: () => isSystemAutomationActive('sys_return_item_received'),
  onRows: async (rows, { advance }) => {
    for (const row of rows) {
      advance(row.id)
      await processReturnItem(row.record_id)
    }
  },
})

export const pollOnce = watcher.pollOnce

export function startReturnItemReceivedWatcher() { watcher.start() }
export function stopReturnItemReceivedWatcher() { watcher.stop() }
