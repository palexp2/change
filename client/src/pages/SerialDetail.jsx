import { useState, useEffect } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Barcode } from 'lucide-react'
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

function Field({ label, children }) {
  return (
    <div>
      <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-0.5">{label}</div>
      <div className="text-sm text-slate-900">{children || <span className="text-slate-400">—</span>}</div>
    </div>
  )
}

export default function SerialDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [serial, setSerial] = useState(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    api.serials.get(id)
      .then(setSerial)
      .catch(() => setSerial(null))
      .finally(() => setLoading(false))
  }, [id])

  if (loading) {
    return <Layout><div className="flex items-center justify-center h-64"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-600" /></div></Layout>
  }
  if (!serial) {
    return <Layout><div className="p-6 text-slate-500">Numéro de série introuvable.</div></Layout>
  }

  return (
    <Layout>
      <div className="p-6 max-w-2xl mx-auto">
        <div className="flex items-start gap-4 mb-6">
          <button onClick={() => navigate(-1)} className="mt-1 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <Barcode size={20} className="text-slate-400" />
              <h1 className="text-2xl font-bold text-slate-900 font-mono">{serial.serial}</h1>
              {serial.status && <Badge color="blue">{serial.status}</Badge>}
            </div>
            {serial.product_name && (
              <div className="text-sm text-slate-500 mt-1">
                {serial.product_id
                  ? <Link to={`/products/${serial.product_id}`} className="text-indigo-600 hover:underline">{serial.product_name}</Link>
                  : serial.product_name
                }
                {serial.sku && <span className="ml-1 font-mono text-slate-400">({serial.sku})</span>}
              </div>
            )}
          </div>
        </div>

        <div className="card p-5 space-y-5">
          <div className="grid grid-cols-2 gap-5">
            <Field label="Entreprise">
              {serial.company_id
                ? <Link to={`/companies/${serial.company_id}`} className="text-indigo-600 hover:underline">{serial.company_name}</Link>
                : serial.company_name
              }
            </Field>
            <Field label="Statut">{serial.status}</Field>
            <Field label="Adresse">{serial.address}</Field>
            <Field label="Valeur fabrication">{fmtCad(serial.manufacture_value)}</Field>
            <Field label="Date fabrication">{fmtDate(serial.manufacture_date)}</Field>
            <Field label="Dernière programmation">{fmtDate(serial.last_programmed_date)}</Field>
          </div>
          {serial.notes && (
            <div className="border-t border-slate-100 pt-4">
              <Field label="Notes">
                <p className="whitespace-pre-wrap text-slate-600">{serial.notes}</p>
              </Field>
            </div>
          )}
          <div className="border-t border-slate-100 pt-4 flex gap-8 text-xs text-slate-400">
            <span>Créé le {fmtDate(serial.created_at)}</span>
            <span>Mis à jour le {fmtDate(serial.updated_at)}</span>
          </div>
        </div>
      </div>
    </Layout>
  )
}
