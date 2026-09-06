// Comptes prépayés — volet 1 : soldes fournisseurs prépayés (ledger),
// volet 2 : cédule de continuité des frais payés d'avance (#13000).
import { Router } from 'express'
import { newRecordId } from '../utils/recordId.js'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { buildPartialUpdate } from '../utils/partialUpdate.js'
import {
  ledgerEntries, ledgerBalance, syncPrepaidAccountFromQB, fetchProviderBalance,
  auditPrepaidAccountAgainstQB, continuityView, buildFpaMonth, publishFpaMonth,
} from '../services/prepaid.js'

const router = Router()
router.use(requireAuth)

const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))
const isMonth = v => /^\d{4}-\d{2}$/.test(String(v || ''))

// ── Comptes ─────────────────────────────────────────────────────────────────

const ACCOUNT_FIELDS = ['vendor', 'currency', 'qb_vendor_name', 'qb_asset_acctnum',
  'balance_provider', 'sync_start_date', 'active', 'notes']

router.get('/accounts', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM prepaid_accounts WHERE deleted_at IS NULL ORDER BY active DESC, vendor COLLATE NOCASE
  `).all()
  for (const r of rows) r.balance = ledgerBalance(r.id)
  res.json(rows)
})

router.post('/accounts', (req, res) => {
  const b = req.body
  if (!b.vendor || !String(b.vendor).trim()) return res.status(400).json({ error: 'vendor requis' })
  if (b.sync_start_date && !isDate(b.sync_start_date)) return res.status(400).json({ error: 'sync_start_date invalide (YYYY-MM-DD)' })
  const id = newRecordId()
  db.prepare(`
    INSERT INTO prepaid_accounts (id, vendor, currency, qb_vendor_name, qb_asset_acctnum, balance_provider, sync_start_date, active, notes, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(id, String(b.vendor).trim(), b.currency || 'USD', b.qb_vendor_name || null,
    b.qb_asset_acctnum || null, b.balance_provider || null, b.sync_start_date || null,
    b.active === 0 || b.active === false ? 0 : 1, b.notes || null, req.user.id)
  res.status(201).json(db.prepare('SELECT * FROM prepaid_accounts WHERE id = ?').get(id))
})

router.put('/accounts/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM prepaid_accounts WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  if ('sync_start_date' in req.body && req.body.sync_start_date && !isDate(req.body.sync_start_date)) {
    return res.status(400).json({ error: 'sync_start_date invalide (YYYY-MM-DD)' })
  }
  const { setClause, values, error } = buildPartialUpdate(req.body, {
    allowed: ACCOUNT_FIELDS, nonNullable: new Set(['vendor']),
  })
  if (error) return res.status(400).json({ error })
  if (setClause) {
    // Changer le fournisseur QB visé invalide l'id résolu en cache.
    const resetVendorId = 'qb_vendor_name' in req.body ? ', qb_vendor_id = NULL' : ''
    db.prepare(`UPDATE prepaid_accounts SET ${setClause}${resetVendorId}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(...values, req.params.id)
  }
  const row = db.prepare('SELECT * FROM prepaid_accounts WHERE id = ?').get(req.params.id)
  row.balance = ledgerBalance(row.id)
  res.json(row)
})

router.delete('/accounts/:id', (req, res) => {
  db.prepare(`UPDATE prepaid_accounts SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND deleted_at IS NULL`)
    .run(req.params.id)
  res.json({ ok: true })
})

// ── Ledger ──────────────────────────────────────────────────────────────────

router.get('/accounts/:id/entries', (req, res) => {
  const account = db.prepare('SELECT * FROM prepaid_accounts WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!account) return res.status(404).json({ error: 'Not found' })
  const entries = ledgerEntries(account.id)
  res.json({ account, balance: entries.length ? entries[entries.length - 1].running_balance : 0, entries })
})

router.post('/accounts/:id/entries', (req, res) => {
  const account = db.prepare('SELECT id FROM prepaid_accounts WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!account) return res.status(404).json({ error: 'Not found' })
  const b = req.body
  if (!isDate(b.entry_date)) return res.status(400).json({ error: 'entry_date invalide (YYYY-MM-DD)' })
  if (!['recharge', 'facture', 'ajustement'].includes(b.type)) return res.status(400).json({ error: 'type invalide' })
  const amount = Number(b.amount)
  if (!Number.isFinite(amount) || amount === 0) return res.status(400).json({ error: 'amount doit être un nombre non nul' })
  if (b.type !== 'ajustement' && amount < 0) return res.status(400).json({ error: 'amount doit être positif (le signe vient du type)' })
  const source = b.source === 'import' ? 'import' : 'manuel'
  const id = newRecordId()
  db.prepare(`
    INSERT INTO prepaid_ledger_entries (id, account_id, entry_date, type, amount, description, source)
    VALUES (?,?,?,?,?,?,?)
  `).run(id, req.params.id, b.entry_date, b.type, amount, b.description || null, source)
  res.status(201).json(db.prepare('SELECT * FROM prepaid_ledger_entries WHERE id = ?').get(id))
})

router.put('/entries/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM prepaid_ledger_entries WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  if ('entry_date' in req.body && !isDate(req.body.entry_date)) return res.status(400).json({ error: 'entry_date invalide' })
  if ('type' in req.body && !['recharge', 'facture', 'ajustement'].includes(req.body.type)) return res.status(400).json({ error: 'type invalide' })
  if ('amount' in req.body && (!Number.isFinite(Number(req.body.amount)) || Number(req.body.amount) === 0)) {
    return res.status(400).json({ error: 'amount doit être un nombre non nul' })
  }
  const { setClause, values, error } = buildPartialUpdate(req.body, {
    allowed: ['entry_date', 'type', 'amount', 'description', 'excluded'],
    nonNullable: new Set(['entry_date', 'type', 'amount']),
  })
  if (error) return res.status(400).json({ error })
  if (setClause) {
    db.prepare(`UPDATE prepaid_ledger_entries SET ${setClause}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(...values, req.params.id)
  }
  res.json(db.prepare('SELECT * FROM prepaid_ledger_entries WHERE id = ?').get(req.params.id))
})

router.delete('/entries/:id', (req, res) => {
  db.prepare(`UPDATE prepaid_ledger_entries SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND deleted_at IS NULL`)
    .run(req.params.id)
  res.json({ ok: true })
})

router.post('/accounts/:id/sync-qb', async (req, res) => {
  try {
    res.json(await syncPrepaidAccountFromQB(req.params.id, 'manual'))
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

// Audit de complétude ledger vs QB (fenêtre complète). apply=true corrige.
router.post('/accounts/:id/audit-qb', async (req, res) => {
  try {
    res.json(await auditPrepaidAccountAgainstQB(req.params.id, { apply: req.body?.apply === true }))
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

router.get('/accounts/:id/provider-balance', async (req, res) => {
  const account = db.prepare('SELECT * FROM prepaid_accounts WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!account) return res.status(404).json({ error: 'Not found' })
  res.json(await fetchProviderBalance(account))
})

// ── Cédule FPA ──────────────────────────────────────────────────────────────

const EXPENSE_FIELDS = ['label', 'description', 'payment_date', 'amount', 'currency',
  'method', 'monthly_amount', 'amort_start', 'amort_end', 'expense_acctnum', 'fpa_acctnum', 'active', 'notes']

const EXPENSE_METHODS = ['prorata_jours', 'mensuel_fixe', 'manuel', 'aucun']

function validateExpense(b, { partial = false } = {}) {
  if (!partial && (!b.label || !String(b.label).trim())) return 'label requis'
  if ('label' in b && partial && !String(b.label || '').trim()) return 'label requis'
  if (!partial || 'amount' in b) {
    const n = Number(b.amount)
    if (!Number.isFinite(n) || n <= 0) return 'amount doit être un nombre positif'
  }
  if ('method' in b && b.method != null && !EXPENSE_METHODS.includes(b.method)) return 'method invalide'
  if ('monthly_amount' in b && b.monthly_amount != null && b.monthly_amount !== '') {
    const n = Number(b.monthly_amount)
    if (!Number.isFinite(n) || n <= 0) return 'monthly_amount doit être un nombre positif'
  }
  for (const k of ['payment_date', 'amort_start', 'amort_end']) {
    if (k in b && b[k] != null && b[k] !== '' && !isDate(b[k])) return `${k} invalide (YYYY-MM-DD)`
  }
  return null
}

router.get('/expenses', (req, res) => {
  const startYear = Number(req.query.fy) || (() => {
    // Exercice courant : avril → mars, donc janv–mars appartiennent à l'exercice
    // débuté l'année précédente.
    const now = new Date()
    return now.getUTCMonth() >= 3 ? now.getUTCFullYear() : now.getUTCFullYear() - 1
  })()
  res.json(continuityView(startYear))
})

router.post('/expenses', (req, res) => {
  const error = validateExpense(req.body)
  if (error) return res.status(400).json({ error })
  const b = req.body
  const id = newRecordId()
  db.prepare(`
    INSERT INTO prepaid_expenses (id, label, description, payment_date, amount, currency, method, monthly_amount, amort_start, amort_end, expense_acctnum, fpa_acctnum, active, notes, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, String(b.label).trim(), b.description || null, b.payment_date || null, Number(b.amount),
    b.currency || 'CAD', b.method || 'prorata_jours',
    b.monthly_amount === '' || b.monthly_amount == null ? null : Number(b.monthly_amount),
    b.amort_start || null, b.amort_end || null,
    b.expense_acctnum || null, b.fpa_acctnum || '13000',
    b.active === 0 || b.active === false ? 0 : 1, b.notes || null, req.user.id)
  res.status(201).json(db.prepare('SELECT * FROM prepaid_expenses WHERE id = ?').get(id))
})

router.put('/expenses/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM prepaid_expenses WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  const error = validateExpense(req.body, { partial: true })
  if (error) return res.status(400).json({ error })
  const { setClause, values, error: buildError } = buildPartialUpdate(req.body, {
    allowed: EXPENSE_FIELDS, nonNullable: new Set(['label', 'amount', 'method']),
  })
  if (buildError) return res.status(400).json({ error: buildError })
  if (setClause) {
    db.prepare(`UPDATE prepaid_expenses SET ${setClause}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(...values, req.params.id)
  }
  res.json(db.prepare('SELECT * FROM prepaid_expenses WHERE id = ?').get(req.params.id))
})

router.delete('/expenses/:id', (req, res) => {
  db.prepare(`UPDATE prepaid_expenses SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND deleted_at IS NULL`)
    .run(req.params.id)
  res.json({ ok: true })
})

// Ligne d'amortissement manuelle / historique importé (déjà comptabilisé → passer pushed:true).
router.post('/expenses/:id/amortizations', (req, res) => {
  const expense = db.prepare('SELECT id FROM prepaid_expenses WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!expense) return res.status(404).json({ error: 'Not found' })
  const b = req.body
  if (!isMonth(b.month)) return res.status(400).json({ error: 'month invalide (YYYY-MM)' })
  const amount = Number(b.amount)
  if (!Number.isFinite(amount)) return res.status(400).json({ error: 'amount doit être un nombre' })
  const source = b.source === 'import' ? 'import' : 'manuel'
  const id = newRecordId()
  try {
    db.prepare(`
      INSERT INTO prepaid_amortizations (id, expense_id, month, amount, source, pushed_at)
      VALUES (?,?,?,?,?,?)
    `).run(id, req.params.id, b.month, amount, source, b.pushed ? new Date().toISOString() : null)
  } catch {
    return res.status(409).json({ error: 'Une ligne existe déjà pour ce mois — la modifier plutôt' })
  }
  res.status(201).json(db.prepare('SELECT * FROM prepaid_amortizations WHERE id = ?').get(id))
})

router.put('/amortizations/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM prepaid_amortizations WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  if (existing.qb_je_id) return res.status(400).json({ error: 'Ligne déjà publiée dans QB — non modifiable' })
  const amount = Number(req.body.amount)
  if (!Number.isFinite(amount)) return res.status(400).json({ error: 'amount doit être un nombre' })
  db.prepare(`UPDATE prepaid_amortizations SET amount = ?, source = 'manuel', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
    .run(amount, req.params.id)
  res.json(db.prepare('SELECT * FROM prepaid_amortizations WHERE id = ?').get(req.params.id))
})

router.delete('/amortizations/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM prepaid_amortizations WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  if (existing.qb_je_id) return res.status(400).json({ error: 'Ligne déjà publiée dans QB — non supprimable' })
  db.prepare(`UPDATE prepaid_amortizations SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
    .run(req.params.id)
  res.json({ ok: true })
})

router.get('/fpa/month/:month', (req, res) => {
  if (!isMonth(req.params.month)) return res.status(400).json({ error: 'month invalide (YYYY-MM)' })
  res.json(buildFpaMonth(req.params.month))
})

// Publication de l'écriture du mois — action transactionnelle approuvée par
// l'utilisateur (bouton), jamais automatique.
router.post('/fpa/month/:month/publish', async (req, res) => {
  try {
    res.json(await publishFpaMonth(req.params.month, { userId: req.user.id }))
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

export default router
