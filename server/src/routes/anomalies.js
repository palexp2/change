// Anomalies transactionnelles — doublons probables, montants hors norme, devise
// incohérente sur les factures fournisseurs. Détection : transactionAnomalies.js.
import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { runAnomalyScan, runQbLinkVerification } from '../services/transactionAnomalies.js'

const router = Router()
router.use(requireAuth)

function serialize(row) {
  let details = {}
  try { details = JSON.parse(row.details || '{}') } catch {}
  return { ...row, details }
}

// GET /api/anomalies?status=open — liste (défaut : ouvertes), plus récentes d'abord.
router.get('/', (req, res) => {
  const status = ['open', 'dismissed', 'resolved', 'all'].includes(req.query.status) ? req.query.status : 'open'
  // entity_id : anomalies d'un document précis (bandeau sur la fiche du reçu).
  const entityId = String(req.query.entity_id || '').trim()
  const clauses = []
  const params = []
  if (status !== 'all') { clauses.push('a.status = ?'); params.push(status) }
  if (entityId) { clauses.push('a.entity_id = ?'); params.push(entityId) }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  const rows = db.prepare(`
    SELECT a.*, r.company AS receipt_company, r.receipt_number, r.receipt_date, r.total AS receipt_total,
           r.currency AS receipt_currency, r.quickbooks_id AS receipt_qb_id, r.deleted_at AS receipt_deleted_at
    FROM transaction_anomalies a
    LEFT JOIN sale_receipts r ON r.id = a.entity_id AND a.entity_type = 'sale_receipt'
    ${where}
    ORDER BY a.created_at DESC
    LIMIT 200
  `).all(...params)
  res.json({ data: rows.map(serialize) })
})

// POST /api/anomalies/:id/dismiss — faux positif : n'est jamais recréée (même fingerprint).
router.post('/:id/dismiss', (req, res) => {
  const reason = String(req.body?.reason || '').trim() || null
  const r = db.prepare(`
    UPDATE transaction_anomalies
    SET status='dismissed', dismissed_by=?, dismissed_reason=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id=? AND status='open'
  `).run(req.user?.id || null, reason, req.params.id)
  if (!r.changes) return res.status(404).json({ error: 'Anomalie introuvable ou déjà traitée' })
  res.json({ ok: true })
})

// POST /api/anomalies/:id/reopen — annuler un dismiss.
router.post('/:id/reopen', (req, res) => {
  const r = db.prepare(`
    UPDATE transaction_anomalies
    SET status='open', dismissed_by=NULL, dismissed_reason=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id=? AND status='dismissed'
  `).run(req.params.id)
  if (!r.changes) return res.status(404).json({ error: 'Anomalie introuvable ou non rejetée' })
  res.json({ ok: true })
})

// POST /api/anomalies/scan — relance manuelle du scan complet.
router.post('/scan', async (req, res) => {
  try {
    const out = runAnomalyScan('manual')
    // Vérification des liens QB (appels API) : un reçu peut pointer une écriture
    // supprimée depuis dans QuickBooks.
    const qb = await runQbLinkVerification('manual')
    res.json({ ...out, qb_checked: qb.checked, qb_missing: qb.missing })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
