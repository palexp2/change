// Envoi Slack — helper partagé.
//
// Le même corps de fonction était recopié dans cinq services planifiés
// (marketingBudget, cardPaymentReminder, treasury, bankTrxSheet, carmAccount).
// Cette version ajoute la résolution du canal réellement joignable : une
// automation dont la variable d'environnement n'est pas configurée doit basculer
// sur un canal de repli AVEC un message préfixé, jamais échouer en silence.
//
// Le piège à ne pas reproduire : SLACK_WEBHOOK_MARKETING est référencée par
// l'automation d'Émilie mais absente de server/.env — l'envoi échoue chaque
// mardi et personne ne le voit passer.

import db from '../db/database.js'
import { decryptCredentials } from '../utils/encryption.js'

const DEFAULT_FALLBACK_ENV = 'SLACK_WEBHOOK_TREASURY'

/**
 * Résout le canal joignable pour une automation.
 * Retourne { url, env, fallback, missing } :
 *  • url présent           → envoyer (fallback=true si c'est le canal de repli)
 *  • url null + missing    → aucun canal configuré, l'appelant DOIT journaliser
 *                            une erreur plutôt que sortir silencieusement.
 * `url` accepte aussi une URL collée directement dans l'action_config de
 * l'automation (éditable depuis la page Automations, sans toucher server/.env).
 */
export function resolveSlackTarget({ url = null, envName = null, fallbackEnv = DEFAULT_FALLBACK_ENV } = {}) {
  if (url && String(url).trim().startsWith('https://')) {
    return { url: String(url).trim(), env: null, fallback: false, missing: null }
  }
  if (envName && process.env[envName]) {
    return { url: process.env[envName], env: envName, fallback: false, missing: null }
  }
  if (fallbackEnv && process.env[fallbackEnv]) {
    return { url: process.env[fallbackEnv], env: fallbackEnv, fallback: true, missing: envName }
  }
  return { url: null, env: null, fallback: false, missing: envName || fallbackEnv }
}

// Une seule app Slack (celle du bot token) : les webhooks entrants de l'ancienne
// app « ERP Orisha » (A0BMC755SRL) sont relayés par chat.postMessage vers le
// canal où chacun postait. Clé = segment `B…` de l'URL (pas secret ; le secret
// est le dernier segment). Un webhook inconnu part encore en direct.
const WEBHOOK_BOT_CHANNELS = {
  B0BRYH9BGKS: 'C0BC7KSM1D5', // SLACK_WEBHOOK_TREASURY  → #comptabilité
  B0BQY08JXSP: 'U06ECMYHNR2', // SLACK_WEBHOOK_PERSO     → DM Antoine Lambert
  B0BR0E7KVGD: 'UUCQBRLF4',   // SLACK_WEBHOOK_GUILLAUME → DM Guillaume Lambert
  B0BR27UPWJ2: 'U0633QP1KUG', // SLACK_WEBHOOK_MARKETING → DM Émilie Carignan
  B0BRV8AB6CT: 'U03GS6BQD5G', // URL collée (prospects Instagram) → DM Philippe
  B0C5JGYTP44: 'C08B0PC5F1Q', // URL collée (factures manquantes) → #informations-importantes
}

export function webhookBotChannel(url) {
  const m = String(url || '').match(/hooks\.slack\.com\/services\/T[A-Z0-9]+\/(B[A-Z0-9]+)\//)
  return m ? WEBHOOK_BOT_CHANNELS[m[1]] || null : null
}

/** POST { text } sur une URL de webhook entrant Slack. Throw si non-2xx. */
export async function postSlack(url, text) {
  if (!url) throw new Error('URL de webhook Slack manquante')
  const botChannel = slackBotToken() ? webhookBotChannel(url) : null
  if (botChannel) { await postSlackChat(botChannel, text); return }
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  if (!resp.ok) throw new Error(`Slack HTTP ${resp.status}`)
}

/**
 * Envoi par nom de variable d'environnement — signature compatible avec les
 * cinq helpers locaux existants, pour faciliter leur migration.
 */
export async function sendSlackWebhook(envName, text) {
  const url = process.env[envName]
  if (!url) throw new Error(`Variable d'environnement manquante : ${envName}`)
  return postSlack(url, text)
}

/**
 * Envoi tolérant au canal manquant. Préfixe le message quand il part sur le
 * repli, pour que le destinataire de secours comprenne pourquoi il le reçoit.
 * Retourne { sent, fallback, env, missing }. Ne throw que sur échec HTTP.
 */
export async function sendSlack({ channel = null, url = null, envName = null, fallbackEnv = DEFAULT_FALLBACK_ENV, text, fallbackNote = null }) {
  // Voie bot token : un canal nommé + SLACK_BOT_TOKEN suffit, aucun webhook à
  // créer. On ne retombe PAS silencieusement sur le webhook si Slack refuse —
  // un canal mal orthographié doit remonter comme erreur, pas partir ailleurs.
  if (channel && String(channel).trim() && slackBotToken()) {
    const resolved = await postSlackChat(String(channel).trim(), text)
    return { sent: true, fallback: false, via: 'bot', channel: resolved, env: null, missing: null }
  }

  const target = resolveSlackTarget({ url, envName, fallbackEnv })
  if (!target.url) return { sent: false, fallback: false, env: null, missing: target.missing }

  const body = target.fallback
    ? `:warning: _${fallbackNote || `${target.missing} n'est pas configuré — ce message a été redirigé ici.`}_\n\n${text}`
    : text
  await postSlack(target.url, body)
  return { sent: true, fallback: target.fallback, via: 'webhook', env: target.env, missing: target.missing }
}

// ---------------------------------------------------------------------------
// API Slack par bot token (chat.postMessage)
// ---------------------------------------------------------------------------
//
// Pourquoi cette seconde voie : un incoming webhook est figé sur UN canal, donc
// chaque nouveau destinataire exigeait une variable d'environnement de plus
// (c'est ainsi qu'on s'est retrouvé avec SLACK_WEBHOOK_PHILIPPE référencée mais
// jamais créée, et l'alerte sondage silencieusement redirigée sur trésorerie).
// Avec un bot token, l'automation nomme simplement son canal (« #support »,
// « @philippe » ou un courriel) et l'ERP résout l'identifiant lui-même.
//
// Scopes requis sur l'app Slack : chat:write, chat:write.public,
// channels:read, groups:read, users:read, users:read.email.
// Pas besoin de im:write : chat.postMessage adressé à un identifiant `U…`
// ouvre le message privé de lui-même (conversations.open, lui, exigerait ce
// scope — d'où le choix de ne pas l'appeler).
//
// Précédence dans sendSlack : channel + bot token > url collée > envName >
// canal de repli. Le webhook reste donc le filet, sans rien à réécrire.

const SLACK_API = 'https://slack.com/api'

export function slackBotToken() {
  return process.env.SLACK_BOT_TOKEN || null
}

// Corps encodé en formulaire, pas en JSON : plusieurs méthodes Web API
// (users.lookupByEmail en tête) refusent un body JSON avec
// « invalid_arguments ». Le formulaire est accepté par toutes.
async function slackApi(method, body = {}) {
  const token = slackBotToken()
  if (!token) throw new Error('SLACK_BOT_TOKEN absent')
  const form = new URLSearchParams()
  for (const [k, v] of Object.entries(body)) {
    if (v !== undefined && v !== null) form.set(k, typeof v === 'boolean' ? String(v) : String(v))
  }
  const resp = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
    },
    body: form.toString(),
  })
  const json = await resp.json().catch(() => null)
  if (!resp.ok) throw new Error(`Slack ${method} HTTP ${resp.status}`)
  if (!json?.ok) throw new Error(`Slack ${method} : ${json?.error || 'réponse illisible'}`)
  return json
}

// Résolution nom → identifiant : un appel d'API par destinataire coûte cher sur
// une automation qui tourne souvent, et les ids ne changent pas. TTL court
// quand même, pour qu'un canal renommé ou recréé se rattrape sans redémarrage.
const CHANNEL_CACHE_TTL_MS = 30 * 60 * 1000
const channelCache = new Map()

function cacheGet(key) {
  const hit = channelCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.at > CHANNEL_CACHE_TTL_MS) { channelCache.delete(key); return null }
  return hit.id
}

function cacheSet(key, id) {
  channelCache.set(key, { id, at: Date.now() })
  return id
}

/** Vide le cache de résolution (utile après un renommage de canal). */
export function clearSlackChannelCache() { channelCache.clear() }

// « #comptabilite » doit trouver #comptabilité : un accent oublié ne doit pas
// faire taire une alerte.
const bareName = v => String(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()

async function findChannelByName(name) {
  const wanted = bareName(name.replace(/^#/, ''))
  let cursor
  do {
    const json = await slackApi('conversations.list', {
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    })
    const hit = (json.channels || []).find(c => bareName(c.name) === wanted)
    if (hit) return hit.id
    cursor = json.response_metadata?.next_cursor || null
  } while (cursor)
  return null
}

/** Canaux (publics + privés où le bot est membre), non archivés, triés par nom. */
export async function listSlackChannels() {
  const out = []
  let cursor
  do {
    const json = await slackApi('conversations.list', {
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    })
    for (const c of json.channels || []) out.push({ id: c.id, name: c.name, private: !!c.is_private })
    cursor = json.response_metadata?.next_cursor || null
  } while (cursor)
  return out.sort((a, b) => a.name.localeCompare(b.name, 'fr'))
}

/**
 * Personnes (humains actifs), triées par nom. `dm` = id du message privé déjà
 * ouvert avec le bot, s'il existe : une ancienne cible « D… » s'affiche par nom.
 */
export async function listSlackUsers() {
  const out = []
  let cursor
  do {
    const json = await slackApi('users.list', { limit: 200, ...(cursor ? { cursor } : {}) })
    for (const u of json.members || []) {
      if (u.deleted || u.is_bot || u.id === 'USLACKBOT') continue
      out.push({ id: u.id, name: u.profile?.real_name || u.real_name || u.name })
    }
    cursor = json.response_metadata?.next_cursor || null
  } while (cursor)
  const dms = new Map()
  try {
    cursor = undefined
    do {
      const json = await slackApi('conversations.list', { types: 'im', limit: 200, ...(cursor ? { cursor } : {}) })
      for (const c of json.channels || []) dms.set(c.user, c.id)
      cursor = json.response_metadata?.next_cursor || null
    } while (cursor)
  } catch { /* lecture des messages privés facultative */ }
  return out.map(u => ({ ...u, dm: dms.get(u.id) || null })).sort((a, b) => a.name.localeCompare(b.name, 'fr'))
}

async function findUserByHandle(handle) {
  const wanted = handle.replace(/^@/, '').toLowerCase()
  let cursor
  do {
    const json = await slackApi('users.list', { limit: 200, ...(cursor ? { cursor } : {}) })
    const hit = (json.members || []).find(u =>
      !u.deleted && [u.name, u.profile?.display_name, u.profile?.real_name]
        .filter(Boolean).some(v => String(v).toLowerCase() === wanted))
    if (hit) return hit.id
    cursor = json.response_metadata?.next_cursor || null
  } while (cursor)
  return null
}

/**
 * Résout une cible écrite par un humain en identifiant de conversation Slack :
 *  • `C…` / `G…` / `D…`      → tel quel (déjà un id)
 *  • `U…`                    → DM avec cet utilisateur
 *  • `quelqu'un@orisha.io`   → DM (lookup par courriel)
 *  • `@philippe`             → DM (lookup par handle / nom affiché)
 *  • `#support` / `support`  → canal public ou privé du même nom
 * Throw un message explicite si introuvable : mieux vaut une erreur journalisée
 * qu'un message parti au mauvais endroit.
 */
export async function resolveSlackChannelId(target) {
  const raw = String(target || '').trim()
  if (!raw) throw new Error('Canal Slack non renseigné')

  const cached = cacheGet(raw)
  if (cached) return cached

  if (/^[CGD][A-Z0-9]{6,}$/.test(raw)) return cacheSet(raw, raw)

  // Un id d'utilisateur est une cible valide telle quelle pour chat.postMessage.
  if (/^U[A-Z0-9]{6,}$/.test(raw)) return cacheSet(raw, raw)

  if (raw.includes('@') && raw.includes('.') && !raw.startsWith('@')) {
    const json = await slackApi('users.lookupByEmail', { email: raw })
    const userId = json.user?.id
    if (!userId) throw new Error(`Aucun utilisateur Slack pour ${raw}`)
    return cacheSet(raw, userId)
  }

  if (raw.startsWith('@')) {
    const userId = await findUserByHandle(raw)
    if (!userId) throw new Error(`Aucun utilisateur Slack nommé ${raw}`)
    return cacheSet(raw, userId)
  }

  const channelId = await findChannelByName(raw)
  if (!channelId) throw new Error(`Canal Slack introuvable : ${raw} (le bot y est-il invité ?)`)
  return cacheSet(raw, channelId)
}

/** Poste un message via chat.postMessage. Throw si Slack refuse. */
export async function postSlackChat(target, text) {
  const channel = await resolveSlackChannelId(target)
  // Message privé à une personne : il part du compte d'Antoine quand son jeton
  // personnel est branché (Connecteurs → Instagram), pas de l'app « ERP Orisha ».
  if (/^U/.test(channel)) {
    const sent = await postAsUser(channel, text)
    if (sent) return sent
  }
  await slackApi('chat.postMessage', { channel, text, unfurl_links: false })
  return channel
}

// ── Envoi au nom d'une personne (jeton Slack personnel xoxp-) ──────────────

export function slackUserToken() {
  const v = db.prepare("SELECT value FROM connector_config WHERE connector='slack' AND key='user_token'").get()?.value
  if (!v) return null
  try { return decryptCredentials(v) || null } catch { return null }
}

async function userApi(token, method, body = {}) {
  const form = new URLSearchParams()
  for (const [k, v] of Object.entries(body)) if (v != null) form.set(k, String(v))
  const resp = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
    body: form.toString(),
  })
  const json = await resp.json().catch(() => ({}))
  if (!json.ok) throw new Error(`Slack (compte personnel) ${method} : ${json.error || resp.status}`)
  return json
}

let ownerCache = null
/** Qui est derrière le jeton personnel (son identifiant Slack et son nom). */
export async function slackUserIdentity() {
  const token = slackUserToken()
  if (!token) return null
  if (ownerCache?.token === token) return ownerCache.who
  const json = await userApi(token, 'auth.test')
  ownerCache = { token, who: { id: json.user_id, name: json.user } }
  return ownerCache.who
}

/**
 * Message privé envoyé par la personne du jeton. Rend l'identifiant de la
 * conversation, ou null s'il n'y a pas de jeton (ou si c'est à elle-même :
 * ses propres rappels restent signés par l'app, sinon ils ne la notifieraient pas).
 */
async function postAsUser(userId, text) {
  const token = slackUserToken()
  if (!token) return null
  const me = await slackUserIdentity()
  if (!me || me.id === userId) return null
  const dm = await userApi(token, 'conversations.open', { users: userId })
  await userApi(token, 'chat.postMessage', { channel: dm.channel.id, text, unfurl_links: false })
  return dm.channel.id
}

/** Diagnostic de la connexion bot (page Connecteurs / test manuel). */
export async function slackBotIdentity() {
  if (!slackBotToken()) return { connected: false, error: 'SLACK_BOT_TOKEN absent' }
  try {
    const json = await slackApi('auth.test')
    return { connected: true, team: json.team, bot: json.user, team_id: json.team_id }
  } catch (err) {
    return { connected: false, error: err.message }
  }
}
