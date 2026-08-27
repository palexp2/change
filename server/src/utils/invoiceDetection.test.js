import test from 'node:test'
import assert from 'node:assert/strict'
import { looksLikeInvoiceMessage } from './emailBodyPdf.js'

test('sujet contenant « facture » suffit', () => {
  assert.equal(looksLikeInvoiceMessage({
    subject: 'Votre facture Google Workspace du 1er juillet',
    from: 'payments-noreply@google.com',
    attachmentNames: ['doc.pdf'],
  }), true)
})

test('nom de pièce jointe facture suffit même avec un sujet neutre', () => {
  assert.equal(looksLikeInvoiceMessage({
    subject: 'Documents du mois',
    from: 'compta@fournisseur.com',
    attachmentNames: ['Invoice_98213.pdf'],
  }), true)
})

test('expéditeur de facturation avec pièce jointe suffit', () => {
  assert.equal(looksLikeInvoiceMessage({
    subject: 'Your monthly summary',
    from: 'billing@twilio.com',
    attachmentNames: ['summary_202607.pdf'],
  }), true)
})

test('corps avec mot-clé + montant, sans pièce jointe', () => {
  assert.equal(looksLikeInvoiceMessage({
    subject: 'Merci !',
    from: 'hello@manychat.com',
    bodyText: 'Receipt for your subscription — total $126.00 USD',
  }), true)
})

test('courriel ordinaire avec pièce jointe : rejeté', () => {
  assert.equal(looksLikeInvoiceMessage({
    subject: 'Plans de la serre révisés',
    from: 'client@example.com',
    bodyText: 'Voici les plans mis à jour, dis-moi ce que tu en penses.',
    attachmentNames: ['plans_v3.pdf'],
  }), false)
})

test('mot-clé sans montant et sans pièce jointe : rejeté', () => {
  assert.equal(looksLikeInvoiceMessage({
    subject: 'Bienvenue',
    from: 'noreply@saas.com',
    bodyText: 'Vos factures seront disponibles dans votre portail client.',
  }), false)
})

test('« billet » ne déclenche pas sur le sujet', () => {
  assert.equal(looksLikeInvoiceMessage({
    subject: 'Votre billet de train est confirmé',
    from: 'noreply@viarail.ca',
    bodyText: 'Départ 8h15, voiture 4.',
    attachmentNames: ['itineraire.pdf'],
  }), false)
})

test('appel sans argument ne lève pas', () => {
  assert.equal(looksLikeInvoiceMessage(), false)
})

test('réponse dans un fil : rejetée même avec un sujet facture', () => {
  assert.equal(looksLikeInvoiceMessage({
    subject: 'Re: Your receipt from CircleCo Inc. #2412-6725',
    from: 'pap@orisha.io',
    attachmentNames: ['Receipt-2412-6725.pdf', 'image003.png'],
  }), false)
})

test('transfert : rejeté (flag In-Reply-To/References)', () => {
  assert.equal(looksLikeInvoiceMessage({
    subject: 'Facture Provo à comptabiliser',
    from: 'pap@orisha.io',
    attachmentNames: ['Invoice_INV369457.pdf'],
    isReply: true,
  }), false)
})

test('avis d\'expédition Amazon : rejeté', () => {
  assert.equal(looksLikeInvoiceMessage({
    subject: 'Expédié : « cm-5.3 - Cyclone Chain... »',
    from: 'shipment-tracking@amazon.ca',
    bodyText: 'Votre commande de 57,48 $ a été expédiée. Facture disponible.',
    attachmentNames: ['order.pdf'],
  }), false)
})

test('partage de note Google Keep : rejeté', () => {
  assert.equal(looksLikeInvoiceMessage({
    subject: 'Notes : "Comptabilité" 21 juil. 2026',
    from: 'noreply@google.com',
    bodyText: 'Factures à payer : Provo 570,40 $',
    attachmentNames: ['Notes.pdf'],
  }), false)
})

test('facture Google Workspace directe : toujours acceptée', () => {
  assert.equal(looksLikeInvoiceMessage({
    subject: 'Votre facture Google Workspace est disponible',
    from: 'payments-noreply@google.com',
    attachmentNames: ['5637718480.pdf'],
  }), true)
})
