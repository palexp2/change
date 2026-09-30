// Connexion ManyChat — compte, session, sonde de santé.
//
// POURQUOI UNE SESSION IMPORTÉE À LA MAIN plutôt qu'un identifiant et un mot
// de passe : la page de connexion de ManyChat est protégée par le contrôle
// anti-robot de Cloudflare. Un navigateur piloté depuis le serveur reste bloqué
// sur « Vérification de sécurité en cours » — vérifié le 2026-09-12, y compris
// après 25 secondes d'attente. C'est exactement le cas prévu par l'import de
// session déjà en place pour Wix (routes/scrapers.js) : la personne se connecte
// dans SON navigateur, exporte les témoins avec Cookie-Editor, et les colle
// dans l'ERP.
//
// Le compte vit dans `scraper_accounts` (vendor='manychat') pour réutiliser le
// chiffrement au repos et le stockage de session, mais il ne passe PAS par
// l'orchestrateur de collecte de factures : celui-ci est câblé sur la
// livraison de documents, ce que ManyChat ne produit pas.
import db from '../db/database.js'
import { encryptCredentials, decryptCredentials } from '../utils/encryption.js'
import { parseSessionPayload, sessionCoversDomain } from './scrapers/session.js'
import { recordSessionStatus } from './sessionHealth.js'
import { newRecordId } from '../utils/recordId.js'

export const MANYCHAT_VENDOR = 'manychat'
export const MANYCHAT_DOMAIN = 'manychat.com'

function nowIso() { return new Date().toISOString() }

export function getManychatAccount() {
  return db.prepare(`
    SELECT * FROM scraper_accounts WHERE vendor=? AND deleted_at IS NULL ORDER BY created_at LIMIT 1
  `).get(MANYCHAT_VENDOR) || null
}

/** État affichable : jamais le mot de passe, jamais les témoins. */
export function publicManychatAccount() {
  const row = getManychatAccount()
  const health = db.prepare("SELECT status, detail, checked_at, last_ok_at FROM connector_sessions WHERE connector='manychat'").get() || null
  return {
    configured: !!row,
    username: row?.username || null,
    has_password: !!row?.password_enc,
    has_session: !!row?.storage_state_enc,
    session_at: row?.storage_state_at || null,
    health,
  }
}

/** Crée ou met à jour le compte. Un mot de passe vide ne l'efface pas. */
export function saveManychatAccount({ username = null, password = null } = {}) {
  const row = getManychatAccount()
  if (!row) {
    const id = newRecordId()
    db.prepare(`
      INSERT INTO scraper_accounts (id, vendor, label, username, password_enc, enabled)
      VALUES (?, ?, ?, ?, ?, 1)
    `).run(id, MANYCHAT_VENDOR, `ManyChat — ${username || 'compte'}`, username, password ? encryptCredentials(password) : null)
    return getManychatAccount()
  }
  const sets = ['updated_at = ?']
  const args = [nowIso()]
  if (username != null) { sets.push('username = ?'); args.push(username) }
  if (password) { sets.push('password_enc = ?'); args.push(encryptCredentials(password)) }
  args.push(row.id)
  db.prepare(`UPDATE scraper_accounts SET ${sets.join(', ')} WHERE id = ?`).run(...args)
  return getManychatAccount()
}

/**
 * Importe une session exportée du navigateur (Cookie-Editor, storageState
 * Playwright, ou en-tête brut). Refuse un export qui ne contient aucun témoin
 * de ManyChat : c'est l'erreur la plus courante (export fait depuis le mauvais
 * onglet) et elle serait autrement invisible jusqu'à la première tournée.
 */
export function importManychatSession(payload) {
  const row = getManychatAccount() || saveManychatAccount({})
  const state = parseSessionPayload(payload, MANYCHAT_DOMAIN)
  if (!sessionCoversDomain(state, MANYCHAT_DOMAIN)) {
    throw new Error(`Aucun témoin de ${MANYCHAT_DOMAIN} dans cet export — l'exporter depuis l'onglet ManyChat, une fois connecté`)
  }
  db.prepare('UPDATE scraper_accounts SET storage_state_enc=?, storage_state_at=?, updated_at=? WHERE id=?')
    .run(encryptCredentials(JSON.stringify(state)), nowIso(), nowIso(), row.id)
  return { ok: true, cookies: state.cookies.length }
}

export function forgetManychatSession() {
  const row = getManychatAccount()
  if (!row) return { ok: true }
  db.prepare('UPDATE scraper_accounts SET storage_state_enc=NULL, storage_state_at=NULL, updated_at=? WHERE id=?')
    .run(nowIso(), row.id)
  return { ok: true }
}

/**
 * ManyChat renouvelle sa session en renvoyant de nouveaux témoins à chaque
 * appel, comme il le fait avec un navigateur. On les garde : sans ça, on
 * rejouait indéfiniment ceux du jour où la session a été collée, et elle
 * mourait au bout d'une semaine environ.
 */
export function absorbManychatCookies(res) {
  let fresh = []
  try { fresh = res?.headers?.getSetCookie?.() || [] } catch { fresh = [] }
  if (!fresh.length) return 0
  const row = getManychatAccount()
  if (!row?.storage_state_enc) return 0
  let state
  try { state = JSON.parse(decryptCredentials(row.storage_state_enc)) } catch { return 0 }
  const cookies = state.cookies || (state.cookies = [])
  let changed = 0
  for (const line of fresh) {
    const [pair, ...attrs] = String(line).split(';')
    const eq = pair.indexOf('=')
    if (eq <= 0) continue
    const name = pair.slice(0, eq).trim()
    const value = pair.slice(eq + 1).trim()
    const attr = k => attrs.map(a => a.trim()).find(a => a.toLowerCase().startsWith(`${k}=`))?.split('=').slice(1).join('=')
    const maxAge = attr('max-age')
    const expiresAttr = attr('expires')
    const expires = maxAge != null ? Math.floor(Date.now() / 1000) + Number(maxAge)
      : expiresAttr ? Math.floor(new Date(expiresAttr).getTime() / 1000) : -1
    const domain = attr('domain') || 'app.manychat.com'
    // Un témoin effacé par le serveur (expiré, vide) n'est pas une rotation :
    // on garde l'ancien plutôt que de s'amputer d'un témoin de session.
    if (!value || (expires > 0 && expires * 1000 < Date.now())) continue
    const i = cookies.findIndex(c => c.name === name)
    if (i >= 0) {
      if (cookies[i].value === value) continue
      cookies[i] = { ...cookies[i], value, expires }
    } else {
      cookies.push({ name, value, domain, path: attr('path') || '/', expires, httpOnly: true, secure: true })
    }
    changed++
  }
  if (changed) {
    db.prepare('UPDATE scraper_accounts SET storage_state_enc=?, updated_at=? WHERE id=?')
      .run(encryptCredentials(JSON.stringify(state)), nowIso(), row.id)
  }
  return changed
}

/** Témoins de session, prêts pour un en-tête Cookie. */
export function manychatCookieHeader() {
  const row = getManychatAccount()
  if (!row?.storage_state_enc) return null
  try {
    const state = JSON.parse(decryptCredentials(row.storage_state_enc))
    const cookies = (state.cookies || []).filter(c => String(c.domain || '').includes('manychat'))
    if (!cookies.length) return null
    return cookies.map(c => `${c.name}=${c.value}`).join('; ')
  } catch { return null }
}

export function hasManychatSession() {
  return !!manychatCookieHeader()
}

export function manychatStorageState() {
  const row = getManychatAccount()
  if (!row?.storage_state_enc) return null
  try { return JSON.parse(decryptCredentials(row.storage_state_enc)) } catch { return null }
}

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

/**
 * Sonde de santé. Même contrat que celle d'Instagram : « expired » veut dire
 * « refais la connexion », « error » veut dire « on n'a pas pu conclure » — on
 * n'envoie jamais quelqu'un rouvrir une session pour une coupure réseau ou un
 * contrôle anti-robot.
 */
export async function probeManychat() {
  const cookie = manychatCookieHeader()
  if (!cookie) {
    return recordSessionStatus('manychat', {
      status: 'error',
      detail: 'Aucune session ManyChat — la coller dans Connecteurs → ManyChat.',
    })
  }
  // On sonde la page même que lit la tournée : la racine du site redirige
  // toujours, connecté ou non, et passait donc une session morte pour valide.
  const pageId = manychatPageId()
  let res, body = ''
  try {
    res = await fetch(`https://app.manychat.com/${pageId || ''}${pageId ? '/subscribers' : ''}`, {
      headers: { 'User-Agent': UA, accept: 'text/html,application/json', cookie },
      redirect: 'manual',
      signal: AbortSignal.timeout(20_000),
    })
    body = await res.text()
    absorbManychatCookies(res)
  } catch (e) {
    return recordSessionStatus('manychat', { status: 'error', detail: `ManyChat injoignable : ${e.message}` })
  }
  const loc = res.headers.get('location') || ''
  if ((pageId && res.status >= 300 && res.status < 400) || /\/(login|signin)\b/i.test(loc) || res.status === 401 || res.status === 403) {
    return recordSessionStatus('manychat', {
      status: 'expired',
      detail: 'ManyChat renvoie vers sa page de connexion — rouvrir une session dans Connecteurs → ManyChat.',
    })
  }
  // Cloudflare peut intercepter l'appel sans que la session soit en cause.
  if (/Vérification de sécurité|Just a moment|cf-turnstile/i.test(body)) {
    return recordSessionStatus('manychat', {
      status: 'error',
      detail: 'Contrôle anti-robot de ManyChat — vérification non concluante, la session n’est pas forcément en cause',
    })
  }
  if (!res.ok && !(res.status >= 300 && res.status < 400)) {
    return recordSessionStatus('manychat', { status: 'error', detail: `ManyChat a répondu ${res.status}` })
  }
  return recordSessionStatus('manychat', { status: 'ok', detail: 'session valide' })
}

// ── Appels à l'interface web de ManyChat ────────────────────────────────────
//
// Pas besoin de navigateur pour lire ou écrire : les appels de l'application
// web acceptent nos témoins de session accompagnés du jeton anti-rejeu, qui se
// lit dans la page HTML. Le navigateur ne sert qu'à ouvrir la session au
// départ (page de connexion protégée par Cloudflare).

let cachedToken = null
let cachedTokenAt = 0
const TOKEN_TTL_MS = 20 * 60 * 1000

/** Identifiant de la page ManyChat (« fb3958601 »), lu dans les témoins. */
export function manychatPageId() {
  const row = db.prepare("SELECT value FROM connector_config WHERE connector='manychat' AND key='page_id'").get()
  if (row?.value) return row.value
  const state = manychatStorageState()
  const c = (state?.cookies || []).find(x => x.name === '_mc_zd_dashboard_session')
  return c?.value || null
}

async function fetchCsrfToken() {
  const pageId = manychatPageId()
  const cookie = manychatCookieHeader()
  if (!pageId || !cookie) throw new Error('Session ManyChat absente')
  const res = await fetch(`https://app.manychat.com/${pageId}/subscribers`, {
    headers: { cookie, 'User-Agent': UA, accept: 'text/html' },
    redirect: 'manual',
    signal: AbortSignal.timeout(20_000),
  })
  absorbManychatCookies(res)
  if (res.status >= 300 && res.status < 400) throw new Error('Session ManyChat expirée')
  const html = await res.text()
  const token = (html.match(/csrf[_-]?token["':\s]+([a-f0-9]{16,})/i) || [])[1]
  if (!token) throw new Error('Jeton ManyChat introuvable — la session est probablement expirée')
  cachedToken = token
  cachedTokenAt = Date.now()
  return token
}

async function csrfToken(force = false) {
  if (!force && cachedToken && Date.now() - cachedTokenAt < TOKEN_TTL_MS) return cachedToken
  return fetchCsrfToken()
}

/**
 * Appel à ManyChat. Réessaie une fois avec un jeton frais : le jeton tourne
 * régulièrement et une seule reprise évite de faire échouer une tournée
 * entière pour ça.
 */
export async function mcFetch(path, { method = 'GET', body = null, retry = true } = {}) {
  const pageId = manychatPageId()
  const cookie = manychatCookieHeader()
  if (!pageId || !cookie) throw new Error('Session ManyChat absente — la rouvrir dans Connecteurs → ManyChat')
  const token = await csrfToken()
  const res = await fetch(`https://app.manychat.com/${pageId}${path}`, {
    method,
    headers: {
      cookie, 'x-csrf-token': token, 'x-requested-with': 'XMLHttpRequest',
      'use-new-error-format': 'True', accept: 'application/json', 'User-Agent': UA,
      referer: `https://app.manychat.com/${pageId}/chat`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
    signal: AbortSignal.timeout(30_000),
  })
  if (res.status >= 300 && res.status < 400) {
    recordSessionStatus('manychat', { status: 'expired', detail: 'ManyChat renvoie vers sa page de connexion — rouvrir une session dans Connecteurs → ManyChat.' })
    throw new Error('Session ManyChat expirée')
  }
  absorbManychatCookies(res)
  const text = await res.text()
  if (res.status === 400 && retry) {
    await csrfToken(true)
    return mcFetch(path, { method, body, retry: false })
  }
  if (!res.ok) throw new Error(`ManyChat a répondu ${res.status}`)
  try { return JSON.parse(text) } catch { throw new Error('Réponse ManyChat illisible') }
}

/** Tous les contacts, page par page (100 à la fois). */
export async function fetchManychatContacts({ max = 2000 } = {}) {
  const out = []
  let limiter = null
  for (let i = 0; i < 40 && out.length < max; i++) {
    const body = limiter ? { q: '', limit: 100, limiter } : { q: '', limit: 100 }
    const json = await mcFetch('/subscribers/search', { method: 'POST', body })
    const users = json?.users || []
    if (!users.length) break
    out.push(...users)
    if (!json.limiter || json.limiter === limiter) break
    limiter = json.limiter
  }
  // Le même contact peut revenir d'une page à l'autre : on dédoublonne ici
  // plutôt que de faire confiance à la pagination.
  return [...new Map(out.map(u => [String(u.user_id), u])).values()]
}

/** Messages d'une conversation, du plus ancien au plus récent. */
// Événements sans texte, tels que ManyChat les nomme.
const EVENTS = {
  ig_cgt_trigger_comment: '📝 A commenté une publication',
  story_reply_to: '💬 A répondu à une story',
  story_mention: '📣 Mention dans une story',
  click_url: '🔗 A cliqué un lien',
  user_thread_new: '✨ Début de la conversation',
  msgin_instagram: '📎 Message sans texte (image, autocollant…)',
}

export async function fetchManychatMessages(userId, limit = 50) {
  const json = await mcFetch(`/im/loadMessages?user_id=${encodeURIComponent(userId)}&limit=${limit}&type=instagram`)
  const msgs = json?.messages || []
  return msgs.map(m => {
    // Deux formes de contenu : nos envois portent une liste `messages`, les
    // messages reçus portent directement `{type:'text', text}`. Sans les deux,
    // la moitié du fil s'affichait comme « message sans texte ».
    const model = m?.model || {}
    const parts = model.messages || (model.type ? [{ type: model.type, content: { text: model.text } }] : [])
    // Un message sans texte (mention de story, photo, réaction) doit quand
    // même se lire dans le fil : on nomme ce que c'est.
    const KINDS = {
      image: '📷 Image', video: '🎬 Vidéo', audio: '🎧 Audio', file: '📎 Fichier',
      story_mention: '📣 Mention dans une story', story_reply: '💬 Réponse à une story',
      story_reply_to: '💬 A répondu à une story', reel: '🎬 A partagé un reel',
      share: '📎 A partagé une publication', sticker: '📷 Autocollant',
    }
    let text = parts
      .map(p => p?.content?.text || KINDS[p?.type] || (p?.type ? '📎 Contenu Instagram' : ''))
      .filter(Boolean).join('\n')
    // Certains événements n'ont aucun contenu : ce sont des gestes de la
    // personne (un commentaire qui a déclenché la conversation, un lien
    // cliqué). Ils comptent dans l'histoire du prospect, il faut les nommer.
    if (!text) text = EVENTS[m.type] || ''
    // Le commentaire déclencheur porte son propre texte et le lien de la
    // publication : c'est la matière la plus utile de tout le fil.
    if (m.type === 'ig_cgt_trigger_comment') {
      text = model.description ? `📝 A commenté « ${model.description} »` : '📝 A commenté une publication'
    }
    const link = model.permalink || model.url || (model.buttons || []).map(b => b?.url).find(Boolean) || null
    return {
      id: String(m.message_id),
      // « msgout » = parti de chez nous (y compris les envois automatiques).
      direction: String(m.type || '').startsWith('msgout') ? 'out' : 'in',
      text,
      sent_at: m.timestamp ? new Date(m.timestamp * 1000).toISOString() : null,
      kind: m.type || null,
      link_url: link,
      comment_text: m.type === 'ig_cgt_trigger_comment' ? (model.description || null) : null,
    }
  }).sort((a, b) => String(a.sent_at).localeCompare(String(b.sent_at)))
}

// Ce qu'une fiche affiche comme activité. Les mots de la personne ne sont
// jamais montrés bruts : « Tomato » seul ne dit pas que c'est ce qu'elle a
// écrit, et un simple « 😮 » encore moins.
const LABELLED = /^(📝|💬 A |📣|🔗|✨|📎|📷|🎬|🎧)/u
export function isActivityLabel(s) { return LABELLED.test(String(s || '')) }
export function activityLabel(msg) {
  const text = String(msg?.text || '').trim()
  if (msg?.kind === 'ig_cgt_trigger_comment') return text || EVENTS.ig_cgt_trigger_comment
  if (LABELLED.test(text)) return text
  if (text) return `💬 A écrit : « ${text.slice(0, 90)} »`
  return EVENTS[msg?.kind] || null
}

/** Envoie un message dans la conversation Instagram d'un contact. */
export async function sendManychatMessage(userId, text) {
  const clean = String(text || '').trim()
  if (!clean) throw new Error('Message vide')
  return mcFetch('/im/sendMessage', {
    method: 'POST',
    body: { user_id: String(userId), type: 'instagram', text: clean },
  })
}
