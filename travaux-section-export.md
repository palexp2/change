# Section « Travaux » + FAB « Modifier le système » — code complet

Export du code de la section Travaux de l'ERP Orisha (file de prompts, suggestions
de l'agent, carnet d'idées, panneau rapide) et du bouton flottant en bas à droite
(« Modifier le système ») avec son système de ciblage d'élément de page.

**Exclu volontairement** : l'onglet « Travaux récurrents » (composants React,
routes `/travaux/recurring*`, service `recurringWork.js`, tables `recurring_tasks`
/ `recurring_task_completions`). Les endroits où le code retiré était référencé
sont marqués par `[… travaux récurrents retirés de cet export …]`.

Chaque bloc porte le chemin réel du fichier dans le dépôt.

## Plan

**Frontend**
- `client/src/pages/Travaux.jsx` — la page /travaux (3 onglets)
- `client/src/lib/travauxQueue.jsx` — primitives partagées de la file
- `client/src/components/TravauxQuickPanel.jsx` — panneau rapide global
- `client/src/lib/pageContext.jsx` — **ciblage d'élément de page** (picker + contexte)
- `client/src/components/FeedbackFab.jsx` — **le bouton en bas à droite**
- `client/src/lib/api.js` (extrait) — client HTTP `api.travaux`

**Backend**
- `server/src/routes/travaux.js` — routes REST
- `server/src/services/promptQueue.js` — file de prompts, ordonnancement
- `server/src/services/taskRunner.js` — exécuteur (spawn Claude Code)
- `server/src/services/workSuggestions.js` — moteurs de suggestions
- `server/src/services/workIdeas.js` — carnet d'idées
- `server/src/services/promptTitle.js`, `promptPreset.js` — titre / preset auto
- `server/src/db/schema.js` (extrait) — DDL des tables

**Mode nuit (mode sombre)**
- `client/tailwind.config.js` — le mécanisme complet (variables CSS par nuance)
- `client/index.html` (extrait) — bootstrap anti-flash
- `client/src/lib/theme.js` — état du thème (localStorage + préférence système)
- `client/src/components/ThemeToggle.jsx` — l'interrupteur
- `client/src/index.css` — CSS global


---

## `client/src/pages/Travaux.jsx`

Page /travaux. Onglet 4 (« Travaux récurrents », lignes 1826-2294 de l'original) retiré, ainsi que son entrée dans `TABS` et son rendu.

```jsx
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
} from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { ClaudeUsageStrip } from '../components/ClaudeUsage.jsx'
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
const CADENCE_LABELS = {
  hebdo: 'Hebdomadaire', mensuel: 'Mensuel', trimestriel: 'Trimestriel',
  annuel: 'Annuel', adhoc: 'À faire une fois',
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

/** Champ texte en autosave : debounce 500 ms + sauvegarde immédiate au blur. */
function useAutosave(save) {
  const timer = useRef(null)
  const pending = useRef(null)
  const flush = useCallback(() => {
    if (timer.current) { clearTimeout(timer.current); timer.current = null }
    if (pending.current) { const p = pending.current; pending.current = null; save(p) }
  }, [save])
  const queue = useCallback((patch) => {
    pending.current = { ...(pending.current || {}), ...patch }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(flush, 500)
  }, [flush])
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
  return { queue, flush }
}

/**
 * Champs texte d'une carte de la file, en autosave, SANS interruption de frappe.
 *
 * Le piège corrigé ici : la liste se recharge en permanence (temps réel, sondage,
 * et après chaque sauvegarde). L'ancienne version réinjectait alors la valeur du
 * serveur dans le champ — les caractères tapés pendant l'aller-retour
 * disparaissaient et le curseur sautait à la fin. Désormais la valeur du serveur
 * n'est reprise que pour les champs dont on n'attend plus rien : tant qu'une
 * frappe n'est pas revenue confirmée, c'est l'écran qui fait foi.
 *
 * `save` doit renvoyer la ligne serveur (ou null) : elle sert à accepter une
 * normalisation côté serveur (titre vidé → titre automatique) sans écraser une
 * frappe arrivée entre-temps.
 */
function usePromptDraft(p, save) {
  const [draft, setDraft] = useState({ title: p.title || '', prompt: p.prompt || '' })
  const awaiting = useRef({})   // champ → dernière valeur envoyée, pas encore confirmée
  const timer = useRef(null)

  useEffect(() => {
    const server = { title: p.title || '', prompt: p.prompt || '' }
    setDraft(prev => {
      let next = prev
      for (const k of ['title', 'prompt']) {
        if (awaiting.current[k] === undefined) {
          if (prev[k] !== server[k]) next = { ...next, [k]: server[k] }
        } else if (awaiting.current[k] === server[k]) {
          delete awaiting.current[k]      // notre frappe est revenue : le champ est à jour
        }
      }
      return next
    })
  }, [p.title, p.prompt])

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
    timer.current = setTimeout(() => { flush() }, 600)
  }, [flush])

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
  const { draft, edit, flush } = usePromptDraft(p, save)

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
  const [form, setForm] = useState({ prompt: '', title: '', mode: 'implement', preset: 'auto', priority: false })
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
      setForm({ prompt: '', title: '', mode: 'implement', preset: 'auto', priority: false })
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
        {/* Laissé vide, le titre est déduit du prompt côté serveur (heuristique
            immédiate, puis titre modèle en quelques secondes). */}
        <input className={`${inputCls} flex-1 min-w-[200px]`} placeholder="Titre — laisse vide pour un titre automatique"
          title="Vide : le titre est déduit automatiquement du prompt"
          value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} />
        <select className={inputCls} data-testid="travaux-new-preset" value={form.preset}
          title="Auto : le calibre (Rapide / Standard / Approfondi) est jugé automatiquement selon la tâche"
          onChange={e => setForm(f => ({ ...f, preset: e.target.value }))}>
          {PRESETS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
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

function QueueTab({ toast, space }) {
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

      <NewPromptComposer agentEnabled={data.agent_enabled} onCreate={create} />

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
function groupSuggestionsByArea(suggestions) {
  const byArea = new Map()
  for (const s of suggestions) {
    const area = AREA_ORDER.includes(s.area) ? s.area : 'technique'
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

      <p className="text-xs text-slate-500 mb-4">
        L'agent regarde chaque matin les travaux que tu fais encore à la main, les chantiers récents et les erreurs de synchronisation,
        puis propose ici les prochaines étapes. Il propose aussi des <strong className="font-medium text-slate-600">intégrations</strong> — des
        logiciels ou des API externes à brancher à l'ERP, en tenant compte de ce qui est déjà connecté — avec ce que le branchement débloquerait.
        Rien ne s'exécute avant que tu ne l'ajoutes à ta file.
      </p>

      {loading ? (
        <div className="text-sm text-slate-500 flex items-center gap-2"><Loader2 size={14} className="animate-spin" /> Chargement…</div>
      ) : suggestions.length ? (
        <div className="space-y-6" data-testid="suggestions-by-area">
          {groupSuggestionsByArea(suggestions).map(({ area, label, items }) => (
            <div key={area} data-testid={`suggestion-area-${area}`}>
              <div className="flex items-center gap-2 mb-2.5">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-500">{label}</h3>
                <span className="text-xs text-slate-400">{items.length}</span>
              </div>
              <div className="space-y-2.5">
                {items.map(s => (
                  <SuggestionCard key={s.id} s={s} onAccept={accept} onDismiss={dismiss} />
                ))}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="text-sm text-slate-500 rounded-xl border border-dashed border-slate-200 p-6 text-center">
          Aucune {kind === 'integration' ? 'intégration proposée' : 'suggestion'} {status === 'new' ? 'en attente' : ''}.
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
  const [draft, setDraft] = useState({ title: idea.title, notes: idea.notes || '', tag: idea.tag || '' })
  const { queue, flush } = useAutosave(patch => onPatch(idea.id, patch))
  const cardRef = useRef(null)
  useEffect(() => {
    setDraft({ title: idea.title, notes: idea.notes || '', tag: idea.tag || '' })
  }, [idea.title, idea.notes, idea.tag])

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
            onChange={e => { setDraft(d => ({ ...d, title: e.target.value })); queue({ title: e.target.value }) }}
            onBlur={flush}
          />
          <textarea
            className="w-full mt-1.5 bg-transparent text-sm text-slate-600 border-0 p-0 focus:outline-none resize-y placeholder:text-slate-300"
            rows={draft.notes ? 3 : 1}
            placeholder="Développer l'idée…"
            value={draft.notes}
            onChange={e => { setDraft(d => ({ ...d, notes: e.target.value })); queue({ notes: e.target.value }) }}
            onBlur={flush}
          />
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <input
              className="w-40 text-xs text-slate-500 bg-transparent border-0 p-0 focus:outline-none placeholder:text-slate-300"
              placeholder="thème…"
              value={draft.tag}
              onChange={e => { setDraft(d => ({ ...d, tag: e.target.value })); queue({ tag: e.target.value }) }}
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
    try { await api.travaux.updateIdea(id, p) } catch (e) { toast.error(e.message); load() }
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

// [… travaux récurrents retirés de cet export …]

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
      </div>
    </Layout>
  )
}
```


---

## `client/src/lib/travauxQueue.jsx`

Primitives partagées entre la page /travaux, le panneau rapide et le FAB : statuts, PlacementToggle, hooks de file.

```jsx
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
```


---

## `client/src/components/TravauxQuickPanel.jsx`

Panneau rapide : déposer/ suivre un prompt depuis n'importe quelle page. Utilise le même ciblage d'élément que le FAB.

```jsx
// Panneau rapide de la file de travaux — accessible depuis N'IMPORTE QUELLE page
// de l'ERP (bouton dans l'en-tête de la barre de gauche + raccourci ⌘/Ctrl + /).
//
// Il fait trois choses, sans quitter la page où on se trouve :
//   1. déposer un prompt dans la file, avec le contexte de la page pré-rempli
//      (route, fiche affichée, et au besoin un élément ciblé au clic — même
//      mécanisme que le FAB « Modifier le système », voir lib/pageContext.jsx) ;
//   2. montrer l'état de la file : ce qui tourne, ce qui attend et à quel rang ;
//   3. répondre à une question de Claude (« À répondre ») — un choix ou du texte
//      libre relance la tâche immédiatement.
//
// Rien n'est réimplémenté ici : la lecture temps réel de la file, la pastille
// d'état, les choix d'une question et la zone de réponse viennent de
// lib/travauxQueue.jsx, partagés avec la page /travaux.
import { createContext, useContext, useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  ListOrdered, X, Plus, Loader2, HelpCircle, Crosshair, MousePointerClick,
  ArrowRight, AlertTriangle, PauseCircle,
} from 'lucide-react'
import api from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import {
  inputCls, btnPrimary,
  isAsking, firstLine, StatusPill, QuestionChoices, ReplyBox, PlacementToggle, useTravauxPrompts,
} from '../lib/travauxQueue.jsx'
import { useElementPicker, buildPageContext, currentRecordLabel, PickerBanner } from '../lib/pageContext.jsx'

// Le panneau dépose dans la file de l'Espace finance (/travaux) — la même que le
// FAB « Modifier le système », dont c'est désormais la seule destination.
const SPACE = 'finance'

const Ctx = createContext(null)

/** État partagé du panneau : le bouton déclencheur vit dans la barre de gauche. */
export function useTravauxQuick() { return useContext(Ctx) }

/**
 * Bouton d'ouverture, à poser dans le chrome de l'app (en-tête de la sidebar,
 * rail replié, en-tête mobile). Pastille violette = des questions attendent une
 * réponse ; sinon le nombre d'items vivants dans la file.
 */
export function TravauxQuickButton({ compact = false, className = '' }) {
  const ctx = useTravauxQuick()
  if (!ctx) return null
  const { open, setOpen, askingCount, activeCount } = ctx
  const badge = askingCount || activeCount
  return (
    <button
      type="button"
      data-testid="travaux-quick-button"
      data-asking={askingCount ? '1' : '0'}
      onClick={() => setOpen(o => !o)}
      title={askingCount
        ? `File de travaux — ${askingCount} question${askingCount > 1 ? 's' : ''} à répondre (⌘/Ctrl + /)`
        : 'File de travaux — ajouter un prompt, voir la file (⌘/Ctrl + /)'}
      aria-label="File de travaux"
      aria-expanded={open}
      className={`relative rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors
        ${compact ? 'p-2' : 'p-1.5'} ${open ? 'text-brand-700 bg-brand-50' : ''} ${className}`}
    >
      <ListOrdered size={compact ? 16 : 15} />
      {!!badge && (
        <span
          data-testid="travaux-quick-badge"
          className={`absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] px-1 rounded-full text-[9px] font-semibold
            leading-[15px] text-white ring-2 ring-white ${askingCount ? 'bg-violet-600' : 'bg-slate-400'}`}
        >{badge > 9 ? '9+' : badge}</span>
      )}
    </button>
  )
}

/** Une ligne de file, repliée : rang, pastille d'état, titre. */
function QueueLine({ p, index }) {
  return (
    <div
      className="flex items-start gap-2 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white"
      data-testid="travaux-quick-queue-item"
      data-prompt-id={p.id}
    >
      <span className="mt-0.5 w-5 shrink-0 text-center text-[11px] font-semibold text-slate-400 tabular-nums">{index}</span>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-slate-800 truncate">{p.title || firstLine(p.prompt, 60)}</div>
        <div className="mt-0.5"><StatusPill p={p} /></div>
      </div>
    </div>
  )
}

/** Carte « À répondre » : la question, ses choix, et une réponse libre. */
function AskingCard({ p, onReply }) {
  return (
    <div
      className="rounded-xl border border-violet-300 ring-1 ring-violet-100 bg-white p-2.5 space-y-2"
      data-testid="travaux-quick-asking"
      data-prompt-id={p.id}
    >
      <div className="flex items-center gap-2 min-w-0">
        <StatusPill p={p} />
        <span className="flex-1 min-w-0 truncate text-sm font-medium text-slate-800">{p.title}</span>
      </div>
      {/* La question est rappelée ici : le panneau n'affiche pas le fil complet. */}
      <QuestionChoices p={p} onAnswer={opt => onReply(p.id, opt)} showQuestion />
      <ReplyBox onSend={(text, placement) => onReply(p.id, text, placement)} />
    </div>
  )
}

function QuickPanel({ onClose, data, load }) {
  const location = useLocation()
  const { addToast } = useToast()
  const toast = useMemo(() => ({
    error: m => addToast({ message: m, type: 'error' }),
    success: m => addToast({ message: m, type: 'success' }),
  }), [addToast])

  const [text, setText] = useState('')
  const [priority, setPriority] = useState(false)
  const [element, setElement] = useState('')
  const [record, setRecord] = useState('')
  const [picking, setPicking] = useState(false)
  const [sending, setSending] = useState(false)
  const inputRef = useRef(null)

  // Fiche affichée : lue à l'ouverture (et à chaque changement de page tant que le
  // panneau est ouvert) — c'est le titre que l'utilisateur a sous les yeux.
  useEffect(() => { setRecord(currentRecordLabel(location.pathname)) }, [location.pathname, location.search])
  useEffect(() => { inputRef.current?.focus() }, [])

  useElementPicker(picking, {
    onPick: (desc) => { setElement(desc); setPicking(false) },
    onCancel: () => setPicking(false),
  })

  const context = buildPageContext({
    pathname: location.pathname, search: location.search, element, record,
  })

  // Création : pas d'autosave possible (aucun id avant l'envoi) — voir CLAUDE.md.
  const submit = async () => {
    const trimmed = text.trim()
    if (!trimmed || sending) return
    setSending(true)
    try {
      await api.travaux.createPrompt({
        // Le contexte suit dans le prompt : c'est lui que l'agent reçoit.
        prompt: `${trimmed}\n\nContexte (ERP) : ${context}`,
        space: SPACE,
        priority,
      })
      setText('')
      setElement('')
      setPriority(false)
      toast.success(priority ? 'Ajouté en tête de ta file' : 'Ajouté à ta file de travaux')
      load()
    } catch (e) { toast.error(e.message) }
    finally { setSending(false) }
  }

  // Répondre relance la tâche (voir page Travaux) : 'front' repart tout de suite,
  // 'back' la remet en fin de file.
  const reply = useCallback(async (id, replyText, placement = 'front') => {
    try {
      await api.travaux.replyToPrompt(id, replyText, placement)
      toast.success(data.queue_paused
        ? 'Réponse enregistrée — la file est en pause, la tâche repartira à la reprise'
        : placement === 'back'
          ? 'Réponse enregistrée — la tâche retourne en fin de file'
          : 'Réponse envoyée — la tâche repart')
      load()
    } catch (e) { toast.error(e.message); throw e }
  }, [data.queue_paused, load, toast])

  // Trois groupes, dans l'ordre où ils intéressent : ce qui attend une réponse, ce
  // qui tourne, puis la file numérotée (déjà remis à l'ordonnanceur d'abord).
  const { asking, running, queue, pausedCount } = useMemo(() => {
    const prompts = data.prompts || []
    const live = prompts.filter(p => p.status === 'running')
    return {
      asking: prompts.filter(isAsking),
      running: live.filter(p => p.run_state === 'executing'),
      queue: [
        ...live.filter(p => p.run_state !== 'executing'),
        ...prompts.filter(p => p.status === 'queued'),
      ],
      pausedCount: prompts.filter(p => p.status === 'paused').length,
    }
  }, [data.prompts])

  return (
    <>
      {picking && <PickerBanner
        onSkip={() => setPicking(false)}
        onCancel={() => setPicking(false)}
        skipLabel="Sans élément"
        testIdPrefix="travaux-quick"
      />}

      {/* Pendant le ciblage, le panneau s'efface : la page doit être cliquable. */}
      <div className={picking ? 'hidden' : undefined}>
        <div className="fixed inset-0 z-[9992] bg-slate-900/10" onClick={onClose} />
        {/* Pas de garde-frappe ici (contrairement aux cartes de la page /travaux) :
            tous les champs du panneau tiennent leur texte en état local, un
            rafraîchissement de la file ne peut pas l'écraser. */}
        <aside
          data-testid="travaux-quick-panel"
          className="fixed top-0 right-0 bottom-0 z-[9993] w-full sm:w-[420px] bg-white border-l border-slate-200
            shadow-2xl flex flex-col"
        >
          <div className="flex items-center gap-2 h-14 px-3.5 border-b border-slate-100 flex-shrink-0">
            <ListOrdered size={16} className="text-slate-500" />
            <div className="text-sm font-semibold text-slate-800">File de travaux</div>
            <Link
              to="/travaux"
              onClick={onClose}
              data-testid="travaux-quick-open-page"
              className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700"
            >Ouvrir la page <ArrowRight size={12} /></Link>
            <button
              onClick={onClose}
              data-testid="travaux-quick-close"
              aria-label="Fermer"
              title="Fermer (Échap)"
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
            ><X size={15} /></button>
          </div>

          <div className="flex-1 overflow-y-auto p-3.5 space-y-4">
            {/* ── Composer : le contexte de la page est déjà là ─────────────── */}
            <div>
              <textarea
                ref={inputRef}
                data-testid="travaux-quick-input"
                className={`${inputCls} w-full`}
                rows={3}
                placeholder="Décris la tâche — la page où tu es est jointe automatiquement…"
                value={text}
                onChange={e => setText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit() }}
              />
              <div
                data-testid="travaux-quick-context"
                className="mt-1.5 rounded-lg bg-slate-50 border border-slate-200 px-2.5 py-1.5 text-[11px] text-slate-500"
              >
                <div className="font-medium text-slate-600">Contexte joint</div>
                <div className="font-mono break-all">{location.pathname}{location.search}</div>
                {!!record && <div className="truncate" data-testid="travaux-quick-record">Fiche affichée : « {record} »</div>}
                {element ? (
                  <div className="mt-1 flex items-start gap-1.5" data-testid="travaux-quick-element">
                    <MousePointerClick size={12} className="text-brand-600 flex-shrink-0 mt-0.5" />
                    <span className="font-mono break-all line-clamp-2 flex-1">{element}</span>
                    <button
                      onClick={() => setElement('')}
                      data-testid="travaux-quick-element-remove"
                      aria-label="Retirer l'élément ciblé"
                      className="text-slate-400 hover:text-slate-600 flex-shrink-0"
                    ><X size={12} /></button>
                  </div>
                ) : (
                  <button
                    data-testid="travaux-quick-pick-element"
                    onClick={() => setPicking(true)}
                    className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-brand-600 hover:text-brand-700"
                  ><Crosshair size={12} /> Cibler un élément sur la page</button>
                )}
              </div>
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <button className={btnPrimary} data-testid="travaux-quick-submit" onClick={submit} disabled={sending || !text.trim()}>
                  {sending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Ajouter à la file
                </button>
                {/* Début ou fin de la file — même bouton que la page /travaux et
                    que le FAB (lib/travauxQueue.jsx). */}
                <PlacementToggle
                  testId="travaux-quick-priority"
                  value={priority ? 'first' : 'last'}
                  onChange={v => setPriority(v === 'first')}
                />
                <span className="text-xs text-slate-400 ml-auto">⌘/Ctrl + Entrée</span>
              </div>
              {!data.agent_enabled && (
                <p className="mt-1.5 text-xs text-amber-700 inline-flex items-center gap-1">
                  <AlertTriangle size={12} /> Agent désactivé — l'item attendra dans la file.
                </p>
              )}
              {data.queue_paused && (
                <p className="mt-1.5 text-xs text-amber-700 inline-flex items-center gap-1" data-testid="travaux-quick-paused">
                  <PauseCircle size={12} /> File en pause — aucune nouvelle tâche ne démarre.
                </p>
              )}
            </div>

            {/* ── À répondre : le seul état où rien n'avance sans nous ──────── */}
            {!!asking.length && (
              <section className="space-y-2">
                <h3 className="text-[11px] uppercase tracking-wide text-violet-700 font-semibold inline-flex items-center gap-1">
                  <HelpCircle size={12} /> À répondre · {asking.length}
                </h3>
                {asking.map(p => <AskingCard key={p.id} p={p} onReply={reply} />)}
              </section>
            )}

            {/* ── En cours ─────────────────────────────────────────────────── */}
            {!!running.length && (
              <section className="space-y-1.5" data-testid="travaux-quick-running">
                <h3 className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold">En cours</h3>
                {running.map(p => (
                  <div key={p.id} className="rounded-lg border border-brand-300 ring-1 ring-brand-100 bg-white px-2.5 py-1.5" data-prompt-id={p.id}>
                    <div className="text-sm text-slate-800 truncate">{p.title || firstLine(p.prompt, 60)}</div>
                    <div className="mt-0.5"><StatusPill p={p} /></div>
                  </div>
                ))}
              </section>
            )}

            {/* ── La file, numérotée : la position, c'est l'ordre de départ ─── */}
            <section className="space-y-1.5">
              <h3 className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold">
                En file · {queue.length}
              </h3>
              {queue.length
                ? queue.map((p, i) => <QueueLine key={p.id} p={p} index={i + 1} />)
                : (
                  <p className="text-xs text-slate-400 rounded-lg border border-dashed border-slate-200 px-3 py-4 text-center">
                    Rien en attente. Ajoute un prompt ci-dessus — il partira tout seul.
                  </p>
                )}
              {!!pausedCount && (
                <p className="text-xs text-slate-400 pt-0.5">
                  {pausedCount} item{pausedCount > 1 ? 's' : ''} de côté — sur la page Travaux.
                </p>
              )}
            </section>
          </div>
        </aside>
      </div>
    </>
  )
}

/**
 * Provider global : l'état du panneau, sa lecture de la file (temps réel) et le
 * raccourci clavier. Monté une seule fois au-dessus des routes (App.jsx) — la
 * sidebar, elle, est remontée à chaque navigation, l'état survit ainsi au
 * changement de page.
 */
export function TravauxQuickProvider({ children }) {
  const { user } = useAuth()
  const [open, setOpen] = useState(false)

  // `active=1` : la file vivante seulement (la réponse complète embarque tout
  // l'historique et ses fils — trop lourde pour un panneau global). Sondage lent
  // seulement quand le panneau est ouvert ; sinon le temps réel suffit à la
  // pastille. Erreurs silencieuses : c'est une lecture de fond.
  const { data, load } = useTravauxPrompts({
    activeOnly: true,
    enabled: !!user,
    pollMs: open ? 20_000 : 0,
  })

  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault()
        setOpen(o => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Échap ferme — sauf pendant le ciblage d'un élément, que le picker gère lui-même
  // (il arrête la propagation en phase capture).
  useEffect(() => {
    if (!open) return undefined
    function onKey(e) { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const askingCount = useMemo(() => (data.prompts || []).filter(isAsking).length, [data.prompts])
  const activeCount = useMemo(
    () => (data.prompts || []).filter(p => ['running', 'queued'].includes(p.status) && !isAsking(p)).length,
    [data.prompts])

  const value = useMemo(() => ({ open, setOpen, askingCount, activeCount }), [open, askingCount, activeCount])

  return (
    <Ctx.Provider value={value}>
      {children}
      {user && open && (
        <QuickPanel onClose={() => setOpen(false)} data={data} load={load} />
      )}
    </Ctx.Provider>
  )
}
```


---

## `client/src/lib/pageContext.jsx`

**Système de ciblage de fonctionnalité / élément de page** : useElementPicker (survol + surbrillance + clic), description de l'élément, buildPageContext (chemin de page, record courant), PickerBanner.

```jsx
// Contexte de page joint aux demandes envoyées à l'agent — mécanisme UNIQUE,
// partagé par le FAB « Modifier le système » (FeedbackFab) et le panneau rapide
// de la file de travaux (TravauxQuickPanel).
//
// Trois briques :
//   1. `describeElement` — description compacte d'un élément DOM (ancres
//      exploitables : data-testid, id, aria…) pour que l'agent le retrouve dans
//      le code sans que l'utilisateur ait à le décrire.
//   2. `useElementPicker` — le mode « cliquer sur un élément » (bandeau appelant,
//      surbrillance au survol, clics de la page neutralisés).
//   3. `currentRecordLabel` / `buildPageContext` — la ligne de contexte finale :
//      route courante, fiche affichée, élément ciblé.
import { useEffect, useRef } from 'react'
import { MousePointerClick, X } from 'lucide-react'

/**
 * Description compacte de l'élément DOM cliqué, jointe en contexte de la demande.
 * Priorise les ancres exploitables (data-testid, id, aria).
 */
export function describeElement(el) {
  if (!(el instanceof Element)) return ''
  const attrs = []
  for (const name of ['data-testid', 'id', 'aria-label', 'placeholder', 'title', 'name']) {
    const v = el.getAttribute(name)
    if (v) attrs.push(`${name}="${v}"`)
  }
  const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 4).join(' ')
  if (cls) attrs.push(`class="${cls}"`)
  let desc = `<${el.tagName.toLowerCase()}${attrs.length ? ' ' + attrs.join(' ') : ''}>`
  const text = (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 80)
  if (text) desc += ` « ${text} »`
  // Ancre ancêtre identifiable la plus proche (repère supplémentaire dans le code).
  for (let anc = el.parentElement; anc && anc !== document.body; anc = anc.parentElement) {
    const tid = anc.getAttribute('data-testid')
    if (tid || anc.id) {
      desc += ` — dans <${anc.tagName.toLowerCase()} ${tid ? `data-testid="${tid}"` : `id="${anc.id}"`}>`
      break
    }
  }
  return desc.slice(0, 400)
}

/**
 * Libellé du record affiché quand la page est une fiche détail (`/factures/123`,
 * `/companies/42`…) : le titre `h1` de la page, c'est-à-dire ce que l'utilisateur
 * lit à l'écran. Une page de liste (`/orders`) n'a pas de record affiché — son
 * titre est le nom de la section, la route le dit déjà.
 */
export function currentRecordLabel(pathname = '') {
  if (typeof document === 'undefined') return ''
  const segments = String(pathname).split('/').filter(Boolean)
  if (segments.length < 2) return ''
  const h1 = document.querySelector('main h1') || document.querySelector('h1')
  const text = (h1?.innerText || '').trim().replace(/\s+/g, ' ')
  return text.slice(0, 120)
}

/**
 * Ligne de contexte jointe à la demande. Sans `record` ni `element`, c'est la
 * simple route courante — le format historique du FAB, que la page Agent affiche
 * telle quelle en pastille.
 */
export function buildPageContext({ pathname = '', search = '', element = '', record = '', appWide = false } = {}) {
  const page = `${pathname}${search || ''}`
  return (appWide
    ? `Demande concernant l'ensemble de l'application (pas seulement la page ${page})`
    : page)
    + (record ? ` — fiche affichée : « ${record} »` : '')
    + (element ? ` — élément ciblé par l'utilisateur : ${element}` : '')
}

/**
 * Bandeau flottant de l'étape « cliquer sur un élément ». Il porte
 * `data-feedback-picker` : ses propres boutons restent cliquables pendant que le
 * reste de la page est neutralisé.
 */
export function PickerBanner({ onSkip, onCancel, skipLabel = 'Demande générale', testIdPrefix = 'feedback' }) {
  return (
    <div
      data-feedback-picker
      data-testid={`${testIdPrefix}-pick-banner`}
      className="fixed top-4 left-1/2 -translate-x-1/2 z-[9991] flex items-center gap-3 bg-slate-900 text-white
        rounded-xl shadow-2xl pl-4 pr-2 py-2 text-sm max-w-[calc(100vw-2rem)]"
    >
      <MousePointerClick size={16} className="text-brand-400 flex-shrink-0" />
      <span className="whitespace-nowrap truncate">
        Cliquez sur l'élément concerné par votre demande
      </span>
      <div className="flex items-center gap-1 flex-shrink-0">
        <button
          type="button"
          data-testid={`${testIdPrefix}-skip-pick`}
          onClick={onSkip}
          className="px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-medium transition-colors"
        >
          {skipLabel}
        </button>
        <button
          type="button"
          data-testid={`${testIdPrefix}-cancel-pick`}
          onClick={onCancel}
          aria-label="Annuler"
          title="Annuler (Échap)"
          className="p-1.5 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition-colors"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}

/**
 * Mode « picking » : capture des événements au niveau document (phase capture)
 * pour intercepter le clic AVANT les handlers de la page (aucune navigation /
 * action ne doit se déclencher). Surbrillance de l'élément survolé via un overlay
 * non interactif repositionné au survol et au scroll.
 *
 * Les éléments portant `data-feedback-picker` (bandeau, FAB, panneau appelant)
 * gardent leur comportement normal — ce sont les commandes du picking lui-même.
 *
 * `onPick(description)` : un élément a été choisi. `onCancel()` : Échap.
 */
export function useElementPicker(picking, { onPick, onCancel } = {}) {
  // Les callbacks passent par une ref : l'effet ne doit dépendre que de `picking`,
  // sinon il se remonte à chaque render de l'appelant (surbrillance qui saute).
  const cb = useRef({ onPick, onCancel })
  cb.current = { onPick, onCancel }

  useEffect(() => {
    if (!picking) return
    const hl = document.createElement('div')
    hl.style.cssText = 'position:fixed;z-index:9990;pointer-events:none;display:none;' +
      'border:2px solid #21B14B;background:rgba(33,177,75,0.10);border-radius:4px;transition:all 60ms ease-out'
    document.body.appendChild(hl)
    const style = document.createElement('style')
    style.textContent = 'body.__feedback-picking *{cursor:crosshair!important}' +
      '[data-feedback-picker], [data-feedback-picker] *{cursor:default!important}' +
      '[data-feedback-picker] button{cursor:pointer!important}'
    document.head.appendChild(style)
    document.body.classList.add('__feedback-picking')

    let hoverEl = null
    const inPicker = t => t instanceof Element && t.closest('[data-feedback-picker]')
    function position(t) {
      const r = t.getBoundingClientRect()
      hl.style.display = 'block'
      hl.style.left = `${r.left - 2}px`
      hl.style.top = `${r.top - 2}px`
      hl.style.width = `${r.width}px`
      hl.style.height = `${r.height}px`
    }
    function onMove(e) {
      const t = e.target
      if (!(t instanceof Element) || inPicker(t) || t === document.body || t === document.documentElement) {
        hoverEl = null
        hl.style.display = 'none'
        return
      }
      hoverEl = t
      position(t)
    }
    function onScroll() { if (hoverEl) position(hoverEl) }
    function onDown(e) {
      if (inPicker(e.target)) return
      e.preventDefault()
      e.stopPropagation()
    }
    function onClick(e) {
      if (inPicker(e.target)) return
      e.preventDefault()
      e.stopPropagation()
      const target = hoverEl || (e.target instanceof Element ? e.target : null)
      cb.current.onPick?.(describeElement(target))
    }
    function onKey(e) {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      cb.current.onCancel?.()
    }
    document.addEventListener('mouseover', onMove, true)
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('scroll', onScroll, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mouseover', onMove, true)
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('keydown', onKey, true)
      hl.remove()
      style.remove()
      document.body.classList.remove('__feedback-picking')
    }
  }, [picking])
}
```


---

## `client/src/components/FeedbackFab.jsx`

**Le bouton en bas à droite** (« Modifier le système »). Monté dans Layout donc présent partout ; dépose la demande comme prompt dans la file Travaux, avec la page et l'élément ciblé joints au texte.

```jsx
import { useState, useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { MessageSquarePlus, Wrench, HelpCircle, MousePointerClick, Crosshair, X, Globe } from 'lucide-react'
import { Modal } from './Modal.jsx'
import { api } from '../lib/api.js'
import { getIsOffline } from '../lib/serverStatus.js'
import { useToast } from '../contexts/ToastContext.jsx'
// Ciblage d'un élément de la page + ligne de contexte : mécanisme partagé avec le
// panneau rapide de la file de travaux (lib/pageContext.jsx).
import { useElementPicker, buildPageContext, PickerBanner } from '../lib/pageContext.jsx'
// Bouton « au début / à la fin de la file » : le même que la page /travaux et le
// panneau rapide — un seul geste à apprendre, où qu'on dépose une tâche.
import { PlacementToggle } from '../lib/travauxQueue.jsx'

// FAB discret « Modifier le système », monté dans Layout donc visible sur
// toutes les pages. Une seule destination : la demande est déposée comme prompt
// dans la file de la section Travaux (/travaux), avec la page courante et
// l'élément ciblé inclus dans le texte du prompt — c'est lui que l'agent reçoit.
// Le serveur relance l'ordonnanceur à la création : si rien ne tourne, la tâche
// part tout de suite ; sinon elle attend son tour — à la fin de la file par
// défaut, ou devant tout le reste si on a basculé le bouton de placement. Le choix de
// destination (« Tout de suite » vs « Ma file Travaux ») a été retiré — les deux
// menaient au même exécuteur, à ceci près que la voie « tout de suite » doublait
// la file au lieu de la respecter.
//
// Le clic sur le FAB ouvre directement le formulaire : par défaut la demande
// est considérée comme générale (concernant la page courante, aucun élément
// ciblé). L'utilisateur peut ensuite, au besoin, cliquer sur « Cibler un
// élément sur la page » pour passer en mode « picking » (bandeau flottant +
// surbrillance au survol) : l'élément cliqué est alors décrit et joint en
// contexte pour qu'il n'ait qu'à expliquer QUOI changer, pas OÙ.

// Persistance par onglet de l'état de la modale (ouverte + brouillon).
// La connexion au serveur se perd typiquement PENDANT que l'utilisateur tape
// une suggestion (l'agent redémarre pm2 / redéploie le frontend) : la modale
// doit survivre au reload forcé par ServerOfflineOverlay quand le bundle JS a
// changé, et à la navigation (Layout est remonté à chaque page).
const STORAGE_KEY = 'erp_feedback_fab_state'

function readPersisted() {
  try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null') || {} } catch { return {} }
}

export function FeedbackFab() {
  const location = useLocation()
  const { addToast } = useToast()
  const [open, setOpen] = useState(() => !!readPersisted().open)
  const [text, setText] = useState(() => readPersisted().text || '')
  // mode : 'implement' (l'agent code un correctif) ou 'question' (l'agent répond
  // sans rien modifier — la réponse apparaît sur la carte de la page Agent).
  const [mode, setMode] = useState(() => readPersisted().mode === 'question' ? 'question' : 'implement')
  // Descriptif de l'élément de la page cliqué en étape 1 ('' = demande générale).
  const [element, setElement] = useState(() => readPersisted().element || '')
  // Portée de la demande : false = liée à la page courante (défaut), true = concerne
  // l'ensemble de l'app. Change le contexte joint (chemin de page vs mention globale).
  const [appWide, setAppWide] = useState(() => !!readPersisted().appWide)
  // Où la demande se dépose dans la file : 'last' (défaut, on respecte l'ordre
  // déjà en place) ou 'first' (elle passe devant tout le reste).
  const [placement, setPlacement] = useState(() => readPersisted().placement === 'first' ? 'first' : 'last')
  // Mode « picking » : transitoire (non persisté), bandeau + surbrillance actifs.
  const [picking, setPicking] = useState(false)
  // Le picking a-t-il été (re)lancé depuis le formulaire ? → Échap y retourne.
  const fromFormRef = useRef(false)
  const [saving, setSaving] = useState(false)
  const isQuestion = mode === 'question'

  useEffect(() => {
    try {
      if (open) sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ open, text, mode, element, appWide, placement }))
      else sessionStorage.removeItem(STORAGE_KEY)
    } catch { /* stockage indisponible (mode privé strict) — dégradation silencieuse */ }
  }, [open, text, mode, element, appWide, placement])

  // Étape « picking » — surbrillance, neutralisation des clics de la page et
  // description de l'élément choisi : lib/pageContext.jsx.
  useElementPicker(picking, {
    onPick: (desc) => { setElement(desc); setPicking(false); setOpen(true) },
    onCancel: () => { setPicking(false); if (fromFormRef.current) setOpen(true) },
  })

  function reset() {
    setText('')
    setMode('implement')
    setElement('')
    setAppWide(false)
    setPlacement('last')
  }

  function close() {
    // Connexion au serveur perdue : ignorer toute fermeture (ex. Échap pendant
    // que l'overlay hors-ligne recouvre la modale) — fermer effacerait le
    // brouillon en cours de frappe.
    if (getIsOffline()) return
    setOpen(false)
    reset()
  }

  // Ouvre directement le formulaire en demande générale (page courante, aucun
  // élément ciblé). Le ciblage d'un élément reste accessible depuis le
  // formulaire via « Cibler un élément sur la page ».
  function openForm() {
    setPicking(false)
    setOpen(true)
  }

  // (Re)lancer le ciblage depuis le formulaire — le brouillon reste en état.
  function repickFromForm() {
    fromFormRef.current = true
    setOpen(false)
    setPicking(true)
  }

  function skipPicking() {
    setPicking(false)
    setOpen(true)
  }

  function cancelPicking() {
    setPicking(false)
    if (fromFormRef.current) setOpen(true)
  }

  async function submit(e) {
    e.preventDefault()
    const trimmed = text.trim()
    if (!trimmed || saving) return
    setSaving(true)
    const context = buildPageContext({
      pathname: location.pathname, search: location.search, element, appWide,
    })
    try {
      // Dépose un prompt dans la file de la section Travaux — le contexte (page +
      // élément ciblé) est inclus dans le prompt, c'est lui que l'agent recevra.
      // Le serveur relance l'ordonnanceur : la tâche part tout de suite si rien
      // ne tourne, sinon elle attend son tour en fin de file.
      const created = await api.travaux.createPrompt({
        prompt: `${trimmed}\n\nContexte (ERP) : ${context}`,
        mode,
        space: 'finance',
        // Le serveur dépose l'item devant la file quand priority est vrai.
        priority: placement === 'first',
      })
      // Pas d'écran de confirmation : la demande est déposée, on referme
      // directement. Un toast suffit à accuser réception sans étape de plus.
      setOpen(false)
      reset()
      addToast({
        message: created?.status === 'running'
          ? 'Demande envoyée — l\'agent s\'y met tout de suite'
          : placement === 'first' ? 'Ajoutée en tête de ta file Travaux' : 'Ajoutée à ta file Travaux',
        type: 'success',
      })
    } catch {
      addToast({ message: 'Échec de l\'envoi de la suggestion', type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      {/* z-[9989] : au-dessus des modales/drawers de l'app (z-50) pour rester
          cliquable même quand une modale est ouverte — la demande peut concerner
          un élément DANS une modale. Reste sous la bannière de picking (9991) et
          l'overlay de surbrillance (9990). Masqué pendant que SA propre modale
          est ouverte (open) pour ne pas chevaucher son pied de page. */}
      <button
        type="button"
        data-testid="feedback-fab"
        data-feedback-picker
        onClick={openForm}
        title="Modifier le système"
        aria-label="Modifier le système"
        className={`fixed bottom-5 right-5 z-[9989] w-11 h-11 rounded-full bg-brand-600 text-white shadow-lg
          items-center justify-center hover:bg-brand-700 hover:scale-105 active:scale-95
          transition-all opacity-60 hover:opacity-100 print:hidden ${open ? 'hidden' : 'flex'}`}
      >
        <MessageSquarePlus size={18} />
      </button>

      {/* Bandeau flottant de l'étape « cliquer sur un élément » (partagé). */}
      {picking && <PickerBanner onSkip={skipPicking} onCancel={cancelPicking} />}

      <Modal
        isOpen={open}
        onClose={close}
        title="Modifier le système"
        size="sm"
      >
        {/* Bouton Envoyer requis : c'est une création de record (exception
            admise à la règle autosave). Pas d'écran de confirmation après
            l'envoi : la demande est déposée et la modale se referme aussitôt. */}
        <form onSubmit={submit} className="space-y-4">
          {/* Choix du mode : demande d'implémentation vs simple question.
              Une question n'implémente rien — l'agent répond dans le compte-rendu
              de la carte (page Agent). */}
          <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-lg" role="radiogroup" aria-label="Type de demande">
            <button
              type="button"
              data-testid="feedback-mode-implement"
              role="radio"
              aria-checked={!isQuestion}
              onClick={() => setMode('implement')}
              className={`flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-sm font-medium transition-colors ${!isQuestion ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            >
              <Wrench size={14} /> Implémentation
            </button>
            <button
              type="button"
              data-testid="feedback-mode-question"
              role="radio"
              aria-checked={isQuestion}
              onClick={() => setMode('question')}
              className={`flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-sm font-medium transition-colors ${isQuestion ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
            >
              <HelpCircle size={14} /> Question
            </button>
          </div>

          {/* Élément ciblé en étape 1 — joint en contexte, retirable. */}
          {element ? (
            <div data-testid="feedback-element-chip" className="flex items-start gap-2 bg-brand-50 border border-brand-200 rounded-lg px-3 py-2">
              <MousePointerClick size={14} className="text-brand-600 flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="text-[11px] font-semibold text-brand-800">Élément ciblé — joint en contexte</div>
                <div className="text-xs font-mono text-slate-600 break-all line-clamp-2">{element}</div>
              </div>
              <button
                type="button"
                data-testid="feedback-element-remove"
                onClick={() => setElement('')}
                aria-label="Retirer l'élément ciblé"
                title="Retirer l'élément ciblé"
                className="text-slate-400 hover:text-slate-600 flex-shrink-0 mt-0.5"
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <button
              type="button"
              data-testid="feedback-pick-element"
              onClick={repickFromForm}
              className="inline-flex items-center gap-1.5 text-xs text-brand-600 hover:text-brand-700 font-medium"
            >
              <Crosshair size={13} /> Cibler un élément sur la page
            </button>
          )}

          <p className="text-sm text-slate-500" data-testid="feedback-mode-hint">
            {isQuestion
              ? (element
                ? 'Posez votre question sur l\'élément ciblé — pas besoin de le décrire, il est joint. L\'agent répondra sans rien modifier.'
                : 'Posez votre question sur le système. L\'agent y répondra sans rien modifier — la réponse apparaîtra sur la carte.')
              : (element
                ? 'Décrivez ce que vous voulez changer — pas besoin de décrire l\'élément, il est joint en contexte.'
                : 'Décrivez le problème ou l\'amélioration souhaitée. L\'agent implémentera le correctif.')}
          </p>
          <textarea
            data-testid="feedback-fab-text"
            value={text}
            onChange={e => setText(e.target.value)}
            rows={5}
            autoFocus
            className="input w-full resize-y"
            placeholder={isQuestion
              ? 'Ex. : Comment le total d\'une facture est-il calculé quand il y a un rabais ?'
              : (element
                ? 'Ex. : Rendre ce bouton plus visible et l\'aligner à droite…'
                : 'Ex. : Le filtre par date ne garde pas ma sélection quand je change de page…')}
          />
          {/* Placement dans la file — bouton discret, sous le champ : la
              demande part à la fin de la file par défaut, un clic la met au
              début. Même contrôle que la page /travaux. */}
          <div className="flex justify-end -mt-2">
            <PlacementToggle
              testId="feedback-placement"
              value={placement}
              onChange={setPlacement}
            />
          </div>
          <div className="flex items-center justify-between gap-3 pt-1">
            {/* Portée de la demande : par défaut la page courante est jointe en
                contexte ; le bouton bascule vers « toute l'application » quand
                la demande n'est pas propre à cette page. */}
            <button
              type="button"
              data-testid="feedback-scope-toggle"
              onClick={() => setAppWide(v => !v)}
              title={appWide
                ? 'La demande concerne toute l\'application — cliquer pour la relier à la page courante'
                : 'La demande concerne cette page — cliquer pour l\'appliquer à toute l\'application'}
              className={`inline-flex items-center gap-1.5 text-xs font-medium truncate transition-colors min-w-0 ${appWide ? 'text-brand-600' : 'text-slate-400 hover:text-slate-600'}`}
            >
              {appWide ? (
                <>
                  <Globe size={12} className="flex-shrink-0" />
                  <span className="truncate">Toute l'application</span>
                </>
              ) : (
                <span className="font-mono truncate">{location.pathname}{location.search}</span>
              )}
            </button>
            <div className="flex gap-3 flex-shrink-0">
              <button type="button" onClick={close} className="btn-secondary">Annuler</button>
              <button
                type="submit"
                data-testid="feedback-fab-submit"
                disabled={saving || !text.trim()}
                className="btn-primary"
              >
                {saving ? 'Envoi…' : 'Envoyer'}
              </button>
            </div>
          </div>
        </form>
      </Modal>
    </>
  )
}
```


---

## `client/src/lib/api.js (extrait — objet `travaux`)`

Client HTTP utilisé par la page, le panneau rapide et le FAB. Les méthodes `*Recurring` / `setCompletion` / `listCompletions` sont retirées.

```js
  // Travaux : file de prompts, suggestions de l'agent, carnet d'idées, travaux
  // récurrents.
  // Les listes sont pollées via getFresh (pas de cache) : la file change en
  // arrière-plan à chaque fin d'exécution, un cache de 30 s la ferait mentir.
  travaux: {
    // `space` sépare les deux files : 'finance' (Espace finance) / 'agent' (section Agent).
    listPrompts:   (params = {}) => getFresh('/travaux/prompts' + (Object.keys(params).length ? '?' + new URLSearchParams(params) : '')),
    createPrompt:  (data)      => post('/travaux/prompts', data),
    updatePrompt:  (id, data)  => patch(`/travaux/prompts/${id}`, data),
    deletePrompt:  (id)        => del(`/travaux/prompts/${id}`),
    reorderPrompts:(ids)       => post('/travaux/prompts/reorder', { ids }),
    promptFirst:   (id)        => post(`/travaux/prompts/${id}/first`, {}),
    advanceQueue:  ()          => post('/travaux/prompts/advance', {}),
    // Pause de la file : rien de nouveau ne démarre, l'exécution en cours va au bout.
    getQueuePause: ()          => getFresh('/travaux/queue/pause'),
    setQueuePaused:(paused, reason) => post('/travaux/queue/pause', { paused, reason }),
    listMessages:  (id)        => getFresh(`/travaux/prompts/${id}/messages`),
    // placement : 'front' (défaut) = la tâche repart tout de suite ; 'back' = elle
    // retourne en fin de file et repartira quand son tour reviendra.
    replyToPrompt: (id, text, placement)  => post(`/travaux/prompts/${id}/reply`, { text, ...(placement ? { placement } : {}) }),
    // Steering : message livré à Claude PENDANT l'exécution, sans l'interrompre.
    steerPrompt:   (id, text)  => post(`/travaux/prompts/${id}/message`, { text }),

    listSuggestions:  (params = {}) => getFresh('/travaux/suggestions?' + new URLSearchParams(params)),
    acceptSuggestion: (id, prompt, space, priority) => post(`/travaux/suggestions/${id}/accept`, {
      ...(prompt ? { prompt } : {}), ...(space ? { space } : {}), ...(priority ? { priority: true } : {}),
    }),
    dismissSuggestion:(id, reason)  => post(`/travaux/suggestions/${id}/dismiss`, { reason }),
    deleteSuggestion: (id)          => del(`/travaux/suggestions/${id}`),
    // Sans `kind`, le serveur passe les deux moteurs (chantiers + intégrations).
    generateSuggestions: (kind)     => post('/travaux/suggestions/generate', kind ? { kind } : {}),
    // Discussion d'une suggestion (chantier ou intégration) : échange en lecture
    // seule à côté de la carte — rien ne part en exécution par ce chemin.
    listSuggestionMessages: (id)       => getFresh(`/travaux/suggestions/${id}/messages`),
    askSuggestion:          (id, text) => post(`/travaux/suggestions/${id}/messages`, { text }),

    // Carnet d'idées : rien ne s'exécute d'ici ; `promoteIdea` dépose un item de
    // file « de côté », à lancer à la main.
    listIdeas:    ()         => getFresh('/travaux/ideas'),
    createIdea:   (data)     => post('/travaux/ideas', data),
    updateIdea:   (id, data) => patch(`/travaux/ideas/${id}`, data),
    deleteIdea:   (id)       => del(`/travaux/ideas/${id}`),
    reorderIdeas: (ids)      => post('/travaux/ideas/reorder', { ids }),
    promoteIdea:  (id, space) => post(`/travaux/ideas/${id}/promote`, space ? { space } : {}),

    // [… méthodes « travaux récurrents » retirées de cet export …]
  },
```


---

## `server/src/routes/travaux.js`

Routes REST. Bloc « Travaux récurrents » (routes /recurring*) et l'import de recurringWork.js retirés.

```js
// Routes de la page /travaux : file de prompts, suggestions de l'agent, travaux
// récurrents. Validation manuelle, erreurs uniformes { error }.
import { Router } from 'express'
import { requireAuth } from '../middleware/auth.js'
import {
  listPrompts, getPrompt, createPrompt, updatePrompt, deletePrompt,
  reorderPrompts, moveToFront, advanceQueue, listMessages, replyToPrompt,
  steerPrompt, getQueuePauseState, pauseQueue, resumeQueue, PROMPT_SPACES,
} from '../services/promptQueue.js'
import {
  listSuggestions, acceptSuggestion, dismissSuggestion, deleteSuggestion,
  addSuggestion, runSuggestionEngines, SUGGESTION_KINDS,
  getSuggestion, listSuggestionMessages, askSuggestion, isAnswering,
} from '../services/workSuggestions.js'
import {
  listIdeas, createIdea, updateIdea, deleteIdea, reorderIdeas, promoteIdea,
} from '../services/workIdeas.js'
import {
  getSettings, isRunnerBusy, findAgentTask,
  getRunningQuestionCount, getMaxParallelQuestions,
} from '../services/taskRunner.js'

const router = Router()
router.use(requireAuth)

// ─── File de prompts ──────────────────────────────────────────────────────────

/**
 * « running » côté file ne veut PAS dire « Claude travaille dessus » : l'item a été
 * remis à l'ordonnanceur, qui ne démarre qu'une implémentation à la fois (et au plus
 * getMaxParallelQuestions() questions). Deux réponses envoyées coup sur coup dans
 * deux fils différents donnaient donc deux cartes « en cours » alors qu'une seule
 * avançait. On distingue l'état réel de la tâche agent :
 *   'executing' → le process Claude tourne pour cet item
 *   'waiting'   → dans la file de l'ordonnanceur, en attente d'un poste libre
 */
function runState(p, task) {
  if (p.status !== 'running') return null
  // Tâche introuvable = exécution perdue : advanceQueue la réconciliera au prochain
  // passage. En attendant, ne pas prétendre que ça tourne.
  if (!task) return 'waiting'
  return task.status === 'in_progress' ? 'executing' : 'waiting'
}

/** Voie d'exécution d'un item : les questions ont leur propre file (parallèle). */
function laneOf(p) {
  return (p.mode === 'question' && !p.same_context) ? 'question' : 'exec'
}

/**
 * Question en attente : stockée en JSON sur la colonne, rendue au front en objet
 * { question, options[] }. Un JSON illisible (écriture d'une version antérieure)
 * dégrade en question sans choix plutôt que de casser la page.
 */
function parseQuestion(raw) {
  if (!raw) return null
  try {
    const q = JSON.parse(raw)
    if (!q?.question) return null
    return { question: String(q.question), options: Array.isArray(q.options) ? q.options.map(String) : [] }
  } catch {
    return { question: String(raw), options: [] }
  }
}

// Le compte-rendu vit sur la tâche agent : on le rapatrie sur l'item pour que la
// page n'ait pas à croiser deux sources (et reste lisible après un /clear).
function withResult(p) {
  const task = p.agent_task_id ? findAgentTask(p.agent_task_id) : null
  return {
    ...p,
    pending_question: parseQuestion(p.pending_question),
    user_summary: task?.user_summary || null,
    agent_status: task?.status || null,
    run_state: runState(p, task),
    lane: laneOf(p),
    // Le fil est joint à la liste : quelques messages courts par tâche, ça évite un
    // aller-retour par carte pour l'afficher.
    messages: listMessages(p.id),
  }
}

/**
 * Rang d'attente affiché sur les cartes (« 2e à partir »), calculé par voie : un item
 * ne se compare qu'à ceux qui lui disputent le même poste. Les items déjà remis à
 * l'ordonnanceur passent avant ceux encore en file côté page.
 */
function withWaitRank(rows) {
  const counters = { exec: 0, question: 0 }
  const waiting = rows
    .filter(p => p.run_state === 'waiting' || p.status === 'queued')
    .sort((a, b) => {
      const ai = a.run_state === 'waiting' ? 0 : 1
      const bi = b.run_state === 'waiting' ? 0 : 1
      if (ai !== bi) return ai - bi
      // Déjà remis à l'ordonnanceur : l'ordre est celui de la remise (started_at est
      // horodaté au moment où l'item lui est passé), pas la position dans la page.
      if (!ai) return String(a.started_at || '').localeCompare(String(b.started_at || ''))
      return (a.position - b.position) || a.created_at.localeCompare(b.created_at)
    })
  const ranks = new Map()
  for (const p of waiting) ranks.set(p.id, ++counters[p.lane])
  return rows.map(p => ({ ...p, wait_rank: ranks.get(p.id) || null }))
}

/** Item « vivant » : il occupe la file ou attend une décision de l'utilisateur. */
function isActivePrompt(p) {
  return ['running', 'queued', 'paused'].includes(p.status)
    || (!!p.pending_question?.question && ['done', 'blocked'].includes(p.status))
}

router.get('/prompts', (req, res) => {
  const space = req.query.space || null
  if (space && !PROMPT_SPACES.includes(space)) return res.status(400).json({ error: 'space invalide' })
  // `active=1` : uniquement la file vivante, sans l'historique terminé et ses fils.
  // La réponse complète pèse plusieurs centaines de Ko — trop lourde pour le
  // panneau rapide, ouvert depuis n'importe quelle page de l'ERP.
  const activeOnly = req.query.active === '1' || req.query.active === 'true'
  // Les rangs d'attente se calculent sur TOUTES les files (l'exécuteur est partagé :
  // « 2e à partir » doit compter les items de l'autre file aussi), puis on ne rend
  // que la file demandée. Sans `space`, tout (rétro-compatible).
  const prompts = withWaitRank(listPrompts().map(withResult))
    .filter(p => !space || p.space === space)
    .filter(p => !activeOnly || isActivePrompt(p))
  const pause = getQueuePauseState()
  res.json({
    prompts,
    agent_enabled: !!getSettings().enabled,
    // Pause manuelle de la file : rien ne démarre tant qu'elle tient.
    queue_paused: pause.paused,
    queue_paused_at: pause.paused_at,
    queue_paused_reason: pause.reason,
    runner_busy: isRunnerBusy(),
    // Voie lecture seule : les questions tournent en parallèle d'un chantier.
    running_questions: getRunningQuestionCount(),
    max_parallel_questions: getMaxParallelQuestions(),
  })
})

router.post('/prompts', (req, res) => {
  const { title, prompt, mode, preset, status, priority, space } = req.body || {}
  if (!prompt || !String(prompt).trim()) return res.status(400).json({ error: 'prompt requis' })
  if (mode && !['implement', 'question'].includes(mode)) return res.status(400).json({ error: 'mode invalide' })
  // 'auto' = calibre jugé par le modèle à partir de la demande (voir promptPreset.js).
  if (preset && !['auto', 'fast', 'standard', 'deep'].includes(preset)) return res.status(400).json({ error: 'preset invalide' })
  if (status && !['queued', 'paused'].includes(status)) return res.status(400).json({ error: 'status invalide' })
  if (space && !PROMPT_SPACES.includes(space)) return res.status(400).json({ error: 'space invalide' })
  // Reprendre le contexte du précédent était un choix manuel — retiré : un item
  // créé de zéro part toujours avec un contexte neuf. La vraie continuité (réponse,
  // relance fauchée) passe par `follow_up`, décidé automatiquement, pas ici.
  const created = createPrompt({
    title, prompt, mode, preset, status, space,
    // Coché à la création : l'item passe devant la file (même effet que le bouton
    // « Passer en premier », sans avoir à le cliquer après coup).
    priority: !!priority,
    created_by: req.user?.id || null,
  })
  // Rien ne tourne → l'item part tout de suite ; sinon il attend son tour.
  advanceQueue()
  res.status(201).json(withResult(getPrompt(created.id)))
})

router.patch('/prompts/:id', (req, res) => {
  const updated = updatePrompt(req.params.id, req.body || {})
  if (!updated) return res.status(404).json({ error: 'introuvable' })
  advanceQueue()
  res.json(withResult(updated))
})

router.delete('/prompts/:id', (req, res) => {
  if (!deletePrompt(req.params.id)) return res.status(404).json({ error: 'introuvable' })
  res.json({ ok: true })
})

router.post('/prompts/reorder', (req, res) => {
  const { ids } = req.body || {}
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids requis' })
  // reorderPrompts se charge lui-même de rendre à l'ordonnanceur les items qu'il lui
  // a repris ; un simple changement de priorité ne déclenche donc rien.
  res.json({ prompts: withWaitRank(reorderPrompts(ids).map(withResult)) })
})

router.post('/prompts/:id/first', (req, res) => {
  const p = moveToFront(req.params.id)
  if (!p) return res.status(404).json({ error: 'introuvable' })
  advanceQueue()
  res.json(withResult(p))
})

// Fil de discussion d'une tâche.
router.get('/prompts/:id/messages', (req, res) => {
  if (!getPrompt(req.params.id)) return res.status(404).json({ error: 'introuvable' })
  res.json({ messages: listMessages(req.params.id) })
})

// Réponse de l'humain → relance de la tâche avec ce complément. `placement` choisit
// le moment : 'front' (défaut) = repart tout de suite, avant le reste de la file ;
// 'back' = retourne en FIN de file et repartira quand son tour reviendra.
router.post('/prompts/:id/reply', (req, res) => {
  const { text, placement } = req.body || {}
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text requis' })
  if (placement && !['front', 'back'].includes(placement)) return res.status(400).json({ error: 'placement invalide' })
  const out = replyToPrompt(req.params.id, { text, userId: req.user?.id || null, placement })
  if (!out) return res.status(404).json({ error: 'introuvable' })
  if (out.error === 'running') {
    return res.status(409).json({ error: 'la tâche est en cours d\'exécution — réponds quand elle a rendu la main' })
  }
  if (out.error) return res.status(400).json({ error: 'réponse vide' })
  res.status(201).json(withResult(out.prompt))
})

// Message envoyé PENDANT l'exécution (steering, comme dans Claude Code) : livré à
// Claude en cours de tâche sans l'interrompre. `delivered` dit par quelle voie :
// 'live' (l'exécution tourne, le hook le glisse au prochain outil) ou 'queued'
// (la tâche attend son tour, le message est intégré au brief avant le départ).
router.post('/prompts/:id/message', (req, res) => {
  const { text } = req.body || {}
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text requis' })
  const out = steerPrompt(req.params.id, { text, userId: req.user?.id || null })
  if (!out) return res.status(404).json({ error: 'introuvable' })
  if (out.error === 'not-running') {
    return res.status(409).json({ error: 'la tâche a rendu la main — utilise « Répondre et relancer »' })
  }
  if (out.error) return res.status(400).json({ error: 'message vide' })
  res.status(201).json({ ...withResult(out.prompt), delivered: out.delivered })
})

// Relance manuelle de l'ordonnanceur (bouton « Lancer la file »). `reason` dit
// pourquoi rien n'a démarré : file vide, agent désactivé, ou exécution en cours.
router.post('/prompts/advance', (req, res) => {
  const { started, startedCount, reason } = advanceQueue()
  res.json({ started: started ? withResult(started.prompt) : null, startedCount, reason })
})

// ─── Pause de la file ─────────────────────────────────────────────────────────
// Bouton assumé (pas d'autosave) : mettre la file en pause / la reprendre est une
// action à effet réel — elle décide si des exécutions Claude démarrent ou non.
// La pause n'interrompt JAMAIS l'exécution en cours : elle bloque seulement les
// départs, donc reprendre repart exactement où la file s'était arrêtée.

router.get('/queue/pause', (req, res) => {
  res.json(getQueuePauseState())
})

router.post('/queue/pause', (req, res) => {
  const { paused, reason } = req.body || {}
  if (typeof paused !== 'boolean') return res.status(400).json({ error: 'paused (booléen) requis' })
  res.json(paused ? pauseQueue({ reason: reason || null }) : resumeQueue())
})

// ─── Suggestions de l'agent ───────────────────────────────────────────────────

router.get('/suggestions', (req, res) => {
  const status = req.query.status || null
  const kind = req.query.kind || null
  if (status && !['new', 'accepted', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: 'status invalide' })
  }
  if (kind && !SUGGESTION_KINDS.includes(kind)) return res.status(400).json({ error: 'kind invalide' })
  res.json({ suggestions: listSuggestions({ status, kind }) })
})

router.post('/suggestions', (req, res) => {
  const { title, prompt, rationale, area, kind } = req.body || {}
  if (!title || !prompt) return res.status(400).json({ error: 'title et prompt requis' })
  if (kind && !SUGGESTION_KINDS.includes(kind)) return res.status(400).json({ error: 'kind invalide' })
  const created = addSuggestion({ title, prompt, rationale, area, kind })
  if (!created) return res.status(409).json({ error: 'suggestion déjà présente' })
  res.status(201).json(created)
})

router.post('/suggestions/:id/accept', (req, res) => {
  const space = req.body?.space || 'finance'
  if (!PROMPT_SPACES.includes(space)) return res.status(400).json({ error: 'space invalide' })
  const out = acceptSuggestion(req.params.id, {
    userId: req.user?.id || null,
    overridePrompt: req.body?.prompt || null,
    priority: !!req.body?.priority,
    // La suggestion rejoint la file de la section d'où elle est acceptée.
    space,
  })
  if (!out) return res.status(404).json({ error: 'introuvable' })
  advanceQueue()
  res.json(out)
})

router.post('/suggestions/:id/dismiss', (req, res) => {
  const s = dismissSuggestion(req.params.id, req.body?.reason || null)
  if (!s) return res.status(404).json({ error: 'introuvable' })
  res.json(s)
})

router.delete('/suggestions/:id', (req, res) => {
  deleteSuggestion(req.params.id)
  res.json({ ok: true })
})

// Fil de discussion d'une suggestion : « dis-m'en plus » avant de décider. Rien ne
// s'exécute par ce chemin — c'est un échange en lecture seule à côté de la carte.
router.get('/suggestions/:id/messages', (req, res) => {
  if (!getSuggestion(req.params.id)) return res.status(404).json({ error: 'introuvable' })
  res.json({ messages: listSuggestionMessages(req.params.id), pending: isAnswering(req.params.id) })
})

router.post('/suggestions/:id/messages', (req, res) => {
  const { text } = req.body || {}
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text requis' })
  const out = askSuggestion(req.params.id, { text, userId: req.user?.id || null })
  if (!out) return res.status(404).json({ error: 'introuvable' })
  if (out.error === 'busy') return res.status(409).json({ error: 'Claude est déjà en train de répondre — attends sa réponse' })
  if (out.error) return res.status(400).json({ error: 'message vide' })
  res.status(201).json(out)
})

// Passage manuel du moteur. Long (appel modèle) → on répond tout de suite et la
// page se met à jour par la diffusion temps réel quand les suggestions arrivent.
// `kind` restreint à un moteur (chantiers ou intégrations) ; sans lui, les deux.
router.post('/suggestions/generate', (req, res) => {
  const kind = req.body?.kind || null
  if (kind && !SUGGESTION_KINDS.includes(kind)) return res.status(400).json({ error: 'kind invalide' })
  runSuggestionEngines({ kind }).catch(e => console.error('🤖 Suggestions de travaux:', e.message))
  res.status(202).json({ ok: true })
})

// ─── Carnet d'idées ───────────────────────────────────────────────────────────
// Aucune route de cette section ne déclenche d'exécution : la seule qui touche à
// l'agent (promote) dépose l'item « de côté ».

router.get('/ideas', (req, res) => {
  res.json({ ideas: listIdeas() })
})

router.post('/ideas', (req, res) => {
  const { title, notes, tag } = req.body || {}
  if (!title || !String(title).trim()) return res.status(400).json({ error: 'title requis' })
  res.status(201).json(createIdea({ title, notes, tag, created_by: req.user?.id || null }))
})

router.patch('/ideas/:id', (req, res) => {
  const updated = updateIdea(req.params.id, req.body || {})
  if (!updated) return res.status(404).json({ error: 'introuvable' })
  res.json(updated)
})

router.delete('/ideas/:id', (req, res) => {
  if (!deleteIdea(req.params.id)) return res.status(404).json({ error: 'introuvable' })
  res.json({ ok: true })
})

router.post('/ideas/reorder', (req, res) => {
  const { ids } = req.body || {}
  if (!Array.isArray(ids)) return res.status(400).json({ error: 'ids requis' })
  res.json({ ideas: reorderIdeas(ids) })
})

// Passage à l'action : crée un item de file « de côté » (jamais lancé d'office).
router.post('/ideas/:id/promote', (req, res) => {
  const space = req.body?.space || 'finance'
  if (!PROMPT_SPACES.includes(space)) return res.status(400).json({ error: 'space invalide' })
  const out = promoteIdea(req.params.id, { userId: req.user?.id || null, prompt: req.body?.prompt || null, space })
  if (!out) return res.status(404).json({ error: 'introuvable' })
  res.status(out.already ? 200 : 201).json(out)
})

// [… routes des travaux récurrents retirées de cet export …]

export default router
```


---

## `server/src/services/promptQueue.js`

File de prompts : ordre, statuts, réponses/steering, pause, avancement de la file.

```js
// File de prompts (page /travaux, onglet « Ma file »).
//
// Remplace le va-et-vient manuel « je colle un prompt → j'attends → /clear → le
// suivant » : les prompts vivent en DB, le serveur en pousse UN à la fois dans
// l'ordonnanceur de l'agent (taskRunner), et chaque exécution part d'un contexte
// neuf — sauf les items marqués « même contexte », qui reprennent la session
// Claude du précédent via --resume. À la fin de chaque item, un recap part dans le
// DM Slack perso : c'est ce qui permet de ne plus surveiller le terminal.
//
// Un seul item « running » à la fois, garanti par advanceQueue() : l'agent n'a
// qu'un slot d'exécution (il édite l'arbre de travail réel, sans isolation).
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { broadcastAll } from './realtime.js'
import {
  enqueueAgentTask, findAgentTask, getSettings, presetFor, getMaxParallelQuestions,
  generateUserSummary, isQueuePaused, setQueuePaused,
  updatePendingAgentTask, cancelPendingAgentTask, sendSteeringMessage,
} from './taskRunner.js'
import { heuristicTitle, refineTitle, refineProjectTitle } from './promptTitle.js'
import { classifyPreset, provisionalPreset, PRESET_KEYS } from './promptPreset.js'

const APP_URL = (process.env.APP_URL || 'https://customer.orisha.io').replace(/\/$/, '')

// Items dont l'exécution avec --resume a échoué et qui ont déjà été relancés à
// contexte neuf : évite une boucle si la reprise de session échoue en boucle.
// Volontairement en mémoire — un redémarrage remet le droit à un essai, ce qui
// est sans danger (au pire une exécution de plus, jamais une boucle infinie).
const _resumeRetried = new Set()

// Questions (lecture seule) exécutables en parallèle. Doit rester ≤ la limite du
// runner (getMaxParallelQuestions) : au-delà, les items partiraient côté file mais
// attendraient un slot côté runner, et la page afficherait « en cours » à tort.
const MAX_PARALLEL_QUESTION_PROMPTS = getMaxParallelQuestions()

const SELECT = 'SELECT * FROM work_prompts WHERE deleted_at IS NULL'

// Deux files distinctes sur la même table : celle de l'Espace finance et celle de
// la section Agent. Chaque page ne voit que la sienne ; l'exécuteur est partagé.
export const PROMPT_SPACES = ['finance', 'agent']

export function listPrompts({ space = null } = {}) {
  // Un item qui attend une réponse passe devant la file : c'est le seul état où RIEN
  // n'avance sans l'utilisateur. Il serait sinon rangé dans l'historique (terminé /
  // bloqué), là où on ne regarde plus.
  const where = space ? ` AND p.space=?` : ''
  // La nature de la suggestion d'origine voyage avec l'item : la file la signale
  // d'une pastille (« Claude · Intégration »), il n'y a donc plus de raison
  // d'aller la relire dans l'onglet Suggestions.
  return db.prepare(`
    SELECT p.*, s.kind AS suggestion_kind, s.area AS suggestion_area
    FROM work_prompts p
    LEFT JOIN work_suggestions s ON s.id = p.suggestion_id
    WHERE p.deleted_at IS NULL${where} ORDER BY
    CASE WHEN p.pending_question IS NOT NULL AND p.status NOT IN ('running','cancelled') THEN 0
         ELSE CASE p.status WHEN 'running' THEN 1 WHEN 'queued' THEN 2 WHEN 'paused' THEN 3 ELSE 4 END END,
    p.position, p.created_at`).all(...(space ? [space] : []))
}

export function getPrompt(id) {
  return db.prepare(`${SELECT} AND id=?`).get(id) || null
}

// Les positions vivent PAR FILE : chaque page réordonne la sienne sans bousculer
// l'autre. Entre files, l'ordonnanceur départage par position puis created_at.
function nextPosition(space) {
  const row = db.prepare(`SELECT MAX(position) AS m FROM work_prompts WHERE deleted_at IS NULL AND space=?`).get(space)
  return (row?.m ?? 0) + 1
}

// « Prioritaire » coché à la création : l'item se dépose DEVANT la file. Les dépôts
// « en file » passent ensuite par moveToFront (qui reprend aussi les items déjà
// remis à l'ordonnanceur) ; cette position ne sert seule qu'aux dépôts en pause
// (brouillon, item de test), que moveToFront réveillerait.
//
// Le MIN doit porter sur 'running' en plus de 'queued' : l'item en tête de file
// est justement celui qui tourne. L'oublier fait recalculer un MIN trop haut
// dès qu'une exécution est en cours, et un « Passer en premier » ultérieur
// retombe alors EXACTEMENT sur la position de l'item en cours dès qu'il est
// repris en file (reclaimPending) sans que sa position n'ait bougé — deux items
// à la même position, départagés ensuite par created_at : le plus récent (souvent
// une suggestion tout juste intégrée) perd le tri et semble ne jamais avancer.
function frontPosition(space) {
  const row = db.prepare(`SELECT MIN(position) AS m FROM work_prompts WHERE deleted_at IS NULL AND status IN ('queued','running') AND space=?`).get(space)
  return (row?.m ?? 1) - 1
}

function broadcast() { broadcastAll({ type: 'travaux:prompts:updated' }) }

export function createPrompt({
  title = '', prompt, mode = 'implement', preset = 'deep',
  same_context = 0, created_by = null, suggestion_id = null, status = 'queued',
  priority = false, space = 'finance',
}) {
  const text = String(prompt || '').trim()
  if (!text) throw new Error('prompt requis')
  const id = randomUUID()
  // Titre absent = titre automatique : l'heuristique tout de suite (déterministe),
  // puis un titre modèle quelques secondes plus tard s'il tient la route. Un titre
  // saisi à la main n'est jamais touché.
  const given = String(title || '').trim()
  const label = given || heuristicTitle(text)
  // 'paused' à la création = déposé sans partir tout de suite (brouillon, ou item
  // de test qui ne doit jamais déclencher d'exécution réelle).
  const initial = status === 'paused' ? 'paused' : 'queued'
  const inSpace = PROMPT_SPACES.includes(space) ? space : 'finance'
  const cleanMode = mode === 'question' ? 'question' : 'implement'
  // Préréglage « auto » : même mécanique que le titre — un provisoire sûr tout de
  // suite (l'item est exécutable sans attendre), puis la classification modèle le
  // remplace si elle rend son verdict avant le départ. `preset` reste toujours une
  // clé concrète : c'est elle que lit l'ordonnanceur.
  const autoPreset = preset === 'auto' || !PRESET_KEYS.includes(preset)
  const chosen = autoPreset ? provisionalPreset(cleanMode) : preset
  db.prepare(`
    INSERT INTO work_prompts (id, title, prompt, status, position, same_context, mode, preset, suggestion_id, created_by, title_auto, preset_auto, space)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, label, text, initial, priority ? frontPosition(inSpace) : nextPosition(inSpace), same_context ? 1 : 0,
    cleanMode, chosen, suggestion_id, created_by,
    given ? 0 : 1, autoPreset && preset === 'auto' ? 1 : 0, inSpace)
  broadcast()
  if (!given) scheduleTitleRefine(id, text, label)
  if (preset === 'auto') schedulePresetClassify(id)
  // « Prioritaire » = vraiment le même effet que « Passer en premier » : reprendre
  // aussi les items déjà remis à l'ordonnanceur, pas seulement une position en
  // tête. Jamais sur un dépôt « de côté » (ça le réveillerait).
  if (priority && initial === 'queued') moveToFront(id)
  return getPrompt(id)
}

/**
 * Deuxième étage du titre automatique. Volontairement hors du chemin de réponse :
 * l'ajout à la file reste instantané et la carte se renomme toute seule par la
 * diffusion temps réel. On n'écrase que si le titre est resté celui de
 * l'heuristique — une retouche manuelle entre-temps gagne toujours.
 */
function scheduleTitleRefine(id, text, provisional) {
  refineTitle(text)
    .then(better => {
      if (!better || better === provisional) return
      const row = getPrompt(id)
      if (!row || !row.title_auto || row.title !== provisional) return
      db.prepare(`UPDATE work_prompts SET title=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .run(better, id)
      broadcast()
    })
    .catch(e => console.error('🤖 File de travaux: titre automatique —', e.message))
}

// ─── Titre dynamique du projet ────────────────────────────────────────────────
// Un item de la file EST un projet : sa demande d'origine plus le fil qui la
// précise. Le titre est donc re-déduit du fil à chaque fois que le projet bouge
// (réponse de l'humain, compte-rendu de l'agent, prompt réécrit) — mais seulement
// tant qu'il est automatique. Dès que l'utilisateur écrit son propre titre,
// title_auto passe à 0 et plus rien ne le touche ; vider le champ le rend au mode
// automatique.
const _refining = new Set()

function scheduleProjectTitleRefine(id) {
  if (_refining.has(id)) return              // un seul passage à la fois par projet
  const row = getPrompt(id)
  if (!row || !row.title_auto) return
  _refining.add(id)
  const before = row.title
  refineProjectTitle({ prompt: row.prompt, messages: listMessages(id), current: before })
    .then(better => {
      if (!better || better === before) return
      // Rien n'a bougé entre-temps ? (retouche manuelle, autre passage, suppression)
      const fresh = getPrompt(id)
      if (!fresh || !fresh.title_auto || fresh.title !== before) return
      db.prepare(`UPDATE work_prompts SET title=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .run(better, id)
      broadcast()
    })
    .catch(e => console.error('🤖 File de travaux: titre dynamique —', e.message))
    .finally(() => _refining.delete(id))
}

// ─── Préréglage automatique ───────────────────────────────────────────────────
// « Auto » dans le sélecteur Rapide/Standard/Approfondi : le calibre est jugé par
// le modèle à partir de la demande (voir promptPreset.js), hors du chemin de
// réponse — l'ajout à la file reste instantané, la carte se met à jour toute
// seule. On ne réécrit que si le préréglage est resté automatique entre-temps :
// un choix manuel gagne toujours, comme pour le titre.
const _classifying = new Set()

function schedulePresetClassify(id) {
  if (_classifying.has(id)) return           // un seul passage à la fois par item
  const row = getPrompt(id)
  if (!row || !row.preset_auto) return
  _classifying.add(id)
  classifyPreset({ prompt: row.prompt, mode: row.mode })
    .then(key => {
      if (!key) return
      const fresh = getPrompt(id)
      if (!fresh || !fresh.preset_auto || fresh.preset === key) return
      // L'exécution a réellement commencé ? Trop tard pour ce départ — le modèle
      // est résolu au démarrage. On laisse le provisoire, fidèle à ce qui a tourné.
      if (fresh.status === 'running' && !isPending(fresh)) return
      db.prepare(`UPDATE work_prompts SET preset=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
        .run(key, id)
      broadcast()
      // Item déjà confié à l'ordonnanceur mais pas parti : le calibre jugé doit
      // être celui qui s'exécutera.
      syncPendingTask(getPrompt(id))
    })
    .catch(e => console.error('🤖 File de travaux: préréglage automatique —', e.message))
    .finally(() => _classifying.delete(id))
}

const EDITABLE = ['title', 'prompt', 'mode', 'preset', 'status', 'position', 'stop_after', 'seen']

// ─── Items « en attente » : remis à l'ordonnanceur, mais pas encore démarrés ───
//
// Un item passe « running » dès qu'il est confié au runner — or celui-ci ne démarre
// qu'une implémentation à la fois. Entre les deux, l'item ne fait RIEN : il attend
// son tour. Le figer (prompt en lecture seule, ordre verrouillé, impossible de le
// mettre de côté) n'avait donc aucune justification, et bloquait la file dès que
// deux items étaient poussés coup sur coup.
//
// Deux traitements, selon ce qu'on touche :
//   • du texte / des réglages → on retouche la tâche en place (pas de va-et-vient) ;
//   • l'ordre, le statut, la suppression → on la reprend à l'ordonnanceur, l'item
//     redevient « en file » et repartira par le chemin normal.
// Les deux refusent dès que l'exécution a réellement commencé.

/** Vrai si l'item est confié au runner mais n'a pas encore démarré. */
function isPending(row) {
  if (!row || row.status !== 'running' || !row.agent_task_id) return false
  const task = findAgentTask(row.agent_task_id)
  return !!task && task.status === 'approved'
}

/**
 * Reprend l'item à l'ordonnanceur et le remet « en file » à sa place.
 * Retourne la ligne à jour, ou `row` inchangée si l'exécution a déjà commencé.
 */
function reclaimPending(row) {
  if (!isPending(row)) return row
  if (!cancelPendingAgentTask(row.agent_task_id)) return row
  db.prepare(`
    UPDATE work_prompts
    SET status='queued', agent_task_id=NULL, started_at=NULL,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?
  `).run(row.id)
  return getPrompt(row.id)
}

/** Répercute une retouche de texte / réglages sur la tâche pas encore démarrée. */
function syncPendingTask(row) {
  if (!isPending(row)) return
  const { model, effort } = presetFor(row.preset)
  updatePendingAgentTask(row.agent_task_id, {
    title: row.title,
    // Tâche « suite de conversation » (réponse relancée) : son brief est le fil,
    // pas le prompt d'origine — le réécrire avec row.prompt effacerait la réponse.
    description: row.follow_up ? buildFollowUpPrompt(row, listMessages(row.id)) : row.prompt,
    mode: row.mode, model, effort,
  })
}

export function updatePrompt(id, patch) {
  let row = getPrompt(id)
  if (!row) return null
  // Mettre de côté / réordonner un item pas encore démarré : on le reprend d'abord,
  // sinon le garde-fou « les états d'exécution appartiennent au runner » l'en empêche.
  if (patch.status !== undefined || patch.position !== undefined) row = reclaimPending(row) || row
  const sets = []
  const vals = []
  // Champ titre vidé = « rends-le automatique » : on repose l'heuristique tout de
  // suite (jamais de carte sans titre) et le fil reprend la main juste après.
  let backToAuto = false
  let frozen = false
  let reclassify = false
  for (const [k, v] of Object.entries(patch)) {
    if (!EDITABLE.includes(k)) continue
    // Le statut n'est pilotable à la main que pour mettre de côté / remettre en
    // file : les états d'exécution appartiennent au runner.
    if (k === 'status' && !['queued', 'paused', 'cancelled'].includes(v)) continue
    if (k === 'status' && row.status === 'running') continue
    // Préréglage : « auto » rend le choix au modèle (le provisoire tient la carte
    // exécutable en attendant le verdict) ; une clé concrète fige le choix.
    if (k === 'preset') {
      if (v !== 'auto' && !PRESET_KEYS.includes(v)) continue
      reclassify = v === 'auto'
      sets.push('preset=?', 'preset_auto=?')
      vals.push(v === 'auto' ? provisionalPreset(patch.mode ?? row.mode) : v, v === 'auto' ? 1 : 0)
      continue
    }
    if (k === 'title') {
      const given = String(v ?? '').trim()
      backToAuto = !given
      frozen = !!given
      sets.push('title=?', 'title_auto=?')
      vals.push(given || heuristicTitle(patch.prompt ?? row.prompt), given ? 0 : 1)
      continue
    }
    // « Lu » façon boîte mail : posé côté serveur (jamais la valeur du client) pour
    // que l'horodatage reste cohérent avec les autres colonnes datetime de la table.
    if (k === 'seen') {
      sets.push('seen_at=?')
      vals.push(v ? new Date().toISOString() : null)
      continue
    }
    sets.push(`${k}=?`)
    vals.push(['same_context', 'stop_after'].includes(k) ? (v ? 1 : 0) : v)
  }
  if (!sets.length) return row
  db.prepare(`UPDATE work_prompts SET ${sets.join(', ')}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
    .run(...vals, id)
  broadcast()
  // Le prompt réécrit change la nature du projet → titre re-déduit, sauf s'il vient
  // d'être figé à la main dans le même PATCH.
  if (backToAuto || (!frozen && patch.prompt !== undefined)) scheduleProjectTitleRefine(id)
  const updated = getPrompt(id)
  // Préréglage remis en auto, ou prompt réécrit alors qu'il l'était déjà : le
  // calibre est re-jugé — la demande n'est peut-être plus du même gabarit.
  if (reclassify || (updated?.preset_auto && patch.prompt !== undefined)) schedulePresetClassify(id)
  // Item encore en attente : ce qu'on vient de réécrire doit être ce qui partira.
  syncPendingTask(updated)
  return updated
}

export function deletePrompt(id) {
  const row = getPrompt(id)
  if (!row) return false
  // Retirer un item pas encore démarré doit aussi le retirer de l'ordonnanceur,
  // sinon il partirait quand même une fois le poste libre.
  const wasPending = isPending(row)
  if (wasPending) reclaimPending(row)
  db.prepare(`UPDATE work_prompts SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(id)
  // Item issu d'une suggestion : la retirer de la file la rend à l'onglet
  // « Suggestions » plutôt que de la perdre — on peut la rejeter pour de bon
  // depuis là, ou la remettre en file plus tard. (SQL direct : importer
  // workSuggestions ici créerait un cycle, ce module est déjà son fournisseur.)
  if (row.suggestion_id) {
    db.prepare(`
      UPDATE work_suggestions SET status='new', work_prompt_id=NULL,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id=? AND status='accepted'
    `).run(row.suggestion_id)
    broadcastAll({ type: 'travaux:suggestions:updated' })
  }
  broadcast()
  // Le poste qu'il occupait est libre : au suivant.
  if (wasPending) advanceQueue()
  return true
}

/** Réordonne la file : le tableau d'ids donne l'ordre voulu, les absents restent après. */
export function reorderPrompts(ids) {
  // Les items en attente reviennent en file avant d'être renumérotés : leur ordre de
  // départ redevient celui de la page (l'ordonnanceur, lui, sert premier arrivé).
  let reclaimed = false
  for (const id of ids) {
    const row = getPrompt(id)
    if (!isPending(row)) continue
    reclaimPending(row)
    reclaimed = true
  }
  const run = db.transaction(() => {
    ids.forEach((id, i) => {
      db.prepare(`UPDATE work_prompts SET position=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND deleted_at IS NULL`).run(i + 1, id)
    })
  })
  run()
  broadcast()
  // Rendre à l'ordonnanceur ce qu'on vient de lui reprendre, dans le nouvel ordre.
  // Uniquement dans ce cas : un simple changement de priorité ne doit RIEN lancer.
  if (reclaimed) advanceQueue()
  return listPrompts()
}

/**
 * Remet un item en tête de file (bouton « Passer en premier »).
 *
 * « Premier » veut dire LE PROCHAIN À PARTIR, pas seulement premier des items
 * encore en file : les items déjà remis à l'ordonnanceur mais pas démarrés lui
 * sont repris — sans ça ils partaient quand même avant, et « premier » mentait.
 * Ils repartiront par le chemin normal, derrière celui-ci. Puis l'item est remis
 * tout de suite à l'ordonnanceur (qui sert premier arrivé) : son rang 1 tient
 * même face à l'autre file, l'exécuteur étant partagé. File en pause ou agent
 * désactivé : simple repositionnement, rien n'est confié au runner.
 */
export function moveToFront(id) {
  let target = getPrompt(id)
  if (!target) return null
  target = reclaimPending(target)
  if (!['queued', 'paused'].includes(target.status)) return target
  // Seule SA voie le concurrence : les questions (parallèles) ne disputent pas le
  // poste d'implémentation, et réciproquement.
  const laneWhere = (target.mode === 'question' && !target.same_context)
    ? `mode='question' AND same_context=0`
    : `(mode!='question' OR same_context=1)`
  for (const row of db.prepare(`${SELECT} AND status='running' AND id!=? AND ${laneWhere}`).all(id)) {
    reclaimPending(row) // no-op si l'exécution a réellement commencé
  }
  db.prepare(`UPDATE work_prompts SET position=?, status='queued', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
    .run(frontPosition(target.space), id)
  broadcast()
  if (getSettings().enabled && !isQueuePaused()) return startPrompt(getPrompt(id)).prompt
  return getPrompt(id)
}

// ─── Ordonnancement ───────────────────────────────────────────────────────────

/**
 * État de la pause manuelle de la file, tel que rendu à la page.
 * `reason` porte le « pourquoi » quand la pause a été posée automatiquement par un
 * item marqué « arrêter après celle-ci ».
 */
export function getQueuePauseState() {
  const s = getSettings()
  return {
    paused: !!s.queuePaused,
    paused_at: s.queuePausedAt || null,
    reason: s.queuePausedReason || null,
  }
}

/**
 * Pause / reprise de la file. Aucune exécution n'est tuée : la pause empêche
 * seulement les DÉPARTS, donc reprendre relance simplement le prochain item — rien
 * n'a été refait, rien n'a été perdu.
 */
export function pauseQueue({ reason = null } = {}) {
  const state = setQueuePaused(true, { reason })
  broadcast()
  return { paused: state.paused, paused_at: state.pausedAt, reason: state.reason }
}

export function resumeQueue() {
  setQueuePaused(false)
  broadcast()
  const out = advanceQueue()
  return { ...getQueuePauseState(), started: out.started ? out.started.prompt : null, startedCount: out.startedCount }
}

/**
 * Démarre le prochain item si rien ne tourne. Retourne { started, reason } :
 * `reason` explique une non-exécution ('busy' | 'agent-disabled' | 'queue-paused' |
 * 'empty') pour que la page puisse le dire clairement au lieu de laisser croire à un
 * blocage.
 */
export function advanceQueue() {
  // 1. Réconciliation : un item resté « running » alors que sa tâche a disparu ou
  // s'est terminée (redémarrage serveur pendant l'exécution) ne doit pas geler la
  // file pour toujours. Vaut pour les deux voies.
  for (const running of db.prepare(`${SELECT} AND status='running' ORDER BY started_at`).all()) {
    const task = running.agent_task_id ? findAgentTask(running.agent_task_id) : null
    if (!task) {
      finishPrompt(running.id, { status: 'blocked', agent_result: '(tâche introuvable — exécution perdue)', user_summary: null, session_id: null })
    } else if (['done', 'blocked', 'cancelled'].includes(task.status)) {
      finishPrompt(running.id, task)
      // Clôture par réconciliation : onAgentTaskFinalized n'a pas tourné (redémarrage
      // en pleine exécution) → le fil n'a aucune réponse. On la verse a posteriori.
      setImmediate(() => { repairAgentReplies(running.id).catch(() => {}) })
    }
  }

  // 2. Pause posée à la main (ou par un item « arrêter après celle-ci ») : la
  // réconciliation ci-dessus a quand même tourné — un item fauché par un redémarrage
  // ne doit pas rester « en cours » pour l'éternité juste parce que la file dort.
  if (isQueuePaused()) return { started: null, startedCount: 0, reason: 'queue-paused' }

  if (!getSettings().enabled) return { started: null, startedCount: 0, reason: 'agent-disabled' }

  const runningRows = db.prepare(`${SELECT} AND status='running'`).all()
  const runningQuestions = runningRows.filter(r => r.mode === 'question').length
  const implRunning = runningRows.some(r => r.mode !== 'question')

  const started = []

  // 2. Questions : lecture seule → plusieurs à la fois, même pendant un chantier.
  // Un item marqué « même contexte » est volontairement exclu de la voie parallèle :
  // il doit reprendre la session de son prédécesseur, donc attendre son tour.
  const slots = MAX_PARALLEL_QUESTION_PROMPTS - runningQuestions
  if (slots > 0) {
    const questions = db.prepare(`${SELECT} AND status='queued' AND mode='question' AND same_context=0 ORDER BY position, created_at LIMIT ?`).all(slots)
    for (const q of questions) started.push(startPrompt(q))
  }

  // 3. Implémentation : une seule à la fois (elle édite l'arbre de travail réel).
  // Les positions vivent PAR FILE (finance / agent) : comparer les positions brutes
  // entre files n'aurait aucun sens. On prend donc le prochain candidat de CHAQUE
  // file selon son propre ordre, puis premier arrivé premier servi entre les files.
  if (!implRunning) {
    const next = PROMPT_SPACES
      .map(sp => db.prepare(`${SELECT} AND status IN ('queued','running') AND space=? AND (mode!='question' OR same_context=1) ORDER BY position, created_at LIMIT 1`).get(sp))
      .filter(Boolean)
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))[0]
    if (next) started.push(startPrompt(next))
  }

  if (!started.length) {
    const anyQueued = db.prepare(`SELECT 1 FROM work_prompts WHERE deleted_at IS NULL AND status='queued' LIMIT 1`).get()
    return { started: null, startedCount: 0, reason: anyQueued ? 'busy' : 'empty' }
  }
  return { started: started[0], startedCount: started.length, reason: null }
}

/**
 * Session Claude à reprendre pour un item « même contexte » : celle de l'item qui
 * le précède dans la file (par position). On ne prend PAS « le dernier terminé » :
 * avec la voie parallèle, une question terminée entre-temps volerait le contexte.
 */
function sessionOfPrevious(row) {
  // Scopé à la même file : un item « même contexte » de la file Agent ne doit
  // jamais reprendre la session d'un item de la file finance (et inversement).
  const prev = db.prepare(`
    SELECT session_id FROM work_prompts
    WHERE deleted_at IS NULL AND session_id IS NOT NULL AND space = ?
      AND (position < ? OR (position = ? AND created_at < ?))
    ORDER BY position DESC, created_at DESC LIMIT 1
  `).get(row.space, row.position, row.position, row.created_at)
  return prev?.session_id || null
}

function startPrompt(row, { forceFresh = false } = {}) {
  const { model, effort } = presetFor(row.preset)
  // Item marqué follow_up : ce départ est la SUITE d'une conversation (réponse de
  // l'utilisateur remise en fin de file, ou relance fauchée avant d'avoir travaillé).
  // Le brief est le fil complet — autoportant — et la session de l'item lui-même
  // est reprise quand elle existe encore.
  const followUp = !!row.follow_up
  const resume = forceFresh ? null
    : followUp ? (row.session_id || null)
      : row.same_context ? sessionOfPrevious(row) : null
  const task = enqueueAgentTask({
    title: row.title,
    description: followUp ? buildFollowUpPrompt(row, listMessages(row.id)) : row.prompt,
    kind: 'queue',
    mode: row.mode,
    model, effort,
    author: followUp ? 'File de travaux (suite)' : 'File de travaux',
    work_prompt_id: row.id,
    resume_session_id: resume,
  })
  db.prepare(`
    UPDATE work_prompts
    SET status='running', agent_task_id=?, started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?
  `).run(task.id, row.id)
  broadcast()
  return { prompt: getPrompt(row.id), task }
}

function finishPrompt(id, task) {
  const status = task.status === 'done' ? 'done' : 'blocked'
  // La question éventuelle est posée sur l'item (pas sur la tâche agent, qui vit dans
  // agent-tasks.json et disparaît de la vue) : c'est la carte qui doit la montrer et
  // récolter le clic. Écrasée à chaque fin d'exécution — une exécution qui n'en pose
  // plus efface celle d'avant.
  const q = task.pending_question && task.pending_question.question
    ? JSON.stringify(task.pending_question)
    : null
  // follow_up est consommé : l'exécution qui vient de finir a lu le fil. Une
  // prochaine relance ne repartira « en suite » que si une nouvelle réponse le repose.
  // seen_at repart à NULL : une nouvelle fin d'exécution est une nouvelle réponse à
  // lire, même si la précédente avait déjà été ouverte.
  db.prepare(`
    UPDATE work_prompts
    SET status=?, session_id=COALESCE(?, session_id), pending_question=?, follow_up=0,
        seen_at=NULL,
        completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?
  `).run(status, task.session_id || null, q, id)
  broadcast()
  return getPrompt(id)
}

// ─── Fil de discussion par tâche ──────────────────────────────────────────────
// Chaque item de la file porte SA conversation. Elle survit aux exécutions
// successives et — surtout — au fait que la session Claude puisse avoir disparu :
// une relance réinjecte le fil en clair dans le prompt (voir buildFollowUpPrompt),
// donc la continuité ne dépend jamais de --resume.

export function listMessages(promptId) {
  return db.prepare(`
    SELECT m.*, u.name AS author_name
    FROM work_prompt_messages m
    LEFT JOIN users u ON u.id = m.author
    WHERE m.prompt_id=? ORDER BY m.created_at
  `).all(promptId)
}

function addMessage(promptId, { role, text, agentTaskId = null, author = null }) {
  const clean = String(text || '').trim()
  if (!clean) return null
  const id = randomUUID()
  db.prepare(`
    INSERT INTO work_prompt_messages (id, prompt_id, role, text, agent_task_id, author)
    VALUES (?,?,?,?,?,?)
  `).run(id, promptId, role, clean, agentTaskId, author)
  broadcast()
  return db.prepare('SELECT * FROM work_prompt_messages WHERE id=?').get(id)
}

/**
 * Prompt d'une relance : la demande d'origine, ce que l'agent a répondu jusqu'ici,
 * et le fil complet. Volontairement autoportant — même si --resume échoue ou que la
 * session a été purgée, la relance sait de quoi on parle.
 */
export function buildFollowUpPrompt(row, messages) {
  const thread = messages
    .map(m => `${m.role === 'user' ? 'Humain' : 'Toi'} : ${m.text}`)
    .join('\n\n')
  return [
    'Suite d\'un échange sur une tâche de la file de travaux. Le contexte ci-dessous est ',
    'peut-être déjà dans ta session ; s\'il ne l\'est pas, il suffit à reprendre le travail.\n\n',
    `=== DEMANDE INITIALE ===\n${row.prompt}\n\n`,
    `=== ÉCHANGE ===\n${thread}\n\n`,
    '=== À FAIRE MAINTENANT ===\n',
    'Réponds au DERNIER message de l\'humain et poursuis la tâche en conséquence. ',
    'Si une information te manque encore, dis précisément laquelle plutôt que de deviner.',
  ].join('')
}

/**
 * Réponse de l'humain dans le fil → relance de la tâche avec ce complément. La
 * session précédente est reprise quand elle existe (contexte intact) ; sinon le
 * fil réinjecté fait office de mémoire.
 * `placement` décide du moment de la relance :
 *   • 'front' (défaut) — tout de suite : l'item est remis à l'ordonnanceur et
 *     repart avant le reste de la file ;
 *   • 'back' — la réponse est enregistrée mais l'item retourne EN FIN de file :
 *     il repartira quand son tour reviendra, avec le fil complet en contexte.
 * Refusée pendant une exécution : le message serait perdu (l'exécution en cours ne
 * le lirait pas). L'appelant reçoit { error: 'running' } pour le dire clairement.
 */
export function replyToPrompt(id, { text, userId = null, placement = 'front' }) {
  const row = getPrompt(id)
  if (!row) return null
  if (row.status === 'running') return { error: 'running' }
  const clean = String(text || '').trim()
  if (!clean) return { error: 'empty' }

  addMessage(id, { role: 'user', text: clean, author: userId })
  const out = placement === 'back' ? requeueWithThread(row) : relaunchWithThread(row)
  // Le projet vient de bouger : c'est le moment le plus fort pour renommer, car la
  // réponse de l'humain donne le cap réel (élargissement, changement de direction).
  scheduleProjectTitleRefine(id)
  return out
}

/**
 * Relance un item avec son fil complet en contexte (le dernier message de l'humain
 * y est déjà). Chemin partagé par la réponse classique (replyToPrompt) et la
 * rattrapage d'un message de steering arrivé trop tard pour être lu en direct.
 */
function relaunchWithThread(row) {
  const messages = listMessages(row.id)
  const { model, effort } = presetFor(row.preset)
  const task = enqueueAgentTask({
    title: row.title,
    description: buildFollowUpPrompt(row, messages),
    kind: 'queue',
    mode: row.mode,
    model, effort,
    author: 'File de travaux (suite)',
    work_prompt_id: row.id,
    resume_session_id: row.session_id || null,
  })
  // follow_up=1 : si cette exécution est fauchée avant d'avoir travaillé (quota,
  // reprise de session impossible), le redémarrage saura qu'il doit repartir du
  // FIL, pas du prompt d'origine. Consommé à la fin de l'exécution (finishPrompt).
  db.prepare(`
    UPDATE work_prompts
    SET status='running', agent_task_id=?, started_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        completed_at=NULL, pending_question=NULL, follow_up=1,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?
  `).run(task.id, row.id)
  broadcast()
  return { prompt: getPrompt(row.id), task }
}

/**
 * Réponse « à la fin de la file » : le fil est complété mais l'item n'est PAS
 * relancé tout de suite — il retourne en file, derrière les items déjà en attente,
 * et repartira par le chemin normal (startPrompt lit follow_up et reconstruit le
 * brief depuis le fil, en reprenant la session Claude si elle existe encore).
 */
function requeueWithThread(row) {
  db.prepare(`
    UPDATE work_prompts
    SET status='queued', position=?, follow_up=1,
        agent_task_id=NULL, started_at=NULL, completed_at=NULL, pending_question=NULL,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?
  `).run(nextPosition(row.space), row.id)
  broadcast()
  // File vide et poste libre → l'item repart tout de suite ; sinon il attend son tour.
  advanceQueue()
  return { prompt: getPrompt(row.id), queued: true }
}

/**
 * Message envoyé PENDANT que la tâche tourne (steering, comme dans Claude Code).
 * Deux livraisons selon l'état réel de la tâche agent :
 *   • 'in_progress' → déposé dans l'inbox de l'exécution, le hook le glisse à
 *     Claude après le prochain outil ('live') ;
 *   • 'approved' (remise à l'ordonnanceur, pas démarrée) → ajouté au brief de la
 *     tâche, il partira avec elle ('queued').
 * Dans les deux cas le message entre au fil — il fait partie de la conversation.
 * Retour { error: 'not-running' } si la tâche a en fait rendu la main : c'est
 * replyToPrompt (relance) qui s'applique alors.
 */
export function steerPrompt(id, { text, userId = null }) {
  const row = getPrompt(id)
  if (!row) return null
  const clean = String(text || '').trim()
  if (!clean) return { error: 'empty' }
  if (row.status !== 'running' || !row.agent_task_id) return { error: 'not-running' }
  const task = findAgentTask(row.agent_task_id)
  if (!task) return { error: 'not-running' }

  // Livraison d'abord, trace au fil ensuite : si la tâche vient de rendre la main
  // entre le chargement de la page et l'envoi, rien n'est écrit et l'appelant
  // peut proposer « Répondre et relancer » à la place.
  if (task.status === 'in_progress' && sendSteeringMessage(row.agent_task_id, clean)) {
    addMessage(id, { role: 'user', text: clean, author: userId, agentTaskId: row.agent_task_id })
    return { prompt: getPrompt(id), delivered: 'live' }
  }
  if (task.status === 'approved') {
    const marked = `${task.description}\n\n=== MESSAGE DE L'UTILISATEUR (ajouté pendant l'attente, à prendre en compte) ===\n${clean}`
    if (updatePendingAgentTask(row.agent_task_id, { description: marked })) {
      addMessage(id, { role: 'user', text: clean, author: userId, agentTaskId: row.agent_task_id })
      return { prompt: getPrompt(id), delivered: 'queued' }
    }
    // La tâche a démarré entre les deux lectures : on retente la voie directe.
    if (sendSteeringMessage(row.agent_task_id, clean)) {
      addMessage(id, { role: 'user', text: clean, author: userId, agentTaskId: row.agent_task_id })
      return { prompt: getPrompt(id), delivered: 'live' }
    }
  }
  return { error: 'not-running' }
}

/**
 * Texte versé dans le fil (et repris dans le recap Slack) à la fin d'une exécution.
 *
 * Le compte-rendu vulgarisé arrive par deux chemins : la section « RÉSUMÉ UTILISATEUR »
 * du rapport (immédiate), ou la génération de secours quand le modèle l'a oubliée
 * (quelques secondes plus tard, en subprocess). Ce deuxième chemin étant asynchrone,
 * lire task.user_summary à chaud figeait un « (terminé sans compte-rendu) » dans le
 * fil alors que le vrai compte-rendu atterrissait juste après sur la tâche. On l'attend
 * donc ici, et à défaut on rend le rapport technique — jamais un placeholder nu.
 */
export async function resolveReply(task) {
  let summary = (task.user_summary || '').trim()
  if (!summary) {
    try { await generateUserSummary(task.id) } catch { /* le repli ci-dessous prend la main */ }
    summary = (findAgentTask(task.id)?.user_summary || '').trim()
  }
  if (summary) return summary

  // Aucun compte-rendu possible (rapport vide, ou génération de secours en échec) :
  // on rend ce qu'on a plutôt que rien — le rapport brut vaut mieux qu'un silence.
  const report = (task.agent_result || '').trim()
  const clean = report && report !== '(terminé sans rapport)' ? report : ''
  if (clean) {
    const excerpt = clean.length > 2500 ? `…${clean.slice(-2500)}` : clean
    const head = task.status === 'done'
      ? 'Compte-rendu vulgarisé indisponible — voici le rapport technique brut :'
      : 'Exécution interrompue, sans compte-rendu — voici le rapport technique brut :'
    return `${head}\n\n${excerpt}`
  }
  return task.status === 'done'
    ? 'Terminé, mais l\'agent n\'a produit aucun rapport (exécution sans sortie exploitable). À relancer si le résultat n\'est pas visible dans l\'app.'
    : 'Exécution interrompue avant toute sortie (délai dépassé, processus tué ou redémarrage). À relancer.'
}

/**
 * Appelé par taskRunner quand une exécution se termine. Quatre responsabilités :
 * verser la réponse dans le fil, clore l'item, envoyer le recap Slack, lancer le suivant.
 */
export async function onAgentTaskFinalized(task) {
  if (!task || task.kind !== 'queue' || !task.work_prompt_id) return
  const row = getPrompt(task.work_prompt_id)
  if (!row) return

  // Reprise de session impossible (session purgée) : le run meurt sans rien
  // produire. On relance UNE fois à contexte neuf plutôt que de marquer bloqué.
  const producedNothing = !(task.agent_result || '').trim() && !(task.user_summary || '').trim()
  if (task.resume_session_id && task.status !== 'done' && producedNothing && !_resumeRetried.has(row.id)) {
    _resumeRetried.add(row.id)
    console.log(`🤖 File de travaux: reprise de session impossible pour « ${row.title} » — relance à contexte neuf`)
    startPrompt(row, { forceFresh: true })
    return
  }

  // Le compte-rendu entre dans le fil : c'est lui qui reste lisible (et réinjectable)
  // quand la session Claude a disparu. Le rapport technique reste sur la tâche agent.
  let reply = await resolveReply(task)
  // La question entre AUSSI dans le fil : la colonne pending_question est vidée dès
  // qu'on répond, et sans cette trace le fil montrerait une réponse sans sa question.
  // La carte n'affiche donc que les boutons de choix, pas une seconde fois le texte.
  if (task.pending_question?.question) reply += `\n\n❓ ${task.pending_question.question}`
  addMessage(row.id, { role: 'agent', text: reply, agentTaskId: task.id })

  const finished = finishPrompt(row.id, task)
  // Le compte-rendu vient d'entrer dans le fil : sur un projet qui a déjà tourné
  // plusieurs fois, il précise souvent mieux la nature du travail que la demande
  // d'origine. En arrière-plan — le recap Slack qui suit peut donc encore porter le
  // titre précédent, la carte, elle, se renomme dès que le modèle répond.
  if (row.title_auto && listMessages(row.id).length > 1) scheduleProjectTitleRefine(row.id)

  // « Arrête après celle-ci » : on pose la pause AVANT le recap et l'advanceQueue,
  // sinon l'item suivant partirait dans le même tick. Le drapeau est consommé (remis
  // à 0) pour qu'une relance de cet item plus tard ne remette pas la file en pause
  // sans qu'on l'ait redemandé.
  const stopHere = !!finished.stop_after
  if (stopHere) {
    db.prepare(`UPDATE work_prompts SET stop_after=0, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(row.id)
    pauseQueue({ reason: `Arrêt demandé après « ${finished.title} »` })
    console.log(`🤖 File de travaux: pause demandée après « ${finished.title} » — la file reprendra sur commande`)
  }

  // Message de steering arrivé dans les dernières secondes de l'exécution : il est
  // au fil, mais Claude ne l'a jamais lu. On relance tout de suite avec le fil en
  // contexte — comme si l'utilisateur avait répondu après coup. Pas de recap ici :
  // le travail n'est pas fini, il viendra à la fin de la relance. Une pause
  // demandée (« arrête après celle-ci ») garde le dernier mot : pas de relance.
  if (!stopHere && String(task.missed_user_message || '').trim()) {
    console.log(`🤖 File de travaux: message utilisateur non lu par l'exécution — relance de « ${finished.title} »`)
    relaunchWithThread(finished)
    return
  }

  try { await sendRecap(finished, task, { stopped: stopHere }) } catch (e) { console.error('🤖 File de travaux: recap Slack en échec —', e.message) }
  advanceQueue()
}

/**
 * Exécution avortée faute de quota Claude (« session limit »). L'item n'a pas échoué :
 * il n'a pas travaillé. Il retourne donc en file à sa place, sans réponse dans le fil
 * ni recap — le runner rallume tout à la réinitialisation. Un seul avis Slack par
 * fenêtre de quota, pour ne pas transformer une pause en pluie de notifications.
 */
export function onAgentTaskDeferred(task, { label = '' } = {}) {
  if (!task || task.kind !== 'queue' || !task.work_prompt_id) return
  const row = getPrompt(task.work_prompt_id)
  if (!row) return
  db.prepare(`
    UPDATE work_prompts
    SET status='queued', started_at=NULL, agent_task_id=NULL, completed_at=NULL,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id=?
  `).run(row.id)
  broadcast()
  notifyLimitOnce(label)
}

let _limitNotified = ''

async function notifyLimitOnce(label) {
  if (_limitNotified === label) return
  _limitNotified = label
  const url = process.env.SLACK_WEBHOOK_PERSO
  if (!url) return
  // Même règle que le recap : une ligne, rien à faire de plus que la lire.
  const text = `:hourglass_flowing_sand: *File de travaux en pause* — limite de session Claude atteinte, ` +
    `reprise à ${label || 'la réinitialisation du quota'}.`
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
  } catch (e) { console.error('🤖 File de travaux: avis de quota non envoyé —', e.message) }
}

// ─── Réparation des réponses manquantes ───────────────────────────────────────
// Deux dégâts possibles dans un fil : un placeholder figé (compte-rendu de secours
// arrivé après l'écriture du message — le bug d'origine) ou aucune réponse du tout
// (exécution close par réconciliation après un redémarrage). Les deux se réparent
// depuis la tâche agent, qui garde rapport et compte-rendu. Idempotent.
const PLACEHOLDERS = ['(terminé sans compte-rendu)', '(bloqué sans explication)']

// Sérialisé : plusieurs réconciliations peuvent la déclencher dans le même tick, et
// deux passages concurrents inséreraient deux fois la même réponse (chacun lisant le
// fil avant l'écriture de l'autre).
let _repairing = null

export function repairAgentReplies(promptId = null) {
  if (_repairing) return _repairing.then(() => runRepair(promptId))
  _repairing = runRepair(promptId).finally(() => { _repairing = null })
  return _repairing
}

async function runRepair(promptId = null) {
  let fixed = 0

  // 0. Doublons exacts (même tâche, même texte) : une réponse versée deux fois n'apporte
  // rien et brouille le fil. On garde la première.
  const dupes = db.prepare(`
    DELETE FROM work_prompt_messages WHERE id IN (
      SELECT m.id FROM work_prompt_messages m
      WHERE m.role='agent' AND m.agent_task_id IS NOT NULL AND m.created_at > (
        SELECT MIN(o.created_at) FROM work_prompt_messages o
        WHERE o.prompt_id=m.prompt_id AND o.agent_task_id=m.agent_task_id AND o.text=m.text
      )
    )
  `).run()
  if (dupes.changes) fixed += dupes.changes

  // 1. Placeholders figés — on part des MESSAGES (une même carte peut avoir plusieurs
  // exécutions, donc plusieurs réponses ; seule la dernière est pointée par la carte).
  const stuck = db.prepare(`
    SELECT m.id, m.agent_task_id FROM work_prompt_messages m
    WHERE m.role='agent' AND m.agent_task_id IS NOT NULL
      AND m.text IN (${PLACEHOLDERS.map(() => '?').join(',')})
      ${promptId ? 'AND m.prompt_id=?' : ''}
  `).all(...PLACEHOLDERS, ...(promptId ? [promptId] : []))
  for (const msg of stuck) {
    const task = findAgentTask(msg.agent_task_id)
    if (!task) continue
    const text = await resolveReply(task)
    if (!text || PLACEHOLDERS.includes(text)) continue
    db.prepare(`UPDATE work_prompt_messages SET text=? WHERE id=?`).run(text, msg.id)
    fixed++
  }

  // 2. Réponse absente : exécution close par réconciliation (redémarrage) — le fil n'a
  // rien reçu pour cette tâche.
  const rows = db.prepare(`${SELECT} AND status IN ('done','blocked') AND agent_task_id IS NOT NULL${promptId ? ' AND id=?' : ''}`)
    .all(...(promptId ? [promptId] : []))
  for (const row of rows) {
    const has = () => db.prepare(`SELECT 1 FROM work_prompt_messages WHERE prompt_id=? AND role='agent' AND agent_task_id=? LIMIT 1`)
      .get(row.id, row.agent_task_id)
    if (has()) continue
    const task = findAgentTask(row.agent_task_id)
    if (!task) continue
    const text = await resolveReply(task)
    if (!text || has()) continue        // re-vérifié après l'attente : anti-doublon
    addMessage(row.id, { role: 'agent', text, agentTaskId: row.agent_task_id })
    fixed++
  }

  if (fixed) {
    broadcast()
    console.log(`🤖 File de travaux: ${fixed} compte-rendu(s) de fil réparé(s)`)
  }
  return fixed
}

// ─── Recap Slack ──────────────────────────────────────────────────────────────

// UNE SEULE LIGNE, volontairement : le DM sert à savoir qu'une tâche est finie (ou
// qu'une question attend), pas à raconter le travail. Le compte-rendu vit dans le
// fil de la carte, dans l'ERP — c'est là qu'on le lit. Une version qui recopiait le
// compte-rendu complet a été essayée puis retirée (même raison que le hook
// ~/.claude/slack-notify.sh) : ne pas la réintroduire.
export function buildRecapMessage(prompt, task, { stopped = false } = {}) {
  const ok = prompt.status === 'done'
  // Une question en attente change la nature du message : ce n'est plus une fin à
  // constater, c'est une action à faire pour que le travail reprenne.
  const asking = !!task?.pending_question?.question
  const head = asking
    ? `:raised_hand: *Question à répondre* — ${prompt.title}`
    : `${ok ? ':white_check_mark:' : ':warning:'} *${ok ? 'Tâche terminée' : 'Tâche bloquée'}* — ${prompt.title}`
  const cta = asking ? 'Répondre' : 'Ouvrir'
  // Pause demandée sur cet item : sans ce mot, le silence de la file ressemble à
  // une panne. C'est le seul complément admis sur la ligne.
  const pause = stopped ? ' · file en pause' : ''
  return `${head} · <${APP_URL}/erp/travaux?onglet=file|${cta}>${pause}`
}

async function sendRecap(prompt, task, { stopped = false } = {}) {
  const url = process.env.SLACK_WEBHOOK_PERSO
  if (!url) {
    console.warn('🤖 File de travaux: SLACK_WEBHOOK_PERSO absent — recap non envoyé')
    return
  }
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: buildRecapMessage(prompt, task, { stopped }) }),
  })
  if (!resp.ok) throw new Error(`Slack HTTP ${resp.status}`)
}

// ─── Démarrage ────────────────────────────────────────────────────────────────
// Au boot, on réconcilie et on relance la file (un item « running » fauché par un
// redémarrage est clos par advanceQueue, puis le suivant démarre).
export function initPromptQueue() {
  const timer = setTimeout(() => {
    try { advanceQueue() } catch (e) { console.error('🤖 File de travaux: démarrage —', e.message) }
    repairAgentReplies().catch(e => console.error('🤖 File de travaux: réparation des compte-rendus —', e.message))
  }, 20_000)
  timer.unref?.()
}
```


---

## `server/src/services/taskRunner.js`

Exécuteur : spawn de Claude Code sur un prompt, une implémentation à la fois, questions en parallèle, journalisation.

```js
import { spawn } from 'child_process'
import { readFileSync, writeFileSync, appendFileSync, renameSync, existsSync, unlinkSync, readdirSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import { broadcastAll } from './realtime.js'
import { AGENT_INTERNAL_SECRET } from '../config/secrets.js'
import {
  AGENT_MODEL, KNOWN_MODELS, modelChain, resolveModel, chainAvailableAt,
  noteModelLimit, nextLimitExpiryAt, purgeExpiredLimits, fetchLimitScope,
  syncScopedModelLimit, agentModelState, preferredAgentModel, setPreferredAgentModel,
} from './agentModel.js'

// ─── Paths (must match what the running server already uses) ──────────────────
// Resolves to the repo root /home/ec2-user/erp/ (versioned + backed up by WIP snapshots).
const TASKS_FILE    = resolve(fileURLToPath(import.meta.url), '../../../../agent-tasks.json')
const TASKS_TMP     = TASKS_FILE + '.tmp'
const DATA_DIR      = dirname(TASKS_FILE)
const BACKLOG_FILE  = resolve(DATA_DIR, 'agent-backlog.json')
const SETTINGS_FILE = resolve(DATA_DIR, 'agent-settings.json')
const PID_FILE      = resolve(fileURLToPath(import.meta.url), '../../../../.agent-pid')
// Voie lecture seule : un fichier PID PAR tâche (plusieurs questions tournent en
// parallèle, un fichier unique serait écrasé et le suivi viserait le mauvais
// process). Volontairement distinct de .agent-pid, que deploy.sh surveille : une
// question ne modifie rien, elle ne doit pas retarder un déploiement.
const QPID_FILE     = id => resolve(fileURLToPath(import.meta.url), `../../../../.agent-qpid-${id}`)
const CLAUDE_BIN    = '/home/ec2-user/.local/bin/claude'
const CWD           = '/home/ec2-user/erp'

// Per-execution durable artifacts (ignored by git). The detached exec Claude writes
// its stream + exit code HERE, not to the parent's stdout pipe — so a `pm2 restart`
// (mandatory after server changes) can't lose the result or SIGPIPE-kill the child.
const EXEC_LOG    = id => resolve(DATA_DIR, `.agent-exec-${id}.log`)
const EXEC_CODE   = id => resolve(DATA_DIR, `.agent-exec-${id}.code`)
const EXEC_PROMPT = id => resolve(DATA_DIR, `.agent-exec-${id}.prompt`)
// Steering en cours de tâche : les messages envoyés depuis la carte /travaux
// PENDANT une exécution sont déposés ici (une ligne JSON par message), et le hook
// agent-steer-hook.mjs (PostToolUse/Stop, branché via --settings) les livre à
// Claude au fil de l'exécution — comme un message tapé en direct dans Claude Code.
const EXEC_INBOX  = id => resolve(DATA_DIR, `.agent-exec-${id}.inbox`)
const STEER_SETTINGS = resolve(fileURLToPath(import.meta.url), '../../../scripts/agent-steer-hooks.json')

// ─── Tunables (settled during the design grilling) ────────────────────────────
const EXEC_TIMEOUT_MS    = 30 * 60_000  // hard kill an execution after 30 min
const READONLY_TIMEOUT_MS = 8 * 60_000  // conversation read-only turns
const INSTANT_TIMEOUT_MS = 3 * 60_000   // proposition instantanée (sans outils, réponse courte)
const READONLY_TOOLS = 'Read,Glob,Grep' // truly read-only — no Bash/Write/Edit
const EXEC_TOOLS     = 'Bash,Read,Write,Edit,Glob,Grep'

// ─── Préréglages modèle / effort (choisis par l'utilisateur à la soumission) ──
// Appliqués à la proposition instantanée ET à l'exécution du correctif.
// « Approfondi » (le défaut de la file de travaux) tourne sur le modèle PRÉFÉRÉ de
// l'agent (fable par défaut, changeable depuis le bandeau quotas — clé
// `preferredModel` d'agent-settings.json), avec repli automatique quand son quota
// hebdomadaire est épuisé — voir agentModel.js. Le modèle inscrit sur la tâche reste
// le modèle SOUHAITÉ ; celui réellement utilisé est résolu au démarrage de
// l'exécution (champ `run_model`).
export const PRESETS = {
  fast:     { model: 'haiku',      effort: 'low',    label: 'Rapide' },
  standard: { model: 'sonnet',     effort: 'medium', label: 'Standard' },
  deep:     { model: AGENT_MODEL,  effort: 'high',   label: 'Approfondi' },
}
export function presetFor(key) {
  const p = PRESETS[key] || PRESETS.standard
  // « Approfondi » suit le modèle préféré courant, pas le fable figé du littéral.
  return p === PRESETS.deep ? { ...p, model: preferredAgentModel() } : p
}

// Repli maximal par tâche : la longueur de la chaîne moins le modèle préféré. Garde-fou
// anti-boucle — une détection de quota qui se déclencherait à tort ne peut pas relancer
// la même tâche indéfiniment.
function maxFallbacksFor(model) { return Math.max(0, modelChain(model).length - 1) }

// ─── Prompt général (préambule système, éditable depuis la page Agent) ─────────
// Injecté en tête de CHAQUE activité (proposition instantanée / conversation / exécution).
// Surchargeable via agent-settings.json (clé `generalPrompt`) — voir getSettings().
export const DEFAULT_GENERAL_PROMPT =
  'Tu es un agent autonome d\'amélioration de l\'ERP Orisha (repo à /home/ec2-user/erp). ' +
  'L\'ERP est une app single-tenant qui couvre marketing, ventes, logistique, assemblage, comptabilité, RH et dashboards. ' +
  'Respecte toujours le CLAUDE.md à la racine du projet.'

function generalPrompt() {
  const p = getSettings().generalPrompt
  return (typeof p === 'string' && p.trim()) ? p.trim() : DEFAULT_GENERAL_PROMPT
}

// ─── Modèles de prompt par activité (éditables depuis la page Agent) ───────────
// Chaque modèle est le prompt COMPLET d'une activité (au-delà du préambule général).
// Les jetons {{placeholder}} sont remplacés au moment de l'exécution par renderTemplate().
// Surchargeables via agent-settings.json (clés instantPrompt / conversationPrompt /
// executionPrompt) — un champ vide retombe sur le défaut ci-dessous (voir promptTemplate()).
//
// Placeholders disponibles :
//   instantané    : {{general}} {{text}} {{context}}
//   conversation  : {{general}} {{proposal}} {{why}} {{zone}} {{thread}}
//   exécution     : {{general}} {{brief}} {{internalSecret}}

export const DEFAULT_INSTANT_PROMPT = [
  '{{general}}', '\n\n',
  'Un utilisateur vient de signaler un problème ou de suggérer une amélioration via la bulle d\'aide de l\'app. ',
  'Tu n\'as AUCUN outil : ne tente pas de lire le code, réponds uniquement à partir du signalement et de ta connaissance générale de l\'ERP.\n\n',
  'Signalement (depuis la page {{context}}):\n{{text}}\n\n',
  'Propose UN correctif concret et plausible : ce qui devrait changer dans l\'app, où (page/zone), et le comportement attendu après le correctif. ',
  'Écris en français, orienté utilisateur (pas de jargon technique ni de noms de fichiers), en 3 à 6 phrases maximum. ',
  'Si le signalement est trop vague pour proposer quoi que ce soit, dis-le et pose LA question qui débloquerait. ',
  'Ne produis que la proposition, sans préambule ni titre.',
].join('')

export const DEFAULT_CONVERSATION_PROMPT = [
  '{{general}}', '\n\n',
  'Tu DISCUTES d\'une proposition d\'amélioration avec l\'humain — tu ne codes PAS maintenant.\n',
  'Tu es en LECTURE SEULE: tu peux explorer le code (Read/Glob/Grep) pour répondre précisément, mais tu ne modifies RIEN.\n\n',
  'Proposition: {{proposal}}\n',
  '{{why}}',
  '{{zone}}',
  '\nFil de discussion:\n{{thread}}\n\n',
  'Réponds au DERNIER message de l\'humain de façon concise (max ~150 mots). ',
  'Tu peux raffiner l\'idée, clarifier la zone touchée ou le risque, ou proposer une variante. ',
  'Si l\'humain demande des changements, confirme-les: ils seront appliqués quand il cliquera « Approuver & coder ». ',
  'Ne produis que ta réponse, sans préambule.',
].join('')

// Consigne du compte-rendu utilisateur — garantie dans CHAQUE prompt d'exécution,
// même si l'utilisateur a personnalisé son modèle sans l'inclure (voir executeTask).
// Toujours très court : 1-2 phrases MAX, sauf si la complexité l'exige vraiment
// (l'utilisateur a explicitement demandé des réponses courtes, à répéter sans relâche).
export const SUMMARY_SECTION_MARKER = '=== RÉSUMÉ UTILISATEUR ==='
export const SUMMARY_SECTION_INSTRUCTION = [
  'Puis termine IMPÉRATIVEMENT ta réponse par une section délimitée EXACTEMENT ainsi:\n',
  SUMMARY_SECTION_MARKER, '\n',
  'Suivie d\'un TRÈS court compte-rendu en français destiné à l\'utilisateur qui a signalé le problème, SANS jargon technique ni noms de fichiers. ',
  'Maximum 1 à 2 phrases, sauf si la complexité du changement rend une explication plus longue vraiment nécessaire (cas rare). ',
  'Explique ce qui a changé dans l\'app et comment le constater, en gardant ça bref. ',
  'Si la tâche est bloquée, explique en une phrase pourquoi.',
].join('')

export const DEFAULT_EXECUTION_PROMPT = [
  '{{general}}', '\n\n',
  'Implémente UNIQUEMENT la tâche ci-dessous. ',
  'Ne lis pas agent-tasks.json ni les autres fichiers de gestion de tâches de l\'agent.\n\n',
  '{{brief}}',
  '\n\n=== RÈGLES IMPÉRATIVES (CLAUDE.md) ===\n',
  '- Respecte le CLAUDE.md à la racine du projet (lis-le si besoin).\n',
  '- Definition of Done frontend: toute modif dans client/src/ DOIT être suivie de `cd /home/ec2-user/erp/client && npm run build` PUIS d\'un test Playwright réel dans e2e/tests/ exécuté contre http://localhost:3004/erp.\n',
  '- Toute modif serveur (server/src/) DOIT être suivie de `pm2 restart erp-server`.\n',
  '- Si un test E2E échoue: corrige et relance. Au MAXIMUM 3 tentatives de correction. Si après 3 tentatives le test échoue encore, ARRÊTE, n\'invente rien, et explique clairement le blocage (ce sera marqué « bloqué »).\n',
  '- Nettoie tout record créé par tes tests E2E (hook after()), et restaure toute configuration existante que le test a écrasée — voir CLAUDE.md.\n\n',
  'Si tu as besoin d\'une approbation humaine pour une sous-étape, crée une sous-tâche:\n',
  'curl -s -X POST http://localhost:3004/api/agent/tasks/internal -H \'Content-Type: application/json\' -H \'X-Agent-Secret: {{internalSecret}}\' -d \'{"description":"...","priority":0}\'\n\n',
  'Termine par un rapport détaillé: ce que tu as changé, le résultat du build et des tests E2E (vert/rouge), ou la raison du blocage.\n',
  SUMMARY_SECTION_INSTRUCTION,
].join('')

// Consigne de la section réponse pour une QUESTION — même marqueur que le résumé
// d'implémentation (le pipeline monitorExecution/user_summary est partagé), mais la
// section contient la RÉPONSE, pas un compte-rendu de changements.
export const QUESTION_SUMMARY_INSTRUCTION = [
  'Termine IMPÉRATIVEMENT ta réponse par une section délimitée EXACTEMENT ainsi:\n',
  SUMMARY_SECTION_MARKER, '\n',
  'Suivie de la RÉPONSE à la question, en français, destinée à l\'utilisateur, SANS jargon technique ni noms de fichiers. ',
  'Adapte la longueur à la complexité de la question : une phrase pour une question simple, quelques paragraphes si nécessaire. ',
  'Si tu n\'as pas pu répondre, explique simplement pourquoi.',
].join('')

// ─── Question de l'agent à l'humain ──────────────────────────────────────────
// Une exécution tourne détachée, sans terminal : elle ne peut PAS afficher un
// choix et attendre. Avant, elle devinait (ou finissait « bloquée » avec la
// question noyée dans le compte-rendu). Elle émet donc une section finale
// optionnelle, lue par finalize() et posée sur l'item de file : la carte affiche
// la question avec ses choix, et un clic répond dans le fil — ce qui relance la
// tâche avec la réponse. Section OPTIONNELLE : ne rien émettre est le cas normal.
export const QUESTION_MARKER = '=== QUESTION UTILISATEUR ==='
export const ASK_USER_INSTRUCTION = [
  '\n\nEnfin, UNIQUEMENT si une décision ne t\'appartient pas et qu\'aucune hypothèse raisonnable ne permet de trancher ',
  '(deux comportements également défendables, une règle métier que seul l\'utilisateur connaît), ajoute TOUT À LA FIN ',
  'une dernière section délimitée EXACTEMENT ainsi:\n',
  QUESTION_MARKER, '\n',
  'Suivie d\'un objet JSON sur une seule ligne: {"question":"la question en français, sans jargon","options":["choix 1","choix 2"]}\n',
  'Deux à quatre options, chacune une réponse complète et actionnable (pas « oui »/« non » nus). ',
  'N\'émets cette section que si tu attends VRAIMENT une réponse : le travail est mis en attente de l\'utilisateur. ',
  'Si tu as pu trancher toi-même, n\'écris pas cette section du tout.',
].join('')

/**
 * Détache la section question du rapport. Renvoie { text, question } où `text` est
 * le rapport sans la section. Tolérant : si le JSON est mal formé, la question brute
 * est conservée sans options — mieux vaut une question sans boutons que rien.
 */
export function extractPendingQuestion(raw) {
  const text = String(raw || '')
  const idx = text.lastIndexOf(QUESTION_MARKER)
  if (idx === -1) return { text, question: null }
  const body = text.slice(idx + QUESTION_MARKER.length).trim()
  const head = text.slice(0, idx).trim()
  if (!body) return { text: head, question: null }

  // Le modèle enrobe parfois le JSON dans un bloc de code : on prend le premier
  // objet accoladé du corps, sinon on retombe sur le texte brut.
  const json = body.match(/\{[\s\S]*\}/)
  if (json) {
    try {
      const parsed = JSON.parse(json[0])
      const q = String(parsed.question || '').trim()
      // JSON valide mais sans question : il n'y a rien à demander. Ne PAS retomber sur
      // le repli texte, qui afficherait le JSON brut à l'utilisateur comme question.
      if (!q) return { text: head, question: null }
      const options = Array.isArray(parsed.options)
        ? parsed.options.map(o => String(o).trim()).filter(Boolean).slice(0, 4)
        : []
      return { text: head, question: { question: q, options } }
    } catch { /* repli texte brut ci-dessous */ }
  }
  const plain = body.replace(/```\w*|```/g, '').trim()
  return { text: head, question: plain ? { question: plain, options: [] } : null }
}

// Prompt d'exécution d'une QUESTION (mode choisi par l'utilisateur à la soumission) :
// exploration en lecture seule, AUCUNE implémentation — la réponse part dans la
// section résumé et devient le compte-rendu de la carte.
export const DEFAULT_QUESTION_PROMPT = [
  '{{general}}', '\n\n',
  'La demande ci-dessous est une QUESTION de l\'utilisateur — PAS une demande d\'implémentation. ',
  'N\'implémente RIEN : tu es en LECTURE SEULE (Read/Glob/Grep uniquement), tu ne modifies aucun fichier, tu ne lances ni build, ni test, ni redémarrage. ',
  'Ne lis pas agent-tasks.json ni les autres fichiers de gestion de tâches de l\'agent.\n\n',
  '{{brief}}',
  '\n\nExplore le code autant que nécessaire pour répondre précisément et complètement à la question.\n',
  QUESTION_SUMMARY_INSTRUCTION,
].join('')

// Map clé de réglage → modèle par défaut. Source de vérité partagée avec la route
// GET /settings (qui renvoie ces défauts au front pour le bouton « Réinitialiser »).
export const PROMPT_TEMPLATE_DEFAULTS = {
  instantPrompt:      DEFAULT_INSTANT_PROMPT,
  conversationPrompt: DEFAULT_CONVERSATION_PROMPT,
  executionPrompt:    DEFAULT_EXECUTION_PROMPT,
  questionPrompt:     DEFAULT_QUESTION_PROMPT,
}

// Récupère le modèle effectif d'une activité : override utilisateur si non vide, sinon défaut.
function promptTemplate(key) {
  const v = getSettings()[key]
  return (typeof v === 'string' && v.trim()) ? v : PROMPT_TEMPLATE_DEFAULTS[key]
}

// Remplace les jetons {{placeholder}} par leur valeur. N'affecte QUE les doubles accolades —
// les accolades simples du schéma JSON de sortie sont préservées telles quelles.
function renderTemplate(tpl, vars) {
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k] ?? '') : m))
}

// ERP_AGENT_RUN=1 est posé sur CHAQUE spawn de claude ci-dessous (voir les quatre
// sites `env:`). Les hooks Stop/Notification de ~/.claude/settings.json héritent de
// cet environnement : slack-notify.sh sort en silence quand la variable est là.
// Sans ce marqueur, une tâche lancée par n'importe quel utilisateur depuis la bulle
// d'aide envoyait « Tâche terminée » dans le DM Slack d'Antoine. Le recap des items
// de la file de prompts est envoyé par le serveur (voir promptQueue.js), pas par le hook.

// ─── Single global slot ───────────────────────────────────────────────────────
// Exactly ONE Claude activity runs at a time (execution / conversation / generation),
// because everything edits or reads the live working tree — no isolation.
// Priority: execution > conversation > generation.
let busy = false
let currentTaskId = null
let currentActivity = null     // 'execution' | 'conversation'
let _currentProc = null
const _replyQueue = []         // proposal ids awaiting a conversation reply

// ─── Voie lecture seule parallèle (tâches « question ») ───────────────────────
// Une question n'a que Read/Glob/Grep : elle ne peut modifier ni fichier, ni DB,
// ni redémarrer le serveur. Elle tourne donc HORS du slot global — jusqu'à
// MAX_PARALLEL_QUESTIONS en même temps, y compris pendant une implémentation, ce
// qui évite qu'une simple question attende la fin d'un chantier.
// Contrepartie assumée : une question lancée pendant une implémentation peut lire
// l'arbre à mi-chemin d'une modification. Acceptable pour une réponse en lecture
// seule ; c'est pourquoi l'implémentation, elle, reste strictement séquentielle.
const MAX_PARALLEL_QUESTIONS = 2
const _questionRuns = new Set()   // ids des tâches question en cours

// In-memory stream buffer per task: taskId -> chunk[]
const streamBuffers = new Map()

function appendStreamChunk(taskId, chunk) {
  if (!taskId) return
  if (!streamBuffers.has(taskId)) streamBuffers.set(taskId, [])
  const buf = streamBuffers.get(taskId)
  buf.push(chunk)
  if (buf.length > 500) buf.shift()
  broadcastAll({ type: 'agent:task:stream', taskId, chunk })
}

export function getStreamBuffer(taskId) {
  return streamBuffers.get(taskId) || []
}

// ─── Steering : message de l'utilisateur pendant une exécution ────────────────
// Dépose le message dans l'inbox de l'exécution ; le hook PostToolUse/Stop de la
// tâche le livrera à Claude après le prochain outil (ou juste avant la fin).
// Refuse si l'exécution ne tourne pas — un message déposé pour rien serait perdu.
export function sendSteeringMessage(taskId, text) {
  const clean = String(text || '').trim()
  if (!clean) return false
  const task = readTasks().find(t => t.id === taskId)
  if (!task || task.status !== 'in_progress') return false
  appendFileSync(EXEC_INBOX(taskId), JSON.stringify({ text: clean, at: new Date().toISOString() }) + '\n', 'utf8')
  // Le message apparaît aussi dans le flux live de la tâche : celui qui regarde
  // l'exécution voit ce qui vient d'être glissé à Claude.
  appendStreamChunk(taskId, { kind: 'user', text: clean })
  return true
}

// Parse ONE line of Claude's stream-json output and push UI chunks (no-op if taskId null).
function streamLine(taskId, line) {
  if (!taskId || !line.trim()) return
  try {
    const evt = JSON.parse(line)
    if (evt.type === 'assistant' && evt.message?.content) {
      for (const block of evt.message.content) {
        if (block.type === 'text' && block.text?.trim()) {
          appendStreamChunk(taskId, { kind: 'text', text: block.text })
        } else if (block.type === 'tool_use') {
          const inp = block.input
          const preview = inp?.command || inp?.file_path || inp?.pattern ||
            (typeof inp === 'object' ? String(Object.values(inp)[0] ?? '').slice(0, 120) : '')
          appendStreamChunk(taskId, { kind: 'tool', name: block.name, input: preview })
        }
      }
    } else if (evt.type === 'user' && evt.message?.content) {
      for (const block of evt.message.content) {
        if (block.type === 'tool_result') {
          let content = ''
          if (typeof block.content === 'string') content = block.content
          else if (Array.isArray(block.content)) content = block.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
          const trimmed = content.trim()
          if (trimmed) appendStreamChunk(taskId, { kind: 'result', content: trimmed.slice(0, 400) })
        }
      }
    }
  } catch {}
}

// Concatenate the assistant's final text blocks from a full stream-json transcript.
function extractAssistantText(transcript) {
  let text = ''
  for (const line of transcript.split('\n')) {
    if (!line.trim()) continue
    try {
      const evt = JSON.parse(line)
      if (evt.type === 'assistant' && evt.message?.content) {
        for (const block of evt.message.content) {
          if (block.type === 'text') text += block.text
        }
      }
    } catch {}
  }
  return text
}

// Message FINAL de l'exécution, tel que Claude le rend dans l'événement `result` du
// stream-json. C'est là que vit la section « RÉSUMÉ UTILISATEUR » : sur les longues
// exécutions, les événements `assistant` intermédiaires peuvent ne pas la contenir
// (dernier tour rendu uniquement dans le result), d'où un compte-rendu introuvable.
function extractResultText(transcript) {
  let last = ''
  for (const line of transcript.split('\n')) {
    if (!line.includes('"result"')) continue
    try {
      const evt = JSON.parse(line)
      if (evt.type === 'result' && typeof evt.result === 'string' && evt.result.trim()) last = evt.result
    } catch {}
  }
  return last
}

// Identifiant de session Claude d'une exécution, lu dans le transcript stream-json
// (chaque événement le porte). Conservé sur la tâche pour qu'un item de la file
// marqué « même contexte » puisse reprendre la session avec --resume.
function extractSessionId(transcript) {
  for (const line of transcript.split('\n')) {
    if (!line.includes('session_id')) continue
    try {
      const evt = JSON.parse(line)
      if (evt.session_id) return evt.session_id
    } catch {}
  }
  return null
}

// ─── File-backed stores (atomic write) ────────────────────────────────────────
function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf8')) } catch { return fallback }
}
function writeJson(file, value) {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8')
  renameSync(tmp, file)
}

function readTasks() { return readJson(TASKS_FILE, []) }
function writeTasks(tasks) {
  writeFileSync(TASKS_TMP, JSON.stringify(tasks, null, 2) + '\n', 'utf8')
  renameSync(TASKS_TMP, TASKS_FILE)
}

export function getSettings() {
  return {
    enabled: false,
    autoApprove: true,
    // Pause de la file de travaux (page /travaux) — distincte de `enabled`, qui coupe
    // TOUT l'agent (y compris les signalements de la bulle d'aide). En pause, aucune
    // nouvelle exécution de la file ne démarre ; celle qui tourne va au bout.
    queuePaused: false,
    queuePausedAt: null,
    queuePausedReason: null,
    generalPrompt: DEFAULT_GENERAL_PROMPT,
    instantPrompt: DEFAULT_INSTANT_PROMPT,
    conversationPrompt: DEFAULT_CONVERSATION_PROMPT,
    executionPrompt: DEFAULT_EXECUTION_PROMPT,
    questionPrompt: DEFAULT_QUESTION_PROMPT,
    // Modèle préféré de l'agent (sélecteur du bandeau quotas) — voir agentModel.js.
    preferredModel: AGENT_MODEL,
    ...readJson(SETTINGS_FILE, {}),
  }
}
export function setSettings(patch) {
  const next = { ...getSettings(), ...patch }
  writeJson(SETTINGS_FILE, next)
  // Le résolveur de modèle (agentModel.js) vit en mémoire : on le tient aligné sur le
  // réglage persisté pour que le changement s'applique dès la prochaine exécution.
  if ('preferredModel' in patch) setPreferredAgentModel(next.preferredModel)
  broadcastAll({ type: 'agent:settings:updated', settings: next })
  // Turning the agent ON may unblock queued work.
  if (next.enabled) setImmediate(kick)
  return next
}

// Au démarrage : recharge le modèle préféré persisté (le résolveur est en mémoire,
// un redémarrage l'aurait sinon remis sur le défaut fable).
setPreferredAgentModel(getSettings().preferredModel)

// ─── Pause de la file de travaux ──────────────────────────────────────────────
// Bouton « Pause » de la page /travaux : rien de nouveau ne part, l'exécution en
// cours finit normalement (donc aucun travail perdu, aucun jeton gaspillé à
// refaire ce qui était commencé). La reprise redémarre exactement là où la file
// s'était arrêtée — l'item suivant n'a jamais été lancé, il n'a rien à rattraper.
export function isQueuePaused() { return !!getSettings().queuePaused }

export function setQueuePaused(paused, { reason = null } = {}) {
  const next = setSettings({
    queuePaused: !!paused,
    queuePausedAt: paused ? new Date().toISOString() : null,
    queuePausedReason: paused ? (reason || null) : null,
  })
  if (!paused) setImmediate(kick)
  return {
    paused: !!next.queuePaused,
    pausedAt: next.queuePausedAt || null,
    reason: next.queuePausedReason || null,
  }
}

export function readBacklog() { return readJson(BACKLOG_FILE, []) }
function writeBacklog(items) { writeJson(BACKLOG_FILE, items); broadcastAll({ type: 'agent:backlog:updated' }) }

// Une « suggestion » : signalement utilisateur (bulle d'aide ou page agent) qui
// porte sa proposition instantanée puis le lien vers la tâche d'implémentation.
export function addBacklogItem(text, { context = '', author = '', preset = 'standard', mode = 'implement' } = {}) {
  const item = {
    id: randomUUID(),
    text,
    context,                       // route de la page d'où vient le signalement
    author,                        // nom de l'utilisateur qui signale
    mode: mode === 'question' ? 'question' : 'implement', // question = répondre sans rien implémenter
    preset: PRESETS[preset] ? preset : 'standard',
    instant_status: 'generating',  // 'generating' | 'ready' | 'error'
    instant_proposal: null,        // correctif proposé (LLM sans outils)
    task_id: null,                 // tâche d'implémentation une fois approuvée
    processed: false,
    created_at: new Date().toISOString(),
  }
  const items = readBacklog()
  items.push(item)
  writeBacklog(items)
  return item
}
export function updateBacklogItem(id, updates) {
  const items = readBacklog()
  const idx = items.findIndex(i => i.id === id)
  if (idx === -1) return null
  items[idx] = { ...items[idx], ...updates }
  writeBacklog(items)
  return items[idx]
}
export function deleteBacklogItem(id) {
  writeBacklog(readBacklog().filter(i => i.id !== id))
}

// ─── Proposition instantanée (sans outils, hors slot global) ──────────────────
// Tourne en PARALLÈLE de tout le reste : aucun outil autorisé → aucune interaction
// avec l'arbre de travail, donc pas besoin du slot global ni du toggle enabled.
export function generateInstantProposal(itemId) {
  const item = readBacklog().find(i => i.id === itemId)
  if (!item) return
  const { model: wanted, effort } = presetFor(item.preset)
  const model = resolveModel(wanted) || wanted
  const prompt = renderTemplate(promptTemplate('instantPrompt'), {
    general: generalPrompt(),
    text: item.text,
    context: item.context || '(inconnue)',
  })

  const { CLAUDECODE: _c, CLAUDE_CODE_ENTRYPOINT: _e, ...cleanEnv } = process.env
  const proc = spawn(CLAUDE_BIN, [
    '-p', '--model', model, '--effort', effort, '--tools', '',
  ], { cwd: CWD, env: { ...cleanEnv, HOME: '/home/ec2-user', ERP_AGENT_RUN: '1' }, stdio: 'pipe' })

  proc.stdin.write(prompt)
  proc.stdin.end()

  let output = ''
  let settled = false
  const timer = setTimeout(() => { if (!settled) { try { proc.kill('SIGKILL') } catch {} } }, INSTANT_TIMEOUT_MS)

  proc.stdout.on('data', chunk => { output += chunk.toString() })
  proc.stderr.on('data', () => {})
  proc.on('error', () => {})
  proc.on('close', (code) => {
    if (settled) return
    settled = true
    clearTimeout(timer)
    const text = output.trim()
    const ok = code === 0 && text
    updateBacklogItem(itemId, ok
      ? { instant_status: 'ready', instant_proposal: text }
      : { instant_status: 'error', instant_proposal: null })
    if (!ok) console.error(`🤖 Agent: proposition instantanée en échec (item ${itemId}, exit ${code})`)
  })
}

// ─── Appel Claude sans outils (hors slot global) ──────────────────────────────
// Aucun outil autorisé → aucune interaction avec l'arbre de travail : ces appels
// tournent en parallèle d'une exécution sans risque de lire un fichier à moitié
// écrit. Utilisé par le moteur de suggestions, qui reçoit son contexte tout cuit
// (git log, journaux) plutôt que d'explorer le repo lui-même.
export function runToollessClaude({ prompt, model: wanted = 'sonnet', effort = 'medium', timeoutMs = 4 * 60_000 }) {
  return new Promise((resolveP) => {
    // Même résolution que les exécutions : un quota de modèle épuisé emprunte le repli
    // au lieu de faire échouer l'appel.
    const model = resolveModel(wanted) || wanted
    const { CLAUDECODE: _c, CLAUDE_CODE_ENTRYPOINT: _e, ...cleanEnv } = process.env
    const proc = spawn(CLAUDE_BIN, [
      '-p', '--model', model, '--effort', effort, '--tools', '',
    ], { cwd: CWD, env: { ...cleanEnv, HOME: '/home/ec2-user', ERP_AGENT_RUN: '1' }, stdio: 'pipe' })

    proc.stdin.write(prompt)
    proc.stdin.end()

    let output = ''
    let settled = false
    const settle = (v) => { if (!settled) { settled = true; clearTimeout(timer); resolveP(v) } }
    const timer = setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, timeoutMs)

    proc.stdout.on('data', c => { output += c.toString() })
    proc.stderr.on('data', () => {})
    proc.on('error', () => settle({ code: -1, text: '' }))
    proc.on('close', (code) => settle({ code, text: output.trim() }))
  })
}

// ─── Compte-rendu utilisateur de secours (a posteriori, sans outils) ───────────
// Deux cas alimentent ce chemin : une exécution dont le modèle a oublié la section
// « RÉSUMÉ UTILISATEUR », et les tâches terminées AVANT l'ajout du compte-rendu
// (rattrapage au démarrage — voir backfillUserSummaries). Aucun outil autorisé →
// tourne hors slot global, en parallèle de tout le reste, comme la proposition
// instantanée.
const SUMMARY_TIMEOUT_MS = 3 * 60_000
const _summarizing = new Map()

/**
 * Compte-rendu de secours, déduplicé : plusieurs appelants peuvent l'attendre en
 * même temps (le finalize de la tâche ET la file de travaux, qui refuse de figer un
 * placeholder dans son fil) — ils partagent la MÊME exécution et la même promesse.
 */
export function generateUserSummary(taskId) {
  const inflight = _summarizing.get(taskId)
  if (inflight) return inflight
  const p = runUserSummary(taskId).finally(() => _summarizing.delete(taskId))
  _summarizing.set(taskId, p)
  return p
}

function runUserSummary(taskId) {
  return new Promise((resolveP) => {
    const task = readTasks().find(t => t.id === taskId)
    if (!task || task.user_summary || !['done', 'blocked'].includes(task.status)) return resolveP(false)
    const report = (task.agent_result || '').trim()
    if (!report || report === '(terminé sans rapport)') return resolveP(false)

    // Une tâche « question » n'a rien changé dans l'app : le compte-rendu de secours
    // est la RÉPONSE tirée du rapport, pas un récit de modifications.
    const isQuestion = task.mode === 'question'
    const prompt = isQuestion ? [
      'Un agent autonome vient d\'explorer l\'ERP Orisha (en lecture seule) pour répondre à la question d\'un utilisateur. ',
      'Rédige la RÉPONSE destinée à l\'utilisateur, en français, SANS jargon technique ni noms de fichiers, à partir du rapport ci-dessous. ',
      'Sois aussi concis que possible — une ou deux phrases courtes suffisent si elles répondent à la question. ',
      task.status === 'blocked'
        ? 'L\'agent n\'a PAS pu répondre : une phrase pour expliquer pourquoi, sans détails techniques. '
        : '',
      // Même garde-fou que pour les implémentations : pas de réponse inventée à partir
      // d'un rapport coupé net.
      'INTERDIT d\'inventer : n\'affirme que ce que le rapport établit. ',
      'Si le rapport ne contient pas la réponse (exploration interrompue), dis simplement que la recherche n\'a pas abouti et qu\'il faut relancer. ',
      'Ne produis QUE la réponse, sans préambule ni titre.\n\n',
      `Question de l'utilisateur:\n${task.description || task.title || '(inconnue)'}\n\n`,
      `Rapport de l'exploration:\n${report.slice(-12000)}`,
    ].join('') : [
      'Un agent autonome vient d\'intervenir sur l\'ERP Orisha suite à un signalement utilisateur. ',
      'Rédige le compte-rendu destiné à l\'utilisateur, en français, SANS jargon technique ni noms de fichiers. ',
      'Sois aussi concis que possible — une seule phrase peut suffire. Deux phrases maximum pour un changement plus important. ',
      'Explique ce qui a changé dans l\'app, comment le constater, et tout commentaire pertinent. ',
      task.status === 'blocked'
        ? 'L\'intervention a été BLOQUÉE : une phrase pour expliquer pourquoi, sans détails techniques. '
        : '',
      // Garde-fou anti-fabulation : un rapport coupé net (quota épuisé, process tué) ne
      // montre que le début de l'investigation. Sans cette consigne, le modèle
      // extrapolait un « c'est intégré, allez voir » pour du travail jamais terminé.
      'INTERDIT d\'inventer ou de supposer : n\'affirme un changement que si le rapport le montre explicitement. ',
      'Si le rapport ne montre que le début du travail (exploration, intention, aucune modification confirmée), dis-le franchement : ',
      'que le travail a été interrompu avant d\'aboutir, que rien ne garantit qu\'il soit fait, et qu\'il faut le relancer. ',
      'Ne produis QUE le compte-rendu, sans préambule ni titre.\n\n',
      `Signalement initial:\n${task.description || task.title || '(inconnu)'}\n\n`,
      // Fin du rapport = conclusion de l'agent (le début est du récit d'exécution).
      `Rapport technique de l'intervention:\n${report.slice(-12000)}`,
    ].join('')

    const { CLAUDECODE: _c, CLAUDE_CODE_ENTRYPOINT: _e, ...cleanEnv } = process.env
    const proc = spawn(CLAUDE_BIN, [
      '-p', '--model', 'haiku', '--effort', 'low', '--tools', '',
    ], { cwd: CWD, env: { ...cleanEnv, HOME: '/home/ec2-user', ERP_AGENT_RUN: '1' }, stdio: 'pipe' })

    proc.stdin.write(prompt)
    proc.stdin.end()

    let output = ''
    let settled = false
    const settle = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveP(ok)
    }
    const timer = setTimeout(() => { try { proc.kill('SIGKILL') } catch {} }, SUMMARY_TIMEOUT_MS)

    proc.stdout.on('data', chunk => { output += chunk.toString() })
    proc.stderr.on('data', () => {})
    proc.on('error', () => settle(false))
    proc.on('close', (code) => {
      const text = output.trim()
      if (code === 0 && text) {
        const updated = updateTask(taskId, { user_summary: text })
        if (updated) broadcastTask(updated)
        settle(true)
      } else {
        console.error(`🤖 Agent: génération du compte-rendu en échec (tâche ${taskId}, exit ${code})`)
        settle(false)
      }
    })
  })
}

// Rattrapage : compte-rendus manquants sur les implémentations déjà terminées
// (tâches d'avant la fonctionnalité, ou prompt personnalisé sans la section).
// Séquentiel pour ne pas empiler les subprocess ; idempotent (le résumé persisté
// n'est jamais régénéré) ; relancé au prochain démarrage en cas d'échec ponctuel.
let _backfillStarted = false
async function backfillUserSummaries() {
  if (_backfillStarted) return
  _backfillStarted = true
  const ids = readTasks()
    .filter(t => ['done', 'blocked'].includes(t.status) && !t.user_summary && (t.agent_result || '').trim())
    .map(t => t.id)
  if (!ids.length) return
  console.log(`🤖 Agent: rattrapage des compte-rendus manquants (${ids.length} tâche(s))…`)
  for (const id of ids) {
    try { await generateUserSummary(id) } catch {}
  }
  console.log('🤖 Agent: rattrapage des compte-rendus terminé')
}

// ─── Approbation d'une suggestion → tâche d'implémentation ────────────────────
export function approveBacklogItem(id, { comment = '' } = {}) {
  const item = readBacklog().find(i => i.id === id)
  if (!item) return null
  if (item.task_id) return { item, task: readTasks().find(t => t.id === item.task_id) || null }
  const { model, effort } = presetFor(item.preset)
  const now = new Date().toISOString()
  const task = {
    id: randomUUID(),
    kind: 'suggestion',
    mode: item.mode === 'question' ? 'question' : 'implement',
    backlog_id: item.id,
    title: item.text.length > 140 ? item.text.slice(0, 140) + '…' : item.text,
    description: item.text,
    context: item.context || '',
    author: item.author || '',
    model, effort,
    status: 'approved',
    priority: 0,
    messages: [],
    user_comment: comment || null,
    agent_result: null,
    user_summary: null,
    created_at: now,
    updated_at: now,
    completed_at: null,
  }
  const tasks = readTasks()
  tasks.push(task)
  writeTasks(tasks)
  const updatedItem = updateBacklogItem(id, { task_id: task.id, processed: true })
  broadcastTask(task)
  setImmediate(kick)
  return { item: updatedItem, task }
}

function updateTask(id, updates) {
  const tasks = readTasks()
  const idx = tasks.findIndex(t => t.id === id)
  if (idx === -1) return null
  const task = { ...tasks[idx], ...updates, updated_at: new Date().toISOString() }
  tasks[idx] = task
  writeTasks(tasks)
  return task
}

function broadcastTask(task) { broadcastAll({ type: 'agent:task:updated', task }) }

export function isRunnerBusy() { return busy }
/** Nombre de questions en cours dans la voie lecture seule (0 à MAX_PARALLEL_QUESTIONS). */
export function getRunningQuestionCount() { return _questionRuns.size }
export function getMaxParallelQuestions() { return MAX_PARALLEL_QUESTIONS }
export function getCurrentTaskId() { return currentTaskId }
export function getCurrentActivity() { return currentActivity }

// ─── Quotas Claude épuisés ────────────────────────────────────────────────────
// « You've hit your session limit · resets 3:40am (UTC) » : ce n'est PAS un échec de
// la tâche, c'est un quota épuisé. Le marquer « bloqué » brûlait toute la file en
// quelques secondes (chaque item repartait, mourait aussitôt, et affichait un message
// d'erreur trompeur).
//
// Deux réactions selon le plafond touché (attribution dans handleLimitHit, registre
// par modèle dans agentModel.js) :
//   • plafond propre au modèle (le hebdo de fable) → la tâche repart aussitôt sur le
//     modèle de repli (opus). Rien ne s'arrête, et fable reprend la main à sa réinit.
//   • plafond de compte (fenêtre de 5 h, hebdo tous modèles) → l'item retourne en file,
//     l'ordonnanceur se met en pause, et tout repart tout seul à l'heure dite.
const LIMIT_RE = /(?:hit your (?:session|usage|weekly) limit|usage limit reached|limit will reset)/i
const RESET_RE = /reset(?:s)?(?:\s+at)?\s+(\d{1,2}):(\d{2})\s*(am|pm)?\s*(?:\(([^)]{1,20})\))?/i

let _limitTimer = null

/**
 * Instant de reprise quand l'ordonnanceur est VRAIMENT à l'arrêt, c'est-à-dire quand
 * même le modèle de repli est à sec (0 sinon). Le plafond hebdomadaire de fable seul ne
 * compte pas : le travail continue sur opus, la file n'est pas en pause.
 */
export function getSessionLimitResetAt() { return chainAvailableAt(preferredAgentModel()) }

/** État du modèle de l'agent (préféré / actif / quotas épuisés) — exposé par /agent/usage. */
export function getAgentModelState() { return agentModelState(preferredAgentModel()) }

/**
 * Reconnaît le message de quota dans la sortie d'une exécution et en déduit l'heure de
 * reprise. Heure lue en UTC (c'est ce que le CLI imprime) ; à défaut d'heure lisible on
 * repousse d'une heure — jamais de reprise immédiate, qui rebrûlerait la file.
 */
/**
 * Signal structuré du stream : chaque exécution émet des `rate_limit_event` portant
 * `rate_limit_info.status` et `resetsAt` (epoch secondes). Bien plus fiable que la
 * phrase d'erreur — on le lit en priorité, et seul un statut non-« allowed » compte.
 */
export function detectRateLimitEvent(transcript, now = Date.now()) {
  let hit = null
  for (const line of String(transcript || '').split('\n')) {
    if (!line.includes('rate_limit_info')) continue
    try {
      const info = JSON.parse(line)?.rate_limit_info
      if (!info?.status) continue
      // Le DERNIER état connu gagne : un refus suivi d'un retour à « allowed » (fenêtre
      // réinitialisée en cours d'exécution) ne doit pas mettre l'ordonnanceur en pause.
      if (info.status === 'allowed' || info.status === 'allowed_warning') { hit = null; continue }
      const resetAt = Number(info.resetsAt) > 0 ? Number(info.resetsAt) * 1000 : now + 60 * 60_000
      hit = { resetAt, label: `${new Date(resetAt).toISOString().slice(11, 16)} UTC` }
    } catch {}
  }
  return hit
}

export function detectSessionLimit(text, now = Date.now()) {
  const s = String(text || '')
  if (!LIMIT_RE.test(s)) return null
  const m = RESET_RE.exec(s)
  if (!m) return { resetAt: now + 60 * 60_000, label: 'dans une heure' }
  let h = parseInt(m[1], 10) % 12
  const min = parseInt(m[2], 10)
  if ((m[3] || '').toLowerCase() === 'pm') h += 12
  if (!m[3] && parseInt(m[1], 10) === 12) h = 12          // « 12:30 » sans am/pm = midi
  const d = new Date(now)
  const at = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, min, 0, 0)
  const resetAt = at > now ? at : at + 24 * 3600_000       // heure déjà passée → demain
  return { resetAt, label: `${String(h).padStart(2, '0')}:${m[2]} UTC` }
}

/**
 * Enregistre un quota épuisé. `models` = le seul modèle concerné (plafond propre au
 * modèle → le repli prend la suite) ou tous (plafond de compte → plus rien ne passe).
 */
function noteLimit(models, { resetAt, label }, { source = 'run' } = {}) {
  const changed = noteModelLimit(models, { resetAt, label, source })
  if (!changed) return
  const stalled = chainAvailableAt(preferredAgentModel())
  if (stalled) {
    const mins = Math.round((stalled - Date.now()) / 60_000)
    console.warn(`🤖 Agent: quotas Claude épuisés (${[].concat(models).join(', ')}) — ordonnanceur en pause ${mins} min (reprise ${label})`)
  } else {
    console.warn(`🤖 Agent: quota ${[].concat(models).join(', ')} épuisé jusqu'à ${label} — bascule sur le modèle de repli`)
  }
  broadcastAll({
    type: 'agent:limit',
    resetAt: stalled ? new Date(stalled).toISOString() : null,
    model: getAgentModelState(),
  })
  rearmLimitTimer()
}

/**
 * Un seul minuteur pour tous les quotas : il se réarme sur la PROCHAINE
 * réinitialisation connue. À son déclenchement, les marques périmées tombent et la file
 * repart — que ce soit fable qui revienne (retour au modèle préféré) ou le dernier
 * repli (sortie de pause).
 */
function rearmLimitTimer() {
  if (_limitTimer) { clearTimeout(_limitTimer); _limitTimer = null }
  const at = nextLimitExpiryAt()
  if (!at) return
  _limitTimer = setTimeout(() => {
    _limitTimer = null
    purgeExpiredLimits()
    console.log('🤖 Agent: quota Claude réinitialisé — reprise de la file')
    kick()
    import('./promptQueue.js').then(m => m.advanceQueue()).catch(() => {})
    rearmLimitTimer()
  }, Math.max(1000, at - Date.now() + 30_000))
  _limitTimer.unref?.()
}

/**
 * Exécution avortée faute de quota. Deux issues :
 *
 *   • le plafond ne visait QUE le modèle utilisé (typiquement le hebdo de fable) et un
 *     repli reste disponible → la tâche repart TOUT DE SUITE sur le modèle suivant. Rien
 *     n'attend, l'utilisateur voit juste le travail reprendre sur opus.
 *   • plus aucun modèle n'a de quota → ancien comportement : la tâche retourne en file,
 *     l'ordonnanceur se met en pause jusqu'à la réinitialisation, aucun compte-rendu
 *     trompeur n'est écrit.
 */
async function handleLimitHit(taskId, limit, sessionId) {
  const task = readTasks().find(t => t.id === taskId) || {}
  const wanted = task.model || preferredAgentModel()
  const ranModel = task.run_model || wanted
  const scope = await fetchLimitScope()
  noteLimit(scope === 'account' ? KNOWN_MODELS : [ranModel], limit)

  const hops = task.model_fallbacks || 0
  const fallback = resolveModel(wanted)
  if (scope === 'model' && fallback && fallback !== ranModel && hops < maxFallbacksFor(wanted)) {
    // Repli immédiat : la tâche redevient « approved » et kick() la relance aussitôt
    // (releaseSlot enchaîne). Le modèle SOUHAITÉ reste inscrit tel quel — c'est
    // resolveModel qui choisit au démarrage, donc fable reprend la main dès son retour.
    const retried = updateTask(taskId, {
      status: 'approved',
      agent_result: `(quota ${ranModel} épuisé jusqu'à ${limit.label} — reprise immédiate sur ${fallback})`,
      user_summary: null,
      run_model: null,
      model_fallbacks: hops + 1,
      session_id: sessionId || null,
      completed_at: null,
    })
    console.warn(`🤖 Agent: tâche ${taskId} relancée sur ${fallback} (quota ${ranModel} épuisé jusqu'à ${limit.label})`)
    if (retried) broadcastTask(retried)
    return
  }

  const isQueue = task.kind === 'queue'
  const deferred = updateTask(taskId, {
    // Item de file : c'est la file qui le relancera (nouvelle tâche) → celle-ci sort
    // du jeu. Suggestion/backlog : le runner la reprendra lui-même.
    status: isQueue ? 'cancelled' : 'approved',
    agent_result: `(limite de session Claude atteinte — reprise automatique à ${limit.label})`,
    user_summary: null,
    run_model: null,
    session_id: sessionId || null,
    completed_at: null,
  })
  if (deferred) {
    broadcastTask(deferred)
    setImmediate(() => {
      import('./promptQueue.js')
        .then(m => m.onAgentTaskDeferred(deferred, limit))
        .catch(e => console.error('🤖 File de travaux: report impossible —', e.message))
    })
  }
}

// ─── Public scheduling API ────────────────────────────────────────────────────
export function requestReply(taskId) {
  if (!_replyQueue.includes(taskId)) _replyQueue.push(taskId)
  setImmediate(kick)
}

// runNextTask kept as a public alias for back-compat (routes call it after approve).
export function runNextTask() { kick() }

// ─── The scheduler heart: pick the next activity by priority ───────────────────
function kick() {
  if (!getSettings().enabled) return

  // File de travaux en pause : ses tâches restent « approved » sans démarrer. Le reste
  // de l'agent (signalements de la bulle d'aide, réponses de conversation) continue —
  // la pause vise la consommation de jetons des chantiers, pas l'app entière.
  const tasks = readTasks().filter(t => !(isQueuePaused() && t.kind === 'queue'))
  const byPriority = (a, b) => (b.priority - a.priority) || a.created_at.localeCompare(b.created_at)
  // Quota épuisé : une tâche n'attend QUE si son modèle et tous ses replis sont à sec
  // (un timer relance kick à la réinitialisation). Le plafond hebdomadaire de fable
  // laisse donc la file tourner sur opus.
  const hasModel = t => !!resolveModel(t.model || preferredAgentModel())

  // 1. Voie lecture seule : les questions démarrent même si une implémentation
  // tourne, jusqu'à MAX_PARALLEL_QUESTIONS simultanées.
  for (const q of tasks.filter(t => t.status === 'approved' && t.mode === 'question' && hasModel(t)).sort(byPriority)) {
    if (_questionRuns.size >= MAX_PARALLEL_QUESTIONS) break
    executeTask(q, { lane: 'question' })
  }

  if (busy) return

  // 2. Implémentation : une seule à la fois, elle édite l'arbre de travail réel.
  const nextExec = tasks
    .filter(t => t.status === 'approved' && t.mode !== 'question' && hasModel(t))
    .sort(byPriority)[0]
  if (nextExec) { executeTask(nextExec); return }

  // 2. Conversation replies (the user is waiting live).
  while (_replyQueue.length) {
    const id = _replyQueue.shift()
    const t = readTasks().find(x => x.id === id)
    if (t && (t.status === 'pending' || t.status === 'in_discussion')) { conversationReply(t); return }
  }
}

function releaseSlot() {
  busy = false
  currentTaskId = null
  currentActivity = null
  _currentProc = null
  setImmediate(kick)
}

// ─── Read-only Claude spawn helper (conversation / generation) ─────────────────
// Pipe-based & in-process. Resolves with { code, text, timedOut }. NOT for execution:
// these turns are short, read-only, and never restart the server, so the in-process
// completion handler is safe here. Execution uses runDetachedExecution() instead.
function spawnClaude({ prompt, allowedTools, streamTaskId = null, timeoutMs }) {
  return new Promise((resolveP) => {
    const { CLAUDECODE: _c, CLAUDE_CODE_ENTRYPOINT: _e, ...cleanEnv } = process.env
    const proc = spawn(CLAUDE_BIN, [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--allowedTools', allowedTools,
    ], { cwd: CWD, env: { ...cleanEnv, HOME: '/home/ec2-user', ERP_AGENT_RUN: '1' }, stdio: 'pipe' })

    _currentProc = proc

    proc.stdin.write(prompt)
    proc.stdin.end()

    let output = ''
    let lineBuffer = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      try { proc.kill('SIGKILL') } catch {}
    }, timeoutMs)

    proc.stdout.on('data', rawChunk => {
      const str = rawChunk.toString()
      output += str
      lineBuffer += str
      const parts = lineBuffer.split('\n')
      lineBuffer = parts.pop()
      for (const line of parts) streamLine(streamTaskId, line)
    })
    proc.stderr.on('data', () => {})

    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const timedOut = code === null || code === 137 // SIGKILL
      resolveP({ code, text: extractAssistantText(output), timedOut })
    })
  })
}

// ─── Detached execution — durable result (survives `pm2 restart erp-server`) ────
// The exec Claude runs inside a detached bash wrapper that redirects its stream to a
// log file and writes the exit code to a sibling file when done. Because nothing reads
// the child's stdout pipe, a parent restart neither loses the result nor SIGPIPE-kills
// the child. monitorExecution() tails the log to stream live and finalizes the task off
// the .code file — the same path used to reconnect after a restart. (taskId, optional pid
// when reconnecting to an already-running orphan.)
// `lane` : 'exec' (slot global, fichier PID unique), 'question' (voie parallèle
// lecture seule, un fichier PID par tâche — voir QPID_FILE) ou 'recover'
// (récupération d'une exécution orpheline dont le slot est déjà tenu par une AUTRE
// tâche : on lit ses artefacts et on écrit son résultat, sans toucher au slot ni au
// fichier PID, qui appartiennent à l'exécution en cours).
export function monitorExecution(taskId, knownPid = null, { lane = 'exec' } = {}) {
  const LOG = EXEC_LOG(taskId)
  const CODE = EXEC_CODE(taskId)
  const pidFile = lane === 'question' ? QPID_FILE(taskId) : (lane === 'recover' ? null : PID_FILE)
  const startedAt = Date.now()
  let offset = 0
  let lineBuffer = ''
  let finished = false

  function drainLog() {
    try {
      if (!existsSync(LOG)) return
      const buf = readFileSync(LOG)
      if (buf.length <= offset) return
      const chunk = buf.slice(offset).toString('utf8')
      offset = buf.length
      lineBuffer += chunk
      const parts = lineBuffer.split('\n')
      lineBuffer = parts.pop()
      for (const line of parts) streamLine(taskId, line)
    } catch {}
  }

  function finalize({ killedTimeout = false } = {}) {
    if (finished) return
    finished = true
    clearInterval(poll)
    drainLog()

    let code = null
    try { if (existsSync(CODE)) code = parseInt(readFileSync(CODE, 'utf8').trim(), 10) } catch {}
    let raw = ''
    try { if (existsSync(LOG)) raw = readFileSync(LOG, 'utf8') } catch {}
    const text = extractAssistantText(raw)
    const sessionId = extractSessionId(raw)

    let status, agent_result
    if (killedTimeout) {
      status = 'blocked'
      agent_result = `(interrompu: dépassement du délai de ${Math.round(EXEC_TIMEOUT_MS / 60000)} min)\n\n${text}`
    } else if (code === 0) {
      status = 'done'
      agent_result = text || '(terminé sans rapport)'
    } else if (code === null) {
      status = 'blocked'
      agent_result = (text ? text + '\n\n' : '') + '(process interrompu sans code de sortie — relancer manuellement si besoin)'
    } else {
      status = 'blocked'
      agent_result = (text ? text + '\n\n' : '') + `(exit code: ${code})`
    }

    // Quota Claude épuisé : la tâche n'a pas échoué, elle n'a pas pu travailler. On la
    // remet en file, on met l'ordonnanceur en pause jusqu'à la réinitialisation, et on
    // n'écrit NI compte-rendu trompeur NI message d'erreur.
    const limit = detectRateLimitEvent(raw) || detectSessionLimit(agent_result)
    if (limit) {
      // Attribution asynchrone (quotas de l'abonnement) → repli sur un autre modèle ou
      // report. Le slot reste tenu le temps de trancher, puis cleanup() le libère.
      handleLimitHit(taskId, limit, sessionId).catch(e => {
        console.error('🤖 Agent: traitement du quota en échec —', e.message)
      }).finally(cleanup)
      return
    }

    // Question à l'humain : détachée AVANT le résumé. La section question vient après
    // celle du résumé dans le rapport ; l'extraction du résumé prenant tout jusqu'à la
    // fin, la laisser en place la collerait dans le compte-rendu au lieu de la poser
    // comme question à répondre.
    let pending_question = null
    {
      const cut = extractPendingQuestion(agent_result)
      agent_result = cut.text
      pending_question = cut.question
    }

    // Résumé vulgarisé : section finale demandée par le prompt d'exécution, affichée
    // en clair sur la fiche de la suggestion (le rapport technique reste en dépli).
    let user_summary = null
    const summaryIdx = agent_result.lastIndexOf(SUMMARY_SECTION_MARKER)
    if (summaryIdx !== -1) {
      user_summary = agent_result.slice(summaryIdx + SUMMARY_SECTION_MARKER.length).trim() || null
      agent_result = agent_result.slice(0, summaryIdx).trim()
    } else {
      // Section absente du récit concaténé : on la cherche dans le message final du
      // stream (événement `result`), qui la porte quand les événements `assistant`
      // ne l'ont pas véhiculée. Évite un compte-rendu « manquant » alors que le
      // modèle l'avait bien écrit.
      const cutResult = extractPendingQuestion(extractResultText(raw))
      const resultText = cutResult.text
      if (!pending_question) pending_question = cutResult.question
      const i = resultText.lastIndexOf(SUMMARY_SECTION_MARKER)
      if (i !== -1) {
        user_summary = resultText.slice(i + SUMMARY_SECTION_MARKER.length).trim() || null
        const head = resultText.slice(0, i).trim()
        if (head && !agent_result.includes(head)) {
          agent_result = agent_result === '(terminé sans rapport)' ? head : `${agent_result}\n\n${head}`
        }
      }
    }

    // Message de steering jamais consommé (envoyé dans les toutes dernières secondes,
    // ou pendant une exécution morte) : Claude ne l'a pas vu. On le pose sur la tâche
    // pour que la file de travaux relance immédiatement avec ce complément.
    let missed_user_message = null
    try {
      if (existsSync(EXEC_INBOX(taskId))) {
        missed_user_message = readFileSync(EXEC_INBOX(taskId), 'utf8')
          .split('\n').filter(l => l.trim())
          .map(l => { try { return String(JSON.parse(l).text || '').trim() } catch { return l.trim() } })
          .filter(Boolean).join('\n') || null
      }
    } catch {}

    const finalTask = updateTask(taskId, {
      status, agent_result, user_summary,
      pending_question,
      missed_user_message,
      session_id: sessionId || null,
      completed_at: new Date().toISOString(),
    })
    if (finalTask) broadcastTask(finalTask)

    // File de prompts : l'item passe à done/blocked, le recap part dans le DM Slack
    // et l'item suivant est mis en route. Import dynamique — promptQueue crée des
    // tâches via ce module, l'import statique serait circulaire.
    if (finalTask) {
      setImmediate(() => {
        import('./promptQueue.js')
          .then(m => m.onAgentTaskFinalized(finalTask))
          .catch(e => console.error('🤖 File de prompts: suite impossible —', e.message))
      })
    }

    // Section résumé absente du rapport (modèle qui a oublié la consigne) →
    // compte-rendu de secours généré a posteriori, hors slot (sans outils).
    if (!user_summary) setImmediate(() => generateUserSummary(taskId).catch(() => {}))

    cleanup()
  }

  // Artefacts de l'exécution + libération du slot. Partagé par les deux sorties de
  // finalize (tâche terminée, ou reportée pour quota épuisé).
  function cleanup() {
    try { unlinkSync(LOG) } catch {}
    try { unlinkSync(CODE) } catch {}
    try { unlinkSync(EXEC_PROMPT(taskId)) } catch {}
    try { unlinkSync(EXEC_INBOX(taskId)) } catch {}
    // Le fichier PID de la voie exec est PARTAGÉ : on ne le supprime que s'il porte
    // encore CETTE tâche. Sinon on effacerait le suivi d'une exécution qui vient de
    // démarrer (ou, pour un lane 'recover', de celle qui tourne vraiment) — et le
    // prochain redémarrage déclarerait « bloquée » une tâche parfaitement vivante.
    if (pidFile && pidFileTaskId(pidFile) === taskId) { try { unlinkSync(pidFile) } catch {} }
    setTimeout(() => streamBuffers.delete(taskId), 120_000).unref?.()
    if (lane === 'recover') {
      // Récupération hors slot : rien à libérer, rien à relancer ici.
    } else if (lane === 'question') {
      // Voie parallèle : rien à libérer côté slot global, on rend juste sa place
      // dans la voie lecture seule et on regarde s'il y a une autre question.
      _questionRuns.delete(taskId)
      setImmediate(kick)
    } else {
      releaseSlot()
    }
  }

  function currentPid() {
    if (knownPid) return knownPid
    if (!pidFile) return null
    // Le fichier PID de la voie exec peut avoir été réécrit par une autre tâche :
    // ne lire son PID que s'il porte bien celle qu'on suit.
    try {
      const [pidStr, id] = readFileSync(pidFile, 'utf8').trim().split('\n')
      if (id && id !== taskId) return null
      return parseInt(pidStr, 10)
    } catch { return null }
  }

  const poll = setInterval(() => {
    drainLog()
    // Primary signal: the wrapper wrote the exit code → done/blocked by code.
    if (existsSync(CODE)) { finalize(); return }
    // Hard timeout: kill the whole detached group, mark blocked.
    if (Date.now() - startedAt > EXEC_TIMEOUT_MS) {
      const pid = currentPid()
      if (pid) { try { process.kill(-pid, 'SIGKILL') } catch {} }
      finalize({ killedTimeout: true })
      return
    }
    // Process vanished without a code file (crash / SIGKILL) — give the FS a beat to
    // flush a possible last-moment .code, then finalize as blocked.
    const pid = currentPid()
    if (pid && !isProcessAlive(pid) && Date.now() - startedAt > 6000) {
      drainLog()
      finalize() // code stays null unless a .code appeared → blocked
    }
  }, 2000)

  drainLog()
}

function runDetachedExecution(taskId, prompt, {
  model = null, effort = null, tools = EXEC_TOOLS, resumeSessionId = null, lane = 'exec',
} = {}) {
  const LOG = EXEC_LOG(taskId)
  const CODE = EXEC_CODE(taskId)
  const PROMPT = EXEC_PROMPT(taskId)

  // Clear any stale artifacts from a previous run of the same id.
  for (const f of [LOG, CODE, EXEC_INBOX(taskId)]) { try { if (existsSync(f)) unlinkSync(f) } catch {} }
  writeFileSync(PROMPT, prompt, 'utf8')

  const { CLAUDECODE: _c, CLAUDE_CODE_ENTRYPOINT: _e, ...cleanEnv } = process.env
  // Modèle/effort issus du préréglage choisi par l'utilisateur à la soumission.
  const modelFlags = (model ? ` --model "${model}"` : '') + (effort ? ` --effort "${effort}"` : '')
  // --resume : l'item de file marqué « même contexte » poursuit la session Claude de
  // l'item précédent au lieu de repartir à zéro. Une session introuvable (purgée,
  // machine redémarrée) fait échouer le démarrage → l'item repart proprement d'un
  // contexte neuf, voir le repli dans promptQueue.startPrompt().
  const resumeFlag = resumeSessionId ? ` --resume "${resumeSessionId}"` : ''
  // Voie question : fichier PID par tâche ; voie exec : le fichier PID unique, celui
  // que deploy.sh consulte pour attendre la fin d'une exécution.
  const pidFile = lane === 'question' ? QPID_FILE(taskId) : PID_FILE

  // ⚠️ `setsid --fork` n'est PAS cosmétique : pm2 tourne en `treekill: true` (défaut) et
  // tue TOUT le sous-arbre du serveur à chaque `pm2 restart erp-server`. Sans la coupure
  // de lignée, chaque exécution mourait au premier redémarrage — y compris celui que
  // l'agent lance lui-même après une modif serveur (CLAUDE.md l'exige), donc il se
  // décapitait au moment de valider son propre travail : rapport tronqué à la première
  // phrase, et compte-rendu inventé par-dessus. setsid meurt aussitôt, le wrapper est
  // réadopté par init (ppid 1) et devient invisible pour treekill.
  //
  // Corollaire : le pid renvoyé par spawn() est celui de setsid, éphémère et inutile.
  // C'est donc le wrapper qui écrit SON pid dans le fichier PID, dès sa première ligne.
  // claude reads the prompt from stdin (PROMPT file); stream-json → LOG; exit code → CODE.
  // --settings : branche le hook de steering (voir EXEC_INBOX) sur CETTE exécution.
  // Le hook est inerte sans ERP_AGENT_TASK_ID, donc sans effet ailleurs.
  const cmd = `printf '%s\\n%s\\n' "$$" "${taskId}" > "${pidFile}"; ` +
    `"${CLAUDE_BIN}" -p --output-format stream-json --verbose${modelFlags}${resumeFlag} ` +
    `--settings "${STEER_SETTINGS}" ` +
    `--allowedTools "${tools}" < "${PROMPT}" > "${LOG}" 2>&1; echo $? > "${CODE}"`

  const proc = spawn('setsid', ['--fork', 'bash', '-c', cmd], {
    cwd: CWD,
    env: { ...cleanEnv, HOME: '/home/ec2-user', ERP_AGENT_RUN: '1', ERP_AGENT_TASK_ID: taskId },
    detached: true,
    stdio: 'ignore', // nobody reads the child's stdout → restart can't SIGPIPE it
  })
  proc.unref()

  // knownPid volontairement absent : le vrai pid arrive par le fichier, quelques
  // millisecondes plus tard (currentPid() le relit à chaque tour de poll).
  monitorExecution(taskId, null, { lane })
}

// ─── Execution ────────────────────────────────────────────────────────────────
// lane 'exec' : read-write, prend le slot global (une seule à la fois).
// lane 'question' : lecture seule, hors slot, jusqu'à MAX_PARALLEL_QUESTIONS.
function executeTask(next, { lane = 'exec' } = {}) {
  if (lane === 'question') {
    _questionRuns.add(next.id)
  } else {
    busy = true
    currentTaskId = next.id
    currentActivity = 'execution'
  }

  // Modèle réellement utilisable : le modèle souhaité s'il a du quota, sinon son repli
  // (fable → opus). `run_model` garde la trace de ce qui a VRAIMENT tourné — c'est lui
  // qu'on attribue si l'exécution se heurte à un plafond.
  const wanted = next.model || preferredAgentModel()
  const runModel = resolveModel(wanted) || wanted
  if (runModel !== wanted) {
    console.log(`🤖 Agent: tâche ${next.id} lancée sur ${runModel} (quota ${wanted} épuisé)`)
  }

  // started_at : horodate le passage en in_progress pour alimenter le compteur de
  // temps écoulé côté UI (timer live pendant l'exécution, durée totale une fois terminée).
  const task = updateTask(next.id, {
    status: 'in_progress', started_at: new Date().toISOString(), run_model: runModel,
  })
  broadcastTask(task)

  const internalSecret = AGENT_INTERNAL_SECRET || ''
  // Question : l'utilisateur veut une réponse, pas un correctif — prompt lecture
  // seule dédié (questionPrompt) + outils read-only, la réponse part dans la
  // section résumé (compte-rendu de la carte).
  const isQuestion = next.mode === 'question'

  let brief
  if (next.kind === 'suggestion') {
    // Suggestion utilisateur (bulle d'aide) : signalement + correctif instantané approuvé.
    const item = readBacklog().find(i => i.id === next.backlog_id)
    brief = [
      `${isQuestion ? 'Question' : 'Signalement'} utilisateur${next.author ? ` (par ${next.author})` : ''}${next.context ? ` depuis la page ${next.context}` : ''}:\n${next.description}`,
      !isQuestion && item?.instant_proposal ? `\n\nCorrectif proposé et APPROUVÉ par l'utilisateur (implémente dans cet esprit):\n${item.instant_proposal}` : '',
      next.user_comment ? `\n\nCommentaire de l'utilisateur à l'approbation: ${next.user_comment}` : '',
    ].join('')
  } else if (next.kind === 'proposal') {
    const thread = (next.messages || [])
      .map(m => `${m.role === 'user' ? 'Humain' : 'Agent'}: ${m.text}`)
      .join('\n')
    brief = [
      `Titre: ${next.title || next.description}`,
      next.why ? `\nPourquoi: ${next.why}` : '',
      next.zone ? `\nZone visée: ${next.zone}` : '',
      next.user_comment ? `\nCommentaire humain: ${next.user_comment}` : '',
      thread ? `\n\nFil de discussion (raffinements convenus):\n${thread}` : '',
    ].join('')
  } else {
    brief = `Description:\n${next.description}${next.user_comment ? `\n\nCommentaire humain: ${next.user_comment}` : ''}`
  }

  let prompt = renderTemplate(promptTemplate(isQuestion ? 'questionPrompt' : 'executionPrompt'), {
    general: generalPrompt(),
    brief,
    internalSecret,
  })
  // Filet : un prompt personnalisé qui omet la section résumé priverait les cartes
  // terminées de leur compte-rendu (ou de la réponse) — on ré-injecte la consigne.
  if (!prompt.includes(SUMMARY_SECTION_MARKER)) {
    prompt += '\n\n' + (isQuestion ? QUESTION_SUMMARY_INSTRUCTION : SUMMARY_SECTION_INSTRUCTION)
  }
  // Droit de poser une question — réservé aux items de la file de travaux : ce sont
  // les seuls dont la carte sait afficher la question et récolter la réponse. Une
  // tâche de la bulle d'aide qui la poserait parlerait dans le vide.
  if (next.work_prompt_id) prompt += ASK_USER_INSTRUCTION

  // Detached + durable: the result is recorded off a .code file, so a `pm2 restart`
  // triggered by the implementation itself can't lose the success and leave the task
  // wrongly "blocked". monitorExecution() handles streaming + finalization.
  // Question → outils lecture seule : l'agent ne peut physiquement rien implémenter.
  runDetachedExecution(next.id, prompt, {
    model: runModel, effort: next.effort,
    tools: isQuestion ? READONLY_TOOLS : EXEC_TOOLS,
    resumeSessionId: next.resume_session_id || null,
    lane,
  })
}

// ─── Création d'une tâche prête à exécuter (file de prompts) ───────────────────
// La file de travaux passe par ici plutôt que d'écrire dans agent-tasks.json
// elle-même : l'ordonnanceur, la diffusion temps réel et le format de tâche
// restent la propriété de ce module.
export function enqueueAgentTask({
  title, description, kind = 'queue', mode = 'implement', model = preferredAgentModel(),
  effort = 'high', priority = 0, author = '', work_prompt_id = null,
  resume_session_id = null,
}) {
  const now = new Date().toISOString()
  const task = {
    id: randomUUID(),
    kind,
    mode: mode === 'question' ? 'question' : 'implement',
    title: title || (description || '').slice(0, 140),
    description: description || '',
    context: '',
    author,
    model, effort,
    status: 'approved',
    priority,
    messages: [],
    user_comment: null,
    agent_result: null,
    user_summary: null,
    work_prompt_id,
    resume_session_id,
    created_at: now,
    updated_at: now,
    started_at: null,
    completed_at: null,
  }
  const tasks = readTasks()
  tasks.push(task)
  writeTasks(tasks)
  broadcastTask(task)
  setImmediate(kick)
  return task
}

export function findAgentTask(id) { return readTasks().find(t => t.id === id) || null }

/**
 * Retouche d'une tâche remise à l'ordonnanceur mais PAS ENCORE démarrée : c'est ce
 * qui rend le prompt d'un item « en attente » réellement modifiable. Refuse dès que
 * la tâche a quitté l'état « approved » — une exécution lancée lit son prompt une
 * fois pour toutes, la retoucher donnerait une carte qui ment.
 *
 * Pas de course possible : executeTask() passe la tâche à `in_progress` de façon
 * synchrone AVANT de lancer le process, donc `status === 'approved'` garantit ici
 * qu'aucun Claude ne tourne pour elle.
 */
export function updatePendingAgentTask(id, patch = {}) {
  if (!id) return false
  const task = readTasks().find(t => t.id === id)
  if (!task || task.status !== 'approved') return false
  const allowed = ['title', 'description', 'model', 'effort', 'mode']
  const updates = {}
  for (const k of allowed) if (patch[k] !== undefined) updates[k] = patch[k]
  if (!Object.keys(updates).length) return true
  const updated = updateTask(id, updates)
  if (updated) broadcastTask(updated)
  return true
}

/**
 * Reprise d'une tâche jamais démarrée : la file de travaux la retire de
 * l'ordonnanceur pour redonner la main à l'utilisateur (réordonner, mettre de côté,
 * supprimer). Même garantie que ci-dessus : refuse si l'exécution a commencé.
 */
export function cancelPendingAgentTask(id) {
  if (!id) return false
  const task = readTasks().find(t => t.id === id)
  if (!task || task.status !== 'approved') return false
  const updated = updateTask(id, {
    status: 'cancelled',
    completed_at: new Date().toISOString(),
    agent_result: '(reprise dans la file avant tout démarrage)',
  })
  if (updated) broadcastTask(updated)
  return true
}

// ─── Conversation reply (read-only) ───────────────────────────────────────────
function conversationReply(task) {
  busy = true
  currentTaskId = task.id
  currentActivity = 'conversation'

  const thread = (task.messages || [])
    .map(m => `${m.role === 'user' ? 'Humain' : 'Agent'}: ${m.text}`)
    .join('\n')

  const prompt = renderTemplate(promptTemplate('conversationPrompt'), {
    general: generalPrompt(),
    proposal: task.title || task.description,
    why: task.why ? `Pourquoi: ${task.why}\n` : '',
    zone: task.zone ? `Zone visée: ${task.zone}\n` : '',
    thread,
  })

  spawnClaude({ prompt, allowedTools: READONLY_TOOLS, timeoutMs: READONLY_TIMEOUT_MS })
    .then(({ text }) => {
      const reply = (text || '').trim() || '(pas de réponse)'
      const fresh = readTasks().find(t => t.id === task.id)
      if (fresh) {
        const messages = [...(fresh.messages || []), { role: 'agent', text: reply, at: new Date().toISOString() }]
        const updated = updateTask(task.id, { messages, status: fresh.status === 'pending' ? 'in_discussion' : fresh.status })
        if (updated) broadcastTask(updated)
      }
      releaseSlot()
    })
}

// ─── Orphan / lifecycle (preserved from the original runner) ──────────────────
function isProcessAlive(pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** Tâche inscrite dans un fichier PID (2e ligne), ou null. */
function pidFileTaskId(file) {
  try { return readFileSync(file, 'utf8').trim().split('\n')[1] || null } catch { return null }
}

/**
 * PID du wrapper d'une exécution, retrouvé dans la table des process — sans passer par
 * `.agent-pid`. Ce fichier est unique pour toute la voie exec : il peut avoir été
 * écrasé (démarrage d'une autre tâche) ou supprimé (suite de tests serveur, qui s'en
 * sert comme fixture) alors que le wrapper tourne toujours. Se fier à lui seul faisait
 * déclarer « bloquée » au démarrage suivant une exécution parfaitement vivante — et,
 * pire, libérait le slot : une seconde implémentation démarrait par-dessus la première,
 * dans le même arbre de travail.
 */
function livePidForTask(taskId) {
  let fallback = null
  for (const d of (() => { try { return readdirSync('/proc') } catch { return [] } })()) {
    if (!/^\d+$/.test(d)) continue
    let cmd = ''
    try { cmd = readFileSync(`/proc/${d}/cmdline`, 'utf8') } catch { continue }
    if (!cmd.includes(`.agent-exec-${taskId}`)) continue
    // Le wrapper bash (celui qui écrit le .code) fait foi ; le claude fils sert de repli.
    if (cmd.includes('printf')) return parseInt(d, 10)
    fallback = parseInt(d, 10)
  }
  return fallback
}

export function initTaskRunner() {
  // Reconnect to an orphaned execution Claude from a previous server instance.
  // monitorExecution() finalizes off the durable .code file, so an exec that finished
  // successfully WHILE the server was restarting (e.g. it ran `pm2 restart erp-server`
  // itself) is correctly marked DONE — not blocked. If the child already finished, the
  // first poll detects the .code file immediately; if it's still running, we tail it; if
  // it crashed without a .code file, it's marked blocked.
  // Les tâches dont on a repris le suivi ne doivent PAS être marquées bloquées
  // plus bas — elles tournent encore (ou viennent de finir, le .code fait foi).
  const reconnected = new Set()

  if (existsSync(PID_FILE)) {
    try {
      const [pidStr, taskId] = readFileSync(PID_FILE, 'utf8').trim().split('\n')
      const pid = parseInt(pidStr, 10)
      const t = taskId && readTasks().find(x => x.id === taskId)
      if (t && t.status === 'in_progress') {
        console.log(`🤖 Agent: exécution orpheline détectée (PID ${pid}, tâche ${taskId}) — reprise du suivi…`)
        busy = true
        currentTaskId = taskId
        currentActivity = 'execution'
        reconnected.add(taskId)
        monitorExecution(taskId, pid || null)
      }
    } catch {}
    if (!reconnected.size) {
      // Stale PID file (task already finalized / gone) → clean up its artifacts.
      try {
        const taskId = readFileSync(PID_FILE, 'utf8').trim().split('\n')[1]
        if (taskId) { for (const f of [EXEC_LOG(taskId), EXEC_CODE(taskId), EXEC_PROMPT(taskId), EXEC_INBOX(taskId)]) { try { unlinkSync(f) } catch {} } }
      } catch {}
      try { unlinkSync(PID_FILE) } catch {}
    }
  }

  // Même reprise pour la voie lecture seule, mais un fichier PID par tâche : une
  // question orpheline se rattache indépendamment de l'implémentation en cours.
  for (const f of (() => { try { return readdirSync(DATA_DIR) } catch { return [] } })()) {
    const m = f.match(/^\.agent-qpid-(.+)$/)
    if (!m) continue
    const taskId = m[1]
    const full = resolve(DATA_DIR, f)
    let pid = null
    try { pid = parseInt(readFileSync(full, 'utf8').trim().split('\n')[0], 10) } catch {}
    const t = readTasks().find(x => x.id === taskId)
    if (t && t.status === 'in_progress') {
      console.log(`🤖 Agent: question orpheline détectée (PID ${pid}, tâche ${taskId}) — reprise du suivi…`)
      _questionRuns.add(taskId)
      reconnected.add(taskId)
      monitorExecution(taskId, pid || null, { lane: 'question' })
    } else {
      try { unlinkSync(full) } catch {}
      for (const g of [EXEC_LOG(taskId), EXEC_CODE(taskId), EXEC_PROMPT(taskId), EXEC_INBOX(taskId)]) { try { unlinkSync(g) } catch {} }
    }
  }

  // Reprise SANS fichier PID : le .agent-pid a pu être écrasé/supprimé pendant
  // l'exécution. Avant de déclarer quoi que ce soit bloqué, on cherche les preuves
  // durables — le .code écrit par le wrapper, ou le wrapper lui-même dans la table
  // des process. Une exécution vivante garde le slot ; une exécution déjà finie est
  // finalisée sur son code de sortie (donc « terminée » si elle a réussi).
  for (const t of readTasks()) {
    if (t.status !== 'in_progress' || reconnected.has(t.id)) continue
    const pid = livePidForTask(t.id)
    if (!pid && !existsSync(EXEC_CODE(t.id))) continue
    reconnected.add(t.id)
    if (!busy) {
      console.log(`🤖 Agent: exécution ${pid ? 'vivante' : 'terminée'} retrouvée sans fichier PID (tâche ${t.id}) — reprise du suivi…`)
      busy = true
      currentTaskId = t.id
      currentActivity = 'execution'
      monitorExecution(t.id, pid || null)
    } else {
      // Le slot est déjà tenu par une autre exécution : on récupère seulement le
      // résultat de celle-ci, sans toucher au slot ni au fichier PID.
      console.log(`🤖 Agent: résultat récupéré hors slot pour la tâche ${t.id}`)
      monitorExecution(t.id, pid || null, { lane: 'recover' })
    }
  }

  // Exécution déclarée bloquée par un démarrage précédent alors que son wrapper avait
  // fini proprement : ses artefacts sont encore là, le vrai résultat est récupérable.
  for (const t of readTasks()) {
    if (t.status !== 'blocked' || reconnected.has(t.id)) continue
    if (!existsSync(EXEC_CODE(t.id)) || !existsSync(EXEC_LOG(t.id))) continue
    if (livePidForTask(t.id)) continue
    console.log(`🤖 Agent: tâche ${t.id} déclarée bloquée à tort — résultat récupéré depuis ses artefacts`)
    reconnected.add(t.id)
    monitorExecution(t.id, null, { lane: 'recover' })
  }

  // An execution interrupted by a server restart is marked BLOCKED (needs a human),
  // never silently re-approved. Re-approving created a runaway: an execution that
  // ran `pm2 restart erp-server` would be re-queued on every boot and loop forever.
  const tasks = readTasks()
  let changed = false
  for (const t of tasks) {
    if (t.status === 'in_progress' && !reconnected.has(t.id)) {
      t.status = 'blocked'
      t.agent_result = (t.agent_result ? t.agent_result + '\n' : '') +
        '(exécution interrompue par un redémarrage serveur — relancer manuellement si besoin)'
      t.updated_at = new Date().toISOString()
      changed = true
    }
  }
  if (changed) writeTasks(tasks)

  // Rattrapage différé des compte-rendus manquants sur les cartes déjà terminées
  // (laisse le serveur finir de démarrer avant de spawner des subprocess).
  const backfillTimer = setTimeout(() => { backfillUserSummaries().catch(() => {}) }, 15_000)
  backfillTimer.unref?.()

  // Quota hebdomadaire propre au modèle (fable) : lu directement dans les quotas de
  // l'abonnement pour basculer sur le repli AVANT de jeter une exécution dans le mur —
  // et pour revenir à fable dès que son plafond est réinitialisé. Toutes les 5 min ;
  // la lecture est mise en cache 60 s côté claudeUsage, donc le coût est négligeable.
  const syncLimits = () => syncScopedModelLimit()
    .then(changed => { if (changed) { rearmLimitTimer(); kick() } })
    .catch(() => {})
  setTimeout(syncLimits, 5_000).unref?.()
  setInterval(syncLimits, 5 * 60_000).unref?.()

  setImmediate(kick)
}

export function shutdownTaskRunner() {
  // Execution Claude is detached and finishes as an orphan; PID file persists for reconnect.
}
```


---

## `server/src/services/workSuggestions.js`

Moteurs de suggestions de l'agent (chantiers, intégrations) + discussion d'une suggestion.

```js
// Moteur de recommandations (page /travaux, onglet « Suggestions de Claude »).
//
// Liste SÉPARÉE de la file humaine : l'agent y dépose des prompts qu'il juge
// pertinents, l'utilisateur les promeut (ou les rejette) — rien ne s'exécute sans
// promotion. Le signal le plus fort vient des travaux récurrents encore faits à la
// main : chaque ligne cochée chaque semaine est un candidat à l'automatisation.
//
// Le modèle n'explore PAS le repo : le contexte lui est fourni ici (git log,
// travaux récurrents, file récente, erreurs de sync). Il tourne donc sans outils,
// en parallèle d'une exécution, sans jamais lire un fichier à moitié écrit.
import { randomUUID, createHash } from 'crypto'
import { execFileSync } from 'child_process'
import { readdirSync } from 'fs'
import db from '../db/database.js'
import { broadcastAll } from './realtime.js'
import { runToollessClaude } from './taskRunner.js'
import { preferredAgentModel } from './agentModel.js'
import { createPrompt } from './promptQueue.js'
import { listRecurringTasks } from './recurringWork.js'

const REPO = '/home/ec2-user/erp'
const MAX_NEW_PER_RUN = 5
const MAX_NEW_INTEGRATIONS_PER_RUN = 3

// Deux natures de suggestions dans la même liste :
//   'chantier'    — un travail à faire dans l'ERP tel qu'il est aujourd'hui ;
//   'integration' — un logiciel / une API externe à brancher, et ce que ça
//                   débloquerait une fois branché.
export const SUGGESTION_KINDS = ['chantier', 'integration']

export function normalizeKind(kind) {
  return SUGGESTION_KINDS.includes(kind) ? kind : 'chantier'
}

// Domaines métier fermés — sert à ranger les suggestions en sous-sections dans
// l'onglet (page /travaux). Le modèle répond en texte libre malgré la consigne
// du prompt (variantes d'accents/casse/synonymes) : on normalise systématiquement
// à l'insertion pour que le regroupement front reste stable. Garder en phase avec
// AREA_LABELS de client/src/pages/Travaux.jsx (même liste, dupliquée côté front).
export const SUGGESTION_AREAS = ['ventes', 'logistique', 'comptabilite', 'rh', 'marketing', 'technique', 'support']

const AREA_KEYWORDS = [
  [/vente|client|pipeline|contact|entreprise|soumission|projet/, 'ventes'],
  [/logistiq|envoi|livraison|transport|retour|expedition|inventaire|entrepot/, 'logistique'],
  [/comptab|finance|facture|paie(?!ment)|tresorerie|banque|taxe|qb|quickbooks/, 'comptabilite'],
  [/\brh\b|ressources humaines|employe|conge|banque d.heures|feuille de temps/, 'rh'],
  [/marketing|campagne|publicite|reseaux sociaux|budget marketing/, 'marketing'],
  [/support|billet|ticket|service client|assistance/, 'support'],
]

/** Fait retomber le texte libre du modèle sur un des SUGGESTION_AREAS ; défaut 'technique'. */
export function normalizeArea(raw) {
  const norm = String(raw || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().trim()
  if (SUGGESTION_AREAS.includes(norm)) return norm
  for (const [re, area] of AREA_KEYWORDS) {
    if (re.test(norm)) return area
  }
  return 'technique'
}

function broadcast() { broadcastAll({ type: 'travaux:suggestions:updated' }) }

// Empreinte de déduplication : titre normalisé (accents, ponctuation et casse
// écartés). Une reformulation cosmétique de la même idée ne revient donc pas.
export function fingerprintOf(title) {
  const norm = String(title || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  return createHash('sha1').update(norm).digest('hex')
}

export function listSuggestions({ status = null, kind = null } = {}) {
  const where = ['s.deleted_at IS NULL']
  const params = []
  if (status) { where.push('s.status=?'); params.push(status) }
  if (kind) { where.push('s.kind=?'); params.push(kind) }
  // Une suggestion promue vit désormais dans la file (elle y porte sa pastille
  // « Claude ») : on joint quand même l'état de l'item promu, c'est ce qui permet
  // à un appel `status=accepted` de savoir ce qu'elle est devenue.
  // `message_count` : le fil de discussion n'est pas chargé ici (il ne l'est qu'à
  // l'ouverture de la carte), mais la pastille doit pouvoir l'annoncer.
  return db.prepare(`
    SELECT s.*, p.status AS prompt_status, p.space AS prompt_space,
      (SELECT COUNT(*) FROM work_suggestion_messages m
        WHERE m.suggestion_id = s.id AND m.deleted_at IS NULL) AS message_count
    FROM work_suggestions s
    LEFT JOIN work_prompts p ON p.id = s.work_prompt_id AND p.deleted_at IS NULL
    WHERE ${where.join(' AND ')} ORDER BY s.created_at DESC
  `).all(...params).map(s => ({ ...s, chat_pending: _answering.has(s.id) }))
}

export function getSuggestion(id) {
  return db.prepare('SELECT * FROM work_suggestions WHERE id=? AND deleted_at IS NULL').get(id)
}

/** Insère une suggestion ; retourne null si l'empreinte existe déjà (doublon). */
export function addSuggestion({ title, rationale = null, prompt, area = null, kind = 'chantier' }) {
  const t = String(title || '').trim()
  const p = String(prompt || '').trim()
  if (!t || !p) return null
  const fp = fingerprintOf(t)
  const exists = db.prepare('SELECT id FROM work_suggestions WHERE fingerprint=?').get(fp)
  if (exists) return null
  const id = randomUUID()
  db.prepare(`
    INSERT INTO work_suggestions (id, title, rationale, prompt, area, kind, fingerprint)
    VALUES (?,?,?,?,?,?,?)
  `).run(id, t, rationale, p, normalizeArea(area), normalizeKind(kind), fp)
  broadcast()
  return db.prepare('SELECT * FROM work_suggestions WHERE id=?').get(id)
}

/** Promeut une suggestion dans la file de prompts de l'utilisateur. */
export function acceptSuggestion(id, { userId = null, overridePrompt = null, space = 'finance', priority = false } = {}) {
  const s = db.prepare('SELECT * FROM work_suggestions WHERE id=? AND deleted_at IS NULL').get(id)
  if (!s) return null
  if (s.status === 'accepted' && s.work_prompt_id) return { suggestion: s, prompt_id: s.work_prompt_id }
  const created = createPrompt({
    title: s.title,
    prompt: String(overridePrompt || s.prompt),
    created_by: userId,
    suggestion_id: s.id,
    // La suggestion rejoint la file de la section d'où on l'accepte (finance/agent).
    space,
    // Même choix qu'un prompt saisi à la main : en tête ou à la suite.
    priority,
  })
  db.prepare(`UPDATE work_suggestions SET status='accepted', work_prompt_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
    .run(created.id, id)
  broadcast()
  return { suggestion: db.prepare('SELECT * FROM work_suggestions WHERE id=?').get(id), prompt_id: created.id }
}

export function dismissSuggestion(id, reason = null) {
  const s = db.prepare('SELECT id FROM work_suggestions WHERE id=? AND deleted_at IS NULL').get(id)
  if (!s) return null
  // Le rejet conserve la ligne (et donc l'empreinte) : la même idée ne sera pas
  // resuggérée au prochain passage du moteur.
  db.prepare(`UPDATE work_suggestions SET status='dismissed', dismissed_reason=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
    .run(reason, id)
  broadcast()
  return db.prepare('SELECT * FROM work_suggestions WHERE id=?').get(id)
}

export function deleteSuggestion(id) {
  db.prepare(`UPDATE work_suggestions SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(id)
  broadcast()
  return true
}

// ─── Discussion d'une suggestion ──────────────────────────────────────────────
//
// Avant de mettre une suggestion dans sa file (ou de la rejeter), on veut souvent
// en savoir plus : pourquoi maintenant, ce que ça change concrètement, ce que
// coûte l'outil externe d'une intégration, par quoi commencer. Le fil vit sur la
// carte, à côté de la suggestion — il n'exécute RIEN et ne touche pas à la file.
//
// L'échange passe par un appel Claude SANS OUTILS : il tourne donc en parallèle
// d'une implémentation en cours (hors slot global), au prix de ne pas explorer le
// repo — comme le moteur qui a produit la suggestion, il raisonne sur le contexte
// qu'on lui sert ici.

// Suggestions dont une réponse est en vol. Volontairement en mémoire : un
// redémarrage du serveur perd la réponse en cours, et l'utilisateur peut
// simplement reposer sa question au lieu d'attendre un fil bloqué à vie.
const _answering = new Set()

function broadcastChat(suggestionId) {
  broadcastAll({ type: 'travaux:suggestion:messages', suggestion_id: suggestionId })
}

export function listSuggestionMessages(id) {
  return db.prepare(`
    SELECT id, suggestion_id, role, text, author, created_at
    FROM work_suggestion_messages
    WHERE suggestion_id=? AND deleted_at IS NULL
    ORDER BY created_at, rowid
  `).all(id)
}

export function isAnswering(id) { return _answering.has(id) }

export function addSuggestionMessage(suggestionId, { role, text, author = null }) {
  const t = String(text || '').trim()
  if (!t) return null
  const id = randomUUID()
  db.prepare(`
    INSERT INTO work_suggestion_messages (id, suggestion_id, role, text, author)
    VALUES (?,?,?,?,?)
  `).run(id, suggestionId, role === 'agent' ? 'agent' : 'user', t, author)
  return db.prepare('SELECT * FROM work_suggestion_messages WHERE id=?').get(id)
}

/** Prompt de discussion — pur, pour rester testable sans appeler le modèle. */
export function buildSuggestionChatPrompt({ suggestion, thread, digest = '' }) {
  const isIntegration = suggestion.kind === 'integration'
  return [
    'Tu es l\'agent de l\'ERP Orisha (PME québécoise qui conçoit, fabrique et vend en direct des produits IoT ',
    'de contrôle climatique pour serres). Son ERP interne single-tenant couvre marketing, ventes, logistique, ',
    'assemblage, comptabilité, RH et dashboards.\n\n',
    isIntegration
      ? 'Tu as proposé de brancher un outil externe à cet ERP. L\'utilisateur veut en savoir plus AVANT de décider.\n\n'
      : 'Tu as proposé un chantier à faire dans cet ERP. L\'utilisateur veut en savoir plus AVANT de décider.\n\n',
    `Nature : ${isIntegration ? 'intégration (outil / API externe à brancher)' : 'chantier (travail dans l\'ERP tel qu\'il est)'}\n`,
    `Titre : ${suggestion.title}\n`,
    suggestion.area ? `Domaine : ${suggestion.area}\n` : '',
    suggestion.rationale ? `Pourquoi tu l'as proposée : ${suggestion.rationale}\n` : '',
    `\nPrompt d'implémentation prévu (ce qui serait donné à l'agent si l'utilisateur l'accepte) :\n${suggestion.prompt}\n\n`,
    digest ? `Contexte de l'ERP :\n${digest}\n\n` : '',
    'Discussion en cours (« Humain » = l\'utilisateur, « Toi » = tes réponses précédentes) :\n',
    thread || '(aucun échange)', '\n\n',
    'Réponds à la DERNIÈRE question de l\'humain, en français, sur un ton direct et concret. Règles :\n',
    '- Réponse courte : 2 à 6 phrases, ou une liste de puces courtes. Va au point.\n',
    '- Tu n\'as PAS lu le code ici : si la réponse dépend d\'un détail d\'implémentation que tu ne connais pas, dis-le franchement plutôt que d\'inventer.\n',
    '- Parle de ce que ça change pour Orisha (temps gagné, erreurs évitées, ce qui reste manuel), pas de généralités.\n',
    isIntegration ? '- Si on te demande le coût ou l\'authentification d\'un outil, donne ton meilleur ordre de grandeur en disant que c\'est à vérifier.\n' : '',
    '- Ne prétends jamais avoir implémenté quoi que ce soit : cette discussion ne modifie rien. Si l\'utilisateur veut avancer, il ajoute la suggestion à sa file.\n',
    '- Réponds uniquement par ton message, sans préambule ni signature.',
  ].join('')
}

function chatDigest(suggestion) {
  try {
    if (suggestion.kind === 'integration') {
      const d = buildIntegrationDigest()
      return [
        `Outils déjà branchés (OAuth) :\n${d.oauth || '(aucun)'}`,
        `Outils déjà branchés (clés d'API) :\n${d.envTools || '(aucun)'}`,
        `Pages de l'ERP :\n${d.pages || '(inconnu)'}`,
        `Travaux encore faits à la main :\n${d.recurring || '(aucun)'}`,
      ].join('\n\n')
    }
    const d = buildContextDigest()
    return [
      `Travaux encore faits à la main :\n${d.recurring || '(aucun)'}`,
      `Chantiers récents (commits) :\n${d.gitLog || '(aucun)'}`,
      d.syncErrors ? `Erreurs de synchronisation récentes :\n${d.syncErrors}` : '',
    ].filter(Boolean).join('\n\n')
  } catch { return '' }
}

/**
 * Question de l'utilisateur sur une suggestion : le message est enregistré tout de
 * suite (la carte l'affiche), la réponse arrive plus tard par diffusion temps réel.
 * Retourne { error } plutôt que de lever — les routes rendent une erreur uniforme.
 */
export function askSuggestion(id, { text, userId = null } = {}) {
  const s = getSuggestion(id)
  if (!s) return null
  const t = String(text || '').trim()
  if (!t) return { error: 'empty' }
  if (_answering.has(id)) return { error: 'busy' }

  addSuggestionMessage(id, { role: 'user', text: t, author: userId })
  _answering.add(id)
  broadcastChat(id)

  // Réponse en arrière-plan : la route a déjà rendu la main.
  ;(async () => {
    let reply = ''
    try {
      const thread = listSuggestionMessages(id)
        .map(m => `${m.role === 'user' ? 'Humain' : 'Toi'}: ${m.text}`)
        .join('\n')
      const { text: out } = await runToollessClaude({
        prompt: buildSuggestionChatPrompt({ suggestion: s, thread, digest: chatDigest(s) }),
        model: preferredAgentModel(),
        effort: 'medium',
        timeoutMs: 4 * 60_000,
      })
      reply = String(out || '').trim()
    } catch (e) {
      console.error('🤖 Discussion suggestion:', e.message)
    }
    // Toujours écrire un message, même en échec : sans ça le fil resterait en
    // « Claude réfléchit… » sans que l'utilisateur sache qu'il peut réessayer.
    addSuggestionMessage(id, {
      role: 'agent',
      text: reply || 'Je n\'ai pas réussi à répondre (appel au modèle en échec ou trop long). Repose ta question.',
    })
    _answering.delete(id)
    broadcastChat(id)
  })()

  return { messages: listSuggestionMessages(id), pending: true }
}

// ─── Contexte fourni au modèle ────────────────────────────────────────────────

function gitLog(n = 40) {
  try {
    return execFileSync('git', ['log', `-${n}`, '--pretty=format:%ad %s', '--date=short'], { cwd: REPO, encoding: 'utf8' })
  } catch { return '' }
}

export function buildContextDigest() {
  const recurring = listRecurringTasks()
    .map(t => `- [${t.cadence}${t.owner ? '/' + t.owner : ''}] ${t.label}${t.notes ? ` (${t.notes})` : ''}`)
    .join('\n')

  const recentPrompts = db.prepare(`
    SELECT title, status FROM work_prompts WHERE deleted_at IS NULL
    ORDER BY created_at DESC LIMIT 25
  `).all().map(p => `- (${p.status}) ${p.title}`).join('\n')

  const known = db.prepare(`
    SELECT title, status FROM work_suggestions WHERE deleted_at IS NULL
    ORDER BY created_at DESC LIMIT 60
  `).all().map(s => `- ${s.title}`).join('\n')

  let syncErrors = ''
  try {
    syncErrors = db.prepare(`
      SELECT module, error_message FROM sync_log
      WHERE status='error' AND created_at >= strftime('%Y-%m-%dT%H:%M:%fZ','now','-14 days')
      ORDER BY created_at DESC LIMIT 15
    `).all().map(r => `- ${r.module}: ${String(r.error_message || '').slice(0, 160)}`).join('\n')
  } catch {}

  return { recurring, recentPrompts, known, gitLog: gitLog(), syncErrors }
}

const SUGGESTION_PROMPT = ({ recurring, recentPrompts, known, gitLog: log, syncErrors }) => [
  'Tu observes l\'évolution de l\'ERP Orisha (app single-tenant : ventes, logistique, assemblage, comptabilité, RH). ',
  'Ton rôle ici est de RECOMMANDER des prochains chantiers, pas de coder.\n\n',
  'Signal le plus important — les travaux que l\'utilisateur fait ENCORE À LA MAIN chaque semaine/mois/trimestre :\n',
  recurring || '(aucun)', '\n\n',
  'Chantiers récents (commits) :\n', log || '(aucun)', '\n\n',
  'Prompts récents de l\'utilisateur (sa direction actuelle) :\n', recentPrompts || '(aucun)', '\n\n',
  syncErrors ? `Erreurs de synchronisation des 14 derniers jours :\n${syncErrors}\n\n` : '',
  'Suggestions DÉJÀ proposées (ne les répète pas, même reformulées) :\n', known || '(aucune)', '\n\n',
  `Propose au maximum ${MAX_NEW_PER_RUN} nouveaux chantiers, classés du plus utile au moins utile. `,
  'Privilégie : automatiser un travail manuel récurrent listé plus haut, fermer une boucle laissée ouverte par un chantier récent, ',
  'ou supprimer une source d\'erreur récurrente. Chaque suggestion doit être réalisable en une seule séance de travail. ',
  'Couvre autant de domaines différents que possible plutôt que d\'empiler plusieurs idées dans le même domaine — l\'utilisateur ',
  'consulte ces suggestions rangées par domaine et veut voir chaque section nourrie, pas une seule qui déborde.\n\n',
  'Réponds UNIQUEMENT par un tableau JSON, sans texte autour, de la forme :\n',
  `[{"title":"titre court","area":"${SUGGESTION_AREAS.join('|')}","rationale":"pourquoi maintenant, 1-2 phrases",`,
  '"prompt":"le prompt complet à donner à un agent qui implémentera le chantier, en français, précis sur le comportement attendu"}]\n',
  'Si tu n\'as rien de solide à proposer, réponds [].',
].join('')

/** Extrait le tableau JSON de la réponse, tolérant à un éventuel enrobage. */
export function parseSuggestionsJson(text) {
  const raw = String(text || '').trim()
  const candidates = []
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fenced) candidates.push(fenced[1])
  const bracket = raw.slice(raw.indexOf('['), raw.lastIndexOf(']') + 1)
  if (bracket) candidates.push(bracket)
  candidates.push(raw)
  for (const c of candidates) {
    try {
      const parsed = JSON.parse(c)
      if (Array.isArray(parsed)) return parsed
    } catch {}
  }
  return []
}

/**
 * Un passage du moteur : demande des recommandations et insère les nouvelles.
 * Idempotent par empreinte de titre — repasser deux fois n'empile pas de doublons.
 */
export async function generateSuggestions() {
  const digest = buildContextDigest()
  const { text } = await runToollessClaude({
    prompt: SUGGESTION_PROMPT(digest),
    model: preferredAgentModel(),
    effort: 'high',
    timeoutMs: 6 * 60_000,
  })
  const items = parseSuggestionsJson(text).slice(0, MAX_NEW_PER_RUN)
  let added = 0
  for (const it of items) {
    if (addSuggestion({ title: it.title, rationale: it.rationale, prompt: it.prompt, area: it.area })) added++
  }
  console.log(`🤖 Suggestions de travaux : ${items.length} proposée(s), ${added} nouvelle(s)`)
  return { proposed: items.length, added }
}

// ─── Second moteur : logiciels / API à brancher ───────────────────────────────
//
// Même liste, autre question : « qu'est-ce qu'on gagnerait à connecter un outil
// externe de plus ? ». Le modèle a besoin de savoir ce qui est DÉJÀ branché,
// sinon il repropose Stripe et QuickBooks — d'où l'inventaire ci-dessous, monté
// depuis les connexions OAuth réelles et les clés d'API présentes (jamais leur
// valeur, seulement leur présence).

// Vendeurs dont une clé en environnement vaut « déjà intégré ». Liste explicite :
// on n'énumère pas process.env à l'aveugle.
const ENV_VENDORS = [
  ['Stripe', 'STRIPE_SECRET_KEY'],
  ['QuickBooks', 'QB_CLIENT_ID'],
  ['Airtable', 'AIRTABLE_CLIENT_ID'],
  ['Google (Gmail/Drive/Sheets)', 'GOOGLE_CLIENT_ID'],
  ['HubSpot', 'HUBSPOT_CLIENT_ID'],
  ['Postmark (envoi de courriels)', 'POSTMARK_API_KEY'],
  ['OpenAI', 'OPENAI_API_KEY'],
  ['Novoxpress (transporteurs)', 'NOVOXPRESS_API_KEY'],
  ['Twilio', 'TWILIO_AUTH_TOKEN'],
  ['Amazon Business', 'AMAZON_CLIENT_ID'],
  ['Slack (webhook entrant)', 'SLACK_WEBHOOK_PERSO'],
  ['Ingestion FTP (Cube ARC, étiquettes)', 'FTP_INGEST_SECRET'],
]

/** Inventaire des outils externes déjà branchés, pour ne pas les reproposer. */
export function buildIntegrationDigest() {
  let oauth = ''
  try {
    oauth = db.prepare(`
      SELECT connector, account_email FROM connector_oauth ORDER BY connector
    `).all().map(r => `- ${r.connector}${r.account_email ? ` (${r.account_email})` : ''}`).join('\n')
  } catch {}

  const envTools = ENV_VENDORS
    .filter(([, key]) => String(process.env[key] || '').trim())
    .map(([label]) => `- ${label}`).join('\n')

  // Périmètre fonctionnel couvert : les pages de l'app suffisent à situer ce que
  // l'ERP fait déjà, sans faire lire le code au modèle.
  let pages = ''
  try {
    pages = readdirSync(`${REPO}/client/src/pages`)
      .filter(f => f.endsWith('.jsx'))
      .map(f => f.replace(/\.jsx$/, ''))
      .join(', ')
  } catch {}

  const recurring = listRecurringTasks()
    .map(t => `- [${t.cadence}${t.owner ? '/' + t.owner : ''}] ${t.label}`)
    .join('\n')

  const known = db.prepare(`
    SELECT title FROM work_suggestions WHERE deleted_at IS NULL AND kind='integration'
    ORDER BY created_at DESC LIMIT 60
  `).all().map(s => `- ${s.title}`).join('\n')

  return { oauth, envTools, pages, recurring, known }
}

const INTEGRATION_PROMPT = ({ oauth, envTools, pages, recurring, known }) => [
  'Orisha conçoit, fabrique et vend en direct des produits IoT de contrôle climatique pour serres (Québec, clients CA/US). ',
  'Son ERP interne single-tenant couvre marketing, ventes, logistique, assemblage, comptabilité, RH et dashboards.\n\n',
  'Ta mission ici : proposer des LOGICIELS ou des API EXTERNES à brancher à cet ERP, et ce que chaque branchement débloquerait concrètement. ',
  'Tu ne codes pas, tu recommandes.\n\n',
  'Déjà branché — connexions OAuth actives :\n', oauth || '(aucune)', '\n\n',
  'Déjà branché — clés d\'API présentes :\n', envTools || '(aucune)', '\n\n',
  'Périmètre fonctionnel actuel (pages de l\'ERP) :\n', pages || '(inconnu)', '\n\n',
  'Travaux encore faits À LA MAIN chaque semaine/mois (souvent le meilleur candidat à un branchement) :\n',
  recurring || '(aucun)', '\n\n',
  'Intégrations DÉJÀ proposées (ne les répète pas, même reformulées) :\n', known || '(aucune)', '\n\n',
  `Propose au maximum ${MAX_NEW_INTEGRATIONS_PER_RUN} intégrations, de la plus utile à la moins utile. Règles :\n`,
  '- Ne propose JAMAIS un outil déjà branché ci-dessus (Stripe, QuickBooks, Airtable, Google, HubSpot, Postmark, OpenAI, Novoxpress… selon les listes).\n',
  '- L\'outil doit avoir une API publique documentée et un intérêt réel pour une PME manufacturière IoT de cette taille — pas de suite entreprise hors de prix, pas de gadget.\n',
  '- Dis ce que ça remplace ou automatise pour Orisha, pas ce que l\'outil fait en général.\n',
  '- Chaque intégration doit tenir dans une seule séance de travail pour une première version utile (un flux, une direction), pas un chantier de six mois.\n\n',
  'Réponds UNIQUEMENT par un tableau JSON, sans texte autour, de la forme :\n',
  `[{"title":"Connecter <outil> — <ce que ça débloque>","area":"${SUGGESTION_AREAS.join('|')}",`,
  '"rationale":"ce que ça remplace/automatise chez Orisha et pourquoi maintenant, 1-3 phrases, en mentionnant le coût et le type d\'authentification (OAuth, clé d\'API) si tu le sais",',
  '"prompt":"le prompt complet à donner à un agent qui implémentera une première version utile : quel flux, dans quel sens, quelles pages/tables de l\'ERP touchées, quel comportement attendu"}]\n',
  'Si tu n\'as rien de solide à proposer, réponds [].',
].join('')

/** Un passage du moteur « intégrations ». Même déduplication par empreinte. */
export async function generateIntegrationSuggestions() {
  const digest = buildIntegrationDigest()
  const { text } = await runToollessClaude({
    prompt: INTEGRATION_PROMPT(digest),
    model: preferredAgentModel(),
    effort: 'high',
    timeoutMs: 6 * 60_000,
  })
  const items = parseSuggestionsJson(text).slice(0, MAX_NEW_INTEGRATIONS_PER_RUN)
  let added = 0
  for (const it of items) {
    if (addSuggestion({ title: it.title, rationale: it.rationale, prompt: it.prompt, area: it.area, kind: 'integration' })) added++
  }
  console.log(`🔌 Suggestions d'intégrations : ${items.length} proposée(s), ${added} nouvelle(s)`)
  return { proposed: items.length, added }
}

/**
 * Passage complet : les deux moteurs, en séquence (un seul appel modèle à la
 * fois — `runToollessClaude` démarre un vrai process). `kind` restreint à un
 * moteur ; sans `kind`, les deux tournent.
 */
export async function runSuggestionEngines({ kind = null } = {}) {
  const out = {}
  if (kind !== 'integration') out.chantiers = await generateSuggestions()
  if (kind !== 'chantier') out.integrations = await generateIntegrationSuggestions()
  return out
}
```


---

## `server/src/services/workIdeas.js`

Carnet d'idées : rien ne s'exécute d'ici ; promoteIdea dépose un item « de côté ».

```js
// Carnet d'idées (page /travaux, onglet « Idées »).
//
// Une idée n'est PAS une tâche : « The Future of ERP Systems » n'a rien à faire
// dans la file de prompts, où tout est destiné à partir en exécution. Cet onglet
// est le seul endroit de la page où rien ne s'exécute jamais — on y dépose ce
// qu'on veut garder et relire. Le passage à l'action est explicite (promoteIdea),
// et l'item créé arrive « de côté » dans la file : même promue, une idée ne
// déclenche pas d'exécution sans un geste de plus.
import { randomUUID } from 'crypto'
import db from '../db/database.js'
import { broadcastAll } from './realtime.js'
import { createPrompt } from './promptQueue.js'

const SELECT = 'SELECT * FROM work_ideas WHERE deleted_at IS NULL'

function broadcast() { broadcastAll({ type: 'travaux:ideas:updated' }) }

export function listIdeas() {
  return db.prepare(`${SELECT} ORDER BY position, created_at`).all()
}

export function getIdea(id) {
  return db.prepare(`${SELECT} AND id=?`).get(id) || null
}

function nextPosition() {
  return (db.prepare('SELECT MAX(position) AS m FROM work_ideas WHERE deleted_at IS NULL').get()?.m ?? 0) + 1
}

export function createIdea({ title, notes = null, tag = null, created_by = null }) {
  const text = String(title || '').trim()
  if (!text) throw new Error('title requis')
  const id = randomUUID()
  db.prepare(`
    INSERT INTO work_ideas (id, title, notes, tag, position, created_by)
    VALUES (?,?,?,?,?,?)
  `).run(id, text, notes || null, tag || null, nextPosition(), created_by)
  broadcast()
  return getIdea(id)
}

const EDITABLE = ['title', 'notes', 'tag']

export function updateIdea(id, patch) {
  const row = getIdea(id)
  if (!row) return null
  const sets = []
  const vals = []
  for (const [k, v] of Object.entries(patch || {})) {
    if (!EDITABLE.includes(k)) continue
    // Le titre est la seule chose qui identifie une idée : on refuse de le vider.
    if (k === 'title' && !String(v || '').trim()) continue
    sets.push(`${k}=?`)
    vals.push(k === 'title' ? String(v).trim() : (v === '' ? null : v))
  }
  if (!sets.length) return row
  db.prepare(`UPDATE work_ideas SET ${sets.join(', ')}, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
    .run(...vals, id)
  broadcast()
  return getIdea(id)
}

export function deleteIdea(id) {
  const row = getIdea(id)
  if (!row) return false
  db.prepare(`UPDATE work_ideas SET deleted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`).run(id)
  broadcast()
  return true
}

/** Réordonne le carnet dans l'ordre exact des ids reçus (les absents suivent). */
export function reorderIdeas(ids) {
  const upd = db.prepare('UPDATE work_ideas SET position=? WHERE id=? AND deleted_at IS NULL')
  db.transaction(() => { ids.forEach((id, i) => upd.run(i + 1, id)) })()
  broadcast()
  return listIdeas()
}

/**
 * Promotion en item de file. Volontairement créé en `paused` : une idée est floue
 * par nature, la promouvoir sert à la sortir du carnet, pas à lancer Claude dessus
 * séance tenante. L'utilisateur ajuste le prompt puis appuie sur ▶.
 * Idempotent : une idée déjà promue renvoie son item existant.
 */
export function promoteIdea(id, { userId = null, prompt = null, space = 'finance' } = {}) {
  const idea = getIdea(id)
  if (!idea) return null
  if (idea.work_prompt_id) {
    const existing = db.prepare('SELECT * FROM work_prompts WHERE id=? AND deleted_at IS NULL').get(idea.work_prompt_id)
    if (existing) return { idea, prompt: existing, already: true }
  }
  const body = String(prompt || '').trim()
    || [idea.title, idea.notes].filter(Boolean).join('\n\n')
  const created = createPrompt({
    title: idea.title,
    prompt: body,
    status: 'paused',
    created_by: userId,
    // L'item de file naît dans la section d'où l'idée est promue (finance/agent).
    space,
  })
  db.prepare(`UPDATE work_ideas SET work_prompt_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
    .run(created.id, id)
  broadcast()
  return { idea: getIdea(id), prompt: created, already: false }
}
```


---

## `server/src/services/promptTitle.js`

Titre automatique d'un prompt.

```js
// Titre automatique d'un prompt de la file de travaux.
//
// L'utilisateur écrit (souvent dicte) son prompt comme il l'écrirait dans le
// terminal : plusieurs phrases, du remplissage oral, aucun titre. Jusqu'ici la
// carte affichait les 120 premiers caractères du texte brut — illisible dans la
// file comme dans le recap Slack. Deux étages :
//
//   1. `heuristicTitle()` — synchrone et déterministe : la première phrase
//      nettoyée. Posé à la création, donc jamais de carte sans titre lisible même
//      si le modèle est indisponible.
//   2. `refineTitle()` — un passage modèle sans outils (haiku, effort bas) qui
//      nomme la NATURE de la tâche en une ligne. Best-effort : au moindre doute
//      sur la réponse, on retourne null et l'heuristique reste en place.
//
// Le titre n'est jamais généré quand l'utilisateur en a saisi un (voir
// promptQueue.createPrompt), et une retouche manuelle n'est jamais écrasée.
import { runToollessClaude } from './taskRunner.js'

export const MAX_TITLE_LEN = 80

const TITLE_TIMEOUT_MS = 90_000

/** Coupe au dernier mot entier avant `max`, avec points de suspension. */
function truncateWords(s, max = MAX_TITLE_LEN) {
  if (s.length <= max) return s
  const cut = s.slice(0, max)
  const sp = cut.lastIndexOf(' ')
  return (sp > max * 0.5 ? cut.slice(0, sp) : cut).replace(/[\s,;:—-]+$/, '') + '…'
}

function capitalize(s) {
  return s ? s[0].toLocaleUpperCase('fr-CA') + s.slice(1) : s
}

/**
 * Titre déterministe tiré du prompt : première ligne non vide, débarrassée de sa
 * puce / numérotation, réduite à sa première phrase si elle est longue.
 */
export function heuristicTitle(prompt) {
  const line = String(prompt || '')
    .split('\n')
    .map(l => l.trim())
    .find(l => l) || ''

  let t = line
    .replace(/^[-*•>#]+\s*/, '')        // puce ou citation markdown
    .replace(/^\d+[.)]\s+/, '')         // « 1. » / « 2) »
    .replace(/\*\*/g, '')               // gras markdown
    .replace(/\s+/g, ' ')
    .trim()

  // Trop long pour tenir : on garde la première phrase si elle suffit.
  if (t.length > MAX_TITLE_LEN) {
    const m = /[.!?](\s|$)/.exec(t)
    if (m && m.index > 15 && m.index <= MAX_TITLE_LEN) t = t.slice(0, m.index)
  }

  t = truncateWords(t.replace(/[.\s]+$/, ''))
  return capitalize(t) || 'Sans titre'
}

/**
 * Nettoie la réponse du modèle. Retourne null si elle ne ressemble pas à un
 * titre (préambule, refus, JSON, paragraphe) — mieux vaut garder l'heuristique
 * qu'afficher une phrase de conversation en titre de carte.
 */
export function sanitizeModelTitle(text) {
  const first = String(text || '')
    .split('\n')
    .map(l => l.trim())
    .find(l => l) || ''

  let t = first
    .replace(/^```.*$/, '')
    .replace(/^(?:titre|title)\s*[:—-]\s*/i, '')
    .replace(/^[«"'`*\s]+|[»"'`*\s]+$/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.]+$/, '')
    .trim()

  if (t.length < 3) return null
  if (t.length > 140) return null                       // paragraphe, pas un titre
  if (/^[[{]/.test(t)) return null                      // JSON
  if (/\b(je ne peux|désolé|voici (le|un) titre|as an ai)\b/i.test(t)) return null

  return capitalize(truncateWords(t))
}

const TITLE_PROMPT = (prompt) => [
  'Tu nommes une tâche dans la file de travaux d\'un ERP (ventes, logistique, assemblage, comptabilité, RH). ',
  'À partir de la demande ci-dessous, écris UN titre court en français qui reflète la nature de la tâche ',
  '(ce qui va changer et où), au maximum 8 mots. ',
  'Commence par un verbe à l\'infinitif ou un groupe nominal, sans point final, sans guillemets, sans préambule. ',
  'La demande est souvent dictée à la voix : ignore le remplissage oral (« tu comprends », « merci », « dans le fond ») ',
  'et garde uniquement l\'intention.\n\n',
  'Exemples de bons titres : « Titre automatique des prompts de la file », « Corriger l\'erreur à l\'ouverture de la fin de mois », ',
  '« Adapter le formulaire de paiement selon le moyen ».\n\n',
  'Ne réponds QUE par le titre, sur une seule ligne.\n\n',
  '--- Demande ---\n',
  String(prompt || '').slice(0, 4000),
].join('')

/**
 * Titre proposé par le modèle, ou null (échec, timeout, réponse douteuse).
 * Ne lève jamais : l'appelant garde son titre heuristique.
 */
export async function refineTitle(prompt) {
  const text = String(prompt || '').trim()
  if (!text) return null
  try {
    const { text: out } = await runToollessClaude({
      prompt: TITLE_PROMPT(text),
      model: 'haiku',
      effort: 'low',
      timeoutMs: TITLE_TIMEOUT_MS,
    })
    return sanitizeModelTitle(out)
  } catch {
    return null
  }
}

// ─── Titre dynamique : le fil de discussion est le projet ─────────────────────
// Un item de la file n'est pas figé à sa première phrase : l'humain répond, la
// demande se précise ou change de cap, l'agent rend compte. Le titre suit donc le
// FIL et pas seulement le prompt d'origine.

const MSG_MAX_CHARS = 600
const DIGEST_MAX_CHARS = 6000
const MAX_MESSAGES = 12

/**
 * Résumé lisible du fil pour le modèle : la demande d'origine puis les derniers
 * tours dans l'ordre. On garde la FIN du fil (le cap le plus récent l'emporte) et
 * chaque message est écourté — un titre n'a pas besoin des détails.
 */
export function buildThreadDigest(prompt, messages = []) {
  const clip = s => {
    const t = String(s || '').replace(/\s+/g, ' ').trim()
    return t.length > MSG_MAX_CHARS ? t.slice(0, MSG_MAX_CHARS) + '…' : t
  }
  const turns = (Array.isArray(messages) ? messages : [])
    .slice(-MAX_MESSAGES)
    .map(m => `${m.role === 'agent' ? 'Claude' : 'Humain'} : ${clip(m.text)}`)
    .filter(l => l.length > 12)

  const head = `Demande d'origine : ${clip(prompt)}`
  const digest = [head, ...turns].join('\n')
  return digest.length > DIGEST_MAX_CHARS ? '…' + digest.slice(-DIGEST_MAX_CHARS) : digest
}

const PROJECT_TITLE_PROMPT = ({ digest, current }) => [
  'Tu nommes un PROJET dans la file de travaux d\'un ERP (ventes, logistique, assemblage, comptabilité, RH). ',
  'Un projet, ici, c\'est un fil de discussion : une demande d\'origine puis des échanges qui la précisent ',
  'ou la font évoluer.\n\n',
  'Écris le titre qui reflète la nature du projet TEL QU\'IL EST MAINTENANT, au maximum 8 mots, en français. ',
  'Le cap le plus récent de l\'humain compte plus que la formulation d\'origine : si l\'échange a élargi ou ',
  'déplacé la demande, le titre doit le montrer. ',
  'Les messages sont souvent dictés à la voix : ignore le remplissage oral (« tu comprends », « merci », ',
  '« dans le fond ») et garde l\'intention.\n\n',
  current
    ? `Titre actuel : « ${current} ». S'il décrit encore correctement le projet, réponds-le mot pour mot au lieu d'en inventer un autre.\n\n`
    : '',
  'Sans point final, sans guillemets, sans préambule. Ne réponds QUE par le titre, sur une seule ligne.\n\n',
  '--- Fil ---\n',
  digest,
].join('')

/**
 * Titre du projet déduit du fil complet, ou null si le modèle échoue / répond
 * autre chose qu'un titre. Ne lève jamais.
 */
export async function refineProjectTitle({ prompt, messages = [], current = '' }) {
  const digest = buildThreadDigest(prompt, messages)
  if (!digest.trim()) return null
  try {
    const { text: out } = await runToollessClaude({
      prompt: PROJECT_TITLE_PROMPT({ digest, current: String(current || '').trim() }),
      model: 'haiku',
      effort: 'low',
      timeoutMs: TITLE_TIMEOUT_MS,
    })
    return sanitizeModelTitle(out)
  } catch {
    return null
  }
}
```


---

## `server/src/services/promptPreset.js`

Presets d'exécution (profondeur / mode) appliqués à un prompt.

```js
// Préréglage automatique d'un prompt de la file de travaux (« Auto »).
//
// Même mécanique que le titre automatique (promptTitle.js), appliquée au choix
// Rapide / Standard / Approfondi : l'utilisateur n'a plus à juger lui-même le
// calibre de sa demande. Deux étages :
//
//   1. `provisionalPreset()` — synchrone et déterministe : un préréglage sûr posé
//      à la création, pour que l'item soit exécutable même si le modèle est
//      indisponible. Volontairement prudent (jamais « rapide ») : mieux vaut
//      sur-servir une tâche que la confier à un modèle trop petit.
//   2. `classifyPreset()` — un passage modèle sans outils (haiku, effort bas) qui
//      juge le calibre réel de la demande. Best-effort : au moindre doute sur la
//      réponse, on retourne null et le provisoire reste en place.
//
// Le préréglage n'est jamais reclassé quand l'utilisateur en a choisi un à la
// main (voir promptQueue : flag preset_auto, même contrat que title_auto).
import { runToollessClaude } from './taskRunner.js'

export const PRESET_KEYS = ['fast', 'standard', 'deep']

const CLASSIFY_TIMEOUT_MS = 90_000

/**
 * Préréglage provisoire, en attendant (ou à défaut de) la classification modèle.
 * Une question part en « standard » (lecture seule, rarement un chantier) ; une
 * implémentation part en « approfondi » — l'ancien défaut de la file.
 */
export function provisionalPreset(mode) {
  return mode === 'question' ? 'standard' : 'deep'
}

/**
 * Nettoie la réponse du modèle et la ramène à une clé de préréglage. Retourne
 * null si elle n'y ressemble pas (préambule, refus, paragraphe) — mieux vaut
 * garder le provisoire qu'exécuter sur un calibre choisi au hasard.
 */
export function sanitizePresetAnswer(text) {
  const first = String(text || '')
    .split('\n')
    .map(l => l.trim())
    .find(l => l) || ''
  const word = first
    .replace(/^[«"'`*\s]+|[»"'`*.\s]+$/g, '')
    .toLowerCase()
  if (['rapide', 'fast', 'haiku'].includes(word)) return 'fast'
  if (['standard', 'sonnet'].includes(word)) return 'standard'
  if (['approfondi', 'approfondie', 'deep', 'fable', 'opus'].includes(word)) return 'deep'
  return null
}

const CLASSIFY_PROMPT = ({ prompt, mode }) => [
  'Tu calibres une tâche dans la file de travaux d\'un ERP (ventes, logistique, assemblage, ',
  'comptabilité, RH). Trois niveaux d\'exécution existent :\n\n',
  '- RAPIDE — petit modèle, effort minimal. Pour : question factuelle simple, lecture d\'une ',
  'valeur, micro-retouche de texte ou de libellé, changement d\'une constante évidente.\n',
  '- STANDARD — modèle intermédiaire. Pour : correctif ou petite fonctionnalité bien délimitée ',
  '(un écran, une route), question qui demande de lire du code, ajustement d\'un comportement existant.\n',
  '- APPROFONDI — meilleur modèle, effort maximal. Pour : chantier multi-étapes, nouvelle ',
  'fonctionnalité complète, logique comptable ou financière, migration ou refonte, débogage dont ',
  'la cause est inconnue, demande ambiguë ou aux ramifications incertaines.\n\n',
  mode === 'question'
    ? 'La demande ci-dessous est une QUESTION (lecture seule, rien ne sera implémenté).\n'
    : 'La demande ci-dessous est une tâche d\'IMPLÉMENTATION (du code sera modifié).\n',
  'En cas de doute entre deux niveaux, choisis le plus élevé des deux. ',
  'La demande est souvent dictée à la voix : ignore le remplissage oral et juge l\'intention.\n\n',
  'Ne réponds QUE par un seul mot, sur une seule ligne : RAPIDE, STANDARD ou APPROFONDI.\n\n',
  '--- Demande ---\n',
  String(prompt || '').slice(0, 4000),
].join('')

/**
 * Préréglage jugé par le modèle ('fast' | 'standard' | 'deep'), ou null (échec,
 * timeout, réponse douteuse). Ne lève jamais : l'appelant garde son provisoire.
 */
export async function classifyPreset({ prompt, mode = 'implement' } = {}) {
  const text = String(prompt || '').trim()
  if (!text) return null
  try {
    const { text: out } = await runToollessClaude({
      prompt: CLASSIFY_PROMPT({ prompt: text, mode }),
      model: 'haiku',
      effort: 'low',
      timeoutMs: CLASSIFY_TIMEOUT_MS,
    })
    return sanitizePresetAnswer(out)
  } catch {
    return null
  }
}
```


---

## `client/tailwind.config.js`

**Mode nuit** — cœur du mécanisme : chaque nuance Tailwind est servie via une variable CSS `rgb(var(--c-<palette>-<nuance>))` ; le mode nuit réécrit les variables sous `.dark`. Aucune classe `dark:` dans les composants (donc rien de spécifique à la section Travaux). `.theme-light` = échappatoire pour les écrans déjà conçus sombres.

```js
import plugin from 'tailwindcss/plugin'
import palette from 'tailwindcss/colors'

/* Mode nuit — les couleurs Tailwind sont servies via des variables CSS.
   Chaque nuance devient `rgb(var(--c-<palette>-<nuance>) / <alpha>)` ; le mode
   nuit se contente de réécrire les variables sous `.dark`. Aucune classe
   `dark:` à semer dans les ~5000 utilisations de `bg-white` / `text-slate-*`.

   - Neutres (slate, gray, white) : rampe sombre dédiée (fond page, surface,
     bordures, textes) — inversée mais calibrée à la main pour le contraste.
   - Palettes chromatiques : rampe simplement inversée (50↔950, 100↔900…),
     ce qui retourne d'un coup les pastilles `bg-amber-50 text-amber-800`.
   - `black` reste noir : il ne sert qu'aux voiles de modales. */

const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]

const brand = {
  50:  '#EEFAF1',
  100: '#D2F4DD',
  200: '#A2E8B6',
  300: '#6BD588',
  400: '#43CC6E',
  500: '#2BC25C',
  600: '#21B14B',
  700: '#1B8E3C',
  800: '#167030',
  900: '#115825',
  950: '#062F12',
}

// Palettes chromatiques : rampe inversée en mode nuit.
const CHROMATIC = ['red', 'orange', 'amber', 'yellow', 'green', 'emerald', 'teal',
  'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'pink', 'rose']

// Neutres : surface #161b22 (cartes), fond page #0d1117, textes clairs.
const NEUTRAL_DARK = {
  50:  '#0d1117',
  100: '#21262d',
  200: '#2b323b',
  300: '#3d444d',
  400: '#7d8590',
  500: '#9198a1',
  600: '#b1bac4',
  700: '#d0d7de',
  800: '#e6edf3',
  900: '#f0f6fc',
  950: '#ffffff',
}
const NEUTRAL_WHITE_DARK = '#161b22'

function rgb(hex) {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16)
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`
}

const THEMED = { slate: palette.slate, gray: palette.gray, brand }
for (const name of CHROMATIC) THEMED[name] = palette[name]

// Couleurs exposées à Tailwind : rgb(var(--…) / <alpha-value>)
const colors = { white: 'rgb(var(--c-white) / <alpha-value>)' }
for (const [name, ramp] of Object.entries(THEMED)) {
  colors[name] = Object.fromEntries(
    SHADES.filter(s => ramp[s]).map(s => [s, `rgb(var(--c-${name}-${s}) / <alpha-value>)`])
  )
}

const lightVars = { '--c-white': rgb('#ffffff') }
const darkVars = { '--c-white': rgb(NEUTRAL_WHITE_DARK) }
for (const [name, ramp] of Object.entries(THEMED)) {
  const neutral = name === 'slate' || name === 'gray'
  for (const s of SHADES) {
    if (!ramp[s]) continue
    lightVars[`--c-${name}-${s}`] = rgb(ramp[s])
    darkVars[`--c-${name}-${s}`] = rgb(neutral ? NEUTRAL_DARK[s] : ramp[SHADES[SHADES.length - 1 - SHADES.indexOf(s)]])
  }
}

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      colors,
    },
  },
  plugins: [
    plugin(({ addBase }) => {
      addBase({
        ':root': lightVars,
        '.dark': { ...darkVars, 'color-scheme': 'dark' },
        // Échappatoire : sous-arbre qui reste en mode jour même en mode nuit.
        // Pour les écrans déjà conçus « sombres » (page de connexion), qui
        // s'inverseraient à contresens. Les variables les plus proches gagnent.
        '.theme-light': { ...lightVars, 'color-scheme': 'light' },
      })
    }),
  ],
}
```


---

## `client/index.html (extrait — bootstrap du thème)`

Applique la classe `dark` avant le premier rendu : évite le flash blanc au chargement.

```html
    <link rel="icon" type="image/png" href="/erp/favicon.png" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Orisha ERP</title>
    <!-- Mode nuit appliqué avant le premier rendu : évite le flash blanc.
         Même logique que client/src/lib/theme.js (clé erp.theme). -->
    <script>
      (function () {
        try {
          var t = localStorage.getItem('erp.theme')
          if (t !== 'light' && t !== 'dark') {
            t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
          }
          if (t === 'dark') document.documentElement.classList.add('dark')
        } catch (e) {}
      })()
    </script>
```


---

## `client/src/lib/theme.js`

**Mode nuit** — état : lecture/écriture du thème (localStorage `erp.theme`, défaut = préférence système), application sur <html>, événement `erp:theme`.

```js
// Mode nuit — une classe `dark` sur <html> suffit : toutes les couleurs
// Tailwind passent par des variables CSS réécrites sous `.dark`
// (voir client/tailwind.config.js).
//
// Le choix est stocké en localStorage ; sans choix explicite on suit la
// préférence système. L'application initiale se fait aussi dans un script
// inline de index.html pour éviter le flash blanc au chargement.

export const THEME_KEY = 'erp.theme'
export const THEME_EVENT = 'erp:theme'

export function prefersDark() {
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches } catch { return false }
}

/** 'light' | 'dark' — thème actuellement souhaité. */
export function getTheme() {
  let stored = null
  try { stored = window.localStorage.getItem(THEME_KEY) } catch {}
  if (stored === 'light' || stored === 'dark') return stored
  return prefersDark() ? 'dark' : 'light'
}

export function applyTheme(theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

export function setTheme(theme) {
  try { window.localStorage.setItem(THEME_KEY, theme) } catch {}
  applyTheme(theme)
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: theme }))
}

export function toggleTheme() {
  const next = getTheme() === 'dark' ? 'light' : 'dark'
  setTheme(next)
  return next
}
```


---

## `client/src/components/ThemeToggle.jsx`

**Mode nuit** — l'interrupteur jour / nuit.

```jsx
import { useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import { getTheme, toggleTheme, THEME_EVENT } from '../lib/theme'

/** Bouton mode jour / mode nuit. `compact` = version icône seule (rail replié,
    en-tête mobile) ; sinon icône + libellé pour la sidebar dépliée. */
export default function ThemeToggle({ compact = false, className = '' }) {
  const [theme, setThemeState] = useState(() => getTheme())

  useEffect(() => {
    const onChange = (e) => setThemeState(e.detail || getTheme())
    window.addEventListener(THEME_EVENT, onChange)
    return () => window.removeEventListener(THEME_EVENT, onChange)
  }, [])

  const dark = theme === 'dark'
  const label = dark ? 'Mode jour' : 'Mode nuit'
  const Icon = dark ? Sun : Moon

  return (
    <button
      type="button"
      data-testid="theme-toggle"
      data-theme={theme}
      onClick={() => setThemeState(toggleTheme())}
      title={label}
      aria-label={label}
      aria-pressed={dark}
      className={
        compact
          ? `p-2 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors ${className}`
          : `p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors ${className}`
      }
    >
      <Icon size={compact ? 16 : 15} />
    </button>
  )
}
```


---

## `client/src/index.css`

CSS global (animations, sliders…) — les couleurs passent toutes par les variables du thème.

```css
@import 'react-grid-layout/css/styles.css';
@import 'react-resizable/css/styles.css';

@tailwind base;
@tailwind components;
@tailwind utilities;

@keyframes slide-in-up {
  from { transform: translateY(16px); opacity: 0; }
  to   { transform: translateY(0);    opacity: 1; }
}
.animate-slide-in-up {
  animation: slide-in-up 0.2s ease-out;
}

/* Dual range slider — used in Dashboard top-products date picker */
.range-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  background: transparent;
  pointer-events: none;
}
.range-slider-thumb::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  pointer-events: auto;
  width: 18px;
  height: 18px;
  border-radius: 9999px;
  background: rgb(var(--c-white));
  border: 2px solid #21B14B;
  box-shadow: 0 1px 3px rgba(0,0,0,0.15);
  cursor: grab;
}
.range-slider-thumb::-webkit-slider-thumb:active { cursor: grabbing; }
.range-slider-thumb::-moz-range-thumb {
  pointer-events: auto;
  width: 18px;
  height: 18px;
  border-radius: 9999px;
  background: rgb(var(--c-white));
  border: 2px solid #21B14B;
  box-shadow: 0 1px 3px rgba(0,0,0,0.15);
  cursor: grab;
}
.range-slider-thumb::-moz-range-track { background: transparent; border: none; }

@layer base {
  * {
    box-sizing: border-box;
  }
  body {
    @apply bg-slate-50 text-slate-900 antialiased;
  }

  /* Custom scrollbar — subtle, matches the ERP aesthetic */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { @apply bg-slate-300 rounded-full; }
  ::-webkit-scrollbar-thumb:hover { @apply bg-slate-400; }

  /* Dark areas use a dark scrollbar */
  .bg-slate-900 ::-webkit-scrollbar-thumb,
  .bg-slate-950 ::-webkit-scrollbar-thumb { @apply bg-slate-700; }
  .bg-slate-900 ::-webkit-scrollbar-thumb:hover,
  .bg-slate-950 ::-webkit-scrollbar-thumb:hover { @apply bg-slate-600; }
}

@layer utilities {
  /* Texte posé sur une surface toujours sombre (voile noir d'une modale,
     vignette d'image) : reste blanc même en mode nuit, contrairement à
     `text-white` qui suit la variable de surface. */
  .text-fixed-white { color: #fff; }
}

@layer components {
  .btn {
    @apply inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed;
  }
  .btn-primary {
    @apply btn bg-brand-600 text-white hover:bg-brand-500 focus:ring-brand-500 shadow-sm shadow-brand-200;
  }
  .btn-secondary {
    @apply btn bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-slate-300 focus:ring-brand-500 shadow-sm;
  }
  .btn-danger {
    @apply btn bg-red-600 text-white hover:bg-red-500 focus:ring-red-500 shadow-sm shadow-red-100;
  }
  .btn-sm {
    @apply px-3 py-1.5 text-xs;
  }
  .card {
    @apply bg-white rounded-xl border border-slate-200/80 shadow-sm;
  }
  .input {
    @apply block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-400 transition-all;
  }
  .label {
    @apply block text-sm font-medium text-slate-600 mb-1;
  }
  .select {
    @apply input appearance-none cursor-pointer;
  }
  .table-row-hover {
    @apply hover:bg-slate-50/80 cursor-pointer transition-colors;
  }
}

@keyframes slide-in-right {
  from { transform: translateX(100%); }
  to   { transform: translateX(0); }
}
.animate-slide-in-right {
  animation: slide-in-right 0.2s ease-out;
}

@keyframes fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
.animate-fade-in {
  animation: fade-in 0.15s ease-out;
}

/* DataTable — indicateur live « modifié par un autre utilisateur ».
   Halo vert sur la cellule changée + badge éditeur, qui s'estompent.
   Durée alignée sur FLASH_MS dans DataTable.jsx (3.6s). */
@keyframes dtCellFlash {
  0%   { background-color: rgba(16, 185, 129, 0.30); box-shadow: inset 0 0 0 2px rgba(16, 185, 129, 0.70); }
  70%  { background-color: rgba(16, 185, 129, 0.12); box-shadow: inset 0 0 0 2px rgba(16, 185, 129, 0.30); }
  100% { background-color: transparent;             box-shadow: inset 0 0 0 2px transparent; }
}
.dt-cell-flash {
  animation: dtCellFlash 3.6s ease-out forwards;
  border-radius: 4px;
}
@keyframes dtEditorBadge {
  0%   { opacity: 0; transform: translateY(-50%) translateX(6px); }
  12%  { opacity: 1; transform: translateY(-50%) translateX(0); }
  75%  { opacity: 1; transform: translateY(-50%) translateX(0); }
  100% { opacity: 0; transform: translateY(-50%) translateX(0); }
}
.dt-editor-badge {
  animation: dtEditorBadge 3.6s ease-out forwards;
}
```


---

## `server/src/db/schema.js (extrait — tables de la section)`

DDL additive et idempotente : work_prompts, work_prompt_messages, work_suggestions, work_ideas. Les tables recurring_tasks / recurring_task_completions sont retirées.

```js
  //   work_prompts      — la file de prompts de l'utilisateur, exécutée une à la
  //                       fois par l'agent (remplace le Google Doc de prompts).
  //   work_suggestions  — les recommandations générées par l'agent lui-même ;
  //                       jamais mélangées à la file humaine, promues sur demande.
  //   work_ideas        — le carnet d'idées de l'utilisateur : rien ne s'exécute
  //                       depuis là, une idée se garde et se relit.
  //   recurring_tasks   — les travaux récurrents du fichier Travaux_OS_ML (Drive),
  //                       cochés par période dans recurring_task_completions.
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_prompts (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      -- 'queued' = en attente de son tour ; 'running' = tâche agent en cours ;
      -- 'done'/'blocked' recopient le sort de la tâche agent ; 'paused' = mise de
      -- côté par l'utilisateur (jamais ramassée par l'ordonnanceur).
      status TEXT NOT NULL DEFAULT 'queued'
        CHECK(status IN ('queued','running','done','blocked','paused','cancelled')),
      position REAL NOT NULL DEFAULT 0,
      -- Enchaîne dans la MÊME session Claude que l'item précédent (--resume) au
      -- lieu de repartir d'un contexte neuf : pour les prompts qui poursuivent le
      -- travail du précédent. Le défaut (0) = contexte remis à zéro.
      same_context INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'implement' CHECK(mode IN ('implement','question')),
      preset TEXT NOT NULL DEFAULT 'deep',
      agent_task_id TEXT,
      -- Session Claude de l'exécution, pour que l'item suivant puisse la reprendre.
      session_id TEXT,
      suggestion_id TEXT,
      created_by TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      started_at TEXT,
      completed_at TEXT,
      deleted_at TEXT
    )
  `)
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_work_prompts_status ON work_prompts(status, position)`) } catch {}
  // Titre géré par l'app (déduit du prompt puis du fil de discussion) plutôt que
  // saisi à la main. Passe à 0 dès que l'utilisateur écrit son propre titre — un
  // titre choisi n'est JAMAIS réécrit. Défaut 0 : les items d'avant la
  // fonctionnalité gardent le leur, seul un item créé sans titre devient dynamique.
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN title_auto INTEGER NOT NULL DEFAULT 0`) } catch {}
  // Préréglage (Rapide/Standard/Approfondi) choisi par l'app plutôt que par
  // l'utilisateur : `preset` garde toujours une clé concrète (c'est elle que lit
  // l'ordonnanceur), ce flag dit qu'elle a été jugée automatiquement — et qu'une
  // reclassification peut la réécrire. Même contrat que title_auto : passe à 0
  // dès que l'utilisateur choisit lui-même, et plus rien n'y touche.
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN preset_auto INTEGER NOT NULL DEFAULT 0`) } catch {}
  // Question posée par l'agent à la fin d'une exécution, en JSON : { question, options[] }.
  // Une tâche détachée n'a pas de terminal — elle ne peut pas demander « laquelle des
  // deux ? » et devinait. Elle écrit désormais sa question ici, la carte l'affiche avec
  // ses choix, et un clic répond via le fil (ce qui relance la tâche). NULL = rien à
  // répondre. Colonne plutôt qu'un statut : le CHECK ci-dessus ne se modifie pas sans
  // reconstruire la table, et « terminé + question en attente » est un état réel.
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN pending_question TEXT`) } catch {}
  // « Arrête après celle-ci » : une fois cet item terminé, l'ordonnanceur se met en
  // pause au lieu d'enchaîner. Sert à borner la consommation de jetons Claude sans
  // avoir à surveiller la file (ex. la nuit, garder du quota pour l'équipe du matin).
  // 0 = enchaîne normalement.
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN stop_after INTEGER NOT NULL DEFAULT 0`) } catch {}
  // Deux files distinctes sur la même table : 'finance' (Espace finance → Travaux)
  // et 'agent' (section Agent → Travaux de l'agent). Chaque page ne montre que la
  // sienne ; l'exécuteur, lui, est partagé (une seule implémentation à la fois,
  // toutes files confondues).
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN space TEXT NOT NULL DEFAULT 'finance'`) } catch {}
  // Relance « avec le fil » : le prochain départ de cet item est une SUITE de
  // conversation (réponse de l'utilisateur après une exécution) — le brief est le
  // fil complet et la session Claude précédente est reprise. Posé quand on répond
  // à un item terminé (tout de suite, ou remis à la fin de la file), consommé à la
  // fin de l'exécution. 0 = départ normal sur le prompt d'origine.
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN follow_up INTEGER NOT NULL DEFAULT 0`) } catch {}
  // Marqueur « lu » façon boîte mail : posé quand l'utilisateur OUVRE une conversation
  // terminée (done/blocked/cancelled). NULL tant que le résultat n'a pas été consulté —
  // la carte « Conversations » s'affiche alors en gras pour qu'une tâche terminée non
  // relue ne se perde jamais dans la liste. Une relance (follow_up / reprise) le remet à
  // NULL : la nouvelle réponse de l'agent redevient « à lire ».
  try { db.exec(`ALTER TABLE work_prompts ADD COLUMN seen_at TEXT`) } catch {}

  // Fil de discussion d'un item de la file : chaque tâche a SA conversation, qui
  // survit aux exécutions successives (une relance crée une nouvelle tâche agent,
  // pas un nouveau fil). C'est ce qui permet de répondre à une demande de précision
  // depuis l'ERP, et de garder la trace même quand la session Claude a été purgée —
  // le fil est alors réinjecté en résumé dans le prompt de la relance.
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_prompt_messages (
      id TEXT PRIMARY KEY,
      prompt_id TEXT NOT NULL REFERENCES work_prompts(id),
      role TEXT NOT NULL CHECK(role IN ('user','agent')),
      text TEXT NOT NULL,
      -- Tâche agent qui a produit le message (côté agent) ou qu'il a déclenchée
      -- (côté humain) : permet de relier un tour de conversation à son exécution.
      agent_task_id TEXT,
      author TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `)
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_work_prompt_msgs ON work_prompt_messages(prompt_id, created_at)`) } catch {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS work_suggestions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      rationale TEXT,
      prompt TEXT NOT NULL,
      area TEXT,
      -- 'chantier'    = un travail à faire dans l'ERP tel qu'il est ;
      -- 'integration' = un logiciel / une API externe à brancher (ce que ça
      --                 débloquerait). Deux moteurs distincts, une seule liste.
      kind TEXT NOT NULL DEFAULT 'chantier',
      status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','accepted','dismissed')),
      -- Empreinte de déduplication : une même recommandation ne revient pas à
      -- chaque passage du moteur, même après avoir été rejetée.
      fingerprint TEXT NOT NULL,
      work_prompt_id TEXT,
      dismissed_reason TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec(`ALTER TABLE work_suggestions ADD COLUMN kind TEXT NOT NULL DEFAULT 'chantier'`) } catch {}
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_work_suggestions_fp ON work_suggestions(fingerprint)`) } catch {}

  // Fil de discussion d'une suggestion : avant de la mettre dans sa file (ou de la
  // rejeter), on peut demander à Claude d'en dire plus — pourquoi maintenant, ce que
  // ça change concrètement, ce que coûte l'outil externe d'une intégration. La
  // discussion n'exécute RIEN : elle vit à côté de la suggestion, pas dans la file.
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_suggestion_messages (
      id TEXT PRIMARY KEY,
      suggestion_id TEXT NOT NULL REFERENCES work_suggestions(id),
      role TEXT NOT NULL CHECK(role IN ('user','agent')),
      text TEXT NOT NULL,
      author TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_work_suggestion_msgs ON work_suggestion_messages(suggestion_id, created_at)`) } catch {}

  // Idées (onglet « Idées ») : le carnet de l'utilisateur. Rien ne s'exécute
  // jamais depuis cette liste — une idée est là pour être gardée et relue, pas
  // pour être faite. Elle ne rejoint la file que par une promotion explicite,
  // et y arrive « de côté » (voir promoteIdea dans workIdeas.js).
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_ideas (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      -- Développement libre de l'idée (le « pourquoi », les pistes…).
      notes TEXT,
      -- Thème libre saisi par l'utilisateur, purement pour regrouper l'œil.
      tag TEXT,
      -- Ordre du carnet, réordonnable à la main comme la file.
      position REAL NOT NULL DEFAULT 0,
      -- Item de file créé par une promotion, pour ne pas promouvoir deux fois.
      work_prompt_id TEXT,
      created_by TEXT REFERENCES users(id),
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_work_ideas_pos ON work_ideas(position)`) } catch {}

```
