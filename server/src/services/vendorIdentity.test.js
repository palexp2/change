import test from 'node:test'
import assert from 'node:assert/strict'
import { canonicalVendorName, isAmazonStoreDocument } from './vendorIdentity.js'

// Facture réelle (boutique Amazon, vendeur tiers) : la seule raison sociale imprimée est
// celle du marchand du marketplace. Lue au pied de la lettre, elle créait un fournisseur
// « AMERICA UGREEN LIMITED » alors que le fournisseur, c'est Amazon.ca.
const AMAZON_3P = `Invoice / Facture
Sold by / Vendu par: AMERICA UGREEN LIMITED
GST/HST # / # de TPS/TVH: 717876916RT0001
For questions about your order, call us at 877-586-3230 or visit www.amazon.ca/contact-us
Order # / Commande #: 702-1060073-2061856
UGREEN USB Hub 3.0, 4 Ports  ASIN: B0CD1BHXPZ`

test('facture de la boutique Amazon vendue par un tiers', () => {
  assert.equal(isAmazonStoreDocument(AMAZON_3P), true)
})

test('AWS n’est pas la boutique', () => {
  assert.equal(isAmazonStoreDocument('Amazon Web Services, Inc.\nInvoice\naws.amazon.com\nTotal 142.80'), false)
})

test('un document sans marqueur Amazon ne bascule pas', () => {
  assert.equal(isAmazonStoreDocument('DigiKey Electronics\nInvoice 132580242'), false)
  assert.equal(isAmazonStoreDocument('Livré par un transporteur, commande 702-1060073-2061856'), false)
  assert.equal(isAmazonStoreDocument(''), false)
})

test('alias : variantes Amazon → Amazon.ca, AWS distinct', () => {
  assert.equal(canonicalVendorName('Amazon.com.ca ULC'), 'Amazon.ca')
  assert.equal(canonicalVendorName('Amazon Web Services Canada, Inc.'), 'Amazon Web Services')
  assert.equal(canonicalVendorName('Federal Express Canada Corporation'), 'FedEx')
})
