import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { Plus, Sparkles, BookUser } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { VendorTabs } from '../components/VendorTabs.jsx'
import { Badge } from '../components/Badge.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { Modal } from '../components/Modal.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'
import { useToast } from '../contexts/ToastContext.jsx'

// Profils fournisseurs : défauts comptables appris à chaque publication QB et
// éditables ici. C'est ce qui pré-remplit le formulaire de publication de
// l'extracteur de données (fournisseur QB dans la bonne devise, comptes, statut
// fiscal, code de taxe, termes de paiement).

const NO_TAX = '__none__'
const QB_TYPE_LABELS = { purchase: 'Dépense payée', bill: 'Facture à payer', cc_credit: 'Crédit carte de crédit' }

const inputCls = 'w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-400'
const labelCls = 'block text-xs font-medium text-slate-500 mb-1'

// Fiche d'un profil — autosave champ par champ (PATCH au blur / au changement),
// pas de bouton Enregistrer.
function EditModal({ profile, qb, onClose, onSaved, onDeleted }) {
  const [form, setForm] = useState(profile)
  const [saving, setSaving] = useState(false)
  const { addToast } = useToast()
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const save = async (k, v) => {
    if ((profile[k] ?? '') === (v ?? '')) return
    setSaving(true)
    try {
      const updated = await api.vendorProfiles.update(profile.id, { [k]: v })
      onSaved(updated)
    } catch (e) {
      addToast({ message: `Sauvegarde échouée : ${e.message}`, type: 'error' })
      setForm(f => ({ ...f, [k]: profile[k] }))
    } finally {
      setSaving(false)
    }
  }

  const pick = (k, label, options, { hint } = {}) => (
    <div>
      <label className={labelCls}>{label}</label>
      <SearchableSelect
        value={form[k] ?? ''}
        options={options}
        onChange={v => { set(k, v || null); save(k, v || null) }}
        placeholder="— Aucun —"
      />
      {hint && <p className="text-[11px] text-slate-400 mt-1">{hint}</p>}
    </div>
  )

  const taxOptions = [{ value: NO_TAX, label: '— Aucune taxe —' }, ...qb.taxCodes.map(c => ({ value: c.Id, label: c.Name }))]

  return (
    <Modal isOpen onClose={onClose} title={form.name} size="lg">
      {(() => {
        // N'afficher du répertoire Drive que ce qui n'est pas déjà couvert par les
        // champs structurés du profil, pour éviter la redondance : la devise est
        // implicite dès qu'un vendor QB est configuré dans cette devise, le mode de
        // paiement dès qu'un compte de paiement l'est, la catégorie dès qu'un compte
        // de dépense l'est.
        const dirCur = (form.directory_currency || '').toUpperCase()
        const currencyCovered = dirCur.includes('USD') ? !!form.qb_vendor_id_usd : (dirCur ? !!form.qb_vendor_id_cad : true)
        const paymentCovered = dirCur.includes('USD') ? !!form.default_payment_account_id_usd : !!form.default_payment_account_id_cad
        const showCurrency = form.directory_currency && !currencyCovered
        const showPayment = form.directory_payment_method && !paymentCovered
        const showCategory = form.directory_category && !form.default_expense_account_id
        const show = showCurrency || showPayment || showCategory || form.directory_particularites
        return show && (
          <div className="mb-4 rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-xs text-slate-600 space-y-0.5">
            <p className="font-medium text-slate-500 uppercase tracking-wide text-[10px]">Répertoire Fournisseurs_Particularités (Drive — lecture seule)</p>
            {(showCurrency || showPayment) && (
              <p>
                {showCurrency && <>Devise habituelle : <strong>{form.directory_currency}</strong></>}
                {showCurrency && showPayment && ' · '}
                {showPayment && <>Paiement : {form.directory_payment_method}</>}
              </p>
            )}
            {showCategory && <p>Catégorie comptable : <strong>{form.directory_category}</strong></p>}
            {form.directory_particularites && <p>Particularités : {form.directory_particularites}</p>}
          </div>
        )
      })()}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Nom canonique</label>
          <input className={inputCls} value={form.name ?? ''} onChange={e => set('name', e.target.value)}
            onBlur={e => { const v = e.target.value.trim(); if (v) save('name', v) }} />
        </div>
        <div>
          <label className={labelCls}>Alias (autres raisons sociales, un par ligne)</label>
          <textarea className={inputCls} rows={2}
            value={(form.aliases || []).join('\n')}
            onChange={e => set('aliases', e.target.value.split('\n'))}
            onBlur={e => save('aliases', e.target.value.split('\n').map(s => s.trim()).filter(Boolean))}
          />
        </div>
        {pick('qb_vendor_id_cad', 'Vendor QuickBooks — CAD', qb.vendorOptionsCad)}
        {pick('qb_vendor_id_usd', 'Vendor QuickBooks — USD', qb.vendorOptionsUsd,
          { hint: 'Un vendor QB ne porte qu\'une devise : un fournisseur bi-devise a deux vendors.' })}
        {pick('default_qb_type', 'Type d\'entité par défaut', Object.entries(QB_TYPE_LABELS).map(([value, label]) => ({ value, label })))}
        {pick('default_expense_account_id', 'Compte de dépense par défaut', qb.expenseOptions)}
        {pick('default_payment_account_id_cad', 'Compte de paiement — CAD', qb.paymentOptionsCad)}
        {pick('default_payment_account_id_usd', 'Compte de paiement — USD', qb.paymentOptionsUsd)}
        {pick('default_transaction_type', 'Type de transaction (statut fiscal)', qb.txTypeOptions)}
        <div>
          <label className={labelCls}>Termes de paiement (Net N jours)</label>
          <input className={inputCls} type="number" min="0" max="365" step="1"
            value={form.payment_terms_days ?? ''}
            onChange={e => set('payment_terms_days', e.target.value === '' ? null : Number(e.target.value))}
            onBlur={e => save('payment_terms_days', e.target.value === '' ? null : Number(e.target.value))}
            placeholder="ex. 21"
          />
        </div>
        {pick('default_tax_code_id_cad', 'Code de taxe — CAD', taxOptions)}
        {pick('default_tax_code_id_usd', 'Code de taxe — USD', taxOptions)}
        <div className="col-span-2">
          <label className={labelCls}>Notes</label>
          <textarea className={inputCls} rows={2} value={form.notes ?? ''}
            onChange={e => set('notes', e.target.value)}
            onBlur={e => save('notes', e.target.value.trim() === '' ? null : e.target.value)}
          />
        </div>
      </div>
      <div className="flex items-center justify-between mt-4">
        <button
          onClick={async () => {
            if (!confirm(`Supprimer le profil « ${profile.name} » ?`)) return
            try {
              await api.vendorProfiles.delete(profile.id)
              onDeleted(profile.id)
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

// Création — bouton requis : pas encore d'id, l'autosave est impraticable avant l'INSERT.
function CreateModal({ onClose, onCreated }) {
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const { addToast } = useToast()
  async function create() {
    if (!name.trim()) { addToast({ message: 'Nom du fournisseur requis', type: 'error' }); return }
    setSaving(true)
    try {
      const created = await api.vendorProfiles.create({ name: name.trim() })
      onCreated(created)
      onClose()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally { setSaving(false) }
  }
  return (
    <Modal isOpen onClose={onClose} title="Nouveau profil fournisseur" size="md">
      <label className={labelCls}>Nom canonique du fournisseur *</label>
      <input className={inputCls} value={name} onChange={e => setName(e.target.value)} autoFocus
        onKeyDown={e => { if (e.key === 'Enter') create() }} />
      <p className="text-xs text-slate-400 mt-2">Les défauts comptables s'ouvrent en édition après création — ou s'apprendront automatiquement à la première publication QB.</p>
      {/* Bouton requis : création d'un nouvel enregistrement (pas encore d'id → autosave impossible) */}
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-lg">Annuler</button>
        <button onClick={create} disabled={saving} className="px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50">
          {saving ? 'Création…' : 'Créer'}
        </button>
      </div>
    </Modal>
  )
}

// Doublons probables (noms normalisés en préfixe l'un de l'autre, ex. DigiKey /
// DigiKey Electronics) — choisir le profil survivant puis fusionner : les autres
// deviennent des alias, leurs défauts remplissent les champs vides du survivant.
function DuplicatesSection({ onMerged, onInspect }) {
  const [groups, setGroups] = useState(null)
  const [survivors, setSurvivors] = useState({}) // index de groupe → id du survivant
  const [excluded, setExcluded] = useState(new Set()) // ids de profils exclus de leur fusion
  const [merging, setMerging] = useState(null)
  const [dismissed, setDismissed] = useState(new Set())
  const { addToast } = useToast()

  const load = useCallback(async () => {
    try {
      const r = await api.vendorProfiles.duplicates()
      setGroups(r.data || [])
    } catch { setGroups([]) }
  }, [])
  useEffect(() => { load() }, [load])

  const visible = (groups || []).filter((g, i) => !dismissed.has(i))
  if (!groups || !visible.length) return null

  const merge = async (idx, group) => {
    // Survivant par défaut : le profil présent dans le répertoire Drive, sinon le premier.
    const targetId = survivors[idx] || group.find(p => p.in_directory)?.id || group[0].id
    const sourceIds = group.filter(p => p.id !== targetId && !excluded.has(p.id)).map(p => p.id)
    if (!sourceIds.length) { addToast({ message: 'Aucun profil à absorber — tout est exclu.', type: 'error' }); return }
    setMerging(idx)
    try {
      await api.vendorProfiles.merge(targetId, sourceIds)
      addToast({ message: `${sourceIds.length} profil(s) fusionné(s) dans « ${group.find(p => p.id === targetId)?.name} »`, type: 'success' })
      await load()
      onMerged()
    } catch (e) {
      addToast({ message: `Fusion échouée : ${e.message}`, type: 'error' })
    } finally { setMerging(null) }
  }

  return (
    <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50 p-4" data-testid="vendor-duplicates">
      <h2 className="text-sm font-semibold text-amber-800 mb-1">
        {visible.length} groupe(s) de doublons probables
      </h2>
      <p className="text-xs text-amber-700 mb-3">
        Ces profils semblent désigner le même fournisseur. Choisir le profil à conserver puis fusionner —
        les autres noms deviennent des alias et leurs défauts comptables complètent les champs vides (rien n'est écrasé).
      </p>
      <div className="space-y-2">
        {(groups || []).map((group, idx) => dismissed.has(idx) ? null : (
          <div key={group.map(p => p.id).join('-')} className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-md bg-white/70 border border-amber-100 px-3 py-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 flex-1 min-w-0">
              {group.map(p => {
                const isSurvivor = (survivors[idx] || group.find(x => x.in_directory)?.id || group[0].id) === p.id
                const isExcluded = !isSurvivor && excluded.has(p.id)
                return (
                  <span key={p.id} className={`flex items-center gap-1.5 text-sm text-amber-900 ${isExcluded ? 'opacity-40' : ''}`}>
                    <input
                      type="radio"
                      name={`dup-${idx}`}
                      title="Conserver ce profil"
                      checked={isSurvivor}
                      onChange={() => setSurvivors(s => ({ ...s, [idx]: p.id }))}
                    />
                    <button
                      onClick={() => onInspect(p)}
                      className={`font-medium hover:underline decoration-amber-400 underline-offset-2 text-left ${isExcluded ? 'line-through' : ''}`}
                      title="Voir les détails de ce profil"
                    >{p.name}</button>
                    {p.in_directory && <Badge color="blue">Répertoire</Badge>}
                    {!isSurvivor && (
                      <button
                        onClick={() => setExcluded(x => { const n = new Set(x); n.has(p.id) ? n.delete(p.id) : n.add(p.id); return n })}
                        className="text-[11px] text-amber-600 hover:text-amber-800 underline decoration-dotted"
                        title={isExcluded ? 'Réinclure dans la fusion' : 'Exclure de la fusion (fournisseur distinct)'}
                      >{isExcluded ? 'réinclure' : 'exclure'}</button>
                    )}
                  </span>
                )
              })}
            </div>
            <div className="flex items-center gap-2 ml-auto">
              <button
                onClick={() => setDismissed(d => new Set([...d, idx]))}
                className="px-2 py-1 text-xs text-amber-700 hover:bg-amber-100 rounded"
                title="Pas un doublon — ignorer pour cette session"
              >Ignorer</button>
              <button
                onClick={() => merge(idx, group)}
                disabled={merging != null}
                className="px-2.5 py-1 text-xs font-medium text-white bg-amber-600 hover:bg-amber-700 rounded disabled:opacity-50"
              >{merging === idx ? 'Fusion…' : 'Fusionner'}</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function VendorProfiles() {
  const [profiles, setProfiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)
  const [creating, setCreating] = useState(false)
  const [seeding, setSeeding] = useState(false)
  const [accounts, setAccounts] = useState([])
  const [vendors, setVendors] = useState([])
  const [taxCodes, setTaxCodes] = useState([])
  const [txTypes, setTxTypes] = useState([])
  const { addToast } = useToast()
  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  const load = useCallback(async () => {
    try {
      const r = await api.vendorProfiles.list()
      if (mounted.current) setProfiles(r.data || [])
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    // Référentiels QB — best effort : QB déconnecté n'empêche pas d'afficher la liste
    // (les colonnes retombent alors sur les Ids bruts).
    api.quickbooks.accounts().then(a => mounted.current && setAccounts(a)).catch(() => {})
    api.quickbooks.vendors().then(v => mounted.current && setVendors(v)).catch(() => {})
    api.quickbooks.taxCodes().then(c => mounted.current && setTaxCodes(c)).catch(() => {})
    api.saleReceipts.transactionTypes().then(t => mounted.current && setTxTypes(t.data || [])).catch(() => {})
  }, [load])

  const qb = useMemo(() => {
    const accountLabel = a => (a.AcctNum ? `${a.AcctNum} — ${a.Name}` : a.Name)
    const cur = a => (a.CurrencyRef?.value || 'CAD').toUpperCase()
    const expense = accounts.filter(a => ['Expense', 'Other Expense', 'Cost of Goods Sold', 'Other Current Asset'].includes(a.AccountType))
    const payment = accounts.filter(a => ['Bank', 'Credit Card'].includes(a.AccountType))
    const vendorOpt = v => ({ value: v.Id, label: v.DisplayName })
    return {
      taxCodes,
      accountById: new Map(accounts.map(a => [a.Id, a])),
      vendorById: new Map(vendors.map(v => [v.Id, v])),
      taxNameById: new Map(taxCodes.map(c => [c.Id, c.Name])),
      txTypeByKey: new Map(txTypes.map(t => [t.key, t])),
      accountLabel,
      expenseOptions: expense.map(a => ({ value: a.Id, label: accountLabel(a) })),
      paymentOptionsCad: payment.filter(a => cur(a) === 'CAD').map(a => ({ value: a.Id, label: `${accountLabel(a)} (${a.AccountType})` })),
      paymentOptionsUsd: payment.filter(a => cur(a) === 'USD').map(a => ({ value: a.Id, label: `${accountLabel(a)} (${a.AccountType})` })),
      vendorOptionsCad: vendors.filter(v => cur(v) === 'CAD').map(vendorOpt),
      vendorOptionsUsd: vendors.filter(v => cur(v) === 'USD').map(vendorOpt),
      txTypeOptions: txTypes.map(t => ({ value: t.key, label: t.side === 'vente' ? `Vente · ${t.label}` : t.label })),
    }
  }, [accounts, vendors, taxCodes, txTypes])

  const renders = useMemo(() => {
    const accName = id => (id ? (qb.accountById.get(id) ? qb.accountLabel(qb.accountById.get(id)) : id) : null)
    const vendName = id => (id ? (qb.vendorById.get(id)?.DisplayName || id) : null)
    const taxName = id => (id === NO_TAX ? 'Aucune taxe' : (id ? (qb.taxNameById.get(id) || id) : null))
    const duo = (cad, usd) => {
      if (!cad && !usd) return <span className="text-slate-300">—</span>
      return (
        <span className="text-slate-600 text-xs">
          {cad && <span><span className="text-slate-400">CAD</span> {cad}</span>}
          {cad && usd && <span className="text-slate-300"> · </span>}
          {usd && <span><span className="text-slate-400">USD</span> {usd}</span>}
        </span>
      )
    }
    return {
      name: row => (
        <span className="font-medium text-slate-800">
          {row.name}
          {row.in_directory && <span className="ml-1.5 align-middle" title="Présent dans Fournisseurs_Particularités"><Badge color="blue">Répertoire</Badge></span>}
        </span>
      ),
      qb_vendors: row => duo(vendName(row.qb_vendor_id_cad), vendName(row.qb_vendor_id_usd)),
      default_qb_type: row => <span className="text-slate-600">{QB_TYPE_LABELS[row.default_qb_type] || '—'}</span>,
      expense_account: row => <span className="text-slate-600 text-xs">{accName(row.default_expense_account_id) || '—'}</span>,
      payment_accounts: row => duo(accName(row.default_payment_account_id_cad), accName(row.default_payment_account_id_usd)),
      transaction_type: row => <span className="text-slate-600 text-xs">{row.default_transaction_type ? (qb.txTypeByKey.get(row.default_transaction_type)?.label || row.default_transaction_type) : '—'}</span>,
      tax_codes: row => duo(taxName(row.default_tax_code_id_cad), taxName(row.default_tax_code_id_usd)),
      payment_terms_days: row => <span className="tabular-nums text-slate-600">{row.payment_terms_days != null ? `Net ${row.payment_terms_days}` : '—'}</span>,
      directory_currency: row => <span className="text-slate-600">{row.directory_currency || '—'}</span>,
      directory_category: row => <span className="text-slate-600">{row.directory_category || '—'}</span>,
      directory_particularites: row => <span className="text-slate-500 text-xs">{row.directory_particularites || '—'}</span>,
      active_subscriptions: row => <span className="tabular-nums text-slate-600">{row.active_subscriptions || 0}</span>,
      last_receipt_date: row => <span className="text-slate-600">{row.last_receipt_date ? fmtDate(row.last_receipt_date) : '—'}</span>,
      notes: row => <span className="text-slate-500 text-xs">{row.notes || '—'}</span>,
    }
  }, [qb])

  const columns = useMemo(
    () => TABLE_COLUMN_META.vendor_profiles.map(meta => ({ ...meta, render: renders[meta.id] })),
    [renders],
  )

  async function seed() {
    setSeeding(true)
    try {
      const r = await api.vendorProfiles.seed()
      addToast({ message: `Amorçage terminé : ${r.created} profil(s) créé(s), ${r.filled} enrichi(s) depuis l'historique (${r.total} au total).`, type: 'success' })
      await load()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally { setSeeding(false) }
  }

  return (
    <Layout>
      <div className="p-6">
        <VendorTabs active="profils" />
        <div className="flex items-center justify-between mb-6">
          <div>
            <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2"><BookUser size={22} className="text-brand-600" /> Fournisseurs</h1>
            <p className="text-xs text-slate-500 mt-0.5">
              Défauts comptables par fournisseur — appris à chaque publication QuickBooks et utilisés pour pré-remplir l'extraction de données (vendor par devise, comptes, statut fiscal, code de taxe, échéance).
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={seed}
              disabled={seeding}
              title="Créer/enrichir les profils depuis le répertoire Drive et l'historique des transactions publiées (n'écrase rien)"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-brand-700 bg-brand-50 hover:bg-brand-100 border border-brand-200 rounded-lg disabled:opacity-50"
            >
              <Sparkles size={14} /> {seeding ? 'Amorçage…' : 'Amorcer depuis l\'historique'}
            </button>
            <button
              onClick={() => setCreating(true)}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg"
            >
              <Plus size={14} /> Nouveau profil
            </button>
          </div>
        </div>

        <DuplicatesSection onMerged={load} onInspect={setEditing} />

        <DataTable
          table="vendor_profiles"
          manageViews
          columns={columns}
          data={profiles}
          loading={loading}
          searchFields={['name', 'notes', 'directory_category', 'directory_particularites']}
          onRowClick={row => setEditing(row)}
        />

        {editing && (
          <EditModal
            profile={editing}
            qb={qb}
            onClose={() => setEditing(null)}
            onSaved={updated => {
              setProfiles(list => list.map(p => (p.id === updated.id ? updated : p)))
              setEditing(e => (e && e.id === updated.id ? { ...e, ...updated } : e))
            }}
            onDeleted={id => setProfiles(list => list.filter(p => p.id !== id))}
          />
        )}
        {creating && (
          <CreateModal
            onClose={() => setCreating(false)}
            onCreated={created => { setProfiles(list => [created, ...list].sort((a, b) => a.name.localeCompare(b.name))); setEditing(created) }}
          />
        )}
      </div>
    </Layout>
  )
}
