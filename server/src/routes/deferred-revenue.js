// Revenus perçus d'avance — le compte 23900 (dépôts de commandes), prouvé.
//
// Trois routes : l'état du compte, l'écriture de correction proposée pour un
// dossier, et son envoi. L'envoi reste un geste humain — rien ne part seul.
import express from 'express'
import { requireAuth } from '../middleware/auth.js'
import { buildState, prepareCorrection, publishCorrection } from '../services/deferredDeposits.js'

const router = express.Router()
router.use(requireAuth)

const run = async (res, fn) => {
  try {
    res.json(await fn())
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
}

// L'état complet : chaque dossier, son solde, ses anomalies, et le solde
// QuickBooks en face. Lent (deux rapports QB) — la page l'appelle une fois.
router.get('/state', (req, res) => {
  const end = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.end || '')) ? req.query.end : undefined
  run(res, () => buildState({ end }))
})

// L'écriture qui solde un dossier, telle qu'elle partira.
router.get('/correction/:key', (req, res) => {
  run(res, () => prepareCorrection(req.params.key))
})

// Envoi dans QuickBooks — l'écriture affichée, pas une autre.
router.post('/correction', (req, res) => {
  const { key, lines, memo, txn_date } = req.body || {}
  if (!key) return res.status(400).json({ error: 'key requis' })
  run(res, () => publishCorrection({ key, lines, memo, txn_date, userId: req.user.id }))
})

export default router
