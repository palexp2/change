import { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'

function fmtDate(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('fr-CA', { year: 'numeric', month: 'short', day: 'numeric' })
}

const STATUS_COLORS = {
  'Reçu': 'green',
  'En attente': 'yellow',
  'En traitement': 'blue',
  'Refusé': 'red',
}

export default function RetourDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [retour, setRetour] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    api.retours.get(id)
      .then(data => setRetour(data))
      .catch(() => setRetour(null))
      .finally(() => setLoading(false))
  }, [id])

  if (loading) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-600" />
        </div>
      </Layout>
    )
  }
  if (!retour) return <Layout><div className="p-6 text-slate-500">Retour introuvable.</div></Layout>

  return (
    <Layout>
      <div className="p-6 max-w-5xl mx-auto">
        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          <button onClick={() => navigate('/retours')} className="mt-1 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold text-slate-900">{retour.return_number || `Retour #${id}`}</h1>
              {retour.processing_status && (
                <Badge color={STATUS_COLORS[retour.processing_status] || 'gray'} size="md">
                  {retour.processing_status}
                </Badge>
              )}
            </div>
            <div className="text-sm text-slate-500 mt-1">
              {retour.company_name && retour.company_id && (
                <Link to={`/companies/${retour.company_id}`} className="text-indigo-600 hover:underline mr-2">
                  {retour.company_name}
                </Link>
              )}
            </div>
          </div>
        </div>

        {/* Info section */}
        <div className="card p-5 mb-4">
          <h2 className="font-semibold text-slate-900 mb-4">Informations</h2>
          <dl className="grid grid-cols-2 md:grid-cols-3 gap-4 text-sm">
            <div>
              <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">N° de retour</dt>
              <dd className="font-mono font-medium text-slate-900">{retour.return_number || '—'}</dd>
            </div>
            <div>
              <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">N° de suivi</dt>
              <dd className="font-mono text-slate-700">{retour.tracking_number || '—'}</dd>
            </div>
            <div>
              <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Date de création</dt>
              <dd className="text-slate-700">{fmtDate(retour.created_at)}</dd>
            </div>
            {retour.received_at && (
              <div>
                <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Date de réception</dt>
                <dd className="text-slate-700">{fmtDate(retour.received_at)}</dd>
              </div>
            )}
            {retour.notes && (
              <div className="col-span-2 md:col-span-3">
                <dt className="text-slate-500 text-xs font-medium uppercase tracking-wide mb-1">Notes</dt>
                <dd className="text-slate-700 whitespace-pre-wrap">{retour.notes}</dd>
              </div>
            )}
          </dl>
        </div>

        {/* Items section */}
        <div className="card overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-200">
            <h2 className="font-semibold text-slate-900">Articles ({retour.items?.length || 0})</h2>
          </div>
          {!retour.items?.length ? (
            <p className="text-center py-10 text-slate-400">Aucun article</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50">
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">N° de série</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500">Produit / SKU</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden sm:table-cell">Raison</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden md:table-cell">Action</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden md:table-cell">Reçu le</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden lg:table-cell">Produit à recevoir</th>
                  <th className="text-left px-4 py-3 text-xs font-semibold text-slate-500 hidden lg:table-cell">Produit à envoyer</th>
                </tr>
              </thead>
              <tbody>
                {retour.items.map((item, i) => (
                  <tr key={item.id || i} className="border-b border-slate-100 last:border-0 hover:bg-slate-50">
                    <td className="px-4 py-3 font-mono text-xs font-medium text-slate-900">{item.serial_number || '—'}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{item.product_name || '—'}</div>
                      {item.sku && <div className="text-xs text-slate-400 font-mono">{item.sku}</div>}
                    </td>
                    <td className="px-4 py-3 hidden sm:table-cell text-slate-600">{item.reason || '—'}</td>
                    <td className="px-4 py-3 hidden md:table-cell text-slate-600">{item.action || '—'}</td>
                    <td className="px-4 py-3 hidden md:table-cell text-slate-500">{fmtDate(item.received_at)}</td>
                    <td className="px-4 py-3 hidden lg:table-cell text-slate-600">{item.product_to_receive || '—'}</td>
                    <td className="px-4 py-3 hidden lg:table-cell text-slate-600">{item.product_to_send || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </Layout>
  )
}
