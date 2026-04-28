import { Router } from 'express'
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

// ── Mapping comptable des transitions ──────────────────────────────────────

// GET /api/serials/accounting/transitions
// Distinct (previous_status, new_status) observés dans serial_state_changes
// avec le compte d'occurrences et l'indicateur de mapping existant.
router.get('/accounting/transitions', (req, res) => {
  const { since } = req.query // ISO date optionnel
  const params = []
  let where = ''
  if (since) { where = 'WHERE COALESCE(sc.changed_at, sc.created_at) >= ?'; params.push(since) }
  const rows = db.prepare(`
    SELECT
      sc.previous_status,
      sc.new_status,
      COUNT(*) as count,
      MAX(COALESCE(sc.changed_at, sc.created_at)) as last_seen,
      r.id as rule_id,
      r.skip_accounting as rule_skip,
      r.valuation_source as rule_valuation,
      SUM(CASE
        WHEN sn.id IS NOT NULL
         AND (sn.manufacture_value IS NULL OR sn.manufacture_value = 0)
         AND (r.id IS NULL
           OR (COALESCE(r.skip_accounting, 0) = 0
               AND COALESCE(r.valuation_source, 'manufacture_value') = 'manufacture_value'))
        THEN 1 ELSE 0 END
      ) as missing_value_count
    FROM serial_state_changes sc
    LEFT JOIN serial_numbers sn ON sn.id = sc.serial_id
    LEFT JOIN serial_accounting_rules r
      ON (r.new_status = sc.new_status
          AND (r.previous_status = sc.previous_status
               OR (r.previous_status IS NULL AND sc.previous_status IS NULL)))
    ${where}
    GROUP BY sc.previous_status, sc.new_status, r.id
    ORDER BY count DESC
  `).all(...params)
  res.json({ data: rows })
})

// Liste des changements d'état problématiques: une règle s'applique mais la valeur
// de fabrication du serial est nulle/manquante. Bloquerait l'agrégation hebdomadaire.
router.get('/accounting/missing-valuations', (req, res) => {
  const { since, limit = 200 } = req.query
  const params = []
  let where = `WHERE sn.id IS NOT NULL
               AND (sn.manufacture_value IS NULL OR sn.manufacture_value = 0)
               AND (r.id IS NULL
                 OR (COALESCE(r.skip_accounting, 0) = 0
                     AND COALESCE(r.valuation_source, 'manufacture_value') = 'manufacture_value'))`
  if (since) { where += ' AND COALESCE(sc.changed_at, sc.created_at) >= ?'; params.push(since) }
  const rows = db.prepare(`
    SELECT
      sc.id as change_id,
      sc.previous_status,
      sc.new_status,
      sc.changed_at,
      sc.created_at,
      sn.id as serial_id,
      sn.airtable_id as serial_airtable_id,
      sn.serial,
      sn.manufacture_value,
      pr.name_fr as product_name,
      pr.sku as product_sku,
      co.name as company_name
    FROM serial_state_changes sc
    LEFT JOIN serial_numbers sn ON sn.id = sc.serial_id
    LEFT JOIN products pr ON pr.id = sn.product_id
    LEFT JOIN companies co ON co.id = sn.company_id
    LEFT JOIN serial_accounting_rules r
      ON (r.new_status = sc.new_status
          AND (r.previous_status = sc.previous_status
               OR (r.previous_status IS NULL AND sc.previous_status IS NULL)))
    ${where}
    ORDER BY COALESCE(sc.changed_at, sc.created_at) DESC
    LIMIT ?
  `).all(...params, parseInt(limit))
  const total = db.prepare(`
    SELECT COUNT(*) as c
    FROM serial_state_changes sc
    LEFT JOIN serial_numbers sn ON sn.id = sc.serial_id
    LEFT JOIN serial_accounting_rules r
      ON (r.new_status = sc.new_status
          AND (r.previous_status = sc.previous_status
               OR (r.previous_status IS NULL AND sc.previous_status IS NULL)))
    ${where}
  `).get(...params).c
  res.json({ data: rows, total })
})

router.get('/accounting/rules', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM serial_accounting_rules
    ORDER BY new_status, COALESCE(previous_status, '')
  `).all()
  res.json({ data: rows })
})

router.post('/accounting/rules', (req, res) => {
  const {
    previous_status, new_status, skip_accounting = 0,
    debit_account_id, debit_account_name,
    credit_account_id, credit_account_name,
    valuation_source = 'manufacture_value',
    fixed_amount, memo_template, notes, active = 1,
  } = req.body || {}
  if (!new_status) return res.status(400).json({ error: 'new_status requis' })
  const skip = skip_accounting ? 1 : 0
  if (!skip) {
    if (!debit_account_id || !credit_account_id) {
      return res.status(400).json({ error: 'Comptes débit et crédit requis (sauf pour règle "Aucune écriture")' })
    }
    if (debit_account_id === credit_account_id) {
      return res.status(400).json({ error: 'Comptes débit et crédit doivent être différents' })
    }
    if (valuation_source === 'fixed_amount' && (fixed_amount == null || isNaN(Number(fixed_amount)))) {
      return res.status(400).json({ error: 'Montant fixe requis pour valuation_source=fixed_amount' })
    }
  }
  const id = randomUUID()
  try {
    db.prepare(`
      INSERT INTO serial_accounting_rules
      (id, previous_status, new_status, skip_accounting,
       debit_account_id, debit_account_name,
       credit_account_id, credit_account_name, valuation_source, fixed_amount,
       memo_template, notes, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, previous_status || null, new_status, skip,
      skip ? null : debit_account_id, skip ? null : (debit_account_name || null),
      skip ? null : credit_account_id, skip ? null : (credit_account_name || null),
      valuation_source, fixed_amount ?? null,
      memo_template || null, notes || null, active ? 1 : 0,
    )
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'Une règle existe déjà pour cette transition' })
    }
    throw e
  }
  res.json(db.prepare('SELECT * FROM serial_accounting_rules WHERE id = ?').get(id))
})


router.put('/accounting/rules/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM serial_accounting_rules WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  const fields = [
    'skip_accounting',
    'debit_account_id','debit_account_name','credit_account_id','credit_account_name',
    'valuation_source','fixed_amount','memo_template','notes','active',
  ]
  const sets = []
  const vals = []
  for (const f of fields) {
    if (f in (req.body || {})) {
      sets.push(`${f} = ?`)
      vals.push(
        (f === 'active' || f === 'skip_accounting')
          ? (req.body[f] ? 1 : 0)
          : (req.body[f] ?? null)
      )
    }
  }
  if (!sets.length) return res.json(existing)
  sets.push(`updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
  vals.push(req.params.id)
  db.prepare(`UPDATE serial_accounting_rules SET ${sets.join(', ')} WHERE id = ?`).run(...vals)
  res.json(db.prepare('SELECT * FROM serial_accounting_rules WHERE id = ?').get(req.params.id))
})

router.delete('/accounting/rules/:id', (req, res) => {
  db.prepare('DELETE FROM serial_accounting_rules WHERE id = ?').run(req.params.id)
  res.json({ ok: true })
})

router.get('/', (req, res) => {
  const { company_id, product_id, status, search, page = 1, limit = 50 } = req.query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit)
  let where = 'WHERE 1=1'
  const params = []

  if (company_id) { where += ' AND sn.company_id = ?'; params.push(company_id) }
  if (product_id) { where += ' AND sn.product_id = ?'; params.push(product_id) }
  if (status) { where += ' AND sn.status = ?'; params.push(status) }
  if (search) {
    where += ' AND (sn.serial LIKE ? OR pr.name_fr LIKE ? OR co.name LIKE ?)'
    const q = `%${search}%`
    params.push(q, q, q)
  }

  const total = db.prepare(`
    SELECT COUNT(*) as c FROM serial_numbers sn
    LEFT JOIN products pr ON sn.product_id = pr.id
    LEFT JOIN companies co ON sn.company_id = co.id
    ${where}
  `).get(...params).c

  const serials = db.prepare(`
    SELECT sn.*, pr.name_fr as product_name, pr.sku, co.name as company_name
    FROM serial_numbers sn
    LEFT JOIN products pr ON sn.product_id = pr.id
    LEFT JOIN companies co ON sn.company_id = co.id
    ${where}
    ORDER BY sn.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limitVal, offset)

  res.json({ data: serials, total, page: parseInt(page), limit: parseInt(limit) })
})

router.get('/:id', (req, res) => {
  const serial = db.prepare(`
    SELECT sn.*, pr.name_fr as product_name, pr.sku, co.name as company_name
    FROM serial_numbers sn
    LEFT JOIN products pr ON sn.product_id = pr.id
    LEFT JOIN companies co ON sn.company_id = co.id
    WHERE sn.id = ?
  `).get(req.params.id)
  if (!serial) return res.status(404).json({ error: 'Not found' })
  res.json(serial)
})

router.get('/:id/history', (req, res) => {
  const changes = db.prepare(`
    SELECT id, previous_status, new_status, changed_at, created_at
    FROM serial_state_changes
    WHERE serial_id = ?
    ORDER BY COALESCE(changed_at, created_at) DESC, created_at DESC
  `).all(req.params.id)
  res.json({ data: changes })
})

export default router
