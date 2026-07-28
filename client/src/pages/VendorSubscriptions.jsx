import { useState, useEffect, useCallback, useRef } from 'react'
import { Plus, AlertTriangle } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { VendorTabs } from '../components/VendorTabs.jsx'
import { Badge } from '../components/Badge.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { Modal } from '../components/Modal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'
import { useToast } from '../contexts/ToastContext.jsx'

function fmtMoney(n, currency = 'CAD') {
  if (n == null) return null
  const cur = currency === 'Euro' ? 'EUR' : (currency || 'CAD')
  try {
    return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: cur }).format(n)
  } catch {
    return `${Number(n).toFixed(2)} ${currency}`
  }
}

function amountDisplay(row) {
  return row.amount_label || fmtMoney(row.amount, row.currency) || '—'
}

const RENDERS = {
  vendor:         row => <span className="font-medium text-slate-800">{row.vendor}</span>,
  plan:           row => <span className="text-slate-600">{row.plan || '—'}</span>,
  currency:       row => <span className="font-mono text-xs text-slate-600">{row.currency || 'CAD'}</span>,
  variable:       row => <span className="text-slate-600">{row.variable ? 'Variable' : 'Fixe'}</span>,
  amount:         row => <span className="tabular-nums text-slate-800">{amountDisplay(row)}</span>,
  taxes:          row => <span className="text-slate-600">{row.taxes || '—'}</span>,
  frequency:      row => <Badge color={row.frequency === 'Annuel' ? 'blue' : 'gray'}>{row.frequency}</Badge>,
  billing_label:  row => <span className="text-slate-600">{row.billing_label || '—'}</span>,
  period:         row => <span className="text-slate-600">{row.period || '—'}</span>,
  payment_method: row => <span className="text-slate-600">{row.payment_method || '—'}</span>,
  active:         row => row.active
    ? <Badge color="green">Actif</Badge>
    : <Badge color="red">Annulé</Badge>,
  comments:       row => <span className="text-slate-500 text-sm">{row.comments || '—'}</span>,
}

const COLUMNS = TABLE_COLUMN_META.vendor_subscriptions.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

const CURRENCIES = ['CAD', 'USD', 'Euro']
const TAXES = ['', 'TPS/TVQ', 'TPS', 'TVQ', 'Hors-champ']
const FREQUENCIES = ['Mensuel', 'Annuel']
const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']

const inputCls = 'w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-400'
const labelCls = 'block text-xs font-medium text-slate-500 mb-1'

// Fiche d'un abonnement existant — autosave champ par champ (PATCH au blur /
// au changement pour les selects), pas de bouton Enregistrer.
function EditModal({ sub, onClose, onSaved, onDeleted }) {
  const [form, setForm] = useState(sub)
  const [saving, setSaving] = useState(false)
  const { addToast } = useToast()
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const save = async (k, v) => {
    if ((sub[k] ?? '') === (v ?? '')) return
    setSaving(true)
    try {
      const updated = await api.vendorSubscriptions.update(sub.id, { [k]: v === '' ? null : v })
      onSaved(updated)
    } catch (e) {
      addToast({ message: `Sauvegarde échouée : ${e.message}`, type: 'error' })
      setForm(f => ({ ...f, [k]: sub[k] }))
    } finally {
      setSaving(false)
    }
  }

  const text = (k, label, props = {}) => (
    <div>
      <label className={labelCls}>{label}</label>
      <input
        className={inputCls}
        value={form[k] ?? ''}
        onChange={e => set(k, e.target.value)}
        onBlur={e => save(k, e.target.value.trim() === '' ? null : e.target.value)}
        {...props}
      />
    </div>
  )
  const select = (k, label, options, { asNumber = false, render = o => (o === '' ? '—' : o) } = {}) => (
    <div>
      <label className={labelCls}>{label}</label>
      <select
        className={inputCls}
        value={form[k] ?? ''}
        onChange={e => {
          const v = e.target.value === '' ? null : (asNumber ? Number(e.target.value) : e.target.value)
          set(k, v)
          save(k, v)
        }}
      >
        {options.map(o => <option key={String(o.value ?? o)} value={o.value ?? o}>{o.label ?? render(o)}</option>)}
      </select>
    </div>
  )

  return (
    <Modal isOpen onClose={onClose} title={form.vendor} size="lg">
      <div className="grid grid-cols-2 gap-3">
        {text('vendor', 'Fournisseur')}
        {text('plan', 'Plan / Forfait', { 'data-testid': 'sub-plan' })}
        {select('currency', 'Devise', CURRENCIES)}
        {select('variable', 'Fixe / Variable', [{ value: 0, label: 'Fixe' }, { value: 1, label: 'Variable' }], { asNumber: true })}
        {text('amount', 'Montant avant taxes', { type: 'number', step: '0.01', min: '0' })}
        {text('amount_label', 'Montant affiché (si variable, ex. « 125 à 150 »)')}
        {select('taxes', 'Taxes', TAXES)}
        {select('frequency', 'Fréquence', FREQUENCIES)}
        {select('billing_day', 'Jour de facturation', ['', ...Array.from({ length: 31 }, (_, i) => i + 1)], { asNumber: true })}
        {select('billing_month', 'Mois (si annuel)', ['', ...MONTHS.map((m, i) => ({ value: i + 1, label: m }))], { asNumber: true })}
        {text('billing_label', 'Date affichée dans le sheet (ex. « 12 du mois », « 20 août »)')}
        {text('period', 'Période (« Mois à venir »… )')}
        {text('payment_method', 'Mode de paiement')}
        {select('active', 'Statut', [{ value: 1, label: 'Actif' }, { value: 0, label: 'Annulé' }], { asNumber: true })}
        <div className="col-span-2">
          <label className={labelCls}>Commentaires</label>
          <textarea
            className={inputCls}
            rows={2}
            value={form.comments ?? ''}
            onChange={e => set('comments', e.target.value)}
            onBlur={e => save('comments', e.target.value.trim() === '' ? null : e.target.value)}
          />
        </div>
      </div>
      <div className="flex items-center justify-between mt-4">
        <button
          onClick={async () => {
            if (!confirm(`Supprimer l'abonnement « ${sub.vendor} » ?`)) return
            try {
              await api.vendorSubscriptions.delete(sub.id)
              onDeleted(sub.id)
              onClose()
            } catch (e) { addToast({ message: e.message, type: 'error' }) }
          }}
          className="text-sm text-red-600 hover:underline"
        >
          Supprimer
        </button>
        <span className="text-xs text-slate-400">{saving ? 'Sauvegarde…' : 'Modifications sauvegardées automatiquement'}</span>
      </div>
    </Modal>
  )
}

// Création d'un nouvel abonnement — bouton Créer requis : pas encore d'id,
// l'autosave est impraticable avant l'INSERT.
function CreateModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ currency: 'CAD', frequency: 'Mensuel', variable: 0, active: 1 })
  const [saving, setSaving] = useState(false)
  const { addToast } = useToast()
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function create() {
    if (!form.vendor?.trim()) { addToast({ message: 'Nom du fournisseur requis', type: 'error' }); return }
    setSaving(true)
    try {
      const created = await api.vendorSubscriptions.create(form)
      onCreated(created)
      onClose()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal isOpen onClose={onClose} title="Nouvel abonnement fournisseur" size="lg">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Fournisseur *</label>
          <input className={inputCls} data-testid="new-sub-vendor" value={form.vendor ?? ''} onChange={e => set('vendor', e.target.value)} autoFocus />
        </div>
        <div>
          <label className={labelCls}>Plan / Forfait</label>
          <input className={inputCls} value={form.plan ?? ''} onChange={e => set('plan', e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>Devise</label>
          <select className={inputCls} value={form.currency} onChange={e => set('currency', e.target.value)}>
            {CURRENCIES.map(c => <option key={c}>{c}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Montant avant taxes</label>
          <input className={inputCls} type="number" step="0.01" min="0" value={form.amount ?? ''} onChange={e => set('amount', e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>Taxes</label>
          <select className={inputCls} value={form.taxes ?? ''} onChange={e => set('taxes', e.target.value || null)}>
            {TAXES.map(t => <option key={t} value={t}>{t === '' ? '—' : t}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Fréquence</label>
          <select className={inputCls} value={form.frequency} onChange={e => set('frequency', e.target.value)}>
            {FREQUENCIES.map(f => <option key={f}>{f}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Jour de facturation</label>
          <select className={inputCls} value={form.billing_day ?? ''} onChange={e => set('billing_day', e.target.value === '' ? null : Number(e.target.value))}>
            <option value="">—</option>
            {Array.from({ length: 31 }, (_, i) => i + 1).map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Mois (si annuel)</label>
          <select className={inputCls} value={form.billing_month ?? ''} onChange={e => set('billing_month', e.target.value === '' ? null : Number(e.target.value))}>
            <option value="">—</option>
            {MONTHS.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Mode de paiement</label>
          <input className={inputCls} value={form.payment_method ?? ''} onChange={e => set('payment_method', e.target.value)} placeholder="Mastercard, Visa USD, Venn – USD…" />
        </div>
        <div>
          <label className={labelCls}>Date affichée (sheet)</label>
          <input className={inputCls} value={form.billing_label ?? ''} onChange={e => set('billing_label', e.target.value)} placeholder="« 12 du mois », « 20 août »…" />
        </div>
      </div>
      {/* Bouton requis : création d'un nouvel enregistrement (pas encore d'id → autosave impossible) */}
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-lg">Annuler</button>
        <button
          onClick={create}
          disabled={saving}
          data-testid="new-sub-create"
          className="px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50"
        >
          {saving ? 'Création…' : 'Créer'}
        </button>
      </div>
    </Modal>
  )
}

export function MissingReceiptsSection() {
  const [data, setData] = useState(null)
  useEffect(() => {
    api.vendorSubscriptions.missingReceipts().then(setData).catch(() => setData({ missing: [] }))
  }, [])
  const missing = data?.missing || []
  if (!data || !missing.length) return null
  return (
    <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-4" data-testid="missing-receipts">
      <div className="flex items-center gap-2 mb-2">
        <AlertTriangle size={16} className="text-amber-600" />
        <h2 className="text-sm font-semibold text-amber-800">
          {missing.length} charge(s) attendue(s) sans reçu ingéré
        </h2>
      </div>
      <p className="text-xs text-amber-700 mb-3">
        Aucun reçu de ces fournisseurs n'a été reçu (factures@orisha.io ou upload) autour de la date de charge attendue.
        Réclamer le reçu, puis le transférer à factures@orisha.io.
      </p>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-amber-700/70">
              <th className="py-1 pr-4 font-medium">Fournisseur</th>
              <th className="py-1 pr-4 font-medium">Charge attendue le</th>
              <th className="py-1 pr-4 font-medium text-right">Montant</th>
              <th className="py-1 pr-4 font-medium">Paiement</th>
              <th className="py-1 pr-4 font-medium">Dernier reçu</th>
            </tr>
          </thead>
          <tbody>
            {missing.map((m, i) => (
              <tr key={`${m.subscription_id}-${m.expected_date}-${i}`} className="border-t border-amber-100 text-amber-900">
                <td className="py-1.5 pr-4 font-medium">{m.vendor}</td>
                <td className="py-1.5 pr-4">{fmtDate(m.expected_date)}</td>
                <td className="py-1.5 pr-4 text-right tabular-nums">{m.amount_label || fmtMoney(m.amount, m.currency) || '—'}</td>
                <td className="py-1.5 pr-4">{m.payment_method || '—'}</td>
                <td className="py-1.5 pr-4">{m.last_receipt_date ? fmtDate(m.last_receipt_date) : 'jamais'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function VendorSubscriptions() {
  const [subs, setSubs] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)
  const [creating, setCreating] = useState(false)
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const load = useCallback(async () => {
    try {
      const rows = await api.vendorSubscriptions.list()
      if (mounted.current) setSubs(rows)
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  return (
    <Layout>
      <div className="p-6">
        <VendorTabs active="abonnements" />
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Abonnements fournisseurs</h1>
            <p className="text-xs text-slate-500 mt-0.5">
              Registre de référence des charges récurrentes (SaaS, télécom…) et calendrier des reçus attendus.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg"
            >
              <Plus size={14} /> Nouvel abonnement
            </button>
          </div>
        </div>

        <MissingReceiptsSection />

        <DataTable
          table="vendor_subscriptions"
          manageViews
          columns={COLUMNS}
          data={subs}
          loading={loading}
          searchFields={['vendor', 'plan', 'payment_method', 'comments']}
          onRowClick={row => setEditing(row)}
        />

        {editing && (
          <EditModal
            sub={editing}
            onClose={() => setEditing(null)}
            onSaved={updated => {
              setSubs(list => list.map(s => (s.id === updated.id ? updated : s)))
              setEditing(e => (e && e.id === updated.id ? { ...e, ...updated } : e))
            }}
            onDeleted={id => setSubs(list => list.filter(s => s.id !== id))}
          />
        )}
        {creating && (
          <CreateModal
            onClose={() => setCreating(false)}
            onCreated={created => setSubs(list => [created, ...list])}
          />
        )}
      </div>
    </Layout>
  )
}
