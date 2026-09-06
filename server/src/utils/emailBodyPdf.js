import PDFDocument from 'pdfkit'

// Certaines factures fournisseurs (ex. Webflow, Manychat) arrivent sans pièce
// jointe : la facture EST le corps HTML du courriel. Le rendu principal est
// désormais le PDF fidèle de emailHtmlPdf.js (Chromium headless) ; le PDF texte
// construit ici sert de REPLI (Chromium absent, rendu en échec, courriel sans
// corps HTML) pour que tout l'aval (viewer, extraction pdftotext, pièce jointe
// QuickBooks) fonctionne comme pour un PDF attaché classique.

const INVOICE_KEYWORDS = /(invoice|facture|receipt|reçu|relevé|statement)/i
// Montant d'argent : « $126.00 », « 126,00 $ », « 18.87 USD », « €42 »…
const MONEY_AMOUNT = /(?:[$€]\s?\d)|(?:\d(?:[\d\s.,]*\d)?\s?(?:[$€]|(?:USD|CAD|EUR)\b))/

// Garde-fou : le label ERP/Factures contient parfois du bruit non-facture
// (notifications de compte, resets de mot de passe…). On n'ingère un courriel
// sans pièce jointe que si une facture y est plausible : mot-clé facture dans
// le sujet ou le corps, ET au moins un montant d'argent dans le corps. Le
// mot-clé seul ne suffit pas — « Factures » est le nom de la boîte destinataire
// et apparaît dans des notifications de compte qui n'ont rien d'une facture.
// Avis « votre facture/relevé est disponible » : notification qui ANNONCE une
// facture publiée ailleurs (portail, ou PDF joint à un second courriel) en
// rappelant le montant. Elle passe le test mot-clé + montant, et se matérialise
// donc en un reçu fantôme qui double la vraie facture — cas mensuel d'AWS
// (« Billing Statement Available … Total in CAD: $102.73 », dont le montant est
// d'ailleurs l'équivalent CAD, pas le montant USD comptabilisé). La vraie facture,
// elle, arrive toujours en pièce jointe et n'emprunte pas ce chemin.
const STATEMENT_NOTIFICATION =
  /(billing statement|invoice|statement|facture|relev[ée])[^\n]{0,80}\b(is )?(now )?(available|ready|disponible|accessible|pr[êe]te?)\b|\b(available|disponible)\s+(on|sur)\s+the\s+\w+\s+(web\s?site|portal)/i

export function looksLikeInvoiceEmail(subject, bodyText) {
  if (STATEMENT_NOTIFICATION.test(subject || '')) return false
  const hasKeyword = INVOICE_KEYWORDS.test(subject || '') || INVOICE_KEYWORDS.test(bodyText || '')
  return hasKeyword && MONEY_AMOUNT.test(bodyText || '')
}

// Expéditeurs de facturation typiques : billing@, invoices@, facturation@,
// no-reply@billing.… Un envoi depuis une de ces adresses avec une pièce jointe
// PDF est une facture dans la quasi-totalité des cas.
const BILLING_SENDER = /(billing|invoic|factur|receipt|no-?reply@.*(bill|pay)|payments?@)/i
// Exporté pour l'autodétection : une facture SANS pièce jointe (le corps du
// courriel est la facture — Webflow, Stripe…) n'est devinée que si l'expéditeur
// ressemble à une adresse de facturation.
export const isBillingSender = from => BILLING_SENDER.test(from || '')
// Nom de fichier de pièce jointe : « invoice_1234.pdf », « Facture-2026-07.pdf »,
// « statement.pdf », « reçu.pdf »… « bill » n'est admis que dans le nom de
// fichier (trop de faux positifs dans un sujet : « billet », « billboard »…).
const ATTACHMENT_INVOICE_NAME = /(invoice|factur|receipt|re[cç]u|relev[ée]|statement|\bbill\b)/i

// Sujets qui portent un mot-clé « facture » sans en être une : avis
// d'expédition, partages de note/document, rappels de portail. Sans cette
// liste, un « Expédié : … » Amazon ou un partage Google Keep intitulé
// « Notes : Comptabilité » passent sur le seul mot-clé du corps.
const NON_INVOICE_SUBJECT =
  /(exp[ée]di[ée]|shipped|out for delivery|tracking|suivi de (votre )?(colis|commande)|^\s*notes?\s*:|partag[ée] (avec vous|un|une)|shared (a |an |the )?(note|document|file|folder))/i
// Réponse ou transfert : le fil cite les messages précédents, donc leurs pièces
// jointes ET les images de signature de chaque intervenant. En autodétection on
// les ignore — une facture transférée reste ingérable via le label ERP/Factures
// ou l'alias factures@, deux gestes explicites. Exception : un expéditeur
// explicitement whitelisté (`trustedSender`) est lui-même une intention humaine
// — sur une boîte personnelle en liste blanche, transférer une facture VERS la
// boîte est justement le geste prévu.
const REPLY_OR_FORWARD_SUBJECT = /^\s*(re|r[ée]p|fwd?|fw|tr)\s*:/i

/**
 * Détection « toute facture reçue », sans label ni adresse dédiée : sert aux
 * boîtes où l'autodétection est activée (voir `invoice_autodetect_mailboxes`).
 * Plus permissive que looksLikeInvoiceEmail (qui exige un montant dans le corps,
 * impossible quand la facture est en pièce jointe) mais toujours gardée par un
 * mot-clé — l'appelant a déjà exclu les envois sortants.
 * @param {{subject?: string, from?: string, bodyText?: string, attachmentNames?: string[], isReply?: boolean, trustedSender?: boolean}} msg
 */
export function looksLikeInvoiceMessage({ subject = '', from = '', bodyText = '', attachmentNames = [], isReply = false, trustedSender = false } = {}) {
  const hasAttachment = attachmentNames.length > 0
  if (!trustedSender && (isReply || REPLY_OR_FORWARD_SUBJECT.test(subject))) return false
  if (NON_INVOICE_SUBJECT.test(subject)) return false
  if (INVOICE_KEYWORDS.test(subject)) return true
  if (hasAttachment && attachmentNames.some(n => ATTACHMENT_INVOICE_NAME.test(n || ''))) return true
  if (hasAttachment && BILLING_SENDER.test(from)) return true
  // Ni le sujet, ni le nom de fichier, ni l'expéditeur : on retombe sur la règle
  // stricte (mot-clé + montant dans le corps).
  return looksLikeInvoiceEmail(subject, bodyText)
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
