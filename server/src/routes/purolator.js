import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { saveConfig, deleteConfig, publicConfig, isPurolatorConfigured, DEFAULTS } from '../connectors/purolator.js'
import { getShipmentRates, createLabel, trackNumber, refreshPurolatorTracking } from '../services/purolator.js'

// Intégration Purolator — connecteur (Basic Auth key/password + compte),
// tarifs (Estimating Service), achat d'étiquette (Shipping Service, sens
// ERP → Purolator uniquement) et suivi (Tracking Service). Toute erreur
// remonte le message BRUT de l'API Purolator dans `error` — jamais d'échec
// silencieux (CLAUDE.md).
//
// ⚠️ Non vérifié en direct — voir l'avertissement en tête de
// services/purolatorPayload.js : aucun identifiant Purolator disponible au
// moment de l'implémentation.

const router = Router()
router.use(requireAuth)

function purolatorFailure(res, e, fallbackStatus = 502) {
  const isLocalValidation = !e.status && !e.responseBody
  return res.status(isLocalValidation ? 400 : fallbackStatus).json({
    error: e.message,
    sent: e.sentPayload || null,
    responseBody: e.responseBody || null,
    purolatorStatus: e.status || null,
  })
}

const SHIPMENT_CTX_SQL = `
  SELECT s.id, o.company_id, c.name AS company_name, c.phone AS company_phone, c.email AS company_email,
         a.id AS address_id, a.line1 AS address_line1, a.city AS address_city,
         a.province AS address_province, a.postal_code AS address_postal_code, a.country AS address_country,
         ct.first_name AS address_contact_first_name, ct.last_name AS address_contact_last_name,
         ct.email AS address_contact_email, ct.phone AS address_contact_phone, ct.mobile AS address_contact_mobile
  FROM shipments s
  LEFT JOIN orders o ON s.order_id = o.id
  LEFT JOIN companies c ON o.company_id = c.id
  LEFT JOIN adresses a ON s.address_id = a.id
  LEFT JOIN contacts ct ON a.contact_id = ct.id
  WHERE s.id = ? AND s.deleted_at IS NULL
`

// ── Connecteur ───────────────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  const last = db.prepare(`
    SELECT created_at, status, records_modified, error_message, duration_ms
    FROM sync_log WHERE module='purolator' ORDER BY created_at DESC LIMIT 1
  `).get() || null
  res.json({
    configured: isPurolatorConfigured(),
    config: publicConfig(),
    defaults: DEFAULTS,
    last_sync: last,
  })
})

router.put('/config', (req, res) => {
  const body = req.body || {}
  if (body.environment !== undefined && !['dev', 'production', ''].includes(String(body.environment))) {
    return res.status(400).json({ error: "environment doit valoir « dev » ou « production »" })
  }
  if (body.account_number !== undefined && body.account_number !== '' && !/^[A-Za-z0-9]{4,12}$/.test(String(body.account_number).trim())) {
    return res.status(400).json({ error: 'Le numéro de compte Purolator est alphanumérique (4 à 12 caractères)' })
  }
  const patch = { ...body }
  if (patch.account_number) patch.account_number = String(patch.account_number).trim().toUpperCase()
  try {
    saveConfig(patch)
    res.json({ ok: true, config: publicConfig(), configured: isPurolatorConfigured() })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

router.delete('/config', (req, res) => {
  deleteConfig()
  res.json({ ok: true, configured: isPurolatorConfigured() })
})

// ── Tarifs (envoi sortant) ───────────────────────────────────────────────────
router.post('/shipments/:id/rates', async (req, res) => {
  const { packages } = req.body || {}
  if (!Array.isArray(packages) || !packages.length) {
    return res.status(400).json({ error: 'packages requis' })
  }
  if (!isPurolatorConfigured()) return res.status(400).json({ error: 'Purolator non configuré (page Connecteurs)' })

  const ctx = db.prepare(SHIPMENT_CTX_SQL).get(req.params.id)
  if (!ctx) return res.status(404).json({ error: 'Envoi introuvable' })
  if (!ctx.address_id) return res.status(400).json({ error: "Cet envoi n'a pas d'adresse de livraison — impossible de tarifer." })

  try {
    res.json(await getShipmentRates(ctx, req.params.id, { packages }))
  } catch (e) {
    console.error('Purolator rates error:', e.message)
    purolatorFailure(res, e)
  }
})

// ── Étiquette (achat) ────────────────────────────────────────────────────────
router.post('/shipments/:id/label', async (req, res) => {
  const { service_id, service_name, packages } = req.body || {}
  if (!service_id) return res.status(400).json({ error: 'service_id requis' })
  if (!Array.isArray(packages) || !packages.length) return res.status(400).json({ error: 'packages requis' })
  if (!isPurolatorConfigured()) return res.status(400).json({ error: 'Purolator non configuré (page Connecteurs)' })

  const ctx = db.prepare(SHIPMENT_CTX_SQL).get(req.params.id)
  if (!ctx) return res.status(404).json({ error: 'Envoi introuvable' })
  if (!ctx.address_id) return res.status(400).json({ error: "Cet envoi n'a pas d'adresse de livraison." })

  try {
    const result = await createLabel(ctx, req.params.id, { service_id, packages })

    // COALESCE sur label_pdf_path : ne pas écraser un PDF déjà présent si le
    // téléchargement a échoué (result.filename peut être null — l'achat reste
    // valide, cf. createLabel). label_pdf_path stocke le nom de fichier NU
    // (même convention que Novoxpress, cf. routes/novoxpress.js) — les deux
    // montages statiques /api/novoxpress/labels et /api/labels pointent vers
    // le même dossier uploads/labels/.
    db.prepare(`
      UPDATE shipments
      SET purolator_shipment_id = ?,
          label_pdf_path = COALESCE(?, label_pdf_path),
          tracking_number = COALESCE(?, tracking_number),
          carrier = 'Purolator',
          status = 'Envoyé',
          shipped_at = COALESCE(shipped_at, date('now'))
      WHERE id = ?
    `).run(
      result.shipment_id,
      result.filename || null,
      result.tracking_id || null,
      req.params.id
    )

    res.json({
      purchased: true,
      shipment_id: result.shipment_id,
      tracking_id: result.tracking_id,
      service_name: service_name || null,
      label_url: result.filename ? `/erp/api/labels/${result.filename}` : null,
      label_error: result.labelError || null,
    })
  } catch (e) {
    console.error('Purolator createLabel error:', e.message)
    purolatorFailure(res, e)
  }
})

// ── Suivi ────────────────────────────────────────────────────────────────────
router.post('/shipments/:id/track', async (req, res) => {
  if (!isPurolatorConfigured()) return res.status(400).json({ error: 'Purolator non configuré (page Connecteurs)' })

  const row = db.prepare("SELECT id, purolator_shipment_id FROM shipments WHERE id = ? AND deleted_at IS NULL").get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Envoi introuvable' })
  if (!row.purolator_shipment_id) return res.status(400).json({ error: "Cet envoi n'a pas d'étiquette Purolator." })

  try {
    const t = await trackNumber(row.purolator_shipment_id)
    db.prepare(`
      UPDATE shipments
      SET purolator_tracking_status = ?, purolator_tracking_last_activity = ?,
          purolator_tracking_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(t.status || null, t.last_activity || null, req.params.id)
    res.json(t)
  } catch (e) {
    console.error('Purolator track error:', e.message)
    purolatorFailure(res, e)
  }
})

// POST /api/purolator/tracking/refresh-now — rafraîchissement manuel (bouton
// « Simuler »/« Exécuter » de la page Automations, cf. systemAutomations.js).
router.post('/tracking/refresh-now', async (req, res) => {
  try {
    res.json(await refreshPurolatorTracking({ trigger: 'manuel' }))
  } catch (e) {
    console.error('Purolator refresh tracking error:', e.message)
    purolatorFailure(res, e)
  }
})

export default router
