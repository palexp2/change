import { useState, useEffect, useCallback, useRef } from 'react'
import { Link } from 'react-router-dom'
import { Bot, Send, CheckCircle, XCircle, Loader2, AlertTriangle, ChevronDown, ChevronUp, Trash2, Terminal, FileText, Edit3, Search, Activity, Maximize2, Minimize2, Lightbulb, MessageSquare, Power, ShieldAlert, RotateCw, Clock, Sparkles, Star, Settings, HelpCircle, Globe, ListChecks } from 'lucide-react'
import { api } from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
// Cartes d'utilisation Claude : extraites dans un composant partagé avec la page
// Travaux (qui en affiche la version bandeau).
import { ClaudeUsageBar } from '../components/ClaudeUsage.jsx'
import { Modal } from '../components/Modal.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { useAuth } from '../lib/auth.jsx'
import { invalidate } from '../lib/prefetch.js'
import { fmtDateTime } from '../lib/formatDate.js'
import { PageLink, isAppWideContext, contextPage } from '../components/PageLink.jsx'

const STATUS_CONFIG = {
  pending:       { label: 'À lire',      color: 'text-slate-600',   bg: 'bg-white',       border: 'border-l-slate-400',   icon: Lightbulb },
  in_discussion: { label: 'Discussion',  color: 'text-violet-600',  bg: 'bg-violet-50/40',border: 'border-l-violet-500',  icon: MessageSquare },
  approved:      { label: 'Approuvée',   color: 'text-sky-600',     bg: 'bg-sky-50',      border: 'border-l-sky-500',     icon: CheckCircle },
  in_progress:   { label: 'En cours',    color: 'text-amber-600',   bg: 'bg-amber-50',    border: 'border-l-amber-500',   icon: Loader2 },
  done:          { label: 'Terminée',    color: 'text-emerald-600', bg: 'bg-emerald-50',  border: 'border-l-emerald-500', icon: CheckCircle },
  blocked:       { label: 'Bloquée',     color: 'text-red-600',     bg: 'bg-red-50',      border: 'border-l-red-500',     icon: AlertTriangle },
  rejected:      { label: 'Rejetée',     color: 'text-slate-400',   bg: 'bg-slate-50',    border: 'border-l-slate-300',   icon: XCircle },
}

const SOURCE_LABELS = {
  A: 'Scan code',
  B: 'Signal système',
  C: 'Règle design',
  D: 'Ton backlog',
}
const EFFORT_LABELS = { small: 'Petit', medium: 'Moyen', large: 'Gros' }

// NB : le badge modèle + effort d'implémentation (« Opus · effort élevé ») a été
// retiré des cartes à la demande de l'utilisateur — model/effort restent stockés
// sur les tâches côté serveur mais ne sont plus affichés.

// ─── Tool icon helper ────────────────────────────────────────────────────────
function _toolIcon(name) {
  if (!name) return <Terminal size={11} />
  const n = name.toLowerCase()
  if (n === 'bash') return <Terminal size={11} />
  if (n === 'read') return <FileText size={11} />
  if (n === 'write' || n === 'edit') return <Edit3 size={11} />
  if (n === 'glob' || n === 'grep') return <Search size={11} />
  return <Terminal size={11} />
}

// ─── Elapsed-time counter ─────────────────────────────────────────────────────
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(s).padStart(2, '0')}s`
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`
  return `${s}s`
}

// Compteur de temps écoulé. `live` → ré-render chaque seconde (exécution en cours) ;
// sinon affiche la durée figée entre started_at et completed_at (tâche terminée).
function ElapsedTimer({ startedAt, completedAt, live = false }) {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!live) return
    const i = setInterval(() => tick(t => t + 1), 1000)
    return () => clearInterval(i)
  }, [live])
  if (!startedAt) return <span className="tabular-nums">--:--</span>
  const start = new Date(startedAt).getTime()
  const end = live || !completedAt ? Date.now() : new Date(completedAt).getTime()
  return <span className="tabular-nums" data-testid="elapsed-timer">{formatDuration(end - start)}</span>
}

// ─── Appréciation d'une implémentation (1 à 5 étoiles, un seul clic) ──────────
// Autosave immédiat au clic (règle « autosave partout » — feedback visible).
// Re-cliquer l'étoile courante retire l'appréciation.
function StarRating({ value = 0, onRate }) {
  const [hover, setHover] = useState(0)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  async function rate(n) {
    if (saving) return
    setSaving(true)
    try {
      await onRate(n === value ? null : n)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally { setSaving(false) }
  }

  return (
    <div className="flex items-center gap-2 flex-wrap" data-testid="implementation-rating">
      <span className="text-[11px] text-slate-400 font-medium uppercase tracking-wider">Appréciation</span>
      <div className="flex items-center" onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map(n => {
          const filled = hover ? n <= hover : n <= (value || 0)
          return (
            <button
              key={n}
              onClick={e => { e.stopPropagation(); rate(n) }}
              onMouseEnter={() => setHover(n)}
              data-testid={`rating-star-${n}`}
              className="p-0.5 transition-transform hover:scale-110"
              title={n === value ? 'Retirer l\'appréciation' : `${n} étoile${n > 1 ? 's' : ''}`}
            >
              <Star size={16} className={`transition-colors ${filled ? 'text-amber-400 fill-amber-400' : 'text-slate-300'}`} />
            </button>
          )
        })}
      </div>
      {saving
        ? <Loader2 size={11} className="text-slate-400 animate-spin" />
        : saved && <span className="text-[11px] text-emerald-600 font-medium">Enregistré</span>}
    </div>
  )
}

// ─── Live stream display ──────────────────────────────────────────────────────
function TaskStream({ chunks, done = false }) {
  const bottomRef = useRef(null)
  const scrollRef = useRef(null)
  const [expanded, setExpanded] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)

  const chunkCount = chunks?.length || 0
  useEffect(() => {
    // Défiler UNIQUEMENT le conteneur interne du stream — jamais `scrollIntoView`,
    // qui ferait sauter toute la page vers cette fenêtre et empêcherait de lire
    // les autres propositions pendant qu'une exécution streame.
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [chunkCount, autoScroll])

  function handleScroll() {
    const el = scrollRef.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 32
    setAutoScroll(atBottom)
  }

  const heightClass = expanded ? 'max-h-[32rem]' : 'max-h-48'

  return (
    <div className="bg-slate-950 rounded-lg border border-slate-800 overflow-hidden">
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-slate-800 bg-slate-900">
        {done ? <Terminal size={10} className="text-slate-500" /> : <Activity size={10} className="text-amber-400 animate-pulse" />}
        <span className="text-xs text-slate-400 font-medium flex-1">{done ? 'Journal d\'exécution' : 'Stream Claude Code'}</span>
        {chunks?.length > 0 && <span className="text-xs text-slate-600 tabular-nums mr-1">{chunks.length} evt</span>}
        {!autoScroll && !done && (
          <button onClick={() => { setAutoScroll(true); const el = scrollRef.current; if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' }) }} className="text-xs text-amber-400 hover:text-amber-300 mr-1.5">↓ bas</button>
        )}
        <button onClick={() => setExpanded(e => !e)} className="text-slate-600 hover:text-slate-400 transition-colors" title={expanded ? 'Réduire' : 'Agrandir'}>
          {expanded ? <Minimize2 size={10} /> : <Maximize2 size={10} />}
        </button>
      </div>
      <div ref={scrollRef} onScroll={handleScroll} className={`${heightClass} overflow-y-auto p-2.5 space-y-0.5 font-mono text-xs transition-all duration-200`}>
        {!chunks?.length ? (
          <div className="flex items-center gap-2 text-slate-500 py-1"><Loader2 size={9} className="animate-spin" /><span>En attente des premières actions…</span></div>
        ) : (
          chunks.map((chunk, i) => {
            if (chunk.kind === 'tool') return (
              <div key={i} className="flex items-center gap-1.5 leading-relaxed">
                <span className="text-slate-600 flex-shrink-0">›</span>
                <span className="text-brand-400 flex-shrink-0 font-semibold">{chunk.name}</span>
                {chunk.input && <span className="text-slate-400 truncate">{chunk.input}</span>}
              </div>
            )
            if (chunk.kind === 'result') return (
              <div key={i} className="ml-3 pl-2 border-l border-slate-700 text-slate-500 whitespace-pre-wrap leading-relaxed my-0.5 break-all">{chunk.content}</div>
            )
            if (chunk.kind === 'text') return (
              <div key={i} className="text-emerald-400 whitespace-pre-wrap leading-relaxed py-0.5">{chunk.text}</div>
            )
            // Message glissé par l'utilisateur PENDANT l'exécution (steering /travaux).
            if (chunk.kind === 'user') return (
              <div key={i} className="text-sky-300 whitespace-pre-wrap leading-relaxed py-0.5">📨 {chunk.text}</div>
            )
            return null
          })
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

// ─── Proposal / task card ─────────────────────────────────────────────────────
function ProposalCard({ task, onUpdate, onDelete, onSend, streamChunks, defaultExpanded = false }) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [comment, setComment] = useState(task.user_comment || '')
  const [commentSaving, setCommentSaving] = useState(false)
  const [commentSaved, setCommentSaved] = useState(false)
  const [showStream, setShowStream] = useState(false)  // repli debug : stream Claude masqué par défaut
  const cfg = STATUS_CONFIG[task.status] || STATUS_CONFIG.pending
  const Icon = cfg.icon
  const isProposal = task.kind === 'proposal'
  const heading = task.title || task.description
  const canTriage = ['pending', 'in_discussion'].includes(task.status)
  const highRisk = task.risk === 'high'

  async function sendReply() {
    if (!reply.trim() || sending) return
    setSending(true)
    await onSend(task.id, reply.trim())
    setReply('')
    setSending(false)
  }

  async function reject() {
    await onUpdate(task.id, { status: 'rejected', user_comment: comment || task.user_comment || null })
  }

  // Autosave on blur (règle « autosave partout » — état de sauvegarde visible obligatoire).
  async function saveComment() {
    if (comment === (task.user_comment || '') || commentSaving) return
    setCommentSaving(true)
    try {
      await onUpdate(task.id, { user_comment: comment })
      setCommentSaved(true)
      setTimeout(() => setCommentSaved(false), 2000)
    } finally {
      setCommentSaving(false)
    }
  }

  return (
    <div className={`rounded-xl border border-slate-200 border-l-[3px] ${cfg.border} ${cfg.bg} transition-all shadow-sm`}>
      {/* Header row */}
      <div className="flex items-start gap-2.5 p-3.5 sm:p-4 cursor-pointer" onClick={() => setExpanded(s => !s)}>
        <Icon size={15} className={`mt-0.5 flex-shrink-0 ${cfg.color} ${task.status === 'in_progress' ? 'animate-spin' : ''}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-2 flex-wrap">
            <span className="text-slate-900 text-sm font-medium break-words flex-1 min-w-0">{heading}</span>
            <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${cfg.color} bg-current/10`}>{cfg.label}</span>
          </div>
          {/* Meta badges — la durée d'exécution reste visible même carte repliée. */}
          {(isProposal || (task.status === 'done' && task.context) || ((task.status === 'done' || task.status === 'blocked') && task.started_at && task.completed_at)) && (
            <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
              {isProposal && (highRisk
                ? <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-semibold"><ShieldAlert size={10} /> Risque élevé</span>
                : <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">Risque faible</span>)}
              {isProposal && task.source && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">{SOURCE_LABELS[task.source] || task.source}</span>}
              {isProposal && task.effort && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">Effort : {EFFORT_LABELS[task.effort] || task.effort}</span>}
              {isProposal && task.messages?.length > 0 && <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-violet-100 text-violet-600"><MessageSquare size={10} />{task.messages.length}</span>}
              {(task.status === 'done' || task.status === 'blocked') && task.started_at && task.completed_at && (
                <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500" data-testid="card-duration">
                  <Clock size={10} /> <ElapsedTimer startedAt={task.started_at} completedAt={task.completed_at} />
                </span>
              )}
              {task.status === 'done' && <PageLink task={task} />}
            </div>
          )}
        </div>
        <button onClick={e => { e.stopPropagation(); onDelete(task.id) }} className="text-slate-300 hover:text-red-500 p-1 rounded-lg transition-colors hover:bg-red-50 flex-shrink-0">
          <Trash2 size={13} />
        </button>
        {expanded ? <ChevronUp size={14} className="text-slate-400 flex-shrink-0 mt-1" /> : <ChevronDown size={14} className="text-slate-400 flex-shrink-0 mt-1" />}
      </div>

      {/* Compteur de temps écoulé pendant l'exécution (le stream Claude n'est plus affiché en cours d'exécution — le journal reste consultable uniquement sur une tâche bloquée). */}
      {task.status === 'in_progress' && (
        <div className="px-3.5 sm:px-4 pb-3 space-y-2">
          <div className="flex items-center justify-between gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2.5">
            <div className="flex items-center gap-2 text-amber-700">
              <Clock size={15} className="animate-pulse" />
              <span className="text-sm font-medium">Temps écoulé</span>
            </div>
            <span className="text-lg font-semibold text-amber-700 tabular-nums">
              <ElapsedTimer startedAt={task.started_at} live />
            </span>
          </div>
        </div>
      )}

      {/* Appréciation de l'implémentation — toujours visible une fois terminée (un seul clic). */}
      {task.status === 'done' && (
        <div className="px-3.5 sm:px-4 pb-3">
          <StarRating value={task.rating} onRate={r => onUpdate(task.id, { rating: r })} />
        </div>
      )}

      {expanded && (
        <div className="px-3.5 sm:px-4 pb-4 space-y-3 border-t border-slate-200/70 pt-3">
          {/* Compte-rendu non technique — visible uniquement carte dépliée
              (demande utilisateur : ne plus l'afficher sur la carte repliée). */}
          {task.status === 'done' && task.user_summary && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3" data-testid="task-user-summary">
              <p className="text-[11px] text-emerald-700 font-semibold uppercase tracking-wider mb-1">Ce qui a changé</p>
              <p className="text-emerald-900 text-sm whitespace-pre-wrap leading-relaxed">{task.user_summary}</p>
            </div>
          )}
          {isProposal && task.why && (
            <div>
              <p className="text-[11px] text-slate-400 font-medium uppercase tracking-wider mb-0.5">Pourquoi</p>
              <p className="text-slate-700 text-sm whitespace-pre-wrap leading-relaxed">{task.why}</p>
            </div>
          )}
          {isProposal && task.zone && (
            <div>
              <p className="text-[11px] text-slate-400 font-medium uppercase tracking-wider mb-0.5">Zone touchée</p>
              <p className="text-slate-600 text-xs font-mono break-words">{task.zone}</p>
            </div>
          )}
          {isProposal && task.side_effects && task.side_effects !== 'aucun' && (
            <div className="bg-amber-50 border border-amber-200 rounded-lg p-2.5">
              <p className="text-[11px] text-amber-700 font-semibold uppercase tracking-wider mb-0.5">Side effects</p>
              <p className="text-amber-800 text-xs whitespace-pre-wrap">{task.side_effects}</p>
            </div>
          )}
          {!isProposal && task.description?.length > 80 && (
            <p className="text-slate-600 text-sm whitespace-pre-wrap">{task.description}</p>
          )}

          {/* Conversation thread */}
          {task.messages?.length > 0 && (
            <div className="space-y-2">
              {task.messages.map((m, i) => (
                <div key={i} className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm whitespace-pre-wrap ${m.role === 'user' ? 'bg-brand-600 text-white rounded-br-sm' : 'bg-slate-100 text-slate-700 rounded-bl-sm'}`}>
                    {m.text}
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Conversation input (read-only discussion, no code yet) */}
          {canTriage && (
            <div className="flex items-end gap-2">
              <textarea
                value={reply}
                onChange={e => setReply(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) sendReply() }}
                rows={1}
                placeholder="Discuter, questionner, demander une variante…"
                className="flex-1 bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900 placeholder-slate-400 resize-none focus:outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-500/20"
              />
              <button onClick={sendReply} disabled={sending || !reply.trim()} className="flex-shrink-0 h-9 w-9 flex items-center justify-center bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white rounded-lg transition-colors" title="Envoyer (⌘+Entrée)">
                {sending ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
              </button>
            </div>
          )}

          {/* Triage actions */}
          {canTriage && (
            <div className="flex flex-col sm:flex-row gap-2 pt-1">
              <button onClick={() => onUpdate(task.id, { status: 'approved' })} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-medium transition-colors">
                <CheckCircle size={15} /> Approuver &amp; coder
              </button>
              <button onClick={reject} className="flex-1 sm:flex-none flex items-center justify-center gap-1.5 px-3 py-2 bg-white hover:bg-slate-50 border border-slate-200 text-slate-600 rounded-lg text-sm font-medium transition-colors">
                <XCircle size={15} /> Rejeter
              </button>
            </div>
          )}
          {/* Relancer une tâche bloquée (interrompue par un redémarrage serveur ou un échec) */}
          {task.status === 'blocked' && (
            <div className="flex flex-col sm:flex-row gap-2 pt-1">
              <button onClick={() => onUpdate(task.id, { status: 'approved' })} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-medium transition-colors">
                <RotateCw size={15} /> Relancer
              </button>
              <button onClick={reject} className="flex-1 sm:flex-none flex items-center justify-center gap-1.5 px-3 py-2 bg-white hover:bg-slate-50 border border-slate-200 text-slate-600 rounded-lg text-sm font-medium transition-colors">
                <XCircle size={15} /> Abandonner
              </button>
            </div>
          )}

          {canTriage && (
            <div>
              <div className="flex items-center gap-2 mb-1">
                <label className="text-[11px] text-slate-400 font-medium uppercase tracking-wider">Commentaire (calibre l'agent en cas de rejet)</label>
                {commentSaving
                  ? <Loader2 size={11} className="text-slate-400 animate-spin" />
                  : commentSaved
                    ? <span className="text-[11px] text-emerald-600 font-medium">Enregistré</span>
                    : comment !== (task.user_comment || '') && <span className="text-[11px] text-slate-400">Modifié</span>}
              </div>
              <textarea value={comment} onChange={e => setComment(e.target.value)} onBlur={saveComment} rows={2} placeholder="Ex. ne propose plus de migrations cosmétiques…" className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900 placeholder-slate-400 resize-none focus:outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-500/20" />
            </div>
          )}

          {/* Pas de rappel de durée ni de date de fin en dépli : la durée est déjà
              affichée dans le badge en tête de carte (demande utilisateur). */}

          {/* Execution replay (debug) — replié par défaut, uniquement pour les
              tâches bloquées (diagnostic). Les cartes terminées ne montrent plus
              le journal d'exécution (demande utilisateur). */}
          {task.status === 'blocked' && streamChunks?.length > 0 && (
            <div className="space-y-2">
              <button
                onClick={() => setShowStream(s => !s)}
                className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-600 transition-colors"
              >
                <Terminal size={12} />
                {showStream ? 'Masquer le journal d\'exécution' : 'Voir le journal d\'exécution'}
                {showStream ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
              </button>
              {showStream && <TaskStream chunks={streamChunks} done />}
            </div>
          )}
          {/* Tâche terminée : le résumé vulgarisé « Ce qui a changé » ci-dessus suffit —
              le rapport technique brut n'est plus montré (demande utilisateur). Il reste
              montré pour les tâches bloquées, où il explique le blocage. */}
          {task.status !== 'done' && task.agent_result && (
            <div className="bg-white rounded-lg p-3 border border-slate-200">
              <p className="text-[11px] text-slate-400 font-medium uppercase tracking-wider mb-1.5">Rapport agent</p>
              <p className="text-slate-700 text-xs whitespace-pre-wrap font-mono leading-relaxed">{task.agent_result}</p>
            </div>
          )}
          {task.completed_at && <p className="text-xs text-slate-400">Terminée le {fmtDateTime(task.completed_at)}</p>}
        </div>
      )}
    </div>
  )
}

// ─── Zone wrapper ─────────────────────────────────────────────────────────────
function Zone({ title, count, children, collapsible = false }) {
  const [open, setOpen] = useState(!collapsible)
  return (
    <section className="mb-6">
      <button
        onClick={() => collapsible && setOpen(o => !o)}
        className={`w-full flex items-center gap-2 mb-2.5 ${collapsible ? 'cursor-pointer' : 'cursor-default'}`}
      >
        <h2 className="text-xs font-semibold uppercase tracking-wider text-slate-500">{title}</h2>
        <span className="text-xs text-slate-400 tabular-nums">{count}</span>
        {collapsible && (open ? <ChevronUp size={13} className="text-slate-400" /> : <ChevronDown size={13} className="text-slate-400" />)}
        <div className="flex-1 border-t border-slate-200/70 ml-1" />
      </button>
      {open && children}
    </section>
  )
}

// ─── Fiche unifiée suggestion ↔ correctif ─────────────────────────────────────
// Statut dérivé : d'abord la tâche d'implémentation (si approuvée), sinon l'état
// de la proposition instantanée. Une fiche « question » (mode question) porte des
// libellés dédiés : l'agent répond, il n'implante rien.
function suggestionStatus(item, task, isQuestion = false) {
  if (task) {
    if (task.status === 'approved')    return { key: 'queued',      label: 'En file',           color: 'text-sky-600',     bg: 'bg-sky-50',       border: 'border-l-sky-500',     icon: CheckCircle }
    if (task.status === 'in_progress') return { key: 'in_progress', label: isQuestion ? 'Réponse en cours…' : 'Implémentation…', color: 'text-amber-600', bg: 'bg-amber-50', border: 'border-l-amber-500', icon: Loader2 }
    if (task.status === 'done')        return { key: 'done',        label: isQuestion ? 'Répondu' : 'Implanté', color: 'text-emerald-600', bg: 'bg-emerald-50', border: 'border-l-emerald-500', icon: CheckCircle }
    if (task.status === 'blocked')     return { key: 'blocked',     label: 'Bloqué',            color: 'text-red-600',     bg: 'bg-red-50',       border: 'border-l-red-500',     icon: AlertTriangle }
  }
  if (item.instant_status === 'generating')                  return { key: 'generating', label: 'Analyse…',          color: 'text-violet-600', bg: 'bg-violet-50/40', border: 'border-l-violet-500', icon: Loader2 }
  if (item.instant_status === 'ready' && item.instant_proposal) return { key: 'proposed', label: 'Correctif proposé', color: 'text-brand-600',  bg: 'bg-white',        border: 'border-l-brand-400',  icon: Sparkles }
  return { key: 'error', label: 'Analyse échouée', color: 'text-red-600', bg: 'bg-red-50/50', border: 'border-l-red-400', icon: AlertTriangle }
}

function SuggestionCard({ item, task, onApprove, onRetry, onDelete, onRelaunch, onRate, streamChunks, defaultExpanded = false, autoApprove = false, onAutoApproveChange = null }) {
  const [expanded, setExpanded] = useState(defaultExpanded)
  const [comment, setComment] = useState('')
  const [approving, setApproving] = useState(false)
  const [showStream, setShowStream] = useState(false)
  const [showReport, setShowReport] = useState(false)
  const [localAutoApprove, setLocalAutoApprove] = useState(autoApprove)
  // Question : l'utilisateur attend une réponse, pas un correctif — libellés adaptés.
  const isQuestion = item.mode === 'question' || task?.mode === 'question'
  const st = suggestionStatus(item, task, isQuestion)
  const Icon = st.icon
  const spinning = st.key === 'in_progress' || st.key === 'generating'

  useEffect(() => {
    setLocalAutoApprove(autoApprove)
  }, [autoApprove])

  async function approve() {
    if (approving) return
    setApproving(true)
    try {
      await onApprove(item, comment.trim())
      if (localAutoApprove) {
        setExpanded(false)
      }
    } finally {
      setApproving(false)
    }
  }

  function handleToggleAutoApprove(value) {
    setLocalAutoApprove(value)
    if (onAutoApproveChange) onAutoApproveChange(value)
  }

  return (
    <div className={`rounded-xl border border-slate-200 border-l-[3px] ${st.border} ${st.bg} transition-all shadow-sm`} data-testid="suggestion-card">
      {/* En-tête : le signalement lui-même + provenance */}
      <div className="flex items-start gap-2.5 p-3.5 sm:p-4 cursor-pointer" onClick={() => setExpanded(s => !s)}>
        <Icon size={15} className={`mt-0.5 flex-shrink-0 ${st.color} ${spinning ? 'animate-spin' : ''}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-2 flex-wrap">
            <span className={`text-slate-900 text-sm font-medium break-words flex-1 min-w-0 whitespace-pre-wrap ${expanded ? '' : 'line-clamp-2'}`}>{item.text}</span>
            <span className={`text-[11px] px-2 py-0.5 rounded-full font-medium whitespace-nowrap ${st.color} bg-current/10`}>{st.label}</span>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
            {isQuestion && (
              <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-violet-100 text-violet-600 font-medium" data-testid="question-badge">
                <HelpCircle size={10} /> Question
              </span>
            )}
            {item.author && <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">{item.author}</span>}
            {item.context && (isAppWideContext(item.context)
              ? <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500" title={item.context} data-testid="context-app-wide"><Globe size={10} /> Toute l'application</span>
              : <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 font-mono" title={item.context}>{contextPage(item.context)}</span>)}
            <span className="text-[10px] text-slate-400">{fmtDateTime(item.created_at)}</span>
            {/* Durée d'exécution visible même carte repliée pour les implémentations terminées. */}
            {task && (task.status === 'done' || task.status === 'blocked') && task.started_at && task.completed_at && (
              <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500" data-testid="card-duration">
                <Clock size={10} /> <ElapsedTimer startedAt={task.started_at} completedAt={task.completed_at} />
              </span>
            )}
            {task?.status === 'done' && <PageLink task={task} />}
          </div>
        </div>
        <button onClick={e => { e.stopPropagation(); onDelete(item, task) }} className="text-slate-300 hover:text-red-500 p-1 rounded-lg transition-colors hover:bg-red-50 flex-shrink-0" title="Supprimer la suggestion">
          <Trash2 size={13} />
        </button>
        {expanded ? <ChevronUp size={14} className="text-slate-400 flex-shrink-0 mt-1" /> : <ChevronDown size={14} className="text-slate-400 flex-shrink-0 mt-1" />}
      </div>

      {/* Implémentation en cours : timer visible même fiche repliée. */}
      {task?.status === 'in_progress' && (
        <div className="px-3.5 sm:px-4 pb-3 space-y-2">
          <div className="flex items-center justify-between gap-2 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2.5">
            <div className="flex items-center gap-2 text-amber-700">
              <Clock size={15} className="animate-pulse" />
              <span className="text-sm font-medium">{isQuestion ? 'L\'agent prépare la réponse' : 'L\'agent implémente le correctif'}</span>
            </div>
            <span className="text-lg font-semibold text-amber-700 tabular-nums">
              <ElapsedTimer startedAt={task.started_at} live />
            </span>
          </div>
        </div>
      )}

      {/* Appréciation de l'implémentation — toujours visible une fois implanté (un seul clic). */}
      {task?.status === 'done' && onRate && (
        <div className="px-3.5 sm:px-4 pb-3">
          <StarRating value={task.rating} onRate={r => onRate(task.id, r)} />
        </div>
      )}

      {expanded && (
        <div className="px-3.5 sm:px-4 pb-4 space-y-3 border-t border-slate-200/70 pt-3">
          {/* Le correctif proposé, affiché directement dans la fiche.
              Gated sur le statut dérivé (st) et non sur instant_status brut :
              un instant_status resté « generating » ne doit pas afficher
              l'analyse en cours sur une carte dont la tâche est terminée. */}
          {st.key === 'generating' && (
            <div className="flex items-center gap-2 text-slate-500 text-sm">
              <Loader2 size={14} className="animate-spin text-brand-500" /> L'agent analyse la demande et prépare une proposition…
            </div>
          )}
          {st.key === 'error' && (
            <div className="flex items-center gap-3 flex-wrap">
              <p className="text-sm text-red-600">La proposition instantanée a échoué.</p>
              <button onClick={() => onRetry(item)} className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1.5 bg-white border border-slate-200 rounded-lg text-slate-600 hover:bg-slate-50 transition-colors">
                <RotateCw size={12} /> Réessayer
              </button>
            </div>
          )}
          {/* L'analyse initiale n'est plus affichée une fois le correctif implanté —
              seule la fiche « Ce qui a changé » (résumé non technique) demeure. */}
          {item.instant_proposal && task?.status !== 'done' && (
            <div>
              <p className="text-[11px] text-slate-400 font-medium uppercase tracking-wider mb-0.5 flex items-center gap-1">
                <Sparkles size={11} className="text-brand-500" /> Correctif proposé
              </p>
              <p className="text-slate-700 text-sm whitespace-pre-wrap leading-relaxed">{item.instant_proposal}</p>
            </div>
          )}

          {/* Approbation sur place (tant qu'aucune tâche n'existe) */}
          {!task && st.key === 'proposed' && (
            <div className="space-y-2 pt-1">
              <textarea
                value={comment}
                onChange={e => setComment(e.target.value)}
                rows={1}
                placeholder="Précision optionnelle avant d'approuver (ex. attention à…)"
                className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900 placeholder-slate-400 resize-none focus:outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-500/20"
              />
              <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-center justify-between pt-1">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={localAutoApprove}
                    onChange={e => handleToggleAutoApprove(e.target.checked)}
                    className="w-4 h-4 accent-emerald-600 cursor-pointer"
                  />
                  <span className="text-sm text-slate-600">Approuver automatiquement</span>
                </label>
                <button
                  onClick={approve}
                  disabled={approving}
                  data-testid="suggestion-approve"
                  className="w-full sm:w-auto flex items-center justify-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white rounded-lg text-sm font-medium transition-colors"
                >
                  {approving ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle size={15} />}
                  Approuver le correctif
                </button>
              </div>
            </div>
          )}

          {/* Résumé vulgarisé (« Ce qui a changé » / « Réponse ») — visible uniquement
              carte dépliée (demande utilisateur : ne plus l'afficher repliée). */}
          {task?.user_summary && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3" data-testid="suggestion-user-summary">
              <p className="text-[11px] text-emerald-700 font-semibold uppercase tracking-wider mb-1">{isQuestion ? 'Réponse' : 'Ce qui a changé'}</p>
              <p className="text-emerald-900 text-sm whitespace-pre-wrap leading-relaxed">{task.user_summary}</p>
            </div>
          )}

          {/* Tâche bloquée : explication + relance */}
          {task?.status === 'blocked' && (
            <div className="space-y-2">
              {!task.user_summary && task.agent_result && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-2.5">
                  <p className="text-red-800 text-xs whitespace-pre-wrap line-clamp-6">{task.agent_result}</p>
                </div>
              )}
              <div className="flex flex-col sm:flex-row gap-2">
                <button onClick={() => onRelaunch(task)} className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-medium transition-colors">
                  <RotateCw size={15} /> {isQuestion ? 'Relancer la réponse' : 'Relancer l\'implémentation'}
                </button>
              </div>
            </div>
          )}

          {/* Rapport technique + journal d'exécution en dépli — visibles uniquement
              pour les tâches bloquées (diagnostic) ; carte terminée = résumé non
              technique uniquement, sans journal (demande utilisateur). Pas de rappel
              durée/date de fin ici : la durée est déjà dans le badge en tête de carte. */}
          {task?.status === 'blocked' && (
            <div className="space-y-2">
              {task.agent_result && (
                <div>
                  <button onClick={() => setShowReport(s => !s)} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-600 transition-colors">
                    <FileText size={12} />
                    {showReport ? 'Masquer le rapport technique' : 'Voir le rapport technique'}
                    {showReport ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  </button>
                  {showReport && (
                    <div className="mt-2 bg-white rounded-lg p-3 border border-slate-200">
                      <p className="text-slate-700 text-xs whitespace-pre-wrap font-mono leading-relaxed">{task.agent_result}</p>
                    </div>
                  )}
                </div>
              )}
              {streamChunks?.length > 0 && (
                <div>
                  <button onClick={() => setShowStream(s => !s)} className="flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-600 transition-colors">
                    <Terminal size={12} />
                    {showStream ? 'Masquer le journal d\'exécution' : 'Voir le journal d\'exécution'}
                    {showStream ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                  </button>
                  {showStream && <TaskStream chunks={streamChunks} done />}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Éditeur de prompt générique (préambule + modèles d'activité) ──────────────
// Tout ce que le modèle reçoit en prompt est éditable ici. Les modèles d'activité
// acceptent des jetons {{placeholder}} remplacés à l'exécution par le serveur.
function PromptEditorPanel({ testid, title, description, value, defaultValue, placeholders = [], rows = 8, onSave }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState(value || '')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

  // Resynchronise si la valeur change ailleurs (WS settings:updated / chargement).
  useEffect(() => { setText(value || '') }, [value])

  const dirty = text !== (value || '')
  // « Personnalisé » = la valeur enregistrée diffère du modèle d'usine.
  const customized = defaultValue != null && (value || '') !== defaultValue

  // Autosave on blur (règle « autosave partout » du CLAUDE.md — pas de bouton Enregistrer).
  async function persist(next) {
    setSaving(true)
    try {
      await onSave(next)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } finally { setSaving(false) }
  }
  async function save() { if (dirty && !saving) await persist(text) }
  async function resetDefault() {
    if (defaultValue == null || saving) return
    setText(defaultValue)
    await persist(defaultValue)
  }

  return (
    <div className="mb-6 bg-white border border-slate-200 rounded-xl p-3.5 shadow-sm">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-2 text-left">
        <FileText size={15} className="text-brand-500" />
        <span className="text-sm font-medium text-slate-700 flex-1">{title}</span>
        {customized && !open && <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 font-medium">Personnalisé</span>}
        {saving
          ? <Loader2 size={13} className="text-slate-400 animate-spin" />
          : saved
            ? <span className="text-[11px] text-emerald-600 font-medium">Enregistré</span>
            : dirty && open && <span className="text-[11px] text-slate-400">Modifié</span>}
        {open ? <ChevronUp size={14} className="text-slate-400" /> : <ChevronDown size={14} className="text-slate-400" />}
      </button>
      {open && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-slate-400">{description}</p>
          {placeholders.length > 0 && (
            <div className="rounded-lg bg-slate-50 border border-slate-200 p-2.5 space-y-1">
              <p className="text-[10px] text-slate-400 font-semibold uppercase tracking-wider">Variables disponibles</p>
              <div className="flex flex-col gap-0.5">
                {placeholders.map(([token, desc]) => (
                  <div key={token} className="flex items-baseline gap-2 text-xs">
                    <code className="text-brand-600 bg-brand-50 px-1 rounded font-mono whitespace-nowrap">{token}</code>
                    <span className="text-slate-500">{desc}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          <textarea
            value={text}
            onChange={e => setText(e.target.value)}
            onBlur={save}
            data-testid={testid ? `prompt-textarea-${testid}` : undefined}
            rows={rows}
            placeholder="Instructions données à l'agent…"
            className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900 placeholder-slate-400 font-mono leading-relaxed resize-y focus:outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-500/20"
          />
          {customized && (
            <button
              onClick={resetDefault}
              data-testid={testid ? `prompt-reset-${testid}` : undefined}
              className="inline-flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-700 transition-colors"
            >
              <RotateCw size={12} /> Réinitialiser le modèle par défaut
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Instructions projet (CLAUDE.md) — éditable, admin only ───────────────────
function ClaudeMdPanel() {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [original, setOriginal] = useState('')
  // `true` initialement : sans ça, il existe un frame entre l'ouverture du
  // panneau et le lancement du fetch (useEffect post-paint) où le textarea est
  // rendu vide — un test/utilisateur rapide peut lire un contenu vide.
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const fetchedRef = useRef(false)

  // Chargement paresseux : on ne lit le fichier qu'au premier dépliage.
  // Deps = [open] uniquement : mettre `loading` dans les deps relancerait l'effet
  // (et tuerait le fetch via le cleanup) avant sa résolution.
  useEffect(() => {
    if (!open || fetchedRef.current) return
    fetchedRef.current = true
    setLoading(true)
    ;(async () => {
      try {
        const r = await api.agent.readClaudeMd()
        setText(r.content || '')
        setOriginal(r.content || '')
      } catch (e) {
        setError(e.message || 'Erreur de chargement')
      } finally {
        setLoading(false)
      }
    })()
  }, [open])

  const dirty = text !== original

  // Autosave on blur (règle « autosave partout » — pas de bouton Enregistrer).
  async function save() {
    if (!dirty || saving) return
    setSaving(true)
    setError(null)
    try {
      await api.agent.saveClaudeMd(text)
      setOriginal(text)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
    } catch (e) {
      setError(e.message || 'Erreur d\'enregistrement')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="mb-6 bg-white border border-slate-200 rounded-xl p-3.5 shadow-sm">
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-2 text-left">
        <FileText size={15} className="text-brand-500" />
        <span className="text-sm font-medium text-slate-700 flex-1">Instructions projet (CLAUDE.md)</span>
        {saving
          ? <Loader2 size={13} className="text-slate-400 animate-spin" />
          : saved
            ? <span className="text-[11px] text-emerald-600 font-medium">Enregistré</span>
            : dirty && open && <span className="text-[11px] text-slate-400">Modifié</span>}
        {open ? <ChevronUp size={14} className="text-slate-400" /> : <ChevronDown size={14} className="text-slate-400" />}
      </button>
      {open && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-slate-400">
            Le contexte et les règles du projet, lus à chaque activité de l'agent. Enregistré automatiquement à la sortie du champ.
          </p>
          <div className="flex items-start gap-2 px-3 py-2 rounded-md bg-amber-50 border border-amber-200 text-amber-800 text-[11px]">
            <AlertTriangle size={13} className="flex-shrink-0 mt-0.5" />
            <span>
              Ce fichier est versionné : un déploiement (<code>git pull</code>) peut écraser des modifications non committées. Pense à committer après une édition importante.
            </span>
          </div>
          {error && (
            <div className="px-3 py-2 rounded-md bg-red-50 border border-red-200 text-red-700 text-[11px]" data-testid="claude-md-error">{error}</div>
          )}
          {loading ? (
            <div className="flex items-center gap-2 text-slate-400 text-sm py-6"><Loader2 size={16} className="animate-spin" /> Chargement…</div>
          ) : (
            <textarea
              value={text}
              onChange={e => setText(e.target.value)}
              onBlur={save}
              data-testid="claude-md-textarea"
              rows={24}
              placeholder="Instructions projet…"
              className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900 placeholder-slate-400 font-mono leading-relaxed resize-y focus:outline-none focus:border-brand-400 focus:ring-2 focus:ring-brand-500/20"
            />
          )}
        </div>
      )}
    </div>
  )
}

// ─── Main content ─────────────────────────────────────────────────────────────
export function AgentContent() {
  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(true)
  const [settings, setSettings] = useState({ enabled: false })
  const [promptDefaults, setPromptDefaults] = useState({})
  const [backlog, setBacklog] = useState([])
  const [activity, setActivity] = useState(null)
  const [streamData, setStreamData] = useState({})
  const [settingsOpen, setSettingsOpen] = useState(false)
  const fetchedStreamRef = useRef(new Set())
  const { showToast } = useToast()
  const { user } = useAuth()

  const load = useCallback(async () => {
    try {
      const [t, s, b] = await Promise.all([api.agent.listTasks(), api.agent.getSettings(), api.agent.listBacklog()])
      setTasks(t); setSettings(s); setBacklog(b)
      if (s.defaults) setPromptDefaults(s.defaults)
    } catch {
      showToast('Erreur chargement de l\'agent', 'error')
    } finally { setLoading(false) }
  }, [showToast])

  useEffect(() => { load() }, [load])

  // Runner status poll
  useEffect(() => {
    async function fetchStatus() {
      try {
        const token = localStorage.getItem('erp_token')
        const res = await fetch('/erp/api/agent/runner/status', { headers: { Authorization: `Bearer ${token}` } })
        if (res.ok) { const d = await res.json(); setActivity(d.busy ? d.activity : null) }
      } catch {}
    }
    fetchStatus()
    const i = setInterval(fetchStatus, 5000)
    return () => clearInterval(i)
  }, [])

  // WS: task updates
  useEffect(() => {
    function onTask(e) {
      const u = e.detail
      setTasks(prev => {
        const idx = prev.findIndex(t => t.id === u.id)
        if (idx === -1) return [u, ...prev]
        const next = [...prev]; next[idx] = u; return next
      })
    }
    function onStream(e) {
      const { taskId, chunk } = e.detail
      setStreamData(prev => ({ ...prev, [taskId]: [...(prev[taskId] || []), chunk] }))
    }
    function onSettings(e) { setSettings(e.detail) }
    // Invalider AVANT le re-fetch, sinon le cache prefetch (TTL 30 s) ressert la
    // version « generating » et la fiche ne passe jamais à « Correctif proposé ».
    function onBacklog() { invalidate('/agent/backlog'); api.agent.listBacklog().then(setBacklog).catch(() => {}) }
    window.addEventListener('agent:task:updated', onTask)
    window.addEventListener('agent:task:stream', onStream)
    window.addEventListener('agent:settings:updated', onSettings)
    window.addEventListener('agent:backlog:updated', onBacklog)
    return () => {
      window.removeEventListener('agent:task:updated', onTask)
      window.removeEventListener('agent:task:stream', onStream)
      window.removeEventListener('agent:settings:updated', onSettings)
      window.removeEventListener('agent:backlog:updated', onBacklog)
    }
  }, [])

  // Fetch stream buffers for in_progress / blocked (les cartes terminées
  // n'affichent plus le journal d'exécution — inutile de le télécharger).
  useEffect(() => {
    const relevant = tasks.filter(t => ['in_progress', 'blocked'].includes(t.status))
    for (const task of relevant) {
      if (fetchedStreamRef.current.has(task.id)) continue
      fetchedStreamRef.current.add(task.id)
      const token = localStorage.getItem('erp_token')
      fetch(`/erp/api/agent/tasks/${task.id}/stream-log`, { headers: { Authorization: `Bearer ${token}` } })
        .then(r => r.json())
        .then(data => { if (data.chunks?.length) setStreamData(prev => ({ ...prev, [task.id]: data.chunks })) })
        .catch(() => {})
    }
  }, [tasks])

  async function handleUpdate(id, patch) {
    try {
      const u = await api.agent.updateTask(id, patch)
      setTasks(prev => prev.map(t => t.id === id ? u : t))
    } catch { showToast('Erreur mise à jour', 'error') }
  }
  async function handleDelete(id) {
    try { await api.agent.deleteTask(id); setTasks(prev => prev.filter(t => t.id !== id)) }
    catch { showToast('Erreur suppression', 'error') }
  }
  async function handleSend(id, text) {
    try {
      const u = await api.agent.sendMessage(id, text)
      setTasks(prev => prev.map(t => t.id === id ? u : t))
    } catch { showToast('Erreur envoi message', 'error') }
  }
  async function toggleAgent() {
    try {
      const s = await api.agent.saveSettings({ enabled: !settings.enabled })
      setSettings(s)
      showToast(s.enabled ? 'Agent activé' : 'Agent en pause', s.enabled ? 'success' : 'info')
    } catch { showToast('Erreur', 'error') }
  }
  async function approveSuggestion(item, comment) {
    try {
      const { item: updated, task } = await api.agent.approveBacklog(item.id, comment)
      setBacklog(prev => prev.map(i => i.id === item.id ? updated : i))
      if (task) setTasks(prev => prev.some(t => t.id === task.id) ? prev : [task, ...prev])
      showToast('Correctif approuvé — l\'agent va l\'implémenter', 'success')
    } catch { showToast('Erreur lors de l\'approbation', 'error') }
  }
  async function retrySuggestion(item) {
    try {
      const updated = await api.agent.retryBacklog(item.id)
      setBacklog(prev => prev.map(i => i.id === item.id ? updated : i))
    } catch { showToast('Erreur lors de la relance', 'error') }
  }
  async function deleteSuggestion(item, task) {
    if (task?.status === 'in_progress') {
      showToast('Implémentation en cours — impossible de supprimer', 'error')
      return
    }
    try {
      if (task) { await api.agent.deleteTask(task.id); setTasks(prev => prev.filter(t => t.id !== task.id)) }
      await api.agent.deleteBacklog(item.id)
      setBacklog(prev => prev.filter(i => i.id !== item.id))
    } catch { showToast('Erreur lors de la suppression', 'error') }
  }
  async function savePromptField(key, value) {
    try {
      const s = await api.agent.saveSettings({ [key]: value })
      setSettings(prev => ({ ...prev, ...s }))
    } catch { showToast('Erreur enregistrement du prompt', 'error') }
  }
  async function handleAutoApproveChange(value) {
    try {
      const s = await api.agent.saveSettings({ autoApprove: value })
      setSettings(prev => ({ ...prev, ...s }))
    } catch { showToast('Erreur enregistrement', 'error') }
  }

  // Fiches unifiées : chaque suggestion est jointe à sa tâche d'implémentation.
  const taskById = new Map(tasks.map(t => [t.id, t]))
  const fiches = backlog
    .map(item => ({ item, task: item.task_id ? taskById.get(item.task_id) || null : null }))
    .sort((a, b) => (b.item.created_at || '').localeCompare(a.item.created_at || ''))

  // Plus de section « en attente » : les suggestions sont implémentées immédiatement.
  // Les fiches sans tâche (transitoires) ou bloquées restent visibles dans « En cours »,
  // bloquées en tête pour attirer l'attention.
  const enCours = fiches.filter(f => !f.task || ['approved', 'in_progress', 'blocked'].includes(f.task.status))
    .sort((a, b) => {
      const rank = f => (f.task?.status === 'blocked' ? 0 : 1)
      return (rank(a) - rank(b)) || (b.item.created_at || '').localeCompare(a.item.created_at || '')
    })
  const implantees = fiches.filter(f => f.task && ['done', 'rejected'].includes(f.task.status))

  // Tâches hors fiches : sous-tâches internes (créées par l'agent en cours d'exécution)
  // et tâches historiques sans suggestion liée.
  const linkedTaskIds = new Set(backlog.map(i => i.task_id).filter(Boolean))
  const otherTasks = tasks.filter(t => !linkedTaskIds.has(t.id))
    .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))

  const activityLabel = activity === 'execution' ? 'Code en cours…' : activity === 'conversation' ? 'Répond…' : null

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 bg-gradient-to-br from-brand-500/20 to-emerald-500/10 border border-brand-200 rounded-xl flex items-center justify-center flex-shrink-0">
            <Bot size={20} className="text-brand-500" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-slate-900 leading-tight">Agent autonome</h1>
            <div className="flex items-center gap-1.5 mt-0.5">
              {activityLabel
                ? <><Loader2 size={10} className="text-amber-500 animate-spin" /><p className="text-amber-600 text-xs font-medium">{activityLabel}</p></>
                : settings.enabled
                  ? <><span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /><p className="text-slate-400 text-xs">Actif — implémente les correctifs approuvés</p></>
                  : <><span className="w-1.5 h-1.5 rounded-full bg-slate-300" /><p className="text-slate-400 text-xs">En pause</p></>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {/* File de prompts propre à la section Agent (distincte de celle de
              l'Espace finance), avec suggestions et idées. */}
          <Link
            to="/agent/travaux"
            data-testid="agent-travaux-link"
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors bg-white hover:bg-slate-50 border border-slate-200 text-slate-600"
            title="File de prompts de l'agent, suggestions de Claude et idées"
          >
            <ListChecks size={15} />
            <span className="hidden sm:inline">Travaux de l'agent</span>
          </Link>
          {/* Réglages de l'agent — ouverts dans une modale dédiée */}
          <button
            onClick={() => setSettingsOpen(true)}
            data-testid="agent-settings-button"
            className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors bg-white hover:bg-slate-50 border border-slate-200 text-slate-600"
            title="Réglages de l'agent (prompts, instructions projet)"
          >
            <Settings size={15} />
            <span className="hidden sm:inline">Réglages</span>
          </button>
          {/* Global ON/OFF toggle */}
          <button
            onClick={toggleAgent}
            className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${settings.enabled ? 'bg-emerald-600 hover:bg-emerald-500 text-white' : 'bg-slate-200 hover:bg-slate-300 text-slate-600'}`}
            title="Frein d'urgence : OFF = l'agent ne génère ni ne code"
          >
            <Power size={15} />
            <span className="hidden sm:inline">{settings.enabled ? 'ON' : 'OFF'}</span>
          </button>
        </div>
      </div>

      {/* Utilisation Claude — en haut de la page (session 5 h + semaine 7 j) */}
      <ClaudeUsageBar />

      {loading ? (
        <div className="flex items-center justify-center py-16"><Loader2 size={20} className="animate-spin text-slate-400" /></div>
      ) : (
        <>
          {/* Deux colonnes côte à côte : implantées à gauche, en cours à droite.
              Sur mobile (1 colonne) « En cours » remonte en premier (plus actionnable)
              via lg:order — l'ordre DOM garde enCours en tête. */}
          {(enCours.length > 0 || implantees.length > 0) && (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 items-start" data-testid="agent-columns">
              <div className="lg:order-2" data-testid="col-en-cours">
                <Zone title="En cours d'implémentation" count={enCours.length}>
                  {enCours.length > 0 ? (
                    <div className="space-y-2.5">
                      {enCours.map(({ item, task }) => (
                        <SuggestionCard key={item.id} item={item} task={task}
                          onApprove={approveSuggestion} onRetry={retrySuggestion} onDelete={deleteSuggestion}
                          onRelaunch={t => handleUpdate(t.id, { status: 'approved' })}
                          onRate={(id, rating) => handleUpdate(id, { rating })}
                          streamChunks={task ? streamData[task.id] : undefined}
                          defaultExpanded={!task || task.status === 'in_progress'}
                          autoApprove={settings.autoApprove}
                          onAutoApproveChange={handleAutoApproveChange} />
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-slate-400 py-2">Aucune implémentation en cours.</p>
                  )}
                </Zone>
              </div>
              <div className="lg:order-1" data-testid="col-implantees">
                <Zone title="Implantées" count={implantees.length}>
                  {implantees.length > 0 ? (
                    <div className="space-y-2.5">
                      {implantees.map(({ item, task }) => (
                        <SuggestionCard key={item.id} item={item} task={task}
                          onApprove={approveSuggestion} onRetry={retrySuggestion} onDelete={deleteSuggestion}
                          onRelaunch={t => handleUpdate(t.id, { status: 'approved' })}
                          onRate={(id, rating) => handleUpdate(id, { rating })}
                          streamChunks={streamData[task.id]}
                          autoApprove={settings.autoApprove}
                          onAutoApproveChange={handleAutoApproveChange} />
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-slate-400 py-2">Aucune carte implantée pour l'instant.</p>
                  )}
                </Zone>
              </div>
            </div>
          )}

          {otherTasks.length > 0 && (
            <Zone title="Sous-tâches de l'agent" count={otherTasks.length}>
              <div className="space-y-2.5">
                {otherTasks.map(t => (
                  <ProposalCard key={t.id} task={t} onUpdate={handleUpdate} onDelete={handleDelete} onSend={handleSend} streamChunks={streamData[t.id]} defaultExpanded={t.status === 'in_progress'} />
                ))}
              </div>
            </Zone>
          )}

          {/* Réglages : prompts éditables + instructions projet, dans une modale
              ouverte via le bouton « Réglages » du header. */}
          <Modal isOpen={settingsOpen} onClose={() => setSettingsOpen(false)} title="Réglages de l'agent" size="xl">
            <PromptEditorPanel
              testid="general"
              title="Prompt général"
              description="Préambule injecté en tête de CHAQUE activité de l'agent (proposition instantanée, discussion, exécution). C'est le {{general}} des modèles ci-dessous. Enregistré automatiquement à la sortie du champ."
              value={settings.generalPrompt}
              defaultValue={promptDefaults.generalPrompt}
              rows={8}
              onSave={v => savePromptField('generalPrompt', v)}
            />
            <PromptEditorPanel
              testid="instant"
              title="Prompt — proposition instantanée"
              description="Le prompt envoyé dès qu'une suggestion est soumise (bulle d'aide ou page agent) pour proposer un correctif immédiat, sans lecture du code."
              value={settings.instantPrompt}
              defaultValue={promptDefaults.instantPrompt}
              rows={12}
              placeholders={[
                ['{{general}}', 'le prompt général'],
                ['{{text}}', 'le texte de la suggestion'],
                ['{{context}}', 'la page d\'où vient le signalement'],
              ]}
              onSave={v => savePromptField('instantPrompt', v)}
            />
            <PromptEditorPanel
              testid="conversation"
              title="Prompt — discussion d'une proposition"
              description="Le prompt envoyé quand tu discutes d'une sous-tâche dans le fil (réponse en lecture seule, sans coder)."
              value={settings.conversationPrompt}
              defaultValue={promptDefaults.conversationPrompt}
              rows={14}
              placeholders={[
                ['{{general}}', 'le prompt général'],
                ['{{proposal}}', 'titre de la proposition discutée'],
                ['{{why}}', 'ligne « Pourquoi » (si renseignée)'],
                ['{{zone}}', 'ligne « Zone visée » (si renseignée)'],
                ['{{thread}}', 'le fil de discussion humain / agent'],
              ]}
              onSave={v => savePromptField('conversationPrompt', v)}
            />
            <PromptEditorPanel
              testid="execution"
              title="Prompt — exécution (codage)"
              description="Le prompt envoyé quand un correctif est approuvé et que l'agent code réellement (lecture/écriture du repo)."
              value={settings.executionPrompt}
              defaultValue={promptDefaults.executionPrompt}
              rows={16}
              placeholders={[
                ['{{general}}', 'le prompt général'],
                ['{{brief}}', 'le brief de la tâche (signalement, correctif approuvé, commentaire)'],
                ['{{internalSecret}}', 'secret d\'auth pour créer des sous-tâches via l\'API'],
              ]}
              onSave={v => savePromptField('executionPrompt', v)}
            />
            <PromptEditorPanel
              testid="question"
              title="Prompt — question (réponse sans implémentation)"
              description="Le prompt envoyé quand la demande soumise est une question : l'agent explore le code en lecture seule et répond dans le compte-rendu de la carte, sans rien implémenter."
              value={settings.questionPrompt}
              defaultValue={promptDefaults.questionPrompt}
              rows={12}
              placeholders={[
                ['{{general}}', 'le prompt général'],
                ['{{brief}}', 'la question de l\'utilisateur (avec auteur et page d\'origine)'],
              ]}
              onSave={v => savePromptField('questionPrompt', v)}
            />
            {user?.role === 'admin' && <ClaudeMdPanel />}
          </Modal>
        </>
      )}
    </div>
  )
}

export default function Agent() {
  return <Layout><AgentContent /></Layout>
}
