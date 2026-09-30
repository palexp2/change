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
    res = await fetch(`${origin}/erp/api/scrapers/session-bridge${path}`, {
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
