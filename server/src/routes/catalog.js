import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { OFFER_WHERE } from '../services/stripeCatalog.js'

const router = Router()
router.use(requireAuth)

// Produits proposés en soumission : le Catalogue de vente, case « Proposé en
// soumission » cochée (offer_legacy = 0).
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM products
    WHERE ${OFFER_WHERE} AND COALESCE(offer_legacy, 0) = 0
    ORDER BY sku, name_fr
  `).all()
  res.json(rows)
})

export default router
