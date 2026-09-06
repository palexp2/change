// Construction et lecture des payloads UPS — fonctions PURES (aucun accès
// réseau ni DB) pour rester testables isolément (cf. upsPayload.test.js).
//
// Deux flux couverts :
//  • Shipping API /api/shipments/{version}/ship avec ReturnService code 9
//    (« Print Return Label ») : le CLIENT expédie, l'atelier d'Orisha reçoit.
//  • Rating API /api/rating/{version}/Shop : comparaison de tarifs pour un
//    envoi sortant (Orisha → client).

// Adresse de l'atelier d'Orisha — destinataire de tout retour. Même source de
// vérité que le SENDER Novoxpress (services/novoxpress.js) ; dupliquée ici en
// format UPS plutôt qu'adaptée, parce que les deux transporteurs ont des
// contraintes de longueur différentes et qu'un adaptateur croisé rendrait un
// changement d'adresse silencieusement risqué pour l'autre transporteur.
export const ORISHA_WORKSHOP = {
  name: 'Automatisation Orisha Inc.',
  attention_name: 'Martin Audesse',
  phone: '4183860213',
  email: 'martin@orisha.io',
  address_line: '220-1535 ch. Ste-Foy',
  city: 'Quebec',
  state: 'QC',
  postal_code: 'G1S2P1',
  country: 'CA',
}

// Code SH par défaut des produits Orisha (thermostat intelligent de serre) —
// identique à celui déjà déclaré dans les envois internationaux Novoxpress.
export const DEFAULT_HS_CODE = '9032.10.0030'

const COUNTRY_MAP = {
  canada: 'CA', ca: 'CA',
  'united states': 'US', 'etats-unis': 'US', 'états-unis': 'US', usa: 'US', us: 'US',
}

export function normalizeCountry(value) {
  if (!value) return 'CA'
  const key = String(value).trim().toLowerCase()
  return COUNTRY_MAP[key] || String(value).trim().toUpperCase().slice(0, 2)
}

// UPS collapse les tableaux à un seul élément en objet — tout parsing de
// réponse doit passer par ici sous peine de perdre l'unique élément.
export function asArray(v) {
  if (v == null) return []
  return Array.isArray(v) ? v : [v]
}

// UPS refuse les caractères non-ASCII dans les adresses (l'étiquette est
// imprimée en Latin-1) : « Québec » → « Quebec ».
export function asciiFold(s) {
  if (!s) return ''
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7E]/g, '').trim()
}

function digits10(...candidates) {
  for (const c of candidates) {
    const raw = String(c || '').replace(/\D/g, '')
    const n = raw.length === 11 && raw.startsWith('1') ? raw.slice(1) : raw
    if (n.length === 10) return n
  }
  return null
}

// `ctx` a la forme produite par buildReturnPartyContext() (returnContext.js) :
// company_name, address_line1/city/province/postal_code/country + contact.
export function buildCustomerParty(ctx) {
  const missing = []
  const country = normalizeCountry(ctx.address_country)
  const line1 = asciiFold((ctx.address_line1 || '').split('\n')[0]).slice(0, 35)
  const city = asciiFold(ctx.address_city).slice(0, 30)
  const postal = String(ctx.address_postal_code || '').replace(/\s/g, '').toUpperCase()
  const state = String(ctx.address_province || '').trim().toUpperCase().slice(0, 5)
  const phone = digits10(ctx.address_contact_phone, ctx.address_contact_mobile, ctx.company_phone)
  const email = ctx.address_contact_email || ctx.company_email || ''

  if (!line1) missing.push('adresse (rue)')
  if (!city) missing.push('ville')
  if (!postal) missing.push('code postal')
  if (!state) missing.push('province/état')
  if (!phone) missing.push('numéro de téléphone (10 chiffres)')
  if (missing.length) {
    throw new Error(
      `Coordonnées du client incomplètes — ${missing.join(', ')}. ` +
      `Complétez l'adresse et le contact rattachés au retour avant de créer l'étiquette UPS.`
    )
  }

  const attention = asciiFold(
    [ctx.address_contact_first_name, ctx.address_contact_last_name].filter(Boolean).join(' ')
  ).slice(0, 35)

  return {
    Name: asciiFold(ctx.company_name || 'Client').slice(0, 35) || 'Client',
    AttentionName: attention || asciiFold(ctx.company_name || 'Client').slice(0, 35),
    Phone: { Number: phone },
    ...(email ? { EMailAddress: email } : {}),
    Address: {
      AddressLine: [line1],
      City: city,
      StateProvinceCode: state,
      PostalCode: postal,
      CountryCode: country,
    },
  }
}

export function buildOrishaParty({ shipperNumber } = {}) {
  return {
    Name: ORISHA_WORKSHOP.name,
    AttentionName: ORISHA_WORKSHOP.attention_name,
    Phone: { Number: ORISHA_WORKSHOP.phone },
    EMailAddress: ORISHA_WORKSHOP.email,
    ...(shipperNumber ? { ShipperNumber: shipperNumber } : {}),
    Address: {
      AddressLine: [ORISHA_WORKSHOP.address_line],
      City: ORISHA_WORKSHOP.city,
      StateProvinceCode: ORISHA_WORKSHOP.state,
      PostalCode: ORISHA_WORKSHOP.postal_code,
      CountryCode: ORISHA_WORKSHOP.country,
    },
  }
}

// `packages` arrive au format ERP partagé avec Novoxpress :
// [{ quantity, weight, length, width, depth }] — `quantity` étant le nombre de
// boîtes IDENTIQUES. UPS veut une entrée par colis physique : on déplie.
//
// ⚠ Le type d'emballage ne porte PAS le même nom selon l'API UPS : la Shipping
// API attend `Package.Packaging`, la Rating API `Package.PackagingType`. Un
// `Packaging` envoyé à la Rating API est ignoré silencieusement, le type
// d'emballage est alors vide et UPS répond « [111212] The requested Package
// Type is unavailable for the selected service between the selected locations ».
// D'où le drapeau `forRating`.
export function buildPackages(packages, description = 'Return', { forRating = false } = {}) {
  const packagingKey = forRating ? 'PackagingType' : 'Packaging'
  const out = []
  for (const p of packages || []) {
    const qty = Math.max(1, parseInt(p.quantity, 10) || 1)
    const weight = Math.max(1, Math.ceil(parseFloat(p.weight) || 1))
    const dims = [p.length, p.width, p.depth].map(d => Math.max(1, Math.ceil(parseFloat(d) || 1)))
    for (let i = 0; i < qty; i++) {
      out.push({
        Description: asciiFold(description).slice(0, 35) || 'Return',
        [packagingKey]: { Code: '02' }, // 02 = colis fourni par le client
        Dimensions: {
          UnitOfMeasurement: { Code: 'IN' },
          Length: String(dims[0]), Width: String(dims[1]), Height: String(dims[2]),
        },
        PackageWeight: {
          UnitOfMeasurement: { Code: 'LBS' },
          Weight: String(weight),
        },
      })
    }
  }
  if (!out.length) throw new Error('Aucun colis décrit — poids et dimensions requis')
  return out
}

// Formulaire douanier minimal (facture commerciale) à partir des lignes de la
// commande / du retour : description, valeur, pays d'origine, code SH.
// `items` : [{ description, qty, unit_value, origin_country, hs_code }]
export function buildInternationalForms(items, { reasonForExport = 'RETURN', currency = 'CAD', invoiceDate = new Date() } = {}) {
  const products = (items || [])
    .filter(it => (parseInt(it.qty, 10) || 0) > 0 || (parseFloat(it.unit_value) || 0) > 0)
    .slice(0, 50)
    .map(it => ({
      Description: (asciiFold(it.description) || 'Greenhouse controller').slice(0, 35),
      Unit: {
        Number: String(Math.max(1, parseInt(it.qty, 10) || 1)),
        UnitOfMeasurement: { Code: 'PCS' },
        Value: (Math.max(1, parseFloat(it.unit_value) || 1)).toFixed(2),
      },
      OriginCountryCode: normalizeCountry(it.origin_country || 'CA'),
      CommodityCode: String(it.hs_code || DEFAULT_HS_CODE).replace(/\./g, ''),
    }))

  if (!products.length) {
    products.push({
      Description: 'Greenhouse controller',
      Unit: { Number: '1', UnitOfMeasurement: { Code: 'PCS' }, Value: '1.00' },
      OriginCountryCode: 'CA',
      CommodityCode: DEFAULT_HS_CODE.replace(/\./g, ''),
    })
  }

  const d = invoiceDate instanceof Date ? invoiceDate : new Date(invoiceDate)
  const yyyymmdd = `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`

  return {
    FormType: '01', // 01 = facture commerciale
    InvoiceDate: yyyymmdd,
    ReasonForExport: reasonForExport,
    CurrencyCode: currency,
    Product: products,
  }
}

export function customsTotal(items) {
  return (items || []).reduce(
    (sum, it) => sum + (parseFloat(it.unit_value) || 0) * (parseInt(it.qty, 10) || 1),
    0
  )
}

// Étiquette de RETOUR : le client expédie (ShipFrom), l'atelier d'Orisha reçoit
// (ShipTo), le compte d'Orisha paie (Shipper + BillShipper). ReturnService code
// 9 = « Print Return Label » — UPS renvoie l'image de l'étiquette, à joindre au
// courriel du client (contrairement au code 8 où UPS l'envoie lui-même).
export function buildReturnShipmentRequest(ctx, {
  accountNumber,
  packages,
  serviceCode = '11',
  description = 'Retour de marchandise',
  customsItems = null,
  currency = 'CAD',
} = {}) {
  if (!accountNumber) throw new Error('Numéro de compte UPS manquant (page Connecteurs)')
  const customer = buildCustomerParty(ctx)
  const orisha = buildOrishaParty({ shipperNumber: accountNumber })

  const shipment = {
    Description: asciiFold(description).slice(0, 50) || 'Return',
    ReturnService: { Code: '9' },
    Shipper: orisha,
    ShipTo: buildOrishaParty(),
    ShipFrom: customer,
    PaymentInformation: {
      ShipmentCharge: { Type: '01', BillShipper: { AccountNumber: accountNumber } },
    },
    Service: { Code: String(serviceCode) },
    Package: buildPackages(packages, description),
  }

  // International (client hors Canada) : facture commerciale obligatoire, sinon
  // le colis est bloqué à la frontière.
  if (customer.Address.CountryCode !== ORISHA_WORKSHOP.country) {
    shipment.ShipmentServiceOptions = {
      InternationalForms: buildInternationalForms(customsItems, { reasonForExport: 'RETURN', currency }),
    }
    shipment.InvoiceLineTotal = {
      CurrencyCode: currency,
      MonetaryValue: Math.max(1, Math.round(customsTotal(customsItems))).toFixed(2),
    }
  }

  return {
    ShipmentRequest: {
      Request: { RequestOption: 'nonvalidate', TransactionReference: { CustomerContext: 'ERP Orisha — étiquette de retour' } },
      Shipment: shipment,
      LabelSpecification: {
        LabelImageFormat: { Code: 'GIF' },
        LabelStockSize: { Height: '6', Width: '4' },
        HTTPUserAgent: 'Mozilla/4.5',
      },
    },
  }
}

// Comparaison de tarifs. Deux sens :
//  • sortant (défaut) : Orisha → client ;
//  • `inbound: true` (retour) : client → atelier d'Orisha, comme l'étiquette de
//    retour — sans quoi le tarif comparé ne serait pas celui du bon trajet.
// Dans les deux cas le compte d'Orisha reste le Shipper (c'est lui qui paie).
// `negotiatedRates` : demande les tarifs du contrat Orisha plutôt que les tarifs
// publics. Un compte sans entente négociée peut faire échouer la requête — d'où
// la possibilité de rebâtir le payload sans (cf. services/ups.js).
export function buildRateRequest(ctx, {
  accountNumber, packages, currency = 'CAD', customsItems = null, negotiatedRates = true, inbound = false,
} = {}) {
  const customer = buildCustomerParty(ctx)
  const orisha = buildOrishaParty({ shipperNumber: accountNumber })
  const shipment = {
    Shipper: orisha,
    ShipTo: inbound ? buildOrishaParty() : customer,
    ShipFrom: inbound ? customer : buildOrishaParty(),
    Package: buildPackages(packages, inbound ? 'Retour' : 'Envoi', { forRating: true }),
    ...(negotiatedRates && accountNumber
      ? { ShipmentRatingOptions: { NegotiatedRatesIndicator: 'Y' } }
      : {}),
  }
  // Envoi vers les US : la valeur déclarée conditionne le tarif ET la
  // déclaration douanière — on la calcule depuis les lignes de la commande.
  if (customer.Address.CountryCode !== ORISHA_WORKSHOP.country) {
    shipment.InvoiceLineTotal = {
      CurrencyCode: currency,
      MonetaryValue: Math.max(1, Math.round(customsTotal(customsItems))).toFixed(2),
    }
  }
  return {
    RateRequest: {
      Request: { RequestOption: 'Shop', TransactionReference: { CustomerContext: 'ERP Orisha — comparaison de tarifs' } },
      Shipment: shipment,
    },
  }
}

// Noms lisibles des services UPS retournés par la Rating API (codes canadiens
// et internationaux réellement possibles depuis le Québec).
export const UPS_SERVICE_NAMES = {
  '01': 'UPS Next Day Air',
  '02': 'UPS 2nd Day Air',
  '03': 'UPS Ground',
  '07': 'UPS Worldwide Express',
  '08': 'UPS Worldwide Expedited',
  '11': 'UPS Standard',
  '12': 'UPS 3 Day Select',
  '13': 'UPS Next Day Air Saver',
  '14': 'UPS Next Day Air Early',
  '54': 'UPS Worldwide Express Plus',
  '59': 'UPS 2nd Day Air A.M.',
  '65': 'UPS Worldwide Saver',
  '82': 'UPS Today Standard',
  '83': 'UPS Today Dedicated Courier',
  '85': 'UPS Today Express',
  '86': 'UPS Today Express Saver',
}

export function serviceName(code, fallback) {
  return UPS_SERVICE_NAMES[String(code)] || fallback || `Service UPS ${code}`
}

// Normalise la réponse Rating vers la même forme que les tarifs Novoxpress
// (service_id / service_name / carrier_name / total) pour que l'UI réutilise
// fmtPrice / getRateName sans adaptateur.
export function parseRates(response) {
  return asArray(response?.RateResponse?.RatedShipment)
    .map(r => {
      const code = r?.Service?.Code
      const charge = r?.NegotiatedRateCharges?.TotalCharge || r?.TotalCharges || {}
      return {
        service_id: String(code || ''),
        service_name: serviceName(code, r?.Service?.Description),
        carrier_name: 'UPS',
        total: {
          value: charge.MonetaryValue != null ? String(charge.MonetaryValue) : null,
          currency: charge.CurrencyCode || 'CAD',
        },
        total_transit_day: r?.GuaranteedDelivery?.BusinessDaysInTransit != null
          ? Number(r.GuaranteedDelivery.BusinessDaysInTransit)
          : null,
        negotiated: !!r?.NegotiatedRateCharges,
      }
    })
    .filter(r => r.total.value != null)
    .sort((a, b) => parseFloat(a.total.value) - parseFloat(b.total.value))
}

// Résultat d'un achat d'étiquette : identifiant d'expédition, suivi, coût et
// image base64 de l'étiquette.
export function parseShipmentResults(response) {
  const results = response?.ShipmentResponse?.ShipmentResults || {}
  const pkgs = asArray(results.PackageResults)
  const first = pkgs[0] || {}
  const charges = results.NegotiatedRateCharges?.TotalCharge || results.ShipmentCharges?.TotalCharges || {}
  return {
    shipment_id: results.ShipmentIdentificationNumber || null,
    tracking_number: first.TrackingNumber || results.ShipmentIdentificationNumber || null,
    cost: charges.MonetaryValue != null ? parseFloat(charges.MonetaryValue) : null,
    currency: charges.CurrencyCode || null,
    label_base64: first.ShippingLabel?.GraphicImage || null,
    label_format: (first.ShippingLabel?.ImageFormat?.Code || 'GIF').toUpperCase(),
  }
}

// UPS date/heure de suivi : 'YYYYMMDD' + 'HHMMSS' locales au lieu de passage.
// Faute de fuseau fourni, on les interprète en UTC — mieux vaut un décalage
// horaire connu qu'une date naïve sans Z (cf. CLAUDE.md, datetimes ISO UTC).
export function parseUpsDateTime(date, time) {
  if (!date || !/^\d{8}$/.test(String(date))) return null
  const t = /^\d{6}$/.test(String(time || '')) ? String(time) : '000000'
  const iso = `${String(date).slice(0, 4)}-${String(date).slice(4, 6)}-${String(date).slice(6, 8)}` +
    `T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}.000Z`
  const d = new Date(iso)
  return isNaN(d.getTime()) ? null : d.toISOString()
}

export function parseTracking(response) {
  const shipment = asArray(response?.trackResponse?.shipment)[0] || {}
  const pkg = asArray(shipment.package)[0] || {}
  const activities = asArray(pkg.activity)
  const latest = activities[0] || {}
  const current = asArray(pkg.currentStatus)[0] || pkg.currentStatus || {}
  const loc = latest?.location?.address || {}
  const place = [loc.city, loc.stateProvince, loc.countryCode].filter(Boolean).join(', ')
  const statusText = current.description || latest?.status?.description || null
  const delivery = asArray(pkg.deliveryDate)[0] || {}

  return {
    tracking_number: pkg.trackingNumber || null,
    status: statusText,
    status_code: current.code || latest?.status?.code || null,
    activity_at: parseUpsDateTime(latest.date, latest.time),
    last_activity: [statusText, place].filter(Boolean).join(' — ') || null,
    delivery_date: delivery.date ? parseUpsDateTime(delivery.date, '000000') : null,
    activities: activities.slice(0, 10).map(a => ({
      status: a?.status?.description || null,
      at: parseUpsDateTime(a.date, a.time),
      location: [a?.location?.address?.city, a?.location?.address?.stateProvince].filter(Boolean).join(', ') || null,
    })),
  }
}
