import { normalizeToken } from './token.mjs'
import { normalizeErpUrl, erpOriginPermission } from './erp-url.mjs'

// Pont de session Orisha — le cœur du module.
//
// Pourquoi ce module existe : Bell et DigiKey posent un captcha sur leur écran
// de connexion, que jamais aucun collecteur automatique ne franchira. Mais le
// captcha ne garde QUE la connexion. Une fois la session ouverte dans ce
// navigateur-ci, l'ERP peut s'en servir pendant des jours pour aller chercher
// les factures tout seul. Ce module fait le transport, rien d'autre.
//
// `chrome.cookies.getAll` lit aussi les cookies httpOnly — c'est précisément ce
// que le collage manuel d'un export Cookie-Editor ratait le plus souvent.
//
// Deux façons de s'en servir, et la première ne demande rien :
//   1. AUTOMATIQUE — dès qu'une session change sur un portail suivi (donc dès
//      qu'on s'y connecte), elle part vers l'ERP toute seule, quelques secondes
//      plus tard. Plus un rappel quotidien pour les sessions qui vieillissent.
//   2. Le bouton, quand on veut déclencher la collecte tout de suite.

const PUSH_DELAY_MS = 8000      // laisser la connexion finir de poser ses témoins
const REFRESH_MINUTES = 60      // filet horaire : les sessions ne vieillissent plus
const TARGETS_TTL_MS = 3600_000 // la liste des portails change rarement
const REFRESH_ALARM = 'orisha-refresh-sessions'

// Une promesse qui ne se termine jamais (onglet endormi, ERP muet) ne doit
// jamais bloquer l'envoi : au-delà de `ms`, on abandonne.
function withTimeout(ms, promise) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`délai dépassé (${Math.round(ms / 1000)} s)`)), ms) }),
  ]).finally(() => clearTimeout(timer))
}

export async function settings() {
  const { erpUrl = '', token = '', auto = true } =
    await chrome.storage.local.get(['erpUrl', 'token', 'auto'])
  return { erpUrl, token, auto }
}

// `timeoutMs: 0` = pas de limite (la collecte peut être longue).
async function call(path, { method = 'GET', body = null, timeoutMs = 20000 } = {}) {
  const { erpUrl, token } = await settings()
  if (!erpUrl || !token) throw new Error('Réglages incomplets — ouvrir les options du module')
  const origin = normalizeErpUrl(erpUrl)
  const validToken = normalizeToken(token)
  if (!await chrome.permissions.contains({ origins: [erpOriginPermission(origin)] })) {
    throw new Error('Accès à l’ERP non autorisé — ouvrez les Réglages du module, cliquez sur Enregistrer et autorisez l’accès au site.')
  }
  let res
  try {
    // `v=` : la version qui tourne, lisible dans les journaux de l'ERP.
    const sep = path.includes('?') ? '&' : '?'
    res = await fetch(`${origin}/erp/api/scrapers/session-bridge${path}${sep}v=${chrome.runtime.getManifest().version}`, {
      method,
      // Sans ça, le navigateur renvoie la requête avec son ETag, nginx répond
      // 304, et la réponse arrive VIDE quand le cache a été purgé entre-temps :
      // le module croyait alors l'ERP injoignable et n'envoyait plus rien.
      cache: 'no-store',
      headers: { Authorization: `Bearer ${validToken}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
    })
  } catch (e) {
    if (e?.name === 'TimeoutError') throw new Error(`L’ERP n’a pas répondu en ${Math.round(timeoutMs / 1000)} s`)
    throw new Error(`Connexion à ${origin} impossible — vérifiez que ce site s’ouvre dans votre navigateur et que l’extension est autorisée à y accéder.`)
  }
  const text = await res.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { /* réponse non JSON */ }
  if (res.status === 401) throw new Error('Jeton expiré ou refusé — recopiez le bouton « Jeton » de l’ERP dans les Réglages du module.')
  if (!res.ok) throw new Error(data?.error || `ERP a répondu ${res.status}`)
  if (data === null) throw new Error('Réponse ERP inattendue — vérifiez l’adresse dans les Réglages du module.')
  return data
}

// La liste des portails est mise en cache : le guetteur de témoins la consulte
// à chaque changement de cookie, il ne peut pas interroger l'ERP à chaque fois.
async function targets({ fresh = false } = {}) {
  const { targetsCache, targetsAt } = await chrome.storage.local.get(['targetsCache', 'targetsAt'])
  if (!fresh && targetsCache && Date.now() - (targetsAt || 0) < TARGETS_TTL_MS) return targetsCache
  const list = await call('/targets')
  await chrome.storage.local.set({ targetsCache: list, targetsAt: Date.now() })
  return list
}

// Les témoins d'un ou plusieurs domaines, sous-domaines compris : Chrome rend
// déjà ceux posés sur « .bell.ca » quand on demande « bell.ca ». Amazon en a
// deux (la connexion vit sur .com, les commandes sur .ca).
async function cookiesFor(domains) {
  const out = []
  const seen = new Set()
  for (const domain of domains) {
    for (const c of await chrome.cookies.getAll({ domain })) {
      const key = `${c.domain}|${c.path}|${c.name}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expirationDate: c.expirationDate,
        httpOnly: c.httpOnly,
        secure: c.secure,
        sameSite: c.sameSite,
      })
    }
  }
  return out
}

// Le stockage local des onglets ouverts sur ce portail. Indispensable : MyBell
// est une application Auth0, qui garde son jeton de session LÀ et non dans un
// témoin — sans ça, la session envoyée retombe sur l'écran de connexion.
// Seuls les onglets déjà ouverts peuvent être lus ; c'est pourquoi le module
// invite à laisser le portail ouvert dans un onglet.
async function originsFor(domains) {
  const patterns = (domains || []).flatMap(d => [`https://${d}/*`, `https://*.${d}/*`])
  let tabs = []
  try { tabs = await chrome.tabs.query({ url: patterns }) } catch { return [] }
  const byOrigin = new Map()
  for (const tab of tabs) {
    // Onglet mis en veille par Edge : executeScript n'y revient jamais.
    if (!tab.id || tab.discarded || tab.frozen) continue
    try {
      const [res] = await withTimeout(3000, chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          const out = []
          try {
            for (let i = 0; i < localStorage.length; i++) {
              const name = localStorage.key(i)
              out.push({ name, value: localStorage.getItem(name) })
            }
          } catch { /* stockage bloqué sur cette origine */ }
          return { origin: location.origin, localStorage: out }
        },
      }))
      if (res?.result?.localStorage?.length) byOrigin.set(res.result.origin, res.result)
    } catch { /* onglet protégé (page interne, PDF…) ou muet */ }
  }
  return [...byOrigin.values()]
}

// ── Découverte ───────────────────────────────────────────────────────────────
//
// Le module voit les sites ouverts dans le navigateur (permission « tabs »). Il
// en envoie les NOMS DE DOMAINE à l'ERP — rien d'autre — et l'ERP répond
// lesquels il sait collecter : leur session part dans la foulée, même si le
// portail n'avait jamais été saisi dans l'ERP. Les domaines inconnus y restent
// comme « portails repérés », à brancher un jour ; aucun témoin ne les
// accompagne.
export const ALL_SITES = 'https://*/*'

export async function hasAllSites() {
  try { return await chrome.permissions.contains({ origins: [ALL_SITES] }) } catch { return false }
}

async function openDomains() {
  let tabs = []
  try { tabs = await chrome.tabs.query({}) } catch { return [] }
  const byDomain = new Map()
  for (const tab of tabs) {
    if (!tab.url?.startsWith('https://')) continue
    let host
    try { host = new URL(tab.url).hostname } catch { continue }
    const domain = host.replace(/^www\./, '')
    if (!byDomain.has(domain)) byDomain.set(domain, { domain, title: tab.title || null })
  }
  return [...byDomain.values()]
}

/** Portails ouverts que l'ERP sait collecter, y compris ceux qu'il ne suivait pas. */
async function discover() {
  const domains = await openDomains()
  if (!domains.length) return []
  try {
    const out = await call('/discover', { method: 'POST', body: { domains } })
    return out?.known || []
  } catch {
    return []
  }
}

// Liste de travail : les portails suivis par l'ERP, plus ceux qu'on vient de
// voir ouverts. Un portail découvert dont le module n'a pas le droit de lire
// les témoins est signalé plutôt qu'oublié.
async function workList({ fresh = false } = {}) {
  const base = await targets({ fresh }).catch(() => [])
  const found = await discover()
  const merged = new Map(base.map(t => [String(t.account_id), t]))
  for (const t of found) {
    const key = String(t.account_id)
    if (!merged.has(key)) merged.set(key, { ...t, label: t.label || t.vendor, discovered: true })
  }
  return [...merged.values()]
}

/** Envoie la session d'UN portail. */
async function pushOne(t) {
  // La session Instagram d'un compte perso ne quitte jamais ce navigateur.
  if (t.account_id === 'bridge:instagram' && !(await igAllowed())) return { ...t, state: 'absent', detail: "compte perso : rien n'est envoyé" }
  const cookies = await cookiesFor(t.domains || [])
  if (!cookies.length) {
    // Un portail repéré hors de la liste d'origine du module demande la
    // permission « tous les sites » : sans elle, ses témoins restent illisibles.
    const detail = t.discovered && !(await hasAllSites())
      ? 'autoriser « tous les sites » dans les réglages du module'
      : 'pas de session ouverte dans ce navigateur'
    return { ...t, state: 'absent', detail }
  }
  const origins = await originsFor(t.domains || [])
  const out = await call('/push', { method: 'POST', body: { account_id: t.account_id, cookies, origins } })
  const extra = out.origins ? ` + ${out.origins} page(s)` : ''
  // L'ERP répond `collecting` quand il part chercher une facture dans la foulée.
  const suite = out.collecting ? ' · collecte lancée' : ''
  return { ...t, state: 'ok', detail: `${out.cookies} témoins${extra} envoyés${suite}` }
}

/**
 * Le bouton : envoyer toutes les sessions ouvertes, puis lancer la collecte.
 *
 * L'avancement est écrit au fur et à mesure dans le stockage du module, et
 * c'est CELA que la fenêtre affiche : elle peut se fermer, le travail continue,
 * et on retrouve le résultat en la rouvrant.
 */
async function setRun(patch) {
  const { lastRun = {} } = await chrome.storage.local.get('lastRun')
  await chrome.storage.local.set({ lastRun: { ...lastRun, ...patch, at: Date.now() } })
}

export async function runBridge() {
  await setRun({ running: true, sent: [], error: null, collect: null })
  let list = []
  try {
    list = await workList({ fresh: true })
  } catch (e) {
    await setRun({ running: false, error: e.message })
    return
  }
  if (!list?.length) {
    await setRun({ running: false, error: 'L’ERP n’a aucun portail à envoyer' })
    return
  }
  // Tous les portails en même temps, chacun borné : un seul portail lent ne
  // retient plus les autres.
  await setRun({ sent: list.map(t => ({ ...t, state: 'wait', detail: 'envoi…' })) })
  const sent = await Promise.all(list.map(t =>
    withTimeout(30000, pushOne(t)).catch(e => ({ ...t, state: 'erreur', detail: e.message }))))
  // Même si un portail n'a pas de session, les autres valent le déplacement.
  // La collecte est lancée sans l'attendre : le bouton redevient libre.
  await setRun({ running: false, sent, collect: { started: true } })
  call('/collect', { method: 'POST', timeoutMs: 0 })
    .catch(e => setRun({ error: e.message }))
}

// ── Envoi automatique ────────────────────────────────────────────────────────
//
// Se connecter à un portail, c'est poser ou remplacer des témoins. On écoute ce
// signal-là : il n'y a rien à cliquer, et la session part quelques secondes
// après la connexion. Regroupé par portail pour ne pas envoyer trente fois de
// suite pendant qu'une page finit de charger.

const pending = new Map()

function domainMatches(cookieDomain, domains) {
  const d = String(cookieDomain || '').replace(/^\./, '')
  return (domains || []).some(x => d === x || d.endsWith(`.${x}`))
}

async function schedulePush(target) {
  if (pending.has(target.account_id)) clearTimeout(pending.get(target.account_id))
  pending.set(target.account_id, setTimeout(async () => {
    pending.delete(target.account_id)
    try {
      const r = await pushOne(target)
      const { autoLog = [] } = await chrome.storage.local.get('autoLog')
      await chrome.storage.local.set({ autoLog: [{ at: Date.now(), ...r }, ...autoLog].slice(0, 20) })
    } catch { /* réseau ou ERP indisponible : le prochain changement réessaiera */ }
  }, PUSH_DELAY_MS))
}

chrome.cookies.onChanged.addListener(async ({ cookie, removed }) => {
  if (removed) return
  const { auto } = await settings()
  if (!auto) return
  let list = []
  try { list = await targets() } catch { return }
  const hit = list.find(t => domainMatches(cookie.domain, t.domains))
  if (hit) return schedulePush(hit)
  // Portail que l'ERP suit depuis peu (ou qu'il vient d'apprendre) : la liste
  // en cache ne le connaît pas encore, on demande.
  if (!(await hasAllSites())) return
  const found = await discover()
  const late = found.find(t => domainMatches(cookie.domain, t.domains))
  if (late) schedulePush({ ...late, discovered: true })
})

// Filet horaire : une session valide mais jamais retouchée finirait par dormir
// côté ERP alors qu'elle est bonne ici. Comme l'ERP relance la collecte dès
// qu'une session arrive et qu'une facture manque, ce filet suffit à tout faire
// sans un seul clic.
chrome.alarms?.create(REFRESH_ALARM, { periodInMinutes: REFRESH_MINUTES })
chrome.alarms?.onAlarm.addListener(async (alarm) => {
  if (alarm.name === REFRESH_ALARM) await pushAll()
})

// Au démarrage du navigateur : les sessions repartent sans attendre l'heure.
async function pushAll() {
  const { auto } = await settings()
  if (!auto) return
  let list = []
  try { list = await workList({ fresh: true }) } catch { return }
  for (const t of list) { try { await withTimeout(30000, pushOne(t)) } catch { /* on réessaiera */ } }
}
chrome.runtime.onStartup?.addListener(pushAll)
chrome.runtime.onInstalled?.addListener(pushAll)

// Un envoi en cours ne survit pas au recyclage du service ou au rechargement du
// module : sans ça, la fenêtre garderait le bouton désactivé pour toujours.
chrome.storage.local.get('lastRun').then(({ lastRun }) => {
  if (lastRun?.running) return chrome.storage.local.set({ lastRun: { ...lastRun, running: false } })
}).catch(() => {})

// On répond TOUT DE SUITE : la fenêtre suit ensuite l'avancement dans le
// stockage. Attendre la fin ici laissait le bouton figé sur « Envoi… » quand le
// service du module était recyclé en cours de route.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== 'run-bridge') return false
  runBridge().catch(async (e) => { await setRun({ running: false, error: e.message }) })
  reply({ ok: true, started: true })
  return false
})

// ── Profils Instagram ────────────────────────────────────────────────────────
//
// Instagram refuse au serveur la lecture des profils (qui fait pousser des
// fleurs, qui est maraîcher…). Depuis un onglet instagram.com ouvert ici, la
// même lecture est une visite ordinaire. Toutes les 20 minutes, tant qu'un
// onglet Instagram est ouvert, le module lit une dizaine de profils demandés
// par l'ERP et lui renvoie le résultat. Plus serré, Instagram bloquerait la
// session entière.
const IG_ALARM = 'orisha-ig-profiles'
const IG_MINUTES = 20

function trace(msg) { call('/log', { method: 'POST', body: { msg } }).catch(() => {}) }

// L'onglet Instagram où lire. Edge endort les onglets en arrière-plan : un
// onglet endormi est réveillé (rechargé) plutôt qu'ignoré.
async function instagramTab() {
  let tabs = []
  try { tabs = await chrome.tabs.query({ url: ['https://www.instagram.com/*', 'https://instagram.com/*'] }) } catch (e) { trace(`tabs.query: ${e.message}`); return null }
  trace(`onglets Instagram : ${tabs.map(t => `${t.status}${t.discarded ? ' endormi' : ''}${t.frozen ? ' gelé' : ''}`).join(', ') || 'aucun'}`)
  const awake = tabs.find(t => t.id && !t.discarded && !t.frozen && t.status === 'complete')
  if (awake) return awake
  const asleep = tabs.find(t => t.id)
  if (!asleep) return null
  try { await chrome.tabs.reload(asleep.id) } catch { return null }
  for (let i = 0; i < 30; i++) {
    await new Promise(ok => setTimeout(ok, 1000))
    try {
      const t = await chrome.tabs.get(asleep.id)
      if (t.status === 'complete' && !t.discarded) return t
    } catch { return null }
  }
  return null
}

// Une seule requête faite DANS l'onglet Instagram (mêmes témoins, même adresse
// que le site). Les attentes, elles, se font ici : Edge ralentit fortement les
// minuteries d'un onglet en arrière-plan, une pause là-bas pouvait durer une minute.
async function pageFetch(tabId, url, { method = 'GET', body = null, headers = {} } = {}) {
  const [r] = await withTimeout(30000, chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    args: [url, method, body, headers],
    func: async (url, method, body, headers) => {
      try {
        const r = await fetch(url, { method, body, headers, credentials: 'include', signal: AbortSignal.timeout(20000) })
        return { status: r.status, text: await r.text() }
      } catch (e) { return { status: 0, text: String(e?.message || e) } }
    },
  }))
  return r?.result || { status: 0, text: 'aucun résultat' }
}
const IG_H = { 'X-IG-App-ID': '936619743392459', 'X-Requested-With': 'XMLHttpRequest' }
const pause = (min = 1500, spread = 1500) => new Promise(ok => setTimeout(ok, min + Math.random() * spread))
const json = (t) => { try { return JSON.parse(t) } catch { return null } }

async function readInstagramProfiles() {
  const { auto } = await settings()
  if (!auto) return
  const tab = await instagramTab()
  if (!tab) return
  let due = []
  try { due = (await call('/instagram/due?limit=10')).usernames || [] } catch { return }
  if (!due.length) return
  const profiles = []
  for (const username of due) {
    const r = await pageFetch(tab.id, `/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`, { headers: IG_H })
    if (r.status === 404) { profiles.push({ username, missing: true }); continue }
    if (r.status !== 200) { trace(`profil ${username} : ${r.status}`); break }
    const u = json(r.text)?.data?.user
    if (!u) { profiles.push({ username, missing: true }); continue }
    const edges = (u.edge_owner_to_timeline_media?.edges || []).slice(0, 12)
    profiles.push({ username, user: {
      id: u.id, biography: u.biography, category_name: u.category_name, external_url: u.external_url,
      edge_followed_by: { count: u.edge_followed_by?.count ?? null },
      is_business_account: u.is_business_account, is_private: u.is_private,
      edge_owner_to_timeline_media: { count: u.edge_owner_to_timeline_media?.count ?? null, edges: edges.map(e => ({ node: {
        shortcode: e.node?.shortcode, taken_at_timestamp: e.node?.taken_at_timestamp,
        accessibility_caption: e.node?.accessibility_caption, thumbnail_src: e.node?.thumbnail_src, display_url: e.node?.display_url,
        edge_media_to_caption: { edges: (e.node?.edge_media_to_caption?.edges || []).slice(0, 1) },
      } })) },
    } })
    await pause(4000, 4000)
  }
  if (!profiles.length) return
  try { await call('/instagram/profiles', { method: 'POST', body: { profiles, viewer: await igViewer() } }) } catch { /* relu à la prochaine tournée */ }
  trace(`${profiles.length} profil(s) envoyé(s)`)
}

// Les commentaires des publications (les nôtres et celles en collaboration).
// L'ERP dit s'il est temps (au plus toutes les 3 h) et quels comptes lire.
async function readInstagramComments() {
  const { auto } = await settings()
  if (!auto) return
  const tab = await instagramTab()
  if (!tab) return
  let plan
  try { plan = await call('/instagram/scrape-plan') } catch (e) { trace(`plan: ${e.message}`); return }
  if (!plan?.due || !plan.accounts?.length) { trace('lecture pas encore due'); return }
  const errors = []
  const since = Date.now() / 1000 - plan.lookback_days * 86400
  const user = u => (u ? { username: u.username, pk: u.pk, full_name: u.full_name } : null)
  const posts = new Map()
  // Le fil passe par la requête GraphQL du site. Jetons : LSD et fb_dtsg dans
  // la page du profil, csrftoken et ds_user_id dans les témoins.
  const cookie = async (name) => (await chrome.cookies.get({ url: 'https://www.instagram.com/', name }))?.value || ''
  const csrf = await cookie('csrftoken')
  const me = (await cookie('ds_user_id')) || '0'
  for (const account of plan.accounts) {
    const page = await pageFetch(tab.id, `/${encodeURIComponent(account)}/`)
    const lsd = (page.text.match(/"LSD",\[\],\{"token":"([^"]+)"/) || [])[1]
    const dtsg = (page.text.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/) || page.text.match(/"dtsg":\{"token":"([^"]+)"/) || [])[1]
    if (!lsd) { errors.push(`pas de jeton pour ${account} (${page.status})`); continue }
    await pause()
    let after = null
    for (let n = 0; n < 15; n++) {
      const body = new URLSearchParams({
        av: me, __a: '1', __user: '0', lsd, fb_api_caller_class: 'RelayModern',
        ...(dtsg ? { fb_dtsg: dtsg, jazoest: '2' + [...dtsg].reduce((t, ch) => t + ch.charCodeAt(0), 0) } : {}),
        fb_api_req_friendly_name: 'PolarisProfilePostsQuery', doc_id: plan.doc_id || '9310670392322965',
        variables: JSON.stringify({
          after, before: null, first: 12, last: null,
          data: { count: 12, include_reel_media_seen_timestamp: true, include_relationship_info: true, latest_besties_reel_media: true, latest_reel_media: true },
          username: account,
          __relay_internal__pv__PolarisIsLoggedInrelayprovider: true,
          __relay_internal__pv__PolarisShareSheetV3relayprovider: false,
        }),
      }).toString()
      const r = await pageFetch(tab.id, '/graphql/query', { method: 'POST', body, headers: {
        'content-type': 'application/x-www-form-urlencoded', 'x-ig-app-id': '936619743392459', 'x-csrftoken': csrf,
        'x-fb-lsd': lsd, 'x-fb-friendly-name': 'PolarisProfilePostsQuery', 'x-asbd-id': '129477',
      } })
      const conn = json(r.text)?.data?.xdt_api__v1__feed__user_timeline_graphql_connection
      if (!conn) { errors.push(`graphql ${account} ${r.status} ${r.text.slice(0, 160)}`); break }
      const items = (conn.edges || []).map(e => e?.node).filter(Boolean)
      for (const it of items) {
        if (it.taken_at >= since && !posts.has(String(it.pk))) {
          posts.set(String(it.pk), {
            pk: String(it.pk), code: it.code, taken_at: it.taken_at, comment_count: it.comment_count || 0,
            user: user(it.user), coauthor_producers: (it.coauthor_producers || []).map(user),
            invited_coauthor_producers: (it.invited_coauthor_producers || []).map(user), comments: [],
          })
        }
      }
      const next = conn.page_info
      if (!items.length || items.every(i => i.taken_at < since) || !next?.has_next_page || !next?.end_cursor) break
      after = next.end_cursor
      await pause()
    }
    await pause()
  }
  trace(`${posts.size} publication(s) lues, commentaires…`)
  const slim = c => ({
    pk: c.pk, text: c.text, created_at: c.created_at, user: user(c.user),
    preview_child_comments: (c.preview_child_comments || []).map(x => ({ pk: x.pk, text: x.text, created_at: x.created_at, user: user(x.user) })),
  })
  // Une publication déjà lue en entier n'est relue que si son nombre de
  // commentaires a bougé : on peut alors tout lire (sans plafond de 5 pages,
  // qui coupait les grosses publications vers 75 commentaires) sans marteler.
  const { igReadCounts = {} } = await chrome.storage.local.get('igReadCounts')
  const children = async (p, c) => {
    const out = [...(c.preview_child_comments || [])]
    if (!(c.child_comment_count > out.length)) return out
    const seen = new Set(out.map(x => String(x.pk)))
    let maxId = null
    for (let n = 0; n < 10; n++) {
      const r = await pageFetch(tab.id, `/api/v1/media/${p.pk}/comments/${c.pk}/child_comments/${maxId ? `?max_id=${encodeURIComponent(maxId)}` : ''}`, { headers: IG_H })
      if (r.status === 429) throw new Error('429')
      const data = r.status === 200 ? json(r.text) : null
      if (!data) break
      for (const x of data.child_comments || []) if (!seen.has(String(x.pk))) { seen.add(String(x.pk)); out.push(x) }
      await pause(1200, 1200)
      maxId = data.has_more_tail_child_comments ? data.next_max_child_cursor : null
      if (!maxId) break
    }
    return out
  }
  let limited = false
  outer: for (const p of posts.values()) {
    if (!p.comment_count || igReadCounts[p.pk] === p.comment_count) continue
    let cursor = null, complete = false
    try {
      for (let n = 0; n < 60; n++) {
        const q = cursor ? `&${cursor.key}=${encodeURIComponent(cursor.val)}` : ''
        const r = await pageFetch(tab.id, `/api/v1/media/${p.pk}/comments/?can_support_threading=true${q}`, { headers: IG_H })
        if (r.status === 429) { limited = true; errors.push('429 commentaires'); break outer }
        const data = r.status === 200 ? json(r.text) : null
        if (!data) { errors.push(`commentaires ${p.pk} : ${r.status}`); break }
        for (const c of data.comments || []) p.comments.push(slim({ ...c, preview_child_comments: await children(p, c) }))
        await pause(1200, 1200)
        cursor = data.next_min_id ? { key: 'min_id', val: data.next_min_id }
          : (data.has_more_comments && data.next_max_id) ? { key: 'max_id', val: data.next_max_id } : null
        if (!cursor) { complete = true; break }
      }
    } catch { limited = true; errors.push('429 réponses'); break }
    if (complete) igReadCounts[p.pk] = p.comment_count
    trace(`${p.code} : ${p.comments.length} lus / ${p.comment_count}`)
  }
  await chrome.storage.local.set({ igReadCounts })
  // Même vide, on le dit à l'ERP : il journalise pourquoi la lecture n'a rien donné.
  try {
    const out = await call('/instagram/comments', { method: 'POST', body: { posts: [...posts.values()], errors: errors.slice(0, 10), viewer: me }, timeoutMs: 120000 })
    trace(out?.summary || out?.error || 'lecture envoyée')
  } catch (e) { trace(`envoi: ${e.message}`) }
  return { limited }
}

// Une tournée à la fois, et pas deux en moins de 15 min (sauf le filet horaire) :
// Instagram bloque les rafales.
let igRunning = false
// Compte connecté dans CE profil de navigateur. Un profil perso (autre compte
// Instagram) ne lit rien : seul le compte d'Orisha travaille pour Boréal.
const igViewer = async () => (await chrome.cookies.get({ url: 'https://www.instagram.com/', name: 'ds_user_id' }))?.value || ''
// Strict : seul un profil coché « Instagram : ce profil est celui d'Orisha »
// touche à Instagram ; si l'ERP connaît le compte d'Orisha, il doit aussi
// correspondre. Un profil perso (case décochée, défaut) n'a aucun contact.
async function igAllowed() {
  const { igOrisha = false } = await chrome.storage.local.get('igOrisha')
  if (igOrisha !== true) return false
  try {
    const { own_pk: own } = await call('/instagram/scrape-plan')
    return !own || (await igViewer()) === String(own)
  } catch { return false }
}
async function instagramRound({ eager = false } = {}) {
  if (igRunning) { trace('tournée déjà en cours'); return }
  if (!(await igAllowed())) { trace("compte Instagram ≠ Orisha : rien n'est lu dans ce profil"); return }
  const { igLastAt = 0 } = await chrome.storage.local.get('igLastAt')
  if (eager && Date.now() - igLastAt < 15 * 60_000) { trace('tournée trop récente'); return }
  trace(`tournée Instagram${eager ? ' (immédiate)' : ''}`)
  igRunning = true
  try {
    await chrome.storage.local.set({ igLastAt: Date.now() })
    // Les commentaires d'abord (ils nourrissent la liste), puis les profils.
    const r = await readInstagramComments()
    // Instagram vient de dire « trop d'appels » : on n'insiste pas avec les profils.
    if (!r?.limited) await readInstagramProfiles()
  } finally { igRunning = false }
}

chrome.alarms?.create(IG_ALARM, { periodInMinutes: IG_MINUTES })
chrome.alarms?.onAlarm.addListener(async (alarm) => {
  if (alarm.name === IG_ALARM) await instagramRound()
})
// Tout de suite, sans attendre l'alarme : dès qu'un onglet Instagram finit de
// charger, et à l'installation / au démarrage du navigateur.
chrome.tabs?.onUpdated.addListener((_id, info, tab) => {
  if (info.status === 'complete' && /^https:\/\/(www\.)?instagram\.com\//.test(tab?.url || '')) {
    setTimeout(() => instagramRound({ eager: true }).catch(() => {}), 5000)
  }
})
chrome.runtime.onInstalled?.addListener(() => {
  // Module tout juste rechargé : on lit sans attendre le délai de 15 min.
  chrome.storage.local.set({ igLastAt: 0 }).then(() => setTimeout(() => instagramRound({ eager: true }).catch(() => {}), 10000))
})
chrome.runtime.onStartup?.addListener(() => { setTimeout(() => instagramRound({ eager: true }).catch(() => {}), 10000) })

// ── Mise à jour toute seule ──────────────────────────────────────────────────
//
// Sur le Mac, une tâche planifiée remplace les fichiers de ce dossier par la
// dernière version de l'ERP. Le module compare alors la version écrite sur le
// disque à celle qu'il fait tourner, et se recharge s'il est en retard : plus
// aucun geste à faire dans edge://extensions.
const SELF_UPDATE_ALARM = 'orisha-self-update'
async function reloadIfUpdated() {
  try {
    const r = await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })
    const onDisk = (await r.json())?.version
    if (onDisk && onDisk !== chrome.runtime.getManifest().version) chrome.runtime.reload()
  } catch { /* fichier en cours d'écriture : on réessaiera */ }
}
chrome.alarms?.create(SELF_UPDATE_ALARM, { periodInMinutes: 0.5 })
chrome.alarms?.onAlarm.addListener((alarm) => { if (alarm.name === SELF_UPDATE_ALARM) reloadIfUpdated() })

// Nouvelle version qui démarre (mise à jour automatique) : on n'attend aucun
// événement du navigateur, on relit Instagram et on renvoie les sessions.
chrome.storage.local.get('runningVersion').then(({ runningVersion }) => {
  const v = chrome.runtime.getManifest().version
  if (runningVersion === v) return
  chrome.storage.local.set({ runningVersion: v, igLastAt: 0 }).then(() => {
    setTimeout(() => { pushAll().catch(() => {}); instagramRound({ eager: true }).catch(() => {}) }, 5000)
  })
}).catch(() => {})

// ── Envoyer ce document à l'extracteur ───────────────────────────────────────
//
// Un clic (bouton du module, clic droit, ou Alt+Shift+E) et la facture affichée
// dans l'onglet part dans l'extracteur de l'ERP. Trois façons de la capturer,
// de la plus fidèle à la plus grossière :
//   1. l'onglet affiche un PDF ou une image → le fichier lui-même ;
//   1b. une page (messagerie, portail) qui montre un PDF ou une grande image
//       → ce fichier seul, pas la page autour ;
//   2. une page web (facture en ligne) → la page entière imprimée en PDF ;
//   3. sinon → une capture de ce qui est visible à l'écran.
// L'onglet n'est lu qu'au clic : `activeTab` suffit, aucun accès permanent.

// Exécutée DANS l'onglet : même origine que le document, donc ses témoins.
async function readTabDocument() {
  const ct = String(document.contentType || '')
  if (ct !== 'application/pdf' && !ct.startsWith('image/')) return { kind: 'page', title: document.title }
  const blob = await (await fetch(location.href, { credentials: 'include' })).blob()
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  let name = ''
  try { name = decodeURIComponent(location.pathname.split('/').pop() || '') } catch { /* nom illisible */ }
  return { kind: 'file', mime: (blob.type || ct).split(';')[0], data: btoa(bin), name: name || document.title }
}

// Exécutée dans chaque cadre : le PDF intégré ou la plus grande image visible.
function findEmbeddedDocument() {
  const vw = window.innerWidth, vh = window.innerHeight
  const visibleArea = (el) => {
    const r = el.getBoundingClientRect()
    const w = Math.min(r.right, vw) - Math.max(r.left, 0)
    const h = Math.min(r.bottom, vh) - Math.max(r.top, 0)
    return w > 0 && h > 0 ? w * h : 0
  }
  const ct = String(document.contentType || '')
  if (window !== window.top && (ct === 'application/pdf' || ct.startsWith('image/'))) {
    return { url: location.href, mime: ct, area: vw * vh }
  }
  let best = null
  const consider = (url, mime, area) => {
    if (!url || area <= 0 || /^(javascript|about):/i.test(url)) return
    if (!best || area > best.area) best = { url, mime, area }
  }
  for (const el of document.querySelectorAll('embed, object, iframe')) {
    const url = el.src || el.data || ''
    const type = String(el.type || '').toLowerCase()
    if (type === 'application/pdf' || /\.pdf($|[?#])|mimetype=application(%2f|\/)pdf/i.test(url)) {
      consider(url, 'application/pdf', visibleArea(el) * 2)
    }
  }
  for (const img of document.images) {
    if (img.naturalWidth < 300 || img.naturalHeight < 300) continue
    const area = visibleArea(img)
    if (area < vw * vh * 0.12) continue
    consider(img.currentSrc || img.src, '', area)
  }
  return best
}

// Exécutée dans le cadre qui porte le fichier : mêmes témoins que lui.
async function fetchInFrame(url, mime) {
  const blob = await (await fetch(url, { credentials: 'include' })).blob()
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  let name = ''
  try { name = decodeURIComponent(new URL(url, location.href).pathname.split('/').pop() || '') } catch { /* nom illisible */ }
  return { kind: 'file', mime: (blob.type || mime || 'application/octet-stream').split(';')[0], data: btoa(bin), name }
}

async function captureEmbedded(tab, srcUrl) {
  let pick = null
  if (srcUrl) pick = { frameId: 0, url: srcUrl, mime: '' }
  else {
    const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: findEmbeddedDocument })
    for (const r of results || []) {
      if (r?.result && (!pick || r.result.area > pick.area)) pick = { frameId: r.frameId, ...r.result }
    }
  }
  if (!pick) return null
  let doc = null
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id, frameIds: [pick.frameId] }, func: fetchInFrame, args: [pick.url, pick.mime] })
    doc = r?.result || null
  } catch { /* lecture refusée dans le cadre : on tente depuis le module */ }
  if (!doc && /^https?:/i.test(pick.url)) {
    try {
      const r = await fetch(pick.url, { credentials: 'include' })
      if (r.ok) {
        const mime = (r.headers.get('content-type') || pick.mime || '').split(';')[0]
        doc = { kind: 'file', mime, data: await bufferToB64(await r.arrayBuffer()), name: '' }
      }
    } catch { /* tant pis */ }
  }
  if (!doc || !(doc.mime === 'application/pdf' || doc.mime.startsWith('image/'))) return null
  if (!doc.name || !/\.[a-z0-9]{2,5}$/i.test(doc.name)) doc.name = (tab.title || 'document').trim()
  return doc
}

async function bufferToB64(buf) {
  const bytes = new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

async function printTabToPdf(tabId) {
  const target = { tabId }
  await chrome.debugger.attach(target, '1.3')
  try {
    const { data } = await chrome.debugger.sendCommand(target, 'Page.printToPDF', { printBackground: true, preferCSSPageSize: true })
    return data
  } finally {
    await chrome.debugger.detach(target).catch(() => {})
  }
}

async function captureTab(tab, srcUrl = '') {
  const fallbackName = (tab.title || 'document').trim()
  if (srcUrl) {
    const doc = await captureEmbedded(tab, srcUrl).catch(() => null)
    if (doc) return doc
  }
  let found = null
  try {
    const [r] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: readTabDocument })
    found = r?.result || null
  } catch { /* PDF local, page protégée : on essaie autrement */ }
  if (found?.kind === 'file') return found

  // PDF que le script n'a pas pu lire (fichier local, visionneuse) : on le
  // télécharge directement par son adresse.
  if (!found && /\.pdf($|[?#])/i.test(tab.url || '')) {
    try {
      const r = await fetch(tab.url, { credentials: 'include' })
      if (r.ok) {
        const name = decodeURIComponent((new URL(tab.url).pathname.split('/').pop()) || '') || fallbackName
        return { kind: 'file', mime: 'application/pdf', data: await bufferToB64(await r.arrayBuffer()), name }
      }
    } catch { /* on passe à la capture */ }
  }

  if (found?.kind === 'page') {
    const doc = await captureEmbedded(tab).catch(() => null)
    if (doc) return doc
    try { return { kind: 'file', mime: 'application/pdf', data: await printTabToPdf(tab.id), name: fallbackName } }
    catch { /* débogueur refusé (outils de développement ouverts…) */ }
  }
  const shot = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
  return { kind: 'file', mime: 'image/png', data: shot.split(',')[1], name: fallbackName }
}

async function flashBadge(text, color) {
  try {
    await chrome.action.setBadgeBackgroundColor({ color })
    await chrome.action.setBadgeText({ text })
    setTimeout(() => chrome.action.setBadgeText({ text: '' }).catch(() => {}), 6000)
  } catch { /* sans importance */ }
}

async function sendDocument(tab, srcUrl = '') {
  if (!tab?.id) throw new Error('Aucun onglet actif')
  await chrome.storage.local.set({ lastDoc: { running: true, at: Date.now(), title: tab.title || '' } })
  await flashBadge('…', '#2563eb')
  try {
    const doc = await captureTab(tab, srcUrl)
    const res = await call('/document', { method: 'POST', body: { ...doc, title: tab.title || '', url: tab.url || '' }, timeoutMs: 60000 })
    const { erpUrl } = await settings()
    const link = res.id ? `${normalizeErpUrl(erpUrl)}/erp/sale-receipts/${res.id}` : ''
    await chrome.storage.local.set({ lastDoc: { running: false, at: Date.now(), title: tab.title || '', status: res.status, link } })
    await flashBadge('✓', '#059669')
    return res
  } catch (e) {
    await chrome.storage.local.set({ lastDoc: { running: false, at: Date.now(), title: tab.title || '', error: e.message } })
    await flashBadge('!', '#dc2626')
    throw e
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== 'send-document') return false
  chrome.tabs.get(msg.tabId)
    .then(sendDocument)
    .then(r => reply({ ok: true, ...r }), e => reply({ ok: false, error: e.message }))
  return true
})

const DOC_MENU = 'orisha-send-document'
chrome.runtime.onInstalled?.addListener(() => {
  chrome.contextMenus?.create({ id: DOC_MENU, title: 'Envoyer à l’extracteur Boréal', contexts: ['page', 'frame', 'image', 'link', 'selection'] }, () => void chrome.runtime.lastError)
})
chrome.contextMenus?.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== DOC_MENU) return
  const src = info.mediaType === 'image' ? info.srcUrl : (/\.pdf($|[?#])/i.test(info.linkUrl || '') ? info.linkUrl : '')
  sendDocument(tab, src || '').catch(() => {})
})
chrome.commands?.onCommand.addListener(async (command, tab) => {
  if (command !== 'send-document') return
  const t = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0]
  sendDocument(t).catch(() => {})
})

// ── Capture pour Claude ──────────────────────────────────────────────────────
// Image glissée ou collée dans la fenêtre du module → l'ERP la range là où
// l'agent la lit.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== 'send-screenshot') return false
  call('/screenshot', { method: 'POST', body: { mime: msg.mime, data: msg.data, note: msg.note || '' }, timeoutMs: 60000 })
    .then(r => { flashBadge('✓', '#7c3aed'); reply({ ok: true, ...r }) }, e => reply({ ok: false, error: e.message }))
  return true
})
