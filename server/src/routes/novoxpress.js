import { Router } from 'express'
import path from 'path'
import { fileURLToPath } from 'url'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import {
  isNovoxpressConfigured,
  clearTokenCache,
  getRates,
  createLabel,
  schedulePickup,
  cancelPickup
} from '../services/novoxpress.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const router = Router()
router.use(requireAuth)

// Load shipment with full address + company info
function getShipmentWithAddress(shipmentId) {
  return db.prepare(`
    SELECT
      s.id, s.order_id, s.tracking_number, s.carrier,
      s.address_id,
      a.line1 as address_line1, a.city as address_city,
      a.province as address_province, a.postal_code as address_postal_code,
      a.country as address_country,
      co.name as company_name, co.phone as company_phone, co.email as company_email
    FROM shipments s
    LEFT JOIN orders o ON s.order_id = o.id
    LEFT JOIN companies co ON o.company_id = co.id
    LEFT JOIN adresses a ON s.address_id = a.id
    WHERE s.id = ?
  `).get(shipmentId)
}

// GET /api/novoxpress/status
router.get('/status', (req, res) => {
  res.json({ configured: isNovoxpressConfigured() })
})

// PUT /api/novoxpress/config — save credentials
router.put('/config', (req, res) => {
  const { username, password } = req.body
  if (!username || !password) return res.status(400).json({ error: 'username et password requis' })
  const upsert = db.prepare(`
    INSERT INTO connector_config (connector, key, value)
    VALUES ('novoxpress', ?, ?)
    ON CONFLICT (connector, key) DO UPDATE SET value = excluded.value
  `)
  upsert.run('username', username)
  upsert.run('password', password)
  clearTokenCache()
  res.json({ ok: true })
})

// DELETE /api/novoxpress/config — remove credentials
router.delete('/config', (req, res) => {
  db.prepare("DELETE FROM connector_config WHERE connector='novoxpress'").run()
  clearTokenCache()
  res.json({ ok: true })
})

// POST /api/novoxpress/rates/:shipmentId — get rate estimates
router.post('/rates/:shipmentId', async (req, res) => {
  if (!isNovoxpressConfigured()) return res.status(400).json({ error: 'Novoxpress non configuré' })

  const shipment = getShipmentWithAddress(req.params.shipmentId)
  if (!shipment) return res.status(404).json({ error: 'Envoi introuvable' })
  if (!shipment.address_id) return res.status(400).json({ error: "L'envoi n'a pas d'adresse de livraison" })

  const { packaging_type, packages, declared_value } = req.body
  if (!packages?.length) return res.status(400).json({ error: 'packages requis' })

  try {
    const result = await getRates(shipment, { packaging_type, packages, declared_value })
    res.json(result)
  } catch (e) {
    console.error('Novoxpress getRates error:', e.message)
    res.status(502).json({ error: e.message })
  }
})

// POST /api/novoxpress/label/:shipmentId — create label + save PDF
router.post('/label/:shipmentId', async (req, res) => {
  if (!isNovoxpressConfigured()) return res.status(400).json({ error: 'Novoxpress non configuré' })

  const shipment = getShipmentWithAddress(req.params.shipmentId)
  if (!shipment) return res.status(404).json({ error: 'Envoi introuvable' })

  const { request_id, service_id, packaging_type, packages, declared_value } = req.body
  if (!service_id) return res.status(400).json({ error: 'service_id requis' })
  if (!packages?.length) return res.status(400).json({ error: 'packages requis' })

  try {
    const result = await createLabel(shipment, req.params.shipmentId, {
      request_id, service_id, packaging_type, packages, declared_value
    })

    // Update shipment record with tracking number + label path
    db.prepare(`
      UPDATE shipments
      SET novoxpress_shipment_id = ?,
          label_pdf_path = ?,
          tracking_number = COALESCE(?, tracking_number),
          carrier = COALESCE(?, carrier),
          status = 'Envoyé',
          shipped_at = COALESCE(shipped_at, date('now'))
      WHERE id = ?
    `).run(
      result.shipment_id,
      result.filename,
      result.tracking_id || null,
      null, // carrier set manually or from service name
      req.params.shipmentId
    )

    res.json({
      shipment_id: result.shipment_id,
      tracking_id: result.tracking_id,
      label_url: `/erp/api/novoxpress/labels/${result.filename}`
    })
  } catch (e) {
    console.error('Novoxpress createLabel error:', e.message)
    res.status(502).json({ error: e.message })
  }
})

// POST /api/novoxpress/pickup/:shipmentId — schedule a pickup
router.post('/pickup/:shipmentId', async (req, res) => {
  if (!isNovoxpressConfigured()) return res.status(400).json({ error: 'Novoxpress non configuré' })

  const shipment = db.prepare('SELECT novoxpress_shipment_id FROM shipments WHERE id = ?').get(req.params.shipmentId)
  if (!shipment) return res.status(404).json({ error: 'Envoi introuvable' })
  if (!shipment.novoxpress_shipment_id) return res.status(400).json({ error: 'Aucun shipment Novoxpress associé' })

  const { date, ready_at, ready_until, quantity, weight, pickup_location, pickup_instructions } = req.body
  if (!date?.year || !date?.month || !date?.day) return res.status(400).json({ error: 'Date de ramassage requise' })

  try {
    const result = await schedulePickup(shipment.novoxpress_shipment_id, {
      date, ready_at, ready_until, quantity, weight, pickup_location, pickup_instructions
    })
    db.prepare('UPDATE shipments SET novoxpress_pickup_id = ? WHERE id = ?')
      .run(result.pickup_id || null, req.params.shipmentId)
    res.json({ pickup_id: result.pickup_id, message: result.message })
  } catch (e) {
    console.error('Novoxpress pickup error:', e.message)
    res.status(502).json({ error: e.message })
  }
})

// DELETE /api/novoxpress/pickup/:shipmentId — cancel pickup
router.delete('/pickup/:shipmentId', async (req, res) => {
  if (!isNovoxpressConfigured()) return res.status(400).json({ error: 'Novoxpress non configuré' })

  const shipment = db.prepare('SELECT novoxpress_pickup_id FROM shipments WHERE id = ?').get(req.params.shipmentId)
  if (!shipment) return res.status(404).json({ error: 'Envoi introuvable' })
  if (!shipment.novoxpress_pickup_id) return res.status(400).json({ error: 'Aucun ramassage planifié pour cet envoi' })

  try {
    await cancelPickup(shipment.novoxpress_pickup_id)
    db.prepare('UPDATE shipments SET novoxpress_pickup_id = NULL WHERE id = ?').run(req.params.shipmentId)
    res.json({ success: true })
  } catch (e) {
    console.error('Novoxpress cancel-pickup error:', e.message)
    res.status(502).json({ error: e.message })
  }
})

export default router
