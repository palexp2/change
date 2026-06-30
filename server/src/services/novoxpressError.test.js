// Tests pour describeCreateLabelFailure — le message surfacé quand
// /shipment/create-shipment répond sans shipment_id.
//
// Contexte : une panne upstream Novoxpress→Postes Canada (depuis ~2026-05-31)
// renvoie une erreur de validation XSD « duplicate element
// groupIdOrTransmitShipment ». L'ancien message « shipment_id manquant » laissait
// croire à un bug de nos données. On vérifie ici que l'erreur upstream est
// reconnue et clairement attribuée à Novoxpress, sans toucher l'API réelle.

import test from 'node:test'
import assert from 'node:assert/strict'

import { describeCreateLabelFailure, extractTrackingNumber, buildRecipient } from './novoxpress.js'

// Erreur réelle observée en prod (logs erp-server-error.log, 2026-06-01)
const REAL_CP_SCHEMA_ERROR = {
  error: {
    description:
      '/rs/0009743627/0009743627/shipment: cvc-model-group 3: in element ' +
      '{http://www.canadapost.ca/ws/shipment-v8}shipment of type ' +
      '{http://www.canadapost.ca/ws/shipment-v8}ShipmentType, duplicate element ' +
      '{http://www.canadapost.ca/ws/shipment-v8}groupIdOrTransmitShipment',
  },
}

test('erreur de schéma Postes Canada → attribuée à l\'amont, pas à nos données', () => {
  const { message, upstream } = describeCreateLabelFailure(REAL_CP_SCHEMA_ERROR)
  assert.equal(upstream, true)
  assert.match(message, /Novoxpress/)
  assert.match(message, /Postes Canada/)
  assert.match(message, /pas un problème des données de cet envoi/)
  // Le détail brut reste présent pour le diagnostic
  assert.match(message, /groupIdOrTransmitShipment/)
  // Et on n'emploie plus le message trompeur « shipment_id manquant »
  assert.doesNotMatch(message, /shipment_id manquant/)
})

test('autre échec (non schéma) → message générique, pas marqué upstream', () => {
  const { message, upstream } = describeCreateLabelFailure({ message: 'Internal error 500' })
  assert.equal(upstream, false)
  assert.match(message, /Création d'étiquette échouée chez Novoxpress/)
  assert.match(message, /Internal error 500/)
})

test('payload opaque → fallback JSON sans crash', () => {
  const { message, upstream } = describeCreateLabelFailure({ foo: 'bar' })
  assert.equal(upstream, false)
  assert.match(message, /foo/)
})

// ── extractTrackingNumber : récupération du n° de suivi après achat d'étiquette ──

test('tracking_id à plat (transporteurs hors Postes Canada)', () => {
  assert.equal(extractTrackingNumber({ shipment_id: 'NX-1', tracking_id: '1Z999AA10123456784' }), '1Z999AA10123456784')
})

test('tracking_pin à plat (Postes Canada)', () => {
  assert.equal(extractTrackingNumber({ shipment_id: 'NX-1', tracking_pin: '1234567890123456' }), '1234567890123456')
})

test('tracking imbriqué dans la réponse print-label', () => {
  const json = { label: { shipping_label: 'https://cdn.novoxpress.com/labels/abc.pdf', tracking_pin: '7000123456789012' } }
  assert.equal(extractTrackingNumber(json), '7000123456789012')
})

test('ne confond pas une URL de PDF avec un numéro de suivi', () => {
  // Aucune clé tracking_* ⇒ pas de faux positif sur shipping_label (une URL)
  assert.equal(extractTrackingNumber({ label: { shipping_label: 'https://cdn.novoxpress.com/x.pdf' } }), null)
})

test('absence totale de suivi → null (préserve la valeur existante via COALESCE)', () => {
  assert.equal(extractTrackingNumber({ shipment_id: 'NX-1', status: 'created' }), null)
  assert.equal(extractTrackingNumber(null), null)
  assert.equal(extractTrackingNumber('oops'), null)
})

test('priorité tracking_pin avant tracking_id quand les deux sont présents', () => {
  assert.equal(extractTrackingNumber({ tracking_id: 'AAA', tracking_pin: 'BBB' }), 'BBB')
})

// ── buildRecipient : Novoxpress rejette désormais recipient.contact_name sur
// tous ses endpoints (« ... contact_name is not allowed », 2026-06-09). On
// vérifie le contrat actuel : le champ ne doit JAMAIS être émis, même quand un
// contact est rattaché à l'adresse — le destinataire reste lisible via
// company_name. (Les anciens tests vérifiaient l'inverse : contact_name
// prénom+nom avec fallbacks — comportement retiré.)

const baseShipment = {
  company_name: 'Ferme Soleil Inc.',
  address_contact_email: 'client@example.com',
  address_contact_phone: '418-555-0199',
  address_line1: '123 rue des Serres',
  address_city: 'Québec',
  address_province: 'QC',
  address_postal_code: 'G1S 2P1',
  address_country: 'CA',
}

test('contact_name n\'est jamais émis, même avec un contact rattaché à l\'adresse', () => {
  const r = buildRecipient({ ...baseShipment, address_contact_first_name: 'Marie', address_contact_last_name: 'Tremblay' })
  assert.ok(!('contact_name' in r), 'recipient.contact_name est rejeté par Novoxpress — ne doit pas être émis')
  assert.equal(r.company_name, 'Ferme Soleil Inc.')
})

test('contact_name absent aussi sans contact (pas de fallback réintroduit)', () => {
  const r = buildRecipient({ ...baseShipment, address_contact_first_name: null, address_contact_last_name: null })
  assert.ok(!('contact_name' in r))
})
