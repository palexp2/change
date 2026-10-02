import { useState, useMemo } from 'react'
import { History } from 'lucide-react'
import api from '../lib/api.js'
import { CentralControllerPermissions } from '../components/CentralControllerPermissions.jsx'
import { fmtDate } from '../lib/formatDate.js'
import { fmtCad } from '../utils/formatters.js'
import { DetailShell, detailPending } from '../components/DetailShell.jsx'
import { useDetailRecord } from '../lib/useDetailRecord.js'
import { useAutosave } from '../lib/useAutosave.js'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { DetailFieldGrid, DetailField } from '../components/DetailFieldGrid.jsx'
import SearchableSelect from '../components/SearchableSelect.jsx'
import { useCustomFields } from '../lib/useCustomFields.js'
import { parseSelectChoices, colorForChoice, ChoiceBadge } from '../lib/customFieldDisplay.jsx'

// Colonnes rendues AILLEURS que dans la carte — le n° de série est le titre du
// panneau, le produit son sous-titre — ou seulement quand elles sont remplies
// (permissions, rendues par leur propre grille). Depuis que toutes les colonnes
// de serial_numbers sont des champs (cf. nativeFieldConversions.js), la carte
// les reproposerait sinon une seconde fois, en JSON brut.
const TAKEN_ELSEWHERE = ['serial', 'product_name', 'permissions']

// Valeur d'un champ, avec le tiret des champs vides.
function Val({ children }) {
  return <div className="text-sm text-slate-900">{children || <span className="text-slate-400">—</span>}</div>
}

export default function SerialDetail({ recordId: id }) {
  const [history, setHistory] = useState([])

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

  // Le produit et le statut se modifient depuis la fiche (autosave) : ce sont
  // les seules colonnes que la route PATCH des numéros de série accepte.
  const { save, savingKeys } = useAutosave(serial, p => api.serials.update(id, p), {
    onSaved: (updated) => setSerial(s => ({ ...s, ...updated })),
  })

  // Choix du statut : ceux du champ « Statut » (/champs/serial_numbers), pour
  // qu'un choix ajouté là-bas apparaisse ici sans retouche.
  const { fields: cf } = useCustomFields('serial_numbers')
  const statusChoices = useMemo(() => parseSelectChoices(cf.find(f => f.column_name === 'status')), [cf])
  const statusOptions = useMemo(() => {
    const opts = statusChoices.map(c => ({ value: c.label ?? c.id, label: c.label ?? c.id }))
    // Valeur hors liste (ancien choix Airtable) : gardée sélectionnable.
    if (serial?.status && !opts.some(o => o.value === serial.status)) opts.push({ value: serial.status, label: serial.status })
    return opts
  }, [statusChoices, serial?.status])
  // Mêmes pastilles colorées que la colonne « Statut » du tableau.
  const statusPill = o => <ChoiceBadge color={colorForChoice(statusChoices, o.label)} className="single-select-label">{o.label}</ChoiceBadge>

  const pending = detailPending({ loading, loadError, onRetry: load, record: serial, notFound: 'Numéro de série introuvable.' })
  if (pending) return pending

  return (
      <DetailShell
        header={{
          badge: serial.status && statusPill({ label: serial.status }),
          meta: (
            <>
              <LinkedRecordField
                name="product_id"
                value={serial.product_id || ''}
                options={serial.product_id ? [{ id: serial.product_id, name: serial.product_name || serial.product_id }] : []}
                getHref={p => `/products/${p.id}`}
                searchTarget="products"
                saving={!!savingKeys.product_id}
                onChange={v => save('product_id', v)}
              />
              {serial.sku && <span className="font-mono text-slate-400">({serial.sku})</span>}
            </>
          ),
        }}
      >
        {/* Carte de champs commune : le panneau y gagne son bouton
            « Personnaliser les champs » (ordre, retrait, ajout d'un champ de la
            table, modification du champ par clic droit). */}
        <DetailFieldGrid
          entityType="serial_numbers"
          record={serial}
          taken={TAKEN_ELSEWHERE}
          className="card p-5"
          testId="serial-fields"
          selectPills
        >
          <DetailField id="company_name" label="Entreprise">
            <Val>
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
            </Val>
          </DetailField>
          <DetailField id="status" label="Statut" saving={!!savingKeys.status}>
            <SearchableSelect
              value={serial.status || ''}
              options={statusOptions}
              emptyOption="—"
              onChange={v => save('status', v)}
              className="input text-sm w-full"
              size="sm"
              disabled={!!savingKeys.status}
              renderValue={statusPill}
              renderOption={statusPill}
            />
          </DetailField>
          <DetailField id="address" label="Adresse"><Val>{serial.address}</Val></DetailField>
          <DetailField id="manufacture_value" label="Valeur fabrication"><Val>{fmtCad(serial.manufacture_value)}</Val></DetailField>
          <DetailField id="manufacture_date" label="Date fabrication"><Val>{fmtDate(serial.manufacture_date)}</Val></DetailField>
          <DetailField id="last_programmed_date" label="Dernière programmation"><Val>{fmtDate(serial.last_programmed_date)}</Val></DetailField>
          {serial.notes && (
            <DetailField id="notes" label="Notes" span2>
              <p className="whitespace-pre-wrap text-sm text-slate-600">{serial.notes}</p>
            </DetailField>
          )}
          {serial.permissions && Object.keys(serial.permissions).length > 0 && (
            <DetailField id="permissions" label="Permissions" span2>
              <CentralControllerPermissions permissions={serial.permissions} />
            </DetailField>
          )}
          <DetailField id="created_at" label="Créé le"><Val>{fmtDate(serial.created_at)}</Val></DetailField>
          <DetailField id="updated_at" label="Mis à jour le"><Val>{fmtDate(serial.updated_at)}</Val></DetailField>
        </DetailFieldGrid>

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
                    {h.previous_status ? statusPill({ label: h.previous_status }) : <span className="text-slate-400">—</span>}
                    <span className="mx-2 text-slate-400">→</span>
                    {h.new_status ? statusPill({ label: h.new_status }) : <span className="text-slate-400">—</span>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </DetailShell>
  )
}
