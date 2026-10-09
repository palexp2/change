import { Router } from 'express'
import { newRecordId } from '../utils/recordId.js'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import PDFDocument from 'pdfkit'
import { emitEntity } from '../services/realtimeEmitters.js'
import { uploadsPath, ensureUploadsDir } from '../config/uploads.js'
import { parsePage } from '../utils/pagination.js'
import { buildSoumissionHtml, renderSoumissionPdf } from '../services/soumissionPdf.js'
import { sendEmail as sendGmail } from '../services/gmail.js'
import { mirrorSoumissionPdf } from '../services/airtable.js'
import { discountLines, soumissionDiscounts, storeSoumissionTotals } from '../services/soumissionTotals.js'
import { recomputeProjectValeurCad } from '../services/projectValeur.js'
import { getStripeClient, syncStripeCustomer } from '../services/stripeInvoices.js'
import { assertStripeCurrency, stripeCurrencyOf } from '../services/stripeCustomerCompany.js'
import { trackEmailHtml } from '../services/emailTracking.js'

// Prix achat / abo de la soumission (colonnes des listes), puis la valeur du
// projet qui en découle.
function syncSoumissionTotals(id) {
  storeSoumissionTotals(db, id)
  const projectId = db.prepare('SELECT project_id FROM soumissions WHERE id = ?').get(id)?.project_id
  if (projectId) recomputeProjectValeurCad(projectId).catch(e => console.error('[valeur_cad_calc]', projectId, e.message))
}

// Numéro QTE-n : séquentiel, unique, jamais réattribué après suppression.
// Part de 1000 pour ne pas croiser les QTE-n d'Airtable (~300 en 2026-09).
// `peek` = le prochain numéro sans le réserver (aperçu du PDF).
const QUOTE_FIRST = 1000
function nextQuoteNumber({ peek = false } = {}) {
  const seq = db.prepare(`SELECT value FROM sequences WHERE name = 'quote'`).get()?.value || 0
  const max = db.prepare('SELECT COALESCE(MAX(quote_number), 0) AS m FROM soumissions').get().m
  const n = Math.max(seq, max, QUOTE_FIRST - 1) + 1
  if (!peek) db.prepare(`INSERT INTO sequences (name, value) VALUES ('quote', ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value`).run(n)
  return n
}
const quoteTitle = n => `QTE-${n}`

// Reuse the LIST query shape so realtime payload matches what the
// soumissions list page consumes (Soumissions.jsx).
const SOUMISSION_LIST_SELECT = `
  SELECT s.*,
    p.name as project_name,
    co.name as company_name,
    c.first_name || ' ' || c.last_name as contact_name,
    se.first_opened_at as sent_opened_at,
    (SELECT MAX(o.opened_at) FROM email_opens o WHERE o.email_id = s.sent_email_id) as sent_last_opened_at
  FROM soumissions s
  LEFT JOIN projects p ON s.project_id = p.id
  LEFT JOIN companies co ON s.company_id = co.id
  LEFT JOIN contacts c ON s.contact_id = c.id
  LEFT JOIN emails se ON se.id = s.sent_email_id
  WHERE s.id = ?
`

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const router = Router()
router.use(requireAuth)

// ── Helpers ───────────────────────────────────────────────────────────────────

function uploadsDir() {
  return ensureUploadsDir('documents')
}

function fmtPrice(n, currency = 'CAD') {
  if (n == null) return currency === 'USD' ? '$0.00' : '0,00 $'
  return new Intl.NumberFormat(currency === 'USD' ? 'en-US' : 'fr-CA', { style: 'currency', currency }).format(n)
}

function fmtDate(d, lang = 'French') {
  if (!d) return '—'
  const locale = lang === 'English' ? 'en-CA' : 'fr-CA'
  return new Date(d).toLocaleDateString(locale, { year: 'numeric', month: 'long', day: 'numeric' })
}

// Rabais nommés d'une soumission. Chacun retire `pct` % des deux colonnes
// (Service = mensuel, Achat = prix fixe) plus des montants fixes par colonne.
// Sans liste (soumissions d'avant), le rabais global unique en tient lieu.
// `until` (AAAA-MM-JJ, facultatif) : fin d'application du rabais.
// `pct_purchase` : % propre à l'Achat (absent : `pct`, ou 0 si `only: 'monthly'`,
// le % ne touchant alors que l'abonnement — ex. Head start plan) ;
// `preset` : rabais standard coché dans l'éditeur.
function sanitizeDiscounts(list) {
  if (!Array.isArray(list)) return null
  const n = v => Math.max(0, parseFloat(v) || 0)
  const day = v => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined)
  return list
    .map(d => ({
      name: String(d?.name || '').trim() || 'Rabais', pct: Math.min(100, n(d?.pct)), monthly: n(d?.monthly), amount: n(d?.amount), until: day(d?.until),
      pct_purchase: d?.pct_purchase == null || d.pct_purchase === '' ? undefined : Math.min(100, n(d.pct_purchase)),
      only: d?.only === 'monthly' ? 'monthly' : undefined, preset: typeof d?.preset === 'string' ? d.preset : undefined,
    }))
    .filter(d => d.pct || d.pct_purchase || d.monthly || d.amount)
}
function discountTotals(discounts, monthlyBase, purchaseBase) {
  const lines = discountLines(discounts, monthlyBase, purchaseBase)
    .map(l => ({ name: l.name, until: l.until, monthly: l.monthly, amount: l.amount }))
  const sum = k => lines.reduce((t, l) => t + l[k], 0)
  return { lines, monthly: Math.max(0, monthlyBase - sum('monthly')), amount: Math.max(0, purchaseBase - sum('amount')) }
}

// ── PDF generation ────────────────────────────────────────────────────────────

// PDF client (gabarit de l'ancien outil, imprimé par Chromium). Sans Chromium
// ou en cas d'échec, repli sur l'ancien rendu pdfkit : jamais de soumission
// sans PDF.
async function generateSoumissionPdf(soumission, items, company, contact, tenant) {
  try {
    const html = buildSoumissionHtml({ soumission, items, discounts: soumissionDiscounts(soumission), company, contact, mode: 'file' })
    const filepath = path.join(uploadsDir(), `soumission-${soumission.id}.pdf`)
    fs.writeFileSync(filepath, await renderSoumissionPdf(html))
    return filepath
  } catch (e) {
    console.error('[soumission] rendu Chromium échoué, repli pdfkit :', e.message)
    return generateSoumissionPdfLegacy(soumission, items, company, contact, tenant)
  }
}

async function generateSoumissionPdfLegacy(soumission, items, company, contact, tenant) {
  return new Promise((resolve, reject) => {
    const lang = soumission.language === 'English' ? 'English' : 'French'
    const isFr = lang !== 'English'
    const currency = soumission.currency || 'CAD'
    const fmt = (n) => fmtPrice(n, currency)

    const dir = uploadsDir()
    const filename = `soumission-${soumission.id}.pdf`
    const filepath = path.join(dir, filename)

    const doc = new PDFDocument({ size: 'LETTER', margin: 50 })
    const stream = fs.createWriteStream(filepath)
    doc.pipe(stream)

    // Colors
    const INDIGO = '#4f46e5'
    const SLATE = '#1e293b'
    const GRAY = '#64748b'
    const LIGHT = '#f1f5f9'
    const WHITE = '#ffffff'
    const LINE = '#e2e8f0'

    // ── Header bar ────────────────────────────────────────────────────────────
    doc.rect(50, 50, doc.page.width - 100, 70).fill(INDIGO)

    doc.fillColor(WHITE).fontSize(22).font('Helvetica-Bold')
       .text(isFr ? 'SOUMISSION' : 'QUOTE', 70, 68)

    const docNum = soumission.document_number || soumission.id.slice(0, 8).toUpperCase()
    doc.fontSize(10).font('Helvetica').fillColor('#c7d2fe')
       .text(`#${docNum}`, 70, 94)

    // Date in top-right
    doc.fontSize(9).fillColor(WHITE)
       .text(isFr ? `Date : ${fmtDate(soumission.created_at, lang)}` : `Date: ${fmtDate(soumission.created_at, lang)}`,
             doc.page.width - 250, 68, { width: 200, align: 'right' })

    if (soumission.expiration_date) {
      doc.text(isFr ? `Expiration : ${fmtDate(soumission.expiration_date, lang)}` : `Expires: ${fmtDate(soumission.expiration_date, lang)}`,
               doc.page.width - 250, 84, { width: 200, align: 'right' })
    }

    // Title below header
    let y = 138
    if (soumission.title) {
      doc.fillColor(SLATE).fontSize(14).font('Helvetica-Bold')
         .text(soumission.title, 50, y)
      y += 24
    }

    // ── FROM / TO blocks ──────────────────────────────────────────────────────
    y += 8
    const colW = (doc.page.width - 100) / 2 - 10

    // FROM (Orisha / tenant)
    doc.fillColor(GRAY).fontSize(8).font('Helvetica-Bold')
       .text(isFr ? 'DE' : 'FROM', 50, y)
    doc.fillColor(SLATE).fontSize(10).font('Helvetica-Bold')
       .text(tenant?.name || 'Orisha', 50, y + 12)
    doc.font('Helvetica').fontSize(9).fillColor(GRAY)
       .text('orisha.ag', 50, y + 26)

    // TO (client company)
    if (company) {
      doc.fillColor(GRAY).fontSize(8).font('Helvetica-Bold')
         .text(isFr ? 'À' : 'TO', 50 + colW + 20, y)
      doc.fillColor(SLATE).fontSize(10).font('Helvetica-Bold')
         .text(company.name, 50 + colW + 20, y + 12)
      if (contact) {
        const contactName = [contact.first_name, contact.last_name].filter(Boolean).join(' ')
        doc.font('Helvetica').fontSize(9).fillColor(GRAY)
           .text(contactName, 50 + colW + 20, y + 26)
        if (contact.email) {
          doc.text(contact.email, 50 + colW + 20, y + 38)
        }
      }
      if (company.city || company.province) {
        const addr = [company.city, company.province].filter(Boolean).join(', ')
        doc.font('Helvetica').fontSize(9).fillColor(GRAY)
           .text(addr, 50 + colW + 20, y + 50)
      }
    }

    y += 80

    // ── Divider ───────────────────────────────────────────────────────────────
    doc.moveTo(50, y).lineTo(doc.page.width - 50, y).strokeColor(LINE).lineWidth(1).stroke()
    y += 16

    // ── Items table ───────────────────────────────────────────────────────────
    const COL = {
      desc: { x: 50, w: 250 },
      qty:  { x: 300, w: 40 },
      month:{ x: 340, w: 70 },
      unit: { x: 410, w: 70 },
      total:{ x: 480, w: 70 },
    }

    // Table header
    doc.rect(50, y, doc.page.width - 100, 22).fill(LIGHT)
    doc.fillColor(GRAY).fontSize(8).font('Helvetica-Bold')
    doc.text(isFr ? 'DESCRIPTION' : 'DESCRIPTION', COL.desc.x + 4, y + 7)
    doc.text(isFr ? 'QTÉ' : 'QTY', COL.qty.x, y + 7, { width: COL.qty.w, align: 'center' })
    doc.text(isFr ? '$/MOIS' : '$/MONTH', COL.month.x, y + 7, { width: COL.month.w, align: 'right' })
    doc.text(isFr ? `PRIX (${currency})` : `PRICE (${currency})`, COL.unit.x, y + 7, { width: COL.unit.w, align: 'right' })
    doc.text(isFr ? 'TOTAL' : 'TOTAL', COL.total.x, y + 7, { width: COL.total.w, align: 'right' })
    y += 22

    // Items
    let subtotal = 0
    let monthlyTotal = 0
    let currentGroup
    for (const item of items) {
      // Lignes rangées par serre : un bandeau à chaque changement de groupe.
      if (item.group_name && item.group_name !== currentGroup) {
        if (y > doc.page.height - 120) { doc.addPage(); y = 50 }
        doc.rect(50, y, doc.page.width - 100, 22).fill('#dbeafe')
        doc.fillColor(SLATE).fontSize(9.5).font('Helvetica-Bold')
           .text(item.group_name, COL.desc.x + 4, y + 7, { width: COL.desc.w, lineBreak: false })
        y += 22
      }
      currentGroup = item.group_name
      if (y > doc.page.height - 120) { doc.addPage(); y = 50 }
      const monthly = (item.qty || 1) * (item.unit_monthly_price || 0)
      monthlyTotal += monthly
      const name = isFr
        ? (item.description_fr || item.name_fr || '')
        : (item.description_en || item.name_en || '')
      const lineTotal = (item.qty || 1) * (item.unit_price_cad || 0)
      subtotal += lineTotal

      const rowH = 28
      doc.rect(50, y, doc.page.width - 100, rowH).fill(WHITE).strokeColor(LINE).lineWidth(0.5).stroke()
      doc.fillColor(SLATE).fontSize(9.5).font('Helvetica')
         .text(name, COL.desc.x + 4, y + 8, { width: COL.desc.w - 8, lineBreak: false })
      doc.text(String(item.qty || 1), COL.qty.x, y + 8, { width: COL.qty.w, align: 'center' })
      doc.text(monthly ? fmt(monthly) : '—', COL.month.x, y + 8, { width: COL.month.w, align: 'right' })
      doc.text(fmt(item.unit_price_cad || 0), COL.unit.x, y + 8, { width: COL.unit.w, align: 'right' })
      doc.text(fmt(lineTotal), COL.total.x, y + 8, { width: COL.total.w, align: 'right' })
      y += rowH
    }

    if (items.length === 0) {
      doc.fillColor(GRAY).fontSize(9).font('Helvetica')
         .text(isFr ? 'Aucun article' : 'No items', 50, y + 10)
      y += 30
    }

    y += 10

    // ── Totals : Service (mensuel) | Achat, un rabais nommé par ligne ─────────
    const totalW = 280
    const totalX = doc.page.width - 50 - totalW
    const tColW = 80
    const svcX = totalX + totalW - 2 * tColW
    const buyX = totalX + totalW - tColW
    const totals = discountTotals(soumissionDiscounts(soumission), monthlyTotal, subtotal)
    if (y > doc.page.height - 160 - 18 * totals.lines.length) { doc.addPage(); y = 50 }

    doc.fillColor(SLATE).fontSize(9).font('Helvetica-Bold')
    doc.text(isFr ? 'Service' : 'Service', svcX, y, { width: tColW, align: 'right' })
    doc.text(isFr ? 'Achat' : 'Purchase', buyX, y, { width: tColW, align: 'right' })
    y += 16
    const totalRow = (label, monthly, amount, color, bold) => {
      doc.fillColor(color).fontSize(9).font(bold ? 'Helvetica-Bold' : 'Helvetica')
      doc.text(label, totalX, y, { width: totalW - 2 * tColW - 8 })
      doc.text(monthly, svcX, y, { width: tColW, align: 'right' })
      doc.text(amount, buyX, y, { width: tColW, align: 'right' })
      y += Math.max(16, doc.heightOfString(label, { width: totalW - 2 * tColW - 8 }) + 4)
    }
    totalRow(isFr ? 'Prix du système' : 'System price', fmt(monthlyTotal), fmt(subtotal), SLATE)
    const off = n => (n ? `-${fmt(n)}` : '—')
    const until = l => (l.until ? ` (${isFr ? 'jusqu’au' : 'until'} ${fmtDate(`${l.until}T12:00:00`, lang)})` : '')
    for (const l of totals.lines) totalRow(`${l.name}${until(l)}`, off(l.monthly), off(l.amount), '#be123c')
    doc.moveTo(totalX, y).lineTo(doc.page.width - 50, y).strokeColor(LINE).lineWidth(1).stroke()
    y += 6

    // Grand total box
    doc.rect(totalX, y, totalW, 28).fill(INDIGO)
    doc.fillColor(WHITE).fontSize(11).font('Helvetica-Bold')
       .text(isFr ? 'Total' : 'Total', totalX + 8, y + 8, { width: totalW - 2 * tColW - 16 })
    doc.text(`${fmt(totals.monthly)}${isFr ? '/mois' : '/mo'}`, svcX - 20, y + 8, { width: tColW + 20, align: 'right' })
    doc.text(fmt(totals.amount), buyX, y + 8, { width: tColW - 6, align: 'right' })
    y += 34
    doc.fillColor(GRAY).fontSize(8).font('Helvetica')
       .text(isFr ? '* Taxes non incluses' : '* Taxes not included', totalX, y)
    y += 20

    // ── Notes ─────────────────────────────────────────────────────────────────
    if (soumission.notes) {
      y += 8
      doc.fillColor(GRAY).fontSize(8).font('Helvetica-Bold')
         .text(isFr ? 'NOTES' : 'NOTES', 50, y)
      y += 12
      doc.fillColor(SLATE).fontSize(9).font('Helvetica')
         .text(soumission.notes, 50, y, { width: doc.page.width - 100 })
      y += doc.heightOfString(soumission.notes, { width: doc.page.width - 100 }) + 8
    }

    // ── Footer ────────────────────────────────────────────────────────────────
    const footerY = doc.page.height - 60
    doc.moveTo(50, footerY).lineTo(doc.page.width - 50, footerY).strokeColor(LINE).lineWidth(0.5).stroke()
    doc.fillColor(GRAY).fontSize(8).font('Helvetica')
       .text('orisha.ag  |  info@orisha.ag', 50, footerY + 10, { width: doc.page.width - 100, align: 'center' })

    doc.end()

    stream.on('finish', () => resolve(filepath))
    stream.on('error', reject)
  })
}

// ── Soumissions ───────────────────────────────────────────────────────────────

router.get('/soumissions', (req, res) => {
  const { company_id, project_id, status } = req.query
  const { page, limit, limitVal, offset } = parsePage(req.query, 50)
  let where = 'WHERE 1=1'
  const params = []
  if (company_id) { where += ' AND s.company_id = ?'; params.push(company_id) }
  if (project_id) { where += ' AND s.project_id = ?'; params.push(project_id) }
  if (status) { where += ' AND s.status = ?'; params.push(status) }

  const total = db.prepare(`SELECT COUNT(*) as c FROM soumissions s ${where}`).get(...params).c
  const rows = db.prepare(`
    SELECT s.*,
      p.name as project_name,
      co.name as company_name,
      c.first_name || ' ' || c.last_name as contact_name
    FROM soumissions s
    LEFT JOIN projects p ON s.project_id = p.id
    LEFT JOIN companies co ON s.company_id = co.id
    LEFT JOIN contacts c ON s.contact_id = c.id
    ${where}
    ORDER BY s.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limitVal, offset)

  res.json({ data: rows, total, page: parseInt(page), limit: parseInt(limit) })
})

router.get('/soumissions/:id', (req, res) => {
  const row = db.prepare(`
    SELECT s.*,
      p.name as project_name,
      co.name as company_name, co.city as company_city, co.province as company_province,
      c.first_name || ' ' || c.last_name as contact_name,
      c.email as contact_email,
      se.first_opened_at as sent_opened_at,
      (SELECT MAX(o.opened_at) FROM email_opens o WHERE o.email_id = s.sent_email_id) as sent_last_opened_at
    FROM soumissions s
    LEFT JOIN projects p ON s.project_id = p.id
    LEFT JOIN companies co ON s.company_id = co.id
    LEFT JOIN contacts c ON s.contact_id = c.id
    LEFT JOIN emails se ON se.id = s.sent_email_id
    WHERE s.id = ?
  `).get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })

  const items = db.prepare(`
    SELECT di.*, p.name_fr, p.name_en
    FROM document_items di
    LEFT JOIN products p ON di.catalog_product_id = p.id
    WHERE di.document_id = ? AND di.document_type = 'soumission'
    ORDER BY di.sort_order
  `).all(req.params.id)

  // Commande issue de cette soumission (quote-to-cash), si conversion déjà faite.
  const converted_order = db.prepare(
    'SELECT id, order_number FROM orders WHERE soumission_id = ? AND deleted_at IS NULL ORDER BY created_at LIMIT 1'
  ).get(req.params.id) || null

  res.json({ ...row, items, converted_order })
})

const ITEMS_QUERY = `
  SELECT di.*, p.name_fr, p.name_en, p.sku, p.image_url
  FROM document_items di
  LEFT JOIN products p ON di.catalog_product_id = p.id
  WHERE di.document_id = ? AND di.document_type = 'soumission'
  ORDER BY di.sort_order
`
const INSERT_ITEM = `
  INSERT INTO document_items
    (id, document_type, document_id, catalog_product_id, qty, unit_price_cad, discount_pct, discount_amount, description_fr, description_en, sort_order, group_name, unit_monthly_price)
  VALUES (?, 'soumission', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`

// Contact d'un projet, pour la couverture du PDF : le lien direct, sinon le
// contact lié côté Airtable, sinon le premier contact de l'entreprise.
function projectContactId(projectId) {
  const p = projectId ? db.prepare('SELECT contact_id, contact_lie, company_id FROM projects WHERE id = ?').get(projectId) : null
  if (!p) return null
  if (p.contact_id) return p.contact_id
  const firstLinked = String(p.contact_lie || '').split(/[,\s]+/).find(Boolean)
  const linked = firstLinked && db.prepare('SELECT id FROM contacts WHERE airtable_id = ?').get(firstLinked)
  if (linked) return linked.id
  return p.company_id ? db.prepare('SELECT id FROM contacts WHERE company_id = ? ORDER BY created_at LIMIT 1').get(p.company_id)?.id || null : null
}

// Aperçu en direct du PDF, pendant la saisie : même corps que la création,
// rien n'est enregistré. Renvoie le HTML du gabarit (rendu dans une iframe).
router.post('/soumissions/preview', (req, res) => {
  const { project_id, company_id, contact_id, language = 'French', currency = 'CAD', items = [] } = req.body
  const project = project_id ? db.prepare('SELECT company_id FROM projects WHERE id = ?').get(project_id) : null
  const companyId = company_id || project?.company_id
  const contactId = contact_id || projectContactId(project_id)
  const next_num = nextQuoteNumber({ peek: true })
  const product = db.prepare('SELECT name_fr, name_en, sku, image_url FROM products WHERE id = ?')
  const html = buildSoumissionHtml({
    soumission: {
      language, currency, title: quoteTitle(next_num),
      expiration_date: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
    },
    items: (Array.isArray(items) ? items : []).map(it => ({ ...it, ...(it.catalog_product_id ? product.get(it.catalog_product_id) : {}),
      description_fr: it.description_fr, description_en: it.description_en })),
    discounts: sanitizeDiscounts(req.body.discounts) || [],
    company: companyId ? db.prepare('SELECT name FROM companies WHERE id = ?').get(companyId) : null,
    contact: contactId ? db.prepare('SELECT first_name, last_name FROM contacts WHERE id = ?').get(contactId) : null,
  })
  res.json({ html })
})

// Devise imposée par le client Stripe de l'entreprise. Stripe non configuré ou
// injoignable : pas de verrou (on ne bloque pas la saisie d'une soumission).
async function lockedCurrency(companyId) {
  if (!companyId) return null
  try { return await stripeCurrencyOf(getStripeClient(), companyId) } catch { return null }
}
function currencyError(res, locked) {
  return res.status(400).json({ error: `Ce client paie en ${locked} dans Stripe : la soumission doit être en ${locked}.`, code: 'currency_mismatch', locked })
}

// GET /api/documents/stripe-currency/:companyId — { currency } ou null.
router.get('/stripe-currency/:companyId', async (req, res) => {
  res.json({ currency: await lockedCurrency(req.params.companyId) })
})

router.post('/soumissions', async (req, res) => {
  const {
    company_id, contact_id, project_id, language = 'French', currency = 'CAD',
    notes, discount_pct = 0, discount_amount = 0, items = []
  } = req.body
  const locked = await lockedCurrency(company_id)
  if (locked && locked !== String(currency).toUpperCase()) return currencyError(res, locked)
  const discounts = sanitizeDiscounts(req.body.discounts)
  // Contact du projet par défaut : son nom figure sur la couverture du PDF.
  const contactId = contact_id || projectContactId(project_id)

  const autoExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  const id = newRecordId()
  // Soumission + ses lignes dans une seule transaction : un échec de contrainte
  // au milieu de la boucle d'items ne doit pas laisser une soumission orpheline.
  const insertSoumission = db.prepare(`
    INSERT INTO soumissions
      (id, company_id, contact_id, project_id, language, currency, status, title, notes,
       expiration_date, quote_number, discount_pct, discount_amount, discounts)
    VALUES (?, ?, ?, ?, ?, ?, 'Brouillon', ?, ?, ?, ?, ?, ?, ?)
  `)
  const insertItem = db.prepare(INSERT_ITEM)
  db.transaction(() => {
    const next_num = nextQuoteNumber()
    insertSoumission.run(id, company_id || null, contactId, project_id || null,
           language, currency, quoteTitle(next_num), notes || null, autoExpiry, next_num,
           discounts ? 0 : discount_pct, discounts ? 0 : discount_amount,
           discounts ? JSON.stringify(discounts) : null)
    for (let i = 0; i < items.length; i++) {
      const it = items[i]
      insertItem.run(newRecordId(), id, it.catalog_product_id || null,
                     it.qty || 1, it.unit_price_cad ?? 0, it.discount_pct ?? 0, it.discount_amount ?? 0,
                     it.description_fr || null, it.description_en || null, i,
                     it.group_name || null, it.unit_monthly_price ?? 0)
    }
  })()
  syncSoumissionTotals(id)

  try {
    const soumission = db.prepare('SELECT * FROM soumissions WHERE id = ?').get(id)
    const allItems = db.prepare(ITEMS_QUERY).all(id)
    const company = company_id ? db.prepare('SELECT * FROM companies WHERE id = ?').get(company_id) : null
    const contact = contactId ? db.prepare('SELECT * FROM contacts WHERE id = ?').get(contactId) : null
    const tenant = db.prepare('SELECT * FROM tenants LIMIT 1').get()
    const pdfPath = await generateSoumissionPdf(soumission, allItems, company, contact, tenant)
    const relPath = path.relative(uploadsPath(), pdfPath)
    db.prepare('UPDATE soumissions SET generated_pdf_path = ? WHERE id = ?').run(relPath, id)
  } catch (e) {
    console.error('PDF generation error:', e)
  }

  const created = db.prepare(SOUMISSION_LIST_SELECT).get(id)
  emitEntity('soumission', 'created', id, created, req.user?.id)
  res.json(created)
})

router.put('/soumissions/:id', async (req, res) => {
  const existing = db.prepare('SELECT id, company_id, currency, language, status, sent_at FROM soumissions WHERE id = ?').get(req.params.id)
  if (!existing) return res.status(404).json({ error: 'Not found' })

  // Une soumission envoyée est figée : le client a ce PDF-là. Ses notes et son
  // statut bougent encore ; pour changer le contenu, on la duplique.
  const sent = existing.sent_at || ['Envoyée', 'Acceptée', 'Refusée'].includes(existing.status)
  const b = req.body || {}
  if (sent && (Array.isArray(b.items) || Array.isArray(b.discounts) || b.discount_pct != null || b.discount_amount != null ||
      (b.language && b.language !== existing.language) || (b.currency && b.currency !== existing.currency))) {
    return res.status(409).json({ error: 'Soumission déjà envoyée : dupliquez-la pour la modifier.' })
  }

  if (req.body.currency && req.body.currency !== existing.currency) {
    const locked = await lockedCurrency(existing.company_id)
    if (locked && locked !== String(req.body.currency).toUpperCase()) return currencyError(res, locked)
  }
  const { language, currency, status, notes, discount_pct, discount_amount, discount_valid_until, items } = req.body
  // Rabais nommés : remplacés s'ils sont envoyés ; effacés si la fiche modifie
  // le rabais global (sinon le PDF garderait les anciens).
  const prev = db.prepare('SELECT discounts, discount_pct, discount_amount FROM soumissions WHERE id = ?').get(req.params.id)
  let discountsJson = prev.discounts
  if (Array.isArray(req.body.discounts)) discountsJson = JSON.stringify(sanitizeDiscounts(req.body.discounts))
  else if ((discount_pct != null && Number(discount_pct) !== Number(prev.discount_pct || 0)) ||
           (discount_amount != null && Number(discount_amount) !== Number(prev.discount_amount || 0))) discountsJson = null

  // Update du header + remplacement des lignes dans une seule transaction : un échec
  // au milieu de la ré-insertion ne doit pas laisser la soumission sans ses items.
  const updateSoumission = db.prepare(`
    UPDATE soumissions SET
      language = COALESCE(?, language),
      currency = COALESCE(?, currency),
      status = COALESCE(?, status),
      notes = ?,
      discount_pct = COALESCE(?, discount_pct),
      discount_amount = COALESCE(?, discount_amount),
      discount_valid_until = ?,
      discounts = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `)
  const deleteItems = db.prepare("DELETE FROM document_items WHERE document_id = ? AND document_type = 'soumission'")
  const insertItem = db.prepare(INSERT_ITEM)
  db.transaction(() => {
    updateSoumission.run(language ?? null, currency ?? null, status ?? null, notes ?? null,
           discount_pct ?? null, discount_amount ?? null, discount_valid_until ?? null, discountsJson, req.params.id)

    if (Array.isArray(items)) {
      deleteItems.run(req.params.id)
      for (let i = 0; i < items.length; i++) {
        const it = items[i]
        insertItem.run(newRecordId(), req.params.id, it.catalog_product_id || null,
                       it.qty || 1, it.unit_price_cad ?? 0, it.discount_pct ?? 0, it.discount_amount ?? 0,
                       it.description_fr || null, it.description_en || null, i,
                       it.group_name || null, it.unit_monthly_price ?? 0)
      }
    }
  })()
  syncSoumissionTotals(req.params.id)

  try {
    const soumission = db.prepare('SELECT * FROM soumissions WHERE id = ?').get(req.params.id)
    const allItems = db.prepare(ITEMS_QUERY).all(req.params.id)
    const company = soumission.company_id ? db.prepare('SELECT * FROM companies WHERE id = ?').get(soumission.company_id) : null
    const contact = soumission.contact_id ? db.prepare('SELECT * FROM contacts WHERE id = ?').get(soumission.contact_id) : null
    const tenant = db.prepare('SELECT * FROM tenants LIMIT 1').get()
    const pdfPath = await generateSoumissionPdf(soumission, allItems, company, contact, tenant)
    const relPath = path.relative(uploadsPath(), pdfPath)
    db.prepare('UPDATE soumissions SET generated_pdf_path = ? WHERE id = ?').run(relPath, req.params.id)
  } catch (e) {
    console.error('PDF regeneration error:', e)
  }

  const updated = db.prepare(SOUMISSION_LIST_SELECT).get(req.params.id)
  emitEntity('soumission', 'updated', req.params.id, updated, req.user?.id)
  res.json(updated)
})

router.delete('/soumissions/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM soumissions WHERE id = ?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  if (row.airtable_id) return res.status(400).json({ error: 'Cannot delete Airtable-synced soumission' })
  // Suppression des lignes + du header dans une seule transaction : pas de lignes
  // orphelines si le DELETE de la soumission échoue.
  const deleteItems = db.prepare("DELETE FROM document_items WHERE document_id = ? AND document_type = 'soumission'")
  const deleteSoumission = db.prepare('DELETE FROM soumissions WHERE id = ?')
  db.transaction(() => {
    deleteItems.run(req.params.id)
    deleteSoumission.run(req.params.id)
  })()
  emitEntity('soumission', 'deleted', req.params.id, { id: req.params.id }, req.user?.id)
  // Clean up PDF
  if (row.generated_pdf_path) {
    try {
      const uploadsBase = uploadsPath()
      const fromUploads = path.join(uploadsBase, row.generated_pdf_path)
      const fromCwd     = path.resolve(process.cwd(), row.generated_pdf_path)
      fs.unlinkSync(fs.existsSync(fromUploads) ? fromUploads : fromCwd)
    } catch {}
  }
  res.json({ ok: true })
})

// ── PDF download ──────────────────────────────────────────────────────────────

// Chemin du PDF d'une soumission, régénéré s'il manque (throw si échec).
async function ensureSoumissionPdf(soumission) {
  let pdfPath
  if (soumission.generated_pdf_path) {
    // Essaie uploads-relative (nouvelles soumissions), puis cwd-relative (legacy)
    const uploadsBase = uploadsPath()
    const fromUploads = path.join(uploadsBase, soumission.generated_pdf_path)
    const fromCwd     = path.resolve(process.cwd(), soumission.generated_pdf_path)
    pdfPath = fs.existsSync(fromUploads) ? fromUploads : fromCwd
  }
  if (pdfPath && fs.existsSync(pdfPath)) return pdfPath
  // Soumission Airtable : son PDF est la pièce jointe Airtable, jamais un
  // rendu local (elle n'a pas de lignes ici).
  if (soumission.airtable_id) {
    const rel = await mirrorSoumissionPdf(soumission.airtable_id)
    if (!rel) throw Object.assign(new Error('Aucun PDF'), { status: 404 })
    return path.join(uploadsPath(), rel)
  }
  const allItems = db.prepare(ITEMS_QUERY).all(soumission.id)
  const company = soumission.company_id ? db.prepare('SELECT * FROM companies WHERE id = ?').get(soumission.company_id) : null
  const contact = soumission.contact_id ? db.prepare('SELECT * FROM contacts WHERE id = ?').get(soumission.contact_id) : null
  const tenant = db.prepare('SELECT * FROM tenants LIMIT 1').get()
  pdfPath = await generateSoumissionPdf(soumission, allItems, company, contact, tenant)
  db.prepare('UPDATE soumissions SET generated_pdf_path = ? WHERE id = ?').run(path.relative(uploadsPath(), pdfPath), soumission.id)
  return pdfPath
}

function soumissionPdfFilename(soumission) {
  const docNum = soumission.document_number || soumission.id.slice(0, 8).toUpperCase()
  return soumission.language === 'English' ? `Quote-${docNum}.pdf` : `Soumission-${docNum}.pdf`
}

router.get('/soumissions/:id/pdf', async (req, res) => {
  const soumission = db.prepare('SELECT * FROM soumissions WHERE id = ?').get(req.params.id)
  if (!soumission) return res.status(404).json({ error: 'Not found' })

  let pdfPath
  try {
    pdfPath = await ensureSoumissionPdf(soumission)
  } catch (e) {
    if (e.status === 404) return res.status(404).json({ error: 'Aucun PDF' })
    console.error('Soumission PDF:', e.message)
    return res.status(500).json({ error: 'PDF generation failed' })
  }

  const filename = soumissionPdfFilename(soumission)
  const disposition = req.query.download ? 'attachment' : 'inline'
  res.setHeader('Content-Type', 'application/pdf')
  res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`)
  fs.createReadStream(pdfPath).pipe(res)
})

// ── Envoi au client ───────────────────────────────────────────────────────────

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// Courriel type des vendeurs (texte de Pierre-Alexandre Papillon), dans la
// langue du contact, personnalisé par son prénom. Les boutons nommés sont ceux
// du PDF joint.
const QUOTE_LINKS = {
  pricing: 'https://www.orisha.io/pricing',
  demo: 'https://app.orisha.io/#try-it-out',
  meet: 'https://meetings.hubspot.com/philippe-chabot/meet-with-phil',
  farmer: 'https://the40hourfarmer.orisha.io/',
}
const a = (href, label) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${label}</a>`
const ul = items => `<ul style="list-style:disc;padding-left:24px;margin:0 0 16px">${items.map(i => `<li><em>${i}</em></li>`).join('')}</ul>`

function soumissionEmailTemplate({ language, firstName, title, senderName }) {
  const en = String(language || '').toLowerCase().startsWith('en')
  const hi = firstName ? ` ${esc(firstName)}` : ''
  const sign = senderName ? `${esc(senderName)}<br>Orisha` : 'Orisha'
  return en ? {
    subject: `Your Orisha quote ${title}`,
    bodyHtml: `<p>Hi${hi},</p><p>Thanks again for your time. It was great to learn more about your project!</p>`
      + `<p>I've attached your quote below.</p>`
      + `<p>To access the checkout session and make your payment, click on <strong>Subscribe</strong> for the pay-as-you-go or click on <strong>Buy Now</strong> for the lifetime access.</p>`
      + `<p>Here is also the link to <em>${a(QUOTE_LINKS.pricing, 'the pricing page')}</em> of our website for an overview of the different options.<br>`
      + `I also added a ${a(QUOTE_LINKS.demo, 'demo of the app')} that manages our systems.</p>`
      + `<p>Orisha is now offering the option to deduct the monthly payment made during year one from the overall purchase price.<br>`
      + `<em>For the products chief and helper sold starting April 1, 2026:</em></p>`
      + ul([
        'The first 12 months are deductible from the amount to be paid upon buyback.',
        'The base price for calculating the buyback price is the one indicated on the quote(s).',
        'Starting from the second anniversary, a progressive discount of 10% is applied.',
        'People with a partner discount and/or another discount are also eligible.',
      ])
      + `<p>If you have any questions, don't hesitate to contact us.<br>Our offices are open Monday through Friday, 9:00 a.m. to 4:00 p.m. EST.</p>`
      + `<p>To book another meeting, you can click ${a(QUOTE_LINKS.meet, 'Meet with Phil (video call)')}.</p>`
      + `<p>Thank you,<br>${sign}</p>`
      + `<p><em>Want to learn more about how you, too, can maximize efficiency on the farm?<br>`
      + `Sign up to our ${a(QUOTE_LINKS.farmer, '40hr farmer class')}<br>`
      + `PSSST it's free for Orisha users &amp; Growing for market subscribers</em></p>`,
  } : {
    subject: `Votre soumission Orisha ${title}`,
    bodyHtml: `<p>Bonjour${hi},</p><p>Merci encore pour votre temps. Ce fut un plaisir d'en apprendre plus sur votre projet !</p>`
      + `<p>Vous trouverez ci-joint votre soumission <strong>${esc(title)}</strong>.</p>`
      + `<p>Pour accéder au paiement, cliquez sur <strong>S’abonner</strong> pour le paiement mensuel ou sur <strong>Acheter</strong> pour l'accès à vie.</p>`
      + `<p>Voici aussi le lien vers <em>${a(QUOTE_LINKS.pricing, 'la page des tarifs')}</em> de notre site pour un aperçu des différentes options.<br>`
      + `J'ai aussi ajouté une ${a(QUOTE_LINKS.demo, "démo de l'application")} qui gère nos systèmes.</p>`
      + `<p>Orisha offre maintenant la possibilité de déduire du prix d'achat les mensualités payées la première année.<br>`
      + `<em>Pour les produits Chief et Helper vendus à partir du 1er avril 2026 :</em></p>`
      + ul([
        'Les 12 premiers mois sont déductibles du montant à payer lors du rachat.',
        'Le prix de base du rachat est celui indiqué sur la ou les soumissions.',
        'À partir du deuxième anniversaire, un rabais progressif de 10 % s’applique.',
        'Les personnes ayant un rabais partenaire ou un autre rabais sont aussi admissibles.',
      ])
      + `<p>Pour toute question, n'hésitez pas à nous contacter.<br>Nos bureaux sont ouverts du lundi au vendredi, de 9 h à 16 h (HNE).</p>`
      + `<p>Pour réserver une autre rencontre, cliquez sur ${a(QUOTE_LINKS.meet, 'Rencontrer Phil (appel vidéo)')}.</p>`
      + `<p>Merci,<br>${sign}</p>`
      + `<p><em>Envie d'en apprendre plus sur comment maximiser l'efficacité de votre ferme ?<br>`
      + `Inscrivez-vous à notre ${a(QUOTE_LINKS.farmer, 'formation 40hr farmer')}<br>`
      + `Psst, c'est gratuit pour les utilisateurs d'Orisha et les abonnés de Growing for Market</em></p>`,
  }
}

// Contacts proposés : celui de la soumission (sinon celui du projet) en tête,
// puis les autres contacts de l'entreprise qui ont un courriel.
function soumissionRecipients(soumission) {
  const mainId = soumission.contact_id || projectContactId(soumission.project_id)
  const main = mainId ? db.prepare('SELECT id, first_name, last_name, email, language, company_id FROM contacts WHERE id = ?').get(mainId) : null
  const companyId = soumission.company_id || main?.company_id ||
    (soumission.project_id ? db.prepare('SELECT company_id FROM projects WHERE id = ?').get(soumission.project_id)?.company_id : null)
  const others = companyId ? db.prepare(`
    SELECT id, first_name, last_name, email, language FROM contacts
    WHERE company_id = ? AND deleted_at IS NULL AND email LIKE '%@%'
    ORDER BY first_name, last_name
  `).all(companyId) : []
  const seen = new Set()
  return [main, ...others].filter(c => c?.email && !seen.has(c.email.toLowerCase()) && seen.add(c.email.toLowerCase()))
}

// GET /api/documents/soumissions/:id/email — brouillon (rien n'est envoyé).
router.get('/soumissions/:id/email', (req, res) => {
  const soumission = db.prepare('SELECT * FROM soumissions WHERE id = ?').get(req.params.id)
  if (!soumission) return res.status(404).json({ error: 'Not found' })
  const senderName = db.prepare('SELECT name FROM users WHERE id = ?').get(req.user?.id)?.name || ''
  const title = soumission.title || soumissionPdfFilename(soumission).replace(/\.pdf$/, '')
  const recipients = soumissionRecipients(soumission).map(c => ({
    contact_id: c.id,
    email: c.email,
    name: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email,
    language: c.language || soumission.language,
    ...soumissionEmailTemplate({ language: c.language || soumission.language, firstName: c.first_name, title, senderName }),
  }))
  const first = recipients[0]
  const fallback = soumissionEmailTemplate({ language: soumission.language, title, senderName })
  res.json({
    to: first?.email || '',
    subject: (first || fallback).subject,
    bodyHtml: (first || fallback).bodyHtml,
    recipients,
    language: soumission.language,
    attachments: [{
      name: soumissionPdfFilename(soumission),
      url: `/erp/api/documents/soumissions/${soumission.id}/pdf?v=${encodeURIComponent(soumission.updated_at || '')}`,
      contentType: 'application/pdf',
    }],
  })
})

// POST /api/documents/soumissions/:id/send-email — PDF en pièce jointe, envoyé
// depuis le Gmail de l'utilisateur (ou `from_account`). Consigne l'interaction
// et passe la soumission « Envoyée ». Un pixel de suivi, absent du corps
// consigné (l'afficher dans l'ERP compterait une ouverture), date la 1re
// ouverture du courriel.
router.post('/soumissions/:id/send-email', async (req, res) => {
  const soumission = db.prepare('SELECT * FROM soumissions WHERE id = ?').get(req.params.id)
  if (!soumission) return res.status(404).json({ error: 'Not found' })
  const { to, cc, bcc, subject, body_html, from_account } = req.body || {}
  if (!to || !String(to).includes('@')) return res.status(400).json({ error: 'Adresse courriel invalide' })
  if (!subject || !String(subject).trim()) return res.status(400).json({ error: 'Objet requis' })

  // Client Stripe créé (ou mis à jour) avec les adresses de la fiche avant que
  // le client puisse payer depuis le PDF.
  if (soumission.company_id) {
    try {
      const stripe = getStripeClient()
      await assertStripeCurrency(stripe, soumission.company_id, soumission.currency || 'CAD')
      await syncStripeCustomer(stripe, soumission.company_id)
    } catch (e) {
      if (e.code === 'currency_mismatch') return currencyError(res, e.locked)
      console.error('Soumission send-email stripe customer:', e.message)
      return res.status(502).json({ error: `Client Stripe : ${e.message}` })
    }
  }

  const emailId = newRecordId()
  let result
  try {
    const pdfPath = await ensureSoumissionPdf(soumission)
    result = await sendGmail(to, String(subject).trim(), trackEmailHtml(body_html, emailId), {
      cc: cc || undefined,
      bcc: bcc || undefined,
      attachments: [{ filename: soumissionPdfFilename(soumission), content: fs.readFileSync(pdfPath), contentType: 'application/pdf' }],
      userId: req.user?.id,
      accountEmail: from_account || undefined,
    })
  } catch (e) {
    console.error('Soumission send-email error:', e.message)
    return res.status(502).json({ error: e.message })
  }

  const contactId = db.prepare('SELECT id FROM contacts WHERE lower(email) = lower(?) AND deleted_at IS NULL').get(to)?.id || soumission.contact_id || null
  const senderUserId = db.prepare('SELECT id FROM users WHERE lower(email) = lower(?)').get(result.account_email)?.id || req.user?.id || null
  const interactionId = newRecordId()
  db.transaction(() => {
    db.prepare(`
      INSERT INTO interactions (id, contact_id, company_id, user_id, type, direction, timestamp)
      VALUES (?, ?, ?, ?, 'email', 'out', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).run(interactionId, contactId, soumission.company_id || null, senderUserId)
    db.prepare(`
      INSERT INTO emails (id, interaction_id, subject, body_html, from_address, to_address, cc, bcc, gmail_message_id, gmail_thread_id, automated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(emailId, interactionId, String(subject).trim(), String(body_html || ''), result.account_email, to, cc || null, bcc || null, result.message_id, result.thread_id)
    db.prepare(`
      UPDATE soumissions SET sent_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), sent_email_id = ?,
        status = CASE WHEN status = 'Brouillon' THEN 'Envoyée' ELSE status END,
        updated_at = CASE WHEN status = 'Brouillon' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') ELSE updated_at END
      WHERE id = ?
    `).run(emailId, soumission.id)
    db.prepare(`
      INSERT INTO soumission_sends (email_id, soumission_id, sent_at)
      SELECT sent_email_id, id, sent_at FROM soumissions WHERE id = ?
    `).run(soumission.id)
  })()

  const updated = db.prepare(SOUMISSION_LIST_SELECT).get(soumission.id)
  emitEntity('soumission', 'updated', soumission.id, updated, req.user?.id)
  res.json({ success: true, interaction_id: interactionId, soumission: updated })
})

// GET /api/documents/soumissions/:id/sends — historique complet : chaque envoi
// (le plus récent d'abord) et toutes les ouvertures de son courriel.
router.get('/soumissions/:id/sends', (req, res) => {
  const sends = db.prepare(`
    SELECT ss.email_id, ss.sent_at, e.to_address, e.from_address
    FROM soumission_sends ss LEFT JOIN emails e ON e.id = ss.email_id
    WHERE ss.soumission_id = ? ORDER BY ss.sent_at DESC
  `).all(req.params.id)
  const opens = db.prepare('SELECT opened_at FROM email_opens WHERE email_id = ? ORDER BY opened_at DESC')
  res.json(sends.map(s => ({ ...s, opens: opens.all(s.email_id).map(o => o.opened_at) })))
})

// ── Duplicate ─────────────────────────────────────────────────────────────────

router.post('/soumissions/:id/duplicate', async (req, res) => {
  const src = db.prepare('SELECT * FROM soumissions WHERE id = ?').get(req.params.id)
  if (!src) return res.status(404).json({ error: 'Not found' })
  const locked = await lockedCurrency(src.company_id)
  if (locked && locked !== (src.currency || 'CAD')) return currencyError(res, locked)

  const newId = newRecordId()
  // La copie a son propre numéro, jamais « Copie de … »
  const copyNum = nextQuoteNumber()
  const copyExpiry = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

  db.prepare(`
    INSERT INTO soumissions
      (id, project_id, company_id, contact_id, language, currency, status, title, notes,
       expiration_date, quote_number, discount_pct, discount_amount, discounts)
    VALUES (?, ?, ?, ?, ?, ?, 'Brouillon', ?, ?, ?, ?, ?, ?, ?)
  `).run(newId, src.project_id, src.company_id, src.contact_id,
         src.language, src.currency || 'CAD',
         quoteTitle(copyNum), src.notes,
         copyExpiry, copyNum, src.discount_pct || 0, src.discount_amount || 0, src.discounts || null)

  // Copy items
  const srcItems = db.prepare(`
    SELECT * FROM document_items WHERE document_id = ? AND document_type = 'soumission' ORDER BY sort_order
  `).all(req.params.id)
  const insertItem = db.prepare(INSERT_ITEM)
  for (const it of srcItems) {
    insertItem.run(newRecordId(), newId, it.catalog_product_id, it.qty, it.unit_price_cad, it.discount_pct ?? 0, it.discount_amount ?? 0, it.description_fr, it.description_en, it.sort_order, it.group_name, it.unit_monthly_price ?? 0)
  }
  syncSoumissionTotals(newId)

  // Generate PDF
  try {
    const soumission = db.prepare('SELECT * FROM soumissions WHERE id = ?').get(newId)
    const allItems = db.prepare(ITEMS_QUERY).all(newId)
    const company = src.company_id ? db.prepare('SELECT * FROM companies WHERE id = ?').get(src.company_id) : null
    const contact = src.contact_id ? db.prepare('SELECT * FROM contacts WHERE id = ?').get(src.contact_id) : null
    const tenant = db.prepare('SELECT * FROM tenants LIMIT 1').get()
    const pdfPath = await generateSoumissionPdf(soumission, allItems, company, contact, tenant)
    const relPath = path.relative(uploadsPath(), pdfPath)
    db.prepare('UPDATE soumissions SET generated_pdf_path = ? WHERE id = ?').run(relPath, newId)
  } catch (e) {
    console.error('PDF generation error (duplicate):', e)
  }

  const dupRow = db.prepare(SOUMISSION_LIST_SELECT).get(newId)
  emitEntity('soumission', 'created', newId, dupRow, req.user?.id)
  res.json(dupRow)
})

export default router
