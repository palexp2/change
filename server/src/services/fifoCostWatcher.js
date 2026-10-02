// fifoCostWatcher — tient le coût unitaire FIFO des pièces (services/fifoCost.js).
//
// Deux déclencheurs, une seule automation système (`sys_fifo_cost`) :
//   - au fil de l'eau : tail change_log(purchases, products). Un achat touché
//     (réception, quantité, pièce) recalcule ses pièces ; une pièce touchée
//     (quantité en inventaire) se recalcule. Notre propre écriture de
//     unit_cost repasse ici une fois, sans effet (coût inchangé → rien écrit) ;
//   - passe complète toutes les heures : relit dans Airtable le prix de tous
//     les achats (il change sans que l'achat bouge : ligne de dépense liée
//     plus tard), puis recalcule toutes les pièces.
// Un coût changé est réécrit dans products.unit_cost puis poussé vers le champ
// Airtable « Coût unitaire (FIFO) », par paquets ; un envoi refusé reste en
// attente (product_fifo.pushed_cost NULL) et repart à la minute suivante.

import db from '../db/database.js'
import { logSystemRun, isSystemAutomationActive } from './systemAutomations.js'
import { createChangeLogWatcher } from './changeLogWatcher.js'
import { applyFifo, productIdsForPurchase, allFifoProductIds, refreshPurchasePrices } from './fifoCost.js'
import { recordWriteback } from './airtableWriteback.js'
import { getAccessToken, airtablePatch } from '../connectors/airtable.js'

const AUTOMATION_ID = 'sys_fifo_cost'
const POLL_MS = 10_000
const FULL_PASS_MS = 60 * 60 * 1000
const PUSH_MS = 60_000
// Airtable : 10 records par PATCH, 5 requêtes/s par base partagées avec les
// autres syncs — on reste loin de la limite.
const PUSH_BATCH = 10
const PUSH_GAP_MS = 400

const ISSUE_LABELS = { sans_prix: 'lot sans prix', prix_douteux: 'prix douteux', stock_sans_achat: 'stock sans achat' }

function productLabel(id) {
  const p = db.prepare('SELECT sku, name_fr FROM products WHERE id = ?').get(id)
  return p ? `${p.sku ? `${p.sku} ` : ''}${p.name_fr || id}` : id
}

// Recalcule des pièces (l'envoi vers Airtable suit, par pushPendingFifoCosts).
function recompute(productIds) {
  const changed = []
  const errors = []
  for (const id of productIds) {
    try {
      const r = applyFifo(id)
      if (r?.changed) changed.push(r)
    } catch (e) {
      errors.push(`${productLabel(id)} : ${e.message}`)
    }
  }
  return { changed, errors }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
let pushing = false

/**
 * Envoie vers Airtable les coûts pas encore confirmés, par paquets de 10.
 * Un refus (limite de débit…) arrête la passe : le reste part à la suivante.
 * @returns {{ pushed: number, pending: number, error?: string }}
 */
export async function pushPendingFifoCosts() {
  if (pushing) return { pushed: 0, pending: 0 }
  pushing = true
  try {
    const field = db.prepare(
      "SELECT airtable_field_name FROM airtable_field_mappings WHERE erp_table = 'products' AND column_name = 'unit_cost' AND import_disabled IS NOT 1"
    ).get()?.airtable_field_name || 'Coût unitaire (FIFO)'
    const cfg = db.prepare("SELECT base_id, table_id FROM airtable_module_config WHERE module = 'pieces'").get()
    const rows = db.prepare(`
      SELECT f.product_id, p.airtable_id, p.unit_cost FROM product_fifo f JOIN products p ON p.id = f.product_id
      WHERE f.cost IS NOT NULL AND p.unit_cost IS NOT NULL AND p.airtable_id LIKE 'rec%' AND p.deleted_at IS NULL
        AND (f.pushed_cost IS NULL OR ABS(f.pushed_cost - p.unit_cost) > 0.00005)
    `).all()
    if (!rows.length || !cfg?.base_id) return { pushed: 0, pending: rows.length }
    const token = await getAccessToken()
    const mark = db.prepare('UPDATE product_fifo SET pushed_cost = ? WHERE product_id = ?')
    let pushed = 0
    for (let i = 0; i < rows.length; i += PUSH_BATCH) {
      const batch = rows.slice(i, i + PUSH_BATCH)
      // Garde anti-écho posée AVANT le PATCH : le webhook peut revenir avant.
      for (const r of batch) recordWriteback(r.airtable_id, { [field]: r.unit_cost })
      try {
        await airtablePatch(`/${cfg.base_id}/${cfg.table_id}`, token, {
          records: batch.map(r => ({ id: r.airtable_id, fields: { [field]: r.unit_cost } })),
          typecast: true,
        })
      } catch (e) {
        const ids = batch.map(r => r.airtable_id)
        db.prepare(`DELETE FROM airtable_writeback_guard WHERE airtable_id IN (${ids.map(() => '?').join(',')})`).run(...ids)
        return { pushed, pending: rows.length - pushed, error: e.message }
      }
      for (const r of batch) mark.run(r.unit_cost, r.product_id)
      pushed += batch.length
      await sleep(PUSH_GAP_MS)
    }
    return { pushed, pending: 0 }
  } finally {
    pushing = false
  }
}

function logPass(source, { changed, errors, prices = null, alerts = null }) {
  if (!changed.length && !errors.length && source === 'continu') return
  const fmt = v => (v == null ? '—' : `${Number(v).toFixed(4).replace(/0{1,2}$/, '')} $`)
  logSystemRun(AUTOMATION_ID, {
    status: errors.length ? 'error' : 'success',
    result: [
      `${source} : ${changed.length} coût(s) changé(s)${prices != null ? ` · ${prices} prix d'achat relus` : ''}${alerts != null ? ` · ${alerts} pièce(s) en alerte` : ''}`,
      ...changed.map(c => `${productLabel(c.product_id)} : ${fmt(c.from)} → ${fmt(c.to)}${c.issues.length ? ` (${[...new Set(c.issues.map(i => ISSUE_LABELS[i.kind]))].join(', ')})` : ''}`),
      errors.length ? `Erreurs : ${errors.join(' | ')}` : null,
    ].filter(Boolean).join('\n'),
    error: errors.length ? errors.join(' | ') : undefined,
    triggerData: { source, changed: changed.length, errors: errors.length },
  })
}

let fullPassRunning = false

/** Passe complète : prix relus dans Airtable, puis toutes les pièces. */
export async function runFifoFullPass({ source = 'horaire' } = {}) {
  if (fullPassRunning) return { skipped: 'passe déjà en cours' }
  fullPassRunning = true
  try {
    let prices = null
    const errors = []
    try { prices = await refreshPurchasePrices() }
    catch (e) { errors.push(`relecture des prix : ${e.message}`) }
    const r = recompute(allFifoProductIds())
    r.errors.unshift(...errors)
    const push = await pushPendingFifoCosts()
    if (push.error) r.errors.push(`Airtable (${push.pending} en attente, nouvel essai dans 1 min) : ${push.error}`)
    const alerts = db.prepare('SELECT COUNT(*) AS n FROM product_fifo WHERE issue_count > 0').get().n
    logPass(source, { ...r, prices, alerts })
    return { changed: r.changed.length, errors: r.errors, prices, alerts }
  } finally {
    fullPassRunning = false
  }
}

const watcher = createChangeLogWatcher({
  name: 'fifoCostWatcher',
  intervalMs: POLL_MS,
  tables: ['purchases', 'products'],
  isEnabled: () => isSystemAutomationActive(AUTOMATION_ID),
  onRows: async (rows, { advance }) => {
    const ids = new Set()
    const newPurchases = []
    for (const row of rows) {
      advance(row.id)
      if (row.table_name === 'products') { ids.add(row.record_id); continue }
      for (const pid of productIdsForPurchase(row.record_id)) ids.add(pid)
      const at = db.prepare('SELECT airtable_id FROM purchases WHERE id = ?').get(row.record_id)?.airtable_id
      if (at && !db.prepare('SELECT 1 FROM purchase_prices WHERE airtable_id = ?').get(at)) newPurchases.push(at)
    }
    if (!ids.size) return 0
    const errors = []
    // Achat jamais vu : son prix n'est pas encore relu.
    if (newPurchases.length) {
      try { await refreshPurchasePrices([...new Set(newPurchases)]) }
      catch (e) { errors.push(`relecture des prix : ${e.message}`) }
    }
    const r = recompute([...ids])
    r.errors.unshift(...errors)
    if (r.changed.length) {
      const push = await pushPendingFifoCosts()
      if (push.error) r.errors.push(`Airtable (${push.pending} en attente, nouvel essai dans 1 min) : ${push.error}`)
    }
    logPass('continu', r)
    return r.changed.length
  },
})

let fullTimer = null
let pushTimer = null

export function startFifoCostWatcher() {
  watcher.start()
  const tick = () => {
    if (!isSystemAutomationActive(AUTOMATION_ID)) return
    runFifoFullPass().catch(e => console.error('[fifoCostWatcher] passe complète :', e.message))
  }
  setTimeout(tick, 60_000).unref?.()
  fullTimer = setInterval(tick, FULL_PASS_MS)
  fullTimer.unref?.()
  // Reprise des envois refusés, sans bruit dans l'historique.
  pushTimer = setInterval(() => {
    if (!isSystemAutomationActive(AUTOMATION_ID)) return
    pushPendingFifoCosts().catch(e => console.error('[fifoCostWatcher] envoi Airtable :', e.message))
  }, PUSH_MS)
  pushTimer.unref?.()
}

export function stopFifoCostWatcher() {
  watcher.stop()
  if (fullTimer) clearInterval(fullTimer)
  if (pushTimer) clearInterval(pushTimer)
  fullTimer = pushTimer = null
}
