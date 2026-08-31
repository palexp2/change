// Tests des fonctions PURES de purolatorPayload.js (construction d'enveloppes
// SOAP + lecture de réponses) — aucun accès réseau, mêmes garanties que
// upsPayload.test.js. Leçons Novoxpress reprises explicitement (CLAUDE.md
// tâche Purolator) : dimensions entières, poids minimum ≥ 1, aucun champ hors
// schéma envoyé.

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  splitStreetAddress,
  buildRecipientParty,
  buildPackageInformation,
  buildEstimateRequest,
  buildCreateShipmentRequest,
  parseEstimateResponse,
  parseCreateShipmentResponse,
  parseGetDocumentsResponse,
  parseTrackingResponse,
  describePurolatorError,
  serviceName,
} from './purolatorPayload.js'

const baseCtx = {
  company_name: 'Ferme Soleil Inc.',
  company_phone: '4185550199',
  address_contact_email: 'client@example.com',
  address_contact_phone: '418-555-0199',
  address_contact_first_name: 'Marie',
  address_contact_last_name: 'Tremblay',
  address_line1: '123 rue des Serres',
  address_city: 'Québec',
  address_province: 'QC',
  address_postal_code: 'G1S 2P1',
  address_country: 'CA',
}

test('splitStreetAddress sépare le numéro civique et le reste', () => {
  assert.deepEqual(splitStreetAddress('123 rue des Serres'), { streetNumber: '123', streetName: 'rue des Serres' })
  assert.deepEqual(splitStreetAddress('220-1535 ch. Ste-Foy'), { streetNumber: '220-1535', streetName: 'ch. Ste-Foy' })
})

test('splitStreetAddress sans numéro en tête ne devine pas un faux numéro', () => {
  assert.deepEqual(splitStreetAddress('ch. Ste-Foy'), { streetNumber: '', streetName: 'ch. Ste-Foy' })
})

test('buildRecipientParty lève une erreur claire si le téléphone manque', () => {
  assert.throws(() => buildRecipientParty({ ...baseCtx, address_contact_phone: null, company_phone: null }), /téléphone/)
})

test('buildRecipientParty construit une adresse complète', () => {
  const r = buildRecipientParty(baseCtx)
  assert.equal(r.streetNumber, '123')
  assert.equal(r.streetName, 'rue des Serres')
  assert.equal(r.city, 'Québec')
  assert.equal(r.province, 'QC')
  assert.equal(r.country, 'CA')
  assert.equal(r.postalCode, 'G1S2P1')
  assert.equal(r.phone.length, 10)
  assert.equal(r.contactName, 'Marie Tremblay')
})

// ── Leçon Novoxpress : dimensions entières, poids ≥ 1 (CLAUDE.md) ───────────
test('buildPackageInformation arrondit les dimensions décimales à l\'entier supérieur', () => {
  const { xml } = buildPackageInformation([{ quantity: '1', weight: '2.3', length: '20.1', width: '16', depth: '8.9' }])
  assert.match(xml, /<Weight>3<\/Weight>/)
  assert.match(xml, /<Length>21<\/Length>/)
  assert.match(xml, /<Width>16<\/Width>/)
  assert.match(xml, /<Height>9<\/Height>/)
})

test('buildPackageInformation impose un poids minimum de 1 même si 0 ou négatif est fourni', () => {
  const { xml: xml0 } = buildPackageInformation([{ quantity: '1', weight: '0', length: '5', width: '5', depth: '5' }])
  assert.match(xml0, /<Weight>1<\/Weight>/)
  const { xml: xmlNeg } = buildPackageInformation([{ quantity: '1', weight: '-3', length: '5', width: '5', depth: '5' }])
  assert.match(xmlNeg, /<Weight>1<\/Weight>/)
})

test('buildPackageInformation déplie la quantité en pièces individuelles', () => {
  const { xml, pieceCount } = buildPackageInformation([{ quantity: '3', weight: '2', length: '10', width: '10', depth: '10' }])
  assert.equal(pieceCount, 3)
  assert.equal((xml.match(/<PieceInformation>/g) || []).length, 3)
  assert.match(xml, /<TotalPieces>3<\/TotalPieces>/)
})

test('buildPackageInformation refuse un envoi sans colis', () => {
  assert.throws(() => buildPackageInformation([]), /Aucun colis décrit/)
})

test('buildEstimateRequest produit une enveloppe SOAP valide avec RequestContext', () => {
  const { xml } = buildEstimateRequest(baseCtx, { packages: [{ quantity: '1', weight: '2', length: '20', width: '16', depth: '8' }], accountNumber: 'ACC123' })
  assert.match(xml, /<soap:Envelope/)
  assert.match(xml, /<RequestContext/)
  assert.match(xml, /<GetFullEstimateRequest/)
  assert.match(xml, /<RegisteredAccountNumber>ACC123<\/RegisteredAccountNumber>/)
  // Aucun champ hors schéma : pas de balise non fermée / non attendue triviale.
  assert.match(xml, /<\/soap:Envelope>$/)
})

test('buildCreateShipmentRequest exige un service_id', () => {
  assert.throws(() => buildCreateShipmentRequest(baseCtx, { packages: [{ quantity: '1', weight: '2', length: '20', width: '16', depth: '8' }] }), /service_id/)
})

test('buildCreateShipmentRequest référence l\'envoi ERP en TrackingReferenceInformation', () => {
  const { xml } = buildCreateShipmentRequest(baseCtx, {
    packages: [{ quantity: '1', weight: '2', length: '20', width: '16', depth: '8' }],
    serviceId: 'PurolatorExpress',
    accountNumber: 'ACC123',
    erpShipmentId: 'ship_42',
  })
  assert.match(xml, /<Reference1>ship_42<\/Reference1>/)
  assert.match(xml, /<ServiceID>PurolatorExpress<\/ServiceID>/)
})

test('serviceName retombe sur l\'id brut si inconnu', () => {
  assert.equal(serviceName('PurolatorExpress'), 'Purolator Express')
  assert.equal(serviceName('CodeInconnu'), 'CodeInconnu')
})

// ── Parsing des réponses SOAP ────────────────────────────────────────────────

const ESTIMATE_OK_XML = `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GetFullEstimateResponse xmlns="http://purolator.com/pws/service/v2">
      <ResponseInformation><Errors/></ResponseInformation>
      <ShipmentEstimates>
        <ShipmentEstimate>
          <ServiceID>PurolatorExpress</ServiceID>
          <TotalPrice>15.42</TotalPrice>
          <EstimatedTransitDays>1</EstimatedTransitDays>
          <ExpectedDeliveryDate>2026-09-02</ExpectedDeliveryDate>
        </ShipmentEstimate>
        <ShipmentEstimate>
          <ServiceID>PurolatorGround</ServiceID>
          <TotalPrice>9.10</TotalPrice>
          <EstimatedTransitDays>3</EstimatedTransitDays>
        </ShipmentEstimate>
      </ShipmentEstimates>
    </GetFullEstimateResponse>
  </soap:Body>
</soap:Envelope>`

test('parseEstimateResponse lit plusieurs tarifs', () => {
  const { rates, errors } = parseEstimateResponse(ESTIMATE_OK_XML)
  assert.equal(errors.length, 0)
  assert.equal(rates.length, 2)
  assert.equal(rates[0].service_id, 'PurolatorExpress')
  assert.equal(rates[0].service_name, 'Purolator Express')
  assert.equal(rates[0].carrier_name, 'Purolator')
  assert.equal(rates[0].total.value, '15.42')
  assert.equal(rates[0].total_transit_day, 1)
})

test('parseEstimateResponse gère un unique tarif sans le perdre (collapse en objet)', () => {
  const xml = ESTIMATE_OK_XML.replace(/<ShipmentEstimate>[\s\S]*?<\/ShipmentEstimate>\s*<ShipmentEstimate>/, '<ShipmentEstimate>').replace(/<\/ShipmentEstimate>\s*<\/ShipmentEstimates>/, '</ShipmentEstimates>')
  const { rates } = parseEstimateResponse(xml)
  assert.equal(rates.length, 1)
})

const ESTIMATE_ERROR_XML = `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GetFullEstimateResponse xmlns="http://purolator.com/pws/service/v2">
      <ResponseInformation>
        <Errors>
          <Error><Code>1104019</Code><Description>Invalid postal code</Description></Error>
        </Errors>
      </ResponseInformation>
    </GetFullEstimateResponse>
  </soap:Body>
</soap:Envelope>`

test('parseEstimateResponse remonte les erreurs Purolator brutes', () => {
  const { rates, errors } = parseEstimateResponse(ESTIMATE_ERROR_XML)
  assert.equal(rates.length, 0)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].code, '1104019')
  assert.match(errors[0].description, /Invalid postal code/)
})

test('describePurolatorError inclut le message brut du transporteur (jamais un message générique)', () => {
  const msg = describePurolatorError('GetFullEstimate', [{ code: '1104019', description: 'Invalid postal code' }])
  assert.match(msg, /Purolator GetFullEstimate/)
  assert.match(msg, /1104019/)
  assert.match(msg, /Invalid postal code/)
})

const CREATE_SHIPMENT_OK_XML = `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <CreateShipmentResponse xmlns="http://purolator.com/pws/service/v2">
      <ResponseInformation><Errors/></ResponseInformation>
      <ShipmentPIN><Value>329020103391</Value></ShipmentPIN>
      <PiecePINs>
        <PiecePIN><PIN><Value>329020103391</Value></PIN></PiecePIN>
      </PiecePINs>
    </CreateShipmentResponse>
  </soap:Body>
</soap:Envelope>`

test('parseCreateShipmentResponse lit le PIN d\'expédition', () => {
  const { shipmentPin, piecePins, errors } = parseCreateShipmentResponse(CREATE_SHIPMENT_OK_XML)
  assert.equal(errors.length, 0)
  assert.equal(shipmentPin, '329020103391')
  assert.deepEqual(piecePins, ['329020103391'])
})

const GET_DOCUMENTS_OK_XML = `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <GetDocumentsResponse xmlns="http://purolator.com/pws/service/v2">
      <ResponseInformation><Errors/></ResponseInformation>
      <DocumentDetails>
        <DocumentDetail><Data>JVBERi0xLjQK</Data></DocumentDetail>
      </DocumentDetails>
    </GetDocumentsResponse>
  </soap:Body>
</soap:Envelope>`

test('parseGetDocumentsResponse lit le base64 du PDF d\'étiquette', () => {
  const { base64, errors } = parseGetDocumentsResponse(GET_DOCUMENTS_OK_XML)
  assert.equal(errors.length, 0)
  assert.equal(base64, 'JVBERi0xLjQK')
})

const TRACKING_OK_XML = `<?xml version="1.0"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Body>
    <TrackPackagesByPinResponse xmlns="http://purolator.com/pws/service/v2">
      <ResponseInformation><Errors/></ResponseInformation>
      <TrackingInformationList>
        <TrackingInformation>
          <Scans>
            <Scan><Description>Delivered</Description><City>Québec</City><Province>QC</Province><Date>2026-08-30</Date></Scan>
            <Scan><Description>Out for delivery</Description><City>Québec</City><Province>QC</Province><Date>2026-08-29</Date></Scan>
          </Scans>
        </TrackingInformation>
      </TrackingInformationList>
    </TrackPackagesByPinResponse>
  </soap:Body>
</soap:Envelope>`

test('parseTrackingResponse détecte un envoi livré depuis le dernier scan', () => {
  const t = parseTrackingResponse(TRACKING_OK_XML)
  assert.equal(t.errors.length, 0)
  assert.equal(t.status, 'Delivered')
  assert.equal(t.delivered, true)
  assert.match(t.last_activity, /Delivered/)
})
