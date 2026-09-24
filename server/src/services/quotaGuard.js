// ─── Garde-fou de quota : la file s'arrête AVANT le mur ───────────────────────
//
// Le runner sait déjà réagir à un plafond ATTEINT (message « session limit » → pause
// jusqu'à la réinitialisation, voir taskRunner.js). Le problème est ce qui se passe
// juste avant : les dernières miettes de quota partent dans des chantiers lancés au
// hasard des files, et il ne reste plus rien pour les questions du moment ni pour un
// travail urgent — alors que la file, elle, aurait très bien pu attendre.
//
// D'où ce garde-fou : dès qu'un plafond DE COMPTE descend sous 30 % de marge
// restante, toute la file passe en pause (rien de nouveau ne démarre, l'exécution en
// cours va au bout), et elle repart toute seule quand le quota remonte au-dessus du
// seuil (réinitialisation de la fenêtre de 5 h ou de la semaine).
//
// 30 % n'est qu'un DÉFAUT, et le seuil se règle dans le bandeau « Quotas Claude » de
// la page Travaux — UN SEUIL PAR PLAFOND : la fenêtre de 5 h se rouvre en quelques
// heures (on peut la laisser descendre bas), la semaine met des jours (on veut y
// garder plus de marge). Clés `quotaFloorSessionPct` et `quotaFloorWeekPct`
// d'agent-settings.json ; l'ancienne clé unique `quotaFloorPct` sert encore de valeur
// de repli pour les deux, le temps que chacune soit réglée.
//
// Deux plafonds seulement sont regardés — la fenêtre glissante de 5 h et le total
// hebdomadaire, les deux qui arrêtent VRAIMENT tout. Le plafond hebdomadaire d'un
// modèle (ex. Fable) est volontairement ignoré : il a son repli automatique, le
// travail continue sur l'autre modèle (voir agentModel.js).
//
// Reprise à la main pendant la pénurie : elle gagne. Le garde-fou se met en sourdine
// et ne repose pas sa pause — il ne redeviendra actif qu'après un retour au-dessus du
// seuil. Sans ça, « Reprendre la file » aurait été annulé deux minutes plus tard.
import { getClaudeUsage } from './claudeUsage.js'
import { getSettings, setSettings } from './taskRunner.js'
import { pauseQueue, resumeQueue } from './promptQueue.js'

/** Marge restante (en %) sous laquelle la file entière est mise en pause — défaut. */
export const QUOTA_FLOOR_PCT = 30
/** Seuils proposés par les sélecteurs du bandeau (0 = garde-fou désarmé). */
export const QUOTA_FLOOR_CHOICES = [0, 5, 10, 20, 30, 40, 50, 60]
/** Les deux plafonds réglables, et la clé de réglage de chacun. */
export const QUOTA_FLOOR_KEYS = { session: 'quotaFloorSessionPct', week: 'quotaFloorWeekPct' }

function normFloor(v) {
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return Math.max(0, Math.min(90, Math.round(n)))
}

/**
 * Seuils effectifs, un par plafond : { session, week }. Réglage propre au plafond,
 * sinon l'ancien seuil unique (installations antérieures), sinon le défaut.
 */
export function getQuotaFloors() {
  const s = getSettings()
  const legacy = normFloor(s.quotaFloorPct)
  const fallback = legacy == null ? QUOTA_FLOOR_PCT : legacy
  return {
    session: normFloor(s.quotaFloorSessionPct) ?? fallback,
    week: normFloor(s.quotaFloorWeekPct) ?? fallback,
  }
}

const CHECK_EVERY_MS = 2 * 60_000   // la lecture est cachée 5 min côté claudeUsage
const FIRST_CHECK_MS = 30_000       // laisse le serveur finir de démarrer

/**
 * Le plafond de compte le plus serré PAR RAPPORT À SON PROPRE SEUIL :
 * { remaining, floor, label, resetsAt }, ou null si aucun pourcentage n'est lisible
 * (abonnement injoignable → on ne décide rien).
 *
 * Chaque plafond ayant maintenant son seuil, « le plus serré » ne peut plus être la
 * plus petite marge : 5 % de marge sous un seuil de 0 % ne coupe rien, alors que 25 %
 * sous un seuil de 40 % coupe. On compare donc l'écart au seuil (`remaining − floor`),
 * dont le minimum est négatif exactement quand un plafond est franchi.
 */
export function tightestBucket(usage, floors = getQuotaFloors()) {
  const buckets = [
    ['fenêtre 5 h', usage?.session, floors.session],
    ['semaine', usage?.week, floors.week],
  ]
  let worst = null
  for (const [label, b, floor] of buckets) {
    // `Number.isFinite` sur la valeur BRUTE : un plafond sans pourcentage vaut null,
    // et `Number(null)` donnerait 0 — c'est-à-dire « 100 % de marge », l'inverse de la
    // vérité (on lèverait la pause au moment où l'on ne sait plus rien).
    const pct = b?.utilizationPct
    if (!Number.isFinite(pct)) continue
    const remaining = Math.max(0, Math.min(100, 100 - pct))
    const f = normFloor(floor) ?? QUOTA_FLOOR_PCT
    if (!worst || remaining - f < worst.remaining - worst.floor) {
      worst = { remaining, floor: f, label, resetsAt: b?.resetsAt || null }
    }
  }
  return worst
}

/**
 * Décision pure (donc testable) du garde-fou.
 *   `remaining` — marge du plafond le plus serré, ou null si illisible ;
 *   `paused`    — la file est-elle en pause en ce moment (peu importe qui l'a posée) ;
 *   `active`    — la pause en cours est-elle CELLE du garde-fou ;
 *   `muted`     — garde-fou en sourdine (l'utilisateur a repris la file malgré tout).
 * Retourne l'action à exécuter et l'état à persister.
 */
export function decideQuotaGuard({ remaining, paused, active, muted, floor = QUOTA_FLOOR_PCT }) {
  if (remaining == null) return { action: null, active: !!active, muted: !!muted }
  let nextActive = !!active
  let nextMuted = !!muted
  // Notre pause a disparu sans qu'on y touche : quelqu'un a repris la file à la main.
  if (nextActive && !paused) { nextActive = false; nextMuted = true }

  if (remaining < floor) {
    if (paused || nextMuted) return { action: null, active: nextActive, muted: nextMuted }
    return { action: 'pause', active: true, muted: nextMuted }
  }
  // Quota revenu au-dessus du seuil : la sourdine expire, et la pause posée par le
  // garde-fou se lève d'elle-même (une pause posée à la main, jamais).
  nextMuted = false
  if (paused && nextActive) return { action: 'resume', active: false, muted: nextMuted }
  return { action: null, active: nextActive, muted: nextMuted }
}

let _notified = false

/** Un seul avis Slack par pause de quota — la reprise réarme le suivant. */
async function notifyPause(worst, floor) {
  if (_notified) return
  _notified = true
  const url = process.env.SLACK_WEBHOOK_PERSO
  if (!url) return
  const text = `:battery: *File de travaux en pause* — quota Claude sous ${floor} % ` +
    `(reste ${worst.remaining} % · ${worst.label}). Reprise automatique dès qu'il remonte.`
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
  } catch (e) { console.error('🤖 Garde-fou de quota: avis Slack non envoyé —', e.message) }
}

/** Un passage du garde-fou. Retourne l'action posée ('pause' | 'resume' | null). */
export async function syncQuotaGuard() {
  let usage
  try { usage = await getClaudeUsage() } catch { return null }
  // Lecture des quotas indisponible : surtout ne POSER aucune pause sur un chiffre
  // absent. En revanche, une pause déjà posée par le garde-fou doit pouvoir se lever :
  // l'heure de réinitialisation notée au moment de la pause est un horodatage absolu,
  // elle reste juste même sans nouvelle lecture. Sans cette porte de sortie, une série
  // d'échecs de lecture immobilisait la file jusqu'à une intervention à la main.
  if (!usage?.subscriptionAvailable) {
    const s = getSettings()
    const resetAt = Date.parse(s.quotaPauseResetAt || '') || 0
    if (s.quotaPauseActive && s.queuePaused && resetAt && resetAt <= Date.now()) {
      setSettings({ quotaPauseActive: false, quotaPauseMuted: false, quotaPauseResetAt: null })
      _notified = false
      resumeQueue()
      console.warn('🤖 Garde-fou de quota: quotas illisibles mais fenêtre réinitialisée — file reprise')
      return 'resume'
    }
    return null
  }

  const s = getSettings()
  const worst = tightestBucket(usage, getQuotaFloors())
  // Le seuil qui décide est celui du plafond retenu : la fenêtre de 5 h et la semaine
  // n'ont plus la même exigence.
  const floor = worst ? worst.floor : QUOTA_FLOOR_PCT
  const before = { active: !!s.quotaPauseActive, muted: !!s.quotaPauseMuted }
  const out = decideQuotaGuard({
    remaining: worst ? worst.remaining : null,
    paused: !!s.queuePaused,
    floor,
    ...before,
  })
  if (out.active !== before.active || out.muted !== before.muted) {
    // On garde l'heure de réinitialisation du plafond qui motive la pause : c'est
    // elle qui permettra de reprendre même si les quotas deviennent illisibles.
    setSettings({
      quotaPauseActive: out.active,
      quotaPauseMuted: out.muted,
      quotaPauseResetAt: out.active ? (worst?.resetsAt || null) : null,
    })
  }

  if (out.action === 'pause') {
    pauseQueue({
      quotaGuard: true,
      reason: `Quota Claude sous ${floor} % (reste ${worst.remaining} % — ${worst.label}) : `
        + 'la file repartira toute seule dès que le quota remonte.',
    })
    console.warn(`🤖 Garde-fou de quota: reste ${worst.remaining} % (seuil ${floor} %, ${worst.label}) — file en pause`)
    notifyPause(worst, floor).catch(() => {})
  } else if (out.action === 'resume') {
    _notified = false
    resumeQueue()
    console.log(`🤖 Garde-fou de quota: quota remonté (reste ${worst.remaining} %) — file reprise`)
  }
  return out.action
}

/** Démarre la surveillance (appelé au boot, après la file). */
export function startQuotaGuard() {
  const tick = () => { syncQuotaGuard().catch(e => console.error('🤖 Garde-fou de quota —', e.message)) }
  setTimeout(tick, FIRST_CHECK_MS).unref?.()
  setInterval(tick, CHECK_EVERY_MS).unref?.()
}
