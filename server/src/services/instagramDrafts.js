// Messages Instagram : écrits d'avance par l'IA, puis envoyés tout seuls.
//
// DEUX TEMPS, VOLONTAIREMENT SÉPARÉS :
//   1. la rédaction — chaque personne captée reçoit un brouillon ;
//   2. l'envoi — RIEN ne part sans un clic. Le bouton « Envoyer maintenant »
//      met toute la pile en file, et elle se vide d'elle-même au rythme d'un
//      message aux 90 secondes ; ceux mis de côté n'y entrent jamais seuls.
//
// CE QUI NE PART JAMAIS TOUT SEUL : une vraie question, un prix, un problème
// précis, quelqu'un qu'on connaît déjà, une autre langue, une relance après
// silence. La liste est réglable dans la fiche de l'automatisation.
//
// Le passage automatique ne fait QUE vider la file déjà lancée : il ne décide
// jamais d'envoyer quoi que ce soit de lui-même.
import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'
import { SEGMENTS, SEGMENT_LABELS, instructionsForSegment } from './instagramSegments.js'
import { ACTIVITIES, profileOf, arrivalOf } from './instagramProfiles.js'

export const DRAFT_WRITE_AUTOMATION_ID = 'sys_instagram_draft_write'
export const DRAFT_SEND_AUTOMATION_ID = 'sys_instagram_draft_send'

export const DRAFT_WRITE_DEFAULT_CONFIG = {
  model: 'gpt-4o',
  temperature: '0.6',
  max_per_run: '40',
  rules:
    "Tu écris à la place de Philippe, cofondateur d'Orisha (contrôle du climat en serre). " +
    "Message privé Instagram : une ou deux phrases courtes, ton direct et chaleureux, tutoiement. " +
    "Pars de ce que la personne vient de faire, pose UNE question ouverte, ne vends rien. " +
    "Pas d'emoji en rafale, pas de lien sauf si on te le donne, pas de signature.",
  // Ce qui envoie quelqu'un dans la pile « à voir » (une raison par ligne,
  // décocher = retirer la ligne).
  review_rules: [
    'question', 'prix', 'probleme_precis', 'deja_client', 'autre_langue', 'relance_sans_reponse',
  ].join(','),
}

export const DRAFT_SEND_DEFAULT_CONFIG = {
  spacing_seconds: '90',
  start_hour: '8',
  end_hour: '18',
  weekdays: '1,2,3,4,5',
  daily_cap: '40',
}

function loadConfig(automationId, defaults) {
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get(automationId)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch {}
  const merged = { ...defaults }
  for (const k of Object.keys(defaults)) {
    if (cfg[k] != null && String(cfg[k]).trim() !== '') merged[k] = String(cfg[k]).trim()
  }
  return merged
}

export function getWriteConfig() { return loadConfig(DRAFT_WRITE_AUTOMATION_ID, DRAFT_WRITE_DEFAULT_CONFIG) }
export function getSendConfig() { return loadConfig(DRAFT_SEND_AUTOMATION_ID, DRAFT_SEND_DEFAULT_CONFIG) }

const WINDOW_MS = 24 * 60 * 60 * 1000
const OPEN_STATES = ['draft', 'queued', 'review', 'held']

// ── Ce qui demande un jugement humain ───────────────────────────────────────

export const REVIEW_LABELS = {
  question: 'Elle pose une vraie question',
  prix: 'Elle parle de prix ou de devis',
  probleme_precis: 'Elle décrit un problème précis',
  deja_client: 'Déjà cliente ou déjà en discussion',
  autre_langue: 'Message dans une autre langue',
  relance_sans_reponse: 'On lui a déjà écrit sans réponse',
  conversation_en_cours: 'Conversation en cours — un message écrit d’avance tomberait à côté',
  rien_a_dire: 'On ne sait pas ce qu’elle a fait',
  nouveau_message: 'Elle a réécrit depuis',
}

function looksLikeQuestion(t) { return /\?/.test(t) }
function mentionsMoney(t) { return /\b(prix|price|co[uû]t|cost|devis|quote|budget|combien|how much|\$)\b/i.test(t) }
function mentionsProblem(t) {
  return /\b(probl[eè]me|problem|issue|bris|broken|panne|ne fonctionne pas|doesn'?t work|help|aide|urgent)\b/i.test(t)
}
// Ni français ni anglais : on regarde s'il reste des lettres hors alphabet
// latin, ou si aucun mot courant des deux langues n'apparaît dans un texte
// assez long pour en contenir.
function foreignLanguage(t) {
  if (/[\p{Script=Cyrillic}\p{Script=Arabic}\p{Script=Devanagari}\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(t)) return true
  const words = t.trim().split(/\s+/)
  if (words.length < 6) return false
  return !/\b(le|la|les|des|une|un|et|de|du|pour|avec|je|tu|nous|vous|the|and|of|for|with|is|are|to|in|on|you|we|my|our)\b/i.test(t)
}

/**
 * Décide si un brouillon peut partir seul. Retourne la raison (clé de
 * REVIEW_LABELS) ou null quand rien ne s'y oppose.
 */
export function reviewReasonFor({ prospect, incomingText = '', outgoingCount = 0, replied = false, liveConversation = false, activeRules }) {
  const rules = activeRules instanceof Set
    ? activeRules
    : new Set(String(activeRules || getWriteConfig().review_rules).split(',').map(s => s.trim()).filter(Boolean))
  const t = String(incomingText || '')
  if (rules.has('question') && looksLikeQuestion(t)) return 'question'
  if (rules.has('prix') && mentionsMoney(t)) return 'prix'
  if (rules.has('probleme_precis') && mentionsProblem(t)) return 'probleme_precis'
  if (rules.has('deja_client') && prospectIsKnown(prospect)) return 'deja_client'
  if (rules.has('autre_langue') && foreignLanguage(t)) return 'autre_langue'
  if (rules.has('relance_sans_reponse') && liveConversation) return 'conversation_en_cours'
  if (rules.has('relance_sans_reponse') && outgoingCount > 0 && !replied) return 'relance_sans_reponse'
  if (!t && !prospect?.first_comment_text) return 'rien_a_dire'
  return null
}

// « Déjà en discussion » : on lui a déjà écrit et elle a répondu, ou quelqu'un
// a déjà coché « contactée ». Dans les deux cas, un message écrit d'avance
// risque de répéter ce qui vient d'être dit.
function prospectIsKnown(p) {
  if (!p) return false
  return !!(p.contacted || p.replied)
}




// Un vrai échange déjà engagé : elle a écrit plusieurs fois et quelqu'un lui a
// répondu. Un message rédigé d'avance, qui repart de son commentaire d'origine,
// tomberait complètement à côté.
function isLiveConversation(messages) {
  const incoming = messages.filter(m => m.direction === 'in' && m.kind !== 'user_thread_new')
  return incoming.length >= 2 && messages.some(m => m.direction === 'out')
}

// « On lui a déjà écrit sans réponse » ne doit compter que de vraies relances.
// ManyChat répond automatiquement dans la seconde qui suit un commentaire ou un
// message : tout ce qui part dans les dix minutes suivant son geste, c'est la
// machine, pas nous.
const AUTO_REPLY_WINDOW_MS = 10 * 60 * 1000
function countRealFollowUps(messages, incoming) {
  if (!incoming?.sent_at) return 0
  const t0 = new Date(incoming.sent_at).getTime() + AUTO_REPLY_WINDOW_MS
  return messages.filter(m => m.direction === 'out' && m.sent_at && new Date(m.sent_at).getTime() > t0).length
}

// Les mots que la personne a réellement écrits. Nos étiquettes d'activité
// (« 📝 A commenté « Coach » », « 📣 Mention dans une story ») sont de la prose
// à nous : les analyser comme si c'était elle qui parlait faisait passer la
// moitié des fiches pour du chinois.
function userWords(msg) {
  const t = String(msg?.text || '').trim()
  if (!t) return ''
  const quoted = t.match(/^📝 A commenté « (.*) »$/)
  if (quoted) return quoted[1]
  const written = t.match(/^💬 A écrit : « (.*) »$/)
  if (written) return written[1]
  if (/^(📝|💬 A |📣|🔗|✨|📎|📷|🎬|🎧|👤)/u.test(t)) return ''
  return t
}

// ── Cohérence avec le reste de la chaîne ───────────────────────────────────
//
// Un message écrit d'avance devient faux dès que quelque chose bouge ailleurs :
// la fiche est écartée, quelqu'un coche « contactée », Philippe répond à la
// main, ou la personne écrit à nouveau. Sans ces trois portes, la file
// enverrait un message qui ne correspond plus à rien.

/** La fiche est écartée ou déjà traitée : plus rien ne doit partir. */
export function dropOpenDrafts(prospectId, reason = 'Fiche écartée ou déjà contactée') {
  return db.prepare(`
    UPDATE instagram_drafts SET status='dropped', scheduled_at=NULL, error=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE prospect_id=? AND status IN (${OPEN_STATES.map(() => '?').join(',')})
  `).run(reason, prospectId, ...OPEN_STATES).changes
}

/** Philippe a écrit lui-même : le brouillon ne doit pas doubler son message. */
export function dropDraftsForThread(userId, reason = 'Philippe a répondu lui-même') {
  return db.prepare(`
    UPDATE instagram_drafts SET status='dropped', scheduled_at=NULL, error=?,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE manychat_user_id=? AND status IN (${OPEN_STATES.map(() => '?').join(',')})
  `).run(reason, String(userId), ...OPEN_STATES).changes
}

/**
 * La personne vient d'écrire : ce qui était prêt à partir ne répond plus à ce
 * qu'elle dit. On sort le message de la file et on le met devant Philippe.
 */
export function flagDraftsOnIncoming(userId) {
  return db.prepare(`
    UPDATE instagram_drafts SET status='review', review_reason='nouveau_message', scheduled_at=NULL,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE manychat_user_id=? AND status IN ('draft','queued','held')
  `).run(String(userId)).changes
}

// ── Contexte donné au modèle ────────────────────────────────────────────────

function threadFor(prospect) {
  const t = prospect.manychat_subscriber_id
    ? db.prepare('SELECT * FROM manychat_threads WHERE user_id=?').get(String(prospect.manychat_subscriber_id))
    : db.prepare('SELECT * FROM manychat_threads WHERE prospect_id=?').get(prospect.id)
  if (!t) return { thread: null, messages: [] }
  const messages = db.prepare(`
    SELECT direction, text, kind, sent_at FROM manychat_messages
    WHERE user_id=? ORDER BY sent_at
  `).all(t.user_id)
  return { thread: t, messages }
}

function buildContext(prospect, messages) {
  const lines = []
  lines.push(`Nom d'usager Instagram : @${prospect.ig_username}`)
  if (prospect.full_name) lines.push(`Nom : ${prospect.full_name}`)
  if (prospect.capture_label) lines.push(`Ce qu'elle a fait : ${prospect.capture_label}`)
  if (prospect.first_comment_text) lines.push(`Son commentaire : « ${prospect.first_comment_text} »`)
  if (prospect.keyword) lines.push(`Mot-clé déclencheur : ${prospect.keyword}`)
  // Son profil public lu : écrire à la personne qu'elle est vraiment, pas à
  // l'idée qu'on s'en fait d'après un émoji.
  const prof = profileOf(prospect)
  if (prospect.profile_who) lines.push(`Qui c'est : ${prospect.profile_who}`)
  if (prospect.profile_activity) {
    lines.push(`Activité principale : ${ACTIVITIES[prospect.profile_activity] || prospect.profile_activity}` +
      (prospect.profile_level && prospect.profile_level !== 'inconnu' ? ` (${prospect.profile_level})` : ''))
  }
  if (prof?.bio) lines.push(`Bio : ${String(prof.bio).replace(/\s+/g, ' ').slice(0, 200)}`)
  const caps = (prof?.posts || []).map(x => String(x.caption || '').replace(/\s+/g, ' ').slice(0, 120)).filter(Boolean).slice(0, 3)
  if (caps.length) lines.push(`Ses dernières publications : ${caps.map(c => `« ${c} »`).join(' ; ')}`)
  const last = messages.slice(-8)
  if (last.length) {
    lines.push('Conversation (du plus ancien au plus récent) :')
    for (const m of last) {
      lines.push(`- ${m.direction === 'out' ? 'nous' : 'elle'} : ${String(m.text || '').replace(/\s+/g, ' ').slice(0, 220)}`)
    }
  }
  return lines.join('\n')
}

// ── Rédaction ───────────────────────────────────────────────────────────────

async function askModel({ rules, context, instructions, model, temperature }) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY non configuré')
  const specific = (instructions || '').trim()
  const userMessage = `Contexte :\n\n${context}` +
    (specific ? `\n\nINSTRUCTIONS SPÉCIFIQUES (priorité haute) :\n${specific}` : '') +
    // Le contexte est en français ; le message, lui, part toujours en anglais.
    "\n\nÉcris le message privé Instagram, EN ANGLAIS, adapté à son activité réelle (profil ci-dessus) — " +
    'sans lui prêter une culture que son profil ne montre pas. ' +
    // Règle de Charles (2026-10-03) : jamais un chiffre inventé.
    'AUCUN chiffre, mesure, durée, débit, dosage ou prix qui ne figure pas mot pour mot dans le contexte ou ' +
    'les instructions : à une question technique, ne réponds pas toi-même — dis qu\'un de nos experts va lui ' +
    'répondre. JSON strict : { "text": "…" }.'
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      temperature: Math.max(0, Math.min(1.5, Number(temperature) || 0.6)),
      max_tokens: 300,
      messages: [
        { role: 'system', content: rules },
        { role: 'user', content: userMessage },
      ],
    }),
  })
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}))
    throw new Error(err.error?.message || `OpenAI HTTP ${resp.status}`)
  }
  const data = await resp.json()
  const raw = data.choices?.[0]?.message?.content
  if (!raw) throw new Error('Réponse vide')
  let parsed
  try { parsed = JSON.parse(raw) } catch { throw new Error('Réponse illisible') }
  const text = typeof parsed.text === 'string' ? parsed.text.trim() : ''
  if (!text) throw new Error('Message vide')
  return text
}

const PROSPECT_FOR_DRAFT = `
  SELECT id, ig_username, full_name, manychat_subscriber_id, capture_label, capture_url,
         first_comment_text, keyword, contacted, replied, dm_sent, segment,
         profile_json, profile_who, profile_activity, profile_level
  FROM instagram_prospects WHERE id = ? AND deleted_at IS NULL
`

/**
 * Écrit (ou réécrit) le brouillon d'une personne. Un brouillon déjà parti n'est
 * jamais touché ; un brouillon retenu ou à revoir est réécrit sur demande.
 */
export async function writeDraft(prospectId, { instructions, force = false } = {}) {
  const p = db.prepare(PROSPECT_FOR_DRAFT).get(prospectId)
  if (!p) throw new Error('Fiche introuvable')
  if (!p.ig_username) throw new Error('Sans nom d’usager, personne à joindre')

  const existing = db.prepare(`
    SELECT * FROM instagram_drafts WHERE prospect_id=? AND status IN (${OPEN_STATES.map(() => '?').join(',')})
  `).get(prospectId, ...OPEN_STATES)
  if (existing && !force) return { ok: true, draft: existing, unchanged: true }

  const cfg = getWriteConfig()
  const { thread, messages } = threadFor(p)
  const incoming = [...messages].reverse().find(m => m.direction === 'in')
  // On ne compte comme « on lui a déjà écrit » que ce qui est parti APRÈS son
  // dernier geste : la réponse automatique de ManyChat, envoyée dans la seconde
  // qui suit un commentaire, n'est pas une relance restée sans réponse.
  const outgoingCount = countRealFollowUps(messages, incoming)
  const reason = reviewReasonFor({
    prospect: p,
    incomingText: userWords(incoming) || p.first_comment_text || '',
    outgoingCount,
    replied: !!p.replied,
    liveConversation: isLiveConversation(messages),
    activeRules: cfg.review_rules,
  })

  // Question technique : on demande d'abord au chatbot de support, qui connaît
  // la base d'Orisha. Sa réponse est la SEULE source de chiffres permise.
  let context = buildContext(p, messages)
  let expert = null
  if ((p.segment || '') === 'question') {
    const { askSupportBot } = await import('./supportBot.js')
    expert = await askSupportBot(userWords(incoming) || p.first_comment_text || '').catch(() => null)
    // Pas de réponse vérifiée : pas de suggestion du tout, Philippe écrit
    // lui-même (Charles, 2026-10-03). Sauf s'il a donné ses propres consignes.
    if (!expert && !instructions) {
      if (existing) dropOpenDrafts(prospectId, 'Pas de réponse vérifiée — à écrire soi-même')
      else {
        // Trace « écartée » : la tournée ne reposera pas la question à chaque passage.
        const now = new Date().toISOString()
        db.prepare(`
          INSERT INTO instagram_drafts (id, prospect_id, manychat_user_id, ig_username, text, status, error, model, generated_at, created_at, updated_at)
          VALUES (?,?,?,?,'','dropped','Pas de réponse vérifiée — à écrire soi-même',?,?,?,?)
        `).run(newRecordId(), p.id, thread?.user_id || p.manychat_subscriber_id || null, p.ig_username, cfg.model, now, now, now)
      }
      return { ok: true, skipped: 'no_verified_answer' }
    }
    if (expert) {
      context += `\n\nRéponse de l'assistant technique d'Orisha (base de connaissance vérifiée) : « ${expert} »\n` +
        'Résume cette réponse en une ou deux phrases dans le message, sans rien y ajouter.'
    }
  }

  const text = await askModel({
    rules: cfg.rules,
    context,
    // Chaque type de demande a son propre message : celle qui a écrit « coach »
    // ne reçoit pas le même mot que celle qui fait pousser des fleurs.
    instructions: instructions ?? existing?.instructions ?? instructionsForSegment(p.segment || 'commentaire'),
    model: cfg.model,
    temperature: cfg.temperature,
  })

  const now = new Date().toISOString()
  const status = reason ? 'review' : 'draft'
  if (existing) {
    db.prepare(`
      UPDATE instagram_drafts SET text=?, status=?, review_reason=?, instructions=COALESCE(?, instructions),
        model=?, generated_at=?, scheduled_at=NULL, error=NULL, edited=0, updated_at=?
      WHERE id=?
    `).run(text, status, reason, instructions ?? null, cfg.model, now, now, existing.id)
    return { ok: true, draft: getDraft(existing.id), rewritten: true }
  }
  const id = newRecordId()
  db.prepare(`
    INSERT INTO instagram_drafts (id, prospect_id, manychat_user_id, ig_username, text, status,
      review_reason, instructions, model, generated_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, p.id, thread?.user_id || p.manychat_subscriber_id || null, p.ig_username,
    text, status, reason, instructions || null, cfg.model, now, now, now)
  return { ok: true, draft: getDraft(id), created: true }
}

/**
 * Un message que Philippe tape lui-même, sans suggestion au départ : il est
 * gardé comme brouillon retenu (jamais envoyé en lot), pour le retrouver tel
 * quel en revenant.
 */
export function saveManualDraft(prospectId, text) {
  const p = db.prepare('SELECT id, ig_username, manychat_subscriber_id FROM instagram_prospects WHERE id=? AND deleted_at IS NULL').get(prospectId)
  if (!p) throw new Error('Fiche introuvable')
  const clean = String(text || '').trim()
  if (!clean) throw new Error('Message vide')
  const now = new Date().toISOString()
  const existing = db.prepare(`
    SELECT id FROM instagram_drafts WHERE prospect_id=? AND status IN (${OPEN_STATES.map(() => '?').join(',')})
  `).get(prospectId, ...OPEN_STATES)
  if (existing) {
    db.prepare('UPDATE instagram_drafts SET text=?, edited=1, updated_at=? WHERE id=?').run(clean, now, existing.id)
    return getDraft(existing.id)
  }
  const { thread } = threadFor(p)
  const id = newRecordId()
  db.prepare(`
    INSERT INTO instagram_drafts (id, prospect_id, manychat_user_id, ig_username, text, status, edited, created_at, updated_at)
    VALUES (?,?,?,?,?,'held',1,?,?)
  `).run(id, p.id, thread?.user_id || p.manychat_subscriber_id || null, p.ig_username, clean, now, now)
  return getDraft(id)
}

export function getDraft(id) {
  return db.prepare('SELECT * FROM instagram_drafts WHERE id=?').get(id) || null
}

/** Tournée de rédaction : tout le monde qui n'a ni brouillon vivant ni message parti. */
export async function runDraftWriting({ force = false, trigger = 'schedule' } = {}) {
  const t0 = Date.now()
  try {
    if (!force && !isSystemAutomationActive(DRAFT_WRITE_AUTOMATION_ID)) return { skipped: 'inactive' }
    const cfg = getWriteConfig()
    const limit = Math.max(1, Number(cfg.max_per_run) || 40)
    const todo = db.prepare(`
      SELECT p.id FROM instagram_prospects p
      WHERE p.deleted_at IS NULL AND p.ig_username IS NOT NULL AND p.contacted = 0
        AND COALESCE(p.segment,'commentaire') NOT IN ('story','robot')
        AND NOT EXISTS (SELECT 1 FROM instagram_drafts d WHERE d.prospect_id = p.id)
      ORDER BY COALESCE(p.last_event_at, p.created_at) DESC
      LIMIT ?
    `).all(limit)

    let written = 0, toReview = 0
    const problems = []
    for (const row of todo) {
      try {
        const r = await writeDraft(row.id)
        if (r.draft?.status === 'review') toReview++
        if (r.created || r.rewritten) written++
      } catch (e) { problems.push(e.message) }
    }
    const summary = `${written} message(s) écrit(s), dont ${toReview} à voir avec Philippe` +
      (problems.length ? ` · ${problems.length} échec(s)` : '')
    logSystemRun(DRAFT_WRITE_AUTOMATION_ID, {
      status: problems.length && !written ? 'error' : 'success',
      duration_ms: Date.now() - t0, triggerData: { trigger }, result: summary,
    })
    return { ok: true, written, toReview, problems, summary }
  } catch (e) {
    logSystemRun(DRAFT_WRITE_AUTOMATION_ID, { status: 'error', duration_ms: Date.now() - t0, triggerData: { trigger }, error: e })
    return { error: e.message }
  }
}

// ── File d'envoi ────────────────────────────────────────────────────────────

/** Fenêtre Instagram : on ne met en file que ce qui peut effectivement partir. */
export function windowOpen(draft) {
  if (!draft.manychat_user_id) return false
  const t = db.prepare('SELECT last_incoming_at FROM manychat_threads WHERE user_id=?').get(String(draft.manychat_user_id))
  if (!t?.last_incoming_at) return false
  return Date.now() - new Date(t.last_incoming_at).getTime() < WINDOW_MS
}

/**
 * Met en file les brouillons ordinaires et leur donne une heure de départ
 * espacée. C'est le bouton « Envoyer maintenant » quand `now` est vrai, et le
 * passage planifié sinon.
 */
export function queueDrafts({ now = false, ids = null } = {}) {
  const cfg = getSendConfig()
  const spacing = Math.max(5, Number(cfg.spacing_seconds) || 90) * 1000
  const rows = ids?.length
    ? db.prepare(`SELECT * FROM instagram_drafts WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
    : db.prepare("SELECT * FROM instagram_drafts WHERE status='draft' ORDER BY created_at").all()

  // On reprend la file existante là où elle s'arrête, sinon deux mises en file
  // successives feraient partir deux messages en même temps.
  const lastQueued = db.prepare("SELECT MAX(scheduled_at) m FROM instagram_drafts WHERE status='queued'").get()?.m
  let cursor = Math.max(Date.now(), lastQueued ? new Date(lastQueued).getTime() + spacing : 0)

  let queued = 0, blocked = 0
  for (const d of rows) {
    if (!['draft', 'held'].includes(d.status)) continue
    if (!windowOpen(d)) {
      db.prepare("UPDATE instagram_drafts SET status='held', error=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
        .run('Fenêtre de 24 h fermée — Instagram refuse un message tant qu’elle n’écrit pas', d.id)
      blocked++
      continue
    }
    db.prepare("UPDATE instagram_drafts SET status='queued', scheduled_at=?, error=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
      .run(new Date(cursor).toISOString(), d.id)
    cursor += spacing
    queued++
  }
  return { queued, blocked, immediate: !!now }
}

// Heure et jour de Montréal — le serveur tourne en UTC, et un message qui part
// à 3 h du matin chez la personne se lit comme du spam.
export function withinSendingHours(cfg, d = new Date()) {
  const local = new Date(d.toLocaleString('en-US', { timeZone: 'America/Montreal' }))
  const iso = local.getDay() === 0 ? 7 : local.getDay()
  const days = String(cfg.weekdays).split(',').map(x => Number(x.trim())).filter(Boolean)
  if (days.length && !days.includes(iso)) return false
  const hour = local.getHours()
  return hour >= Number(cfg.start_hour) && hour < Number(cfg.end_hour)
}

/**
 * Passage d'envoi : fait partir ce qui est dû. Appelé chaque minute ; ne
 * dépasse jamais le plafond quotidien et respecte les heures ouvrables, sauf
 * quand Philippe a cliqué (`force`).
 */
export async function runDraftQueue({ force = false, trigger = 'schedule' } = {}) {
  const t0 = Date.now()
  try {
    if (!force && !isSystemAutomationActive(DRAFT_SEND_AUTOMATION_ID)) return { skipped: 'inactive' }
    const cfg = getSendConfig()
    if (!force && !withinSendingHours(cfg)) return { skipped: 'hors des heures d’envoi' }

    const sentToday = db.prepare(`
      SELECT COUNT(*) n FROM instagram_drafts
      WHERE status='sent' AND sent_at >= strftime('%Y-%m-%dT00:00:00.000Z','now')
    `).get().n
    const cap = Math.max(1, Number(cfg.daily_cap) || 40)
    if (sentToday >= cap) return { skipped: 'plafond du jour atteint' }

    const due = db.prepare(`
      SELECT * FROM instagram_drafts
      WHERE status='queued' AND (scheduled_at IS NULL OR scheduled_at <= strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      ORDER BY scheduled_at LIMIT ?
    `).all(Math.max(0, cap - sentToday))

    let sent = 0, failed = 0
    const { sendManychatMessage } = await import('./manychat.js')
    const { syncThreadMessages } = await import('./manychatSync.js')
    for (const d of due) {
      if (!windowOpen(d)) {
        db.prepare("UPDATE instagram_drafts SET status='held', error=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
          .run('Fenêtre de 24 h fermée avant l’envoi', d.id)
        continue
      }
      try {
        const out = await sendManychatMessage(d.manychat_user_id, d.text)
        if (out?.state === false) throw new Error(out?.$errors?.[0]?.message || 'Envoi refusé')
        db.prepare(`UPDATE instagram_drafts SET status='sent', sent_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          error=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(d.id)
        db.prepare(`UPDATE instagram_prospects SET dm_sent=1, dm_sent_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          contacted=1, contacted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), contacted_source='boreal',
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(d.prospect_id)
        try { await syncThreadMessages(d.manychat_user_id) } catch { /* le message est parti, le fil se relira */ }
        sent++
      } catch (e) {
        db.prepare("UPDATE instagram_drafts SET status='failed', error=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
          .run(e.message, d.id)
        failed++
      }
    }
    if (sent || failed) {
      logSystemRun(DRAFT_SEND_AUTOMATION_ID, {
        status: failed && !sent ? 'error' : 'success', duration_ms: Date.now() - t0,
        triggerData: { trigger }, result: `${sent} message(s) parti(s)${failed ? `, ${failed} refusé(s)` : ''}`,
      })
    }
    return { ok: true, sent, failed }
  } catch (e) {
    logSystemRun(DRAFT_SEND_AUTOMATION_ID, { status: 'error', duration_ms: Date.now() - t0, triggerData: { trigger }, error: e })
    return { error: e.message }
  }
}

/** Le bouton : met tout en file tout de suite et fait partir le premier. */
export async function sendAllNow() {
  const q = queueDrafts({ now: true })
  const r = await runDraftQueue({ force: true, trigger: 'bouton' })
  return { ...q, ...r }
}

export function holdAll() {
  const n = db.prepare("UPDATE instagram_drafts SET status='held', scheduled_at=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status='queued'").run().changes
  return { held: n }
}

/** Ce que la page affiche : la file, la pile à voir, et ce qui est déjà parti. */
export function listDrafts() {
  const rows = db.prepare(`
    SELECT d.*, p.full_name, p.capture_label, p.capture_url, p.first_comment_text,
           t.last_incoming_at
    FROM instagram_drafts d
    LEFT JOIN instagram_prospects p ON p.id = d.prospect_id
    LEFT JOIN manychat_threads t ON t.user_id = d.manychat_user_id
    WHERE d.status <> 'dropped'
    ORDER BY CASE d.status WHEN 'queued' THEN 0 WHEN 'draft' THEN 1 WHEN 'review' THEN 2
      WHEN 'held' THEN 3 WHEN 'failed' THEN 4 ELSE 5 END,
      COALESCE(d.scheduled_at, d.updated_at)
    LIMIT 300
  `).all()
  const cfg = getSendConfig()
  const next = db.prepare("SELECT MIN(scheduled_at) m FROM instagram_drafts WHERE status='queued'").get()?.m || null
  return {
    drafts: rows.map(r => ({ ...r, review_label: r.review_reason ? REVIEW_LABELS[r.review_reason] || r.review_reason : null })),
    counts: {
      queued: rows.filter(r => r.status === 'queued').length,
      draft: rows.filter(r => r.status === 'draft').length,
      review: rows.filter(r => r.status === 'review').length,
      held: rows.filter(r => r.status === 'held').length,
      failed: rows.filter(r => r.status === 'failed').length,
      sent_today: rows.filter(r => r.status === 'sent' && String(r.sent_at || '').slice(0, 10) === new Date().toISOString().slice(0, 10)).length,
    },
    next_at: next,
    spacing_seconds: Number(cfg.spacing_seconds),
    hours: `${cfg.start_hour} h – ${cfg.end_hour} h`,
    active: isSystemAutomationActive(DRAFT_SEND_AUTOMATION_ID),
  }
}



/**
 * Re-trie les messages déjà écrits sans les réécrire : quand la règle de mise
 * de côté change, la pile doit suivre au lieu de rester figée sur l'ancien
 * verdict.
 */
export function reclassifyDrafts() {
  const rows = db.prepare(`
    SELECT d.id, d.prospect_id, d.manychat_user_id, d.status, d.review_reason,
           p.contacted, p.replied, p.first_comment_text
    FROM instagram_drafts d
    JOIN instagram_prospects p ON p.id = d.prospect_id
    WHERE d.status IN ('draft','queued','review','held')
  `).all()
  const cfg = getWriteConfig()
  let changed = 0
  for (const r of rows) {
    const messages = r.manychat_user_id
      ? db.prepare('SELECT direction, text, kind, sent_at FROM manychat_messages WHERE user_id=? ORDER BY sent_at').all(String(r.manychat_user_id))
      : []
    const incoming = [...messages].reverse().find(m => m.direction === 'in')
    const outgoingCount = countRealFollowUps(messages, incoming)
    const reason = reviewReasonFor({
      prospect: r,
      incomingText: userWords(incoming) || r.first_comment_text || '',
      outgoingCount,
      replied: !!r.replied,
      liveConversation: isLiveConversation(messages),
      activeRules: cfg.review_rules,
    })
    const status = reason ? 'review' : (r.status === 'review' ? 'draft' : r.status)
    if (reason !== r.review_reason || status !== r.status) {
      db.prepare("UPDATE instagram_drafts SET review_reason=?, status=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
        .run(reason, status, r.id)
      changed++
    }
  }
  return { changed, total: rows.length }
}

/**
 * La liste unique de Philippe : les gens qui attendent quelque chose de lui.
 *
 * Y entrent les personnes jamais contactées, et celles qui ont été contactées
 * mais qui ont RÉÉCRIT depuis — ces dernières ressortent de la liste une fois
 * la conversation close, et y reviennent d'elles-mêmes au message suivant.
 */
export function workbench({ all = false } = {}) {
  const rows = db.prepare(`
    SELECT p.id AS prospect_id, p.ig_username, p.full_name, p.capture_label, p.capture_url,
           p.contacted, p.contacted_at, p.replied, p.segment, p.segment_source,
           p.first_comment_text, p.first_comment_at, p.first_post_url, p.capture_kind,
           p.profile_who, p.profile_status, p.profile_activity, p.profile_level,
           t.user_id AS manychat_user_id, t.last_incoming_at, t.last_message_text,
           t.last_message_at, t.last_direction,
           d.id AS draft_id, d.text AS draft_text, d.status AS draft_status,
           d.review_reason, d.scheduled_at, d.error, d.edited
    FROM instagram_prospects p
    LEFT JOIN manychat_threads t ON t.prospect_id = p.id OR t.user_id = p.manychat_subscriber_id
    LEFT JOIN instagram_drafts d ON d.prospect_id = p.id
      AND d.status IN ('draft','queued','review','held','failed')
    WHERE p.deleted_at IS NULL AND p.ig_username IS NOT NULL
      AND COALESCE(p.segment,'commentaire') NOT IN ('story','robot')
      AND (${all ? '1=1 OR' : ''} p.contacted = 0
           OR (t.last_direction = 'in' AND t.last_incoming_at > COALESCE(p.contacted_at,'')))
    ORDER BY COALESCE(t.last_incoming_at, p.last_event_at, p.created_at) DESC
    LIMIT ${all ? 1000 : 400}
  `).all()

  // Une personne écrit à nouveau après avoir été traitée : elle revient dans sa
  // pile, au lieu de rester rangée avec les dossiers clos. Seulement si c'est
  // ELLE qui a le dernier mot : si on lui a répondu depuis, c'est traité.
  const reopened = r => !!(r.contacted && r.last_direction === 'in' && r.last_incoming_at
    && r.last_incoming_at > (r.contacted_at || ''))
  const items = rows.map(r => {
    const segment = SEGMENT_LABELS[r.segment] ? r.segment : 'commentaire'
    const arrival = arrivalOf(r)
    return {
      ...r,
      segment,
      arrival: arrival.text,
      arrival_url: arrival.url,
      arrival_head: arrival.head || null,
      arrival_quote: arrival.quote || null,
      reopened: reopened(r),
      group: r.contacted && !reopened(r) ? 'done' : segment,
      review_label: r.review_reason ? REVIEW_LABELS[r.review_reason] || r.review_reason : null,
      window_open: r.last_incoming_at ? Date.now() - new Date(r.last_incoming_at).getTime() < WINDOW_MS : false,
    }
  })

  const cfg = getSendConfig()
  const next = db.prepare("SELECT MIN(scheduled_at) m FROM instagram_drafts WHERE status='queued'").get()?.m || null
  const counts = {
    ready: items.filter(i => i.group !== 'done' && i.draft_status === 'draft').length,
    review: items.filter(i => i.group !== 'done' && i.draft_status === 'review').length,
    held: items.filter(i => i.group !== 'done' && ['held', 'failed'].includes(i.draft_status)).length,
    queued: items.filter(i => i.draft_status === 'queued').length,
    done: items.filter(i => i.group === 'done').length,
    todo: items.filter(i => i.group !== 'done').length,
  }
  for (const s of SEGMENTS) counts[s.key] = items.filter(i => i.group === s.key).length
  return {
    items,
    segments: SEGMENTS,
    counts,
    next_at: next,
    spacing_seconds: Number(cfg.spacing_seconds),
    hours: `${cfg.start_hour} h – ${cfg.end_hour} h`,
  }
}

/** Aperçu (« Simuler ») : ce qui partirait, sans rien appeler. */
export function previewDraftQueue() {
  const l = listDrafts()
  return {
    prets_a_partir: l.counts.queued + l.counts.draft,
    a_voir_avec_philippe: l.counts.review,
    retenus: l.counts.held,
    prochain_depart: l.next_at || 'aucun',
    espacement: `${l.spacing_seconds} s entre deux messages`,
    heures: l.hours,
  }
}

export function previewDraftWriting() {
  const todo = db.prepare(`
    SELECT COUNT(*) n FROM instagram_prospects p
    WHERE p.deleted_at IS NULL AND p.ig_username IS NOT NULL AND p.contacted = 0
      AND COALESCE(p.segment,'commentaire') NOT IN ('story','robot')
      AND NOT EXISTS (SELECT 1 FROM instagram_drafts d WHERE d.prospect_id = p.id)
  `).get().n
  const cfg = getWriteConfig()
  return {
    sans_message_ecrit: todo,
    modele: cfg.model,
    par_tournee: cfg.max_per_run,
    mis_de_cote_si: String(cfg.review_rules).split(',').map(k => REVIEW_LABELS[k.trim()] || k.trim()).join(' · '),
  }
}
