import { Router } from 'express'
import { v4 as uuidv4 } from 'uuid'
import path from 'path'
import fs from 'fs'
import PDFDocument from 'pdfkit'
import sharp from 'sharp'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import * as postmark from 'postmark'
import { logSystemRun } from '../services/systemAutomations.js'
import { getAutomationFrom } from '../services/postmarkConfig.js'

const router = Router()
router.use(requireAuth)

const ADDRESS_COLS = `
  s.address_id,
  a.line1 as address_line1, a.city as address_city,
  a.province as address_province, a.postal_code as address_postal_code,
  a.country as address_country,
  a.contact_id as address_contact_id,
  ct.email as address_contact_email,
  ct.first_name as address_contact_first_name,
  ct.last_name as address_contact_last_name,
  ct.phone as address_contact_phone,
  ct.mobile as address_contact_mobile
`

// GET /api/shipments
router.get('/', (req, res) => {
  const { search, status, order_id, company_id, page = 1, limit = 50 } = req.query
  const limitAll = limit === 'all'
  const limitVal = limitAll ? -1 : parseInt(limit)
  const offset = limitAll ? 0 : (parseInt(page) - 1) * parseInt(limit)
  let where = 'WHERE s.deleted_at IS NULL'
  const params = []

  if (search) {
    where += ' AND (s.tracking_number LIKE ? OR s.carrier LIKE ? OR CAST(o.order_number AS TEXT) LIKE ? OR c.name LIKE ?)'
    const q = `%${search}%`
    params.push(q, q, q, q)
  }
  if (status) {
    where += ' AND s.status = ?'
    params.push(status)
  }
  if (order_id) {
    where += ' AND s.order_id = ?'
    params.push(order_id)
  }
  if (company_id) {
    where += ' AND o.company_id = ?'
    params.push(company_id)
  }

  const total = db.prepare(`
    SELECT COUNT(*) as c FROM shipments s
    LEFT JOIN orders o ON s.order_id = o.id
    LEFT JOIN companies c ON o.company_id = c.id
    ${where}
  `).get(...params).c

  const rows = db.prepare(`
    SELECT s.*, o.order_number, o.company_id, c.name as company_name, ${ADDRESS_COLS}
    FROM shipments s
    LEFT JOIN orders o ON s.order_id = o.id
    LEFT JOIN companies c ON o.company_id = c.id
    LEFT JOIN adresses a ON s.address_id = a.id
    LEFT JOIN contacts ct ON a.contact_id = ct.id
    ${where}
    ORDER BY s.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limitVal, offset)

  res.json({ data: rows, total, page: parseInt(page), limit: parseInt(limit) })
})

// GET /api/shipments/stats/weekly — colis envoyés par semaine (16 dernières semaines)
router.get('/stats/weekly', (req, res) => {
  const rows = db.prepare(`
    SELECT
      date(created_at, '-' || ((cast(strftime('%w', created_at) as integer) + 6) % 7) || ' days') as week_start,
      COUNT(*) as count
    FROM shipments
    WHERE created_at >= date('now', '-112 days')
    GROUP BY week_start
    ORDER BY week_start ASC
  `).all()
  res.json(rows)
})

// GET /api/shipments/:id
router.get('/:id', (req, res) => {
  const row = db.prepare(`
    SELECT s.*, o.order_number, o.company_id, c.name as company_name, ${ADDRESS_COLS}
    FROM shipments s
    LEFT JOIN orders o ON s.order_id = o.id
    LEFT JOIN companies c ON o.company_id = c.id
    LEFT JOIN adresses a ON s.address_id = a.id
    LEFT JOIN contacts ct ON a.contact_id = ct.id
    WHERE s.id = ?
  `).get(req.params.id)

  if (!row) return res.status(404).json({ error: 'Envoi introuvable' })

  const order_items = db.prepare(`
    SELECT oi.*, pr.name_fr as product_name, pr.sku, pr.weight_lbs
    FROM order_items oi
    LEFT JOIN products pr ON oi.product_id = pr.id
    WHERE oi.order_id = ?
    ORDER BY oi.created_at
  `).all(row.order_id)

  res.json({ ...row, order_items })
})

// POST /api/shipments
router.post('/', (req, res) => {
  const { order_id, tracking_number, carrier, status, shipped_at, notes, address_id, pays } = req.body
  if (!order_id) return res.status(400).json({ error: 'order_id est requis' })

  const order = db.prepare('SELECT id FROM orders WHERE id = ?').get(order_id)
  if (!order) return res.status(400).json({ error: 'Commande introuvable' })

  const id = uuidv4()
  db.prepare(`
    INSERT INTO shipments (id, order_id, tracking_number, carrier, status, shipped_at, notes, address_id, pays)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, order_id, tracking_number || null, carrier || null,
    status || 'À envoyer', shipped_at || null, notes || null, address_id || null, pays || null)

  const created = db.prepare(`
    SELECT s.*, o.order_number, o.company_id, c.name as company_name, ${ADDRESS_COLS}
    FROM shipments s
    LEFT JOIN orders o ON s.order_id = o.id
    LEFT JOIN companies c ON o.company_id = c.id
    LEFT JOIN adresses a ON s.address_id = a.id
    LEFT JOIN contacts ct ON a.contact_id = ct.id
    WHERE s.id = ?
  `).get(id)

  res.status(201).json(created)
})

// PATCH /api/shipments/:id
router.patch('/:id', (req, res) => {
  const { tracking_number, carrier, status, shipped_at, notes, address_id, pays } = req.body
  const existing = db.prepare('SELECT id FROM shipments WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Envoi introuvable' })

  db.prepare(`
    UPDATE shipments SET
      tracking_number = COALESCE(?, tracking_number),
      carrier = COALESCE(?, carrier),
      status = COALESCE(?, status),
      shipped_at = COALESCE(?, shipped_at),
      notes = COALESCE(?, notes),
      address_id = CASE WHEN ? THEN ? ELSE address_id END,
      pays = COALESCE(?, pays)
    WHERE id = ?
  `).run(
    tracking_number !== undefined ? tracking_number : null,
    carrier !== undefined ? carrier : null,
    status !== undefined ? status : null,
    shipped_at !== undefined ? shipped_at : null,
    notes !== undefined ? notes : null,
    address_id !== undefined ? 1 : 0, address_id !== undefined ? address_id : null,
    pays !== undefined ? pays : null,
    req.params.id
  )

  // Freeze unit cost on items when shipment is marked as Envoyé
  if (status === 'Envoyé') {
    db.prepare(`
      UPDATE order_items SET shipped_unit_cost = unit_cost
      WHERE shipment_id = ? AND shipped_unit_cost IS NULL
    `).run(req.params.id)
  }

  const updated = db.prepare(`
    SELECT s.*, o.order_number, o.company_id, c.name as company_name, ${ADDRESS_COLS}
    FROM shipments s
    LEFT JOIN orders o ON s.order_id = o.id
    LEFT JOIN companies c ON o.company_id = c.id
    LEFT JOIN adresses a ON s.address_id = a.id
    LEFT JOIN contacts ct ON a.contact_id = ct.id
    WHERE s.id = ?
  `).get(req.params.id)

  res.json(updated)
})

const TRACKING_URLS = {
  purolator:    (n) => `https://www.purolator.com/en/shipping/tracker?pin=${n}`,
  fedex:        (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}`,
  ups:          (n) => `https://www.ups.com/track?tracknum=${n}`,
  canpar:       (n) => `https://www.canpar.com/en/tracking/track.htm?barcode=${n}`,
  'canada post': (n) => `https://www.canadapost-postescanada.ca/track-reperage/en#/search?searchFor=${n}`,
  'postes canada':(n) => `https://www.canadapost-postescanada.ca/track-reperage/fr#/search?searchFor=${n}`,
  gls:           (n) => `https://gls-group.eu/EU/en/parcel-tracking?match=${n}`,
  nationex:      (n) => `https://nationex.com/reperage/${n}`,
}

function getTrackingLink(carrier, trackingNumber) {
  if (!carrier || !trackingNumber) return null
  const key = carrier.toLowerCase()
  for (const [name, fn] of Object.entries(TRACKING_URLS)) {
    if (key.includes(name)) return fn(trackingNumber)
  }
  return null
}

const TRANSLATIONS = {
  fr: {
    subject:        (orderNum) => `Votre commande${orderNum ? ` #${orderNum}` : ''} a été expédiée`,
    greeting:       'Bonjour',
    message:        'Votre commande a été expédiée et est en route vers :',
    warning:        'Veuillez vous assurer que quelqu\'un est disponible pour réceptionner la livraison.',
    trackingMessage:'Vous pouvez suivre votre colis en temps réel ici :',
    carrier:        'Transporteur :',
    tracking:       'N° de suivi :',
    help:           'Des questions ? Répondez directement à ce courriel ou appelez-nous au 888-267-4742',
  },
  en: {
    subject:        (orderNum) => `Your order${orderNum ? ` #${orderNum}` : ''} has been shipped`,
    greeting:       'Hello',
    message:        'Your order has been shipped and is on its way to:',
    warning:        'Please make sure someone is available to receive the delivery.',
    trackingMessage:'You can track your package in real time here:',
    carrier:        'Carrier:',
    tracking:       'Tracking number:',
    help:           'Questions? Reply directly to this email or call us at 888-267-4742',
  },
}

function buildTrackingHtml(t, recipientName, addressLine1, carrier, trackingNumber, trackingLink, trackPixelUrl) {
  const link = trackingLink || '#'
  return `<!DOCTYPE html>
<html>
  <head><meta charset="utf-8"><title>${t.subject('')}</title></head>
  <body style="margin: 0; padding: 0; background-color: #f4f4f4; font-family: Arial, sans-serif;">
    <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color: #f4f4f4;">
      <tr><td align="center">
        <table width="600" border="0" cellspacing="0" cellpadding="0" style="background-color: #ffffff; border-radius: 4px; overflow: hidden;">
          <tr>
            <td align="center" style="padding: 20px; background-color: #ffffff;">
              <img src="https://orisha.us-east-1.linodeobjects.com/logo.png" alt="Logo Orisha" style="max-width: 150px; display: block;">
            </td>
          </tr>
          <tr><td style="background-color: #22b14c; height: 5px; line-height: 5px; font-size: 0;"></td></tr>
          <tr>
            <td style="padding: 20px;">
              <p style="margin: 0 0 10px 0; font-size: 16px; color: #333333;">${t.greeting}${recipientName ? ` ${recipientName}` : ''},</p>
              <br>
              <p style="margin: 0 0 20px 0; font-size: 16px; color: #333333;">${t.message}</p>
              <br>
              <p style="margin: 0 0 20px 0; font-size: 16px; color: #333333;"><strong>${addressLine1 || ''}</strong></p>
              <br>
              <p style="margin: 0 0 20px 0; font-size: 16px; color: #333333;">${t.trackingMessage}</p>
              <br>
              <p style="margin: 0; font-size: 16px; color: #333333;">
                <a href="${link}" style="color: #1a73e8; text-decoration: none;">${link}</a>
              </p>
              <br>
              <p style="margin: 0 0 20px 0; font-size: 16px; color: #333333;">${t.carrier} ${carrier || '—'}</p>
              <p style="margin: 0 0 20px 0; font-size: 16px; color: #333333;">${t.tracking} ${trackingNumber}</p>
            </td>
          </tr>
          <tr>
            <td style="padding: 20px; text-align: center;">
              <p style="margin: 0; font-size: 16px; color: #333333;">${t.help}</p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding: 20px; background-color: #f4f4f4; font-size: 12px; color: #777777;">
              Automatisation Orisha Inc. 1535 ch. Ste-Foy Bureau 220 Québec, QC G1S 2P1
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
    ${trackPixelUrl ? `<img src="${trackPixelUrl}" width="1" height="1" alt="" style="display:none;border:0;width:1px;height:1px">` : ''}
  </body>
</html>`
}

// POST /api/shipments/:id/send-tracking
router.post('/:id/send-tracking', async (req, res) => {
  const started = Date.now()
  const { to } = req.body
  if (!to || !to.includes('@')) return res.status(400).json({ error: 'Adresse courriel invalide' })

  const row = db.prepare(`
    SELECT s.*, o.order_number, o.company_id, c.name as company_name,
           a.contact_id as address_contact_id, a.line1 as address_line1,
           ct.first_name as contact_first_name, ct.last_name as contact_last_name,
           ct.language as contact_language
    FROM shipments s
    LEFT JOIN orders o ON s.order_id = o.id
    LEFT JOIN companies c ON o.company_id = c.id
    LEFT JOIN adresses a ON s.address_id = a.id
    LEFT JOIN contacts ct ON a.contact_id = ct.id
    WHERE s.id = ?
  `).get(req.params.id)

  if (!row) return res.status(404).json({ error: 'Envoi introuvable' })
  if (!row.tracking_number) return res.status(400).json({ error: 'Aucun numéro de suivi sur cet envoi' })

  const lang = (row.contact_language || '').toLowerCase().startsWith('en') ? 'en' : 'fr'
  const t = TRANSLATIONS[lang]
  const recipientName = row.contact_first_name || ''
  const trackingLink = getTrackingLink(row.carrier, row.tracking_number)
  const subject = t.subject(row.order_number)
  const emailId = uuidv4()
  const trackPixelUrl = `${process.env.APP_URL || 'https://customer.orisha.io'}/erp/api/track/email/${emailId}.gif`
  const html = buildTrackingHtml(t, recipientName, row.address_line1, row.carrier, row.tracking_number, trackingLink, trackPixelUrl)

  try {
    const fromAddress = getAutomationFrom('sys_shipment_tracking_email')
    if (!fromAddress) throw new Error('Adresse expéditeur Postmark non configurée')
    const client = new postmark.ServerClient(process.env.POSTMARK_API_KEY)
    await client.sendEmail({
      From: fromAddress,
      To: to,
      Subject: subject,
      HtmlBody: html,
    })

    // Logger l'interaction
    const interactionId = uuidv4()
    db.prepare(`
      INSERT INTO interactions (id, contact_id, company_id, type, direction, timestamp)
      VALUES (?, ?, ?, 'email', 'out', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).run(interactionId, row.address_contact_id || null, row.company_id || null)
    db.prepare(`
      INSERT INTO emails (id, interaction_id, subject, body_html, from_address, to_address, automated)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(emailId, interactionId, subject, html, fromAddress, to)

    db.prepare(`
      UPDATE shipments SET
        tracking_email_sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        tracking_email_interaction_id = ?,
        tracking_email_contact_id = ?
      WHERE id = ?
    `).run(interactionId, row.address_contact_id || null, req.params.id)

    const appUrl = (process.env.APP_URL || 'https://customer.orisha.io').replace(/\/$/, '')
    const nowIso = new Date().toISOString()
    logSystemRun('sys_shipment_tracking_email', {
      status: 'success',
      result: [
        `Email de suivi envoyé`,
        `  De : ${fromAddress}`,
        `  À : ${to}`,
        `  Sujet : ${subject}`,
        `  Langue : ${lang}`,
        `  Transporteur : ${row.carrier || 'N/A'} — ${row.tracking_number}`,
        '',
        `Envoi : ${row.order_number || req.params.id}`,
        `${appUrl}/erp/envois/${req.params.id}`,
        '',
        `Changements (shipments) :`,
        `  • tracking_email_sent_at: ∅ → ${nowIso}`,
        `  • tracking_email_interaction_id: ∅ → ${interactionId}`,
        `  • tracking_email_contact_id: ∅ → ${row.address_contact_id || '∅'}`,
        '',
        `Interaction créée : ${interactionId} (emails.id = ${emailId}, pixel de tracking actif)`,
      ].join('\n'),
      duration_ms: Date.now() - started,
      triggerData: { shipment_id: req.params.id, to, interaction_id: interactionId, email_id: emailId },
    })
    res.json({ success: true, interaction_id: interactionId, contact_id: row.address_contact_id || null })
  } catch (e) {
    logSystemRun('sys_shipment_tracking_email', {
      status: 'error',
      error: e.message,
      duration_ms: Date.now() - started,
      triggerData: { shipment_id: req.params.id, to },
    })
    res.status(500).json({ error: e.message })
  }
})

// POST /api/shipments/:id/bon-livraison
router.post('/:id/bon-livraison', async (req, res) => {
  const shipment = db.prepare(`
    SELECT s.*, o.order_number, o.id as order_id, o.date_commande,
           c.name as company_name,
           a.line1 as address_line1, a.city as address_city,
           a.province as address_province, a.postal_code as address_postal_code, a.country as address_country,
           ct.first_name as contact_first_name, ct.last_name as contact_last_name, ct.language as contact_language
    FROM shipments s
    LEFT JOIN orders o ON s.order_id = o.id
    LEFT JOIN companies c ON o.company_id = c.id
    LEFT JOIN adresses a ON s.address_id = a.id
    LEFT JOIN contacts ct ON a.contact_id = ct.id
    WHERE s.id = ?
  `).get(req.params.id)
  if (!shipment) return res.status(404).json({ error: 'Envoi introuvable' })

  // Items linked to this shipment explicitly (exclude JWT type)
  let shipmentItems = db.prepare(`
    SELECT oi.*, pr.name_fr as product_name_fr, pr.name_en as product_name_en, pr.sku, pr.image_url
    FROM order_items oi
    LEFT JOIN products pr ON oi.product_id = pr.id
    WHERE oi.shipment_id = ? AND oi.order_id = ? AND (pr.type IS NULL OR pr.type != 'JWT')
    ORDER BY oi.created_at
  `).all(req.params.id, shipment.order_id)

  // Fallback: if no items linked, use all order items (shipment_id not yet set)
  if (shipmentItems.length === 0) {
    shipmentItems = db.prepare(`
      SELECT oi.*, pr.name_fr as product_name_fr, pr.name_en as product_name_en, pr.sku, pr.image_url
      FROM order_items oi
      LEFT JOIN products pr ON oi.product_id = pr.id
      WHERE oi.order_id = ? AND (pr.type IS NULL OR pr.type != 'JWT')
      ORDER BY oi.created_at
    `).all(shipment.order_id)
  }

  // Other items in the same order (not in this shipment) — only when shipment_id is used
  const otherItems = db.prepare(`
    SELECT oi.*, pr.name_fr as product_name_fr, pr.name_en as product_name_en, pr.sku,
           s2.id as other_shipment_id, s2.tracking_number as other_tracking,
           s2.status as other_status
    FROM order_items oi
    LEFT JOIN products pr ON oi.product_id = pr.id
    LEFT JOIN shipments s2 ON oi.shipment_id = s2.id
    WHERE oi.order_id = ? AND oi.shipment_id IS NOT NULL AND oi.shipment_id != ?
      AND (pr.type IS NULL OR pr.type != 'JWT')
    ORDER BY oi.created_at
  `).all(shipment.order_id, req.params.id)

  const contactLang = (shipment.contact_language || '').toLowerCase().startsWith('en') ? 'en' : 'fr'

  const uploadsDir = path.resolve(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'bons-livraison')
  if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true })

  const filename = `bon-livraison-envoi-${shipment.order_number}-${Date.now()}.pdf`
  const filepath = path.join(uploadsDir, filename)
  const uploadsRoot = path.resolve(process.cwd(), process.env.UPLOADS_PATH || 'uploads')

  // Fetch Orisha logo
  let logoBuffer = null
  try {
    const logoRes = await fetch('https://orisha.us-east-1.linodeobjects.com/logo.png')
    if (logoRes.ok) logoBuffer = Buffer.from(await logoRes.arrayBuffer())
  } catch {}

  // Helper to load image buffer for a product image_url — converts to PNG via sharp
  async function getImageBuffer(imageUrl) {
    if (!imageUrl) return null
    try {
      if (imageUrl.startsWith('/erp/api/product-images/') || imageUrl.startsWith('/api/product-images/')) {
        const fname = imageUrl.split('/').pop()
        const imgPath = path.join(uploadsRoot, 'products', fname)
        if (!fs.existsSync(imgPath) || imgPath.endsWith('.svg')) return null
        return await sharp(imgPath).png().toBuffer()
      }
    } catch {}
    return null
  }

  const PDF_LABELS = {
    fr: {
      deliveryNote:  'BON DE LIVRAISON',
      orderNum:      (n) => `Commande #${n}`,
      orderDate:     (d) => `Date de commande : ${d}`,
      deliverTo:     'LIVRER À',
      carrier:       'Transporteur :',
      tracking:      'N° de suivi :',
      contents:      'CONTENU DE CET ENVOI',
      product:       'PRODUIT',
      qty:           'QTÉ',
      tested:        'TESTÉ',
      otherItems:    'AUTRES ARTICLES DE LA COMMANDE',
      status:        'STATUT',
      alreadySent:   (t) => `Déjà envoyé${t ? ` (${t})` : ''}`,
      inOtherShip:   'Dans un autre envoi',
      toSend:        'À envoyer',
      noItems:       'Aucun article associé à cet envoi.',
      responsible:   'Responsable de production',
    },
    en: {
      deliveryNote:  'DELIVERY NOTE',
      orderNum:      (n) => `Order #${n}`,
      orderDate:     (d) => `Order date: ${d}`,
      deliverTo:     'SHIP TO',
      carrier:       'Carrier:',
      tracking:      'Tracking #:',
      contents:      'CONTENTS OF THIS SHIPMENT',
      product:       'PRODUCT',
      qty:           'QTY',
      tested:        'TESTED',
      otherItems:    'OTHER ITEMS IN THIS ORDER',
      status:        'STATUS',
      alreadySent:   (t) => `Already shipped${t ? ` (${t})` : ''}`,
      inOtherShip:   'In another shipment',
      toSend:        'Pending shipment',
      noItems:       'No items linked to this shipment.',
      responsible:   'Production manager',
    },
  }

  function drawCopy(doc, copyLabel, lang = 'fr', imageBuffers = new Map()) {
    const L = PDF_LABELS[lang] || PDF_LABELS.fr
    const pageWidth = doc.page.width - 100
    const M = 50 // left margin

    // ── Orisha logo ──────────────────────────────────────────────────────────
    if (logoBuffer) {
      doc.image(logoBuffer, M, 42, { height: 42, fit: [150, 42] })
    } else {
      doc.rect(M, 45, 110, 36).fill('#22b14c')
      doc.fillColor('#ffffff').fontSize(18).font('Helvetica-Bold')
        .text('ORISHA', M + 8, 54, { width: 94, align: 'center' })
    }

    // ── Copy label (top right) ───────────────────────────────────────────────
    doc.fillColor('#555555').fontSize(9).font('Helvetica-Bold')
      .text(copyLabel, M + pageWidth - 110, 45, { width: 110, align: 'right' })

    // ── Title ────────────────────────────────────────────────────────────────
    const dateLocale = lang === 'en' ? 'en-CA' : 'fr-CA'
    doc.fillColor('#111111').fontSize(20).font('Helvetica-Bold')
      .text(L.deliveryNote, M + 120, 50, { width: pageWidth - 120 })
    doc.fillColor('#555555').fontSize(10).font('Helvetica')
      .text(L.orderNum(shipment.order_number), M + 120, 73)

    if (shipment.date_commande) {
      const cmdDate = new Date(shipment.date_commande).toLocaleDateString(dateLocale, { year: 'numeric', month: 'long', day: 'numeric' })
      doc.text(L.orderDate(cmdDate), M + 120, 86)
    }

    // ── Divider ──────────────────────────────────────────────────────────────
    doc.moveTo(M, 95).lineTo(M + pageWidth, 95).strokeColor('#22b14c').lineWidth(2).stroke()

    // ── Delivery address ─────────────────────────────────────────────────────
    let addrY = 108
    doc.fillColor('#22b14c').fontSize(9).font('Helvetica-Bold').text(L.deliverTo, M, addrY)
    addrY += 13
    doc.fillColor('#111111').fontSize(11).font('Helvetica-Bold')
    if (shipment.company_name) { doc.text(shipment.company_name, M, addrY); addrY += 14 }
    if (shipment.contact_first_name || shipment.contact_last_name) {
      doc.font('Helvetica').fillColor('#333333')
        .text([shipment.contact_first_name, shipment.contact_last_name].filter(Boolean).join(' '), M, addrY)
      addrY += 14
    }
    doc.font('Helvetica').fillColor('#333333').fontSize(10)
    if (shipment.address_line1) { doc.text(shipment.address_line1, M, addrY); addrY += 13 }
    if (shipment.carrier || shipment.tracking_number) {
      doc.fillColor('#555555').fontSize(9)
      if (shipment.carrier) { doc.text(`${L.carrier} ${shipment.carrier}`, M, addrY); addrY += 12 }
      if (shipment.tracking_number) { doc.text(`${L.tracking} ${shipment.tracking_number}`, M, addrY); addrY += 12 }
    }

    // ── Section: Contenu de cet envoi ────────────────────────────────────────
    const sectionY = Math.max(addrY + 8, 175)
    doc.moveTo(M, sectionY).lineTo(M + pageWidth, sectionY).strokeColor('#cccccc').lineWidth(1).stroke()
    doc.fillColor('#111111').fontSize(11).font('Helvetica-Bold')
      .text(L.contents, M, sectionY + 8)
    doc.moveTo(M, sectionY + 24).lineTo(M + pageWidth, sectionY + 24).strokeColor('#eeeeee').lineWidth(0.5).stroke()

    // Table header
    const col = { img: M, name: M + 50, qty: M + pageWidth * 0.75, tested: M + pageWidth * 0.87, status: M + pageWidth * 0.83 }
    let rowY = sectionY + 32
    doc.fillColor('#888888').fontSize(8).font('Helvetica-Bold')
    doc.text(L.product, col.name, rowY)
    doc.text(L.qty, col.qty, rowY)
    doc.text(L.tested, col.tested, rowY)
    rowY += 14

    doc.font('Helvetica').fontSize(10).fillColor('#222222')
    for (const item of shipmentItems) {
      if (rowY > doc.page.height - 220) { doc.addPage(); rowY = 50 }

      // Product image
      const imgBuf = imageBuffers.get(item.image_url) || null
      if (imgBuf) {
        try {
          doc.image(imgBuf, col.img, rowY - 2, { width: 40, height: 40, fit: [40, 40] })
        } catch {}
      }

      const productName = (lang === 'en' && item.product_name_en) ? item.product_name_en : (item.product_name_fr || '—')
      const nameWidth = col.qty - col.name - 10
      doc.fillColor('#111111').font('Helvetica-Bold').fontSize(10)
        .text(productName, col.name, rowY, { width: nameWidth, ellipsis: true })
      doc.fillColor('#111111').font('Helvetica-Bold').fontSize(11)
        .text(String(item.qty ?? '—'), col.qty, rowY, { width: 30 })

      // Checked checkbox
      const cbSize = 10
      const cbX = col.tested
      const cbY = rowY + 1
      doc.rect(cbX, cbY, cbSize, cbSize).strokeColor('#333333').lineWidth(0.8).stroke()
      doc.moveTo(cbX + 2, cbY + 5).lineTo(cbX + 4, cbY + 8).lineTo(cbX + 9, cbY + 2)
        .strokeColor('#22b14c').lineWidth(1.5).stroke()

      const lineH = imgBuf ? 44 : 18
      rowY += lineH
      doc.moveTo(M, rowY - 4).lineTo(M + pageWidth, rowY - 4).strokeColor('#eeeeee').lineWidth(0.5).stroke()
    }

    if (shipmentItems.length === 0) {
      doc.fillColor('#999999').fontSize(10).font('Helvetica')
        .text(L.noItems, col.name, rowY)
      rowY += 18
    }

    // ── Section: Autres articles de la commande ──────────────────────────────
    if (otherItems.length > 0) {
      rowY += 10
      if (rowY > doc.page.height - 180) { doc.addPage(); rowY = 50 }
      doc.moveTo(M, rowY).lineTo(M + pageWidth, rowY).strokeColor('#cccccc').lineWidth(1).stroke()
      doc.fillColor('#555555').fontSize(11).font('Helvetica-Bold')
        .text(L.otherItems, M, rowY + 8)
      doc.moveTo(M, rowY + 24).lineTo(M + pageWidth, rowY + 24).strokeColor('#eeeeee').lineWidth(0.5).stroke()

      rowY += 32
      doc.fillColor('#888888').fontSize(8).font('Helvetica-Bold')
      doc.text(L.product, col.name, rowY)
      doc.text(L.qty, col.qty, rowY)
      doc.text(L.status, col.status, rowY)
      rowY += 14

      for (const item of otherItems) {
        if (rowY > doc.page.height - 120) { doc.addPage(); rowY = 50 }

        const otherName = (lang === 'en' && item.product_name_en) ? item.product_name_en : (item.product_name_fr || '—')
        const nameWidth = col.qty - col.name - 10
        doc.fillColor('#555555').font('Helvetica').fontSize(9)
          .text(otherName, col.name, rowY, { width: nameWidth, ellipsis: true })
        doc.text(String(item.qty ?? '—'), col.qty, rowY, { width: 30 })

        let statusText, statusColor
        if (item.other_shipment_id && item.other_status === 'Envoyé') {
          statusText = L.alreadySent(item.other_tracking)
          statusColor = '#22b14c'
        } else if (item.other_shipment_id) {
          statusText = L.inOtherShip
          statusColor = '#3b82f6'
        } else {
          statusText = L.toSend
          statusColor = '#f59e0b'
        }
        doc.fillColor(statusColor).font('Helvetica-Bold').fontSize(8)
          .text(statusText, col.status, rowY, { width: pageWidth - (col.status - M) })

        rowY += 18
        doc.moveTo(M, rowY - 4).lineTo(M + pageWidth, rowY - 4).strokeColor('#eeeeee').lineWidth(0.5).stroke()
      }
    }

    // ── Signature — fixed absolute position at page bottom ───────────────────
    const footerY = doc.page.height - 30
    const sigLineY = footerY - 35
    const sigRight = M + pageWidth - 220
    doc.moveTo(sigRight, sigLineY).lineTo(M + pageWidth, sigLineY).strokeColor('#333333').lineWidth(0.8).stroke()
    doc.fillColor('#888888').fontSize(8).font('Helvetica')
      .text(L.responsible, sigRight, sigLineY + 4, { lineBreak: false })
  }

  // Pre-fetch all product images (async, before sync PDF rendering)
  const imageBuffers = new Map()
  for (const item of shipmentItems) {
    if (item.image_url && !imageBuffers.has(item.image_url)) {
      imageBuffers.set(item.image_url, await getImageBuffer(item.image_url))
    }
  }

  await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: 50, left: 50, right: 50, bottom: 10 }, autoFirstPage: true })
    const stream = fs.createWriteStream(filepath)
    doc.pipe(stream)
    stream.on('finish', resolve)
    stream.on('error', reject)

    const clientLabel = contactLang === 'en' ? 'CLIENT COPY' : 'COPIE CLIENT'
    const orishaLabel = contactLang === 'en' ? 'ORISHA COPY' : 'COPIE ORISHA'
    drawCopy(doc, clientLabel, contactLang, imageBuffers)
    doc.addPage()
    drawCopy(doc, orishaLabel, 'fr', imageBuffers)

    doc.end()
  })

  const relPath = `bons-livraison/${filename}`
  db.prepare(`UPDATE shipments SET bon_livraison_path = ? WHERE id = ?`)
    .run(relPath, req.params.id)

  res.json({ bon_livraison_path: relPath, url: `/api/bons-livraison/${filename}` })
})

// DELETE /api/shipments/:id
router.delete('/:id', (req, res) => {
  const existing = db.prepare('SELECT id FROM shipments WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Envoi introuvable' })

  db.prepare("UPDATE shipments SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?").run(req.params.id)
  res.json({ success: true })
})

export default router
