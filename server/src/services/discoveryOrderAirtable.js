import db from '../db/database.js'
import { setTimeout as delay } from 'node:timers/promises'
import { createInAirtable } from './airtableWriteback.js'

// Commandes en cours d'envoi : un seul envoi à la fois par commande, sinon la
// reprise et l'envoi initial créeraient chacun leur copie dans Airtable.
const inFlight = new Set()
// Reprise espacée par commande (en mémoire) : 5 min, 10, 20… plafonné à 6 h.
const backoff = new Map()
const RETRY_BASE_MS = 5 * 60 * 1000
const RETRY_MAX_MS = 6 * 60 * 60 * 1000
const RATE_LIMIT_WAIT_MS = 30_000

// Appelé pour une commande System Builder, après validation de la transaction.
// Le parent doit être lié avant de transmettre ses articles. Rejouable : les
// fiches déjà liées sont sautées par createInAirtable.
export async function mirrorDiscoveryOrder(orderId) {
  if (inFlight.has(orderId)) return { status: 'pending' }
  inFlight.add(orderId)
  try {
    const order = await createInAirtable('orders', orderId)
    if (!db.prepare('SELECT airtable_id FROM orders WHERE id=?').get(orderId)?.airtable_id) {
      return { status: 'error', error: order.error || order.skipped }
    }
    const failures = []
    const items = db.prepare('SELECT id FROM order_items WHERE order_id=? AND airtable_id IS NULL ORDER BY id').all(orderId)
    for (const item of items) {
      // Espacer les POST d'une commande comportant de nombreuses lignes.
      await delay(225)
      let result = await createInAirtable('order_items', item.id)
      // Airtable impose 30 s d'attente après un refus pour débit trop élevé.
      if (/\b429\b/.test(result.error || '')) {
        await delay(RATE_LIMIT_WAIT_MS)
        result = await createInAirtable('order_items', item.id)
      }
      if (!db.prepare('SELECT airtable_id FROM order_items WHERE id=?').get(item.id)?.airtable_id) {
        failures.push({ id: item.id, error: result.error || result.skipped })
      }
    }
    return failures.length ? { status: 'partial', failures } : { status: 'success' }
  } catch (error) {
    console.error('System Builder → Airtable:', error.message)
    return { status: 'error', error: error.message }
  } finally {
    inFlight.delete(orderId)
  }
}

// Envoi en arrière-plan : la réponse au bouton n'attend pas Airtable. Un échec
// programme la reprise.
const queued = new Set()
export function queueDiscoveryOrderMirror(orderId) {
  const run = mirrorDiscoveryOrder(orderId).then(result => noteOutcome(orderId, result))
  queued.add(run)
  run.finally(() => queued.delete(run))
  return run
}

// Tests : attendre la fin des envois lancés en arrière-plan.
export async function settleDiscoveryOrderMirrors() { await Promise.all([...queued]) }

function noteOutcome(orderId, result) {
  if (result.status === 'success') { backoff.delete(orderId); return }
  if (result.status === 'pending') return
  const attempts = (backoff.get(orderId)?.attempts || 0) + 1
  backoff.set(orderId, { attempts, nextAt: Date.now() + Math.min(RETRY_BASE_MS * 2 ** (attempts - 1), RETRY_MAX_MS) })
}

// Commandes nées dans l'ERP (System Builder, ou créées à la main — marquées
// dans order_airtable_exports) dont la commande ou un article n'est pas encore
// dans Airtable. Les commandes venues d'Airtable n'y sont jamais renvoyées.
export function pendingDiscoveryOrders() {
  return db.prepare(`
    SELECT o.id FROM orders o
    WHERE o.deleted_at IS NULL
      AND (o.id IN (SELECT generated_order_id FROM customer_onboarding_responses)
           OR o.id IN (SELECT order_id FROM order_airtable_exports))
      AND (o.airtable_id IS NULL
           OR EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.airtable_id IS NULL))
  `).all().map(r => r.id)
}

// Commande créée à la main dans l'ERP : la marquer pour Airtable et l'envoyer.
// Jamais bloquant : la commande est déjà enregistrée, la reprise rattrapera.
export function exportErpOrder(orderId) {
  try {
    db.prepare('INSERT OR IGNORE INTO order_airtable_exports (order_id) VALUES (?)').run(orderId)
    queueDiscoveryOrderMirror(orderId)
  } catch (e) { console.error('Commande ERP → Airtable:', e.message) }
}

// Article ajouté à une commande née dans l'ERP : suivre la commande dans Airtable.
export function exportErpOrderItems(orderId) {
  try {
    const born = db.prepare('SELECT 1 FROM order_airtable_exports WHERE order_id=?').get(orderId)
    if (born) queueDiscoveryOrderMirror(orderId)
  } catch (e) { console.error('Article ERP → Airtable:', e.message) }
}

// Reprise périodique, une commande à la fois.
export async function retryPendingDiscoveryOrders() {
  const now = Date.now()
  const results = []
  for (const orderId of pendingDiscoveryOrders()) {
    if ((backoff.get(orderId)?.nextAt || 0) > now) continue
    const result = await mirrorDiscoveryOrder(orderId)
    noteOutcome(orderId, result)
    results.push({ orderId, ...result })
  }
  return results
}

export function resetDiscoveryOrderRetryState() { backoff.clear() }
