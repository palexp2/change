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
  fetchAndSaveLabelPdf,
  schedulePickup,
  cancelPickup,
  buildPayload
} from '../services/novoxpress.js'
import {
  isDiagnosticAvailable,
  isOpaqueNovoError,
  runDiagnostic
} from '../services/novoxpressDiagnostic.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const router = Router()
router.use(requireAuth)

// Load shipment with full address + company info + contact attaché à l'adresse
// (le contact de l'adresse prime sur l'email/tel de la company — c'est lui le
// destinataire physique du colis).
function getShipmentWithAddress(shipmentId) {
  return db.prepare(`
    SELECT
      s.id, s.order_id, s.tracking_number, s.carrier,
      s.address_id,
      a.line1 as address_line1, a.city as address_city,
      a.province as address_province, a.postal_code as address_postal_code,
      a.country as address_country,
      co.name as company_name, co.phone as company_phone, co.email as company_email,
      ct.first_name as address_contact_first_name,
      ct.last_name as address_contact_last_name,
      ct.email as address_contact_email,
      ct.phone as address_contact_phone,
      ct.mobile as address_contact_mobile
    FROM shipments s
    LEFT JOIN orders o ON s.order_id = o.id
    LEFT JOIN companies co ON o.company_id = co.id
    LEFT JOIN adresses a ON s.address_id = a.id
    LEFT JOIN contacts ct ON a.contact_id = ct.id
    WHERE s.id = ? AND s.deleted_at IS NULL
  `).get(shipmentId)
}

// GET /api/novoxpress/status
router.get('/status', (req, res) => {
  res.json({ configured: isNovoxpressConfigured(), diagnostic_available: isDiagnosticAvailable() })
})

// PUT /api/novoxpress/config — save credentials et/ou token API (diagnostic dev).
// username+password vont ensemble ; api_token peut être sauvegardé seul.
router.put('/config', (req, res) => {
  const { username, password, api_token } = req.body
  if ((username && !password) || (!username && password)) {
    return res.status(400).json({ error: 'username et password vont ensemble' })
  }
  if (!username && !api_token) {
    return res.status(400).json({ error: 'username+password ou api_token requis' })
  }
  const upsert = db.prepare(`
    INSERT INTO connector_config (connector, key, value)
    VALUES ('novoxpress', ?, ?)
    ON CONFLICT (connector, key) DO UPDATE SET value = excluded.value
  `)
  if (username && password) {
    upsert.run('username', username)
    upsert.run('password', password)
    clearTokenCache()
  }
  if (api_token) upsert.run('api_token', api_token)
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
    // Erreur de validation locale (avant l'appel API Novoxpress) → 400.
    // Erreur Novoxpress côté upstream → 502.
    const isLocalValidation = !e.responseBody && !e.status
    // Erreur opaque (500 relayé, panne amont) → diagnostic auto en env dev,
    // synchrone dans la même requête (système temporaire, cf. novoxpressDiagnostic.js).
    let diagnostic = null
    if (!isLocalValidation && e.sentPayload && isDiagnosticAvailable() && isOpaqueNovoError(e)) {
      try {
        diagnostic = await runDiagnostic('rate', {
          details: e.sentPayload,
          shipmentId: req.params.shipmentId,
          prodError: e.message,
        }, 'auto')
      } catch (de) { console.error('Novoxpress diagnostic error:', de.message) }
    }
    res.status(isLocalValidation ? 400 : 502).json({
      error: e.message,
      sent: e.sentPayload || null,
      responseBody: e.responseBody || null,
      novoxpressStatus: e.status || null,
      diagnostic,
    })
  }
})

// POST /api/novoxpress/label/:shipmentId — create label + save PDF
router.post('/label/:shipmentId', async (req, res) => {
  if (!isNovoxpressConfigured()) return res.status(400).json({ error: 'Novoxpress non configuré' })

  const shipment = getShipmentWithAddress(req.params.shipmentId)
  if (!shipment) return res.status(404).json({ error: 'Envoi introuvable' })

  const { request_id, service_id, carrier_name, packaging_type, packages, declared_value } = req.body
  if (!service_id) return res.status(400).json({ error: 'service_id requis' })
  if (!packages?.length) return res.status(400).json({ error: 'packages requis' })

  try {
    const result = await createLabel(shipment, req.params.shipmentId, {
      request_id, service_id, packaging_type, packages, declared_value
    })

    // Update shipment record with tracking number, carrier, label path.
    // Le `carrier_name` vient de la sélection client (ex. "Canada Post",
    // "Nationex") ; on l'écrit en clair pour permettre le lien de suivi
    // automatique dans OrderDetail (`trackingUrl()` matche sur ce label).
    // L'étiquette est achetée même si le PDF n'a pas pu être téléchargé
    // (result.filename peut être null en cas d'échec CDN). On persiste quand
    // même shipment_id/suivi/transporteur et on marque l'envoi « Envoyé » :
    // l'achat a bien eu lieu, le PDF se récupère ensuite via /label/:id/retry-pdf.
    // COALESCE sur label_pdf_path pour ne pas écraser un PDF déjà présent.
    db.prepare(`
      UPDATE shipments
      SET novoxpress_shipment_id = ?,
          label_pdf_path = COALESCE(?, label_pdf_path),
          tracking_number = COALESCE(?, tracking_number),
          carrier = COALESCE(?, carrier),
          status = 'Envoyé',
          shipped_at = COALESCE(shipped_at, date('now'))
      WHERE id = ?
    `).run(
      result.shipment_id,
      result.filename || null,
      result.tracking_id || null,
      carrier_name || null,
      req.params.shipmentId
    )

    // Constat de vente : plus déclenché ici. L'UPDATE ci-dessus (status='Envoyé')
    // est journalisé dans change_log et capté par revenueRecognitionWatcher, qui
    // pose la JE et persiste/retente tout échec. Voir services/revenueRecognitionWatcher.js.

    res.json({
      purchased: true,
      shipment_id: result.shipment_id,
      tracking_id: result.tracking_id,
      // null si le PDF n'a pas pu être téléchargé — l'achat reste valide.
      label_url: result.filename ? `/erp/api/novoxpress/labels/${result.filename}` : null,
      label_error: result.labelError || null
    })
  } catch (e) {
    console.error('Novoxpress createLabel error:', e.message)
    const isLocalValidation = !e.responseBody && !e.status
    // Diagnostic auto en env dev sur erreur opaque. e.sentPayload pour le
    // create-shipment = { request_id, service_id, details } — on bisecte details.
    let diagnostic = null
    const sentDetails = e.sentPayload?.details
    if (!isLocalValidation && sentDetails && isDiagnosticAvailable() && isOpaqueNovoError(e)) {
      try {
        diagnostic = await runDiagnostic('label', {
          details: sentDetails,
          serviceId: e.sentPayload.service_id,
          shipmentId: req.params.shipmentId,
          prodError: e.message,
        }, 'auto')
      } catch (de) { console.error('Novoxpress diagnostic error:', de.message) }
    }
    res.status(isLocalValidation ? 400 : 502).json({
      error: e.message,
      sent: e.sentPayload || null,
      responseBody: e.responseBody || null,
      novoxpressStatus: e.status || null,
      diagnostic,
    })
  }
})

// POST /api/novoxpress/label/:shipmentId/retry-pdf — re-télécharger le PDF d'une
// étiquette DÉJÀ achetée (cas où l'achat a réussi mais le téléchargement du PDF
// a échoué, ex. 403 du CDN). Ne re-facture rien : réutilise novoxpress_shipment_id.
router.post('/label/:shipmentId/retry-pdf', async (req, res) => {
  if (!isNovoxpressConfigured()) return res.status(400).json({ error: 'Novoxpress non configuré' })

  const shipment = db.prepare(
    'SELECT novoxpress_shipment_id FROM shipments WHERE id = ? AND deleted_at IS NULL'
  ).get(req.params.shipmentId)
  if (!shipment) return res.status(404).json({ error: 'Envoi introuvable' })
  if (!shipment.novoxpress_shipment_id) {
    return res.status(400).json({ error: "Aucune étiquette Novoxpress achetée pour cet envoi — rien à re-télécharger." })
  }

  try {
    const pdf = await fetchAndSaveLabelPdf(shipment.novoxpress_shipment_id, req.params.shipmentId)
    db.prepare(`
      UPDATE shipments
      SET label_pdf_path = ?,
          tracking_number = COALESCE(?, tracking_number)
      WHERE id = ?
    `).run(pdf.filename, pdf.trackingNumber || null, req.params.shipmentId)
    res.json({
      label_url: `/erp/api/novoxpress/labels/${pdf.filename}`,
      tracking_id: pdf.trackingNumber || null
    })
  } catch (e) {
    console.error('Novoxpress retry-pdf error:', e.message)
    res.status(502).json({ error: e.message })
  }
})

// Service dev par défaut dérivé du transporteur de l'envoi — pour le diagnostic
// pickup déclenché sans contexte d'achat (le shipment dev support doit être créé
// chez le même transporteur que l'étiquette réelle).
function carrierToDevService(carrier) {
  const c = String(carrier || '').toLowerCase()
  if (/ups/.test(c)) return 'ups-307'
  if (/gls/.test(c)) return 'gls-24'
  if (/purolator/.test(c)) return 'purolator-10'
  return 'canadapost-292'
}

// POST /api/novoxpress/diagnostic/:shipmentId — diagnostic manuel en env dev
// (aucun achat réel : l'env dev de Novoxpress ne facture pas). Utilisé par le
// bouton « Diagnostiquer en dev » des modales étiquette/ramassage, et par les
// tests E2E. Body : { op: 'rate'|'label'|'pickup', packaging_type?, packages?,
// declared_value?, service_id?, pickup?: {date, ready_at, ready_until, quantity,
// weight, pickup_location, pickup_instructions}, prod_error? }
router.post('/diagnostic/:shipmentId', async (req, res) => {
  if (!isDiagnosticAvailable()) {
    return res.status(400).json({ error: "Diagnostic indisponible — token API Novoxpress (api_token) non configuré dans la page Connecteurs." })
  }
  const shipment = getShipmentWithAddress(req.params.shipmentId)
  if (!shipment) return res.status(404).json({ error: 'Envoi introuvable' })
  if (!shipment.address_id) return res.status(400).json({ error: "L'envoi n'a pas d'adresse de livraison" })

  const { op = 'label', packaging_type, packages, declared_value, service_id, pickup, prod_error } = req.body
  if (!['rate', 'label', 'pickup'].includes(op)) return res.status(400).json({ error: 'op invalide (rate|label|pickup)' })

  let details
  try {
    details = buildPayload(
      shipment,
      packaging_type || 'package',
      packages?.length ? packages : [{ quantity: '1', weight: '2', length: '20', width: '16', depth: '8' }],
      declared_value || '1'
    )
  } catch (e) {
    // buildRecipient lève une erreur claire (courriel/téléphone manquants) —
    // c'est déjà un verdict « notre côté », inutile d'appeler le dev.
    return res.status(400).json({ error: `Validation locale (avant tout appel Novoxpress) : ${e.message}` })
  }

  let pickupDetails
  if (op === 'pickup') {
    const p = pickup || {}
    if (!p.date?.year || !p.date?.month || !p.date?.day) {
      return res.status(400).json({ error: 'pickup.date requis pour le diagnostic de ramassage' })
    }
    pickupDetails = {
      date: p.date,
      ready_at: p.ready_at || { hour: 9, minute: 0 },
      ready_until: p.ready_until || { hour: 17, minute: 0 },
      package_details: {
        quantity: String(p.quantity || 1),
        weight: { unit: 'lb', value: String(p.weight || '1') }
      },
      pickup_instructions: p.pickup_instructions || '',
      pickup_location: p.pickup_location || 'OutsideDoor'
    }
  }

  try {
    const result = await runDiagnostic(op, {
      details,
      serviceId: service_id || carrierToDevService(shipment.carrier),
      pickupDetails,
      shipmentId: req.params.shipmentId,
      prodError: prod_error || null,
    }, 'manual')
    res.json(result)
  } catch (e) {
    console.error('Novoxpress diagnostic error:', e.message)
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
