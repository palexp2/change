import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Plus, Settings, Server, Cpu, HardDrive, RefreshCw, AlertTriangle, CheckCircle, XCircle, Clock, Trash2, Plug, Database, Check, Zap, Bot, Users } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { useAuth } from '../lib/auth.jsx'
import { CorbeilleContent } from './Corbeille.jsx'
import { ConnectorsContent } from './Connectors.jsx'
import { AutomationsContent } from './Automations.jsx'
import { AgentContent } from './Agent.jsx'

function fmt(bytes) {
  if (bytes == null) return '—'
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB'
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB'
  return (bytes / 1e3).toFixed(0) + ' KB'
}

function fmtUptime(seconds) {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d > 0) return `${d}j ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function BarStat({ label, used, total, color = 'bg-indigo-500', warn = 80, danger = 90 }) {
  const pct = total ? Math.round(used / total * 100) : 0
  const barColor = pct >= danger ? 'bg-red-500' : pct >= warn ? 'bg-amber-500' : color
  return (
    <div>
      <div className="flex justify-between text-xs text-slate-500 mb-1">
        <span>{label}</span>
        <span className={pct >= danger ? 'text-red-600 font-semibold' : pct >= warn ? 'text-amber-600 font-semibold' : ''}>{fmt(used)} / {fmt(total)} ({pct}%)</span>
      </div>
      <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
        <div className={`h-2 rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function HealthDashboard() {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [lastRefresh, setLastRefresh] = useState(null)

  const load = async () => {
    setLoading(true)
    try { setData(await api.admin.health()); setLastRefresh(new Date()) }
    catch {}
    finally { setLoading(false) }
  }

  useEffect(() => { load() }, [])

  // Auto-refresh toutes les 30s
  useEffect(() => {
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [])

  if (loading && !data) return (
    <div className="flex items-center justify-center py-12 text-slate-400">
      <RefreshCw size={16} className="animate-spin mr-2" /> Chargement…
    </div>
  )

  if (!data) return null

  const pm2StatusColor = { online: 'green', stopped: 'red', errored: 'red', stopping: 'amber', launching: 'amber' }
  const whisperTotal = Object.values(data.whisper).reduce((a, b) => a + b, 0)

  return (
    <div className="space-y-6">
      {/* Header refresh */}
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 flex items-center gap-2"><Server size={16} /> Tableau de bord système</h2>
        <div className="flex items-center gap-3">
          {lastRefresh && <span className="text-xs text-slate-400">Mis à jour {lastRefresh.toLocaleTimeString('fr-CA')}</span>}
          <button onClick={load} disabled={loading} className="btn-secondary btn-sm text-xs">
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} /> Actualiser
          </button>
        </div>
      </div>

      {/* Santé serveur */}
      <div className="card p-5 space-y-4">
        <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wide flex items-center gap-2">
          <Cpu size={14} /> Santé du serveur
        </h3>

        <div className="grid grid-cols-1 gap-4">
          {data.disk && <BarStat label="Disque" used={data.disk.used} total={data.disk.total} color="bg-blue-500" warn={75} danger={90} />}
          <BarStat label="RAM" used={data.ram.used} total={data.ram.total} color="bg-violet-500" warn={80} danger={95} />
        </div>

        {data.diskBreakdown?.length > 0 && data.disk && (
          <div>
            <p className="text-xs font-medium text-slate-500 mb-3 flex items-center gap-1"><HardDrive size={11} /> Répartition de l'espace disque</p>
            <div className="space-y-2">
              {data.diskBreakdown.filter(c => c.bytes > 0).map(c => {
                const pct = Math.round(c.bytes / data.disk.total * 100)
                const colors = [
                  'bg-blue-500','bg-violet-500','bg-emerald-500','bg-amber-500','bg-rose-500','bg-cyan-500','bg-orange-500'
                ]
                const idx = data.diskBreakdown.filter(x => x.bytes > 0).indexOf(c)
                return (
                  <div key={c.label}>
                    <div className="flex justify-between text-xs text-slate-500 mb-0.5">
                      <span>{c.label}</span>
                      <span className="tabular-nums">{fmt(c.bytes)} <span className="text-slate-400">({pct}%)</span></span>
                    </div>
                    <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                      <div className={`h-1.5 rounded-full ${colors[idx % colors.length]}`} style={{ width: `${Math.max(pct, 0.5)}%` }} />
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
          <div className="bg-slate-50 rounded-xl p-3 text-center">
            <div className="text-lg font-bold text-slate-800">{data.cpu.load1.toFixed(2)}</div>
            <div className="text-xs text-slate-500 mt-0.5">CPU 1 min</div>
          </div>
          <div className="bg-slate-50 rounded-xl p-3 text-center">
            <div className="text-lg font-bold text-slate-800">{data.cpu.load5.toFixed(2)}</div>
            <div className="text-xs text-slate-500 mt-0.5">CPU 5 min</div>
          </div>
          <div className="bg-slate-50 rounded-xl p-3 text-center">
            <div className="text-lg font-bold text-slate-800">{data.cpu.load15.toFixed(2)}</div>
            <div className="text-xs text-slate-500 mt-0.5">CPU 15 min</div>
          </div>
          <div className="bg-slate-50 rounded-xl p-3 text-center">
            <div className="text-lg font-bold text-slate-800">{fmtUptime(data.uptime)}</div>
            <div className="text-xs text-slate-500 mt-0.5">Uptime serveur</div>
          </div>
        </div>
      </div>

      {/* Santé application */}
      <div className="card p-5 space-y-4">
        <h3 className="text-sm font-semibold text-slate-700 uppercase tracking-wide flex items-center gap-2">
          <Settings size={14} /> Santé de l'application
        </h3>

        {/* PM2 */}
        <div className="space-y-2">
          <p className="text-xs font-medium text-slate-500">Processus PM2</p>
          {data.processes.map(p => (
            <div key={p.name} className="flex items-center justify-between py-2 px-3 bg-slate-50 rounded-lg">
              <div className="flex items-center gap-2">
                {p.status === 'online'
                  ? <CheckCircle size={13} className="text-green-500 flex-shrink-0" />
                  : <XCircle size={13} className="text-red-500 flex-shrink-0" />}
                <span className="text-sm font-medium text-slate-800">{p.name}</span>
                <Badge color={pm2StatusColor[p.status] || 'slate'} size="sm">{p.status}</Badge>
              </div>
              <div className="flex items-center gap-4 text-xs text-slate-500">
                {p.memory > 0 && <span>{fmt(p.memory)}</span>}
                {p.restarts > 0 && <span className="text-amber-600">{p.restarts} restarts</span>}
                {p.uptime && p.status === 'online' && <span className="flex items-center gap-1"><Clock size={10} />{fmtUptime((Date.now() - p.uptime) / 1000)}</span>}
              </div>
            </div>
          ))}
        </div>

        {/* DB + Whisper */}
        <div className="grid grid-cols-2 gap-4 pt-1">
          <div className="bg-slate-50 rounded-xl p-4">
            <p className="text-xs text-slate-500 mb-1">Base de données SQLite</p>
            <p className="text-xl font-bold text-slate-800">{fmt(data.dbSize)}</p>
          </div>
          <div className="bg-slate-50 rounded-xl p-4">
            <p className="text-xs text-slate-500 mb-2">Transcriptions Whisper</p>
            <div className="flex flex-wrap gap-2 text-xs">
              <span className="text-green-600 font-medium">{data.whisper.done || 0} ok</span>
              <span className="text-amber-600 font-medium">{(data.whisper.pending || 0) + (data.whisper.processing || 0)} en attente</span>
              {data.whisper.error > 0 && <span className="text-red-600 font-medium">{data.whisper.error} erreurs</span>}
            </div>
            {whisperTotal > 0 && (
              <div className="h-1.5 bg-slate-200 rounded-full overflow-hidden flex mt-2">
                <div className="bg-green-500 h-full" style={{ width: `${(data.whisper.done || 0) / whisperTotal * 100}%` }} />
                <div className="bg-amber-400 h-full" style={{ width: `${((data.whisper.pending || 0) + (data.whisper.processing || 0)) / whisperTotal * 100}%` }} />
                <div className="bg-red-400 h-full" style={{ width: `${(data.whisper.error || 0) / whisperTotal * 100}%` }} />
              </div>
            )}
          </div>
        </div>

        {/* Dernières erreurs */}
        {data.recentErrors.length > 0 && (
          <div>
            <p className="text-xs font-medium text-slate-500 mb-2 flex items-center gap-1"><AlertTriangle size={11} className="text-amber-500" /> Dernières erreurs</p>
            <div className="bg-slate-900 rounded-xl p-3 space-y-1 max-h-48 overflow-y-auto">
              {data.recentErrors.map((line, i) => {
                const m = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?:?\s*(.*)$/s)
                const time = m ? new Date(m[1]).toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : null
                const msg = m ? m[2] : line
                return (
                  <p key={i} className="text-xs font-mono text-slate-300 leading-relaxed break-all">
                    {time && <span className="text-slate-500 mr-2 flex-shrink-0">{time}</span>}
                    {msg}
                  </p>
                )
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const ROLES = ['admin', 'sales', 'support', 'ops']
const roleLabels = { admin: 'Admin', sales: 'Ventes', support: 'Support', ops: 'Opérations' }
const roleColors = { admin: 'indigo', sales: 'blue', support: 'green', ops: 'orange' }

function UserForm({ initial = {}, onSave, onClose, isNew, isSelf }) {
  const [form, setForm] = useState({
    name: '', email: '', password: '', role: 'sales', active: true, ...initial
  })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (isNew && form.password.length < 8) {
      return setError('Le mot de passe doit contenir au moins 8 caractères.')
    }
    setSaving(true)
    try {
      await onSave(form)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="label">Nom *</label>
        <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="input" required />
      </div>
      <div>
        <label className="label">Courriel *</label>
        <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} className="input" required />
      </div>
      <div>
        <label className="label">{isNew ? 'Mot de passe *' : 'Nouveau mot de passe (laisser vide pour conserver)'}</label>
        <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} className="input" required={isNew} placeholder={isNew ? 'Minimum 8 caractères' : 'Laisser vide pour ne pas changer'} />
      </div>
      <div>
        <label className="label">Rôle *</label>
        <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))} className="select">
          {ROLES.map(r => <option key={r} value={r}>{roleLabels[r]}</option>)}
        </select>
      </div>
      {!isNew && (
        <div className="flex items-center gap-2">
          <input type="checkbox" id="user-active" checked={form.active} onChange={e => setForm(f => ({ ...f, active: e.target.checked }))} className="rounded" disabled={isSelf} />
          <label htmlFor="user-active" className={`text-sm cursor-pointer ${isSelf ? 'text-slate-400' : 'text-slate-700'}`}>Compte actif{isSelf && ' (impossible de se désactiver soi-même)'}</label>
        </div>
      )}
      {error && <p className="text-red-600 text-sm">{error}</p>}
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
        <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Enregistrement...' : 'Enregistrer'}</button>
      </div>
    </form>
  )
}


function ResetPasswordForm({ userId, onClose }) {
  const [pw, setPw] = useState('')
  const [pw2, setPw2] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    if (pw.length < 8) return setError('Minimum 8 caractères')
    if (pw !== pw2) return setError('Les mots de passe ne correspondent pas')
    setSaving(true)
    setError('')
    try {
      await api.admin.resetPassword(userId, pw)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="label">Nouveau mot de passe</label>
        <input type="password" value={pw} onChange={e => setPw(e.target.value)} className="input" placeholder="Minimum 8 caractères" required />
      </div>
      <div>
        <label className="label">Confirmer</label>
        <input type="password" value={pw2} onChange={e => setPw2(e.target.value)} className="input" placeholder="Répéter le mot de passe" required />
      </div>
      {error && <p className="text-red-600 text-sm">{error}</p>}
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
        <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Enregistrement...' : 'Réinitialiser'}</button>
      </div>
    </form>
  )
}

const TABS = [
  { key: 'systeme',     label: 'Système',     icon: Server },
  { key: 'utilisateurs', label: 'Utilisateurs', icon: Users },
  { key: 'connecteurs', label: 'Connecteurs', icon: Plug },
  { key: 'automations', label: 'Automations', icon: Zap },
  { key: 'agent',       label: 'Agent',       icon: Bot },
  { key: 'corbeille',   label: 'Corbeille',   icon: Trash2 },
]

function UsersSection({ currentUser }) {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(true)
  const [showModal, setShowModal] = useState(false)
  const [editUser, setEditUser] = useState(null)
  const [resetUser, setResetUser] = useState(null)

  async function load() {
    setLoading(true)
    try { setUsers(await api.admin.listUsers()) } finally { setLoading(false) }
  }
  useEffect(() => { load() }, [])

  async function handleCreate(form) { await api.admin.createUser(form); load() }
  async function handleUpdate(form) {
    const payload = { name: form.name, email: form.email, role: form.role, active: form.active }
    if (form.password) payload.password = form.password
    await api.admin.updateUser(editUser.id, payload)
    setEditUser(null); load()
  }

  return (
    <>
      <div className="flex items-center justify-between mb-4">
        <h2 className="font-semibold text-slate-900">Utilisateurs ({users.length})</h2>
        <button onClick={() => setShowModal(true)} className="btn-primary btn-sm">
          <Plus size={14} /> Nouvel utilisateur
        </button>
      </div>
      <div className="card overflow-hidden mb-6">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50">
              <th className="text-left px-5 py-3 text-xs font-semibold text-slate-500 uppercase">Utilisateur</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase hidden sm:table-cell">Courriel</th>
              <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Rôle</th>
              <th className="text-center px-4 py-3 text-xs font-semibold text-slate-500 uppercase">Statut</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={5} className="text-center py-10 text-slate-400">Chargement...</td></tr>
            ) : users.map(u => (
              <tr key={u.id} onClick={() => setEditUser(u)}
                className="border-b border-slate-100 last:border-0 cursor-pointer hover:bg-slate-50 transition-colors">
                <td className="px-5 py-3">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 bg-indigo-100 rounded-full flex items-center justify-center flex-shrink-0">
                      <span className="text-indigo-600 font-semibold text-sm">{u.name?.[0]?.toUpperCase()}</span>
                    </div>
                    <div className="font-medium text-slate-900">{u.name}
                      {u.id === currentUser.id && <span className="ml-1.5 text-xs text-slate-400">(vous)</span>}
                    </div>
                  </div>
                </td>
                <td className="px-4 py-3 hidden sm:table-cell text-slate-500">{u.email}</td>
                <td className="px-4 py-3"><Badge color={roleColors[u.role]}>{roleLabels[u.role]}</Badge></td>
                <td className="px-4 py-3 text-center">
                  <Badge color={u.active ? 'green' : 'red'}>{u.active ? 'Actif' : 'Inactif'}</Badge>
                </td>
                <td className="px-4 py-3 text-right">
                  <button onClick={e => { e.stopPropagation(); setResetUser(u) }}
                    className="text-xs text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 px-2 py-1 rounded transition-colors">
                    🔑 Reset
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="Nouvel utilisateur">
        <UserForm isNew onSave={handleCreate} onClose={() => setShowModal(false)} />
      </Modal>
      <Modal isOpen={!!editUser} onClose={() => setEditUser(null)} title="Modifier l'utilisateur">
        {editUser && (
          <UserForm initial={{ ...editUser, active: editUser.active === 1, password: '' }} onSave={handleUpdate} onClose={() => setEditUser(null)} isSelf={editUser.id === currentUser.id} />
        )}
      </Modal>
      <Modal isOpen={!!resetUser} onClose={() => setResetUser(null)} title={`Réinitialiser le mot de passe — ${resetUser?.name}`} size="sm">
        {resetUser && <ResetPasswordForm userId={resetUser.id} onClose={() => setResetUser(null)} />}
      </Modal>
    </>
  )
}


const VALID_TABS = new Set(TABS.map(t => t.key))

export default function Admin() {
  const { user: currentUser } = useAuth()
  const { tab } = useParams()
  const navigate = useNavigate()
  const activeTab = VALID_TABS.has(tab) ? tab : 'systeme'
  const setActiveTab = (key) => navigate(`/admin/${key}`, { replace: true })

  return (
    <Layout>
      <div className="p-6 max-w-4xl mx-auto">
        <div className="flex items-center gap-3 mb-6">
          <div className="p-2 bg-indigo-50 rounded-lg">
            <Settings size={20} className="text-indigo-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Paramètres</h1>
            <p className="text-slate-500 text-sm">Administration de l'ERP</p>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-1 mb-6 border-b border-slate-200">
          {TABS.map(tab => {
            const Icon = tab.icon
            return (
              <button key={tab.key} onClick={() => setActiveTab(tab.key)}
                className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === tab.key
                    ? 'border-indigo-500 text-indigo-600'
                    : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}>
                <Icon size={14} /> {tab.label}
              </button>
            )
          })}
        </div>

        {activeTab === 'systeme' && <HealthDashboard />}
        {activeTab === 'utilisateurs' && <UsersSection currentUser={currentUser} />}

        {activeTab === 'connecteurs' && <ConnectorsContent />}
        {activeTab === 'automations' && <AutomationsContent />}
        {activeTab === 'agent' && <AgentContent />}
        {activeTab === 'corbeille' && <CorbeilleContent />}
      </div>
    </Layout>
  )
}
