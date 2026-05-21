import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { PhoneCall, ChevronLeft, Search, Plus, Building2 } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { TableConfigModal } from '../components/TableConfigModal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { useToast } from '../contexts/ToastContext.jsx'
import { fmtDate } from '../lib/formatDate.js'

// ── Dropdown "Nouvel appel" : sélection d'une entreprise avec recherche live.
// On suit la règle CLAUDE.md : dropdowns avec >10 options doivent avoir une zone
// de recherche.
function NewCallDropdown({ companies, onPick, onPickNew, busy }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const ref = useRef(null)

  useEffect(() => {
    function onDocClick(e) {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = q
      ? companies.filter(c => (c.name || '').toLowerCase().includes(q))
      : companies
    return list.slice(0, 100)
  }, [companies, search])

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={busy}
        onClick={() => setOpen(v => !v)}
        className="btn-primary inline-flex items-center gap-2 disabled:opacity-60"
      >
        <Plus size={16} />
        Nouvel appel
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-80 bg-white border border-slate-200 rounded-lg shadow-lg z-30">
          <button
            type="button"
            onClick={() => { setOpen(false); setSearch(''); onPickNew() }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-emerald-50 text-left border-b border-slate-100 text-emerald-700 font-medium"
          >
            <Plus size={14} className="flex-shrink-0" />
            <span>Nouvelle entreprise</span>
          </button>
          <div className="relative p-2 border-b border-slate-100">
            <Search size={14} className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Rechercher une entreprise…"
              className="w-full pl-7 pr-2 py-1.5 text-sm border border-slate-200 rounded focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-500"
            />
          </div>
          <ul className="max-h-80 overflow-y-auto py-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-2 text-sm text-slate-400">Aucune entreprise.</li>
            ) : filtered.map(c => (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => { setOpen(false); setSearch(''); onPick(c) }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-slate-50 text-left"
                >
                  <Building2 size={14} className="text-slate-400 flex-shrink-0" />
                  <span className="truncate text-slate-800">{c.name}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function statusColor(s) {
  if (s === 'Terminé') return 'green'
  if (s === 'En cours') return 'blue'
  if (s === 'Abandonné') return 'gray'
  return 'slate'
}

const RENDERS = {
  call_date: (row) => row.call_date
    ? fmtDate(row.call_date)
    : (row.airtable_created_at ? fmtDate(row.airtable_created_at) : <span className="text-slate-400">—</span>),
  company_name: (row) => row.company_id
    ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline text-sm">{row.company_name || row.company_name_raw || '—'}</Link>
    : <span className="text-slate-700 text-sm">{row.company_name_raw || '—'}</span>,
  status: (row) => row.status
    ? <Badge color={statusColor(row.status)} size="sm">{row.status}</Badge>
    : <span className="text-slate-400">—</span>,
  source: (row) => row.source === 'ERP'
    ? <Badge color="green" size="sm">ERP</Badge>
    : <Badge color="gray" size="sm">Airtable</Badge>,
  motivation_today: (row) => {
    const s = (row.motivation_today || '').trim()
    if (!s) return <span className="text-slate-400">—</span>
    return <span className="text-sm text-slate-700">{s.length > 80 ? s.slice(0, 80) + '…' : s}</span>
  },
  summary: (row) => {
    const s = (row.summary || '').trim()
    if (!s) return <span className="text-slate-400">—</span>
    return <span className="text-sm text-slate-700">{s.length > 80 ? s.slice(0, 80) + '…' : s}</span>
  },
  next_steps: (row) => {
    const s = (row.next_steps || '').trim()
    if (!s) return <span className="text-slate-400">—</span>
    return <span className="text-sm text-slate-700">{s.length > 80 ? s.slice(0, 80) + '…' : s}</span>
  },
  pain_points_count: (row) => row.pain_points_count > 0
    ? <span className="text-sm text-slate-700">{row.pain_points_count}</span>
    : <span className="text-slate-400">—</span>,
  red_flags_count: (row) => row.red_flags_count > 0
    ? <Badge color="red" size="sm">{row.red_flags_count}</Badge>
    : <span className="text-slate-400">—</span>,
  quote_paid_at: (row) => row.quote_paid_at
    ? <Badge color="green" size="sm">Payé · {fmtDate(row.quote_paid_at)}</Badge>
    : <span className="text-slate-400">—</span>,
  contact_full_name: (row) => row.contact_full_name || <span className="text-slate-400">—</span>,
  heard_about: (row) => row.heard_about || <span className="text-slate-400">—</span>,
  created_at: (row) => fmtDate(row.created_at),
}

const COLUMNS = TABLE_COLUMN_META.qualification_calls.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

function CallFrame({ company, callRecord, editableFarm, onBack }) {
  const iframeRef = useRef(null)
  const pendingRef = useRef(null)
  const timerRef = useRef(null)
  const companyNamePendingRef = useRef(null)
  const companyNameTimerRef = useRef(null)
  const companyAddressPendingRef = useRef(null)
  const companyAddressTimerRef = useRef(null)
  const { addToast } = useToast()

  function flush() {
    const data = pendingRef.current
    pendingRef.current = null
    if (!data) return
    api.qualificationCalls.update(callRecord.id, data)
      .then(() => {
        const iframe = iframeRef.current
        if (iframe && iframe.contentWindow) {
          iframe.contentWindow.postMessage({ target: 'qualification-call', type: 'saved' }, '*')
        }
      })
      .catch(err => {
        addToast({ type: 'error', message: 'Erreur de sauvegarde : ' + (err.message || 'inconnue') })
        const iframe = iframeRef.current
        if (iframe && iframe.contentWindow) {
          iframe.contentWindow.postMessage({ target: 'qualification-call', type: 'save-error' }, '*')
        }
      })
  }

  function queueSave(data) {
    pendingRef.current = { ...(pendingRef.current || {}), ...data }
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(flush, 500)
  }

  function flushCompanyName() {
    const name = companyNamePendingRef.current
    companyNamePendingRef.current = null
    if (name === null || name === undefined) return
    api.companies.update(company.id, { name })
      .catch(err => {
        addToast({ type: 'error', message: 'Erreur de sauvegarde du nom : ' + (err.message || 'inconnue') })
      })
  }

  function queueCompanyName(name) {
    companyNamePendingRef.current = name
    if (companyNameTimerRef.current) clearTimeout(companyNameTimerRef.current)
    companyNameTimerRef.current = setTimeout(flushCompanyName, 500)
  }

  function flushCompanyAddress() {
    const address = companyAddressPendingRef.current
    companyAddressPendingRef.current = null
    if (address === null || address === undefined) return
    api.companies.update(company.id, { address })
      .catch(err => {
        addToast({ type: 'error', message: 'Erreur de sauvegarde de l’adresse : ' + (err.message || 'inconnue') })
      })
  }

  function queueCompanyAddress(address) {
    companyAddressPendingRef.current = address
    if (companyAddressTimerRef.current) clearTimeout(companyAddressTimerRef.current)
    companyAddressTimerRef.current = setTimeout(flushCompanyAddress, 500)
  }

  useEffect(() => {
    function onMessage(e) {
      const msg = e.data
      if (!msg || msg.source !== 'qualification-call') return
      if (msg.type === 'ready') {
        const iframe = iframeRef.current
        if (iframe && iframe.contentWindow) {
          iframe.contentWindow.postMessage({
            target: 'qualification-call',
            type: 'init',
            data: callRecord,
          }, '*')
        }
      } else if (msg.type === 'save' && msg.data) {
        queueSave(msg.data)
      } else if (msg.type === 'save-company-name' && typeof msg.name === 'string') {
        queueCompanyName(msg.name)
      } else if (msg.type === 'save-company-address' && typeof msg.address === 'string') {
        queueCompanyAddress(msg.address)
      } else if (msg.type === 'subscribe-card' && typeof msg.id === 'number' && msg.body) {
        // Le formulaire Stripe Elements de l'iframe a déjà tokenisé la carte ;
        // on relaie l'appel API authentifié et renvoie le résultat à l'iframe
        // qui se chargera de l'éventuel 3DS via stripe.confirmCardPayment.
        api.qualificationCalls.subscribeCard(callRecord.id, msg.body)
          .then(result => {
            const iframe = iframeRef.current
            if (iframe && iframe.contentWindow) {
              iframe.contentWindow.postMessage({
                target: 'qualification-call',
                type: 'subscribe-card-result',
                id: msg.id,
                result,
              }, '*')
            }
          })
          .catch(err => {
            const iframe = iframeRef.current
            if (iframe && iframe.contentWindow) {
              iframe.contentWindow.postMessage({
                target: 'qualification-call',
                type: 'subscribe-card-result',
                id: msg.id,
                result: { error: err.message || 'Erreur inconnue' },
              }, '*')
            }
          })
      }
    }
    window.addEventListener('message', onMessage)
    return () => {
      window.removeEventListener('message', onMessage)
      if (timerRef.current) { clearTimeout(timerRef.current); flush() }
      if (companyNameTimerRef.current) { clearTimeout(companyNameTimerRef.current); flushCompanyName() }
      if (companyAddressTimerRef.current) { clearTimeout(companyAddressTimerRef.current); flushCompanyAddress() }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callRecord.id])

  // L'iframe doit pouvoir appeler /api/places/* (autocomplete d'adresse via
  // proxy backend). On lui passe le JWT en query param — pattern déjà utilisé
  // pour les iframes PDF (cf. CLAUDE.md, middleware requireAuth accepte ?token=).
  const erpToken = typeof window !== 'undefined' ? (localStorage.getItem('erp_token') || '') : ''
  const url = `/erp/qualification-call-guide/index.html?call_id=${encodeURIComponent(callRecord.id)}&company_name=${encodeURIComponent(company.name || '')}&company_address=${encodeURIComponent(company.address || '')}${erpToken ? `&token=${encodeURIComponent(erpToken)}` : ''}${editableFarm ? '&editable_farm=1' : ''}`

  return (
    <div className="fixed inset-0 bg-white flex flex-col">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-200 bg-slate-50">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-100 rounded"
        >
          <ChevronLeft size={16} />
          Retour à la liste
        </button>
        <div className="text-sm font-medium text-slate-700 flex items-center gap-2">
          <PhoneCall size={14} className="text-emerald-600" />
          Appel · <a href={`/erp/companies/${company.id}`} target="_blank" rel="noreferrer" className="text-emerald-700 hover:underline">{company.name}</a>
        </div>
        <div className="w-32" />
      </div>
      <iframe
        ref={iframeRef}
        src={url}
        title="Guide d'appel de qualification"
        className="flex-1 w-full border-0"
      />
    </div>
  )
}

export default function QualificationCall() {
  const [calls, setCalls] = useState([])
  const [companies, setCompanies] = useState([])
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [activeCall, setActiveCall] = useState(null) // { company, record }
  const { addToast } = useToast()

  async function load() {
    setLoading(true)
    try {
      const r = await api.qualificationCalls.list()
      setCalls(r.data || [])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    api.companies.lookup().then(list => setCompanies(Array.isArray(list) ? list : [])).catch(() => {})
  }, [])

  async function startCall(c) {
    setCreating(true)
    try {
      const rec = await api.qualificationCalls.create({ company_id: c.id })
      setActiveCall({ company: { id: c.id, name: c.name }, record: rec, editableFarm: false })
    } catch (err) {
      addToast({ type: 'error', message: 'Impossible de créer l\'appel : ' + (err.message || 'inconnue') })
    } finally {
      setCreating(false)
    }
  }

  async function startNewCompanyCall() {
    setCreating(true)
    try {
      const newCompany = await api.companies.create({ name: '' })
      const rec = await api.qualificationCalls.create({ company_id: newCompany.id })
      setActiveCall({ company: { id: newCompany.id, name: '' }, record: rec, editableFarm: true })
      // Recharger la liste des companies pour qu'elle apparaisse dans le picker la prochaine fois
      api.companies.lookup().then(list => setCompanies(Array.isArray(list) ? list : [])).catch(() => {})
    } catch (err) {
      addToast({ type: 'error', message: 'Impossible de créer l\'entreprise : ' + (err.message || 'inconnue') })
    } finally {
      setCreating(false)
    }
  }

  async function openExistingCall(row) {
    // Charge le record complet — la liste ne renvoie qu'un sous-ensemble de colonnes.
    try {
      const full = await api.qualificationCalls.get(row.id)
      setActiveCall({
        company: { id: full.company_id, name: row.company_name || full.company_name_raw || '' },
        record: full,
        editableFarm: false,
      })
    } catch (err) {
      addToast({ type: 'error', message: 'Erreur de chargement : ' + (err.message || 'inconnue') })
    }
  }

  function closeCall() {
    setActiveCall(null)
    load()
  }

  if (activeCall) {
    return <CallFrame company={activeCall.company} callRecord={activeCall.record} editableFarm={activeCall.editableFarm} onBack={closeCall} />
  }

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2">
              <PhoneCall size={20} className="text-emerald-600" />
              Appels de qualification
            </h1>
            <p className="text-sm text-slate-500 mt-0.5">
              {calls.length} appel{calls.length !== 1 ? 's' : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <TableConfigModal table="qualification_calls" />
            <NewCallDropdown companies={companies} onPick={startCall} onPickNew={startNewCompanyCall} busy={creating} />
          </div>
        </div>

        <DataTable
          table="qualification_calls"
          columns={COLUMNS}
          data={calls}
          loading={loading}
          onRowClick={openExistingCall}
          searchFields={['company_name', 'company_name_raw', 'assignee', 'contact_full_name', 'motivation_today', 'summary', 'heard_about']}
        />
      </div>

      {creating && (
        <div className="fixed inset-0 bg-black/20 flex items-center justify-center z-50">
          <div className="card p-6 flex items-center gap-3">
            <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-emerald-600" />
            <span className="text-sm text-slate-700">Préparation de l'appel…</span>
          </div>
        </div>
      )}
    </Layout>
  )
}
