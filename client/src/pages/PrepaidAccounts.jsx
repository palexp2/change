import { useState, useEffect, useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'
import { RefreshCw, Plus, Settings, CheckCircle2, AlertTriangle, ChevronLeft, ChevronRight, ExternalLink, ShieldCheck } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import { useQbAccounts } from '../lib/qbAccounts.js'
import DouanesCarmPanel from './DouanesCarm.jsx'
import { fmtDate } from '../lib/formatDate.js'
import { useToast } from '../contexts/ToastContext.jsx'

const inputCls = 'w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-400'
const labelCls = 'block text-xs font-medium text-slate-500 mb-1'

function fmtMoney(n, currency = 'CAD') {
  if (n == null) return '—'
  try {
    return new Intl.NumberFormat('fr-CA', { style: 'currency', currency }).format(n)
  } catch {
    return `${Number(n).toFixed(2)} ${currency}`
  }
}

// Convention comptable : montant négatif entre parenthèses (comme la cédule papier).
function fmtAmort(n, currency = 'CAD') {
  if (!n) return ''
  return `(${fmtMoney(Math.abs(n), currency).replace(/-/, '')})`
}

const ENTRY_TYPES = [
  { value: 'recharge', label: 'Recharge' },
  { value: 'facture', label: 'Facture' },
  { value: 'ajustement', label: 'Ajustement' },
]

const MONTH_LABELS = { '01': 'Janv', '02': 'Févr', '03': 'Mars', '04': 'Avr', '05': 'Mai', '06': 'Juin', '07': 'Juil', '08': 'Août', '09': 'Sept', 10: 'Oct', 11: 'Nov', 12: 'Déc' }
const monthLabel = m => `${MONTH_LABELS[m.slice(5, 7)]} ${m.slice(0, 4)}`

// ── Volet 1 : soldes fournisseurs prépayés ──────────────────────────────────

function AccountModal({ account, onClose, onSaved, onDeleted }) {
  const isNew = !account?.id
  const [form, setForm] = useState(account || { vendor: '', currency: 'USD', active: 1 })
  const [saving, setSaving] = useState(false)
  const { addToast } = useToast()
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  // Fiche existante → autosave au blur ; création → bouton (pas encore d'id).
  const save = async (k, v) => {
    if (isNew) return
    if ((account[k] ?? '') === (v ?? '')) return
    setSaving(true)
    try {
      onSaved(await api.prepaid.accounts.update(account.id, { [k]: v === '' ? null : v }))
    } catch (e) {
      addToast({ message: `Sauvegarde échouée : ${e.message}`, type: 'error' })
      set(k, account[k])
    } finally {
      setSaving(false)
    }
  }

  async function create() {
    if (!form.vendor?.trim()) { addToast({ message: 'Nom du fournisseur requis', type: 'error' }); return }
    setSaving(true)
    try {
      onSaved(await api.prepaid.accounts.create(form))
      onClose()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const field = (k, label, props = {}) => (
    <div>
      <label className={labelCls}>{label}</label>
      <input
        className={inputCls}
        value={form[k] ?? ''}
        onChange={e => set(k, e.target.value)}
        onBlur={e => save(k, e.target.value.trim() === '' ? null : e.target.value.trim())}
        {...props}
      />
    </div>
  )

  return (
    <Modal isOpen onClose={onClose} title={isNew ? 'Nouveau compte prépayé' : form.vendor} size="lg">
      <div className="grid grid-cols-2 gap-3">
        {field('vendor', 'Fournisseur *', { 'data-testid': 'prepaid-vendor', autoFocus: isNew })}
        <div>
          <label className={labelCls}>Devise</label>
          <select className={inputCls} value={form.currency ?? 'USD'} onChange={e => { set('currency', e.target.value); save('currency', e.target.value) }}>
            {['USD', 'CAD', 'EUR'].map(c => <option key={c}>{c}</option>)}
          </select>
        </div>
        {field('qb_vendor_name', 'Fournisseur QuickBooks (DisplayName)', { placeholder: 'Twilio' })}
        {field('qb_asset_acctnum', "No de compte d'actif prépayé QB", { placeholder: 'ex. 13000 — sert à classer recharge vs facture' })}
        <div>
          <label className={labelCls}>Solde réel via API</label>
          <select className={inputCls} value={form.balance_provider ?? ''} onChange={e => { const v = e.target.value || null; set('balance_provider', v); save('balance_provider', v) }}>
            <option value="">—</option>
            <option value="twilio">Twilio</option>
          </select>
        </div>
        {field('sync_start_date', 'Détecter les transactions QB depuis le', { type: 'date' })}
        {!isNew && (
          <div>
            <label className={labelCls}>Statut</label>
            <select className={inputCls} value={form.active ?? 1} onChange={e => { const v = Number(e.target.value); set('active', v); save('active', v) }}>
              <option value={1}>Actif</option>
              <option value={0}>Inactif</option>
            </select>
          </div>
        )}
        <div className="col-span-2">
          <label className={labelCls}>Notes</label>
          <textarea className={inputCls} rows={2} value={form.notes ?? ''} onChange={e => set('notes', e.target.value)}
            onBlur={e => save('notes', e.target.value.trim() === '' ? null : e.target.value)} />
        </div>
      </div>
      <div className="flex items-center justify-between mt-4">
        {isNew ? (
          // Bouton requis : création d'un nouvel enregistrement (pas encore d'id → autosave impossible)
          <div className="flex w-full justify-end gap-2">
            <button onClick={onClose} className="px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-lg">Annuler</button>
            <button onClick={create} disabled={saving} data-testid="prepaid-create"
              className="px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50">
              {saving ? 'Création…' : 'Créer'}
            </button>
          </div>
        ) : (
          <>
            <button
              onClick={async () => {
                try { await api.prepaid.accounts.delete(account.id); onDeleted(account.id); onClose() }
                catch (e) { addToast({ message: e.message, type: 'error' }) }
              }}
              className="text-sm text-red-600 hover:underline"
            >
              Supprimer
            </button>
            <span className="text-xs text-slate-400">{saving ? 'Sauvegarde…' : 'Modifications sauvegardées automatiquement'}</span>
          </>
        )}
      </div>
    </Modal>
  )
}

function NewEntryModal({ account, onClose, onCreated }) {
  const [form, setForm] = useState({ entry_date: new Date().toISOString().slice(0, 10), type: 'recharge', amount: '', description: '' })
  const [saving, setSaving] = useState(false)
  const { addToast } = useToast()
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function create() {
    setSaving(true)
    try {
      await api.prepaid.accounts.addEntry(account.id, { ...form, amount: Number(form.amount) })
      onCreated()
      onClose()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal isOpen onClose={onClose} title={`Nouvelle entrée — ${account.vendor}`} size="md">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Date</label>
          <input className={inputCls} type="date" value={form.entry_date} onChange={e => set('entry_date', e.target.value)} />
        </div>
        <div>
          <label className={labelCls}>Type</label>
          <select className={inputCls} value={form.type} onChange={e => set('type', e.target.value)} data-testid="entry-type">
            {ENTRY_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls}>Montant ({account.currency}){form.type === 'ajustement' ? ' — signé, + augmente le crédit' : ''}</label>
          <input className={inputCls} type="number" step="0.01" value={form.amount} onChange={e => set('amount', e.target.value)} data-testid="entry-amount" />
        </div>
        <div>
          <label className={labelCls}>Description</label>
          <input className={inputCls} value={form.description} onChange={e => set('description', e.target.value)} data-testid="entry-description" />
        </div>
      </div>
      {/* Bouton requis : création d'un nouvel enregistrement (pas encore d'id → autosave impossible) */}
      <div className="flex justify-end gap-2 mt-4">
        <button onClick={onClose} className="px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-lg">Annuler</button>
        <button onClick={create} disabled={saving || !form.amount} data-testid="entry-create"
          className="px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50">
          {saving ? 'Création…' : 'Créer'}
        </button>
      </div>
    </Modal>
  )
}

function LedgerTab() {
  const [accounts, setAccounts] = useState(null)
  const [selectedId, setSelectedId] = useState(null)
  const [ledger, setLedger] = useState(null)
  const [providerBalance, setProviderBalance] = useState(null)
  const [syncing, setSyncing] = useState(false)
  const [auditing, setAuditing] = useState(false)
  const [audit, setAudit] = useState(null)
  const [editingAccount, setEditingAccount] = useState(null)
  const [creatingAccount, setCreatingAccount] = useState(false)
  const [addingEntry, setAddingEntry] = useState(false)
  const { addToast } = useToast()

  const loadAccounts = useCallback(async () => {
    const rows = await api.prepaid.accounts.list()
    setAccounts(rows)
    setSelectedId(id => id && rows.some(a => a.id === id) ? id : rows[0]?.id || null)
  }, [])
  useEffect(() => { loadAccounts().catch(() => setAccounts([])) }, [loadAccounts])

  const loadLedger = useCallback(async () => {
    if (!selectedId) { setLedger(null); return }
    setLedger(await api.prepaid.accounts.entries(selectedId))
  }, [selectedId])
  useEffect(() => { loadLedger().catch(() => setLedger(null)) }, [loadLedger])

  const account = accounts?.find(a => a.id === selectedId)

  useEffect(() => { setAudit(null) }, [selectedId])

  useEffect(() => {
    setProviderBalance(null)
    if (!account?.balance_provider) return
    api.prepaid.accounts.providerBalance(account.id).then(setProviderBalance).catch(() => {})
  }, [account?.id, account?.balance_provider])

  async function handleSync() {
    setSyncing(true)
    try {
      const out = await api.prepaid.accounts.syncQb(selectedId)
      addToast({ message: `${out.imported} transaction(s) QB importée(s) (depuis le ${fmtDate(out.since)})`, type: 'success' })
      await Promise.all([loadLedger(), loadAccounts()])
    } catch (e) {
      addToast({ message: `Détection QB échouée : ${e.message}`, type: 'error' })
    } finally {
      setSyncing(false)
    }
  }

  // Vérification de complétude ledger ↔ QB (fenêtre complète). apply=true corrige.
  async function handleAudit(apply = false) {
    setAuditing(true)
    try {
      const out = await api.prepaid.accounts.auditQb(selectedId, apply)
      setAudit(out)
      if (apply) {
        addToast({ message: `${out.fixed} correction(s) appliquée(s)`, type: 'success' })
        await Promise.all([loadLedger(), loadAccounts()])
      }
    } catch (e) {
      addToast({ message: `Vérification échouée : ${e.message}`, type: 'error' })
    } finally {
      setAuditing(false)
    }
  }

  async function updateEntry(entry, patch) {
    try {
      await api.prepaid.entries.update(entry.id, patch)
      await Promise.all([loadLedger(), loadAccounts()])
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    }
  }

  if (accounts === null) return <div className="text-sm text-slate-400 py-10 text-center">Chargement…</div>

  const balance = ledger?.balance ?? account?.balance ?? 0
  const delta = providerBalance?.balance != null ? Math.round((providerBalance.balance - balance) * 100) / 100 : null
  // Ledger affiché du plus récent au plus ancien (le solde courant reste calculé chronologiquement).
  const entries = ledger?.entries ? [...ledger.entries].reverse() : []
  // Décomposition du solde (entrées incluses seulement) : rend le maintien du
  // solde lisible — solde = recharges − factures + ajustements.
  const included = (ledger?.entries || []).filter(e => !e.excluded)
  const totals = {
    recharges: included.filter(e => e.type === 'recharge').reduce((s, e) => s + Math.abs(e.amount), 0),
    factures: included.filter(e => e.type === 'facture').reduce((s, e) => s + Math.abs(e.amount), 0),
    ajustements: included.filter(e => e.type === 'ajustement').reduce((s, e) => s + e.amount, 0),
  }
  const auditIssues = audit ? audit.missing.length + audit.mismatched.length + audit.orphaned.length : 0

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2 flex-wrap">
          {accounts.map(a => (
            <button key={a.id} onClick={() => setSelectedId(a.id)}
              className={`px-3 py-1.5 text-sm rounded-full border ${a.id === selectedId
                ? 'bg-brand-600 text-white border-brand-600'
                : 'bg-white text-slate-600 border-slate-200 hover:bg-slate-50'}`}>
              {a.vendor}{!a.active ? ' (inactif)' : ''}
            </button>
          ))}
          <button onClick={() => setCreatingAccount(true)} data-testid="prepaid-new-account"
            className="inline-flex items-center gap-1 px-3 py-1.5 text-sm text-slate-500 border border-dashed border-slate-300 rounded-full hover:bg-slate-50">
            <Plus size={13} /> Compte
          </button>
        </div>
        {account && (
          <div className="flex items-center gap-2">
            <button onClick={() => handleAudit(false)} disabled={auditing} data-testid="prepaid-audit"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50"
              title="Recomparer tout le ledger aux transactions QuickBooks réelles (manquantes, modifiées, supprimées)">
              <ShieldCheck size={14} className={auditing ? 'animate-pulse' : ''} />
              {auditing ? 'Vérification…' : 'Vérifier vs QB'}
            </button>
            <button onClick={handleSync} disabled={syncing}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50"
              title="Détecter les transactions QuickBooks du fournisseur">
              <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
              {syncing ? 'Détection…' : 'Détecter les transactions QB'}
            </button>
            <button onClick={() => setAddingEntry(true)} data-testid="prepaid-new-entry"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg">
              <Plus size={14} /> Entrée
            </button>
            <button onClick={() => setEditingAccount(account)} title="Paramètres du compte"
              className="p-2 text-slate-500 bg-white border border-slate-200 rounded-lg hover:bg-slate-50">
              <Settings size={15} />
            </button>
          </div>
        )}
      </div>

      {!account && (
        <div className="text-center py-14 text-slate-400 text-sm">
          Aucun compte prépayé. Créer un compte pour suivre un fournisseur à recharges (ex. Twilio).
        </div>
      )}

      {account && (
        <>
          <div className="flex items-stretch gap-4 mb-5">
            <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
              <div className="text-xs text-slate-500 mb-1">Solde du suivi ERP</div>
              <div className={`text-2xl font-bold tabular-nums ${balance >= 0 ? 'text-emerald-600' : 'text-red-600'}`} data-testid="prepaid-balance">
                {fmtMoney(Math.abs(balance), account.currency)}
              </div>
              <div className="text-xs text-slate-500 mt-1">
                {balance >= 0 ? `Crédit prépayé chez ${account.vendor}` : `Dû à ${account.vendor}`}
              </div>
            </div>
            {account.balance_provider && (
              <div className="rounded-xl border border-slate-200 bg-white px-5 py-4">
                <div className="text-xs text-slate-500 mb-1">Solde réel {account.vendor} (API)</div>
                {providerBalance?.balance != null ? (
                  <>
                    <div className="text-2xl font-bold tabular-nums text-slate-800">
                      {fmtMoney(providerBalance.balance, providerBalance.currency || account.currency)}
                    </div>
                    <div className={`text-xs mt-1 ${Math.abs(delta) > 5 ? 'text-amber-600 font-medium' : 'text-slate-500'}`}>
                      {Math.abs(delta) <= 0.01 ? 'Concorde avec le suivi ✓' : `Écart vs suivi : ${fmtMoney(delta, account.currency)}`}
                    </div>
                  </>
                ) : (
                  <div className="text-xs text-slate-400 max-w-[220px]">{providerBalance?.error || 'Chargement…'}</div>
                )}
              </div>
            )}
            {/* Décomposition : comment le solde se maintient. */}
            <div className="rounded-xl border border-slate-200 bg-white px-5 py-4" data-testid="prepaid-breakdown">
              <div className="text-xs text-slate-500 mb-1.5">Composition du solde</div>
              <div className="space-y-0.5 text-sm tabular-nums">
                <div className="flex justify-between gap-6">
                  <span className="text-slate-500">Recharges</span>
                  <span className="text-emerald-600 font-medium">+{fmtMoney(totals.recharges, account.currency)}</span>
                </div>
                <div className="flex justify-between gap-6">
                  <span className="text-slate-500">Factures</span>
                  <span className="text-slate-700 font-medium">−{fmtMoney(totals.factures, account.currency)}</span>
                </div>
                {totals.ajustements !== 0 && (
                  <div className="flex justify-between gap-6">
                    <span className="text-slate-500">Ajustements</span>
                    <span className="text-slate-700 font-medium">{totals.ajustements > 0 ? '+' : ''}{fmtMoney(totals.ajustements, account.currency)}</span>
                  </div>
                )}
                <div className="flex justify-between gap-6 border-t border-slate-100 pt-0.5 mt-1">
                  <span className="text-slate-600 font-medium">Solde</span>
                  <span className={`font-semibold ${balance >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>{fmtMoney(balance, account.currency)}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Résultat de la vérification ledger ↔ QB */}
          {audit && (
            <div className={`rounded-xl border px-4 py-3 mb-5 text-sm ${auditIssues
              ? 'border-amber-200 bg-amber-50'
              : 'border-emerald-200 bg-emerald-50'}`} data-testid="prepaid-audit-result">
              {auditIssues === 0 ? (
                <div className="flex items-center gap-2 text-emerald-700">
                  <CheckCircle2 size={15} />
                  Ledger complet et exact : {audit.matched} transaction(s) QB depuis le {fmtDate(audit.since)}, toutes présentes au bon montant.
                </div>
              ) : (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2 text-amber-800 font-medium">
                      <AlertTriangle size={15} />
                      {auditIssues} écart(s) vs QuickBooks ({audit.matched} transaction(s) concordante(s))
                    </div>
                    {!audit.applied && (
                      <button onClick={() => handleAudit(true)} disabled={auditing} data-testid="prepaid-audit-fix"
                        className="px-3 py-1.5 text-xs font-medium text-white bg-amber-600 hover:bg-amber-700 rounded-lg disabled:opacity-50">
                        Corriger automatiquement
                      </button>
                    )}
                  </div>
                  <ul className="space-y-1 text-xs text-amber-900">
                    {audit.missing.map(t => (
                      <li key={`m-${t.qb_txn_type}-${t.qb_txn_id}`}>
                        <span className="font-medium">Manquante dans l'ERP :</span> {fmtDate(t.entry_date)} — {t.description} ({fmtMoney(Math.abs(t.amount), account.currency)})
                      </li>
                    ))}
                    {audit.mismatched.map(m => (
                      <li key={`d-${m.entry.id}`}>
                        <span className="font-medium">Modifiée dans QB :</span> {m.entry.description} — {m.amount_differs
                          ? `montant ERP ${fmtMoney(Math.abs(m.entry.amount), account.currency)} ≠ QB ${fmtMoney(Math.abs(m.qb.amount), account.currency)}`
                          : `date ERP ${fmtDate(m.entry.entry_date)} ≠ QB ${fmtDate(m.qb.entry_date)}`}
                      </li>
                    ))}
                    {audit.orphaned.map(e => (
                      <li key={`o-${e.id}`}>
                        <span className="font-medium">Supprimée de QB :</span> {fmtDate(e.entry_date)} — {e.description} ({fmtMoney(Math.abs(e.amount), account.currency)})
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}

          <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="prepaid-ledger">
                <thead>
                  <tr className="text-left text-xs text-slate-500 border-b border-slate-100 bg-slate-50/50">
                    <th className="py-2 px-3 font-medium">Date</th>
                    <th className="py-2 px-3 font-medium">Type</th>
                    <th className="py-2 px-3 font-medium">Description</th>
                    <th className="py-2 px-3 font-medium">Source</th>
                    <th className="py-2 px-3 font-medium text-right">Montant</th>
                    <th className="py-2 px-3 font-medium text-right">Solde</th>
                    <th className="py-2 px-3" />
                  </tr>
                </thead>
                <tbody>
                  {entries.map(e => {
                    const signed = e.type === 'facture' ? -Math.abs(e.amount) : e.type === 'recharge' ? Math.abs(e.amount) : e.amount
                    return (
                      <tr key={e.id} className={`border-b border-slate-50 ${e.excluded ? 'opacity-40' : ''}`}>
                        <td className="py-1.5 px-3 whitespace-nowrap">{fmtDate(e.entry_date)}</td>
                        <td className="py-1.5 px-3">
                          {/* Reclassement inline : la détection QB peut se tromper (recharge vs facture). */}
                          <select
                            value={e.type}
                            onChange={ev => updateEntry(e, { type: ev.target.value })}
                            className={`text-xs border-0 rounded-md px-1.5 py-0.5 cursor-pointer focus:ring-1 focus:ring-brand-400 ${
                              e.type === 'recharge' ? 'bg-emerald-50 text-emerald-700'
                                : e.type === 'facture' ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-600'}`}
                          >
                            {ENTRY_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                          </select>
                        </td>
                        <td className="py-1.5 px-3 text-slate-600 max-w-[380px]" title={e.description || ''}>
                          {e.qb_url ? (
                            // Facture/dépense détectée de QB → ouvre la transaction dans QuickBooks.
                            <a href={e.qb_url} target="_blank" rel="noreferrer"
                              className="inline-flex items-center gap-1 max-w-full text-brand-600 hover:text-brand-700 hover:underline"
                              title="Ouvrir dans QuickBooks">
                              <span className="truncate">{e.description || `${e.qb_txn_type} #${e.qb_txn_id}`}</span>
                              <ExternalLink size={11} className="shrink-0" />
                            </a>
                          ) : (
                            <span className="block truncate">{e.description || '—'}</span>
                          )}
                        </td>
                        <td className="py-1.5 px-3">
                          <Badge color={e.source === 'qb' ? 'purple' : e.source === 'import' ? 'gray' : 'blue'}>
                            {e.source === 'qb' ? 'QB' : e.source === 'import' ? 'Import' : 'Manuel'}
                          </Badge>
                        </td>
                        <td className={`py-1.5 px-3 text-right tabular-nums ${signed >= 0 ? 'text-emerald-600' : 'text-slate-700'}`}>
                          {signed >= 0 ? '+' : ''}{fmtMoney(signed, account.currency)}
                        </td>
                        <td className={`py-1.5 px-3 text-right tabular-nums font-medium ${e.running_balance >= 0 ? 'text-slate-800' : 'text-red-600'}`}>
                          {fmtMoney(e.running_balance, account.currency)}
                        </td>
                        <td className="py-1.5 px-3 text-right whitespace-nowrap">
                          <button onClick={() => updateEntry(e, { excluded: e.excluded ? 0 : 1 })}
                            className="text-xs text-slate-400 hover:text-slate-600 mr-2"
                            title={e.excluded ? 'Réinclure dans le solde' : 'Exclure du solde (garde la trace)'}>
                            {e.excluded ? 'Réinclure' : 'Exclure'}
                          </button>
                          {e.source !== 'qb' && (
                            <button
                              onClick={async () => {
                                try { await api.prepaid.entries.delete(e.id); await loadLedger(); await loadAccounts() }
                                catch (err) { addToast({ message: err.message, type: 'error' }) }
                              }}
                              className="text-xs text-red-400 hover:text-red-600">
                              Suppr.
                            </button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                  {!entries.length && (
                    <tr><td colSpan={7} className="py-8 text-center text-sm text-slate-400">
                      Aucune entrée. « Détecter les transactions QB » ou ajouter une entrée manuelle.
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {creatingAccount && (
        <AccountModal account={null} onClose={() => setCreatingAccount(false)}
          onSaved={created => { setAccounts(list => [...(list || []), created]); setSelectedId(created.id) }} />
      )}
      {editingAccount && (
        <AccountModal account={editingAccount}
          onClose={() => setEditingAccount(null)}
          onSaved={updated => {
            setAccounts(list => list.map(a => (a.id === updated.id ? { ...a, ...updated } : a)))
            setEditingAccount(prev => (prev && prev.id === updated.id ? { ...prev, ...updated } : prev))
          }}
          onDeleted={id => { setAccounts(list => list.filter(a => a.id !== id)); setSelectedId(null) }} />
      )}
      {addingEntry && account && (
        <NewEntryModal account={account} onClose={() => setAddingEntry(false)}
          onCreated={() => { loadLedger(); loadAccounts() }} />
      )}
    </div>
  )
}

// ── Volet 2 : cédule FPA ────────────────────────────────────────────────────

function ExpenseModal({ expense, onClose, onChanged }) {
  const isNew = !expense?.id
  const [form, setForm] = useState(expense || {
    label: '', amount: '', currency: 'CAD', method: 'prorata_jours', fpa_acctnum: '13000', active: 1,
  })
  const [saving, setSaving] = useState(false)
  const { addToast } = useToast()
  const { options: acctOptions, accountName } = useQbAccounts()
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const save = async (k, v) => {
    if (isNew) return
    if ((expense[k] ?? '') === (v ?? '')) return
    setSaving(true)
    try {
      await api.prepaid.expenses.update(expense.id, { [k]: v === '' ? null : v })
      onChanged()
    } catch (e) {
      addToast({ message: `Sauvegarde échouée : ${e.message}`, type: 'error' })
      set(k, expense[k])
    } finally {
      setSaving(false)
    }
  }

  async function create() {
    if (!form.label?.trim()) { addToast({ message: 'Libellé requis', type: 'error' }); return }
    if (!Number(form.amount)) { addToast({ message: 'Montant requis', type: 'error' }); return }
    setSaving(true)
    try {
      await api.prepaid.expenses.create({ ...form, amount: Number(form.amount) })
      onChanged()
      onClose()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  const field = (k, label, props = {}) => (
    <div>
      <label className={labelCls}>{label}</label>
      <input className={inputCls} value={form[k] ?? ''} onChange={e => set(k, e.target.value)}
        onBlur={e => save(k, e.target.value.trim() === '' ? null : e.target.value.trim())} {...props} />
    </div>
  )

  // Sélecteur de compte QB (numéro + nom, recherchable). Persiste immédiatement :
  // le SearchableSelect n'émet pas de blur.
  const acctField = (k, label) => (
    <div>
      <label className={labelCls}>{label}</label>
      <SearchableSelect
        testId={`fpa-${k}`}
        value={form[k] ?? ''}
        options={acctOptions}
        emptyOption="— Aucun compte —"
        placeholder="— Aucun compte —"
        onChange={v => { set(k, v || null); save(k, v || null) }}
      />
      {form[k] && !accountName(form[k]) && (
        <p className="text-[11px] text-amber-600 mt-1">Compte #{form[k]} introuvable dans QuickBooks.</p>
      )}
    </div>
  )

  return (
    <Modal isOpen onClose={onClose} title={isNew ? 'Nouveau frais payé d\'avance' : form.label} size="lg">
      <div className="grid grid-cols-2 gap-3">
        {field('label', 'Libellé (fournisseur / objet) *', { 'data-testid': 'fpa-label', autoFocus: isNew })}
        {field('amount', 'Montant porté au 13000 *', { type: 'number', step: '0.01', min: '0', 'data-testid': 'fpa-amount' })}
        {field('payment_date', 'Date du paiement', { type: 'date' })}
        <div>
          <label className={labelCls}>Méthode d'amortissement</label>
          <select className={inputCls} value={form.method} data-testid="fpa-method"
            onChange={e => { set('method', e.target.value); save('method', e.target.value) }}>
            <option value="prorata_jours">Prorata des jours (période)</option>
            <option value="mensuel_fixe">Montant mensuel fixe (période)</option>
            <option value="manuel">Montants manuels par mois</option>
            <option value="aucun">Aucun (dépôt, imputation ponctuelle)</option>
          </select>
        </div>
        {(form.method === 'prorata_jours' || form.method === 'mensuel_fixe') && (
          <>
            {field('amort_start', 'Début de la période', { type: 'date', 'data-testid': 'fpa-start' })}
            {field('amort_end', 'Fin de la période', { type: 'date', 'data-testid': 'fpa-end' })}
          </>
        )}
        {form.method === 'mensuel_fixe' && (
          <div className="col-span-2">
            {field('monthly_amount', 'Montant imputé chaque mois', { type: 'number', step: '0.01', min: '0', 'data-testid': 'fpa-monthly' })}
            <p className="text-[11px] text-slate-400 mt-1">
              Le même montant est imputé tous les mois de la période ; le dernier mois absorbe le résidu.
            </p>
          </div>
        )}
        {/* Comptes choisis dans le plan comptable QB, pas tapés de mémoire : le compte
            de débit est le compte de DÉPENSE (ex. « 60000 · Assurances »), jamais un
            compte au nom du fournisseur. */}
        {acctField('expense_acctnum', 'Compte de dépense QB (Dr)')}
        {acctField('fpa_acctnum', 'Compte FPA QB (Cr)')}
        <div className="col-span-2">
          <label className={labelCls}>Description</label>
          <textarea className={inputCls} rows={2} value={form.description ?? ''} onChange={e => set('description', e.target.value)}
            onBlur={e => save('description', e.target.value.trim() === '' ? null : e.target.value)} />
        </div>
        {!isNew && (
          <div>
            <label className={labelCls}>Statut</label>
            <select className={inputCls} value={form.active ?? 1}
              onChange={e => { const v = Number(e.target.value); set('active', v); save('active', v) }}>
              <option value={1}>Actif</option>
              <option value={0}>Soldé / inactif</option>
            </select>
          </div>
        )}
      </div>
      <div className="flex items-center justify-between mt-4">
        {isNew ? (
          // Bouton requis : création d'un nouvel enregistrement (pas encore d'id → autosave impossible)
          <div className="flex w-full justify-end gap-2">
            <button onClick={onClose} className="px-3 py-2 text-sm text-slate-600 hover:bg-slate-50 rounded-lg">Annuler</button>
            <button onClick={create} disabled={saving} data-testid="fpa-create"
              className="px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50">
              {saving ? 'Création…' : 'Créer'}
            </button>
          </div>
        ) : (
          <>
            <button
              onClick={async () => {
                try { await api.prepaid.expenses.delete(expense.id); onChanged(); onClose() }
                catch (e) { addToast({ message: e.message, type: 'error' }) }
              }}
              className="text-sm text-red-600 hover:underline"
            >
              Supprimer
            </button>
            <span className="text-xs text-slate-400">{saving ? 'Sauvegarde…' : 'Modifications sauvegardées automatiquement'}</span>
          </>
        )}
      </div>
    </Modal>
  )
}

function FpaTab() {
  const currentFy = (() => {
    const now = new Date()
    return now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1
  })()
  const [fy, setFy] = useState(currentFy)
  const [view, setView] = useState(null)
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7))
  const [monthData, setMonthData] = useState(null)
  const [publishing, setPublishing] = useState(false)
  const [editing, setEditing] = useState(null)
  const [creating, setCreating] = useState(false)
  const { addToast } = useToast()
  // Le numéro seul ne dit pas où l'imputation atterrit (le libellé de l'item est un
  // fournisseur, pas un compte) : on affiche le nom du compte QB à côté du numéro.
  const { accountName } = useQbAccounts()

  const load = useCallback(async () => {
    setView(await api.prepaid.expenses.list(fy))
  }, [fy])
  useEffect(() => { load().catch(() => setView({ months: [], items: [] })) }, [load])

  const loadMonth = useCallback(async () => {
    setMonthData(await api.prepaid.fpaMonth(month))
  }, [month])
  useEffect(() => { loadMonth().catch(() => setMonthData(null)) }, [loadMonth])

  async function handlePublish() {
    setPublishing(true)
    try {
      const out = await api.prepaid.fpaPublish(month)
      addToast({ message: `Écriture publiée dans QB (JE #${out.qb_je_id})`, type: 'success' })
      await Promise.all([load(), loadMonth()])
    } catch (e) {
      addToast({ message: `Publication échouée : ${e.message}`, type: 'error' })
    } finally {
      setPublishing(false)
    }
  }

  const shiftMonth = delta => {
    const d = new Date(`${month}-15T12:00:00Z`)
    d.setUTCMonth(d.getUTCMonth() + delta)
    setMonth(d.toISOString().slice(0, 7))
  }

  const publishedCount = monthData?.lines?.filter(l => l.pushed_at).length || 0

  return (
    <div>
      {/* Écriture du mois */}
      <div className="rounded-xl border border-slate-200 bg-white p-4 mb-5" data-testid="fpa-month-card">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <button onClick={() => shiftMonth(-1)} className="p-1 text-slate-400 hover:text-slate-600"><ChevronLeft size={16} /></button>
            <span className="text-sm font-semibold text-slate-800 w-28 text-center">{monthLabel(month)}</span>
            <button onClick={() => shiftMonth(1)} className="p-1 text-slate-400 hover:text-slate-600"><ChevronRight size={16} /></button>
            <span className="text-xs text-slate-500 ml-2">Écriture d'imputation aux résultats (Dr dépense / Cr 13000)</span>
          </div>
          {monthData?.publishable_count > 0 && (
            <button onClick={handlePublish} disabled={publishing || monthData.missing_accounts.length > 0}
              data-testid="fpa-publish"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50">
              {publishing ? 'Publication…' : `Publier dans QB — ${fmtMoney(monthData.publishable_total)}`}
            </button>
          )}
        </div>
        {monthData?.missing_accounts?.length > 0 && (
          <div className="flex items-center gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-2">
            <AlertTriangle size={14} />
            Compte de dépense QB manquant sur : {monthData.missing_accounts.join(', ')} — à renseigner dans la fiche de l'item.
          </div>
        )}
        {monthData?.lines?.length ? (
          <table className="w-full text-sm">
            <tbody>
              {monthData.lines.map(l => (
                <tr key={l.expense_id} className="border-t border-slate-50">
                  <td className="py-1.5 pr-4">{l.label}</td>
                  <td className="py-1.5 pr-4 text-xs text-slate-500">
                    Dr #{l.expense_acctnum || '?'}{accountName(l.expense_acctnum) ? ` ${accountName(l.expense_acctnum)}` : ''}
                    {' / '}Cr #{l.fpa_acctnum}{accountName(l.fpa_acctnum) ? ` ${accountName(l.fpa_acctnum)}` : ''}
                  </td>
                  <td className="py-1.5 pr-4 text-right tabular-nums">{fmtMoney(l.amount)}</td>
                  <td className="py-1.5 text-right">
                    {l.pushed_at
                      ? <span className="inline-flex items-center gap-1 text-xs text-emerald-600"><CheckCircle2 size={13} /> {l.qb_je_id ? `JE #${l.qb_je_id}` : 'Comptabilisé'}</span>
                      : <span className="text-xs text-slate-400">À publier</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="text-sm text-slate-400 py-2">Aucun amortissement ce mois-ci.</div>
        )}
        {monthData && !monthData.publishable_count && publishedCount > 0 && (
          <div className="text-xs text-emerald-600 mt-2">Écriture du mois entièrement comptabilisée ✓</div>
        )}
      </div>

      {/* Cédule de continuité */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <button onClick={() => setFy(f => f - 1)} className="p-1 text-slate-400 hover:text-slate-600"><ChevronLeft size={16} /></button>
          <h2 className="text-sm font-semibold text-slate-800">
            Cédule de continuité {fy}-{String(fy + 1).slice(2)} <span className="text-slate-400 font-normal">(avril → mars)</span>
          </h2>
          <button onClick={() => setFy(f => f + 1)} className="p-1 text-slate-400 hover:text-slate-600"><ChevronRight size={16} /></button>
        </div>
        <button onClick={() => setCreating(true)} data-testid="fpa-new"
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg">
          <Plus size={14} /> Nouvel item
        </button>
      </div>

      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm whitespace-nowrap" data-testid="fpa-continuity">
            <thead>
              <tr className="text-xs text-slate-500 border-b border-slate-100 bg-slate-50/50">
                <th className="py-2 px-3 font-medium text-left sticky left-0 bg-slate-50">Item</th>
                <th className="py-2 px-3 font-medium text-right">Ouverture</th>
                {view?.months?.map(m => <th key={m} className="py-2 px-2 font-medium text-right">{MONTH_LABELS[m.slice(5, 7)]}</th>)}
                <th className="py-2 px-3 font-medium text-right">Fermeture</th>
              </tr>
            </thead>
            <tbody>
              {view?.items?.map(item => (
                <tr key={item.id} className="border-b border-slate-50 hover:bg-slate-50/50 cursor-pointer" onClick={() => setEditing(item)}>
                  <td className="py-2 px-3 sticky left-0 bg-white">
                    <span className="font-medium text-slate-800">{item.label}</span>
                    {!item.active && <span className="text-xs text-slate-400 ml-1">(soldé)</span>}
                    {item.description && <div className="text-xs text-slate-400 max-w-[260px] truncate" title={item.description}>{item.description}</div>}
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums font-medium">{fmtMoney(item.opening_balance)}</td>
                  {view.months.map(m => {
                    const cell = item.months[m]
                    return (
                      <td key={m} className="py-2 px-2 text-right tabular-nums text-slate-600" title={cell?.pushed_at ? `Comptabilisé${cell.qb_je_id ? ` — JE #${cell.qb_je_id}` : ''}` : ''}>
                        {cell ? (
                          <span className={cell.pushed_at ? 'text-emerald-700' : ''}>{fmtAmort(cell.amount)}</span>
                        ) : ''}
                      </td>
                    )
                  })}
                  <td className="py-2 px-3 text-right tabular-nums font-medium">{fmtMoney(item.closing_balance)}</td>
                </tr>
              ))}
              {view?.items?.length > 0 && (
                <tr className="border-t border-slate-200 bg-slate-50/50 font-medium">
                  <td className="py-2 px-3 sticky left-0 bg-slate-50">Total</td>
                  <td className="py-2 px-3 text-right tabular-nums">{fmtMoney(view.items.reduce((s, i) => s + i.opening_balance, 0))}</td>
                  {view.months.map(m => (
                    <td key={m} className="py-2 px-2 text-right tabular-nums">
                      {fmtAmort(view.items.reduce((s, i) => s + (i.months[m]?.amount || 0), 0))}
                    </td>
                  ))}
                  <td className="py-2 px-3 text-right tabular-nums">{fmtMoney(view.items.reduce((s, i) => s + i.closing_balance, 0))}</td>
                </tr>
              )}
              {!view?.items?.length && (
                <tr><td colSpan={15} className="py-8 text-center text-sm text-slate-400">Aucun frais payé d'avance dans la cédule.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {(creating || editing) && (
        <ExpenseModal expense={editing} onClose={() => { setCreating(false); setEditing(null) }}
          onChanged={() => { load(); loadMonth() }} />
      )}
    </div>
  )
}

// ── Page ────────────────────────────────────────────────────────────────────

// Le compte CARM de l'ASFC est un compte prépayé de plus (avances de fonds
// consommées par les déclarations) : son suivi vit ici, en troisième onglet,
// plutôt que sur une page isolée.
const TABS = [
  ['ledger', 'Soldes fournisseurs'],
  ['fpa', 'Cédule FPA'],
  ['douanes', 'Douanes (ASFC)'],
]

export default function PrepaidAccounts() {
  // Onglet piloté par l'URL (?onglet=) : partageable, et le sous-menu de la
  // sidebar peut y sauter même quand la page est déjà affichée.
  const [params, setParams] = useSearchParams()
  const asked = params.get('onglet')
  const tab = TABS.some(([k]) => k === asked) ? asked : 'ledger'
  const setTab = (v) => setParams({ onglet: v }, { replace: true })
  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-center justify-between mb-5">
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Comptes prépayés</h1>
            <p className="text-xs text-slate-500 mt-0.5">
              Soldes fournisseurs à recharges (ex-Twilio_Suivi), cédule de continuité des frais payés d'avance #13000 (ex-FPA_Continuité) et compte de douanes ASFC.
            </p>
          </div>
          <div className="flex items-center bg-slate-100 rounded-lg p-0.5">
            {TABS.map(([k, label]) => (
              <button key={k} onClick={() => setTab(k)} data-testid={`tab-${k}`}
                className={`px-3 py-1.5 text-sm rounded-md ${tab === k ? 'bg-white shadow-sm font-medium text-slate-800' : 'text-slate-500 hover:text-slate-700'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {tab === 'ledger' && <LedgerTab />}
        {tab === 'fpa' && <FpaTab />}
        {tab === 'douanes' && <DouanesCarmPanel />}
      </div>
    </Layout>
  )
}
