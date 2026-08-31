// returnItemCreatedWatcher — import de l'automatisation Airtable #2
// (« Création d'un item de retour »). Tail change_log sur return_items ;
// pour chaque ligne non encore traitée (rma_processed_at IS NULL) :
//   1. Passe le # de série lié à 'En retour' (si un serial_id est présent).
//   2. Si return_reason = « Retour de garantie avec échange immédiat »,
//      crée une vraie commande de remplacement (orders + order_items).
//   3. Marque la ligne traitée (claim) — évite qu'une mise à jour ultérieure
//      (ex. réception, gérée par returnItemReceivedWatcher) ne la rejoue.
//
// ⚠️ Différence structurelle avec Airtable : dans l'ERP, return_items.return_id
// est NOT NULL (FK obligatoire) — un item de retour ne peut jamais exister sans
// RMA déjà lié, contrairement à Airtable où l'automation peut créer le RMA à la
// volée. L'étape « créer/lier le RMA » de l'original est donc un no-op ici,
// structurellement garanti par le schéma.
//
// Toute erreur (ex. produit de remplacement introuvable) est journalisée et
// envoyée sur Slack — fidèle à la branche catch de l'automation Airtable.

import { v4 as uuidv4 } from 'uuid'
import db from '../db/database.js'
import { sendSlack } from './slack.js'
import { logSystemRun, isSystemAutomationActive } from './systemAutomations.js'
import { createChangeLogWatcher } from './changeLogWatcher.js'

const POLL_MS = 5000
const BATCH = 200
const IMMEDIATE_REASON = 'Retour de garantie avec échange immédiat'
const SLACK_ENV = 'SLACK_WEBHOOK_RETOURS'

function createReplacementOrder(item) {
  const companyId = item.company_id || db.prepare('SELECT company_id FROM returns WHERE id = ?').get(item.return_id)?.company_id
  if (!companyId) throw new Error(`Impossible de créer la commande de remplacement — aucune entreprise résolue pour l'item ${item.id}`)

  const orderId = uuidv4()
  const orderItemId = uuidv4()
  const maxNum = db.prepare('SELECT MAX(order_number) AS m FROM orders').get()
  const orderNumber = (maxNum?.m || 0) + 1

  const tx = db.transaction(() => {
    db.prepare(`
      INSERT INTO orders (id, order_number, company_id, status, notes, documents)
      VALUES (?, ?, ?, 'Commande vide', ?, ?)
    `).run(
      orderId, orderNumber, companyId,
      `Remplacement automatique — retour ${item.return_id}`,
      item.return_shipping_label || null
    )
    db.prepare(`
      INSERT INTO order_items (id, order_id, product_id, qty, item_type, document_type, return_id, replaced_serial)
      VALUES (?, ?, ?, 1, 'Remplacement', 'Remplacement', ?, ?)
    `).run(orderItemId, orderId, item.product_send_id || null, item.return_id, item.serial_id || null)
  })
  tx()

  return { orderId, orderNumber }
}

async function processReturnItem(id) {
  const item = db.prepare('SELECT * FROM return_items WHERE id = ?').get(id)
  if (!item || item.rma_processed_at) return

  const errors = []

  if (item.serial_id) {
    try {
      db.prepare(`UPDATE serial_numbers SET status = 'En retour', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(item.serial_id)
    } catch (e) {
      errors.push(`Statut # de série : ${e.message}`)
    }
  }

  let replacement = null
  if (item.return_reason === IMMEDIATE_REASON) {
    try {
      replacement = createReplacementOrder(item)
    } catch (e) {
      errors.push(`Commande de remplacement : ${e.message}`)
    }
  }

  // Claim — posé même en cas d'erreur partielle, pour ne jamais reboucler sur
  // le même item à chaque poll (fidèle au principe one-shot de l'automation
  // Airtable — un item créé ne redéclenche pas indéfiniment).
  db.prepare(`UPDATE return_items SET rma_processed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(id)

  if (errors.length) {
    const text = `La création de retour a échoué. SVP vérifiez. Message d'erreur: ${errors.join(' · ')} (item ${id}, retour ${item.return_id})`
    await sendSlack({ envName: SLACK_ENV, text, fallbackNote: `${SLACK_ENV} n'est pas configuré — alerte de création de retour redirigée ici.` }).catch(() => {})
    logSystemRun('sys_return_item_created', { status: 'error', error: errors.join(' · '), triggerData: { return_item_id: id, return_id: item.return_id } })
  } else {
    logSystemRun('sys_return_item_created', {
      status: 'success',
      result: `Item ${id} traité (retour ${item.return_id})${replacement ? ` — commande de remplacement #${replacement.orderNumber} créée` : ''}`,
      triggerData: { return_item_id: id, return_id: item.return_id, replacement_order_id: replacement?.orderId || null },
    })
  }
}

const watcher = createChangeLogWatcher({
  name: 'returnItemCreatedWatcher',
  intervalMs: POLL_MS,
  tables: 'return_items',
  batchSize: BATCH,
  isEnabled: () => isSystemAutomationActive('sys_return_item_created'),
  onRows: async (rows, { advance }) => {
    for (const row of rows) {
      advance(row.id)
      await processReturnItem(row.record_id)
    }
  },
})

export const pollOnce = watcher.pollOnce

export function startReturnItemCreatedWatcher() { watcher.start() }
export function stopReturnItemCreatedWatcher() { watcher.stop() }
