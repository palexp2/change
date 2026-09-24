import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { peekClaudeUsage } from '../services/claudeUsage.js'
import { peekCodexUsage } from '../services/codexUsage.js'
import { summarizeAiUsage } from '../services/aiUsageSummary.js'

// GET /api/ai-usage — jauges IA de la barre de gauche, pour tous les utilisateurs.
// Lecture des caches seulement : aucun nouvel appel au fournisseur.
const router = Router()
router.get('/', requireAuth, (req, res) => {
  res.json(summarizeAiUsage({ claude: peekClaudeUsage(), codex: peekCodexUsage() }))
})
export default router
