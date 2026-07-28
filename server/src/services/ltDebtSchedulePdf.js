import PDFDocument from 'pdfkit'

// Cédule de remboursement d'une dette LT en PDF — jointe à chaque écriture de
// versement publiée dans QB pour que la pièce justificative suive l'écriture.

const money = n => (n == null ? '' : Number(n).toLocaleString('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' $')

export function buildDebtSchedulePdf({ debt, payments, highlightPaymentId }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 50 })
    const chunks = []
    doc.on('data', c => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    doc.font('Helvetica-Bold').fontSize(14).text(`Cédule de remboursement — ${debt.label}`)
    doc.moveDown(0.3)
    doc.font('Helvetica').fontSize(9).fillColor('#555555')
    if (debt.lender) doc.text(`Prêteur : ${debt.lender}`)
    if (debt.loan_number) doc.text(`No de prêt : ${debt.loan_number}`)
    if (debt.principal != null) doc.text(`Capital initial : ${money(debt.principal)} ${debt.currency || 'CAD'}`)
    doc.text(`Générée le ${new Date().toISOString().slice(0, 10)} par l'ERP Orisha`)
    doc.moveDown()

    const cols = [
      { key: 'seq', label: '#', width: 30, align: 'right' },
      { key: 'payment_date', label: 'Date', width: 80 },
      { key: 'principal', label: 'Capital', width: 90, align: 'right', fmt: money },
      { key: 'interest', label: 'Intérêts', width: 90, align: 'right', fmt: money },
      { key: 'total', label: 'Versement', width: 90, align: 'right', fmt: money },
      { key: 'balance_after', label: 'Solde après', width: 100, align: 'right', fmt: money },
    ]
    const startX = doc.page.margins.left
    const rowH = 16

    const drawRow = (row, y, { bold = false, highlight = false } = {}) => {
      if (highlight) {
        doc.save().rect(startX - 3, y - 3, cols.reduce((s, c) => s + c.width, 0) + 6, rowH).fill('#FFF3C4').restore()
      }
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9).fillColor('#000000')
      let x = startX
      for (const c of cols) {
        const raw = row[c.key]
        const text = c.fmt && raw !== '' && raw != null ? c.fmt(raw) : String(raw ?? '')
        doc.text(text, x, y, { width: c.width - 8, align: c.align || 'left' })
        x += c.width
      }
    }

    const drawHeader = y => {
      drawRow(Object.fromEntries(cols.map(c => [c.key, c.label])), y, { bold: true })
      doc.moveTo(startX, y + rowH - 4).lineTo(startX + cols.reduce((s, c) => s + c.width, 0), y + rowH - 4)
        .strokeColor('#999999').lineWidth(0.5).stroke()
    }

    let y = doc.y + 4
    drawHeader(y)
    y += rowH

    for (const p of payments) {
      if (y > doc.page.height - doc.page.margins.bottom - rowH) {
        doc.addPage()
        y = doc.page.margins.top
        drawHeader(y)
        y += rowH
      }
      drawRow(
        { ...p, total: (p.principal || 0) + (p.interest || 0) },
        y,
        { highlight: p.id === highlightPaymentId, bold: p.id === highlightPaymentId },
      )
      y += rowH
    }

    const totals = payments.reduce((a, p) => ({ principal: a.principal + (p.principal || 0), interest: a.interest + (p.interest || 0) }), { principal: 0, interest: 0 })
    if (y > doc.page.height - doc.page.margins.bottom - rowH * 2) { doc.addPage(); y = doc.page.margins.top }
    doc.moveTo(startX, y).lineTo(startX + cols.reduce((s, c) => s + c.width, 0), y).strokeColor('#999999').lineWidth(0.5).stroke()
    y += 6
    drawRow({ seq: '', payment_date: 'Total', principal: totals.principal, interest: totals.interest, total: totals.principal + totals.interest, balance_after: '' }, y, { bold: true })

    doc.end()
  })
}
