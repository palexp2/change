import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Barcode, History } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import Spinner from '../components/Spinner.jsx'
import { Badge } from '../components/Badge.jsx'
import { CentralControllerPermissions } from '../components/CentralControllerPermissions.jsx'
import { fmtDate } from '../lib/formatDate.js'
import { fmtCad } from '../utils/formatters.js'
import { DetailLoadError } from '../components/DetailLoadError.jsx'
import WeatherPanel from '../components/WeatherPanel.jsx'

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
  const [loadError, setLoadError] = useState(null)
  const [history, setHistory] = useState([])

  const load = useCallback(() => {
    setLoading(true)
    setLoadError(null)
    api.serials.get(id)
      .then(setSerial)
      .catch((e) => { setSerial(null); setLoadError(e?.message || 'Erreur de chargement') })
      .finally(() => setLoading(false))
    api.serials.history(id)
      .then(r => setHistory(r.data || []))
      .catch(() => setHistory([]))
  }, [id])

  useEffect(() => { load() }, [load])

  if (loading) {
    return <Layout><Spinner center /></Layout>
  }
  if (loadError && !serial) {
    return <Layout><DetailLoadError message={loadError} onRetry={load} /></Layout>
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
                  ? <Link to={`/products/${serial.product_id}`} className="text-brand-600 hover:underline">{serial.product_name}</Link>
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
                ? <Link to={`/companies/${serial.company_id}`} className="text-brand-600 hover:underline">{serial.company_name}</Link>
                : serial.company_name
              }
            </Field>
            <Field label="Statut">{serial.status}</Field>
            <Field label="Adresse">{serial.address}</Field>
            <Field label="Valeur fabrication">{fmtCad(serial.manufacture_value)}</Field>
            <Field label="Date fabrication">{fmtDate(serial.manufacture_date)}</Field>
            <Field label="Dernière programmation">{fmtDate(serial.last_programmed_date)}</Field>
          </div>
          {serial.permissions && Object.keys(serial.permissions).length > 0 && (
            <div className="border-t border-slate-100 pt-4">
              <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-2">Permissions</div>
              <CentralControllerPermissions permissions={serial.permissions} />
            </div>
          )}
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

        {/* Météo au site — conditions à l'adresse où l'unité est installée */}
        <div className="mt-5">
          <WeatherPanel companyId={serial.company_id} />
        </div>

        <div className="card p-5 mt-5">
          <div className="flex items-center gap-2 mb-4">
            <History size={16} className="text-slate-400" />
            <h2 className="text-sm font-semibold text-slate-900">Historique des changements d'état</h2>
            <span className="text-xs text-slate-400">({history.length})</span>
          </div>
          {history.length === 0 ? (
            <div className="text-sm text-slate-400">Aucun changement d'état enregistré.</div>
          ) : (
            <ol className="relative border-l border-slate-200 ml-2">
              {history.map(h => (
                <li key={h.id} className="ml-4 pb-4 last:pb-0">
                  <div className="absolute -left-1.5 w-3 h-3 bg-brand-500 rounded-full mt-1.5 border-2 border-white" />
                  <div className="text-xs text-slate-400">{fmtDate(h.changed_at || h.created_at)}</div>
                  <div className="text-sm text-slate-900 mt-0.5">
                    {h.previous_status ? <Badge color="slate">{h.previous_status}</Badge> : <span className="text-slate-400">—</span>}
                    <span className="mx-2 text-slate-400">→</span>
                    {h.new_status ? <Badge color="blue">{h.new_status}</Badge> : <span className="text-slate-400">—</span>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </Layout>
  )
}
