import PDFDocument from 'pdfkit'

// Certaines factures fournisseurs (ex. Manychat) arrivent sans pièce jointe :
// la facture EST le corps HTML du courriel. On la matérialise en PDF texte pour
// que tout l'aval (viewer, extraction pdftotext, pièce jointe QuickBooks)
// fonctionne comme pour un PDF attaché classique.

const INVOICE_KEYWORDS = /(invoice|facture|receipt|reçu|relevé|statement)/i
// Montant d'argent : « $126.00 », « 126,00 $ », « 18.87 USD », « €42 »…
const MONEY_AMOUNT = /(?:[$€]\s?\d)|(?:\d(?:[\d\s.,]*\d)?\s?(?:[$€]|(?:USD|CAD|EUR)\b))/

// Garde-fou : le label ERP/Factures contient parfois du bruit non-facture
// (notifications de compte, resets de mot de passe…). On n'ingère un courriel
// sans pièce jointe que si une facture y est plausible : mot-clé facture dans
// le sujet ou le corps, ET au moins un montant d'argent dans le corps. Le
// mot-clé seul ne suffit pas — « Factures » est le nom de la boîte destinataire
// et apparaît dans des notifications de compte qui n'ont rien d'une facture.
export function looksLikeInvoiceEmail(subject, bodyText) {
  const hasKeyword = INVOICE_KEYWORDS.test(subject || '') || INVOICE_KEYWORDS.test(bodyText || '')
  return hasKeyword && MONEY_AMOUNT.test(bodyText || '')
}

export function htmlToText(html) {
  if (!html) return ''
  let s = html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|table|blockquote)>/gi, '\n')
    .replace(/<\/(td|th)>/gi, '  ')
    .replace(/<[^>]+>/g, '')
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  return s
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{3,}/g, '  ')
    .trim()
}

// Les corps plaintext générés par Gmail entourent les liens de <https://…> ;
// ces URLs de tracking (sendgrid & co) sont énormes et noient le contenu utile
// dans la fenêtre de 8000 caractères de l'extraction.
export function stripTrackingUrls(text) {
  return (text || '').replace(/<https?:\/\/\S+>/g, '').replace(/\n{3,}/g, '\n\n').trim()
}

export function buildEmailBodyPdf({ subject, from, date, text }) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margin: 50 })
    const chunks = []
    doc.on('data', c => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)

    doc.font('Helvetica-Bold').fontSize(12).text(subject || '(sans objet)')
    doc.moveDown(0.3)
    doc.font('Helvetica').fontSize(9).fillColor('#555555')
    if (from) doc.text(`De : ${from}`)
    if (date) doc.text(`Date : ${date}`)
    doc.moveDown()
    // pdfkit rend les \r comme un glyphe « Ð » — normaliser les fins de ligne.
    doc.fillColor('#000000').fontSize(10).text((text || '').replace(/\r\n?/g, '\n'), { lineGap: 2 })
    doc.end()
  })
}
