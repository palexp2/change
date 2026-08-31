import { Router } from 'express'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import { v4 as uuidv4 } from 'uuid'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { logSystemRun } from '../services/systemAutomations.js'
import { getAutomationFrom, getPostmarkClient } from '../services/postmarkConfig.js'
import { buildReturnPartyContext } from '../services/returnContext.js'
import { selectReturnRate } from '../services/returnCarrier.js'
import { buildReturnMemoPdf } from '../services/returnMemoPdf.js'
import { selectReturnInstructionsTemplate, buildReturnInstructionsHtml } from '../services/returnInstructionsTemplates.js'
import {
  isNovoxpressConfigured,
  getReturnRates,
  createReturnLabel,
  fetchAndSaveLabelPdf,
  buildReturnPayload,
} from '../services/novoxpress.js'
import {
  isDiagnosticAvailable,
  runDiagnostic,
} from '../services/novoxpressDiagnostic.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const router = Router()
router.use(requireAuth)

const MEMOS_DIR = path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'documents', 'retours')

function getReturnAutomationConfig(id) {
  const row = db.prepare('SELECT action_config FROM automations WHERE id = ? AND deleted_at IS NULL').get(id)
  try { return JSON.parse(row?.action_config || '{}') } catch { return {} }
}

function getReturnWithItems(returnId) {
  const row = db.prepare(`
    SELECT r.*, co.name as company_name
    FROM returns r
    LEFT JOIN companies co ON r.company_id = co.id
    WHERE r.id = ?
  `).get(returnId)
  if (!row) return null

  const items = db.prepare(`
    SELECT ri.*, sn.serial as serial_number,
           COALESCE(pr.name_fr, psn.name_fr) as product_name
    FROM return_items ri
    LEFT JOIN serial_numbers sn ON ri.serial_id = sn.id
    LEFT JOIN products psn ON sn.product_id = psn.id
    LEFT JOIN products pr ON ri.product_id = pr.id
    WHERE ri.return_id = ?
    ORDER BY ri.created_at
  `).all(returnId)

  return { ...row, items }
}

// GET /api/retours/:id/return-context — adresse résolue (+ candidates) + poids estimé
router.get('/:id/return-context', (req, res) => {
  const ret = getReturnWithItems(req.params.id)
  if (!ret) return res.status(404).json({ error: 'Retour introuvable' })

  const { address, candidates, ctx } = buildReturnPartyContext(req.params.id, req.query.address_id || null)
  res.json({ return: ret, address, candidates, party_ctx: ctx })
})

// POST /api/retours/:id/return-rates — tarifs + tarif recommandé
router.post('/:id/return-rates', async (req, res) => {
  if (!isNovoxpressConfigured()) return res.status(400).json({ error: 'Novoxpress non configuré' })

  const { address_id, packaging_type, packages, declared_value } = req.body
  if (!packages?.length) return res.status(400).json({ error: 'packages requis' })

  const { ctx } = buildReturnPartyContext(req.params.id, address_id || null)
  if (!ctx) return res.status(400).json({ error: "Aucune adresse client trouvée pour ce retour — sélectionnez-en une manuellement." })

  try {
    const result = await getReturnRates(ctx, { packaging_type, packages, declared_value })
    const cfg = getReturnAutomationConfig('sys_return_label')
    const senderCountry = ctx.address_country === 'États-Unis' || ctx.address_country === 'United States' ? 'US' : (ctx.address_country || 'CA')
    const recommendation = selectReturnRate(result.rates, senderCountry, {
      threshold: Number(cfg.savings_threshold || 0),
      preferCA: cfg.prefer_ca || 'purolator',
      preferUS: cfg.prefer_us || 'ups',
    })
    res.json({ ...result, recommendation })
  } catch (e) {
    console.error('Retours getReturnRates error:', e.message)
    const isLocalValidation = !e.responseBody && !e.status
    res.status(isLocalValidation ? 400 : 502).json({
      error: e.message,
      sent: e.sentPayload || null,
      responseBody: e.responseBody || null,
      novoxpressStatus: e.status || null,
    })
  }
})

// POST /api/retours/:id/return-label — achat de l'étiquette de retour
router.post('/:id/return-label', async (req, res) => {
  if (!isNovoxpressConfigured()) return res.status(400).json({ error: 'Novoxpress non configuré' })

  const { address_id, request_id, service_id, carrier_name, service_name, packaging_type, packages, declared_value } = req.body
  if (!service_id) return res.status(400).json({ error: 'service_id requis' })
  if (!packages?.length) return res.status(400).json({ error: 'packages requis' })

  const ret = db.prepare('SELECT id FROM returns WHERE id = ?').get(req.params.id)
  if (!ret) return res.status(404).json({ error: 'Retour introuvable' })

  const { ctx } = buildReturnPartyContext(req.params.id, address_id || null)
  if (!ctx) return res.status(400).json({ error: "Aucune adresse client trouvée pour ce retour." })

  const started = Date.now()
  try {
    const result = await createReturnLabel(ctx, req.params.id, {
      request_id, service_id, packaging_type, packages, declared_value
    })

    db.prepare(`
      UPDATE returns
      SET return_novoxpress_shipment_id = ?,
          return_label_pdf_path = COALESCE(?, return_label_pdf_path),
          return_label_tracking_number = COALESCE(?, return_label_tracking_number),
          return_carrier = COALESCE(?, return_carrier),
          return_service_name = COALESCE(?, return_service_name),
          return_label_created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(
      result.shipment_id,
      result.filename ? `labels/${result.filename}` : null,
      result.tracking_id || null,
      carrier_name || null,
      service_name || null,
      req.params.id
    )

    logSystemRun('sys_return_label', {
      status: 'success',
      result: [
        `Étiquette de retour achetée`,
        `  Retour : ${req.params.id}`,
        `  Transporteur : ${carrier_name || 'N/A'} — ${service_name || ''}`,
        `  Suivi : ${result.tracking_id || 'N/A'}`,
        `  N° Novoxpress : ${result.shipment_id}`,
      ].join('\n'),
      duration_ms: Date.now() - started,
      triggerData: { return_id: req.params.id, service_id },
    })

    res.json({
      purchased: true,
      shipment_id: result.shipment_id,
      tracking_id: result.tracking_id,
      label_url: result.filename ? `/erp/api/novoxpress/labels/${result.filename}` : null,
      label_error: result.labelError || null,
    })
  } catch (e) {
    console.error('Retours createReturnLabel error:', e.message)
    logSystemRun('sys_return_label', { status: 'error', error: e.message, duration_ms: Date.now() - started, triggerData: { return_id: req.params.id } })
    const isLocalValidation = !e.responseBody && !e.status
    res.status(isLocalValidation ? 400 : 502).json({
      error: e.message,
      sent: e.sentPayload || null,
      responseBody: e.responseBody || null,
      novoxpressStatus: e.status || null,
    })
  }
})

// POST /api/retours/:id/return-label/retry-pdf — re-télécharger sans re-facturer
router.post('/:id/return-label/retry-pdf', async (req, res) => {
  if (!isNovoxpressConfigured()) return res.status(400).json({ error: 'Novoxpress non configuré' })

  const ret = db.prepare('SELECT return_novoxpress_shipment_id FROM returns WHERE id = ?').get(req.params.id)
  if (!ret) return res.status(404).json({ error: 'Retour introuvable' })
  if (!ret.return_novoxpress_shipment_id) {
    return res.status(400).json({ error: "Aucune étiquette Novoxpress achetée pour ce retour." })
  }

  try {
    const pdf = await fetchAndSaveLabelPdf(ret.return_novoxpress_shipment_id, `return-${req.params.id}`)
    db.prepare(`
      UPDATE returns SET return_label_pdf_path = ?, return_label_tracking_number = COALESCE(?, return_label_tracking_number)
      WHERE id = ?
    `).run(`labels/${pdf.filename}`, pdf.trackingNumber || null, req.params.id)
    res.json({ label_url: `/erp/api/novoxpress/labels/${pdf.filename}`, tracking_id: pdf.trackingNumber || null })
  } catch (e) {
    console.error('Retours retry-pdf error:', e.message)
    res.status(502).json({ error: e.message })
  }
})

// POST /api/retours/:id/diagnostic — validation en environnement dev Novoxpress,
// AUCUN achat réel. À utiliser avant tout achat prod pour trancher payment_type
// sur le payload inversé (cf. commentaire dans novoxpress.js buildReturnPayload).
router.post('/:id/diagnostic', async (req, res) => {
  if (!isDiagnosticAvailable()) {
    return res.status(400).json({ error: "Diagnostic indisponible — token API Novoxpress (api_token) non configuré dans la page Connecteurs." })
  }
  const { address_id, op = 'rate', packaging_type, packages, declared_value, service_id } = req.body
  const { ctx } = buildReturnPartyContext(req.params.id, address_id || null)
  if (!ctx) return res.status(400).json({ error: "Aucune adresse client trouvée pour ce retour." })

  let details
  try {
    details = buildReturnPayload(
      ctx,
      packaging_type || 'package',
      packages?.length ? packages : [{ quantity: '1', weight: '2', length: '20', width: '16', depth: '8' }],
      declared_value || '1'
    )
  } catch (e) {
    return res.status(400).json({ error: `Validation locale (avant tout appel Novoxpress) : ${e.message}` })
  }

  try {
    const result = await runDiagnostic(op, {
      details,
      serviceId: service_id || 'purolator-10',
      shipmentId: req.params.id,
    }, 'manual')
    res.json(result)
  } catch (e) {
    console.error('Retours diagnostic error:', e.message)
    res.status(502).json({ error: e.message })
  }
})

// POST /api/retours/:id/memo — génère l'aide-mémoire PDF
// Charge un buffer image depuis une URL locale `/erp/api/attachments/...` ou
// `/api/attachments/...` (miroir Airtable, cf. reference_airtable_attachment_mirror) —
// lecture disque directe, pas de fetch HTTP. Une image Airtable synced peut
// être une liste séparée par des virgules (cf. RetourDetail.jsx) : on ne
// prend que la première.
function loadAttachmentBuffer(value) {
  if (!value) return null
  const url = String(value).split(',')[0].trim()
  const marker = '/api/attachments/'
  const idx = url.indexOf(marker)
  if (idx === -1) return null
  const relPath = url.slice(idx + marker.length)
  const filePath = path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'attachments', relPath)
  try { return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null } catch { return null }
}

router.post('/:id/memo', async (req, res) => {
  const ret = getReturnWithItems(req.params.id)
  if (!ret) return res.status(404).json({ error: 'Retour introuvable' })

  try {
    const contact = ret.contact_id
      ? db.prepare('SELECT langue FROM contacts WHERE id = ?').get(ret.contact_id)
      : null
    const items = (ret.items || []).map(it => ({
      produit: (contact?.langue === 'English' ? it.poduit_a_recevoir_en_for_email_display : it.poduit_a_recevoir_fr_for_email_display) || it.product_name,
      adresse: it.adresse_lora,
      image: loadAttachmentBuffer(it.image_from_numero_de_serie) || loadAttachmentBuffer(it.image_from_produit_a_recevoir),
      transfo: loadAttachmentBuffer(it.transfo_a_recevoir_from_numero_de_serie) || loadAttachmentBuffer(it.transfo_a_recevoir_from_produit_a_recevoir),
    }))
    const pdfBuffer = await buildReturnMemoPdf({ langue: contact?.langue, items })
    const filename = `memo-${req.params.id}.pdf`
    fs.mkdirSync(MEMOS_DIR, { recursive: true })
    fs.writeFileSync(path.join(MEMOS_DIR, filename), pdfBuffer)

    db.prepare(`
      UPDATE returns SET memo_pdf_path = ?, memo_generated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?
    `).run(`documents/retours/${filename}`, req.params.id)

    res.json({ memo_url: `/erp/api/retours/memos/${filename}` })
  } catch (e) {
    console.error('Retours memo PDF error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

// GET /api/retours/memos/:filename — sert l'aide-mémoire (via requireAuth du routeur)
router.get('/memos/:filename', (req, res) => {
  const filePath = path.join(MEMOS_DIR, req.params.filename)
  if (!filePath.startsWith(MEMOS_DIR) || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Introuvable' })
  res.sendFile(filePath)
})

// POST /api/retours/:id/send-instructions — courriel client (Postmark),
// reproduisant l'un des 6 templates HubSpot réels (returnInstructionsTemplates.js) —
// sélection par pays (transporteur) × langue × type de retour (immédiat/différé).
router.post('/:id/send-instructions', async (req, res) => {
  const started = Date.now()
  const { to } = req.body
  if (!to || !to.includes('@')) return res.status(400).json({ error: 'Adresse courriel invalide' })

  const ret = getReturnWithItems(req.params.id)
  if (!ret) return res.status(404).json({ error: 'Retour introuvable' })

  const { ctx } = buildReturnPartyContext(req.params.id, null)
  const contact = ret.contact_id ? db.prepare('SELECT first_name, langue FROM contacts WHERE id = ?').get(ret.contact_id) : null
  // Un retour peut avoir plusieurs items avec des raisons différentes — on
  // retient la 1ère raison présente, fidèle à l'hypothèse implicite de
  // l'automatisation Airtable d'origine (un retour = une raison dominante).
  const returnReason = ret.items?.find(it => it.return_reason)?.return_reason || null

  const template = selectReturnInstructionsTemplate({
    country: ctx?.address_country || 'CA',
    lang: contact?.langue || 'French',
    returnReason,
  })
  const html = buildReturnInstructionsHtml(template, contact?.first_name)

  const attachments = []
  try {
    if (ret.return_label_pdf_path) {
      const labelPath = path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'labels', path.basename(ret.return_label_pdf_path))
      if (fs.existsSync(labelPath)) {
        attachments.push({ Name: `etiquette-retour-${ret.return_number || req.params.id}.pdf`, Content: fs.readFileSync(labelPath).toString('base64'), ContentType: 'application/pdf' })
      }
    }
    if (ret.memo_pdf_path) {
      const memoPath = path.join(MEMOS_DIR, path.basename(ret.memo_pdf_path))
      if (fs.existsSync(memoPath)) {
        attachments.push({ Name: `aide-memoire-${ret.return_number || req.params.id}.pdf`, Content: fs.readFileSync(memoPath).toString('base64'), ContentType: 'application/pdf' })
      }
    }

    const fromAddress = getAutomationFrom('sys_return_instructions_email')
    if (!fromAddress) throw new Error('Adresse expéditeur Postmark non configurée')
    const client = getPostmarkClient()
    await client.sendEmail({
      From: fromAddress,
      To: to,
      Subject: template.subject,
      HtmlBody: html,
      Attachments: attachments,
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
      `).run(emailId, interactionId, template.subject, html, fromAddress, to)
      db.prepare(`
        UPDATE returns SET instructions_sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), instructions_interaction_id = ?
        WHERE id = ?
      `).run(interactionId, req.params.id)
    })()

    logSystemRun('sys_return_instructions_email', {
      status: 'success',
      result: [
        `Instructions de retour envoyées`,
        `  De : ${fromAddress}`,
        `  À : ${to}`,
        `  Pièces jointes : ${attachments.map(a => a.Name).join(', ') || 'aucune'}`,
        `  Retour : ${req.params.id}`,
      ].join('\n'),
      duration_ms: Date.now() - started,
      triggerData: { return_id: req.params.id, to, interaction_id: interactionId },
    })

    res.json({ success: true, interaction_id: interactionId, attachments: attachments.map(a => a.Name) })
  } catch (e) {
    console.error('Retours send-instructions error:', e.message)
    logSystemRun('sys_return_instructions_email', { status: 'error', error: e.message, duration_ms: Date.now() - started, triggerData: { return_id: req.params.id } })
    res.status(502).json({ error: e.message })
  }
})

// POST /api/retours/bulk-from-serials — « Retourner tous les numéros de série »
// (import de l'automatisation Airtable #3, bouton en masse sur la fiche
// entreprise). Contrairement à l'original (qui refiltre lui-même les numéros
// « Opérationnel - Loué » côté serveur), ici l'utilisateur sélectionne les
// lignes dans le tableau (bulk action DataTable) — le filtre de statut est
// déjà appliqué visuellement par la vue, la sélection explicite est plus sûre.
router.post('/bulk-from-serials', (req, res) => {
  const { company_id, serial_ids, reason } = req.body
  if (!company_id) return res.status(400).json({ error: 'company_id requis' })
  if (!Array.isArray(serial_ids) || !serial_ids.length) return res.status(400).json({ error: 'serial_ids requis' })
  if (!reason) return res.status(400).json({ error: 'reason requis' })

  try {
    const returnId = uuidv4()
    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO returns (id, company_id, status, created_at, updated_at)
        VALUES (?, ?, 'Ouvert', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      `).run(returnId, company_id)

      const insertItem = db.prepare(`
        INSERT INTO return_items (id, return_id, serial_id, company_id, return_reason, creassion_massive, created_at)
        VALUES (?, ?, ?, ?, ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      `)
      const updateSerial = db.prepare(`UPDATE serial_numbers SET status = 'En retour', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)

      for (const serialId of serial_ids) {
        insertItem.run(uuidv4(), returnId, serialId, company_id, reason)
        updateSerial.run(serialId)
      }
    })
    tx()

    logSystemRun('sys_return_bulk_by_company', {
      status: 'success',
      result: `${serial_ids.length} numéro(s) de série retourné(s) en masse pour l'entreprise ${company_id} (retour ${returnId}, raison: ${reason})`,
      triggerData: { company_id, return_id: returnId, count: serial_ids.length, reason },
    })

    res.json({ return_id: returnId, count: serial_ids.length })
  } catch (e) {
    console.error('Retours bulk-from-serials error:', e.message)
    logSystemRun('sys_return_bulk_by_company', { status: 'error', error: e.message, triggerData: { company_id } })
    res.status(500).json({ error: e.message })
  }
})

export default router
