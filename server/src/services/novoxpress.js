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
    throw new Error(`Novoxpress ${endpoint} (${res.status}): ${text}`)
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

function extractStreet(line1, city) {
  if (!line1) return ''
  // line1 often contains full concatenated address: "123 rue X Ville QC H1H1H1 CA"
  // Extract just the street by cutting at the city name
  if (city) {
    const idx = line1.indexOf(city)
    if (idx > 0) return line1.slice(0, idx).trim().slice(0, 35)
  }
  return line1.slice(0, 35).trim()
}

function buildRecipient(shipment) {
  // Sanitize phone
  const raw = (shipment.company_phone || '').replace(/\D/g, '')
  const phone = raw.length === 11 && raw.startsWith('1') ? raw.slice(1) : raw

  // Normalize country to 2-letter code
  const countryMap = { 'Canada': 'CA', 'United States': 'US', 'États-Unis': 'US' }
  const country = countryMap[shipment.address_country] || shipment.address_country || 'CA'

  return {
    company_name: (shipment.company_name || 'Client').slice(0, 30),
    email_address: shipment.company_email || '',
    address: {
      street_address: extractStreet(shipment.address_line1, shipment.address_city),
      city: shipment.address_city || '',
      region: shipment.address_province || '',
      country,
      postal_code: (shipment.address_postal_code || '').replace(/\s/g, ''),
      phone_code: '1',
      phone_number: phone || '5550000000'
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

export async function getRates(shipment, { packaging_type, packages, declared_value }) {
  const data = await apiPost('/services/rate-estimate',
    buildPayload(shipment, packaging_type, packages, declared_value || '100'))
  const rates = (data.ratelist || []).sort((a, b) => parseFloat(a.total?.value ?? 0) - parseFloat(b.total?.value ?? 0))
  return { request_id: data.request_id || null, rates }
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
  const body = {
    shipment_id: novoxpressShipmentId,
    sender: SENDER,
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
  const data = await apiPost('/shipment/create-shipment', { request_id, service_id, details })

  const novoxShipmentId = data.shipment_id
  if (!novoxShipmentId) throw new Error(`Novoxpress: shipment_id manquant — réponse: ${JSON.stringify(data)}`)

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
