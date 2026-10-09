import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { newRecordId } from '../utils/recordId.js'
import { emitEntity } from '../services/realtimeEmitters.js'
import { getStripeClient } from '../services/stripeInvoices.js'
import {
  getCatalogProduct, syncStripeCatalog, catalogSyncedAt,
  updateCatalogProduct, createCatalogPrice, setCatalogPriceActive,
  listOffers, listUnlinked, getOffer, pushOfferPrices, linkOffer, adoptStripeProduct, setOfferActive, ensureOfferSkus,
} from '../services/stripeCatalog.js'

// Catalogue de vente (/catalogue-vente) : produits de soumission, chacun relié
// à son produit Stripe ; les produits Stripe non reliés à part (filtre).
const router = Router()
router.use(requireAuth)

const wrap = fn => async (req, res) => {
  try { res.json(await fn(req)) }
  catch (e) { res.status(e.status || e.statusCode || 502).json({ error: e.message }) }
}

const emitProduct = (id, verb, req) => emitEntity('product', verb, id, db.prepare('SELECT * FROM products WHERE id=?').get(id), req.user?.id)

// GET /api/stripe-catalog
router.get('/', wrap(() => ({ offers: listOffers(), unlinked: listUnlinked(), synced_at: catalogSyncedAt() })))

// POST /api/stripe-catalog/sync — relit Stripe
router.post('/sync', wrap(async () => ({ ...(await syncStripeCatalog(getStripeClient())), synced_at: catalogSyncedAt() })))

// POST /api/stripe-catalog/offers — { name } : nouveau produit, créé aussi dans Stripe
router.post('/offers', wrap(async req => {
  const name = String(req.body?.name || '').trim()
  if (!name) throw Object.assign(new Error('Nom requis'), { status: 400 })
  const id = newRecordId()
  db.prepare("INSERT INTO products (id, name_fr, type, is_sellable) VALUES (?, ?, 'Service', 1)").run(id, name.slice(0, 200))
  ensureOfferSkus()
  const o = await linkOffer(getStripeClient(), id, { create: true })
  emitProduct(id, 'created', req)
  return o
}))

// PATCH /api/stripe-catalog/offers/:id — { offer_legacy } : ancien forfait (hors soumissions) ou non
router.patch('/offers/:id', wrap(req => {
  if (!getOffer(req.params.id)) throw Object.assign(new Error('Produit introuvable'), { status: 404 })
  if ('offer_legacy' in (req.body || {})) {
    db.prepare("UPDATE products SET offer_legacy=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(req.body.offer_legacy ? 1 : 0, req.params.id)
    emitProduct(req.params.id, 'updated', req)
  }
  return getOffer(req.params.id)
}))

// POST /api/stripe-catalog/offers/:id/active — { active } : archive / réactive (Stripe + fiche)
router.post('/offers/:id/active', wrap(async req => {
  const o = await setOfferActive(getStripeClient(), req.params.id, !!req.body?.active)
  emitProduct(req.params.id, 'updated', req)
  return o
}))

// GET /api/stripe-catalog/offers/:id
router.get('/offers/:id', wrap(req => {
  const o = getOffer(req.params.id)
  if (!o) throw Object.assign(new Error('Produit introuvable'), { status: 404 })
  return o
}))

// POST /api/stripe-catalog/offers/:id/push — crée dans Stripe les prix manquants
router.post('/offers/:id/push', wrap(req => pushOfferPrices(getStripeClient(), req.params.id)))

// POST /api/stripe-catalog/offers/:id/link — { stripe_product_id | null, create }
router.post('/offers/:id/link', wrap(async req => {
  const o = await linkOffer(getStripeClient(), req.params.id, req.body || {})
  emitProduct(req.params.id, 'updated', req)
  return o
}))

// POST /api/stripe-catalog/stripe/:id/adopt — produit Stripe non relié → catalogue
router.post('/stripe/:id/adopt', wrap(req => {
  const id = newRecordId()
  adoptStripeProduct(req.params.id, id)
  ensureOfferSkus()
  const o = getOffer(id)
  emitProduct(id, 'created', req)
  return o
}))

// PATCH /api/stripe-catalog/prices/:priceId — { active }
router.patch('/prices/:priceId', wrap(req => setCatalogPriceActive(getStripeClient(), req.params.priceId, req.body?.active)))

// GET /api/stripe-catalog/:id — produit Stripe
router.get('/:id', wrap(req => {
  const p = getCatalogProduct(req.params.id)
  if (!p) throw Object.assign(new Error('Produit introuvable'), { status: 404 })
  return p
}))

// PATCH /api/stripe-catalog/:id — { name, description, active }
router.patch('/:id', wrap(req => updateCatalogProduct(getStripeClient(), req.params.id, req.body || {})))

// POST /api/stripe-catalog/:id/prices — { amount, currency, interval }
router.post('/:id/prices', wrap(req => createCatalogPrice(getStripeClient(), req.params.id, req.body || {})))

export default router
