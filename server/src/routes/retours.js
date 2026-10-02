import { Router } from 'express'
import { newRecordId } from '../utils/recordId.js'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { logSystemRun } from '../services/systemAutomations.js'
import { getAutomationFrom, getPostmarkClient } from '../services/postmarkConfig.js'
import { readRelation } from '../services/customFieldsView.js'
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
import { uploadsPath } from '../config/uploads.js'
import { createInAirtable, writeBackRecord } from '../services/airtableWriteback.js'
import { refusedAirtablePullKeys, AIRTABLE_PULL_EDIT_ERROR } from '../services/customFieldWritability.js'
import { matchReturnItem, receptionInstruction, receptionShelf } from '../services/returnReception.js'
import { emitEntity, emitOrder, emitOrderItem } from '../services/realtimeEmitters.js'
import { returnCompanyLinkColumn } from '../services/returnCompany.js'
import { applyOrderItemDefaults } from '../services/orderItemDefaults.js'
import { exportErpOrder, exportErpOrderItems } from '../services/discoveryOrderAirtable.js'
import { localDay } from '../utils/datetime.js'
import { stampOrderDate, alignAddressColumns } from './orders.js'
import { logSync } from '../services/syncLog.js'
import { trackEmailHtml } from '../services/emailTracking.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const router = Router()
router.use(requireAuth)

const MEMOS_DIR = uploadsPath('documents', 'retours')

// Filet du write-back ERP → Airtable lancé en fire-and-forget (même helper que
// routes/projets.js) : l'échec laisse une trace exploitable, pas un console.error.
function traceRetourPush(promise, recordId) {
  return promise.catch(e => {
    console.error(`erp-writeback retour_items ${recordId} (async):`, e.message)
    logSync('retours', 'erp-writeback', { status: 'error', error: `${recordId}: ${e.message}` })
  })
}

function getReturnAutomationConfig(id) {
  const row = db.prepare('SELECT action_config FROM automations WHERE id = ? AND deleted_at IS NULL').get(id)
  try { return JSON.parse(row?.action_config || '{}') } catch { return {} }
}

function getReturnWithItems(returnId) {
  // `SELECT r.*` sans jamais nommer de colonne : la table n'a plus de champ
  // Airtable géré en code (migration 037), tout ce qu'elle porte vient de la
  // vue et peut être supprimé depuis /champs/retours. L'entreprise, elle, se
  // déduit des articles (services/returnContext.js).
  const row = db.prepare(`
    SELECT r.*
    FROM ${readRelation('returns')} r
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

  const built = buildReturnPartyContext(req.params.id, req.query.address_id || null)
  const { address, candidates, ctx } = built
  // L'entreprise est publiée pour que l'état vide sache dire lequel des deux
  // manque : le client du retour, ou une adresse sur sa fiche.
  const company = built.ret?.company_id ? { id: built.ret.company_id, name: built.ret.company_name } : null
  res.json({ return: ret, company, address, candidates, party_ctx: ctx })
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
  const filePath = uploadsPath('attachments', relPath)
  try { return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null } catch { return null }
}

router.post('/:id/memo', async (req, res) => {
  const ret = getReturnWithItems(req.params.id)
  if (!ret) return res.status(404).json({ error: 'Retour introuvable' })

  // Le retour n'a plus de contact à lui (colonne droppée, migration 037) : la
  // langue des documents vient du contact de l'adresse de retour.
  const { ctx } = buildReturnPartyContext(req.params.id, req.body?.address_id || null) || {}
  const langue = ctx?.address_contact_langue || null
  const items = (ret.items || []).map(it => ({
    produit: (langue === 'English' ? it.poduit_a_recevoir_en_for_email_display : it.poduit_a_recevoir_fr_for_email_display) || it.product_name,
    adresse: it.adresse_lora,
    image: loadAttachmentBuffer(it.image_from_numero_de_serie) || loadAttachmentBuffer(it.image_from_produit_a_recevoir),
    transfo: loadAttachmentBuffer(it.transfo_a_recevoir_from_numero_de_serie) || loadAttachmentBuffer(it.transfo_a_recevoir_from_produit_a_recevoir),
  }))
  const pdfBuffer = await buildReturnMemoPdf({ langue, items })
  const filename = `memo-${req.params.id}.pdf`
  fs.mkdirSync(MEMOS_DIR, { recursive: true })
  fs.writeFileSync(path.join(MEMOS_DIR, filename), pdfBuffer)

  db.prepare(`
    UPDATE returns SET memo_pdf_path = ?, memo_generated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(`documents/retours/${filename}`, req.params.id)

  res.json({ memo_url: `/erp/api/retours/memos/${filename}` })
})

// GET /api/retours/memos/:filename — sert l'aide-mémoire (via requireAuth du routeur)
router.get('/memos/:filename', (req, res) => {
  const filePath = path.join(MEMOS_DIR, req.params.filename)
  if (!filePath.startsWith(MEMOS_DIR) || !fs.existsSync(filePath)) return res.status(404).json({ error: 'Introuvable' })
  res.sendFile(filePath)
})

// Contexte de composition des instructions de retour. Partagé entre l'aperçu
// (GET .../instructions-email, affiché dans la modale de composition) et
// l'envoi réel, pour que ce que l'utilisateur voit soit exactement ce qui part.
function loadInstructionsEmailContext(returnId) {
  const ret = getReturnWithItems(returnId)
  if (!ret) return { error: { status: 404, message: 'Retour introuvable' } }

  const { ctx } = buildReturnPartyContext(returnId, null)
  // Destinataire : le contact de l'adresse de retour (le retour lui-même n'a
  // plus de contact depuis la migration 037), à défaut le courriel de
  // l'entreprise.
  const contact = ctx?.address_contact_email || ctx?.address_contact_first_name
    ? { first_name: ctx.address_contact_first_name, langue: ctx.address_contact_langue, email: ctx.address_contact_email }
    : null
  // Un retour peut avoir plusieurs items avec des raisons différentes — on
  // retient la 1ère raison présente, fidèle à l'hypothèse implicite de
  // l'automatisation Airtable d'origine (un retour = une raison dominante).
  const returnReason = ret.items?.find(it => it.return_reason)?.return_reason || null

  const template = selectReturnInstructionsTemplate({
    country: ctx?.address_country || 'CA',
    lang: contact?.langue || 'French',
    returnReason,
  })

  return {
    ret,
    ctx,
    contact,
    to: ctx?.address_contact_email || contact?.email || ctx?.company_email || null,
    subject: template.subject,
    html: buildReturnInstructionsHtml(template, contact?.first_name),
  }
}

// Pièces jointes du courriel d'instructions : étiquette de retour + aide-mémoire
// quand ils existent. Même liste pour l'aperçu (noms seulement) et l'envoi.
function instructionsAttachments(ret, returnId) {
  const out = []
  if (ret.return_label_pdf_path) {
    const labelPath = uploadsPath('labels', path.basename(ret.return_label_pdf_path))
    if (fs.existsSync(labelPath)) out.push({ name: `etiquette-retour-${returnId}.pdf`, path: labelPath, url: `/erp/api/novoxpress/labels/${path.basename(labelPath)}` })
  }
  if (ret.memo_pdf_path) {
    const memoPath = path.join(MEMOS_DIR, path.basename(ret.memo_pdf_path))
    if (fs.existsSync(memoPath)) out.push({ name: `aide-memoire-${returnId}.pdf`, path: memoPath, url: `/erp/api/retours/memos/${path.basename(memoPath)}` })
  }
  return out
}

// GET /api/retours/:id/instructions-email — brouillon du courriel (destinataire,
// expéditeur, objet, corps HTML, pièces jointes) sans rien envoyer.
router.get('/:id/instructions-email', (req, res) => {
  const ctx = loadInstructionsEmailContext(req.params.id)
  if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.message })

  res.json({
    to: ctx.to,
    from: getAutomationFrom('sys_return_instructions_email') || null,
    subject: ctx.subject,
    bodyHtml: ctx.html,
    // `url` : la modale en montre une vignette et l'aperçu, sans quitter le brouillon.
    attachments: instructionsAttachments(ctx.ret, req.params.id).map(a => ({ name: a.name, url: a.url })),
    already_sent_at: ctx.ret.instructions_sent_at || null,
  })
})

// POST /api/retours/:id/send-instructions — courriel client (Postmark),
// reproduisant l'un des 6 templates HubSpot réels (returnInstructionsTemplates.js) —
// sélection par pays (transporteur) × langue × type de retour (immédiat/différé).
// L'objet, le corps et le Cc peuvent être remplacés par ce que l'utilisateur a
// édité dans la modale de composition (EmailComposerModal).
router.post('/:id/send-instructions', async (req, res) => {
  const started = Date.now()
  const { to, cc, subject, body_html } = req.body
  if (!to || !to.includes('@')) return res.status(400).json({ error: 'Adresse courriel invalide' })

  const emailCtx = loadInstructionsEmailContext(req.params.id)
  if (emailCtx.error) return res.status(emailCtx.error.status).json({ error: emailCtx.error.message })
  const { ret, ctx } = emailCtx
  const finalSubject = (subject && String(subject).trim()) || emailCtx.subject
  const html = (body_html && String(body_html).trim()) || emailCtx.html

  const emailId = newRecordId()
  const attachments = []
  try {
    for (const a of instructionsAttachments(ret, req.params.id)) {
      attachments.push({ Name: a.name, Content: fs.readFileSync(a.path).toString('base64'), ContentType: 'application/pdf' })
    }

    const fromAddress = getAutomationFrom('sys_return_instructions_email')
    if (!fromAddress) throw new Error('Adresse expéditeur Postmark non configurée')
    const client = getPostmarkClient()
    await client.sendEmail({
      From: fromAddress,
      To: to,
      Cc: cc || undefined,
      Subject: finalSubject,
      HtmlBody: trackEmailHtml(html, emailId),
      Attachments: attachments,
    })

    const interactionId = newRecordId()
    db.transaction(() => {
      db.prepare(`
        INSERT INTO interactions (id, contact_id, company_id, type, direction, timestamp)
        VALUES (?, ?, ?, 'email', 'out', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      `).run(interactionId, ctx?.address_contact_id || null, ctx?.company_id || null)
      db.prepare(`
        INSERT INTO emails (id, interaction_id, subject, body_html, from_address, to_address, cc, automated)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1)
      `).run(emailId, interactionId, finalSubject, html, fromAddress, to, cc || null)
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
        `  À : ${to}${cc ? ` (Cc : ${cc})` : ''}`,
        `  Objet : ${finalSubject}`,
        `  Pièces jointes : ${attachments.map(a => a.Name).join(', ') || 'aucune'}`,
        `  Retour : ${req.params.id}`,
      ].join('\n'),
      duration_ms: Date.now() - started,
      triggerData: { return_id: req.params.id, to, cc: cc || null, interaction_id: interactionId },
    })

    res.json({ success: true, interaction_id: interactionId, attachments: attachments.map(a => a.Name) })
  } catch (e) {
    console.error('Retours send-instructions error:', e.message)
    logSystemRun('sys_return_instructions_email', { status: 'error', error: e.message, duration_ms: Date.now() - started, triggerData: { return_id: req.params.id } })
    res.status(502).json({ error: e.message })
  }
})

// Miroir Airtable d'un retour NÉ dans Boréal : le retour d'abord, ses articles
// ensuite (ils se lient à lui par record id, il doit donc exister avant).
//
// Rien ne part tant qu'aucun champ des retours n'est réglé sur « Bidirectionnel »
// ou « Boréal → Airtable » dans /champs/retours : createInAirtable n'a alors
// aucun champ à pousser et saute la création. Les articles ne sont tentés que si
// le retour a bien obtenu son record Airtable — sinon ils y naîtraient orphelins,
// et le sync entrant ignore un article sans retour lié.
//
// Asynchrone et non bloquant : le retour existe dans Boréal même si Airtable est
// indisponible ; les échecs sont tracés dans sync_log par createInAirtable.
async function mirrorNewReturn(returnId, itemIds) {
  try {
    const res = await createInAirtable('retours', returnId)
    if (!res?.ok) return
    for (const itemId of itemIds) await createInAirtable('retour_items', itemId)
  } catch (e) {
    console.error('Retours miroir Airtable (async):', e.message)
  }
}

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
    const returnId = newRecordId()
    const itemIds = []
    const tx = db.transaction(() => {
      // Le retour ne porte plus l'entreprise (colonne droppée, migration 037) :
      // ce sont ses ARTICLES qui la portent (`return_items.company_id`
      // ci-dessous), et c'est de là qu'elle est relue partout. Plus de statut
      // non plus (migration 041).
      db.prepare(`
        INSERT INTO returns (id, created_at, updated_at)
        VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      `).run(returnId)

      const insertItem = db.prepare(`
        INSERT INTO return_items (id, return_id, serial_id, company_id, return_reason, creassion_massive, created_at)
        VALUES (?, ?, ?, ?, ?, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      `)
      const updateSerial = db.prepare(`UPDATE serial_numbers SET status = 'En retour', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`)

      for (const serialId of serial_ids) {
        const itemId = newRecordId()
        itemIds.push(itemId)
        insertItem.run(itemId, returnId, serialId, company_id, reason)
        updateSerial.run(serialId)
      }
    })
    tx()

    mirrorNewReturn(returnId, itemIds)

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

// ── « Créer un retour » depuis la fiche entreprise ─────────────────────────
//
// Candidats au retour : les numéros de série OPÉRATIONNELS de l'entreprise, et
// les articles sans numéro de série (produit non sérialisé) qui lui ont été
// envoyés — envoi marqué « Envoyé », ligne envoyée, ou date d'envoi Airtable.
router.get('/company-candidates/:companyId', (req, res) => {
  const companyId = req.params.companyId
  const serials = db.prepare(`
    SELECT sn.id, sn.serial, sn.status, sn.address, sn.product_id, pr.name_fr AS product_name, pr.sku, pr.image_url
    FROM serial_numbers sn
    LEFT JOIN products pr ON pr.id = sn.product_id
    WHERE sn.company_id = ? AND sn.deleted_at IS NULL AND sn.status LIKE 'Opérationnel%'
    ORDER BY sn.serial COLLATE NOCASE
  `).all(companyId)
  const items = db.prepare(`
    SELECT oi.id, oi.product_id, oi.qty, o.id AS order_id, o.order_number,
           pr.name_fr AS product_name, pr.sku, pr.image_url,
           COALESCE(sh.shipped_at, oi.date_de_l_envoi) AS shipped_at
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id AND o.deleted_at IS NULL
    LEFT JOIN products pr ON pr.id = oi.product_id
    LEFT JOIN shipments sh ON sh.id = oi.shipment_id
    WHERE o.company_id = ? AND oi.product_id IS NOT NULL
      AND (pr.besoin_d_un_numero_de_serie IS NULL OR pr.besoin_d_un_numero_de_serie != '1.0')
      AND (oi.fulfillment_status = 'Envoyé' OR sh.status = 'Envoyé' OR oi.date_de_l_envoi IS NOT NULL)
    ORDER BY COALESCE(sh.shipped_at, oi.date_de_l_envoi) DESC
  `).all(companyId)
  res.json({ serials, items })
})

const linkKey = row => row?.airtable_id || row?.id || null

// POST /api/retours/create — retour complet saisi dans le formulaire :
//   { company_id, ticket_id?,
//     items: [{ serial_id | order_item_id, qty?, reason, notes?, substitute_product_id? }],
//     exchange?: { order_id? (sinon nouvelle commande), address_id? } }
//
// Un article de retour = une unité : un article sans n° de série retourné en
// quantité N donne N articles. Avec échange immédiat, chaque article substitué
// devient une ligne « Remplacement » dans la commande (nouvelle ou existante),
// dont le « # de série remplacé » porte le n° retourné — c'est par lui que
// l'appareil envoyé hérite de la date de début de garantie.
//
// Les articles naissent « déjà traités » (rma_processed_at) : l'automatisation
// « Création d'un item de retour » créerait sinon une seconde commande de
// remplacement pour la raison « échange immédiat ».
router.post('/create', (req, res) => {
  const { company_id, ticket_id, items, exchange } = req.body || {}
  const company = company_id && db.prepare('SELECT id, airtable_id FROM companies WHERE id = ?').get(company_id)
  if (!company) return res.status(400).json({ error: 'Entreprise introuvable' })
  if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Aucun article à retourner' })

  const ticket = ticket_id ? db.prepare('SELECT id, airtable_id FROM tickets WHERE id = ?').get(ticket_id) : null
  if (ticket_id && !ticket) return res.status(400).json({ error: 'Billet introuvable' })

  const getSerial = db.prepare('SELECT id, airtable_id, serial, product_id, company_id FROM serial_numbers WHERE id = ?')
  const getOrderItem = db.prepare(`
    SELECT oi.id, oi.airtable_id, oi.product_id, oi.qty FROM order_items oi
    JOIN orders o ON o.id = oi.order_id WHERE oi.id = ? AND o.company_id = ?`)
  const getProduct = db.prepare('SELECT id FROM products WHERE id = ?')

  const lines = []
  for (const it of items) {
    const reason = String(it?.reason || '').trim()
    if (!reason) return res.status(400).json({ error: 'Raison du retour requise pour chaque article' })
    const sub = it.substitute_product_id || null
    if (sub && !getProduct.get(sub)) return res.status(400).json({ error: 'Produit de substitution introuvable' })
    if (it.serial_id) {
      const sn = getSerial.get(it.serial_id)
      if (!sn || sn.company_id !== company.id) return res.status(400).json({ error: 'Numéro de série introuvable pour cette entreprise' })
      lines.push({ serial: sn, qty: 1, reason, notes: it.notes || null, sub })
    } else if (it.order_item_id) {
      const oi = getOrderItem.get(it.order_item_id, company.id)
      if (!oi) return res.status(400).json({ error: 'Article introuvable pour cette entreprise' })
      const qty = parsePositiveQty(it.qty)
      if (!qty || qty > (oi.qty || 1)) return res.status(400).json({ error: 'Quantité invalide' })
      lines.push({ orderItem: oi, qty, reason, notes: it.notes || null, sub })
    } else {
      return res.status(400).json({ error: 'Article sans référence' })
    }
  }

  const substituted = lines.filter(l => l.sub)
  let order = null
  let address = null
  if (exchange && substituted.length) {
    if (exchange.order_id) {
      order = db.prepare('SELECT id, airtable_id, order_number FROM orders WHERE id = ? AND company_id = ? AND deleted_at IS NULL').get(exchange.order_id, company.id)
      if (!order) return res.status(400).json({ error: 'Commande introuvable pour cette entreprise' })
    }
    if (exchange.address_id) {
      address = db.prepare('SELECT id, airtable_id FROM adresses WHERE id = ?').get(exchange.address_id)
      if (!address) return res.status(400).json({ error: 'Adresse introuvable' })
    }
  }

  try {
    const returnId = newRecordId()
    const itemIds = []
    const orderItemIds = []
    let createdOrder = false
    const now = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"
    db.transaction(() => {
      // Champ « Entreprise » du retour (lien miroité) quand il existe : la liste
      // des retours l'affiche, les articles portent déjà `company_id`.
      const companyCol = returnCompanyLinkColumn()
      db.prepare(`INSERT INTO returns (id, created_at, updated_at${companyCol ? `, [${companyCol}]` : ''})
                  VALUES (?, ${now}, ${now}${companyCol ? ', ?' : ''})`)
        .run(returnId, ...(companyCol ? [linkKey(company)] : []))

      if (exchange && substituted.length) {
        if (!order) {
          const orderId = newRecordId()
          const orderNumber = (db.prepare('SELECT MAX(order_number) AS m FROM orders').get()?.m || 0) + 1
          db.prepare(`INSERT INTO orders (id, order_number, company_id, status, notes, date_commande)
                      VALUES (?, ?, ?, 'Commande vide', ?, ?)`)
            .run(orderId, orderNumber, company.id, 'Remplacement — échange immédiat', localDay())
          stampOrderDate(orderId)
          order = { id: orderId, airtable_id: null, order_number: orderNumber }
          createdOrder = true
        }
        if (address) {
          const body = { address_id: address.id }
          alignAddressColumns(body)
          db.prepare(`UPDATE orders SET address_id = ?, adresse_de_livraison = ?, updated_at = ${now} WHERE id = ?`)
            .run(body.address_id, body.adresse_de_livraison, order.id)
        }
        db.prepare('UPDATE returns SET order_id = ? WHERE id = ?').run(order.id, returnId)
      }

      const insertItem = db.prepare(`
        INSERT INTO return_items (id, return_id, serial_id, product_id, company_id, return_reason, return_reason_notes,
                                  billets, items_de_commande, commande, rma_processed_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${now}, ${now})`)
      const insertOrderItem = db.prepare(`
        INSERT INTO order_items (id, order_id, product_id, qty, item_type, document_type, return_id, replaced_serial, de_serie_remplace)
        VALUES (?, ?, ?, ?, 'Remplacement', 'Remplacement', ?, ?, ?)`)
      const serialEnRetour = db.prepare(`UPDATE serial_numbers SET status = 'En retour', updated_at = ${now} WHERE id = ?`)
      const ticketLink = ticket ? JSON.stringify([linkKey(ticket)]) : null

      for (const l of lines) {
        const orderLink = order && l.sub ? JSON.stringify([linkKey(order)]) : null
        for (let i = 0; i < l.qty; i++) {
          const itemId = newRecordId()
          itemIds.push(itemId)
          insertItem.run(
            itemId, returnId, l.serial?.id || null, l.orderItem?.product_id || null, company.id,
            l.reason, l.notes, ticketLink,
            l.orderItem ? JSON.stringify([linkKey(l.orderItem)]) : null, orderLink,
          )
        }
        if (l.serial) serialEnRetour.run(l.serial.id)
        if (order && l.sub) {
          const oiId = newRecordId()
          orderItemIds.push(oiId)
          insertOrderItem.run(oiId, order.id, l.sub, l.qty, returnId,
            l.serial?.id || null, l.serial ? linkKey(l.serial) : null)
          applyOrderItemDefaults(oiId)
        }
      }
    })()

    mirrorNewReturn(returnId, itemIds)
    if (order) {
      if (createdOrder) { emitOrder('created', order.id, req.user?.id); exportErpOrder(order.id) }
      else { emitOrder('updated', order.id, req.user?.id); exportErpOrderItems(order.id) }
      for (const oiId of orderItemIds) emitOrderItem('created', order.id, { id: oiId }, req.user?.id)
    }
    res.status(201).json({
      return_id: returnId,
      count: itemIds.length,
      order: order ? { id: order.id, order_number: order.order_number, created: createdOrder } : null,
    })
  } catch (e) {
    console.error('Retours create error:', e.message)
    res.status(500).json({ error: e.message })
  }
})

function parsePositiveQty(v) {
  const n = Number(v ?? 1)
  return Number.isInteger(n) && n > 0 ? n : null
}

// Articles d'un retour avec ce qu'il faut pour les reconnaître au scan et leur
// dire leur étagère.
function receptionItems(returnId) {
  return db.prepare(`
    SELECT ri.id, ri.return_reason, ri.received_at, ri.received_by,
           sn.serial AS serial_number,
           COALESCE(pr.sku, psn.sku) AS sku,
           COALESCE(pr.name_fr, psn.name_fr) AS product_name
    FROM return_items ri
    LEFT JOIN serial_numbers sn ON ri.serial_id = sn.id
    LEFT JOIN products psn ON sn.product_id = psn.id
    LEFT JOIN products pr ON ri.product_id = pr.id
    WHERE ri.return_id = ?
    ORDER BY ri.created_at
  `).all(returnId)
}

// POST /api/retours/:id/receive-scan — réception au pistolet d'un article.
//
// Un seul geste : le code scanné désigne l'article du retour, à qui on pose la
// date de réception et le réceptionniste choisis dans la section « Réception »
// de la fiche. La réponse porte la phrase à afficher (étagère d'analyse ou de
// reconditionnement, cf. services/returnReception.js — règle reprise
// d'Airtable).
//
// Comme le scan de prélèvement des commandes : un refus répond 200 avec un
// `action`, jamais une erreur HTTP — l'opérateur a les mains sur le pistolet,
// pas sur une console.
router.post('/:id/receive-scan', (req, res) => {
  const ret = db.prepare('SELECT id FROM returns WHERE id = ?').get(req.params.id)
  if (!ret) return res.status(404).json({ error: 'Retour introuvable' })

  const code = String(req.body.code || '').trim()
  if (!code) return res.status(400).json({ error: 'code requis' })
  const receivedBy = String(req.body.received_by || '').trim()
  const receivedAt = String(req.body.received_at || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedAt)) return res.status(400).json({ error: 'received_at attendu en AAAA-MM-JJ' })

  // Les deux colonnes écrites doivent être en « Bidirectionnel » (/champs/
  // return_items) : en sens import, la réception serait écrasée au prochain
  // sync Airtable. La migration 070 les y a mises — si quelqu'un les repasse en
  // import, le scan le dit au lieu d'écrire dans le vide.
  const refused = refusedAirtablePullKeys('return_items', { received_at: receivedAt, received_by: receivedBy })
  if (refused.length) return res.status(400).json({ error: AIRTABLE_PULL_EDIT_ERROR })

  const items = receptionItems(req.params.id)

  const item = matchReturnItem(items, code)
  if (!item) return res.json({ action: 'not_in_return', code })

  const message = receptionInstruction(item.return_reason, receivedBy)
  if (item.received_at) {
    return res.json({ action: 'already_received', code, item, message, shelf: receptionShelf(item.return_reason) })
  }

  db.prepare('UPDATE return_items SET received_at = ?, received_by = ? WHERE id = ?')
    .run(receivedAt, receivedBy || null, item.id)
  traceRetourPush(writeBackRecord('retour_items', item.id, ['received_at', 'received_by']), item.id)

  const updated = db.prepare(`SELECT * FROM ${readRelation('return_items')} WHERE id = ?`).get(item.id)
  emitEntity('return_item', 'updated', item.id, updated, req.user?.id)
  res.json({
    action: 'received',
    code,
    item: { ...item, received_at: receivedAt, received_by: receivedBy },
    message,
    shelf: receptionShelf(item.return_reason),
  })
})

// POST /api/retours/:id/receive — réception d'articles cochés dans le tableau
// de la fiche (pendant manuel du pistolet). Pose la même date et le même
// réceptionniste sur chaque article choisi ; un article déjà reçu est
// réécrit — la case cochée est un geste explicite (correction comprise).
router.post('/:id/receive', (req, res) => {
  const ret = db.prepare('SELECT id FROM returns WHERE id = ?').get(req.params.id)
  if (!ret) return res.status(404).json({ error: 'Retour introuvable' })

  const ids = Array.isArray(req.body.item_ids) ? req.body.item_ids.map(String).filter(Boolean) : []
  if (!ids.length) return res.status(400).json({ error: 'item_ids requis' })
  const receivedBy = String(req.body.received_by || '').trim()
  const receivedAt = String(req.body.received_at || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedAt)) return res.status(400).json({ error: 'received_at attendu en AAAA-MM-JJ' })

  // Même garde que le scan : colonnes en « Bidirectionnel » sinon refus.
  const refused = refusedAirtablePullKeys('return_items', { received_at: receivedAt, received_by: receivedBy })
  if (refused.length) return res.status(400).json({ error: AIRTABLE_PULL_EDIT_ERROR })

  const wanted = new Set(ids)
  const chosen = receptionItems(req.params.id).filter(i => wanted.has(String(i.id)))
  const inReturn = chosen.map(i => i.id)
  if (!inReturn.length) return res.status(400).json({ error: 'Aucun article de ce retour' })

  const update = db.prepare('UPDATE return_items SET received_at = ?, received_by = ? WHERE id = ?')
  db.transaction(() => { for (const itemId of inReturn) update.run(receivedAt, receivedBy || null, itemId) })()

  const readUpdated = db.prepare(`SELECT * FROM ${readRelation('return_items')} WHERE id = ?`)
  for (const itemId of inReturn) {
    traceRetourPush(writeBackRecord('retour_items', itemId, ['received_at', 'received_by']), itemId)
    emitEntity('return_item', 'updated', itemId, readUpdated.get(itemId), req.user?.id)
  }
  // Même consigne d'étagère que le scan, article par article.
  const instructions = chosen.map(i => ({
    item: { ...i, received_at: receivedAt, received_by: receivedBy },
    message: receptionInstruction(i.return_reason, receivedBy),
    shelf: receptionShelf(i.return_reason),
  }))
  res.json({ received: inReturn, received_at: receivedAt, received_by: receivedBy || null, instructions })
})

export default router
