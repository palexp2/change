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

const CACHE_TTL_MS        = 60 * 1000
const FAILED_CACHE_TTL_MS = 15 * 1000  // lecture de quotas ratée → nouvel essai rapide

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
  let token
  try {
    const raw = await readFile(CREDENTIALS_PATH, 'utf8')
    token = JSON.parse(raw)?.claudeAiOauth?.accessToken
  } catch { return null }
  if (!token) return null

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
    if (!res.ok) return null
    data = await res.json()
  } catch { return null }

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
  return parsed
}

const emptyBucket = () => ({ utilizationPct: null, resetsAt: null, severity: null })

let _cache = null // { at, data, ttl }

async function compute() {
  const now = Date.now()
  const fresh = await fetchSubscription()

  // Lecture ratée → on garde la dernière connue (moins de 30 min) plutôt que d'effacer
  // les jauges. Les `resetsAt` étant absolus, les décomptes restent exacts ; seuls les
  // pourcentages vieillissent, et `subscriptionStale` permet de le dire à l'écran.
  const recovered = !fresh && _lastSub && (now - _lastSub.at) < SUB_STALE_MAX_MS ? _lastSub : null
  const sub = fresh || recovered?.data || null

  return {
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
      // Une lecture de quotas ratée ne se garde pas une minute entière : on réessaie au
      // prochain rafraîchissement de la page pour retrouver des chiffres frais vite.
      const ttl = data.subscriptionAvailable && !data.subscriptionStale ? CACHE_TTL_MS : FAILED_CACHE_TTL_MS
      _cache = { at: Date.now(), data, ttl }
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
