// Sondage de satisfaction — API PUBLIQUE de la page /s/:token. Pas de
// requireAuth : le client n'a pas de compte, le jeton EST le secret.
//
// La réponse ne fuit jamais l'identité du destinataire (nom, téléphone, id du
// contact) : quelqu'un qui devinerait un jeton n'apprendrait rien de plus que
// le titre du billet. Voir publicSurveyView().

import { Router } from 'express'
import { getSurveyByToken, publicSurveyView, recordSurveyResponse } from '../services/ticketSurveys.js'

const router = Router()

// GET /api/public/ticket-survey/:token
router.get('/:token', (req, res) => {
  const survey = getSurveyByToken(req.params.token)
  // 404 indifférencié : ne pas distinguer jeton inconnu et sondage supprimé.
  if (!survey) return res.status(404).json({ error: 'Sondage introuvable' })
  res.json(publicSurveyView(survey))
})

// POST /api/public/ticket-survey/:token — première réponse ou modification
router.post('/:token', async (req, res) => {
  const { rating, accepts_call, comment } = req.body || {}
  const result = await recordSurveyResponse(req.params.token, { rating, accepts_call, comment })
  if (!result.ok) return res.status(result.status || 400).json({ error: result.error })
  res.json(publicSurveyView(result.survey))
})

export default router
