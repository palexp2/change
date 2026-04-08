import { useState, useEffect, useCallback, useRef } from 'react'
import { Bot, Plus, CheckCircle, XCircle, Clock, Loader2, AlertTriangle, ChevronDown, ChevronUp, Trash2, Terminal, FileText, Edit3, Search, Zap, ListTodo, Activity, Maximize2, Minimize2 } from 'lucide-react'
import { api } from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { useToast } from '../contexts/ToastContext.jsx'

const STATUS_CONFIG = {
  pending:     { label: 'En attente',    color: 'text-slate-500',   bg: 'bg-slate-50',      border: 'border-l-slate-400',    dot: 'bg-slate-400',    icon: Clock },
  approved:    { label: 'Approuvée',     color: 'text-sky-600',     bg: 'bg-sky-50',        border: 'border-l-sky-500',      dot: 'bg-sky-500',      icon: CheckCircle },
  in_progress: { label: 'En cours',      color: 'text-amber-600',   bg: 'bg-amber-50',      border: 'border-l-amber-500',    dot: 'bg-amber-500',    icon: Loader2 },
  done:        { label: 'Terminée',      color: 'text-emerald-600', bg: 'bg-emerald-50',    border: 'border-l-emerald-500',  dot: 'bg-emerald-500',  icon: CheckCircle },
  blocked:     { label: 'Bloquée',       color: 'text-red-600',     bg: 'bg-red-50',        border: 'border-l-red-500',      dot: 'bg-red-500',      icon: AlertTriangle },
  rejected:    { label: 'Rejetée',       color: 'text-slate-400',   bg: 'bg-slate-50',      border: 'border-l-slate-300',    dot: 'bg-slate-300',    icon: XCircle },
}

// ─── Tool icon helper ────────────────────────────────────────────────────────
function toolIcon(name) {
  if (!name) return <Terminal size={11} />
  const n = name.toLowerCase()
  if (n === 'bash') return <Terminal size={11} />
  if (n === 'read') return <FileText size={11} />
  if (n === 'write' || n === 'edit') return <Edit3 size={11} />
  if (n === 'glob' || n === 'grep') return <Search size={11} />
  return <Terminal size={11} />
}

// ─── Live stream display ──────────────────────────────────────────────────────
function TaskStream({ chunks, done = false }) {
  const bottomRef = useRef(null)
  const scrollRef = useRef(null)
  const [expanded, setExpanded] = useState(false)
  const [autoScroll, setAutoScroll] = useState(true)

  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: 'instant' })
    }
  }, [chunks?.length, autoScroll])

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
        {done
          ? <Terminal size={10} className="text-slate-500" />
          : <Activity size={10} className="text-amber-400 animate-pulse" />
        }
        <span className="text-xs text-slate-400 font-medium flex-1">
          {done ? 'Journal d\'exécution' : 'Stream Claude Code'}
        </span>
        {chunks?.length > 0 && (
          <span className="text-xs text-slate-600 tabular-nums mr-1">{chunks.length} evt</span>
        )}
        {!autoScroll && !done && (
          <button
            onClick={() => { setAutoScroll(true); bottomRef.current?.scrollIntoView({ behavior: 'smooth' }) }}
            className="text-xs text-amber-400 hover:text-amber-300 mr-1.5"
          >↓ bas</button>
        )}
        <button
          onClick={() => setExpanded(e => !e)}
          className="text-slate-600 hover:text-slate-400 transition-colors"
          title={expanded ? 'Réduire' : 'Agrandir'}
        >
          {expanded ? <Minimize2 size={10} /> : <Maximize2 size={10} />}
        </button>
      </div>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className={`${heightClass} overflow-y-auto p-2.5 space-y-0.5 font-mono text-xs transition-all duration-200`}
      >
        {!chunks?.length ? (
          <div className="flex items-center gap-2 text-slate-500 py-1">
            <Loader2 size={9} className="animate-spin" />
            <span>En attente des premières actions…</span>
          </div>
        ) : (
          chunks.map((chunk, i) => {
            if (chunk.kind === 'tool') {
              return (
                <div key={i} className="flex items-center gap-1.5 leading-relaxed">
                  <span className="text-slate-600 flex-shrink-0">›</span>
                  <span className="text-indigo-400 flex-shrink-0 font-semibold">{chunk.name}</span>
                  {chunk.input && (
                    <span className="text-slate-400 truncate">{chunk.input}</span>
                  )}
                </div>
              )
            }
            if (chunk.kind === 'result') {
              return (
                <div key={i} className="ml-3 pl-2 border-l border-slate-700 text-slate-500 whitespace-pre-wrap leading-relaxed my-0.5 break-all">
                  {chunk.content}
                </div>
              )
            }
            if (chunk.kind === 'text') {
              return (
                <div key={i} className="text-emerald-400 whitespace-pre-wrap leading-relaxed py-0.5">
                  {chunk.text}
                </div>
              )
            }
            return null
          })
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}

// ─── Task components ─────────────────────────────────────────────────────────
function TaskCard({ task, onUpdate, onDelete, streamChunks }) {
  const [expanded, setExpanded] = useState(false)
  const [comment, setComment] = useState(task.user_comment || '')
  const [saving, setSaving] = useState(false)
  const cfg = STATUS_CONFIG[task.status] || STATUS_CONFIG.pending
  const Icon = cfg.icon

  async function saveComment() {
    if (comment === task.user_comment) return
    setSaving(true)
    await onUpdate(task.id, { user_comment: comment })
    setSaving(false)
  }

  const isActive = !['done', 'rejected'].includes(task.status)

  return (
    <div className={`rounded-xl border border-slate-200 border-l-2 ${cfg.border} ${cfg.bg} transition-all shadow-sm`}>
      <div className="flex items-start gap-3 p-4 cursor-pointer" onClick={() => setExpanded(s => !s)}>
        <Icon size={15} className={`mt-0.5 flex-shrink-0 ${cfg.color} ${task.status === 'in_progress' ? 'animate-spin' : ''}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-slate-900 text-sm font-medium truncate">{task.description}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cfg.color} bg-current/10`}>
              {cfg.label}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {isActive && task.status === 'pending' && (
            <button
              onClick={e => { e.stopPropagation(); onUpdate(task.id, { status: 'approved' }) }}
              className="text-xs px-2.5 py-1 bg-sky-600 hover:bg-sky-500 text-white rounded-lg font-medium transition-colors"
            >
              Approuver
            </button>
          )}
          {isActive && (task.status === 'approved' || task.status === 'pending') && (
            <button
              onClick={e => { e.stopPropagation(); onUpdate(task.id, { status: 'rejected' }) }}
              className="text-xs px-2.5 py-1 bg-white hover:bg-slate-50 border border-slate-200 text-slate-600 rounded-lg font-medium transition-colors"
            >
              Rejeter
            </button>
          )}
          <button
            onClick={e => { e.stopPropagation(); onDelete(task.id) }}
            className="text-slate-400 hover:text-red-500 p-1.5 rounded-lg transition-colors hover:bg-red-50"
          >
            <Trash2 size={13} />
          </button>
          {expanded ? <ChevronUp size={14} className="text-slate-400" /> : <ChevronDown size={14} className="text-slate-400" />}
        </div>
      </div>

      {/* Live stream — always visible when in_progress */}
      {task.status === 'in_progress' && (
        <div className="px-4 pb-3">
          <TaskStream chunks={streamChunks} />
        </div>
      )}

      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-slate-200/80 pt-3">
          {task.description && task.description.length > 80 && (
            <p className="text-slate-600 text-sm whitespace-pre-wrap">{task.description}</p>
          )}
          {/* Stream replay for completed/blocked tasks (while buffer is still in memory) */}
          {(task.status === 'done' || task.status === 'blocked') && streamChunks?.length > 0 && (
            <TaskStream chunks={streamChunks} done />
          )}
          {task.agent_result && (
            <div className="bg-white rounded-lg p-3 border border-slate-200">
              <p className="text-xs text-slate-400 font-medium uppercase tracking-wider mb-1.5">Résultat agent</p>
              <p className="text-slate-700 text-xs whitespace-pre-wrap font-mono leading-relaxed">{task.agent_result}</p>
            </div>
          )}
          <div>
            <label className="text-xs text-slate-400 font-medium uppercase tracking-wider block mb-1.5">
              Votre commentaire
            </label>
            <textarea
              value={comment}
              onChange={e => setComment(e.target.value)}
              onBlur={saveComment}
              rows={2}
              placeholder="Instructions, corrections, précisions…"
              className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900 placeholder-slate-400 resize-none focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 transition-all"
            />
            {saving && <span className="text-xs text-slate-400">Enregistrement…</span>}
          </div>
          {task.completed_at && (
            <p className="text-xs text-slate-400">
              Terminée le {new Date(task.completed_at).toLocaleString('fr-CA')}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

function NewTaskForm({ onAdd, onCancel }) {
  const [form, setForm] = useState({ description: '' })
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.description.trim()) return
    setSaving(true)
    await onAdd(form)
    setSaving(false)
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white border border-slate-200 rounded-xl p-4 space-y-3 shadow-sm">
      <textarea
        autoFocus
        value={form.description}
        onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
        placeholder="Description de la tâche…"
        rows={3}
        className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900 placeholder-slate-400 resize-none focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 transition-all"
        required
      />
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="btn-secondary text-sm">Annuler</button>
        <button type="submit" disabled={saving || !form.description.trim()} className="btn-primary text-sm">
          {saving ? 'Ajout…' : 'Ajouter la tâche'}
        </button>
      </div>
    </form>
  )
}

// ─── Tasks tab ────────────────────────────────────────────────────────────────
function TasksTab() {
  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [filter, setFilter] = useState(null)
  const [streamData, setStreamData] = useState({}) // taskId -> chunk[]
  const fetchedStreamRef = useRef(new Set())
  const { showToast } = useToast()

  const load = useCallback(async () => {
    try {
      const data = await api.agent.listTasks()
      setTasks(data)
    } catch {
      showToast('Erreur chargement des tâches', 'error')
    } finally {
      setLoading(false)
    }
  }, [showToast])

  useEffect(() => { load() }, [load])

  // Real-time task updates via WebSocket events dispatched by Layout
  useEffect(() => {
    function onTaskUpdate(e) {
      const updated = e.detail
      setTasks(prev => {
        const idx = prev.findIndex(t => t.id === updated.id)
        if (idx === -1) return [updated, ...prev]
        const next = [...prev]
        next[idx] = updated
        return next
      })
    }
    window.addEventListener('agent:task:updated', onTaskUpdate)
    return () => window.removeEventListener('agent:task:updated', onTaskUpdate)
  }, [])

  // Real-time stream chunks for in_progress tasks
  useEffect(() => {
    function onStream(e) {
      const { taskId, chunk } = e.detail
      setStreamData(prev => ({
        ...prev,
        [taskId]: [...(prev[taskId] || []), chunk],
      }))
    }
    window.addEventListener('agent:task:stream', onStream)
    return () => window.removeEventListener('agent:task:stream', onStream)
  }, [])

  // Fetch existing stream buffer for in_progress tasks (late arrivals / page refresh)
  // and for recently done/blocked tasks (buffer kept 2min after completion)
  useEffect(() => {
    const relevant = tasks.filter(t => ['in_progress', 'done', 'blocked'].includes(t.status))
    for (const task of relevant) {
      if (fetchedStreamRef.current.has(task.id)) continue
      fetchedStreamRef.current.add(task.id)
      const token = localStorage.getItem('erp_token')
      fetch(`/erp/api/agent/tasks/${task.id}/stream-log`, {
        headers: { Authorization: `Bearer ${token}` },
      })
        .then(r => r.json())
        .then(data => {
          if (data.chunks?.length > 0) {
            setStreamData(prev => ({ ...prev, [task.id]: data.chunks }))
          }
        })
        .catch(() => {})
    }
  }, [tasks])

  async function handleUpdate(id, patch) {
    try {
      const updated = await api.agent.updateTask(id, patch)
      setTasks(prev => prev.map(t => t.id === id ? updated : t))
    } catch {
      showToast('Erreur mise à jour', 'error')
    }
  }

  async function handleDelete(id) {
    try {
      await api.agent.deleteTask(id)
      setTasks(prev => prev.filter(t => t.id !== id))
    } catch {
      showToast('Erreur suppression', 'error')
    }
  }

  async function handleAdd(form) {
    try {
      const task = await api.agent.createTask(form)
      setTasks(prev => [task, ...prev])
      setShowForm(false)
    } catch {
      showToast('Erreur création', 'error')
    }
  }

  const filtered = (filter
    ? tasks.filter(t => t.status === filter)
    : tasks.filter(t => ['pending', 'approved', 'in_progress', 'blocked'].includes(t.status))
  ).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))


  const counts = {
    pending:     tasks.filter(t => t.status === 'pending').length,
    approved:    tasks.filter(t => t.status === 'approved').length,
    in_progress: tasks.filter(t => t.status === 'in_progress').length,
    blocked:     tasks.filter(t => t.status === 'blocked').length,
    done:        tasks.filter(t => t.status === 'done').length,
  }

  const statCards = [
    { key: 'in_progress', label: 'En cours',   color: 'text-amber-600',   border: 'border-t-amber-500' },
    { key: 'pending',     label: 'En attente', color: 'text-slate-600',   border: 'border-t-slate-400' },
    { key: 'approved',    label: 'Approuvées', color: 'text-sky-600',     border: 'border-t-sky-500' },
    { key: 'blocked',     label: 'Bloquées',   color: 'text-red-600',     border: 'border-t-red-500' },
    { key: 'done',        label: 'Terminées',  color: 'text-emerald-600', border: 'border-t-emerald-500' },
  ]

  return (
    <div>
      {/* Stats */}
      <div className="grid grid-cols-5 gap-2.5 mb-6">
        {statCards.map(({ key, label, color, border }) => {
          const isActive = filter === key || (!filter && key !== 'done')
          return (
            <button
              key={key}
              onClick={() => setFilter(prev => prev === key ? null : key)}
              className={`bg-white border border-t-2 ${border} rounded-xl p-3 text-center shadow-sm transition-all cursor-pointer ${
                isActive
                  ? 'border-slate-300 ring-1 ring-indigo-200'
                  : 'border-slate-200 opacity-50 hover:opacity-75'
              }`}
            >
              <div className={`text-2xl font-bold tabular-nums ${color}`}>{counts[key]}</div>
              <div className="text-xs text-slate-400 mt-0.5">{label}</div>
            </button>
          )
        })}
      </div>

      {/* New task form */}
      {showForm && (
        <div className="mb-5">
          <NewTaskForm onAdd={handleAdd} onCancel={() => setShowForm(false)} />
        </div>
      )}

      {!showForm && (
        <div className="flex justify-end mb-4">
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-medium transition-colors shadow-sm"
          >
            <Plus size={14} />
            Nouvelle tâche
          </button>
        </div>
      )}

      {/* Task list */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 size={20} className="animate-spin text-slate-400" />
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-16">
          <div className="w-12 h-12 rounded-xl bg-slate-100 border border-slate-200 flex items-center justify-center mx-auto mb-3">
            <ListTodo size={22} className="text-slate-400" />
          </div>
          <p className="text-slate-500 text-sm">Aucune tâche{filter ? ` ${statCards.find(c => c.key === filter)?.label?.toLowerCase() || ''}` : ''}</p>
          {!filter && (
            <button
              onClick={() => setShowForm(true)}
              className="mt-3 text-indigo-600 hover:text-indigo-500 text-sm underline underline-offset-2 transition-colors"
            >
              Proposer la première tâche
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {filtered.map(task => (
            <TaskCard
              key={task.id}
              task={task}
              onUpdate={handleUpdate}
              onDelete={handleDelete}
              streamChunks={streamData[task.id]}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export function AgentContent() {
  const [runnerBusy, setRunnerBusy] = useState(false)

  // Poll runner status every 5s
  useEffect(() => {
    async function fetchStatus() {
      try {
        const token = localStorage.getItem('erp_token')
        const res = await fetch('/erp/api/agent/runner/status', {
          headers: { Authorization: `Bearer ${token}` },
        })
        if (res.ok) {
          const data = await res.json()
          setRunnerBusy(data.busy)
        }
      } catch {}
    }
    fetchStatus()
    const interval = setInterval(fetchStatus, 5000)
    return () => clearInterval(interval)
  }, [])

  // Update runner status from WebSocket task events
  useEffect(() => {
    function onTaskUpdate(e) {
      const task = e.detail
      if (task.status === 'in_progress') setRunnerBusy(true)
      else setRunnerBusy(false)
    }
    window.addEventListener('agent:task:updated', onTaskUpdate)
    return () => window.removeEventListener('agent:task:updated', onTaskUpdate)
  }, [])

  return (
      <div className="max-w-3xl mx-auto px-6 py-8">

        {/* Header */}
        <div className="flex items-center justify-between mb-7">
          <div className="flex items-center gap-3.5">
            <div className="w-10 h-10 bg-gradient-to-br from-indigo-500/20 to-violet-500/10 border border-indigo-200 rounded-xl flex items-center justify-center">
              <Bot size={20} className="text-indigo-500" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-slate-900 leading-tight">Agent autonome</h1>
              <div className="flex items-center gap-1.5 mt-0.5">
                {runnerBusy
                  ? <><Loader2 size={10} className="text-amber-500 animate-spin" /><p className="text-amber-600 text-xs font-medium">Exécution en cours…</p></>
                  : <><span className="w-1.5 h-1.5 rounded-full bg-emerald-400" /><p className="text-slate-400 text-xs">Prêt</p></>
                }
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-slate-500 bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 shadow-sm">
            <Zap size={11} className="text-amber-500" />
            <span>Claude Code</span>
          </div>
        </div>

        <TasksTab />
      </div>
  )
}

export default function Agent() {
  return <Layout><AgentContent /></Layout>
}
