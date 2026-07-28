// ─── Utilisation Claude (session 5 h + semaine 7 j) ───────────────────────────
// L'agent autonome tourne sur un abonnement Claude Code (forfait fixe), pas sur
// l'API facturée au jeton. On expose donc deux choses complémentaires :
//
//   1. La consommation de JETONS agrégée depuis les transcriptions locales de
//      Claude Code (~/.claude/projects/**/*.jsonl) — chaque message assistant
//      porte un bloc `usage` + un `timestamp` ISO. Sur deux fenêtres glissantes :
//        • session : 5 dernières heures
//        • semaine : 7 derniers jours
//
//   2. L'UTILISATION RÉELLE DE L'ABONNEMENT, lue depuis l'endpoint que Claude
//      Code utilise lui-même pour sa commande `/usage` (GET /api/oauth/usage,
//      authentifié via le token OAuth stocké dans ~/.claude/.credentials.json).
//      On en tire le pourcentage de la limite de session (5 h) et de la limite
//      hebdomadaire (7 j) consommé, ainsi que l'heure de réinitialisation. C'est
//      le vrai indicateur pertinent pour un forfait — pas une estimation de coût.
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

  const session = emptyBucket()
  const week = emptyBucket()
  const seen = new Set() // dédup par message.id (transcriptions reprises = lignes dupliquées)

  let projectDirs = []
  try {
    const entries = await readdir(PROJECTS_DIR, { withFileTypes: true })
    projectDirs = entries.filter(e => e.isDirectory()).map(e => join(PROJECTS_DIR, e.name))
  } catch {
    // Pas de répertoire ~/.claude/projects (ex. environnement de test) → tout à zéro.
    return { session, week }
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
      }
    }
  }

  return { session, week }
}

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

  const pct = (v) => (Number.isFinite(v?.utilization) ? Math.round(v.utilization) : null)
  return {
    session: { utilizationPct: pct(data.five_hour), resetsAt: data.five_hour?.resets_at || null },
    week: { utilizationPct: pct(data.seven_day), resetsAt: data.seven_day?.resets_at || null },
  }
}

let _cache = null // { at, data }

async function compute() {
  const now = Date.now()
  const [tokens, sub] = await Promise.all([computeTokens(), fetchSubscription()])

  // Fusionne l'utilisation réelle de l'abonnement dans les mêmes buckets.
  tokens.session.utilizationPct = sub?.session.utilizationPct ?? null
  tokens.session.resetsAt = sub?.session.resetsAt ?? null
  tokens.week.utilizationPct = sub?.week.utilizationPct ?? null
  tokens.week.resetsAt = sub?.week.resetsAt ?? null

  return {
    session: tokens.session,
    week: tokens.week,
    subscriptionAvailable: sub != null,
    generatedAt: new Date(now).toISOString(),
  }
}

export async function getClaudeUsage() {
  if (_cache && Date.now() - _cache.at < CACHE_TTL_MS) return _cache.data
  const data = await compute()
  _cache = { at: Date.now(), data }
  return data
}
