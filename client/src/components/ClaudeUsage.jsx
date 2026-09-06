// ─── Utilisation Claude — affichages partagés ─────────────────────────────────
// L'agent tourne sur l'abonnement Claude Code (forfait fixe) : on affiche donc
// l'utilisation RÉELLE de l'abonnement — le % de chaque plafond consommé, avec son
// heure de réinitialisation — plutôt qu'une estimation de coût en dollars qui
// n'aurait aucun sens sur un forfait. Aucun compteur de jetons : il a été retiré
// (il ressemblait à un quota journalier qui n'existe pas).
//
// LES TROIS PLAFONDS, ET CE QU'ILS NE SONT PAS (vérifié le 2026-08-04 sur la réponse
// de l'endpoint /api/oauth/usage, cf. server/src/services/claudeUsage.js) :
//   • Fenêtre de 5 h — GLISSANTE : elle s'ouvre au premier message et se referme 5 h
//     plus tard ; la suivante s'ouvre à l'échange suivant. Ce n'est pas un créneau
//     fixe de la journée, et l'heure de réinitialisation change donc d'un bloc à
//     l'autre. C'est le plafond qui coupe le plus souvent.
//   • Semaine — total sur 7 jours, tous modèles, réinitialisé à date et heure fixes.
//   • Semaine d'un modèle — plafond hebdomadaire propre à un modèle (ex. « Fable ») :
//     il peut être atteint alors que les deux autres jauges paraissent au vert.
//   • Il n'existe AUCUNE limite de 24 h.
//
// Une seule source (`GET /api/agent/usage`), deux affichages voisins :
//   • <ClaudeUsageStrip/> — une ligne discrète mais lisible (haut de Travaux) : ce
//     qu'on MESURE, rien d'autre.
//   • <ClaudeModelControl/> — le choix du modèle de l'agent, à côté du bandeau et
//     non dedans : c'est une commande, sa place est avec Pause et Réglages.
import { useState, useEffect, useRef, useSyncExternalStore } from 'react'
import { Sparkles, Gauge, CalendarDays, Loader2, Cpu, AlertTriangle, Bot, ChevronDown, Check } from 'lucide-react'
import api from '../lib/api.js'
import { useToast } from './ui/ToastProvider.jsx'

// « Réinit. dans 3 h 12 » à partir d'un timestamp ISO de réinitialisation.
export function formatResetIn(iso) {
  if (!iso) return null
  const ms = Date.parse(iso) - Date.now()
  if (!Number.isFinite(ms) || ms <= 0) return null
  const totalMin = Math.round(ms / 60000)
  const days = Math.floor(totalMin / 1440)
  const hours = Math.floor((totalMin % 1440) / 60)
  const mins = totalMin % 60
  if (days >= 1) return `réinit. dans ${days} j ${hours} h`
  if (hours >= 1) return `réinit. dans ${hours} h ${mins} min`
  return `réinit. dans ${mins} min`
}

// Heure de réinitialisation en clair, fuseau du navigateur : « jeu. 21:59 ». Le
// relatif seul (« dans 2 j 8 h ») ne permet pas de planifier sa semaine — et le jour
// compte : la remise à zéro hebdomadaire tombe un soir de semaine précis.
// Format 24 h HH:MM comme partout ailleurs dans l'app (cf. lib/formatDate.js).
export function formatResetAt(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const weekday = d.toLocaleDateString('fr-CA', { weekday: 'short' })
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  return `${weekday} ${hm}`
}

// « il y a 4 min » — âge d'une lecture de quotas récupérée du cache.
export function formatAgo(iso) {
  if (!iso) return null
  const ms = Date.now() - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 0) return 'à l\'instant'
  const min = Math.round(ms / 60000)
  if (min < 1) return 'moins d\'une minute'
  if (min < 60) return `${min} min`
  return `${Math.floor(min / 60)} h ${min % 60} min`
}

// Date + heure complètes, pour les infobulles (aucune ambiguïté de jour ni de fuseau).
export function formatResetFull(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString('fr-CA', { dateStyle: 'full', timeStyle: 'short' })
}

// ─── Modèle de travail de l'agent ─────────────────────────────────────────────
// L'agent travaille sur le modèle préféré (Fable par défaut) — CHANGEABLE ici même :
// le nom est un bouton qui ouvre le choix des modèles, sauvegardé aussitôt
// (agent-settings.json, clé preferredModel). Le plafond hebdomadaire du modèle
// préféré peut être épuisé alors que les autres jauges sont au vert : dans ce cas
// l'agent continue sur le repli et revient au préféré à la réinitialisation.
const MODEL_LABELS = { fable: 'Fable', opus: 'Opus', sonnet: 'Sonnet', haiku: 'Haiku' }
export function modelLabel(m) { return MODEL_LABELS[m] || m || '—' }

/**
 * « Fable ▾ » — sur quoi l'agent tourne, cliquable pour changer de modèle.
 * Contrôle autonome, posé À CÔTÉ du bandeau de quotas (pas dedans) : choisir le
 * modèle est une commande, pas une mesure — sa place est avec Pause et Réglages.
 */
export function ClaudeModelControl({ className = '' }) {
  const { usage } = useClaudeUsage()
  const state = usage?.agentModel
  const toast = useToast()
  const [open, setOpen] = useState(false)
  // Choix optimiste : affiché tout de suite, effacé quand le poll suivant le confirme.
  const [pending, setPending] = useState(null)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false) }
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const serverPreferred = state?.preferred
  useEffect(() => {
    if (pending && serverPreferred === pending) setPending(null)
  }, [pending, serverPreferred])

  if (!state?.preferred) return null
  const { active, preferredResetAt } = state
  const preferred = pending || state.preferred
  const models = Array.isArray(state.models) && state.models.length ? state.models : Object.keys(MODEL_LABELS)
  // Un choix en attente masque l'état de repli du serveur (il porte sur l'ancien préféré).
  const fallbackActive = !pending && state.fallbackActive
  const shown = pending || active || state.preferred
  const hint = (fallbackActive
    ? `Plafond hebdomadaire ${modelLabel(state.preferred)} épuisé : l'agent travaille sur ${modelLabel(active)}. `
      + `Retour à ${modelLabel(state.preferred)} ${formatResetIn(preferredResetAt) || 'à la réinitialisation'}.`
    : active || pending
      ? `L'agent travaille sur ${modelLabel(shown)}. Si son plafond hebdomadaire s'épuise, il continue automatiquement sur le modèle de repli.`
      : 'Tous les modèles sont au plafond : la file attend la réinitialisation.')
    + ' Cliquer pour changer de modèle.'

  async function choose(m) {
    setOpen(false)
    if (m === preferred) return
    setPending(m)
    try {
      await api.agent.saveSettings({ preferredModel: m })
      fetchUsage()   // confirme le choix tout de suite, sans attendre le poll suivant
    } catch {
      setPending(null)
      toast?.addToast?.({ message: 'Impossible de changer le modèle de l\'agent — réessayez.', type: 'error' })
    }
  }

  return (
    <div className={`relative shrink-0 ${className}`} data-testid="usage-strip-model" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border shrink-0 ${
          fallbackActive
            ? 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100'
            : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
        }`}
        data-testid="usage-strip-model-name"
        title={hint}
      >
        <Bot size={14} className={fallbackActive ? 'text-amber-500' : 'text-slate-400'} />
        {modelLabel(shown)}{fallbackActive ? ' (repli)' : ''}
        <ChevronDown size={12} className={`shrink-0 ${fallbackActive ? 'text-amber-500' : 'text-slate-400'}`} />
      </button>
      {open && (
        <div
          className="absolute right-0 top-full mt-1.5 z-30 w-48 rounded-lg border border-slate-200 bg-white shadow-lg py-1"
          data-testid="usage-strip-model-menu"
        >
          <p className="px-3 pt-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            Modèle de l'agent
          </p>
          {models.map(m => (
            <button
              key={m}
              type="button"
              onClick={() => choose(m)}
              className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 text-xs text-left hover:bg-slate-50 ${m === preferred ? 'text-brand-600 font-semibold' : 'text-slate-700'}`}
              data-testid={`usage-strip-model-option-${m}`}
            >
              {modelLabel(m)}
              {m === preferred && <Check size={12} className="shrink-0" />}
            </button>
          ))}
          <p className="px-3 pt-1.5 pb-1 text-[10px] leading-snug text-slate-400 border-t border-slate-100 mt-1">
            S'applique aux prochaines exécutions ; celle en cours garde son modèle.
          </p>
        </div>
      )}
    </div>
  )
}

// Couleur de la jauge selon le niveau de consommation. `severity` est le niveau
// d'alerte donné par Anthropic lui-même : quand il sort de « normal », il prime sur
// notre seuil en pourcentage (c'est lui qui connaît la vraie marge restante).
export function usageTone(pct, severity = null) {
  if (severity && severity !== 'normal') return { bar: 'bg-rose-500', text: 'text-rose-600' }
  if (pct >= 90) return { bar: 'bg-rose-500', text: 'text-rose-600' }
  if (pct >= 70) return { bar: 'bg-amber-500', text: 'text-amber-600' }
  return { bar: 'bg-brand-500', text: 'text-slate-900' }
}

// ─── Lecture des quotas : affichée tout de suite, rafraîchie derrière ──────────
// Les jauges mettaient quelques secondes à apparaître : chaque arrivée sur la page
// repartait de zéro (bandeau vide + roue) le temps d'un aller-retour qui, serveur
// occupé, pouvait traîner. Trois choses le règlent :
//   • la dernière lecture connue est gardée dans le navigateur et réaffichée au
//     premier rendu — plus de bandeau vide ; les chiffres frais la remplacent dès
//     qu'ils arrivent (les heures de réinitialisation, elles, ne périment pas) ;
//   • un seul état partagé par tous les montages : changer de page ne relance pas
//     une lecture, et deux bandeaux à l'écran n'en font qu'une ;
//   • onglet en arrière-plan → on cesse d'interroger, et on rattrape au retour.
const STORE_KEY = 'erp:claude-usage'
const HYDRATE_MAX_AGE_MS = 30 * 60 * 1000  // au-delà, mieux vaut la roue qu'un chiffre faux
const POLL_MS = 30_000

function readStored() {
  try {
    const { at, data } = JSON.parse(localStorage.getItem(STORE_KEY) || 'null') || {}
    if (!at || !data || Date.now() - at > HYDRATE_MAX_AGE_MS) return null
    return data
  } catch { return null }
}

let _usage = readStored()   // dernière valeur connue (mémoire + relais localStorage)
let _error = false          // vrai seulement si on n'a RIEN à montrer
let _inflight = null
let _timer = null
const _subs = new Set()

function emit() { for (const fn of _subs) fn() }

function fetchUsage() {
  if (_inflight) return _inflight
  _inflight = api.agent.getUsage()
    .then(u => {
      _usage = u
      _error = false
      try { localStorage.setItem(STORE_KEY, JSON.stringify({ at: Date.now(), data: u })) } catch {}
      emit()
    })
    .catch(() => {
      // Une lecture ratée n'efface pas ce qui est affiché : on ne se retire que si
      // l'on n'a jamais rien eu.
      if (!_usage) { _error = true; emit() }
    })
    .finally(() => { _inflight = null })
  return _inflight
}

function startPolling() {
  if (_timer) return
  _timer = setInterval(() => { if (!document.hidden) fetchUsage() }, POLL_MS)
}

function onVisible() { if (!document.hidden) fetchUsage() }

function subscribe(fn) {
  _subs.add(fn)
  if (_subs.size === 1) {
    document.addEventListener('visibilitychange', onVisible)
    startPolling()
  }
  fetchUsage()
  return () => {
    _subs.delete(fn)
    if (!_subs.size) {
      document.removeEventListener('visibilitychange', onVisible)
      clearInterval(_timer); _timer = null
    }
  }
}

const snapshot = () => _usage
const errorSnapshot = () => _error

// Hook commun : état partagé, rafraîchi toutes les 30 s (le serveur cache 60 s de
// toute façon). `error` → l'appelant se retire silencieusement.
function useClaudeUsage() {
  const usage = useSyncExternalStore(subscribe, snapshot, snapshot)
  const error = useSyncExternalStore(subscribe, errorSnapshot, errorSnapshot)
  return { usage, error }
}

/**
 * Bandeau d'alerte des cas où le travail EST ou VA être arrêté. Rendu au-dessus des
 * jauges : un plafond atteint immobilise la file, et un pourcentage au vert ne le
 * dit pas (le runner peut être en pause depuis une exécution précédente).
 */
function LimitAlerts({ usage }) {
  if (!usage) return null
  const stalled = usage.schedulerLimitResetAt
  const model = usage.agentModel
  // Repli en cours : le travail CONTINUE, sur l'autre modèle. C'est une information, pas
  // une alerte rouge — d'où le ton ambre et un message qui ne parle pas de pause.
  const fallback = !stalled && model?.fallbackActive ? model : null
  const hot = [usage.session, usage.week, usage.weekScoped]
    .filter(b => b && b.severity && b.severity !== 'normal')
  if (!stalled && !fallback && !hot.length) return null
  const tone = stalled || hot.length
    ? 'border-rose-200 bg-rose-50 text-rose-800'
    : 'border-amber-200 bg-amber-50 text-amber-800'
  return (
    <div
      className={`flex items-start gap-2 rounded-lg border px-3 py-2 text-xs ${tone}`}
      data-testid="claude-usage-alert"
    >
      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
      <div>
        {stalled ? (
          <>
            <span className="font-medium">Plafond Claude atteint — la file est en pause forcée.</span>{' '}
            Reprise automatique vers {formatResetAt(stalled)} ({formatResetIn(stalled) || 'imminent'}) : rien à faire,
            aucun travail n'est perdu.
          </>
        ) : fallback ? (
          <span data-testid="claude-usage-fallback">
            <span className="font-medium">
              Plafond {modelLabel(fallback.preferred)} épuisé — l'agent continue sur {modelLabel(fallback.active)}.
            </span>{' '}
            La file avance normalement ; retour à {modelLabel(fallback.preferred)}{' '}
            {fallback.preferredResetAt
              ? `vers ${formatResetAt(fallback.preferredResetAt)} (${formatResetIn(fallback.preferredResetAt) || 'imminent'})`
              : 'à la réinitialisation'}.
          </span>
        ) : (
          <span className="font-medium">Marge Claude faible — un plafond est près d'être atteint.</span>
        )}
      </div>
    </div>
  )
}

// Une limite compactée : « Fenêtre 5 h ▓▓░ reste 58 % · réinit. dans 2 h 10 ».
// On affiche ce qui RESTE (pas ce qui est consommé) : c'est la question qu'on se pose
// en regardant la page — « est-ce qu'il me reste assez pour lancer ce chantier ? ».
function StripLimit({ icon: Icon, label, bucket, testid, hint }) {
  const b = bucket || {}
  const pct = Number.isFinite(b.utilizationPct) ? Math.max(0, Math.min(100, b.utilizationPct)) : null
  const tone = usageTone(pct ?? 0, b.severity)
  const resetIn = formatResetIn(b.resetsAt)
  const resetAt = formatResetAt(b.resetsAt)
  return (
    <div className="flex items-center gap-2 min-w-0" data-testid={testid}>
      <Icon size={13} className="text-slate-400 shrink-0" />
      <span className="text-slate-500 shrink-0" title={hint}>{label}</span>
      {pct != null ? (
        <>
          <span className="h-1.5 w-16 rounded-full bg-slate-100 overflow-hidden shrink-0" title={`${pct} % de la limite consommé`}>
            <span className={`block h-full rounded-full ${tone.bar}`} style={{ width: `${pct}%` }} />
          </span>
          <span className={`font-semibold tabular-nums shrink-0 ${tone.text}`} data-testid={`${testid}-pct`}>
            reste {100 - pct} %
          </span>
          {/* Relatif à l'écran (c'est ce qui se lit d'un coup d'œil), heure exacte en
              infobulle (c'est ce qui sert à planifier). */}
          {resetIn && (
            <span
              className="text-slate-400 tabular-nums truncate"
              title={`Réinitialisation : ${formatResetFull(b.resetsAt)}`}
            >
              · {resetIn}{resetAt ? ` (${resetAt})` : ''}
            </span>
          )}
        </>
      ) : (
        // Abonnement injoignable : on ne prétend pas connaître le %.
        <span className="text-slate-400 tabular-nums">—</span>
      )}
    </div>
  )
}

/**
 * Bandeau discret pour le haut de la page Travaux : où en sont les trois plafonds de
 * l'abonnement et — quand ça arrive — le fait que la file soit arrêtée par un
 * plafond. Disparaît si l'API échoue (jamais bloquant).
 *
 * Sous le bandeau, une seule ligne peut apparaître : celle qui signale que les
 * pourcentages datent d'un moment (lecture des quotas momentanément indisponible).
 */
export function ClaudeUsageStrip({ className = 'mb-5' }) {
  const { usage, error } = useClaudeUsage()

  if (error) return null

  const scoped = usage?.weekScoped
  return (
    <div className={className} data-testid="claude-usage-strip">
      <div className="rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <div className="flex items-center gap-1.5 shrink-0">
            <Sparkles size={13} className="text-brand-400" />
            <span className="font-semibold uppercase tracking-wider text-slate-500">Quotas Claude</span>
            {!usage && <Loader2 size={11} className="text-slate-300 animate-spin" />}
          </div>
          <StripLimit
            icon={Gauge} label="Fenêtre 5 h" bucket={usage?.session} testid="usage-strip-session"
            hint="Bloc glissant de 5 h : il s'ouvre au premier message et se referme 5 h plus tard. C'est le plafond qui coupe le plus souvent."
          />
          <StripLimit
            icon={CalendarDays} label="Semaine" bucket={usage?.week} testid="usage-strip-week"
            hint="Total des 7 derniers jours, tous modèles confondus."
          />
          {scoped && (
            <StripLimit
              icon={Cpu} label={`Semaine ${scoped.label || 'modèle'}`} bucket={scoped} testid="usage-strip-scoped"
              hint={`Plafond hebdomadaire propre au modèle ${scoped.label || ''} : il peut être atteint alors que les autres jauges sont au vert.`}
            />
          )}
        </div>

        {usage?.subscriptionStale && (
          <p className="mt-1.5 text-[11px] leading-snug text-amber-600" data-testid="usage-strip-note">
            Pourcentages datant de {formatAgo(usage.subscriptionAt)} — lecture des quotas momentanément indisponible.
          </p>
        )}
      </div>

      {/* Alerte sous le bandeau : n'apparaît que quand le travail est vraiment arrêté
          ou sur le point de l'être. Le reste du temps, rien — on ne crie pas pour rien. */}
      <div className="[&>*]:mt-2"><LimitAlerts usage={usage} /></div>
    </div>
  )
}
