import test from 'node:test'
import assert from 'node:assert/strict'
import { htmlToText, looksLikeInvoiceEmail, stripTrackingUrls, buildEmailBodyPdf } from './emailBodyPdf.js'

test('htmlToText convertit les blocs en lignes et décode les entités', () => {
  const html = `
    <html><head><style>.x{color:red}</style></head><body>
    <script>alert(1)</script>
    <h1>Invoice</h1>
    <table><tr><td>Total&nbsp;:</td><td>168,00&#8239;$</td></tr></table>
    <p>Merci &amp; bonne journ&#233;e</p>
    </body></html>`
  const text = htmlToText(html)
  assert.ok(text.includes('Invoice'))
  assert.ok(text.includes('Total :  168,00'))
  assert.ok(text.includes('Merci & bonne journée'))
  assert.ok(!text.includes('alert(1)'))
  assert.ok(!text.includes('color:red'))
})

test('looksLikeInvoiceEmail accepte les sujets/corps facture, rejette le bruit', () => {
  assert.ok(looksLikeInvoiceEmail('Fwd: Orisha - Manychat Invoice', 'Subtotal $126.00 Total $144.87'))
  assert.ok(looksLikeInvoiceEmail('', 'Voici votre facture du mois : 1 234,56 $'))
  assert.ok(looksLikeInvoiceEmail('Your receipt from Anthropic', 'Amount paid 25.00 USD'))
  assert.ok(!looksLikeInvoiceEmail('Linode Account Password Successfully Reset',
    'Linode account password was successfully reset.'))
  // « Factures » est le nom du compte destinataire — un mot-clé sans montant
  // d'argent ne doit pas suffire (notifications de compte, onboarding…).
  assert.ok(!looksLikeInvoiceEmail('Linode User Created',
    'A new Linode user, Factures, has been created with this email address. To log in, you must first change your password.'))
  // Et un montant sans mot-clé facture ne suffit pas non plus.
  assert.ok(!looksLikeInvoiceEmail('Votre solde', 'Votre compte affiche 100,00 $'))
})

test('stripTrackingUrls retire les liens <https://…> du plaintext Gmail', () => {
  const text = 'Page\n*Orisha*\n<https://u4649330.ct.sendgrid.net/ls/click?upn=u001.Flk3Tqe3tVQ3>\nTotal $168.00'
  const out = stripTrackingUrls(text)
  assert.ok(!out.includes('sendgrid'))
  assert.ok(out.includes('Total $168.00'))
})

test('buildEmailBodyPdf produit un PDF', async () => {
  const buf = await buildEmailBodyPdf({
    subject: 'Fwd: Orisha - Manychat Invoice',
    from: 'pap@orisha.io',
    date: 'Thu, 4 Jun 2026 11:24:58 -0400',
    text: 'Invoice ID 3958601-1\nTotal $168.00',
  })
  assert.ok(Buffer.isBuffer(buf))
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-')
})
