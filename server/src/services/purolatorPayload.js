// Construction des enveloppes SOAP Purolator (E-Ship Web Services v2) et
// lecture des réponses — fonctions PURES (aucun accès réseau ni DB), pour
// rester testables isolément (cf. purolatorPayload.test.js). Miroir de
// upsPayload.js pour la forme, adapté au SOAP/XML de Purolator plutôt qu'au
// JSON de UPS/Novoxpress.
//
// ⚠️ IMPORTANT — non vérifié en direct : ces enveloppes suivent le schéma PWS
// v2 documenté par Purolator (Estimating/Shipping/Tracking Services), mais
// aucun appel réel n'a pu être fait faute d'identifiants (PUROLATOR_KEY/
// PUROLATOR_PASSWORD/PUROLATOR_ACCOUNT — demandés à l'utilisateur, jamais
// écrits dans .env sans confirmation). À valider contre l'environnement de
// développement Purolator (devwebservices.purolator.com) dès que les
// identifiants sont disponibles, avant toute utilisation en production —
// même précédent que le connecteur DigiKey (services/digikey.js).

import { XMLParser } from 'fast-xml-parser'

const parser = new XMLParser({ removeNSPrefix: true, ignoreAttributes: true, parseTagValue: false })

export function parseXml(xml) {
  return parser.parse(xml)
}

// Purolator (comme UPS) collapse les tableaux à un seul élément en objet nu —
// tout parsing de réponse doit passer par ici sous peine de perdre l'unique élément.
export function asArray(v) {
  if (v == null) return []
  return Array.isArray(v) ? v : [v]
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

// Atelier Orisha — expéditeur fixe de tout envoi sortant. Même source de
// vérité conceptuelle que SENDER (novoxpress.js) / ORISHA_WORKSHOP
// (upsPayload.js), dupliquée en forme Purolator : son schéma d'adresse exige
// StreetNumber et StreetName SÉPARÉS (contrairement à UPS/Novoxpress qui
// acceptent une ligne d'adresse unique).
export const PUROLATOR_SENDER = {
  companyName: 'Automatisation Orisha Inc.',
  contactName: 'Martin Audesse',
  email: 'martin@orisha.io',
  phone: '4183860213',
  streetNumber: '1535',
  streetName: 'ch. Ste-Foy',
  suite: '220',
  city: 'Québec',
  province: 'QC',
  country: 'CA',
  postalCode: 'G1S2P1',
}

// Sépare une ligne d'adresse "123 rue Exemple" en numéro civique + reste — le
// schéma Purolator veut les deux séparément. Reste tel quel (StreetNumber
// vide) si aucun numéro en tête, plutôt que de deviner faux.
export function splitStreetAddress(line1) {
  const s = String(line1 || '').split('\n')[0].trim()
  const m = s.match(/^(\d+(?:-\d+)?[A-Za-z]?)\s+(.*)$/)
  if (m) return { streetNumber: m[1], streetName: m[2].slice(0, 44) }
  return { streetNumber: '', streetName: s.slice(0, 44) }
}

function digits10(...candidates) {
  for (const c of candidates) {
    const raw = String(c || '').replace(/\D/g, '')
    const n = raw.length === 11 && raw.startsWith('1') ? raw.slice(1) : raw
    if (n.length === 10) return n
  }
  return null
}

const COUNTRY_MAP = {
  canada: 'CA', ca: 'CA',
  'united states': 'US', 'etats-unis': 'US', 'états-unis': 'US', usa: 'US', us: 'US',
}
export function normalizeCountry(value) {
  if (!value) return 'CA'
  const key = String(value).trim().toLowerCase()
  return COUNTRY_MAP[key] || String(value).trim().toUpperCase().slice(0, 2)
}

// `ctx` a la forme produite par la requête SQL des routes (shipment + adresse
// + contact rattaché) — mêmes noms de colonnes que novoxpress.js/ups.js.
export function buildRecipientParty(ctx) {
  const missing = []
  const { streetNumber, streetName } = splitStreetAddress(ctx.address_line1)
  const city = String(ctx.address_city || '').trim()
  const province = String(ctx.address_province || '').trim().toUpperCase().slice(0, 2)
  const postalCode = String(ctx.address_postal_code || '').replace(/\s/g, '').toUpperCase()
  const country = normalizeCountry(ctx.address_country)
  const phone = digits10(ctx.address_contact_phone, ctx.address_contact_mobile, ctx.company_phone)
  const email = ctx.address_contact_email || ctx.company_email || ''

  if (!streetName) missing.push('adresse (rue)')
  if (!city) missing.push('ville')
  if (!postalCode) missing.push('code postal')
  if (country === 'CA' && !province) missing.push('province')
  if (!phone) missing.push('numéro de téléphone (10 chiffres)')
  if (missing.length) {
    throw new Error(
      `Coordonnées du destinataire incomplètes — ${missing.join(', ')}. ` +
      `Complétez l'adresse et le contact rattachés à l'envoi avant de tarifer/créer l'étiquette Purolator.`
    )
  }

  const contactName = [ctx.address_contact_first_name, ctx.address_contact_last_name].filter(Boolean).join(' ').trim()

  return {
    companyName: ctx.company_name || 'Client',
    contactName: contactName || ctx.company_name || 'Client',
    email,
    phone,
    streetNumber,
    streetName,
    city,
    province,
    country,
    postalCode,
  }
}

function partyXml(tag, p) {
  return `<${tag}>
    <Name>${esc(p.companyName)}</Name>
    <Address>
      <StreetNumber>${esc(p.streetNumber)}</StreetNumber>
      <StreetName>${esc(p.streetName)}</StreetName>
      ${p.suite ? `<Suite>${esc(p.suite)}</Suite>` : ''}
      <City>${esc(p.city)}</City>
      <Province>${esc(p.province)}</Province>
      <Country>${esc(p.country)}</Country>
      <PostalCode>${esc(p.postalCode)}</PostalCode>
    </Address>
    <ContactInformation>
      <PersonName>${esc(p.contactName)}</PersonName>
      ${p.phone ? `<Phone><CountryCode>1</CountryCode><AreaCode>${esc(p.phone.slice(0, 3))}</AreaCode><Phone>${esc(p.phone.slice(3))}</Phone></Phone>` : ''}
      ${p.email ? `<Email>${esc(p.email)}</Email>` : ''}
    </ContactInformation>
  </${tag}>`
}

// `packages` arrive au format ERP partagé avec Novoxpress/UPS :
// [{ quantity, weight, length, width, depth }]. Leçon apprise sur Novoxpress
// (cf. services/novoxpress.js) : dimensions ENTIÈRES obligatoires, poids
// minimum ≥ 1 — Purolator a la même contrainte de piste (pas de décimales).
export function buildPackageInformation(packages, serviceId) {
  const pieces = []
  for (const p of packages || []) {
    const qty = Math.max(1, parseInt(p.quantity, 10) || 1)
    const weight = Math.max(1, Math.ceil(parseFloat(p.weight) || 1))
    const length = Math.max(1, Math.ceil(parseFloat(p.length) || 1))
    const width = Math.max(1, Math.ceil(parseFloat(p.width) || 1))
    const height = Math.max(1, Math.ceil(parseFloat(p.depth) || 1))
    for (let i = 0; i < qty; i++) pieces.push({ weight, length, width, height })
  }
  if (!pieces.length) throw new Error('Aucun colis décrit — poids et dimensions requis')
  const totalWeight = pieces.reduce((s, p) => s + p.weight, 0)

  return {
    xml: `<PackageInformation>
      <ServiceID>${esc(serviceId || '')}</ServiceID>
      <TotalWeight><Value>${totalWeight}</Value><WeightUnit>lb</WeightUnit></TotalWeight>
      <TotalPieces>${pieces.length}</TotalPieces>
      <PiecesInformation>
        ${pieces.map(p => `<PieceInformation>
          <Weight>${p.weight}</Weight>
          <Length>${p.length}</Length>
          <Width>${p.width}</Width>
          <Height>${p.height}</Height>
        </PieceInformation>`).join('')}
      </PiecesInformation>
      <DimensionUnit>in</DimensionUnit>
    </PackageInformation>`,
    totalWeight,
    pieceCount: pieces.length,
  }
}

// En-tête RequestContext (SOAP Header) commun aux 3 services PWS.
function requestContextXml(reference) {
  return `<RequestContext xmlns="http://purolator.com/pws/datatypes/v2">
    <Version>2.0</Version>
    <Language>en</Language>
    <GroupID></GroupID>
    <RequestReference>${esc(reference || 'erp-orisha')}</RequestReference>
  </RequestContext>`
}

function envelope(bodyXml, reference) {
  return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">
  <soap:Header>${requestContextXml(reference)}</soap:Header>
  <soap:Body>${bodyXml}</soap:Body>
</soap:Envelope>`
}

// ── Estimating Service — GetFullEstimate ────────────────────────────────────
export function buildEstimateRequest(ctx, { packages, accountNumber } = {}) {
  const recipient = buildRecipientParty(ctx)
  const pkg = buildPackageInformation(packages)
  const body = `<GetFullEstimateRequest xmlns="http://purolator.com/pws/service/v2">
    <Shipment>
      ${partyXml('SenderInformation', { ...PUROLATOR_SENDER })}
      ${partyXml('ReceiverInformation', recipient)}
      ${pkg.xml}
      <PaymentInformation>
        <PaymentType>Sender</PaymentType>
        <RegisteredAccountNumber>${esc(accountNumber)}</RegisteredAccountNumber>
      </PaymentInformation>
    </Shipment>
  </GetFullEstimateRequest>`
  return { xml: envelope(body, 'erp-orisha-estimate'), recipient, packageInfo: pkg }
}

function extractErrors(parsed) {
  const body = parsed?.Envelope?.Body || {}
  const respWrapper = Object.values(body).find(v => v && typeof v === 'object') || {}
  const errs = asArray(respWrapper?.ResponseInformation?.Errors?.Error)
  return errs.map(e => ({ code: e?.Code || null, description: e?.Description || String(e) }))
}

export function describePurolatorError(context, errors, rawXml) {
  if (errors?.length) {
    return `Purolator ${context} : ${errors.map(e => `${e.code ? `[${e.code}] ` : ''}${e.description}`).join(' · ')}`
  }
  const trimmed = String(rawXml || '').slice(0, 800)
  return `Purolator ${context} : réponse inattendue — ${trimmed || 'vide'}`
}

const SERVICE_NAMES = {
  PurolatorExpress: 'Purolator Express',
  PurolatorExpress9AM: 'Purolator Express 9AM',
  PurolatorExpress1030AM: 'Purolator Express 10:30AM',
  PurolatorGround: 'Purolator Ground',
  PurolatorGround9AM: 'Purolator Ground 9AM',
  PurolatorGround1030AM: 'Purolator Ground 10:30AM',
  PurolatorExpressU9600AM: 'Purolator Express U.S. 9:00AM',
  PurolatorExpressU: 'Purolator Express U.S.',
  PurolatorGroundU: 'Purolator Ground U.S.',
}
export function serviceName(id) {
  return SERVICE_NAMES[id] || id || 'Service Purolator'
}

// Normalise vers la même forme que les tarifs Novoxpress/UPS (service_id /
// service_name / carrier_name / total) pour que l'UI réutilise fmtPrice /
// getRateName sans adaptateur (cf. novoxpressShared.jsx).
export function parseEstimateResponse(xml) {
  const parsed = parseXml(xml)
  const errors = extractErrors(parsed)
  if (errors.length) return { rates: [], errors, raw: parsed }

  const resp = parsed?.Envelope?.Body?.GetFullEstimateResponse || {}
  const estimates = asArray(resp?.ShipmentEstimates?.ShipmentEstimate)
  const rates = estimates.map(e => ({
    service_id: e?.ServiceID || '',
    service_name: serviceName(e?.ServiceID),
    carrier_name: 'Purolator',
    total: {
      value: e?.TotalPrice != null ? String(e.TotalPrice) : null,
      currency: 'CAD',
    },
    total_transit_day: e?.EstimatedTransitDays != null ? Number(e.EstimatedTransitDays) : null,
    expected_delivery_date: e?.ExpectedDeliveryDate || null,
  })).filter(r => r.service_id)

  return { rates, errors: [], raw: parsed }
}

// ── Shipping Service — CreateShipment ───────────────────────────────────────
export function buildCreateShipmentRequest(ctx, { packages, serviceId, accountNumber, erpShipmentId } = {}) {
  if (!serviceId) throw new Error('service_id Purolator requis')
  const recipient = buildRecipientParty(ctx)
  const pkg = buildPackageInformation(packages, serviceId)
  const body = `<CreateShipmentRequest xmlns="http://purolator.com/pws/service/v2">
    <Shipment>
      ${partyXml('SenderInformation', { ...PUROLATOR_SENDER })}
      ${partyXml('ReceiverInformation', recipient)}
      ${pkg.xml}
      <PaymentInformation>
        <PaymentType>Sender</PaymentType>
        <RegisteredAccountNumber>${esc(accountNumber)}</RegisteredAccountNumber>
      </PaymentInformation>
      <PickupInformation><PickupType>DropOff</PickupType></PickupInformation>
      <TrackingReferenceInformation>
        <Reference1>${esc(erpShipmentId || '')}</Reference1>
      </TrackingReferenceInformation>
    </Shipment>
    <PrinterType>Regular</PrinterType>
  </CreateShipmentRequest>`
  return { xml: envelope(body, `erp-orisha-shipment-${erpShipmentId || ''}`), recipient, packageInfo: pkg }
}

export function parseCreateShipmentResponse(xml) {
  const parsed = parseXml(xml)
  const errors = extractErrors(parsed)
  if (errors.length) return { shipmentPin: null, piecePins: [], errors, raw: parsed }

  const resp = parsed?.Envelope?.Body?.CreateShipmentResponse || {}
  const shipmentPin = resp?.ShipmentPIN?.Value || null
  const piecePins = asArray(resp?.PiecePINs?.PiecePIN).map(p => p?.PIN?.Value || p?.Value).filter(Boolean)
  return { shipmentPin, piecePins, errors: [], raw: parsed }
}

// ── Shipping Documents Service — GetDocuments ───────────────────────────────
// Récupère le PDF d'étiquette d'un envoi DÉJÀ créé (achat fait) — séparé de
// CreateShipment pour pouvoir réessayer le téléchargement sans re-facturer
// (même précaution que Novoxpress, cf. services/novoxpress.js fetchAndSaveLabelPdf).
export function buildGetDocumentsRequest(shipmentPin) {
  const body = `<GetDocumentsRequest xmlns="http://purolator.com/pws/service/v2">
    <DocumentCriterium>
      <DocumentCriteria>
        <PIN><Value>${esc(shipmentPin)}</Value></PIN>
        <DocumentTypes><DocumentType>Label</DocumentType></DocumentTypes>
      </DocumentCriteria>
    </DocumentCriterium>
    <OutputType>PDF</OutputType>
    <Synchronous>true</Synchronous>
  </GetDocumentsRequest>`
  return envelope(body, `erp-orisha-documents-${shipmentPin}`)
}

export function parseGetDocumentsResponse(xml) {
  const parsed = parseXml(xml)
  const errors = extractErrors(parsed)
  if (errors.length) return { base64: null, errors, raw: parsed }

  const resp = parsed?.Envelope?.Body?.GetDocumentsResponse || {}
  const details = asArray(resp?.DocumentDetails?.DocumentDetail)
  const first = details[0] || {}
  const base64 = first?.Data || null
  return { base64, errors: [], raw: parsed }
}

// ── Tracking Service — TrackPackagesByPin ───────────────────────────────────
export function buildTrackingRequest(pin) {
  const body = `<TrackPackagesByPinRequest xmlns="http://purolator.com/pws/service/v2">
    <PINs><PIN><Value>${esc(pin)}</Value></PIN></PINs>
  </TrackPackagesByPinRequest>`
  return envelope(body, `erp-orisha-tracking-${pin}`)
}

// Statuts Purolator considérés « livré » — la tournée horaire de suivi
// (services/purolator.js → refreshPurolatorTracking) arrête de raffraîchir un
// envoi une fois ce statut atteint.
export const DELIVERED_STATUSES = ['Delivered', 'Livré']

export function parseTrackingResponse(xml) {
  const parsed = parseXml(xml)
  const errors = extractErrors(parsed)
  if (errors.length) return { status: null, lastActivity: null, delivered: false, errors, raw: parsed }

  const resp = parsed?.Envelope?.Body?.TrackPackagesByPinResponse || {}
  const info = asArray(resp?.TrackingInformationList?.TrackingInformation)[0] || {}
  const scans = asArray(info?.Scans?.Scan)
  // Le dernier scan chronologique est en général le premier de la liste
  // renvoyée par Purolator — on garde l'ordre tel quel sans réordonner en
  // l'absence d'un appel réel pour vérifier cette hypothèse.
  const latest = scans[0] || {}
  const statusText = latest?.Description || info?.CurrentStatus || null
  const place = [latest?.City, latest?.Province].filter(Boolean).join(', ')

  return {
    status: statusText,
    last_activity: [statusText, place].filter(Boolean).join(' — ') || null,
    activity_at: latest?.Date || null,
    delivered: DELIVERED_STATUSES.some(s => String(statusText || '').toLowerCase().includes(s.toLowerCase())),
    errors: [],
    raw: parsed,
  }
}
