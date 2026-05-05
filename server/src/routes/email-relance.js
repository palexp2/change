import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import {
  buildRelanceList, regenerateEmail,
  getAllOverrides, setOverride, GLOBAL_SCOPE,
} from '../services/relanceEmail.js'

const router = Router()
router.use(requireAuth)

router.get('/qualification-calls', (req, res) => {
  res.json({ data: buildRelanceList() })
})

router.get('/settings', (req, res) => {
  res.json(getAllOverrides())
})

// PUT /settings/global  ou  PUT /settings/qc/:qcId
router.put('/settings/global', (req, res) => {
  const value = setOverride(GLOBAL_SCOPE, req.body?.instructions)
  res.json({ scope: GLOBAL_SCOPE, instructions: value })
})

router.put('/settings/qc/:qcId', (req, res) => {
  const { qcId } = req.params
  if (!qcId) return res.status(400).json({ error: 'qcId requis' })
  const value = setOverride(qcId, req.body?.instructions)
  res.json({ scope: qcId, instructions: value })
})

router.post('/regenerate', async (req, res) => {
  const { qualification_call_id, temperature, general_rules, specific_instructions } = req.body || {}
  if (!qualification_call_id) return res.status(400).json({ error: 'qualification_call_id requis' })
  try {
    const out = await regenerateEmail({
      qcId: qualification_call_id,
      temperature,
      generalRules: general_rules,
      specificInstructions: specific_instructions,
    })
    res.json(out)
  } catch (e) {
    res.status(500).json({ error: e.message || 'Erreur de génération' })
  }
})

export default router
