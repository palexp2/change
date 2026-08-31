import path from 'path'
import fs from 'fs'
import db from '../db/database.js'
import { getConfig, isPurolatorConfigured, apiBase } from '../connectors/purolator.js'
import { logSync } from './syncLog.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'
import {
  buildEstimateRequest,
  buildCreateShipmentRequest,
  buildGetDocumentsRequest,
  buildTrackingRequest,
  parseEstimateResponse,
  parseCreateShipmentResponse,
  parseGetDocumentsResponse,
  parseTrackingResponse,
  describePurolatorError,
} from './purolatorPayload.js'

// Service Purolator — côté effets (réseau, disque, DB). Toute la construction
// d'enveloppe SOAP et le parsing de réponse vivent dans purolatorPayload.js
// (pur, testé) — même séparation que ups.js / upsPayload.js.
//
// ⚠️ Non vérifié en direct — voir l'avertissement en tête de purolatorPayload.js.
//
// Traçabilité (CLAUDE.md) : chaque tarif, chaque achat d'étiquette et chaque
// rafraîchissement de suivi passe par logSync('purolator', …), succès comme
// échec, avec le message brut de l'API Purolator en cas d'erreur.

const LABELS_DIR = path.join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'labels')

export { isPurolatorConfigured }

function assertConfigured() {
  if (!isPurolatorConfigured()) {
    throw new Error("Purolator non configuré — renseignez la clé, le mot de passe et le numéro de compte dans la page Connecteurs.")
  }
}

const SOAP_PATHS = {
  estimating: '/EWS/V2/Estimating/EstimatingService.asmx',
  shipping: '/EWS/V2/Shipping/ShippingService.asmx',
  documents: '/EWS/V2/ShippingDocuments/ShippingDocumentsService.asmx',
  tracking: '/EWS/V1/Tracking/TrackingService.asmx',
}
const SOAP_ACTIONS = {
  estimate: 'http://purolator.com/pws/service/v2/GetFullEstimate',
  createShipment: 'http://purolator.com/pws/service/v2/CreateShipment',
  getDocuments: 'http://purolator.com/pws/service/v2/GetDocuments',
  track: 'http://purolator.com/pws/service/v1/TrackPackagesByPin',
}

async function soapRequest(service, soapAction, xmlBody, context) {
  const cfg = getConfig()
  const basic = Buffer.from(`${cfg.key}:${cfg.password}`).toString('base64')
  const url = `${apiBase(cfg)}${SOAP_PATHS[service]}`
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'text/xml; charset=utf-8',
      SOAPAction: soapAction,
    },
    body: xmlBody,
  })
  const text = await res.text()
  if (!res.ok) {
    const err = new Error(`Purolator ${context} (HTTP ${res.status}) : ${text.slice(0, 800) || 'réponse vide'}`)
    err.status = res.status
    err.responseBody = text.slice(0, 4000)
    err.sentPayload = xmlBody
    throw err
  }
  return text
}

// ── Tarifs (envoi sortant) ───────────────────────────────────────────────────
export async function getShipmentRates(ctx, shipmentId, { packages } = {}) {
  assertConfigured()
  const cfg = getConfig()
  const started = Date.now()
  const req = buildEstimateRequest(ctx, { packages, accountNumber: cfg.account_number })

  let xml
  try {
    xml = await soapRequest('estimating', SOAP_ACTIONS.estimate, req.xml, `GetFullEstimate (envoi ${shipmentId})`)
  } catch (e) {
    logSync('purolator', 'manual', { status: 'error', durationMs: Date.now() - started, error: `Tarifs envoi ${shipmentId} : ${e.message}` })
    if (!e.sentPayload) e.sentPayload = req.xml
    throw e
  }

  const parsed = parseEstimateResponse(xml)
  if (parsed.errors.length) {
    const err = new Error(describePurolatorError(`GetFullEstimate (envoi ${shipmentId})`, parsed.errors, xml))
    err.sentPayload = req.xml
    err.responseBody = xml.slice(0, 4000)
    logSync('purolator', 'manual', { status: 'error', durationMs: Date.now() - started, error: err.message })
    throw err
  }

  logSync('purolator', 'manual', { status: 'success', modified: parsed.rates.length, durationMs: Date.now() - started })
  return { rates: parsed.rates, sent: req.xml, environment: cfg.environment }
}

// ── Achat d'une étiquette (envoi sortant Orisha → client) ───────────────────
// Renvoie { shipment_id (PIN), tracking_id, filename, labelError }. L'étiquette
// est ACHETÉE dès que Purolator renvoie un ShipmentPIN : un échec de
// récupération du PDF (GetDocuments) ne doit pas faire perdre l'achat — même
// règle que Novoxpress/UPS — il remonte dans labelError.
export async function createLabel(ctx, erpShipmentId, { service_id, packages } = {}) {
  assertConfigured()
  const cfg = getConfig()
  const started = Date.now()
  const req = buildCreateShipmentRequest(ctx, {
    packages, serviceId: service_id, accountNumber: cfg.account_number, erpShipmentId,
  })

  let xml
  try {
    xml = await soapRequest('shipping', SOAP_ACTIONS.createShipment, req.xml, `CreateShipment (envoi ${erpShipmentId})`)
  } catch (e) {
    logSync('purolator', 'manual', { status: 'error', durationMs: Date.now() - started, error: `Étiquette envoi ${erpShipmentId} : ${e.message}` })
    if (!e.sentPayload) e.sentPayload = req.xml
    throw e
  }

  const parsed = parseCreateShipmentResponse(xml)
  if (parsed.errors.length || !parsed.shipmentPin) {
    const err = new Error(describePurolatorError(`CreateShipment (envoi ${erpShipmentId})`, parsed.errors, xml))
    err.sentPayload = req.xml
    err.responseBody = xml.slice(0, 4000)
    logSync('purolator', 'manual', { status: 'error', durationMs: Date.now() - started, error: err.message })
    throw err
  }

  let filename = null
  let labelError = null
  try {
    const pdf = await fetchAndSaveLabelPdf(parsed.shipmentPin, erpShipmentId)
    filename = pdf.filename
  } catch (e) {
    labelError = e.message
  }

  logSync('purolator', 'manual', {
    status: labelError ? 'error' : 'success',
    modified: 1,
    durationMs: Date.now() - started,
    error: labelError ? `Étiquette ${erpShipmentId} achetée (PIN ${parsed.shipmentPin}) mais PDF indisponible : ${labelError}` : null,
  })

  return { shipment_id: parsed.shipmentPin, tracking_id: parsed.shipmentPin, filename, labelError }
}

// Récupère (ou re-télécharge) le PDF d'étiquette d'un envoi Purolator DÉJÀ
// créé. Séparé de createLabel pour pouvoir réessayer sans re-facturer.
export async function fetchAndSaveLabelPdf(shipmentPin, erpShipmentId) {
  const xmlReq = buildGetDocumentsRequest(shipmentPin)
  const xml = await soapRequest('documents', SOAP_ACTIONS.getDocuments, xmlReq, `GetDocuments (PIN ${shipmentPin})`)
  const parsed = parseGetDocumentsResponse(xml)
  if (parsed.errors.length || !parsed.base64) {
    throw new Error(describePurolatorError(`GetDocuments (PIN ${shipmentPin})`, parsed.errors, xml))
  }
  const filename = `purolator-${erpShipmentId}.pdf`
  fs.mkdirSync(LABELS_DIR, { recursive: true })
  fs.writeFileSync(path.join(LABELS_DIR, filename), Buffer.from(parsed.base64, 'base64'))
  return { filename }
}

// ── Suivi ────────────────────────────────────────────────────────────────────
export async function trackNumber(pin) {
  assertConfigured()
  const started = Date.now()
  const num = String(pin || '').trim()
  if (!num) throw new Error('Numéro de suivi manquant')

  const xmlReq = buildTrackingRequest(num)
  try {
    const xml = await soapRequest('tracking', SOAP_ACTIONS.track, xmlReq, `TrackPackagesByPin (${num})`)
    const parsed = parseTrackingResponse(xml)
    if (parsed.errors.length) {
      throw new Error(describePurolatorError(`TrackPackagesByPin (${num})`, parsed.errors, xml))
    }
    logSync('purolator', 'manual', { status: 'success', modified: parsed.status ? 1 : 0, durationMs: Date.now() - started })
    return parsed
  } catch (e) {
    logSync('purolator', 'manual', { status: 'error', durationMs: Date.now() - started, error: `Suivi ${num} : ${e.message}` })
    throw e
  }
}

export const TRACKING_AUTOMATION_ID = 'sys_purolator_tracking'

// Rafraîchissement horaire du suivi (cron dans index.js) : parcourt les envois
// Purolator non encore livrés et met à jour leur statut. Coupe-circuit si
// l'automation sys_purolator_tracking est désactivée (page Automations),
// comme les autres tournées système du projet (cf. treasurySoldeSheet.js).
export async function refreshPurolatorTracking({ trigger = 'scheduled' } = {}) {
  if (!isSystemAutomationActive(TRACKING_AUTOMATION_ID)) {
    return { skipped: 'automation désactivée' }
  }
  if (!isPurolatorConfigured()) {
    return { skipped: 'Purolator non configuré' }
  }
  const started = Date.now()
  const rows = db.prepare(`
    SELECT id, purolator_shipment_id
    FROM shipments
    WHERE deleted_at IS NULL
      AND carrier = 'Purolator'
      AND purolator_shipment_id IS NOT NULL
      AND (purolator_tracking_status IS NULL OR purolator_tracking_status NOT LIKE '%Delivered%')
    ORDER BY created_at DESC
    LIMIT 200
  `).all()

  let updated = 0
  let errors = 0
  const details = []
  for (const row of rows) {
    try {
      const t = await trackNumber(row.purolator_shipment_id)
      db.prepare(`
        UPDATE shipments
        SET purolator_tracking_status = ?, purolator_tracking_last_activity = ?,
            purolator_tracking_checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).run(t.status || null, t.last_activity || null, row.id)
      updated++
    } catch (e) {
      errors++
      details.push(`${row.id} : ${e.message}`)
    }
  }

  const durationMs = Date.now() - started
  logSync('purolator', trigger === 'manuel' ? 'manual' : 'scheduled', {
    status: errors > 0 && updated === 0 ? 'error' : 'success',
    modified: updated,
    durationMs,
    error: details.length ? details.slice(0, 5).join(' · ') : null,
  })
  const result = { checked: rows.length, updated, errors, details: details.slice(0, 10) }
  logSystemRun(TRACKING_AUTOMATION_ID, {
    status: errors > 0 && updated === 0 ? 'error' : 'success',
    result: `${rows.length} envoi(s) vérifié(s) · ${updated} mis à jour · ${errors} erreur(s)`,
    duration_ms: durationMs,
    triggerData: { trigger },
  })
  return result
}
