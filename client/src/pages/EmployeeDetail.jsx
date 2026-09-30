import { hasRole } from '../../../shared/roles.mjs'
import { useAuth } from '../lib/auth.jsx'
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { Trash2, Palmtree, MoreHorizontal } from 'lucide-react'
import api from '../lib/api.js'
import { localISODate } from '../lib/formatDate.js'
import { fmtMoney } from '../utils/formatters.js'
import { RecordOps } from '../lib/recordOps.js'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { DataTable } from '../components/DataTable.jsx'
import { Badge } from '../components/Badge.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { useRealtimeChannel, useEntityListRealtime } from '../lib/useRealtimeChannel.js'
import { useDetailRecord } from '../lib/useDetailRecord.js'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import { DetailShell, detailPending } from '../components/DetailShell.jsx'
import { DetailFieldGrid, DetailField } from '../components/DetailFieldGrid.jsx'

const DEPARTMENTS = ['R&D', 'Opérations', 'Marketing']
const GENDERS = ['Homme', 'Femme', 'Autre']

const SECTIONS = [
  {
    title: 'Identité',
    fields: [
      { key: 'first_name', label: 'Prénom', type: 'text' },
      { key: 'last_name',  label: 'Nom',    type: 'text' },
      { key: 'gender',     label: 'Genre',  type: 'select', options: GENDERS },
      { key: 'birth_date', label: 'Date de naissance', type: 'date' },
      { key: 'address',    label: 'Adresse de résidence', type: 'textarea', span2: true },
      { key: 'emergency_contact', label: "Contact d'urgence", type: 'textarea', span2: true },
      { key: 'address_verified',  label: 'Adresse validée',   type: 'checkbox', span2: true },
    ],
  },
  {
    title: 'Coordonnées',
    fields: [
      { key: 'email_work',     label: 'Courriel travail', type: 'email' },
      { key: 'email_personal', label: 'Courriel perso',   type: 'email' },
      { key: 'phone_work',     label: 'Téléphone travail', type: 'tel' },
      { key: 'phone_personal', label: 'Téléphone perso',   type: 'tel' },
    ],
  },
  {
    title: 'Emploi',
    fields: [
      { key: 'matricule', label: 'Matricule', type: 'text' },
      { key: 'accounting_department', label: 'Département', type: 'select', options: DEPARTMENTS },
      { key: 'hire_date', label: "Date d'embauche", type: 'date' },
      { key: 'end_date',  label: "Date de fin d'emploi", type: 'date' },
      { key: 'hours_per_week',   label: 'Heures par semaine', type: 'number', step: '0.5' },
      { key: 'last_raise_date',  label: 'Dernière augmentation', type: 'date' },
      { key: 'active',         label: 'Actif',          type: 'checkbox' },
      { key: 'is_salesperson', label: 'Vendeur',        type: 'checkbox' },
      { key: 'commission_rate', label: 'Commission (%)', type: 'number', step: '0.25' },
      { key: 'is_consultant',  label: 'Consultant',     type: 'checkbox' },
      { key: 'office_key',     label: 'Clef du bureau', type: 'checkbox' },
    ],
  },
  {
    title: 'Paie & assurances',
    fields: [
      { key: 'nethris_username', label: 'Nethris username', type: 'text' },
      { key: 'insurance_id',     label: 'ID Assurances',    type: 'text' },
      { key: 'banking_info',     label: 'Coordonnées bancaires', type: 'text', span2: true },
      { key: 'group_insurance',  label: 'Assurance collective',  type: 'checkbox', span2: true },
    ],
  },
  {
    title: 'Notes',
    fields: [
      { key: 'peer_reviews', label: 'Évaluations par les pairs', type: 'textarea', span2: true },
      { key: 'issues',       label: 'Problèmes',                 type: 'textarea', span2: true },
    ],
  },
]

const BOOL_KEYS = new Set(['active', 'is_salesperson', 'is_consultant', 'office_key', 'group_insurance', 'address_verified'])

// Colonnes que la fiche affiche DÉJÀ : la carte des champs personnalisés ne doit
// pas les répéter. Depuis que les champs de la table sont tous des champs
// personnalisés, `vacation_pct` (définition propre à l'ERP) s'y serait invité —
// il est saisi juste au-dessus, dans le bloc « Vacances ». `vacation_days_per_year`
// (ancien droit en jours, remplacé par le %) reste caché.
// Champs de la fiche, à plat : les sections de SECTIONS ne servent plus qu'à
// fixer l'ordre de départ. L'ordre réel, et les champs qu'on garde, se règlent
// depuis la fiche (bouton « Personnaliser les champs »).
const ALL_FIELDS = SECTIONS.flatMap(s => s.fields)

// Rendu AILLEURS que dans la carte de champs : le % de vacances est saisi dans
// le bloc « Vacances ». Sans ça il reviendrait en double dans la liste des
// champs de la table.
const TAKEN_ELSEWHERE = ['vacation_pct', 'vacation_days_per_year', 'vacation_ref_date', 'vacation_ref_balance']

function normalize(raw) {
  const out = { ...raw }
  for (const k of BOOL_KEYS) out[k] = raw?.[k] ? 1 : 0
  return out
}

const inp = 'w-full border border-slate-200 rounded-lg px-3 py-1.5 text-sm text-slate-900 focus:outline-none focus:border-brand-400 bg-white'

// `onClose` ferme le panneau après suppression du record.
export default function EmployeeDetail({ recordId: id, onClose }) {
  const { user } = useAuth()
  const isHR = hasRole(user, 'rh')
  // Portier des champs supprimés, libellés, champs personnalisés, ordre et
  // présence : tout est appliqué par la carte de champs commune.
  const leaveRecord = () => onClose?.()
  const confirm = useConfirm()
  const { addToast } = useToast()
  const [form, setForm] = useState(null)
  const [saving, setSaving] = useState(false)
  const saveTimer = useRef(null)
  const pendingRef = useRef({})

  const { record: employee, setRecord: setEmployee, loading, loadError, reload: load } =
    useDetailRecord(async () => {
      const data = await api.employees.get(id)
      setForm(normalize(data))
      return data
    }, [id])
  useEffect(() => () => clearTimeout(saveTimer.current), [])

  useRealtimeChannel(id ? `employee:${id}` : null, (msg) => {
    const verb = msg.type?.split(':').slice(1).join(':')
    if (verb === 'updated' && msg.payload) {
      setEmployee(prev => prev ? { ...prev, ...msg.payload } : msg.payload)
      setForm(prev => prev ? normalize({ ...prev, ...msg.payload }) : prev)
    } else if (verb === 'deleted') {
      leaveRecord()
    }
  })

  function change(key, val) {
    setForm(f => ({ ...f, [key]: val }))
    pendingRef.current[key] = val
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(flush, 400)
  }

  async function flush() {
    const patch = pendingRef.current
    pendingRef.current = {}
    if (!Object.keys(patch).length) return
    setSaving(true)
    try {
      const updated = await api.employees.update(id, patch)
      setEmployee(updated)
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  // Le serveur refuse une première fois (409) si des lignes de paie, de banque
  // d'heures… pendent à l'employé : on dit ce qui serait emporté, puis on force.
  async function handleDelete() {
    if (!(await confirm(`Supprimer ${employee.first_name} ${employee.last_name} ?`))) return
    await runDelete(false)
  }

  async function runDelete(force) {
    try {
      const r = await api.employees.delete(id, { force })
      if (r?.from_airtable) addToast({ message: 'Supprimer aussi dans Airtable, sinon la fiche revient', type: 'info' })
      leaveRecord()
    } catch (err) {
      if (err?.status === 409 && err.details?.dependents) {
        if (await confirm({ message: `Supprime aussi ${err.message} ?`, confirmLabel: 'Tout supprimer' })) {
          await runDelete(true)
        }
        return
      }
      addToast({ message: err.message, type: 'error' })
    }
  }

  // `form` est dérivé du record au chargement : tant qu'il n'existe pas, on est
  // encore en chargement (sauf si c'est le chargement lui-même qui a échoué).
  // Commande de saisie d'un champ. Le libellé, la place et la présence du champ
  // sont rendus par <DetailFieldGrid> : la fiche ne fournit que l'éditeur.
  function fieldEditor(field) {
    const val = form[field.key]
    if (!isHR) return <span className="text-sm whitespace-pre-wrap">{field.type === 'checkbox' ? (val ? 'Oui' : 'Non') : (val ?? '—')}</span>
    if (field.type === 'checkbox') {
      return (
        <input
          type="checkbox" className="rounded" checked={!!val}
          onChange={e => change(field.key, e.target.checked ? 1 : 0)}
          data-testid={`employee-field-${field.key}`}
        />
      )
    }
    if (field.type === 'textarea') {
      return <textarea className={inp} rows={2} value={val ?? ''} onChange={e => change(field.key, e.target.value)} />
    }
    if (field.type === 'select') {
      // Règle CLAUDE.md : tout dropdown > 10 options doit offrir une recherche.
      return (field.options || []).length > 10 ? (
        <SearchableSelect
          value={val || ''}
          options={(field.options || []).map(o => ({ value: o, label: o }))}
          emptyOption="—"
          onChange={v => change(field.key, v)}
          className={inp}
          size="sm"
          testId={`employee-field-${field.key}`}
        />
      ) : (
        <select className={inp} value={val || ''} onChange={e => change(field.key, e.target.value)}
          data-testid={`employee-field-${field.key}`}>
          <option value="">—</option>
          {(field.options || []).map(o => <option key={o} value={o}>{o}</option>)}
        </select>
      )
    }
    if (field.type === 'number') {
      return (
        <input type="number" step={field.step || '1'} className={inp}
          value={val ?? ''} onChange={e => change(field.key, e.target.value === '' ? null : parseFloat(e.target.value))} />
      )
    }
    return (
      <input type={field.type} className={inp}
        value={val ?? ''} onChange={e => change(field.key, e.target.value)} />
    )
  }

  const pending = detailPending({
    loading: !loadError && (loading || !form),
    loadError, onRetry: load, record: employee, notFound: 'Employé introuvable.',
  })
  if (pending) return pending

  const initials = (form.first_name?.[0] || '') + (form.last_name?.[0] || '')

  return (
      <DetailShell
        header={{
          leading: (
            <div className="w-14 h-14 rounded-full bg-brand-100 text-brand-600 flex items-center justify-center font-semibold text-lg flex-shrink-0">
              {initials || '—'}
            </div>
          ),
          badge: (
            <>
              {!form.active && <Badge color="red">Inactif</Badge>}
              {!!form.is_salesperson && <Badge color="indigo">Vendeur</Badge>}
              {!!form.is_consultant && <Badge color="purple">Consultant</Badge>}
            </>
          ),
          meta: (
            <>
              {form.matricule && <span className="font-mono bg-slate-100 px-2 py-0.5 rounded">{form.matricule}</span>}
              {form.accounting_department && <span>{form.accounting_department}</span>}
              {form.email_work && <a href={`mailto:${form.email_work}`} className="link-record">{form.email_work}</a>}
            </>
          ),
          actions: (
            <span className={`text-xs transition-opacity ${saving ? 'opacity-100 text-slate-400' : 'opacity-0'}`}>Sauvegarde…</span>
          ),
        }}
      >
        <div className="space-y-6">
          {isHR && <VacationsSection
            employeeId={id}
            pct={form.vacation_pct}
            onPctChange={v => change('vacation_pct', v)}
            refDate={form.vacation_ref_date}
            refBalance={form.vacation_ref_balance}
            onChange={change}
          />}

          {/* Carte de champs commune : une seule liste, réordonnable depuis la
              fiche (bouton « Personnaliser les champs »). Les champs
              personnalisés de la table s'y posent seuls — d'où `record`. */}
          <DetailFieldGrid
            entityType={isHR ? "employees" : undefined}
            record={isHR ? employee : undefined}
            taken={TAKEN_ELSEWHERE}
            className="card p-5"
            testId="employee-fields"
          >
            {ALL_FIELDS.map(field => (
              <DetailField key={field.key} id={field.key} label={field.label} span2={field.span2}>
                {fieldEditor(field)}
              </DetailField>
            ))}
          </DetailFieldGrid>

          {isHR && <div className="flex justify-end pt-2">
            <button onClick={handleDelete}
              className="text-sm text-slate-400 hover:text-red-600 flex items-center gap-1.5">
              <Trash2 size={14} /> Supprimer cet employé
            </button>
          </div>}
        </div>
      </DetailShell>
  )
}

// Vacances de l'employé : DataTable manipulable (cf. lib/recordOps.js) — clic
// droit = dupliquer/supprimer, « + » sous la dernière ligne = nouvelle période,
// cellules éditables en mode tableur. « Type » est dérivé de `paid` (1/0).
const PAID = 'Congé payé'
const UNPAID = 'Sans solde'
const VACATION_COLUMNS = TABLE_COLUMN_META.employee_vacations.map(meta => ({ ...meta, editable: true }))

function VacationsSection({ employeeId, pct, onPctChange, refDate, refBalance, onChange }) {
  const { addToast } = useToast()
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await api.vacations.list({ employee_id: employeeId })
      setRows(res.data || [])
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    } finally {
      setLoading(false)
    }
  }, [employeeId, addToast])

  useEffect(() => { load() }, [load])

  // Realtime: filtre sur l'employé courant (le canal global est partagé entre toutes les fiches).
  useEntityListRealtime('vacation', setRows, { predicate: (p) => !p?.employee_id || p.employee_id === employeeId })

  const tableRows = useMemo(
    () => rows.map(r => ({ ...r, paid_type: r.paid ? PAID : UNPAID })),
    [rows],
  )

  const vacationOps = useMemo(() => new RecordOps({
    labels: {
      add: 'Ajouter des vacances',
      duplicate: 'Dupliquer',
      delete: 'Supprimer',
      duplicated: 'Vacances dupliquées',
      deleted: 'Vacances supprimées',
    },
    create: async () => {
      const today = localISODate()
      const created = await api.vacations.create({ employee_id: employeeId, start_date: today, end_date: today, paid: 1 })
      setRows(rs => (rs.some(r => r.id === created.id) ? rs : [...rs, created]))
      return created
    },
    duplicate: async (row) => {
      const created = await api.vacations.create({
        employee_id: employeeId, start_date: row.start_date, end_date: row.end_date, paid: row.paid ? 1 : 0, notes: row.notes,
      })
      setRows(rs => {
        if (rs.some(r => r.id === created.id)) return rs
        const idx = rs.findIndex(r => r.id === row.id)
        const next = [...rs]
        next.splice(idx === -1 ? next.length : idx + 1, 0, created)
        return next
      })
      return created
    },
    remove: async (row) => {
      await api.vacations.delete(row.id)
      setRows(rs => rs.filter(r => r.id !== row.id))
    },
    deleteConfirm: row => `Supprimer les vacances ${row.start_date ? `du ${row.start_date}${row.end_date ? ` au ${row.end_date}` : ''}` : 'de cette période'} ?`,
  }), [employeeId])

  async function handleCellEdit(row, col, value) {
    const patch = col.field === 'paid_type'
      ? { paid: value === UNPAID ? 0 : 1 }
      : { [col.field]: value === '' ? null : value }
    setRows(rs => rs.map(r => (r.id === row.id ? { ...r, ...patch } : r)))
    try {
      const updated = await api.vacations.update(row.id, patch)
      setRows(rs => rs.map(r => (r.id === row.id ? updated : r)))
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
      load()
    }
  }

  // Banque de vacances en $ : [montant de référence] + Σ brut des paies
  // (postérieures à la date de référence, s'il y en a une) × % − paies de
  // vacances versées. Le % a changé dans le passé sans historique : le point de
  // référence fixe la banque à une date connue. Le serveur donne les sommes ;
  // le % et le montant de référence sont appliqués ici pour réagir à la frappe.
  const [sums, setSums] = useState(null)
  useEffect(() => {
    api.vacations.balance({ employee_id: employeeId, since: refDate || '' }).then(setSums).catch(() => setSums(null))
  }, [employeeId, refDate])
  const base = refDate ? (Number(refBalance) || 0) : 0
  const accrued = sums ? Math.round(sums.gross * (Number(pct) || 0)) / 100 : null
  const balance = sums ? Math.round((base + accrued - sums.paid_out) * 100) / 100 : null
  const refInp = 'border border-slate-200 rounded-lg px-2 py-1 text-sm text-slate-900 focus:outline-none focus:border-brand-400 bg-white tabular-nums'
  const [refOpen, setRefOpen] = useState(false)
  const refMenuRef = useRef(null)
  useEffect(() => {
    if (!refOpen) return
    const onDown = e => { if (!refMenuRef.current?.contains(e.target)) setRefOpen(false) }
    const onKey = e => { if (e.key === 'Escape') setRefOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [refOpen])

  return (
    <div className="card p-5">
      <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-4">Vacances</h3>

      <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 p-3" data-testid="vacation-balance">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input
              type="number"
              step="0.5"
              min="0"
              className="w-20 border border-slate-200 rounded-lg px-2 py-1 text-sm text-slate-900 focus:outline-none focus:border-brand-400 bg-white tabular-nums"
              value={pct ?? ''}
              onChange={e => onPctChange(e.target.value === '' ? null : parseFloat(e.target.value))}
              data-testid="vacation-pct"
            />
            <span className="text-xs text-slate-400">%</span>
          </label>
          {sums && (
            <div className="flex items-center gap-4 text-sm tabular-nums">
              <span className="text-slate-500">
                Banque{' '}
                <span
                  className={`font-semibold ${balance < 0 ? 'text-red-600' : balance === 0 ? 'text-slate-400' : 'text-emerald-600'}`}
                  data-testid="vacation-bank"
                >
                  {fmtMoney(balance)}
                </span>
              </span>
              <span className="text-slate-300">·</span>
              <span className="text-xs text-slate-400" data-testid="vacation-bank-detail">
                {refDate && <>{fmtMoney(base)} </>}+{fmtMoney(accrued)} − {fmtMoney(sums.paid_out)}
              </span>
            </div>
          )}
          {/* Point de référence : saisi une fois, rangé dans un sous-menu. */}
          <div className="relative ml-auto" ref={refMenuRef}>
            <button
              type="button"
              className="p-1 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-200"
              title="Référence"
              onClick={() => setRefOpen(o => !o)}
              data-testid="vacation-ref-toggle"
            >
              <MoreHorizontal size={16} />
            </button>
            {refOpen && (
              <div className="absolute right-0 top-full mt-1 z-20 rounded-lg border border-slate-200 bg-white p-3 shadow-lg">
                <label className="flex items-center gap-2 text-sm text-slate-600 whitespace-nowrap" title="Banque connue à cette date">
                  <span className="text-xs text-slate-400">Réf.</span>
                  <input
                    type="date"
                    className={refInp}
                    value={refDate ?? ''}
                    onChange={e => onChange('vacation_ref_date', e.target.value || null)}
                    data-testid="vacation-ref-date"
                  />
                  <input
                    type="number"
                    step="0.01"
                    className={`w-28 ${refInp}`}
                    value={refBalance ?? ''}
                    onChange={e => onChange('vacation_ref_balance', e.target.value === '' ? null : parseFloat(e.target.value))}
                    data-testid="vacation-ref-balance"
                  />
                  <span className="text-xs text-slate-400">$</span>
                </label>
              </div>
            )}
          </div>
        </div>
      </div>

      <DataTable
        table="employee_vacations"
        columns={VACATION_COLUMNS}
        data={tableRows}
        loading={loading}
        height="auto"
        onCellEdit={handleCellEdit}
        dateCellPicker
        selectBadges
        recordOps={vacationOps}
        emptyState={{ icon: Palmtree, title: 'Aucune vacance' }}
      />
    </div>
  )
}
