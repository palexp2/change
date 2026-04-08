import { useState, useEffect } from 'react'
import { CheckCircle, XCircle, Link2, RefreshCw, Trash2, Mail, Database, CreditCard, BarChart3, Plus, Phone, Eye, EyeOff, Copy, BookOpen, Truck } from 'lucide-react'
import api from '../lib/api.js'
import AirtableConfig from './AirtableConfig.jsx'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { useSyncStatus } from '../lib/useSyncStatus.js'

function WhisperConfig() {
  const [data, setData] = useState(null)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [retryResult, setRetryResult] = useState(null)
  const [fixingTs, setFixingTs] = useState(false)
  const [fixTsResult, setFixTsResult] = useState(null)
  const [deduping, setDeduping] = useState(false)
  const [dedupResult, setDedupResult] = useState(null)
  const [driveStatus, setDriveStatus] = useState(null)
  const [downloadProgress, setDownloadProgress] = useState(null)

  const load = async () => {
    try {
      const [info, drive] = await Promise.all([api.connectors.whisperInfo(), api.connectors.whisperDriveStatus()])
      setData(info)
      setDriveStatus(drive)
    } catch {}
  }
  useEffect(() => { load() }, [])

  // Polling pendant le téléchargement
  useEffect(() => {
    if (!downloadProgress?.running) return
    const id = setInterval(async () => {
      const p = await api.connectors.whisperDownloadProgress()
      setDownloadProgress(p)
      if (!p.running) { clearInterval(id); load() }
    }, 2000)
    return () => clearInterval(id)
  }, [downloadProgress?.running])

  const saveKey = async () => {
    setSaving(true)
    try {
      await api.connectors.whisperSaveKey(apiKey)
      setApiKey('')
      await load()
    } catch (e) { alert(e.message) }
    finally { setSaving(false) }
  }

  const startDriveDownload = async () => {
    const r = await api.connectors.whisperDownloadDrive()
    setDownloadProgress({ running: true, done: 0, total: r.total, errors: 0 })
  }

  const retry = async () => {
    setRetrying(true)
    setRetryResult(null)
    try {
      const r = await api.connectors.whisperRetry()
      setRetryResult(r)
      setTimeout(load, 2000)
    } catch (e) { alert(e.message) }
    finally { setRetrying(false) }
  }

  if (!data) return <div className="mt-4 text-sm text-slate-400">Chargement…</div>

  const statMap = Object.fromEntries(data.stats.map(s => [s.transcription_status, s.total]))
  const done    = statMap.done    || 0
  const pending = statMap.pending || 0
  const error   = statMap.error   || 0
  const total   = done + pending + error + (statMap.processing || 0)

  return (
    <div className="mt-4 space-y-4">
      {/* Clé API */}
      <div className="bg-slate-50 rounded-xl p-4 space-y-3">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Clé API OpenAI</p>
        {data.configured
          ? <p className="text-sm text-green-600 font-medium flex items-center gap-1.5"><CheckCircle size={14} /> Clé configurée</p>
          : <p className="text-sm text-amber-600 font-medium flex items-center gap-1.5"><XCircle size={14} /> Aucune clé configurée</p>
        }
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type={showKey ? 'text' : 'password'}
              className="input pr-8 font-mono text-sm"
              placeholder="sk-..."
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
            />
            <button onClick={() => setShowKey(v => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <button onClick={saveKey} disabled={saving || !apiKey} className="btn-primary btn-sm">
            {saving ? 'Sauvegarde…' : data.configured ? 'Mettre à jour' : 'Enregistrer'}
          </button>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Transcrites', value: done,    color: 'text-green-600 bg-green-50' },
          { label: 'En attente',  value: pending,  color: 'text-amber-600 bg-amber-50' },
          { label: 'Erreurs',     value: error,    color: 'text-red-600 bg-red-50' },
        ].map(({ label, value, color }) => (
          <div key={label} className={`rounded-xl p-3 text-center ${color}`}>
            <div className="text-2xl font-bold">{value}</div>
            <div className="text-xs mt-0.5 opacity-80">{label}</div>
          </div>
        ))}
      </div>

      {/* Téléchargement Drive */}
      {driveStatus?.missing > 0 && (
        <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 space-y-3">
          <p className="text-sm font-medium text-blue-800">
            {driveStatus.missing} enregistrement{driveStatus.missing > 1 ? 's' : ''} Google Drive non téléchargé{driveStatus.missing > 1 ? 's' : ''}
          </p>
          {downloadProgress?.running ? (
            <div className="space-y-2">
              <div className="flex justify-between text-xs text-blue-700">
                <span>Téléchargement en cours…</span>
                <span>{downloadProgress.done} / {downloadProgress.total}</span>
              </div>
              <div className="w-full bg-blue-200 rounded-full h-2">
                <div className="bg-blue-600 h-2 rounded-full transition-all" style={{ width: `${Math.round(downloadProgress.done / downloadProgress.total * 100)}%` }} />
              </div>
              {downloadProgress.errors > 0 && <p className="text-xs text-red-500">{downloadProgress.errors} erreur(s)</p>}
            </div>
          ) : downloadProgress && !downloadProgress.running ? (
            <p className="text-xs text-green-600">✅ Terminé — {downloadProgress.done} téléchargés, {downloadProgress.errors} erreurs</p>
          ) : (
            <button onClick={startDriveDownload} disabled={!data.configured} className="btn-primary btn-sm text-xs" title={!data.configured ? 'Configurez d\'abord la clé API' : ''}>
              <RefreshCw size={12} /> Télécharger depuis Google Drive
            </button>
          )}
        </div>
      )}

    </div>
  )
}

function CubeAcrConfig({ onRefresh }) {
  const [data, setData] = useState(null)
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState({ ftpUser: '', ftpPass: '', nom: '', erpUserId: '' })
  const [saving, setSaving] = useState(false)
  const [visiblePass, setVisiblePass] = useState({})
  const [copied, setCopied] = useState(null)

  const load = async () => {
    try { setData(await api.connectors.ftpInfo()) } catch {}
  }
  useEffect(() => { load() }, [])

  const copy = (text, key) => {
    navigator.clipboard.writeText(text)
    setCopied(key)
    setTimeout(() => setCopied(null), 1500)
  }

  const addPhone = async () => {
    if (!form.ftpUser || !form.ftpPass || !form.nom || !form.erpUserId) return
    setSaving(true)
    try {
      await api.connectors.ftpAddPhone(form)
      setForm({ ftpUser: '', ftpPass: '', nom: '', erpUserId: '' })
      setShowAdd(false)
      await load()
      onRefresh()
    } catch (e) {
      alert(e.message)
    } finally { setSaving(false) }
  }

  const deletePhone = async (ftpUser) => {
    if (!confirm(`Supprimer le téléphone "${ftpUser}" ?`)) return
    await api.connectors.ftpDeletePhone(ftpUser)
    await load()
    onRefresh()
  }

  if (!data) return <div className="mt-4 text-sm text-slate-400">Chargement…</div>

  return (
    <div className="mt-4 space-y-4">
      {/* Infos serveur */}
      <div className="bg-slate-50 rounded-xl p-4 space-y-2">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Paramètres de connexion Cube ACR</p>
        {[
          { label: 'Hôte', value: data.host, key: 'host' },
          { label: 'Port', value: data.port, key: 'port' },
          { label: 'Dossier', value: data.folder, key: 'folder' },
        ].map(({ label, value, key }) => (
          <div key={key} className="flex items-center justify-between">
            <span className="text-xs text-slate-500 w-16">{label}</span>
            <div className="flex items-center gap-2 flex-1">
              <code className="text-xs bg-white border border-slate-200 px-2 py-1 rounded font-mono flex-1">{value}</code>
              <button onClick={() => copy(value, key)} className="text-slate-400 hover:text-slate-600 transition-colors">
                {copied === key ? <CheckCircle size={13} className="text-green-500" /> : <Copy size={13} />}
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Liste des téléphones */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Téléphones configurés</p>
          <button onClick={() => setShowAdd(!showAdd)} className="btn-secondary btn-sm text-xs">
            <Plus size={11} /> Ajouter
          </button>
        </div>

        {data.phones.length === 0 && !showAdd && (
          <p className="text-sm text-slate-400 py-2">Aucun téléphone configuré.</p>
        )}

        <div className="space-y-2">
          {data.phones.map(p => (
            <div key={p.ftpUser} className="bg-white border border-slate-200 rounded-xl px-4 py-3">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <span className="text-sm font-medium text-slate-800">{p.nom}</span>
                  {p.erpUserId && <span className="ml-2 text-xs text-slate-400">lié à l'ERP</span>}
                </div>
                <button onClick={() => deletePhone(p.ftpUser)} className="text-slate-300 hover:text-red-500 transition-colors">
                  <Trash2 size={13} />
                </button>
              </div>
              <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                {[
                  { label: 'Utilisateur', value: p.ftpUser, key: `u_${p.ftpUser}` },
                  { label: 'Mot de passe', value: p.ftpPass, key: `p_${p.ftpUser}`, secret: true },
                ].map(({ label, value, key, secret }) => (
                  <div key={key} className="flex items-center gap-1.5">
                    <span className="text-slate-400 w-20 flex-shrink-0">{label}</span>
                    <code className="font-mono text-slate-700">
                      {secret && !visiblePass[p.ftpUser] ? '••••••••' : value}
                    </code>
                    {secret && (
                      <button onClick={() => setVisiblePass(v => ({ ...v, [p.ftpUser]: !v[p.ftpUser] }))} className="text-slate-300 hover:text-slate-500">
                        {visiblePass[p.ftpUser] ? <EyeOff size={11} /> : <Eye size={11} />}
                      </button>
                    )}
                    <button onClick={() => copy(value, key)} className="text-slate-300 hover:text-slate-500">
                      {copied === key ? <CheckCircle size={11} className="text-green-500" /> : <Copy size={11} />}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        {/* Formulaire d'ajout */}
        {showAdd && (
          <div className="mt-3 bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
            <p className="text-xs font-semibold text-slate-600">Nouveau téléphone</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label text-xs">Nom affiché</label>
                <input className="input" placeholder="Ex: Philippe Chabot" value={form.nom} onChange={e => setForm(f => ({ ...f, nom: e.target.value }))} />
              </div>
              <div>
                <label className="label text-xs">Utilisateur ERP</label>
                <select className="input" value={form.erpUserId} onChange={e => setForm(f => ({ ...f, erpUserId: e.target.value }))}>
                  <option value="">— Sélectionner —</option>
                  {data.erpUsers.filter(u => !u.ftp_username).map(u => (
                    <option key={u.id} value={u.id}>{u.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label text-xs">Identifiant FTP</label>
                <input className="input font-mono" placeholder="Ex: philippe" value={form.ftpUser} onChange={e => setForm(f => ({ ...f, ftpUser: e.target.value.toLowerCase().replace(/\s/g, '') }))} />
              </div>
              <div>
                <label className="label text-xs">Mot de passe FTP</label>
                <input className="input font-mono" placeholder="Ex: motdepasse" value={form.ftpPass} onChange={e => setForm(f => ({ ...f, ftpPass: e.target.value }))} />
              </div>
            </div>
            <div className="flex gap-2 pt-1">
              <button onClick={addPhone} disabled={saving || !form.ftpUser || !form.ftpPass || !form.nom || !form.erpUserId} className="btn-primary btn-sm text-xs">
                {saving ? 'Ajout…' : 'Ajouter'}
              </button>
              <button onClick={() => setShowAdd(false)} className="btn-secondary btn-sm text-xs">Annuler</button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

const CONNECTORS = [
  { id: 'google',     name: 'Gmail',       icon: Mail,       color: 'bg-red-50 text-red-600' },
  { id: 'airtable',   name: 'Airtable',    icon: Database,   color: 'bg-amber-50 text-amber-600' },
  { id: 'calls',      name: 'Appels',      icon: Phone,      color: 'bg-green-50 text-green-600', alwaysConnected: true },
  { id: 'quickbooks', name: 'QuickBooks',  icon: BookOpen,   color: 'bg-green-50 text-green-700' },
  { id: 'stripe',     name: 'Stripe',      icon: CreditCard, color: 'bg-purple-50 text-purple-600', apiKeyManaged: true },
  { id: 'novoxpress', name: 'Novoxpress',  icon: Truck,      color: 'bg-orange-50 text-orange-600', apiKeyManaged: true },
]

function SyncBtn({ label, syncKey, syncStatus, onSync }) {
  const serverRunning = syncStatus?.[syncKey]?.running
  const serverError = syncStatus?.[syncKey]?.error
  const [progress, setProgress] = useState(null)

  useEffect(() => {
    function onProgress(e) {
      const { syncKey: key, loaded, done } = e.detail
      if (key !== syncKey) return
      if (done) { setProgress(null); return }
      setProgress(loaded)
    }
    window.addEventListener('sync:progress', onProgress)
    return () => window.removeEventListener('sync:progress', onProgress)
  }, [syncKey])

  // Clear progress when sync stops
  useEffect(() => { if (!serverRunning) setProgress(null) }, [serverRunning])

  return (
    <div className="flex items-center gap-2">
      <button onClick={onSync} disabled={serverRunning} className="btn-secondary btn-sm py-1">
        <RefreshCw size={12} className={serverRunning ? 'animate-spin' : ''} /> {label}
      </button>
      {serverRunning && (
        <span className="text-xs text-amber-600 font-medium tabular-nums">
          {progress != null ? `${progress} records chargés…` : 'En cours…'}
        </span>
      )}
      {serverError && !serverRunning && <span className="text-xs text-red-500" title={serverError}>⚠ Erreur</span>}
    </div>
  )
}

function parseDriveFolders(config) {
  if (config?.drive_folders) {
    try { return JSON.parse(config.drive_folders) } catch {}
  }
  // Migrate legacy single-folder config
  if (config?.drive_folder_id) {
    return [{ folder_id: config.drive_folder_id, email: config.drive_sync_email || '', user_id: '', label: '' }]
  }
  return []
}

function GoogleConfig({ accounts, config, syncStatus, onRefresh }) {
  const [folders, setFolders] = useState(() => parseDriveFolders(config))
  const [users, setUsers] = useState([])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    api.admin.listUsers().then(setUsers).catch(() => {})
  }, [])

  function addFolder() {
    setFolders(f => [...f, { folder_id: '', email: '', user_id: '', label: '' }])
  }

  function updateFolder(i, field, value) {
    setFolders(f => f.map((entry, idx) => idx === i ? { ...entry, [field]: value } : entry))
  }

  function removeFolder(i) {
    setFolders(f => f.filter((_, idx) => idx !== i))
  }

  async function save() {
    setSaving(true)
    try {
      await api.connectors.saveConfig('google', { drive_folders: JSON.stringify(folders) })
      onRefresh()
    } finally { setSaving(false) }
  }

  return (
    <div className="space-y-4 mt-4">
      {accounts.length > 0 && (
        <div>
          <div className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Comptes connectés</div>
          {accounts.map(a => (
            <div key={a.id} className="flex items-center justify-between p-2 bg-slate-50 rounded-lg mb-1">
              <span className="text-sm text-slate-700">{a.account_email}</span>
              <div className="flex gap-2">
                <SyncBtn label="Gmail" syncKey="gmail" syncStatus={syncStatus} onSync={() => api.connectors.syncGmail()} />
                <button onClick={() => api.connectors.disconnect(a.id).then(onRefresh)} className="text-red-400 hover:text-red-600 p-1">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <button onClick={save} disabled={saving} className="btn-primary btn-sm">{saving ? 'Enregistrement...' : 'Enregistrer'}</button>
      </div>
    </div>
  )
}


function QuickBooksConfig({ accounts, onRefresh }) {
  const connectedAccounts = accounts.filter(a => a.connector === 'quickbooks')

  return (
    <div className="mt-4 space-y-3">
      {connectedAccounts.map(a => (
        <div key={a.id} className="flex items-center justify-between p-2 bg-slate-50 rounded-lg">
          <div className="flex items-center gap-2">
            <CheckCircle size={14} className="text-green-500" />
            <span className="text-sm text-slate-700">QuickBooks connecté</span>
          </div>
          <button onClick={() => api.connectors.disconnect(a.id).then(onRefresh)} className="text-red-400 hover:text-red-600 p-1" title="Déconnecter">
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      {connectedAccounts.length > 0 && (
        <p className="text-xs text-slate-400">
          Les comptes de dépense, de paiement et le fournisseur sont sélectionnés par l'opérateur au moment de publier chaque reçu depuis la page <strong>Reçus de vente</strong>.
        </p>
      )}
    </div>
  )
}

function NovoxpressConfig({ configured: initialConfigured, onRefresh }) {
  const [configured, setConfigured] = useState(initialConfigured)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      await api.novoxpress.saveConfig({ username, password })
      setUsername(''); setPassword('')
      setConfigured(true)
      onRefresh()
    } catch (e) { alert(e.message) }
    finally { setSaving(false) }
  }

  const remove = async () => {
    if (!confirm('Supprimer les identifiants Novoxpress ?')) return
    try {
      await api.novoxpress.deleteConfig()
      setConfigured(false)
      onRefresh()
    } catch (e) { alert(e.message) }
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="bg-slate-50 rounded-xl p-4 space-y-3">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Identifiants Novoxpress</p>
        {configured
          ? <p className="text-sm text-green-600 font-medium flex items-center gap-1.5"><CheckCircle size={14} /> Compte configuré</p>
          : <p className="text-sm text-amber-600 font-medium flex items-center gap-1.5"><XCircle size={14} /> Aucun compte configuré</p>
        }
        <div className="space-y-2">
          <input
            type="text"
            className="input"
            placeholder="Nom d'utilisateur"
            value={username}
            onChange={e => setUsername(e.target.value)}
            autoComplete="off"
          />
          <div className="relative">
            <input
              type={showPass ? 'text' : 'password'}
              className="input pr-8"
              placeholder="Mot de passe"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="new-password"
            />
            <button onClick={() => setShowPass(v => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
              {showPass ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={save} disabled={saving || !username || !password} className="btn-primary btn-sm">
            {saving ? 'Sauvegarde…' : configured ? 'Mettre à jour' : 'Enregistrer'}
          </button>
          {configured && (
            <button onClick={remove} className="btn-secondary btn-sm text-red-500 hover:text-red-600">
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

function StripeConfig({ configured: initialConfigured, syncStatus, onRefresh }) {
  const [configured, setConfigured] = useState(initialConfigured)
  const [secretKey, setSecretKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)

  const saveKey = async () => {
    setSaving(true)
    try {
      await api.stripe.saveKey(secretKey)
      setSecretKey('')
      setConfigured(true)
      onRefresh()
    } catch (e) { alert(e.message) }
    finally { setSaving(false) }
  }

  const removeKey = async () => {
    if (!confirm('Supprimer la clé Stripe ?')) return
    try {
      await api.stripe.deleteKey()
      setConfigured(false)
      onRefresh()
    } catch (e) { alert(e.message) }
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="bg-slate-50 rounded-xl p-4 space-y-3">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Clé secrète Stripe</p>
        {configured
          ? <p className="text-sm text-green-600 font-medium flex items-center gap-1.5"><CheckCircle size={14} /> Clé configurée</p>
          : <p className="text-sm text-amber-600 font-medium flex items-center gap-1.5"><XCircle size={14} /> Aucune clé configurée</p>
        }
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type={showKey ? 'text' : 'password'}
              className="input pr-8 font-mono text-sm"
              placeholder="sk_live_... ou sk_test_..."
              value={secretKey}
              onChange={e => setSecretKey(e.target.value)}
            />
            <button onClick={() => setShowKey(v => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <button onClick={saveKey} disabled={saving || !secretKey} className="btn-primary btn-sm">
            {saving ? 'Sauvegarde…' : configured ? 'Mettre à jour' : 'Enregistrer'}
          </button>
          {configured && (
            <button onClick={removeKey} className="btn-secondary btn-sm text-red-500 hover:text-red-600">
              <Trash2 size={14} />
            </button>
          )}
        </div>
        <p className="text-xs text-slate-400">
          Trouvez votre clé dans le <a href="https://dashboard.stripe.com/apikeys" target="_blank" rel="noopener noreferrer" className="underline hover:text-slate-600">tableau de bord Stripe → Développeurs → Clés API</a>
        </p>
      </div>

      {configured && (
        <div className="flex items-center gap-3">
          <SyncBtn label="Synchroniser abonnements" syncKey="stripe" syncStatus={syncStatus} onSync={() => api.stripe.sync()} />
        </div>
      )}
    </div>
  )
}

function ConnectorCard({ connector, accounts, config, syncConfigs, syncStatus, onRefresh, stripeConfigured, novoxpressConfigured }) {
  const [expanded, setExpanded] = useState(false)
  const { icon: Icon, color } = connector
  const connectorAccounts = accounts.filter(a => a.connector === connector.id)
  const isConnected = connector.alwaysConnected ? true
    : connector.apiKeyManaged ? (
        connector.id === 'stripe' ? stripeConfigured :
        connector.id === 'novoxpress' ? novoxpressConfigured :
        false
      )
    : connectorAccounts.length > 0

  const needsOAuth = !connector.apiKeyManaged && !connector.alwaysConnected && !isConnected

  return (
    <div className="card overflow-hidden">
      <button
        onClick={() => needsOAuth ? null : setExpanded(!expanded)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-50 transition-colors text-left"
      >
        <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${color}`}>
          <Icon size={16} />
        </div>
        <span className="font-medium text-slate-900 flex-1">{connector.name}</span>
        {isConnected
          ? <Badge color="green" size="sm">Connecté</Badge>
          : <Badge color="slate" size="sm">Non connecté</Badge>
        }
        {needsOAuth ? (
          <button
            onClick={(e) => {
              e.stopPropagation()
              const token = localStorage.getItem('erp_token')
              window.location.href = `/erp/api/connectors/${connector.id}/connect?token=${token}`
            }}
            className="btn-primary btn-sm text-xs"
          >
            <Link2 size={12} /> Connecter
          </button>
        ) : null}
      </button>

      {expanded && (
        <div className="px-4 pb-4 border-t border-slate-100">
          {connector.id === 'google' && (
            <GoogleConfig accounts={connectorAccounts} config={config?.google || {}} syncStatus={syncStatus} onRefresh={onRefresh} />
          )}
          {connector.id === 'airtable' && (
            <AirtableConfig syncConfigs={syncConfigs} syncStatus={syncStatus} onRefresh={onRefresh} stripeConfigured={stripeConfigured} />
          )}
          {connector.id === 'calls' && (
            <div className="space-y-4 mt-4">
              <WhisperConfig />
              <CubeAcrConfig onRefresh={onRefresh} />
            </div>
          )}
          {connector.id === 'quickbooks' && (
            <QuickBooksConfig accounts={connectorAccounts} config={config} syncStatus={syncStatus} onRefresh={onRefresh} />
          )}
          {connector.id === 'stripe' && (
            <StripeConfig configured={stripeConfigured} syncStatus={syncStatus} onRefresh={onRefresh} />
          )}
          {connector.id === 'novoxpress' && (
            <NovoxpressConfig configured={novoxpressConfigured} onRefresh={onRefresh} />
          )}
        </div>
      )}
    </div>
  )
}

// ── Sync Log Panel ───────────────────────────────────────────────────────────

const TRIGGER_LABELS = { webhook: 'Webhook', manual: 'Manuel', scheduled: 'Planifié' }
const TRIGGER_COLORS = { webhook: 'bg-blue-100 text-blue-700', manual: 'bg-purple-100 text-purple-700', scheduled: 'bg-slate-100 text-slate-600' }

const MODULE_LABELS = {
  airtable: 'CRM', projets: 'Projets', pieces: 'Produits', orders: 'Commandes',
  achats: 'Achats', billets: 'Billets', serials: 'N° de série', envois: 'Envois',
  soumissions: 'Soumissions', retours: 'Retours', retour_items: 'Items retour',
  adresses: 'Adresses', bom: 'BOM', serial_changes: 'Changements série',
  assemblages: 'Assemblages', factures: 'Factures',
}

function SyncLogPanel() {
  const [open, setOpen] = useState(false)
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')

  const load = async () => {
    try {
      const params = { limit: 200 }
      if (filter) params.module = filter
      const data = await api.syncLog.list(params)
      setLogs(data)
    } catch {} finally { setLoading(false) }
  }

  useEffect(() => { load() }, [filter])
  useEffect(() => { const id = setInterval(load, 15000); return () => clearInterval(id) }, [filter])

  const modules = [...new Set(logs.map(l => l.module))].sort()

  const fmtTime = (iso) => {
    if (!iso) return '—'
    const d = new Date(iso + 'Z')
    const now = new Date()
    const diff = now - d
    if (diff < 60000) return 'à l\'instant'
    if (diff < 3600000) return `il y a ${Math.floor(diff / 60000)}min`
    if (diff < 86400000) return d.toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit' })
    return d.toLocaleDateString('fr-CA', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  }

  // Stats summary
  const last24h = logs.filter(l => new Date(l.created_at + 'Z') > new Date(Date.now() - 86400000))
  const successCount = last24h.filter(l => l.status === 'success').length
  const errorCount = last24h.filter(l => l.status === 'error').length
  const lastScheduled = logs.find(l => l.trigger === 'scheduled')
  const lastWebhook = logs.find(l => l.trigger === 'webhook')

  return (
    <div className="card overflow-hidden">
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-3 px-4 py-3 hover:bg-slate-50 transition-colors text-left"
      >
        <div className="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 bg-slate-100 text-slate-500">
          <BarChart3 size={16} />
        </div>
        <span className="font-medium text-slate-900 flex-1">Journal de synchronisation</span>
        <span className="text-xs text-slate-400">
          24h : <span className="text-green-600 font-medium">{successCount}</span> ok
          {errorCount > 0 && <>, <span className="text-red-500 font-medium">{errorCount}</span> err</>}
        </span>
      </button>

      {open && (
        <div className="border-t border-slate-100">
          <div className="px-4 py-2 flex items-center justify-between bg-slate-50/50">
            <div className="flex gap-4 text-xs text-slate-500">
              {lastScheduled && <span>Dernière planifiée : {fmtTime(lastScheduled.created_at)}</span>}
              {lastWebhook && <span>Dernier webhook : {fmtTime(lastWebhook.created_at)}</span>}
            </div>
            <select
              value={filter}
              onChange={e => { setFilter(e.target.value); setLoading(true) }}
              className="text-xs border border-slate-200 rounded-lg px-2 py-1.5 bg-white text-slate-600"
            >
              <option value="">Tous les modules</option>
              {modules.map(m => <option key={m} value={m}>{MODULE_LABELS[m] || m}</option>)}
            </select>
          </div>

          {loading && logs.length === 0 ? (
            <div className="flex items-center justify-center h-20">
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-indigo-600" />
            </div>
          ) : logs.length === 0 ? (
            <div className="px-5 py-6 text-center text-sm text-slate-400">Aucun log</div>
          ) : (
            <div className="max-h-72 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 sticky top-0">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium text-slate-500">Heure</th>
                    <th className="text-left px-4 py-2 font-medium text-slate-500">Module</th>
                    <th className="text-left px-4 py-2 font-medium text-slate-500">Source</th>
                    <th className="text-left px-4 py-2 font-medium text-slate-500">Statut</th>
                    <th className="text-right px-4 py-2 font-medium text-slate-500">Modifiés</th>
                    <th className="text-right px-4 py-2 font-medium text-slate-500">Durée</th>
                    <th className="text-left px-4 py-2 font-medium text-slate-500">Erreur</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {logs.map(l => (
                    <tr key={l.id} className={l.status === 'error' ? 'bg-red-50/50' : ''}>
                      <td className="px-4 py-1.5 text-slate-500 whitespace-nowrap">{fmtTime(l.created_at)}</td>
                      <td className="px-4 py-1.5 font-medium text-slate-700">{MODULE_LABELS[l.module] || l.module}</td>
                      <td className="px-4 py-1.5">
                        <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${TRIGGER_COLORS[l.trigger] || 'bg-slate-100 text-slate-600'}`}>
                          {TRIGGER_LABELS[l.trigger] || l.trigger}
                        </span>
                      </td>
                      <td className="px-4 py-1.5">
                        {l.status === 'success'
                          ? <span className="text-green-600 font-medium">OK</span>
                          : <span className="text-red-500 font-medium">Erreur</span>}
                      </td>
                      <td className="px-4 py-1.5 text-right text-slate-600">
                        {l.records_modified > 0 && <span>+{l.records_modified}</span>}
                        {l.records_destroyed > 0 && <span className="text-red-400 ml-1">-{l.records_destroyed}</span>}
                        {l.records_modified === 0 && l.records_destroyed === 0 && <span className="text-slate-300">—</span>}
                      </td>
                      <td className="px-4 py-1.5 text-right text-slate-400">{l.duration_ms != null ? `${(l.duration_ms / 1000).toFixed(1)}s` : '—'}</td>
                      <td className="px-4 py-1.5 text-red-400 max-w-48 truncate" title={l.error_message || ''}>{l.error_message || ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const SYNC_LABELS = {
  gmail: 'Gmail', drive: 'Drive', airtable: 'CRM Airtable',
  projets: 'Projets', pieces: 'Pièces', orders: 'Commandes',
  achats: 'Achats', billets: 'Billets', serials: 'N° de série', envois: 'Envois',
  stripe: 'Stripe', 'qb-depenses': 'QB Dépenses', 'qb-factures': 'QB Factures',
}

export function ConnectorsContent() {
  const [data, setData] = useState({ accounts: [], config: {}, airtable_sync: {}, projets_sync: {}, pieces: {}, orders_sync: {}, achats: {}, billets: {}, serials: {}, envois: {}, stripe_configured: false, novoxpress_configured: false })
  const [loading, setLoading] = useState(true)
  const { status: syncStatus, anyRunning } = useSyncStatus(3000)

  const load = async (showSpinner = true) => {
    if (showSpinner) setLoading(true)
    try {
      const d = await api.connectors.list()
      setData(d)
    } finally { if (showSpinner) setLoading(false) }
  }

  useEffect(() => { load() }, [])

  // Handle OAuth redirect result
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    if (params.get('success') || params.get('error')) {
      window.history.replaceState({}, '', window.location.pathname)
      load()
    }
  }, [])

  return (
    <div>
      <div className="mb-6">
        <h2 className="text-2xl font-bold text-slate-900">Connecteurs</h2>
        <p className="text-sm text-slate-500 mt-0.5">Intégrez vos outils externes à l'ERP</p>
      </div>

        {anyRunning && (
          <div className="mb-4 flex items-center gap-3 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
            <RefreshCw size={15} className="animate-spin text-amber-500 flex-shrink-0" />
            <span className="font-medium">Synchronisation en cours :</span>
            <span>
              {Object.entries(syncStatus)
                .filter(([, s]) => s.running)
                .map(([k]) => SYNC_LABELS[k] || k)
                .join(', ')}
            </span>
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center h-32">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" />
          </div>
        ) : (
          <>
            <div className="space-y-4">
              {CONNECTORS.map(connector => (
                <ConnectorCard
                  key={connector.id}
                  connector={connector}
                  accounts={data.accounts || []}
                  config={data.config || {}}
                  stripeConfigured={!!data.stripe_configured}
                  novoxpressConfigured={!!data.novoxpress_configured}
                  syncConfigs={{
                    contacts:      data.contacts_sync    || {},
                    companies:     data.companies_sync   || {},
                    projets:       data.projets_sync    || {},
                    orders:        data.orders_sync     || {},
                    pieces:        data.pieces          || {},
                    achats:        data.achats          || {},
                    billets:       data.billets         || {},
                    serials:       data.serials         || {},
                    envois:        data.envois          || {},
                    soumissions:   data.soumissions     || {},
                    adresses:      data.adresses        || {},
                    bom:           data.bom             || {},
                    serial_changes:data.serial_changes  || {},
                    abonnements:   data.abonnements     || {},
                    assemblages:   data.assemblages     || {},
                    factures:      data.factures        || {},
                    retours:       data.retours         || {},
                    retour_items:  data.retour_items    || {},
                  }}
                  syncStatus={syncStatus}
                  onRefresh={() => load(false)}
                />
              ))}
            </div>

            <div className="mt-6">
              <SyncLogPanel />
            </div>
          </>
        )}
    </div>
  )
}

export default function Connectors() {
  return <Layout><div className="p-6 max-w-4xl mx-auto"><ConnectorsContent /></div></Layout>
}
