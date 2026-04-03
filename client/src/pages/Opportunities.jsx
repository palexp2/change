import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { Sparkles, RefreshCw, Mail, UserX, X, CheckCircle, Send, ChevronDown, ChevronUp } from 'lucide-react'
import { api } from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'

const TYPE_CONFIG = {
  winback_client: { label: 'Réengagement', icon: UserX, color: 'indigo' },
}

const PRIORITY_STYLE = {
  high:   'bg-red-100 text-red-700 border-red-200',
  medium: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  low:    'bg-slate-100 text-slate-600 border-slate-200',
}
const PRIORITY_LABEL = { high: 'Urgent', medium: 'Moyen', low: 'Faible' }

const COLOR_MAP = {
  orange: { bg: 'bg-orange-50', border: 'border-orange-200', icon: 'bg-orange-100 text-orange-600' },
  red:    { bg: 'bg-red-50',    border: 'border-red-200',    icon: 'bg-red-100 text-red-600'       },
  yellow: { bg: 'bg-yellow-50', border: 'border-yellow-200', icon: 'bg-yellow-100 text-yellow-600' },
  blue:   { bg: 'bg-blue-50',   border: 'border-blue-200',   icon: 'bg-blue-100 text-blue-600'     },
  indigo: { bg: 'bg-indigo-50', border: 'border-indigo-200', icon: 'bg-indigo-100 text-indigo-600' },
}

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('fr-CA', { year: 'numeric', month: 'short', day: 'numeric' })
}

function OpportunityCard({ opp, onUpdate, onSend }) {
  const [expanded, setExpanded] = useState(false)
  const [emailTo, setEmailTo] = useState(opp.email_to || '')
  const [emailSubject, setEmailSubject] = useState(opp.email_subject || '')
  const [emailBody, setEmailBody] = useState(opp.email_body || '')
  const [sending, setSending] = useState(false)
  const [dismissing, setDismissing] = useState(false)
  const [sent, setSent] = useState(false)

  const cfg = TYPE_CONFIG[opp.type] || { label: opp.type, icon: Sparkles, color: 'blue' }
  const colors = COLOR_MAP[cfg.color] || COLOR_MAP.blue
  const Icon = cfg.icon
  const hasEmail = opp.action_type === 'email'

  async function handleSend() {
    setSending(true)
    try {
      // Save edits first
      await api.opportunities.update(opp.id, { email_to: emailTo, email_subject: emailSubject, email_body: emailBody })
      await onSend(opp.id)
      setSent(true)
    } catch (e) {
      alert(e.message)
    } finally {
      setSending(false)
    }
  }

  async function handleDismiss() {
    setDismissing(true)
    try { await onUpdate(opp.id, 'dismissed') } finally { setDismissing(false) }
  }

  async function handleDone() {
    try { await onUpdate(opp.id, 'done') } catch {}
  }

  if (sent) return null

  const entityPath = opp.entity_type === 'company' ? `/companies/${opp.entity_id}`
    : opp.entity_type === 'product' ? `/products/${opp.entity_id}`
    : null

  return (
    <div className={`rounded-xl border ${colors.border} ${colors.bg} p-4 space-y-3`}>
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className={`w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 ${colors.icon}`}>
          <Icon size={17} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-slate-500">{cfg.label}</span>
            <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${PRIORITY_STYLE[opp.priority]}`}>
              {PRIORITY_LABEL[opp.priority]}
            </span>
          </div>
          <p className="font-semibold text-slate-900 mt-0.5">{opp.title}</p>
          <p className="text-sm text-slate-600 mt-0.5">{opp.description}</p>
          {opp.entity_name && entityPath && (
            <Link to={entityPath} className="text-xs text-indigo-600 hover:underline mt-1 inline-block">
              → {opp.entity_name}
            </Link>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          {!hasEmail && (
            <button onClick={handleDone} title="Marquer comme fait" className="p-1.5 text-slate-400 hover:text-green-600 hover:bg-green-50 rounded-lg transition-colors">
              <CheckCircle size={16} />
            </button>
          )}
          <button onClick={handleDismiss} disabled={dismissing} title="Ignorer" className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-200 rounded-lg transition-colors">
            <X size={16} />
          </button>
        </div>
      </div>

      {/* Email section */}
      {hasEmail && (
        <div>
          <button
            onClick={() => setExpanded(e => !e)}
            className="flex items-center gap-1.5 text-sm font-medium text-slate-700 hover:text-slate-900"
          >
            <Mail size={14} />
            {expanded ? 'Masquer le brouillon' : 'Voir le brouillon'}
            {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>

          {expanded && (
            <div className="mt-3 space-y-2">
              <div>
                <label className="label text-xs">Destinataire</label>
                <input
                  type="email"
                  value={emailTo}
                  onChange={e => setEmailTo(e.target.value)}
                  className="input text-sm"
                  placeholder="email@example.com"
                />
              </div>
              <div>
                <label className="label text-xs">Sujet</label>
                <input
                  type="text"
                  value={emailSubject}
                  onChange={e => setEmailSubject(e.target.value)}
                  className="input text-sm"
                />
              </div>
              <div>
                <label className="label text-xs">Message</label>
                <textarea
                  value={emailBody}
                  onChange={e => setEmailBody(e.target.value)}
                  className="input text-sm font-mono"
                  rows={8}
                />
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={handleDismiss} disabled={dismissing} className="btn-secondary btn-sm">
                  Ignorer
                </button>
                <button
                  onClick={handleSend}
                  disabled={sending || !emailTo}
                  className="btn-primary btn-sm flex items-center gap-1.5"
                >
                  <Send size={13} />
                  {sending ? 'Envoi…' : 'Envoyer'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function Opportunities() {
  const [opps, setOpps] = useState([])
  const [lastScan, setLastScan] = useState(null)
  const [loading, setLoading] = useState(true)
  const [scanning, setScanning] = useState(false)
  const [scanResult, setScanResult] = useState(null)
  const [scanError, setScanError] = useState(null)

  const load = useCallback(async () => {
    try {
      const { data, last_scan } = await api.opportunities.list()
      setOpps(data || [])
      setLastScan(last_scan)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  async function handleScan() {
    setScanning(true)
    setScanResult(null)
    setScanError(null)
    try {
      const result = await api.opportunities.scan()
      setScanResult(result)
      await load()
    } catch (e) {
      setScanError(e.message)
    } finally {
      setScanning(false)
    }
  }

  async function handleUpdate(id, status) {
    await api.opportunities.update(id, { status })
    setOpps(prev => prev.filter(o => o.id !== id))
  }

  async function handleSend(id) {
    await api.opportunities.send(id)
    setOpps(prev => prev.filter(o => o.id !== id))
  }

  const grouped = {
    high:   opps.filter(o => o.priority === 'high'),
    medium: opps.filter(o => o.priority === 'medium'),
    low:    opps.filter(o => o.priority === 'low'),
  }

  return (
    <Layout>
      <div className="p-6 max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-start justify-between mb-6">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles size={22} className="text-indigo-600" />
              <h1 className="text-2xl font-bold text-slate-900">Réengagement clients</h1>
            </div>
            <p className="text-sm text-slate-500 mt-1">
              Relancez les clients désabonnés depuis plus de 6 mois avec un courriel personnalisé par IA
              {lastScan && <span className="ml-2 text-xs">· Dernier scan : {fmtDate(lastScan)}</span>}
            </p>
          </div>
          <button
            onClick={handleScan}
            disabled={scanning}
            className="btn-primary flex items-center gap-2"
          >
            <RefreshCw size={15} className={scanning ? 'animate-spin' : ''} />
            {scanning ? 'Analyse en cours…' : 'Scanner les désabonnés'}
          </button>
        </div>

        {/* Scan feedback */}
        {scanning && (
          <div className="card p-6 text-center text-slate-500 mb-6">
            <div className="flex items-center justify-center gap-3">
              <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-indigo-600" />
              <span>Analyse des abonnements annulés et rédaction des courriels personnalisés…</span>
            </div>
          </div>
        )}
        {scanResult && !scanning && (
          <div className="bg-green-50 border border-green-200 rounded-xl px-4 py-3 text-sm text-green-700 mb-6">
            {scanResult.inserted > 0
              ? `${scanResult.inserted} courriel${scanResult.inserted !== 1 ? 's' : ''} de relance généré${scanResult.inserted !== 1 ? 's' : ''} pour ${scanResult.total_candidates} client${scanResult.total_candidates !== 1 ? 's' : ''} désabonné${scanResult.total_candidates !== 1 ? 's' : ''}. Révisez et envoyez quand vous êtes prêt.`
              : scanResult.message || 'Aucun client désabonné depuis plus de 6 mois trouvé.'
            }
          </div>
        )}
        {scanError && (
          <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 text-sm text-red-700 mb-6">{scanError}</div>
        )}

        {/* Content */}
        {loading ? (
          <div className="flex justify-center py-16"><div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-600" /></div>
        ) : opps.length === 0 && !scanning ? (
          <div className="card p-16 text-center">
            <UserX size={40} className="text-slate-300 mx-auto mb-3" />
            <p className="text-slate-500 font-medium">Aucune relance en attente</p>
            <p className="text-sm text-slate-400 mt-1">Lancez un scan pour identifier les clients désabonnés à relancer.</p>
          </div>
        ) : (
          <div className="space-y-6">
            {['high', 'medium', 'low'].map(priority => {
              const items = grouped[priority]
              if (!items.length) return null
              return (
                <div key={priority}>
                  <h2 className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">
                    {PRIORITY_LABEL[priority]} · {items.length}
                  </h2>
                  <div className="space-y-3">
                    {items.map(opp => (
                      <OpportunityCard
                        key={opp.id}
                        opp={opp}
                        onUpdate={handleUpdate}
                        onSend={handleSend}
                      />
                    ))}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </Layout>
  )
}
