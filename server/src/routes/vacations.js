import db from '../db/database.js'
import { isHR } from '../middleware/auth.js'
import { crudRouter } from '../utils/crudRouter.js'
import { RECORD_REGISTRY } from '../db/recordRegistry.js'
import { vacationBalance } from '../services/vacationBalance.js'

export default crudRouter(RECORD_REGISTRY.vacations, {
  extend(router) {
    router.use((req, res, next) => {
      if (isHR(req.user)) return next()
      if (req.method !== 'GET') return res.status(403).json({ error: 'Accès RH requis' })
      const employeeId = req.user.employee_id
      if (req.path === '/') {
        const data = employeeId ? db.prepare('SELECT * FROM vacations WHERE employee_id=? ORDER BY start_date DESC').all(employeeId) : []
        return res.json({ data, total: data.length, page: 1, limit: data.length })
      }
      if (req.path === '/balance' && employeeId && req.query.employee_id === employeeId) return next()
      const row = db.prepare('SELECT * FROM vacations WHERE id=? AND employee_id=?').get(req.path.slice(1), employeeId || '')
      if (!row) return res.status(403).json({ error: 'Accès à vos vacances uniquement' })
      return res.json(row)
    })
    // GET /api/vacations/balance?employee_id=X[&since=YYYY-MM-DD] — banque de
    // vacances en $. `since` (vide = aucune référence) remplace la date de
    // référence enregistrée.
    router.get('/balance', (req, res) => {
      const { employee_id, since } = req.query
      if (!employee_id) return res.status(400).json({ error: 'employee_id requis' })
      const bal = vacationBalance(employee_id, since)
      if (!bal) return res.status(404).json({ error: 'Employé introuvable' })
      res.json(bal)
    })
  },
})
