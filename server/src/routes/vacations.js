import { crudRouter } from '../utils/crudRouter.js'
import { RECORD_REGISTRY } from '../db/recordRegistry.js'
import { vacationBalance } from '../services/vacationBalance.js'

export default crudRouter(RECORD_REGISTRY.vacations, {
  extend(router) {
    // GET /api/vacations/balance?employee_id=X&year=YYYY
    router.get('/balance', (req, res) => {
      const { employee_id } = req.query
      if (!employee_id) return res.status(400).json({ error: 'employee_id requis' })
      const year = parseInt(req.query.year, 10) || new Date().getFullYear()
      const bal = vacationBalance(employee_id, year)
      if (!bal) return res.status(404).json({ error: 'Employé introuvable' })
      res.json(bal)
    })
  },
})
