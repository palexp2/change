import { useEffect, useState } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Truck } from 'lucide-react'
import api from '../lib/api.js'
import { PageTitle } from '../components/PageTitle.jsx'
import Spinner from '../components/Spinner.jsx'
import { Badge } from '../components/Badge.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { DetailFieldGrid, DetailField } from '../components/DetailFieldGrid.jsx'
import { SaveStatus, useSaveStatus } from '../components/SaveStatus.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { AddressCheckBadge, AddressCheckIssues, parseCheckIssues } from '../components/AddressCheckIssues.jsx'
import { US_STATES, CA_PROVINCES } from '../components/AdresseModal.jsx'
import { DetailLoadError } from '../components/DetailLoadError.jsx'
import EnvoisDetail from './EnvoisDetail.jsx'
import { useDetailRecord } from '../lib/useDetailRecord.js'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'
import { fmtAddress } from '../utils/formatters.js'
import { shipmentTitle, shipmentSubtitle } from '../lib/shipmentLabel.js'

const ADDRESS_TYPES = ['Ferme', 'Livraison', 'Facturation']

// Envois expédiés à cette adresse. Clé de vue `adresse_envois` : mêmes lignes
// que /envois, mais colonnes visibles et vues propres à la fiche adresse.
const SHIPMENT_RENDERS = {
  // Certains envois pointent une commande sans numéro (import Airtable) : on
  // garde le lien, avec un libellé lisible plutôt qu'un « # » orphelin.
  order_number: row => row.order_id
    ? <Link to={`/orders/${row.order_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline font-medium">{row.order_number ? `#${row.order_number}` : 'Commande'}</Link>
    : <span className="text-slate-400">—</span>,
  company_name: row => row.company_id
    ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline">{row.company_name}</Link>
    : <span className="text-slate-400">—</span>,
  tracking_number: row => <span className="font-mono text-xs text-slate-700">{row.tracking_number || '—'}</span>,
  status: row => (row.status
    ? <Badge color={row.status === 'Envoyé' ? 'green' : 'slate'}>{row.status}</Badge>
    : <span className="text-slate-400">—</span>),
  shipped_at: row => <span className="text-slate-500">{fmtDate(row.shipped_at)}</span>,
  created_at: row => <span className="text-slate-500">{fmtDate(row.created_at)}</span>,
}

const SHIPMENT_COLUMNS = TABLE_COLUMN_META.adresse_envois
  .map(meta => ({ ...meta, render: SHIPMENT_RENDERS[meta.id] }))

// Éditeur en ligne : la valeur part au blur (règle autosave du CLAUDE.md).
function InlineText({ value, saving, onSave, testId }) {
  const [local, setLocal] = useState(value ?? '')
  useEffect(() => { setLocal(value ?? '') }, [value])
  return (
    <input
      type="text"
      value={local}
      onChange={e => setLocal(e.target.value)}
      onBlur={e => { if (e.target.value !== (value ?? '')) onSave(e.target.value) }}
      className="input text-sm w-full"
      disabled={saving}
      data-testid={testId}
    />
  )
}

// Fiche d'une adresse. `recordId` + `embedded` : montée dans un
// RecordPeekDrawer (side-peek) sans le chrome de page — c'est ce qui s'ouvre
// quand on clique l'adresse de livraison depuis la fiche d'un envoi.
export default function AdresseDetail({ recordId, embedded = true }) {
  const { id: paramId } = useParams()
  const id = recordId ?? paramId
  const navigate = useNavigate()
  // Le cadre vient toujours du panneau latéral : une fiche ne s'affiche jamais
  // en pleine page (voir components/RecordRoutePanel.jsx).
  const shell = (content) => content

  const { record: adresse, setRecord: setAdresse, loading, loadError, reload: load } =
    useDetailRecord(() => api.adresses.get(id), [id], { clearOnError: true })
  const [contacts, setContacts] = useState([])
  const [envois, setEnvois] = useState([])
  const [loadingEnvois, setLoadingEnvois] = useState(true)
  const [fieldSaving, setFieldSaving] = useState({})
  const { status: saveState, save } = useSaveStatus()

  // Contacts de l'entreprise propriétaire — options du champ « Contact associé ».
  useEffect(() => {
    if (!adresse?.company_id) { setContacts([]); return }
    api.contacts.list({ company_id: adresse.company_id, limit: 'all' })
      .then(r => setContacts(r.data || []))
      .catch(() => setContacts([]))
  }, [adresse?.company_id])

  useEffect(() => {
    if (!id) return
    setLoadingEnvois(true)
    api.shipments.list({ address_id: id, limit: 'all' })
      .then(r => setEnvois(r.data || []))
      .catch(() => setEnvois([]))
      .finally(() => setLoadingEnvois(false))
  }, [id])

  useRealtimeChannel(id ? `adresse:${id}` : null, (msg) => {
    if (msg.type === 'adresse:updated') setAdresse(a => (a ? { ...a, ...msg.payload } : a))
  })

  // Autosave champ par champ. Le PUT est sémantique (seules les colonnes
  // envoyées sont écrites) et renvoie la ligne à jour, verdict du vérificateur
  // d'adresses compris : on la fusionne plutôt que de recharger la fiche.
  async function saveField(patch, keys = Object.keys(patch)) {
    const clean = Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, v === '' ? null : v]))
    setFieldSaving(s => ({ ...s, ...Object.fromEntries(keys.map(k => [k, true])) }))
    try {
      await save(async () => {
        const updated = await api.adresses.update(id, clean)
        setAdresse(a => (a ? { ...a, ...updated } : a))
      })
    } finally {
      setFieldSaving(s => ({ ...s, ...Object.fromEntries(keys.map(k => [k, false])) }))
    }
  }

  if (loading) return shell(<Spinner center />)
  if (loadError && !adresse) return shell(<DetailLoadError message={loadError} onRetry={load} />)
  if (!adresse) return shell(<div className="p-6 text-slate-500">Adresse introuvable.</div>)

  const checkIssues = parseCheckIssues(adresse.check_issues)
  const provinceOptions = adresse.country === 'US' ? US_STATES : CA_PROVINCES

  return shell(
    <div className={embedded ? 'p-6' : 'p-6 max-w-5xl mx-auto'}>
      {/* En panneau latéral, l'en-tête du drawer porte déjà l'adresse : on ne
          répète pas le titre, seulement les pastilles et le lien entreprise. */}
      {embedded ? (
        <div className="flex items-center gap-3 flex-wrap mb-4">
          {adresse.address_type && <Badge color="slate">{adresse.address_type}</Badge>}
          <AddressCheckBadge status={adresse.check_status} />
          <SaveStatus status={saveState} />
          {adresse.company_id && (
            <LinkedRecordField
              name="company_id"
              value={adresse.company_id}
              options={[{ id: adresse.company_id, name: adresse.company_name || 'Entreprise' }]}
              getHref={c => `/companies/${c.id}`}
              disabled
              allowClear={false}
            />
          )}
        </div>
      ) : (
        <div className="flex items-start gap-4 mb-6">
          <button
            onClick={() => navigate(-1)}
            className="mt-1 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg"
            aria-label="Retour"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <PageTitle>{fmtAddress(adresse) || 'Adresse'}</PageTitle>
              {adresse.address_type && <Badge color="slate">{adresse.address_type}</Badge>}
              <AddressCheckBadge status={adresse.check_status} />
              <SaveStatus status={saveState} />
            </div>
            {adresse.company_name && (
              <div className="text-sm text-slate-500 mt-1">
                <LinkedRecordField
                  name="company_id"
                  value={adresse.company_id || adresse.company_name}
                  options={[{ id: adresse.company_id || adresse.company_name, name: adresse.company_name }]}
                  getHref={adresse.company_id ? c => `/companies/${c.id}` : undefined}
                  disabled
                  allowClear={false}
                />
              </div>
            )}
          </div>
        </div>
      )}

      {checkIssues.length > 0 && (
        <div
          className={`mb-4 rounded-lg border px-3 py-2.5 ${adresse.check_status === 'error' ? 'border-red-200 bg-red-50' : 'border-orange-200 bg-orange-50'}`}
          data-testid="adresse-check-panel"
        >
          <div className="text-xs text-slate-600 mb-1">Cette adresse ne passe pas la vérification</div>
          <AddressCheckIssues issues={checkIssues} />
        </div>
      )}

      <DetailFieldGrid entityType="adresses" record={adresse} className="card p-5 mb-4" testId="adresse-fields">
        <DetailField id="line1" label="Rue / Ligne 1" span2 saving={fieldSaving.line1}>
          <InlineText
            value={adresse.line1}
            saving={!!fieldSaving.line1}
            onSave={v => saveField({ line1: v })}
            testId="adresse-field-line1"
          />
        </DetailField>
        <DetailField id="city" label="Ville" saving={fieldSaving.city}>
          <InlineText
            value={adresse.city}
            saving={!!fieldSaving.city}
            onSave={v => saveField({ city: v })}
            testId="adresse-field-city"
          />
        </DetailField>
        <DetailField id="province" label="Province / État" saving={fieldSaving.province}>
          <SearchableSelect
            value={adresse.province || ''}
            options={provinceOptions}
            emptyOption="—"
            onChange={v => saveField({ province: v })}
            className="input text-sm w-full"
            size="sm"
            testId="adresse-province-select"
          />
        </DetailField>
        <DetailField id="postal_code" label="Code postal" saving={fieldSaving.postal_code}>
          <InlineText
            value={adresse.postal_code}
            saving={!!fieldSaving.postal_code}
            onSave={v => saveField({ postal_code: v })}
            testId="adresse-field-postal_code"
          />
        </DetailField>
        <DetailField id="country" label="Pays" saving={fieldSaving.country}>
          {/* Changer de pays invalide la province choisie (listes distinctes). */}
          <select
            value={adresse.country || ''}
            onChange={e => saveField({ country: e.target.value, province: '' }, ['country', 'province'])}
            className="select text-sm w-full"
            disabled={!!fieldSaving.country}
            data-testid="adresse-field-country"
          >
            <option value="CA">Canada (CA)</option>
            <option value="US">États-Unis (US)</option>
          </select>
        </DetailField>
        <DetailField id="address_type" label="Type" saving={fieldSaving.address_type}>
          <select
            value={adresse.address_type || ''}
            onChange={e => saveField({ address_type: e.target.value })}
            className="select text-sm w-full"
            disabled={!!fieldSaving.address_type}
            data-testid="adresse-field-address_type"
          >
            {ADDRESS_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </DetailField>
        <DetailField id="contact_id" label="Contact associé" span2 saving={fieldSaving.contact_id}>
          <LinkedRecordField
            name="address_contact_id"
            value={adresse.contact_id || ''}
            options={contacts}
            labelFn={c => `${c.first_name || ''} ${c.last_name || ''}`.trim() || c.email || c.id}
            getHref={c => `/contacts/${c.id}`}
            saving={!!fieldSaving.contact_id}
            onChange={v => saveField({ contact_id: v })}
          />
        </DetailField>
        <DetailField id="company_id" label="Entreprise">
          {adresse.company_id
            ? <LinkedRecordField
              name="company_id"
              value={adresse.company_id}
              options={[{ id: adresse.company_id, name: adresse.company_name || adresse.company_id }]}
              getHref={c => `/companies/${c.id}`}
              disabled
              allowClear={false}
            />
            : <span className="text-sm text-slate-400">—</span>}
        </DetailField>
        <DetailField id="created_at" label="Créée le">
          <div className="text-sm text-slate-700">{fmtDate(adresse.created_at)}</div>
        </DetailField>
        <DetailField id="updated_at" label="Mise à jour le">
          <div className="text-sm text-slate-700">{fmtDate(adresse.updated_at)}</div>
        </DetailField>
      </DetailFieldGrid>

      {/* Envois livrés à cette adresse — DataTable standard (tri, filtres,
          recherche, side-peek sur la fiche de l'envoi). */}
      <div>
        <div className="flex items-baseline gap-2 mb-2">
          <h2 className="font-semibold text-slate-900">Envois à cette adresse ({envois.length})</h2>
        </div>
        <DataTable
          table="adresse_envois"
          columns={SHIPMENT_COLUMNS}
          data={envois}
          loading={loadingEnvois}
          searchFields={['order_number', 'tracking_number', 'company_name', 'carrier', 'pays', 'notes']}
          // Sans envoi, la table doit rester assez haute pour laisser respirer
          // l'état vide (icône + titre + description).
          height={envois.length === 0 ? 300 : Math.max(180, Math.min(100 + envois.length * 32, 480))}
          peek={{
            title: shipmentTitle,
            subtitle: shipmentSubtitle,
            to: row => `/envois/${row.id}`,
            width: 860,
            render: (row, { close }) => <EnvoisDetail recordId={row.id} embedded onClose={close} />,
          }}
          emptyState={{
            icon: Truck,
            title: 'Aucun envoi',
            description: "Aucune expédition n'a encore été faite à cette adresse.",
          }}
        />
      </div>
    </div>,
  )
}
