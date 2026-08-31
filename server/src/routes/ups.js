import { Router } from 'express'
import path from 'path'
import fs from 'fs'
import { v4 as uuidv4 } from 'uuid'
import * as postmark from 'postmark'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { getConfig, saveConfig, deleteConfig, isUpsConfigured, DEFAULTS } from '../connectors/ups.js'
import { createReturnLabel, getShipmentRates, trackNumber, testConnection } from '../services/ups.js'
import { buildReturnPartyContext } from '../services/returnContext.js'
import { logSystemRun } from '../services/systemAutomations.js'
import { getAutomationFrom } from '../services/postmarkConfig.js'

// Intégration UPS — connecteur (OAuth client_credentials), étiquettes de retour
// (Shipping API, ReturnService 9), tarifs (Rating API /Shop) et suivi
// (Tracking API). Toute erreur UPS remonte le message BRUT de l'API dans
// `error` — jamais d'échec silencieux (CLAUDE.md).

const router = Router()
router.use(requireAuth)

const LABELS_DIR = path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'labels')

// Le secret ne ressort jamais : l'UI n'affiche que « configuré / pas configuré ».
function publicConfig() {
  const cfg = getConfig()
  const { client_secret, client_id, account_number, ...rest } = cfg
  return {
    ...rest,
    client_id_set: !!client_id,
    client_secret_set: !!client_secret,
    account_number_set: !!account_number,
    // 4 derniers chiffres seulement — assez pour vérifier le bon compte sans
    // exposer l'identifiant de facturation en clair dans le navigateur.
    account_number_hint: account_number ? `••••${String(account_number).slice(-4)}` : null,
  }
}

// Réponse d'erreur uniforme : message brut UPS + payload envoyé pour debug.
function upsFailure(res, e, fallbackStatus = 502) {
  const isLocalValidation = !e.status && !e.responseBody
  return res.status(isLocalValidation ? 400 : fallbackStatus).json({
    error: e.message,
    sent: e.sentPayload || null,
    responseBody: e.responseBody || null,
    upsStatus: e.status || null,
  })
}

// ── Connecteur ───────────────────────────────────────────────────────────────
router.get('/status', (req, res) => {
  const last = db.prepare(`
    SELECT created_at, status, records_modified, error_message, duration_ms
    FROM sync_log WHERE module='ups' ORDER BY created_at DESC LIMIT 1
  `).get() || null
  res.json({
    configured: isUpsConfigured(),
    config: publicConfig(),
    defaults: DEFAULTS,
    last_sync: last,
  })
})

router.put('/config', (req, res) => {
  const body = req.body || {}
  if (body.environment !== undefined && !['cie', 'production', ''].includes(String(body.environment))) {
    return res.status(400).json({ error: "environment doit valoir « cie » ou « production »" })
  }
  for (const key of ['shipping_version', 'rating_version', 'tracking_version']) {
    if (body[key] !== undefined && body[key] !== '' && !/^v[0-9]{1,4}$/.test(String(body[key]))) {
      return res.status(400).json({ error: `${key} doit ressembler à « v1 » ou « v2409 »` })
    }
  }
  if (body.account_number !== undefined && body.account_number !== '' && !/^[A-Za-z0-9]{4,12}$/.test(String(body.account_number).trim())) {
    return res.status(400).json({ error: 'Le numéro de compte UPS est alphanumérique (4 à 12 caractères)' })
  }
  const patch = { ...body }
  if (patch.account_number) patch.account_number = String(patch.account_number).trim().toUpperCase()
  try {
    saveConfig(patch)
    res.json({ ok: true, config: publicConfig(), configured: isUpsConfigured() })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

router.delete('/config', (req, res) => {
  deleteConfig()
  res.json({ ok: true, configured: isUpsConfigured() })
})

// « Tester la connexion » — mint d'un jeton OAuth, aucun effet facturable.
router.post('/test', async (req, res) => {
  try {
    res.json(await testConnection())
  } catch (e) {
    upsFailure(res, e, 400)
  }
})

// ── Étiquette de retour ──────────────────────────────────────────────────────
function getReturn(id) {
  return db.prepare(`
    SELECT r.*, co.name AS company_name FROM returns r
    LEFT JOIN companies co ON r.company_id = co.id
    WHERE r.id = ?
  `).get(id)
}

router.post('/returns/:id/return-label', async (req, res) => {
  const { address_id, packages, service_code, description } = req.body || {}
  if (!Array.isArray(packages) || !packages.length) {
    return res.status(400).json({ error: 'packages requis (au moins un colis avec poids et dimensions)' })
  }
  for (const p of packages) {
    if (!(parseFloat(p.weight) > 0)) return res.status(400).json({ error: 'Chaque colis doit avoir un poids supérieur à 0' })
    if (!(parseFloat(p.length) > 0 && parseFloat(p.width) > 0 && parseFloat(p.depth) > 0)) {
      return res.status(400).json({ error: 'Chaque colis doit avoir des dimensions supérieures à 0' })
    }
  }
  if (service_code !== undefined && service_code !== '' && !/^[0-9]{2}$/.test(String(service_code))) {
    return res.status(400).json({ error: 'service_code doit être un code UPS à 2 chiffres (ex. 11)' })
  }
  if (!isUpsConfigured()) {
    return res.status(400).json({ error: 'UPS non configuré — renseignez client_id, client_secret et le numéro de compte dans la page Connecteurs.' })
  }

  const ret = getReturn(req.params.id)
  if (!ret) return res.status(404).json({ error: 'Retour introuvable' })

  const { ctx } = buildReturnPartyContext(req.params.id, address_id || null) || {}
  if (!ctx) return res.status(400).json({ error: "Aucune adresse client trouvée pour ce retour — sélectionnez-en une manuellement." })

  const started = Date.now()
  try {
    const result = await createReturnLabel(ctx, req.params.id, { packages, service_code, description })

    db.prepare(`
      UPDATE returns
      SET return_ups_shipment_id = ?,
          return_label_pdf_path = COALESCE(?, return_label_pdf_path),
          return_label_tracking_number = COALESCE(?, return_label_tracking_number),
          return_label_cost = COALESCE(?, return_label_cost),
          return_label_currency = COALESCE(?, return_label_currency),
          return_carrier = 'UPS',
          return_service_name = ?,
          return_address_id = COALESCE(?, return_address_id),
          return_label_created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(
      result.shipment_id,
      result.filename ? `labels/${result.filename}` : null,
      result.tracking_number || null,
      result.cost != null ? result.cost : null,
      result.currency || null,
      result.service_name,
      ctx.address_id || null,
      req.params.id
    )

    logSystemRun('sys_ups_return_label', {
      status: result.pdf_error ? 'error' : 'success',
      result: [
        'Étiquette de retour UPS achetée',
        `  Retour : ${req.params.id}`,
        `  Environnement : ${result.environment}`,
        `  Service : ${result.service_name} (${result.service_code})`,
        `  Suivi : ${result.tracking_number || 'N/A'}`,
        `  Coût : ${result.cost != null ? `${result.cost} ${result.currency || ''}` : 'non retourné'}`,
        `  Expéditeur : ${ctx.company_name} (${ctx.address_city || ''})`,
        '  Destinataire : atelier Orisha, Québec',
      ].join('\n'),
      error: result.pdf_error || null,
      duration_ms: Date.now() - started,
      triggerData: { return_id: req.params.id, service_code: result.service_code },
    })

    res.json({
      purchased: true,
      shipment_id: result.shipment_id,
      tracking_number: result.tracking_number,
      cost: result.cost,
      currency: result.currency,
      service_name: result.service_name,
      environment: result.environment,
      label_url: result.filename ? `/erp/api/labels/${result.filename}` : null,
      label_error: result.pdf_error || null,
      customs: result.customs_items || null,
    })
  } catch (e) {
    console.error('UPS return-label error:', e.message)
    logSystemRun('sys_ups_return_label', {
      status: 'error', error: e.message, duration_ms: Date.now() - started,
      triggerData: { return_id: req.params.id },
    })
    upsFailure(res, e)
  }
})

// Envoi de l'étiquette au client (Postmark). Appelé par le front APRÈS la
// fenêtre d'annulation de 10 s d'UndoSendProvider — d'où l'absence de délai
// côté serveur : l'utilisateur a déjà eu sa chance d'annuler.
router.post('/returns/:id/return-label/send', async (req, res) => {
  const to = String(req.body?.to || '').trim()
  if (!to || !to.includes('@')) return res.status(400).json({ error: 'Adresse courriel invalide' })

  const ret = getReturn(req.params.id)
  if (!ret) return res.status(404).json({ error: 'Retour introuvable' })
  if (!ret.return_label_pdf_path) return res.status(400).json({ error: "Aucune étiquette de retour à envoyer — créez-la d'abord." })

  const labelPath = path.join(LABELS_DIR, path.basename(ret.return_label_pdf_path))
  if (!fs.existsSync(labelPath)) {
    return res.status(400).json({ error: `Fichier d'étiquette introuvable sur le serveur (${ret.return_label_pdf_path})` })
  }

  const started = Date.now()
  const label = ret.return_number || req.params.id
  const subject = `Votre étiquette de retour UPS — ${label}`
  const trackingLine = ret.return_label_tracking_number
    ? `<p>Numéro de suivi UPS : <strong>${ret.return_label_tracking_number}</strong></p>`
    : ''
  const html = `
    <p>Bonjour,</p>
    <p>Voici votre étiquette de retour prépayée UPS pour le dossier <strong>${label}</strong>.</p>
    <p>Imprimez-la, collez-la sur votre colis et déposez-le à un point de service UPS.</p>
    ${trackingLine}
    <p>Merci,<br>L'équipe Orisha</p>
  `

  try {
    const fromAddress = getAutomationFrom('sys_ups_return_label_email')
    if (!fromAddress) throw new Error('Adresse expéditeur Postmark non configurée')
    const client = new postmark.ServerClient(process.env.POSTMARK_API_KEY)
    await client.sendEmail({
      From: fromAddress,
      To: to,
      Subject: subject,
      HtmlBody: html,
      Attachments: [{
        Name: `etiquette-retour-ups-${label}.pdf`,
        Content: fs.readFileSync(labelPath).toString('base64'),
        ContentType: 'application/pdf',
      }],
    })

    const interactionId = uuidv4()
    const emailId = uuidv4()
    db.transaction(() => {
      db.prepare(`
        INSERT INTO interactions (id, contact_id, company_id, type, direction, timestamp)
        VALUES (?, ?, ?, 'email', 'out', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      `).run(interactionId, ret.contact_id || null, ret.company_id || null)
      db.prepare(`
        INSERT INTO emails (id, interaction_id, subject, body_html, from_address, to_address, automated)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `).run(emailId, interactionId, subject, html, fromAddress, to)
      db.prepare(`
        UPDATE returns
        SET return_label_sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            return_label_email_interaction_id = ?
        WHERE id = ?
      `).run(interactionId, req.params.id)
    })()

    logSystemRun('sys_ups_return_label_email', {
      status: 'success',
      result: `Étiquette de retour UPS envoyée à ${to} (retour ${req.params.id}, suivi ${ret.return_label_tracking_number || 'N/A'})`,
      duration_ms: Date.now() - started,
      triggerData: { return_id: req.params.id, to, interaction_id: interactionId },
    })

    res.json({ sent: true, interaction_id: interactionId })
  } catch (e) {
    console.error('UPS return-label send error:', e.message)
    logSystemRun('sys_ups_return_label_email', {
      status: 'error', error: e.message, duration_ms: Date.now() - started,
      triggerData: { return_id: req.params.id, to },
    })
    res.status(502).json({ error: e.message })
  }
})

// ── Tarifs (envoi sortant) ───────────────────────────────────────────────────
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

router.post('/shipments/:id/rates', async (req, res) => {
  const { packages } = req.body || {}
  if (!Array.isArray(packages) || !packages.length) {
    return res.status(400).json({ error: 'packages requis' })
  }
  if (!isUpsConfigured()) return res.status(400).json({ error: 'UPS non configuré (page Connecteurs)' })

  const ctx = db.prepare(SHIPMENT_CTX_SQL).get(req.params.id)
  if (!ctx) return res.status(404).json({ error: 'Envoi introuvable' })
  if (!ctx.address_id) return res.status(400).json({ error: "Cet envoi n'a pas d'adresse de livraison — impossible de tarifer." })

  try {
    res.json(await getShipmentRates(ctx, req.params.id, { packages }))
  } catch (e) {
    console.error('UPS rates error:', e.message)
    upsFailure(res, e)
  }
})

// ── Suivi ────────────────────────────────────────────────────────────────────
router.post('/shipments/:id/track', async (req, res) => {
  if (!isUpsConfigured()) return res.status(400).json({ error: 'UPS non configuré (page Connecteurs)' })

  const row = db.prepare('SELECT id, tracking_number FROM shipments WHERE id = ? AND deleted_at IS NULL').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Envoi introuvable' })
  if (!row.tracking_number) return res.status(400).json({ error: "Cet envoi n'a pas de numéro de suivi." })

  try {
    const t = await trackNumber(row.tracking_number)
    db.prepare(`
      UPDATE shipments
      SET ups_tracking_status = ?, ups_tracking_last_activity = ?,
          ups_tracking_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(t.status || null, t.last_activity || null, req.params.id)
    res.json(t)
  } catch (e) {
    console.error('UPS track error:', e.message)
    upsFailure(res, e)
  }
})

export default router
