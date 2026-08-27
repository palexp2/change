// ─── Utilisation Claude (quotas de l'abonnement) ───────────────────────────────
// L'agent autonome tourne sur un abonnement Claude Code (forfait fixe), pas sur
// l'API facturée au jeton. On expose donc deux choses complémentaires :
//
//   1. La consommation de JETONS agrégée depuis les transcriptions locales de
//      Claude Code (~/.claude/projects/**/*.jsonl) — chaque message assistant
//      porte un bloc `usage` + un `timestamp` ISO. Sur trois fenêtres :
//        • session : 5 dernières heures
//        • semaine : 7 derniers jours
//        • aujourd'hui : depuis minuit heure de Montréal (fenêtre calendaire, pas
//          glissante — c'est celle que la barre de la page Travaux affiche)
//
//   2. L'UTILISATION RÉELLE DE L'ABONNEMENT, lue depuis l'endpoint que Claude
//      Code utilise lui-même pour sa commande `/usage` (GET /api/oauth/usage,
//      authentifié via le token OAuth stocké dans ~/.claude/.credentials.json).
//      C'est le vrai indicateur pertinent pour un forfait — pas une estimation de
//      coût.
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
//   • IL N'Y A AUCUNE LIMITE JOURNALIÈRE (24 h). Le compteur « aujourd'hui » que
//     l'on calcule ici est une commodité de lecture (jetons dépensés depuis minuit),
//     PAS un quota — ne jamais le présenter comme une limite.
//   • `severity` ('normal' | autre) est le niveau d'alerte donné par Anthropic
//     lui-même ; `extra_usage.is_enabled` dit si des crédits de dépassement
//     prendraient le relais au plafond (chez nous : non → tout attend la réinit.).
//
// Résultat mis en cache 60 s (la page agent interroge fréquemment le statut du
// runner ; inutile de re-parser 50 Mo ni de re-frapper l'API à chaque fois).

import { readdir, readFile, stat } from 'fs/promises'
import { resolve, join } from 'path'

const HOME = process.env.HOME || '/home/ec2-user'
const PROJECTS_DIR = resolve(HOME, '.claude', 'projects')
const CREDENTIALS_PATH = resolve(HOME, '.claude', '.credentials.json')
const USAGE_ENDPOINT = 'https://api.anthropic.com/api/oauth/usage'

const SESSION_WINDOW_MS = 5 * 60 * 60 * 1000   // 5 h
const WEEK_WINDOW_MS     = 7 * 24 * 60 * 60 * 1000  // 7 j
const CACHE_TTL_MS       = 60 * 1000
const FAILED_CACHE_TTL_MS = 15 * 1000  // lecture de quotas ratée → nouvel essai rapide
const TZ                 = 'America/Montreal'

// Minuit du jour courant, heure de Montréal, en ms epoch. On soustrait à `now`
// l'heure locale écoulée plutôt que de bricoler une date — pas de dépendance et
// le changement d'heure est géré par Intl.
function startOfLocalDay(now) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(now))
  const get = (t) => Number(parts.find(p => p.type === t)?.value ?? 0)
  const h = get('hour') % 24 // Intl peut rendre « 24 » à minuit
  const elapsed = ((h * 60 + get('minute')) * 60 + get('second')) * 1000 + (now % 1000)
  return now - elapsed
}

function emptyBucket() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreateTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 0,
    messageCount: 0,
  }
}

function addUsage(bucket, usage) {
  const input = usage.input_tokens || 0
  const output = usage.output_tokens || 0
  const cacheRead = usage.cache_read_input_tokens || 0
  // Ventilation écriture cache 5 min / 1 h si disponible, sinon tout en 5 min.
  const cc = usage.cache_creation || {}
  const cw5m = cc.ephemeral_5m_input_tokens ?? usage.cache_creation_input_tokens ?? 0
  const cw1h = cc.ephemeral_1h_input_tokens ?? 0
  const cacheCreate = cw5m + cw1h

  bucket.inputTokens += input
  bucket.outputTokens += output
  bucket.cacheCreateTokens += cacheCreate
  bucket.cacheReadTokens += cacheRead
  bucket.totalTokens += input + output + cacheCreate + cacheRead
  bucket.messageCount += 1
}

async function computeTokens() {
  const now = Date.now()
  const sessionFrom = now - SESSION_WINDOW_MS
  const weekFrom = now - WEEK_WINDOW_MS
  const todayFrom = startOfLocalDay(now)

  const session = emptyBucket()
  const week = emptyBucket()
  const today = emptyBucket()
  const seen = new Set() // dédup par message.id (transcriptions reprises = lignes dupliquées)

  let projectDirs = []
  try {
    const entries = await readdir(PROJECTS_DIR, { withFileTypes: true })
    projectDirs = entries.filter(e => e.isDirectory()).map(e => join(PROJECTS_DIR, e.name))
  } catch {
    // Pas de répertoire ~/.claude/projects (ex. environnement de test) → tout à zéro.
    return { session, week, today, todayFrom }
  }

  for (const dir of projectDirs) {
    let files = []
    try {
      files = (await readdir(dir)).filter(f => f.endsWith('.jsonl'))
    } catch { continue }

    for (const name of files) {
      const path = join(dir, name)
      // Filtre mtime : seuls les fichiers modifiés dans la fenêtre semaine peuvent
      // contenir des messages pertinents (évite de lire des centaines de vieux fichiers).
      try {
        const st = await stat(path)
        if (st.mtimeMs < weekFrom) continue
      } catch { continue }

      let content
      try { content = await readFile(path, 'utf8') } catch { continue }

      for (const line of content.split('\n')) {
        // Pré-filtre bon marché : seules les lignes assistant portent output_tokens.
        if (!line || line.indexOf('"output_tokens"') === -1) continue
        let evt
        try { evt = JSON.parse(line) } catch { continue }
        if (evt.type !== 'assistant' || !evt.message?.usage) continue

        const ts = evt.timestamp ? Date.parse(evt.timestamp) : NaN
        if (!Number.isFinite(ts) || ts < weekFrom) continue

        const id = evt.message?.id || evt.requestId || evt.uuid
        if (id) {
          if (seen.has(id)) continue
          seen.add(id)
        }

        addUsage(week, evt.message.usage)
        if (ts >= sessionFrom) addUsage(session, evt.message.usage)
        if (ts >= todayFrom) addUsage(today, evt.message.usage)
      }
    }
  }

  return { session, week, today, todayFrom }
}

// Dernière lecture RÉUSSIE des quotas, gardée en mémoire. Un appel raté (token en
// cours de rafraîchissement, réseau, endpoint lent) faisait retomber l'affichage sur
// « nombre de jetons » et effaçait les jauges : illisible, et à tort — les heures de
// réinitialisation sont des horodatages absolus, elles restent justes, et un
// pourcentage vieux de quelques minutes vaut infiniment mieux que rien. On le réutilise
// donc, en disant son âge (voir subscriptionStale plus bas).
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

let _cache = null // { at, data }

async function compute() {
  const now = Date.now()
  const [tokens, fresh] = await Promise.all([computeTokens(), fetchSubscription()])

  // Lecture ratée → on garde la dernière connue (moins de 30 min) plutôt que d'effacer
  // les jauges. Les `resetsAt` étant absolus, les décomptes restent exacts ; seuls les
  // pourcentages vieillissent, et `subscriptionStale` permet de le dire à l'écran.
  const recovered = !fresh && _lastSub && (now - _lastSub.at) < SUB_STALE_MAX_MS ? _lastSub : null
  const sub = fresh || recovered?.data || null

  // Fusionne l'utilisation réelle de l'abonnement dans les mêmes buckets.
  tokens.session.utilizationPct = sub?.session.utilizationPct ?? null
  tokens.session.resetsAt = sub?.session.resetsAt ?? null
  tokens.session.severity = sub?.session.severity ?? null
  tokens.week.utilizationPct = sub?.week.utilizationPct ?? null
  tokens.week.resetsAt = sub?.week.resetsAt ?? null
  tokens.week.severity = sub?.week.severity ?? null

  return {
    session: tokens.session,
    week: tokens.week,
    // Troisième limite : plafond hebdomadaire d'un modèle donné. Pas de compteur de
    // jetons associé (on ne sait pas, côté transcriptions, ce qu'Anthropic range dans
    // ce périmètre) — seulement le % et la réinitialisation, qui suffisent à alerter.
    weekScoped: sub?.weekScoped ?? null,
    // Fenêtre calendaire : pas de % d'abonnement associé — Claude NE plafonne PAS à
    // la journée. C'est un simple volume consommé depuis minuit, jamais un quota.
    today: { ...tokens.today, since: new Date(tokens.todayFrom).toISOString() },
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

export async function getClaudeUsage() {
  if (_cache && Date.now() - _cache.at < _cache.ttl) return _cache.data
  const data = await compute()
  // Une lecture de quotas ratée ne se garde pas une minute entière : on réessaie au
  // prochain rafraîchissement de la page pour retrouver des chiffres frais vite.
  const ttl = data.subscriptionAvailable && !data.subscriptionStale ? CACHE_TTL_MS : FAILED_CACHE_TTL_MS
  _cache = { at: Date.now(), data, ttl }
  return data
}
