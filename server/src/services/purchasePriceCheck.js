// Vérificateur de prix des achats (table `purchases`, miroir Airtable « Achats »).
//
// Dans Airtable, le prix unitaire d'un achat est CALCULÉ : total facturé (lookup
// des « Dépense Line item » liés) ÷ quantité commandée. Un lien de dépense erroné
// — le match automatique Airtable a déjà lié la ligne d'une autre pièce — produit
// un prix absurde (cas réel : Raspberry Pi à 1 $ au lieu de 81,85 $, 2026-09-01)
// qui se propage à l'ERP au sync et fausse la valeur d'inventaire.
//
// Ce module compare chaque prix unitaire à une référence (médiane des autres
// achats de la même pièce, sinon coût de référence du produit) et signale les
// écarts d'ordre de grandeur. Il signale aussi un achat facturé (dépense liée)
// dont le prix reste à 0. Un achat à 0 $ SANS dépense liée est normal : la
// facture n'est pas encore entrée.
//
// Même squelette que addressCheck.js : verdict persisté sur la ligne, watcher
// change_log (toute origine d'écriture couverte, sync Airtable inclus),
// notification in-app anti-spam (re-signaler le même problème ne re-sonne pas),
// passe complète à la demande qui ne notifie jamais.

import db from '../db/database.js'
import { createNotification } from './notifications.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'
import { createChangeLogWatcher } from './changeLogWatcher.js'

export const PURCHASE_PRICE_CHECK_AUTOMATION_ID = 'sys_purchase_price_check'

export const PURCHASE_PRICE_CHECK_DEFAULT_CONFIG = {
  // Bornes du ratio prix observé / prix de référence hors desquelles on signale.
  ratio_min: '0.25',
  ratio_max: '4',
  // Écart unitaire minimal en $ CAD pour signaler (évite le bruit sur les
  // pièces à quelques sous, dont le prix varie beaucoup en relatif).
  min_abs_diff: '20',
  // Destinataires des notifications in-app : rôles (admin, sales…) et/ou
  // emails de comptes précis, séparés par des virgules.
  fallback_roles: 'antoine.lambert96@gmail.com',
  // 0 = vérifie et affiche, mais n'envoie aucune notification.
  notify: '1',
}

export function getPurchasePriceCheckConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id = ?').get(PURCHASE_PRICE_CHECK_AUTOMATION_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch {}
  const merged = { ...PURCHASE_PRICE_CHECK_DEFAULT_CONFIG }
  for (const k of Object.keys(PURCHASE_PRICE_CHECK_DEFAULT_CONFIG)) {
    if (cfg[k] != null && String(cfg[k]).trim() !== '') merged[k] = String(cfg[k]).trim()
  }
  const num = (v, fallback) => {
    const n = parseFloat(String(v).replace(',', '.'))
    return Number.isFinite(n) && n > 0 ? n : fallback
  }
  return {
    ratioMin: num(merged.ratio_min, 0.25),
    ratioMax: num(merged.ratio_max, 4),
    minAbsDiff: num(merged.min_abs_diff, 20),
    fallbackRoles: merged.fallback_roles.split(/[,\s]+/).filter(Boolean),
    notify: merged.notify !== '0',
  }
}

// ── Référence de prix ────────────────────────────────────────────────────────

function median(values) {
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/**
 * Prix unitaire de référence d'une pièce : médiane des AUTRES achats non annulés
 * à prix connu (≥ 2 points), sinon coût de référence du produit, sinon le seul
 * autre achat connu. null = pas de référence, l'achat n'est pas jugeable.
 */
export function referenceUnitCost(productId, excludePurchaseId) {
  if (!productId) return null
  const costs = db.prepare(`
    SELECT unit_cost FROM purchases
    WHERE product_id = ? AND id <> ? AND status <> 'Annulé' AND unit_cost > 0
  `).all(productId, excludePurchaseId || '').map(r => r.unit_cost)
  if (costs.length >= 2) return { ref: median(costs), source: `médiane de ${costs.length} achats` }
  const p = db.prepare('SELECT unit_cost FROM products WHERE id = ?').get(productId)
  if (p?.unit_cost > 0) return { ref: p.unit_cost, source: 'coût de référence du produit' }
  if (costs.length === 1) return { ref: costs[0], source: 'seul autre achat connu' }
  return null
}

// ── Évaluation (pure, testable) ──────────────────────────────────────────────

const money = v => `${(Math.round(v * 100) / 100).toLocaleString('fr-CA', { minimumFractionDigits: 2 })} $`

const hasLinkedExpense = v => !!(v && String(v).trim() && String(v).trim() !== '[]')

/**
 * Juge un achat contre sa référence de prix. `reference` = { ref, source } ou null.
 * Retourne { status: 'ok'|'error', issues: [{ code, message }] }.
 */
export function evaluatePurchasePrice(purchase, reference, cfg) {
  const issues = []
  const uc = purchase.unit_cost ?? 0

  if (uc > 0 && reference) {
    const ratio = uc / reference.ref
    const absDiff = Math.abs(uc - reference.ref)
    if ((ratio < cfg.ratioMin || ratio > cfg.ratioMax) && absDiff >= cfg.minAbsDiff) {
      issues.push({
        code: ratio < 1 ? 'price_low' : 'price_high',
        message: `Prix unitaire ${money(uc)} alors que la référence est ~${money(reference.ref)} (${reference.source}). `
          + `Vérifier le lien « Dépense Line item » de l'achat dans Airtable — un lien vers la ligne d'une autre pièce fausse le prix calculé.`,
      })
    }
  }

  // Facture entrée (dépense liée) mais prix resté à 0 : la formule Airtable n'a
  // rien donné (lookup cassé) ou la quantité est nulle. Sans dépense liée, 0 $
  // est l'état normal d'une commande pas encore facturée — on ne signale pas.
  if (uc === 0 && hasLinkedExpense(purchase.depense_line_item)) {
    issues.push({
      code: 'invoiced_zero',
      message: 'Une dépense est liée à cet achat mais le prix unitaire est à 0 $ — le prix calculé dans Airtable ne suit pas.',
    })
  }

  return { status: issues.length ? 'error' : 'ok', issues }
}

// ── Persistance + notification ───────────────────────────────────────────────

const signature = issues => issues.map(i => i.code).sort().join('|')

// Un token avec « @ » désigne un compte par email, sinon un rôle.
function notifyTargets(fallbackRoles) {
  if (!fallbackRoles.length) return []
  const roles = fallbackRoles.filter(t => !t.includes('@'))
  const emails = fallbackRoles.filter(t => t.includes('@'))
  const ids = new Set()
  if (roles.length) {
    const ph = roles.map(() => '?').join(',')
    for (const r of db.prepare(`SELECT id FROM users WHERE active = 1 AND role IN (${ph})`).all(...roles)) ids.add(r.id)
  }
  if (emails.length) {
    const ph = emails.map(() => '?').join(',')
    for (const r of db.prepare(`SELECT id FROM users WHERE active = 1 AND email IN (${ph})`).all(...emails)) ids.add(r.id)
  }
  return [...ids]
}

// Anti-boucle : écriture seulement si le verdict change — notre propre UPDATE
// retombe dans change_log, la passe suivante trouve le même verdict et s'arrête.
function persistVerdict(row, cfg, { notify = true } = {}) {
  const reference = referenceUnitCost(row.product_id, row.id)
  const { status, issues } = evaluatePurchasePrice(row, reference, cfg)
  let prevIssues = []
  try { prevIssues = JSON.parse(row.price_check_issues || '[]') } catch {}
  const nextJson = JSON.stringify(issues)
  const stale = row.price_check_status !== status || row.price_check_issues !== nextJson
  const changed = row.price_check_status !== status || signature(prevIssues) !== signature(issues)

  if (stale) {
    db.prepare(`
      UPDATE purchases
         SET price_check_status = ?, price_check_issues = ?, price_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ?
    `).run(status, nextJson, row.id)
  }

  let notified = false
  if (notify && cfg.notify && status === 'error' && changed) {
    const label = [row.product_name, row.reference ? `PO ${row.reference}` : null].filter(Boolean).join(' — ')
      || `achat ${row.id}`
    const body = issues.map(i => `• ${i.message}`).join('\n')
    for (const userId of notifyTargets(cfg.fallbackRoles)) {
      if (createNotification({
        userId, type: 'purchase_price_check',
        title: `Prix d'achat suspect — ${label}`,
        body, link: `/purchases/${row.id}`,
      })) notified = true
    }
  }
  return { status, issues, notified }
}

const PURCHASE_ROW_SQL = `
  SELECT p.id, p.product_id, p.reference, p.unit_cost, p.qty_ordered, p.status,
         p.depense_line_item, p.price_check_status, p.price_check_issues,
         pr.name_fr AS product_name
  FROM purchases p
  LEFT JOIN products pr ON pr.id = p.product_id
`

/** Vérifie un achat, persiste le verdict, notifie s'il vient de devenir fautif. Ne lève jamais. */
export function checkPurchase(purchaseId, { notify = true } = {}) {
  try {
    const row = db.prepare(`${PURCHASE_ROW_SQL} WHERE p.id = ?`).get(purchaseId)
    if (!row || row.status === 'Annulé') return null
    return persistVerdict(row, getPurchasePriceCheckConfig(), { notify })
  } catch (e) {
    console.error('⚠️  checkPurchase:', e.message)
    return null
  }
}

/**
 * Passe complète. `apply: false` = simulation sans écriture. Comme pour les
 * adresses, une passe complète ne notifie JAMAIS : elle rafraîchit l'état,
 * la notification est réservée à l'achat qui VIENT de devenir fautif (watcher).
 */
export function runPurchasePriceCheck({ trigger = 'manuel', apply = true, notify = false, log = true } = {}) {
  const started = Date.now()
  const rows = db.prepare(`${PURCHASE_ROW_SQL} WHERE p.status <> 'Annulé'`).all()
  const cfg = getPurchasePriceCheckConfig()

  const counts = { total: rows.length, ok: 0, error: 0, notified: 0 }
  const problems = []
  for (const row of rows) {
    const verdict = apply
      ? persistVerdict(row, cfg, { notify })
      : evaluatePurchasePrice(row, referenceUnitCost(row.product_id, row.id), cfg)
    counts[verdict.status]++
    if (verdict.notified) counts.notified++
    if (verdict.status !== 'ok') {
      problems.push({
        id: row.id,
        reference: row.reference,
        product_name: row.product_name,
        unit_cost: row.unit_cost,
        issues: verdict.issues,
      })
    }
  }

  const summary = `${counts.total} achat(s) · ${counts.error} prix suspect(s)`
    + (apply ? (notify ? ` · ${counts.notified} notification(s)` : '') : ' · simulation')
  if (log) {
    logSystemRun(PURCHASE_PRICE_CHECK_AUTOMATION_ID, {
      status: 'success',
      result: { summary, counts, problems: problems.slice(0, 50) },
      duration_ms: Date.now() - started,
      triggerData: { trigger, apply },
    })
  }
  return { summary, counts, problems }
}

// ── Watcher (change_log) ─────────────────────────────────────────────────────
//
// Toute mutation de `purchases` — sync Airtable en tête, c'est lui qui importe
// le prix cassé — passe par le change_log : la couverture est exhaustive.

const POLL_MS = 5000
const BATCH = 500

const watcher = createChangeLogWatcher({
  name: 'purchasePriceCheck',
  intervalMs: POLL_MS,
  tables: 'purchases',
  maxIdTables: 'purchases',
  batchSize: BATCH,
  isEnabled: () => isSystemAutomationActive(PURCHASE_PRICE_CHECK_AUTOMATION_ID),
  onRows: (rows, { advance }) => {
    const seen = new Set()
    for (const row of rows) {
      advance(row.id)
      if (seen.has(row.record_id)) continue
      seen.add(row.record_id)
      checkPurchase(row.record_id)
    }
    return seen.size
  },
  startLog: `watcher démarré (poll ${POLL_MS}ms sur change_log(purchases))`,
})

export const pollPurchaseChangesOnce = watcher.pollOnce

export function startPurchasePriceCheckWatcher() {
  // Démarre à la pointe : l'historique se rejoue à la demande (« Exécuter »).
  watcher.start()
}

export function stopPurchasePriceCheckWatcher() { watcher.stop() }

export default { evaluatePurchasePrice, referenceUnitCost, checkPurchase, runPurchasePriceCheck }
