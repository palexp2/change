import { requireAuth, isHR } from '../middleware/auth.js'
import { getRow } from '../utils/crudRouter.js'
import db from '../db/database.js'
import { emitEntity } from '../services/realtimeEmitters.js'
import { readRelation } from '../services/customFieldsView.js'
import { crudRouter } from '../utils/crudRouter.js'
import { RECORD_REGISTRY } from '../db/recordRegistry.js'

// Tables qui pointent vers un employé par clé étrangère : tant qu'une ligne
// subsiste, SQLite refuse le DELETE. On dit d'abord ce qui serait emporté (409),
// et on ne purge que si l'utilisateur a tranché (?force=1).
const DEPENDENTS = [
  { table: 'paie_items', one: 'ligne de paie', many: 'lignes de paie' },
  { table: 'vacations', one: 'vacance', many: 'vacances' },
  { table: 'rd_month_hours', one: 'mois de R&D', many: 'mois de R&D' },
]

export default crudRouter({ ...RECORD_REGISTRY.employees, view: readRelation('employees'), auth: requireAuth }, {
  omit: ['delete'],
  extend(router) {
    router.use((req, res, next) => {
      if (isHR(req.user)) return next()
      if (req.method !== 'GET') return res.status(403).json({ error: 'Accès RH requis' })
      const employeeId = req.user.employee_id
      const own = employeeId ? getRow({ ...RECORD_REGISTRY.employees, view: readRelation('employees') }, employeeId) : null
      if (req.path === '/') return res.json({ data: own?.status === 200 ? [own.json] : [], total: own?.status === 200 ? 1 : 0, page: 1, limit: 1 })
      if (!employeeId || req.path !== `/${employeeId}`) return res.status(403).json({ error: 'Accès à votre fiche uniquement' })
      return res.status(own.status).json(own.json)
    })
    router.get('/sync-config', (req, res) => {
      const cfg = db.prepare("SELECT module, base_id, table_id, field_map, last_synced_at FROM airtable_module_config WHERE module='employees'").get() || {}
      res.json(cfg)
    })

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
  },
})
