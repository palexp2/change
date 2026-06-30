// Diagnostic Novoxpress via leur environnement DEV (https://api.novoxpress.ca/dev).
//
// SYSTÈME TEMPORAIRE — à retirer quand l'intégration sera stable : supprimer ce
// module, son branchement dans routes/novoxpress.js et l'encart côté client
// (NovoxpressDiagnosticPanel.jsx). Rien d'autre n'en dépend.
//
// Pourquoi le dev : vérifié par spike le 2026-06-11 — l'env dev ne facture rien
// (create-shipment retourne un tracking mocké `123456789012`) MAIS passe par la
// vraie validation Novoxpress + XML Postes Canada (un `&` dans company_name y
// reproduit exactement l'erreur prod « illegal character at offset 920 »). C'est
// donc le seul endroit où on peut bisecter un payload en sécurité : en prod, une
// tentative mutée qui réussit = une étiquette réellement achetée.
//
// Stratégie « substitution contrôlée » (validée avec l'utilisateur) :
//   T1  replay du payload réel en dev   → réussit ? verdict « Novo prod »
//   T2  payload 100 % témoin            → échoue ?  verdict « Novo down »
//   T3+ payload réel avec UN groupe remplacé par la valeur témoin (nom, rue,
//       ville/CP, courriel/tél, emballage) → le 1er qui passe désigne le champ
//       fautif. Aucun ne passe → « cause non isolée ».
// Tous les verdicts « pas notre côté » renvoient vers la création manuelle :
// https://app.novoxpress.ca/create-shipment
import db from '../db/database.js'
import { SENDER } from './novoxpress.js'
import { logSync } from './syncLog.js'

const DEV_BASE = 'https://api.novoxpress.ca/dev'
const MANUAL_URL = 'https://app.novoxpress.ca/create-shipment'
const DEV_CALL_TIMEOUT_MS = 15000

// Transporteurs présents dans l'env dev (mêmes service_id qu'en prod). Absents :
// Nationex (grd-374), Uber (uber-371), Loomis (dd-395), Canpar (1-391, 5-390) et
// les nouveaux services Purolator (purolatorexpress-373, purolatorground-372).
const DEV_SERVICE_RE = /^(canadapost|ups|gls|purolator)-\d+$/

// Token personnel longue durée (généré sur app.novoxpress.ca/generate-my-token),
// saisi via la page Connecteurs. Utilisé UNIQUEMENT pour les appels dev — l'auth
// prod (username/password + get-token) reste inchangée.
export function getDiagnosticToken() {
  return db.prepare(
    "SELECT value FROM connector_config WHERE connector='novoxpress' AND key='api_token'"
  ).get()?.value || null
}

export function isDiagnosticAvailable() {
  return !!getDiagnosticToken()
}

// Classe une erreur Novoxpress prod : « opaque » (mérite le diagnostic auto) vs
// « claire » (le message dit déjà quoi corriger — bouton manuel seulement).
export function isOpaqueNovoError(e) {
  if (!e) return false
  const body = String(e.responseBody || e.message || '')
  // Messages de validation auto-explicatifs du schéma Novoxpress.
  const isClear = /is not allowed|is required|characters only|valid package|must be|invalid/i.test(body)
    && !/status code 5\d\d/i.test(body)
  if (isClear) return false
  // 500 relayé, erreurs amont Postes Canada, shipment_id manquant, 5xx direct.
  if (/status code 5\d\d|internal server error/i.test(body)) return true
  if (/illegal character|cvc-|model-group|does not match city|shipment-v8/i.test(body)) return true
  if (e.upstream) return true
  if ((e.status || 0) >= 500) return true
  // Échec create-shipment sans shipment_id (réponse 200 mais error présent).
  if (/aucun shipment_id|étiquette refusée en amont/i.test(body)) return true
  return false
}

// Destinataire témoin connu-bon (adresse Orisha, validé par spike sur /dev).
const WITNESS = {
  company_name: 'Client Temoin',
  email_address: 'martin@orisha.io',
  street_address: '1535 ch. Ste-Foy',
  city: 'Québec',
  region: 'QC',
  country: 'CA',
  postal_code: 'G1S2P1',
  phone_code: '1',
  phone_number: '4183860213',
}

const WITNESS_PACKAGING = {
  packaging_type: 'package',
  packaging_properties: {
    packages: [{ quantity: '1', weight: '2', length: '20', width: '16', depth: '8' }],
    weight: { unit: 'lb' },
  },
}

function clone(obj) {
  return JSON.parse(JSON.stringify(obj))
}

// Groupes de substitution — chacun remplace UN aspect du payload réel par la
// valeur témoin. L'ordre va du plus fréquent (nom — caractères spéciaux) au
// moins fréquent (emballage — ses erreurs sont en général des 400 clairs).
const GROUPS = [
  {
    key: 'company_name',
    label: "nom d'entreprise (recipient.company_name)",
    extract: d => ({ company_name: d.recipient?.company_name }),
    apply: d => { d.recipient.company_name = WITNESS.company_name },
  },
  {
    key: 'street_address',
    label: 'rue (recipient.address.street_address)',
    extract: d => ({ street_address: d.recipient?.address?.street_address }),
    apply: d => { d.recipient.address.street_address = WITNESS.street_address },
  },
  {
    key: 'city_postal',
    label: 'ville / province / code postal (recipient.address)',
    extract: d => ({
      city: d.recipient?.address?.city,
      region: d.recipient?.address?.region,
      postal_code: d.recipient?.address?.postal_code,
      country: d.recipient?.address?.country,
    }),
    apply: d => {
      Object.assign(d.recipient.address, {
        city: WITNESS.city, region: WITNESS.region,
        postal_code: WITNESS.postal_code, country: WITNESS.country,
      })
    },
  },
  {
    key: 'phone_email',
    label: 'courriel / téléphone (recipient)',
    extract: d => ({
      email_address: d.recipient?.email_address,
      phone_number: d.recipient?.address?.phone_number,
    }),
    apply: d => {
      d.recipient.email_address = WITNESS.email_address
      d.recipient.address.phone_code = WITNESS.phone_code
      d.recipient.address.phone_number = WITNESS.phone_number
    },
  },
  {
    key: 'packaging',
    label: 'emballage (packaging_type / packages)',
    extract: d => ({ packaging_type: d.packaging_type, packages: d.packaging_properties?.packages }),
    apply: d => { Object.assign(d, clone(WITNESS_PACKAGING)) },
  },
]

function buildWitnessDetails(realDetails) {
  const d = clone(realDetails)
  d.recipient = {
    company_name: WITNESS.company_name,
    email_address: WITNESS.email_address,
    address: {
      street_address: WITNESS.street_address,
      city: WITNESS.city,
      region: WITNESS.region,
      country: WITNESS.country,
      postal_code: WITNESS.postal_code,
      phone_code: WITNESS.phone_code,
      phone_number: WITNESS.phone_number,
    },
    residential: false,
  }
  Object.assign(d, clone(WITNESS_PACKAGING))
  // Un payload témoin est toujours domestique — on retire le bloc douanes
  // éventuel d'un envoi international pour ne tester que la base.
  delete d.internationalForms
  delete d.reason_for_export
  delete d.business_relationship
  delete d.non_delivery
  return d
}

async function devPost(endpoint, body, token) {
  const res = await fetch(`${DEV_BASE}${endpoint}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(DEV_CALL_TIMEOUT_MS),
  })
  const text = await res.text()
  let data = null
  try { data = JSON.parse(text) } catch { /* réponse non-JSON */ }
  return { ok: res.ok, status: res.status, data, text }
}

// Une « tentative » pour l'op rate : un seul appel rate-estimate dev.
async function attemptRate(details, token) {
  const r = await devPost('/services/rate-estimate', details, token)
  if (!r.ok) return { ok: false, error: `rate-estimate dev (${r.status}): ${r.text.slice(0, 400)}` }
  return { ok: true }
}

// Une « tentative » pour l'op label : rate-estimate dev → vérifier que le
// service demandé est offert → create-shipment dev. L'absence du service dans
// le ratelist dev compte comme un échec (le transporteur a silencieusement
// rejeté l'adresse — observé au spike avec un code postal/ville incohérents).
async function attemptLabel(details, serviceId, token) {
  const rate = await devPost('/services/rate-estimate', details, token)
  if (!rate.ok) return { ok: false, error: `rate-estimate dev (${rate.status}): ${rate.text.slice(0, 400)}` }
  const list = rate.data?.ratelist || []
  if (!list.some(r => r.service_id === serviceId)) {
    return { ok: false, error: `service ${serviceId} absent du ratelist dev — le transporteur a probablement rejeté l'adresse sans message d'erreur` }
  }
  const create = await devPost('/shipment/create-shipment', {
    request_id: rate.data.request_id, service_id: serviceId, details,
  }, token)
  if (!create.ok) return { ok: false, error: `create-shipment dev (${create.status}): ${create.text.slice(0, 400)}` }
  if (!create.data?.shipment_id) {
    const desc = create.data?.error?.description || create.data?.error || JSON.stringify(create.data)
    return { ok: false, error: `create-shipment dev sans shipment_id: ${String(desc).slice(0, 400)}` }
  }
  return { ok: true, devShipmentId: create.data.shipment_id }
}

// Une « tentative » pour l'op pickup : créer un shipment dev jetable (gratuit,
// l'env dev exige un shipment_id du MÊME environnement), puis create-pickup.
async function attemptPickup(details, serviceId, pickupDetails, token) {
  const lab = await attemptLabel(details, serviceId, token)
  if (!lab.ok) return { ok: false, error: `création du shipment dev support impossible — ${lab.error}`, setupFailed: true }
  // create-pickup rejette sender.residential (cf. schedulePickup en prod).
  const { residential: _r, ...senderForPickup } = SENDER
  const r = await devPost('/pickup/create-pickup', {
    shipment_id: lab.devShipmentId,
    sender: senderForPickup,
    pickup_details: pickupDetails,
  }, token)
  if (!r.ok) return { ok: false, error: `create-pickup dev (${r.status}): ${r.text.slice(0, 400)}` }
  return { ok: true }
}

// Prochain jour ouvrable — date de ramassage témoin.
function witnessPickupDate() {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1)
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() }
}

const PICKUP_GROUPS = [
  {
    key: 'pickup_date',
    label: 'date de ramassage (pickup_details.date)',
    extract: p => ({ date: p.date }),
    apply: p => { p.date = witnessPickupDate() },
  },
  {
    key: 'pickup_window',
    label: 'fenêtre horaire (ready_at / ready_until)',
    extract: p => ({ ready_at: p.ready_at, ready_until: p.ready_until }),
    apply: p => {
      p.ready_at = { hour: 9, minute: 0 }
      p.ready_until = { hour: 17, minute: 0 }
    },
  },
  {
    key: 'pickup_package',
    label: 'détails du colis (package_details)',
    extract: p => ({ package_details: p.package_details }),
    apply: p => { p.package_details = { quantity: '1', weight: { unit: 'lb', value: '1' } } },
  },
  {
    key: 'pickup_location',
    label: 'emplacement / instructions (pickup_location, pickup_instructions)',
    extract: p => ({ pickup_location: p.pickup_location, pickup_instructions: p.pickup_instructions }),
    apply: p => {
      p.pickup_location = 'OutsideDoor'
      p.pickup_instructions = ''
    },
  },
]

function witnessPickupDetails() {
  const p = {}
  for (const g of PICKUP_GROUPS) g.apply(p)
  return p
}

function buildClaudePrompt({ op, shipmentId, group, faultyValue, errorDetail }) {
  const today = new Date().toISOString().slice(0, 10)
  return (
    `Le diagnostic Novoxpress du ${today} (envoi #${shipmentId}, opération ${op}) a isolé le champ fautif : ${group.label}.\n` +
    `La valeur réelle ${JSON.stringify(faultyValue)} échoue dans l'environnement dev Novoxpress avec l'erreur :\n` +
    `${errorDetail}\n` +
    `…mais le même payload passe quand ce champ est remplacé par une valeur témoin.\n\n` +
    `Corrige durablement la construction du payload (buildRecipient / sanitizeXmlText / buildPayload dans ` +
    `server/src/services/novoxpress.js) pour que ce cas passe, ajoute le cas au besoin dans les normalisations existantes, ` +
    `puis vérifie ta correction en rejouant le payload contre https://api.novoxpress.ca/dev (token connector_config novoxpress/api_token — aucun achat réel en dev).`
  )
}

/**
 * Lance le diagnostic par substitution contrôlée dans l'env dev.
 *
 * @param {'rate'|'label'|'pickup'} op
 * @param {object} params
 *   - details : payload Novoxpress réel (sender/recipient/packaging…) tel qu'envoyé en prod
 *   - serviceId : requis pour op label/pickup
 *   - pickupDetails : requis pour op pickup (format create-pickup)
 *   - shipmentId : id ERP de l'envoi (pour le prompt)
 *   - prodError : message de l'erreur prod d'origine (contexte du prompt)
 * @param {'auto'|'manual'} trigger
 * @returns {object} { available, verdict, message, manualUrl?, faultyField?, claudePrompt?, attempts: [...] }
 */
export async function runDiagnostic(op, { details, serviceId, pickupDetails, shipmentId, prodError }, trigger = 'auto') {
  const token = getDiagnosticToken()
  if (!token) return { available: false }

  const startedAt = Date.now()
  const attempts = []

  const finish = (result) => {
    logSync('novoxpress_diagnostic', trigger === 'auto' ? 'webhook' : 'manual', {
      status: 'success',
      modified: attempts.length,
      error: `${op} → ${result.verdict}${result.faultyField ? ` (${result.faultyField})` : ''}`,
      durationMs: Date.now() - startedAt,
    })
    return { available: true, op, attempts, ...result }
  }

  // Transporteur absent de l'env dev → impossible de tester le create-shipment.
  if ((op === 'label' || op === 'pickup') && !DEV_SERVICE_RE.test(String(serviceId || ''))) {
    return finish({
      verdict: 'carrier_unavailable',
      message: `Le service « ${serviceId} » n'existe pas dans l'environnement dev Novoxpress (seuls Postes Canada, UPS, GLS et Purolator y sont disponibles) — diagnostic impossible pour ce transporteur. Si l'erreur persiste, créez l'envoi à la main chez Novoxpress.`,
      manualUrl: MANUAL_URL,
    })
  }

  const runAttempt = async (label, mutatedDetails, mutatedPickup) => {
    const t0 = Date.now()
    let r
    try {
      if (op === 'rate') r = await attemptRate(mutatedDetails, token)
      else if (op === 'label') r = await attemptLabel(mutatedDetails, serviceId, token)
      else r = await attemptPickup(mutatedDetails, serviceId, mutatedPickup, token)
    } catch (e) {
      r = { ok: false, error: `appel dev impossible: ${e.message}` }
    }
    attempts.push({ label, outcome: r.ok ? 'success' : 'fail', error: r.error || null, ms: Date.now() - t0 })
    return r
  }

  // ── T1 — replay du payload réel en dev
  const t1 = await runAttempt('T1 · replay du payload réel en dev', details, pickupDetails)
  if (t1.ok) {
    return finish({
      verdict: 'novo_prod',
      message: `Le même payload passe sans erreur dans l'environnement dev Novoxpress : vos données sont valides, le problème est côté Novoxpress prod (panne ou incident transitoire chez eux ou chez le transporteur). Réessayez dans quelques minutes ; si ça persiste, créez l'envoi à la main chez Novoxpress.`,
      manualUrl: MANUAL_URL,
    })
  }

  // ── T2 — payload 100 % témoin (connu-bon)
  const witnessDetails = buildWitnessDetails(details)
  // En label/pickup, le service réel peut être absent pour le témoin si le
  // compte dev n'offre pas ce service — on garde le même serviceId : il a été
  // validé DEV_SERVICE_RE et le témoin est domestique.
  const t2 = await runAttempt(
    'T2 · payload témoin connu-bon (adresse Orisha)',
    witnessDetails,
    op === 'pickup' ? witnessPickupDetails() : undefined
  )
  if (!t2.ok) {
    return finish({
      verdict: 'novo_down',
      message: `Même un payload témoin connu-bon échoue dans l'environnement dev Novoxpress : leur API est en panne ou leur schéma a changé globalement. Ce n'est pas un problème de vos données. Créez l'envoi à la main chez Novoxpress et signalez l'incident à leur support.`,
      manualUrl: MANUAL_URL,
    })
  }

  // ── T3+ — substitution d'un groupe à la fois sur le payload réel
  if (op === 'pickup') {
    // Pour le pickup, le shipment dev support doit se créer : si T1 a échoué dès
    // la création du shipment (setupFailed), le fautif est dans details, pas
    // dans pickup_details → on bisecte details comme un label.
    if (t1.setupFailed) {
      for (const group of GROUPS) {
        const mutated = clone(details)
        group.apply(mutated)
        const r = await runAttempt(`T${attempts.length + 1} · ${group.label} remplacé par la valeur témoin`, mutated, pickupDetails)
        if (r.ok) {
          const faultyValue = group.extract(details)
          return finish({
            verdict: 'field_isolated',
            faultyField: group.key,
            faultyLabel: group.label,
            faultyValue,
            message: `Champ fautif isolé : ${group.label}. La valeur réelle ${JSON.stringify(faultyValue)} fait échouer Novoxpress ; remplacée par une valeur témoin, tout passe. C'est un problème de formatage de notre côté — copiez le prompt ci-dessous et donnez-le à Claude pour le fix permanent.`,
            claudePrompt: buildClaudePrompt({ op, shipmentId, group, faultyValue, errorDetail: t1.error || prodError || '' }),
          })
        }
      }
    } else {
      for (const group of PICKUP_GROUPS) {
        const mutatedPickup = clone(pickupDetails)
        group.apply(mutatedPickup)
        const r = await runAttempt(`T${attempts.length + 1} · ${group.label} remplacé par la valeur témoin`, details, mutatedPickup)
        if (r.ok) {
          const faultyValue = group.extract(pickupDetails)
          return finish({
            verdict: 'field_isolated',
            faultyField: group.key,
            faultyLabel: group.label,
            faultyValue,
            message: `Champ fautif isolé : ${group.label}. La valeur réelle ${JSON.stringify(faultyValue)} fait échouer le ramassage ; remplacée par une valeur témoin, tout passe. Copiez le prompt ci-dessous et donnez-le à Claude pour le fix permanent.`,
            claudePrompt: buildClaudePrompt({ op, shipmentId, group, faultyValue, errorDetail: t1.error || prodError || '' }),
          })
        }
      }
    }
  } else {
    for (const group of GROUPS) {
      // Pour l'op rate, le groupe emballage produit surtout des 400 clairs — on
      // le teste quand même : coût marginal d'un appel dev.
      const mutated = clone(details)
      group.apply(mutated)
      const r = await runAttempt(`T${attempts.length + 1} · ${group.label} remplacé par la valeur témoin`, mutated)
      if (r.ok) {
        const faultyValue = group.extract(details)
        return finish({
          verdict: 'field_isolated',
          faultyField: group.key,
          faultyLabel: group.label,
          faultyValue,
          message: `Champ fautif isolé : ${group.label}. La valeur réelle ${JSON.stringify(faultyValue)} fait échouer Novoxpress ; remplacée par une valeur témoin, tout passe. C'est un problème de formatage de notre côté — copiez le prompt ci-dessous et donnez-le à Claude pour le fix permanent.`,
          claudePrompt: buildClaudePrompt({ op, shipmentId, group, faultyValue, errorDetail: t1.error || prodError || '' }),
        })
      }
    }
  }

  return finish({
    verdict: 'not_isolated',
    message: `Le payload réel échoue en dev même après remplacement de chaque champ un à un : la cause n'est pas isolable à un champ unique (combinaison de champs, ou problème côté Novoxpress qui touche aussi leur env dev pour ce cas). Créez l'envoi à la main chez Novoxpress ; si ça passe à la main, signalez le cas à leur support.`,
    manualUrl: MANUAL_URL,
  })
}
