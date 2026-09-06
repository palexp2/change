import { Link, useParams, useNavigate } from 'react-router-dom'
import { ExternalLink, Trash2 } from 'lucide-react'
import api from '../lib/api.js'
import { PageTitle } from '../components/PageTitle.jsx'
import Spinner from '../components/Spinner.jsx'
import { Badge } from '../components/Badge.jsx'
import { DetailLoadError } from '../components/DetailLoadError.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { useDetailRecord } from '../lib/useDetailRecord.js'
import { fmtDate } from '../lib/formatDate.js'
import { fmtAddress } from '../utils/formatters.js'

// Fiche d'un formulaire de découverte : lecture des réponses telles que
// remplies par le client (le formulaire lui-même vit sur /d/:token).
// Les codes stockés en base sont traduits ici avec les mêmes libellés que
// ceux affichés au client dans pages/CustomerPostPayment.jsx.

const SITE_LABELS = {
  new: 'Nouveau site',
  add_to_existing: 'Ajout à un site existant',
}
const NETWORK_LABELS = {
  ethernet: 'Ethernet (< 250 pi)',
  wifi_250: 'Wi-Fi (< 250 pi, ligne de vue)',
  wifi_350_coax: '350 pi — câble coaxial fourni',
  mobile_controller: 'Contrôleur internet mobile requis',
}
const PIPE_LABELS = {
  aluminum_C: 'Aluminium (profil C)',
  steel_O: 'Acier (profil rond)',
}
const GUIDE_LABELS = {
  present: 'Déjà présents',
  needed: 'À fournir',
}
const PERMISSION_LABELS = {
  chief_grower: 'Chief',
  helper: 'Helper',
}

function yesNo(v) {
  if (v == null || v === '') return null
  return v ? 'Oui' : 'Non'
}

function Row({ label, children }) {
  const empty = children == null || children === '' || children === false
  return (
    <div>
      <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-0.5">{label}</div>
      <div className="text-sm text-slate-900">{empty ? <span className="text-slate-400">—</span> : children}</div>
    </div>
  )
}

function Section({ title, children, cols = 2 }) {
  return (
    <div className="card p-5">
      <h2 className="text-sm font-semibold text-slate-900 mb-3">{title}</h2>
      <div className={cols === 1 ? 'space-y-3' : 'grid grid-cols-2 gap-4'}>{children}</div>
    </div>
  )
}

function GreenhouseCard({ g, idx }) {
  const perm = PERMISSION_LABELS[g.permission_level]
  const zones = Number(g.irrigation_zones) || 0
  const furnaces = Array.isArray(g.furnaces) ? g.furnaces : []
  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-sm font-semibold text-slate-900">Serre #{idx + 1}</h2>
        {perm && <Badge color={g.permission_level === 'chief_grower' ? 'purple' : 'slate'} size="sm">{perm}</Badge>}
      </div>
      <div className="grid grid-cols-2 gap-4">
        <Row label="Longueur (pi)">{g.length || null}</Row>
        <Row label="Côtés ouvrants">{yesNo(g.has_side_vents)}</Row>
        {g.has_side_vents === true && (
          <>
            <Row label="Hauteur côtés (pi)">{g.side_vent_height || null}</Row>
            <Row label="Tuyau de côté">{PIPE_LABELS[g.side_pipe_type] || g.side_pipe_type}</Row>
            <Row label="Diamètre côté">{g.side_pipe_diameter}</Row>
            <Row label="Tuyaux guides">{GUIDE_LABELS[g.guide_pipes_state] || g.guide_pipes_state}</Row>
            <Row label="Diamètre guides">{g.guide_pipe_diameter}</Row>
            {g.wants_compatible_guide_pipes && <Row label="Guides compatibles">À fournir</Row>}
          </>
        )}
        {g.permission_level === 'chief_grower' && (
          <>
            <Row label="Fournaises">{yesNo(g.has_furnaces)}</Row>
            <Row label="Zones d'irrigation">{zones || null}</Row>
            {zones > 0 && <Row label="Valves 1 po par Orisha">{yesNo(g.needs_orisha_valves)}</Row>}
          </>
        )}
      </div>
      {furnaces.length > 0 && (
        <div className="mt-3 pt-3 border-t border-slate-100 space-y-2">
          {furnaces.map((f, i) => (
            <div key={i} className="rounded-lg border border-slate-200 p-3 grid grid-cols-2 gap-3">
              <Row label={`Fournaise #${i + 1}`}>{[f.brand, f.model === 'Autre' ? f.model_other : f.model].filter(Boolean).join(' ') || null}</Row>
              <Row label="Filage (pi)">{f.control_wire_feet || null}</Row>
              <Row label="Thermostat de secours">{yesNo(f.backup_thermostat)}</Row>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// `recordId` + `embedded` : la fiche est toujours montée dans un
// RecordPeekDrawer (voir components/RecordRoutePanel.jsx), sans chrome de page.
export default function DiscoveryFormDetail({ recordId, onClose, onDeleted }) {
  const { id: paramId } = useParams()
  const id = recordId ?? paramId
  const shell = (content) => content
  const navigate = useNavigate()
  const confirm = useConfirm()
  const { addToast } = useToast()

  const { record: form, loading, loadError, reload } = useDetailRecord(
    () => api.discoveryForms.get(id), [id], { clearOnError: true },
  )

  // Suppression définitive : la table n'est pas soft-delete, donc on confirme.
  async function handleDelete() {
    if (!(await confirm('Supprimer ce système ? Le lien du formulaire cessera de fonctionner.'))) return
    try {
      await api.discoveryForms.delete(id)
      onDeleted?.()
      if (onClose) onClose()
      else navigate('/discovery-forms')
    } catch (err) {
      addToast({ message: err.message || 'Erreur lors de la suppression', type: 'error' })
    }
  }

  if (loading) return shell(<Spinner center />)
  if (loadError && !form) return shell(<DetailLoadError message={loadError} onRetry={reload} />)
  if (!form) return shell(<div className="p-6 text-slate-500">Système introuvable.</div>)

  const submitted = form.status === 'submitted'
  const greenhouses = form.greenhouses || []
  const extras = form.extras || []
  const sameShipping = form.shipping_same_as_farm === true

  return shell(
    <div className="p-6 space-y-4">
      <div>
        <div className="flex items-center gap-3">
          <PageTitle titleClassName="text-xl font-bold text-slate-900">
            {form.company_id
              ? <Link to={`/companies/${form.company_id}`} className="text-brand-600 hover:underline">{form.company_name || 'Entreprise'}</Link>
              : (form.company_name || 'System builder')}
          </PageTitle>
          <Badge color={submitted ? 'green' : 'blue'} size="sm">{submitted ? 'Soumis' : 'En cours'}</Badge>
          <button
            onClick={handleDelete}
            className="ml-auto p-1.5 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded-lg"
            title="Supprimer"
          >
            <Trash2 size={16} />
          </button>
        </div>
        <div className="text-xs text-slate-400 mt-1 flex items-center gap-3">
          <span>Créé le {fmtDate(form.created_at)}</span>
          {form.submitted_at && <span>Soumis le {fmtDate(form.submitted_at)}</span>}
          {form.public_url && (
            <a href={form.public_url} target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline inline-flex items-center gap-1">
              <ExternalLink size={11} /> Formulaire
            </a>
          )}
        </div>
      </div>

      <Section title="Site">
        <Row label="Type">{SITE_LABELS[form.is_new_site] || form.is_new_site}</Row>
        <Row label="Serres">{form.num_greenhouses || null}</Row>
        <Row label="Adresse de la ferme">{fmtAddress(form.farm_address) || null}</Row>
        <Row label="Adresse de livraison">
          {sameShipping ? 'Même que la ferme' : (fmtAddress(form.shipping_address) || null)}
        </Row>
      </Section>

      <Section title="Réseau">
        <Row label="Accès">{NETWORK_LABELS[form.network_access] || form.network_access}</Row>
        <Row label="Wi-Fi">{form.wifi_ssid}</Row>
        {form.wifi_password && <Row label="Mot de passe">{form.wifi_password}</Row>}
      </Section>

      {greenhouses.length === 0
        ? <div className="card p-5 text-sm text-slate-400">Aucune carte de serre.</div>
        : greenhouses.map((g, i) => <GreenhouseCard key={i} g={g} idx={i} />)}

      {extras.length > 0 && (
        <Section title="Extras" cols={1}>
          {extras.map((it, i) => (
            <div key={i} className="text-sm text-slate-900">
              {it.qty ? `${it.qty} × ` : ''}{it.description || it.role}
            </div>
          ))}
        </Section>
      )}
    </div>,
  )
}
