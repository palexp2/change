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

export async function settings() {
  const { erpUrl = '', token = '', auto = true } =
    await chrome.storage.local.get(['erpUrl', 'token', 'auto'])
  return { erpUrl, token, auto }
}

async function call(path, { method = 'GET', body = null } = {}) {
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
    })
  } catch {
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
    if (!tab.id) continue
    try {
      const [res] = await chrome.scripting.executeScript({
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
      })
      if (res?.result?.localStorage?.length) byOrigin.set(res.result.origin, res.result)
    } catch { /* onglet protégé (page interne, PDF…) */ }
  }
  return [...byOrigin.values()]
}

/** Envoie la session d'UN portail. */
async function pushOne(t) {
  const cookies = await cookiesFor(t.domains || [])
  if (!cookies.length) return { ...t, state: 'absent', detail: 'pas de session ouverte dans ce navigateur' }
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
    list = await targets({ fresh: true })
  } catch (e) {
    await setRun({ running: false, error: e.message })
    return
  }
  const sent = []
  for (const t of list) {
    try { sent.push(await pushOne(t)) }
    catch (e) { sent.push({ ...t, state: 'erreur', detail: e.message }) }
    await setRun({ sent })
  }
  // Même si un portail n'a pas de session, les autres valent le déplacement.
  try {
    const collect = await call('/collect', { method: 'POST' })
    await setRun({ running: false, sent, collect })
  } catch (e) {
    await setRun({ running: false, sent, error: e.message })
  }
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
  if (hit) schedulePush(hit)
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
  try { list = await targets({ fresh: true }) } catch { return }
  for (const t of list) { try { await pushOne(t) } catch { /* on réessaiera */ } }
}
chrome.runtime.onStartup?.addListener(pushAll)
chrome.runtime.onInstalled?.addListener(pushAll)

// On répond TOUT DE SUITE : la fenêtre suit ensuite l'avancement dans le
// stockage. Attendre la fin ici laissait le bouton figé sur « Envoi… » quand le
// service du module était recyclé en cours de route.
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg?.type !== 'run-bridge') return false
  runBridge().catch(async (e) => { await setRun({ running: false, error: e.message }) })
  reply({ ok: true, started: true })
  return false
})
