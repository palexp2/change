import { useState, useEffect, useCallback, useRef } from 'react'
import { Bot, Plus, CheckCircle, XCircle, Clock, Loader2, AlertTriangle, ChevronDown, ChevronUp, Trash2, Send, Terminal, FileText, Edit3, Search, Zap, ListTodo, Activity, Maximize2, Minimize2 } from 'lucide-react'
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

const STATUS_ORDER = ['in_progress', 'approved', 'pending', 'blocked', 'done', 'rejected']

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

// ─── Chat message renderer ───────────────────────────────────────────────────
function ChatMessage({ msg }) {
  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] bg-indigo-600 text-white rounded-2xl rounded-tr-sm px-4 py-2.5 text-sm whitespace-pre-wrap shadow-sm">
          {msg.text}
        </div>
      </div>
    )
  }

  // assistant message — array of blocks
  return (
    <div className="flex gap-3">
      <div className="w-7 h-7 rounded-xl bg-gradient-to-br from-indigo-500/20 to-violet-500/10 border border-indigo-200 flex items-center justify-center flex-shrink-0 mt-0.5">
        <Bot size={14} className="text-indigo-500" />
      </div>
      <div className="flex-1 space-y-2">
        {msg.blocks.map((block, i) => {
          if (block.type === 'text') {
            return (
              <p key={i} className="text-slate-700 text-sm whitespace-pre-wrap leading-relaxed">
                {block.text}
              </p>
            )
          }
          if (block.type === 'tool_use') {
            return (
              <div key={i} className="flex items-center gap-2 text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 font-mono w-fit max-w-full">
                <span className="text-indigo-400">{toolIcon(block.name)}</span>
                <span className="text-indigo-600 font-semibold">{block.name}</span>
                {block.input && (
                  <span className="text-slate-400 truncate max-w-[360px]">
                    {typeof block.input === 'string'
                      ? block.input
                      : block.input.command || block.input.file_path || block.input.pattern || JSON.stringify(block.input).slice(0, 80)}
                  </span>
                )}
              </div>
            )
          }
          return null
        })}
      </div>
    </div>
  )
}

// ─── Chat tab ────────────────────────────────────────────────────────────────
function ChatTab() {
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [running, setRunning] = useState(false)
  const bottomRef = useRef(null)
  const textareaRef = useRef(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function send() {
    const text = input.trim()
    if (!text || running) return
    setInput('')
    setRunning(true)

    setMessages(prev => [...prev, { role: 'user', text }])

    const token = localStorage.getItem('erp_token')
    const res = await fetch('/erp/api/agent/claude/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ message: text }),
    })

    if (!res.ok) {
      setMessages(prev => [...prev, { role: 'assistant', blocks: [{ type: 'text', text: 'Erreur lors de la connexion au CLI.' }] }])
      setRunning(false)
      return
    }

    setMessages(prev => [...prev, { role: 'assistant', blocks: [] }])

    try {
      const body = await res.text()
      const blocks = []

      for (const line of body.split('\n')) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6).trim()
        if (!raw) continue
        let evt
        try { evt = JSON.parse(raw) } catch { continue }

        if (evt.type === 'assistant' && evt.message?.content) {
          for (const block of evt.message.content) {
            if (block.type === 'text' && block.text) {
              const last = blocks[blocks.length - 1]
              if (last?.type === 'text') {
                last.text += block.text
              } else {
                blocks.push({ type: 'text', text: block.text })
              }
            } else if (block.type === 'tool_use') {
              blocks.push({ type: 'tool_use', name: block.name, input: block.input })
            }
          }
        }
      }

      setMessages(prev => {
        const next = [...prev]
        next[next.length - 1] = {
          role: 'assistant',
          blocks: blocks.length ? blocks : [{ type: 'text', text: '(pas de réponse)' }],
        }
        return next
      })
    } finally {
      setRunning(false)
    }
  }

  function handleKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="flex flex-col h-[calc(100vh-240px)] min-h-[400px]">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto space-y-4 py-4 px-1">
        {messages.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-center gap-3">
            <div className="w-14 h-14 bg-gradient-to-br from-indigo-500/15 to-violet-500/10 border border-indigo-200 rounded-2xl flex items-center justify-center">
              <Bot size={26} className="text-indigo-500" />
            </div>
            <div>
              <p className="text-slate-700 text-sm font-medium">Claude Code</p>
              <p className="text-slate-400 text-xs mt-1">Décris ce que tu veux modifier dans l'ERP</p>
            </div>
            <div className="flex gap-2 mt-2 flex-wrap justify-center">
              {['Ajouter un champ à une table', 'Corriger un bug', 'Créer une nouvelle page'].map(s => (
                <button
                  key={s}
                  onClick={() => setInput(s)}
                  className="text-xs px-3 py-1.5 rounded-lg bg-white border border-slate-200 text-slate-500 hover:text-slate-700 hover:border-indigo-300 transition-all shadow-sm"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}
        {messages.map((msg, i) => (
          <ChatMessage key={i} msg={msg} />
        ))}
        {running && messages[messages.length - 1]?.role !== 'assistant' && (
          <div className="flex gap-3">
            <div className="w-7 h-7 rounded-xl bg-gradient-to-br from-indigo-500/20 to-violet-500/10 border border-indigo-200 flex items-center justify-center flex-shrink-0">
              <Loader2 size={14} className="text-indigo-500 animate-spin" />
            </div>
            <div className="flex items-center gap-1.5 pt-1">
              <span className="w-1.5 h-1.5 rounded-full bg-slate-300 animate-bounce" style={{ animationDelay: '0ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-slate-300 animate-bounce" style={{ animationDelay: '150ms' }} />
              <span className="w-1.5 h-1.5 rounded-full bg-slate-300 animate-bounce" style={{ animationDelay: '300ms' }} />
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="border-t border-slate-200 pt-4">
        <div className="flex gap-2 items-end">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKey}
            disabled={running}
            rows={2}
            placeholder="Dis à Claude ce que tu veux faire… (Entrée pour envoyer)"
            className="flex-1 bg-white border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 resize-none focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 disabled:opacity-50 transition-all shadow-sm"
          />
          <button
            onClick={send}
            disabled={running || !input.trim()}
            className="flex-shrink-0 w-10 h-10 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-30 disabled:cursor-not-allowed text-white rounded-xl flex items-center justify-center transition-all shadow-sm"
          >
            {running ? <Loader2 size={15} className="animate-spin" /> : <Send size={15} />}
          </button>
        </div>
        <p className="text-xs text-slate-400 mt-2">Claude a accès en lecture/écriture aux fichiers de l'ERP</p>
      </div>
    </div>
  )
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
            <span className="text-slate-900 text-sm font-medium">{task.title}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cfg.color} bg-current/10`}>
              {cfg.label}
            </span>
          </div>
          {task.description && !expanded && (
            <p className="text-slate-500 text-xs mt-1 truncate">{task.description}</p>
          )}
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
          {task.description && (
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
  const [form, setForm] = useState({ title: '', description: '' })
  const [saving, setSaving] = useState(false)

  async function handleSubmit(e) {
    e.preventDefault()
    if (!form.title.trim()) return
    setSaving(true)
    await onAdd(form)
    setSaving(false)
  }

  return (
    <form onSubmit={handleSubmit} className="bg-white border border-slate-200 rounded-xl p-4 space-y-3 shadow-sm">
      <input
        autoFocus
        value={form.title}
        onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
        placeholder="Titre de la tâche…"
        className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 transition-all"
        required
      />
      <textarea
        value={form.description}
        onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
        placeholder="Description détaillée (optionnel)…"
        rows={3}
        className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 placeholder-slate-400 resize-none focus:outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-500/20 transition-all"
      />
      <div className="flex gap-2 justify-end">
        <button type="button" onClick={onCancel} className="btn-secondary text-sm">Annuler</button>
        <button type="submit" disabled={saving || !form.title.trim()} className="btn-primary text-sm">
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
  const [filter, setFilter] = useState('active')
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

  const activeStatuses = ['pending', 'approved', 'in_progress', 'blocked']
  const filtered = filter === 'active'
    ? tasks.filter(t => activeStatuses.includes(t.status))
    : filter === 'done'
    ? tasks.filter(t => t.status === 'done' || t.status === 'rejected')
    : tasks

  const grouped = STATUS_ORDER.reduce((acc, s) => {
    const group = filtered.filter(t => t.status === s)
    if (group.length) acc[s] = group
    return acc
  }, {})

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
        {statCards.map(({ key, label, color, border }) => (
          <div key={key} className={`bg-white border border-slate-200 border-t-2 ${border} rounded-xl p-3 text-center shadow-sm`}>
            <div className={`text-2xl font-bold tabular-nums ${color}`}>{counts[key]}</div>
            <div className="text-xs text-slate-400 mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      {/* New task form */}
      {showForm && (
        <div className="mb-5">
          <NewTaskForm onAdd={handleAdd} onCancel={() => setShowForm(false)} />
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex gap-0.5 bg-slate-100 border border-slate-200 p-1 rounded-lg">
          {[
            { key: 'active', label: 'Actives' },
            { key: 'all',    label: 'Toutes' },
            { key: 'done',   label: 'Terminées' },
          ].map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`px-3 py-1.5 text-sm rounded-md font-medium transition-all ${
                filter === key
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {!showForm && (
          <button
            onClick={() => setShowForm(true)}
            className="flex items-center gap-1.5 text-sm px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-lg font-medium transition-colors shadow-sm"
          >
            <Plus size={14} />
            Nouvelle tâche
          </button>
        )}
      </div>

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
          <p className="text-slate-500 text-sm">Aucune tâche</p>
          {filter === 'active' && (
            <button
              onClick={() => setShowForm(true)}
              className="mt-3 text-indigo-600 hover:text-indigo-500 text-sm underline underline-offset-2 transition-colors"
            >
              Proposer la première tâche
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-5">
          {Object.entries(grouped).map(([status, group]) => (
            <div key={status}>
              <div className="flex items-center gap-2 mb-2">
                <span className={`w-1.5 h-1.5 rounded-full ${STATUS_CONFIG[status]?.dot || 'bg-slate-400'}`} />
                <h2 className={`text-xs font-semibold uppercase tracking-wider ${STATUS_CONFIG[status]?.color || 'text-slate-500'}`}>
                  {STATUS_CONFIG[status]?.label}
                  <span className="ml-1.5 opacity-50 normal-case font-normal">({group.length})</span>
                </h2>
              </div>
              <div className="space-y-2">
                {group.map(task => (
                  <TaskCard
                    key={task.id}
                    task={task}
                    onUpdate={handleUpdate}
                    onDelete={handleDelete}
                    streamChunks={streamData[task.id]}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function Agent() {
  const [tab, setTab] = useState('tasks')
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
    <Layout>
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

        {/* Tabs */}
        <div className="flex gap-0.5 mb-6 bg-slate-100 border border-slate-200 p-1 rounded-xl w-fit">
          {[
            { key: 'tasks', label: 'File de tâches' },
            { key: 'chat',  label: 'Chat direct' },
          ].map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`px-4 py-2 text-sm rounded-lg font-medium transition-all ${
                tab === key
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === 'tasks' && <TasksTab />}
        {tab === 'chat'  && <ChatTab />}
      </div>
    </Layout>
  )
}
