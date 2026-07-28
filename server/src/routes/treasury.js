import { Router } from 'express'
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { buildPartialUpdate } from '../utils/partialUpdate.js'
import { requireAuth } from '../middleware/auth.js'
import { computeProjection, checkTreasuryAlert, variableOccurrence } from '../services/treasury.js'

const router = Router()
router.use(requireAuth)

// Projection jour par jour du solde BNC CAD.
router.get('/projection', (req, res) => {
  res.json(computeProjection({ days: req.query.days }))
})

// ── Solde disponible réel (saisie rapide) ────────────────────────────────────

router.get('/balances', (req, res) => {
  const rows = db.prepare(`
    SELECT b.*, u.name AS created_by_name FROM treasury_balances b
    LEFT JOIN users u ON u.id = b.created_by
    ORDER BY b.noted_at DESC LIMIT 20
  `).all()
  res.json(rows)
})

router.post('/balance', (req, res) => {
  const n = Number(req.body.balance)
  if (!Number.isFinite(n)) return res.status(400).json({ error: 'balance doit être un nombre' })
  const id = randomUUID()
  db.prepare('INSERT INTO treasury_balances (id, balance, created_by) VALUES (?,?,?)')
    .run(id, Math.round(n * 100) / 100, req.user.id)
  const created = db.prepare('SELECT * FROM treasury_balances WHERE id=?').get(id)
  // Une saisie de solde est le bon moment pour re-vérifier l'alerte.
  checkTreasuryAlert({ trigger: 'saisie solde' }).catch(() => {})
  res.status(201).json(created)
})

// Suppression d'une saisie de solde (correction d'une erreur de frappe, cleanup E2E).
router.delete('/balance/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM treasury_balances WHERE id=?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  db.prepare('DELETE FROM treasury_balances WHERE id=?').run(req.params.id)
  res.json({ ok: true })
})

// ── Sorties récurrentes ──────────────────────────────────────────────────────

const RECURRING_FIELDS = ['label', 'amount', 'frequency', 'day_of_month', 'anchor_date', 'active', 'notes', 'variable_amount']

function validateRecurring(body, { partial = false } = {}) {
  if (!partial && (!body.label || !String(body.label).trim())) return 'label requis'
  if ('frequency' in body && body.frequency != null &&
      !['weekly', 'biweekly', 'monthly', 'quarterly'].includes(body.frequency)) {
    return 'frequency invalide (weekly, biweekly, monthly, quarterly)'
  }
  if ('amount' in body && body.amount !== null && body.amount !== '' && body.amount !== undefined) {
    const n = Number(body.amount)
    if (!Number.isFinite(n) || n < 0) return 'amount doit être un nombre positif'
  }
  if ('day_of_month' in body && body.day_of_month != null && body.day_of_month !== '') {
    const n = Number(body.day_of_month)
    if (!Number.isInteger(n) || n < 1 || n > 31) return 'day_of_month doit être entre 1 et 31'
  }
  if ('anchor_date' in body && body.anchor_date && !/^\d{4}-\d{2}-\d{2}$/.test(body.anchor_date)) {
    return 'anchor_date au format YYYY-MM-DD'
  }
  if ('variable_amount' in body && body.variable_amount != null && ![0, 1, true, false].includes(body.variable_amount)) {
    return 'variable_amount doit être 0 ou 1'
  }
  return null
}

// Annote une récurrente à montant variable : date d'application du montant
// saisi (`amount_applies_to`) et péremption (`amount_stale` — occurrence passée,
// montant à ressaisir). Fenêtre de recherche : 1 an après aujourd'hui.
function annotateRecurring(r) {
  if (!r.variable_amount || !(Number(r.amount) > 0)) return r
  const today = new Date()
  const todayIso = today.toISOString().slice(0, 10)
  const end = new Date(today); end.setFullYear(end.getFullYear() + 1)
  const applies = variableOccurrence(r, todayIso, end.toISOString().slice(0, 10))
  return { ...r, amount_applies_to: applies, amount_stale: applies ? 0 : 1 }
}

router.get('/recurring', (req, res) => {
  const rows = db.prepare(
    'SELECT * FROM recurring_outflows WHERE deleted_at IS NULL ORDER BY active DESC, label COLLATE NOCASE'
  ).all()
  res.json(rows.map(annotateRecurring))
})

router.post('/recurring', (req, res) => {
  const error = validateRecurring(req.body)
  if (error) return res.status(400).json({ error })
  const b = req.body
  const id = randomUUID()
  const amount = b.amount === '' || b.amount == null ? null : Number(b.amount)
  db.prepare(`
    INSERT INTO recurring_outflows (id, label, amount, frequency, day_of_month, anchor_date, active, notes, variable_amount, amount_entered_at)
    VALUES (?,?,?,?,?,?,?,?,?, CASE WHEN ? IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END)
  `).run(
    id, String(b.label).trim(),
    amount,
    b.frequency || 'monthly',
    b.day_of_month === '' || b.day_of_month == null ? null : Number(b.day_of_month),
    b.anchor_date || null,
    b.active === 0 || b.active === false ? 0 : 1,
    b.notes || null,
    b.variable_amount === 1 || b.variable_amount === true ? 1 : 0,
    amount
  )
  res.status(201).json(annotateRecurring(db.prepare('SELECT * FROM recurring_outflows WHERE id=?').get(id)))
})

router.put('/recurring/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM recurring_outflows WHERE id=? AND deleted_at IS NULL').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  const error = validateRecurring(req.body, { partial: true })
  if (error) return res.status(400).json({ error })
  const { setClause, values, error: buildError } = buildPartialUpdate(req.body, {
    allowed: RECURRING_FIELDS,
    nonNullable: new Set(['label', 'frequency']),
  })
  if (buildError) return res.status(400).json({ error: buildError })
  if (setClause) {
    db.prepare(`UPDATE recurring_outflows SET ${setClause}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(...values, req.params.id)
  }
  // Chaque (re)saisie du montant est horodatée : pour les montants variables,
  // elle détermine l'unique occurrence à laquelle le montant s'applique.
  if ('amount' in req.body) {
    db.prepare(`
      UPDATE recurring_outflows
      SET amount_entered_at = CASE WHEN amount IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END
      WHERE id = ?
    `).run(req.params.id)
  }
  res.json(annotateRecurring(db.prepare('SELECT * FROM recurring_outflows WHERE id=?').get(req.params.id)))
})

router.delete('/recurring/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM recurring_outflows WHERE id=? AND deleted_at IS NULL').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  db.prepare(`UPDATE recurring_outflows SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?`)
    .run(req.params.id)
  res.json({ ok: true })
})

export default router
