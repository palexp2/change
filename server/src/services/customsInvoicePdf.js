import PDFDocument from 'pdfkit'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'
import db from '../db/database.js'
import { SENDER, normalizeCountry, getShipmentWithAddress, shipmentCustomsValueCad } from './novoxpress.js'
import { buildReturnPartyContext } from './returnContext.js'
import { localDay } from '../utils/datetime.js'

// Facture commerciale (douane) d'un envoi ou d'un retour hors Canada — reprise
// du script Airtable de Pierre-Alexandre Papillon (2026-10-14), sans pdf.co :
// produite ici avec pdfkit, comme l'aide-mémoire (returnMemoPdf.js).
// Plus de certificat d'origine CUSMA/USMCA : l'entente n'est plus en vigueur.

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SIGNATURE_PATH = path.join(__dirname, '..', 'assets', 'signature-pa.png')

// Orisha, exportateur d'un envoi et destinataire d'un retour. Le script Airtable
// écrivait « 1536 » : coquille, l'adresse est celle de SENDER (1535).
export const ORISHA_PARTY = {
  name: SENDER.company_name,
  address: `1535 Ch. Ste-Foy Bureau 220, ${SENDER.address.city}, ${SENDER.address.region} G1S 2P1, ${SENDER.address.country}`,
  phone: '1-888-998-9189',
  email: 'pap@orisha.io',
  country: SENDER.address.country,
}

const BROKER = 'Axxess International, 100 Walnut Street, Champlain, NY, United States, 12919, paps@axxessintl.com'
// Origine = lieu de fabrication (Orisha, Canada), quel que soit l'exportateur.
const GOODS = { description: 'Intelligent greenhouse thermostat.', hsCode: '9032.10.0030', origin: 'CA' }
const SIGNER = { name: 'Pierre-Alexandre Papillon', title: 'Operations Manager' }
export const COPIES = 3

// Partie (exportateur ou destinataire) tirée d'un ctx d'adresse — mêmes clés
// que getShipmentWithAddress / buildReturnPartyContext.
export function partyFromAddressCtx(ctx) {
  const country = normalizeCountry(ctx.address_country)
  const contactName = [ctx.address_contact_first_name, ctx.address_contact_last_name].filter(Boolean).join(' ').trim()
  let line1 = (ctx.address_line1 || '').trim()
  // Rue saisie avec toute l'adresse (« 12 Farm Rd Albany NY … ») : couper au
  // nom de ville, comme extractStreet (novoxpress.js), sans tronquer.
  const cityAt = ctx.address_city && !line1.includes('\n') ? line1.indexOf(ctx.address_city) : -1
  if (cityAt > 0) line1 = line1.slice(0, cityAt).replace(/[\s,]+$/, '')
  // Adresse legacy Airtable multi-lignes : elle porte déjà ville, province et pays.
  const address = line1.includes('\n')
    ? line1.split('\n').map(s => s.trim()).filter(Boolean).join(', ')
    : [line1, ctx.address_city, [ctx.address_province, ctx.address_postal_code].filter(Boolean).join(' '), country]
      .map(s => (s || '').trim()).filter(Boolean).join(', ')
  return {
    name: ctx.company_name || contactName || '',
    address,
    phone: ctx.address_contact_phone || ctx.address_contact_mobile || '',
    email: ctx.address_contact_email || ctx.company_email || '',
    country,
  }
}

// Contenu de la facture, sans rendu : c'est lui que testent les tests unitaires.
// null quand le client est au Canada (pays de départ = pays d'arrivée).
export function customsInvoiceModel({ kind, isReplacement = false, invoiceNumber, client, valueCad = 0, date = localDay() }) {
  if (!client || normalizeCountry(client.country) === 'CA') return null
  const isReturn = kind === 'return'
  const exporter = isReturn ? client : ORISHA_PARTY
  const consignee = isReturn ? ORISHA_PARTY : client
  const value = isReturn ? 0 : Number(valueCad) || 0
  return {
    title: isReturn || isReplacement ? 'RETURN COMMERCIAL INVOICE' : 'COMMERCIAL INVOICE',
    invoiceNumber: String(invoiceNumber || ''),
    date,
    exporter,
    consignee,
    importerOfRecord: isReturn ? null : ORISHA_PARTY,
    line: { ...GOODS, qty: 1, unitPrice: value, total: value },
    currencyNote: isReturn ? 'Value for customs purposes only.' : null,
    declaration: isReturn
      ? 'Returned goods – no commercial value. Reason for export: Return of goods.'
      : isReplacement
        ? 'Goods returned after reparation – no commercial value. Reason for export: Return after reparation.'
        : 'I declare that the information on this invoice is true and correct.',
    signer: SIGNER,
    broker: isReturn ? null : BROKER,
  }
}

// ── Contexte d'un envoi ───────────────────────────────────────────────────

// Envoi de remplacement/réparation : le script testait « Remplacement » dans le
// type des articles de l'envoi. Équivalent ERP : order_items.item_type —
// articles assignés à l'envoi, sinon toute la commande (même repli que la fiche).
function shipmentIsReplacement(shipment) {
  const assigned = db.prepare('SELECT item_type FROM order_items WHERE shipment_id = ?').all(shipment.id)
  const items = assigned.length || !shipment.order_id
    ? assigned
    : db.prepare('SELECT item_type FROM order_items WHERE order_id = ?').all(shipment.order_id)
  return items.some(i => /remplacement/i.test(i.item_type || ''))
}

// Numéro : facture de la commande liée, sinon « # d'envoi », sinon l'id.
function shipmentInvoiceNumber(shipment) {
  const facture = shipment.order_id
    ? db.prepare(`SELECT document_number FROM factures WHERE order_id = ? AND document_number IS NOT NULL
        ORDER BY document_date DESC, created_at DESC LIMIT 1`).get(shipment.order_id)
    : null
  const dEnvoi = db.prepare('SELECT d_envoi FROM shipments WHERE id = ?').get(shipment.id)?.d_envoi
  return facture?.document_number || dEnvoi || shipment.id
}

export function shipmentCustomsInvoice(shipmentId) {
  const shipment = getShipmentWithAddress(shipmentId)
  if (!shipment) return null
  return customsInvoiceModel({
    kind: 'shipment',
    isReplacement: shipmentIsReplacement(shipment),
    invoiceNumber: shipmentInvoiceNumber(shipment),
    client: partyFromAddressCtx(shipment),
    valueCad: shipmentCustomsValueCad(shipmentId),
  })
}

// ── Contexte d'un retour ──────────────────────────────────────────────────

// Le contrôle porte sur le pays du CLIENT (l'expéditeur), comme
// createReturnLabel. Adresse : celle de l'étiquette de retour si elle est
// posée, sinon la meilleure de l'entreprise.
export function returnCustomsInvoice(returnId) {
  const ret = db.prepare('SELECT * FROM returns WHERE id = ? AND deleted_at IS NULL').get(returnId)
  if (!ret) return null
  const { ctx } = buildReturnPartyContext(returnId, ret.return_address_id || null) || {}
  if (!ctx) return null
  return customsInvoiceModel({
    kind: 'return',
    invoiceNumber: ret.cf_de_retour || ret.id,
    client: partyFromAddressCtx(ctx),
  })
}

// ── Rendu ─────────────────────────────────────────────────────────────────

const M = 40
const FONT = 9 // ≈ Arial 11 px du gabarit HTML d'origine
const PAD = 4
const HEADER_BG = '#e6e6e6'
const money = n => (Number(n) || 0).toFixed(2)

function partyLines(p) {
  return [p.name, p.address, p.phone && `Phone: ${p.phone}`, p.email && `Email: ${p.email}`].filter(Boolean).join('\n')
}

// Tableau à bordures noires. rows[i] = { cells: [...], header?, bold?, height? }.
function drawTable(doc, y, widths, rows) {
  for (const row of rows) {
    const font = row.header || row.bold ? 'Helvetica-Bold' : 'Helvetica'
    doc.font(font).fontSize(FONT)
    const h = row.height || Math.max(...row.cells.map((c, i) =>
      typeof c === 'string' ? doc.heightOfString(c, { width: widths[i] - 2 * PAD }) : 0)) + 2 * PAD
    let x = M
    row.cells.forEach((c, i) => {
      if (row.header) doc.rect(x, y, widths[i], h).fill(HEADER_BG)
      doc.lineWidth(0.75).strokeColor('#000').rect(x, y, widths[i], h).stroke()
      if (typeof c === 'string') {
        doc.fillColor('#000').font(font).fontSize(FONT).text(c, x + PAD, y + PAD, { width: widths[i] - 2 * PAD })
      } else if (typeof c === 'function') {
        c(x, y, widths[i], h)
      }
      x += widths[i]
    })
    y += h
  }
  return y
}

function labelled(doc, y, label, value, width) {
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(FONT).text(`${label} `, M, y, { width, continued: true })
  doc.font('Helvetica').text(value)
  return doc.y + 8
}

function drawCopy(doc, m, signature) {
  const W = doc.page.width - 2 * M
  let y = M
  doc.fillColor('#000').font('Helvetica-Bold').fontSize(14).text(m.title, M, y, { width: W, align: 'center' })
  y = doc.y + 10
  y = labelled(doc, y, 'Invoice No:', m.invoiceNumber, W) - 6
  y = labelled(doc, y, 'Date:', m.date, W)

  y = drawTable(doc, y, [W / 2, W / 2], [
    { header: true, cells: ['Exporter', 'Consignee'] },
    { cells: [partyLines(m.exporter), partyLines(m.consignee)] },
  ]) + 10

  if (m.importerOfRecord) {
    y = drawTable(doc, y, [W], [
      { header: true, cells: ['Importer of Record'] },
      { cells: [partyLines(m.importerOfRecord)] },
    ]) + 10
  }

  y = labelled(doc, y, 'Relationship Statement:', 'The exporter and consignee are not related.', W)

  const widths = [0.05, 0.31, 0.13, 0.07, 0.16, 0.16, 0.12].map(f => f * W)
  const l = m.line
  y = drawTable(doc, y, widths, [
    { header: true, cells: ['#', 'Description of Goods', 'HS Code', 'Qty', 'Unit Price (CAD)', 'Total (CAD)', 'Origin'] },
    { cells: ['1', l.description, l.hsCode, String(l.qty), money(l.unitPrice), money(l.total), l.origin] },
    { bold: true, cells: ['', 'TOTAL', '', String(l.qty), '', money(l.total), ''] },
  ]) + 10

  if (m.currencyNote) y = labelled(doc, y, 'Currency Note:', m.currencyNote, W)
  y = labelled(doc, y, 'Declaration:', m.declaration, W)

  const sigW = [W / 3, W / 3, W / 3]
  y = drawTable(doc, y, sigW, [
    { header: true, cells: ['Authorized Signature', 'Name', 'Title'] },
    {
      height: 60,
      cells: [
        (x, top, w, h) => { if (signature) { try { doc.image(signature, x + PAD, top + PAD, { fit: [w - 2 * PAD, h - 2 * PAD] }) } catch { /* sans image */ } } },
        m.signer.name,
        m.signer.title,
      ],
    },
  ]) + 10

  if (m.broker) labelled(doc, y, 'Customs broker:', m.broker, W)
}

// PDF de la facture en COPIES exemplaires identiques, une par page (le script
// Airtable fusionnait la facture 3 fois).
export async function buildCustomsInvoicePdf(model) {
  let signature = null
  try { signature = fs.readFileSync(SIGNATURE_PATH) } catch { /* PDF sans signature */ }
  return await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: M, autoFirstPage: false })
    const chunks = []
    doc.on('data', c => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
    for (let i = 0; i < COPIES; i++) {
      doc.addPage()
      drawCopy(doc, model, signature)
    }
    doc.end()
  })
}
