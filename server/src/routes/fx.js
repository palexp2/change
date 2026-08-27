// Taux de change — exposition du cache/API Banque du Canada au frontend.
//
// Sert de référence au calculateur de conversion de devise (onglet « USD_CAD »
// du sheet CTB - Suivi, repris dans l'ERP) : le taux du marché à la date de la
// transaction permet de mesurer la commission de conversion appliquée par la
// carte, sans jamais servir à calculer les montants comptabilisés — ceux-ci
// viennent du montant réellement débité.
import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import { getUsdCadRate } from '../services/fx.js'

const router = Router()

router.get('/rate', requireAuth, async (req, res) => {
  const pair = String(req.query.pair || 'USDCAD').toUpperCase()
  if (pair !== 'USDCAD') return res.status(400).json({ error: 'Paire non supportée (USDCAD seulement)' })
  const date = String(req.query.date || new Date().toISOString().slice(0, 10)).slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Date invalide (YYYY-MM-DD attendu)' })
  try {
    const rate = await getUsdCadRate(date)
    if (rate == null) return res.status(503).json({ error: 'Aucun taux Banque du Canada disponible pour cette date' })
    res.json({ pair, date, rate })
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

export default router
