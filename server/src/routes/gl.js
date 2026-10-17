// Grand livre miroir de QuickBooks (lecture seule) — import mois par mois.
import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { importGlRange, glImportRunning, glSummary, monthsBetween, glAccountsWithBalances, glDirtyMonths } from '../services/glMirror.js'
import { glStatements, glAccountLines } from '../services/glStatements.js'
import { reconciliationMonths, reconciliationAccounts, accountMonthLines, runGlReconciliation, glReconciliationRunning, loadFiscalStartMonth, fiscalStartOf } from '../services/glReconcile.js'

const router = Router()

// Plan comptable local (/plan-comptable, ouvert à tous les connectés comme
// avant) : gl_accounts + solde CAD calculé depuis gl_lines, sans appel à QBO.
router.get('/accounts', requireAuth, (req, res) => {
  const all = req.query.all === '1' || req.query.all === 'true'
  res.json(glAccountsWithBalances({ all }))
})

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
  res.json({ running: glImportRunning(), summary: glSummary(), dirty: glDirtyMonths(), runs })
})

// Balance de vérification Boréal ↔ QBO, fin de mois par fin de mois (tranche 3).
const YM = /^\d{4}-\d{2}$/

router.get('/reconciliation', (req, res) => {
  res.json({ running: glReconciliationRunning(), months: reconciliationMonths() })
})

router.post('/reconciliation/run', (req, res) => {
  if (glReconciliationRunning()) return res.status(409).json({ error: 'Comparaison déjà en cours' })
  runGlReconciliation({ trigger: 'manuel', force: true }).catch(err => console.error('[gl] comparaison', err.message))
  res.status(202).json({ started: true })
})

router.get('/reconciliation/:month', (req, res) => {
  if (!YM.test(req.params.month)) return res.status(400).json({ error: 'Mois invalide (AAAA-MM)' })
  res.json(reconciliationAccounts(req.params.month))
})

router.get('/reconciliation/:month/accounts/:id/lines', (req, res) => {
  if (!YM.test(req.params.month)) return res.status(400).json({ error: 'Mois invalide (AAAA-MM)' })
  res.json(accountMonthLines(req.params.month, String(req.params.id)))
})

// Bilan et état des résultats Boréal ↔ QBO (tranche 4). Sans période : exercice en cours.
const DAY = /^\d{4}-\d{2}-\d{2}$/

router.get('/statements', async (req, res) => {
  const today = new Date().toISOString().slice(0, 10)
  let { from, to } = req.query
  if (from && !DAY.test(String(from))) return res.status(400).json({ error: 'Date invalide (from : AAAA-MM-JJ)' })
  if (to && !DAY.test(String(to))) return res.status(400).json({ error: 'Date invalide (to : AAAA-MM-JJ)' })
  try {
    if (!from) from = fiscalStartOf(today, await loadFiscalStartMonth())
    to = to || today
    if (from > to) return res.status(400).json({ error: 'Période vide' })
    res.json(await glStatements(from, to))
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

router.get('/accounts/:id/lines', (req, res) => {
  const { from, to } = req.query
  if (!DAY.test(String(from || '')) || !DAY.test(String(to || ''))) return res.status(400).json({ error: 'Période invalide (from, to : AAAA-MM-JJ)' })
  res.json(glAccountLines(String(req.params.id), from, to))
})

export default router
