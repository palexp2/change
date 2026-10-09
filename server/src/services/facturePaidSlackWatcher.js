// facturePaidSlackWatcher — « Une facture a été payée » sur Slack (#paiements).
//
// Quand une facture passe à « Payé », quelle que soit l'origine (webhook
// Stripe, paiement saisi, sync QuickBooks ou Airtable), un message demande de
// lier la facture au projet. Les factures d'abonnement sont ignorées, SAUF le
// premier paiement de l'abonnement, et SAUF un ajout à un abonnement existant
// (contrat ou soumission approuvé : subscription_upgrade_invoices).
//
// change_log ne garde pas l'ancienne valeur : chaque facture tranchée est
// inscrite dans facture_paid_notifications (migration 103) et n'est plus
// jamais regardée. Une facture d'abonnement dont l'abonnement n'est pas encore
// synchronisé localement n'est PAS tranchée — elle le sera à sa prochaine
// écriture, quand on saura si c'est le premier paiement.

import db from '../db/database.js'
import { sendSlack } from './slack.js'
import { logSystemRun, isSystemAutomationActive } from './systemAutomations.js'
import { createChangeLogWatcher } from './changeLogWatcher.js'
import { APP_URL } from '../config/appUrl.js'
import { allStripeIdsOf } from './stripeCatalog.js'

export const FACTURE_PAID_SLACK_ID = 'sys_facture_paid_slack'

export const FACTURE_PAID_SLACK_DEFAULT_CONFIG = {
  slack_channel: '#paiements',
  slack_webhook_url: '',
  slack_webhook_env: '',
  paid_statuses: 'Payé, Payée',
  upgrade_prefix: "Ajout à l'abonnement.",
  excluded_products: '[]',
  skip_zero_amount: '1',
  message:
    'Une facture a été payée.\n' +
    'SVP liez la facture au projet : {lien}\n' +
    'Et suivez la procédure inscrite sur la fiche de la facture.\n' +
    "S'il s'agit d'un rachat d'équipement en abonnement, n'oubliez pas d'annuler / modifier l'abonnement et de changer l'état des numéros de série concernés.",
}

export function getFacturePaidSlackConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get(FACTURE_PAID_SLACK_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch {}
  const merged = { ...FACTURE_PAID_SLACK_DEFAULT_CONFIG }
  for (const k of Object.keys(merged)) {
    if (cfg[k] != null && String(cfg[k]).trim() !== '') merged[k] = String(cfg[k]).trim()
  }
  return merged
}

export function factureUrl(id) {
  return `${APP_URL}/erp/factures/${id}`
}

export function renderMessage(template, facture, prefix = '') {
  return (prefix ? `${prefix}\n` : '') + String(template)
    .replace(/\\n/g, '\n')
    .replaceAll('{lien}', factureUrl(facture.id))
    .replaceAll('{numero}', facture.document_number || '')
}

/**
 * Décide du sort d'une facture. Pur côté écriture (lecture seule de la DB).
 * → { outcome: 'send' | 'skip' | 'wait' | 'ignore', reason }
 *   ignore = pas (encore) payée : rien à inscrire, elle pourra le devenir.
 *   wait   = abonnement pas encore résolu : réévaluée à la prochaine écriture.
 */
// Produits du catalogue exclus (ids) → leurs produits Stripe (langues + anciens).
function excludedSets(cfg) {
  let ids = []
  try { ids = JSON.parse(cfg.excluded_products || '[]') } catch {}
  ids = (Array.isArray(ids) ? ids : []).map(String).filter(Boolean)
  return { products: new Set(ids), stripe: new Set(ids.flatMap(allStripeIdsOf)) }
}

// Toutes les lignes de la facture sont des produits exclus (sans ligne connue : non).
function onlyExcluded(facture, cfg) {
  const ex = excludedSets(cfg)
  if (!ex.products.size) return false
  const lines = db.prepare('SELECT product_id, stripe_product_id FROM stripe_invoice_items WHERE facture_id=?').all(facture.id)
  return lines.length > 0 && lines.every(l => ex.products.has(l.product_id) || ex.stripe.has(l.stripe_product_id))
}

export function decide(facture, cfg) {
  const paid = new Set(String(cfg.paid_statuses).split(',').map(s => s.trim()).filter(Boolean))
  if (!paid.has(facture.status)) return { outcome: 'ignore', reason: 'non payée' }
  if (cfg.skip_zero_amount === '1' && !(Number(facture.total_amount) > 0)) {
    return { outcome: 'skip', reason: 'montant nul' }
  }
  if (onlyExcluded(facture, cfg)) return { outcome: 'skip', reason: 'produits exclus' }
  if (!facture.subscription_id) {
    if (facture.kind === 'subscription') return { outcome: 'wait', reason: 'abonnement pas encore synchronisé' }
    return { outcome: 'send', reason: 'facture hors abonnement' }
  }
  if (facture.invoice_id && db.prepare('SELECT 1 FROM subscription_upgrade_invoices WHERE stripe_invoice_id=?').get(facture.invoice_id)) {
    return { outcome: 'send', reason: "ajout à l'abonnement", upgrade: true }
  }
  const placeholders = [...paid].map(() => '?').join(',')
  const earlier = db.prepare(`
    SELECT 1 FROM factures
     WHERE subscription_id = ? AND id != ? AND status IN (${placeholders})
       AND total_amount > 0
       AND COALESCE(document_date, '') <= COALESCE(?, '')
     LIMIT 1
  `).get(facture.subscription_id, facture.id, ...paid, facture.document_date)
  if (earlier) return { outcome: 'skip', reason: "paiement récurrent d'abonnement" }
  return { outcome: 'send', reason: "premier paiement de l'abonnement" }
}

function record(factureId, outcome, reason) {
  db.prepare(`
    INSERT OR IGNORE INTO facture_paid_notifications (facture_id, outcome, reason) VALUES (?, ?, ?)
  `).run(factureId, outcome, reason)
}

export async function processFacture(id, cfg = getFacturePaidSlackConfig()) {
  if (db.prepare('SELECT 1 FROM facture_paid_notifications WHERE facture_id = ?').get(id)) return
  const f = db.prepare(`
    SELECT id, document_number, status, total_amount, currency, subscription_id, kind, document_date, invoice_id
      FROM factures WHERE id = ?
  `).get(id)
  if (!f) return

  const { outcome, reason, upgrade } = decide(f, cfg)
  if (outcome === 'ignore' || outcome === 'wait') return
  if (outcome === 'skip') { record(id, 'skipped', reason); return }

  const started = Date.now()
  const triggerData = { facture_id: id, document_number: f.document_number, reason }
  try {
    const sent = await sendSlack({
      channel: cfg.slack_channel || null,
      url: cfg.slack_webhook_url || null,
      envName: cfg.slack_webhook_env || null,
      text: renderMessage(cfg.message, f, upgrade ? cfg.upgrade_prefix : ''),
    })
    if (!sent.sent) throw new Error(`aucun canal Slack joignable (${sent.missing || 'non configuré'})`)
    record(id, 'sent', reason)
    logSystemRun(FACTURE_PAID_SLACK_ID, {
      status: 'success',
      result: `Facture ${f.document_number || id} (${reason}) → ${cfg.slack_channel || sent.env || 'webhook'}\n${factureUrl(id)}`,
      duration_ms: Date.now() - started,
      triggerData,
    })
  } catch (e) {
    record(id, 'error', e.message)
    logSystemRun(FACTURE_PAID_SLACK_ID, {
      status: 'error',
      error: `Facture ${f.document_number || id} : ${e.message}`,
      duration_ms: Date.now() - started,
      triggerData,
    })
  }
}

const watcher = createChangeLogWatcher({
  name: 'facturePaidSlackWatcher',
  intervalMs: 5000,
  tables: 'factures',
  batchSize: 200,
  isEnabled: () => isSystemAutomationActive(FACTURE_PAID_SLACK_ID),
  onRows: async (rows, { advance }) => {
    if (!rows.length) return 0
    const cfg = getFacturePaidSlackConfig()
    const seen = new Set()
    for (const row of rows) {
      advance(row.id)
      if (seen.has(row.record_id)) continue
      seen.add(row.record_id)
      await processFacture(row.record_id, cfg)
    }
    return rows.length
  },
})

/**
 * Ajout approuvé à un abonnement existant : sa facture de prorata sera
 * annoncée. Si elle a déjà été écartée (paiement récurrent, webhook arrivé
 * avant), elle est réévaluée.
 */
export function markUpgradeInvoice(sub, source) {
  const inv = typeof sub?.latest_invoice === 'string' ? sub.latest_invoice : sub?.latest_invoice?.id
  if (!inv) return
  try {
    db.prepare('INSERT OR IGNORE INTO subscription_upgrade_invoices (stripe_invoice_id, stripe_subscription_id, source) VALUES (?,?,?)').run(inv, sub.id, source)
    const f = db.prepare('SELECT id FROM factures WHERE invoice_id=?').get(inv)
    if (!f) return
    db.prepare("DELETE FROM facture_paid_notifications WHERE facture_id=? AND outcome='skipped'").run(f.id)
    if (isSystemAutomationActive(FACTURE_PAID_SLACK_ID)) processFacture(f.id).catch(e => console.error('upgrade slack:', e.message))
  } catch (e) { console.error('markUpgradeInvoice:', e.message) }
}

export const pollOnce = watcher.pollOnce
export function startFacturePaidSlackWatcher() { watcher.start() }
export function stopFacturePaidSlackWatcher() { watcher.stop() }
