import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildReturnShipmentRequest,
  buildRateRequest,
  buildPackages,
  buildInternationalForms,
  parseRates,
  parseShipmentResults,
  parseTracking,
  parseUpsDateTime,
  normalizeCountry,
  asciiFold,
  asArray,
  ORISHA_WORKSHOP,
  DEFAULT_HS_CODE,
} from './upsPayload.js'

const CLIENT_CA = {
  company_name: 'Ferme L&C Charlebois',
  address_line1: '123 rue des Serres',
  address_city: 'Montréal',
  address_province: 'QC',
  address_postal_code: 'H2X 1Y4',
  address_country: 'Canada',
  address_contact_first_name: 'Émile',
  address_contact_last_name: 'Tremblay',
  address_contact_email: 'emile@example.com',
  address_contact_phone: '(514) 555-0142',
}

const CLIENT_US = {
  ...CLIENT_CA,
  address_city: 'Burlington',
  address_province: 'VT',
  address_postal_code: '05401',
  address_country: 'United States',
  address_contact_phone: '1-802-555-0199',
}

const PACKAGES = [{ quantity: '2', weight: '4.2', length: '20', width: '16', depth: '8' }]

test('normalizeCountry mappe les libellés FR/EN vers le code ISO', () => {
  assert.equal(normalizeCountry('Canada'), 'CA')
  assert.equal(normalizeCountry('États-Unis'), 'US')
  assert.equal(normalizeCountry('United States'), 'US')
  assert.equal(normalizeCountry(null), 'CA')
})

test('asciiFold retire les accents (UPS imprime en Latin-1)', () => {
  assert.equal(asciiFold('Québec'), 'Quebec')
  assert.equal(asciiFold('Montréal'), 'Montreal')
})

test('asArray protège du collapse des tableaux à 1 élément par UPS', () => {
  assert.deepEqual(asArray({ a: 1 }), [{ a: 1 }])
  assert.deepEqual(asArray([1, 2]), [1, 2])
  assert.deepEqual(asArray(null), [])
})

test('buildPackages déplie la quantité en colis physiques et arrondit le poids au lb supérieur', () => {
  const pkgs = buildPackages(PACKAGES)
  assert.equal(pkgs.length, 2, 'quantity=2 → 2 entrées Package')
  assert.equal(pkgs[0].PackageWeight.Weight, '5', '4.2 lb → 5')
  assert.equal(pkgs[0].PackageWeight.UnitOfMeasurement.Code, 'LBS')
  assert.equal(pkgs[0].Dimensions.Length, '20')
})

test('buildPackages refuse une liste vide plutôt que d\'envoyer un colis fantôme', () => {
  assert.throws(() => buildPackages([]), /Aucun colis/)
})

test('étiquette de retour : le client expédie, l\'atelier Orisha reçoit, ReturnService 9', () => {
  const { ShipmentRequest } = buildReturnShipmentRequest(CLIENT_CA, {
    accountNumber: 'A1B2C3', packages: PACKAGES,
  })
  const s = ShipmentRequest.Shipment
  assert.equal(s.ReturnService.Code, '9', 'Print Return Label')
  assert.equal(s.ShipFrom.Address.City, 'Montreal', 'expéditeur = client')
  assert.equal(s.ShipFrom.Address.PostalCode, 'H2X1Y4')
  assert.equal(s.ShipTo.Address.PostalCode, ORISHA_WORKSHOP.postal_code, 'destinataire = atelier Orisha')
  assert.equal(s.ShipTo.Address.City, 'Quebec')
  assert.equal(s.Shipper.ShipperNumber, 'A1B2C3', 'compte payeur = Orisha')
  assert.equal(s.PaymentInformation.ShipmentCharge.BillShipper.AccountNumber, 'A1B2C3')
  assert.equal(s.ShipFrom.Phone.Number, '5145550142', 'téléphone normalisé à 10 chiffres')
  assert.equal(ShipmentRequest.LabelSpecification.LabelImageFormat.Code, 'GIF')
})

test('étiquette de retour : sans compte UPS, on refuse avant tout appel réseau', () => {
  assert.throws(() => buildReturnShipmentRequest(CLIENT_CA, { packages: PACKAGES }), /compte UPS/)
})

test('étiquette de retour : coordonnées client incomplètes → message actionnable', () => {
  assert.throws(
    () => buildReturnShipmentRequest({ ...CLIENT_CA, address_contact_phone: null, company_phone: null }, {
      accountNumber: 'A1B2C3', packages: PACKAGES,
    }),
    /téléphone/
  )
})

test('retour depuis les US : facture commerciale jointe (description, valeur, origine, code SH)', () => {
  const { ShipmentRequest } = buildReturnShipmentRequest(CLIENT_US, {
    accountNumber: 'A1B2C3',
    packages: PACKAGES,
    customsItems: [{ description: 'Thermostat', qty: 2, unit_value: 300, origin_country: 'CA', hs_code: '9032.10.0030' }],
  })
  const forms = ShipmentRequest.Shipment.ShipmentServiceOptions.InternationalForms
  assert.equal(forms.ReasonForExport, 'RETURN')
  assert.equal(forms.Product[0].Description, 'Thermostat')
  assert.equal(forms.Product[0].Unit.Value, '300.00')
  assert.equal(forms.Product[0].OriginCountryCode, 'CA')
  assert.equal(forms.Product[0].CommodityCode, '9032100030', 'code SH sans point')
  assert.equal(ShipmentRequest.Shipment.InvoiceLineTotal.MonetaryValue, '600.00')
})

test('retour canadien : aucune déclaration douanière (colis domestique)', () => {
  const { ShipmentRequest } = buildReturnShipmentRequest(CLIENT_CA, { accountNumber: 'A1B2C3', packages: PACKAGES })
  assert.equal(ShipmentRequest.Shipment.ShipmentServiceOptions, undefined)
})

test('buildInternationalForms retombe sur le code SH par défaut quand le produit n\'en a pas', () => {
  const forms = buildInternationalForms([{ description: 'Sonde', qty: 1, unit_value: 50 }])
  assert.equal(forms.Product[0].CommodityCode, DEFAULT_HS_CODE.replace(/\./g, ''))
  assert.match(forms.InvoiceDate, /^\d{8}$/)
})

test('tarification : requête Shop, Orisha expéditeur, valeur déclarée pour les US', () => {
  const { RateRequest } = buildRateRequest(CLIENT_US, {
    accountNumber: 'A1B2C3',
    packages: PACKAGES,
    customsItems: [{ qty: 1, unit_value: 425.4 }],
  })
  assert.equal(RateRequest.Request.RequestOption, 'Shop')
  assert.equal(RateRequest.Shipment.ShipFrom.Address.PostalCode, ORISHA_WORKSHOP.postal_code)
  assert.equal(RateRequest.Shipment.ShipTo.Address.CountryCode, 'US')
  assert.equal(RateRequest.Shipment.InvoiceLineTotal.MonetaryValue, '425.00')
})

test('tarification canadienne : pas de valeur déclarée', () => {
  const { RateRequest } = buildRateRequest(CLIENT_CA, { accountNumber: 'A1B2C3', packages: PACKAGES })
  assert.equal(RateRequest.Shipment.InvoiceLineTotal, undefined)
})

test('parseRates trie par prix, nomme les services et préfère le tarif négocié', () => {
  const rates = parseRates({
    RateResponse: {
      RatedShipment: [
        { Service: { Code: '01' }, TotalCharges: { CurrencyCode: 'CAD', MonetaryValue: '48.10' } },
        {
          Service: { Code: '11' },
          TotalCharges: { CurrencyCode: 'CAD', MonetaryValue: '22.00' },
          NegotiatedRateCharges: { TotalCharge: { CurrencyCode: 'CAD', MonetaryValue: '18.75' } },
          GuaranteedDelivery: { BusinessDaysInTransit: '2' },
        },
      ],
    },
  })
  assert.equal(rates.length, 2)
  assert.equal(rates[0].service_id, '11')
  assert.equal(rates[0].service_name, 'UPS Standard')
  assert.equal(rates[0].carrier_name, 'UPS')
  assert.equal(rates[0].total.value, '18.75', 'tarif négocié retenu')
  assert.equal(rates[0].total_transit_day, 2)
  assert.equal(rates[1].service_name, 'UPS Next Day Air')
})

test('parseShipmentResults lit le suivi, le coût et l\'image même quand UPS collapse le tableau', () => {
  const r = parseShipmentResults({
    ShipmentResponse: {
      ShipmentResults: {
        ShipmentIdentificationNumber: '1Z12345E1512345676',
        ShipmentCharges: { TotalCharges: { CurrencyCode: 'CAD', MonetaryValue: '19.44' } },
        PackageResults: {
          TrackingNumber: '1Z12345E1512345676',
          ShippingLabel: { ImageFormat: { Code: 'GIF' }, GraphicImage: 'R0lGODlh' },
        },
      },
    },
  })
  assert.equal(r.shipment_id, '1Z12345E1512345676')
  assert.equal(r.tracking_number, '1Z12345E1512345676')
  assert.equal(r.cost, 19.44)
  assert.equal(r.currency, 'CAD')
  assert.equal(r.label_base64, 'R0lGODlh')
  assert.equal(r.label_format, 'GIF')
})

test('parseUpsDateTime produit de l\'ISO UTC avec Z (jamais de naïf local)', () => {
  assert.equal(parseUpsDateTime('20260830', '143000'), '2026-08-30T14:30:00.000Z')
  assert.equal(parseUpsDateTime('20260830'), '2026-08-30T00:00:00.000Z')
  assert.equal(parseUpsDateTime('bidon'), null)
})

test('parseTracking extrait statut courant, dernière activité et lieu', () => {
  const t = parseTracking({
    trackResponse: {
      shipment: {
        package: {
          trackingNumber: '1Z999AA10123456784',
          currentStatus: { code: 'I', description: 'En transit' },
          activity: [
            { status: { description: 'Départ du centre' }, date: '20260830', time: '081500', location: { address: { city: 'Montreal', stateProvince: 'QC' } } },
            { status: { description: 'Colis reçu' }, date: '20260829', time: '191000', location: { address: { city: 'Burlington', stateProvince: 'VT' } } },
          ],
        },
      },
    },
  })
  assert.equal(t.tracking_number, '1Z999AA10123456784')
  assert.equal(t.status, 'En transit')
  assert.equal(t.activity_at, '2026-08-30T08:15:00.000Z')
  assert.match(t.last_activity, /En transit — Montreal, QC/)
  assert.equal(t.activities.length, 2)
})
