// Travaux — quatre listes, réunies sur une page.
//
// 1. « Ma file » remplace le Google Doc de prompts : on empile ses demandes, le
//    serveur en exécute UNE à la fois via l'agent (contexte neuf à chaque item —
//    la vraie continuité, réponse ou relance fauchée, est reprise automatiquement
//    via `follow_up`), et un recap part dans le DM Slack à chaque fin — plus
//    besoin de surveiller le terminal.
// 2. « Suggestions » est la liste que l'agent alimente lui-même — des chantiers,
//    et des intégrations (outils/API externes à brancher) ; rien ne part en
//    exécution avant d'avoir été promu dans la file.
// 3. « De côté & idées » réunit ce qui attend son heure : les items de file mis
//    de côté (rien ne démarre tant qu'on ne les remet pas en file) et le carnet
//    d'idées, dont rien ne s'exécute non plus. Les deux listes vivaient loin l'une
//    de l'autre alors qu'on les consulte dans le même geste — « qu'est-ce que
//    j'avais laissé pour plus tard ? ». Un bouton du carnet crée un item de file
//    (mis de côté) le jour où l'idée devient un chantier.
// 4. « Travaux récurrents » remplace le fichier Travaux_OS_ML du Drive : chaque
//    ligne se coche PAR PÉRIODE (la case se rouvre à la période suivante).
//
// Autosave partout (blur / debounce 500 ms) ; les seuls boutons sont les créations
// et les actions à effet réel (lancer la file, promouvoir, générer).
import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  Play, Pause, Trash2, ChevronUp, ChevronsUp, Plus, Sparkles, Check, X, Loader2,
  ListOrdered, Link2, CheckCircle2, AlertTriangle, RefreshCw, ChevronDown, Send,
  Hourglass, GripVertical, Plug, HelpCircle, CircleStop, PauseCircle, PlayCircle,
  Lightbulb, MessageSquare, ChevronLeft, ChevronRight, CalendarDays, Paperclip,
  Settings2,
} from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { ClaudeUsageStrip } from '../components/ClaudeUsage.jsx'
import { PageLink } from '../components/PageLink.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
// Briques partagées avec le panneau rapide (accessible depuis toute l'app) :
// lecture temps réel de la file, pastille d'état, choix d'une question, réponse.
// Une seule implémentation, deux points d'entrée — voir lib/travauxQueue.jsx.
import {
  inputCls, btnCls, btnPrimary,
  isAsking, pillStateOf, firstLine, shortDate,
  StatusPill, QuestionChoices, ReplyBox, PlacementToggle, useTravauxPrompts,
} from '../lib/travauxQueue.jsx'

// « Auto » : le calibre est jugé côté serveur à partir de la demande (comme le
// titre automatique) — un choix manuel le fige, revenir à Auto le rend au modèle.
const PRESETS = [
  { value: 'auto', label: 'Auto (selon la tâche)' },
  { value: 'fast', label: 'Rapide' },
  { value: 'standard', label: 'Standard' },
  { value: 'deep', label: 'Approfondi' },
]
const presetLabel = v => PRESETS.find(o => o.value === v)?.label || v

/**
 * Sélecteur de calibre d'un item existant. La valeur affichée reste « Auto » tant
 * que le choix est automatique (preset_auto), avec le verdict entre parenthèses —
 * la clé concrète vit côté serveur, c'est elle que lit l'ordonnanceur.
 */
function PresetSelect({ p, onPatch }) {
  return (
    <select
      className={inputCls}
      data-testid="travaux-preset"
      value={p.preset_auto ? 'auto' : p.preset}
      title={p.preset_auto
        ? 'Calibre jugé automatiquement selon la tâche — choisis-en un pour le figer'
        : 'Calibre figé — choisis « Auto » pour le rendre au jugement automatique'}
      onChange={e => onPatch(p.id, { preset: e.target.value })}
    >
      {PRESETS.map(o => (
        <option key={o.value} value={o.value}>
          {o.value === 'auto' && p.preset_auto ? `Auto — ${presetLabel(p.preset)}` : o.label}
        </option>
      ))}
    </select>
  )
}
// L'ordre est celui des sections de la page : du plus fréquent au plus rare.
const CADENCE_LABELS = {
  bihebdo: 'Deux fois par semaine', hebdo: 'Hebdomadaire', mensuel: 'Mensuel',
  trimestriel: 'Trimestriel', annuel: 'Annuel', adhoc: 'À faire une fois',
}
const OWNERS = [
  { value: 'AL', label: 'Antoine (AL)' },
  { value: 'ML', label: 'Michel (ML)' },
]

/** Durée écoulée lisible, rafraîchie chaque seconde tant que l'item tourne. */
function useElapsed(startedAt, live) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [live])
  if (!startedAt) return null
  const secs = Math.max(0, Math.round((now - new Date(startedAt).getTime()) / 1000))
  const m = Math.floor(secs / 60)
  return m ? `${m} min ${String(secs % 60).padStart(2, '0')} s` : `${secs} s`
}

/**
 * Champs d'un record en autosave, SANS interruption de frappe.
 *
 * Le piège corrigé ici : chaque sauvegarde déclenche une diffusion temps réel,
 * donc un rechargement de la liste. Réinjecter bêtement la valeur du serveur
 * effaçait les caractères tapés pendant l'aller-retour et renvoyait le curseur
 * à la fin. Tant qu'une frappe n'est pas revenue confirmée, c'est l'écran qui
 * fait foi pour CE champ ; les autres suivent le serveur normalement.
 *
 * `server` est l'objet champ → valeur affichée telle que le serveur la voit.
 * `save(patch)` peut renvoyer la ligne serveur : elle sert à accepter une
 * normalisation côté serveur (titre vidé → titre automatique) sans écraser une
 * frappe arrivée entre-temps.
 */
function useRecordDraft(server, save, delay = 600) {
  const [draft, setDraft] = useState(server)
  const awaiting = useRef({})   // champ → dernière valeur envoyée, pas encore confirmée
  const timer = useRef(null)
  const latest = useRef(server)
  latest.current = server
  // Signature des valeurs serveur : l'objet est recréé à chaque rendu, donc on ne
  // peut pas le mettre en dépendance directe sans boucler.
  const signature = JSON.stringify(server)

  useEffect(() => {
    const srv = latest.current
    setDraft(prev => {
      let next = prev
      for (const k of Object.keys(srv)) {
        if (awaiting.current[k] === undefined) {
          if (prev[k] !== srv[k]) next = { ...next, [k]: srv[k] }
        } else if (awaiting.current[k] === srv[k]) {
          delete awaiting.current[k]      // notre frappe est revenue : le champ est à jour
        }
      }
      return next
    })
  }, [signature])

  const flush = useCallback(async () => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    const patch = { ...awaiting.current }
    if (!Object.keys(patch).length) return
    const row = await save(patch)
    for (const [k, sent] of Object.entries(patch)) {
      // Tapé depuis l'envoi ? On laisse la frappe en cours gagner.
      if (awaiting.current[k] !== sent) continue
      delete awaiting.current[k]
      const got = row?.[k] ?? null
      if (got !== null && got !== sent) setDraft(d => ({ ...d, [k]: got }))
    }
  }, [save])

  const edit = useCallback((k, v) => {
    setDraft(d => ({ ...d, [k]: v }))
    awaiting.current[k] = v
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => { flush().catch(() => {}) }, delay)
  }, [flush, delay])

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  return { draft, edit, flush }
}

// ─── Onglet 1 : ma file de prompts ────────────────────────────────────────────
//
// Deux vues plutôt qu'une seule liste à dérouler : « File » (ce qui tourne ou va
// tourner) et « Conversations » (ce qui a rendu la main et attend éventuellement
// une réponse). Chaque item tient sur une ligne repliée — le fil, le prompt et les
// réglages ne s'ouvrent qu'à la demande. Avant, il fallait dérouler des
// conversations entières pour atteindre le bas de la file, et bien plus loin
// encore pour répondre à Claude.

/**
 * Message à Claude PENDANT que la tâche tourne (steering, comme dans Claude Code) :
 * livré en cours d'exécution sans rien interrompre ni relancer. Bouton assumé (pas
 * d'autosave) : envoyer parle à un agent en plein travail — ça ne part pas d'un blur.
 */
function SteerBox({ onSend, executing, autoFocus }) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const ref = useRef(null)
  useEffect(() => { if (autoFocus) ref.current?.focus() }, [autoFocus])
  const send = async () => {
    if (!text.trim()) return
    setSending(true)
    try {
      await onSend(text.trim())
      setText('')
    } finally { setSending(false) }
  }
  return (
    <div>
      <textarea
        ref={ref}
        data-testid="travaux-steer-input"
        className={`${inputCls} w-full`}
        rows={2}
        placeholder="Dire quelque chose à Claude pendant qu'il travaille…"
        value={text}
        onChange={e => setText(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send() }}
      />
      <div className="flex items-center gap-2 mt-1.5">
        <button className={btnPrimary} data-testid="travaux-steer-send" onClick={send} disabled={sending || !text.trim()}>
          {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />} Envoyer en cours de tâche
        </button>
        <span className="text-xs text-slate-400">
          {executing
            ? 'Claude le prendra en compte sans interrompre le travail.'
            : 'Pas encore démarrée — le message sera intégré au brief au départ.'}
        </span>
      </div>
    </div>
  )
}

/**
 * Réordonnancement d'une liste : glisser-déposer + flèches d'un cran, partagés
 * par la file de prompts et le carnet d'idées.
 *
 * `siblingsOf(id)` renvoie les ids entre lesquels l'item peut se déplacer (le
 * groupe pour la file, la liste entière pour les idées) — un drop hors de ces
 * voisins est ignoré. `applyOrder(nextIds, id)` persiste le nouvel ordre.
 * Les flèches restent indispensables : un drag seul rendrait la liste
 * inaccessible sans souris.
 */
function useReorderDnd({ siblingsOf, applyOrder }) {
  const [dragId, setDragId] = useState(null)
  const [dragOver, setDragOver] = useState({ id: null, side: null })
  const dragIdRef = useRef(null)
  const sideOf = (e) => {
    const r = e.currentTarget.getBoundingClientRect()
    return (e.clientY - r.top) < r.height / 2 ? 'before' : 'after'
  }
  const resetDrag = useCallback(() => {
    dragIdRef.current = null
    setDragId(null)
    setDragOver({ id: null, side: null })
  }, [])
  const move = useCallback((id, delta) => {
    const list = siblingsOf(id) || []
    const i = list.indexOf(id)
    const j = i + delta
    if (i < 0 || j < 0 || j >= list.length) return
    const next = [...list]
    ;[next[i], next[j]] = [next[j], next[i]]
    applyOrder(next, id)
  }, [siblingsOf, applyOrder])

  return {
    dragId,
    dragOverId: dragOver.id,
    dragOverSide: dragOver.side,
    // Rien à réordonner quand l'item est seul de son groupe : pas de poignée.
    canMove: (id) => (siblingsOf(id)?.length || 0) > 1,
    isFirst: (id) => siblingsOf(id)?.[0] === id,
    isLast: (id) => siblingsOf(id)?.slice(-1)[0] === id,
    move,
    dragStart: (e, id, card) => {
      dragIdRef.current = id
      setDragId(id)
      if (e.dataTransfer) {
        e.dataTransfer.effectAllowed = 'move'
        try { e.dataTransfer.setData('text/plain', id) } catch { /* Safari */ }
        // Fantôme = la carte entière, pas la poignée seule.
        if (card) { try { e.dataTransfer.setDragImage(card, 24, 24) } catch { /* vieux navigateurs */ } }
      }
    },
    dragOver: (e, id) => {
      const src = dragIdRef.current
      if (!src || src === id || !(siblingsOf(src) || []).includes(id)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
      const side = sideOf(e)
      setDragOver(prev => (prev.id === id && prev.side === side ? prev : { id, side }))
    },
    drop: (e, targetId) => {
      e.preventDefault()
      const sourceId = dragIdRef.current
      // Le côté est recalculé ici : React groupe les setState du dragOver, donc
      // l'état peut être périmé au moment du drop (surtout en test synchrone).
      const side = sideOf(e)
      resetDrag()
      const siblings = siblingsOf(sourceId) || []
      if (!sourceId || sourceId === targetId || !siblings.includes(targetId)) return
      const next = siblings.filter(id => id !== sourceId)
      let idx = next.indexOf(targetId)
      if (idx === -1) return
      if (side === 'after') idx += 1
      next.splice(idx, 0, sourceId)
      applyOrder(next, sourceId)
    },
    dragEnd: resetDrag,
  }
}

/**
 * Poignée de priorité d'un item pas encore parti : glisser la carte, ou monter /
 * descendre d'un cran au clic. Le clavier passe par les deux boutons — un drag
 * seul laisserait la file inaccessible sans souris.
 */
function ReorderRail({ p, dnd }) {
  const arrow = 'p-0.5 rounded text-slate-300 hover:text-slate-700 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent'
  return (
    <div className="flex flex-col items-center shrink-0 w-4">
      <button
        className={arrow} data-testid="travaux-move-up" title="Monter d'un cran" aria-label="Monter d'un cran"
        disabled={dnd.isFirst(p.id)} onClick={() => dnd.move(p.id, -1)}
      ><ChevronUp size={13} /></button>
      <span
        draggable
        onDragStart={e => dnd.dragStart(e, p.id)}
        onDragEnd={dnd.dragEnd}
        className="cursor-grab active:cursor-grabbing text-slate-300 hover:text-slate-500"
        title="Glisser pour changer la priorité"
        data-testid="travaux-drag-handle"
      ><GripVertical size={13} /></span>
      <button
        className={arrow} data-testid="travaux-move-down" title="Descendre d'un cran" aria-label="Descendre d'un cran"
        disabled={dnd.isLast(p.id)} onClick={() => dnd.move(p.id, 1)}
      ><ChevronDown size={13} /></button>
    </div>
  )
}

/** Un message du fil. */
function ThreadMessage({ m }) {
  return (
    <div className={`text-sm whitespace-pre-wrap rounded-lg px-3 py-2 ${
      m.role === 'agent' ? 'bg-slate-50 text-slate-700' : 'bg-brand-50 text-brand-900'
    }`}>
      <div className="text-[11px] uppercase tracking-wide opacity-60 mb-0.5">
        {m.role === 'agent' ? 'Claude' : (m.author_name || 'Toi')}
      </div>
      {m.text}
    </div>
  )
}

// Fil replié par défaut au-delà de ce nombre de messages : une conversation de
// vingt échanges ne doit pas repousser le reste de la file hors de l'écran.
const THREAD_TAIL = 3

const SPACE_LABEL = { finance: 'Espace finance', agent: 'Agent' }

function PromptRow({ p, onPatch, onDelete, onFirst, onReply, onSteer, dnd, space }) {
  const state = pillStateOf(p)
  const asking = state === 'asking'
  const executing = state === 'running'
  const waiting = state === 'waiting'
  const finished = ['done', 'blocked', 'cancelled'].includes(p.status)
  // Façon boîte mail : une conversation terminée jamais ouverte reste « à lire »
  // jusqu'au premier dépliage — voir le PATCH { seen: true } plus bas.
  const unread = finished && !p.seen_at
  // Un item « en attente » a été remis à l'ordonnanceur mais n'a RIEN commencé :
  // il reste donc modifiable et déplaçable, le serveur le reprend au premier
  // changement. Seule une exécution réellement en cours est figée.
  const editable = ['queued', 'paused'].includes(p.status) || waiting

  const [open, setOpen] = useState(asking)
  const [focusReply, setFocusReply] = useState(0)
  const [showWholeThread, setShowWholeThread] = useState(false)
  const cardRef = useRef(null)
  // Le chrono ne vaut que pendant l'exécution : `started_at` survit à la tâche, et
  // l'afficher sur un item terminé ou remis en file donnait des « 1044 min » absurdes.
  const running = p.status === 'running'
  const elapsed = useElapsed(running ? p.started_at : null, running)

  const save = useCallback(patch => onPatch(p.id, patch), [onPatch, p.id])
  const { draft, edit, flush } = useRecordDraft({ title: p.title || '', prompt: p.prompt || '' }, save)

  // Une question ouverte force l'ouverture : c'est le seul état où rien n'avance
  // sans un geste de l'utilisateur.
  useEffect(() => { if (asking) setOpen(true) }, [asking])

  // Dépliage = lecture, comme un e-mail qu'on ouvre : le marqueur « à lire » ne
  // revient qu'à la prochaine fin d'exécution (voir finishPrompt côté serveur).
  useEffect(() => { if (open && unread) onPatch(p.id, { seen: true }) }, [open, unread, onPatch, p.id])

  const movable = !!dnd && editable && dnd.canMove(p.id)
  const dropSide = (movable && dnd.dragOverId === p.id && dnd.dragId && dnd.dragId !== p.id) ? dnd.dragOverSide : null

  const messages = p.messages || []
  const lastAgent = [...messages].reverse().find(m => m.role === 'agent')
  const preview = firstLine((finished || asking) ? (lastAgent?.text || p.user_summary || p.prompt) : p.prompt)
  const hidden = showWholeThread ? 0 : Math.max(0, messages.length - THREAD_TAIL)
  const shownMessages = hidden ? messages.slice(-THREAD_TAIL) : messages

  const iconBtn = 'p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 disabled:opacity-40'

  // Toute la ligne repliée ouvre/replie la conversation — pas seulement la
  // flèche ou l'aperçu. Un clic sur un contrôle (bouton, champ, poignée…) ou
  // une sélection de texte en cours garde son comportement propre.
  const toggleFromCard = (e) => {
    if (e.target.closest('button, a, input, textarea, select, label, [draggable="true"]')) return
    if (window.getSelection && String(window.getSelection())) return
    setOpen(o => !o)
  }

  return (
    <div
      ref={cardRef}
      data-prompt-id={p.id}
      data-prompt-status={p.status}
      data-prompt-open={open ? '1' : '0'}
      onDragOver={movable ? e => dnd.dragOver(e, p.id) : undefined}
      onDrop={movable ? e => dnd.drop(e, p.id) : undefined}
      data-prompt-unread={unread ? '1' : '0'}
      className={`relative rounded-xl border transition ${
        executing ? 'border-brand-300 ring-1 ring-brand-100 bg-white'
          : asking ? 'border-violet-300 ring-1 ring-violet-100 bg-white'
          // Terminé et jamais ouvert : traitement « e-mail non lu », volontairement
          // franc (fond teinté + liseré) pour repérer d'un coup d'œil ce qui reste à lire.
          : unread ? 'border-brand-200 bg-brand-50/60 hover:border-brand-300'
          : 'border-slate-200 bg-white hover:border-slate-300'
      } ${dnd?.dragId === p.id ? 'opacity-50' : ''}`}
    >
      {dropSide && (
        <span className={`absolute left-2 right-2 h-0.5 bg-brand-500 rounded pointer-events-none ${dropSide === 'before' ? '-top-1' : '-bottom-1'}`} />
      )}
      {unread && (
        <span
          data-testid="travaux-unread-dot"
          className="absolute left-1 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full bg-brand-500"
          title="Conversation terminée non encore ouverte"
        />
      )}

      {/* Ligne repliée : tout ce qu'il faut pour trier la file d'un coup d'œil.
          Cliquable en entier (voir toggleFromCard) pour ouvrir la conversation. */}
      <div
        className="flex items-start gap-2 px-2.5 py-2 cursor-pointer"
        data-testid="travaux-row-head"
        onClick={toggleFromCard}
      >
        {movable
          ? <ReorderRail p={p} dnd={{ ...dnd, dragStart: (e, id) => dnd.dragStart(e, id, cardRef.current) }} />
          : <span className="w-4 shrink-0" />}

        <button
          className="mt-0.5 p-0.5 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100 shrink-0"
          data-testid="travaux-toggle"
          aria-expanded={open}
          title={open ? 'Replier' : editable ? 'Ouvrir — prompt et réglages' : 'Ouvrir la conversation'}
          onClick={() => setOpen(o => !o)}
        ><ChevronDown size={14} className={open ? 'rotate-180 transition' : 'transition'} /></button>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <StatusPill p={p} />
            {editable ? (
              <input
                className="flex-1 min-w-0 bg-transparent text-sm font-medium text-slate-800 border-0 p-0 focus:outline-none placeholder:text-slate-300"
                value={draft.title}
                onChange={e => edit('title', e.target.value)}
                onBlur={flush}
                placeholder="Titre — vide = automatique"
                // Titre auto : aucune mention à l'écran — il se présente comme n'importe
                // quel titre (demande utilisateur). L'indication ne reste que sur un
                // titre figé, pour retrouver le chemin du mode automatique.
                title={p.title_auto ? undefined : 'Titre figé — vide le champ pour revenir au titre automatique'}
              />
            ) : (
              <span
                data-testid="travaux-title"
                className={`flex-1 min-w-0 truncate text-sm text-slate-800 ${unread ? 'font-bold' : 'font-medium'}`}
              >{p.title}</span>
            )}

            {/* Repères discrets : la ligne doit rester lisible d'un coup d'œil. */}
            {!!p.same_context && (
              <Link2 size={12} className="shrink-0 text-violet-500" aria-label="Même contexte">
                <title>Reprend la session Claude de l'item précédent</title>
              </Link2>
            )}
            {/* Item né d'une suggestion de Claude : la pastille dit « Claude » —
                l'origine est ce qu'on veut reconnaître d'un coup d'œil (« ça, ce
                n'est pas moi qui l'ai demandé »). La nature exacte (chantier /
                intégration) et le domaine restent dans l'infobulle : à l'écran,
                le repère doit rester discret. */}
            {p.suggestion_id && (
              <span
                data-testid="travaux-suggestion-badge"
                data-kind={p.suggestion_kind || 'chantier'}
                className={`shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium rounded ${
                  p.suggestion_kind === 'integration' ? 'bg-indigo-50 text-indigo-700' : 'bg-violet-50 text-violet-700'
                }`}
                title={`Suggestion de Claude — ${p.suggestion_kind === 'integration' ? 'Intégration' : 'Chantier'}${p.suggestion_area ? ` · ${p.suggestion_area}` : ''}`}
              >
                <Sparkles size={10} />
                Claude
              </span>
            )}
            {p.mode === 'question' && (
              <span className="shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded bg-sky-50 text-sky-700" title="Lecture seule — tourne en parallèle">Q</span>
            )}
            {/* Conversation venue de l'AUTRE file : elle est listée ici pour ne jamais
                disparaître, mais on dit d'où elle vient. */}
            {space && p.space && p.space !== space && (
              <span
                data-testid="travaux-space-badge"
                data-space={p.space}
                className="shrink-0 px-1.5 py-0.5 text-[10px] font-medium rounded bg-slate-100 text-slate-600"
                title={`Lancée depuis la section ${SPACE_LABEL[p.space] || p.space}`}
              >{SPACE_LABEL[p.space] || p.space}</span>
            )}
            {!!messages.length && (
              <span className="shrink-0 inline-flex items-center gap-0.5 text-xs text-slate-400" title={`${messages.length} message${messages.length > 1 ? 's' : ''} dans le fil`}>
                <MessageSquare size={11} /> {messages.length}
              </span>
            )}
            {elapsed && <span className="shrink-0 text-xs text-slate-400">{elapsed}</span>}
            {finished && shortDate(p.completed_at) && (
              <span className="shrink-0 text-xs text-slate-400">{shortDate(p.completed_at)}</span>
            )}
            {p.status === 'done' && <PageLink task={p} />}
          </div>

          {!open && !!preview && (
            <button
              className={`mt-0.5 block w-full text-left text-xs truncate ${
                unread ? 'font-semibold text-slate-600 hover:text-slate-800' : 'text-slate-400 hover:text-slate-600'
              }`}
              onClick={() => setOpen(true)}
              title="Ouvrir"
            >{preview}</button>
          )}
        </div>

        <div className="flex items-center gap-0.5 shrink-0">
          {/* Frein posé sur un item précis : quand CELUI-CI se termine, la file se
              met en pause au lieu d'enchaîner. La façon la plus simple de borner la
              consommation de jetons sans surveiller la page. */}
          {['queued', 'running'].includes(p.status) && (
            <button
              data-testid="travaux-stop-after"
              data-active={p.stop_after ? '1' : '0'}
              className={`inline-flex items-center gap-1 px-1.5 py-1 text-[11px] rounded-lg border transition ${
                p.stop_after
                  ? 'border-amber-300 bg-amber-50 text-amber-700'
                  : 'border-transparent text-slate-400 hover:bg-slate-100 hover:text-slate-600'
              }`}
              title={p.stop_after
                ? 'La file se mettra en pause une fois cette tâche terminée. Clique pour annuler.'
                : 'Mettre la file en pause une fois cette tâche terminée — les suivantes attendront ton feu vert.'}
              onClick={() => onPatch(p.id, { stop_after: p.stop_after ? 0 : 1 })}
            >
              <CircleStop size={13} />{p.stop_after ? ' Pause après' : ''}
            </button>
          )}
          {['done', 'blocked'].includes(p.status) && (
            <button
              className={iconBtn} data-testid="travaux-reply"
              onClick={() => { setOpen(true); setFocusReply(n => n + 1) }}
              title="Répondre à Claude"
            ><Send size={14} /></button>
          )}
          {editable && p.status !== 'paused' && (
            <button className={iconBtn} data-testid="travaux-move-first" onClick={() => onFirst(p.id)} title="Passer en premier — partira avant tout le reste, même les tâches déjà remises à l'agent"><ChevronsUp size={14} /></button>
          )}
          {editable && p.status !== 'paused' && (
            <button className={iconBtn} onClick={() => onPatch(p.id, { status: 'paused' })} title="Mettre de côté"><Pause size={14} /></button>
          )}
          {p.status === 'paused' && (
            <button className={iconBtn} onClick={() => onPatch(p.id, { status: 'queued' })} title="Remettre en file"><Play size={14} /></button>
          )}
          {!executing && (
            <button className={`${iconBtn} hover:text-rose-600`} data-testid="travaux-delete" onClick={() => onDelete(p.id)} title="Retirer"><Trash2 size={14} /></button>
          )}
        </div>
      </div>

      {open && (
        <div className="border-t border-slate-100 px-3 py-3 space-y-3">
          {/* Fil de discussion : chaque compte-rendu y est versé, et une réponse
              relance l'exécution avec le fil en contexte. `user_summary` seul ne
              s'affiche que pour les items d'avant le fil. */}
          {messages.length ? (
            <div className="space-y-2">
              {hidden > 0 && (
                <button
                  className="text-xs text-slate-500 hover:text-slate-700 inline-flex items-center gap-1"
                  data-testid="travaux-show-thread"
                  onClick={() => setShowWholeThread(true)}
                ><ChevronUp size={12} /> Afficher les {hidden} message{hidden > 1 ? 's' : ''} précédent{hidden > 1 ? 's' : ''}</button>
              )}
              {shownMessages.map(m => <ThreadMessage key={m.id} m={m} />)}
            </div>
          ) : p.user_summary ? (
            <div className="text-sm text-slate-600 whitespace-pre-wrap bg-slate-50 rounded-lg px-3 py-2">{p.user_summary}</div>
          ) : null}

          {/* Question de Claude : le texte est déjà dans le fil (dernier message), on
              n'affiche donc ici que les choix — un clic répond et relance la tâche. */}
          {asking && <QuestionChoices p={p} onAnswer={opt => onReply(p.id, opt)} />}

          {['done', 'blocked'].includes(p.status) && <ReplyBox onSend={(text, placement) => onReply(p.id, text, placement)} autoFocus={focusReply} />}

          {/* Steering : on peut parler à Claude PENDANT qu'il travaille (ou pendant
              que la tâche attend son tour) — le message est pris en compte en cours
              de tâche, rien n'est interrompu. */}
          {(executing || waiting) && (
            <SteerBox onSend={text => onSteer(p.id, text)} executing={executing} autoFocus={focusReply} />
          )}
          {waiting && (
            <p className="text-xs text-amber-600 inline-flex items-center gap-1">
              <Hourglass size={11} />
              {p.wait_rank > 1
                ? `Pas encore démarrée — ${p.wait_rank - 1} tâche${p.wait_rank > 2 ? 's' : ''} à finir avant celle-ci. Le prompt et l'ordre restent modifiables.`
                : 'Pas encore démarrée — elle part dès que le poste se libère. Le prompt et l\'ordre restent modifiables.'}
            </p>
          )}

          <div>
            <div className="text-[11px] uppercase tracking-wide text-slate-400 mb-1">
              {editable ? 'Prompt envoyé — modifiable tant que ça n\'a pas démarré' : 'Prompt envoyé'}
            </div>
            {editable ? (
              <textarea
                data-testid="travaux-prompt-input"
                className={`${inputCls} w-full font-mono text-xs`}
                rows={8}
                value={draft.prompt}
                onChange={e => edit('prompt', e.target.value)}
                onBlur={flush}
              />
            ) : (
              <pre className="text-xs text-slate-600 whitespace-pre-wrap font-mono bg-slate-50 rounded-lg p-3">{p.prompt}</pre>
            )}
          </div>

          {editable && (
            <div className="flex items-center gap-3 flex-wrap">
              <PresetSelect p={p} onPatch={onPatch} />
              <select className={inputCls} value={p.mode} onChange={e => onPatch(p.id, { mode: e.target.value })}>
                <option value="implement">Implémenter</option>
                <option value="question">Question (lecture seule, en parallèle)</option>
              </select>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Composeur replié : un champ d'une ligne, qui s'ouvre au clic. */
function NewPromptComposer({ agentEnabled, onCreate }) {
  const [open, setOpen] = useState(false)
  // Préréglage « auto » par défaut : le calibre est jugé du prompt côté serveur.
  const [form, setForm] = useState({ prompt: '', mode: 'implement', preset: 'auto', priority: false })
  const [saving, setSaving] = useState(false)
  const ref = useRef(null)

  const start = () => { setOpen(true); setTimeout(() => ref.current?.focus(), 30) }
  // Création : pas d'autosave possible (aucun id avant l'envoi) — voir CLAUDE.md.
  // `status` distingue les deux dépôts : « queued » part tout seul quand son tour
  // vient, « paused » est rangé de côté et n'ira nulle part sans un geste de plus.
  const add = async (status = 'queued') => {
    if (!form.prompt.trim()) return
    setSaving(status)
    try {
      await onCreate({ ...form, status, ...(status === 'paused' ? { priority: false } : {}) })
      setForm({ prompt: '', mode: 'implement', preset: 'auto', priority: false })
      setOpen(false)
    } finally { setSaving(false) }
  }

  if (!open) {
    return (
      <button
        className="w-full flex items-center gap-2 rounded-xl border border-dashed border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-500 hover:border-brand-400 hover:text-brand-700 mb-3"
        onClick={start}
        data-testid="travaux-new-prompt"
      >
        <Plus size={15} /> Nouveau prompt…
        {!agentEnabled && (
          <span className="ml-auto inline-flex items-center gap-1 text-xs text-amber-700">
            <AlertTriangle size={12} /> Agent désactivé
          </span>
        )}
      </button>
    )
  }

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 mb-3">
      <div className="flex items-center justify-between gap-3 mb-3">
        <div className="text-sm font-semibold text-slate-800">Nouveau prompt</div>
        <div className="text-xs text-slate-500">
          {agentEnabled
            ? <span className="inline-flex items-center gap-1 text-emerald-700"><CheckCircle2 size={12} /> Agent actif</span>
            : <span className="inline-flex items-center gap-1 text-amber-700"><AlertTriangle size={12} /> Agent désactivé — rien ne s'exécutera</span>}
        </div>
      </div>
      <textarea
        ref={ref}
        className={`${inputCls} w-full`}
        rows={4}
        placeholder="Décris la tâche comme tu me l'écrirais dans le terminal…"
        value={form.prompt}
        onChange={e => setForm(f => ({ ...f, prompt: e.target.value }))}
      />
      <div className="flex items-center gap-3 mt-3 flex-wrap">
        {/* Pas de champ titre à la création : il est déduit du prompt côté serveur
            (heuristique immédiate, puis titre modèle en quelques secondes). Il
            reste modifiable après coup sur la carte. */}
        {/* Pas de sélecteur de calibre à la création : il vaut toujours « auto »,
            le calibre est jugé côté serveur d'après la demande. Il reste
            modifiable après coup sur la carte (PresetSelect) pour le figer. */}
        <select className={inputCls} value={form.mode} onChange={e => setForm(f => ({ ...f, mode: e.target.value }))}>
          <option value="implement">Implémenter</option>
          <option value="question">Question (lecture seule, en parallèle)</option>
        </select>
        {/* Début ou fin de la file, décidé dès la création — même effet que le
            bouton « Passer en premier » d'une carte, sans avoir à le cliquer
            après coup. Contrôle partagé avec le panneau rapide et le FAB. */}
        <PlacementToggle
          testId="travaux-new-priority"
          value={form.priority ? 'first' : 'last'}
          onChange={v => setForm(f => ({ ...f, priority: v === 'first' }))}
        />
        <button className={btnCls} onClick={() => setOpen(false)}>Annuler</button>
        {/* Déposer sans lancer : la demande est écrite tant qu'elle est fraîche,
            mais elle attend dans « De côté & idées » — utile quand la file du jour
            est déjà pleine, ou quand la demande doit mûrir avant de partir. */}
        <button
          className={btnCls} data-testid="travaux-new-aside"
          onClick={() => add('paused')} disabled={!!saving || !form.prompt.trim()}
          title="Déposer la demande sans la mettre en file — elle attendra dans « De côté & idées », rien ne démarrera"
        >
          {saving === 'paused' ? <Loader2 size={14} className="animate-spin" /> : <PauseCircle size={14} />} Mettre de côté
        </button>
        <button className={btnPrimary} data-testid="travaux-new-submit" onClick={() => add('queued')} disabled={!!saving || !form.prompt.trim()}>
          {saving === 'queued' ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Ajouter à la file
        </button>
      </div>
    </div>
  )
}

// Combien de conversations terminées on rend d'emblée : au-delà, un bouton. Le fil
// complet de chacune est de toute façon replié, mais rendre 200 cartes coûte cher.
const HISTORY_PAGE = 15

/**
 * Actions d'une carte de file (modifier, retirer, passer en premier, répondre,
 * parler en cours de tâche). Extraites de la vue « File » parce que la section
 * « De côté » rend exactement les mêmes cartes : une seule implémentation, deux
 * points d'entrée — comme pour la lecture (useTravauxPrompts).
 */
function usePromptActions({ load, dropPrompt, undropPrompt, liftPrompt, unliftPrompt, toast, queuePaused = false }) {
  // Renvoie la ligne serveur : l'autosave des cartes s'en sert pour savoir si sa
  // frappe est bien arrivée (et accepter une normalisation côté serveur).
  const patch = useCallback(async (id, p) => {
    try {
      const row = await api.travaux.updatePrompt(id, p)
      load()
      return row
    } catch (e) { toast.error(e.message); return null }
  }, [load, toast])
  // Un seul clic sur la corbeille = la carte part, tout de suite et pour de bon.
  // Attendre la suppression PUIS le rechargement (la réponse de la file pèse ~285 Ko :
  // tout l'historique et ses fils) laissait la corbeille sans effet visible une bonne
  // seconde ; et un chargement déjà en vol pouvait ensuite remettre la ligne à l'écran.
  // `dropPrompt` règle les deux : retrait immédiat + filtrage des réponses en retard.
  // Un échec lève la pierre tombale (la carte revient) en plus du toast d'erreur.
  const remove = useCallback(async (id) => {
    dropPrompt?.(id)
    try { await api.travaux.deletePrompt(id); load() }
    catch (e) { toast.error(e.message); undropPrompt?.(id); load() }
  }, [load, dropPrompt, undropPrompt, toast])
  // Un clic sur « Passer en premier » = la carte est en tête, tout de suite. Attendre
  // le serveur PUIS le rechargement de la file laissait le bouton sans effet visible
  // pendant près d'une seconde — même symptôme que la corbeille, même remède :
  // `liftPrompt` joue le mouvement localement (celui que le serveur va appliquer) et
  // le tient jusqu'à la confirmation, y compris face à une liste en vol.
  const first = useCallback(async (id) => {
    liftPrompt?.(id)
    try { await api.travaux.promptFirst(id) }
    catch (e) { toast.error(e.message) }
    finally { await load(); unliftPrompt?.(id) }
  }, [load, liftPrompt, unliftPrompt, toast])

  // Répondre relance la tâche : le fil est réinjecté dans le prompt, et la session
  // Claude précédente est reprise quand elle existe encore. `placement` : 'front'
  // (défaut) = repart tout de suite ; 'back' = retourne en fin de file.
  const reply = useCallback(async (id, text, placement = 'front') => {
    try {
      await api.travaux.replyToPrompt(id, text, placement)
      // En pause, la relance est bien enregistrée mais ne démarrera qu'à la reprise :
      // le dire évite d'attendre devant une carte qui ne bouge pas.
      toast.success(queuePaused
        ? 'Réponse enregistrée — la file est en pause, la tâche repartira à la reprise'
        : placement === 'back'
          ? 'Réponse enregistrée — la tâche retourne en fin de file'
          : 'Réponse envoyée — la tâche repart')
      load()
    } catch (e) { toast.error(e.message); throw e }
  }, [queuePaused, load, toast])

  // Steering : message glissé à Claude PENDANT l'exécution (rien n'est relancé).
  // `delivered` distingue la voie : en direct (hook) ou intégré au brief au départ.
  const steer = useCallback(async (id, text) => {
    try {
      const out = await api.travaux.steerPrompt(id, text)
      toast.success(out.delivered === 'live'
        ? 'Message transmis — Claude le prend en compte sans interrompre la tâche'
        : 'Message noté — il partira avec la tâche au démarrage')
      load()
    } catch (e) { toast.error(e.message); throw e }
  }, [load, toast])

  return useMemo(() => ({ patch, remove, first, reply, steer }), [patch, remove, first, reply, steer])
}

// `noComposer` : masque le dépôt « Nouveau prompt… ». Utilisé par l'encart de
// /agent, qui n'affiche que la file — le dépôt s'y fait par le FAB « Modifier le
// système » ou sur la page /agent/travaux.
export function QueueTab({ toast, space, noComposer }) {
  const [view, setView] = useState('file')
  const [search, setSearch] = useState('')
  const [historyLimit, setHistoryLimit] = useState(HISTORY_PAGE)

  // On charge les DEUX files (pas de filtre `space` côté serveur). La vue « File »
  // ne montre que celle de la page (les deux ordres sont indépendants), mais la vue
  // « Conversations » les réunit : une tâche terminée ne doit jamais rester
  // invisible parce qu'elle a été lancée depuis l'autre section (typiquement une
  // suggestion acceptée depuis /agent alors qu'on la cherche dans /travaux — les
  // suggestions, elles, sont partagées entre les deux sections).
  // Chargement, temps réel et garde-frappe : lib/travauxQueue.jsx (partagé avec le
  // panneau rapide accessible depuis toute l'app).
  const onLoadError = useCallback(e => toast.error(e.message), [toast])
  const { data, setData, loading, load, flushStale, dropPrompt, undropPrompt, liftPrompt, unliftPrompt } = useTravauxPrompts({ onError: onLoadError })

  // « running » côté DB couvre deux réalités : l'item que Claude traite vraiment et
  // celui qui attend son tour chez l'ordonnanceur. On les sépare pour l'affichage,
  // en gardant les vrais « en cours » en tête de liste.
  // Un item qui attend une réponse sort de l'historique et passe tout en haut : c'est
  // le seul état où le travail est arrêté par nous, pas par l'agent.
  const { asking, executing, waiting, queuedList, pausedList, history } = useMemo(() => {
    // Vue « File » : seulement la file de cette page (l'ordre lui est propre).
    // Vue « Conversations » : les deux files, pour qu'un travail terminé soit
    // toujours retrouvable là où l'utilisateur le cherche.
    // Ligne sans `space` (fixture, ancienne réponse en cache) : on la garde dans la
    // file courante plutôt que de la faire disparaître.
    const mine = data.prompts.filter(p => !p.space || p.space === space)
    const running = mine.filter(p => p.status === 'running')
    return {
      asking: mine.filter(isAsking),
      executing: running.filter(p => p.run_state === 'executing'),
      waiting: running.filter(p => p.run_state !== 'executing'),
      queuedList: mine.filter(p => p.status === 'queued'),
      pausedList: mine.filter(p => p.status === 'paused'),
      // Les conversations se lisent de la PLUS RÉCEMMENT terminée à la plus ancienne.
      // L'ordre du serveur (position dans la file, puis date de création) n'a aucun
      // sens ici : une tâche qui vient de finir se retrouvait enfouie au milieu de
      // l'historique — hors des 15 premières affichées, donc introuvable.
      history: data.prompts
        .filter(p => ['done', 'blocked', 'cancelled'].includes(p.status) && !isAsking(p))
        .sort((a, b) => String(b.completed_at || b.started_at || b.created_at || '')
          .localeCompare(String(a.completed_at || a.started_at || a.created_at || ''))),
    }
  }, [data.prompts, space])

  const matches = useCallback((p) => {
    const q = search.trim().toLowerCase()
    if (!q) return true
    return [p.title, p.prompt, ...(p.messages || []).map(m => m.text)]
      .some(t => String(t || '').toLowerCase().includes(q))
  }, [search])

  // L'exécuteur est PARTAGÉ entre les deux files (une implémentation à la fois) : ce
  // qui tourne dans l'autre section bloque aussi celle-ci. On montre donc ses items
  // actifs — en cours, en attente de slot, ou en attente d'une réponse — en tête de
  // file, badgés et non réordonnables (les positions sont propres à chaque file).
  const otherActive = useMemo(() => {
    const rank = p => (p.run_state === 'executing' ? 0 : isAsking(p) ? 1 : 2)
    return data.prompts
      .filter(p => p.space && p.space !== space && (p.status === 'running' || isAsking(p)))
      .sort((a, b) => rank(a) - rank(b))
  }, [data.prompts, space])

  const fileList = useMemo(
    () => [...asking, ...executing, ...otherActive, ...waiting, ...queuedList, ...pausedList].filter(matches),
    [asking, executing, otherActive, waiting, queuedList, pausedList, matches])
  const historyList = useMemo(() => history.filter(matches), [history, matches])

  const create = async (form) => {
    try {
      await api.travaux.createPrompt({ ...form, space })
      // Dépôt « de côté » : le dire, sinon l'item semble s'être évaporé (il n'est
      // pas dans la file, il attend dans l'autre onglet).
      if (form.status === 'paused') toast.success('Mis de côté — retrouve-le dans l\'onglet « De côté & idées »')
      load()
    } catch (e) { toast.error(e.message); throw e }
  }

  const { patch, remove, first, reply, steer } = usePromptActions({ load, dropPrompt, undropPrompt, liftPrompt, unliftPrompt, toast, queuePaused: data.queue_paused })

  // ── Priorité : réordonner la file ──────────────────────────────────────────
  // Seule une exécution RÉELLEMENT en cours est intouchable. Les items « en
  // attente » (remis à l'ordonnanceur, pas encore démarrés) se réordonnent avec
  // ceux de la file — le serveur les lui reprend et les lui rend dans le nouvel
  // ordre. Deux groupes, chacun réordonnable en son sein : « en file » (attente +
  // file) et « de côté » — le serveur trie toujours la file avant les items de
  // côté, un glissement d'un groupe à l'autre reviendrait en place.
  const groupIds = useMemo(() => ({
    queued: [...waiting, ...queuedList].map(p => p.id),
    paused: pausedList.map(p => p.id),
  }), [waiting, queuedList, pausedList])
  const groupOf = useCallback((id) => (
    groupIds.queued.includes(id) ? 'queued' : groupIds.paused.includes(id) ? 'paused' : null
  ), [groupIds])

  const applyOrder = useCallback(async (group, ids) => {
    if (ids.every((id, i) => id === groupIds[group][i])) return
    const ordered = group === 'queued' ? [...ids, ...groupIds.paused] : [...groupIds.queued, ...ids]
    const slots = new Set(ordered)
    // Optimiste : la carte bouge tout de suite, le serveur confirme derrière. Les
    // items déplaçables reprennent leurs propres emplacements dans le tableau,
    // dans le nouvel ordre — les autres cartes ne bronchent pas.
    setData(d => {
      const moved = ordered.map(id => d.prompts.find(p => p.id === id)).filter(Boolean)
      let i = 0
      return { ...d, prompts: d.prompts.map(p => (slots.has(p.id) ? moved[i++] : p)) }
    })
    try {
      await api.travaux.reorderPrompts(executing.map(p => p.id).concat(ordered))
    } catch (e) { toast.error(e.message) }
    load()
  }, [groupIds, executing, load, setData, toast])

  const siblingsOf = useCallback((id) => groupIds[groupOf(id)] || null, [groupIds, groupOf])
  const applyGroupOrder = useCallback((ids, id) => applyOrder(groupOf(id), ids), [applyOrder, groupOf])
  const dnd = useReorderDnd({ siblingsOf, applyOrder: applyGroupOrder })
  const advance = async () => {
    try {
      const { started, startedCount, reason } = await api.travaux.advanceQueue()
      if (startedCount > 1) toast.success(`${startedCount} items démarrés`)
      else if (started) toast.success(`« ${started.title} » démarré`)
      else if (reason === 'queue-paused') toast.error('La file est en pause — reprends-la avec le bouton en haut de page')
      else if (reason === 'agent-disabled') toast.error("L'agent est désactivé — activez-le sur la page Agent")
      else if (reason === 'busy') toast.info('Tout ce qui pouvait démarrer tourne déjà')
      else toast.info('Rien à lancer : la file est vide')
      load()
    } catch (e) { toast.error(e.message) }
  }

  const rowProps = { onPatch: patch, onDelete: remove, onFirst: first, onReply: reply, onSteer: steer, space }
  const seg = (active) => `inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg transition ${
    active ? 'bg-white text-slate-900 shadow-sm ring-1 ring-slate-200' : 'text-slate-500 hover:text-slate-800'}`

  return (
    <div>
      {/* Pause en cours : le dire ici aussi (le bouton est en haut de page), sinon une
          file qui n'avance pas ressemble à une panne. */}
      {data.queue_paused && (
        <div
          className="mb-4 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800"
          data-testid="travaux-queue-paused-banner"
        >
          <PauseCircle size={16} className="mt-0.5 shrink-0" />
          <div>
            <div className="font-medium">File en pause — aucune nouvelle tâche ne démarre.</div>
            <div className="text-xs text-amber-700/90 mt-0.5">
              {data.queue_paused_reason || 'Pause posée à la main.'} La tâche en cours va au bout ;
              à la reprise, la file repart exactement où elle s'est arrêtée — rien n'est refait.
            </div>
          </div>
        </div>
      )}

      {!noComposer && <NewPromptComposer agentEnabled={data.agent_enabled} onCreate={create} />}

      {/* Barre de navigation : deux vues, comptées, et une recherche. Elle colle en
          haut pour rester accessible sans remonter toute la liste. */}
      <div className="sticky top-0 z-10 -mx-1 px-1 py-2 bg-slate-50/95 backdrop-blur-sm">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="inline-flex items-center gap-1 p-1 rounded-xl bg-slate-100">
            <button className={seg(view === 'file')} data-testid="travaux-view-file" onClick={() => setView('file')}>
              <ListOrdered size={14} /> File
              <span className="text-xs text-slate-400">{asking.length + executing.length + waiting.length + queuedList.length + pausedList.length}</span>
            </button>
            <button className={seg(view === 'conversations')} data-testid="travaux-view-conversations" onClick={() => setView('conversations')}>
              <MessageSquare size={14} /> Conversations
              <span className="text-xs text-slate-400">{history.length}</span>
            </button>
          </div>

          {!!asking.length && view !== 'file' && (
            <button
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-violet-50 text-violet-700 border border-violet-200 hover:bg-violet-100"
              onClick={() => setView('file')}
            ><HelpCircle size={13} /> {asking.length} à répondre</button>
          )}

          <div className="flex-1" />

          <input
            className={`${inputCls} w-44`}
            placeholder="Rechercher…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            data-testid="travaux-search"
          />
          {view === 'file' && (
            <>
              {/* Les questions étant en lecture seule, elles tournent à plusieurs et en
                  même temps qu'un chantier : le bouton reste actif tant qu'il reste
                  quelque chose de démarrable. */}
              {data.running_questions > 0 && (
                <span className="text-xs text-slate-500">
                  {data.running_questions}/{data.max_parallel_questions} question{data.running_questions > 1 ? 's' : ''} en parallèle
                </span>
              )}
              <button
                className={btnCls}
                onClick={advance}
                disabled={data.queue_paused || !queuedList.length}
                title={data.queue_paused ? 'File en pause — reprends-la avec le bouton en haut de page' : undefined}
              >
                <Play size={14} /> Lancer la file
              </button>
            </>
          )}
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-slate-500 flex items-center gap-2 mt-3"><Loader2 size={14} className="animate-spin" /> Chargement…</div>
      ) : search.trim() ? (
        // Une recherche cherche dans les deux sections à la fois : peu importe
        // l'onglet affiché, on ne veut jamais rater un résultat rangé dans l'autre.
        <div className="space-y-4 mt-1">
          <div>
            <p className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
              <ListOrdered size={12} /> File ({fileList.length})
            </p>
            <div className="space-y-1.5">
              {fileList.map(p => (
                <PromptRow key={p.id} p={p} dnd={(!p.space || p.space === space) ? dnd : undefined} {...rowProps} />
              ))}
              {!fileList.length && (
                <div className="text-sm text-slate-500 rounded-xl border border-dashed border-slate-200 p-4 text-center">
                  Aucun item ne correspond à cette recherche.
                </div>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
              <MessageSquare size={12} /> Conversations ({historyList.length})
            </p>
            <div className="space-y-1.5">
              {historyList.slice(0, historyLimit).map(p => <PromptRow key={p.id} p={p} {...rowProps} />)}
              {!historyList.length && (
                <div className="text-sm text-slate-500 rounded-xl border border-dashed border-slate-200 p-4 text-center">
                  Aucune conversation ne correspond à cette recherche.
                </div>
              )}
              {historyList.length > historyLimit && (
                <button className={`${btnCls} w-full justify-center`} onClick={() => setHistoryLimit(n => n + HISTORY_PAGE)}>
                  Afficher {Math.min(HISTORY_PAGE, historyList.length - historyLimit)} conversations de plus
                  <span className="text-slate-400">· {historyList.length - historyLimit} restantes</span>
                </button>
              )}
            </div>
          </div>
        </div>
      ) : view === 'file' ? (
        <div
          className="space-y-1.5 mt-1"
          onDragEnd={dnd.dragEnd}
          onBlur={flushStale}
        >
          {/* Un item de l'AUTRE file ne se réordonne pas ici : les positions sont
              propres à chaque file. Il est là pour dire ce qui occupe l'exécuteur. */}
          {fileList.map(p => (
            <PromptRow key={p.id} p={p} dnd={(!p.space || p.space === space) ? dnd : undefined} {...rowProps} />
          ))}
          {!fileList.length && (
            <div className="text-sm text-slate-500 rounded-xl border border-dashed border-slate-200 p-6 text-center">
              File vide. Ajoute un prompt ci-dessus — il partira tout seul.
            </div>
          )}
          {groupIds.queued.length > 1 && (
            <p className="text-xs text-slate-400 pt-1">
              L'ordre de la liste = l'ordre de départ. Glisse une carte par sa poignée, ou utilise les flèches.
              Tant qu'un item n'a pas démarré, son prompt et sa place restent modifiables — même s'il est déjà remis à l'agent.
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-1.5 mt-1">
          {historyList.slice(0, historyLimit).map(p => <PromptRow key={p.id} p={p} {...rowProps} />)}
          {!historyList.length && (
            <div className="text-sm text-slate-500 rounded-xl border border-dashed border-slate-200 p-6 text-center">
              Aucune tâche terminée pour l'instant.
            </div>
          )}
          {historyList.length > historyLimit && (
            <button className={`${btnCls} w-full justify-center`} onClick={() => setHistoryLimit(n => n + HISTORY_PAGE)}>
              Afficher {Math.min(HISTORY_PAGE, historyList.length - historyLimit)} conversations de plus
              <span className="text-slate-400">· {historyList.length - historyLimit} restantes</span>
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Onglet 2 : suggestions de l'agent ────────────────────────────────────────

/**
 * Discussion d'une suggestion — « dis-m'en plus » avant de décider.
 *
 * Même fil que la file (mêmes bulles), mais rien ne s'exécute d'ici : Claude
 * répond sans outils, en parallèle d'une éventuelle implémentation en cours. Le
 * fil est chargé à l'ouverture (pas avec la liste : une suggestion sur dix est
 * discutée) et se rafraîchit quand la réponse arrive, par la diffusion temps réel.
 */
function SuggestionChat({ s }) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([])
  const [pending, setPending] = useState(!!s.chat_pending)
  const [loading, setLoading] = useState(false)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)
  const count = messages.length || s.message_count || 0

  const load = useCallback(async () => {
    try {
      const r = await api.travaux.listSuggestionMessages(s.id)
      setMessages(r.messages || [])
      setPending(!!r.pending)
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [s.id])

  useEffect(() => {
    if (!open) return
    setLoading(true)
    load()
  }, [open, load])

  // La réponse de Claude arrive de façon asynchrone : le serveur diffuse l'id de
  // la suggestion concernée, on ne recharge que le fil ouvert qui la porte.
  useEffect(() => {
    if (!open) return
    const onEvt = e => { if (e.detail?.suggestion_id === s.id) load() }
    window.addEventListener('travaux:suggestion:messages', onEvt)
    return () => window.removeEventListener('travaux:suggestion:messages', onEvt)
  }, [open, s.id, load])

  const send = async () => {
    const t = text.trim()
    if (!t || sending) return
    setSending(true)
    setError(null)
    try {
      const r = await api.travaux.askSuggestion(s.id, t)
      setMessages(r.messages || [])
      setPending(true)
      setText('')
    } catch (e) { setError(e.message) }
    finally { setSending(false) }
  }

  return (
    <div className="mt-2">
      <button
        className="text-xs text-slate-500 hover:text-slate-700 inline-flex items-center gap-1"
        data-testid="suggestion-chat-toggle"
        onClick={() => setOpen(o => !o)}
      >
        <MessageSquare size={12} />
        {open ? 'Masquer la discussion' : 'Discuter avec Claude'}
        {count > 0 && <span className="text-slate-400" data-testid="suggestion-chat-count">· {count}</span>}
        {!open && pending && <Loader2 size={11} className="animate-spin text-slate-400" />}
      </button>

      {open && (
        <div className="mt-2 space-y-2" data-testid="suggestion-chat">
          {loading ? (
            <div className="text-xs text-slate-500 inline-flex items-center gap-1.5"><Loader2 size={12} className="animate-spin" /> Chargement du fil…</div>
          ) : messages.length ? (
            <div className="space-y-2" data-testid="suggestion-chat-thread">
              {messages.map(m => <ThreadMessage key={m.id} m={m} />)}
            </div>
          ) : (
            <p className="text-xs text-slate-400">
              Pose une question sur cette {s.kind === 'integration' ? 'intégration' : 'suggestion'} — ce que ça changerait,
              par quoi commencer, ce qu'elle suppose. Rien ne s'exécute : c'est une discussion.
            </p>
          )}

          {pending && (
            <div className="text-xs text-slate-500 inline-flex items-center gap-1.5" data-testid="suggestion-chat-pending">
              <Loader2 size={12} className="animate-spin" /> Claude réfléchit…
            </div>
          )}
          {error && <p className="text-xs text-red-600" data-testid="suggestion-chat-error">{error}</p>}

          {/* Bouton assumé (pas d'autosave) : envoyer une question déclenche un
              appel réel au modèle — voir la règle « autosave partout ». */}
          <div className="flex items-end gap-2">
            <textarea
              className={`${inputCls} flex-1 text-sm`}
              data-testid="suggestion-chat-input"
              rows={2}
              placeholder="Dis-m'en plus… (⌘/Ctrl + Entrée pour envoyer)"
              value={text}
              onChange={e => setText(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send() }}
            />
            <button
              className={btnPrimary}
              data-testid="suggestion-chat-send"
              onClick={send}
              disabled={sending || !text.trim()}
              title="Poser la question à Claude"
            >
              {sending ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

function SuggestionCard({ s, onAccept, onDismiss }) {
  const [open, setOpen] = useState(false)
  const [prompt, setPrompt] = useState(s.prompt)
  useEffect(() => { setPrompt(s.prompt) }, [s.prompt])

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3.5">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            {s.kind === 'integration' && (
              <span className="px-2 py-0.5 text-xs rounded-full bg-indigo-50 text-indigo-700 inline-flex items-center gap-1">
                <Plug size={11} /> Intégration
              </span>
            )}
            {s.status === 'accepted' && <span className="px-2 py-0.5 text-xs rounded-full bg-emerald-50 text-emerald-700">Dans ma file</span>}
            {s.status === 'dismissed' && <span className="px-2 py-0.5 text-xs rounded-full bg-slate-100 text-slate-500">Rejetée</span>}
          </div>
          <div className="mt-1.5 text-sm font-medium text-slate-800">{s.title}</div>
          {s.rationale && <p className="mt-1 text-sm text-slate-600">{s.rationale}</p>}
          <button className="mt-2 text-xs text-slate-500 hover:text-slate-700 inline-flex items-center gap-1" onClick={() => setOpen(o => !o)}>
            <ChevronDown size={12} className={open ? 'rotate-180 transition' : 'transition'} />
            {open ? 'Masquer le prompt' : 'Voir / ajuster le prompt'}
          </button>
          {open && (
            <textarea className={`${inputCls} w-full mt-2 font-mono text-xs`} rows={8} value={prompt} onChange={e => setPrompt(e.target.value)} />
          )}
          {/* Discussion : disponible pour toute suggestion, chantier ou intégration,
              y compris une fois promue ou rejetée (on peut vouloir comprendre après coup). */}
          <SuggestionChat s={s} />
        </div>
        {/* Promouvoir = déposer un prompt dans « Ma file », exactement comme un
            prompt saisi à la main : à la suite, ou devant tout le reste. La carte
            quitte alors cet onglet — elle se pilote depuis la file (pastille
            « Claude · … »), là où vivent déjà pause, réordonnancement et retrait. */}
        {s.status === 'new' && (
          <div className="flex flex-col gap-1.5 shrink-0">
            <button className={btnPrimary} data-testid="suggestion-accept-last" onClick={() => onAccept(s.id, prompt !== s.prompt ? prompt : null, false)} title="Ajouter à la fin de ma file">
              <Check size={14} /> Ajouter à la fin
            </button>
            <button className={btnCls} data-testid="suggestion-accept-first" onClick={() => onAccept(s.id, prompt !== s.prompt ? prompt : null, true)} title="Ajouter en tête de file — partira avant tout le reste">
              <ChevronsUp size={14} /> En premier
            </button>
            <button className={btnCls} onClick={() => onDismiss(s.id)}><X size={14} /> Rejeter</button>
          </div>
        )}
      </div>
    </div>
  )
}

// Deux natures de suggestions dans la même liste : un chantier à faire dans l'ERP
// tel qu'il est, ou un outil externe à brancher. Le filtre pilote AUSSI le bouton
// « Générer » — on relance le moteur qu'on est en train de regarder.
const SUGGESTION_KINDS = [['', 'Tout'], ['chantier', 'Chantiers'], ['integration', 'Intégrations']]

// Domaines métier — même liste et même ordre que SUGGESTION_AREAS côté serveur
// (server/src/services/workSuggestions.js), dupliquée ici comme SUGGESTION_KINDS
// ci-dessus. Sert à ranger les suggestions en sous-sections : l'utilisateur veut
// voir d'un coup d'œil ce qui touche les ventes, la logistique, la comptabilité…
const AREA_ORDER = ['ventes', 'logistique', 'comptabilite', 'rh', 'marketing', 'technique', 'support']
const AREA_LABELS = {
  ventes: 'Ventes', logistique: 'Logistique', comptabilite: 'Comptabilité',
  rh: 'RH', marketing: 'Marketing', technique: 'Technique', support: 'Support',
}
const areaOf = s => (AREA_ORDER.includes(s.area) ? s.area : 'technique')
function groupSuggestionsByArea(suggestions) {
  const byArea = new Map()
  for (const s of suggestions) {
    const area = areaOf(s)
    if (!byArea.has(area)) byArea.set(area, [])
    byArea.get(area).push(s)
  }
  return AREA_ORDER
    .map(area => ({ area, label: AREA_LABELS[area], items: byArea.get(area) || [] }))
    .filter(g => g.items.length > 0)
}

function SuggestionsTab({ toast, space }) {
  const [suggestions, setSuggestions] = useState([])
  const [status, setStatus] = useState('new')
  const [kind, setKind] = useState('')
  // Domaine métier sélectionné ('' = tous). Filtre purement client : la liste
  // tient en mémoire, et garder les suggestions non filtrées permet d'afficher
  // le compte de chaque domaine sur ses pastilles.
  const [area, setArea] = useState('')
  const [loading, setLoading] = useState(true)
  const [generating, setGenerating] = useState(false)

  const load = useCallback(async () => {
    try {
      const { suggestions } = await api.travaux.listSuggestions({
        ...(status ? { status } : {}),
        ...(kind ? { kind } : {}),
      })
      setSuggestions(suggestions)
    } catch (e) { toast.error(e.message) }
    finally { setLoading(false) }
  }, [status, kind, toast])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const onEvt = () => { setGenerating(false); load() }
    window.addEventListener('travaux:suggestions:updated', onEvt)
    return () => window.removeEventListener('travaux:suggestions:updated', onEvt)
  }, [load])

  const generate = async () => {
    setGenerating(true)
    try {
      await api.travaux.generateSuggestions(kind || null)
      toast.info(kind === 'integration'
        ? 'Recherche d\'outils à brancher lancée — les propositions apparaîtront ici'
        : 'Analyse lancée — les suggestions apparaîtront ici')
    } catch (e) { setGenerating(false); toast.error(e.message) }
  }
  const accept = async (id, prompt, priority = false) => {
    try {
      await api.travaux.acceptSuggestion(id, prompt, space, priority)
      toast.success(priority ? 'Ajoutée en tête de ta file' : 'Ajoutée à la fin de ta file')
      load()   // la file, elle, se met à jour par la diffusion temps réel du dépôt
    } catch (e) { toast.error(e.message) }
  }
  const dismiss = async (id) => {
    try { await api.travaux.dismissSuggestion(id); load() } catch (e) { toast.error(e.message) }
  }

  // Pastilles de domaine : on n'affiche que les domaines réellement présents dans
  // la liste courante — plus celui qui est sélectionné, pour qu'il ne disparaisse
  // pas sous le doigt quand on change de statut ou de nature.
  const areaCounts = suggestions.reduce((acc, s) => {
    const a = areaOf(s)
    acc[a] = (acc[a] || 0) + 1
    return acc
  }, {})
  const areaChips = AREA_ORDER.filter(a => areaCounts[a] || a === area)
  const visible = area ? suggestions.filter(s => areaOf(s) === area) : suggestions

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          {/* Pas de section « Dans ma file » : une suggestion ajoutée EST un item de
              la file, on la suit et on la pilote là-bas. */}
          {[['new', 'Nouvelles'], ['dismissed', 'Rejetées']].map(([v, l]) => (
            <button
              key={v}
              className={`px-3 py-1.5 text-sm rounded-lg ${status === v ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
              onClick={() => setStatus(v)}
            >{l}</button>
          ))}
          <span className="w-px h-5 bg-slate-200 mx-1.5" />
          {SUGGESTION_KINDS.map(([v, l]) => (
            <button
              key={v || 'all'}
              className={`px-3 py-1.5 text-sm rounded-lg inline-flex items-center gap-1.5 ${kind === v ? 'bg-indigo-600 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
              onClick={() => setKind(v)}
            >{v === 'integration' && <Plug size={13} />}{l}</button>
          ))}
        </div>
        <button
          className={btnCls}
          onClick={generate}
          disabled={generating}
          title={kind === 'integration' ? 'Chercher des outils externes à brancher'
            : kind === 'chantier' ? 'Chercher des chantiers'
              : 'Chercher des chantiers ET des outils à brancher'}
        >
          {generating ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {kind === 'integration' ? 'Chercher des intégrations' : 'Générer maintenant'}
        </button>
      </div>

      {/* Filtre par domaine : sept domaines au plus, tous visibles d'un coup — pas
          besoin de dropdown ni de recherche (règle des >10 options). */}
      {areaChips.length > 1 && (
        <div className="flex items-center gap-1.5 flex-wrap mb-4" data-testid="suggestion-area-filter">
          <button
            className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${area === '' ? 'bg-slate-900 text-white border-slate-900' : 'text-slate-600 border-slate-200 hover:bg-slate-100'}`}
            data-testid="suggestion-area-chip-all"
            aria-pressed={area === ''}
            onClick={() => setArea('')}
          >Tous les domaines <span className={area === '' ? 'text-slate-300' : 'text-slate-400'}>{suggestions.length}</span></button>
          {areaChips.map(a => (
            <button
              key={a}
              className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${area === a ? 'bg-slate-900 text-white border-slate-900' : 'text-slate-600 border-slate-200 hover:bg-slate-100'}`}
              data-testid={`suggestion-area-chip-${a}`}
              aria-pressed={area === a}
              onClick={() => setArea(area === a ? '' : a)}
            >{AREA_LABELS[a]} <span className={area === a ? 'text-slate-300' : 'text-slate-400'}>{areaCounts[a] || 0}</span></button>
          ))}
        </div>
      )}

      <p className="text-xs text-slate-500 mb-4">
        L'agent regarde chaque matin les travaux que tu fais encore à la main, les chantiers récents et les erreurs de synchronisation,
        puis propose ici les prochaines étapes. Il propose aussi des <strong className="font-medium text-slate-600">intégrations</strong> — des
        logiciels ou des API externes à brancher à l'ERP, en tenant compte de ce qui est déjà connecté — avec ce que le branchement débloquerait.
        Rien ne s'exécute avant que tu ne l'ajoutes à ta file.
      </p>

      {loading ? (
        <div className="text-sm text-slate-500 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Chargement…</div>
      ) : visible.length ? (
        <div className="space-y-6" data-testid="suggestions-by-area">
          {groupSuggestionsByArea(visible).map(({ area: a, label, items }) => (
            <div key={a} data-testid={`suggestion-area-${a}`}>
              {/* Le titre de section est lui-même le filtre : cliquer « Ventes »
                  isole les ventes, recliquer revient à tout voir. */}
              <button
                className="flex items-center gap-2 mb-2.5 group"
                data-testid={`suggestion-area-title-${a}`}
                title={area === a ? 'Revoir tous les domaines' : `Ne voir que ${label}`}
                onClick={() => setArea(area === a ? '' : a)}
              >
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500 group-hover:text-slate-900 transition-colors">{label}</h3>
                <span className="text-xs text-slate-400">{items.length}</span>
              </button>
              <div className="space-y-2.5">
                {items.map(s => (
                  <SuggestionCard key={s.id} s={s} onAccept={accept} onDismiss={dismiss} />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-sm text-slate-500 rounded-xl border border-dashed border-slate-200 p-6 text-center" data-testid="suggestions-empty">
          Aucune {kind === 'integration' ? 'intégration proposée' : 'suggestion'} {status === 'new' ? 'en attente' : ''}
          {area ? ` en ${AREA_LABELS[area]}` : ''}.
          {area && (
            <button className="ml-1.5 text-slate-700 underline underline-offset-2 hover:text-slate-900" onClick={() => setArea('')}>
              Voir tous les domaines
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Onglet 3 : de côté & idées ───────────────────────────────────────────────
//
// L'onglet de ce qui attend, en deux listes dont RIEN ne part tout seul :
//   • « De côté » — des items de file bel et bien écrits, mais rangés : mis de
//     côté depuis une carte, déposés directement de côté au composeur, ou nés
//     d'une idée passée à l'action. Ils n'existaient que tout en bas de la file,
//     là où on ne descend jamais ;
//   • « Idées » — un carnet : une idée se garde et se relit (« The Future of ERP
//     Systems » n'avait rien à faire dans la file, où tout est destiné à être
//     fait). Le passage à l'action est un geste explicite, et l'item créé arrive
//     de côté — jamais lancé d'office.
// Les deux répondent à la même question (« qu'est-ce que j'avais laissé pour plus
// tard ? »), d'où le regroupement sur un seul onglet.

/**
 * Section « De côté » : les items de file en pause, avec toutes les affordances
 * d'une carte de file (remettre en file, passer en premier, modifier, retirer).
 * On rend la MÊME carte que la file — un item de côté reste un item de file, il
 * n'a pas besoin d'un autre vocabulaire.
 */
function SetAsideSection({ toast, space }) {
  const onLoadError = useCallback(e => toast.error(e.message), [toast])
  // `activeOnly` : les items de côté font partie de la file vivante ; l'historique
  // et ses fils (plusieurs centaines de Ko) n'ont rien à faire ici.
  const { data, loading, load, flushStale, dropPrompt, undropPrompt, liftPrompt, unliftPrompt } = useTravauxPrompts({ activeOnly: true, onError: onLoadError })
  const actions = usePromptActions({ load, dropPrompt, undropPrompt, liftPrompt, unliftPrompt, toast, queuePaused: data.queue_paused })

  // Ligne sans `space` (fixture, ancienne réponse en cache) : gardée dans la
  // section courante plutôt que de disparaître — même règle que la vue File.
  const aside = useMemo(
    () => data.prompts.filter(p => p.status === 'paused' && (!p.space || p.space === space)),
    [data.prompts, space])

  // Remettre en file a un effet réel (l'item repart quand son tour vient) : on le
  // confirme, sinon la carte disparaît de la section sans qu'on sache où.
  const patch = useCallback(async (id, p) => {
    const row = await actions.patch(id, p)
    if (row && p.status === 'queued') toast.success('Remis en file — il partira à son tour')
    return row
  }, [actions, toast])

  const rowProps = {
    onPatch: patch, onDelete: actions.remove, onFirst: actions.first,
    onReply: actions.reply, onSteer: actions.steer, space,
  }

  return (
    <div data-testid="travaux-aside-section">
      <h2 className="text-sm font-semibold text-slate-800 mb-1 flex items-center gap-1.5">
        <PauseCircle size={14} className="text-amber-500" /> De côté
        <span className="text-slate-400 font-normal">· {aside.length}</span>
      </h2>
      <p className="text-xs text-slate-500 mb-3">
        Des demandes déjà écrites, mais rangées : rien ne démarre tant que tu ne les remets pas en file
        (bouton « Remettre en file » sur la carte).
      </p>

      {loading ? (
        <div className="text-sm text-slate-500 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Chargement…</div>
      ) : aside.length ? (
        <div className="space-y-1.5" data-testid="travaux-aside-list" onBlur={flushStale}>
          {aside.map(p => <PromptRow key={p.id} p={p} {...rowProps} />)}
        </div>
      ) : (
        <div className="text-sm text-slate-500 rounded-xl border border-dashed border-slate-200 p-5 text-center" data-testid="travaux-aside-empty">
          Rien de côté. « Mettre de côté » (au composeur ou sur une carte de la file) dépose ici ce qui n'est pas pour tout de suite.
        </div>
      )}
    </div>
  )
}

function isImageAttachment(att) {
  if (att.content_type && att.content_type.startsWith('image/')) return true
  return /\.(jpe?g|png|gif|webp|heic)$/i.test(att.file_name || '')
}

function attachmentUrl(entityType, entityId, attId) {
  const token = localStorage.getItem('erp_token')
  return `/erp/api/attachments/${entityType}/${entityId}/${attId}/download?token=${token}`
}

/**
 * Pièces jointes du carnet d'idées : contrairement au composant générique
 * `Attachments` (liste à télécharger), les images s'affichent directement dans
 * la carte — pas de clic requis pour les voir, un clic les agrandit en
 * lightbox (même pattern que l'aide de PrioriteAssemblage).
 */
function IdeaAttachments({ ideaId, toast }) {
  const [items, setItems] = useState([])
  const [uploading, setUploading] = useState(false)
  const [zoomSrc, setZoomSrc] = useState(null)
  const inputRef = useRef(null)

  const load = useCallback(async () => {
    try { setItems(await api.attachments.list('work_ideas', ideaId)) }
    catch (e) { toast.error(e.message) }
  }, [ideaId, toast])

  useEffect(() => { load() }, [load])

  const handleFiles = async (fileList) => {
    const files = Array.from(fileList || [])
    if (!files.length) return
    setUploading(true)
    try { await api.attachments.upload('work_ideas', ideaId, files); await load() }
    catch (e) { toast.error(e.message) }
    finally { setUploading(false); if (inputRef.current) inputRef.current.value = '' }
  }

  const remove = async (att) => {
    setItems(prev => prev.filter(x => x.id !== att.id))
    try { await api.attachments.delete('work_ideas', ideaId, att.id) }
    catch (e) { toast.error(e.message); load() }
  }

  const images = items.filter(isImageAttachment)
  const files = items.filter(a => !isImageAttachment(a))

  return (
    <div className="mt-2">
      {!!images.length && (
        <div className="flex flex-wrap gap-2 mb-2" data-testid="idea-attachment-images">
          {images.map(att => (
            <div key={att.id} className="relative group/att">
              <button
                type="button"
                onClick={() => setZoomSrc(attachmentUrl('work_ideas', ideaId, att.id))}
                className="block cursor-zoom-in"
                title="Cliquer pour agrandir"
                data-testid="idea-attachment-image"
              >
                <img
                  src={attachmentUrl('work_ideas', ideaId, att.id)}
                  alt={att.file_name}
                  className="h-20 w-20 object-cover rounded-lg border border-slate-200"
                />
              </button>
              <button
                type="button"
                className="absolute -top-1.5 -right-1.5 p-0.5 rounded-full bg-white border border-slate-200 text-slate-400 opacity-0 group-hover/att:opacity-100 hover:text-rose-600 transition"
                title="Retirer la pièce jointe"
                data-testid="idea-attachment-delete"
                onClick={() => remove(att)}
              ><X size={11} /></button>
            </div>
          ))}
        </div>
      )}
      {!!files.length && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {files.map(att => (
            <span key={att.id} className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-lg bg-slate-50 text-slate-600 border border-slate-200">
              <Paperclip size={11} />
              {att.file_name}
              <button type="button" className="text-slate-400 hover:text-rose-600" title="Retirer" onClick={() => remove(att)}><X size={11} /></button>
            </span>
          ))}
        </div>
      )}
      <input
        ref={inputRef} type="file" multiple accept="image/*,.pdf,.doc,.docx,.xls,.xlsx" className="hidden"
        data-testid="idea-attachment-input" onChange={e => handleFiles(e.target.files)}
      />
      <button
        type="button"
        className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-slate-600 disabled:opacity-50"
        onClick={() => inputRef.current?.click()}
        disabled={uploading}
        data-testid="idea-attachment-add"
      >
        {uploading ? <Loader2 size={12} className="animate-spin" /> : <Paperclip size={12} />}
        Ajouter une pièce jointe
      </button>

      {zoomSrc && (
        <div
          data-testid="idea-attachment-lightbox"
          onClick={() => setZoomSrc(null)}
          className="fixed inset-0 z-[300] flex items-center justify-center bg-black/80 p-6 cursor-zoom-out"
        >
          <img src={zoomSrc} alt="Pièce jointe agrandie" className="max-w-full max-h-full rounded-lg shadow-2xl" data-testid="idea-attachment-lightbox-img" />
        </div>
      )}
    </div>
  )
}

function IdeaCard({ idea, onPatch, onDelete, onPromote, dnd, toast }) {
  const { draft, edit, flush } = useRecordDraft(
    { title: idea.title, notes: idea.notes || '', tag: idea.tag || '' },
    patch => onPatch(idea.id, patch),
  )
  const cardRef = useRef(null)

  const movable = dnd.canMove(idea.id)
  const dropSide = (movable && dnd.dragOverId === idea.id && dnd.dragId && dnd.dragId !== idea.id) ? dnd.dragOverSide : null
  const arrow = 'p-0.5 rounded text-slate-300 hover:text-slate-700 hover:bg-slate-100 disabled:opacity-0'
  return (
    <div
      ref={cardRef}
      className={`group relative rounded-xl border border-slate-200 bg-white p-3.5 ${dnd.dragId === idea.id ? 'opacity-50' : ''}`}
      data-idea-id={idea.id}
      onDragOver={movable ? e => dnd.dragOver(e, idea.id) : undefined}
      onDrop={movable ? e => dnd.drop(e, idea.id) : undefined}
    >
      {dropSide && (
        <span className={`absolute left-2 right-2 h-0.5 bg-brand-500 rounded pointer-events-none ${dropSide === 'before' ? '-top-1' : '-bottom-1'}`} />
      )}
      <div className="flex items-start gap-2.5">
        <div className="flex flex-col items-center shrink-0 -ml-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <button className={arrow} title="Monter" aria-label="Monter" data-testid="idea-move-up"
            disabled={dnd.isFirst(idea.id)} onClick={() => dnd.move(idea.id, -1)}><ChevronUp size={14} /></button>
          {/* Glisser la carte par sa poignée : le reste de la carte n'est pas
              draggable, sinon la sélection de texte des champs deviendrait un drag. */}
          <span
            draggable={movable}
            onDragStart={e => dnd.dragStart(e, idea.id, cardRef.current)}
            onDragEnd={dnd.dragEnd}
            className="cursor-grab active:cursor-grabbing text-slate-300 hover:text-slate-500"
            title="Glisser pour déplacer l'idée"
            data-testid="idea-drag-handle"
          ><GripVertical size={13} /></span>
          <button className={arrow} title="Descendre" aria-label="Descendre" data-testid="idea-move-down"
            disabled={dnd.isLast(idea.id)} onClick={() => dnd.move(idea.id, 1)}><ChevronDown size={14} /></button>
        </div>
        <Lightbulb size={15} className="text-amber-400 mt-1.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <input
            className="w-full bg-transparent text-sm font-medium text-slate-800 border-0 p-0 focus:outline-none"
            value={draft.title}
            placeholder="Titre de l'idée"
            onChange={e => edit('title', e.target.value)}
            onBlur={flush}
          />
          <textarea
            className="w-full mt-1.5 bg-transparent text-sm text-slate-600 border-0 p-0 focus:outline-none resize-y placeholder:text-slate-300"
            rows={draft.notes ? 3 : 1}
            placeholder="Développer l'idée…"
            value={draft.notes}
            onChange={e => edit('notes', e.target.value)}
            onBlur={flush}
          />
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <input
              className="w-40 text-xs text-slate-500 bg-transparent border-0 p-0 focus:outline-none placeholder:text-slate-300"
              placeholder="thème…"
              value={draft.tag}
              onChange={e => edit('tag', e.target.value)}
              onBlur={flush}
            />
            {idea.work_prompt_id && (
              <span className="px-2 py-0.5 text-xs rounded-full bg-emerald-50 text-emerald-700">Déjà dans ma file</span>
            )}
          </div>
          <IdeaAttachments ideaId={idea.id} toast={toast} />
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <button
            className={btnCls}
            onClick={() => onPromote(idea.id)}
            title="Créer un item dans ma file, mis de côté — rien ne se lance tant que tu ne le démarres pas"
            data-testid="idea-promote"
          ><ListOrdered size={14} /> Passer à l'action</button>
          <button className={`${btnCls} text-rose-600`} onClick={() => onDelete(idea.id)} title="Retirer l'idée" data-testid="idea-delete">
            <Trash2 size={14} />
          </button>
        </div>
      </div>
    </div>
  )
}

function IdeasTab({ toast, space }) {
  const [ideas, setIdeas] = useState([])
  const [loading, setLoading] = useState(true)
  const [form, setForm] = useState({ title: '', notes: '' })
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try { setIdeas((await api.travaux.listIdeas()).ideas) }
    catch (e) { toast.error(e.message) }
    finally { setLoading(false) }
  }, [toast])

  useEffect(() => { load() }, [load])
  useEffect(() => {
    const onEvt = () => load()
    window.addEventListener('travaux:ideas:updated', onEvt)
    return () => window.removeEventListener('travaux:ideas:updated', onEvt)
  }, [load])

  // Création : pas d'autosave possible (aucun id avant l'envoi) — voir CLAUDE.md.
  const add = async () => {
    if (!form.title.trim()) return
    setSaving(true)
    try {
      await api.travaux.createIdea(form)
      setForm({ title: '', notes: '' })
      load()
    } catch (e) { toast.error(e.message) }
    finally { setSaving(false) }
  }
  const patch = async (id, p) => {
    // La ligne serveur est renvoyée : useRecordDraft s'en sert pour accepter une
    // normalisation sans écraser une frappe en cours.
    try { return await api.travaux.updateIdea(id, p) } catch (e) { toast.error(e.message); load() }
  }
  const remove = async (id) => {
    setIdeas(prev => prev.filter(x => x.id !== id))
    try { await api.travaux.deleteIdea(id) } catch (e) { toast.error(e.message); load() }
  }
  const promote = async (id) => {
    try {
      const { already } = await api.travaux.promoteIdea(id, space)
      toast.success(already
        ? 'Cette idée a déjà son item dans ta file (mis de côté)'
        : 'Ajoutée à ta file, mise de côté — démarre-la quand tu veux')
      load()
    } catch (e) { toast.error(e.message) }
  }
  // Réordonner : le carnet garde l'ordre qu'on lui donne (optimiste, le serveur
  // suit). Flèches ET glisser-déposer passent par le même chemin.
  const siblingsOf = useCallback(() => ideas.map(x => x.id), [ideas])
  const applyOrder = useCallback(async (ids) => {
    setIdeas(prev => ids.map(id => prev.find(x => x.id === id)).filter(Boolean))
    try { await api.travaux.reorderIdeas(ids) } catch (e) { toast.error(e.message); load() }
  }, [toast, load])
  const dnd = useReorderDnd({ siblingsOf, applyOrder })

  return (
    <div className="space-y-8">
      {/* Ce qui a été mis de côté vit au-dessus du carnet : c'est du travail déjà
          formulé, à un clic de repartir — les idées, elles, sont encore à mûrir. */}
      <SetAsideSection toast={toast} space={space} />

      <div data-testid="travaux-ideas-section">
      <h2 className="text-sm font-semibold text-slate-800 mb-3 flex items-center gap-1.5">
        <Lightbulb size={14} className="text-amber-400" /> Carnet d'idées
        <span className="text-slate-400 font-normal">· {ideas.length}</span>
      </h2>
      <div className="rounded-xl border border-slate-200 bg-white p-4 mb-5">
        <div className="text-sm font-semibold text-slate-800 mb-3">Nouvelle idée</div>
        <input
          className={`${inputCls} w-full`}
          placeholder="L'idée en une ligne…"
          value={form.title}
          onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) add() }}
          data-testid="idea-title-input"
        />
        <textarea
          className={`${inputCls} w-full mt-2`}
          rows={2}
          placeholder="Développer (facultatif) — pourquoi, pistes, ce que ça changerait…"
          value={form.notes}
          onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
        />
        <div className="flex items-center justify-between gap-3 mt-3 flex-wrap">
          <p className="text-xs text-slate-500">
            Rien ne s'exécute depuis les idées : elles restent là pour être relues.
          </p>
          <button className={btnPrimary} onClick={add} disabled={saving || !form.title.trim()} data-testid="idea-add">
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Garder l'idée
          </button>
        </div>
      </div>

      {loading ? (
        <div className="text-sm text-slate-500 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Chargement…</div>
      ) : ideas.length ? (
        <div className="space-y-2.5">
          {ideas.map(idea => (
            <IdeaCard
              key={idea.id} idea={idea} onPatch={patch} onDelete={remove} onPromote={promote}
              dnd={dnd} toast={toast}
            />
          ))}
        </div>
      ) : (
        <div className="text-sm text-slate-500 rounded-xl border border-dashed border-slate-200 p-6 text-center">
          Aucune idée pour l'instant. Note ci-dessus ce que tu veux garder sous la main.
        </div>
      )}
      </div>
    </div>
  )
}

// ─── Onglet 4 : travaux récurrents ────────────────────────────────────────────

/**
 * Sélecteur de semaine. Les flèches suffisent au quotidien (semaine dernière /
 * prochaine) ; le menu sert à sauter plus loin — recherchable, comme tout menu
 * de plus de dix options.
 */
function WeekPicker({ weeks, value, onChange, testid = 'recurring-week' }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const box = useRef(null)

  useEffect(() => {
    if (!open) return
    const handler = e => { if (box.current && !box.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])
  useEffect(() => { if (!open) setQ('') }, [open])
  // Le menu s'ouvre sur la semaine choisie, pas sur la plus ancienne : sans ça,
  // « la semaine dernière » demande de faire défiler douze lignes.
  useEffect(() => {
    if (!open) return
    const el = box.current?.querySelector(`[data-week-option="${value?.key}"]`)
    el?.scrollIntoView({ block: 'center' })
  }, [open, value?.key])

  const idx = weeks.findIndex(w => w.key === value?.key)
  const go = (delta) => {
    const next = weeks[idx + delta]
    if (next) onChange(next.key)
  }
  const shown = q.trim()
    ? weeks.filter(w => (w.label + ' ' + w.short_label).toLowerCase().includes(q.trim().toLowerCase()))
    : weeks

  return (
    <div className="flex items-center gap-1" ref={box}>
      <button
        className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-30"
        onClick={() => go(-1)} disabled={idx <= 0}
        title="Semaine précédente" data-testid={`${testid}-prev`}
      ><ChevronLeft size={16} /></button>

      <div className="relative">
        <button
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50"
          onClick={() => setOpen(o => !o)}
          data-testid={testid} data-week={value?.key || ''}
        >
          <CalendarDays size={14} className="text-slate-400" />
          {value?.label || 'Semaine…'}
          <ChevronDown size={14} className="text-slate-400" />
        </button>
        {open && (
          <div className="absolute z-30 mt-1 w-72 rounded-xl border border-slate-200 bg-white shadow-lg p-1.5" data-testid={`${testid}-menu`}>
            <input
              autoFocus
              className={`${inputCls} w-full mb-1`}
              placeholder="Rechercher une semaine…"
              value={q}
              onChange={e => setQ(e.target.value)}
            />
            <div className="max-h-72 overflow-y-auto">
              {shown.length ? shown.map(w => (
                <button
                  key={w.key}
                  className={`w-full text-left px-2.5 py-1.5 text-sm rounded-lg flex items-center justify-between gap-2 ${
                    w.key === value?.key ? 'bg-brand-50 text-brand-700' : 'text-slate-700 hover:bg-slate-50'
                  }`}
                  onClick={() => { onChange(w.key); setOpen(false) }}
                  data-week-option={w.key}
                >
                  <span>{w.label}</span>
                  {w.is_current && <span className="text-[11px] text-emerald-600 shrink-0">en cours</span>}
                </button>
              )) : (
                <div className="px-2.5 py-2 text-sm text-slate-400">Aucune semaine</div>
              )}
            </div>
          </div>
        )}
      </div>

      <button
        className="p-1.5 rounded-lg text-slate-500 hover:bg-slate-100 disabled:opacity-30"
        onClick={() => go(1)} disabled={idx < 0 || idx >= weeks.length - 1}
        title="Semaine suivante" data-testid={`${testid}-next`}
      ><ChevronRight size={16} /></button>

      {value && !value.is_current && (
        <button
          className="ml-1 px-2.5 py-1.5 text-xs rounded-lg text-brand-700 hover:bg-brand-50"
          onClick={() => onChange(null)} data-testid={`${testid}-today`}
        >Cette semaine</button>
      )}
    </div>
  )
}

// Échéance dans la période (mensuel + jour du mois). Le gris ne sert qu'à
// rappeler la date ; l'ambre et le rouge sont là pour être vus de loin.
const DUE_STYLES = {
  overdue:  'bg-rose-50 text-rose-700 border-rose-200',
  due_soon: 'bg-amber-50 text-amber-800 border-amber-200',
  upcoming: 'bg-slate-50 text-slate-500 border-slate-200',
}
function dueLabel(t) {
  const d = t.days_until_due
  if (d === null || d === undefined || !t.due_date) return null
  const day = Number(t.due_date.slice(8))
  if (d < 0) return `En retard de ${-d} j — était dû le ${day}`
  if (d === 0) return 'Dû aujourd\'hui'
  if (d === 1) return 'Dû demain'
  return `Dû le ${day} · dans ${d} j`
}
const capitalize = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

/**
 * Ligne de rattrapage : une période TERMINÉE et jamais cochée, proposée à part.
 *
 * Sans elle, la tâche mensuelle de juillet faite le 3 août se cochait sur août —
 * juillet restait ouvert sans que personne ne le voie, et août passait pour fait.
 * Elle vit hors de la ligne du travail : le mois courant peut être coché, le
 * rappel du mois précédent doit rester.
 */
function CatchUpRow({ t, period, currentLabel, onToggle }) {
  return (
    <div
      data-catchup={`${t.id}:${period.period_key}`}
      className="flex items-start gap-3 px-3 py-2 mb-1 rounded-lg border border-amber-200 bg-amber-50/70"
    >
      <input
        type="checkbox"
        className="mt-0.5 h-4 w-4 rounded border-amber-300"
        checked={false}
        onChange={() => onToggle(t, true, period.period_key)}
        aria-label={`Marquer « ${t.label} » fait pour ${period.period_label}`}
      />
      <div className="min-w-0">
        <div className="text-[15px] leading-6 text-amber-900">{t.label}</div>
        <div className="text-[13px] leading-relaxed text-amber-700">
          {capitalize(period.period_label)} jamais coché — cocher ici marque {period.period_label}, pas {currentLabel}.
        </div>
      </div>
    </div>
  )
}

/**
 * Les deux cases d'un travail fait DEUX fois par semaine (mardi et samedi).
 *
 * Une seule case ne pourrait pas dire « fait mardi, pas encore samedi » : cochée
 * le mardi elle resterait cochée toute la semaine, et le travail du samedi
 * passerait pour fait. Chaque créneau a donc la sienne, et se rouvre tout seul
 * quand son tour revient — le mardi le lundi, le samedi le samedi.
 *
 * La case du créneau en cours est mise en avant ; un créneau terminé et resté
 * vide passe en ambre (« raté »), pour qu'un oubli se voie sans rien lire.
 */
function OccurrenceChecks({ t, onToggle }) {
  return (
    <div className="mt-0.5 flex items-center gap-1 shrink-0">
      {t.occurrences.map(o => {
        const style = o.done ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
          : o.is_current ? 'border-slate-300 bg-white text-slate-700 font-medium ring-1 ring-slate-900/10'
          : o.is_past ? 'border-amber-200 bg-amber-50 text-amber-800'
          : 'border-slate-200 bg-white text-slate-400'
        return (
          <label
            key={o.period_key}
            data-occurrence={`${t.id}:${o.period_key}`}
            data-occurrence-slot={o.label}
            data-done={o.done ? '1' : '0'}
            title={o.done ? `Fait — ${o.label}` : o.is_past ? `${o.label} : créneau passé, jamais coché` : `À faire — ${o.label}`}
            className={`inline-flex items-center gap-1 pl-1 pr-1.5 py-0.5 rounded-md border text-[11px] cursor-pointer transition-colors ${style}`}
          >
            <input
              type="checkbox"
              className="h-3.5 w-3.5 rounded border-slate-300"
              checked={o.done}
              onChange={e => onToggle(t, e.target.checked, o.period_key)}
              aria-label={`${t.label} — ${o.label}`}
            />
            {o.label}
          </label>
        )
      })}
    </div>
  )
}

/**
 * Note d'un travail récurrent : un champ qui grandit avec son contenu.
 *
 * La note vivait dans un `<input>` d'une ligne, coincé à droite du champ
 * « quand » : « Mastercard : paiement pré-programmé le 4-5 du mois. Garder le
 * solde so… » se coupait au milieu d'un mot, et il fallait cliquer dedans puis
 * faire défiler pour lire le reste. Un textarea remis à la hauteur de son
 * contenu affiche la note en entier, sur autant de lignes qu'il faut — sans
 * jamais montrer de barre de défilement ni de poignée de redimensionnement.
 */
function AutoGrowNote({ value, onChange, onBlur, className = '', ...rest }) {
  const ref = useRef(null)
  const fit = useCallback(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'         // repartir de zéro, sinon la hauteur ne redescend jamais
    el.style.height = `${el.scrollHeight}px`
  }, [])
  // À la valeur ET à la largeur : replier la fenêtre change le nombre de lignes.
  useEffect(() => { fit() }, [fit, value])
  useEffect(() => {
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [fit])

  return (
    <textarea
      ref={ref}
      rows={1}
      className={`w-full resize-none overflow-hidden bg-transparent border-0 p-0 focus:outline-none ${className}`}
      value={value}
      onChange={e => { onChange(e); fit() }}
      onBlur={onBlur}
      {...rest}
    />
  )
}

/**
 * Ligne d'un travail récurrent.
 *
 * Les réglages (quand, dû le, propriétaire, cadence, retrait) ne s'affichent
 * plus en barre : ils vivent derrière un petit bouton, dans un panneau qui
 * s'ouvre au clic.
 *
 * Pourquoi : la barre flottait AU-DESSUS de la ligne dès le survol et masquait
 * ce qu'on venait lire — le « quand » et le badge d'échéance devaient être
 * cachés pour ne pas se retrouver à moitié sous elle, et les deux menus
 * déroulants (« Deux fois par semaine », « Antoine (AL) ») s'ouvraient à un
 * pixel du titre. Résultat : passer la souris sur une ligne pour la lire
 * changeait ce qu'elle affichait. Un bouton de 24 px réservé à droite ne
 * recouvre rien, ne bouge rien en apparaissant, et le panneau — libellé,
 * ouvert volontairement — se referme au clic ailleurs ou à Échap.
 */
function RecurringRow({ t, onToggle, onPatch, onDelete, fading = false }) {
  const { draft, edit, flush } = useRecordDraft(
    { label: t.label, day_hint: t.day_hint || '', notes: t.notes || '', due_day: t.due_day ?? '' },
    patch => onPatch(t.id, patch),
  )
  // Pas de badge sur une ligne cochée : l'échéance ne concerne plus personne.
  const due = t.due_status ? dueLabel(t) : null

  const [open, setOpen] = useState(false)
  const box = useRef(null)
  // `flush` change d'identité à chaque rendu (le `save` est une lambda) : passer
  // par une ref évite de ré-abonner les écouteurs à chaque frappe.
  const flushRef = useRef(flush)
  flushRef.current = flush
  useEffect(() => {
    if (!open) return
    // Fermeture au clic ailleurs / à Échap : le panneau sort du flux, rien ne
    // le refermerait sinon. `flush` avant de fermer pour ne pas perdre une
    // saisie en cours (le blur n'a pas lieu si le champ disparaît).
    const close = () => { flushRef.current(); setOpen(false) }
    const onDown = e => { if (box.current && !box.current.contains(e.target)) close() }
    const onKey = e => { if (e.key === 'Escape') close() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div
      data-task-id={t.id}
      data-done={t.done ? '1' : '0'}
      className={`group relative flex items-start gap-3 px-3 py-2.5 rounded-lg transition-all duration-300 ${
        open ? 'bg-slate-50' : 'hover:bg-slate-50'
      } ${t.done ? 'opacity-60' : ''} ${fading ? 'opacity-0 translate-x-2' : ''}`}
    >
      {t.occurrences?.length ? (
        <OccurrenceChecks t={t} onToggle={onToggle} />
      ) : (
        <input
          type="checkbox"
          className="mt-1 h-4 w-4 rounded border-slate-300"
          checked={!!t.done}
          onChange={e => onToggle(t, e.target.checked)}
        />
      )}
      {/* Deux lignes seulement : le titre, puis la note. Le titre se lit d'un
          coup d'œil (plus gros, plus contrasté) et la note prend TOUTE la
          largeur en dessous, où elle revient à la ligne au lieu d'être coupée
          au milieu d'un mot. Tout le reste (quand, dû le, propriétaire, cadence)
          est rangé dans la barre de réglages qui apparaît au survol : ces
          mentions grises encombraient chaque ligne sans jamais être lues. */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <input
            className={`flex-1 min-w-0 bg-transparent text-[15px] leading-6 text-slate-900 border-0 p-0 focus:outline-none ${t.done ? 'line-through' : ''}`}
            value={draft.label}
            onChange={e => edit('label', e.target.value)}
            onBlur={flush}
          />
          {/* Le « quand » et l'échéance restent lisibles EN TOUT TEMPS : ils
              étaient masqués au survol pour laisser passer l'ancienne barre de
              réglages, donc lire une ligne de près la vidait de ses repères. */}
          {draft.day_hint && (
            <span className="shrink-0 text-xs text-slate-500">{draft.day_hint}</span>
          )}
          {due && (
            <span
              data-testid="recurring-due-badge"
              data-due-status={t.due_status || ''}
              className={`shrink-0 px-2 py-0.5 text-[11px] font-medium rounded-full border ${DUE_STYLES[t.due_status] || DUE_STYLES.upcoming}`}
            >{due}</span>
          )}
        </div>
        <AutoGrowNote
          className="mt-0.5 text-[13px] leading-relaxed text-slate-600 placeholder:text-slate-300"
          placeholder="note…"
          data-testid="recurring-note"
          value={draft.notes}
          onChange={e => edit('notes', e.target.value)}
          onBlur={flush}
        />
        {t.done && t.done_by_name && (
          <div className="text-xs text-emerald-700 mt-1">Fait par {t.done_by_name}</div>
        )}
      </div>
      {/* Réglages de la ligne : un seul bouton, dont la place est réservée en
          permanence (l'apparition au survol ne décale donc rien). Il s'allume au
          survol, au focus clavier, et reste allumé tant que le panneau est
          ouvert — sinon sortir la souris de la ligne pour aller dans le panneau
          l'éteindrait. */}
      <div className="relative shrink-0 mt-0.5" ref={box}>
        <button
          type="button"
          data-testid="recurring-settings"
          aria-label={`Réglages de « ${t.label} »`}
          aria-expanded={open}
          title="Réglages : quand, échéance, pour qui, cadence"
          className={`p-1 rounded-md text-slate-400 hover:text-slate-700 hover:bg-slate-200/70 focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-300 transition-opacity ${
            open ? 'opacity-100 text-slate-700 bg-slate-200/70' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus:opacity-100'
          }`}
          onClick={() => setOpen(o => { if (o) flush(); return !o })}
        >
          <Settings2 size={15} />
        </button>

        {open && (
          <div
            data-testid="recurring-settings-panel"
            className="absolute right-0 top-full z-30 mt-1 w-64 rounded-xl border border-slate-200 bg-white shadow-lg p-2.5 space-y-2 text-left"
          >
            {/* Chaque réglage est libellé : dans l'ancienne barre, « quand… » et
                les deux menus se lisaient comme trois cases sans titre. */}
            <label className="block">
              <span className="block text-[11px] font-medium text-slate-500 mb-0.5">Quand</span>
              <input
                className="w-full text-sm text-slate-700 rounded-md border border-slate-200 bg-white px-2 py-1 focus:outline-none focus:ring-2 focus:ring-brand-100 focus:border-brand-300 placeholder:text-slate-400"
                placeholder="ex. mardi matin"
                value={draft.day_hint}
                onChange={e => edit('day_hint', e.target.value)}
                onBlur={flush}
              />
            </label>
            {/* Jour du mois où le travail est dû — seule cadence où « le 25 » veut
                dire quelque chose de calculable. Autosave comme le reste. */}
            {t.cadence === 'mensuel' && (
              <label className="block">
                <span className="block text-[11px] font-medium text-slate-500 mb-0.5">Dû le (jour du mois)</span>
                <input
                  type="number" min="1" max="31"
                  className="w-full text-sm text-slate-700 rounded-md border border-slate-200 bg-white px-2 py-1 focus:outline-none focus:ring-2 focus:ring-brand-100 focus:border-brand-300 placeholder:text-slate-400"
                  placeholder="–"
                  data-testid="recurring-due-day"
                  value={draft.due_day}
                  onChange={e => edit('due_day', e.target.value)}
                  onBlur={flush}
                />
              </label>
            )}
            {/* À qui appartient le travail : le changer le fait passer dans la section
                de l'autre personne (la ligne quitte donc la liste filtrée). */}
            <label className="block">
              <span className="block text-[11px] font-medium text-slate-500 mb-0.5">Pour qui</span>
              <select
                className="w-full text-sm text-slate-700 rounded-md border border-slate-200 bg-white px-2 py-1 focus:outline-none focus:ring-2 focus:ring-brand-100 focus:border-brand-300"
                value={t.owner || 'AL'}
                data-testid="recurring-owner"
                onChange={e => onPatch(t.id, { owner: e.target.value })}
              >
                {OWNERS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </label>
            <label className="block">
              <span className="block text-[11px] font-medium text-slate-500 mb-0.5">Cadence</span>
              <select
                className="w-full text-sm text-slate-700 rounded-md border border-slate-200 bg-white px-2 py-1 focus:outline-none focus:ring-2 focus:ring-brand-100 focus:border-brand-300"
                value={t.cadence}
                data-testid="recurring-cadence"
                onChange={e => onPatch(t.id, { cadence: e.target.value })}
              >
                {Object.entries(CADENCE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <button
              className="w-full flex items-center gap-1.5 px-2 py-1 text-sm rounded-md text-rose-600 hover:bg-rose-50"
              data-testid="recurring-delete"
              onClick={() => { setOpen(false); onDelete(t.id) }}
            >
              <Trash2 size={14} /> Retirer ce travail
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Travaux récurrents — une semaine à la fois.
 *
 * Ce que la page raconte : la semaine choisie est l'ancre. Toutes les cadences
 * en découlent (la semaine du 10 août appartient au mois d'août, au T3, à 2026),
 * donc changer de semaine ne « recopie » aucune liste : les travaux sont les
 * mêmes, seul leur état de cochage change de période. Une semaine qui commence
 * repart donc d'elle-même avec tous les travaux à faire.
 *
 * Cocher fait DISPARAÎTRE la ligne de la liste à faire (le fondu dure le temps
 * de voir ce qui part) : ce qui reste à l'écran est ce qui reste à faire. Rien
 * n'est perdu — les lignes cochées s'empilent sous « Faits », d'où on peut les
 * décocher. Un travail « à faire une fois » coché ne revient jamais ; un
 * hebdomadaire réapparaît, vide, dans la semaine suivante.
 */
function RecurringTab({ toast }) {
  const [tasks, setTasks] = useState([])
  const [owner, setOwner] = useState('AL')
  const [loading, setLoading] = useState(true)
  // `form.owner` par défaut = la section affichée, mais reste choisissable :
  // on peut ajouter un travail pour l'autre personne sans changer d'onglet.
  const [form, setForm] = useState({ label: '', cadence: 'hebdo', owner: 'AL' })
  // `weekKey === null` = semaine courante : le serveur suit alors le calendrier
  // tout seul, sans figer une semaine dans l'état du composant.
  const [weekKey, setWeekKey] = useState(null)
  const [week, setWeek] = useState(null)
  const [weeks, setWeeks] = useState([])
  const [fading, setFading] = useState(() => new Set())
  const [showDone, setShowDone] = useState({})

  const load = useCallback(async () => {
    try {
      const params = {}
      if (owner) params.owner = owner
      if (weekKey) params.week = weekKey
      const out = await api.travaux.listRecurring(params)
      setTasks(out.tasks)
      setWeek(out.week || null)
      setWeeks(out.weeks || [])
    } catch (e) { toast.error(e.message) }
    finally { setLoading(false) }
  }, [owner, weekKey, toast])

  useEffect(() => { load() }, [load])
  // Changer de section = ajouter par défaut dans cette section.
  useEffect(() => { if (owner) setForm(f => ({ ...f, owner })) }, [owner])
  useEffect(() => {
    const onEvt = () => load()
    window.addEventListener('travaux:recurring:updated', onEvt)
    return () => window.removeEventListener('travaux:recurring:updated', onEvt)
  }, [load])

  // Cochage optimiste : la case bascule tout de suite, le POST suit. Un échec
  // remet la liste dans l'état du serveur (recharge) et affiche l'erreur. La
  // période part explicitement du travail affiché : cocher en consultant une
  // semaine passée doit marquer CETTE semaine-là, pas celle d'aujourd'hui.
  const toggle = async (t, done, periodKey = null) => {
    const key = periodKey || t.period_key
    // Deux fois par semaine : on coche UN créneau (mardi ou samedi). La ligne ne
    // quitte la liste que lorsque les deux sont faits — sinon cocher le mardi
    // ferait disparaître de l'écran le travail du samedi.
    const occ = t.occurrences?.find(o => o.period_key === key)
    if (occ) {
      const occurrences = t.occurrences.map(o => (o.period_key === key ? { ...o, done } : o))
      const allDone = occurrences.every(o => o.done)
      if (allDone) {
        setFading(prev => new Set(prev).add(t.id))
        setTimeout(() => setFading(prev => { const n = new Set(prev); n.delete(t.id); return n }), 320)
      }
      setTasks(prev => prev.map(x => (x.id === t.id ? { ...x, occurrences, done: allDone } : x)))
      try { await api.travaux.setCompletion(t.id, { done, period_key: key }); load() }
      catch (e) { toast.error(e.message); load() }
      return
    }
    // Rattrapage : on coche une période PASSÉE. La ligne de rattrapage part,
    // la ligne de la période affichée, elle, ne bouge pas.
    if (periodKey && periodKey !== t.period_key) {
      setTasks(prev => prev.map(x => x.id === t.id
        ? { ...x, catch_up: (x.catch_up || []).filter(p => p.period_key !== periodKey) }
        : x))
      try {
        await api.travaux.setCompletion(t.id, { done, period_key: key })
        toast.success(`Marqué fait pour ${t.catch_up?.find(p => p.period_key === periodKey)?.period_label || key}`)
      } catch (e) { toast.error(e.message); load() }
      return
    }
    if (done) {
      // La ligne s'efface avant de rejoindre « Faits » — sinon elle disparaîtrait
      // d'un coup et on ne saurait pas laquelle on vient de cocher.
      setFading(prev => new Set(prev).add(t.id))
      setTimeout(() => setFading(prev => { const n = new Set(prev); n.delete(t.id); return n }), 320)
    }
    setTasks(prev => prev.map(x => x.id === t.id ? { ...x, done } : x))
    // Relecture après coup : le « Fait par » ne vient que du serveur, et
    // l'attendre du temps réel laissait la ligne cochée sans son attribution
    // tant que le websocket n'avait pas repassé le message.
    try { await api.travaux.setCompletion(t.id, { done, period_key: key }); load() }
    catch (e) { toast.error(e.message); load() }
  }
  const patch = async (id, p) => {
    // Réassigner : la ligne appartient à l'autre section, elle part tout de suite
    // de la liste filtrée (sinon elle resterait affichée sous le mauvais nom).
    if (p.owner && owner && p.owner !== owner) setTasks(prev => prev.filter(x => x.id !== id))
    try {
      const out = await api.travaux.updateRecurring(id, p)
      if (p.owner) {
        toast.success(`Assigné à ${OWNERS.find(o => o.value === p.owner)?.label || p.owner}`)
        load()
      }
      return out
    } catch (e) { toast.error(e.message); load() }
  }
  const remove = async (id) => {
    setTasks(prev => prev.filter(x => x.id !== id))
    try { await api.travaux.deleteRecurring(id) } catch (e) { toast.error(e.message); load() }
  }
  const add = async () => {
    if (!form.label.trim()) return
    try {
      await api.travaux.createRecurring({ ...form, owner: form.owner || owner || 'AL' })
      setForm({ label: '', cadence: form.cadence, owner: form.owner })
      load()
    } catch (e) { toast.error(e.message) }
  }

  // Une ligne cochée quitte la liste à faire, mais garde sa place le temps du
  // fondu (`fading`) — d'où la partition en deux listes plutôt qu'un filtre sec.
  //
  // Le rattrapage est une liste À PART, pas une propriété des lignes à faire :
  // le mois courant peut très bien être coché alors que le mois précédent
  // traîne — dans ce cas la ligne du travail est partie sous « Faits » et
  // emporterait le rappel avec elle.
  const groups = useMemo(() => {
    const by = {}
    for (const t of tasks) (by[t.cadence] ||= []).push(t)
    // En retard d'abord, puis « bientôt dû », puis l'ordre habituel : ce qui
    // presse doit être en haut de sa section, pas noyé au milieu.
    const rank = t => (t.due_status === 'overdue' ? 0 : t.due_status === 'due_soon' ? 1 : 2)
    return Object.keys(CADENCE_LABELS).filter(c => by[c]?.length).map(c => ({
      cadence: c,
      period_label: by[c][0]?.period_label,
      todo: by[c].filter(t => !t.done || fading.has(t.id)).sort((a, b) => rank(a) - rank(b)),
      done: by[c].filter(t => t.done && !fading.has(t.id)),
      catchUp: by[c].flatMap(t => (t.catch_up || []).map(period => ({ t, period }))),
    }))
  }, [tasks, fading])

  // Une section vidée de son « à faire » ne doit pas se lire comme une section
  // VIDE : Antoine cherchait « Compiler les dépenses pour Émilie » dans sa
  // section et ne voyait plus rien du tout, le travail étant coché et replié
  // sous le compteur « 1 fait ». Quand il ne reste rien à faire, les lignes
  // cochées sont donc dépliées d'office (le repli manuel reste possible, et
  // prime dès qu'on y touche).
  const isDoneOpen = g => showDone[g.cadence] ?? g.todo.length === 0
  const toggleDone = g => setShowDone(s => ({ ...s, [g.cadence]: !isDoneOpen(g) }))

  const remaining = tasks.filter(t => !t.done).length
  const lateCount = tasks.reduce((n, t) => n + (t.catch_up?.length || 0), 0)
  const isCurrent = week?.is_current !== false

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <div className="flex items-center gap-1.5">
          {OWNERS.map(o => (
            <button
              key={o.value}
              className={`px-3 py-1.5 text-sm rounded-lg ${owner === o.value ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
              onClick={() => setOwner(o.value)}
            >{o.label}</button>
          ))}
          <button
            className={`px-3 py-1.5 text-sm rounded-lg ${owner === '' ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-100'}`}
            onClick={() => setOwner('')}
          >Tout le monde</button>
        </div>
        <div className="text-xs text-slate-500" data-testid="recurring-remaining">
          {remaining} {remaining > 1 ? 'travaux' : 'travail'} à faire {isCurrent ? 'cette semaine' : 'cette semaine-là'}
          {lateCount > 0 && (
            <span className="text-amber-700" data-testid="recurring-late-count"> · {lateCount} période{lateCount > 1 ? 's' : ''} à rattraper</span>
          )}
        </div>
      </div>

      {/* Barre de semaine : c'est l'ancre de lecture de tout l'onglet. */}
      <div className="flex items-center justify-between gap-3 mb-4 flex-wrap rounded-xl border border-slate-200 bg-slate-50/60 px-2.5 py-2">
        <WeekPicker weeks={weeks} value={week} onChange={setWeekKey} />
        {!isCurrent && (
          <span className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1">
            Semaine passée ou à venir — cocher ici marque cette semaine-là.
          </span>
        )}
      </div>

      {loading ? (
        <div className="text-sm text-slate-500 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Chargement…</div>
      ) : (
        <div className="space-y-5">
          {groups.map(g => (
            <div key={g.cadence} className="rounded-xl border border-slate-200 bg-white" data-cadence={g.cadence}>
              <div className="flex items-center justify-between px-3.5 py-2.5 border-b border-slate-100">
                <h3 className="text-[15px] font-semibold text-slate-900">{CADENCE_LABELS[g.cadence]}</h3>
                {/* La période d'un « à faire une fois » répéterait le titre de la section. */}
                {g.cadence !== 'adhoc' && <span className="text-xs text-slate-400">{g.period_label}</span>}
              </div>
              {g.catchUp.length > 0 && (
                <div className="p-1 pb-0" data-testid={`recurring-catchup-${g.cadence}`}>
                  <div className="px-2.5 pt-1 pb-1.5 text-xs font-medium text-amber-800 flex items-center gap-1.5">
                    <AlertTriangle size={13} /> À rattraper — période{g.catchUp.length > 1 ? 's' : ''} terminée{g.catchUp.length > 1 ? 's' : ''} jamais cochée{g.catchUp.length > 1 ? 's' : ''}
                  </div>
                  {g.catchUp.map(({ t, period }) => (
                    <CatchUpRow key={`${t.id}:${period.period_key}`} t={t} period={period}
                      currentLabel={g.period_label} onToggle={toggle} />
                  ))}
                </div>
              )}
              <div className="p-1">
                {g.todo.length ? g.todo.map(t => (
                  <RecurringRow key={t.id} t={t} onToggle={toggle} onPatch={patch} onDelete={remove} fading={fading.has(t.id)} />
                )) : g.catchUp.length ? (
                  <div className="px-3 py-2.5 text-sm text-amber-700">
                    Rien à faire pour {g.period_label} — il reste la période à rattraper ci-dessus.
                  </div>
                ) : (
                  <div className="px-3 py-2.5 text-sm text-emerald-700 flex items-center gap-1.5">
                    <CheckCircle2 size={14} /> Tout est fait{
                      g.cadence === 'hebdo' ? ' — la liste repart lundi'
                        : g.cadence === 'bihebdo' ? ' — les cases se rouvrent au prochain créneau (mardi, samedi)'
                        : ''}.
                  </div>
                )}
              </div>
              {g.done.length > 0 && (
                <div className="border-t border-slate-100">
                  <button
                    className="w-full flex items-center gap-1.5 px-3.5 py-2 text-xs text-slate-500 hover:text-slate-700"
                    onClick={() => toggleDone(g)}
                    data-testid={`recurring-done-toggle-${g.cadence}`}
                  >
                    <ChevronDown size={13} className={`transition-transform ${isDoneOpen(g) ? '' : '-rotate-90'}`} />
                    {g.done.length} fait{g.done.length > 1 ? 's' : ''}
                  </button>
                  {isDoneOpen(g) && (
                    <div className="p-1 pt-0" data-testid={`recurring-done-${g.cadence}`}>
                      {g.done.map(t => (
                        <RecurringRow key={t.id} t={t} onToggle={toggle} onPatch={patch} onDelete={remove} />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-2 mt-5">
        <input
          className={`${inputCls} flex-1`}
          placeholder="Ajouter un travail…"
          value={form.label}
          onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
          onKeyDown={e => { if (e.key === 'Enter') add() }}
        />
        <select className={inputCls} value={form.cadence} onChange={e => setForm(f => ({ ...f, cadence: e.target.value }))}>
          {Object.entries(CADENCE_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
        <select
          className={inputCls} value={form.owner} data-testid="recurring-new-owner"
          title="À qui ce travail revient"
          onChange={e => setForm(f => ({ ...f, owner: e.target.value }))}
        >
          {OWNERS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <button className={btnPrimary} onClick={add} disabled={!form.label.trim()}><Plus size={14} /> Ajouter</button>
      </div>
      <p className="text-xs text-slate-500 mt-2">
        Cocher un travail le retire de la liste : ce qui reste à l'écran est ce qui reste à faire (les lignes cochées se retrouvent sous « Faits »,
        où on peut les décocher). La semaine suivante repart avec tous les travaux récurrents à faire ; un travail « à faire une fois » coché, lui, ne revient pas.
        Un travail « deux fois par semaine » porte deux cases, <strong>mardi</strong> et <strong>samedi</strong> : cocher celle du mardi laisse celle du samedi à faire,
        et chacune se rouvre d'elle-même quand son tour revient.
      </p>
    </div>
  )
}

// ─── Pause de la file ─────────────────────────────────────────────────────────

/**
 * Bouton pause / reprise de la file, en haut de page à côté de la consommation de
 * Claude : on voit ce qu'il reste de quota, et on coupe d'un clic si on veut en
 * garder pour plus tard. Bouton assumé (pas d'autosave) : c'est une action à effet
 * réel — elle décide si des exécutions démarrent.
 *
 * Ce qu'elle NE fait pas : tuer l'exécution en cours. La pause bloque les départs,
 * donc reprendre repart d'où la file s'était arrêtée, sans rien recommencer.
 *
 * État autonome (pas de props) pour rester visible sur les trois onglets ; la
 * synchro avec la liste passe par l'événement temps réel `travaux:prompts:updated`,
 * que les deux côtés écoutent.
 */
function QueuePauseControl({ toast }) {
  const [state, setState] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try { setState(await api.travaux.getQueuePause()) } catch { /* silencieux : jamais bloquant */ }
  }, [])

  useEffect(() => {
    load()
    const onEvt = () => load()
    window.addEventListener('travaux:prompts:updated', onEvt)
    // Filet : la pause peut être posée par le serveur (item « arrêter après celle-ci »)
    // alors que la page est ouverte sans que rien d'autre ne bouge.
    const t = setInterval(load, 30_000)
    return () => { window.removeEventListener('travaux:prompts:updated', onEvt); clearInterval(t) }
  }, [load])

  const toggle = async () => {
    const next = !state?.paused
    setBusy(true)
    try {
      const out = await api.travaux.setQueuePaused(next)
      setState({ paused: out.paused, paused_at: out.paused_at, reason: out.reason })
      toast.success(next
        ? 'File en pause — la tâche en cours finit, aucune autre ne démarre'
        : out.startedCount ? 'File reprise — le travail suivant démarre' : 'File reprise')
      // La liste (bandeau, bouton « Lancer la file ») se remet à jour comme si le
      // serveur avait diffusé : la reprise passe par la même route pour tout le monde.
      window.dispatchEvent(new CustomEvent('travaux:prompts:updated'))
    } catch (e) { toast.error(e.message) }
    finally { setBusy(false) }
  }

  const paused = !!state?.paused
  return (
    <button
      data-testid="travaux-pause-queue"
      data-paused={paused ? '1' : '0'}
      className={`inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border shrink-0 disabled:opacity-50 ${
        paused
          ? 'border-amber-300 bg-amber-50 text-amber-800 hover:bg-amber-100'
          : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
      }`}
      disabled={busy || !state}
      onClick={toggle}
      title={paused
        ? 'Reprendre la file là où elle s\'est arrêtée'
        : 'Mettre la file en pause : la tâche en cours va au bout, aucune autre ne démarre'}
    >
      {busy ? <Loader2 size={14} className="animate-spin" />
        : paused ? <PlayCircle size={14} /> : <PauseCircle size={14} />}
      {paused ? 'Reprendre la file' : 'Pause'}
    </button>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

const TABS = [
  { key: 'file', label: 'Ma file de prompts', icon: ListOrdered },
  { key: 'suggestions', label: 'Suggestions de Claude', icon: Sparkles },
  { key: 'idees', label: 'De côté & idées', icon: Lightbulb },
  { key: 'recurrents', label: 'Travaux récurrents', icon: RefreshCw },
]
// L'onglet des idées héberge aussi les items mis de côté : « ?onglet=de-cote » y
// mène. Les liens existants (?onglet=idees) restent valides — une clé d'URL déjà
// partagée ne doit jamais mourir.
const TAB_ALIASES = { 'de-cote': 'idees' }
// La même page sert deux sections : Espace finance (/travaux) et Agent
// (/agent/travaux). Chacune a SA file de prompts (listes distinctes en DB, un seul
// exécuteur partagé) ; les suggestions et les idées, elles, sont les mêmes partout —
// seul l'endroit où « Ajouter » / « Passer à l'action » dépose l'item change. Les
// travaux récurrents restent propres à l'Espace finance.
const SPACE_CONFIG = {
  finance: {
    title: 'Travaux',
    intro: "Ta file de prompts pour l'agent, ses recommandations, ce que tu as mis de côté avec ton carnet d'idées, et les travaux récurrents à cocher.",
    tabs: TABS,
  },
  agent: {
    title: "Travaux de l'agent",
    intro: "La file de prompts de la section Agent — distincte de celle de l'Espace finance, mais exécutée par le même agent (une implémentation à la fois, toutes files confondues). Les suggestions et le carnet d'idées sont partagés entre les deux sections ; les items mis de côté restent, eux, propres à chaque file.",
    tabs: TABS.filter(t => t.key !== 'recurrents'),
  },
}

export default function Travaux({ space = 'finance' }) {
  const { addToast } = useToast()
  const cfg = SPACE_CONFIG[space] || SPACE_CONFIG.finance
  // Adaptateur : les onglets appellent toast.error/success/info, le provider
  // expose addToast({ message, type }).
  const toast = useMemo(() => ({
    error:   m => addToast({ message: m, type: 'error' }),
    success: m => addToast({ message: m, type: 'success' }),
    info:    m => addToast({ message: m, type: 'info' }),
  }), [addToast])
  // L'URL est la source de vérité de l'onglet : un lien Slack, un rechargement
  // ou le sous-menu de la sidebar (?onglet=…) retombent au bon endroit, même
  // quand la page est déjà montée.
  const [params, setParams] = useSearchParams()
  const raw = params.get('onglet')
  const asked = TAB_ALIASES[raw] || raw
  const tab = cfg.tabs.some(x => x.key === asked) ? asked : 'file'
  const select = (key) => setParams({ onglet: key }, { replace: true })

  return (
    <Layout>
      <div className="p-6 max-w-5xl" data-travaux-space={space}>
        <h1 className="text-2xl font-bold text-slate-900">{cfg.title}</h1>
        <p className="text-sm text-slate-500 mt-1 mb-4">
          {cfg.intro}
        </p>

        {/* Consommation de Claude + frein d'urgence, à la même hauteur : on voit ce
            qu'il reste de quota et on coupe d'un clic si on veut en garder pour la
            journée de quelqu'un d'autre. Le bouton reste là même si la lecture de
            l'utilisation échoue (le bandeau, lui, s'efface silencieusement). */}
        <div className="flex flex-wrap items-center gap-2 mb-5">
          <ClaudeUsageStrip className="mb-0 flex-1 min-w-[300px]" />
          <QueuePauseControl toast={toast} />
        </div>

        <div className="flex items-center gap-1 border-b border-slate-200 mb-5">
          {cfg.tabs.map(t => (
            <button
              key={t.key}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium border-b-2 -mb-px ${
                tab === t.key ? 'border-brand-600 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
              onClick={() => select(t.key)}
            >
              <t.icon size={14} /> {t.label}
            </button>
          ))}
        </div>

        {tab === 'file' && <QueueTab toast={toast} space={space} />}
        {tab === 'suggestions' && <SuggestionsTab toast={toast} space={space} />}
        {tab === 'idees' && <IdeasTab toast={toast} space={space} />}
        {tab === 'recurrents' && <RecurringTab toast={toast} />}
      </div>
    </Layout>
  )
}
