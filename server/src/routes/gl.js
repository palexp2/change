// Grand livre miroir de QuickBooks (lecture seule) — import mois par mois.
import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { importGlRange, glImportRunning, glSummary, monthsBetween } from '../services/glMirror.js'

const router = Router()
router.use(requireAuth, requireAdmin)

const PERIOD = /^\d{4}-\d{2}(-\d{2})?$/

// Lance l'import en arrière-plan ; le suivi se lit dans /import-runs.
router.post('/import', (req, res) => {
  const { from, to = new Date().toISOString().slice(0, 10) } = req.body || {}
  if (!PERIOD.test(String(from || '')) || !PERIOD.test(String(to))) {
    return res.status(400).json({ error: 'Période invalide (from, to : AAAA-MM)' })
  }
  if (glImportRunning()) return res.status(409).json({ error: 'Import déjà en cours', running: glImportRunning() })
  const months = monthsBetween(from, to)
  if (!months.length) return res.status(400).json({ error: 'Période vide' })
  importGlRange(from, to).catch(err => console.error('[gl] import', err.message))
  res.status(202).json({ started: true, months: months.length })
})

router.get('/import-runs', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000)
  const runs = db.prepare(`SELECT * FROM gl_import_runs ORDER BY id DESC LIMIT ?`).all(limit)
  res.json({ running: glImportRunning(), summary: glSummary(), runs })
})

export default router
