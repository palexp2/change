import { Router } from 'express'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import { peekClaudeUsage } from '../services/claudeUsage.js'
import { summarizeAiUsage } from '../services/aiUsageSummary.js'
import { aiCostReport } from '../services/aiCostMeter.js'
import { updateEnvKey } from './connectors.js'

// GET /api/ai-usage — jauges IA de la barre de gauche, pour tous les utilisateurs.
// Lecture des caches seulement : aucun nouvel appel au fournisseur.
const router = Router()
router.get('/', requireAuth, (req, res) => {
  res.json(summarizeAiUsage({ claude: peekClaudeUsage() }))
})

// Coûts des API d'IA payées à l'usage, par jour (Paramètres → Coûts IA).
router.get('/costs', requireAdmin, async (req, res) => {
  const days = Math.min(Math.max(parseInt(req.query.days, 10) || 365, 1), 365)
  try { res.json(await aiCostReport({ days })) } catch (e) { res.status(500).json({ error: e.message }) }
})

// Clé admin OpenAI : ouvre la lecture des coûts réellement facturés.
router.put('/openai-admin-key', requireAdmin, (req, res) => {
  const key = String(req.body?.api_key || '').trim()
  if (!key.startsWith('sk-')) return res.status(400).json({ error: 'Clé OpenAI invalide' })
  updateEnvKey('OPENAI_ADMIN_KEY', key)
  res.json({ ok: true })
})

export default router
