// orderStatusWatcher — tient à jour le statut calculé des commandes
// (services/orderStatus.js, automation système `sys_order_status`).
//
// Le statut dépend de la commande, de ses lignes, de ses envois, du stock des
// pièces et des numéros de série disponibles — écrits par les routes, le mode
// expédition, Novoxpress, les syncs Airtable… On tail donc change_log sur ces
// cinq tables (toute origine) et on recalcule les commandes touchées. Une
// suppression de ligne ou d'envoi ne dit plus à quelle commande elle
// appartenait : passe complète. Passe complète aussi toutes les heures
// (« Envoyé aujourd'hui » → « Envoyé » au changement de jour).

import db from '../db/database.js'
import { logSystemRun, isSystemAutomationActive } from './systemAutomations.js'
import { createChangeLogWatcher } from './changeLogWatcher.js'
import { refreshOrderStatuses } from './orderStatus.js'

const POLL_MS = 5000
const FULL_PASS_MS = 60 * 60 * 1000
const BATCH = 2000
const AUTOMATION_ID = 'sys_order_status'
const TABLES = ['orders', 'order_items', 'shipments', 'products', 'serial_numbers']
// Au-delà, une passe complète coûte moins que la liste.
const MAX_TARGETED = 400

const SENT = "('Envoyé', 'Envoyé aujourd''hui')"

function ordersTouchedBy(rows) {
  const ids = new Set()
  const byTable = {}
  for (const r of rows) {
    if (r.change_type === 'delete' && (r.table_name === 'order_items' || r.table_name === 'shipments')) return null
    if (r.change_type !== 'upsert') continue
    ;(byTable[r.table_name] ||= new Set()).add(r.record_id)
  }
  const add = list => { for (const row of list) ids.add(row.order_id) }
  const q = (sql, keys) => {
    const arr = [...keys]
    for (let i = 0; i < arr.length; i += 500) {
      const chunk = arr.slice(i, i + 500)
      add(db.prepare(sql.replace('$IN', chunk.map(() => '?').join(','))).all(...chunk))
    }
  }
  for (const id of byTable.orders || []) ids.add(id)
  if (byTable.order_items) q('SELECT order_id FROM order_items WHERE id IN ($IN)', byTable.order_items)
  if (byTable.shipments) {
    q('SELECT order_id FROM shipments WHERE id IN ($IN)', byTable.shipments)
    q('SELECT order_id FROM order_items WHERE shipment_id IN ($IN)', byTable.shipments)
  }
  // Stock et séries ne changent que la disponibilité : seules les commandes
  // pas encore envoyées qui portent la pièce sont concernées.
  const productIds = new Set(byTable.products || [])
  if (byTable.serial_numbers) {
    const arr = [...byTable.serial_numbers]
    for (let i = 0; i < arr.length; i += 500) {
      const chunk = arr.slice(i, i + 500)
      for (const r of db.prepare(`SELECT product_id FROM serial_numbers WHERE id IN (${chunk.map(() => '?').join(',')})`).all(...chunk)) {
        if (r.product_id) productIds.add(r.product_id)
      }
    }
  }
  if (productIds.size) {
    q(`SELECT DISTINCT oi.order_id FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.status NOT IN ${SENT} AND oi.product_id IN ($IN)`, productIds)
  }
  ids.delete(null)
  return ids
}

function logChanges(changed, trigger) {
  if (!changed.length) return
  logSystemRun(AUTOMATION_ID, {
    status: 'success',
    result: [
      `${changed.length} statut(s) mis à jour (${trigger})`,
      ...changed.map(c => `#${c.order_number ?? c.id} : ${c.from} → ${c.to}`),
    ].join('\n'),
    triggerData: { trigger, changed: changed.length },
  })
}

export function runFullPass(trigger = 'passe complète') {
  try {
    const { changed } = refreshOrderStatuses()
    logChanges(changed, trigger)
    return changed.length
  } catch (e) {
    logSystemRun(AUTOMATION_ID, { status: 'error', result: trigger, error: e.message })
    return 0
  }
}

let tailStmt = null
const watcher = createChangeLogWatcher({
  name: 'orderStatusWatcher',
  intervalMs: POLL_MS,
  maxIdTables: TABLES,
  isEnabled: () => isSystemAutomationActive(AUTOMATION_ID),
  onPoll: async () => {
    tailStmt ??= db.prepare(`
      SELECT id, table_name, record_id, change_type FROM change_log
      WHERE id > ? AND table_name IN (${TABLES.map(() => '?').join(',')})
      ORDER BY id ASC LIMIT ?
    `)
    const rows = tailStmt.all(watcher.getLastSeenId(), ...TABLES, BATCH)
    if (!rows.length) return 0
    watcher.setLastSeenId(rows[rows.length - 1].id)
    const ids = ordersTouchedBy(rows)
    if (!ids || ids.size > MAX_TARGETED) return runFullPass('modification')
    if (!ids.size) return 0
    try {
      const { changed } = refreshOrderStatuses([...ids])
      logChanges(changed, 'modification')
      return changed.length
    } catch (e) {
      logSystemRun(AUTOMATION_ID, { status: 'error', result: 'modification', error: e.message })
      return 0
    }
  },
})

let fullTimer = null

export function startOrderStatusWatcher() {
  watcher.start()
  const tick = () => { if (isSystemAutomationActive(AUTOMATION_ID)) runFullPass() }
  setTimeout(tick, 20_000).unref?.()
  fullTimer = setInterval(tick, FULL_PASS_MS)
  fullTimer.unref?.()
}

export function stopOrderStatusWatcher() {
  watcher.stop()
  if (fullTimer) { clearInterval(fullTimer); fullTimer = null }
}

export const pollOnce = watcher.pollOnce
