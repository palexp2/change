import { Router } from 'express'
import db from '../db/database.js'
import { runWebhook } from '../services/webhookEngine.js'

/**
 * Routeur PUBLIC des webhooks entrants — PAS de requireAuth.
 *
 * Le token compact (généré par generateShortToken, ex: hookB4Fehk9jYd4s4B) EST
 * le secret : seul un appelant connaissant le token peut déclencher le webhook.
 * Mappé sur une automation kind='webhook' active via la colonne webhook_token
 * (index unique partiel). GET et POST acceptés ; les params exposés à l'action
 * sont query ∪ body (le body JSON écrase la query sur clé identique).
 *
 * Monté APRÈS express.json() pour que le body soit déjà parsé.
 */

const router = Router()

async function handle(req, res) {
  const token = req.params.token
  const automation = db.prepare(`
    SELECT * FROM automations
    WHERE webhook_token = ? AND kind = 'webhook' AND active = 1 AND deleted_at IS NULL
  `).get(token)

  // 404 indifférencié (token inconnu / inactif / supprimé) : ne pas révéler
  // l'existence d'un webhook désactivé à un appelant non autorisé.
  if (!automation) return res.status(404).json({ error: 'Webhook introuvable' })

  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {}
  const query = req.query || {}
  const params = { ...query, ...body }

  const { status, body: respBody } = await runWebhook(automation, {
    method: req.method,
    query,
    body,
    params,
    headers: req.headers,
  })

  const code = Number(status) || 200
  if (respBody && typeof respBody === 'object') return res.status(code).json(respBody)
  if (respBody == null) return res.status(code).end()
  return res.status(code).send(String(respBody))
}

router.get('/:token', handle)
router.post('/:token', handle)

export default router
