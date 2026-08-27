// Budget marketing (Émilie) — file de validation des dépenses détectées dans
// QuickBooks, règles d'exclusion par fournisseur, Budget vs Réel (remplace le
// fichier Drive « Annual Marketing budget ») et message Slack hebdomadaire.
import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { qbEntityUrl } from '../connectors/quickbooks.js'
import {
  syncMarketingExpenses, listRules, createRule, applyRuleToPending,
  previewWeeklyMarketingSlack, checkWeeklyMarketingSlack,
  budgetSummary, upsertBudgetCell, pendingCount, lastSyncInfo,
} from '../services/marketingBudget.js'

const router = Router()
router.use(requireAuth)

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`

function withQbUrl(e) {
  return { ...e, qb_url: e.qb_txn_id && e.qb_txn_type ? qbEntityUrl(e.qb_txn_type, e.qb_txn_id) : null }
}

// ── Dépenses ─────────────────────────────────────────────────────────────────

// status : pending | relevant | not_relevant | all (défaut : all)
router.get('/expenses', (req, res) => {
  const { status = 'all', limit = 500 } = req.query
  const where = ['e.deleted_at IS NULL']
  const args = []
  if (['pending', 'relevant', 'not_relevant'].includes(status)) { where.push('e.status = ?'); args.push(status) }
  const rows = db.prepare(`
    SELECT e.*, r.vendor_label AS rule_label
    FROM marketing_expenses e
    LEFT JOIN marketing_expense_rules r ON r.id = e.rule_id
    WHERE ${where.join(' AND ')}
    ORDER BY e.txn_date DESC, e.created_at DESC LIMIT ?
  `).all(...args, Math.min(2000, Math.max(1, Number(limit) || 500)))
  res.json({ expenses: rows.map(withQbUrl), pending: pendingCount(), last_sync: lastSyncInfo() })
})

// Décision : { status: 'relevant' | 'not_relevant' | 'pending' }
router.patch('/expenses/:id', (req, res) => {
  const { status } = req.body
  if (!['relevant', 'not_relevant', 'pending'].includes(status)) {
    return res.status(400).json({ error: "status doit valoir 'relevant', 'not_relevant' ou 'pending'" })
  }
  const row = db.prepare('SELECT * FROM marketing_expenses WHERE id=? AND deleted_at IS NULL').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Dépense introuvable' })
  db.prepare(`
    UPDATE marketing_expenses SET status=?, rule_id=NULL,
      decided_at=CASE WHEN ?='pending' THEN NULL ELSE ${NOW} END,
      decided_by=CASE WHEN ?='pending' THEN NULL ELSE ? END,
      updated_at=${NOW}
    WHERE id=?
  `).run(status, status, status, req.user?.id || null, req.params.id)
  res.json(withQbUrl(db.prepare('SELECT * FROM marketing_expenses WHERE id=?').get(req.params.id)))
})

// « Jamais pertinente » : marque la dépense non pertinente ET crée la règle
// d'exclusion sur son fournisseur (appliquée aux autres lignes en attente).
router.post('/expenses/:id/never', (req, res) => {
  const row = db.prepare('SELECT * FROM marketing_expenses WHERE id=? AND deleted_at IS NULL').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Dépense introuvable' })
  if (!row.vendor) return res.status(400).json({ error: 'Dépense sans fournisseur — exclure manuellement' })
  const allAccounts = req.body?.all_accounts !== false // défaut : tous les comptes marketing
  let rule
  try {
    rule = createRule({
      vendor_label: row.vendor,
      acctnum: allAccounts ? null : row.acctnum,
      note: req.body?.note || null,
    }, req.user?.id || null)
  } catch (e) {
    return res.status(400).json({ error: e.message })
  }
  db.prepare(`
    UPDATE marketing_expenses SET status='not_relevant', rule_id=?, decided_at=${NOW}, decided_by=?, updated_at=${NOW}
    WHERE id=?
  `).run(rule.id, req.user?.id || null, req.params.id)
  const applied = applyRuleToPending(rule)
  res.json({ rule, applied_to_pending: applied })
})

// ── Règles d'exclusion ───────────────────────────────────────────────────────

router.get('/rules', (req, res) => res.json(listRules()))

router.post('/rules', (req, res) => {
  try {
    const rule = createRule({
      vendor_label: req.body?.vendor_label,
      acctnum: req.body?.acctnum || null,
      note: req.body?.note || null,
    }, req.user?.id || null)
    const applied = applyRuleToPending(rule)
    res.json({ rule, applied_to_pending: applied })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// Supprimer une règle ne ré-ouvre PAS les dépenses déjà tranchées par elle —
// on remet seulement en attente celles qu'elle avait exclues automatiquement,
// pour qu'elles repassent devant l'utilisateur.
router.delete('/rules/:id', (req, res) => {
  const rule = db.prepare('SELECT * FROM marketing_expense_rules WHERE id=? AND deleted_at IS NULL').get(req.params.id)
  if (!rule) return res.status(404).json({ error: 'Règle introuvable' })
  db.prepare(`UPDATE marketing_expense_rules SET deleted_at=${NOW} WHERE id=?`).run(rule.id)
  const reopened = db.prepare(`
    UPDATE marketing_expenses SET status='pending', rule_id=NULL, decided_at=NULL, decided_by=NULL, updated_at=${NOW}
    WHERE rule_id=? AND status='not_relevant' AND notified_at IS NULL AND deleted_at IS NULL
  `).run(rule.id)
  res.json({ ok: true, reopened: reopened.changes })
})

// ── Sync & Slack ─────────────────────────────────────────────────────────────

router.post('/sync', async (req, res) => {
  const out = await syncMarketingExpenses({ trigger: 'bouton page Budget marketing', force: true })
  if (out.error) return res.status(502).json(out)
  res.json(out)
})

router.get('/slack/preview', (req, res) => res.json(previewWeeklyMarketingSlack()))

router.post('/slack/send', async (req, res) => {
  const out = await checkWeeklyMarketingSlack({ force: true, trigger: 'bouton page Budget marketing' })
  if (out.error) return res.status(502).json(out)
  res.json(out)
})

// ── Budget vs Réel ───────────────────────────────────────────────────────────

router.get('/summary', (req, res) => {
  const fy = String(req.query.fy || '').trim()
  if (!/^\d{4}$/.test(fy)) return res.status(400).json({ error: 'fy requis (année du 1er avril, ex. 2026)' })
  res.json(budgetSummary(fy))
})

router.put('/budget', (req, res) => {
  try {
    const id = upsertBudgetCell(req.body || {})
    res.json({ ok: true, id })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

export default router
