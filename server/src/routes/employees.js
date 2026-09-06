import { Router } from 'express'
import { newRecordId } from '../utils/recordId.js'
import db from '../db/database.js'
import { requireHROrAdmin } from '../middleware/auth.js'
import { emitEntity } from '../services/realtimeEmitters.js'
import { readRelation } from '../services/customFieldsView.js'
import { parsePage } from '../utils/pagination.js'

const router = Router()
router.use(requireHROrAdmin)

// ── Airtable sync config (consumed by Employees page)
router.get('/sync-config', (req, res) => {
  const cfg = db.prepare("SELECT module, base_id, table_id, field_map, last_synced_at FROM airtable_module_config WHERE module='employees'").get() || {}
  res.json(cfg)
})

router.get('/', (req, res) => {
  const { q } = req.query
  const { page, limitVal, offset } = parsePage(req.query, 50)
  let where = ''
  const params = []
  if (q) {
    where = 'WHERE (first_name LIKE ? OR last_name LIKE ? OR email_work LIKE ? OR matricule LIKE ?)'
    const like = `%${q}%`
    params.push(like, like, like, like)
  }

  const total = db.prepare(`SELECT COUNT(*) as c FROM employees ${where}`).get(...params).c
  const rows = db.prepare(`
    SELECT * FROM employees ${where}
    ORDER BY last_name ASC, first_name ASC
    LIMIT ? OFFSET ?
  `).all(...params, limitVal, offset)

  res.json({ data: rows, total, page: parseInt(page), limit: limitVal })
})

router.get('/:id', (req, res) => {
  const row = db.prepare(`SELECT * FROM ${readRelation('employees')} WHERE id=?`)
    .get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  res.json(row)
})

const ALLOWED = [
  'first_name', 'last_name', 'phone_personal', 'phone_work', 'email_personal', 'email_work',
  'birth_date', 'hire_date', 'matricule', 'active', 'gender', 'address', 'emergency_contact',
  'end_date', 'office_key', 'insurance_id', 'nethris_username', 'is_salesperson', 'is_consultant',
  'accounting_department', 'hours_per_week', 'last_raise_date', 'group_insurance',
  'address_verified', 'banking_info', 'issues', 'peer_reviews', 'vacation_days_per_year',
]

router.post('/', (req, res) => {
  const { first_name, last_name } = req.body
  if (!first_name || !last_name) return res.status(400).json({ error: 'Prénom et nom requis' })
  const id = newRecordId()
  const cols = ['id', ...ALLOWED.filter(k => k in req.body)]
  const vals = [id, ...ALLOWED.filter(k => k in req.body).map(k => req.body[k] ?? null)]
  const placeholders = cols.map(() => '?').join(',')
  db.prepare(`INSERT INTO employees (${cols.join(',')}) VALUES (${placeholders})`).run(...vals)
  const row = db.prepare('SELECT * FROM employees WHERE id=?').get(id)
  emitEntity('employee', 'created', id, row, req.user?.id)
  res.status(201).json(row)
})

router.patch('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM employees WHERE id=?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })

  const fields = ["updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"]
  const params = []
  for (const key of ALLOWED) {
    if (key in req.body) { fields.push(`${key}=?`); params.push(req.body[key] ?? null) }
  }

  db.prepare(`UPDATE employees SET ${fields.join(',')} WHERE id=?`).run(...params, req.params.id)
  const updated = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.id)
  emitEntity('employee', 'updated', req.params.id, updated, req.user?.id)
  res.json(updated)
})

// Tables qui pointent vers un employé par clé étrangère : tant qu'une ligne
// subsiste, SQLite refuse le DELETE. L'échec remontait en 500 « FOREIGN KEY
// constraint failed » — de l'extérieur, le bouton « Supprimer » paraissait
// simplement inerte. On dit d'abord ce qui serait emporté (409), et on ne
// purge que si l'utilisateur a tranché (?force=1).
const DEPENDENTS = [
  { table: 'paie_items', one: 'ligne de paie', many: 'lignes de paie' },
  { table: 'hour_bank_entries', one: 'entrée de banque d\'heures', many: 'entrées de banque d\'heures' },
  { table: 'vacations', one: 'vacance', many: 'vacances' },
  { table: 'rd_month_hours', one: 'mois de R&D', many: 'mois de R&D' },
]

router.delete('/:id', (req, res) => {
  const id = req.params.id
  const existing = db.prepare('SELECT id, airtable_id FROM employees WHERE id=?').get(id)
  if (!existing) return res.status(404).json({ error: 'Not found' })
  const force = req.query.force === '1' || req.query.force === 'true'

  const blockers = DEPENDENTS
    .map(d => ({ ...d, count: db.prepare(`SELECT COUNT(*) c FROM ${d.table} WHERE employee_id=?`).get(id).c }))
    .filter(d => d.count > 0)
  if (blockers.length && !force) {
    return res.status(409).json({
      error: blockers.map(d => `${d.count} ${d.count > 1 ? d.many : d.one}`).join(', '),
      dependents: blockers.map(({ table, count }) => ({ table, count })),
    })
  }

  db.transaction(() => {
    for (const d of DEPENDENTS) db.prepare(`DELETE FROM ${d.table} WHERE employee_id=?`).run(id)
    // Un compte utilisateur ne disparaît pas avec la fiche : on le détache.
    db.prepare('UPDATE users SET employee_id=NULL WHERE employee_id=?').run(id)
    db.prepare('DELETE FROM employees WHERE id=?').run(id)
  })()

  emitEntity('employee', 'deleted', id, { id }, req.user?.id)
  res.json({ ok: true, from_airtable: !!existing.airtable_id })
})

export default router
