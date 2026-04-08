import { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, X, Download } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('fr-CA', { year: 'numeric', month: 'short', day: 'numeric' })
}

function fmtCad(n) {
  if (!n && n !== 0) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(n)
}

const STATUS_COLORS = {
  'Payée': 'green',
  'Partielle': 'yellow',
  'En retard': 'red',
  'Envoyée': 'blue',
  'Brouillon': 'gray',
  'Annulée': 'red',
}

export default function FactureDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [facture, setFacture] = useState(null)
  const [loading, setLoading] = useState(true)
  const [projects, setProjects] = useState([])
  const [saving, setSaving] = useState(false)
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [pdfBlobUrl, setPdfBlobUrl] = useState(null)
  const [pdfLoading, setPdfLoading] = useState(false)
  const [showPdfModal, setShowPdfModal] = useState(false)

  useEffect(() => {
    setLoading(true)
    api.factures.get(id)
      .then(data => {
        setFacture(data)
        setSelectedProjectId(data.project_id || '')
        if (data.airtable_pdf_path) {
          const token = localStorage.getItem('erp_token')
          fetch(`/erp/api/inventaire/factures/${id}/pdf`, {
            headers: { Authorization: `Bearer ${token}` }
          }).then(r => r.ok ? r.blob() : null)
            .then(blob => blob && setPdfBlobUrl(URL.createObjectURL(blob)))
            .catch(() => {})
        }
        if (data.company_id) {
          return api.projects.list({ company_id: data.company_id, limit: 'all' })
        }
        return { data: [] }
      })
      .then(res => setProjects(res.data || []))
      .catch(() => setFacture(null))
      .finally(() => setLoading(false))
  }, [id])

  async function handleProjectChange(e) {
    const newProjectId = e.target.value
    setSelectedProjectId(newProjectId)
    setSaving(true)
    try {
      const updated = await api.factures.update(id, { project_id: newProjectId || null })
      setFacture(updated)
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-600" />
        </div>
      </Layout>
    )
  }
  if (!facture) return <Layout><div className="p-6 text-slate-500">Facture introuvable.</div></Layout>

  return (
    <Layout>
      <div className="p-6 max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          <button onClick={() => navigate('/factures')} className="mt-1 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold text-slate-900">{facture.document_number || `Facture #${id}`}</h1>
              {facture.status && (
                <Badge color={STATUS_COLORS[facture.status] || 'gray'} size="md">
                  {facture.status}
                </Badge>
              )}
              {facture.airtable_pdf_path && (
                <button
                  disabled={!pdfBlobUrl}
                  onClick={() => setShowPdfModal(true)}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-red-50 text-red-600 border border-red-200 rounded-lg hover:bg-red-100 transition-colors disabled:opacity-40"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14,2 14,8 20,8"/></svg>
                  {pdfBlobUrl ? 'PDF' : 'Chargement…'}
                </button>
              )}
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
          {/* Entreprise */}
          <div className="grid grid-cols-2 gap-4 p-5">
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Entreprise</p>
              {facture.company_id
                ? <Link to={`/companies/${facture.company_id}`} className="text-indigo-600 hover:underline font-medium">{facture.company_name}</Link>
                : <span className="text-slate-400">—</span>}
            </div>
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Projet</p>
              {facture.company_id ? (
                <div className="flex items-center gap-2">
                  <select
                    value={selectedProjectId}
                    onChange={handleProjectChange}
                    disabled={saving}
                    className="text-sm border border-slate-200 rounded-lg px-2 py-1.5 text-slate-700 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 min-w-[180px]"
                  >
                    <option value="">— Aucun projet —</option>
                    {projects.map(p => (
                      <option key={p.id} value={p.id}>{p.name}</option>
                    ))}
                  </select>
                  {saving && <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-indigo-500" />}
                </div>
              ) : (
                <span className="text-slate-400 text-sm">Associer une entreprise d'abord</span>
              )}
            </div>
          </div>

          {/* Commande / Abonnement */}
          <div className="grid grid-cols-2 gap-4 p-5">
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Commande</p>
              {facture.order_id
                ? <Link to={`/orders/${facture.order_id}`} className="text-indigo-600 hover:underline font-medium">#{facture.order_number}</Link>
                : <span className="text-slate-400 text-sm">—</span>}
            </div>
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Abonnement</p>
              {facture.subscription_id
                ? <Link to={`/subscriptions/${facture.subscription_id}`} className="text-indigo-600 hover:underline font-medium">{facture.subscription_stripe_id || facture.subscription_id}</Link>
                : <span className="text-slate-400 text-sm">—</span>}
            </div>
          </div>

          {/* PDF thumbnail */}
          {pdfBlobUrl && (
            <div className="p-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Aperçu</p>
              <div
                className="relative cursor-pointer overflow-hidden rounded-lg border border-slate-200 bg-slate-50 hover:border-indigo-300 transition-colors"
                style={{ height: 200, width: 154 }}
                onClick={() => setShowPdfModal(true)}
              >
                <iframe
                  src={`${pdfBlobUrl}#toolbar=0&navpanes=0&scrollbar=0`}
                  className="absolute top-0 left-0 origin-top-left pointer-events-none"
                  style={{ width: '200%', height: '200%', transform: 'scale(0.5)' }}
                  title="Aperçu facture"
                />
                <div className="absolute inset-0 flex items-end justify-center pb-2 opacity-0 hover:opacity-100 transition-opacity bg-gradient-to-t from-black/20">
                  <span className="text-xs text-white font-medium">Agrandir</span>
                </div>
              </div>
            </div>
          )}

          {/* Dates */}
          <div className="grid grid-cols-2 gap-4 p-5">
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Date de facturation</p>
              <p className="text-sm text-slate-700">{fmtDate(facture.document_date)}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Date d'échéance</p>
              <p className="text-sm text-slate-700">{fmtDate(facture.due_date)}</p>
            </div>
          </div>

          {/* Montants */}
          <div className="grid grid-cols-3 gap-4 p-5">
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Avant taxes</p>
              <p className="text-sm font-medium text-slate-700">{fmtCad(facture.amount_before_tax_cad)}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Total</p>
              <p className="text-sm font-medium text-slate-700">{fmtCad(facture.total_amount)}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Solde dû</p>
              <p className={`text-sm font-medium ${facture.balance_due > 0 ? 'text-red-600' : 'text-green-600'}`}>
                {fmtCad(facture.balance_due)}
              </p>
            </div>
          </div>

          {/* Notes */}
          {facture.notes && (
            <div className="p-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Notes</p>
              <p className="text-sm text-slate-700 whitespace-pre-wrap">{facture.notes}</p>
            </div>
          )}
        </div>
      </div>

      {/* PDF viewer modal */}
      {showPdfModal && pdfBlobUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowPdfModal(false)} />
          <div className="relative bg-white rounded-xl shadow-2xl w-[95vw] max-w-6xl h-[92vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
              <span className="text-sm font-semibold text-slate-900">{facture.document_number}</span>
              <div className="flex items-center gap-2">
                <a href={pdfBlobUrl} download={`${facture.document_number}.pdf`} className="btn-secondary btn-sm flex items-center gap-1.5">
                  <Download size={13} /> Télécharger
                </a>
                <button onClick={() => setShowPdfModal(false)} className="p-1.5 text-slate-400 hover:text-slate-600 rounded">
                  <X size={16} />
                </button>
              </div>
            </div>
            <iframe src={pdfBlobUrl} className="flex-1 w-full" title="Facture PDF" />
          </div>
        </div>
      )}
    </Layout>
  )
}
