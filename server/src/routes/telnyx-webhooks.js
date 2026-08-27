// Webhooks Telnyx — accusés de livraison SMS. PUBLIC, pas de requireAuth :
// c'est Telnyx qui appelle, l'authentification passe par la signature.
//
// Telnyx signe chaque requête en Ed25519 : `telnyx-signature-ed25519` est la
// signature base64 de `${timestamp}|${rawBody}`, vérifiable avec la clé
// publique du portail (Account → Keys & Credentials → Public Key).
//
// La vérification EXIGE le corps brut, d'où le montage avec express.raw AVANT
// express.json dans index.js — même contrainte que les webhooks Stripe.
//
// Sans TELNYX_PUBLIC_KEY configurée, les webhooks sont REFUSÉS (401) plutôt
// qu'acceptés en aveugle : un accusé de livraison falsifié ferait croire qu'un
// sondage a été reçu alors qu'il n'est jamais parti.

import { Router } from 'express'
import { createPublicKey, verify as edVerify } from 'crypto'
import { applyDeliveryReceipt } from '../services/ticketSurveys.js'

const router = Router()

// Tolérance sur l'horodatage : rejette un rejeu d'une signature ancienne.
const MAX_SKEW_SECONDS = 5 * 60

// La clé publique Telnyx est fournie en base64 brut (32 octets Ed25519) ;
// crypto.verify exige un objet KeyObject, d'où l'emballage en DER.
const ED25519_DER_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

function telnyxPublicKey() {
  const raw = process.env.TELNYX_PUBLIC_KEY
  if (!raw) return null
  try {
    const keyBytes = Buffer.from(raw.trim(), 'base64')
    if (keyBytes.length !== 32) return null
    return createPublicKey({
      key: Buffer.concat([ED25519_DER_PREFIX, keyBytes]),
      format: 'der',
      type: 'spki',
    })
  } catch {
    return null
  }
}

export function verifyTelnyxSignature({ rawBody, signature, timestamp, publicKey }) {
  if (!publicKey || !signature || !timestamp) return false
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false
  if (Math.abs(Date.now() / 1000 - ts) > MAX_SKEW_SECONDS) return false
  try {
    const payload = Buffer.concat([
      Buffer.from(`${timestamp}|`),
      Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody)),
    ])
    return edVerify(null, payload, publicKey, Buffer.from(signature, 'base64'))
  } catch {
    return false
  }
}

// POST /api/hooks/telnyx/dlr
router.post('/dlr', (req, res) => {
  const publicKey = telnyxPublicKey()
  if (!publicKey) {
    console.error('[telnyx] TELNYX_PUBLIC_KEY absente ou invalide — webhook refusé')
    return res.status(401).json({ error: 'Signature non vérifiable' })
  }

  const ok = verifyTelnyxSignature({
    rawBody: req.rawBody,
    signature: req.get('telnyx-signature-ed25519'),
    timestamp: req.get('telnyx-timestamp'),
    publicKey,
  })
  if (!ok) return res.status(401).json({ error: 'Signature invalide' })

  const payload = req.body?.data?.payload || {}
  const messageId = payload.id || null
  // Un SMS part vers un seul destinataire ici : `to` est un tableau d'un élément.
  const dest = Array.isArray(payload.to) ? payload.to[0] : null
  const status = dest?.status || null
  const errorText = Array.isArray(payload.errors) && payload.errors.length
    ? payload.errors.map(e => e.detail || e.title).filter(Boolean).join(' — ')
    : null

  const changed = applyDeliveryReceipt({ messageId, status, errorText })
  if (changed) console.log(`[telnyx] DLR ${status} pour ${messageId}`)

  // Toujours 200 : un non-2xx déclenche des retentatives Telnyx pour un
  // message qui ne nous concerne pas (autre usage du même profil).
  res.json({ received: true, matched: changed })
})

export default router
