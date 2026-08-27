// ─── Modèle de l'agent autonome + repli quand SON quota est épuisé ─────────────
//
// L'agent tourne sur `fable` (le modèle le plus capable de l'abonnement). Or
// l'abonnement porte un plafond hebdomadaire PROPRE à ce modèle — la limite
// `weekly_scoped` de /api/oauth/usage, cf. claudeUsage.js : Fable peut refuser de
// travailler alors que la fenêtre de 5 h et le total hebdomadaire (tous modèles) sont
// encore au vert. Avant, ce refus mettait toute la file en pause pendant des jours,
// jusqu'à la réinitialisation hebdomadaire.
//
// Ce module tient donc un registre des quotas épuisés PAR MODÈLE et résout, à chaque
// démarrage d'exécution, le modèle réellement utilisable :
//
//     fable épuisé  →  opus  (le travail continue)
//     les deux épuisés  →  plus rien ne démarre, l'ordonnanceur attend la réinit.
//
// Deux sources alimentent le registre :
//   1. RÉACTIVE  — une exécution s'est heurtée au mur (`rate_limit_event` dans son
//      transcript). On demande alors aux quotas de l'abonnement si c'est le plafond
//      DU MODÈLE (→ repli) ou un plafond de compte (→ tout est bloqué, on attend).
//   2. PROACTIVE — lecture périodique des quotas : quand le plafond Fable est déjà à
//      100 %, on bascule sur Opus AVANT de brûler une exécution dans le mur.
//
// Volontairement sans état persistant : un redémarrage relit les quotas (source 2) en
// quelques secondes, et une mauvaise attribution s'auto-corrige au passage suivant.

import { getClaudeUsage } from './claudeUsage.js'

/** Modèle préféré par défaut — tout ce qui n'est pas explicitement bridé passe par lui. */
export const AGENT_MODEL = 'fable'

/** Chaîne de repli : modèle → modèle à emprunter quand son quota est épuisé. */
export const MODEL_FALLBACK = Object.freeze({ fable: 'opus' })

/** Modèles que l'agent sait utiliser (un plafond de COMPTE les bloque tous). */
export const KNOWN_MODELS = Object.freeze(['fable', 'opus', 'sonnet', 'haiku'])

// ─── Modèle préféré courant — choisi par l'utilisateur depuis le bandeau quotas ─
// Persisté dans agent-settings.json (clé `preferredModel`) ; taskRunner le recharge
// au démarrage et le pousse ici à chaque changement. Toutes les fonctions ci-dessous
// prennent ce modèle comme défaut, donc un changement s'applique dès la PROCHAINE
// exécution (celle en cours garde le modèle résolu à son lancement).
let _preferred = AGENT_MODEL

export function preferredAgentModel() { return _preferred }

/** Change le modèle préféré ; une valeur inconnue est ignorée (on garde l'actuel). */
export function setPreferredAgentModel(model) {
  if (KNOWN_MODELS.includes(model)) _preferred = model
  return _preferred
}

// modèle → { resetAt: epoch ms, label: '01:59 UTC', source: 'run' | 'usage' }
const _limits = new Map()

/** Modèles empruntables pour ce travail, du préféré au dernier repli. */
export function modelChain(model = preferredAgentModel()) {
  const chain = []
  let m = model || preferredAgentModel()
  while (m && !chain.includes(m)) {
    chain.push(m)
    m = MODEL_FALLBACK[m]
  }
  return chain
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

/**
 * Modèle réellement utilisable pour ce travail : le préféré s'il a encore du quota,
 * sinon son repli. `null` = toute la chaîne est à sec → rien ne peut démarrer.
 */
export function resolveModel(model = preferredAgentModel(), now = Date.now()) {
  for (const m of modelChain(model)) if (!isModelLimited(m, now)) return m
  return null
}

/**
 * Instant où cette chaîne redevient utilisable — 0 si elle l'est déjà. C'est ce que
 * l'ordonnanceur affiche comme « pause forcée » : tant que le repli tient, la file
 * n'est PAS à l'arrêt et on ne raconte donc pas qu'elle l'est.
 */
export function chainAvailableAt(model = preferredAgentModel(), now = Date.now()) {
  const chain = modelChain(model)
  if (chain.some(m => !isModelLimited(m, now))) return 0
  return Math.min(...chain.map(m => _limits.get(m)?.resetAt || 0))
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

/** État lisible pour l'UI : modèle préféré, modèle réellement actif, quotas épuisés. */
export function agentModelState(model = preferredAgentModel(), now = Date.now()) {
  const active = resolveModel(model, now)
  const preferredEntry = _limits.get(model)
  return {
    preferred: model,
    active,                                   // null = toute la chaîne est à sec
    fallback: MODEL_FALLBACK[model] || null,
    fallbackActive: !!active && active !== model,
    models: [...KNOWN_MODELS],                // choix offerts au sélecteur de l'UI
    preferredResetAt: preferredEntry ? new Date(preferredEntry.resetAt).toISOString() : null,
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
// l'abonnement, eux, le disent : si la fenêtre de 5 h ou le total hebdomadaire est à
// 100 %, aucun modèle ne passera — inutile de tenter le repli. Sinon, le refus vient
// du plafond propre au modèle et le repli a toutes ses chances.
//
// Quotas illisibles (token expiré, hors-ligne) → on privilégie la CONTINUITÉ : on
// tente le repli. S'il se heurte au même mur, sa propre marque épuise la chaîne et
// l'ordonnanceur s'arrête au tour suivant — un aller-retour perdu, pas une file morte.
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

export async function fetchLimitScope() {
  try { return attributeLimitScope(await getClaudeUsage()) } catch { return 'model' }
}

// ─── Lecture proactive du plafond par modèle ───────────────────────────────────

/**
 * Traduit la limite `weekly_scoped` des quotas en verdict sur UN modèle.
 * `null` = les quotas ne disent rien d'exploitable (pas de plafond par modèle, libellé
 * inconnu, crédits de dépassement actifs).
 */
export function scopedLimitFromUsage(usage, now = Date.now()) {
  const scoped = usage?.weekScoped
  if (!scoped || usage.extraUsageEnabled) return null
  const label = String(scoped.label || '').toLowerCase()
  const model = KNOWN_MODELS.find(m => label.includes(m))
  if (!model) return null
  const pct = Number.isFinite(scoped.utilizationPct) ? scoped.utilizationPct : null
  const resetAt = Date.parse(scoped.resetsAt || '') || 0
  if (pct == null || pct < 100 || !resetAt || resetAt <= now) return { model, limited: false }
  return {
    model,
    limited: true,
    resetAt,
    label: new Date(resetAt).toISOString().slice(11, 16) + ' UTC',
  }
}

/**
 * Aligne le registre sur les quotas réels de l'abonnement. Renvoie true si l'état a
 * changé (l'ordonnanceur en profite pour relancer la file).
 *
 * Le nettoyage compte autant que la pose : quand les quotas montrent le plafond du
 * modèle au vert ET aucun plafond de compte atteint, une marque qui traîne (refus
 * ponctuel attribué au modèle par défaut) est fausse — on la lève, sinon l'agent
 * resterait sur son repli pendant des heures sans raison.
 */
export async function syncScopedModelLimit() {
  let usage
  try { usage = await getClaudeUsage() } catch { return false }
  const verdict = scopedLimitFromUsage(usage)
  if (!verdict) return purgeExpiredLimits()
  if (verdict.limited) {
    return noteModelLimit([verdict.model], {
      resetAt: verdict.resetAt, label: verdict.label, source: 'usage',
    })
  }
  const accountBlocked = attributeLimitScope(usage) === 'account'
  if (!accountBlocked && _limits.has(verdict.model)) return clearModelLimit(verdict.model)
  return purgeExpiredLimits()
}
