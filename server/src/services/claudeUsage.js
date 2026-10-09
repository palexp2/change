// ─── Utilisation Claude (quotas de l'abonnement) ───────────────────────────────
// L'agent autonome tourne sur un abonnement Claude Code (forfait fixe), pas sur
// l'API facturée au jeton. On expose donc l'UTILISATION RÉELLE DE L'ABONNEMENT,
// lue depuis l'endpoint que Claude Code utilise lui-même pour sa commande `/usage`
// (GET /api/oauth/usage, authentifié via le token OAuth stocké dans
// ~/.claude/.credentials.json). C'est le seul indicateur pertinent pour un forfait.
//
// Il n'y a PLUS de comptage de jetons (l'ancien parsing des transcriptions locales a
// été retiré le 2026-09-03) : les pourcentages d'Anthropic suffisent, et le compteur
// prêtait à confusion — il ressemblait à un quota journalier qui n'existe pas.
//
// QUELLES SONT LES LIMITES, EXACTEMENT (vérifié sur la réponse de l'endpoint le
// 2026-08-04 — le tableau `limits[]` est la source faisant foi) :
//
//   • kind 'session'       — fenêtre de 5 h, GLISSANTE : elle s'ancre au premier
//     message et se ferme 5 h plus tard, puis une nouvelle s'ouvre à l'échange
//     suivant. Ce n'est donc pas un créneau fixe de la journée : le même compteur
//     expirait à 08:38 UTC le matin et à 18:40 UTC l'après-midi du même jour.
//   • kind 'weekly_all'    — total sur 7 jours, tous modèles confondus. Se
//     réinitialise à date et heure fixes (ex. jeudi 01:59:59 UTC).
//   • kind 'weekly_scoped' — plafond hebdomadaire propre à UN modèle (Fable).
//     Ignoré : l'agent ne tourne plus sur Fable (2026-09-30).
//
//   • IL N'Y A AUCUNE LIMITE JOURNALIÈRE (24 h).
//   • `severity` ('normal' | autre) est le niveau d'alerte donné par Anthropic
//     lui-même ; `extra_usage.is_enabled` dit si des crédits de dépassement
//     prendraient le relais au plafond (chez nous : non → tout attend la réinit.).
//
// Résultat mis en cache 5 min : l'endpoint refuse (429) dès qu'on le lit plus d'une
// fois toutes les ~2 min — et Claude Code, qui tourne pour l'agent, consomme le même
// crédit de lecture. Un quota n'a pas besoin d'être connu à la minute. Le cache est servi
// TOUJOURS sans attendre : voir getClaudeUsage() — une lecture périmée part en
// rafraîchissement de fond au lieu de faire patienter la page.
//
// PLUSIEURS COMPTES (2026-10-01) : chaque compte Claude (voir claudeAccounts.js) a
// son propre lecteur — son cache, son backoff, sa dernière lecture connue. La vue
// agrégée (sans `accountId`) est celle du compte qui a le plus de marge, c'est-à-dire
// celui sur lequel la prochaine exécution partira, avec le détail de chaque compte
// dans `accounts[]`.

import { readFile, writeFile, rename } from 'fs/promises'
import { resolve } from 'path'
import {
  listAccounts, getAccount, pickAccount, accountLimitedUntil, PRIMARY_ACCOUNT_ID,
} from './claudeAccounts.js'

const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'
const TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token'
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'

const CACHE_TTL_MS = 5 * 60 * 1000

// ─── Ce qui se passe quand la lecture échoue ──────────────────────────────────
// L'endpoint des quotas est lui-même limité en fréquence (HTTP 429). Avant, un
// échec RACCOURCISSAIT le cache à 15 s : on frappait donc quatre fois plus fort
// l'endpoint qui venait de nous refouler, et le refus s'entretenait tout seul
// (jauges vides pendant des heures). Désormais un échec espace les tentatives —
// 2 min, 4 min, 8 min… jusqu'à 30 min — et l'`Retry-After` du serveur, s'il en
// donne un, prime sur ce calcul. Une réussite remet le compteur à zéro.
const RETRY_BASE_MS = 2 * 60 * 1000
const RETRY_MAX_MS  = 30 * 60 * 1000

const FAIL_LABELS = {
  no_credentials: 'aucun jeton Claude lisible sur la machine',
  rate_limited: 'limite de consultation atteinte chez Anthropic',
  unauthorized: 'jeton Claude refusé (reconnexion nécessaire)',
  http_error: 'réponse inattendue d\'Anthropic',
  network: 'endpoint des quotas injoignable',
}

/** Nature d'un refus HTTP — c'est elle qui sera dite à l'écran. */
export function failureReasonForStatus(status) {
  if (status === 429) return 'rate_limited'
  if (status === 401 || status === 403) return 'unauthorized'
  return 'http_error'
}

/**
 * Attente avant le prochain essai. `retryAfterMs` = en-tête `Retry-After` du serveur
 * quand il en donne un ; il ne sert qu'à ALLONGER l'attente (Anthropic renvoie parfois
 * `Retry-After: 0` avec son 429 — le prendre au mot relancerait la boucle qu'on veut
 * casser).
 */
export function nextRetryDelayMs(attempts, retryAfterMs = null) {
  const backoff = Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS)
  return Number.isFinite(retryAfterMs) && retryAfterMs > backoff
    ? Math.min(retryAfterMs, RETRY_MAX_MS)
    : backoff
}

// Dernière lecture RÉUSSIE gardée 30 min : un appel raté effacerait les jauges à
// tort — les heures de réinitialisation sont absolues, elles restent justes, et un
// pourcentage vieux de quelques minutes vaut mieux que rien (voir subscriptionStale).
const SUB_STALE_MAX_MS = 30 * 60 * 1000
const ACCOUNT_TTL_MS = 10 * 60 * 1000
const emptyBucket = () => ({ utilizationPct: null, resetsAt: null, severity: null })

// ─── Jeton d'un compte au repos ───────────────────────────────────────────────
// Le jeton OAuth (~8 h) est renouvelé par Claude Code lui-même pendant qu'il tourne.
// Avec deux comptes, l'un peut rester des heures sans exécution : son jeton expire et
// ses quotas deviendraient illisibles — donc jamais choisi, donc jamais renouvelé.
// On le renouvelle nous-mêmes, mais SEULEMENT une fois expiré : un Claude en marche
// l'aurait renouvelé avant l'échéance, donc personne d'autre n'y touche à ce moment.
async function readOauth(credPath) {
  return JSON.parse(await readFile(credPath, 'utf8'))?.claudeAiOauth || null
}

async function refreshIfExpired(credPath) {
  const raw = JSON.parse(await readFile(credPath, 'utf8'))
  const o = raw?.claudeAiOauth
  if (!o?.refreshToken || !o.expiresAt || o.expiresAt > Date.now()) return o?.accessToken || null
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grant_type: 'refresh_token', refresh_token: o.refreshToken, client_id: OAUTH_CLIENT_ID }),
    signal: AbortSignal.timeout(8000),
  })
  if (!res.ok) throw new Error(`renouvellement du jeton HTTP ${res.status}`)
  const t = await res.json()
  raw.claudeAiOauth = {
    ...o,
    accessToken: t.access_token,
    refreshToken: t.refresh_token || o.refreshToken,
    expiresAt: Date.now() + (Number(t.expires_in) || 3600) * 1000,
  }
  const tmp = `${credPath}.tmp-${process.pid}`
  await writeFile(tmp, JSON.stringify(raw), { mode: 0o600 })
  await rename(tmp, credPath)
  console.log(`🤖 Quotas Claude: jeton renouvelé (${credPath})`)
  return t.access_token
}

// ─── Un lecteur par compte ────────────────────────────────────────────────────
function makeReader(accountId) {
  let _fail = null    // { at, reason, message, attempts, retryAt, since }
  let _lastSub = null // { at, data }
  let _profile = null // { at, data }
  let _cache = null   // { at, data, ttl }
  let _inflight = null
  const acc = () => getAccount(accountId)
  const credPath = () => resolve(acc().configDir, '.credentials.json')

  function noteFailure(reason, message = null, retryAfterMs = null) {
    const attempts = (_fail?.attempts || 0) + 1
    const wait = nextRetryDelayMs(attempts, retryAfterMs)
    const now = Date.now()
    // Une ligne au premier échec puis à chaque palier : « passager ou récurrent ? ».
    if (attempts === 1 || attempts % 5 === 0) {
      console.warn(`🤖 Quotas Claude [${accountId}]: lecture impossible (${reason}${message ? ' — ' + message : ''}) `
        + `— tentative n° ${attempts}, prochaine dans ${Math.round(wait / 1000)} s`)
    }
    _fail = { at: now, reason, message, attempts, retryAt: now + wait, since: _fail?.since || now }
    return null
  }

  function noteSuccess() {
    if (_fail) {
      console.log(`🤖 Quotas Claude [${accountId}]: lecture rétablie après ${_fail.attempts} échec(s)`)
      _fail = null
    }
  }

  function failureInfo() {
    if (!_fail) return null
    return {
      reason: _fail.reason,
      label: FAIL_LABELS[_fail.reason] || _fail.reason,
      attempts: _fail.attempts,
      since: new Date(_fail.since).toISOString(),
      retryAt: new Date(_fail.retryAt).toISOString(),
    }
  }

  // Lit l'utilisation réelle de l'abonnement via l'endpoint de la commande `/usage`.
  async function fetchSubscription() {
    // Tentative trop rapprochée d'un échec : on ne frappe même pas l'endpoint (c'est
    // la fréquence elle-même qui déclenche les 429).
    if (_fail && Date.now() < _fail.retryAt) return null

    let token
    try {
      token = await refreshIfExpired(credPath())
    } catch (e) {
      if (e?.code === 'ENOENT' || e instanceof SyntaxError) return noteFailure('no_credentials')
      // Renouvellement refusé : on tente quand même avec le jeton en place.
      try { token = (await readOauth(credPath()))?.accessToken } catch { return noteFailure('no_credentials') }
    }
    if (!token) return noteFailure('no_credentials')

    let data
    try {
      const res = await fetch(USAGE_ENDPOINT, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'anthropic-beta': 'oauth-2025-04-20',
        },
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) {
        return noteFailure(
          failureReasonForStatus(res.status),
          `HTTP ${res.status}`,
          Number(res.headers.get('retry-after')) * 1000,
        )
      }
      data = await res.json()
    } catch (e) { return noteFailure('network', e?.message || null) }

    // `limits[]` fait foi (severity + scope, c'est lui que Claude Code affiche) ; les
    // champs plats `five_hour`/`seven_day` restent en repli.
    const limits = Array.isArray(data.limits) ? data.limits : []
    const byKind = (kind) => limits.find(l => l?.kind === kind) || null
    const round = (v) => (Number.isFinite(v) ? Math.round(v) : null)
    const flatPct = (v) => round(v?.utilization)
    const session = byKind('session')
    const weekly = byKind('weekly_all')

    const parsed = {
      session: {
        utilizationPct: round(session?.percent) ?? flatPct(data.five_hour),
        resetsAt: session?.resets_at || data.five_hour?.resets_at || null,
        severity: session?.severity || null,
      },
      week: {
        utilizationPct: round(weekly?.percent) ?? flatPct(data.seven_day),
        resetsAt: weekly?.resets_at || data.seven_day?.resets_at || null,
        severity: weekly?.severity || null,
      },
      // Crédits de dépassement désactivés = un plafond ARRÊTE ce compte jusqu'à la
      // réinitialisation.
      extraUsageEnabled: !!data.extra_usage?.is_enabled,
    }
    _lastSub = { at: Date.now(), data: parsed }
    noteSuccess()
    return parsed
  }

  // Profil du compte (Claude Code le garde dans son .claude.json, `oauthAccount`) ;
  // nature du forfait depuis le fichier de credentials. Change seulement à la reconnexion.
  async function readProfile() {
    if (_profile && Date.now() - _profile.at < ACCOUNT_TTL_MS) return _profile.data
    let data = null
    try {
      const a = JSON.parse(await readFile(acc().globalConfig, 'utf8'))?.oauthAccount
      if (a?.emailAddress || a?.displayName) {
        data = {
          email: a.emailAddress || null,
          name: a.displayName || a.fullName || null,
          organization: a.organizationName || null,
        }
      }
    } catch { /* pas de config lisible → pas de compte affiché */ }
    if (data) {
      try { data.plan = (await readOauth(credPath()))?.subscriptionType || null } catch { data.plan = null }
    }
    _profile = { at: Date.now(), data }
    return data
  }

  async function compute() {
    const now = Date.now()
    const [fresh, account] = await Promise.all([fetchSubscription(), readProfile()])
    const recovered = !fresh && _lastSub && (now - _lastSub.at) < SUB_STALE_MAX_MS ? _lastSub : null
    const sub = fresh || recovered?.data || null
    return {
      accountId,
      account,
      session: sub?.session ?? emptyBucket(),
      week: sub?.week ?? emptyBucket(),
      extraUsageEnabled: sub?.extraUsageEnabled ?? false,
      subscriptionAvailable: sub != null,
      subscriptionStale: !!recovered,
      subscriptionAt: new Date(fresh ? now : (recovered?.at ?? now)).toISOString(),
      subscriptionError: fresh ? null : failureInfo(),
      generatedAt: new Date(now).toISOString(),
    }
  }

  function refresh() {
    if (_inflight) return _inflight
    _inflight = compute()
      .then(data => {
        // Après un échec, le cache tient jusqu'à la prochaine tentative autorisée.
        const now = Date.now()
        const ttl = _fail ? Math.max(5_000, _fail.retryAt - now) : CACHE_TTL_MS
        _cache = { at: now, data, ttl }
        return data
      })
      .finally(() => { _inflight = null })
    return _inflight
  }

  async function get({ allowStale = true } = {}) {
    if (_cache) {
      if (Date.now() - _cache.at < _cache.ttl) return _cache.data
      // Périmé → rafraîchissement de fond, réponse immédiate (affichage).
      const p = refresh()
      if (allowStale) { p.catch(() => {}); return _cache.data }
      return p
    }
    return refresh()
  }

  return { get, refresh, peek: () => _cache?.data || null }
}

const _readers = new Map()
function reader(id) {
  if (!_readers.has(id)) _readers.set(id, makeReader(id))
  return _readers.get(id)
}

// Seuils du garde-fou (ils départagent les comptes) — import paresseux : quotaGuard
// importe ce module.
// Une fonction id → seuils : chaque compte a les siens.
const NO_FLOORS = () => ({ session: 0, week: 0 })
async function floors() {
  try { return (await import('./quotaGuard.js')).getQuotaFloors } catch { return NO_FLOORS }
}
let _floorsCache = NO_FLOORS

/**
 * Vue agrégée : celle du compte qui a le plus de marge (la prochaine exécution part
 * dessus), et `accounts[]` = le détail de chaque compte, dans l'ordre (principal en tête).
 */
function aggregate(list) {
  const byId = Object.fromEntries(list.filter(Boolean).map(d => [d.accountId, d]))
  const best = pickAccount(byId, _floorsCache)
  const top = byId[best.id] || list.find(Boolean) || null
  if (!top) return null
  return {
    ...top,
    activeAccountId: best.id,
    accounts: listAccounts().map(a => {
      const d = byId[a.id]
      const until = accountLimitedUntil(a.id)
      return {
        ...(d || { accountId: a.id, account: null, session: emptyBucket(), week: emptyBucket(), subscriptionAvailable: false }),
        id: a.id,
        primary: a.id === PRIMARY_ACCOUNT_ID,
        limitedUntil: until ? new Date(until).toISOString() : null,
      }
    }),
  }
}

// ─── Servir sans faire attendre ───────────────────────────────────────────────
// Le serveur est mono-thread : une lecture en vol par compte (`_inflight`), cache
// servi même périmé à l'affichage (rafraîchi en fond), et réchauffage tant qu'un écran
// regarde (`keepWarm`, posé par la route HTTP) — les appels internes ne réchauffent
// pas : inutile de frapper l'API quand personne ne regarde.
const KEEP_WARM_MS = 5 * 60 * 1000
let _lastAskedAt = 0
let _warmTimer = null

function scheduleKeepWarm() {
  if (_warmTimer) return
  _warmTimer = setTimeout(() => {
    _warmTimer = null
    if (Date.now() - _lastAskedAt > KEEP_WARM_MS) return // plus personne ne regarde
    Promise.all(listAccounts().map(a => reader(a.id).refresh().catch(() => null)))
      .then(scheduleKeepWarm)
  }, CACHE_TTL_MS)
  _warmTimer.unref?.()
}

/**
 * Quotas de l'abonnement.
 *   `accountId`  — un compte précis ; sinon la vue agrégée (voir aggregate()).
 *   `allowStale` — false pour une DÉCISION : on attend une lecture fraîche.
 *   `keepWarm`   — posé par la route HTTP : quelqu'un regarde, on entretient le cache.
 */
export async function getClaudeUsage({ allowStale = true, keepWarm = false, accountId = null } = {}) {
  if (keepWarm) { _lastAskedAt = Date.now(); scheduleKeepWarm() }
  if (accountId) return reader(getAccount(accountId).id).get({ allowStale })
  _floorsCache = await floors()
  const list = await Promise.all(listAccounts().map(a => reader(a.id).get({ allowStale }).catch(() => null)))
  return aggregate(list)
}

// Dernière lecture connue, sans rien déclencher : la barre de gauche (toutes les
// pages) ne doit jamais ajouter d'appel à Anthropic.
export function peekClaudeUsage() {
  const list = listAccounts().map(a => _readers.get(a.id)?.peek() || null)
  return list.some(Boolean) ? aggregate(list) : null
}

/** Quotas connus par compte (cache seul) — sert à choisir le compte d'une exécution. */
export function peekUsageByAccount() {
  return Object.fromEntries(listAccounts().map(a => [a.id, _readers.get(a.id)?.peek() || null]))
}

/** Compte sur lequel lancer la prochaine exécution. */
export function chooseRunAccount() {
  return pickAccount(peekUsageByAccount(), _floorsCache)
}

// Premier chargement, décalé de 5 s (pas sur le relais de redémarrage).
if (process.env.ERP_ROLE !== 'standby') setTimeout(() => { getClaudeUsage().catch(() => {}) }, 5000).unref?.()
