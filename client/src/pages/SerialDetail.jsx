import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, History } from 'lucide-react'
import api from '../lib/api.js'
import { PageTitle } from '../components/PageTitle.jsx'
import Spinner from '../components/Spinner.jsx'
import { Badge } from '../components/Badge.jsx'
import { CentralControllerPermissions } from '../components/CentralControllerPermissions.jsx'
import { fmtDate } from '../lib/formatDate.js'
import { fmtCad } from '../utils/formatters.js'
import { DetailLoadError } from '../components/DetailLoadError.jsx'
import { useDetailRecord } from '../lib/useDetailRecord.js'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'
import WeatherPanel from '../components/WeatherPanel.jsx'
import { Field } from '../components/Field.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { CustomDetailFields } from '../components/CustomDetailFields.jsx'

// Champ de la table `serial_numbers` : passe par <Field>, donc par le portier
// des champs supprimés (le bloc disparaît dès qu'on supprime le champ dans
// /champs/serial_numbers).
function SerialField({ id, label, children }) {
  return (
    <Field table="serial_numbers" id={id} label={label} labelClassName="text-xs font-medium text-slate-400 uppercase tracking-wide mb-0.5">
      <div className="text-sm text-slate-900">{children || <span className="text-slate-400">—</span>}</div>
    </Field>
  )
}

// `recordId` + `embedded` : monte la fiche dans un RecordPeekDrawer (side-peek)
// sans le chrome de page (Layout, bouton retour). En route normale l'id vient
// de l'URL.
export default function SerialDetail({ recordId, embedded = true }) {
  const { id: paramId } = useParams()
  const id = recordId ?? paramId
  const navigate = useNavigate()
  const [history, setHistory] = useState([])
  // Le cadre vient toujours du panneau latéral : une fiche ne s'affiche jamais
  // en pleine page (voir components/RecordRoutePanel.jsx).
  const shell = (content) => content

  const { record: serial, setRecord: setSerial, loading, loadError, reload: load } = useDetailRecord(() => {
    // L'historique part en parallèle du record principal (échec silencieux).
    api.serials.history(id)
      .then(r => setHistory(r.data || []))
      .catch(() => setHistory([]))
    return api.serials.get(id)
  }, [id], { clearOnError: true })

  // Modifié ailleurs (Airtable, un collègue) → la fiche suit sans rechargement.
  useRealtimeChannel(id ? `serial_number:${id}` : null, (msg) => {
    if (msg.type === 'serial_number:updated') setSerial(s => (s ? { ...s, ...msg.payload } : s))
  })

  if (loading) return shell(<Spinner center />)
  if (loadError && !serial) return shell(<DetailLoadError message={loadError} onRetry={load} />)
  if (!serial) return shell(<div className="p-6 text-slate-500">Numéro de série introuvable.</div>)

  return shell(
      <div className={embedded ? 'p-6' : 'p-6 max-w-2xl mx-auto'}>
        <div className="flex items-start gap-4 mb-6">
          {!embedded && (
            <button onClick={() => navigate(-1)} className="mt-1 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">
              <ArrowLeft size={18} />
            </button>
          )}
          <div className="flex-1">
            <div className="flex items-center gap-3">
              <PageTitle titleClassName="text-2xl font-bold text-slate-900 font-mono">{serial.serial}</PageTitle>
              {serial.status && <Badge color="blue">{serial.status}</Badge>}
            </div>
            {serial.product_name && (
              <div className="text-sm text-slate-500 mt-1 flex items-center gap-1.5 flex-wrap">
                <LinkedRecordField
                  name="product_id"
                  value={serial.product_id || serial.product_name}
                  options={[{ id: serial.product_id || serial.product_name, name: serial.product_name }]}
                  getHref={serial.product_id ? p => `/products/${p.id}` : undefined}
                  disabled
                  allowClear={false}
                />
                {serial.sku && <span className="font-mono text-slate-400">({serial.sku})</span>}
              </div>
            )}
          </div>
        </div>

        <div className="card p-5 space-y-5">
          <div className="grid grid-cols-2 gap-5">
            <SerialField id="company_name" label="Entreprise">
              {serial.company_name
                ? <LinkedRecordField
                  name="company_id"
                  value={serial.company_id || serial.company_name}
                  options={[{ id: serial.company_id || serial.company_name, name: serial.company_name }]}
                  getHref={serial.company_id ? c => `/companies/${c.id}` : undefined}
                  disabled
                  allowClear={false}
                />
                : null}
            </SerialField>
            <SerialField id="status" label="Statut">{serial.status}</SerialField>
            <SerialField id="address" label="Adresse">{serial.address}</SerialField>
            <SerialField id="manufacture_value" label="Valeur fabrication">{fmtCad(serial.manufacture_value)}</SerialField>
            <SerialField id="manufacture_date" label="Date fabrication">{fmtDate(serial.manufacture_date)}</SerialField>
            <SerialField id="last_programmed_date" label="Dernière programmation">{fmtDate(serial.last_programmed_date)}</SerialField>
            <CustomDetailFields table="serial_numbers" record={serial} labelClassName="text-xs font-medium text-slate-400 uppercase tracking-wide mb-0.5" />
          </div>
          {serial.permissions && Object.keys(serial.permissions).length > 0 && (
            <div className="border-t border-slate-100 pt-4">
              <SerialField id="permissions" label="Permissions">
                <CentralControllerPermissions permissions={serial.permissions} />
              </SerialField>
            </div>
          )}
          {serial.notes && (
            <div className="border-t border-slate-100 pt-4">
              <SerialField id="notes" label="Notes">
                <p className="whitespace-pre-wrap text-slate-600">{serial.notes}</p>
              </SerialField>
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
  )
}
