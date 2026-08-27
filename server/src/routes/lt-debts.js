// Dettes à long terme — cédules de remboursement et comptabilisation des
// versements dans QB (Dépense : banque → capital + intérêts).
import { Router } from 'express'
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { buildPartialUpdate } from '../utils/partialUpdate.js'
import { qbEntityUrl, qbGet } from '../connectors/quickbooks.js'
import { resolveAccountByAcctNum } from '../services/quickbooks.js'
import { publishDebtPaymentExpense } from '../services/ltDebtQb.js'
import { generateSchedule } from '../services/ltDebtSchedule.js'
import { logSync } from '../services/syncLog.js'

const router = Router()
router.use(requireAuth)

const isDate = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))
const round2 = n => Math.round(n * 100) / 100

const DEBT_FIELDS = ['label', 'lender', 'loan_number', 'currency', 'principal',
  'qb_debt_acctnum', 'qb_interest_acctnum', 'qb_bank_acctnum', 'active', 'notes',
  'annual_rate', 'payment_frequency', 'payment_amount']

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
  for (const p of payments) p.qb_txn_url = p.qb_txn_id ? qbEntityUrl(p.qb_txn_type === 'purchase' ? 'expense' : 'journal', p.qb_txn_id) : null
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
  const { inserted, skipped } = insertScheduleRows(req.params.id, rows, req.body.replace === true)
  res.json({ inserted, skipped })
})

// Insertion d'une cédule (import collé ou générée). replace = true efface les
// versements NON comptabilisés existants ; une ligne dont la date est déjà prise
// est ignorée plutôt que d'écraser un versement publié.
function insertScheduleRows(debtId, rows, replace) {
  let inserted = 0, skipped = 0
  const tx = db.transaction(() => {
    if (replace) {
      db.prepare(`
        UPDATE lt_debt_payments SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE debt_id = ? AND deleted_at IS NULL AND pushed_at IS NULL AND qb_txn_id IS NULL
      `).run(debtId)
    }
    const insert = db.prepare(`
      INSERT INTO lt_debt_payments (id, debt_id, payment_date, principal, interest, balance_after, source, notes)
      VALUES (?,?,?,?,?,?,'import',?)
    `)
    for (const r of rows) {
      const dup = db.prepare('SELECT id FROM lt_debt_payments WHERE debt_id = ? AND payment_date = ? AND deleted_at IS NULL')
        .get(debtId, r.payment_date)
      if (dup) { skipped++; continue }
      insert.run(randomUUID(), debtId, r.payment_date, Number(r.principal), Number(r.interest),
        Number.isFinite(Number(r.balance_after)) && r.balance_after !== '' && r.balance_after != null ? Number(r.balance_after) : null,
        r.notes || null)
      inserted++
    }
  })
  tx()
  renumber(debtId)
  return { inserted, skipped }
}

// Génération de la cédule d'amortissement à partir des paramètres du prêt
// (solde d'ouverture, taux annuel, cadence, montant du versement OU nombre de
// versements). `preview: true` ne fait que calculer — c'est ce qui alimente
// l'aperçu de la modale avant que l'utilisateur confirme.
router.post('/:id/payments/generate', (req, res) => {
  const debt = db.prepare('SELECT * FROM lt_debts WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!debt) return res.status(404).json({ error: 'Not found' })
  const { rows, error, totals } = generateSchedule(req.body)
  if (error) return res.status(400).json({ error })
  if (req.body.preview === true) return res.json({ preview: true, rows, totals })

  const { inserted, skipped } = insertScheduleRows(req.params.id, rows, req.body.replace === true)
  // Les paramètres restent sur la dette : ils préremplissent la prochaine
  // génération et alimentent la récurrente de trésorerie.
  db.prepare(`
    UPDATE lt_debts SET annual_rate = ?, payment_frequency = ?, payment_amount = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
  `).run(Number(req.body.annual_rate) || 0, req.body.frequency || 'monthly',
    totals.count ? round2(rows[0].principal + rows[0].interest) : null, req.params.id)
  res.json({ inserted, skipped, totals })
})

// Concordance du solde de la cédule avec le solde du compte de dette dans QB.
// QB porte les passifs en négatif : on compare en valeur absolue. Un écart
// signale une cédule décalée (versement oublié, intérêts capitalisés non
// repris…) — c'est un contrôle de lecture, rien n'est écrit.
router.get('/:id/qb-balance', async (req, res) => {
  const debt = db.prepare('SELECT * FROM lt_debts WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!debt) return res.status(404).json({ error: 'Not found' })
  if (!debt.qb_debt_acctnum) return res.status(400).json({ error: 'Aucun compte de dette QB configuré' })
  Object.assign(debt, debtSummary(debt))
  try {
    const acctId = await resolveAccountByAcctNum(debt.qb_debt_acctnum)
    if (!acctId) return res.status(404).json({ error: `Compte QB #${debt.qb_debt_acctnum} introuvable` })
    const acct = (await qbGet(`/account/${acctId}`))?.Account
    const qbBalance = round2(Math.abs(Number(acct?.CurrentBalance) || 0))
    const erpBalance = debt.remaining_balance == null ? null : round2(Math.abs(debt.remaining_balance))
    const delta = erpBalance == null ? null : round2(qbBalance - erpBalance)
    res.json({
      acctnum: debt.qb_debt_acctnum,
      account_name: acct?.Name || null,
      qb_balance: qbBalance,
      erp_balance: erpBalance,
      delta,
      // 1 ¢ de tolérance : les deux côtés sont arrondis au cent.
      matches: delta != null && Math.abs(delta) <= 0.01,
      checked_at: new Date().toISOString(),
    })
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

// Contrôle de lecture : les transactions QB liées aux versements « publiés »
// existent-elles toujours ? Une suppression côté QuickBooks laissait l'ERP
// afficher « Publié » alors que rien n'est comptabilisé. Un seul appel par type
// d'entité (WHERE Id IN (…)), rien n'est écrit.
router.get('/:id/qb-check', async (req, res) => {
  const debt = db.prepare('SELECT id FROM lt_debts WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!debt) return res.status(404).json({ error: 'Not found' })
  const published = db.prepare(`
    SELECT id, qb_txn_id, qb_txn_type FROM lt_debt_payments
    WHERE debt_id = ? AND deleted_at IS NULL AND qb_txn_id IS NOT NULL
  `).all(req.params.id).filter(p => /^\d+$/.test(String(p.qb_txn_id)))
  if (!published.length) return res.json({ missing: [], checked_at: new Date().toISOString() })

  try {
    const missing = []
    for (const [type, entity] of [['purchase', 'Purchase'], ['journal', 'JournalEntry']]) {
      const rows = published.filter(p => (p.qb_txn_type === 'purchase' ? 'purchase' : 'journal') === type)
      if (!rows.length) continue
      const found = new Set()
      const ids = [...new Set(rows.map(p => String(p.qb_txn_id)))]
      // Lots de 50 : la requête QB passe par l'URL, on évite les URI géantes.
      for (let i = 0; i < ids.length; i += 50) {
        const batch = ids.slice(i, i + 50).map(id => `'${id}'`).join(', ')
        const q = encodeURIComponent(`SELECT Id FROM ${entity} WHERE Id IN (${batch}) MAXRESULTS 1000`)
        const found_ = (await qbGet(`/query?query=${q}`))?.QueryResponse?.[entity] || []
        for (const r of found_) found.add(String(r.Id))
      }
      for (const p of rows) if (!found.has(String(p.qb_txn_id))) missing.push(p.id)
    }
    res.json({ missing, checked_at: new Date().toISOString() })
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
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
  if (existing.qb_txn_id) return res.status(400).json({ error: 'Versement déjà publié dans QB — non modifiable' })
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
  if (existing.qb_txn_id) return res.status(400).json({ error: 'Versement déjà publié dans QB — non supprimable' })
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
  if (existing.qb_txn_id) return res.status(400).json({ error: 'Versement publié via l\'ERP — non démarquable' })
  db.prepare(`UPDATE lt_debt_payments SET pushed_at = NULL, updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), req.params.id)
  res.json(db.prepare('SELECT * FROM lt_debt_payments WHERE id = ?').get(req.params.id))
})

// Délier la transaction QB d'un versement (supprimée dans QuickBooks : rien n'est
// comptabilisé, l'ERP ne doit plus afficher « Publié »). On vérifie auprès de QB
// avant de délier — { force: true } pour passer outre. Le versement redevient
// « À comptabiliser » et peut être republié.
router.post('/payments/:id/unpublish', async (req, res) => {
  const existing = db.prepare('SELECT * FROM lt_debt_payments WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  if (!existing.qb_txn_id) return res.status(400).json({ error: 'Aucune transaction QB liée à ce versement' })

  const isPurchase = existing.qb_txn_type === 'purchase'
  if (req.body?.force !== true) {
    try {
      const r = await qbGet(`/${isPurchase ? 'purchase' : 'journalentry'}/${existing.qb_txn_id}`)
      if (r?.Purchase || r?.JournalEntry) {
        return res.status(409).json({
          error: `${isPurchase ? 'Dépense' : 'JE'} QB #${existing.qb_txn_id} existe encore dans QuickBooks. Supprime-la d'abord ou renvoie { force: true } pour délier quand même.`,
        })
      }
    } catch (e) {
      // Code 610 « Objet introuvable » → confirme que la transaction n'existe plus.
      if (!/610|introuvable|n'existe plus|not found/i.test(e.message)) {
        return res.status(502).json({ error: `Vérification QB échouée: ${e.message}` })
      }
    }
  }

  db.prepare(`UPDATE lt_debt_payments SET qb_txn_id = NULL, qb_txn_type = NULL, pushed_at = NULL, updated_at = ? WHERE id = ?`)
    .run(new Date().toISOString(), req.params.id)
  res.json({
    ok: true,
    previous_qb_txn_id: existing.qb_txn_id,
    payment: db.prepare('SELECT * FROM lt_debt_payments WHERE id = ?').get(req.params.id),
  })
})

// Comptabilisation d'un versement en Dépense QB — action transactionnelle
// approuvée par l'utilisateur (bouton), jamais automatique. Claim AVANT le
// POST, rollback si le POST échoue (même pattern que publishFpaMonth).
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
    const { purchaseId, attachmentWarning } = await publishDebtPaymentExpense(debt, payment)
    db.prepare(`UPDATE lt_debt_payments SET qb_txn_id = ?, qb_txn_type = 'purchase', updated_at = ? WHERE id = ?`)
      .run(purchaseId, new Date().toISOString(), payment.id)

    logSync('lt_debts', 'manual', { status: 'success', modified: 1 })
    res.json({
      qb_txn_id: purchaseId,
      warning: attachmentWarning,
      payment: db.prepare('SELECT * FROM lt_debt_payments WHERE id = ?').get(payment.id),
    })
  } catch (e) {
    db.prepare(`UPDATE lt_debt_payments SET pushed_at = NULL WHERE id = ? AND qb_txn_id IS NULL`).run(payment.id)
    logSync('lt_debts', 'manual', { status: 'error', error: e.message })
    res.status(502).json({ error: e.message })
  }
})

export default router
