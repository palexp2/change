import path from 'path'
import fs from 'fs'
import sharp from 'sharp'
import PDFDocument from 'pdfkit'
import db from '../db/database.js'
import { getConfig, isUpsConfigured, upsRequest } from '../connectors/ups.js'
import { logSync } from './syncLog.js'
import {
  buildReturnShipmentRequest,
  buildRateRequest,
  parseRates,
  parseShipmentResults,
  parseTracking,
  serviceName,
  normalizeCountry,
  DEFAULT_HS_CODE,
  ORISHA_WORKSHOP,
} from './upsPayload.js'
import { uploadsPath } from '../config/uploads.js'

// Service UPS — côté effets (réseau, disque, DB). Toute la construction de
// payload et le parsing de réponse vivent dans upsPayload.js (pur, testé).
//
// Traçabilité (CLAUDE.md) : CHAQUE appel qui achète une étiquette et CHAQUE
// rafraîchissement de suivi passe par logSync('ups', …), succès comme échec,
// avec le message brut de l'API UPS en cas d'erreur.

const LABELS_DIR = uploadsPath('labels')

export { isUpsConfigured }

function assertConfigured() {
  if (!isUpsConfigured()) {
    throw new Error('UPS non configuré — renseignez client_id, client_secret et le numéro de compte dans la page Connecteurs.')
  }
}

// Colonne « code SH » côté produits : le schéma ERP n'en a pas encore
// officiellement ; on la détecte au vol pour l'utiliser dès qu'elle existe
// (l'utilisateur peut l'ajouter comme champ Airtable/personnalisé) et on
// retombe sinon sur le code SH par défaut des produits Orisha.
const HS_CANDIDATES = ['hs_code', 'code_sh', 'hscode', 'code_douanier', 'code_tarifaire']
let hsColumnCache
function productHsColumn() {
  if (hsColumnCache !== undefined) return hsColumnCache
  try {
    const cols = db.prepare('PRAGMA table_info(products)').all().map(c => c.name)
    hsColumnCache = HS_CANDIDATES.find(c => cols.includes(c)) || null
  } catch {
    hsColumnCache = null
  }
  return hsColumnCache
}

function hsOf(row) {
  const col = productHsColumn()
  const v = col ? row?.[col] : null
  return v || DEFAULT_HS_CODE
}

// Lignes douanières d'un RETOUR — ce qui revient réellement dans la boîte.
export function returnCustomsItems(returnId) {
  const hsCol = productHsColumn()
  const rows = db.prepare(`
    SELECT ri.qty, p.name_en, p.name_fr, p.price_cad${hsCol ? `, p.${hsCol}` : ''}
    FROM return_items ri
    LEFT JOIN products p ON p.id = ri.product_id
    WHERE ri.return_id = ?
  `).all(returnId)
  return rows.map(r => ({
    description: r.name_en || r.name_fr || 'Greenhouse controller',
    qty: r.qty || 1,
    unit_value: r.price_cad || 1,
    origin_country: 'CA',
    hs_code: hsOf(r),
  }))
}

// Lignes douanières d'un ENVOI — à partir des lignes de la commande liée.
export function shipmentCustomsItems(shipmentId) {
  const hsCol = productHsColumn()
  const rows = db.prepare(`
    SELECT oi.qty, oi.unit_cost, p.name_en, p.name_fr, p.price_cad${hsCol ? `, p.${hsCol}` : ''}
    FROM order_items oi
    LEFT JOIN products p ON p.id = oi.product_id
    WHERE oi.order_id = (SELECT order_id FROM shipments WHERE id = ?)
  `).all(shipmentId)
  return rows.map(r => ({
    description: r.name_en || r.name_fr || 'Greenhouse controller',
    qty: r.qty || 1,
    unit_value: r.unit_cost || r.price_cad || 1,
    origin_country: 'CA',
    hs_code: hsOf(r),
  }))
}

// ── Étiquette : image UPS (GIF) → PDF joignable au courriel ──────────────────
// UPS ne renvoie pas de PDF (LabelImageFormat accepte GIF/ZPL/EPL/SPL) : on
// convertit l'image en PDF pleine page 4×6 po, format d'étiquette standard.
export async function labelImageToPdf(base64, format = 'GIF') {
  const raw = Buffer.from(base64, 'base64')
  // ZPL/EPL sont du texte d'imprimante thermique — pas convertibles en image.
  if (!['GIF', 'PNG', 'JPG', 'JPEG'].includes(String(format).toUpperCase())) {
    throw new Error(`Format d'étiquette UPS non convertible en PDF : ${format}`)
  }
  const png = await sharp(raw).rotate(90).png().toBuffer()
  const meta = await sharp(png).metadata()

  return await new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: [288, 432], margin: 0 }) // 4 × 6 po à 72 dpi
    const chunks = []
    doc.on('data', c => chunks.push(c))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
    const scale = Math.min(288 / (meta.width || 288), 432 / (meta.height || 432))
    const w = (meta.width || 288) * scale
    const h = (meta.height || 432) * scale
    doc.image(png, (288 - w) / 2, (432 - h) / 2, { width: w, height: h })
    doc.end()
  })
}

// ── Achat d'une étiquette de RETOUR (client → atelier Orisha) ────────────────
// Renvoie { shipment_id, tracking_number, cost, currency, service_code,
//           service_name, filename, pdf_error }.
// L'étiquette est ACHETÉE dès que UPS renvoie un ShipmentIdentificationNumber :
// un échec de conversion PDF ne doit pas faire perdre l'achat (mêmes règles que
// Novoxpress) — il remonte dans `pdf_error`.
export async function createReturnLabel(ctx, returnId, { packages, service_code, description, currency } = {}) {
  assertConfigured()
  const cfg = getConfig()
  const started = Date.now()

  const customsItems = returnCustomsItems(returnId)
  const payload = buildReturnShipmentRequest(ctx, {
    accountNumber: cfg.account_number,
    packages,
    serviceCode: service_code || '11',
    description: description || 'Retour de marchandise',
    customsItems,
    currency: currency || 'CAD',
  })

  let data
  try {
    data = await upsRequest('POST', `/api/shipments/${cfg.shipping_version || 'v1'}/ship`, {
      body: payload,
      context: `Shipping /api/shipments/${cfg.shipping_version || 'v1'}/ship (étiquette de retour)`,
    })
  } catch (e) {
    logSync('ups', 'manual', {
      status: 'error',
      durationMs: Date.now() - started,
      error: `Étiquette de retour ${returnId} : ${e.message}`,
    })
    if (!e.sentPayload) e.sentPayload = payload
    throw e
  }

  const parsed = parseShipmentResults(data)
  if (!parsed.shipment_id) {
    const raw = JSON.stringify(data).slice(0, 800)
    const err = new Error(`UPS n'a retourné aucun numéro d'expédition — réponse brute : ${raw}`)
    err.sentPayload = payload
    err.responseBody = raw
    logSync('ups', 'manual', { status: 'error', durationMs: Date.now() - started, error: `Étiquette de retour ${returnId} : ${err.message}` })
    throw err
  }

  let filename = null
  let pdfError = null
  if (parsed.label_base64) {
    try {
      const pdf = await labelImageToPdf(parsed.label_base64, parsed.label_format)
      filename = `ups-return-${returnId}.pdf`
      fs.mkdirSync(LABELS_DIR, { recursive: true })
      fs.writeFileSync(path.join(LABELS_DIR, filename), pdf)
    } catch (e) {
      pdfError = e.message
    }
  } else {
    pdfError = "UPS n'a pas renvoyé d'image d'étiquette dans la réponse."
  }

  logSync('ups', 'manual', {
    status: pdfError ? 'error' : 'success',
    modified: 1,
    durationMs: Date.now() - started,
    error: pdfError ? `Étiquette de retour ${returnId} achetée (${parsed.tracking_number}) mais PDF indisponible : ${pdfError}` : null,
  })

  return {
    ...parsed,
    service_code: String(service_code || '11'),
    service_name: serviceName(service_code || '11'),
    filename,
    pdf_error: pdfError,
    customs_items: customsItems,
    environment: cfg.environment,
  }
}

// ── Comparaison de tarifs ────────────────────────────────────────────────────
// Un seul chemin pour les deux sens : `inbound` bascule ShipFrom/ShipTo (retour
// client → atelier) sans rien changer au reste (compte payeur, repli sur les
// tarifs publics, douane si le client est hors Canada).
async function fetchRates(ctx, { packages, currency, customsItems, inbound = false, label } = {}) {
  assertConfigured()
  const cfg = getConfig()
  const started = Date.now()

  const buildPayload = negotiatedRates => buildRateRequest(ctx, {
    accountNumber: cfg.account_number,
    packages,
    currency: currency || 'CAD',
    customsItems,
    negotiatedRates,
    inbound,
  })
  const endpoint = `/api/rating/${cfg.rating_version || 'v1'}/Shop`

  let payload = buildPayload(true)
  let data
  try {
    data = await upsRequest('POST', endpoint, { body: payload, context: `Rating ${endpoint}` })
  } catch (e) {
    // Un compte sans entente tarifaire négociée fait rejeter
    // NegotiatedRatesIndicator : on retente une fois aux tarifs publics plutôt
    // que de laisser l'utilisateur sans aucun tarif. Si ça échoue aussi, c'est
    // la PREMIÈRE erreur (la plus complète) qui remonte.
    try {
      payload = buildPayload(false)
      data = await upsRequest('POST', endpoint, { body: payload, context: `Rating ${endpoint}` })
    } catch {
      logSync('ups', 'manual', { status: 'error', durationMs: Date.now() - started, error: `${label} : ${e.message}` })
      if (!e.sentPayload) e.sentPayload = payload
      throw e
    }
  }

  const rates = parseRates(data)
  logSync('ups', 'manual', { status: 'success', modified: rates.length, durationMs: Date.now() - started })
  // Douane dès que le client est hors Canada, peu importe le sens du colis.
  const international = normalizeCountry(ctx.address_country) !== ORISHA_WORKSHOP.country
  return {
    rates,
    sent: payload,
    environment: cfg.environment,
    customs: international ? customsItems : null,
  }
}

// Envoi sortant (Orisha → client).
export async function getShipmentRates(ctx, shipmentId, { packages, currency } = {}) {
  return await fetchRates(ctx, {
    packages,
    currency,
    customsItems: shipmentCustomsItems(shipmentId),
    label: `Tarifs envoi ${shipmentId}`,
  })
}

// Retour (client → atelier Orisha) — sert à comparer les tarifs Novoxpress
// d'une étiquette de retour avec le tarif UPS direct. Aucun achat.
export async function getReturnRates(ctx, returnId, { packages, currency } = {}) {
  return await fetchRates(ctx, {
    packages,
    currency,
    customsItems: returnCustomsItems(returnId),
    inbound: true,
    label: `Tarifs retour ${returnId}`,
  })
}

// ── Suivi ───────────────────────────────────────────────────────────────────
export async function trackNumber(trackingNumber) {
  assertConfigured()
  const cfg = getConfig()
  const started = Date.now()
  const num = String(trackingNumber || '').trim()
  if (!num) throw new Error('Numéro de suivi manquant')

  try {
    const data = await upsRequest(
      'GET',
      `/api/track/${cfg.tracking_version || 'v1'}/details/${encodeURIComponent(num)}?locale=fr_CA&returnSignature=false`,
      { context: `Tracking /api/track/${cfg.tracking_version || 'v1'}/details` }
    )
    const parsed = parseTracking(data)
    logSync('ups', 'manual', { status: 'success', modified: parsed.status ? 1 : 0, durationMs: Date.now() - started })
    return parsed
  } catch (e) {
    logSync('ups', 'manual', { status: 'error', durationMs: Date.now() - started, error: `Suivi ${num} : ${e.message}` })
    throw e
  }
}

// Test de connexion (bouton « Tester la connexion » de la page Connecteurs) :
// un simple mint de jeton, aucun effet de bord facturable.
export async function testConnection() {
  assertConfigured()
  const cfg = getConfig()
  const started = Date.now()
  const { getAccessToken } = await import('../connectors/ups.js')
  try {
    const token = await getAccessToken()
    logSync('ups', 'manual', { status: 'success', durationMs: Date.now() - started })
    return {
      ok: true,
      environment: cfg.environment,
      base_url: cfg.environment === 'production' ? 'https://onlinetools.ups.com' : 'https://wwwcie.ups.com',
      token_preview: `${String(token).slice(0, 6)}…`,
    }
  } catch (e) {
    logSync('ups', 'manual', { status: 'error', durationMs: Date.now() - started, error: `Test de connexion : ${e.message}` })
    throw e
  }
}
