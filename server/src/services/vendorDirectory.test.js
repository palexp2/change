import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVendorTableHtml, normalizeVendorKey, findVendorMatch } from './vendorDirectory.js'

// HTML minimal représentatif d'un export Google Doc : cellules enveloppées de
// <p><span>, entités HTML, <br>, ligne d'en-tête, ligne vide.
const SAMPLE_HTML = `
<html><body>
<table>
<tr><td><p><span>Fournisseur</span></p></td><td><p><span>CAD/USD</span></p></td><td><p><span>Paiement</span></p></td><td><p><span>Cat&eacute;gorie ctb</span></p></td><td><p><span>Description</span></p></td><td><p><span>Particularit&#233;s</span></p></td></tr>
<tr><td><p><span>Adafruit</span></p></td><td><p><span>USD</span></p></td><td><p><span>Master</span></p></td><td><p><span>68000 Fournitures R&amp;D</span></p></td><td><p><span>Conception et fabrication de produits &eacute;lectroniques</span></p></td><td><p><span>Web: R&#233;cup&eacute;rer la facture</span><br><span>Taxes: Hors-champ (New York)</span></p></td></tr>
<tr><td><p><span>Bell (Internet)</span></p></td><td><p><span>CAD</span></p></td><td><p><span>Master</span></p></td><td><p><span>76000 Serv. web &amp; T&#233;l&#233;phonie</span></p></td><td><p><span></span></p></td><td><p><span>Facture: sur le web</span></p></td></tr>
<tr><td><p><span></span></p></td><td><p><span>CAD</span></p></td><td><p><span></span></p></td><td><p><span></span></p></td><td><p><span></span></p></td><td><p><span></span></p></td></tr>
</table>
</body></html>`

test('parseVendorTableHtml — extrait les lignes, saute en-tête et lignes sans nom', () => {
  const vendors = parseVendorTableHtml(SAMPLE_HTML)
  assert.equal(vendors.length, 2)

  assert.deepEqual(vendors[0], {
    name: 'Adafruit',
    currency: 'USD',
    payment_method: 'Master',
    qb_category: '68000 Fournitures R&D',
    description: 'Conception et fabrication de produits électroniques',
    particularites: 'Web: Récupérer la facture Taxes: Hors-champ (New York)',
  })

  assert.equal(vendors[1].name, 'Bell (Internet)')
  assert.equal(vendors[1].qb_category, '76000 Serv. web & Téléphonie')
  // Cellule vide → null, pas chaîne vide
  assert.equal(vendors[1].description, null)
})

test('parseVendorTableHtml — HTML sans tableau → liste vide', () => {
  assert.deepEqual(parseVendorTableHtml('<html><body><p>rien</p></body></html>'), [])
  assert.deepEqual(parseVendorTableHtml(''), [])
})

test('normalizeVendorKey — minuscules, sans accents ni ponctuation', () => {
  assert.equal(normalizeVendorKey('Bell (Internet)'), 'bellinternet')
  assert.equal(normalizeVendorKey('Antoine Létourneau '), 'antoineletourneau')
  assert.equal(normalizeVendorKey('McMaster- Carr'), 'mcmastercarr')
  assert.equal(normalizeVendorKey(null), '')
})

test('findVendorMatch — exact à la normalisation près, jamais partiel', () => {
  const vendors = [{ name: 'Adafruit' }, { name: 'Bell (Internet)' }, { name: 'Antoine Létourneau' }]

  assert.equal(findVendorMatch('adafruit', vendors)?.name, 'Adafruit')
  assert.equal(findVendorMatch('ANTOINE LETOURNEAU', vendors)?.name, 'Antoine Létourneau')
  assert.equal(findVendorMatch('Bell Internet', vendors)?.name, 'Bell (Internet)')

  // Pas de match partiel : « Adafruit Industries LLC » ≠ « Adafruit » (le fuzzy
  // est délégué au modèle d'extraction, qui reçoit les noms canoniques en contexte)
  assert.equal(findVendorMatch('Adafruit Industries LLC', vendors), null)
  assert.equal(findVendorMatch('', vendors), null)
  assert.equal(findVendorMatch(null, vendors), null)
})
