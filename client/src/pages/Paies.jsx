import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { RefreshCw, Plus, Pencil, Trash2 } from 'lucide-react'
import api from '../lib/api.js'
import { ListPage } from '../components/ListPage.jsx'
import { useListData } from '../lib/useListData.js'
import { DataTable } from '../components/DataTable.jsx'
import { Modal } from '../components/Modal.jsx'
import { SaveStatus, useSaveStatus } from '../components/SaveStatus.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'
import { fmtMoney, fmtNumber } from '../utils/formatters.js'
import { useToast } from '../contexts/ToastContext.jsx'
import { useAuth } from '../lib/auth.jsx'
import Spinner from '../components/Spinner.jsx'

function bool(row, key) {
  return row[key] ? <span className="text-green-600">✓</span> : <span className="text-slate-300">—</span>
}

const num = (n, digits = 2) => fmtNumber(n, { minimumFractionDigits: 0, maximumFractionDigits: digits })

const RENDERS_PAIES = {
  period_end: row => <span className="text-slate-700">{fmtDate(row.period_end)}</span>,
  timesheets_deadline: row => <span className="text-slate-500">{row.timesheets_deadline || '—'}</span>,
  total_with_charges_and_reimb: row => <span className="font-medium">{fmtMoney(row.total_with_charges_and_reimb)}</span>,
  total_regular_amount: row => <span className="text-slate-700">{fmtMoney(row.total_regular_amount)}</span>,
  total_regular_hours: row => <span className="text-slate-700">{num(row.total_regular_hours)}</span>,
  timesheets_sent: row => bool(row, 'timesheets_sent'),
  includes_hourly: row => bool(row, 'includes_hourly'),
  includes_mileage: row => bool(row, 'includes_mileage'),
  includes_expense_reimb: row => bool(row, 'includes_expense_reimb'),
  includes_paid_leave: row => bool(row, 'includes_paid_leave'),
  includes_holiday_hours: row => bool(row, 'includes_holiday_hours'),
  includes_sales_commissions: row => bool(row, 'includes_sales_commissions'),
}

const COLUMNS_PAIES = TABLE_COLUMN_META.paies.map(meta => ({ ...meta, render: RENDERS_PAIES[meta.id] }))

const RENDERS_PAIE_ITEMS = {
  employee_name:           row => <span>{row.first_name} {row.last_name}</span>,
  accounting_department:   row => <span className="text-slate-500">{row.accounting_department || '—'}</span>,
  hourly_rate:             row => <span className="tabular-nums">{fmtMoney(row.hourly_rate)}</span>,
  regular_hours:           row => <span className="tabular-nums">{num(row.regular_hours)}</span>,
  holiday_hours:           row => <span className="tabular-nums">{num(row.holiday_hours)}</span>,
  vacation:                row => <span className="tabular-nums">{fmtMoney(row.vacation)}</span>,
  commission:              row => <span className="tabular-nums">{fmtMoney(row.commission)}</span>,
  expense_reimb:           row => <span className="tabular-nums">{fmtMoney(row.expense_reimb)}</span>,
  holiday_1_20:            row => <span className="tabular-nums">{fmtMoney(row.holiday_1_20)}</span>,
  insurance_gains:         row => <span className="tabular-nums">{fmtMoney(row.insurance_gains)}</span>,
  rsde_pct:                row => <span className="tabular-nums">{row.rsde_pct == null ? '—' : `${num(row.rsde_pct)} %`}</span>,
  paid_leave:              row => <span className="text-slate-600">{row.paid_leave || '—'}</span>,
  period_end:              row => <span className="text-slate-700">{fmtDate(row.period_end)}</span>,
}

const COLUMNS_PAIE_ITEMS = TABLE_COLUMN_META.paie_items
  .filter(meta => meta.id !== 'period_end')
  .map(meta => ({ ...meta, render: RENDERS_PAIE_ITEMS[meta.id] }))

// FK → fiche employé. La route /employees/:id est hrOnly : on ne rend le lien
// que pour admin/rh (sinon un clic redirige vers /dashboard). Non-HR garde le texte.
function buildPaieItemsColumns(isHR) {
  if (!isHR) return COLUMNS_PAIE_ITEMS
  return COLUMNS_PAIE_ITEMS.map(col =>
    col.id === 'employee_name'
      ? {
          ...col,
          render: row => (
            <Link
              to={`/employees/${row.employee_id}`}
              onClick={e => e.stopPropagation()}
              className="font-medium text-brand-600 hover:underline"
            >
              {row.first_name} {row.last_name}
            </Link>
          ),
        }
      : col,
  )
}

const STATUSES = ['Non débuté', 'En cours', 'Complété', 'Envoyé', 'Envoyés']

const EMPTY_PAIE = {
  number: '', period_end: '', status: 'Non débuté',
  nb_holiday_days: 0, total_with_charges_and_reimb: '',
  timesheets_deadline: '', timesheets_sent: 0,
  includes_hourly: 1, includes_mileage: 0, includes_expense_reimb: 1,
  includes_paid_leave: 0, includes_holiday_hours: 0, includes_sales_commissions: 0,
}

// Conversion d'un champ vers sa valeur persistée (numériques → null si vide).
const NUMERIC_FIELDS = new Set(['number', 'nb_holiday_days', 'total_with_charges_and_reimb'])
function normalizeField(key, value) {
  if (NUMERIC_FIELDS.has(key)) return value === '' || value == null ? null : Number(value)
  return value
}

function PaieForm({ paie, onClose, onSaved, onDeleted }) {
  // Édition d'une paie existante → autosave (PATCH on blur / on change), pas de
  // bouton « Enregistrer » (règle CLAUDE.md). Création → bouton « Enregistrer »
  // car le record n'a pas encore d'id.
  const editing = !!paie
  const [form, setForm] = useState(() => {
    if (!paie) return { ...EMPTY_PAIE }
    return {
      ...EMPTY_PAIE,
      ...paie,
      number: paie.number ?? '',
      nb_holiday_days: paie.nb_holiday_days ?? 0,
      total_with_charges_and_reimb: paie.total_with_charges_and_reimb ?? '',
      timesheets_deadline: paie.timesheets_deadline || '',
    }
  })
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState('')
  const { status: saveStatus, save } = useSaveStatus()
  // Dernières valeurs persistées — évite les PATCH redondants au blur.
  const savedRef = useRef(editing ? { ...form } : null)

  // Persiste un champ unique en édition ; ignore les no-op et (pour period_end,
  // requis) les valeurs vides qui effaceraient la borne de période.
  const saveField = useCallback((key, rawValue) => {
    if (!paie) return
    if (savedRef.current && savedRef.current[key] === rawValue) return
    if (key === 'period_end' && !rawValue) return
    if (savedRef.current) savedRef.current[key] = rawValue
    setError('')
    save(() => api.paies.update(paie.id, { [key]: normalizeField(key, rawValue) }))
  }, [paie, save])

  // Inputs texte/nombre : maj du form au change, persistance au blur en édition.
  const f = k => e => setForm(p => ({ ...p, [k]: e.target.value }))
  const blurSave = k => () => { if (editing) saveField(k, form[k]) }
  // Select / checkbox : changement discret → maj du form + persistance immédiate.
  const sel = k => e => {
    const v = e.target.value
    setForm(p => ({ ...p, [k]: v }))
    if (editing) saveField(k, v)
  }
  const chk = k => e => {
    const v = e.target.checked ? 1 : 0
    setForm(p => ({ ...p, [k]: v }))
    if (editing) saveField(k, v)
  }

  async function handleSubmit(e) {
    e.preventDefault()
    if (editing) return // édition = autosave, pas de soumission groupée
    setSaving(true)
    setError('')
    try {
      const payload = {
        ...form,
        number: form.number === '' ? null : Number(form.number),
        nb_holiday_days: form.nb_holiday_days === '' ? null : Number(form.nb_holiday_days),
        total_with_charges_and_reimb: form.total_with_charges_and_reimb === '' ? null : Number(form.total_with_charges_and_reimb),
      }
      await api.paies.create(payload)
      onSaved()
    } catch (err) { setError(err.message) }
    finally { setSaving(false) }
  }

  async function handleDelete() {
    setDeleting(true)
    try {
      await api.paies.delete(paie.id)
      onDeleted()
    } catch (err) { setError(err.message); setDeleting(false) }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      {error && <p className="text-red-600 text-sm">{error}</p>}

      <div>
        <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Période</div>
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="label">Fin de période *</label>
            <input type="date" value={form.period_end || ''} onChange={f('period_end')} onBlur={blurSave('period_end')} className="input" required />
          </div>
          <div>
            <label className="label">Numéro</label>
            <input type="number" value={form.number} onChange={f('number')} onBlur={blurSave('number')} className="input" />
          </div>
          <div>
            <label className="label">Statut</label>
            <select value={form.status || ''} onChange={sel('status')} className="input">
              {STATUSES.map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Nombre de congés fériés</label>
            <input type="number" step="1" value={form.nb_holiday_days ?? ''} onChange={f('nb_holiday_days')} onBlur={blurSave('nb_holiday_days')} className="input" />
          </div>
          <div>
            <label className="label">Date limite correction FdT</label>
            <input value={form.timesheets_deadline || ''} onChange={f('timesheets_deadline')} onBlur={blurSave('timesheets_deadline')} className="input" />
          </div>
          <div>
            <label className="label">Total paie (optionnel)</label>
            <input type="number" step="0.01" value={form.total_with_charges_and_reimb ?? ''} onChange={f('total_with_charges_and_reimb')} onBlur={blurSave('total_with_charges_and_reimb')} className="input" />
          </div>
        </div>
      </div>

      <div>
        <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Inclusions</div>
        <div className="grid grid-cols-2 gap-3">
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={!!form.includes_hourly} onChange={chk('includes_hourly')} className="rounded" /> Heures employés horaires
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={!!form.includes_mileage} onChange={chk('includes_mileage')} className="rounded" /> Kilométrage
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={!!form.includes_expense_reimb} onChange={chk('includes_expense_reimb')} className="rounded" /> Remboursement de dépenses
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={!!form.includes_paid_leave} onChange={chk('includes_paid_leave')} className="rounded" /> Congés payés
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={!!form.includes_holiday_hours} onChange={chk('includes_holiday_hours')} className="rounded" /> Heures fériées
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-600">
            <input type="checkbox" checked={!!form.includes_sales_commissions} onChange={chk('includes_sales_commissions')} className="rounded" /> Commissions vendeurs
          </label>
          <label className="flex items-center gap-2 text-sm text-slate-600 col-span-2 pt-1 border-t border-slate-100 mt-1">
            <input type="checkbox" checked={!!form.timesheets_sent} onChange={chk('timesheets_sent')} className="rounded" /> Feuilles de temps envoyées
          </label>
        </div>
      </div>

      <div className="flex justify-between items-center pt-2">
        <div>
          {paie && (
            confirmDelete ? (
              <div className="flex items-center gap-2">
                <button type="button" onClick={handleDelete} disabled={deleting} className="btn-sm text-red-600 hover:bg-red-50 px-2 py-1 rounded font-medium">
                  {deleting ? 'Suppression…' : 'Confirmer'}
                </button>
                <button type="button" onClick={() => setConfirmDelete(false)} className="btn-sm text-slate-500 px-2 py-1">Annuler</button>
              </div>
            ) : (
              <button type="button" onClick={() => setConfirmDelete(true)} className="text-sm text-slate-400 hover:text-red-600 flex items-center gap-1">
                <Trash2 size={13} /> Supprimer
              </button>
            )
          )}
        </div>
        <div className="flex items-center gap-3">
          {editing ? (
            <>
              <SaveStatus status={saveStatus} />
              <button type="button" onClick={onClose} className="btn-primary">Fermer</button>
            </>
          ) : (
            <>
              <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
              <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Enregistrement…' : 'Enregistrer'}</button>
            </>
          )}
        </div>
      </div>
    </form>
  )
}

// Écriture de répartition de la paie par département (onglet Salaires du
// fichier CTB - Suivi). Aperçu recalculé selon les ajouts saisis (téléphone,
// repas) ; publication QB idempotente (une écriture par paie).
function PaieRepartitionSection({ paie }) {
  const [preview, setPreview] = useState(null)
  const [error, setError] = useState(null)
  const [phone, setPhone] = useState(null)  // null = défaut de la config
  const [meals, setMeals] = useState(null)
  const [pushing, setPushing] = useState(false)
  const [pushed, setPushed] = useState(null) // { id, url }

  const load = (opts = {}) => {
    const params = {}
    if ((opts.phone ?? phone) != null) params.phone = opts.phone ?? phone
    if ((opts.meals ?? meals) != null) params.meals = opts.meals ?? meals
    api.paies.repartitionPreview(paie.id, params)
      .then(p => { setPreview(p); setError(null) })
      .catch(e => setError(e.message))
  }
  useEffect(() => { load() }, [paie.id]) // eslint-disable-line react-hooks/exhaustive-deps

  async function push() {
    setPushing(true)
    setError(null)
    try {
      const out = await api.paies.repartitionPush(paie.id, {
        ...(phone != null ? { phone } : {}), ...(meals != null ? { meals } : {}),
      })
      setPushed({ id: out.qb_journal_entry_id, url: out.qb_journal_entry_url })
    } catch (e) {
      setError(e.message)
    } finally {
      setPushing(false)
    }
  }

  const jeId = pushed?.id || preview?.paie?.repartition_je_id
  const jeUrl = pushed?.url || preview?.paie?.repartition_je_url
  return (
    <div className="border-t border-slate-200 pt-3" data-testid="paie-repartition">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-slate-800">Répartition comptable par département</h3>
        {jeId ? (
          jeUrl ? (
            <a href={jeUrl} target="_blank" rel="noreferrer" title="Ouvrir l'écriture dans QuickBooks"
              className="text-xs text-green-700 bg-green-100 hover:bg-green-200 px-2 py-0.5 rounded-full">
              Publiée — JE QuickBooks #{jeId} ↗
            </a>
          ) : (
            <span className="text-xs text-green-700 bg-green-100 px-2 py-0.5 rounded-full">Publiée — JE QuickBooks #{jeId}</span>
          )
        ) : (
          // Action transactionnelle (publication QB) : bouton volontaire.
          <button onClick={push} disabled={pushing || !preview || preview.base <= 0}
            className="btn-primary text-sm disabled:opacity-50" data-testid="paie-repartition-push">
            {pushing ? 'Publication…' : 'Publier sur QB'}
          </button>
        )}
      </div>
      {error && <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded px-3 py-2 mb-2">{error}</div>}
      {preview && (
        <>
          <div className="flex flex-wrap items-end gap-4 text-sm mb-2">
            <div>
              <div className="text-xs text-slate-500">Total paie − remb. ({fmtMoney(preview.reimb)})</div>
              <div className="font-medium tabular-nums">{fmtMoney(preview.total)} → base {fmtMoney(preview.base)}</div>
            </div>
            <div>
              <label className="text-xs text-slate-500 block">Téléphone Martin (76000)</label>
              {/* text + inputMode : un input number rejette la virgule décimale
                  fr-CA (valeur vide) — le serveur normalise via parseAmount. */}
              <input type="text" inputMode="decimal" className="input w-24"
                value={phone ?? preview.phone}
                onChange={e => setPhone(e.target.value)}
                onBlur={e => load({ phone: e.target.value })} />
            </div>
            <div>
              <label className="text-xs text-slate-500 block">Repas séjour (75930)</label>
              <input type="text" inputMode="decimal" className="input w-24"
                value={meals ?? preview.meals}
                onChange={e => setMeals(e.target.value)}
                onBlur={e => load({ meals: e.target.value })} />
            </div>
          </div>
          <table className="text-sm w-full max-w-xl">
            <tbody>
              {preview.lines.map((l, i) => (
                <tr key={i} className="border-b border-slate-100">
                  <td className="py-1 pr-3 text-xs text-slate-500">{l.type === 'Debit' ? 'Débit' : 'Crédit'}</td>
                  <td className="py-1 pr-3 font-mono text-xs">{l.acctnum}</td>
                  <td className="py-1 pr-3 text-slate-600">{l.label}</td>
                  <td className="py-1 text-right tabular-nums font-medium">{fmtMoney(l.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.warnings?.map((w, i) => (
            <p key={i} className="text-xs text-amber-700 mt-1.5">⚠️ {w}</p>
          ))}
        </>
      )}
    </div>
  )
}

// Fiche paie rendue dans le side-peek de la liste : le drawer fournit déjà le
// titre et la fermeture, la fiche ne porte donc pas de bouton « Fermer ».
function PaieDetail({ paie, onEdit, onDeleted }) {
  const { addToast } = useToast()
  const { user } = useAuth()
  const isHR = ['admin', 'rh'].includes(user?.role)
  const paieItemsColumns = useMemo(() => buildPaieItemsColumns(isHR), [isHR])
  const [detail, setDetail] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState(null)
  useEffect(() => {
    api.paies.get(paie.id).then(setDetail).catch(() => {})
  }, [paie.id])

  async function handleDelete() {
    setDeleting(true)
    try {
      await api.paies.delete(paie.id)
      onDeleted()
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
      setDeleting(false)
    }
  }

  async function handleImport() {
    setImporting(true)
    setImportResult(null)
    try {
      const result = await api.paies.importTimesheets(paie.id)
      setImportResult(result)
      const fresh = await api.paies.get(paie.id)
      setDetail(fresh)
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    } finally {
      setImporting(false)
    }
  }

  if (!detail) return <p className="p-5 text-sm text-slate-400"><Spinner size="xs" label="Chargement…" /></p>

  const totalHeuresReg = detail.items.reduce((s, i) => s + (i.regular_hours || 0), 0)
  const totalMontantReg = detail.items.reduce((s, i) => s + ((i.regular_hours || 0) * (i.hourly_rate || 0)), 0)
  const totalCommissions = detail.items.reduce((s, i) => s + (i.commission || 0), 0)
  const totalRemb = detail.items.reduce((s, i) => s + (i.expense_reimb || 0), 0)

  // Panneau latéral : plus étroit qu'une modale, les blocs de chiffres tiennent
  // sur 2 colonnes.
  const statsGrid = 'grid grid-cols-2 gap-x-6 gap-y-3 text-sm'

  return (
    // pb généreux : les actions de pied de fiche arrivent dans le coin bas-droit
    // du panneau, là où flotte le bouton de feedback — on leur laisse la place.
    <div className="p-5 pb-24 space-y-4">
      <div className={statsGrid}>
        <div>
          <div className="text-xs text-slate-500">Période</div>
          <div className="font-medium">
            {detail.period_start ? `${fmtDate(detail.period_start)} → ` : ''}
            {fmtDate(detail.period_end)}
          </div>
        </div>
        <div>
          <div className="text-xs text-slate-500">Statut</div>
          <div className="font-medium">{detail.status || '—'}</div>
        </div>
        <div>
          <div className="text-xs text-slate-500">Total paie (Airtable)</div>
          <div className="font-medium">{fmtMoney(detail.total_with_charges_and_reimb)}</div>
        </div>
      </div>

      <div className={`${statsGrid} border-t border-slate-200 pt-3`}>
        <div>
          <div className="text-xs text-slate-500">Heures régulières</div>
          <div className="font-medium">{num(totalHeuresReg)}</div>
        </div>
        <div>
          <div className="text-xs text-slate-500">$ heures régulières</div>
          <div className="font-medium">{fmtMoney(totalMontantReg)}</div>
        </div>
        <div>
          <div className="text-xs text-slate-500">Commissions</div>
          <div className="font-medium">{fmtMoney(totalCommissions)}</div>
        </div>
        <div>
          <div className="text-xs text-slate-500">Remb. dépenses</div>
          <div className="font-medium">{fmtMoney(totalRemb)}</div>
        </div>
      </div>

      {isHR && (
        <div className="flex items-center gap-2 text-sm border-t border-slate-200 pt-3">
          <button
            onClick={handleImport}
            disabled={importing}
            className="btn-secondary flex items-center gap-1.5 text-sm"
            title="Recalcule les heures depuis les feuilles de temps. Les employés avec hours_per_week > 0 conservent leurs heures régulières (le diff va en banque d'heures). Les autres voient leurs heures régulières écrasées."
          >
            <RefreshCw size={13} className={importing ? 'animate-spin' : ''} />
            {importing ? 'Import en cours…' : 'Resynchroniser avec les feuilles de temps'}
          </button>
          {importResult && (
            <span className="text-xs text-slate-500">
              {importResult.results?.length || 0} employé(s) traité(s) — période {importResult.period_start} → {importResult.period_end}
            </span>
          )}
        </div>
      )}
      {importResult?.results?.some(r => r.skipped === 'no_user_link') && (
        <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2">
          Certains employés n'ont pas d'utilisateur lié (impossible d'importer leurs feuilles de temps).
          Lier dans Paramètres → Utilisateurs.
        </div>
      )}

      <DataTable
        table="paie_items"
        columns={paieItemsColumns}
        data={detail.items}
        searchFields={['first_name', 'last_name', 'accounting_department']}
      />

      {isHR && <PaieRepartitionSection paie={detail} />}

      <div className="flex justify-between items-center gap-2">
        <div>
          {isHR && (confirmDelete ? (
            <div className="flex items-center gap-2">
              <button onClick={handleDelete} disabled={deleting} className="text-sm text-red-600 hover:bg-red-50 px-2 py-1 rounded font-medium">
                {deleting ? 'Suppression…' : 'Confirmer la suppression'}
              </button>
              <button onClick={() => setConfirmDelete(false)} className="text-sm text-slate-500 px-2 py-1">Annuler</button>
            </div>
          ) : (
            <button onClick={() => setConfirmDelete(true)} className="text-sm text-slate-400 hover:text-red-600 flex items-center gap-1.5">
              <Trash2 size={13} /> Supprimer
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          {isHR && (
            <button onClick={() => onEdit(detail)} className="btn-secondary flex items-center gap-1.5">
              <Pencil size={13} /> Modifier
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

export default function Paies() {
  const { user } = useAuth()
  const isHR = ['admin', 'rh'].includes(user?.role)
  const [editing, setEditing] = useState(null)
  const [showForm, setShowForm] = useState(false)
  const { rows: paies, loading, reload: load } = useListData({ fetch: () => api.paies.list({ limit: 500 }), realtime: 'paie' })

  function openCreate() {
    setEditing(null)
    setShowForm(true)
  }

  function openEdit(paie) {
    setEditing(paie)
    setShowForm(true)
  }

  function handleSaved() {
    setShowForm(false)
    setEditing(null)
    load()
  }

  return (
    <ListPage
      title={isHR ? 'Paies' : 'Mes bulletins de paie'}
      actions={isHR && (
        <button onClick={openCreate} className="btn-primary flex items-center gap-2">
          <Plus size={15} /> Nouvelle paie
        </button>
      )}
    >
      <DataTable
        table="paies"
        manageViews
        columns={COLUMNS_PAIES}
        data={paies}
        loading={loading}
        peek={{
          title: row => `Paie — ${fmtDate(row.period_end)}${row.number ? ` (#${row.number})` : ''}`,
          subtitle: row => row.status || '',
          width: 860,
          render: (row, { close }) => (
            <PaieDetail
              paie={row}
              onEdit={paie => { close(); openEdit(paie) }}
              onDeleted={() => { close(); load() }}
            />
          ),
        }}
        searchFields={['status', 'number', 'total_with_charges_and_reimb', 'total_regular_amount']}
      />

      <Modal
        isOpen={showForm}
        title={editing ? `Paie — ${fmtDate(editing.period_end)}${editing.number ? ` (#${editing.number})` : ''}` : 'Nouvelle paie'}
        onClose={() => { setShowForm(false); setEditing(null) }}
        size="lg"
      >
        <PaieForm
          paie={editing}
          onClose={() => { setShowForm(false); setEditing(null) }}
          onSaved={handleSaved}
          onDeleted={handleSaved}
        />
      </Modal>
    </ListPage>
  )
}
