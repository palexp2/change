import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Plus, Sparkles } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import { VendorTabs } from '../components/VendorTabs.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { Modal } from '../components/Modal.jsx'
import RecordPeekDrawer from '../components/RecordPeekDrawer.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'
import { useToast } from '../contexts/ToastContext.jsx'
import { useAutosave } from '../lib/useAutosave.js'

// Fiche fournisseur — source de vérité unique de l'ERP (le Google Doc
// « Fournisseurs_Particularités » n'est plus synchronisé, tout s'édite ici) :
//  - défauts comptables appris à chaque publication QB, qui pré-remplissent le
//    formulaire de publication de l'extracteur (vendor QB dans la bonne devise,
//    comptes, statut fiscal, code de taxe, termes de paiement) ;
//  - particularités du fournisseur (devise habituelle, mode de paiement, catégorie
//    comptable, description, particularités de facturation/taxes).

const NO_TAX = '__none__'
const QB_TYPE_LABELS = { purchase: 'Dépense payée', bill: 'Facture à payer', cc_credit: 'Crédit carte de crédit' }

const inputCls = 'w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-400'
const labelCls = 'block text-xs font-medium text-slate-500 mb-1'

// Fiche d'un profil — autosave champ par champ (PATCH au blur / au changement),
// pas de bouton Enregistrer.
function EditModal({ profile, qb, onClose, onSaved, onDeleted }) {
  const [form, setForm] = useState(profile)
  const { addToast } = useToast()
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const { save, saving } = useAutosave(profile, patch => api.vendorProfiles.update(profile.id, patch), {
    onSaved,
    onError: (k, prev) => setForm(f => ({ ...f, [k]: prev })),
  })

  const pick = (k, label, options, { hint } = {}) => (
    <div>
      <label className={labelCls}>{label}</label>
      <SearchableSelect
        value={form[k] ?? ''}
        options={options}
        onChange={v => { set(k, v || null); save(k, v || null) }}
      />
      {hint && <p className="text-[11px] text-slate-400 mt-1">{hint}</p>}
    </div>
  )

  const text = (k, label) => (
    <div>
      <label className={labelCls}>{label}</label>
      <input className={inputCls} value={form[k] ?? ''}
        onChange={e => set(k, e.target.value)}
        onBlur={e => save(k, e.target.value.trim() === '' ? null : e.target.value.trim())} />
    </div>
  )

  const taxOptions = [{ value: NO_TAX, label: '— Aucune taxe —' }, ...qb.taxCodes.map(c => ({ value: c.Id, label: c.Name }))]

  return (
    <RecordPeekDrawer open onClose={onClose} title={form.name} width={720} peekKey="vendor_profiles">
      <div className="px-5 py-4">
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
        <div>
          <label className={labelCls}>Motifs du relevé bancaire (un par ligne)</label>
          <textarea className={inputCls} rows={2}
            value={(form.bank_label_patterns || []).join('\n')}
            onChange={e => set('bank_label_patterns', e.target.value.split('\n'))}
            onBlur={e => save('bank_label_patterns', e.target.value.split('\n').map(s => s.trim()).filter(Boolean))}
          />
          <p className="text-[11px] text-slate-400 mt-1">
            Comment ce fournisseur apparaît sur un relevé (« AMZN », « SQ *LE CAFE »).
            Sert à reconnaître ses transactions bancaires et à aller chercher la facture
            sur son portail. À ne pas confondre avec les alias, qui servent à lire les documents.
          </p>
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
          />
        </div>
        {pick('default_tax_code_id_cad', 'Code de taxe — CAD', taxOptions)}
        {pick('default_tax_code_id_usd', 'Code de taxe — USD', taxOptions)}

        {/* Particularités du fournisseur — rapatriées du Google Doc
            « Fournisseurs_Particularités », l'ERP en est la seule source de vérité.
            Ces champs alimentent le prompt d'extraction (devise habituelle, catégorie). */}
        <div className="col-span-2 pt-1">
          <p className="text-[10px] font-medium text-slate-400 uppercase tracking-wide border-t border-slate-100 pt-3">Particularités du fournisseur</p>
        </div>
        {text('usual_currency', 'Devise habituelle')}
        {text('payment_method', 'Mode de paiement')}
        {/* Re-proposé automatiquement dans /paiements-emis dès qu'on saisit ce
            fournisseur, et ré-appris à chaque commentaire de paiement saisi. */}
        {text('payment_note', 'Commentaire de paiement habituel')}
        {text('qb_category', 'Catégorie comptable')}
        {text('description', 'Description')}
        <div className="col-span-2">
          <label className={labelCls}>Particularités (facturation, taxes, accès…)</label>
          <textarea className={inputCls} rows={3} value={form.particularites ?? ''}
            onChange={e => set('particularites', e.target.value)}
            onBlur={e => save('particularites', e.target.value.trim() === '' ? null : e.target.value)}
          />
        </div>

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
      </div>
    </RecordPeekDrawer>
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

// Survivant proposé par défaut dans un groupe de doublons : le profil le plus
// renseigné (défauts comptables + particularités), à défaut le premier (ordre alpha).
const SURVIVOR_WEIGHTED = [
  'qb_vendor_id_cad', 'qb_vendor_id_usd', 'default_qb_type', 'default_expense_account_id',
  'default_payment_account_id_cad', 'default_payment_account_id_usd', 'default_transaction_type',
  'default_tax_code_id_cad', 'default_tax_code_id_usd', 'payment_terms_days',
  'usual_currency', 'payment_method', 'qb_category', 'description', 'particularites',
]
function defaultSurvivor(group) {
  const score = p => SURVIVOR_WEIGHTED.filter(k => p[k] != null && p[k] !== '').length
  return group.reduce((best, p) => (score(p) > score(best) ? p : best), group[0])
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
  const [dismissing, setDismissing] = useState(null)
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
    const targetId = survivors[idx] || defaultSurvivor(group).id
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

  // « Pas un doublon » — persistant côté serveur : le groupe ne sera re-proposé que
  // si sa composition change (ex. un nouveau profil homonyme est créé plus tard).
  const dismiss = async (idx, group) => {
    setDismissing(idx)
    try {
      await api.vendorProfiles.dismissDuplicates(group.map(p => p.id))
      setDismissed(d => new Set([...d, idx]))
    } catch (e) {
      addToast({ message: `Échec : ${e.message}`, type: 'error' })
    } finally { setDismissing(null) }
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
                const isSurvivor = (survivors[idx] || defaultSurvivor(group).id) === p.id
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
                onClick={() => dismiss(idx, group)}
                disabled={dismissing != null}
                className="px-2 py-1 text-xs text-amber-700 hover:bg-amber-100 rounded disabled:opacity-50"
                title="Pas un doublon — ne plus proposer ce groupe"
              >{dismissing === idx ? 'Ignorer…' : 'Ignorer'}</button>
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

// Fournisseurs sans activité récente : aucun abonnement actif ET aucun reçu depuis
// 12 mois (ou aucun reçu du tout — l'historique de reçus de l'ERP est jeune, d'où le
// libellé distinct). Archivage en lot ; sans risque : un profil archivé se recrée
// automatiquement, défauts réappris, à la prochaine publication QB de ce fournisseur.
const INACTIVE_MONTHS = 12
function InactiveSection({ profiles, onArchived }) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState(new Set())
  const [archiving, setArchiving] = useState(false)
  const { addToast } = useToast()

  const cutoff = useMemo(() => {
    const d = new Date()
    d.setMonth(d.getMonth() - INACTIVE_MONTHS)
    return d.toISOString().slice(0, 10)
  }, [])
  const inactive = useMemo(
    () => profiles.filter(p => !p.active_subscriptions && (!p.last_receipt_date || p.last_receipt_date < cutoff)),
    [profiles, cutoff],
  )
  if (!inactive.length) return null

  const toggle = id => setSelected(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const allSelected = inactive.every(p => selected.has(p.id))

  const archive = async () => {
    const ids = inactive.filter(p => selected.has(p.id)).map(p => p.id)
    if (!ids.length) return
    setArchiving(true)
    let done = 0
    try {
      for (const id of ids) { await api.vendorProfiles.delete(id); done++ }
      addToast({ message: `${done} profil(s) archivé(s)`, type: 'success' })
    } catch (e) {
      addToast({ message: `Archivage interrompu après ${done} profil(s) : ${e.message}`, type: 'error' })
    } finally {
      setArchiving(false)
      setSelected(new Set())
      onArchived()
    }
  }

  return (
    <div className="mb-5 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3" data-testid="vendor-inactive">
      <div className="flex items-center justify-between gap-3">
        <button onClick={() => setOpen(o => !o)} className="text-sm font-medium text-slate-700 hover:text-slate-900 text-left">
          <span className="inline-block w-4 text-slate-400">{open ? '▾' : '▸'}</span>
          {inactive.length} fournisseur(s) sans activité récente
          <span className="font-normal text-slate-500"> — aucun abonnement actif ni reçu depuis {INACTIVE_MONTHS} mois</span>
        </button>
        {open && (
          <button
            onClick={archive}
            disabled={archiving || !selected.size}
            className="px-2.5 py-1 text-xs font-medium text-white bg-slate-600 hover:bg-slate-700 rounded disabled:opacity-40"
            data-testid="vendor-inactive-archive"
          >{archiving ? 'Archivage…' : `Archiver la sélection${selected.size ? ` (${selected.size})` : ''}`}</button>
        )}
      </div>
      {open && (
        <div className="mt-3">
          <label className="flex items-center gap-2 text-xs text-slate-500 mb-2 cursor-pointer">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={() => setSelected(allSelected ? new Set() : new Set(inactive.map(p => p.id)))}
            />
            Tout sélectionner
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-1 max-h-72 overflow-y-auto pr-1">
            {inactive.map(p => (
              <label key={p.id} className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer min-w-0" data-testid={`vendor-inactive-row-${p.id}`}>
                <input type="checkbox" checked={selected.has(p.id)} onChange={() => toggle(p.id)} />
                <span className="truncate">{p.name}</span>
                <span className="text-xs text-slate-400 whitespace-nowrap ml-auto">
                  {p.last_receipt_date ? `dernier reçu ${fmtDate(p.last_receipt_date)}` : 'aucun reçu dans l\'ERP'}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
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
  const [searchParams, setSearchParams] = useSearchParams()

  const load = useCallback(async () => {
    try {
      const r = await api.vendorProfiles.list()
      if (mounted.current) setProfiles(r.data || [])
    } finally {
      if (mounted.current) setLoading(false)
    }
  }, [])

  // Ouverture directe d'une fiche depuis la recherche globale (?open=<id>) —
  // consommé une fois puis retiré de l'URL pour ne pas rouvrir au retour arrière.
  useEffect(() => {
    const openId = searchParams.get('open')
    if (!openId || !profiles.length) return
    const found = profiles.find(p => p.id === openId)
    if (found) setEditing(found)
    setSearchParams(params => { params.delete('open'); return params }, { replace: true })
  }, [searchParams, profiles, setSearchParams])

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
      name: row => <span className="font-medium text-slate-800">{row.name}</span>,
      qb_vendors: row => duo(vendName(row.qb_vendor_id_cad), vendName(row.qb_vendor_id_usd)),
      default_qb_type: row => <span className="text-slate-600">{QB_TYPE_LABELS[row.default_qb_type] || '—'}</span>,
      expense_account: row => <span className="text-slate-600 text-xs">{accName(row.default_expense_account_id) || '—'}</span>,
      payment_accounts: row => duo(accName(row.default_payment_account_id_cad), accName(row.default_payment_account_id_usd)),
      transaction_type: row => <span className="text-slate-600 text-xs">{row.default_transaction_type ? (qb.txTypeByKey.get(row.default_transaction_type)?.label || row.default_transaction_type) : '—'}</span>,
      tax_codes: row => duo(taxName(row.default_tax_code_id_cad), taxName(row.default_tax_code_id_usd)),
      payment_terms_days: row => <span className="tabular-nums text-slate-600">{row.payment_terms_days != null ? `Net ${row.payment_terms_days}` : '—'}</span>,
      usual_currency: row => <span className="text-slate-600">{row.usual_currency || '—'}</span>,
      qb_category: row => <span className="text-slate-600">{row.qb_category || '—'}</span>,
      particularites: row => <span className="text-slate-500 text-xs">{row.particularites || '—'}</span>,
      active_subscriptions: row => <span className="tabular-nums text-slate-600">{row.active_subscriptions || 0}</span>,
      receipt_count: row => <span className="tabular-nums text-slate-600">{row.receipt_count || 0}</span>,
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
            <PageTitle>Fournisseurs</PageTitle>
            <p className="text-xs text-slate-500 mt-0.5">
              Fiche unique par fournisseur : défauts comptables appris à chaque publication QuickBooks (vendor par devise, comptes, statut fiscal, code de taxe, échéance) et particularités (devise habituelle, mode de paiement, catégorie, facturation/taxes). Le tout pré-remplit l'extraction de données.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={seed}
              disabled={seeding}
              title="Créer/enrichir les profils depuis l'historique des transactions publiées (n'écrase rien)"
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
        <InactiveSection profiles={profiles} onArchived={load} />

        <DataTable
          table="vendor_profiles"
          manageViews
          columns={columns}
          data={profiles}
          loading={loading}
          searchFields={['name', 'notes', 'qb_category', 'description', 'particularites']}
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
