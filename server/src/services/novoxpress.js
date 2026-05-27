import db from '../db/database.js'
import path from 'path'
import fs from 'fs'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BASE_URL = 'https://api.novoxpress.ca/prod'
const LABELS_DIR = path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'labels')

// In-memory JWT cache
let tokenCache = null

export function isNovoxpressConfigured() {
  const row = db.prepare(
    "SELECT value FROM connector_config WHERE connector='novoxpress' AND key='username'"
  ).get()
  return !!row?.value
}

function getCredentials() {
  const get = key => db.prepare(
    "SELECT value FROM connector_config WHERE connector='novoxpress' AND key=?"
  ).get(key)?.value
  return { username: get('username'), password: get('password') }
}

async function fetchNewToken(username, password) {
  const res = await fetch(`${BASE_URL}/auth/get-token`, {
    method: 'POST',
    headers: { username, password }
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Authentification Novoxpress échouée (${res.status}): ${text}`)
  }
  const data = await res.json()
  // Response wrapped in { response: { token, refresh_token } }
  return data.response || data
}

async function getToken() {
  if (tokenCache && tokenCache.expires_at > Date.now() + 5 * 60 * 1000) return tokenCache.jwt_token

  // Try refresh
  if (tokenCache?.refresh_token) {
    try {
      const res = await fetch(`${BASE_URL}/auth/refresh-token?refresh_token=${encodeURIComponent(tokenCache.refresh_token)}`)
      if (res.ok) {
        const raw = await res.json()
        const data = raw.response || raw
        tokenCache = { jwt_token: data.token || data.jwt_token, refresh_token: data.refresh_token, expires_at: Date.now() + 55 * 60 * 1000 }
        return tokenCache.jwt_token
      }
    } catch { /* fall through to full auth */ }
  }

  const { username, password } = getCredentials()
  if (!username || !password) throw new Error('Novoxpress non configuré')
  const data = await fetchNewToken(username, password)
  // Field is "token" not "jwt_token"
  tokenCache = { jwt_token: data.token || data.jwt_token, refresh_token: data.refresh_token, expires_at: Date.now() + 55 * 60 * 1000 }
  return tokenCache.jwt_token
}

export function clearTokenCache() {
  tokenCache = null
}

async function apiPost(endpoint, body) {
  const token = await getToken()
  const res = await fetch(`${BASE_URL}${endpoint}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const text = await res.text()
    const err = new Error(`Novoxpress ${endpoint} (${res.status}): ${text}`)
    err.status = res.status
    err.responseBody = text
    err.sentPayload = body
    throw err
  }
  return res.json()
}

// Fixed sender — Automatisation Orisha Inc.
const SENDER = {
  company_name: 'Automatisation Orisha Inc.',
  contact_name: 'Martin Audesse',
  email_address: 'martin@orisha.io',
  address: {
    street_address: '220-1535 ch. Ste-Foy',
    city: 'Québec',
    region: 'QC',
    country: 'CA',
    postal_code: 'G1S2P1',
    phone_code: '1',
    phone_number: '4183860213'
  },
  residential: false
}

// Liste des provinces (FR + EN) pour stripper le nom de province quand on
// parse une adresse legacy multi-lignes type Airtable.
const PROVINCE_NAMES = [
  'Québec', 'Quebec', 'Ontario', 'Alberta', 'Manitoba', 'Saskatchewan',
  'Nouveau-Brunswick', 'New Brunswick', 'Nouvelle-Écosse', 'Nova Scotia',
  'Terre-Neuve-et-Labrador', 'Newfoundland and Labrador', 'Newfoundland',
  'Île-du-Prince-Édouard', 'Prince Edward Island',
  'Colombie-Britannique', 'British Columbia',
  'Yukon', 'Territoires du Nord-Ouest', 'Northwest Territories', 'Nunavut',
]

// Parse une adresse Airtable de type "Rue\nVille Province QC postal CA"
// (line1 multi-lignes) et renvoie { street, city }. Retourne null si line1
// n'a pas de structure multi-lignes (cas normal, on retombe sur les colonnes).
function parseAddressFromLine1(line1) {
  if (!line1 || !line1.includes('\n')) return null
  const lines = line1.split('\n').map(s => s.trim()).filter(Boolean)
  if (lines.length < 2) return null
  const street = lines[0]
  let rest = lines.slice(1).join(' ').trim()
  // Strip pays
  rest = rest.replace(/\s+(CA|US|Canada|United States|États-Unis)$/i, '').trim()
  // Strip code postal CA (A1A 1A1 / A1A1A1) puis US (12345 / 12345-6789)
  rest = rest.replace(/\s+[A-Za-z]\d[A-Za-z]\s*\d[A-Za-z]\d$/, '').trim()
  rest = rest.replace(/\s+\d{5}(-\d{4})?$/, '').trim()
  // Strip code province (QC, ON, …)
  rest = rest.replace(/\s+(QC|ON|AB|MB|SK|NB|NS|NL|PE|BC|YT|NT|NU)$/i, '').trim()
  // Strip nom de province (Québec, Ontario, …)
  for (const prov of PROVINCE_NAMES) {
    const lcRest = rest.toLowerCase()
    const lcProv = ' ' + prov.toLowerCase()
    if (lcRest.endsWith(lcProv)) {
      rest = rest.slice(0, rest.length - prov.length).trim()
      break
    }
  }
  return { street, city: rest }
}

function extractStreet(line1, city) {
  if (!line1) return ''
  // Cas 1 — line1 multi-lignes (legacy Airtable) : la 1ère ligne EST la rue.
  if (line1.includes('\n')) {
    return line1.split('\n')[0].trim().slice(0, 35)
  }
  // Cas 2 — line1 concaténée single-line "123 rue X Ville QC H1H1H1 CA" :
  // on coupe au nom de ville (si présent dans line1).
  if (city) {
    const idx = line1.indexOf(city)
    if (idx > 0) return line1.slice(0, idx).trim().slice(0, 35)
  }
  return line1.slice(0, 35).trim()
}

// Novoxpress sérialise nos chaînes JSON directement dans le XML envoyé à
// Canada Post (et probablement aux autres transporteurs). Sans échappement,
// un `&` dans un nom (ex. « Ferme L&C Charlebois ») est interprété comme le
// début d'une entité XML et casse le parsing côté Canada Post avec
// "illegal character ' '". On neutralise les 3 chars XML-spéciaux qui peuvent
// apparaître dans des noms réels (entreprise, contact, rue) en les remplaçant
// par des équivalents lisibles plutôt qu'en cassant le rendu de l'étiquette.
function sanitizeXmlText(s) {
  if (!s) return s
  return String(s)
    // « L&C » → « L et C » (espaces préservés pour lisibilité sur l'étiquette)
    .replace(/\s*&\s*/g, ' et ')
    .replace(/[<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function buildRecipient(shipment) {
  // Préférence : contact rattaché à l'adresse > company (le contact est le
  // destinataire physique du colis, ses coordonnées sont les bonnes).
  const rawEmail = shipment.address_contact_email || shipment.company_email || ''
  const rawPhoneSource = shipment.address_contact_phone || shipment.address_contact_mobile || shipment.company_phone || ''
  const raw = rawPhoneSource.replace(/\D/g, '')
  const phone = raw.length === 11 && raw.startsWith('1') ? raw.slice(1) : raw

  // Validation — Novoxpress exige un courriel et un numéro de 10 chiffres
  // valides. Avant on injectait silencieusement '5550000000', ce qui causait
  // des étiquettes avec de fausses coordonnées. Maintenant on lève une erreur
  // claire pour que l'utilisateur corrige la fiche contact/company.
  const missing = []
  if (!rawEmail) missing.push('courriel')
  if (phone.length !== 10) missing.push('numéro de téléphone (10 chiffres)')
  if (missing.length) {
    throw new Error(
      `Coordonnées du destinataire manquantes — ${missing.join(' et ')}. ` +
      `Ajoutez ${missing.join(' et ')} sur le contact rattaché à l'adresse de livraison ` +
      `(ou à défaut sur la fiche entreprise « ${shipment.company_name || 'Client'} ») avant d'acheter l'étiquette.`
    )
  }

  // Normalize country to 2-letter code
  const countryMap = { 'Canada': 'CA', 'United States': 'US', 'États-Unis': 'US' }
  const country = countryMap[shipment.address_country] || shipment.address_country || 'CA'

  // Si line1 est multi-lignes, on en extrait street + city ; sinon on retombe
  // sur les colonnes structurées. La ville parsée bat la colonne dans ce cas,
  // car les imports legacy Airtable mettent souvent la province dans `city`.
  const parsed = parseAddressFromLine1(shipment.address_line1)
  const street = extractStreet(shipment.address_line1, shipment.address_city)
  const city = parsed?.city || shipment.address_city || ''

  return {
    company_name: sanitizeXmlText(shipment.company_name || 'Client').slice(0, 30),
    email_address: rawEmail,
    address: {
      street_address: sanitizeXmlText(street).slice(0, 35),
      city: sanitizeXmlText(city).slice(0, 35),
      region: shipment.address_province || '',
      country,
      postal_code: (shipment.address_postal_code || '').replace(/\s/g, ''),
      phone_code: '1',
      phone_number: phone
    },
    residential: false
  }
}

function buildPayload(shipment, packaging_type, packages, declaredValue = '100') {
  return {
    sender: SENDER,
    recipient: buildRecipient(shipment),
    payment_type: 'Sender',
    packaging_type: packaging_type || 'package',
    packaging_properties: { packages, weight: { unit: 'lb' } },
    additional_options: { declared_value: declaredValue, signature_option: 'SNR' }
  }
}

// Transporteurs masqués côté UI/sélection. Ajouter ici pour exclure d'autres
// services à l'avenir (préfèrence opérationnelle Orisha).
const HIDDEN_CARRIERS = ['gls']

function isHiddenCarrier(rate) {
  const c = String(rate.carrier_name || rate.carrier || '').toLowerCase()
  return HIDDEN_CARRIERS.some(h => c.includes(h))
}

export async function getRates(shipment, { packaging_type, packages, declared_value }) {
  const payload = buildPayload(shipment, packaging_type, packages, declared_value || '100')
  let data
  try {
    data = await apiPost('/services/rate-estimate', payload)
  } catch (e) {
    if (!e.sentPayload) e.sentPayload = payload
    throw e
  }
  const rates = (data.ratelist || [])
    .filter(r => !isHiddenCarrier(r))
    .sort((a, b) => parseFloat(a.total?.value ?? 0) - parseFloat(b.total?.value ?? 0))
  // Inclut la réponse brute (hors ratelist déjà extrait) + le payload envoyé,
  // pour permettre au client d'afficher warnings/erreurs/diagnostics Novoxpress
  // lorsque ratelist est vide ou inattendu.
  const { ratelist: _omit, ...response } = data
  return { request_id: data.request_id || null, rates, response, sent: payload }
}

export async function cancelPickup(pickupId) {
  const token = await getToken()
  const res = await fetch(`${BASE_URL}/pickup/cancel-pickup?pickup_id=${encodeURIComponent(pickupId)}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Novoxpress cancel-pickup (${res.status}): ${text}`)
  }
  return res.json().catch(() => ({}))
}

export async function schedulePickup(novoxpressShipmentId, { date, ready_at, ready_until, quantity, weight, pickup_location, pickup_instructions }) {
  // L'endpoint /pickup/create-pickup rejette `sender.residential` (alors que
  // /shipment/create-shipment et /services/rate-estimate l'acceptent). On
  // strippe ce champ ici uniquement.
  const { residential: _residential, ...senderForPickup } = SENDER
  const body = {
    shipment_id: novoxpressShipmentId,
    sender: senderForPickup,
    pickup_details: {
      date,
      ready_at,
      ready_until,
      package_details: {
        quantity: String(quantity || 1),
        weight: { unit: 'lb', value: String(weight || '1') }
      },
      pickup_instructions: pickup_instructions || '',
      pickup_location: pickup_location || 'OutsideDoor'
    }
  }
  const data = await apiPost('/pickup/create-pickup', body)
  return data
}

export async function createLabel(shipment, erpShipmentId, { request_id, service_id, packaging_type, packages, declared_value }) {
  const details = buildPayload(shipment, packaging_type, packages, declared_value || '100')

  // International shipment — add customs declaration
  const destCountry = details.recipient.address.country
  if (destCountry !== 'CA') {
    const items = db.prepare(`
      SELECT oi.qty, oi.unit_cost
      FROM order_items oi
      WHERE oi.order_id = (SELECT order_id FROM shipments WHERE id = ?)
    `).all(erpShipmentId)

    const totalValue = items.reduce((sum, i) => sum + (i.unit_cost || 0) * (i.qty || 0), 0)
    const totalWeight = packages.reduce((sum, p) => sum + Math.ceil(parseFloat(p.weight)) * parseInt(p.quantity || 1), 0)

    Object.assign(details, {
      reason_for_export: 'Permanent',
      business_relationship: 'NotRelated',
      non_delivery: 'RTS',
      internationalForms: {
        product: [{
          product_name: 'Intelligent greenhouse thermostat',
          desc: 'Intelligent greenhouse thermostat',
          hscode: '9032.10.0030',
          qty: '1',
          unit_weight: String(totalWeight),
          value: String(Math.ceil(totalValue)),
          country: 'CA'
        }]
      }
    })
  }
  const createPayload = { request_id, service_id, details }
  const data = await apiPost('/shipment/create-shipment', createPayload)

  const novoxShipmentId = data.shipment_id
  if (!novoxShipmentId) {
    const err = new Error(`Novoxpress: shipment_id manquant — ${data?.error?.description || JSON.stringify(data)}`)
    err.sentPayload = createPayload
    err.responseBody = JSON.stringify(data)
    err.status = 200
    throw err
  }

  // Fetch label PDF
  const token = await getToken()
  const labelRes = await fetch(`${BASE_URL}/shipment/print-label`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ shipment_id: novoxShipmentId, label_type: 'EightFiveByEleven' }).toString()
  })
  if (!labelRes.ok) {
    const text = await labelRes.text()
    throw new Error(`Novoxpress print-label (${labelRes.status}): ${text}`)
  }

  let pdfBuffer
  const contentType = labelRes.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    // API returns JSON with a URL to the actual PDF
    const json = await labelRes.json()
    const pdfUrl = json?.label?.shipping_label
    if (!pdfUrl) throw new Error(`Novoxpress: pas d'URL d'étiquette dans la réponse — ${JSON.stringify(json)}`)
    const pdfRes = await fetch(pdfUrl)
    if (!pdfRes.ok) throw new Error(`Novoxpress: échec téléchargement étiquette (${pdfRes.status})`)
    pdfBuffer = Buffer.from(await pdfRes.arrayBuffer())
  } else {
    pdfBuffer = Buffer.from(await labelRes.arrayBuffer())
  }

  const filename = `${erpShipmentId}.pdf`
  fs.mkdirSync(LABELS_DIR, { recursive: true })
  fs.writeFileSync(path.join(LABELS_DIR, filename), pdfBuffer)

  return { shipment_id: novoxShipmentId, tracking_id: data.tracking_id, status: data.status, filename }
}
