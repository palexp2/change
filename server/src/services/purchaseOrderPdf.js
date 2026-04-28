import PDFDocument from 'pdfkit'

const GREEN = '#28B04E'
const DARK = '#111111'
const MUTED = '#555555'

const L = {
  fr: {
    title:    'BON DE COMMANDE',
    supplier: 'Fournisseur',
    date:     'Date',
    poNum:    'Numéro de commande',
    currency: 'Devise',
    details:  'Détails',
    billTo:   'FACTURER À',
    shipTo:   'EXPÉDIER À',
    product:  'Produit',
    qty:      'Quantité',
    rate:     'Tarif',
    amount:   'Montant',
    total:    'TOTAL',
  },
  en: {
    title:    'PURCHASE ORDER',
    supplier: 'Supplier',
    date:     'Date',
    poNum:    'PO Number',
    currency: 'Currency',
    details:  'Details',
    billTo:   'BILL TO',
    shipTo:   'SHIP TO',
    product:  'Product',
    qty:      'Quantity',
    rate:     'Rate',
    amount:   'Amount',
    total:    'TOTAL',
  },
}

/**
 * Génère un PDF de bon de commande en mémoire.
 *
 * @param {Object} po
 * @param {string} [po.lang='fr']
 * @param {string} po.supplier
 * @param {string} po.date              ISO date
 * @param {string} po.po_number
 * @param {string} po.currency
 * @param {string} [po.details]
 * @param {Object} po.bill_to           { company, address1, address2, contact, phone, email }
 * @param {Object} po.ship_to           { company, address1, address2, contact, phone, email }
 * @param {Array<{product:string, qty:number, rate:number}>} po.items
 * @param {Buffer} [po.logoBuffer]
 * @returns {Promise<Buffer>}
 */
export async function buildPurchaseOrderPdf(po) {
  const lang = (po.lang || 'fr').toLowerCase().startsWith('en') ? 'en' : 'fr'
  const t = L[lang]

  return await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: 50, left: 50, right: 50, bottom: 50 } })
    const chunks = []
    doc.on('data', c => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const pageWidth = doc.page.width - 100
    const M = 50

    // Logo
    if (po.logoBuffer) {
      try { doc.image(po.logoBuffer, M, 42, { height: 42, fit: [150, 42] }) } catch {}
    } else {
      doc.rect(M, 45, 110, 36).fill(GREEN)
      doc.fillColor('#fff').fontSize(18).font('Helvetica-Bold').text('ORISHA', M + 8, 54, { width: 94, align: 'center' })
    }

    // Title
    doc.fillColor(GREEN).fontSize(22).font('Helvetica-Bold')
      .text(t.title, M, 52, { width: pageWidth, align: 'center' })

    // Divider
    doc.moveTo(M, 100).lineTo(M + pageWidth, 100).strokeColor(GREEN).lineWidth(2).stroke()

    // Three-column info section
    let y = 115
    const colW = pageWidth / 3
    const leftX = M
    const midX = M + colW
    const rightX = M + 2 * colW

    // Left col: PO metadata
    const metaLines = [
      [t.supplier, po.supplier || '—'],
      [t.date, formatDate(po.date, lang)],
      [t.poNum, po.po_number || '—'],
      [t.currency, po.currency || 'CAD'],
    ]
    if (po.details) metaLines.push([t.details, po.details])

    let leftY = y
    for (const [label, val] of metaLines) {
      doc.fillColor(DARK).font('Helvetica-Bold').fontSize(9).text(`${label} :`, leftX, leftY, { width: colW - 10 })
      leftY += 12
      doc.fillColor(MUTED).font('Helvetica').fontSize(10).text(val, leftX, leftY, { width: colW - 10 })
      leftY += 18
    }

    // Middle col: Bill To
    let midY = y
    doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(9).text(t.billTo, midX, midY, { width: colW - 10 })
    midY += 14
    midY = writeAddressBlock(doc, po.bill_to, midX, midY, colW - 10)

    // Right col: Ship To
    let rightY = y
    doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(9).text(t.shipTo, rightX, rightY, { width: colW - 10 })
    rightY += 14
    rightY = writeAddressBlock(doc, po.ship_to, rightX, rightY, colW - 10)

    // Items table
    let tableY = Math.max(leftY, midY, rightY) + 20

    const cols = {
      product: M,
      qty:     M + pageWidth * 0.55,
      rate:    M + pageWidth * 0.70,
      amount:  M + pageWidth * 0.85,
    }
    const colW2 = {
      product: pageWidth * 0.55,
      qty:     pageWidth * 0.15,
      rate:    pageWidth * 0.15,
      amount:  pageWidth * 0.15,
    }

    // Header row
    doc.rect(M, tableY, pageWidth, 22).fill(GREEN)
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(10)
    doc.text(t.product, cols.product + 8, tableY + 6, { width: colW2.product - 8 })
    doc.text(t.qty,     cols.qty,         tableY + 6, { width: colW2.qty,     align: 'right' })
    doc.text(t.rate,    cols.rate,        tableY + 6, { width: colW2.rate,    align: 'right' })
    doc.text(t.amount,  cols.amount - 8,  tableY + 6, { width: colW2.amount,  align: 'right' })

    let rowY = tableY + 22
    let total = 0
    let alt = false
    for (const it of (po.items || [])) {
      const qty = Number(it.qty) || 0
      const rate = Number(it.rate) || 0
      const amt = qty * rate
      total += amt

      if (rowY > doc.page.height - 120) { doc.addPage(); rowY = 50 }

      // Alternate row bg
      if (alt) doc.rect(M, rowY, pageWidth, 22).fill('#f2f2f2')
      alt = !alt

      doc.fillColor(DARK).font('Helvetica').fontSize(10)
      doc.text(it.product || '—', cols.product + 8, rowY + 6, { width: colW2.product - 8, ellipsis: true })
      doc.text(String(qty),       cols.qty,         rowY + 6, { width: colW2.qty,    align: 'right' })
      doc.text(rate.toFixed(2),   cols.rate,        rowY + 6, { width: colW2.rate,   align: 'right' })
      doc.text(amt.toFixed(2),    cols.amount - 8,  rowY + 6, { width: colW2.amount, align: 'right' })

      // Row border
      doc.moveTo(M, rowY + 22).lineTo(M + pageWidth, rowY + 22).strokeColor('#ddd').lineWidth(0.5).stroke()

      rowY += 22
    }

    // Table outer border
    doc.rect(M, tableY, pageWidth, rowY - tableY).strokeColor('#ddd').lineWidth(0.5).stroke()

    // Total
    rowY += 20
    doc.fillColor(DARK).font('Helvetica-Bold').fontSize(13)
      .text(`${t.total} : ${total.toFixed(2)} ${po.currency || 'CAD'}`, M, rowY, { width: pageWidth, align: 'right' })

    doc.end()
  })
}

function formatDate(iso, lang) {
  if (!iso) return '—'
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return d.toLocaleDateString(lang === 'en' ? 'en-CA' : 'fr-CA', { year: 'numeric', month: 'long', day: 'numeric' })
  } catch {
    return iso
  }
}

function writeAddressBlock(doc, addr, x, y, width) {
  if (!addr) return y
  doc.fillColor(DARK).font('Helvetica-Bold').fontSize(10)
  if (addr.company) { doc.text(addr.company, x, y, { width }); y += 13 }
  doc.fillColor(MUTED).font('Helvetica').fontSize(9)
  if (addr.address1) { doc.text(addr.address1, x, y, { width }); y += 12 }
  if (addr.address2) { doc.text(addr.address2, x, y, { width }); y += 12 }
  if (addr.contact)  { y += 4; doc.fillColor(DARK).font('Helvetica-Bold').text(addr.contact, x, y, { width }); y += 12 }
  doc.fillColor(MUTED).font('Helvetica')
  if (addr.phone)    { doc.text(addr.phone, x, y, { width }); y += 12 }
  if (addr.email)    { doc.text(addr.email, x, y, { width }); y += 12 }
  return y
}

/**
 * Fetch Orisha logo as Buffer (best effort — returns null on failure).
 */
export async function fetchOrishaLogo() {
  try {
    const r = await fetch('https://orisha.us-east-1.linodeobjects.com/logo.png')
    if (!r.ok) return null
    return Buffer.from(await r.arrayBuffer())
  } catch { return null }
}
