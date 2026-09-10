// Sondages de satisfaction par SMS — logique métier.
//
// Parcours : bouton dans la fiche d'un billet → SMS Telnyx contenant un lien
// tokenisé → page publique /s/:token → réponse écrite ici → Slack à Philippe
// pour les seuls cas actionnables.
//
// Décisions structurantes (arbitrées avec Guillaume, ne pas les rouvrir sans
// demande explicite) :
//
//  • ENVOI 100 % MANUEL. Aucun déclenchement à la fermeture d'un billet, aucune
//    restriction de statut. C'est l'humain qui juge le moment opportun.
//  • UN SEUL JETON PAR BILLET. Renvoyer réutilise le même lien : en générer un
//    second transformerait le premier SMS en lien mort.
//  • RÉPONSE MODIFIABLE jusqu'à expiration (30 jours). Un client qui reclique
//    par curiosité ou change d'avis doit pouvoir le faire ; un changement
//    déclenche sa propre alerte Slack.
//  • LANGUE OBLIGATOIRE. Sans langue, l'envoi est bloqué en amont — deviner la
//    langue d'un client est plus coûteux qu'un champ à remplir. Depuis la
//    migration 040 (le billet n'a plus de colonne contact), langue et numéro se
//    saisissent à l'envoi ; un renvoi reprend ceux du sondage déjà parti, et le
//    numéro est proposé d'après le contact LIÉ au billet (mobile, puis
//    téléphone) — proposé, donc corrigeable avant l'envoi.
//  • SLACK PARCIMONIEUX. Seuls note ≤ 2, « oui je veux être appelé » et les
//    changements de réponse alertent. Une note de 5 sans commentaire n'appelle
//    aucune action, donc aucun message.

import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { generateBase62Token } from '../utils/shortToken.js'
import { sendSms, toE164 } from './sms.js'
import { sendSlack } from './slack.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'
import { APP_URL } from '../config/appUrl.js'

export const SURVEY_SLACK_AUTOMATION_ID = 'sys_ticket_survey_slack'
export const SURVEY_EXPIRY_DAYS = 30

// Valeurs acceptées par le CHECK de `ticket_surveys.language`.
export const SURVEY_LANGUAGES = ['French', 'English']

// Seuil de la question « accepteriez-vous d'être contacté par téléphone ? ».
// Elle vise les clients SATISFAITS (logique témoignage / référence), pas la
// récupération d'insatisfaits — d'où ≥ 3 et non ≤ 2.
export const CALLBACK_QUESTION_MIN_RATING = 3

// Seuil d'alerte Slack : une note basse est toujours actionnable.
const LOW_RATING_ALERT_MAX = 2

export const SURVEY_SLACK_DEFAULT_CONFIG = {
  slack_channel: '',          // « #canal », « @philippe » ou un courriel — voie bot token, prioritaire
  slack_webhook_url: '',      // URL collée ici = aucun besoin de toucher server/.env
  slack_webhook_env: 'SLACK_WEBHOOK_PHILIPPE',
  recipient: 'Philippe',
  low_rating_max: String(LOW_RATING_ALERT_MAX),
}

export function getSurveySlackConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get(SURVEY_SLACK_AUTOMATION_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch {}
  const merged = { ...SURVEY_SLACK_DEFAULT_CONFIG }
  for (const k of Object.keys(SURVEY_SLACK_DEFAULT_CONFIG)) {
    if (cfg[k] != null && String(cfg[k]).trim() !== '') merged[k] = String(cfg[k]).trim()
  }
  return merged
}

function appUrl() {
  return APP_URL
}

export function surveyUrl(token) {
  return `${appUrl()}/erp/s/${token}`
}

function nowIso() { return new Date().toISOString() }

function expiryIso(fromIso = null) {
  const base = fromIso ? new Date(fromIso) : new Date()
  return new Date(base.getTime() + SURVEY_EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString()
}

// ---------------------------------------------------------------------------
// Éligibilité
// ---------------------------------------------------------------------------

// Identifiants portés par le champ lien `cf_contact` : tableau JSON de clés
// (forme écrite par la sync Airtable), liste séparée par des virgules, ou clé
// seule. Le mapping du champ n'a pas de table cible, donc les clés sont des
// record ids Airtable bruts — mais un id Boréal doit rester accepté au cas où
// le mapping en gagnerait une (cf. link_target_table réécrit les valeurs).
function linkKeys(raw) {
  if (raw == null || raw === '') return []
  let items = raw
  if (typeof raw === 'string') {
    const s = raw.trim()
    if (s.startsWith('[')) { try { items = JSON.parse(s) } catch { items = s.split(',') } }
    else items = s.split(',')
  }
  if (!Array.isArray(items)) items = [items]
  return items.map(v => String(v ?? '').trim()).filter(Boolean)
}

/**
 * Numéro à proposer pour un contact : le MOBILE d'abord — c'est un SMS, un
 * numéro fixe ne le recevra jamais — puis le téléphone à défaut. Beaucoup de
 * contacts n'ont que `phone`, et un numéro proposé se corrige dans la modale ;
 * ne rien proposer obligeait à aller le chercher dans la fiche du contact.
 * Retourne { phone, source } ou null.
 */
export function contactSurveyPhone(contact) {
  const mobile = (contact?.mobile || '').trim()
  if (mobile) return { phone: mobile, source: 'contact_mobile' }
  const phone = (contact?.phone || '').trim()
  if (phone) return { phone, source: 'contact_phone' }
  return null
}

// Contact lié au billet — depuis la migration 040 ce n'est plus une colonne
// native mais le champ LIEN `cf_contact` venu d'Airtable. Le premier lien
// gagne : un billet n'en porte qu'un en pratique.
function ticketContact(ticketId) {
  let raw = null
  try { raw = db.prepare('SELECT cf_contact FROM tickets WHERE id = ?').get(ticketId)?.cf_contact }
  catch { return null }   // colonne absente (champ dé-mappé) : pas de contact, pas d'erreur
  for (const key of linkKeys(raw)) {
    const row = db.prepare(`
      SELECT id, first_name, mobile, phone, language FROM contacts
      WHERE airtable_id = ? OR id = ?
    `).get(key, key)
    if (row) return row
  }
  return null
}

/**
 * Décrit ce qu'un billet propose à l'envoi d'un sondage. La même fonction sert
 * au front (valeurs pré-remplies de la modale) et à la route d'envoi : un seul
 * endroit qui décide, jamais deux règles qui divergent.
 *
 * Ordre des replis pour le numéro :
 *   1. le sondage DÉJÀ envoyé pour ce billet — un renvoi repart au numéro qui a
 *      reçu le premier SMS, pas ailleurs ;
 *   2. le mobile du contact lié au billet (`cf_contact`) ;
 *   3. son téléphone.
 * La langue, elle, reste celle du sondage déjà parti ou la saisie humaine : elle
 * décide du texte envoyé au client, on ne la déduit pas.
 *
 * Retourne { eligible, reason, phone, phone_source, language, contact_id }.
 */
export function surveyEligibility(ticketId) {
  const exists = db.prepare('SELECT id FROM tickets WHERE id = ?').get(ticketId)
  if (!exists) return { eligible: false, reason: 'Billet introuvable' }

  const previous = getSurveyByTicket(ticketId)
  const contact = previous?.phone ? null : ticketContact(ticketId)
  const fromContact = contact ? contactSurveyPhone(contact) : null
  return {
    eligible: true,
    reason: null,
    contact_id: previous?.contact_id || null,
    // Le prénom personnalise le SMS (« Bonjour Marie ») : il ne vient QUE du
    // contact que l'envoi a lui-même enregistré, jamais d'un lien deviné — un
    // billet mal lié saluerait le client par le nom de quelqu'un d'autre.
    first_name: null,
    phone: previous?.phone || fromContact?.phone || null,
    phone_source: previous?.phone ? 'previous' : (fromContact?.source || null),
    language: previous?.language || null,
  }
}

// ---------------------------------------------------------------------------
// Texte du SMS
// ---------------------------------------------------------------------------

/**
 * Message SMS, un seul segment (< 160 caractères avec un lien court).
 * Pas de mention STOP : un sondage de satisfaction n'est pas un message
 * électronique commercial au sens de la LCAP (le CRTC exclut explicitement
 * sondages et recherche de marché), et Telnyx traite STOP au niveau du
 * messaging profile. ATTENTION : ajouter une promo ou un rabais à ce texte le
 * ferait basculer en MEC, et la mention deviendrait obligatoire.
 */
export function buildSmsText({ language, firstName, url }) {
  const name = (firstName || '').trim()
  if (language === 'English') {
    return `Hi${name ? ' ' + name : ''}, this is Orisha. Your support request is complete. Take 15 seconds to rate it: ${url} Thanks!`
  }
  return `Bonjour${name ? ' ' + name : ''}, ici Orisha. Votre demande de soutien est complétée. Prenez 15 secondes pour l'évaluer : ${url} Merci !`
}

// ---------------------------------------------------------------------------
// Envoi
// ---------------------------------------------------------------------------

export function getSurveyByTicket(ticketId) {
  return db.prepare(`
    SELECT * FROM ticket_surveys WHERE ticket_id = ? AND deleted_at IS NULL
  `).get(ticketId)
}

export function getSurveyByToken(token) {
  return db.prepare(`SELECT * FROM ticket_surveys WHERE token = ? AND deleted_at IS NULL`).get(token)
}

/**
 * Envoie (ou renvoie) le sondage d'un billet.
 * `phoneOverride` et `language` viennent de la modale. Les deux peuvent être
 * omis : le sondage déjà parti les porte (renvoi), et à défaut le numéro
 * retombe sur le contact lié au billet (cf. surveyEligibility).
 *
 * Retourne { ok, survey, error }.
 */
export async function sendTicketSurvey(ticketId, { userId = null, phoneOverride = null, language: languageInput = null } = {}) {
  const elig = surveyEligibility(ticketId)
  if (!elig.eligible) return { ok: false, error: elig.reason }

  const overrideE164 = phoneOverride ? toE164(phoneOverride) : null
  if (phoneOverride && !overrideE164) {
    return { ok: false, error: `Numéro invalide : ${phoneOverride}` }
  }

  const phone = overrideE164 || elig.phone
  if (!phone) return { ok: false, error: 'Numéro de téléphone requis' }

  // `ticket_surveys.language` porte un CHECK : une valeur libre ferait échouer
  // l'INSERT après l'envoi du SMS — on refuse avant d'appeler Telnyx.
  const language = languageInput || elig.language
  if (!SURVEY_LANGUAGES.includes(language)) {
    return { ok: false, error: 'Langue requise (français ou anglais)' }
  }

  const existing = getSurveyByTicket(ticketId)

  // Renvoi : même jeton, expiration repoussée (le SMS qui part aujourd'hui doit
  // rester valide 30 jours, pas hériter du décompte de l'envoi initial).
  const token = existing?.token || generateBase62Token(14)
  const url = surveyUrl(token)
  const text = buildSmsText({ language, firstName: elig.first_name, url })

  const result = await sendSms({ to: phone, text })
  const ts = nowIso()

  if (existing) {
    db.prepare(`
      UPDATE ticket_surveys SET
        contact_id = ?, phone = ?, language = ?, expires_at = ?,
        send_status = ?, send_error = ?, telnyx_message_id = ?,
        sent_at = ?, sent_by = ?, delivered_at = NULL,
        send_count = send_count + 1, updated_at = ?
      WHERE id = ?
    `).run(
      elig.contact_id, phone, language, expiryIso(ts),
      result.ok ? 'sent' : 'failed', result.ok ? null : result.error, result.messageId || null,
      result.ok ? ts : null, userId, ts, existing.id
    )
  } else {
    db.prepare(`
      INSERT INTO ticket_surveys
        (id, ticket_id, contact_id, token, language, phone, expires_at,
         send_status, send_error, telnyx_message_id, sent_at, sent_by, send_count,
         created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      newRecordId(), ticketId, elig.contact_id, token, language, phone, expiryIso(ts),
      result.ok ? 'sent' : 'failed', result.ok ? null : result.error, result.messageId || null,
      result.ok ? ts : null, userId, ts, ts
    )
  }

  const survey = getSurveyByTicket(ticketId)
  return result.ok
    ? { ok: true, survey, simulated: !!result.simulated }
    : { ok: false, error: result.error, survey }
}

// ---------------------------------------------------------------------------
// Réponse du client
// ---------------------------------------------------------------------------

export function isExpired(survey) {
  return !!survey?.expires_at && survey.expires_at < nowIso()
}

/**
 * Vue publique d'un sondage — strictement ce dont la page a besoin.
 * Ne fuit ni le numéro de téléphone, ni l'identité du contact, ni l'id interne.
 */
export function publicSurveyView(survey) {
  return {
    language: survey.language,
    // `tickets.title` a été droppée (migration 040) : la page publique n'a plus
    // de titre à rappeler, et n'en avait pas besoin pour noter le service.
    ticket_title: null,
    expired: isExpired(survey),
    rating: survey.rating,
    accepts_call: survey.accepts_call === null ? null : !!survey.accepts_call,
    comment: survey.comment || '',
    responded: !!survey.responded_at,
    callback_question_min_rating: CALLBACK_QUESTION_MIN_RATING,
  }
}

/**
 * Enregistre (ou met à jour) la réponse d'un client, puis notifie Slack si le
 * cas est actionnable. Retourne { ok, survey, error }.
 */
export async function recordSurveyResponse(token, { rating, accepts_call, comment }) {
  const survey = getSurveyByToken(token)
  if (!survey) return { ok: false, status: 404, error: 'Sondage introuvable' }
  if (isExpired(survey)) return { ok: false, status: 410, error: 'Ce sondage a expiré' }

  const r = Number(rating)
  if (!Number.isInteger(r) || r < 1 || r > 5) {
    return { ok: false, status: 400, error: 'Note invalide (1 à 5 attendu)' }
  }

  // La question de rappel n'existe pas sous le seuil : forcer NULL évite qu'un
  // client repassant de 4 à 2 conserve un « accepte un appel » orphelin.
  const accepts = r >= CALLBACK_QUESTION_MIN_RATING
    ? (accepts_call === null || accepts_call === undefined ? null : (accepts_call ? 1 : 0))
    : null

  const cleanComment = comment == null ? null : String(comment).trim().slice(0, 2000) || null
  const previous = survey.responded_at ? { rating: survey.rating, accepts_call: survey.accepts_call, comment: survey.comment } : null
  const ts = nowIso()

  db.prepare(`
    UPDATE ticket_surveys SET
      rating = ?, accepts_call = ?, comment = ?,
      responded_at = ?, response_count = response_count + 1, updated_at = ?
    WHERE id = ?
  `).run(r, accepts, cleanComment, ts, ts, survey.id)

  const updated = getSurveyByToken(token)
  // Slack ne doit jamais faire échouer l'enregistrement de la réponse.
  try { await notifySurveyResponse(updated, previous) } catch { /* journalisé côté notify */ }
  return { ok: true, survey: updated }
}

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------

function stars(n) { return '★'.repeat(n) + '☆'.repeat(5 - n) }

/**
 * Alerte Slack sur les seuls cas actionnables :
 *   • note ≤ low_rating_max (client mécontent)
 *   • « oui, contactez-moi » (occasion de témoignage)
 *   • réponse modifiée (le client a changé d'avis — toujours signalé)
 * Les autres réponses restent silencieuses et se consultent dans la fiche.
 */
export async function notifySurveyResponse(survey, previous = null) {
  const started = Date.now()
  if (!isSystemAutomationActive(SURVEY_SLACK_AUTOMATION_ID)) return { skipped: 'inactive' }

  const cfg = getSurveySlackConfig()
  const lowMax = Number(cfg.low_rating_max) || LOW_RATING_ALERT_MAX
  const changed = !!previous && (
    previous.rating !== survey.rating ||
    previous.accepts_call !== survey.accepts_call ||
    (previous.comment || '') !== (survey.comment || '')
  )
  const isLow = survey.rating <= lowMax
  const wantsCall = survey.accepts_call === 1

  if (!isLow && !wantsCall && !changed) return { skipped: 'not_actionable' }

  // Le billet n'a plus ni titre, ni entreprise, ni contact (migration 040) : le
  // seul contact connu est celui que le sondage a lui-même enregistré à l'envoi.
  const contact = survey.contact_id
    ? db.prepare(`SELECT first_name || ' ' || last_name AS contact_name FROM contacts WHERE id = ?`).get(survey.contact_id)
    : null

  const header = changed
    ? `:repeat: *Sondage modifié* — ${stars(previous.rating || 0)} → ${stars(survey.rating)}`
    : isLow
      ? `:warning: *Client insatisfait* — ${stars(survey.rating)}`
      : `:telephone_receiver: *Accepte un appel* — ${stars(survey.rating)}`

  const lines = [
    header,
    `Billet : ${survey.ticket_id}`,
    contact?.contact_name ? `Client : ${contact.contact_name}` : null,
    wantsCall ? ':white_check_mark: A accepté d\'être contacté par téléphone' : null,
    survey.comment ? `Commentaire : « ${survey.comment} »` : null,
    `${appUrl()}/erp/tickets/${survey.ticket_id}`,
  ].filter(Boolean)

  const text = lines.join('\n')

  try {
    const sent = await sendSlack({
      channel: cfg.slack_channel,
      url: cfg.slack_webhook_url,
      envName: cfg.slack_webhook_env,
      text,
      fallbackNote: `${cfg.slack_webhook_env} n'est pas configuré — l'alerte sondage de ${cfg.recipient} a été redirigée ici.`,
    })
    logSystemRun(SURVEY_SLACK_AUTOMATION_ID, {
      status: sent.sent ? 'success' : 'error',
      result: sent.sent ? text : null,
      error: sent.sent ? null : `Aucun canal Slack joignable (${sent.missing})`,
      // `via` distingue le bot token du webhook de repli : utile quand on se
      // demande pourquoi un message est arrivé sur trésorerie plutôt qu'au
      // destinataire nommé.
      duration_ms: Date.now() - started,
      triggerData: { ticket_id: survey.ticket_id, rating: survey.rating, changed },
    })
    return sent
  } catch (err) {
    logSystemRun(SURVEY_SLACK_AUTOMATION_ID, {
      status: 'error',
      error: err.message,
      duration_ms: Date.now() - started,
      triggerData: { ticket_id: survey.ticket_id },
    })
    return { sent: false, error: err.message }
  }
}

// ---------------------------------------------------------------------------
// Accusés de livraison Telnyx
// ---------------------------------------------------------------------------

// Statuts Telnyx → statut ERP. « accepted »/« queued »/« sending » restent
// `sent` : l'information utile est la livraison finale, pas le transit.
const DLR_MAP = {
  delivered: 'delivered',
  delivery_failed: 'failed',
  delivery_unconfirmed: 'sent',
  sending_failed: 'failed',
  failed: 'failed',
}

/** Applique un accusé de livraison. Retourne le nombre de lignes touchées. */
export function applyDeliveryReceipt({ messageId, status, errorText = null }) {
  if (!messageId) return 0
  const mapped = DLR_MAP[status]
  if (!mapped) return 0
  const ts = nowIso()
  const res = db.prepare(`
    UPDATE ticket_surveys SET
      send_status = ?,
      delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END,
      send_error = ?,
      updated_at = ?
    WHERE telnyx_message_id = ? AND deleted_at IS NULL
  `).run(mapped, mapped, ts, mapped === 'failed' ? (errorText || 'Échec de livraison') : null, ts, messageId)
  return res.changes
}
