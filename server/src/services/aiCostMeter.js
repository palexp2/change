import db from '../db/database.js'

// Coût des API d'IA payées à l'usage (Paramètres → Coûts IA).
//
// Mesure : `installAiFetchMeter()` observe le `fetch` global — tout appel texte à
// OpenAI ou Gemini, présent ou futur, laisse une ligne (jetons, modèle, module
// appelant) sans toucher aux appelants. La réponse est clonée : l'appelant lit
// la sienne intacte, et un échec de mesure n'est jamais le sien.
// Coût affiché = coût réel :
// - OpenAI : facture de l'organisation (OPENAI_ADMIN_KEY), par jour et par ligne
//   de facture (« gpt-4o-mini, input »…), répartie entre les fonctionnalités au
//   prorata des jetons mesurés ce jour-là. Whisper → Transcription. Une ligne sans
//   usage mesuré dans l'ERP → « Hors ERP ».
// - Gemini : Google n'expose pas sa facture ; jetons × prix Google (ce qu'il facture).

// USD par million de jetons (Gemini seulement). Modèle absent → coût « ? ».
const GEMINI_PRICES = {
  'gemini-3.5-flash-lite': [0.30, 2.50],
}

const FEATURE_LABELS = {
  whisper: 'Transcription',
  instagramProfiles: 'Instagram',
  instagramSegments: 'Instagram',
  instagramDrafts: 'Instagram',
  textSpellfix: 'Autocorrection',
  relanceEmail: 'Relances',
  driveInventoryAnalysis: 'Inventaire Drive',
  'drive-inventory': 'Inventaire Drive',
  saleReceiptExtraction: 'Lecture de factures',
  bankStatementImport: 'Relevés bancaires',
  connectors: 'Connecteurs',
  workSuggestions: 'Suggestions',
}
export const featureLabel = (f) => FEATURE_LABELS[f] || f || 'Autre'

// Les réponses nomment l'instantané (« gpt-4o-mini-2024-07-18 ») : on garde la famille.
export const normalizeModel = (m) => String(m || 'inconnu').replace(/^models\//, '').replace(/-\d{4}-\d{2}-\d{2}$/, '')

// → { provider, model?, usage: { input, output } } ou null si l'URL n'est pas mesurée.
export function parseAiResponse(url, body) {
  if (/^https:\/\/api\.openai\.com\/v1\/(chat\/completions|responses|embeddings)\b/.test(url)) {
    const u = body?.usage
    if (!u) return null
    return {
      provider: 'openai', model: body.model,
      usage: { input: u.prompt_tokens ?? u.input_tokens ?? 0, output: u.completion_tokens ?? u.output_tokens ?? 0 },
    }
  }
  const g = url.match(/^https:\/\/generativelanguage\.googleapis\.com\/[^/]+\/models\/([^:?]+):generateContent/)
  if (g) {
    const u = body?.usageMetadata
    if (!u) return null
    return {
      provider: 'gemini', model: body.modelVersion || g[1],
      usage: { input: u.promptTokenCount || 0, output: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) },
    }
  }
  return null
}

// Module appelant = premier fichier de services/ ou routes/ dans la pile.
function callerFeature(stack) {
  for (const line of String(stack || '').split('\n').slice(1)) {
    const m = line.match(/\/src\/(?:services|routes)\/([\w.-]+)\.js/)
    if (m && m[1] !== 'aiCostMeter') return m[1]
  }
  return null
}

export function recordAiUsage({ provider, model, feature, input = 0, output = 0 }) {
  db.prepare(`INSERT INTO ai_usage_events (provider, model, feature, input_tokens, output_tokens) VALUES (?,?,?,?,?)`)
    .run(provider, normalizeModel(model), feature || null, Math.round(input) || 0, Math.round(output) || 0)
}

const METERED = /^https:\/\/(api\.openai\.com\/v1\/(chat\/completions|responses|embeddings)|generativelanguage\.googleapis\.com\/)/

export function installAiFetchMeter() {
  if (globalThis.fetch?.__aiMeter) return
  const orig = globalThis.fetch
  const metered = async function (input, init) {
    const url = typeof input === 'string' ? input : input?.url || String(input)
    if (!METERED.test(url)) return orig(input, init)
    const stack = new Error().stack
    const resp = await orig(input, init)
    if (resp.ok) {
      resp.clone().json().then(body => {
        const p = parseAiResponse(url, body)
        if (p) recordAiUsage({ ...p, feature: callerFeature(stack), ...p.usage })
      }).catch(() => {})
    }
    return resp
  }
  metered.__aiMeter = true
  globalThis.fetch = metered
}

const isoDay = (d) => d.toISOString().slice(0, 10)

// Jours UTC, du plus ancien à aujourd'hui inclus.
export function lastDays(n, now = new Date()) {
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return Array.from({ length: n }, (_, i) => isoDay(new Date(end - (n - 1 - i) * 86400_000)))
}

// ── Facture OpenAI (clé admin) : { configured, byDay: { day: [{ item, amount }] } } ──
let billedCache = { at: 0, key: null, start: null, value: null }
const BILLED_TTL_MS = 60 * 60_000

export async function fetchOpenAiBilled(days) {
  const key = process.env.OPENAI_ADMIN_KEY
  if (!key) return { configured: false }
  if (billedCache.key === key && billedCache.start === days[0] && Date.now() - billedCache.at < BILLED_TTL_MS) return billedCache.value
  const byDay = {}
  let page = null
  let value
  try {
    const start = Math.floor(Date.parse(`${days[0]}T00:00:00Z`) / 1000)
    for (let i = 0; i < 10; i++) {
      const qs = new URLSearchParams({ start_time: String(start), bucket_width: '1d', limit: '180' })
      qs.append('group_by', 'line_item')
      if (page) qs.set('page', page)
      const r = await fetch(`https://api.openai.com/v1/organization/costs?${qs}`, { headers: { Authorization: `Bearer ${key}` } })
      const body = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(body?.error?.message || `OpenAI ${r.status}`)
      for (const b of body.data || []) {
        const d = isoDay(new Date(b.start_time * 1000))
        for (const x of b.results || []) {
          const amount = Number(x.amount?.value || 0)
          if (amount) (byDay[d] ||= []).push({ item: x.line_item || null, amount })
        }
      }
      if (!body.has_more || !body.next_page) break
      page = body.next_page
    }
    value = { configured: true, byDay }
  } catch (e) {
    value = { configured: true, error: e.message }
  }
  billedCache = { at: Date.now(), key, start: days[0], value }
  return value
}

// Une ligne de facture OpenAI d'un jour → { feature: montant }.
// usage = [{ feature, model, input, output }] des appels OpenAI mesurés ce jour-là.
export function allocateBilledItem(item, amount, usage) {
  const [name, kind = ''] = String(item || '').split(/,\s*/)
  if (/whisper|transcribe/i.test(name)) return { whisper: amount }
  const model = normalizeModel(name)
  const side = /output/i.test(kind) ? 'output' : 'input'
  const rows = usage.filter(u => u.model === model && u[side] > 0)
  const total = rows.reduce((s, u) => s + u[side], 0)
  if (!item || !total) return { __horsErp: amount }
  const out = {}
  for (const u of rows) out[u.feature] = (out[u.feature] || 0) + amount * u[side] / total
  return out
}

export async function aiCostReport({ days: n = 365, now = new Date() } = {}) {
  const days = lastDays(n, now)
  const from = `${days[0]}T00:00:00Z`

  const rows = db.prepare(`
    SELECT substr(at, 1, 10) AS day, provider, model, feature,
           COUNT(*) AS calls, SUM(input_tokens) AS input, SUM(output_tokens) AS output
    FROM ai_usage_events WHERE at >= ? GROUP BY day, provider, model, feature`).all(from)
  const whisperJobs = db.prepare(`
    SELECT COUNT(*) AS n FROM transcription_jobs WHERE status = 'done' AND completed_at >= ?`).get(from)?.n || 0

  const perDay = Object.fromEntries(days.map(d => [d, 0]))
  const features = {}
  const feat = (key) => {
    const label = key === '__horsErp' ? 'Hors ERP' : featureLabel(key)
    return (features[label] ||= { label, calls: 0, cost: 0, unpriced: 0 })
  }
  const openaiUsage = {}
  for (const r of rows) {
    feat(r.feature).calls += r.calls
    if (r.provider === 'openai') {
      (openaiUsage[r.day] ||= []).push({ feature: r.feature, model: r.model, input: r.input, output: r.output })
      continue
    }
    const p = GEMINI_PRICES[r.model]
    if (!p) { feat(r.feature).unpriced += r.calls; continue }
    const cost = (r.input * p[0] + r.output * p[1]) / 1e6
    feat(r.feature).cost += cost
    if (perDay[r.day] != null) perDay[r.day] += cost
  }
  if (whisperJobs) feat('whisper').calls += whisperJobs

  const billing = await fetchOpenAiBilled(days)
  for (const [day, items] of Object.entries(billing.byDay || {})) {
    if (perDay[day] == null) continue
    for (const { item, amount } of items) {
      for (const [f, v] of Object.entries(allocateBilledItem(item, amount, openaiUsage[day] || []))) feat(f).cost += v
      perDay[day] += amount
    }
  }

  return {
    currency: 'USD',
    days: days.map(d => ({ date: d, cost: perDay[d] })),
    total: days.reduce((s, d) => s + perDay[d], 0),
    billing: { configured: billing.configured, error: billing.error || null },
    features: Object.values(features).filter(f => f.cost > 0 || f.calls > 0).sort((a, b) => b.cost - a.cost || b.calls - a.calls),
  }
}
