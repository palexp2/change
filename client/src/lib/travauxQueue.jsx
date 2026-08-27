// Briques communes de la file de prompts (/travaux) : lecture temps réel de la
// file, pastille d'état, choix d'une question de Claude, zone de réponse.
//
// Deux consommateurs, une seule logique : la page Travaux (liste complète, ordre,
// réglages) et le panneau rapide accessible depuis n'importe quelle page
// (TravauxQuickPanel). Tout ce qui est ici doit rester utilisable sans la page.
import { useState, useEffect, useCallback, useRef } from 'react'
import { Loader2, HelpCircle, Send, ChevronsDown, ChevronsUp } from 'lucide-react'
import api from './api.js'

export const inputCls = 'px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-400'
export const btnCls = 'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50'
export const btnPrimary = 'inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg bg-brand-600 text-white hover:bg-brand-700 disabled:opacity-50'

export const STATUS_STYLES = {
  asking: 'bg-violet-50 text-violet-700',
  running: 'bg-brand-50 text-brand-700',
  // « waiting » (remis à l'ordonnanceur, pas démarré) s'affiche comme n'importe
  // quel item en file : « En attente » disait la même chose que le rang, en
  // moins clair. La distinction reste dans le tooltip, pas dans la pastille.
  waiting: 'bg-slate-100 text-slate-600',
  queued: 'bg-slate-100 text-slate-600',
  paused: 'bg-amber-50 text-amber-700',
  done: 'bg-emerald-50 text-emerald-700',
  blocked: 'bg-rose-50 text-rose-700',
  cancelled: 'bg-slate-100 text-slate-500',
}
export const STATUS_LABELS = {
  asking: 'À répondre',
  running: 'En cours', waiting: 'En file', queued: 'En file', paused: 'De côté',
  done: 'Terminé', blocked: 'Bloqué', cancelled: 'Annulé',
}

/** L'agent attend une réponse : rien n'avancera sans un clic de l'utilisateur. */
export function isAsking(p) {
  return !!p.pending_question?.question && ['done', 'blocked'].includes(p.status)
}

/**
 * Un item remis à l'agent n'est pas forcément en train de tourner : une seule
 * implémentation avance à la fois. `run_state` (serveur) tranche entre les deux —
 * sans lui, deux réponses envoyées coup sur coup affichaient deux « En cours ».
 */
export function pillStateOf(p) {
  if (p.status === 'running') return p.run_state === 'executing' ? 'running' : 'waiting'
  // « Terminé » serait faux : la tâche a rendu la main faute d'une décision qui
  // n'appartenait qu'à l'utilisateur, et reprendra dès qu'il aura répondu.
  if (isAsking(p)) return 'asking'
  return p.status
}

export function ordinal(n) { return n === 1 ? '1er' : `${n}e` }

/** Première ligne utile d'un texte, pour les aperçus repliés. */
export function firstLine(text, max = 170) {
  const t = String(text || '').split('\n').map(s => s.trim()).find(Boolean) || ''
  return t.length > max ? `${t.slice(0, max - 1)}…` : t
}

/** Date courte et lisible d'un item terminé (« 4 août, 14:07 »). */
export function shortDate(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toLocaleString('fr-CA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

export function StatusPill({ p }) {
  const state = pillStateOf(p)
  const rank = p.wait_rank
  const suffix = (state === 'waiting' || state === 'queued') && rank ? ` · ${ordinal(rank)}` : ''
  const title = state === 'waiting'
    ? "Remis à l'agent, mais son tour n'est pas venu : une seule implémentation tourne à la fois."
    : state === 'running' ? "Claude travaille sur cette tâche en ce moment."
      : state === 'asking' ? "Claude attend ta réponse : le travail reprend dès que tu choisis."
        : state === 'queued' ? "Dans la file : partira quand le poste sera libre." : undefined
  return (
    <span className={`px-2 py-0.5 text-xs font-medium rounded-full ${STATUS_STYLES[state] || 'bg-slate-100 text-slate-600'}`} title={title}>
      {state === 'running' && <Loader2 size={11} className="inline animate-spin mr-1" />}
      {state === 'asking' && <HelpCircle size={11} className="inline mr-1" />}
      {STATUS_LABELS[state] || state}{suffix}
    </span>
  )
}

/**
 * Question de Claude : les choix proposés. Le texte de la question vit dans le fil
 * (dernier message) sur la page Travaux ; le panneau rapide, lui, n'affiche pas le
 * fil — d'où `showQuestion`, qui rappelle la question au-dessus des choix.
 * Un clic répond ET relance la tâche.
 */
export function QuestionChoices({ p, onAnswer, showQuestion = false }) {
  const [answering, setAnswering] = useState(false)
  const options = p.pending_question?.options || []
  return (
    <div className="rounded-lg border border-violet-200 bg-violet-50/60 px-3 py-2.5" data-testid="travaux-question">
      <div className="text-xs font-medium text-violet-800 inline-flex items-center gap-1.5">
        <HelpCircle size={13} /> Claude attend ta réponse pour continuer
      </div>
      {showQuestion && (
        <p className="mt-1.5 text-sm text-violet-900 whitespace-pre-wrap">{p.pending_question.question}</p>
      )}
      {!!options.length && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {options.map((opt, i) => (
            <button
              key={i}
              className="px-2.5 py-1 text-sm rounded-lg bg-white border border-violet-300 text-violet-900 hover:bg-violet-100 disabled:opacity-50 text-left"
              data-testid="travaux-question-option"
              disabled={answering}
              onClick={async () => { setAnswering(true); try { await onAnswer(opt) } finally { setAnswering(false) } }}
            >{opt}</button>
          ))}
        </div>
      )}
      <p className="text-xs text-violet-700/70 mt-2">
        Un choix relance le travail avec ta réponse. Tu peux aussi répondre librement ci-dessous.
      </p>
    </div>
  )
}

/**
 * Zone de réponse d'un fil. Boutons assumés (pas d'autosave) : envoyer RELANCE
 * l'exécution de la tâche — action à effet réel, elle ne doit pas partir d'un blur.
 * Deux départs possibles : au DÉBUT de la file (la tâche repart tout de suite,
 * avant le reste) ou à la FIN (la réponse est enregistrée, la tâche reprendra
 * quand son tour reviendra).
 */
export function ReplyBox({ onSend, autoFocus, rows = 2 }) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(null)   // 'front' | 'back' | null
  const ref = useRef(null)
  useEffect(() => { if (autoFocus) ref.current?.focus() }, [autoFocus])
  const send = async (placement) => {
    if (!text.trim() || sending) return
    setSending(placement)
    try {
      await onSend(text.trim(), placement)
      setText('')
    } finally { setSending(null) }
  }
  return (
    <div>
      <textarea
        ref={ref}
        data-testid="travaux-reply-input"
        className={`${inputCls} w-full`}
        rows={rows}
        placeholder="Répondre à Claude — ta réponse relance la tâche…"
        value={text}
        onChange={e => setText(e.target.value)}
        // Cmd/Ctrl+Entrée envoie (au début de la file) : Entrée seule sert aux retours à la ligne.
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send('front') }}
      />
      <div className="flex items-center gap-2 mt-1.5 flex-wrap">
        <button
          className={btnPrimary} data-testid="travaux-reply-front"
          onClick={() => send('front')} disabled={!!sending || !text.trim()}
          title="La tâche repart tout de suite, avant le reste de la file"
        >
          {sending === 'front' ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Relancer au début de la file
        </button>
        <button
          className={btnCls} data-testid="travaux-reply-back"
          onClick={() => send('back')} disabled={!!sending || !text.trim()}
          title="La réponse est enregistrée et la tâche retourne en fin de file — elle reprendra quand son tour reviendra"
        >
          {sending === 'back' ? <Loader2 size={14} className="animate-spin" /> : <ChevronsDown size={14} />} À la fin de la file
        </button>
        <span className="text-xs text-slate-400">⌘/Ctrl + Entrée</span>
      </div>
    </div>
  )
}

/**
 * Où la tâche qu'on est en train d'écrire ira se déposer : au début ou à la fin
 * de la file. Bouton discret (une bascule, pas deux contrôles) posé à côté du
 * bouton d'envoi.
 *
 * Un seul composant pour les TROIS endroits d'où l'on dépose une tâche — page
 * /travaux, panneau rapide, FAB « Modifier le système » — donc le même geste et
 * le même vocabulaire partout dans l'app. Le bouton dit l'état courant (« à la
 * fin de la file ») ; cliquer le bascule, il n'y a rien d'autre à comprendre.
 *
 * Défaut : la fin de file — c'est le comportement historique, et le seul qui
 * respecte l'ordre déjà décidé pour le reste de la file.
 */
export function PlacementToggle({ value, onChange, testId = 'travaux-placement', className = '' }) {
  const first = value === 'first'
  return (
    <button
      type="button"
      data-testid={testId}
      data-placement={first ? 'first' : 'last'}
      aria-pressed={first}
      onClick={() => onChange(first ? 'last' : 'first')}
      title={first
        ? 'Se dépose au début de la file — cliquer pour la mettre plutôt à la fin'
        : 'Se dépose à la fin de la file — cliquer pour la passer au début'}
      className={`inline-flex items-center gap-1 text-xs font-medium transition-colors ${
        first ? 'text-brand-600 hover:text-brand-700' : 'text-slate-400 hover:text-slate-600'
      } ${className}`}
    >
      {first ? <ChevronsUp size={12} /> : <ChevronsDown size={12} />}
      {first ? 'Au début de la file' : 'À la fin de la file'}
    </button>
  )
}

/** Voie d'exécution d'un item — même règle que le serveur (`laneOf`). */
function laneOf(p) { return p.lane || ((p.mode === 'question' && !p.same_context) ? 'question' : 'exec') }

/**
 * « Passer en premier », joué localement — exactement ce que le serveur va faire :
 * l'item repasse en file (un item de côté y revient), les items de SA voie déjà
 * remis à l'ordonnanceur mais pas démarrés lui sont repris, et il se place en tête.
 * Les rangs d'attente de la voie glissent d'un cran, sinon deux cartes afficheraient
 * « 1er » le temps de l'aller-retour.
 */
function liftToFront(prompts, id) {
  const target = prompts.find(p => p.id === id)
  if (!target || !['queued', 'paused'].includes(target.status)) return prompts
  const lane = laneOf(target)
  const from = target.wait_rank || Infinity
  const rest = prompts.filter(p => p.id !== id).map(p => {
    if (laneOf(p) !== lane) return p
    // Remis à l'ordonnanceur mais pas démarré : le serveur le lui reprend pour que
    // « premier » ne mente pas — l'écran doit le dire aussi (une exécution
    // réellement en cours, elle, n'est jamais touchée).
    const reclaimed = p.status === 'running' && p.run_state !== 'executing' && p.space === target.space
    const rank = p.wait_rank && p.wait_rank < from ? p.wait_rank + 1 : p.wait_rank
    if (!reclaimed && rank === p.wait_rank) return p
    return { ...p, wait_rank: rank, ...(reclaimed ? { status: 'queued', run_state: null } : null) }
  })
  return [{ ...target, status: 'queued', wait_rank: 1 }, ...rest]
}

const EMPTY_QUEUE = {
  prompts: [], agent_enabled: true, runner_busy: false, running_questions: 0, max_parallel_questions: 2,
  queue_paused: false, queue_paused_at: null, queue_paused_reason: null,
}

/**
 * Lecture temps réel de la file de prompts.
 *
 * - `activeOnly` : ne demande que les items vivants (en cours, en file, de côté,
 *   en attente de réponse) — la réponse complète embarque tout l'historique et ses
 *   fils, trop lourde pour un panneau ouvert depuis n'importe quelle page.
 * - `pollMs` : filet lent (l'exécution en cours n'émet pas d'événement à chaque
 *   étape) ; 0 le désactive.
 * - Rafraîchir pendant que l'utilisateur écrit re-rend la liste sous ses doigts :
 *   on note qu'un rafraîchissement est dû (`flushStale`) et on le passe quand le
 *   champ perd le focus.
 */
export function useTravauxPrompts({ activeOnly = false, pollMs = 20_000, enabled = true, onError } = {}) {
  const [data, setData] = useState(EMPTY_QUEUE)
  const [loading, setLoading] = useState(true)

  const errRef = useRef(onError)
  errRef.current = onError

  // Plusieurs chargements peuvent être en vol en même temps (temps réel + sondage +
  // rechargement après une action). Sans numéro d'ordre, une réponse partie AVANT un
  // réordonnancement pouvait arriver APRÈS et remettre la liste dans l'ordre d'avant.
  const seq = useRef(0)

  // Suppression : la carte doit partir AU CLIC et ne jamais revenir. Le serveur, lui,
  // supprime tout de suite ; ce qui la ramenait, c'est une réponse de liste PARTIE
  // avant la suppression et arrivée après (sondage, temps réel) — la ligne
  // réapparaissait alors telle quelle. D'où cette pierre tombale locale : les ids
  // retirés sont filtrés de TOUTE réponse, pas seulement de l'état courant.
  const dropped = useRef(new Set())

  // « Passer en premier » : même problème, même remède. Le serveur tranche en
  // quelques dizaines de ms, mais la liste complète (une centaine de Ko : tout
  // l'historique et ses fils) met le reste de la seconde à revenir et à se
  // re-rendre — la carte ne bougeait pas d'ici là. Le mouvement est donc appliqué
  // AU CLIC, et ré-appliqué à toute réponse tant qu'il n'est pas confirmé : une
  // liste partie avant le clic et arrivée après ferait sinon redescendre la carte.
  const lifted = useRef(new Set())

  const strip = useCallback(d => {
    const before = d.prompts || []
    let prompts = before
    if (dropped.current.size) prompts = prompts.filter(p => !dropped.current.has(p.id))
    for (const id of lifted.current) prompts = liftToFront(prompts, id)
    return prompts === before ? d : { ...d, prompts }
  }, [])

  const load = useCallback(async () => {
    if (!enabled) return
    const mine = ++seq.current
    try {
      const fresh = await api.travaux.listPrompts(activeOnly ? { active: 1 } : {})
      if (mine === seq.current) setData(strip(fresh))
    }
    catch (e) { errRef.current?.(e) }
    finally { setLoading(false) }
  }, [enabled, activeOnly, strip])

  /** Retire une ligne sur-le-champ, avant même la réponse du serveur. */
  const dropPrompt = useCallback(id => {
    dropped.current.add(id)
    setData(d => strip(d))
  }, [strip])
  /** La suppression a échoué : la ligne a le droit de revenir au prochain chargement. */
  const undropPrompt = useCallback(id => { dropped.current.delete(id) }, [])

  /** Remonte une ligne en tête de file sur-le-champ, avant la réponse du serveur. */
  const liftPrompt = useCallback(id => {
    lifted.current.add(id)
    setData(d => strip(d))
  }, [strip])
  /** Le serveur a rendu son verdict (ou a refusé) : la liste reprend la main. */
  const unliftPrompt = useCallback(id => { lifted.current.delete(id) }, [])

  const stale = useRef(false)
  const softLoad = useCallback(() => {
    const el = document.activeElement
    const typing = !!(el && /^(INPUT|TEXTAREA)$/.test(el.tagName) && el.closest('[data-prompt-id], [data-travaux-composer]'))
    if (typing) { stale.current = true; return }
    load()
  }, [load])
  const flushStale = useCallback(() => {
    if (!stale.current) return
    stale.current = false
    load()
  }, [load])

  useEffect(() => { if (enabled) load() }, [enabled, load])
  useEffect(() => {
    if (!enabled) return undefined
    const onEvt = () => softLoad()
    // Le passage « en attente → en cours » se joue côté ordonnanceur : il n'émet pas
    // d'événement de file, seulement une mise à jour de tâche. Sans cette écoute, la
    // carte resterait « En attente » jusqu'au rafraîchissement lent.
    const onTask = (e) => { if (e.detail?.kind === 'queue') softLoad() }
    window.addEventListener('travaux:prompts:updated', onEvt)
    window.addEventListener('agent:task:updated', onTask)
    const t = pollMs ? setInterval(softLoad, pollMs) : null
    return () => {
      window.removeEventListener('travaux:prompts:updated', onEvt)
      window.removeEventListener('agent:task:updated', onTask)
      if (t) clearInterval(t)
    }
  }, [enabled, softLoad, pollMs])

  return { data, setData, loading, load, softLoad, flushStale, dropPrompt, undropPrompt, liftPrompt, unliftPrompt }
}
