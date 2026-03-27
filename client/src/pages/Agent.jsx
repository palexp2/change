import { useState, useEffect, useCallback } from 'react'
import { Bot, Plus, CheckCircle, XCircle, Clock, Loader2, AlertTriangle, ChevronDown, ChevronUp, Trash2 } from 'lucide-react'
import { api } from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { useToast } from '../contexts/ToastContext.jsx'

const STATUS_CONFIG = {
  pending:     { label: 'En attente',    color: 'text-slate-400',  bg: 'bg-slate-800',   icon: Clock },
  approved:    { label: 'Approuvée',     color: 'text-blue-400',   bg: 'bg-blue-900/40', icon: CheckCircle },
  in_progress: { label: 'En cours',      color: 'text-amber-400',  bg: 'bg-amber-900/40',icon: Loader2 },
  done:        { label: 'Terminée',      color: 'text-green-400',  bg: 'bg-green-900/40',icon: CheckCircle },
  blocked:     { label: 'Bloquée',       color: 'text-red-400',    bg: 'bg-red-900/40',  icon: AlertTriangle },
  rejected:    { label: 'Rejetée',       color: 'text-slate-500',  bg: 'bg-slate-800',   icon: XCircle },
}

const STATUS_ORDER = ['in_progress', 'approved', 'pending', 'blocked', 'done', 'rejected']

function TaskCard({ task, onUpdate, onDelete }) {
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
    <div className={`rounded-xl border border-slate-700/50 ${cfg.bg} transition-all`}>
      <div className="flex items-start gap-3 p-4 cursor-pointer" onClick={() => setExpanded(s => !s)}>
        <Icon size={16} className={`mt-0.5 flex-shrink-0 ${cfg.color} ${task.status === 'in_progress' ? 'animate-spin' : ''}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-white text-sm font-medium">{task.title}</span>
            <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cfg.color} border border-current/20`}>
              {cfg.label}
            </span>
          </div>
          {task.description && !expanded && (
            <p className="text-slate-400 text-xs mt-1 truncate">{task.description}</p>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {isActive && task.status === 'pending' && (
            <button
              onClick={e => { e.stopPropagation(); onUpdate(task.id, { status: 'approved' }) }}
              className="text-xs px-2 py-1 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium transition-colors"
            >
              Approuver
            </button>
          )}
          {isActive && task.status === 'approved' && (
            <button
              onClick={e => { e.stopPropagation(); onUpdate(task.id, { status: 'rejected' }) }}
              className="text-xs px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg font-medium transition-colors"
            >
              Rejeter
            </button>
          )}
          {isActive && task.status === 'pending' && (
            <button
              onClick={e => { e.stopPropagation(); onUpdate(task.id, { status: 'rejected' }) }}
              className="text-xs px-2 py-1 bg-slate-700 hover:bg-slate-600 text-slate-300 rounded-lg font-medium transition-colors"
            >
              Rejeter
            </button>
          )}
          <button
            onClick={e => { e.stopPropagation(); onDelete(task.id) }}
            className="text-slate-600 hover:text-red-400 p-1 rounded transition-colors"
          >
            <Trash2 size={13} />
          </button>
          {expanded ? <ChevronUp size={14} className="text-slate-500" /> : <ChevronDown size={14} className="text-slate-500" />}
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-slate-700/40 pt-3">
          {task.description && (
            <p className="text-slate-300 text-sm whitespace-pre-wrap">{task.description}</p>
          )}
          {task.agent_result && (
            <div className="bg-slate-900/60 rounded-lg p-3">
              <p className="text-xs text-slate-500 font-medium uppercase tracking-wide mb-1">Résultat agent</p>
              <p className="text-slate-300 text-xs whitespace-pre-wrap font-mono">{task.agent_result}</p>
            </div>
          )}
          <div>
            <label className="text-xs text-slate-500 font-medium uppercase tracking-wide block mb-1">
              Votre commentaire
            </label>
            <textarea
              value={comment}
              onChange={e => setComment(e.target.value)}
              onBlur={saveComment}
              rows={2}
              placeholder="Instructions, corrections, précisions…"
              className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 resize-none focus:outline-none focus:border-indigo-500"
            />
            {saving && <span className="text-xs text-slate-500">Enregistrement…</span>}
          </div>
          {task.completed_at && (
            <p className="text-xs text-slate-500">
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
    <form onSubmit={handleSubmit} className="bg-slate-800/60 border border-slate-700 rounded-xl p-4 space-y-3">
      <input
        autoFocus
        value={form.title}
        onChange={e => setForm(f => ({ ...f, title: e.target.value }))}
        placeholder="Titre de la tâche…"
        className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-600 focus:outline-none focus:border-indigo-500"
        required
      />
      <textarea
        value={form.description}
        onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
        placeholder="Description détaillée (optionnel)…"
        rows={3}
        className="w-full bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 resize-none focus:outline-none focus:border-indigo-500"
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

export default function Agent() {
  const [tasks, setTasks] = useState([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [filter, setFilter] = useState('active')
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
    pending: tasks.filter(t => t.status === 'pending').length,
    approved: tasks.filter(t => t.status === 'approved').length,
    in_progress: tasks.filter(t => t.status === 'in_progress').length,
    blocked: tasks.filter(t => t.status === 'blocked').length,
    done: tasks.filter(t => t.status === 'done').length,
  }

  return (
    <Layout>
      <div className="max-w-3xl mx-auto px-6 py-8">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-indigo-600/20 border border-indigo-500/30 rounded-xl flex items-center justify-center">
              <Bot size={18} className="text-indigo-400" />
            </div>
            <div>
              <h1 className="text-xl font-semibold text-white">Agent autonome</h1>
              <p className="text-slate-400 text-sm">Tâches exécutées toutes les 30 min</p>
            </div>
          </div>
          <button
            onClick={() => setShowForm(s => !s)}
            className="flex items-center gap-2 px-3 py-2 bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-medium rounded-lg transition-colors"
          >
            <Plus size={15} />
            Proposer une tâche
          </button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-5 gap-3 mb-6">
          {[
            { key: 'pending',     label: 'En attente', color: 'text-slate-300' },
            { key: 'approved',    label: 'Approuvées', color: 'text-blue-400' },
            { key: 'in_progress', label: 'En cours',   color: 'text-amber-400' },
            { key: 'blocked',     label: 'Bloquées',   color: 'text-red-400' },
            { key: 'done',        label: 'Terminées',  color: 'text-green-400' },
          ].map(({ key, label, color }) => (
            <div key={key} className="bg-slate-800/60 border border-slate-700/50 rounded-xl p-3 text-center">
              <div className={`text-2xl font-bold ${color}`}>{counts[key]}</div>
              <div className="text-xs text-slate-500 mt-0.5">{label}</div>
            </div>
          ))}
        </div>

        {/* New task form */}
        {showForm && (
          <div className="mb-6">
            <NewTaskForm onAdd={handleAdd} onCancel={() => setShowForm(false)} />
          </div>
        )}

        {/* Filter tabs */}
        <div className="flex gap-1 mb-4 bg-slate-800/40 p-1 rounded-lg w-fit">
          {[
            { key: 'active', label: 'Actives' },
            { key: 'all',    label: 'Toutes' },
            { key: 'done',   label: 'Terminées' },
          ].map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`px-3 py-1.5 text-sm rounded-md font-medium transition-colors ${
                filter === key ? 'bg-slate-700 text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Task list */}
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={20} className="animate-spin text-slate-500" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            <Bot size={32} className="mx-auto text-slate-700 mb-3" />
            <p className="text-slate-500 text-sm">Aucune tâche</p>
            {filter === 'active' && (
              <button
                onClick={() => setShowForm(true)}
                className="mt-3 text-indigo-400 hover:text-indigo-300 text-sm underline transition-colors"
              >
                Proposer la première tâche
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-6">
            {Object.entries(grouped).map(([status, group]) => (
              <div key={status}>
                <h2 className={`text-xs font-semibold uppercase tracking-wide mb-2 ${STATUS_CONFIG[status]?.color || 'text-slate-500'}`}>
                  {STATUS_CONFIG[status]?.label} ({group.length})
                </h2>
                <div className="space-y-2">
                  {group.map(task => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      onUpdate={handleUpdate}
                      onDelete={handleDelete}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </Layout>
  )
}
