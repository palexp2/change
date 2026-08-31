// Import MAPAQ — exploitations agricoles en serre (page « Tests – Antoine »).
//
// Sens unique externe → ERP, déclenchement manuel : aucune tâche planifiée ne
// frappe ces routes. `preview` ne fait que lire, `prospects` est le seul point
// d'écriture et n'insère que des nouveaux records (jamais d'UPDATE : une
// entreprise déjà enrichie à la main n'est pas touchée).
import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { buildPreviewReport, createProspects } from '../services/mapaqImport.js'
import { logSync } from '../services/syncLog.js'
import { parseLimit } from '../utils/pagination.js'

const router = Router()
router.use(requireAuth)

// Le CSV est collé/téléversé par l'utilisateur : il peut peser quelques Mo.
const MAX_CSV_CHARS = 20 * 1024 * 1024

// POST /api/mapaq/preview — rapport d'aperçu. POST (et non GET) parce que le
// corps peut porter le CSV fourni à la main.
// Body : { region?, dataset?, csv?, limit? }
router.post('/preview', async (req, res) => {
  const { region, dataset, csv, limit } = req.body || {}
  if (csv != null && typeof csv !== 'string') return res.status(400).json({ error: 'csv doit être une chaîne' })
  if (typeof csv === 'string' && csv.length > MAX_CSV_CHARS) {
    return res.status(400).json({ error: 'Fichier trop volumineux (max 20 Mo)' })
  }
  if (region != null && typeof region !== 'string') return res.status(400).json({ error: 'region doit être une chaîne' })
  if (dataset != null && typeof dataset !== 'string') return res.status(400).json({ error: 'dataset doit être une chaîne' })

  const started = Date.now()
  try {
    const report = await buildPreviewReport({
      csv: csv || null,
      region: region ? region.trim() : null,
      dataset: dataset ? dataset.trim() : null,
      limit: limit ? parseLimit(limit, { def: 0, max: 5000 }) : null,
    })
    logSync('mapaq', 'manual', {
      status: report.source.available ? 'success' : 'error',
      modified: 0,
      error: report.source.available ? null : report.source.reason,
      durationMs: Date.now() - started,
    })
    res.json(report)
  } catch (e) {
    logSync('mapaq', 'manual', { status: 'error', modified: 0, error: e.message, durationMs: Date.now() - started })
    res.status(502).json({ error: `Import MAPAQ impossible : ${e.message}` })
  }
})

// POST /api/mapaq/prospects — crée les entreprises + projets de prospection
// pour les entrées explicitement cochées. Body : { entries: [...] }
router.post('/prospects', (req, res) => {
  const entries = req.body?.entries
  if (!Array.isArray(entries) || entries.length === 0) {
    return res.status(400).json({ error: 'entries doit être un tableau non vide' })
  }
  if (entries.length > 500) return res.status(400).json({ error: 'Maximum 500 entrées par lot' })
  if (entries.some(e => !e || typeof e !== 'object' || !String(e.name || '').trim())) {
    return res.status(400).json({ error: 'Chaque entrée doit porter un nom' })
  }

  const started = Date.now()
  try {
    const result = createProspects(entries, req.user?.id)
    logSync('mapaq', 'manual', { status: 'success', modified: result.created.length, durationMs: Date.now() - started })
    res.status(201).json(result)
  } catch (e) {
    logSync('mapaq', 'manual', { status: 'error', modified: 0, error: e.message, durationMs: Date.now() - started })
    res.status(500).json({ error: `Création impossible : ${e.message}` })
  }
})

export default router
