// Contrôles comptables — la liste des constatations et le bouton « Vérifier ».
// Détection : services/audit/.
import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { runAudit, CHECKS, isCheckEnabled } from '../services/audit/index.js'
import { listFindings, findingsSummary, dismissFinding, reopenFinding } from '../services/audit/store.js'

const router = Router()
router.use(requireAuth)

// GET /api/audit/findings?status=open&domain=banque
router.get('/findings', (req, res) => {
  const status = ['open', 'dismissed', 'resolved', 'all'].includes(req.query.status) ? req.query.status : 'open'
  res.json({
    findings: listFindings({
      status,
      domain: req.query.domain || null,
      checkId: req.query.check_id || null,
      limit: Math.min(Number(req.query.limit) || 200, 500),
    }),
    summary: findingsSummary(),
    checks: CHECKS.map((c) => ({ id: c.id, label: c.label, domain: c.domain, enabled: isCheckEnabled(c.id) })),
  })
})

// POST /api/audit/run — le bouton « Vérifier maintenant ».
router.post('/run', async (req, res) => {
  try {
    const checks = Array.isArray(req.body?.checks) && req.body.checks.length ? req.body.checks : null
    res.json(await runAudit({ checks, dryRun: !!req.body?.dry_run, trigger: 'manuel' }))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// POST /api/audit/findings/:id/dismiss — « ce n'en est pas un », définitif.
router.post('/findings/:id/dismiss', (req, res) => {
  try {
    res.json(dismissFinding(req.params.id, req.user?.id, req.body?.reason || null))
  } catch (e) {
    res.status(404).json({ error: e.message })
  }
})

router.post('/findings/:id/reopen', (req, res) => {
  try {
    res.json(reopenFinding(req.params.id))
  } catch (e) {
    res.status(404).json({ error: e.message })
  }
})

export default router
