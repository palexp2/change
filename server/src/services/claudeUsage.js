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
//   • kind 'weekly_scoped' — plafond hebdomadaire propre à UN modèle (`scope.model`,
//     ex. « Fable »). Troisième limite réelle : elle peut bloquer le modèle haut de
//     gamme alors que les deux autres jauges paraissent au vert.
//
//   • IL N'Y A AUCUNE LIMITE JOURNALIÈRE (24 h).
//   • `severity` ('normal' | autre) est le niveau d'alerte donné par Anthropic
//     lui-même ; `extra_usage.is_enabled` dit si des crédits de dépassement
//     prendraient le relais au plafond (chez nous : non → tout attend la réinit.).
//
// Résultat mis en cache 60 s (la page agent interroge fréquemment le statut du
// runner ; inutile de re-frapper l'API à chaque fois). Le cache est servi
// TOUJOURS sans attendre : voir getClaudeUsage() — une lecture périmée part en
// rafraîchissement de fond au lieu de faire patienter la page.

import { readFile } from 'fs/promises'
import { resolve } from 'path'

const HOME = process.env.HOME || '/home/ec2-user'
const CREDENTIALS_PATH = resolve(HOME, '.claude', '.credentials.json')
const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'

const CACHE_TTL_MS = 60 * 1000

// ─── Ce qui se passe quand la lecture échoue ──────────────────────────────────
// L'endpoint des quotas est lui-même limité en fréquence (HTTP 429). Avant, un
// échec RACCOURCISSAIT le cache à 15 s : on frappait donc quatre fois plus fort
// l'endpoint qui venait de nous refouler, et le refus s'entretenait tout seul
// (jauges vides pendant des heures). Désormais un échec espace les tentatives —
// 30 s, 1 min, 2 min… jusqu'à 10 min — et l'`Retry-After` du serveur, s'il en
// donne un, prime sur ce calcul. Une réussite remet le compteur à zéro.
const RETRY_BASE_MS = 30 * 1000
const RETRY_MAX_MS  = 10 * 60 * 1000

let _fail = null // { at, reason, message, attempts, retryAt }

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

function noteFailure(reason, message = null, retryAfterMs = null) {
  const attempts = (_fail?.attempts || 0) + 1
  const wait = nextRetryDelayMs(attempts, retryAfterMs)
  const now = Date.now()
  // Une seule ligne de journal au premier échec puis à chaque palier : de quoi
  // répondre à « est-ce passager ou récurrent ? » en relisant les logs.
  if (attempts === 1 || attempts % 5 === 0) {
    console.warn(`🤖 Quotas Claude: lecture impossible (${reason}${message ? ' — ' + message : ''}) `
      + `— tentative n° ${attempts}, prochaine dans ${Math.round(wait / 1000)} s`)
  }
  _fail = { at: now, reason, message, attempts, retryAt: now + wait, since: _fail?.since || now }
  return null
}

function noteSuccess() {
  if (_fail) {
    console.log(`🤖 Quotas Claude: lecture rétablie après ${_fail.attempts} échec(s)`)
    _fail = null
  }
}

/** État d'échec exposé à la page (null = tout va bien). */
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

// Dernière lecture RÉUSSIE des quotas, gardée en mémoire. Un appel raté (token en
// cours de rafraîchissement, réseau, endpoint lent) effacerait les jauges : à tort —
// les heures de réinitialisation sont des horodatages absolus, elles restent justes,
// et un pourcentage vieux de quelques minutes vaut infiniment mieux que rien. On le
// réutilise donc, en disant son âge (voir subscriptionStale plus bas).
let _lastSub = null // { at, data }
const SUB_STALE_MAX_MS = 30 * 60 * 1000

// Lit l'utilisation réelle de l'abonnement Claude Code via l'endpoint OAuth que
// la commande `/usage` de Claude Code utilise. Le token OAuth est maintenu à jour
// par Claude Code lui-même (qui tourne en permanence pour l'agent) ; on se
// contente de le relire à chaque appel. Dégradation silencieuse (→ null) si le
// fichier de credentials est absent, le token expiré/refusé, ou le réseau KO.
async function fetchSubscription() {
  // Tentative trop rapprochée d'un échec : on ne frappe même pas l'endpoint (c'est
  // la fréquence elle-même qui déclenche les 429). L'appelant se rabattra sur la
  // dernière lecture connue, comme pour n'importe quel échec.
  if (_fail && Date.now() < _fail.retryAt) return null

  let token
  try {
    const raw = await readFile(CREDENTIALS_PATH, 'utf8')
    token = JSON.parse(raw)?.claudeAiOauth?.accessToken
  } catch { return noteFailure('no_credentials') }
  if (!token) return noteFailure('no_credentials')

  let data
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    let res
    try {
      res = await fetch(USAGE_ENDPOINT, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'anthropic-beta': 'oauth-2025-04-20',
        },
        signal: controller.signal,
      })
    } finally { clearTimeout(timer) }
    if (!res.ok) {
      return noteFailure(
        failureReasonForStatus(res.status),
        `HTTP ${res.status}`,
        Number(res.headers.get('retry-after')) * 1000,
      )
    }
    data = await res.json()
  } catch (e) { return noteFailure('network', e?.message || null) }

  // `limits[]` est la vue faisant foi (elle porte severity + scope, et c'est elle
  // que Claude Code affiche). Les champs plats `five_hour`/`seven_day` restent en
  // repli au cas où une version de l'API ne renverrait que ceux-là.
  const limits = Array.isArray(data.limits) ? data.limits : []
  const byKind = (kind) => limits.find(l => l?.kind === kind) || null
  const round = (v) => (Number.isFinite(v) ? Math.round(v) : null)
  const flatPct = (v) => round(v?.utilization)

  const session = byKind('session')
  const weekly = byKind('weekly_all')
  const scoped = byKind('weekly_scoped')

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
    // Plafond hebdomadaire d'un modèle précis. Absent du forfait ? → null, et la page
    // n'affiche simplement rien (plutôt qu'une jauge à zéro qui inquiéterait pour rien).
    weekScoped: scoped ? {
      utilizationPct: round(scoped.percent),
      resetsAt: scoped.resets_at || null,
      severity: scoped.severity || null,
      // `display_name` est le libellé d'Anthropic (ex. « Fable ») : on le rend tel quel
      // au lieu de deviner un nom de modèle.
      label: scoped.scope?.model?.display_name || null,
    } : null,
    // Crédits de dépassement : désactivés = atteindre un plafond ARRÊTE le travail
    // jusqu'à la réinitialisation (rien ne bascule en facturation à l'usage).
    extraUsageEnabled: !!data.extra_usage?.is_enabled,
  }

  _lastSub = { at: Date.now(), data: parsed }
  noteSuccess()
  return parsed
}

// ─── Quel compte Claude ? ─────────────────────────────────────────────────────
// Les plafonds sont ceux d'UN abonnement précis : sans dire lequel, un pourcentage
// bas ou haut ne s'explique pas (« c'est mon compte ou celui de l'agent ? »).
// Claude Code garde le profil du compte connecté dans ~/.claude.json
// (`oauthAccount`) ; la nature du forfait vient du fichier de credentials
// (`subscriptionType`). Lecture mise en cache longtemps : ça ne change qu'à une
// reconnexion.
const CLAUDE_CONFIG_PATH = resolve(HOME, '.claude.json')
const ACCOUNT_TTL_MS = 10 * 60 * 1000
let _account = null // { at, data }

async function readAccount() {
  if (_account && Date.now() - _account.at < ACCOUNT_TTL_MS) return _account.data
  let data = null
  try {
    const acc = JSON.parse(await readFile(CLAUDE_CONFIG_PATH, 'utf8'))?.oauthAccount
    if (acc?.emailAddress || acc?.displayName) {
      data = {
        email: acc.emailAddress || null,
        name: acc.displayName || acc.fullName || null,
        organization: acc.organizationName || null,
      }
    }
  } catch { /* pas de config lisible → on n'affiche simplement pas de compte */ }
  if (data) {
    try {
      const oauth = JSON.parse(await readFile(CREDENTIALS_PATH, 'utf8'))?.claudeAiOauth
      data.plan = oauth?.subscriptionType || null
    } catch { data.plan = null }
  }
  _account = { at: Date.now(), data }
  return data
}

const emptyBucket = () => ({ utilizationPct: null, resetsAt: null, severity: null })

let _cache = null // { at, data, ttl }

async function compute() {
  const now = Date.now()
  const [fresh, account] = await Promise.all([fetchSubscription(), readAccount()])

  // Lecture ratée → on garde la dernière connue (moins de 30 min) plutôt que d'effacer
  // les jauges. Les `resetsAt` étant absolus, les décomptes restent exacts ; seuls les
  // pourcentages vieillissent, et `subscriptionStale` permet de le dire à l'écran.
  const recovered = !fresh && _lastSub && (now - _lastSub.at) < SUB_STALE_MAX_MS ? _lastSub : null
  const sub = fresh || recovered?.data || null

  return {
    // Compte Claude auquel ces plafonds appartiennent (null si non lisible).
    account,
    session: sub?.session ?? emptyBucket(),
    week: sub?.week ?? emptyBucket(),
    // Troisième limite : plafond hebdomadaire d'un modèle donné — seulement le % et la
    // réinitialisation, qui suffisent à alerter.
    weekScoped: sub?.weekScoped ?? null,
    // Faux = au plafond, tout attend la réinitialisation (aucun crédit de secours).
    extraUsageEnabled: sub?.extraUsageEnabled ?? false,
    subscriptionAvailable: sub != null,
    // Pourcentages issus d'une lecture antérieure (l'appel du moment a échoué) :
    // la page l'annonce au lieu de laisser croire à des chiffres frais.
    subscriptionStale: !!recovered,
    subscriptionAt: new Date(fresh ? now : (recovered?.at ?? now)).toISOString(),
    // Pourquoi la lecture échoue, et quand on réessaie : sans ça, la page ne pouvait
    // afficher qu'un tiret muet, impossible à distinguer d'une panne durable.
    subscriptionError: fresh ? null : failureInfo(),
    generatedAt: new Date(now).toISOString(),
  }
}

// ─── Servir sans faire attendre ───────────────────────────────────────────────
// L'appel à Anthropic prend ~200 ms en temps normal, mais le serveur est
// mono-thread : quand une exécution d'agent ou une synchro l'occupe, la requête
// s'ajoute derrière et les jauges mettaient plusieurs secondes à s'afficher.
// Trois garde-fous :
//   1. `_inflight` — une seule lecture en vol : dix pages qui interrogent en même
//      temps partagent le même appel réseau au lieu d'en lancer dix.
//   2. Périmé mais connu → on répond TOUT DE SUITE avec la dernière lecture et on
//      rafraîchit en fond (les `resetsAt` sont absolus, seuls les % vieillissent
//      d'une minute).
//   3. Tant qu'un écran regarde (`keepWarm`, posé par la route HTTP dans les 5
//      dernières minutes), le cache est réchauffé tout seul : la lecture suivante
//      est déjà prête. Les appels internes (garde-fou de quota, choix du modèle)
//      ne déclenchent pas ce réchauffage — inutile de frapper l'API en continu
//      quand personne ne regarde.
const KEEP_WARM_MS   = 5 * 60 * 1000   // durée d'« intérêt » après la dernière requête
let _inflight = null
let _lastAskedAt = 0
let _warmTimer = null

function refresh() {
  if (_inflight) return _inflight
  _inflight = compute()
    .then(data => {
      // Après un échec, le cache tient jusqu'à la prochaine tentative autorisée : pas
      // la peine de laisser dix lecteurs relancer un appel qui ne partira pas.
      const now = Date.now()
      const ttl = _fail ? Math.max(5_000, _fail.retryAt - now) : CACHE_TTL_MS
      _cache = { at: now, data, ttl }
      return data
    })
    .finally(() => { _inflight = null })
  return _inflight
}

// Réchauffage : un seul minuteur, replanifié tant que la page est consultée, et
// `unref()` pour ne jamais retenir le process en vie.
function scheduleKeepWarm() {
  if (_warmTimer) return
  _warmTimer = setTimeout(() => {
    _warmTimer = null
    if (Date.now() - _lastAskedAt > KEEP_WARM_MS) return // plus personne ne regarde
    refresh().catch(() => {}).then(scheduleKeepWarm)
  }, CACHE_TTL_MS)
  _warmTimer.unref?.()
}

/**
 * Quotas de l'abonnement.
 *   `allowStale` — false pour une DÉCISION (attribution d'un plafond, garde-fou) :
 *      on attend alors une lecture fraîche si le cache est périmé. L'affichage, lui,
 *      préfère un chiffre d'il y a une minute tout de suite.
 *   `keepWarm`   — posé par la route HTTP : quelqu'un regarde, on entretient le cache.
 */
export async function getClaudeUsage({ allowStale = true, keepWarm = false } = {}) {
  if (keepWarm) { _lastAskedAt = Date.now(); scheduleKeepWarm() }
  if (_cache) {
    const expired = Date.now() - _cache.at >= _cache.ttl
    if (!expired) return _cache.data
    // Périmé → rafraîchissement de fond, mais on répond immédiatement.
    const p = refresh()
    if (allowStale) { p.catch(() => {}); return _cache.data }
    return p
  }
  return refresh()
}

// Premier chargement : on remplit le cache sans attendre qu'une page le demande,
// pour que la toute première consultation soit instantanée elle aussi. Décalé de
// 5 s, le temps que le démarrage du serveur retombe.
setTimeout(() => { refresh().catch(() => {}) }, 5000).unref?.()
