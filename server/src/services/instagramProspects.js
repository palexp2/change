// Prospects Instagram — captation des commentateurs de nos publications.
//
//   1. CAPTATION — ManyChat (déjà approuvé par Meta, ce qui évite à l'ERP une
//      revue d'application) détecte les commentaires sur nos publications et
//      appelle POST /api/instagram/manychat. Trois flux : `comment` (quelqu'un
//      a commenté), `dm_sent` (ManyChat a envoyé le message privé), `reply`
//      (la personne a répondu).
//   2. DÉDUP — l'ERP est la source de vérité. ManyChat ne déclenche qu'une fois
//      par personne ET PAR PUBLICATION : il ne peut donc pas savoir qu'on a déjà
//      écrit à quelqu'un qui commente une deuxième publication. C'est l'ERP qui
//      tranche, via `should_dm` dans la réponse HTTP, sur laquelle le flow
//      ManyChat branche avant d'envoyer le DM.
//   3. MIROIR — chaque fiche est poussée dans la table Airtable « Prospects
//      Instagram », où Philippe édite le suivi et les notes (seuls champs qui
//      remontent vers l'ERP).
//   4. ENVOI — chaque dimanche à minuit (heure de Montréal), la liste des
//      nouveaux prospects part par Slack à Philippe.
//
// Limites de plateforme assumées, documentées pour ne pas être re-questionnées :
//  • Le DM automatique n'est possible qu'en « private reply » à un commentaire
//    (1 seul message par commentaire, dans les 7 jours). Aucun DM à froid.
//  • La liste des NOUVEAUX ABONNÉS est impossible : Meta n'expose que le
//    compteur, à personne. Volet abandonné, ne pas rouvrir sans demande.
//  • Les commentaires d'une publication publiée par un partenaire (Growing for
//    Market) ne sont pas accessibles : Instagram ne les donne qu'au compte
//    éditeur. Le webhook accepte cependant un second ManyChat (celui du
//    partenaire) sans modification.
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'
import { localDay, isoWeekKey, isoWeekday } from './marketingBudget.js'
import { sendSlack, resolveSlackTarget } from './slack.js'
import { writeBackRecord, createInAirtable } from './airtableWriteback.js'
import { APP_URL } from '../config/appUrl.js'
import { TZ } from '../utils/datetime.js'

export const INSTAGRAM_INTAKE_AUTOMATION_ID = 'sys_instagram_prospect_intake'
export const INSTAGRAM_SLACK_AUTOMATION_ID = 'sys_instagram_weekly_slack'

const MAX_TEXT = 4000

export const INSTAGRAM_INTAKE_DEFAULT_CONFIG = {
  keywords: 'coach',          // mots-clés qui déclenchent le DM, séparés par des virgules
}

export const INSTAGRAM_SLACK_DEFAULT_CONFIG = {
  send_weekday: '1',          // ISO : 1=lundi … 7=dimanche. 1 = lundi.
  send_hour: '7',             // heure locale de Montréal. Les minutes (7h30)
                              // viennent du cron : ce champ ne porte que l'heure.
  slack_webhook_url: '',      // URL collée ici = aucun besoin de toucher server/.env
  slack_webhook_env: 'SLACK_WEBHOOK_PHILIPPE',
  recipient: 'Philippe',
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

export function getIntakeConfig() { return loadConfig(INSTAGRAM_INTAKE_AUTOMATION_ID, INSTAGRAM_INTAKE_DEFAULT_CONFIG) }
export function getSlackConfig() { return loadConfig(INSTAGRAM_SLACK_AUTOMATION_ID, INSTAGRAM_SLACK_DEFAULT_CONFIG) }

// ── Helpers purs ────────────────────────────────────────────────────────────

/** Heure locale de Montréal (0-23). h23 explicite : en-CA peut rendre « 24 ». */
export function localHour(date = new Date(), timeZone = TZ) {
  const h = new Intl.DateTimeFormat('en-CA', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(date)
  return Number(h)
}

/** '@Jean_Coach ' → 'Jean_Coach'. Casse conservée (l'affichage compte), vide → null. */
export function normalizeUsername(value) {
  if (value == null) return null
  const v = String(value).trim().replace(/^@+/, '').slice(0, 80)
  return v || null
}

function clean(value, max = MAX_TEXT) {
  if (value == null) return null
  const v = String(value).trim().slice(0, max)
  return v || null
}

/**
 * Clé de dédup. L'IGSID est préféré : il reste stable si la personne renomme
 * son compte, alors qu'un username change et créerait un doublon — donc un
 * second DM à quelqu'un déjà contacté.
 */
export function dedupKeyFor({ ig_user_id, ig_username }) {
  const igsid = clean(ig_user_id, 64)
  if (igsid) return `igsid:${igsid}`
  const user = normalizeUsername(ig_username)
  if (user) return `user:${user.toLowerCase()}`
  return null
}

/**
 * Clé d'idempotence de l'événement. `event_id` de ManyChat (id du commentaire)
 * quand il est fourni, sinon une empreinte du contenu — pour qu'un rejeu de
 * livraison ne regonfle pas comment_count.
 */
export function eventKeyFor({ event_id, kind, dedupKey, text, occurredAt }) {
  const given = clean(event_id, 200)
  if (given) return `${kind}:${given}`
  const basis = [kind, dedupKey || '', clean(text, 500) || '', (occurredAt || '').slice(0, 16)].join('|')
  return `hash:${hashString(basis)}`
}

// FNV-1a 32 bits en hexadécimal — suffisant pour une clé de dédup locale, et
// sans dépendance à crypto pour rester testable trivialement.
function hashString(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

const stripAccents = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '')

/** Distance d'édition (substitutions/insertions/suppressions) entre deux mots. */
function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = 0; i <= a.length; i++) dp[i][0] = i
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1])
    }
  }
  return dp[a.length][b.length]
}

/**
 * 'Je cherche un COACH !' → 'coach'. Accents et casse ignorés, et tolérant aux
 * fautes de frappe courantes (« couch », un mot-clé mal orthographié) : un mot
 * du commentaire à une distance d'édition de 1 (2 pour un mot-clé de plus de
 * 5 lettres) du mot-clé compte comme une correspondance.
 */
export function detectKeyword(text, keywordsCsv = 'coach') {
  if (!text) return null
  const haystack = stripAccents(String(text)).toLowerCase()
  const words = haystack.split(/[^a-z0-9]+/).filter(Boolean)
  for (const raw of String(keywordsCsv).split(',')) {
    const kw = stripAccents(raw.trim()).toLowerCase()
    if (!kw) continue
    if (haystack.includes(kw)) return raw.trim().toLowerCase()
    const maxDist = kw.length <= 5 ? 1 : 2
    for (const w of words) {
      if (Math.abs(w.length - kw.length) > maxDist) continue
      if (levenshtein(w, kw) <= maxDist) return raw.trim().toLowerCase()
    }
  }
  return null
}

function nowIso() { return new Date().toISOString() }

// ── Résolution / fusion de fiche ────────────────────────────────────────────

const PROSPECT_COLS = `
  id, dedup_key, ig_username, ig_user_id, manychat_subscriber_id, full_name, profile_url,
  first_comment_text, first_comment_at, first_post_url, keyword, has_keyword,
  last_comment_text, last_comment_at, last_post_url, comment_count,
  dm_sent, dm_sent_at, replied, replied_at, first_reply_text, reply_count,
  follow_up_status, notes, week_key, notified_at, notified_week, airtable_id, created_at,
  contacted, contacted_at, contacted_by, contacted_source
`

/**
 * Retrouve la fiche d'une personne, en réparant l'historique au passage :
 *  • une fiche créée sans IGSID ('user:jean') est promue en 'igsid:…' dès qu'un
 *    événement apporte l'identifiant stable ;
 *  • si les deux existent (doublon né avant la promotion), on garde la plus
 *    ancienne, on additionne les compteurs, on prend l'OR des booléens — pour
 *    ne jamais perdre la mémoire d'un DM déjà envoyé — et on soft-delete la
 *    seconde, ce qui libère l'index unique partiel.
 * À appeler DANS une transaction.
 */
export function resolveProspect(fields) {
  const igsid = clean(fields.ig_user_id, 64)
  const username = normalizeUsername(fields.ig_username)
  const byIgsid = igsid
    ? db.prepare(`SELECT ${PROSPECT_COLS} FROM instagram_prospects WHERE dedup_key=? AND deleted_at IS NULL`).get(`igsid:${igsid}`)
    : null
  const byUser = username
    ? db.prepare(`SELECT ${PROSPECT_COLS} FROM instagram_prospects WHERE dedup_key=? AND deleted_at IS NULL`).get(`user:${username.toLowerCase()}`)
    : null

  if (byIgsid && byUser && byIgsid.id !== byUser.id) return mergeProspects(byIgsid, byUser)
  if (byIgsid) return byIgsid
  if (byUser) {
    if (igsid) {
      db.prepare(`
        UPDATE instagram_prospects
        SET dedup_key=?, ig_user_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id=?
      `).run(`igsid:${igsid}`, igsid, byUser.id)
      return db.prepare(`SELECT ${PROSPECT_COLS} FROM instagram_prospects WHERE id=?`).get(byUser.id)
    }
    return byUser
  }
  return null
}

function mergeProspects(a, b) {
  const [keep, drop] = (a.created_at || '') <= (b.created_at || '') ? [a, b] : [b, a]
  db.prepare(`
    UPDATE instagram_prospects SET
      comment_count = ?, reply_count = ?,
      dm_sent = ?, dm_sent_at = COALESCE(?, dm_sent_at),
      replied = ?, replied_at = COALESCE(?, replied_at),
      first_reply_text = COALESCE(first_reply_text, ?),
      has_keyword = ?, keyword = COALESCE(keyword, ?),
      notes = ?,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(
    (keep.comment_count || 0) + (drop.comment_count || 0),
    (keep.reply_count || 0) + (drop.reply_count || 0),
    keep.dm_sent || drop.dm_sent ? 1 : 0,
    keep.dm_sent_at || drop.dm_sent_at || null,
    keep.replied || drop.replied ? 1 : 0,
    keep.replied_at || drop.replied_at || null,
    drop.first_reply_text || null,
    keep.has_keyword || drop.has_keyword ? 1 : 0,
    drop.keyword || null,
    [keep.notes, drop.notes].filter(Boolean).join('\n') || null,
    keep.id,
  )
  db.prepare(`UPDATE instagram_prospect_events SET prospect_id=? WHERE prospect_id=?`).run(keep.id, drop.id)
  db.prepare(`
    UPDATE instagram_prospects
    SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(drop.id)
  return db.prepare(`SELECT ${PROSPECT_COLS} FROM instagram_prospects WHERE id=?`).get(keep.id)
}

// ── Ingestion ───────────────────────────────────────────────────────────────

const VALID_KINDS = new Set(['comment', 'dm_sent', 'reply'])

/**
 * Traite un appel de ManyChat. Synchrone (better-sqlite3), tout sous
 * transaction. Le push Airtable est déclenché APRÈS par l'appelant, en
 * fire-and-forget : une panne Airtable ne doit jamais faire perdre un prospect.
 *
 * Retourne { ok, stored, duplicate, is_new, prospect, error }.
 */
export function ingestManychatEvent(payload = {}) {
  const kind = clean(payload.flow, 20) || 'comment'
  if (!VALID_KINDS.has(kind)) return { ok: false, error: `flow invalide : ${kind}` }

  const dedupKey = dedupKeyFor(payload)
  if (!dedupKey) return { ok: false, error: 'Identité du commentateur manquante (ig_user_id ou ig_username requis)' }

  const cfg = getIntakeConfig()
  const text = clean(payload.comment_text ?? payload.text)
  const occurredAt = normalizeOccurredAt(payload.occurred_at)
  const eventKey = eventKeyFor({ event_id: payload.event_id, kind, dedupKey, text, occurredAt })
  const keyword = clean(payload.keyword, 60) || detectKeyword(text, cfg.keywords)

  const run = db.transaction(() => {
    const existingEvent = db.prepare('SELECT prospect_id FROM instagram_prospect_events WHERE event_key=?').get(eventKey)
    if (existingEvent) {
      const current = existingEvent.prospect_id
        ? db.prepare(`SELECT ${PROSPECT_COLS} FROM instagram_prospects WHERE id=?`).get(existingEvent.prospect_id)
        : null
      return { ok: true, stored: false, duplicate: true, is_new: false, prospect: current }
    }

    let prospect = resolveProspect(payload)
    const isNew = !prospect
    if (isNew) prospect = createProspect({ ...payload, kind, dedupKey, text, occurredAt, keyword })
    else prospect = applyEvent(prospect, { ...payload, kind, text, occurredAt, keyword })

    db.prepare(`
      INSERT INTO instagram_prospect_events (id, prospect_id, event_key, kind, payload, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), prospect.id, eventKey, kind, JSON.stringify(payload).slice(0, 8000), occurredAt)

    return { ok: true, stored: true, duplicate: false, is_new: isNew, prospect }
  })

  return run()
}

function normalizeOccurredAt(value) {
  if (!value) return nowIso()
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? nowIso() : d.toISOString()
}

function createProspect(fields) {
  const id = randomUUID()
  const username = normalizeUsername(fields.ig_username)
  const isComment = fields.kind === 'comment'
  const isReply = fields.kind === 'reply'
  // first_comment_at est renseigné même pour un premier événement `reply` ou
  // `dm_sent` : c'est la date de captation, elle porte le tri et la semaine de
  // l'envoi hebdo. Le TEXTE, lui, n'est classé en commentaire que si c'en est un.
  const commentText = isComment ? fields.text : null
  db.prepare(`
    INSERT INTO instagram_prospects (
      id, dedup_key, ig_username, ig_user_id, manychat_subscriber_id, full_name, profile_url,
      first_comment_text, first_comment_at, first_post_url, keyword, has_keyword,
      last_comment_text, last_comment_at, last_post_url, comment_count,
      dm_sent, dm_sent_at, replied, replied_at, first_reply_text, reply_count,
      follow_up_status, week_key, source
    ) VALUES (?,?,?,?,?,?,?, ?,?,?,?,?, ?,?,?,?, ?,?,?,?,?,?, ?,?,?)
  `).run(
    id, fields.dedupKey, username, clean(fields.ig_user_id, 64), clean(fields.manychat_subscriber_id, 64),
    clean(fields.full_name, 200), username ? `https://instagram.com/${username}` : null,
    commentText, fields.occurredAt, clean(fields.post_url, 500), fields.keyword, fields.keyword ? 1 : 0,
    commentText, isComment ? fields.occurredAt : null, clean(fields.post_url, 500), isComment ? 1 : 0,
    (fields.kind === 'dm_sent' || truthy(fields.dm_sent)) ? 1 : 0,
    (fields.kind === 'dm_sent' || truthy(fields.dm_sent)) ? fields.occurredAt : null,
    isReply ? 1 : 0, isReply ? fields.occurredAt : null,
    isReply ? fields.text : null, isReply ? 1 : 0,
    'À contacter', isoWeekKey(localDay(new Date(fields.occurredAt))), clean(fields.source, 20) || 'manychat',
  )
  return db.prepare(`SELECT ${PROSPECT_COLS} FROM instagram_prospects WHERE id=?`).get(id)
}

function truthy(v) {
  return v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true'
}

/**
 * Applique un événement à une fiche existante. Les champs « mémoire » ne sont
 * JAMAIS écrasés : dm_sent_at (sinon on recontacterait), replied_at et
 * first_reply_text (la première réponse est celle qui compte), first_comment_*,
 * et follow_up_status (qui appartient à Philippe).
 */
function applyEvent(prospect, ev) {
  const username = normalizeUsername(ev.ig_username) || prospect.ig_username
  const sets = [
    'ig_username = ?', 'profile_url = ?', 'full_name = COALESCE(?, full_name)',
    'manychat_subscriber_id = COALESCE(?, manychat_subscriber_id)',
    'ig_user_id = COALESCE(?, ig_user_id)',
    'updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\')',
  ]
  const args = [
    username, username ? `https://instagram.com/${username}` : prospect.profile_url,
    clean(ev.full_name, 200), clean(ev.manychat_subscriber_id, 64), clean(ev.ig_user_id, 64),
  ]

  if (ev.kind === 'comment') {
    sets.push('comment_count = comment_count + 1')
    if (ev.text) { sets.push('last_comment_text = ?'); args.push(ev.text) }
    sets.push('last_comment_at = ?'); args.push(ev.occurredAt)
    if (ev.post_url) { sets.push('last_post_url = ?'); args.push(clean(ev.post_url, 500)) }
    // Le mot-clé promeut la fiche mais ne la déclasse jamais : quelqu'un qui a
    // écrit « coach » une fois reste un prospect qualifié.
    if (ev.keyword) { sets.push('keyword = ?', 'has_keyword = 1'); args.push(ev.keyword) }
  }

  if (ev.kind === 'dm_sent' || truthy(ev.dm_sent)) {
    sets.push('dm_sent = 1', 'dm_sent_at = COALESCE(dm_sent_at, ?)')
    args.push(ev.occurredAt)
  }

  if (ev.kind === 'reply') {
    sets.push('replied = 1', 'replied_at = COALESCE(replied_at, ?)', 'reply_count = reply_count + 1')
    args.push(ev.occurredAt)
    if (ev.text) { sets.push('first_reply_text = COALESCE(first_reply_text, ?)'); args.push(ev.text) }
  }

  args.push(prospect.id)
  db.prepare(`UPDATE instagram_prospects SET ${sets.join(', ')} WHERE id = ?`).run(...args)
  return db.prepare(`SELECT ${PROSPECT_COLS} FROM instagram_prospects WHERE id=?`).get(prospect.id)
}

/**
 * Miroir Airtable, best-effort et non bloquant. writeBackRecord/createInAirtable
 * ne throwent pas (ils journalisent dans sync_log et renvoient {skipped|error}),
 * mais on garde le catch : la config Airtable peut manquer et l'ingestion doit
 * réussir quand même.
 */
export const AIRTABLE_TABLE_NAME = 'Prospects Instagram'

/**
 * Résout le table_id Airtable par le NOM de la table.
 *
 * Le jeton n'a que le scope schema.bases:read : la table doit être créée à la
 * main. Mais il n'existe aucune UI pour saisir son identifiant, et un table_id
 * absent laisse le miroir silencieusement vide. On le retrouve donc tout seul
 * dès que la table apparaît dans la base — la config manuelle reste possible et
 * prioritaire (on ne touche rien si table_id est déjà renseigné).
 */
export async function ensureAirtableTableId() {
  const cfg = db.prepare("SELECT base_id, table_id FROM airtable_module_config WHERE module='instagram'").get()
  if (!cfg?.base_id) return { skipped: 'base_id absent' }
  if (cfg.table_id) return { table_id: cfg.table_id, resolved: false }
  try {
    const { getBaseTablesCached } = await import('../connectors/airtable.js')
    const data = await getBaseTablesCached(cfg.base_id)
    const wanted = AIRTABLE_TABLE_NAME.toLowerCase()
    const table = (data?.tables || []).find(t => String(t.name || '').trim().toLowerCase() === wanted)
    if (!table) return { skipped: `table « ${AIRTABLE_TABLE_NAME} » introuvable dans la base` }
    db.prepare("UPDATE airtable_module_config SET table_id=? WHERE module='instagram'").run(table.id)
    console.log(`📸 Prospects Instagram : table Airtable résolue automatiquement (${table.id})`)
    return { table_id: table.id, resolved: true }
  } catch (e) {
    return { error: e.message }
  }
}

export async function pushToAirtable(prospectId) {
  try {
    const row = db.prepare('SELECT airtable_id FROM instagram_prospects WHERE id=?').get(prospectId)
    if (!row) return { skipped: 'fiche introuvable' }
    await ensureAirtableTableId()
    return row.airtable_id
      ? await writeBackRecord('instagram', prospectId)
      : await createInAirtable('instagram', prospectId)
  } catch (e) {
    console.error('instagram prospect → airtable:', e.message)
    return { error: e.message }
  }
}

/** Rattrapage : pousse les fiches jamais arrivées dans Airtable (panne, config posée après coup). */
export async function reconcileAirtable(limit = 200) {
  const rows = db.prepare(`
    SELECT id FROM instagram_prospects
    WHERE airtable_id IS NULL AND deleted_at IS NULL
    ORDER BY created_at LIMIT ?
  `).all(limit)
  let pushed = 0
  for (const r of rows) {
    const res = await createInAirtable('instagram', r.id)
    if (res && !res.skipped && !res.error) pushed++
  }
  return { candidates: rows.length, pushed }
}

// ── Envoi hebdomadaire ──────────────────────────────────────────────────────

/** Prospects jamais annoncés. Le backlog part en entier : personne n'est perdu. */
export function unnotifiedProspects() {
  return db.prepare(`
    SELECT ${PROSPECT_COLS} FROM instagram_prospects
    WHERE notified_at IS NULL AND deleted_at IS NULL
    ORDER BY first_comment_at
  `).all()
}

const WEEKDAY_LABELS = {
  1: 'le lundi', 2: 'le mardi', 3: 'le mercredi', 4: 'le jeudi',
  5: 'le vendredi', 6: 'le samedi', 7: 'le dimanche',
}

function erpProspectsUrl() {
  const base = APP_URL
  return `${base}/erp/prospects-instagram`
}

function airtableUrl() {
  const cfg = db.prepare("SELECT base_id, table_id FROM airtable_module_config WHERE module='instagram'").get()
  return cfg?.base_id && cfg?.table_id ? `https://airtable.com/${cfg.base_id}/${cfg.table_id}` : null
}

/**
 * Semaine ANNONCÉE par le message : celle de la veille du jour d'envoi.
 *
 * L'envoi a lieu le lundi matin et couvre la semaine qui vient de se clore ;
 * `isoWeekKey(lundi)` désignerait la semaine qui commence, donc un décalage
 * d'une semaine dans l'en-tête. La veille (dimanche) retombe sur la bonne.
 * N'affecte que l'affichage : l'idempotence hebdomadaire et `notified_week`
 * restent indexées sur la semaine calendaire de l'envoi.
 */
export function coveredWeek(dayIso) {
  const d = new Date(`${dayIso}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return isoWeekKey(d.toISOString().slice(0, 10))
}

/**
 * Bornes d'une semaine ISO, en clair : '2026-W35' → « du 17 au 23 août ».
 * Le numéro ISO ne dit rien à personne — la date, si.
 */
export function weekRangeLabel(weekKey) {
  const m = /^(\d{4})-W(\d{2})$/.exec(weekKey || '')
  if (!m) return weekKey || 'semaine inconnue'
  const [, year, week] = m
  // Le 4 janvier tombe toujours dans la semaine ISO 1 : on part de son lundi.
  const jan4 = new Date(Date.UTC(Number(year), 0, 4))
  const monday = new Date(jan4)
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (Number(week) - 1) * 7)
  const sunday = new Date(monday)
  sunday.setUTCDate(monday.getUTCDate() + 6)
  const fmt = (d, withMonth) => new Intl.DateTimeFormat('fr-CA', {
    timeZone: 'UTC', day: 'numeric', ...(withMonth ? { month: 'long' } : {}),
  }).format(d)
  // « du 17 au 23 août » quand c'est le même mois, « du 29 septembre au 5 octobre » sinon.
  const sameMonth = monday.getUTCMonth() === sunday.getUTCMonth()
  return `du ${fmt(monday, !sameMonth)} au ${fmt(sunday, true)}`
}

/**
 * Message Slack. Fonction pure → testable sans DB.
 *
 * DÉLIBÉRÉMENT COURT : un résumé chiffré et deux liens, pas la liste des
 * prospects. Le détail vit dans l'ERP et dans Airtable, où Philippe travaille
 * (il coche « contacté ») ; le recopier dans Slack donnerait un pavé à faire
 * défiler, périmé dès qu'une case est cochée.
 */
export function buildWeeklyMessage(prospects, { dayIso, url = null, erpUrl = null } = {}) {
  const header = `:camera_with_flash: *Prospects Instagram — semaine ${weekRangeLabel(coveredWeek(dayIso || localDay()))}*`
  const links = [
    erpUrl ? `<${erpUrl}|Ouvrir la liste dans l'ERP>` : null,
    url ? `<${url}|Ouvrir dans Airtable>` : null,
  ].filter(Boolean)
  const footer = links.length ? `\n${links.join(' · ')}` : ''

  if (!prospects.length) {
    return `${header}\nAucun nouveau prospect cette semaine.${footer}`
  }

  const dmCount = prospects.filter(p => p.dm_sent).length
  const replied = prospects.filter(p => p.replied).length
  const keyword = prospects.filter(p => p.has_keyword).length

  const bits = [`${prospects.length} prospect(s)`]
  if (keyword && keyword !== prospects.length) bits.push(`dont ${keyword} avec le mot-clé`)
  bits.push(`${dmCount} DM envoyé(s)`)
  bits.push(`${replied} ${replied === 1 ? 'a répondu' : 'ont répondu'}`)

  return `${header}\n${bits.join(' · ')}${footer}`
}

function alreadySentThisWeek(dayIso) {
  return !!db.prepare(`
    SELECT 1 FROM automation_logs
    WHERE automation_id = ? AND status = 'success' AND result LIKE ?
    LIMIT 1
  `).get(INSTAGRAM_SLACK_AUTOMATION_ID, `HEBDO ${isoWeekKey(dayIso)}%`)
}

/**
 * Passage du dimanche minuit. Le cron tire à 4h ET 5h UTC (minuit à Montréal en
 * heure d'été puis en heure d'hiver) ; seul le passage où l'heure locale vaut
 * bien `send_hour` envoie, et `alreadySentThisWeek` sert de ceinture.
 * `force` court-circuite jour, heure et idempotence (bouton « Exécuter »).
 */
export async function runWeeklyProspectDigest({ force = false, trigger = 'schedule', today = null, hour = null } = {}) {
  const t0 = Date.now()
  try {
    if (!isSystemAutomationActive(INSTAGRAM_SLACK_AUTOMATION_ID)) return { skipped: 'inactive' }
    const cfg = getSlackConfig()
    const dayIso = today || localDay()
    const nowHour = hour == null ? localHour() : Number(hour)
    const sendDay = Math.min(7, Math.max(1, Number(cfg.send_weekday) || 1))
    const sendHour = Math.min(23, Math.max(0, Number(cfg.send_hour) || 0))

    if (!force) {
      if (isoWeekday(dayIso) !== sendDay) return { ok: true, sent: false, reason: "pas le jour d'envoi" }
      if (nowHour !== sendHour) return { ok: true, sent: false, reason: "pas l'heure d'envoi" }
      if (alreadySentThisWeek(dayIso)) return { ok: true, sent: false, reason: 'déjà envoyé cette semaine' }
    }

    // Rattrapage du miroir avant l'envoi : le lien Airtable du message doit
    // mener à une liste complète. Un échec ici n'empêche pas l'envoi.
    try { await reconcileAirtable() } catch (e) { console.error('instagram reconcile:', e.message) }

    const prospects = unnotifiedProspects()
    const message = buildWeeklyMessage(prospects, { dayIso, url: airtableUrl(), erpUrl: erpProspectsUrl() })

    const res = await sendSlack({
      url: cfg.slack_webhook_url,
      envName: cfg.slack_webhook_env,
      text: message,
      fallbackNote: `${cfg.slack_webhook_env} n'est pas configuré — cette liste devait aller à ${cfg.recipient}.`,
    })

    // Aucun canal joignable : on journalise une ERREUR et on ne marque RIEN, pour
    // que la liste reparte au prochain passage. Jamais de sortie silencieuse —
    // c'est exactement le bug de SLACK_WEBHOOK_MARKETING qu'on refuse de répéter.
    if (!res.sent) {
      logSystemRun(INSTAGRAM_SLACK_AUTOMATION_ID, {
        status: 'error', duration_ms: Date.now() - t0, triggerData: { trigger, day: dayIso },
        error: new Error(`Aucun canal Slack joignable (${res.missing} absent, aucun repli). ` +
          `${prospects.length} prospect(s) non annoncés — ils repartiront au prochain passage.`),
      })
      return { ok: false, sent: false, reason: 'aucun canal Slack', count: prospects.length }
    }

    const mark = db.prepare(`
      UPDATE instagram_prospects
      SET notified_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), notified_week = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?
    `)
    const week = isoWeekKey(dayIso)
    db.transaction(() => { for (const p of prospects) mark.run(week, p.id) })()
    for (const p of prospects) pushToAirtable(p.id).catch(() => {})

    // Seul l'envoi planifié porte le préfixe HEBDO <semaine> : c'est lui qui
    // consomme l'idempotence. Un « Exécuter » manuel ne fait pas sauter le
    // dimanche à venir.
    const scheduled = !force
    logSystemRun(INSTAGRAM_SLACK_AUTOMATION_ID, {
      status: 'success', duration_ms: Date.now() - t0, triggerData: { trigger, day: dayIso },
      result: `${scheduled ? `HEBDO ${week}` : 'ENVOI MANUEL'} — ${prospects.length} prospect(s) annoncé(s) à ${cfg.recipient}` +
        (res.fallback ? ` · ⚠️ envoyé sur le canal de repli (${res.env})` : ''),
    })
    return { ok: true, sent: true, count: prospects.length, fallback: res.fallback, message }
  } catch (e) {
    logSystemRun(INSTAGRAM_SLACK_AUTOMATION_ID, {
      status: 'error', duration_ms: Date.now() - t0, triggerData: { trigger }, error: e,
    })
    console.error('instagramProspects slack:', e.message)
    return { error: e.message }
  }
}

/** Aperçu (bouton « Simuler ») : message qui partirait, sans envoi ni marquage. */
export function previewWeeklyProspectDigest() {
  const cfg = getSlackConfig()
  const prospects = unnotifiedProspects()
  const target = resolveSlackTarget({ url: cfg.slack_webhook_url, envName: cfg.slack_webhook_env })
  const canal = target.url
    ? (target.fallback
        ? `⚠️ ${cfg.slack_webhook_env} absent — repli sur ${target.env}`
        : `canal : ${target.env || 'URL configurée dans cette automation'}`)
    : `⚠️ aucun canal joignable (${cfg.slack_webhook_env} absent de server/.env et aucun repli) — l'envoi échouera`
  return {
    summary: `${prospects.length} prospect(s) à annoncer à ${cfg.recipient} · ` +
      // Les minutes ne sont pas dans la config : elles viennent du cron (7h30
      // le lundi). On les affiche telles quelles pour ne pas laisser croire
      // que l'envoi part à l'heure pile.
      `envoi ${WEEKDAY_LABELS[cfg.send_weekday] || `jour ISO ${cfg.send_weekday}`} vers ${cfg.send_hour} h ` +
      `(heure de Montréal) · ${canal}`,
    apercu: buildWeeklyMessage(prospects, { dayIso: localDay(), url: airtableUrl(), erpUrl: erpProspectsUrl() }),
  }
}

/** Diagnostic de l'intake (bouton « Simuler » de l'automation webhook). */
export async function previewIntake() {
  const cfg = getIntakeConfig()
  // Tente la résolution automatique du table_id : le diagnostic doit refléter
  // l'état réel, pas un « absent » périmé alors que la table vient d'être créée.
  await ensureAirtableTableId()
  const at = db.prepare("SELECT base_id, table_id FROM airtable_module_config WHERE module='instagram'").get()
  // COALESCE : SUM() sur zéro ligne renvoie NULL, ce qui afficherait « null »
  // dans le diagnostic au lieu de 0.
  const counts = db.prepare(`
    SELECT COUNT(*) total,
      COALESCE(SUM(CASE WHEN dm_sent=1 THEN 1 ELSE 0 END), 0) dm,
      COALESCE(SUM(CASE WHEN replied=1 THEN 1 ELSE 0 END), 0) repondu,
      COALESCE(SUM(CASE WHEN airtable_id IS NULL THEN 1 ELSE 0 END), 0) sans_miroir,
      COALESCE(SUM(CASE WHEN notified_at IS NULL THEN 1 ELSE 0 END), 0) a_annoncer
    FROM instagram_prospects WHERE deleted_at IS NULL
  `).get()
  const events = db.prepare('SELECT COUNT(*) n FROM instagram_prospect_events').get()
  return {
    secret: hasIntakeSecret() ? 'configuré' : '⚠️ absent — le webhook répondra 503 à ManyChat',
    airtable: at?.table_id
      ? `base ${at.base_id} · table ${at.table_id}`
      : `⚠️ table introuvable — créer une table nommée exactement « ${AIRTABLE_TABLE_NAME} » dans la base ${at?.base_id || '?'} : ` +
        'elle sera détectée automatiquement au prochain commentaire (ou en relançant cette simulation). ' +
        "Tant qu'elle n'existe pas, les prospects sont bien enregistrés dans l'ERP mais pas encore mis en miroir.",
    mots_cles: cfg.keywords,
    prospects: counts,
    evenements: events.n,
  }
}

// ── Secret partagé du webhook ───────────────────────────────────────────────
// Stocké dans connector_config (et non dans server/.env) pour être rotatable
// depuis l'interface via PUT /api/connectors/config/manychat.

export function getIntakeSecret() {
  const row = db.prepare("SELECT value FROM connector_config WHERE connector='manychat' AND key='webhook_secret'").get()
  const fromDb = row?.value ? String(row.value).trim() : ''
  return fromDb || (process.env.MANYCHAT_WEBHOOK_SECRET || '').trim()
}

export function hasIntakeSecret() { return getIntakeSecret().length >= 16 }
