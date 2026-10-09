// Instagram — lire le profil public de chaque personne, et dire qui elle est.
//
// Le tri ne voyait que le nom d'usager et le commentaire : « Those plants look
// so healthy 🌱 » d'un potager de cuisine finissait dans la pile « fleurs ».
// Ici on lit ce que tout visiteur voit — bio, catégorie, lien, abonnés, les
// ~12 dernières publications (légendes + images) — et un modèle qui VOIT les
// images en tire une phrase « Qui c'est » et l'activité principale.
//
// Même session que la lecture des commentaires (cookie `sessionid`). On va
// doucement : petits lots, longues pauses, résultat gardé sur la fiche et relu
// au plus tous les 30 jours. Session morte ou Instagram qui freine = la tournée
// s'arrête et le dit ; le tri, lui, continue avec ce qu'il a.
import db from '../db/database.js'
import { recordSessionStatus } from './sessionHealth.js'
import {
  getSessionCookie, hasSessionCookie, igGet, API_ROOT,
  loadProfilePage, fetchPostsPage, SessionExpired, Throttled,
} from './instagramCommentScrape.js'

export const ACTIVITIES = {
  fleurs: 'Fleurs coupées',
  maraichage: 'Maraîchage',
  potager: 'Jardin amateur / potager',
  hydroponie: 'Hydroponie',
  serre: 'Serre commerciale',
  contenu: 'Influenceur / contenu',
  commerce: 'Commerce / fournisseur',
  autre: 'Autre',
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
}

/** La plus petite image d'au moins 300 px : assez pour voir, peu à envoyer. */
function thumbOf(node) {
  const media = node?.image_versions2?.candidates?.length ? node : node?.carousel_media?.[0]
  const c = [...(media?.image_versions2?.candidates || [])].sort((a, b) => a.width - b.width)
  return (c.find(x => x.width >= 300) || c[c.length - 1])?.url || null
}

/**
 * Lecture brute d'un profil : 3 appels (page, fiche, publications).
 * Renvoie { status: 'ok'|'private'|'missing', ... } ; lève SessionExpired /
 * Throttled, que la tournée transforme en arrêt propre.
 */
export async function fetchProfile(username, session) {
  const page = await loadProfilePage(username, session)
  if (page.missing) return { status: 'missing' }
  const pk = (page.html.match(/"props":\{"id":"(\d+)"/) || [])[1] || null
  // Repli : la page elle-même porte la bio dans sa description.
  const meta = decodeEntities((page.html.match(/<meta content="([^"]*)" name="description"/) || [])[1])
  const metaBio = (meta.match(/on Instagram: "([\s\S]*)"$/) || [])[1] || ''

  let u = null
  if (pk) u = (await igGet(`${API_ROOT}/users/${pk}/info/`, { ...session, csrf: page.csrf }, 2))?.user || null
  const profile = {
    pk,
    bio: u?.biography ?? metaBio,
    category: u?.category || u?.category_name || null,
    external_url: u?.external_url || null,
    followers: u?.follower_count ?? null,
    media_count: u?.media_count ?? null,
    is_business: u ? !!u.is_business : null,
    is_private: u ? !!u.is_private : null,
    posts: [],
  }
  if (profile.is_private) return { status: 'private', ...profile }

  const conn = await fetchPostsPage(username, { ...session, lsd: page.lsd, csrf: page.csrf }, null)
  profile.posts = (conn?.edges || []).map(e => e?.node).filter(Boolean).slice(0, 12).map(n => ({
    code: n.code,
    taken_at: n.taken_at || null,
    caption: String(n.caption?.text || '').slice(0, 400),
    alt: String(n.accessibility_caption || '').slice(0, 200),
    thumb: thumbOf(n),
  }))
  return { status: 'ok', ...profile }
}

// ── Analyse par un modèle qui voit les images ────────────────────────────────

async function imageAsDataUrl(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15_000) })
    if (!r.ok) return null
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length > 400_000) return null
    return `data:${r.headers.get('content-type') || 'image/jpeg'};base64,${buf.toString('base64')}`
  } catch { return null }
}

export async function analyzeProfile(prospect, profile, { model = 'gpt-4o-mini' } = {}) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY non configuré')
  const system =
    "Tu regardes le profil Instagram public d'une personne qui a interagi avec Orisha (contrôle du climat " +
    'en serre). Dis qui elle est, à partir de la bio, des légendes ET des photos. JSON strict : ' +
    '{ "who": "<une phrase courte en français, forme « Prénom — activité, amateur|pro, précision utile »>", ' +
    `"activity": "<une clé parmi ${Object.keys(ACTIVITIES).join(', ')}>", ` +
    '"level": "amateur"|"pro"|"inconnu", ' +
    '"flowers_main": true|false, "flowers_evidence": "<la preuve, sinon null>", ' +
    '"bot": true|false }. ' +
    'Clés : fleurs = fleurs coupées ou ornementales comme activité principale ; maraichage = légumes vendus ' +
    '(ferme, marché, paniers) ; potager = jardin personnel ; hydroponie = culture hors-sol (amateur ou pro) ; ' +
    'serre = exploitation en serre commerciale ; contenu = créateur de contenu / média ; commerce = vend du ' +
    'matériel, des semences, des services. ' +
    '"flowers_main" est vrai SEULEMENT si les fleurs sont clairement l\'activité principale (bio, plusieurs ' +
    'légendes ou la majorité des photos). Un émoji 🌱, le mot « plants » ou une fleur isolée ne suffisent pas. ' +
    '"bot" = faux compte ou vendeur d\'abonnés manifeste. Profil vide ou illisible : activity "autre", ' +
    'level "inconnu", flowers_main false.'
  const lines = [`@${prospect.ig_username}` + (prospect.full_name ? ` — ${prospect.full_name}` : '')]
  if (profile.bio) lines.push(`Bio : ${profile.bio}`)
  if (profile.category) lines.push(`Catégorie : ${profile.category}`)
  if (profile.external_url) lines.push(`Lien : ${profile.external_url}`)
  if (profile.followers != null) lines.push(`Abonnés : ${profile.followers} · Publications : ${profile.media_count ?? '?'}`)
  if (profile.is_business) lines.push('Compte professionnel')
  if (profile.is_private) lines.push('Compte privé : publications non visibles')
  profile.posts.forEach((p, i) => {
    const t = [p.caption.replace(/\s+/g, ' ').slice(0, 220), p.alt].filter(Boolean).join(' / ')
    if (t) lines.push(`Publication ${i + 1} : ${t}`)
  })
  const content = [{ type: 'text', text: lines.join('\n') }]
  for (const p of profile.posts.filter(p => p.thumb).slice(0, 4)) {
    const url = await imageAsDataUrl(p.thumb)
    if (url) content.push({ type: 'image_url', image_url: { url, detail: 'low' } })
  }
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      temperature: 0,
      messages: [{ role: 'system', content: system }, { role: 'user', content }],
    }),
  })
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}))
    throw new Error(err.error?.message || `OpenAI HTTP ${resp.status}`)
  }
  const data = await resp.json()
  let r = {}
  try { r = JSON.parse(data.choices?.[0]?.message?.content || '{}') } catch { r = {} }
  const activity = ACTIVITIES[r.activity] ? r.activity : 'autre'
  return {
    who: String(r.who || '').trim().slice(0, 160) || null,
    activity,
    level: ['amateur', 'pro'].includes(r.level) ? r.level : 'inconnu',
    // Double verrou : « fleurs » n'existe que si l'activité ET la preuve concordent.
    flowers_main: activity === 'fleurs' && r.flowers_main === true && !!r.flowers_evidence,
    flowers_evidence: r.flowers_evidence ? String(r.flowers_evidence).slice(0, 200) : null,
    bot: r.bot === true,
  }
}

// ── Stockage sur la fiche ────────────────────────────────────────────────────

/** Le profil lu d'une fiche, ou null. */
export function profileOf(row) {
  if (!row?.profile_json) return null
  try { return JSON.parse(row.profile_json) } catch { return null }
}

function save(id, fields) {
  db.prepare(`
    UPDATE instagram_prospects
    SET profile_json = ?, profile_status = ?, profile_read_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        profile_who = ?, profile_activity = ?, profile_level = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(fields.json ?? null, fields.status, fields.who ?? null, fields.activity ?? null, fields.level ?? null, id)
}

/** Une fiche dont le profil vient de changer se fait re-trier (sauf choix manuel). */
function requeueSegment(id) {
  db.prepare(`
    UPDATE instagram_prospects SET segment_at = NULL
    WHERE id = ? AND segment_source IS NOT 'manual' AND COALESCE(segment,'') NOT IN ('robot','story')
  `).run(id)
}

function dueProfiles(limit, refreshDays, onlyIds = null) {
  const cutoff = new Date(Date.now() - refreshDays * 86400_000).toISOString()
  const scope = onlyIds?.length ? `AND p.id IN (${onlyIds.map(() => '?').join(',')})` : ''
  return db.prepare(`
    SELECT p.id, p.ig_username, p.full_name, p.segment FROM instagram_prospects p
    WHERE p.deleted_at IS NULL AND p.ig_username IS NOT NULL
      AND COALESCE(p.segment,'') NOT IN ('robot','story')
      AND (p.profile_read_at IS NULL OR p.profile_read_at < ?)
      ${scope}
    ORDER BY (p.profile_read_at IS NULL) DESC, (p.segment = 'fleurs') DESC, (p.segment_source IS NOT 'manual') DESC, p.contacted ASC,
             COALESCE(p.last_event_at, p.created_at) DESC
    LIMIT ?
  `).all(cutoff, ...(onlyIds || []), limit)
}

/**
 * Tournée de lecture. N'échoue jamais bruyamment : elle rend ce qu'elle a lu et,
 * si elle a dû s'arrêter, pourquoi (`stopped`).
 */
export async function readProfiles({ limit = 25, refreshDays = 30, model = 'gpt-4o-mini', ids = null } = {}) {
  const out = { read: 0, private: 0, missing: 0, failed: 0, stopped: null, problems: [] }
  if (!limit) return out
  if (!hasSessionCookie()) { out.stopped = 'Aucune session Instagram branchée (Connecteurs → Instagram).'; return out }
  const session = getSessionCookie()
  const rows = dueProfiles(limit, refreshDays, ids)
  for (let i = 0; i < rows.length; i++) {
    const p = rows[i]
    let prof
    try {
      prof = await fetchProfile(p.ig_username, session)
    } catch (e) {
      if (e instanceof SessionExpired) {
        out.stopped = e.message
        recordSessionStatus('instagram', { status: 'expired', detail: e.message })
        break
      }
      if (e instanceof Throttled) { out.stopped = e.message; break }
      out.failed++; out.problems.push(`@${p.ig_username} : ${e.message}`)
      continue
    }
    if (prof.status === 'missing') {
      save(p.id, { status: 'missing', who: null })
      out.missing++
    } else {
      const { status, ...profile } = prof
      let a = null
      try { a = await analyzeProfile(p, profile, { model }) } catch (e) { out.problems.push(`@${p.ig_username} : ${e.message}`) }
      save(p.id, {
        status,
        json: JSON.stringify({ ...profile, ai: a }),
        who: a?.who, activity: a?.activity, level: a?.level,
      })
      if (status === 'private') out.private++; else out.read++
    }
    requeueSegment(p.id)
    // Politesse : un humain ne visite pas trente profils à la seconde.
    if (i < rows.length - 1) await sleep(6000 + Math.random() * 6000)
  }
  if (out.read || out.private) recordSessionStatus('instagram', { status: 'ok', detail: `profils lus le ${new Date().toISOString().slice(0, 10)}` })
  return out
}

// ── Lecture depuis le navigateur (module Orisha) ────────────────────────────
//
// Depuis le serveur, Instagram refuse la lecture des profils au bout de
// quelques appels. Depuis un onglet instagram.com ouvert chez Charles, la même
// lecture passe comme une visite ordinaire : le module demande la liste, lit
// chaque profil dans l'onglet et renvoie ici le résultat brut.

/** Les noms d'usager à lire, ceux de la liste à traiter d'abord. */
export function dueForBrowser(limit = 10, refreshDays = 30) {
  return dueProfiles(limit, refreshDays).map(p => p.ig_username)
}

/** Forme `web_profile_info` → forme interne de `fetchProfile`. */
function fromWebProfile(u) {
  const edges = u?.edge_owner_to_timeline_media?.edges || []
  return {
    pk: u?.id || null,
    bio: u?.biography || '',
    category: u?.category_name || null,
    external_url: u?.external_url || null,
    followers: u?.edge_followed_by?.count ?? null,
    media_count: u?.edge_owner_to_timeline_media?.count ?? null,
    is_business: !!u?.is_business_account,
    is_private: !!u?.is_private,
    posts: edges.map(e => e?.node).filter(Boolean).slice(0, 12).map(n => ({
      code: n.shortcode || null,
      taken_at: n.taken_at_timestamp || null,
      caption: String(n.edge_media_to_caption?.edges?.[0]?.node?.text || '').slice(0, 400),
      alt: String(n.accessibility_caption || '').slice(0, 200),
      thumb: n.thumbnail_src || n.display_url || null,
    })),
  }
}

/**
 * Range les profils lus par le navigateur : analyse, enregistrement, re-tri.
 * `items` = [{ username, missing?, user? }].
 */
export async function ingestBrowserProfiles(items, { model = 'gpt-4o-mini' } = {}) {
  const out = { read: 0, private: 0, missing: 0, problems: [], ids: [] }
  const find = db.prepare(`
    SELECT id, ig_username, full_name FROM instagram_prospects
    WHERE lower(ig_username) = lower(?) AND deleted_at IS NULL
  `)
  for (const it of (items || []).slice(0, 50)) {
    const rows = find.all(String(it?.username || ''))
    if (!rows.length) continue
    if (it.missing) {
      for (const p of rows) { save(p.id, { status: 'missing', who: null }); requeueSegment(p.id); out.ids.push(p.id) }
      out.missing++
      continue
    }
    if (!it.user) continue
    const profile = fromWebProfile(it.user)
    const status = profile.is_private ? 'private' : 'ok'
    let a = null
    try { a = await analyzeProfile(rows[0], profile, { model }) } catch (e) { out.problems.push(`@${rows[0].ig_username} : ${e.message}`) }
    for (const p of rows) {
      save(p.id, { status, json: JSON.stringify({ ...profile, ai: a, via: 'navigateur' }), who: a?.who, activity: a?.activity, level: a?.level })
      requeueSegment(p.id)
      out.ids.push(p.id)
    }
    if (status === 'private') out.private++; else out.read++
  }
  return out
}

// ── « Comment elle est arrivée » ─────────────────────────────────────────────

const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.']
function shortDate(iso) {
  const d = iso ? new Date(iso) : null
  return d && !isNaN(d) ? `${d.getDate()} ${MONTHS[d.getMonth()]}` : null
}
function clip(t, n = 90) {
  const s = String(t || '').replace(/\s+/g, ' ').trim()
  return s.length > n ? `${s.slice(0, n - 1)}…` : s
}

/** Une ligne courte, et le lien qui va avec (publication commentée, sinon rien). */
export function arrivalOf(p) {
  const label = String(p.capture_label || '').trim()
  if (p.first_comment_text) {
    const when = shortDate(p.first_comment_at)
    const head = `A commenté${when ? ` le ${when}` : ''}`
    return {
      text: `${head} : « ${clip(p.first_comment_text)} »`,
      url: p.first_post_url || p.capture_url || null,
      head, quote: String(p.first_comment_text).trim(),
    }
  }
  const quoted = (label.match(/«\s*([\s\S]*?)\s*»?$/) || [])[1]
  if (/^📝/u.test(label)) return { text: `A commenté : « ${clip(quoted)} »`, url: p.capture_url || null, head: 'A commenté', quote: quoted || null }
  if (/^💬 A écrit/u.test(label)) return { text: `Écrit en DM : « ${clip(quoted)} »`, url: null, head: 'Écrit en DM', quote: quoted || null }
  if (/story/i.test(label)) return { text: /Mention/i.test(label) ? 'Mention dans une story' : 'Réponse à une story', url: null }
  if (/^👤/u.test(label) || !label) return { text: 'Abonnée, n’a rien écrit', url: null }
  return { text: clip(label.replace(/^\p{Extended_Pictographic}\s*/u, '')), url: p.capture_url || null }
}
