import { useState, useEffect, useRef, useMemo } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, Edit2, Plus, Save, X, Trash2, ExternalLink, FileText, ChevronDown, Package, FolderKanban, CheckSquare, Truck, RefreshCw, LifeBuoy, ShoppingCart, Undo2, Users, MapPin, Phone, ClipboardList, PanelRight } from 'lucide-react'
import EmptyState from '../components/EmptyState.jsx'
import InteractionTimeline from '../components/InteractionTimeline.jsx'
import { CreateInvoiceModal } from '../components/CreateInvoiceModal.jsx'
import api from '../lib/api.js'
import { invalidate } from '../lib/prefetch.js'
import { Layout } from '../components/Layout.jsx'
import Spinner from '../components/Spinner.jsx'
import { Badge, phaseBadgeColor, orderStatusColor, ticketStatusColor } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { AbonnementDetailModal } from '../components/AbonnementDetailModal.jsx'
import { DataTable } from '../components/DataTable.jsx'
import TableThumb from '../components/TableThumb.jsx'
import { CentralControllerPermissions } from '../components/CentralControllerPermissions.jsx'
import { FurnaceV1Alert } from '../components/FurnaceV1Alert.jsx'
import Attachments from '../components/Attachments.jsx'
import ReqRegistryCard from '../components/ReqRegistryCard.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { useUndoableDelete } from '../lib/undoableDelete.js'
import { useAuth } from '../lib/auth.jsx'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'
import { useDetailRecord } from '../lib/useDetailRecord.js'
import { fmtDate } from '../lib/formatDate.js'
import { SaveStatus, useSaveStatus } from '../components/SaveStatus.jsx'
import { DetailLoadError } from '../components/DetailLoadError.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import { DuplicateWarning } from '../components/DuplicateWarning.jsx'
import { AddressCheckBadge, AddressCheckIssues, parseCheckIssues } from '../components/AddressCheckIssues.jsx'

const PHASES = ['Contact', 'Qualified', 'Problem aware', 'Solution aware', 'Lead', 'Quote Sent', 'Customer', 'Not a Client Anymore']
const TYPES = ['ASC', 'Serriculteur', 'Pépinière', 'Producteur fleurs', 'Centre jardin', 'Agriculture urbaine', 'Cannabis', 'Particulier', 'Distributeur', 'Partenaire', 'Compétiteur', 'Consultant', 'Autre']

// États US et provinces/territoires CA — libellés complets pour rendre la recherche utile,
// valeur = code à 2 lettres (format stocké en DB).
const US_STATES = [
  ['AL', 'Alabama'], ['AK', 'Alaska'], ['AZ', 'Arizona'], ['AR', 'Arkansas'], ['CA', 'California'],
  ['CO', 'Colorado'], ['CT', 'Connecticut'], ['DE', 'Delaware'], ['FL', 'Florida'], ['GA', 'Georgia'],
  ['HI', 'Hawaii'], ['ID', 'Idaho'], ['IL', 'Illinois'], ['IN', 'Indiana'], ['IA', 'Iowa'],
  ['KS', 'Kansas'], ['KY', 'Kentucky'], ['LA', 'Louisiana'], ['ME', 'Maine'], ['MD', 'Maryland'],
  ['MA', 'Massachusetts'], ['MI', 'Michigan'], ['MN', 'Minnesota'], ['MS', 'Mississippi'], ['MO', 'Missouri'],
  ['MT', 'Montana'], ['NE', 'Nebraska'], ['NV', 'Nevada'], ['NH', 'New Hampshire'], ['NJ', 'New Jersey'],
  ['NM', 'New Mexico'], ['NY', 'New York'], ['NC', 'North Carolina'], ['ND', 'North Dakota'], ['OH', 'Ohio'],
  ['OK', 'Oklahoma'], ['OR', 'Oregon'], ['PA', 'Pennsylvania'], ['RI', 'Rhode Island'], ['SC', 'South Carolina'],
  ['SD', 'South Dakota'], ['TN', 'Tennessee'], ['TX', 'Texas'], ['UT', 'Utah'], ['VT', 'Vermont'],
  ['VA', 'Virginia'], ['WA', 'Washington'], ['WV', 'West Virginia'], ['WI', 'Wisconsin'], ['WY', 'Wyoming'],
].map(([value, name]) => ({ value, label: `${value} — ${name}` }))

const CA_PROVINCES = [
  ['AB', 'Alberta'], ['BC', 'Colombie-Britannique'], ['MB', 'Manitoba'], ['NB', 'Nouveau-Brunswick'],
  ['NL', 'Terre-Neuve-et-Labrador'], ['NS', 'Nouvelle-Écosse'], ['NT', 'Territoires du Nord-Ouest'],
  ['NU', 'Nunavut'], ['ON', 'Ontario'], ['PE', 'Île-du-Prince-Édouard'], ['QC', 'Québec'],
  ['SK', 'Saskatchewan'], ['YT', 'Yukon'],
].map(([value, name]) => ({ value, label: `${value} — ${name}` }))

import { fmtMoney } from '../utils/formatters.js'
import { fmtPhone, fmtAddress as fmtAddressBase } from '../utils/formatters.js'

const fmtCad = (n) => fmtMoney(n, 'CAD', { fallback: '$0', zeroIsEmpty: true, maximumFractionDigits: 0 })

function fieldTypeInput(type) {
  if (type === 'number') return 'number'
  if (type === 'date') return 'date'
  if (type === 'url') return 'url'
  if (type === 'email') return 'email'
  return 'text'
}


const SERIAL_RENDERS = {
  serial: row => <span className="font-mono font-medium text-slate-900">{row.serial}</span>,
  product_name: row => row.product_id
    ? <Link to={`/products/${row.product_id}`} onClick={e => e.stopPropagation()} className="inline-flex items-center gap-2 text-brand-600 hover:underline">
        {row.product_image
          ? <TableThumb src={row.product_image} className="border border-slate-200 shrink-0" />
          : <div className="h-7 w-7 rounded border border-slate-200 bg-slate-100 shrink-0" />}
        <span>{row.product_name || row.sku || '—'}</span>
      </Link>
    : <span className="text-slate-400">—</span>,
  manufacture_date: row => <span className="text-slate-500">{fmtDate(row.manufacture_date)}</span>,
}

// company_name is redundant on the company detail page — filter it out.
const SERIAL_COLUMNS = TABLE_COLUMN_META.serial_numbers
  .filter(m => m.id !== 'company_name')
  .map(meta => ({ ...meta, render: SERIAL_RENDERS[meta.id] }))

function InlineField({ field, value, saving, onSave }) {
  const [local, setLocal] = useState(String(value ?? ''))
  useEffect(() => { setLocal(String(value ?? '')) }, [value])

  const base = `w-full text-sm rounded-lg border transition-colors focus:outline-none focus:ring-2 focus:ring-brand-400 ${saving ? 'opacity-50' : ''}`
  const inputCls = `${base} border-slate-200 bg-white px-3 py-1.5 hover:border-slate-300`
  const selectCls = `${base} border-slate-200 bg-white px-3 py-1.5 hover:border-slate-300`

  function commit(val) {
    if (val === String(value ?? '')) return
    onSave(val)
  }

  if (field.type === 'boolean') {
    const checked = value === 1 || value === true || value === '1'
    return (
      <div className={field.span2 ? 'col-span-2' : ''}>
        <label className="inline-flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={checked}
            onChange={e => onSave(e.target.checked ? 1 : 0)}
            disabled={saving}
            className="rounded"
          />
          <span className="text-sm text-slate-700">{field.label}</span>
        </label>
      </div>
    )
  }

  return (
    <div className={field.span2 ? 'col-span-2' : ''}>
      <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">{field.label}</div>
      {field.type === 'select' ? (
        // Règle CLAUDE.md : tout dropdown > 10 options doit offrir une recherche.
        (field.options || []).length > 10 ? (
          <SearchableSelect
            value={local}
            options={(field.options || []).map(o => ({ value: o, label: o }))}
            emptyOption="—"
            placeholder="—"
            onChange={v => { setLocal(v); commit(v) }}
            className={selectCls}
            size="sm"
            disabled={saving}
            testId={`company-field-${field.key}`}
          />
        ) : (
          <select value={local} onChange={e => { setLocal(e.target.value); commit(e.target.value) }} className={selectCls} disabled={saving}>
            <option value="">—</option>
            {(field.options || []).map(o => <option key={o} value={o}>{o}</option>)}
          </select>
        )
      ) : field.type === 'textarea' ? (
        <textarea value={local} onChange={e => setLocal(e.target.value)} onBlur={e => commit(e.target.value)} className={`${inputCls} resize-none`} rows={3} />
      ) : field.type === 'phone' ? (
        <input type="tel" value={local} onChange={e => setLocal(e.target.value)}
          onBlur={e => { const f = fmtPhone(e.target.value); setLocal(f); commit(f) }}
          className={inputCls} />
      ) : (
        <input
          type={fieldTypeInput(field.type)}
          value={local}
          onChange={e => setLocal(e.target.value)}
          onBlur={e => commit(e.target.value)}
          className={inputCls}
        />
      )}
    </div>
  )
}

const COMPANY_FIELDS = [
  { key: 'type',            label: 'Type',      type: 'select', options: TYPES },
  { key: 'lifecycle_phase', label: 'Phase',     type: 'select', options: PHASES },
  { key: 'phone',           label: 'Téléphone', type: 'phone' },
  { key: 'website',         label: 'Site web',  type: 'url', span2: true },
  { key: 'currency',        label: 'Devise',    type: 'select', options: ['CAD','USD','EUR'] },
  { key: 'language',        label: 'Langue',    type: 'select', options: ['French','English'] },
  { key: 'is_vendeur_orisha', label: 'Vendeur Orisha', type: 'boolean', span2: true },
  { key: 'notes',           label: 'Notes',     type: 'textarea', span2: true, defaultVisible: false },
]

function AdresseModalContent({ companyId, company, editingAdresse, adresseForm, setAdresseForm, setAdresses, onClose }) {
  const isEdit = !!editingAdresse
  const { addToast } = useToast()
  const [fieldSaving, setFieldSaving] = useState({})
  const [saving, setSaving] = useState(false)
  // Verdict du vérificateur d'adresses, rafraîchi à chaque autosave : l'erreur
  // apparaît sous les yeux de l'utilisateur pendant qu'il corrige.
  const [check, setCheck] = useState(() => ({
    status: editingAdresse?.check_status || null,
    issues: parseCheckIssues(editingAdresse?.check_issues),
  }))

  const applySaved = (updated) => {
    setAdresses(prev => prev.map(a => a.id === updated.id ? updated : a))
    setCheck({ status: updated.check_status || null, issues: parseCheckIssues(updated.check_issues) })
  }

  const saveField = async (key, value) => {
    setAdresseForm(f => ({ ...f, [key]: value }))
    if (!isEdit) return
    setFieldSaving(s => ({ ...s, [key]: true }))
    try {
      applySaved(await api.adresses.update(editingAdresse.id, { [key]: value }))
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    } finally {
      setFieldSaving(s => ({ ...s, [key]: false }))
    }
  }

  const saveCountry = async (value) => {
    setAdresseForm(f => ({ ...f, country: value, province: '' }))
    if (!isEdit) return
    setFieldSaving(s => ({ ...s, country: true }))
    try {
      applySaved(await api.adresses.update(editingAdresse.id, { country: value, province: '' }))
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    } finally {
      setFieldSaving(s => ({ ...s, country: false }))
    }
  }

  async function handleSubmitCreate(e) {
    e.preventDefault()
    setSaving(true)
    try {
      const created = await api.adresses.create({ ...adresseForm, company_id: companyId })
      setAdresses(prev => [...prev, created])
      onClose()
    } catch (err) { addToast({ message: err.message, type: 'error' }) } finally { setSaving(false) }
  }

  const anySaving = Object.values(fieldSaving).some(Boolean)

  const fields = (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
      {check.issues.length > 0 && (
        <div
          className={`col-span-2 rounded-lg border px-3 py-2.5 ${check.status === 'error' ? 'border-red-200 bg-red-50' : 'border-orange-200 bg-orange-50'}`}
          data-testid="adresse-check-panel"
        >
          <div className="flex items-center gap-2 mb-1">
            <AddressCheckBadge status={check.status} />
            <span className="text-xs text-slate-600">Cette adresse ne passe pas la vérification</span>
          </div>
          <AddressCheckIssues issues={check.issues} />
        </div>
      )}
      <div className="col-span-2">
        <label className="label">Rue / Ligne 1</label>
        <input
          value={adresseForm.line1}
          onChange={e => setAdresseForm(f => ({ ...f, line1: e.target.value }))}
          onBlur={isEdit ? e => saveField('line1', e.target.value) : undefined}
          className="input"
        />
      </div>
      <div>
        <label className="label">Ville</label>
        <input
          value={adresseForm.city}
          onChange={e => setAdresseForm(f => ({ ...f, city: e.target.value }))}
          onBlur={isEdit ? e => saveField('city', e.target.value) : undefined}
          className="input"
        />
      </div>
      <div>
        <label className="label">Province / État</label>
        <SearchableSelect
          value={adresseForm.province || ''}
          options={adresseForm.country === 'US' ? US_STATES : CA_PROVINCES}
          emptyOption="—"
          placeholder="—"
          onChange={v => isEdit ? saveField('province', v) : setAdresseForm(f => ({ ...f, province: v }))}
          className="input"
          size="sm"
          testId="adresse-province-select"
        />
      </div>
      <div>
        <label className="label">Code postal</label>
        <input
          value={adresseForm.postal_code}
          onChange={e => setAdresseForm(f => ({ ...f, postal_code: e.target.value }))}
          onBlur={isEdit ? e => saveField('postal_code', e.target.value) : undefined}
          className="input"
        />
      </div>
      <div>
        <label className="label">Pays</label>
        <select value={adresseForm.country} onChange={e => saveCountry(e.target.value)} className="select">
          <option value="CA">Canada (CA)</option>
          <option value="US">États-Unis (US)</option>
        </select>
      </div>
      <div>
        <label className="label">Type</label>
        <select
          value={adresseForm.address_type}
          onChange={e => isEdit ? saveField('address_type', e.target.value) : setAdresseForm(f => ({ ...f, address_type: e.target.value }))}
          className="select"
        >
          {['Ferme', 'Livraison', 'Facturation'].map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      <div className="col-span-2">
        <label className="label">Contact associé</label>
        <LinkedRecordField
          name="address_contact_id"
          value={adresseForm.contact_id}
          options={company?.contacts || []}
          labelFn={c => `${c.first_name || ''} ${c.last_name || ''}`.trim()}
          getHref={c => `/contacts/${c.id}`}
          placeholder="Contact"
          saving={!!fieldSaving.contact_id}
          onChange={v => isEdit ? saveField('contact_id', v) : setAdresseForm(f => ({ ...f, contact_id: v }))}
        />
      </div>
    </div>
  )

  if (isEdit) {
    return (
      <div className="space-y-4">
        {fields}
        <div className="flex items-center justify-end gap-3 pt-2">
          {anySaving && <span className="text-xs text-slate-400">Sauvegarde…</span>}
          <button type="button" onClick={onClose} className="btn-secondary">Fermer</button>
        </div>
      </div>
    )
  }
  return (
    <form onSubmit={handleSubmitCreate} className="space-y-4">
      {fields}
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
        <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Enregistrement…' : 'Enregistrer'}</button>
      </div>
    </form>
  )
}

function CompanyTaskModal({ companyId, company, users, editingTask, taskForm, setTaskForm, savingTask, setSavingTask, onClose, onRefresh }) {
  const isEdit = !!editingTask
  const [fieldSaving, setFieldSaving] = useState({})
  const confirm = useConfirm()
  const { addToast } = useToast()
  const undoableDelete = useUndoableDelete()

  const saveField = async (key, value) => {
    setTaskForm(f => ({ ...f, [key]: value }))
    if (!isEdit) return
    setFieldSaving(s => ({ ...s, [key]: true }))
    try {
      await api.tasks.update(editingTask.id, { [key]: value })
      onRefresh()
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    } finally {
      setFieldSaving(s => ({ ...s, [key]: false }))
    }
  }

  async function handleSubmitCreate(e) {
    e.preventDefault()
    setSavingTask(true)
    try {
      await api.tasks.create({ ...taskForm, company_id: companyId })
      await onRefresh()
      onClose()
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    } finally {
      setSavingTask(false)
    }
  }

  async function handleDelete() {
    if (!(await confirm('Supprimer cette tâche ?'))) return
    onClose()
    await undoableDelete({
      table: 'tasks',
      id: editingTask.id,
      deleteFn: () => api.tasks.delete(editingTask.id),
      label: 'Tâche supprimée',
      onChange: onRefresh,
    })
  }

  const anySaving = Object.values(fieldSaving).some(Boolean)

  const fields = (
    <>
      <div>
        <label className="label">Titre *</label>
        <input
          value={taskForm.title}
          onChange={e => setTaskForm(f => ({ ...f, title: e.target.value }))}
          onBlur={isEdit ? e => saveField('title', e.target.value) : undefined}
          className="input" required autoFocus
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="label">Statut</label>
          <select
            value={taskForm.status}
            onChange={e => isEdit ? saveField('status', e.target.value) : setTaskForm(f => ({ ...f, status: e.target.value }))}
            className="select"
          >
            {['À faire','En cours','Terminé','Annulé'].map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label className="label">Priorité</label>
          <select
            value={taskForm.priority}
            onChange={e => isEdit ? saveField('priority', e.target.value) : setTaskForm(f => ({ ...f, priority: e.target.value }))}
            className="select"
          >
            {['Basse','Normal','Haute','Urgente'].map(p => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
      </div>
      <div>
        <label className="label">Échéance</label>
        <input
          type="date"
          value={taskForm.due_date || ''}
          onChange={e => isEdit ? saveField('due_date', e.target.value) : setTaskForm(f => ({ ...f, due_date: e.target.value }))}
          className="input"
        />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div>
          <label className="label">Contact</label>
          <LinkedRecordField
            name="task_contact_id"
            value={taskForm.contact_id || ''}
            options={company.contacts || []}
            labelFn={c => `${c.first_name || ''} ${c.last_name || ''}`.trim()}
            getHref={c => `/contacts/${c.id}`}
            placeholder="Contact"
            saving={!!fieldSaving.contact_id}
            onChange={v => isEdit ? saveField('contact_id', v) : setTaskForm(f => ({ ...f, contact_id: v }))}
          />
        </div>
        <div>
          <label className="label">Responsable</label>
          <LinkedRecordField
            name="task_assigned_to"
            value={taskForm.assigned_to || ''}
            options={users}
            labelFn={u => u.name}
            placeholder="Responsable"
            saving={!!fieldSaving.assigned_to}
            onChange={v => isEdit ? saveField('assigned_to', v) : setTaskForm(f => ({ ...f, assigned_to: v }))}
          />
        </div>
      </div>
      <div>
        <label className="label">Notes</label>
        <textarea
          value={taskForm.notes || ''}
          onChange={e => setTaskForm(f => ({ ...f, notes: e.target.value }))}
          onBlur={isEdit ? e => saveField('notes', e.target.value) : undefined}
          className="input" rows={2}
        />
      </div>
    </>
  )

  return (
    <Modal title={isEdit ? 'Modifier la tâche' : 'Nouvelle tâche'} onClose={onClose}>
      {isEdit ? (
        <div className="space-y-4">
          {fields}
          <div className="flex items-center justify-between pt-2">
            <button type="button" onClick={handleDelete} className="text-sm text-red-500 hover:text-red-700 hover:underline">Supprimer</button>
            <div className="flex items-center gap-3 ml-auto">
              {anySaving && <span className="text-xs text-slate-400">Sauvegarde…</span>}
              <button type="button" onClick={onClose} className="btn-secondary"><X size={14} /> Fermer</button>
            </div>
          </div>
        </div>
      ) : (
        <form onSubmit={handleSubmitCreate} className="space-y-4">
          {fields}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary"><X size={14} /> Annuler</button>
            <button type="submit" disabled={savingTask} className="btn-primary"><Save size={14} /> {savingTask ? 'Enregistrement...' : 'Enregistrer'}</button>
          </div>
        </form>
      )}
    </Modal>
  )
}

const fmtAddress = (a) => fmtAddressBase(a) || '—'

function OnboardingResponsesPanel({ responses }) {
  const [expanded, setExpanded] = useState(() => responses.length === 1 ? new Set([responses[0].id]) : new Set())
  function toggle(id) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  if (!responses.length) {
    return (
      <div className="card">
        <EmptyState compact icon={ClipboardList} title="Aucune réponse d'onboarding" description="Aucun formulaire d'onboarding n'a encore été rempli pour cette entreprise." />
      </div>
    )
  }
  return (
    <div className="space-y-3">
      {responses.map(r => {
        const isOpen = expanded.has(r.id)
        const headline = r.is_new_site === 'new' ? 'Nouveau site' : r.is_new_site === 'add_to_existing' ? 'Ajout à un site existant' : 'Configuration'
        const statusBadge = r.status === 'submitted'
          ? <span className="inline-flex text-xs font-medium px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">Soumis</span>
          : <span className="inline-flex text-xs font-medium px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">En cours</span>
        return (
          <div key={r.id} className="card overflow-hidden">
            <button
              onClick={() => toggle(r.id)}
              className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50 text-left"
            >
              <div className="flex items-center gap-3 min-w-0">
                <ChevronDown size={16} className={`text-slate-400 transition-transform ${isOpen ? '' : '-rotate-90'}`} />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-900 truncate">{headline}</div>
                  <div className="text-xs text-slate-500">
                    {r.submitted_at ? `Soumis le ${fmtDate(r.submitted_at)}` : `Démarré le ${fmtDate(r.created_at)}`}
                    {r.stripe_invoice_id ? ` · Facture Stripe ${r.stripe_invoice_id}` : ''}
                  </div>
                </div>
              </div>
              {statusBadge}
            </button>
            {isOpen && (
              <div className="border-t border-slate-100 p-4 space-y-4 text-sm">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div>
                    <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">Adresse de la ferme</div>
                    <div className="text-slate-700">{fmtAddress(r.farm_address)}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">Adresse de livraison</div>
                    <div className="text-slate-700">
                      {r.shipping_same_as_farm ? <span className="text-slate-500 italic">Identique à la ferme</span> : fmtAddress(r.shipping_address)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">Niveau de permission</div>
                    <div className="text-slate-700">{r.permission_level || '—'}</div>
                  </div>
                  <div>
                    <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">Accès réseau</div>
                    <div className="text-slate-700">{r.network_access || '—'}</div>
                  </div>
                  {(r.wifi_ssid || r.wifi_password) && (
                    <>
                      <div>
                        <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">SSID Wi-Fi</div>
                        <div className="text-slate-700 font-mono">{r.wifi_ssid || '—'}</div>
                      </div>
                      <div>
                        <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">Mot de passe Wi-Fi</div>
                        <div className="text-slate-700 font-mono">{r.wifi_password || '—'}</div>
                      </div>
                    </>
                  )}
                  <div>
                    <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">Nombre de serres</div>
                    <div className="text-slate-700">{r.num_greenhouses ?? '—'}</div>
                  </div>
                </div>

                {r.greenhouses?.length > 0 && (
                  <div>
                    <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-2">Configuration des serres</div>
                    <div className="space-y-2">
                      {r.greenhouses.map((g, i) => (
                        <div key={i} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                          <div className="text-sm font-medium text-slate-800 mb-1">Serre {i + 1}{g.name ? ` — ${g.name}` : ''}</div>
                          <pre className="text-xs text-slate-600 whitespace-pre-wrap font-mono">{JSON.stringify(g, null, 2)}</pre>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {r.extras?.length > 0 && (
                  <div>
                    <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-2">Extras demandés</div>
                    <ul className="space-y-1">
                      {r.extras.map((e, i) => (
                        <li key={i} className="text-slate-700">
                          <span className="font-medium">{e.role || e.product || 'Extra'}</span>
                          {e.qty != null ? ` × ${e.qty}` : ''}
                          {e.description ? ` — ${e.description}` : ''}
                        </li>
                      ))}
                    </ul>
                    {r.extras_pending_invoice && (
                      <div className="mt-2 text-xs text-slate-500">
                        Facture extras générée
                        {r.extras_pending_invoice.status ? ` — ${r.extras_pending_invoice.status}` : ''}
                        {r.extras_pending_invoice.paid_invoice_id ? ' (payée)' : ''}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function QualificationCallsPanel({ calls }) {
  // Auto-ouvre le plus récent (calls est trié DESC par date côté serveur).
  const [expanded, setExpanded] = useState(() => calls.length ? new Set([calls[0].id]) : new Set())
  function toggle(id) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }
  if (!calls.length) return <div className="card"><EmptyState compact icon={Phone} title="Aucun appel de qualification" description="Aucun appel de qualification n'a encore été enregistré pour cette entreprise." /></div>

  function parseList(v) {
    if (!v) return []
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : [] } catch { return [] }
  }
  function Field({ label, children }) {
    return (
      <div>
        <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1">{label}</div>
        <div className="text-slate-700 whitespace-pre-wrap">{children || <span className="text-slate-400">—</span>}</div>
      </div>
    )
  }
  function Pills({ values }) {
    if (!values.length) return <span className="text-slate-400">—</span>
    return (
      <div className="flex flex-wrap gap-1.5">
        {values.map((v, i) => (
          <span key={i} className="inline-flex text-xs font-medium px-2 py-0.5 rounded-full bg-slate-100 text-slate-700">{v}</span>
        ))}
      </div>
    )
  }
  function Section({ title, children }) {
    return (
      <div>
        <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2 pb-1 border-b border-slate-100">{title}</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">{children}</div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {calls.map(c => {
        const isOpen = expanded.has(c.id)
        const headline = c.summary && c.summary !== 'N/A' ? c.summary : (c.farm_description ? c.farm_description.split('\n')[0] : 'Appel de qualification')
        const statusBadge = c.status
          ? <span className="inline-flex text-xs font-medium px-2 py-0.5 rounded-full bg-blue-100 text-blue-700">{c.status}</span>
          : null
        return (
          <div key={c.id} className="card overflow-hidden">
            <button
              onClick={() => toggle(c.id)}
              className="w-full flex items-center justify-between gap-3 px-4 py-3 hover:bg-slate-50 text-left"
            >
              <div className="flex items-center gap-3 min-w-0">
                <ChevronDown size={16} className={`text-slate-400 transition-transform ${isOpen ? '' : '-rotate-90'}`} />
                <div className="min-w-0">
                  <div className="text-sm font-medium text-slate-900 truncate">{headline}</div>
                  <div className="text-xs text-slate-500">
                    {c.call_date ? fmtDate(c.call_date) : fmtDate(c.airtable_created_at)}
                    {c.assignee ? ` · ${c.assignee}` : ''}
                    {/* "saisi sous X" n'a de sens que quand X diffère du nom courant
                        (cas des records Airtable importés sous un nom historique).
                        Pour un record local créé depuis cette même fiche, c'est du bruit. */}
                    {c.company_name_raw && (!c.airtable_record_id || !c.airtable_record_id.startsWith('local_'))
                      ? ` · saisi sous "${c.company_name_raw}"` : ''}
                  </div>
                </div>
              </div>
              {statusBadge}
            </button>
            {isOpen && (
              <div className="border-t border-slate-100 p-4 space-y-5 text-sm">
                <Section title="Entreprise">
                  <Field label="Description de la ferme">{c.farm_description}</Field>
                  <Field label="Employés">
                    {c.has_employees == null
                      ? '—'
                      : c.has_employees ? `Oui${c.employees_count ? ` (${c.employees_count})` : ''}` : 'Non'}
                  </Field>
                  <Field label="Modèles d'affaires"><Pills values={parseList(c.business_models)} /></Field>
                  <Field label="Gestion actuelle">{c.current_management}{c.management_effective ? ` · ${c.management_effective}` : ''}</Field>
                  {(c.is_charity || c.can_issue_charity_receipt) && (
                    <Field label="Organisme charitable">
                      {c.is_charity ? 'Oui' : 'Non'}
                      {c.can_issue_charity_receipt ? ' · peut émettre un reçu' : ''}
                    </Field>
                  )}
                </Section>

                <Section title="Défis & motivation">
                  <Field label="Principaux défis">{c.challenges}</Field>
                  <Field label="Depuis combien de temps">{c.challenge_duration}</Field>
                  <Field label="Impact financier">{c.challenge_financial_impact}</Field>
                  <Field label="Objectifs court terme">{c.short_term_goals}</Field>
                  <Field label="Motivation aujourd'hui">{c.motivation_today}</Field>
                  <Field label="Pourquoi maintenant">{c.motivation_why_now}</Field>
                  <Field label="Importance des défis (1-5)">{c.importance_score}</Field>
                  <Field label="Prêt à résoudre (1-5)">{c.readiness_score}</Field>
                </Section>

                <Section title="Budget & décision">
                  <Field label="Budget alloué">{c.has_budget}{c.budget_amount ? ` · ${c.budget_amount}` : ''}</Field>
                  <Field label="Échéance">{c.timeline}</Field>
                  <Field label="Décideur">{c.decision_maker_name}{c.decision_maker_role ? ` · ${c.decision_maker_role}` : ''}</Field>
                  <Field label="Rôle dans l'entreprise"><Pills values={parseList(c.role_in_company)} /></Field>
                </Section>

                {(c.grows_tomatoes || parseList(c.tomato_season_months).length || parseList(c.pain_points).length) && (
                  <Section title="Tomates & points douloureux">
                    <Field label="Cultive des tomates">{c.grows_tomatoes}</Field>
                    <Field label="Mois de saison"><Pills values={parseList(c.tomato_season_months)} /></Field>
                    <Field label="Points douloureux"><Pills values={parseList(c.pain_points)} /></Field>
                  </Section>
                )}

                {(c.summary || c.next_steps || c.notes) && (
                  <Section title="Résumé & suivi">
                    <Field label="Résumé">{c.summary}</Field>
                    <Field label="Décision & follow-up">{c.next_steps}</Field>
                    <Field label="Notes">{c.notes}</Field>
                  </Section>
                )}

                <div className="text-xs text-slate-400 pt-2 border-t border-slate-100">
                  {c.airtable_record_id && c.airtable_record_id.startsWith('local_')
                    ? <>Source : ERP · saisi via le module Appel de qualification</>
                    : <>Source : Airtable « Communication interne » · record {c.airtable_record_id}</>}
                </div>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

const SECTION_LABELS = {
  info: 'Informations',
  contacts: 'Contacts',
  interactions: 'Interactions',
  projets: 'Projets',
  commandes: 'Commandes',
  envois: 'Envois',
  retours: 'Retours (RMA)',
  support: 'Support',
  'numéros de série': 'N° de série',
  factures: 'Factures',
  abonnements: 'Abonnements',
  tâches: 'Tâches',
  achats: 'Achats fourn.',
  onboarding: 'Onboarding',
  qualification: 'Qualification call',
}

// Les sous-tableaux étant désormais empilés, chacun est borné en hauteur selon
// son nombre de lignes (32 px/ligne + l'en-tête collant) pour éviter les grands
// vides sous une table de deux lignes.
function stackedTableHeight(rows) {
  if (!rows) return '190px'
  return `${Math.min(520, Math.max(160, 44 + rows * 32))}px`
}

// Bloc de section : ancre pour le scroll-spy + titre et action optionnelle.
function Section({ id, label, count, action, registerRef, children }) {
  return (
    <section ref={registerRef} data-section={id} className="pt-1 pb-8 scroll-mt-2">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wide text-slate-400">
          {label}
          {count > 0 && (
            <span className="bg-slate-100 text-slate-500 text-[11px] font-medium px-1.5 py-0.5 rounded-full leading-none normal-case tracking-normal">{count}</span>
          )}
        </h2>
        {action}
      </div>
      {children}
    </section>
  )
}

// `recordId` + `embedded` permettent de monter cette fiche dans le side-peek
// (RecordPeekDrawer) d'une liste : pas de Layout, pas de bouton retour ni de
// titre (le drawer fournit le sien). `onClose` ferme le drawer (utilisé quand
// le record est supprimé pendant que le drawer est ouvert).
export default function CompanyDetail({ recordId, embedded = false, onClose }) {
  const { id: paramId } = useParams()
  const id = recordId ?? paramId
  const navigate = useNavigate()
  const { user: _user } = useAuth()
  const confirm = useConfirm()
  const { addToast } = useToast()
  // Bulk « Retourner tous les numéros de série » (import automatisation Airtable #3)
  const [bulkReturnSerialIds, setBulkReturnSerialIds] = useState(null)
  const [bulkReturnReason, setBulkReturnReason] = useState('')
  const [bulkReturnSubmitting, setBulkReturnSubmitting] = useState(false)
  // Toutes les sections sont affichées d'un coup (empilées) : `activeSection`
  // sert uniquement à surligner l'entrée du sélecteur latéral en fonction de la
  // position de défilement (scroll-spy), cf. useEffect plus bas.
  const [activeSection, setActiveSection] = useState('info')
  const [fieldSaving, setFieldSaving] = useState(null)
  const { status: saveState, save } = useSaveStatus()
  const [showContactModal, setShowContactModal] = useState(false)
  const [contactForm, setContactForm] = useState({ first_name: '', last_name: '', email: '', phone: '', mobile: '', language: '' })
  const [contactMode, setContactMode] = useState('new') // 'new' | 'link'
  const [linkQuery, setLinkQuery] = useState('')
  const [linkResults, setLinkResults] = useState([])
  const [linkSelected, setLinkSelected] = useState(null)
  const [linkSearching, setLinkSearching] = useState(false)
  const [invoiceMenuOpen, setInvoiceMenuOpen] = useState(false)
  const [invoiceModalOpen, setInvoiceModalOpen] = useState(false)
  const [invoiceModalMode, setInvoiceModalMode] = useState('new')
  const [interactions, setInteractions] = useState([])
  const [interactionsTotal, setInteractionsTotal] = useState(0)
  const [interactionsOffset, setInteractionsOffset] = useState(0)
  const [loadingInteractions, setLoadingInteractions] = useState(false)
  const [loadingMoreInteractions, setLoadingMoreInteractions] = useState(false)
  const INTER_LIMIT = 30
  const [factures, setFactures] = useState([])
  const [facturesTotal, setFacturesTotal] = useState(0)
  const [envoisTotal, setEnvoisTotal] = useState(0)
  const [abonnementsTotal, setAbonnementsTotal] = useState(0)
  const [abonnements, setAbonnements] = useState([])
  const [selectedAbonnement, setSelectedAbonnement] = useState(null)
  const [tasks, setTasks] = useState([])
  const [users, setUsers] = useState([])
  const [showTaskModal, setShowTaskModal] = useState(false)
  const [editingTask, setEditingTask] = useState(null)
  const [taskForm, setTaskForm] = useState({ title: '', status: 'À faire', priority: 'Normal', due_date: '', contact_id: '', assigned_to: '', notes: '' })
  const [savingTask, setSavingTask] = useState(false)
  const [envois, setEnvois] = useState([])
  const [achats, setAchats] = useState([])
  const [achatsTotal, setAchatsTotal] = useState(0)
  const [retours, setRetours] = useState([])
  const [adresses, setAdresses] = useState([])
  const [showAdresseModal, setShowAdresseModal] = useState(false)
  const [editingAdresse, setEditingAdresse] = useState(null)
  const [adresseForm, setAdresseForm] = useState({ line1: '', city: '', province: '', postal_code: '', country: 'CA', address_type: 'Ferme', contact_id: '' })
  const [onboardingResponses, setOnboardingResponses] = useState([])
  const [qualificationCalls, setQualificationCalls] = useState([])
  const { record: company, setRecord: setCompany, loading, loadError, reload: load } =
    useDetailRecord(() => api.companies.get(id), [id])

  useRealtimeChannel(id ? `company:${id}` : null, (msg) => {
    if (msg.type === 'company:updated') {
      setCompany(c => c ? { ...c, ...msg.payload } : c)
    } else if (msg.type === 'company:deleted') {
      if (embedded) onClose?.()
      else navigate('/companies')
    } else if (msg.type === 'company:contacts_changed') {
      // Re-fetch la fiche pour rafraîchir le sous-tableau `contacts`
      // (link/délink/rename d'un contact lié, depuis un autre onglet/user).
      // Invalide le cache prefetch sinon le GET retournerait la version stale.
      invalidate(`/companies/${id}`)
      api.companies.get(id).then(setCompany).catch(() => {})
    }
  })

  useEffect(() => {
    api.adresses.list({ company_id: id, limit: 'all' }).then(r => setAdresses(r.data || [])).catch(() => {})
    api.companies.onboardingResponses(id).then(r => setOnboardingResponses(r.data || [])).catch(() => {})
    api.qualificationCalls.byCompany(id).then(r => setQualificationCalls(r.data || [])).catch(() => {})
  }, [id])


  const visibleFields = useMemo(() => COMPANY_FIELDS.filter(f => f.defaultVisible !== false), [])

  // ── Sections empilées + scroll-spy ──────────────────────────────────────────
  // Le sélecteur latéral n'affiche plus/ne masque plus les sections : tout est
  // rendu à la suite et l'entrée surlignée suit le défilement.
  const sections = useMemo(() => [
    'info', 'contacts', 'interactions', 'projets', 'commandes', 'envois', 'retours', 'support',
    'numéros de série', 'factures', 'abonnements', 'tâches',
    ...(company?.quickbooks_vendor_id ? ['achats'] : []),
    ...(onboardingResponses.length > 0 ? ['onboarding'] : []),
    ...(qualificationCalls.length > 0 ? ['qualification'] : []),
  ], [company?.quickbooks_vendor_id, onboardingResponses.length, qualificationCalls.length])

  const sectionEls = useRef(new Map())
  const sectionsRef = useRef(sections)
  sectionsRef.current = sections
  const spyMutedUntil = useRef(0)
  // Callbacks de ref mémoïsés par section : sinon React les rejouerait
  // (null puis el) à chaque rendu.
  const sectionRefCbs = useRef(new Map())
  const registerSection = (key) => {
    if (!sectionRefCbs.current.has(key)) {
      sectionRefCbs.current.set(key, (el) => {
        if (el) sectionEls.current.set(key, el)
        else sectionEls.current.delete(key)
      })
    }
    return sectionRefCbs.current.get(key)
  }

  // Le conteneur de défilement diffère selon le contexte : <main> en pleine page,
  // le panneau du side-peek en mode embedded. On le retrouve en remontant le DOM.
  function scrollParentOf(el) {
    let p = el?.parentElement
    while (p) {
      if (/(auto|scroll|overlay)/.test(getComputedStyle(p).overflowY)) return p
      p = p.parentElement
    }
    return document.scrollingElement
  }

  useEffect(() => {
    if (loading || !company) return
    const first = sectionEls.current.get(sectionsRef.current[0])
    const root = scrollParentOf(first)
    if (!root) return
    const target = root === document.scrollingElement ? window : root
    let raf = 0
    const compute = () => {
      raf = 0
      if (Date.now() < spyMutedUntil.current) return
      const rootTop = root === document.scrollingElement ? 0 : root.getBoundingClientRect().top
      const probe = rootTop + 96
      const keys = sectionsRef.current
      let current = keys[0]
      for (const key of keys) {
        const el = sectionEls.current.get(key)
        if (!el) continue
        if (el.getBoundingClientRect().top <= probe) current = key
      }
      // Bas de page : la dernière section est forcément « celle où on est rendu »,
      // même si son haut n'a pas franchi la ligne de sonde.
      if (root.scrollHeight - root.scrollTop - root.clientHeight < 6) current = keys[keys.length - 1]
      setActiveSection(prev => (prev === current ? prev : current))
    }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(compute) }
    target.addEventListener('scroll', onScroll, { passive: true })
    compute()
    return () => {
      target.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
  }, [loading, company, sections])

  function goToSection(key) {
    setActiveSection(key)
    const el = sectionEls.current.get(key)
    if (!el) return
    // On coupe le scroll-spy pendant l'animation, sinon les sections traversées
    // feraient sauter le surlignage.
    spyMutedUntil.current = Date.now() + 900
    const root = scrollParentOf(el)
    if (!root || root === document.scrollingElement) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' })
      return
    }
    const delta = el.getBoundingClientRect().top - root.getBoundingClientRect().top
    root.scrollTo({ top: Math.max(0, root.scrollTop + delta - 8), behavior: 'smooth' })
  }

  // ── Colonnes DataTable des sous-tableaux liés ────────────────────────────
  // Dérivées des metas company_* de tableDefs.js, enrichies ici des render()
  // (qui ont besoin de navigate / des setters de modale). Setters useState et
  // navigate sont stables → deps vides (cf. ProjectDetail).
  const contactColumns = useMemo(() => {
    const RENDERS = {
      name: row => (
        <span className="inline-flex items-center gap-1.5 font-medium text-brand-600">
          {row.first_name} {row.last_name}
          {row.link_is_primary === 0 && (
            <Badge color="gray" size="sm" title="Entreprise secondaire pour ce contact">Secondaire</Badge>
          )}
        </span>
      ),
      email: row => row.email || <span className="text-slate-400">—</span>,
      phone: row => <span className="font-mono text-sm text-slate-500">{fmtPhone(row.phone || row.mobile) || '—'}</span>,
      language: row => row.language
        ? <Badge color={row.language === 'French' ? 'blue' : 'green'}>{row.language}</Badge>
        : <span className="text-slate-400">—</span>,
    }
    return TABLE_COLUMN_META.company_contacts.map(m => ({ ...m, render: RENDERS[m.id] }))
  }, [])

  const orderColumns = useMemo(() => {
    const RENDERS = {
      order_number: row => <span className="font-medium">#{row.order_number}</span>,
      status: row => <Badge color={orderStatusColor(row.status)}>{row.status}</Badge>,
      items_count: row => <span className="text-slate-500">{row.items_count}</span>,
      created_at: row => <span className="text-slate-500">{fmtDate(row.created_at)}</span>,
    }
    return TABLE_COLUMN_META.company_orders.map(m => ({ ...m, render: RENDERS[m.id] }))
  }, [])

  const ticketColumns = useMemo(() => {
    const RENDERS = {
      title: row => <span className="font-medium">{row.title}</span>,
      type: row => row.type ? <Badge color="blue">{row.type}</Badge> : <span className="text-slate-400">—</span>,
      status: row => <Badge color={ticketStatusColor(row.status)}>{row.status}</Badge>,
      created_at: row => <span className="text-slate-500">{fmtDate(row.created_at)}</span>,
    }
    return TABLE_COLUMN_META.company_tickets.map(m => ({ ...m, render: RENDERS[m.id] }))
  }, [])

  const factureColumns = useMemo(() => {
    const RENDERS = {
      document_number: row => <span className="font-mono font-medium text-slate-900">{row.document_number || '—'}</span>,
      status: row => <span className="text-slate-600">{row.status || '—'}</span>,
      document_date: row => <span className="text-slate-500">{fmtDate(row.document_date)}</span>,
      amount_before_tax_cad: row => <span className="font-medium text-slate-700">{fmtMoney(row.amount_before_tax_cad, row.currency)}</span>,
      currency: row => <span className="font-mono text-xs text-slate-600">{(row.currency || 'CAD').toUpperCase()}</span>,
    }
    return TABLE_COLUMN_META.company_factures.map(m => ({ ...m, render: RENDERS[m.id] }))
  }, [])

  const abonnementColumns = useMemo(() => {
    const RENDERS = {
      product_name: row => row.product_id
        ? <Link to={`/products/${row.product_id}`} onClick={e => e.stopPropagation()} className="text-brand-600 hover:underline">{row.product_name || '—'}</Link>
        : <span className="text-slate-900">{row.product_name || '—'}</span>,
      type: row => <span className="text-slate-600">{row.type || '—'}</span>,
      status: row => (
        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${row.status === 'active' ? 'bg-green-100 text-green-700' : row.status === 'canceled' ? 'bg-red-100 text-red-700' : row.status === 'past_due' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>
          {row.status === 'active' ? 'Actif' : row.status === 'canceled' ? 'Annulé' : row.status === 'past_due' ? 'En retard' : row.status === 'trialing' ? 'Essai' : row.status}
        </span>
      ),
      amount_cad: row => <span className="font-medium text-slate-700">{fmtCad(row.amount_cad)}</span>,
      start_date: row => <span className="text-slate-500">{fmtDate(row.start_date)}</span>,
      end_date: row => <span className="text-slate-500">{fmtDate(row.end_date)}</span>,
    }
    return TABLE_COLUMN_META.company_abonnements.map(m => ({ ...m, render: RENDERS[m.id] }))
  }, [])

  const envoiColumns = useMemo(() => {
    const RENDERS = {
      tracking_number: row => row.tracking_number
        ? <span className="font-mono text-slate-900">{row.tracking_number}</span>
        : <span className="text-slate-400">—</span>,
      carrier: row => <span className="text-slate-500">{row.carrier || '—'}</span>,
      order_number: row => <span className="text-slate-500">{row.order_number ? `#${row.order_number}` : '—'}</span>,
      shipped_at: row => <span className="text-slate-500">{fmtDate(row.shipped_at)}</span>,
    }
    return TABLE_COLUMN_META.company_envois.map(m => ({ ...m, render: RENDERS[m.id] }))
  }, [])

  const taskColumns = useMemo(() => {
    const RENDERS = {
      title: row => <span className="font-medium text-slate-900">{row.title}</span>,
      status: row => (
        <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full ${row.status === 'Terminé' ? 'bg-green-100 text-green-700' : row.status === 'En cours' ? 'bg-blue-100 text-blue-700' : row.status === 'Annulé' ? 'bg-slate-100 text-slate-500' : 'bg-amber-100 text-amber-700'}`}>{row.status}</span>
      ),
      priority: row => <span className="text-slate-500">{row.priority}</span>,
      due_date: row => {
        if (!row.due_date) return <span className="text-slate-400">—</span>
        const overdue = row.status !== 'Terminé' && new Date(row.due_date) < new Date()
        return <span className={overdue ? 'text-red-600 font-medium' : 'text-slate-500'}>{fmtDate(row.due_date)}</span>
      },
    }
    return TABLE_COLUMN_META.company_tasks.map(m => ({ ...m, render: RENDERS[m.id] }))
  }, [])

  const achatColumns = useMemo(() => {
    const RENDERS = {
      type: row => (
        <span className={`inline-flex text-xs font-medium px-2 py-0.5 rounded-full ${row.type === 'bill' ? 'bg-brand-100 text-brand-700' : 'bg-slate-100 text-slate-600'}`}>
          {row.type === 'bill' ? 'Facture' : 'Dépense'}
        </span>
      ),
      reference: row => {
        const ref = row.bill_number || row.vendor_invoice_number || row.reference || row.description || '—'
        return <span className="font-mono text-slate-900 truncate">{ref}</span>
      },
      status: row => <span className="text-slate-500">{row.status}</span>,
      date_achat: row => <span className="text-slate-500">{fmtDate(row.date_achat)}</span>,
      due_date: row => {
        if (!row.due_date) return <span className="text-slate-400">—</span>
        const overdue = row.status !== 'Payée' && row.status !== 'Annulée' && new Date(row.due_date) < new Date()
        return <span className={overdue ? 'text-red-600 font-medium' : 'text-slate-500'}>{fmtDate(row.due_date)}</span>
      },
      total_cad: row => <span className="font-medium text-slate-700">{fmtCad(row.total_cad)}</span>,
      balance_due_cad: row => {
        if (row.type !== 'bill') return <span className="text-slate-400">—</span>
        const balance = row.balance_due_cad ?? (row.total_cad - row.amount_paid_cad)
        return <span className={balance > 0 ? 'text-red-600 font-medium' : 'text-green-600 font-medium'}>{fmtCad(balance)}</span>
      },
    }
    return TABLE_COLUMN_META.company_achats.map(m => ({ ...m, render: RENDERS[m.id] }))
  }, [])

  const retourColumns = useMemo(() => {
    const RENDERS = {
      return_number: row => <span className="font-mono font-medium text-slate-900">{row.return_number || '—'}</span>,
      status: row => (
        <span className={`inline-flex text-xs font-medium px-2 py-0.5 rounded-full ${row.status === 'Fermé' ? 'bg-slate-100 text-slate-500' : row.status === 'Ouvert' ? 'bg-blue-100 text-blue-700' : 'bg-amber-100 text-amber-700'}`}>{row.status || '—'}</span>
      ),
      processing_status: row => <span className="text-slate-500">{row.processing_status || '—'}</span>,
      contact_name: row => <span className="text-slate-500">{row.contact_first_name ? `${row.contact_first_name} ${row.contact_last_name || ''}`.trim() : '—'}</span>,
      order_number: row => <span className="text-slate-500">{row.order_number ? `#${row.order_number}` : '—'}</span>,
      items_count: row => <span className="text-slate-700">{row.items_count ?? 0}</span>,
      created_at: row => <span className="text-slate-500">{fmtDate(row.created_at)}</span>,
    }
    return TABLE_COLUMN_META.company_retours.map(m => ({ ...m, render: RENDERS[m.id] }))
  }, [])

  // Toutes les sections étant visibles simultanément, tout est chargé au montage
  // (plus de chargement paresseux à la sélection d'un onglet).
  useEffect(() => {
    setLoadingInteractions(true)
    setInteractions([])
    setInteractionsOffset(0)
    api.interactions.list({ company_id: id, limit: INTER_LIMIT, offset: 0, include: 'heavy' })
      .then(d => {
        setInteractions(d.interactions || [])
        setInteractionsTotal(d.total || 0)
        setInteractionsOffset(INTER_LIMIT)
      })
      .catch(() => {})
      .finally(() => setLoadingInteractions(false))
  }, [id])

  useEffect(() => {
    api.factures.list({ company_id: id, limit: 'all' }).then(r => { setFactures(r.data || []); setFacturesTotal(r.total || r.data?.length || 0) }).catch(() => {})
    api.abonnements.list({ company_id: id, limit: 'all' }).then(r => { setAbonnements(r.data || []); setAbonnementsTotal(r.total || r.data?.length || 0) }).catch(() => {})
    api.tasks.list({ company_id: id, limit: 'all' }).then(r => setTasks(r.data || [])).catch(() => {})
    api.auth.users().then(setUsers).catch(() => {})
    api.shipments.list({ company_id: id, limit: 'all' }).then(r => { setEnvois(r.data || []); setEnvoisTotal(r.total || r.data?.length || 0) }).catch(() => {})
    api.returns.listByCompany(id).then(r => setRetours(r.data || [])).catch(() => {})
  }, [id])

  // Achats fournisseurs : seulement si l'entreprise est aussi un fournisseur QB.
  const isVendor = !!company?.quickbooks_vendor_id
  useEffect(() => {
    if (!isVendor) { setAchats([]); setAchatsTotal(0); return }
    api.achatsFournisseurs.list({ vendor_id: id, limit: 'all' }).then(r => { setAchats(r.data || []); setAchatsTotal(r.total || r.data?.length || 0) }).catch(() => {})
  }, [id, isVendor])

  async function loadMoreInteractions() {
    setLoadingMoreInteractions(true)
    try {
      const d = await api.interactions.list({ company_id: id, limit: INTER_LIMIT, offset: interactionsOffset, include: 'heavy' })
      setInteractions(prev => [...prev, ...(d.interactions || [])])
      setInteractionsOffset(o => o + INTER_LIMIT)
    } finally {
      setLoadingMoreInteractions(false)
    }
  }

  async function saveField(key, value) {
    setFieldSaving(key)
    try {
      const ok = await save(async () => {
        await api.companies.update(id, { [key]: value })
        setCompany(c => ({ ...c, [key]: value }))
      })
      return ok
    } finally {
      setFieldSaving(null)
    }
  }

  async function handleAddContact(e) {
    e.preventDefault()
    if (contactMode === 'link') {
      if (!linkSelected) return
      // Lien non-destructif : on ajoute l'entreprise au contact sans toucher
      // à son entreprise principale existante.
      await api.contacts.addCompany(linkSelected.id, { company_id: id })
    } else {
      await api.contacts.create({ ...contactForm, company_id: id })
    }
    setShowContactModal(false)
    setContactForm({ first_name: '', last_name: '', email: '', phone: '', mobile: '', language: '' })
    setContactMode('new')
    setLinkQuery('')
    setLinkResults([])
    setLinkSelected(null)
    load()
  }

  useEffect(() => {
    if (contactMode !== 'link' || !linkQuery || linkQuery.length < 2) { setLinkResults([]); return }
    const tid = setTimeout(async () => {
      setLinkSearching(true)
      try {
        const { data } = await api.contacts.list({ search: linkQuery, limit: 10 })
        setLinkResults((data || []).filter(c => c.company_id !== id))
      } catch {
        setLinkResults([])
      } finally {
        setLinkSearching(false)
      }
    }, 200)
    return () => clearTimeout(tid)
  }, [linkQuery, contactMode, id])

  // En mode embedded (side-peek), pas de Layout : le drawer fournit le cadre.
  const shell = (content) => (embedded ? content : <Layout>{content}</Layout>)

  if (loading) {
    return shell(<Spinner center />)
  }
  if (loadError && !company) {
    return shell(<DetailLoadError message={loadError} onRetry={load} />)
  }
  if (!company) {
    return shell(<div className="p-6 text-slate-500">Entreprise introuvable.</div>)
  }

  const sectionCounts = {
    contacts: company.contacts?.length,
    projets: company.projects?.length,
    interactions: interactionsTotal || undefined,
    commandes: company.orders?.length,
    envois: envoisTotal || undefined,
    support: company.tickets?.length,
    'numéros de série': company.serials?.length,
    factures: facturesTotal || undefined,
    abonnements: abonnementsTotal || undefined,
    tâches: tasks.length || undefined,
    achats: achatsTotal || undefined,
    retours: retours.length || company.returns_count || undefined,
    onboarding: onboardingResponses.length || undefined,
    qualification: qualificationCalls.length || undefined,
  }

  return shell(
    <>
      <div className={embedded ? 'px-5 py-4' : 'p-6 max-w-5xl mx-auto'}>
        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          {!embedded && (
            <button onClick={() => navigate('/companies')} className="mt-1 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">
              <ArrowLeft size={18} />
            </button>
          )}
          <div className="flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              {!embedded && <h1 className="text-2xl font-bold text-slate-900">{company.name}</h1>}
              {company.lifecycle_phase && (
                <Badge color={phaseBadgeColor(company.lifecycle_phase)} size="md">{company.lifecycle_phase}</Badge>
              )}
              <SaveStatus status={saveState} />
            </div>
            <div className="flex items-center gap-3 mt-1 text-sm text-slate-500 flex-wrap">
              {company.type && <span>{company.type}</span>}
              {company.phone && <span>· {fmtPhone(company.phone)}</span>}
              {company.central_controllers?.length > 0 && (
                <span className="flex items-center gap-3 flex-wrap">
                  {company.central_controllers.map(cc => (
                    <a
                      key={cc.address}
                      href={`https://app.orisha.io/#admin/${encodeURIComponent(cc.address)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={cc.serial ? `Contrôleur ${cc.serial} · adresse ${cc.address}` : `Adresse ${cc.address}`}
                      className="inline-flex items-center gap-1 text-brand-600 hover:underline"
                    >
                      <ExternalLink size={12} />
                      {company.central_controllers.length === 1 ? 'Ouvrir dans Orisha' : `Orisha ${cc.address}`}
                    </a>
                  ))}
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!embedded && (
              /* Miroir du bouton « ouvrir en grand » du drawer : retourne à la
                 liste avec cette entreprise ouverte en panneau latéral. */
              <button
                onClick={() => navigate('/companies', { state: { peekId: id } })}
                className="p-1.5 text-slate-400 hover:text-brand-600 hover:bg-slate-100 rounded-lg"
                title="Revenir à la liste avec cette entreprise en panneau latéral"
                aria-label="Ouvrir en panneau latéral"
                data-testid="company-open-as-peek"
              >
                <PanelRight size={16} />
              </button>
            )}
            <div className="relative">
              <button
                onClick={() => setInvoiceMenuOpen(o => !o)}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg"
              >
                <FileText size={14} /> Nouvelle facture <ChevronDown size={14} />
              </button>
              {invoiceMenuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setInvoiceMenuOpen(false)} />
                  <div className="absolute right-0 mt-1 z-20 bg-white border border-slate-200 rounded-lg shadow-lg min-w-[240px] py-1">
                    <button
                      onClick={() => { setInvoiceModalMode('new'); setInvoiceModalOpen(true); setInvoiceMenuOpen(false) }}
                      className="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                    >Créer une nouvelle facture</button>
                    <button
                      onClick={() => { setInvoiceModalMode('convert'); setInvoiceModalOpen(true); setInvoiceMenuOpen(false) }}
                      className="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
                    >Convertir une soumission en facture</button>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        <CreateInvoiceModal
          companyId={id}
          initialMode={invoiceModalMode}
          isOpen={invoiceModalOpen}
          onClose={() => setInvoiceModalOpen(false)}
        />

        <FurnaceV1Alert
          centralControllers={company.central_controllers}
          serials={company.serials}
        />

        {company.central_controllers?.some(cc => cc.permissions && Object.keys(cc.permissions).length > 0) && (
          <div className="card p-4 mb-4">
            <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-3">
              Permissions des contrôleurs centraux
            </div>
            <div className="space-y-3">
              {company.central_controllers
                .filter(cc => cc.permissions && Object.keys(cc.permissions).length > 0)
                .map(cc => (
                  <div key={cc.address} className="border-l-2 border-brand-100 pl-3">
                    <div className="text-sm font-medium text-slate-700 mb-1.5">
                      {cc.serial ? (
                        <Link to={`/serials/${cc.id}`} className="text-brand-600 hover:underline font-mono">{cc.serial}</Link>
                      ) : <span className="font-mono">—</span>}
                      <span className="ml-2 text-xs text-slate-400">adresse {cc.address}</span>
                    </div>
                    <CentralControllerPermissions permissions={cc.permissions} />
                  </div>
                ))}
            </div>
          </div>
        )}

        {/* Sélecteur de section (collant, suit le défilement) + sections empilées */}
        <div className="flex gap-6 items-start">
          <div className="w-44 flex-shrink-0 sticky top-2 self-start max-h-[calc(100vh-120px)] overflow-y-auto">
            <nav className="flex flex-col gap-0.5" data-testid="company-section-nav">
              {sections.map(t => {
                const count = sectionCounts[t]
                const isActive = activeSection === t
                return (
                  <button
                    key={t}
                    onClick={() => goToSection(t)}
                    aria-current={isActive ? 'true' : undefined}
                    data-section-link={t}
                    data-active={isActive ? 'true' : 'false'}
                    className={`flex items-center justify-between gap-2 px-3 py-2 rounded-lg text-sm font-medium transition-colors text-left w-full ${
                      isActive
                        ? 'bg-brand-50 text-brand-700'
                        : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    <span>{SECTION_LABELS[t] || t}</span>
                    {count > 0 && (
                      <span className="bg-slate-200 text-slate-600 text-xs px-1.5 py-0.5 rounded-full leading-none flex-shrink-0">{count}</span>
                    )}
                  </button>
                )
              })}
            </nav>
          </div>

          {/* Sections */}
          <div className="flex-1 min-w-0">

        {/* Section Informations (fiche + adresses + pièces jointes) */}
        <Section id="info" label={SECTION_LABELS.info} registerRef={registerSection('info')}>
          <div className="card p-6">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {visibleFields.map(field => {
                if (field.key === 'name') return null
                const value = company[field.key] ?? ''
                const isSaving = fieldSaving === field.key
                return (
                  <InlineField
                    key={field.key}
                    field={field}
                    value={value}
                    saving={isSaving}
                    onSave={val => saveField(field.key, val)}
                  />
                )
              })}
            </div>
          </div>

          <div className="card p-6 mt-4">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-semibold text-slate-700">Adresses</h3>
              <button onClick={() => { setEditingAdresse(null); setAdresseForm({ line1: '', city: '', province: '', postal_code: '', country: 'CA', address_type: 'Ferme', contact_id: '' }); setShowAdresseModal(true) }} className="btn-secondary btn-sm"><Plus size={13} /> Ajouter</button>
            </div>
            {adresses.length === 0 ? (
              <EmptyState
                compact
                icon={MapPin}
                title="Aucune adresse"
                description="Ajoutez une adresse de ferme, de facturation ou de livraison."
                cta={{ label: 'Ajouter', icon: Plus, onClick: () => { setEditingAdresse(null); setAdresseForm({ line1: '', city: '', province: '', postal_code: '', country: 'CA', address_type: 'Ferme', contact_id: '' }); setShowAdresseModal(true) } }}
              />
            ) : (
              <div className="divide-y divide-slate-100">
                {adresses.map(a => (
                  <div key={a.id} className="flex items-start justify-between py-3 gap-4" data-testid={`adresse-row-${a.id}`}>
                    <div>
                      <div className="flex items-center gap-1.5 mb-1">
                        <span className="inline-block text-xs font-medium px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{a.address_type || '—'}</span>
                        {/* Verdict du vérificateur d'adresses (services/addressCheck.js). */}
                        <AddressCheckBadge status={a.check_status} />
                      </div>
                      <div className="text-sm text-slate-800">{a.line1}</div>
                      <div className="text-xs text-slate-500 mt-0.5">
                        {[a.city, a.province, a.postal_code, a.country].filter(Boolean).join(', ')}
                      </div>
                      <AddressCheckIssues issues={parseCheckIssues(a.check_issues)} className="mt-1" />
                      {a.contact_name?.trim() && (
                        <Link to={`/contacts/${a.contact_id}`} className="text-xs text-brand-500 hover:underline mt-0.5 block">{a.contact_name.trim()}</Link>
                      )}
                      {a.language && <div className="text-xs text-slate-400 mt-0.5">{a.language}</div>}
                    </div>
                    <div className="flex gap-1 flex-shrink-0">
                      <button onClick={() => { setEditingAdresse(a); setAdresseForm({ line1: a.line1||'', city: a.city||'', province: a.province||'', postal_code: a.postal_code||'', country: a.country||'Canada', address_type: a.address_type||'Ferme', contact_id: a.contact_id||'' }); setShowAdresseModal(true) }} className="text-slate-400 hover:text-brand-600 p-1"><Edit2 size={13} /></button>
                      <button onClick={async () => { if (!(await confirm('Supprimer cette adresse ?'))) return; await api.adresses.delete(a.id); setAdresses(prev => prev.filter(x => x.id !== a.id)) }} className="text-slate-400 hover:text-red-500 p-1"><Trash2 size={13} /></button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Registre des entreprises du Québec — correspondance proposée par le
              nom + la ville, liaison explicite. Lecture seule côté registre. */}
          <ReqRegistryCard companyId={company.id} />

          <div className="mt-4">
            <Attachments entityType="companies" entityId={company.id} />
          </div>
        </Section>

        <Section
          id="contacts"
          label={SECTION_LABELS.contacts}
          count={sectionCounts.contacts}
          registerRef={registerSection('contacts')}
          action={<button onClick={() => setShowContactModal(true)} className="btn-primary btn-sm"><Plus size={14} /> Ajouter</button>}
        >
          <DataTable
            table="company_contacts"
            columns={contactColumns}
            data={company.contacts || []}
            searchFields={['first_name', 'last_name', 'email', 'phone', 'mobile']}
            onRowClick={row => navigate(`/contacts/${row.id}`)}
            height={stackedTableHeight(company.contacts?.length)}
            emptyState={{ icon: Users, title: 'Aucun contact', description: "Aucune personne n'est encore rattachée à cette entreprise.", cta: { label: 'Ajouter', icon: Plus, onClick: () => setShowContactModal(true) } }}
          />
        </Section>

        <Section id="interactions" label={SECTION_LABELS.interactions} count={sectionCounts.interactions} registerRef={registerSection('interactions')}>
          <InteractionTimeline
            interactions={interactions}
            loading={loadingInteractions}
            total={interactionsTotal}
            onLoadMore={loadMoreInteractions}
            loadingMore={loadingMoreInteractions}
          />
        </Section>

        {/* Projects Tab */}
        <Section
          id="projets"
          label={SECTION_LABELS.projets}
          count={sectionCounts.projets}
          registerRef={registerSection('projets')}
          action={<Link to={`/pipeline?company_id=${id}`} className="btn-secondary btn-sm"><Plus size={14} /> Nouveau projet</Link>}
        >
            <div className="space-y-3">
              {!company.projects?.length ? (
                <div className="card">
                  <EmptyState
                    compact
                    icon={FolderKanban}
                    title="Aucun projet"
                    description="Cette entreprise n'a encore aucun projet au pipeline."
                    cta={{ label: 'Nouveau projet', icon: Plus, to: `/pipeline?company_id=${id}` }}
                  />
                </div>
              ) : company.projects.map(p => (
                <div key={p.id} className="card p-4">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-medium text-slate-900">{p.name}</div>
                      <div className="text-xs text-slate-500 mt-0.5">{p.type || '—'}</div>
                    </div>
                  </div>
                  <div className="flex gap-4 mt-3 text-sm">
                    <div><span className="text-slate-400">Valeur: </span><span className="font-medium">{fmtCad(p.value_cad)}</span></div>
                    <div><span className="text-slate-400">Probabilité: </span><span className="font-medium">{p.probability}%</span></div>
                    {p.nb_greenhouses > 0 && <div><span className="text-slate-400">Serres: </span><span className="font-medium">{p.nb_greenhouses}</span></div>}
                  </div>
                </div>
              ))}
            </div>
        </Section>

        <Section id="commandes" label={SECTION_LABELS.commandes} count={sectionCounts.commandes} registerRef={registerSection('commandes')}>
          <DataTable
            table="company_orders"
            columns={orderColumns}
            data={company.orders || []}
            searchFields={['order_number', 'status']}
            onRowClick={row => navigate(`/orders/${row.id}`)}
            height={stackedTableHeight(company.orders?.length)}
            emptyState={{ icon: Package, title: 'Aucune commande', description: "Aucune commande n'est encore associée à cette entreprise." }}
          />
        </Section>

        <Section id="envois" label={SECTION_LABELS.envois} count={sectionCounts.envois} registerRef={registerSection('envois')}>
          <DataTable
            table="company_envois"
            columns={envoiColumns}
            data={envois}
            searchFields={['tracking_number', 'carrier', 'order_number', 'status']}
            onRowClick={row => navigate(`/envois/${row.id}`)}
            height={stackedTableHeight(envois.length)}
            emptyState={{ icon: Truck, title: 'Aucun envoi', description: "Aucune expédition n'a encore été créée pour cette entreprise." }}
          />
        </Section>

        <Section id="retours" label={SECTION_LABELS.retours} count={sectionCounts.retours} registerRef={registerSection('retours')}>
          <DataTable
            table="company_retours"
            columns={retourColumns}
            data={retours}
            searchFields={['return_number', 'status', 'processing_status', 'contact_first_name', 'contact_last_name', 'order_number']}
            onRowClick={row => navigate(`/retours/${row.id}`)}
            height={stackedTableHeight(retours.length)}
            emptyState={{ icon: Undo2, title: 'Aucun retour', description: "Aucune demande de retour (RMA) n'a été enregistrée pour cette entreprise." }}
          />
        </Section>

        <Section id="support" label={SECTION_LABELS.support} count={sectionCounts.support} registerRef={registerSection('support')}>
          <DataTable
            table="company_tickets"
            columns={ticketColumns}
            data={company.tickets || []}
            searchFields={['title', 'type', 'status']}
            onRowClick={row => navigate(`/tickets/${row.id}`)}
            height={stackedTableHeight(company.tickets?.length)}
            emptyState={{ icon: LifeBuoy, title: 'Aucun ticket', description: "Aucune demande de support n'a été ouverte pour cette entreprise." }}
          />
        </Section>

        <Section id="numéros de série" label={SECTION_LABELS['numéros de série']} count={sectionCounts['numéros de série']} registerRef={registerSection('numéros de série')}>
          <DataTable
            table="company_serials"
            columns={SERIAL_COLUMNS}
            data={company.serials || []}
            searchFields={['serial', 'product_name', 'status']}
            onRowClick={row => navigate(`/serials/${row.id}`)}
            height={stackedTableHeight(company.serials?.length)}
            bulkActions={[{
              key: 'return-serials',
              label: 'Retourner tous les numéros de série',
              icon: Undo2,
              show: rows => rows.length > 0,
              onClick: (ids) => { setBulkReturnSerialIds(ids); setBulkReturnReason('') },
            }]}
          />
        </Section>

        <Section id="factures" label={SECTION_LABELS.factures} count={sectionCounts.factures} registerRef={registerSection('factures')}>
          <DataTable
            table="company_factures"
            columns={factureColumns}
            data={factures}
            searchFields={['document_number', 'status', 'currency']}
            onRowClick={row => navigate(`/factures/${row.id}`)}
            height={stackedTableHeight(factures.length)}
            emptyState={{ icon: FileText, title: 'Aucune facture', description: "Aucune facture n'a encore été émise pour cette entreprise." }}
          />
        </Section>

        <Section id="abonnements" label={SECTION_LABELS.abonnements} count={sectionCounts.abonnements} registerRef={registerSection('abonnements')}>
          <DataTable
            table="company_abonnements"
            columns={abonnementColumns}
            data={abonnements}
            searchFields={['product_name', 'type', 'status']}
            onRowClick={row => setSelectedAbonnement(row)}
            height={stackedTableHeight(abonnements.length)}
            emptyState={{ icon: RefreshCw, title: 'Aucun abonnement', description: "Cette entreprise n'a aucun abonnement Stripe actif ou passé." }}
          />

          <AbonnementDetailModal
            abonnement={selectedAbonnement}
            onClose={() => setSelectedAbonnement(null)}
            onChange={() => api.abonnements.list({ company_id: id, limit: 'all' }).then(r => setAbonnements(r.data || [])).catch(() => {})}
          />
        </Section>

        <Section
          id="tâches"
          label={SECTION_LABELS.tâches}
          count={sectionCounts.tâches}
          registerRef={registerSection('tâches')}
          action={<button onClick={() => { setTaskForm({ title: '', status: 'À faire', priority: 'Normal', due_date: '', contact_id: '', assigned_to: '', notes: '' }); setEditingTask(null); setShowTaskModal(true) }} className="btn-primary btn-sm"><Plus size={14} /> Ajouter</button>}
        >
          <DataTable
            table="company_tasks"
            columns={taskColumns}
            data={tasks}
            searchFields={['title', 'status', 'priority']}
            onRowClick={row => { setEditingTask(row); setTaskForm({ title: row.title, status: row.status, priority: row.priority, due_date: row.due_date || '', contact_id: row.contact_id || '', assigned_to: row.assigned_to || '', notes: row.notes || '' }); setShowTaskModal(true) }}
            height={stackedTableHeight(tasks.length)}
            emptyState={{ icon: CheckSquare, title: 'Aucune tâche', description: "Aucune tâche n'est associée à cette entreprise pour l'instant.", cta: { label: 'Ajouter', icon: Plus, onClick: () => { setTaskForm({ title: '', status: 'À faire', priority: 'Normal', due_date: '', contact_id: '', assigned_to: '', notes: '' }); setEditingTask(null); setShowTaskModal(true) } } }}
          />
        </Section>

        {company.quickbooks_vendor_id && (
          <Section id="achats" label={SECTION_LABELS.achats} count={sectionCounts.achats} registerRef={registerSection('achats')}>
            <DataTable
              table="company_achats"
              columns={achatColumns}
              data={achats}
              searchFields={['reference', 'bill_number', 'vendor_invoice_number', 'description', 'status']}
              height={stackedTableHeight(achats.length)}
              emptyState={{ icon: ShoppingCart, title: 'Aucun achat fournisseur', description: "Aucune facture ou dépense fournisseur n'est rattachée à cette entreprise." }}
            />
          </Section>
        )}

        {onboardingResponses.length > 0 && (
          <Section id="onboarding" label={SECTION_LABELS.onboarding} count={sectionCounts.onboarding} registerRef={registerSection('onboarding')}>
            <OnboardingResponsesPanel responses={onboardingResponses} />
          </Section>
        )}

        {qualificationCalls.length > 0 && (
          <Section id="qualification" label={SECTION_LABELS.qualification} count={sectionCounts.qualification} registerRef={registerSection('qualification')}>
            <QualificationCallsPanel calls={qualificationCalls} />
          </Section>
        )}

          </div>{/* end sections */}
        </div>{/* end flex nav+sections */}
      </div>

      {/* Task Modal */}
      {showTaskModal && (
        <CompanyTaskModal
          companyId={id}
          company={company}
          users={users}
          editingTask={editingTask}
          taskForm={taskForm}
          setTaskForm={setTaskForm}
          savingTask={savingTask}
          setSavingTask={setSavingTask}
          onClose={() => setShowTaskModal(false)}
          onRefresh={async () => {
            const r = await api.tasks.list({ company_id: id, limit: 'all' })
            setTasks(r.data || [])
          }}
        />
      )}

      {/* Adresse Modal */}
      <Modal isOpen={showAdresseModal} onClose={() => setShowAdresseModal(false)} title={editingAdresse ? 'Modifier l\'adresse' : 'Ajouter une adresse'}>
        <AdresseModalContent
          companyId={id}
          company={company}
          editingAdresse={editingAdresse}
          adresseForm={adresseForm}
          setAdresseForm={setAdresseForm}
          setAdresses={setAdresses}
          onClose={() => setShowAdresseModal(false)}
        />
      </Modal>

      {/* Add Contact Modal */}
      <Modal isOpen={showContactModal} onClose={() => setShowContactModal(false)} title="Ajouter un contact">
        <div className="mb-4 inline-flex bg-slate-100 rounded-lg p-0.5 text-xs font-medium">
          <button type="button" onClick={() => setContactMode('new')}
            className={`px-3 py-1.5 rounded-md transition ${contactMode === 'new' ? 'bg-white shadow text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>
            Nouveau contact
          </button>
          <button type="button" onClick={() => setContactMode('link')}
            className={`px-3 py-1.5 rounded-md transition ${contactMode === 'link' ? 'bg-white shadow text-slate-900' : 'text-slate-500 hover:text-slate-700'}`}>
            Lier un contact existant
          </button>
        </div>
        <form onSubmit={handleAddContact} className="space-y-4">
          {contactMode === 'new' ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="label">Prénom *</label>
                <input value={contactForm.first_name} onChange={e => setContactForm(f => ({ ...f, first_name: e.target.value }))} className="input" required />
              </div>
              <div>
                <label className="label">Nom *</label>
                <input value={contactForm.last_name} onChange={e => setContactForm(f => ({ ...f, last_name: e.target.value }))} className="input" required />
              </div>
              <div>
                <label className="label">Courriel</label>
                <input type="email" value={contactForm.email} onChange={e => setContactForm(f => ({ ...f, email: e.target.value }))} className="input" />
              </div>
              <div>
                <label className="label">Téléphone</label>
                <input value={contactForm.phone} onChange={e => setContactForm(f => ({ ...f, phone: e.target.value }))} className="input" />
              </div>
              <div>
                <label className="label">Mobile</label>
                <input value={contactForm.mobile} onChange={e => setContactForm(f => ({ ...f, mobile: e.target.value }))} className="input" />
              </div>
              <div>
                <label className="label">Langue</label>
                <select value={contactForm.language} onChange={e => setContactForm(f => ({ ...f, language: e.target.value }))} className="select">
                  <option value="">—</option>
                  <option value="French">Français</option>
                  <option value="English">Anglais</option>
                </select>
              </div>
              <div className="sm:col-span-2">
                <DuplicateWarning kind="contact" values={contactForm} />
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <label className="label">Rechercher un contact</label>
                <input
                  value={linkQuery}
                  onChange={e => { setLinkQuery(e.target.value); setLinkSelected(null) }}
                  className="input"
                  placeholder="Nom, courriel ou téléphone…"
                  autoFocus
                />
              </div>
              {linkSelected ? (
                <div className="border border-brand-200 bg-brand-50 rounded-lg px-3 py-2 flex items-start justify-between gap-3">
                  <div>
                    <div className="font-medium text-slate-900">{linkSelected.first_name} {linkSelected.last_name}</div>
                    <div className="text-xs text-slate-500">
                      {linkSelected.email || '—'}{linkSelected.company_name ? ` · Actuellement chez ${linkSelected.company_name}` : ''}
                    </div>
                  </div>
                  <button type="button" onClick={() => setLinkSelected(null)} className="text-slate-400 hover:text-red-500">
                    <X size={16} />
                  </button>
                </div>
              ) : linkQuery.length < 2 ? (
                <p className="text-xs text-slate-400">Tape au moins 2 caractères pour rechercher.</p>
              ) : linkSearching ? (
                <p className="text-xs text-slate-400">Recherche…</p>
              ) : linkResults.length === 0 ? (
                <p className="text-xs text-slate-400">Aucun contact trouvé.</p>
              ) : (
                <ul className="border border-slate-200 rounded-lg divide-y divide-slate-100 max-h-64 overflow-y-auto">
                  {linkResults.map(c => (
                    <li key={c.id}>
                      <button type="button" onClick={() => setLinkSelected(c)}
                        className="w-full text-left px-3 py-2 hover:bg-slate-50 flex items-center justify-between">
                        <div>
                          <div className="text-sm text-slate-900">{c.first_name} {c.last_name}</div>
                          <div className="text-xs text-slate-500">
                            {c.email || '—'}{c.company_name ? ` · ${c.company_name}` : ''}
                          </div>
                        </div>
                        <Plus size={14} className="text-slate-400" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {linkSelected?.company_id && linkSelected.company_id !== id && (
                <p className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                  Ce contact a déjà <span className="font-medium">{linkSelected.company_name}</span> comme entreprise principale — elle le restera. Cette entreprise sera ajoutée en lien secondaire.
                </p>
              )}
            </div>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={() => setShowContactModal(false)} className="btn-secondary">Annuler</button>
            <button type="submit" disabled={contactMode === 'link' && !linkSelected} className="btn-primary">
              {contactMode === 'link' ? 'Lier' : 'Ajouter'}
            </button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={!!bulkReturnSerialIds} onClose={() => setBulkReturnSerialIds(null)} title="Retourner tous les numéros de série" size="sm">
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            {bulkReturnSerialIds?.length} numéro(s) de série sélectionné(s) seront marqués « En retour » et regroupés dans un nouveau dossier de retour.
          </p>
          <div>
            <label className="label">Raison du retour</label>
            <select className="input" value={bulkReturnReason} onChange={e => setBulkReturnReason(e.target.value)} autoFocus>
              <option value="">Sélectionner…</option>
              <option value="Fin d'abonnement">Fin d'abonnement</option>
              <option value="Le client à changé d'idée">Le client à changé d'idée</option>
              <option value="Erreur de commande">Erreur de commande</option>
              <option value="Retour d'équipement de courtoisie">Retour d'équipement de courtoisie</option>
            </select>
          </div>
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={() => setBulkReturnSerialIds(null)} className="btn-secondary">Annuler</button>
            <button
              type="button"
              disabled={!bulkReturnReason || bulkReturnSubmitting}
              onClick={async () => {
                setBulkReturnSubmitting(true)
                try {
                  await api.retours.bulkFromSerials({ company_id: id, serial_ids: bulkReturnSerialIds, reason: bulkReturnReason })
                  addToast({ message: 'Retour créé avec succès.', type: 'success' })
                  setBulkReturnSerialIds(null)
                  api.companies.get(id).then(setCompany).catch(() => {})
                } catch (err) {
                  addToast({ message: err.message, type: 'error' })
                } finally {
                  setBulkReturnSubmitting(false)
                }
              }}
              className="btn-primary"
            >
              {bulkReturnSubmitting ? 'Création…' : 'Confirmer'}
            </button>
          </div>
        </div>
      </Modal>
    </>
  )
}
