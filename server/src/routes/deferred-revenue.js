// Revenus perçus d'avance — état mensuel, brouillon d'écriture, comptabilisation.
//
// Le registre des constatations est servi par la fabrique CRUD
// (RECORD_REGISTRY.deferred_revenue_recognitions) ; les routes calculées et
// transactionnelles sont montées avant, via `extend`.
import { crudRouter } from '../utils/crudRouter.js'
import { RECORD_REGISTRY } from '../db/recordRegistry.js'
import {
  buildMonth, qbReconciliation, proposeDraft, updateDraft, deleteDraft, publishMonth, isMonth,
} from '../services/deferredRevenue.js'

const guard = (req, res) => {
  if (isMonth(req.params.month)) return false
  res.status(400).json({ error: 'month invalide (YYYY-MM)' })
  return true
}

const run = async (res, fn) => {
  try {
    res.json(await fn())
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
}

export default crudRouter(RECORD_REGISTRY.deferred_revenue_recognitions, {
  extend: router => {
    // État du mois : lignes, totaux, brouillon. Sans appel QuickBooks — la page
    // s'affiche sans attendre le bilan.
    router.get('/month/:month', (req, res) => {
      if (guard(req, res)) return
      run(res, () => buildMonth(req.params.month))
    })

    // Rapprochement avec le solde du compte de report dans QuickBooks : route
    // séparée, le rapport de bilan est lent.
    router.get('/month/:month/qb', (req, res) => {
      if (guard(req, res)) return
      run(res, () => qbReconciliation(req.params.month))
    })

    router.post('/month/:month/draft', (req, res) => {
      if (guard(req, res)) return
      run(res, () => proposeDraft(req.params.month, {
        aggregated: req.body?.aggregated === true,
        userId: req.user.id,
      }))
    })

    router.put('/month/:month/draft', (req, res) => {
      if (guard(req, res)) return
      run(res, () => updateDraft(req.params.month, req.body || {}))
    })

    router.delete('/month/:month/draft', (req, res) => {
      if (guard(req, res)) return
      run(res, () => deleteDraft(req.params.month))
    })

    // Comptabilisation — action humaine explicite, jamais déclenchée ailleurs.
    router.post('/month/:month/publish', (req, res) => {
      if (guard(req, res)) return
      run(res, () => publishMonth(req.params.month, { userId: req.user.id }))
    })
  },
})
