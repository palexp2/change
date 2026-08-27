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

/** POST { text } sur une URL de webhook entrant Slack. Throw si non-2xx. */
export async function postSlack(url, text) {
  if (!url) throw new Error('URL de webhook Slack manquante')
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

async function findChannelByName(name) {
  const wanted = name.replace(/^#/, '').toLowerCase()
  let cursor
  do {
    const json = await slackApi('conversations.list', {
      types: 'public_channel,private_channel',
      exclude_archived: true,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    })
    const hit = (json.channels || []).find(c => String(c.name).toLowerCase() === wanted)
    if (hit) return hit.id
    cursor = json.response_metadata?.next_cursor || null
  } while (cursor)
  return null
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
  await slackApi('chat.postMessage', { channel, text, unfurl_links: false })
  return channel
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
