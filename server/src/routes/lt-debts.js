// Dettes à long terme — cédules de remboursement et comptabilisation des
// versements dans QB (JE : Dr dette (capital) · Dr intérêts · Cr banque).
import { Router } from 'express'
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { buildPartialUpdate } from '../utils/partialUpdate.js'
import { resolveAccountByAcctNum } from '../services/quickbooks.js'
import { qbPost, qbEntityUrl, qbUploadAttachment } from '../connectors/quickbooks.js'
import { buildDebtSchedulePdf } from '../services/ltDebtSchedulePdf.js'
import { logSync } from '../services/syncLog.js'

const router = Router()
router.use(requireAuth)

const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))
const round2 = n => Math.round(n * 100) / 100

const DEBT_FIELDS = ['label', 'lender', 'loan_number', 'currency', 'principal',
  'qb_debt_acctnum', 'qb_interest_acctnum', 'qb_bank_acctnum', 'active', 'notes']

function debtSummary(debt) {
  const payments = db.prepare(`
    SELECT payment_date, principal, interest, balance_after, pushed_at
    FROM lt_debt_payments WHERE debt_id = ? AND deleted_at IS NULL ORDER BY payment_date
  `).all(debt.id)
  const pushed = payments.filter(p => p.pushed_at)
  const lastPushed = pushed[pushed.length - 1] || null
  // Solde restant = balance_after du dernier versement comptabilisé ; avant tout
  // versement comptabilisé, on remonte au solde initial de la cédule (balance_after
  // + capital de la 1re ligne) faute d'historique.
  let remaining = null
  if (lastPushed?.balance_after != null) remaining = lastPushed.balance_after
  else if (payments[0]?.balance_after != null) remaining = round2(payments[0].balance_after + payments[0].principal)
  const today = new Date().toISOString().slice(0, 10)
  const due = payments.filter(p => !p.pushed_at && p.payment_date <= today)
  const next = payments.find(p => !p.pushed_at)
  return {
    payment_count: payments.length,
    pushed_count: pushed.length,
    due_count: due.length,
    due_total: round2(due.reduce((s, p) => s + p.principal + p.interest, 0)),
    remaining_balance: remaining,
    next_payment_date: next?.payment_date || null,
    next_payment_total: next ? round2(next.principal + next.interest) : null,
  }
}

// ── Dettes ──────────────────────────────────────────────────────────────────

router.get('/', (req, res) => {
  const rows = db.prepare(`SELECT * FROM lt_debts WHERE deleted_at IS NULL ORDER BY active DESC, label COLLATE NOCASE`).all()
  for (const r of rows) Object.assign(r, debtSummary(r))
  res.json(rows)
})

router.post('/', (req, res) => {
  const b = req.body
  if (!b.label || !String(b.label).trim()) return res.status(400).json({ error: 'label requis' })
  const id = randomUUID()
  db.prepare(`
    INSERT INTO lt_debts (id, label, lender, loan_number, currency, principal, qb_debt_acctnum, qb_interest_acctnum, qb_bank_acctnum, active, notes, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, String(b.label).trim(), b.lender || null, b.loan_number || null, b.currency || 'CAD',
    Number.isFinite(Number(b.principal)) && b.principal !== '' && b.principal != null ? Number(b.principal) : null,
    b.qb_debt_acctnum || null, b.qb_interest_acctnum || null, b.qb_bank_acctnum || null,
    b.active === 0 || b.active === false ? 0 : 1, b.notes || null, req.user.id)
  res.status(201).json(db.prepare('SELECT * FROM lt_debts WHERE id = ?').get(id))
})

router.put('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM lt_debts WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  const { setClause, values, error } = buildPartialUpdate(req.body, {
    allowed: DEBT_FIELDS, nonNullable: new Set(['label']),
  })
  if (error) return res.status(400).json({ error })
  if (setClause) {
    db.prepare(`UPDATE lt_debts SET ${setClause}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
      .run(...values, req.params.id)
  }
  const row = db.prepare('SELECT * FROM lt_debts WHERE id = ?').get(req.params.id)
  Object.assign(row, debtSummary(row))
  res.json(row)
})

router.delete('/:id', (req, res) => {
  db.prepare(`UPDATE lt_debts SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND deleted_at IS NULL`)
    .run(req.params.id)
  res.json({ ok: true })
})

// ── Cédule (versements) ─────────────────────────────────────────────────────

router.get('/:id/payments', (req, res) => {
  const debt = db.prepare('SELECT * FROM lt_debts WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!debt) return res.status(404).json({ error: 'Not found' })
  const payments = db.prepare(`
    SELECT * FROM lt_debt_payments WHERE debt_id = ? AND deleted_at IS NULL ORDER BY payment_date
  `).all(debt.id)
  for (const p of payments) p.qb_je_url = p.qb_je_id ? qbEntityUrl('journal', p.qb_je_id) : null
  Object.assign(debt, debtSummary(debt))
  res.json({ debt, payments })
})

function validatePaymentRow(b) {
  if (!isDate(b.payment_date)) return 'payment_date invalide (YYYY-MM-DD)'
  const p = Number(b.principal), i = Number(b.interest)
  if (!Number.isFinite(p) || p < 0) return 'principal doit être un nombre ≥ 0'
  if (!Number.isFinite(i) || i < 0) return 'interest doit être un nombre ≥ 0'
  if (p === 0 && i === 0) return 'versement vide (capital et intérêts à 0)'
  return null
}

router.post('/:id/payments', (req, res) => {
  const debt = db.prepare('SELECT id FROM lt_debts WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!debt) return res.status(404).json({ error: 'Not found' })
  const error = validatePaymentRow(req.body)
  if (error) return res.status(400).json({ error })
  const b = req.body
  const id = randomUUID()
  try {
    db.prepare(`
      INSERT INTO lt_debt_payments (id, debt_id, payment_date, principal, interest, balance_after, source, notes)
      VALUES (?,?,?,?,?,?,'manuel',?)
    `).run(id, req.params.id, b.payment_date, Number(b.principal), Number(b.interest),
      Number.isFinite(Number(b.balance_after)) && b.balance_after !== '' && b.balance_after != null ? Number(b.balance_after) : null,
      b.notes || null)
  } catch {
    return res.status(409).json({ error: 'Un versement existe déjà à cette date — le modifier plutôt' })
  }
  renumber(req.params.id)
  res.status(201).json(db.prepare('SELECT * FROM lt_debt_payments WHERE id = ?').get(id))
})

// Import en lot d'une cédule : rows = [{ payment_date, principal, interest, balance_after? }].
// replace = true remplace les versements NON comptabilisés existants (les lignes
// publiées/marquées sont préservées ; une ligne importée à la même date est ignorée).
router.post('/:id/payments/import', (req, res) => {
  const debt = db.prepare('SELECT id FROM lt_debts WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!debt) return res.status(404).json({ error: 'Not found' })
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : null
  if (!rows?.length) return res.status(400).json({ error: 'rows[] requis' })
  for (const [i, r] of rows.entries()) {
    const error = validatePaymentRow(r)
    if (error) return res.status(400).json({ error: `ligne ${i + 1} : ${error}` })
  }
  let inserted = 0, skipped = 0
  const tx = db.transaction(() => {
    if (req.body.replace === true) {
      db.prepare(`
        UPDATE lt_debt_payments SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE debt_id = ? AND deleted_at IS NULL AND pushed_at IS NULL AND qb_je_id IS NULL
      `).run(req.params.id)
    }
    const insert = db.prepare(`
      INSERT INTO lt_debt_payments (id, debt_id, payment_date, principal, interest, balance_after, source, notes)
      VALUES (?,?,?,?,?,?,'import',?)
    `)
    for (const r of rows) {
      const dup = db.prepare('SELECT id FROM lt_debt_payments WHERE debt_id = ? AND payment_date = ? AND deleted_at IS NULL')
        .get(req.params.id, r.payment_date)
      if (dup) { skipped++; continue }
      insert.run(randomUUID(), req.params.id, r.payment_date, Number(r.principal), Number(r.interest),
        Number.isFinite(Number(r.balance_after)) && r.balance_after !== '' && r.balance_after != null ? Number(r.balance_after) : null,
        r.notes || null)
      inserted++
    }
  })
  tx()
  renumber(req.params.id)
  res.json({ inserted, skipped })
})

function renumber(debtId) {
  const rows = db.prepare('SELECT id FROM lt_debt_payments WHERE debt_id = ? AND deleted_at IS NULL ORDER BY payment_date').all(debtId)
  const upd = db.prepare('UPDATE lt_debt_payments SET seq = ? WHERE id = ?')
  const tx = db.transaction(() => rows.forEach((r, i) => upd.run(i + 1, r.id)))
  tx()
}

router.put('/payments/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM lt_debt_payments WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  if (existing.qb_je_id) return res.status(400).json({ error: 'Versement déjà publié dans QB — non modifiable' })
  const merged = { ...existing, ...req.body }
  const error = validatePaymentRow(merged)
  if (error) return res.status(400).json({ error })
  const { setClause, values, error: buildError } = buildPartialUpdate(req.body, {
    allowed: ['payment_date', 'principal', 'interest', 'balance_after', 'notes'],
    nonNullable: new Set(['payment_date', 'principal', 'interest']),
  })
  if (buildError) return res.status(400).json({ error: buildError })
  if (setClause) {
    try {
      db.prepare(`UPDATE lt_debt_payments SET ${setClause}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
        .run(...values, req.params.id)
    } catch {
      return res.status(409).json({ error: 'Un versement existe déjà à cette date' })
    }
    if ('payment_date' in req.body) renumber(existing.debt_id)
  }
  res.json(db.prepare('SELECT * FROM lt_debt_payments WHERE id = ?').get(req.params.id))
})

router.delete('/payments/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM lt_debt_payments WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  if (existing.qb_je_id) return res.status(400).json({ error: 'Versement déjà publié dans QB — non supprimable' })
  db.prepare(`UPDATE lt_debt_payments SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)
    .run(req.params.id)
  renumber(existing.debt_id)
  res.json({ ok: true })
})

// Versement historique déjà comptabilisé à la main dans QB : on le marque sans JE.
router.post('/payments/:id/mark-booked', (req, res) => {
  const existing = db.prepare('SELECT * FROM lt_debt_payments WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  if (existing.pushed_at) return res.status(400).json({ error: 'Déjà comptabilisé' })
  db.prepare(`UPDATE lt_debt_payments SET pushed_at = ?, updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), new Date().toISOString(), req.params.id)
  res.json(db.prepare('SELECT * FROM lt_debt_payments WHERE id = ?').get(req.params.id))
})

router.post('/payments/:id/unmark-booked', (req, res) => {
  const existing = db.prepare('SELECT * FROM lt_debt_payments WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  if (existing.qb_je_id) return res.status(400).json({ error: 'Versement publié via une JE ERP — non démarquable' })
  db.prepare(`UPDATE lt_debt_payments SET pushed_at = NULL, updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), req.params.id)
  res.json(db.prepare('SELECT * FROM lt_debt_payments WHERE id = ?').get(req.params.id))
})

// Comptabilisation d'un versement — action transactionnelle approuvée par
// l'utilisateur (bouton), jamais automatique. Claim AVANT le POST, rollback si
// le POST échoue (même pattern que publishFpaMonth).
router.post('/payments/:id/publish', async (req, res) => {
  const payment = db.prepare('SELECT * FROM lt_debt_payments WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!payment) return res.status(404).json({ error: 'Not found' })
  if (payment.pushed_at) return res.status(400).json({ error: 'Versement déjà comptabilisé' })
  const debt = db.prepare('SELECT * FROM lt_debts WHERE id = ? AND deleted_at IS NULL').get(payment.debt_id)
  if (!debt) return res.status(404).json({ error: 'Dette introuvable' })
  const missing = []
  if (!debt.qb_debt_acctnum) missing.push('compte de dette')
  if (payment.interest > 0 && !debt.qb_interest_acctnum) missing.push("compte d'intérêts")
  if (!debt.qb_bank_acctnum) missing.push('compte de banque')
  if (missing.length) return res.status(400).json({ error: `Configurer d'abord : ${missing.join(', ')}` })

  // Claim — un double-clic concurrent échoue sur pushed_at déjà posé.
  const now = new Date().toISOString()
  const claimed = db.prepare(`UPDATE lt_debt_payments SET pushed_at = ?, updated_at = ? WHERE id = ? AND pushed_at IS NULL`)
    .run(now, now, payment.id)
  if (!claimed.changes) return res.status(409).json({ error: 'Versement déjà en cours de publication' })

  try {
    const total = round2(payment.principal + payment.interest)
    const lines = []
    const addLine = async (acctnum, type, amount, desc) => {
      const acctId = await resolveAccountByAcctNum(acctnum)
      if (!acctId) throw new Error(`Compte QB #${acctnum} introuvable`)
      lines.push({
        DetailType: 'JournalEntryLineDetail',
        Amount: round2(amount),
        Description: desc,
        JournalEntryLineDetail: { PostingType: type, AccountRef: { value: acctId } },
      })
    }
    const ref = [debt.label, debt.loan_number].filter(Boolean).join(' ')
    if (payment.principal > 0) await addLine(debt.qb_debt_acctnum, 'Debit', payment.principal, `Remboursement capital — ${ref}`)
    if (payment.interest > 0) await addLine(debt.qb_interest_acctnum, 'Debit', payment.interest, `Intérêts — ${ref}`)
    await addLine(debt.qb_bank_acctnum, 'Credit', total, `Versement ${payment.payment_date} — ${ref}`)

    const je = {
      TxnDate: payment.payment_date,
      PrivateNote: `Versement dette LT ${ref} — ${payment.payment_date} (ERP, dettes long terme)`,
      Line: lines,
    }
    const result = await qbPost('/journalentry', je)
    const jeId = result.JournalEntry?.Id
    if (!jeId) throw new Error("QB n'a pas retourné d'Id pour le JournalEntry")
    db.prepare(`UPDATE lt_debt_payments SET qb_je_id = ?, updated_at = ? WHERE id = ?`)
      .run(String(jeId), new Date().toISOString(), payment.id)

    // Pièce justificative : la cédule complète (versement courant surligné)
    // jointe à la JE. L'écriture est déjà créée — un échec ici ne l'annule pas,
    // on remonte un avertissement à l'utilisateur.
    let attachmentWarning = null
    try {
      const schedule = db.prepare(`
        SELECT * FROM lt_debt_payments WHERE debt_id = ? AND deleted_at IS NULL ORDER BY payment_date
      `).all(debt.id)
      const pdf = await buildDebtSchedulePdf({ debt, payments: schedule, highlightPaymentId: payment.id })
      const slug = debt.label.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')
      await qbUploadAttachment({
        entityType: 'JournalEntry', entityId: jeId,
        fileBuffer: pdf, fileName: `cedule-${slug}-${payment.payment_date}.pdf`,
        contentType: 'application/pdf',
      })
    } catch (e) {
      attachmentWarning = `Écriture créée, mais la cédule n'a pas pu être jointe : ${e.message}`
    }

    logSync('lt_debts', 'manual', { status: 'success', modified: 1 })
    res.json({
      qb_je_id: String(jeId),
      warning: attachmentWarning,
      payment: db.prepare('SELECT * FROM lt_debt_payments WHERE id = ?').get(payment.id),
    })
  } catch (e) {
    db.prepare(`UPDATE lt_debt_payments SET pushed_at = NULL WHERE id = ? AND qb_je_id IS NULL`).run(payment.id)
    logSync('lt_debts', 'manual', { status: 'error', error: e.message })
    res.status(502).json({ error: e.message })
  }
})

export default router
