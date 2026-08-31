import { useState, useEffect, useCallback } from 'react'
import { CheckCircle, XCircle, Link2, RefreshCw, Trash2, Mail, Database, CreditCard, BarChart3, Plus, Phone, Eye, EyeOff, Copy, BookOpen, Truck, Users, Send, Percent, ShoppingCart, User, Instagram, Cpu, FileText } from 'lucide-react'
import { Link } from 'react-router-dom'
import api from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'
import AirtableConfig from './AirtableConfig.jsx'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { useSyncStatus } from '../lib/useSyncStatus.js'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { TaxMappingModal } from '../components/TaxMappingModal.jsx'
import QuickBooksAccountCard from '../components/QuickBooksAccountCard.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDateTime } from '../lib/formatDate.js'
import { HubSpotExportModal } from '../components/HubSpotExportModal.jsx'

function WhisperConfig() {
  const { addToast } = useToast()
  const [data, setData] = useState(null)
  const [apiKey, setApiKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const [_retrying, setRetrying] = useState(false)
  const [_retryResult, setRetryResult] = useState(null)
  const [_fixingTs, _setFixingTs] = useState(false)
  const [_fixTsResult, _setFixTsResult] = useState(null)
  const [_deduping, _setDeduping] = useState(false)
  const [_dedupResult, _setDedupResult] = useState(null)
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
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
    finally { setSaving(false) }
  }

  const startDriveDownload = async () => {
    const r = await api.connectors.whisperDownloadDrive()
    setDownloadProgress({ running: true, done: 0, total: r.total, errors: 0 })
  }

  const _retry = async () => {
    setRetrying(true)
    setRetryResult(null)
    try {
      const r = await api.connectors.whisperRetry()
      setRetryResult(r)
      setTimeout(load, 2000)
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
    finally { setRetrying(false) }
  }

  if (!data) return <div className="mt-4 text-sm text-slate-400">Chargement…</div>

  const statMap = Object.fromEntries(data.stats.map(s => [s.transcription_status, s.total]))
  const done    = statMap.done    || 0
  const pending = statMap.pending || 0
  const error   = statMap.error   || 0
  const _total  = done + pending + error + (statMap.processing || 0)

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
  const { addToast } = useToast()
  const [data, setData] = useState(null)
  const [showAdd, setShowAdd] = useState(false)
  const [form, setForm] = useState({ ftpUser: '', ftpPass: '', nom: '', erpUserId: '' })
  const [saving, setSaving] = useState(false)
  const [visiblePass, setVisiblePass] = useState({})
  const [copied, setCopied] = useState(null)
  const confirm = useConfirm()

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
      addToast({ message: e.message, type: 'error' })
    } finally { setSaving(false) }
  }

  const deletePhone = async (ftpUser) => {
    if (!(await confirm(`Supprimer le téléphone "${ftpUser}" ?`))) return
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
                <SearchableSelect
                  testId="cubeacr-erpuser-select"
                  className="input"
                  size="sm"
                  value={form.erpUserId}
                  onChange={v => setForm(f => ({ ...f, erpUserId: v }))}
                  options={data.erpUsers.filter(u => !u.ftp_username)}
                  getOptionValue={u => u.id}
                  getOptionLabel={u => u.name}
                  placeholder="— Sélectionner —"
                  searchPlaceholder="Rechercher un utilisateur…"
                />
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
  { id: 'postmark',   name: 'Postmark',    icon: Send,       color: 'bg-sky-50 text-sky-600',      alwaysConnected: true },
  { id: 'airtable',   name: 'Airtable',    icon: Database,   color: 'bg-amber-50 text-amber-600' },
  { id: 'calls',      name: 'Appels',      icon: Phone,      color: 'bg-green-50 text-green-600', alwaysConnected: true },
  { id: 'quickbooks', name: 'QuickBooks',  icon: BookOpen,   color: 'bg-green-50 text-green-700' },
  { id: 'stripe',     name: 'Stripe',      icon: CreditCard, color: 'bg-purple-50 text-purple-600', apiKeyManaged: true },
  { id: 'novoxpress', name: 'Novoxpress',  icon: Truck,      color: 'bg-orange-50 text-orange-600', apiKeyManaged: true },
  { id: 'ups',        name: 'UPS',         icon: Truck,      color: 'bg-amber-50 text-amber-800',  apiKeyManaged: true },
  { id: 'purolator',  name: 'Purolator',   icon: Truck,      color: 'bg-purple-50 text-purple-700', apiKeyManaged: true },
  { id: 'hubspot',    name: 'HubSpot',     icon: Users,      color: 'bg-rose-50 text-rose-600',     apiKeyManaged: true },
  { id: 'amazon',     name: 'Amazon Business', icon: ShoppingCart, color: 'bg-orange-50 text-orange-700' },
  { id: 'digikey',    name: 'DigiKey',     icon: Cpu,        color: 'bg-red-50 text-red-700',      apiKeyManaged: true },
  { id: 'instagram',  name: 'Instagram',   icon: Instagram,  color: 'bg-pink-50 text-pink-600',    apiKeyManaged: true },
]

/**
 * Instagram — cookie de session pour la lecture des commentaires.
 *
 * Instagram n'offre aucune API qui donne les commentaires d'un compte sans une
 * revue d'application Meta. On passe donc par l'API web privée, celle du site,
 * qui demande le cookie d'un compte connecté. Le cookie expire environ une fois
 * par an : quand la page Prospects Instagram signale une erreur 401, c'est ici
 * qu'on en recolle un frais.
 */
function InstagramConfig() {
  const { addToast } = useToast()
  const [state, setState] = useState(null)          // { configured, hint, ds_user_id }
  const [sessionid, setSessionid] = useState('')
  const [dsUserId, setDsUserId] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const confirm = useConfirm()

  const load = useCallback(() => {
    api.instagram.session().then(s => { setState(s); setDsUserId(s.ds_user_id || '') }).catch(() => {})
  }, [])
  useEffect(() => { load() }, [load])

  const save = async () => {
    setSaving(true)
    try {
      await api.instagram.setSession({ sessionid, ds_user_id: dsUserId })
      setSessionid('')
      addToast({ message: 'Cookie Instagram enregistré', type: 'success' })
      load()
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
    finally { setSaving(false) }
  }

  const remove = async () => {
    if (!(await confirm('Supprimer le cookie Instagram ? La lecture automatique des commentaires cessera de fonctionner.'))) return
    try {
      await api.instagram.setSession({ sessionid: '', ds_user_id: '' })
      setDsUserId('')
      load()
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
  }

  return (
    <div className="mt-4 space-y-4">
      <div className="bg-slate-50 rounded-xl p-4 space-y-3">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Cookie de session</p>
        {state?.configured
          ? <p className="text-sm text-green-600 font-medium flex items-center gap-1.5"><CheckCircle size={14} /> Cookie configuré ({state.hint})</p>
          : <p className="text-sm text-amber-600 font-medium flex items-center gap-1.5"><XCircle size={14} /> Aucun cookie — la lecture des commentaires ne peut pas tourner</p>
        }
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type={showKey ? 'text' : 'password'}
              className="input pr-8 font-mono text-sm"
              placeholder="sessionid"
              value={sessionid}
              onChange={e => setSessionid(e.target.value)}
            />
            <button onClick={() => setShowKey(v => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
              {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <input
            className="input font-mono text-sm w-40"
            placeholder="ds_user_id"
            value={dsUserId}
            onChange={e => setDsUserId(e.target.value)}
          />
          <button onClick={save} disabled={saving || !sessionid} className="btn-primary btn-sm">
            {saving ? 'Sauvegarde…' : state?.configured ? 'Mettre à jour' : 'Enregistrer'}
          </button>
          {state?.configured && (
            <button onClick={remove} className="btn-secondary btn-sm text-red-500 hover:text-red-600">
              <Trash2 size={14} />
            </button>
          )}
        </div>
        <p className="text-xs text-slate-400">
          Dans un Chrome connecté au compte Instagram : DevTools → Application → Cookies → instagram.com → copier
          <code className="mx-1">sessionid</code> et <code className="mx-1">ds_user_id</code>.
          Le cookie expire environ une fois par an — le recoller ici quand la page{' '}
          <Link to="/prospects-instagram" className="underline hover:text-slate-600">Prospects Instagram</Link> signale une erreur 401.
        </p>
      </div>
    </div>
  )
}

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

function parseAutoDetect(config) {
  try {
    const list = JSON.parse(config?.invoice_autodetect_mailboxes || '[]')
    return Array.isArray(list) ? list.map(e => String(e).toLowerCase()) : []
  } catch { return [] }
}

function parseTrashAfterImport(config) {
  try {
    const list = JSON.parse(config?.invoice_trash_after_import_mailboxes || '[]')
    return Array.isArray(list) ? list.map(e => String(e).toLowerCase()) : []
  } catch { return [] }
}

function parseInvoiceOnly(config) {
  try {
    const list = JSON.parse(config?.invoice_only_mailboxes || '[]')
    return Array.isArray(list) ? list.map(e => String(e).toLowerCase()) : []
  } catch { return [] }
}

function parseAutoDetectSenders(config) {
  try {
    const map = JSON.parse(config?.invoice_autodetect_senders || '{}')
    return map && typeof map === 'object' && !Array.isArray(map) ? map : {}
  } catch { return {} }
}

function GoogleConfig({ accounts, config, syncStatus, onRefresh }) {
  const [folders, setFolders] = useState(() => parseDriveFolders(config))
  const [autoDetect, setAutoDetect] = useState(() => parseAutoDetect(config))
  const [trashAfterImport, setTrashAfterImport] = useState(() => parseTrashAfterImport(config))
  const [invoiceOnly, setInvoiceOnly] = useState(() => parseInvoiceOnly(config))
  const [senders, setSenders] = useState(() => parseAutoDetectSenders(config))
  const [newAccount, setNewAccount] = useState('')
  const [_users, setUsers] = useState([])
  const [saving, setSaving] = useState(false)
  const confirm = useConfirm()

  // Autosave immédiat (règle autosave) : les interrupteurs par boîte n'attendent
  // pas le bouton Enregistrer, qui ne sert qu'aux dossiers Drive.
  async function toggleAutoDetect(email) {
    const key = (email || '').toLowerCase()
    const next = autoDetect.includes(key) ? autoDetect.filter(e => e !== key) : [...autoDetect, key]
    setAutoDetect(next)
    try {
      await api.connectors.saveConfig('google', { invoice_autodetect_mailboxes: JSON.stringify(next) })
    } catch {
      setAutoDetect(autoDetect)
    }
  }

  async function toggleTrashAfterImport(email) {
    const key = (email || '').toLowerCase()
    const next = trashAfterImport.includes(key) ? trashAfterImport.filter(e => e !== key) : [...trashAfterImport, key]
    setTrashAfterImport(next)
    try {
      await api.connectors.saveConfig('google', { invoice_trash_after_import_mailboxes: JSON.stringify(next) })
    } catch {
      setTrashAfterImport(trashAfterImport)
    }
  }

  async function toggleInvoiceOnly(email) {
    const key = (email || '').toLowerCase()
    const next = invoiceOnly.includes(key) ? invoiceOnly.filter(e => e !== key) : [...invoiceOnly, key]
    setInvoiceOnly(next)
    try {
      await api.connectors.saveConfig('google', { invoice_only_mailboxes: JSON.stringify(next) })
    } catch {
      setInvoiceOnly(invoiceOnly)
    }
  }

  // Liste blanche d'expéditeurs saisie en clair, séparée par virgules.
  // Autosave au blur (règle autosave) : pas de bouton pour cette ligne.
  async function saveSenders(email, raw) {
    const key = (email || '').toLowerCase()
    const list = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
    const next = { ...senders }
    if (list.length) next[key] = list
    else delete next[key]
    setSenders(next)
    try {
      await api.connectors.saveConfig('google', { invoice_autodetect_senders: JSON.stringify(next) })
    } catch {
      setSenders(senders)
    }
  }

  async function disconnect(account) {
    const ok = await confirm({
      title: 'Déconnecter le compte Google',
      message: `Déconnecter « ${account.account_email} » ?\n\n` +
        `• Les tokens OAuth chiffrés de ce compte seront supprimés (irréversible).\n` +
        `• La synchronisation Gmail/Drive de ce compte s'arrêtera.\n` +
        `• Pour le reconnecter, il faudra refaire tout le flux d'autorisation Google.`,
      confirmLabel: 'Déconnecter',
    })
    if (!ok) return
    await api.connectors.disconnect(account.id)
    onRefresh()
  }

  useEffect(() => {
    api.admin.listUsers().then(setUsers).catch(() => {})
  }, [])

  function _addFolder() {
    setFolders(f => [...f, { folder_id: '', email: '', user_id: '', label: '' }])
  }

  function _updateFolder(i, field, value) {
    setFolders(f => f.map((entry, idx) => idx === i ? { ...entry, [field]: value } : entry))
  }

  function _removeFolder(i) {
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
            <div key={a.id} className="p-2 bg-slate-50 rounded-lg mb-1">
             <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 min-w-0 flex-wrap">
                <span className="text-sm text-slate-700 truncate">{a.account_email}</span>
                <label
                  className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer whitespace-nowrap"
                  title="Ingère automatiquement dans les reçus toute facture reçue dans cette boîte (30 derniers jours), sans label ni passage par factures@orisha.io"
                >
                  <input
                    type="checkbox"
                    checked={autoDetect.includes((a.account_email || '').toLowerCase())}
                    onChange={() => toggleAutoDetect(a.account_email)}
                    className="rounded border-slate-300"
                  />
                  Détection auto des factures
                </label>
                <label
                  className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer whitespace-nowrap"
                  title="Après ingestion d'une facture de cette boîte par l'extracteur (import ou doublon déjà importé), le courriel est mis à la corbeille Gmail (récupérable 30 jours). Nécessite de reconnecter le compte après activation pour accorder la permission Gmail « modifier »."
                >
                  <input
                    type="checkbox"
                    checked={trashAfterImport.includes((a.account_email || '').toLowerCase())}
                    onChange={() => toggleTrashAfterImport(a.account_email)}
                    className="rounded border-slate-300"
                  />
                  Corbeille après import
                </label>
                <label
                  className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer whitespace-nowrap"
                  title="Boîte connectée uniquement pour router des factures : le sync des courriels (emails, interactions, création automatique de contacts) est désactivé pour ce compte. À cocher pour toute boîte personnelle — sinon la correspondance privée atterrit dans le CRM."
                >
                  <input
                    type="checkbox"
                    checked={invoiceOnly.includes((a.account_email || '').toLowerCase())}
                    onChange={() => toggleInvoiceOnly(a.account_email)}
                    className="rounded border-slate-300"
                  />
                  Boîte factures seulement
                </label>
              </div>
              <div className="flex gap-2">
                <SyncBtn label="Gmail" syncKey="gmail" syncStatus={syncStatus} onSync={() => api.connectors.syncGmail()} />
                <button
                  onClick={() => {
                    const token = localStorage.getItem('erp_token')
                    window.location.href = `/erp/api/connectors/google/connect?token=${token}&account=${encodeURIComponent(a.account_email || '')}`
                  }}
                  className="btn-secondary btn-sm text-xs flex items-center gap-1"
                  title="Relance le consentement Google pour ce compte afin de rafraîchir ses scopes (ex: gmail.send, gmail.compose)"
                >
                  <Link2 size={12} /> Reconnecter
                </button>
                <button onClick={() => disconnect(a)} className="text-red-400 hover:text-red-600 p-1" title="Déconnecter">
                  <Trash2 size={14} />
                </button>
              </div>
             </div>
             {autoDetect.includes((a.account_email || '').toLowerCase()) && (
               <div className="flex items-center gap-2 mt-2 pl-1">
                 <span className="text-xs text-slate-400 whitespace-nowrap">Expéditeurs autorisés</span>
                 <input
                   type="text"
                   defaultValue={(senders[(a.account_email || '').toLowerCase()] || []).join(', ')}
                   onBlur={e => saveSenders(a.account_email, e.target.value)}
                   placeholder="tous les expéditeurs"
                   className="input text-xs py-1 flex-1 min-w-0"
                   title="Limite la détection auto de cette boîte à ces expéditeurs (domaine ou adresse complète, séparés par des virgules). Vide = aucune restriction. Le label ERP/Factures et factures@orisha.io ne sont jamais filtrés."
                 />
               </div>
             )}
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2 items-center">
        {/* L'adresse est transmise en login_hint : elle pré-sélectionne le compte
            chez Google ET détermine les scopes demandés (corbeille, brouillons),
            qui se lisent dans la config par boîte. Connecter sans la préciser
            oblige à reconnecter le compte ensuite pour élargir le consentement. */}
        <input
          type="email"
          value={newAccount}
          onChange={e => setNewAccount(e.target.value)}
          placeholder="adresse du compte à connecter (optionnel)"
          className="input text-xs py-1 w-72"
        />
        <button
          onClick={() => {
            const token = localStorage.getItem('erp_token')
            const hint = newAccount.trim().toLowerCase()
            window.location.href = `/erp/api/connectors/google/connect?token=${token}` +
              (hint ? `&account=${encodeURIComponent(hint)}` : '')
          }}
          className="btn-secondary btn-sm"
        >
          <Plus size={12} /> Connecter un autre compte
        </button>
        <button onClick={save} disabled={saving} className="btn-primary btn-sm">{saving ? 'Enregistrement...' : 'Enregistrer'}</button>
      </div>
    </div>
  )
}


function PostmarkConfig() {
  const { addToast } = useToast()
  const [data, setData] = useState(null)
  const [saving, setSaving] = useState(false)
  const [value, setValue] = useState('')

  const load = async () => {
    try {
      const d = await api.connectors.postmarkInfo()
      setData(d)
      setValue(d.default_from || '')
    } catch {}
  }
  useEffect(() => { load() }, [])

  const save = async () => {
    setSaving(true)
    try {
      await api.connectors.postmarkSetDefault(value || null)
      await load()
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
    finally { setSaving(false) }
  }

  if (!data) return <div className="mt-4 text-sm text-slate-400">Chargement…</div>

  return (
    <div className="mt-4 space-y-4">
      <div className="bg-slate-50 rounded-xl p-4 space-y-3">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Adresse expéditeur par défaut</p>
        <p className="text-xs text-slate-500">
          Utilisée pour tous les courriels transactionnels (notifications d'expédition, suivi d'installation, field rules). Le domaine <code>orisha.io</code> est DKIM-verified chez Postmark — toute adresse <code>@orisha.io</code> est acceptée.
        </p>
        <SearchableSelect
          testId="postmark-default-from-select"
          className="input"
          size="sm"
          value={value}
          onChange={setValue}
          options={data.addresses}
          getOptionValue={a => a}
          getOptionLabel={a => a}
          emptyOption="— Aucun —"
          placeholder="— Aucun —"
          searchPlaceholder="Rechercher une adresse…"
        />
        <div className="flex gap-2">
          <button onClick={save} disabled={saving || value === (data.default_from || '')} className="btn-primary btn-sm">
            {saving ? 'Sauvegarde…' : 'Enregistrer'}
          </button>
          {data.default_from && (
            <span className="text-xs text-slate-500 self-center">
              Actuel : <code>{data.default_from}</code>
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

function QuickBooksConfig({ accounts, onRefresh }) {
  const connectedAccounts = accounts.filter(a => a.connector === 'quickbooks')
  const [taxModalOpen, setTaxModalOpen] = useState(false)
  const confirm = useConfirm()

  const reconnect = () => {
    const token = localStorage.getItem('erp_token')
    window.location.href = `/erp/api/connectors/quickbooks/connect?token=${token}`
  }

  const disconnect = async (account) => {
    const ok = await confirm({
      title: 'Déconnecter QuickBooks',
      message: `Déconnecter QuickBooks ?\n\n` +
        `• Les tokens OAuth chiffrés seront supprimés (irréversible).\n` +
        `• La publication des reçus/dépôts/dépenses vers QuickBooks s'arrêtera.\n` +
        `• Pour le reconnecter, il faudra refaire tout le flux d'autorisation QuickBooks.`,
      confirmLabel: 'Déconnecter',
    })
    if (!ok) return
    await api.connectors.disconnect(account.id)
    onRefresh()
  }

  return (
    <div className="mt-4 space-y-3">
      {connectedAccounts.map(a => (
        <div key={a.id} className="flex items-center justify-between p-2 bg-slate-50 rounded-lg">
          <div className="flex items-center gap-2">
            <CheckCircle size={14} className="text-green-500" />
            <span className="text-sm text-slate-700">QuickBooks connecté</span>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={reconnect} className="btn-secondary btn-sm text-xs" title="Réautoriser QuickBooks (si le token a expiré)">
              <Link2 size={12} /> Reconnecter
            </button>
            <button onClick={() => disconnect(a)} className="text-red-400 hover:text-red-600 p-1" title="Déconnecter">
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      ))}
      {connectedAccounts.length > 0 && (
        <>
          <MyQuickBooksConnection />
          <QuickBooksUserConnections />
          <p className="text-xs text-slate-400">
            Les comptes de dépense, de paiement et le fournisseur sont sélectionnés par l'opérateur au moment de publier chaque reçu depuis la page <strong>Extraction de données</strong>.
          </p>
          <div className="pt-2 border-t border-slate-100">
            <button
              onClick={() => setTaxModalOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50"
              title="Mapping des taxes Stripe → QuickBooks"
            >
              <Percent size={12} /> Taxes Stripe → QB
            </button>
          </div>
          <TaxMappingModal isOpen={taxModalOpen} onClose={() => setTaxModalOpen(false)} />
        </>
      )}
    </div>
  )
}

// Connexion QuickBooks personnelle de l'utilisateur courant (section dans l'onglet
// Connecteurs). Le même bloc est aussi exposé dans /settings pour les non-admins.
function MyQuickBooksConnection() {
  return (
    <div className="pt-2 border-t border-slate-100 space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
        <User size={12} /> Mon compte QuickBooks
      </div>
      <QuickBooksAccountCard />
    </div>
  )
}

// Vue admin : liste des connexions QuickBooks personnelles de tous les utilisateurs.
function QuickBooksUserConnections() {
  const { user } = useAuth()
  const [conns, setConns] = useState([])
  const confirm = useConfirm()

  const load = async () => {
    try { setConns(await api.connectors.qbConnections()) } catch { setConns([]) }
  }
  useEffect(() => { if (user?.role === 'admin') load() }, [user?.role])

  if (user?.role !== 'admin') return null
  const personal = conns.filter(c => !c.isDefault)
  if (personal.length === 0) return null

  const disconnect = async (c) => {
    const ok = await confirm({
      title: 'Déconnecter cette personne',
      message: `Déconnecter le compte QuickBooks de ${c.userName || 'cet utilisateur'} ?\n\n` +
        `Ses prochaines publications seront de nouveau attribuées au compte principal.`,
      confirmLabel: 'Déconnecter',
    })
    if (!ok) return
    await api.connectors.qbDisconnectUser(c.accountKey)
    load()
  }

  return (
    <div className="pt-2 border-t border-slate-100 space-y-1.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-slate-600">
        <Users size={12} /> Comptes personnels connectés
      </div>
      {personal.map(c => (
        <div key={c.accountKey} className="flex items-center justify-between p-2 bg-slate-50 rounded-lg">
          <div className="flex items-center gap-2">
            <CheckCircle size={14} className="text-green-500" />
            <span className="text-xs text-slate-700">{c.userName || c.accountKey}</span>
            {c.updatedAt && <span className="text-[11px] text-slate-400">depuis le {fmtDateTime(c.updatedAt)}</span>}
          </div>
          <button onClick={() => disconnect(c)} className="text-red-400 hover:text-red-600 p-1" title="Déconnecter">
            <Trash2 size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}

function AmazonConfig({ accounts, configured, syncStatus, onRefresh }) {
  const connectedAccounts = accounts.filter(a => a.connector === 'amazon')
  const confirm = useConfirm()

  const reconnect = () => {
    const token = localStorage.getItem('erp_token')
    window.location.href = `/erp/api/connectors/amazon/connect?token=${token}`
  }

  const sync = async () => {
    await api.connectors.sync('amazon')
    onRefresh()
  }

  const disconnect = async (account) => {
    const ok = await confirm({
      title: 'Déconnecter Amazon Business',
      message: `Déconnecter Amazon Business ?\n\n` +
        `• Les tokens OAuth seront supprimés (irréversible).\n` +
        `• La récupération automatique des factures Amazon s'arrêtera.\n` +
        `• Pour le reconnecter, il faudra refaire le flux d'autorisation Amazon.`,
      confirmLabel: 'Déconnecter',
    })
    if (!ok) return
    await api.connectors.disconnect(account.id)
    onRefresh()
  }

  return (
    <div className="mt-4 space-y-3">
      {!configured && (
        <p className="text-xs text-amber-600 bg-amber-50 rounded-lg p-2">
          ⚠ Identifiants API Amazon Business absents (<code>AMAZON_CLIENT_ID</code> / <code>AMAZON_CLIENT_SECRET</code>).
          La connexion sera possible une fois l'onboarding développeur Amazon Business approuvé et les clés ajoutées au serveur.
        </p>
      )}
      {connectedAccounts.map(a => (
        <div key={a.id} className="flex items-center justify-between p-2 bg-slate-50 rounded-lg">
          <div className="flex items-center gap-2">
            <CheckCircle size={14} className="text-green-500" />
            <span className="text-sm text-slate-700">Amazon Business connecté</span>
          </div>
          <div className="flex items-center gap-1">
            <button onClick={reconnect} className="btn-secondary btn-sm text-xs" title="Réautoriser Amazon (si le token a expiré)">
              <Link2 size={12} /> Reconnecter
            </button>
            <button onClick={() => disconnect(a)} className="text-red-400 hover:text-red-600 p-1" title="Déconnecter">
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      ))}
      {connectedAccounts.length > 0 && (
        <>
          <SyncBtn label="Importer les factures" syncKey="amazon" syncStatus={syncStatus} onSync={sync} />
          <p className="text-xs text-slate-400">
            Les factures Amazon récupérées arrivent dans la page <strong>Extraction de données</strong> où l'IA extrait les montants, comme pour les reçus importés par courriel.
          </p>
        </>
      )}
    </div>
  )
}

// UPS — OAuth 2.0 « client credentials » (POST /security/v1/oauth/token) : une
// paire client_id / client_secret du portail developer.ups.com + le numéro de
// compte UPS (payeur des étiquettes). Les trois sont chiffrés en base.
// Deux environnements strictement séparés : CIE (bac à sable, aucune
// facturation, étiquettes non utilisables) et production.
function UpsConfig({ configured: initialConfigured, onRefresh }) {
  const { addToast } = useToast()
  const confirm = useConfirm()
  const [status, setStatus] = useState(null)
  const [configured, setConfigured] = useState(initialConfigured)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [accountNumber, setAccountNumber] = useState('')
  const [showSecret, setShowSecret] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState(null) // { ok, message }
  const [advanced, setAdvanced] = useState(false)

  const load = useCallback(async () => {
    try {
      const st = await api.ups.status()
      setStatus(st)
      setConfigured(st.configured)
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
  }, [addToast])

  useEffect(() => { load() }, [load])

  // Exception documentée à la règle d'autosave : les trois identifiants n'ont
  // de sens qu'ensemble (un client_id sans secret ne sert à rien) et le secret
  // est en écriture seule — on enregistre le bloc, comme DigiKey et Stripe.
  const saveCredentials = async () => {
    setSaving(true)
    try {
      await api.ups.saveConfig({
        ...(clientId ? { client_id: clientId } : {}),
        ...(clientSecret ? { client_secret: clientSecret } : {}),
        ...(accountNumber ? { account_number: accountNumber } : {}),
      })
      setClientSecret('')
      setTestResult(null)
      await load()
      onRefresh?.()
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
    finally { setSaving(false) }
  }

  // Réglages non secrets : autosave immédiate (règle de design CLAUDE.md).
  const saveField = async (key, value) => {
    if (status?.config?.[key] === value) return
    try {
      const r = await api.ups.saveConfig({ [key]: value })
      setStatus(st => ({ ...st, config: r.config, configured: r.configured }))
      setConfigured(r.configured)
      setTestResult(null)
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
  }

  const removeCredentials = async () => {
    if (!(await confirm({
      title: 'Supprimer les identifiants UPS',
      message: "Les clés OAuth et le numéro de compte seront effacés. Les étiquettes déjà achetées et leur suivi restent en place.",
      confirmLabel: 'Supprimer',
    }))) return
    try {
      await api.ups.deleteConfig()
      setClientId(''); setClientSecret(''); setAccountNumber(''); setTestResult(null)
      await load()
      onRefresh?.()
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
  }

  // Test de connexion : mint d'un jeton OAuth uniquement — rien de facturable.
  const testConnection = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const r = await api.ups.test()
      setTestResult({ ok: true, message: `Connexion réussie — environnement ${r.environment === 'production' ? 'production' : 'CIE (test)'} (${r.base_url})` })
    } catch (e) {
      // Message BRUT de l'API UPS, jamais masqué (CLAUDE.md).
      setTestResult({ ok: false, message: e.message })
    } finally { setTesting(false) }
  }

  const cfg = status?.config || {}
  const last = status?.last_sync

  return (
    <div className="mt-4 space-y-4" data-testid="ups-config">
      <div className="bg-slate-50 rounded-xl p-4 space-y-3">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Identifiants OAuth UPS</p>
        {configured
          ? <p className="text-sm text-green-600 font-medium flex items-center gap-1.5"><CheckCircle size={14} /> Application configurée</p>
          : <p className="text-sm text-amber-600 font-medium flex items-center gap-1.5"><XCircle size={14} /> Aucune application configurée</p>
        }
        <div className="space-y-2">
          <input
            type="text"
            className="input font-mono text-sm"
            placeholder={cfg.client_id_set ? 'Client ID (enregistré — laisser vide pour ne pas changer)' : 'Client ID (portail developer.ups.com)'}
            value={clientId}
            onChange={e => setClientId(e.target.value)}
            autoComplete="off"
            data-testid="ups-client-id"
          />
          <div className="relative">
            <input
              type={showSecret ? 'text' : 'password'}
              className="input pr-8 font-mono text-sm"
              placeholder={cfg.client_secret_set ? 'Client Secret (enregistré — laisser vide pour ne pas changer)' : 'Client Secret'}
              value={clientSecret}
              onChange={e => setClientSecret(e.target.value)}
              autoComplete="new-password"
              data-testid="ups-client-secret"
            />
            <button onClick={() => setShowSecret(v => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
              {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <input
            type="text"
            className="input font-mono text-sm"
            placeholder={cfg.account_number_set ? `N° de compte UPS (${cfg.account_number_hint})` : 'N° de compte UPS (payeur des étiquettes)'}
            value={accountNumber}
            onChange={e => setAccountNumber(e.target.value)}
            autoComplete="off"
            data-testid="ups-account-number"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={saveCredentials}
            disabled={saving || (!clientId && !clientSecret && !accountNumber)}
            className="btn-primary btn-sm"
            data-testid="ups-save-credentials"
          >
            {saving ? 'Sauvegarde…' : configured ? 'Mettre à jour' : 'Enregistrer'}
          </button>
          <button
            onClick={testConnection}
            disabled={testing}
            className="btn-secondary btn-sm"
            data-testid="ups-test-connection"
          >
            {testing ? 'Test en cours…' : 'Tester la connexion'}
          </button>
          {configured && (
            <button onClick={removeCredentials} className="btn-secondary btn-sm text-red-500 hover:text-red-600">
              <Trash2 size={14} />
            </button>
          )}
        </div>
        {testResult && (
          <p
            data-testid="ups-test-result"
            className={`text-xs rounded-lg px-3 py-2 whitespace-pre-wrap break-words ${testResult.ok ? 'bg-green-50 border border-green-200 text-green-700' : 'bg-red-50 border border-red-200 text-red-600'}`}
          >
            {testResult.message}
          </p>
        )}
      </div>

      <div className="bg-slate-50 rounded-xl p-4 space-y-3">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Environnement</p>
        <div className="flex flex-wrap gap-2">
          {[['cie', 'CIE (test)'], ['production', 'Production']].map(([value, label]) => (
            <button
              key={value}
              onClick={() => saveField('environment', value)}
              data-testid={`ups-env-${value}`}
              className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${cfg.environment === value ? 'border-brand-500 bg-brand-50 text-brand-700 font-medium' : 'border-slate-200 text-slate-600 hover:border-slate-300'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-xs text-slate-400">
          En CIE (wwwcie.ups.com), les étiquettes sont des tests : rien n'est facturé et elles ne sont pas utilisables pour expédier.
          La valeur par défaut vient de la variable d'environnement <code className="font-mono">UPS_ENV</code>.
        </p>
        <button onClick={() => setAdvanced(v => !v)} className="text-xs text-slate-400 hover:text-slate-600">
          {advanced ? 'Masquer' : 'Afficher'} les versions d'API
        </button>
        {advanced && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {[['shipping_version', 'Shipping'], ['rating_version', 'Rating'], ['tracking_version', 'Tracking']].map(([k, label]) => (
              <div key={k}>
                <p className="text-[11px] text-slate-400 mb-0.5">{label}</p>
                <input
                  type="text" className="input font-mono text-xs"
                  defaultValue={cfg[k] || ''} key={`${k}-${cfg[k] || ''}`}
                  onBlur={e => saveField(k, e.target.value.trim())}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {last && (
        <p className="text-xs text-slate-400">
          Dernier appel UPS : {fmtDateTime(last.created_at)} — {last.status === 'success'
            ? 'OK'
            : <span className="text-red-500">{last.error_message || 'erreur'}</span>}
        </p>
      )}
      <p className="text-xs text-slate-400">
        Utilisé pour les <strong>étiquettes de retour</strong> (fiche retour), la comparaison de tarifs et le suivi des envois.
        Chaque appel est tracé dans le journal des synchronisations ci-dessous (module « UPS »).
      </p>
    </div>
  )
}

// Purolator — E-Ship Web Services (SOAP), authentification HTTP Basic : une
// clé + mot de passe délivrés ensemble par Purolator, plus le numéro de compte
// (payeur des étiquettes). Deux environnements strictement séparés — Dev
// (bac à sable devwebservices.purolator.com, aucune facturation) et
// Production. On démarre toujours en dev tant que les identifiants prod n'ont
// pas été confirmés. Sens unique ERP → Purolator (achat d'étiquette + suivi).
function PurolatorConfig({ configured: initialConfigured, onRefresh }) {
  const { addToast } = useToast()
  const confirm = useConfirm()
  const [status, setStatus] = useState(null)
  const [configured, setConfigured] = useState(initialConfigured)
  const [key, setKey] = useState('')
  const [password, setPassword] = useState('')
  const [accountNumber, setAccountNumber] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    try {
      const st = await api.purolator.status()
      setStatus(st)
      setConfigured(st.configured)
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
  }, [addToast])

  useEffect(() => { load() }, [load])

  // Exception documentée à la règle d'autosave : les trois identifiants n'ont
  // de sens qu'ensemble et le mot de passe est en écriture seule — on
  // enregistre le bloc, comme UPS/DigiKey/Novoxpress.
  const saveCredentials = async () => {
    setSaving(true)
    try {
      await api.purolator.saveConfig({
        ...(key ? { key } : {}),
        ...(password ? { password } : {}),
        ...(accountNumber ? { account_number: accountNumber } : {}),
      })
      setPassword('')
      await load()
      onRefresh?.()
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
    finally { setSaving(false) }
  }

  const saveField = async (k, value) => {
    if (status?.config?.[k] === value) return
    try {
      const r = await api.purolator.saveConfig({ [k]: value })
      setStatus(st => ({ ...st, config: r.config, configured: r.configured }))
      setConfigured(r.configured)
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
  }

  const removeCredentials = async () => {
    if (!(await confirm({
      title: 'Supprimer les identifiants Purolator',
      message: "La clé, le mot de passe et le numéro de compte seront effacés. Les étiquettes déjà achetées et leur suivi restent en place.",
      confirmLabel: 'Supprimer',
    }))) return
    try {
      await api.purolator.deleteConfig()
      setKey(''); setPassword(''); setAccountNumber('')
      await load()
      onRefresh?.()
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
  }

  const cfg = status?.config || {}
  const last = status?.last_sync

  return (
    <div className="mt-4 space-y-4" data-testid="purolator-config">
      <div className="bg-slate-50 rounded-xl p-4 space-y-3">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Identifiants Purolator (E-Ship)</p>
        {configured
          ? <p className="text-sm text-green-600 font-medium flex items-center gap-1.5"><CheckCircle size={14} /> Application configurée</p>
          : <p className="text-sm text-amber-600 font-medium flex items-center gap-1.5"><XCircle size={14} /> Aucune application configurée</p>
        }
        <div className="space-y-2">
          <input
            type="text"
            className="input font-mono text-sm"
            placeholder={cfg.key_set ? 'Clé (enregistrée — laisser vide pour ne pas changer)' : 'Clé Purolator (Key)'}
            value={key}
            onChange={e => setKey(e.target.value)}
            autoComplete="off"
            data-testid="purolator-key"
          />
          <div className="relative">
            <input
              type={showPassword ? 'text' : 'password'}
              className="input pr-8 font-mono text-sm"
              placeholder={cfg.password_set ? 'Mot de passe (enregistré — laisser vide pour ne pas changer)' : 'Mot de passe Purolator'}
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="new-password"
              data-testid="purolator-password"
            />
            <button onClick={() => setShowPassword(v => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
              {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <input
            type="text"
            className="input font-mono text-sm"
            placeholder={cfg.account_number_set ? `N° de compte Purolator (${cfg.account_number_hint})` : 'N° de compte Purolator (payeur des étiquettes)'}
            value={accountNumber}
            onChange={e => setAccountNumber(e.target.value)}
            autoComplete="off"
            data-testid="purolator-account-number"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={saveCredentials}
            disabled={saving || (!key && !password && !accountNumber)}
            className="btn-primary btn-sm"
            data-testid="purolator-save-credentials"
          >
            {saving ? 'Sauvegarde…' : configured ? 'Mettre à jour' : 'Enregistrer'}
          </button>
          {configured && (
            <button onClick={removeCredentials} className="btn-secondary btn-sm text-red-500 hover:text-red-600">
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="bg-slate-50 rounded-xl p-4 space-y-3">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Environnement</p>
        <div className="flex flex-wrap gap-2">
          {[['dev', 'Développement'], ['production', 'Production']].map(([value, label]) => (
            <button
              key={value}
              onClick={() => saveField('environment', value)}
              data-testid={`purolator-env-${value}`}
              className={`px-3 py-1.5 rounded-lg text-sm border transition-colors ${cfg.environment === value ? 'border-brand-500 bg-brand-50 text-brand-700 font-medium' : 'border-slate-200 text-slate-600 hover:border-slate-300'}`}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="text-xs text-slate-400">
          En Développement (devwebservices.purolator.com), rien n'est facturé — utile pour valider l'intégration avant de passer en production.
          La valeur par défaut vient de la variable d'environnement <code className="font-mono">PUROLATOR_ENV</code>.
        </p>
      </div>

      {last && (
        <p className="text-xs text-slate-400">
          Dernier appel Purolator : {fmtDateTime(last.created_at)} — {last.status === 'success'
            ? 'OK'
            : <span className="text-red-500">{last.error_message || 'erreur'}</span>}
        </p>
      )}
      <p className="text-xs text-slate-400">
        Utilisé pour la <strong>tarification et l'achat d'étiquettes sortantes</strong> (fiche envoi, bouton « Tarifer », côte à côte avec Novoxpress) et le suivi horaire.
        Sens unique ERP → Purolator. Chaque appel est tracé dans le journal des synchronisations ci-dessous (module « Purolator »).
      </p>
    </div>
  )
}

// DigiKey — OAuth2 « client credentials » (plan développeur DigiKey) : pas de
// redirection d'autorisation, juste une paire client_id / client_secret. La
// tournée rapatrie les commandes récentes et leur facture PDF, et dépose un
// achat fournisseur EN BROUILLON. Sens unique : rien n'est écrit chez DigiKey.
function DigikeyConfig({ configured: initialConfigured, syncStatus, onRefresh }) {
  const { addToast } = useToast()
  const confirm = useConfirm()
  const [status, setStatus] = useState(null)
  const [configured, setConfigured] = useState(initialConfigured)
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [showSecret, setShowSecret] = useState(false)
  const [saving, setSaving] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [orders, setOrders] = useState([])

  const load = useCallback(async () => {
    try {
      const st = await api.digikey.status()
      setStatus(st)
      setConfigured(st.configured)
      setClientId(st.config?.client_id || '')
      const o = await api.digikey.orders(10)
      setOrders(o.data || [])
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
  }, [addToast])

  useEffect(() => { load() }, [load])

  // Exception documentée à la règle d'autosave : le secret OAuth est un champ
  // en écriture seule (jamais réaffiché) et n'a de sens qu'avec son client_id —
  // on enregistre la paire d'un bloc, comme pour Stripe et Novoxpress.
  const saveCredentials = async () => {
    setSaving(true)
    try {
      await api.digikey.saveConfig({ client_id: clientId, client_secret: clientSecret })
      setClientSecret('')
      await load()
      onRefresh()
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
    finally { setSaving(false) }
  }

  // Réglages non secrets : autosave au blur (règle de design CLAUDE.md).
  const saveField = async (key, value) => {
    if (status?.config?.[key] === value) return
    try {
      const r = await api.digikey.saveConfig({ [key]: value })
      setStatus(st => ({ ...st, config: r.config, configured: r.configured }))
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
  }

  const removeCredentials = async () => {
    if (!(await confirm({
      title: 'Supprimer les identifiants DigiKey',
      message: 'Les clés OAuth seront effacées et la tournée quotidienne cessera de rapatrier les commandes. Les achats déjà créés restent en place.',
      confirmLabel: 'Supprimer',
    }))) return
    try {
      await api.digikey.deleteConfig()
      setClientId(''); setClientSecret('')
      await load()
      onRefresh()
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
  }

  const sync = async () => {
    try {
      await api.digikey.sync()
      addToast({ message: 'Importation DigiKey lancée', type: 'success' })
      setTimeout(load, 4000)
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
  }

  const cfg = status?.config || {}
  const last = status?.last_sync

  return (
    <div className="mt-4 space-y-4">
      <div className="bg-slate-50 rounded-xl p-4 space-y-3">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Identifiants OAuth DigiKey</p>
        {configured
          ? <p className="text-sm text-green-600 font-medium flex items-center gap-1.5"><CheckCircle size={14} /> Application configurée</p>
          : <p className="text-sm text-amber-600 font-medium flex items-center gap-1.5"><XCircle size={14} /> Aucune application configurée</p>
        }
        <div className="space-y-2">
          <input
            type="text"
            className="input font-mono text-sm"
            placeholder="Client ID (portail developer.digikey.com)"
            value={clientId}
            onChange={e => setClientId(e.target.value)}
            autoComplete="off"
          />
          <div className="relative">
            <input
              type={showSecret ? 'text' : 'password'}
              className="input pr-8 font-mono text-sm"
              placeholder={cfg.client_secret_set ? 'Client Secret (enregistré — laisser vide pour ne pas changer)' : 'Client Secret'}
              value={clientSecret}
              onChange={e => setClientSecret(e.target.value)}
              autoComplete="new-password"
            />
            <button onClick={() => setShowSecret(v => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
              {showSecret ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={saveCredentials}
            disabled={saving || !clientId || (!clientSecret && !cfg.client_secret_set)}
            className="btn-primary btn-sm"
            data-testid="digikey-save-credentials"
          >
            {saving ? 'Sauvegarde…' : configured ? 'Mettre à jour' : 'Enregistrer'}
          </button>
          {configured && (
            <button onClick={removeCredentials} className="btn-secondary btn-sm text-red-500 hover:text-red-600">
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>

      <div className="bg-slate-50 rounded-xl p-4 space-y-3">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Compte et région</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <input
            type="text" className="input text-sm" placeholder="N° de client DigiKey (optionnel)"
            defaultValue={cfg.customer_id || ''} key={`cust-${cfg.customer_id || ''}`}
            onBlur={e => saveField('customer_id', e.target.value.trim())}
          />
          <input
            type="text" className="input text-sm" placeholder="Site (CA)"
            defaultValue={cfg.locale_site || ''} key={`site-${cfg.locale_site || ''}`}
            onBlur={e => saveField('locale_site', e.target.value.trim().toUpperCase())}
          />
          <input
            type="text" className="input text-sm" placeholder="Devise (CAD)"
            defaultValue={cfg.locale_currency || ''} key={`cur-${cfg.locale_currency || ''}`}
            onBlur={e => saveField('locale_currency', e.target.value.trim().toUpperCase())}
          />
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-600">
          <input
            type="checkbox" className="rounded border-slate-300"
            checked={cfg.sandbox === '1'}
            onChange={e => saveField('sandbox', e.target.checked ? '1' : '0')}
          />
          Utiliser l'environnement bac à sable de DigiKey
        </label>
        <button onClick={() => setAdvanced(v => !v)} className="text-xs text-slate-400 hover:text-slate-600">
          {advanced ? 'Masquer' : 'Afficher'} les adresses d'API
        </button>
        {advanced && (
          <div className="space-y-2">
            {['api_base', 'history_path', 'salesorder_path', 'invoice_path'].map(k => (
              <div key={k}>
                <p className="text-[11px] text-slate-400 mb-0.5">{k}</p>
                <input
                  type="text" className="input font-mono text-xs"
                  defaultValue={cfg[k] || ''} key={`${k}-${cfg[k] || ''}`}
                  onBlur={e => saveField(k, e.target.value.trim())}
                />
              </div>
            ))}
            <p className="text-xs text-slate-400">
              À ne toucher que si DigiKey change de version d'API. Les jetons {'{salesOrderId}'} et {'{invoiceId}'} sont remplacés à l'appel.
            </p>
          </div>
        )}
      </div>

      {configured && (
        <div className="space-y-2">
          <SyncBtn label="Importer les commandes" syncKey="digikey" syncStatus={syncStatus} onSync={sync} />
          {last && (
            <p className="text-xs text-slate-400">
              Dernière tournée : {fmtDateTime(last.created_at)} — {last.status === 'success'
                ? `${last.records_modified || 0} achat(s) touché(s)`
                : <span className="text-red-500">{last.error_message || 'erreur'}</span>}
            </p>
          )}
          <p className="text-xs text-slate-400">
            Chaque commande facturée devient une <strong>facture fournisseur en brouillon</strong> dans{' '}
            <Link to="/fournisseurs/achats" className="text-blue-500 hover:underline">Fournisseurs → Achats</Link>,
            avec son PDF en pièce jointe. Rien n'est publié dans QuickBooks sans votre clic.
            La fenêtre d'historique se règle dans{' '}
            <Link to="/automations/sys_digikey_orders" className="text-blue-500 hover:underline">l'automation DigiKey</Link>.
          </p>
        </div>
      )}

      {orders.length > 0 && (
        <div>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-2">Dernières commandes rapatriées</p>
          <div className="rounded-lg border border-slate-200 divide-y divide-slate-100">
            {orders.map(o => (
              <div key={o.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className="text-slate-500 tabular-nums w-24 shrink-0">{o.order_date || '—'}</span>
                <span className="font-medium text-slate-700 flex-1 truncate">
                  {o.invoice_id ? `Facture ${o.invoice_id}` : `Commande ${o.sales_order_id}`}
                </span>
                {o.pdf_path && <FileText size={13} className="text-slate-400" title="PDF téléchargé" />}
                <span className="tabular-nums text-slate-600">{o.total != null ? `${Number(o.total).toFixed(2)} ${o.currency || ''}` : '—'}</span>
                {o.achat_id && (
                  <Link to={`/fournisseurs/achats?id=${o.achat_id}`} className="text-blue-500 hover:underline text-xs">
                    {o.achat_status || 'Achat'}
                  </Link>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function NovoxpressConfig({ configured: initialConfigured, onRefresh }) {
  const { addToast } = useToast()
  const [configured, setConfigured] = useState(initialConfigured)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [apiToken, setApiToken] = useState('')
  const [showPass, setShowPass] = useState(false)
  const [saving, setSaving] = useState(false)
  const confirm = useConfirm()

  const save = async () => {
    setSaving(true)
    try {
      // username+password vont ensemble ; api_token (diagnostic env dev) peut
      // être sauvegardé seul — on n'envoie que ce qui est rempli.
      const body = {}
      if (username && password) { body.username = username; body.password = password }
      if (apiToken) body.api_token = apiToken
      await api.novoxpress.saveConfig(body)
      setUsername(''); setPassword(''); setApiToken('')
      setConfigured(true)
      onRefresh()
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
    finally { setSaving(false) }
  }

  const remove = async () => {
    if (!(await confirm('Supprimer les identifiants Novoxpress ?'))) return
    try {
      await api.novoxpress.deleteConfig()
      setConfigured(false)
      onRefresh()
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
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
          <input
            type="password"
            className="input"
            placeholder="Token API (diagnostic env. dev — généré sur app.novoxpress.ca/generate-my-token)"
            value={apiToken}
            onChange={e => setApiToken(e.target.value)}
            autoComplete="off"
          />
        </div>
        <div className="flex gap-2">
          <button onClick={save} disabled={saving || (!(username && password) && !apiToken)} className="btn-primary btn-sm">
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
  const { addToast } = useToast()
  const [configured, setConfigured] = useState(initialConfigured)
  const [secretKey, setSecretKey] = useState('')
  const [showKey, setShowKey] = useState(false)
  const [saving, setSaving] = useState(false)
  const confirm = useConfirm()

  const saveKey = async () => {
    setSaving(true)
    try {
      await api.stripe.saveKey(secretKey)
      setSecretKey('')
      setConfigured(true)
      onRefresh()
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
    finally { setSaving(false) }
  }

  const removeKey = async () => {
    if (!(await confirm('Supprimer la clé Stripe ?'))) return
    try {
      await api.stripe.deleteKey()
      setConfigured(false)
      onRefresh()
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
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

function HubSpotConfig({ configured: initialConfigured, syncStatus, onRefresh }) {
  const { addToast } = useToast()
  const [configured, setConfigured] = useState(initialConfigured)
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)
  const [saving, setSaving] = useState(false)
  const [info, setInfo] = useState(null)
  const [loadingInfo, setLoadingInfo] = useState(false)
  const [showSegmentModal, setShowSegmentModal] = useState(false)
  const confirm = useConfirm()

  const loadInfo = async () => {
    if (!configured) { setInfo(null); return }
    setLoadingInfo(true)
    try { setInfo(await api.hubspot.info()) } catch (e) { setInfo({ error: e.message }) }
    finally { setLoadingInfo(false) }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadInfo() }, [configured])

  const saveToken = async () => {
    setSaving(true)
    try {
      await api.hubspot.saveToken(token)
      setToken('')
      setConfigured(true)
      onRefresh()
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
    finally { setSaving(false) }
  }

  const removeToken = async () => {
    if (!(await confirm('Supprimer le token HubSpot ? Le sync s\'arrêtera.'))) return
    try {
      await api.hubspot.deleteToken()
      setConfigured(false)
      onRefresh()
    } catch (e) { addToast({ message: e.message, type: 'error' }) }
  }

  const triggerFull = async () => {
    if (!(await confirm({ title: 'Resync complète HubSpot', message: 'Lancer une resync complète ? Toutes les tâches HubSpot seront (ré)importées.', confirmLabel: 'Lancer', danger: false }))) return
    try { await api.hubspot.sync(true); addToast({ message: 'Resync complète lancée — vérifiez les logs.', type: 'success' }) }
    catch (e) { addToast({ message: e.message, type: 'error' }) }
  }

  const users = info?.users || []
  const mappedCount = users.filter(u => u.effective_owner_id).length
  const unmappedNames = users.filter(u => !u.effective_owner_id).map(u => u.name)

  return (
    <div className="mt-4 space-y-4">
      <div className="bg-slate-50 rounded-xl p-4 space-y-3">
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Token Private App HubSpot</p>
        {configured
          ? <p className="text-sm text-green-600 font-medium flex items-center gap-1.5"><CheckCircle size={14} /> Token configuré</p>
          : <p className="text-sm text-amber-600 font-medium flex items-center gap-1.5"><XCircle size={14} /> Aucun token configuré</p>
        }
        <div className="flex gap-2">
          <div className="relative flex-1">
            <input
              type={showToken ? 'text' : 'password'}
              className="input pr-8 font-mono text-sm"
              placeholder="pat-na1-..."
              value={token}
              onChange={e => setToken(e.target.value)}
            />
            <button onClick={() => setShowToken(v => !v)} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">
              {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
          </div>
          <button onClick={saveToken} disabled={saving || !token} className="btn-primary btn-sm">
            {saving ? 'Sauvegarde…' : configured ? 'Mettre à jour' : 'Enregistrer'}
          </button>
          {configured && (
            <button onClick={removeToken} className="btn-secondary btn-sm text-red-500 hover:text-red-600">
              <Trash2 size={14} />
            </button>
          )}
        </div>
        <p className="text-xs text-slate-400">
          Scopes requis : <code>crm.objects.tasks.read/write</code> + <code>crm.objects.owners.read</code>.
          Créez-la dans <a href="https://app.hubspot.com/settings/integrations/private-apps" target="_blank" rel="noopener noreferrer" className="underline hover:text-slate-600">HubSpot → Paramètres → Intégrations → Private Apps</a>.
        </p>
      </div>

      {configured && (
        <>
          {/* Le mapping s'édite dans le tableau des utilisateurs (colonne
              « Owner HubSpot ») — ici on ne garde que l'état de couverture. */}
          <div className="bg-slate-50 rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Mapping utilisateurs ERP ↔ owners HubSpot</p>
                {info && !info.error && (
                  <p className="text-xs text-slate-500 mt-0.5" data-testid="hubspot-mapping-count">{mappedCount}/{users.length} mappés · auto par email avec override manuel possible</p>
                )}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <button onClick={loadInfo} className="btn-secondary btn-sm py-1 text-xs" disabled={loadingInfo}>
                  <RefreshCw size={12} className={loadingInfo ? 'animate-spin' : ''} /> Rafraîchir
                </button>
                <Link to="/admin/utilisateurs" className="btn-secondary btn-sm py-1 text-xs" data-testid="hubspot-mapping-users-link">
                  <Users size={12} /> Gérer dans les utilisateurs
                </Link>
              </div>
            </div>
            {info?.error && <p className="text-sm text-red-500">⚠ {info.error}</p>}
            {info && !info.error && (
              <p className="text-xs text-slate-500">
                Chaque owner se choisit dans la colonne <span className="font-medium text-slate-600">Owner HubSpot</span> du tableau des utilisateurs.
                {unmappedNames.length > 0 && <> Sans owner : {unmappedNames.join(', ')}.</>}
              </p>
            )}
          </div>

          <div className="flex items-center gap-3">
            <SyncBtn label="Pull delta" syncKey="hubspot_tasks" syncStatus={syncStatus} onSync={() => api.hubspot.sync(false)} />
            <button onClick={triggerFull} className="btn-secondary btn-sm py-1 text-xs">
              Resync complète
            </button>
          </div>

          <div className="bg-slate-50 rounded-xl p-4 space-y-2">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Segment à partir d'une liste d'emails</p>
            <p className="text-xs text-slate-500">Colle une liste d'emails pour créer une liste statique HubSpot (matche les contacts existants, n'en crée aucun).</p>
            <button onClick={() => setShowSegmentModal(true)} className="btn-secondary btn-sm py-1 text-xs">
              Créer un segment
            </button>
          </div>
          <HubSpotExportModal isOpen={showSegmentModal} onClose={() => setShowSegmentModal(false)} />
        </>
      )}
    </div>
  )
}

function ConnectorCard({ connector, accounts, config, syncConfigs, syncStatus, onRefresh, stripeConfigured, novoxpressConfigured, hubspotConfigured, amazonConfigured, digikeyConfigured, upsConfigured, purolatorConfigured }) {
  const [expanded, setExpanded] = useState(false)
  const { icon: Icon, color } = connector
  const connectorAccounts = accounts.filter(a => a.connector === connector.id)
  const isConnected = connector.alwaysConnected ? true
    : connector.apiKeyManaged ? (
        connector.id === 'stripe' ? stripeConfigured :
        connector.id === 'novoxpress' ? novoxpressConfigured :
        connector.id === 'hubspot' ? hubspotConfigured :
        connector.id === 'digikey' ? digikeyConfigured :
        connector.id === 'ups' ? upsConfigured :
        connector.id === 'purolator' ? purolatorConfigured :
        false
      )
    : connectorAccounts.length > 0

  // Amazon Business : pas de clés API tant que l'onboarding développeur n'est pas approuvé —
  // on masque « Connecter » (sinon le flux OAuth échoue avec une erreur JSON brute).
  const blockedNoCredentials = connector.id === 'amazon' && !amazonConfigured
  const needsOAuth = !connector.apiKeyManaged && !connector.alwaysConnected && !isConnected && !blockedNoCredentials

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
          : blockedNoCredentials
            ? <Badge color="yellow" size="sm">Non configuré</Badge>
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
          {connector.id === 'postmark' && (
            <PostmarkConfig />
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
          {connector.id === 'hubspot' && (
            <HubSpotConfig configured={hubspotConfigured} syncStatus={syncStatus} onRefresh={onRefresh} />
          )}
          {connector.id === 'instagram' && (
            <InstagramConfig />
          )}
          {connector.id === 'amazon' && (
            <AmazonConfig accounts={connectorAccounts} configured={amazonConfigured} syncStatus={syncStatus} onRefresh={onRefresh} />
          )}
          {connector.id === 'digikey' && (
            <DigikeyConfig configured={digikeyConfigured} syncStatus={syncStatus} onRefresh={onRefresh} />
          )}
          {connector.id === 'ups' && (
            <UpsConfig configured={upsConfigured} onRefresh={onRefresh} />
          )}
          {connector.id === 'purolator' && (
            <PurolatorConfig configured={purolatorConfigured} onRefresh={onRefresh} />
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
  assemblages: 'Assemblages', factures: 'Factures', amazon: 'Amazon Business', digikey: 'DigiKey', ups: 'UPS', purolator: 'Purolator',
  instagram: 'Prospects Instagram',
}

const SYNC_LOG_RENDERS = {
  created_at:       l => <span className="text-slate-500 whitespace-nowrap">{fmtDateTime(l.created_at)}</span>,
  module:           l => <span className="font-medium text-slate-700">{MODULE_LABELS[l.module] || l.module}</span>,
  trigger:          l => (
    <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-medium ${TRIGGER_COLORS[l.trigger] || 'bg-slate-100 text-slate-600'}`}>
      {TRIGGER_LABELS[l.trigger] || l.trigger}
    </span>
  ),
  status:           l => l.status === 'success'
    ? <span className="text-green-600 font-medium">OK</span>
    : <span className="text-red-500 font-medium">Erreur</span>,
  records_modified: l => (
    (l.records_modified > 0 || l.records_destroyed > 0)
      ? <span>
          {l.records_modified > 0 && <span className="text-slate-600">+{l.records_modified}</span>}
          {l.records_destroyed > 0 && <span className="text-red-400 ml-1">-{l.records_destroyed}</span>}
        </span>
      : <span className="text-slate-300">—</span>
  ),
  duration_ms:      l => <span className="text-slate-400">{l.duration_ms != null ? `${(l.duration_ms / 1000).toFixed(1)}s` : '—'}</span>,
  error_message:    l => <span className="text-red-400 block max-w-xs truncate" title={l.error_message || ''}>{l.error_message || '—'}</span>,
}
const SYNC_LOG_COLUMNS = TABLE_COLUMN_META.sync_log.map(meta => ({ ...meta, render: SYNC_LOG_RENDERS[meta.id] }))

function SyncLogPanel() {
  const [open, setOpen] = useState(false)
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)

  const load = async () => {
    try {
      const data = await api.syncLog.list({ limit: open ? 'all' : 50 })
      setLogs(data)
    } catch {} finally { setLoading(false) }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load() }, [open])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { const id = setInterval(load, 15000); return () => clearInterval(id) }, [open])

  const fmtTime = (iso) => {
    if (!iso) return '—'
    const d = new Date(iso)
    const diff = Date.now() - d
    if (diff < 60000) return 'à l\'instant'
    if (diff < 3600000) return `il y a ${Math.floor(diff / 60000)}min`
    return fmtDateTime(iso)
  }

  // Stats summary
  const last24h = logs.filter(l => new Date(l.created_at) > new Date(Date.now() - 86400000))
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
          <div className="px-4 py-2 bg-slate-50/50">
            <div className="flex gap-4 text-xs text-slate-500">
              <span>{logs.length} entrée{logs.length > 1 ? 's' : ''} · 7 derniers jours</span>
              {lastScheduled && <span>Dernière planifiée : {fmtTime(lastScheduled.created_at)}</span>}
              {lastWebhook && <span>Dernier webhook : {fmtTime(lastWebhook.created_at)}</span>}
            </div>
          </div>

          <DataTable
            table="sync_log"
            columns={SYNC_LOG_COLUMNS}
            data={logs}
            loading={loading}
            searchFields={['module', 'trigger', 'status', 'error_message']}
            height="60vh"
          />
        </div>
      )}
    </div>
  )
}

const SYNC_LABELS = {
  gmail: 'Gmail', drive: 'Drive', airtable: 'CRM Airtable',
  projets: 'Projets', pieces: 'Pièces', orders: 'Commandes',
  achats: 'Achats', billets: 'Billets', serials: 'N° de série', envois: 'Envois',
  stripe: 'Stripe', 'qb-achats': 'QB Achats', hubspot_tasks: 'HubSpot Tasks',
}

export function ConnectorsContent() {
  const [data, setData] = useState({ accounts: [], config: {}, airtable_sync: {}, projets_sync: {}, pieces: {}, orders_sync: {}, achats: {}, billets: {}, serials: {}, envois: {}, stripe_configured: false, novoxpress_configured: false, hubspot_configured: false, amazon_configured: false, digikey_configured: false, ups_configured: false, purolator_configured: false })
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
        <p className="text-sm text-slate-500 mt-0.5">Intégrez vos outils externes à Boréal</p>
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
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
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
                  hubspotConfigured={!!data.hubspot_configured}
                  amazonConfigured={!!data.amazon_configured}
                  digikeyConfigured={!!data.digikey_configured}
                  upsConfigured={!!data.ups_configured}
                  purolatorConfigured={!!data.purolator_configured}
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
