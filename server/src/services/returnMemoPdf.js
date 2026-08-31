import PDFDocument from 'pdfkit'

const GREEN = '#23B04C'
const BLUE = '#00A2E8'
const DARK = '#333333'
const MUTED = '#999999'

// Contenu fidèle au script Airtable original (bouton « Générer un aide
// mémoire » sur la fiche Retour) : titre, encart d'instructions, puis un
// tableau par article avec Produit | Numéro sur le produit (Adresse LoRa) |
// Image du produit | Transformateur à retourner.
const L = {
  French: {
    title: 'Aide mémoire de retour',
    subtitle: 'Liste des items que vous devez retourner',
    important: 'Important :',
    instructions1: 'Veuillez retourner exactement les items listés ci-dessous.',
    instructions2: "N'oubliez pas le transformateur externe (power supply) lorsqu'indiqué.",
    colProduit: 'Produit',
    colNumero: 'Numéro sur le produit',
    colImage: 'Image du produit',
    colTransfo: 'Transformateur à retourner',
    none: 'Aucun',
  },
  English: {
    title: 'Return Reminder',
    subtitle: 'List of items you must return',
    important: 'Important:',
    instructions1: 'Please return exactly the items listed below.',
    instructions2: "Don't forget the external power supply when indicated.",
    colProduit: 'Product',
    colNumero: 'Unit Number',
    colImage: 'Product Image',
    colTransfo: 'Power Supply to Return',
    none: 'None',
  },
}

/**
 * Génère l'aide-mémoire PDF d'un retour (RMA) — fidèle au script Airtable
 * d'origine (voir Phase 2 du plan). Langue déterminée par la langue du
 * contact (pas par le pays).
 *
 * @param {Object} ret
 * @param {string} [ret.langue='French'] — valeur brute du single-select Airtable Langue ('French'|'English')
 * @param {Array<{produit, adresse, image, transfo}>} ret.items
 * @returns {Promise<Buffer>}
 */
export async function buildReturnMemoPdf(ret) {
  const lang = ret.langue === 'English' ? 'English' : 'French'
  const t = L[lang]
  const items = ret.items || []

  return await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 40 })
    const chunks = []
    doc.on('data', c => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    const M = 40
    const pageWidth = doc.page.width - 2 * M

    doc.fillColor(GREEN).fontSize(32).font('Helvetica-Bold')
      .text(t.title, M, 40, { width: pageWidth, align: 'center' })
    doc.fillColor(BLUE).fontSize(18).font('Helvetica')
      .text(t.subtitle, M, 80, { width: pageWidth, align: 'center' })

    let y = 130
    doc.save()
    doc.rect(M, y, pageWidth, 60).fill('#f8f8f8')
    doc.rect(M, y, 6, 60).fill(GREEN)
    doc.restore()
    doc.fillColor(DARK).font('Helvetica-Bold').fontSize(11)
      .text(t.important, M + 20, y + 12, { continued: true })
    doc.font('Helvetica').text(` ${t.instructions1}`, { width: pageWidth - 40 })
    doc.text(t.instructions2, M + 20, y + 34, { width: pageWidth - 40 })

    y += 90
    const cols = { produit: M, numero: M + pageWidth * 0.30, image: M + pageWidth * 0.55, transfo: M + pageWidth * 0.78 }
    const colW = { produit: pageWidth * 0.30, numero: pageWidth * 0.25, image: pageWidth * 0.23, transfo: pageWidth * 0.22 }

    const headerHeight = 36
    doc.rect(M, y, pageWidth, headerHeight).fill(BLUE)
    doc.fillColor('#fff').font('Helvetica-Bold').fontSize(9)
    doc.text(t.colProduit, cols.produit + 10, y + 12, { width: colW.produit - 10 })
    doc.text(t.colNumero, cols.numero, y + 12, { width: colW.numero })
    doc.text(t.colImage, cols.image, y + 12, { width: colW.image })
    doc.text(t.colTransfo, cols.transfo, y + 4, { width: colW.transfo })
    y += headerHeight

    const rowHeight = 110
    for (const item of items) {
      if (y + rowHeight > doc.page.height - 60) { doc.addPage(); y = 50 }

      doc.rect(M, y, pageWidth, rowHeight).fill('#f5f5f5')

      doc.fillColor(GREEN).font('Helvetica-Bold').fontSize(13)
        .text(item.produit || '', cols.produit + 10, y + 14, { width: colW.produit - 10 })
      doc.fillColor(DARK).font('Helvetica').fontSize(11)
        .text(item.adresse || '', cols.numero, y + 14, { width: colW.numero })

      if (item.image) {
        try { doc.image(item.image, cols.image, y + 5, { width: 100, height: 100, fit: [100, 100] }) } catch {}
      }
      if (item.transfo) {
        try { doc.image(item.transfo, cols.transfo, y + 5, { width: 100, height: 100, fit: [100, 100] }) } catch {}
      } else {
        doc.fillColor(MUTED).font('Helvetica').fontSize(10)
          .text(t.none, cols.transfo, y + 45, { width: colW.transfo })
      }

      y += rowHeight
    }

    doc.end()
  })
}
