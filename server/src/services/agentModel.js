// ─── Modèle de l'agent autonome + registre des quotas épuisés ──────────────────
//
// Tout tourne sur Opus 5.5 (décision de Charles, 2026-09-30 : Fable et son repli
// automatique sont retirés). Le registre ci-dessous garde, PAR MODÈLE, les quotas
// épuisés signalés par une exécution (`rate_limit_event`) : une tâche n'attend que
// si le modèle qu'elle doit utiliser est à sec, l'ordonnanceur repart à la réinit.

import { getClaudeUsage } from './claudeUsage.js'

/** Modèle préféré par défaut — tout ce qui n'est pas explicitement bridé passe par lui. */
export const AGENT_MODEL = 'opus'

/** Modèles que l'agent sait utiliser (un plafond de COMPTE les bloque tous). */
export const CLAUDE_MODELS = Object.freeze(['opus', 'sonnet', 'haiku'])
export const KNOWN_MODELS = CLAUDE_MODELS

// ─── Modèle préféré courant — choisi par l'utilisateur depuis le bandeau quotas ─
// Persisté dans agent-settings.json (clé `preferredModel`) ; taskRunner le recharge
// au démarrage et le pousse ici à chaque changement. Un changement s'applique dès la
// PROCHAINE exécution (celle en cours garde le modèle résolu à son lancement).
let _preferred = AGENT_MODEL

export function preferredAgentModel() { return _preferred }

/** Change le modèle préféré ; une valeur inconnue est ignorée (on garde l'actuel). */
export function setPreferredAgentModel(model) {
  if (KNOWN_MODELS.includes(model)) _preferred = model
  return _preferred
}

// modèle → { resetAt: epoch ms, label: '01:59 UTC', source: 'run' | 'usage' }
const _limits = new Map()

/** Modèle retiré (ex. « fable » inscrit sur une vieille tâche) → le préféré. */
export function normalizeModel(model = preferredAgentModel()) {
  return KNOWN_MODELS.includes(model) ? model : preferredAgentModel()
}

/** Purge les quotas dont l'heure de réinitialisation est passée. Renvoie true si ça a bougé. */
export function purgeExpiredLimits(now = Date.now()) {
  let changed = false
  for (const [model, entry] of _limits) {
    if (!entry?.resetAt || entry.resetAt <= now) { _limits.delete(model); changed = true }
  }
  return changed
}

export function isModelLimited(model, now = Date.now()) {
  const entry = _limits.get(model)
  if (!entry) return false
  if (entry.resetAt <= now) { _limits.delete(model); return false }
  return true
}

/** Modèle utilisable pour ce travail ; `null` = son quota est épuisé → rien ne démarre. */
export function resolveModel(model = preferredAgentModel(), now = Date.now()) {
  const m = normalizeModel(model)
  return isModelLimited(m, now) ? null : m
}

/** Instant où ce modèle redevient utilisable — 0 s'il l'est déjà (« pause forcée » de l'UI). */
export function chainAvailableAt(model = preferredAgentModel(), now = Date.now()) {
  const m = normalizeModel(model)
  return isModelLimited(m, now) ? _limits.get(m).resetAt : 0
}

/** Prochaine réinitialisation connue, tous modèles confondus (0 = aucun quota épuisé). */
export function nextLimitExpiryAt() {
  let at = 0
  for (const entry of _limits.values()) {
    if (!entry?.resetAt) continue
    if (!at || entry.resetAt < at) at = entry.resetAt
  }
  return at
}

/**
 * Marque un (ou plusieurs) modèle(s) sans quota jusqu'à `resetAt`. Une marque plus
 * lointaine ne recule jamais : deux signaux pour la même fenêtre ne se contredisent pas.
 */
export function noteModelLimit(models, { resetAt, label = '', source = 'run' } = {}, now = Date.now()) {
  const safe = resetAt > now ? resetAt : now + 15 * 60_000
  let changed = false
  for (const model of [].concat(models)) {
    if (!model) continue
    const prev = _limits.get(model)
    if (prev && prev.resetAt >= safe) continue
    _limits.set(model, { resetAt: safe, label: label || '', source })
    changed = true
  }
  return changed
}

/** Lève la marque d'un modèle (quota revenu, ou attribution corrigée par les quotas réels). */
export function clearModelLimit(model) {
  return _limits.delete(model)
}

/** Vide le registre — réservé aux tests. */
export function resetModelLimits() { _limits.clear() }

/** État lisible pour l'UI : modèle préféré, modèle actif, quotas épuisés. */
export function agentModelState(model = preferredAgentModel(), now = Date.now()) {
  return {
    preferred: model,
    active: resolveModel(model, now),         // null = quota épuisé
    models: [...KNOWN_MODELS],                // choix offerts au sélecteur de l'UI
    limited: [..._limits.entries()].map(([m, e]) => ({
      model: m,
      resetAt: new Date(e.resetAt).toISOString(),
      source: e.source,
    })),
  }
}

// ─── Attribution d'un refus : plafond du modèle, ou plafond du compte ? ────────
//
// Le `rate_limit_event` du transcript ne dit PAS quel plafond a sauté. Les quotas de
// l'abonnement, eux, le disent : fenêtre de 5 h ou total hebdomadaire à 100 % →
// plafond de compte, aucun modèle ne passera. Sinon, seul le modèle utilisé est marqué
// (les tâches sur un autre modèle continuent). Quotas illisibles → 'model'.
export function attributeLimitScope(usage) {
  const pct = b => (Number.isFinite(b?.utilizationPct) ? b.utilizationPct : null)
  const exhausted = v => v != null && v >= 100
  if (!usage) return 'model'
  // Crédits de dépassement actifs = le plafond n'arrête rien ; on ne conclut pas au
  // blocage de compte sur cette seule base.
  if (usage.extraUsageEnabled) return 'model'
  if (exhausted(pct(usage.session)) || exhausted(pct(usage.week))) return 'account'
  return 'model'
}

export async function fetchLimitScope(accountId = null) {
  try { return attributeLimitScope(await getClaudeUsage({ allowStale: false, accountId })) } catch { return 'model' }
}
