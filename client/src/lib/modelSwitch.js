// Choix automatique du modèle par défaut de la modale « Modifier le système » :
// Opus (abonnement Claude) ou Astra (abonnement Codex), selon celui qui a le plus
// de marge sur ses deux plafonds — fenêtre de 5 h et semaine.
//
// Marge d'un plafond = part restante ÷ part de temps restante avant sa
// réinitialisation. 1 = on consomme exactement au rythme ; > 1 = du quota qui sera
// perdu si on ne s'en sert pas ; < 1 = on va manquer avant la fin. La marge d'un
// abonnement est celle de son plafond le plus serré. Un plafond (quasi) épuisé
// vaut 0. Chiffres illisibles → marge neutre (1) ; à égalité, Astra reste le défaut.
// Exécution des tests : `node --test client/src/lib/modelSwitch.test.js`

const H5 = 5 * 60
const WEEK = 7 * 24 * 60
const EXHAUSTED_PCT = 97
const MIN_TIME_FRACTION = 0.02
const TIE = 1.1 // Opus doit faire au moins 10 % mieux pour déloger Astra

export function windowSlack({ utilizationPct, resetsAt } = {}, windowMins, now = Date.now()) {
  if (!Number.isFinite(utilizationPct)) return null
  if (utilizationPct >= EXHAUSTED_PCT) return 0
  const remaining = (100 - utilizationPct) / 100
  const reset = resetsAt ? new Date(resetsAt).getTime() : NaN
  // Pas d'heure de réinitialisation : fenêtre pas encore entamée → tout le temps devant.
  const timeLeft = Number.isFinite(reset) ? (reset - now) / (windowMins * 60000) : 1
  return remaining / Math.min(1, Math.max(MIN_TIME_FRACTION, timeLeft))
}

function tightest(slacks) {
  const known = slacks.filter(s => s != null)
  return known.length ? Math.min(...known) : null
}

export function claudeSlack(usage, now = Date.now()) {
  if (!usage?.subscriptionAvailable) return null
  const scoped = usage.weekScoped && /opus/i.test(usage.weekScoped.label || '') ? usage.weekScoped : null
  return tightest([
    windowSlack(usage.session, H5, now),
    windowSlack(usage.week, WEEK, now),
    scoped && windowSlack(scoped, WEEK, now),
  ])
}

export function codexSlack(codex, now = Date.now()) {
  if (!codex?.available) return null
  return tightest((codex.windows || []).map(w =>
    windowSlack(w, w.key === 'secondary' || w.label === 'Semaine' ? WEEK : H5, now)))
}

/** 'opus' | 'codex', avec les marges qui ont décidé (null = illisible). */
export function pickDefaultModel(usage, now = Date.now()) {
  const opus = claudeSlack(usage, now)
  const codex = codexSlack(usage?.codex, now)
  const model = (opus ?? 1) > (codex ?? 1) * TIE ? 'opus' : 'codex'
  return { model, opus, codex }
}
