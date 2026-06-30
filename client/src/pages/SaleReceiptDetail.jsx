import { useState, useEffect, useRef, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import {
  ArrowLeft, ChevronLeft, ChevronRight,
  RefreshCw, AlertCircle, CheckCircle, Clock, BookOpen, ReceiptText,
  Plus, Trash2, Archive, ArchiveRestore, Pencil,
} from 'lucide-react'
import { api } from '../lib/api.js'
import { fmtDate, fmtDateTime } from '../lib/formatDate.js'
import { Layout } from '../components/Layout.jsx'
import Spinner from '../components/Spinner.jsx'
import { Modal } from '../components/Modal.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useEntityListRealtime } from '../lib/useRealtimeChannel.js'
import { findBestVendorMatch } from '../lib/vendorMatch.js'

import { fmtCad } from '../utils/formatters.js'
import { DetailLoadError } from '../components/DetailLoadError.jsx'

const round2 = x => Math.round((Number(x) || 0) * 100) / 100

// Montants synchronisés avec le total : toute édition de l'un de ces champs doit
// recalculer `total` dans le même PATCH pour rester cohérent en DB.
const TOTAL_SYNC_FIELDS = new Set(['subtotal', 'tps', 'tvq', 'other_taxes'])

// Sous-total effectif : somme des lignes d'articles si au moins une porte un
// montant (le sous-total est alors en lecture seule), sinon le sous-total saisi.
function effectiveSubtotal(receipt) {
  const withTotals = (receipt.items || []).filter(it => it && it.total != null)
  if (withTotals.length) return round2(withTotals.reduce((s, it) => s + (Number(it.total) || 0), 0))
  return round2(receipt.subtotal || 0)
}

// Total = sous-total (articles) + TPS + TVQ + autres taxes. Toujours DÉRIVÉ, jamais
// saisi à la main — règle métier : « le total doit correspondre aux articles et aux
// taxes ». Affiché en lecture seule et persisté à chaque édition de montant.
function computedTotal(receipt) {
  return round2(effectiveSubtotal(receipt) + (receipt.tps || 0) + (receipt.tvq || 0) + (receipt.other_taxes || 0))
}

// Enrichit un patch de montants du total recalculé pour garder `total` cohérent en DB.
function withRecomputedTotal(receipt, patch) {
  return { ...patch, total: computedTotal({ ...receipt, ...patch }) }
}

function StatusBadge({ status }) {
  if (status === 'done')       return <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-100 px-2 py-0.5 rounded-full"><CheckCircle size={10} /> Complété</span>
  if (status === 'processing') return <span className="inline-flex items-center gap-1 text-xs text-blue-700 bg-blue-100 px-2 py-0.5 rounded-full"><RefreshCw size={10} className="animate-spin" /> En cours</span>
  if (status === 'error')      return <span className="inline-flex items-center gap-1 text-xs text-red-700 bg-red-100 px-2 py-0.5 rounded-full"><AlertCircle size={10} /> Erreur</span>
  return <span className="inline-flex items-center gap-1 text-xs text-gray-600 bg-gray-100 px-2 py-0.5 rounded-full"><Clock size={10} /> En attente</span>
}

// Code de taxe QB déduit par défaut selon les montants TPS/TVQ extraits — sert de
// présélection. Doit rester aligné avec la déduction serveur (pushSaleReceiptToQB).
const NO_TAX = '__none__'
function deducedTaxName(tps, tvq) {
  if (tps > 0 && tvq > 0) return 'TPS/TVQ QC - 9,975'
  if (tps > 0) return 'TPS'
  if (tvq > 0) return 'TVQ QC - 9,975'
  return null
}

// Taux de taxe d'ACHAT par NOM de code QB (codes vérifiés en prod — cf. fiscalStatus.js).
// Sert UNIQUEMENT à l'indicateur de réconciliation : compare la taxe impliquée par les
// codes par ligne aux taxes saisies du document. Un nom absent = taux inconnu → la
// réconciliation est marquée « partielle » plutôt que de conclure à tort.
const TAX_RATE_BY_NAME = new Map([
  ['TPS', 5],
  ['TVQ QC - 9,975', 9.975],
  ['TPS/TVQ QC - 9,975', 14.975],
  ['TPS/TVQ repas', 14.975],
  ['Détaxé', 0],
  ['Exonéré', 0],
  ['Hors champ', 0],
])

// Ventilation TPS/TVQ par NOM de code QB — pour le recalcul AUTOMATIQUE des taxes du
// document à partir des codes (mode « piloté par les codes »). Le taux est le taux PLEIN
// de taxe facturée (le crédit partiel des repas est géré au posting QB, pas au taux).
const TAX_SPLIT_BY_NAME = new Map([
  ['TPS', { tps: 5, tvq: 0 }],
  ['TVQ QC - 9,975', { tps: 0, tvq: 9.975 }],
  ['TPS/TVQ QC - 9,975', { tps: 5, tvq: 9.975 }],
  ['TPS/TVQ repas', { tps: 5, tvq: 9.975 }],
  ['Détaxé', { tps: 0, tvq: 0 }],
  ['Exonéré', { tps: 0, tvq: 0 }],
  ['Hors champ', { tps: 0, tvq: 0 }],
])

// Recalcule TPS/TVQ à partir des codes : chaque ligne est taxée selon SON code, ou le
// code par DÉFAUT du document (defaultCodeId) si la ligne n'a pas de code propre.
// taxNameById : Map(Id QB → Nom). Retourne { tps, tvq } ou null si non calculable
// (une ligne sans code et sans défaut, ou un code au taux inconnu) → l'appelant garde
// alors les taxes manuelles.
function computeTaxesFromCodes(items, defaultCodeId, taxNameById) {
  const splitFor = codeId => {
    if (codeId === NO_TAX) return { tps: 0, tvq: 0 }
    const name = taxNameById.get(codeId)
    return name != null ? TAX_SPLIT_BY_NAME.get(name) : undefined
  }
  let tps = 0, tvq = 0
  for (const it of (items || [])) {
    const ht = Number(it && it.total) || 0
    const code = (it && it.tax_code_id != null && it.tax_code_id !== '') ? it.tax_code_id : defaultCodeId
    if (!code) return null
    const split = splitFor(code)
    if (!split) return null
    tps += ht * split.tps / 100
    tvq += ht * split.tvq / 100
  }
  return { tps: round2(tps), tvq: round2(tvq) }
}

// Patch des montants après édition des lignes ou d'un code. Mode « piloté par les codes »
// (un code par défaut du document est défini ET les taxes sont calculables) → TPS/TVQ
// dérivées des codes, other_taxes remis à 0, total = sous-total + taxes. Sinon → retombe
// sur le comportement manuel (mise à l'échelle proportionnelle).
function recomputeAmounts(receipt, items, defaultCodeId, taxNameById) {
  const lineTotals = (items || []).map(it => it && it.total).filter(n => n != null)
  if (lineTotals.length && defaultCodeId) {
    const t = computeTaxesFromCodes(items, defaultCodeId, taxNameById)
    if (t) {
      const subtotal = round2(lineTotals.reduce((a, b) => a + (Number(b) || 0), 0))
      return { subtotal, tps: t.tps, tvq: t.tvq, other_taxes: 0, total: round2(subtotal + t.tps + t.tvq) }
    }
  }
  return recalcAmountsFromItems(items, receipt)
}

// Taxe impliquée par les codes de taxe PAR LIGNE (réconciliation, lecture seule — ne
// modifie jamais les taxes du document, qui restent la vérité de la facture).
// taxNameById : Map(Id QB → Nom). Retourne :
//  - applicable : au moins une ligne porte un code explicite (réel ou « aucune taxe »).
//  - allExplicit : toutes les lignes portent un code explicite. Sinon on ne peut pas
//    conclure — une ligne « code du document » dépend du code choisi à la publication.
//  - unknown : un code explicite a un taux inconnu (hors table) → réconciliation partielle.
//  - implied : somme des HT × taux des lignes à code explicite.
function impliedTaxFromLineCodes(receipt, taxNameById) {
  const items = receipt.items || []
  let implied = 0, explicitCount = 0, followCount = 0, unknown = false
  for (const it of items) {
    const code = it && it.tax_code_id
    const ht = Number(it && it.total) || 0
    if (code == null || code === '') { followCount++; continue }
    explicitCount++
    let rate
    if (code === NO_TAX) rate = 0
    else {
      const name = taxNameById.get(code)
      rate = name != null ? TAX_RATE_BY_NAME.get(name) : undefined
    }
    if (rate == null) { unknown = true; continue }
    implied += ht * rate / 100
  }
  return {
    applicable: explicitCount > 0,
    allExplicit: explicitCount > 0 && followCount === 0,
    unknown,
    implied: round2(implied),
  }
}


function QBPublishForm({ receipt, onSuccess }) {
  const { addToast } = useToast()
  const [accounts, setAccounts] = useState([])
  const [vendors, setVendors] = useState([])
  const [taxCodes, setTaxCodes] = useState([])
  const [txTypes, setTxTypes] = useState([])
  const [vendorHistory, setVendorHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState(null)

  // Vérification du statut fiscal avant publication. transactionType détermine le
  // code de taxe QB attendu (cf. server/services/fiscalStatus.js). showConfirm ouvre
  // la modale récapitulative ; forceReason = justification pour publier malgré un écart.
  const [transactionType, setTransactionType] = useState('')
  const [showConfirm, setShowConfirm] = useState(false)
  const [forceReason, setForceReason] = useState('')

  const [type, setType] = useState('purchase')
  const [expenseAccountId, setExpenseAccountId] = useState('')
  const [paymentAccountId, setPaymentAccountId] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [vendorMode, setVendorMode] = useState('existing')
  const [vendorId, setVendorId] = useState('')
  const [newVendorName, setNewVendorName] = useState(receipt.company || '')
  const [taxCodeId, setTaxCodeId] = useState(NO_TAX)

  // Pré-remplissage auto depuis la dernière compta du même fournisseur.
  // autoAppliedRef : applique une seule fois ; userTouchedRef : ne jamais écraser
  // une édition manuelle de type/dépense/paiement ; autoAppliedFrom : txn source (note).
  const autoAppliedRef = useRef(false)
  const userTouchedRef = useRef(false)
  const [autoAppliedFrom, setAutoAppliedFrom] = useState(null)
  const markTouched = fn => v => { userTouchedRef.current = true; fn(v) }

  useEffect(() => {
    Promise.all([api.quickbooks.accounts(), api.quickbooks.vendors(), api.quickbooks.taxCodes(), api.saleReceipts.transactionTypes()])
      .then(([accs, vends, codes, types]) => {
        setAccounts(accs)
        setVendors(vends)
        setTaxCodes(codes)
        setTxTypes(types.data || [])
        // Type de transaction : choix confirmé déjà en DB sinon suggestion serveur.
        // L'utilisateur doit toujours confirmer (champ obligatoire à la publication).
        setTransactionType(receipt.transaction_type || receipt.suggested_transaction_type || '')
        if (receipt.company) {
          // Rapproche le fournisseur extrait d'un vendor QB existant (match exact
          // OU normalisé/flou) AVANT de proposer d'en créer un nouveau — évite les
          // doublons (« Amazon.com.ca ULC » vs vendor « Amazon » déjà au plan).
          const match = findBestVendorMatch(receipt.company, vends)
          if (match) { setVendorId(match.Id); setVendorMode('existing') }
          else setVendorMode('new')
        }
        // Présélection du code de taxe : le code par défaut du document (choisi dans la
        // section Montants) prime ; sinon la déduction automatique par les montants TPS/TVQ.
        if (receipt.tax_code_id) {
          setTaxCodeId(receipt.tax_code_id)
        } else {
          const wantName = deducedTaxName(receipt.tps || 0, receipt.tvq || 0)
          const taxMatch = wantName && codes.find(c => c.Name === wantName)
          if (taxMatch) setTaxCodeId(taxMatch.Id)
        }
      })
      .catch(() => setError('Impossible de charger les données QuickBooks'))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Transactions passées du même fournisseur déjà comptabilisées — rechargées si
  // le nom du fournisseur change.
  useEffect(() => {
    let cancelled = false
    api.saleReceipts.vendorHistory(receipt.id)
      .then(r => { if (!cancelled) setVendorHistory(r.data || []) })
      .catch(() => { if (!cancelled) setVendorHistory([]) })
    return () => { cancelled = true }
  }, [receipt.id, receipt.company])

  // Applique les réglages de comptabilisation d'une transaction passée.
  // withTax=true (bouton « Utiliser » manuel) copie aussi le code de taxe + toast ;
  // withTax=false (auto-apply silencieux) laisse la déduction TPS/TVQ du reçu courant.
  function applyAccountingFields(txn, { withTax } = { withTax: true }) {
    setType(txn.quickbooks_type === 'bill' ? 'bill' : 'purchase')
    if (txn.expense_account_id) setExpenseAccountId(txn.expense_account_id)
    if (txn.payment_account_id) setPaymentAccountId(txn.payment_account_id)
    if (withTax) {
      setTaxCodeId(txn.tax_code_id || NO_TAX)
      if (txn.transaction_type) setTransactionType(txn.transaction_type)
      setError(null)
      addToast({ message: 'Réglages copiés depuis la transaction passée — vérifiez puis publiez.', type: 'success' })
    }
  }

  // Auto-pré-sélection au chargement : reprend type/compte de dépense/compte de
  // paiement de la dernière transaction comptabilisée du même fournisseur. Ne touche
  // ni au fournisseur ni au code de taxe (gérés par l'effet QB ci-dessus). Une seule
  // fois, jamais sur un reçu déjà publié, jamais après une édition manuelle.
  useEffect(() => {
    if (loading || autoAppliedRef.current || userTouchedRef.current) return
    if (receipt.quickbooks_id || vendorHistory.length === 0) return
    const txn = vendorHistory[0] // route triée récent → ancien
    if (!txn.expense_account_id) return
    applyAccountingFields(txn, { withTax: false })
    autoAppliedRef.current = true
    setAutoAppliedFrom(txn)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, vendorHistory])

  const expenseAccounts = accounts.filter(a => ['Expense', 'Other Expense', 'Cost of Goods Sold', 'Other Current Asset'].includes(a.AccountType))
  const paymentAccounts = accounts.filter(a => ['Bank', 'Credit Card'].includes(a.AccountType))
  const accountLabel = a => (a.AcctNum ? `${a.AcctNum} — ${a.Name}` : a.Name)
  const vendorOptions  = vendors.map(v => ({ value: v.Id, label: v.DisplayName }))
  const expenseOptions = expenseAccounts.map(a => ({ value: a.Id, label: accountLabel(a) }))
  const paymentOptions = paymentAccounts.map(a => ({ value: a.Id, label: `${accountLabel(a)} (${a.AccountType})` }))
  const taxCodeOptions = [{ value: NO_TAX, label: '— Aucune taxe —' }, ...taxCodes.map(c => ({ value: c.Id, label: c.Name }))]
  const accountById = new Map(accounts.map(a => [a.Id, a]))
  const taxNameById = new Map(taxCodes.map(c => [c.Id, c.Name]))
  const taxIdByName = new Map(taxCodes.map(c => [c.Name, c.Id]))

  // ── Vérification du statut fiscal (live) ──────────────────────────────────────
  // Type de transaction « achat »/« both » en tête (la section comptabilise des
  // dépenses), ventes ensuite, avec un séparateur de libellé.
  const txTypeOptions = [...txTypes]
    .sort((a, b) => (a.side === 'vente' ? 1 : 0) - (b.side === 'vente' ? 1 : 0))
    .map(t => ({ value: t.key, label: t.side === 'vente' ? `Vente · ${t.label}` : t.label }))
  const selectedType = txTypes.find(t => t.key === transactionType) || null
  const selectedTaxName = taxCodeId === NO_TAX ? null : (taxNameById.get(taxCodeId) || null)
  const fiscalOk = selectedType ? (!!selectedTaxName && selectedType.codes.includes(selectedTaxName)) : false
  // Id QB du code recommandé pour le bouton « Corriger » (null si absent du fichier QB).
  const recommendedCodeId = selectedType ? (taxIdByName.get(selectedType.recommendedCode) || null) : null

  // Clic sur « Publier » : on valide les champs, puis on publie. Si le statut fiscal
  // est conforme (fiscalOk), la publication part DIRECTEMENT — pas d'étape de
  // confirmation. En cas d'ÉCART fiscal, on ouvre la modale : c'est le seul endroit où
  // l'utilisateur peut corriger le code de taxe ou saisir une justification (le serveur
  // BLOQUE la publication sans forceReason — cf. services/fiscalStatus.js), donc on ne
  // peut pas la sauter.
  function handlePublish() {
    if (receipt.receipt_date) {
      const today = new Date(); today.setHours(0, 0, 0, 0)
      const [y, m, d] = receipt.receipt_date.slice(0, 10).split('-').map(Number)
      const rDate = new Date(y, (m || 1) - 1, d || 1)
      const diffDays = Math.round((today - rDate) / 86400000)
      if (diffDays < 0) { setError('Impossible de publier une facture datée dans le futur.'); return }
      if (diffDays > 30) { setError(`Impossible de publier une facture datée de plus de 30 jours dans le passé (${diffDays} jours).`); return }
    }
    if (!transactionType) { setError('Sélectionnez le type de transaction (statut fiscal)'); return }
    if (!expenseAccountId) { setError('Sélectionnez un compte de dépense'); return }
    if (type === 'purchase' && !paymentAccountId) { setError('Sélectionnez un compte de paiement'); return }
    if (vendorMode === 'existing' && !vendorId) { setError('Sélectionnez un fournisseur'); return }
    if (vendorMode === 'new' && !newVendorName.trim()) { setError('Entrez le nom du fournisseur'); return }
    setError(null)
    if (fiscalOk) { doPublish(); return }
    setForceReason('')
    setShowConfirm(true)
  }

  // Étape 2 : publication effective. forceReason n'est transmis (et requis) que si le
  // code de taxe ne correspond pas au statut fiscal attendu — échappatoire tracée.
  async function doPublish() {
    setSubmitting(true)
    setError(null)
    try {
      await api.saleReceipts.pushToQb(receipt.id, {
        type,
        expenseAccountId,
        paymentAccountId: type === 'purchase' ? paymentAccountId : undefined,
        vendorId: vendorMode === 'existing' ? vendorId : undefined,
        newVendorName: vendorMode === 'new' ? newVendorName.trim() : undefined,
        dueDate: type === 'bill' && dueDate ? dueDate : undefined,
        taxCodeId: taxCodeId === NO_TAX ? null : taxCodeId,
        transactionType,
        forceReason: fiscalOk ? undefined : forceReason.trim(),
      })
      setShowConfirm(false)
      const updated = await api.saleReceipts.get(receipt.id)
      onSuccess(updated)
    } catch (e) {
      setError(e.message)
      setShowConfirm(false)
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-slate-400 text-sm mt-3 py-2">
        <RefreshCw size={14} className="animate-spin" /> Chargement des comptes QuickBooks…
      </div>
    )
  }

  return (
    <div className="mt-3 border border-green-200 bg-green-50 rounded-xl p-4 space-y-4">
      <div>
        <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">Type</label>
        <div className="flex gap-4">
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input type="radio" data-testid="qb-type-purchase" checked={type === 'purchase'} onChange={() => markTouched(setType)('purchase')} />
            <span>Dépense payée (Purchase)</span>
          </label>
          <label className="flex items-center gap-1.5 text-xs cursor-pointer">
            <input type="radio" data-testid="qb-type-bill" checked={type === 'bill'} onChange={() => markTouched(setType)('bill')} />
            <span>Facture à payer (Bill → Comptes fournisseurs)</span>
          </label>
        </div>
        {autoAppliedFrom && !userTouchedRef.current && (
          <p data-testid="qb-prefill-note" className="text-[11px] text-brand-700 bg-brand-50 border border-brand-100 rounded px-2 py-1 mt-1.5 leading-snug">
            Pré-rempli depuis la dernière compta de ce fournisseur{autoAppliedFrom.receipt_date ? ` — ${fmtDate(autoAppliedFrom.receipt_date)}` : ''}. Vérifiez puis publiez.
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4">
        <div>
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">Fournisseur</label>
          <div className="flex gap-3 mb-1.5">
            <label className="flex items-center gap-1 text-xs cursor-pointer">
              <input type="radio" checked={vendorMode === 'existing'} onChange={() => setVendorMode('existing')} /> Existant
            </label>
            <label className="flex items-center gap-1 text-xs cursor-pointer">
              <input type="radio" checked={vendorMode === 'new'} onChange={() => setVendorMode('new')} /> Nouveau
            </label>
          </div>
          {vendorMode === 'existing' ? (
            <SearchableSelect
              testId="qb-vendor-select"
              value={vendorId}
              options={vendorOptions}
              onChange={setVendorId}
              placeholder="— Aucun —"
            />
          ) : (
            <input type="text" placeholder="Nom du fournisseur" value={newVendorName} onChange={e => setNewVendorName(e.target.value)} className="input-field text-xs w-full" />
          )}
        </div>

        <div>
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">Compte de dépense</label>
          <SearchableSelect
            testId="qb-expense-select"
            value={expenseAccountId}
            options={expenseOptions}
            onChange={markTouched(setExpenseAccountId)}
            placeholder="— Sélectionner —"
          />
        </div>

        {type === 'purchase' ? (
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">Compte de paiement</label>
            <SearchableSelect
              testId="qb-payment-select"
              value={paymentAccountId}
              options={paymentOptions}
              onChange={markTouched(setPaymentAccountId)}
              placeholder="— Sélectionner —"
            />
          </div>
        ) : (
          <div>
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">Échéance</label>
            <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} className="input-field text-xs w-full" />
            <p className="text-[11px] text-slate-500 mt-1.5 leading-snug">
              Le crédit est posté automatiquement au compte <strong>Comptes fournisseurs</strong> du vendor — aucun compte de paiement à choisir.
            </p>
          </div>
        )}

        <div>
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">
            Type de transaction <span className="text-red-500">*</span>
          </label>
          <SearchableSelect
            testId="qb-txtype-select"
            value={transactionType}
            options={txTypeOptions}
            onChange={setTransactionType}
            placeholder="— Sélectionner le statut fiscal —"
          />
          {!transactionType && (
            <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-1.5 leading-snug" data-testid="qb-txtype-missing">
              Obligatoire — détermine le statut fiscal et le code de taxe attendu.
            </p>
          )}
          {selectedType && (
            <div className="text-[11px] mt-1.5 leading-snug bg-white border border-slate-200 rounded px-2 py-1.5" data-testid="qb-fiscal-expected">
              <span className="text-slate-500">Statut fiscal attendu : </span>
              <strong className="text-slate-700">{selectedType.statusLabel}</strong>
              <span className="text-slate-500"> → code QB </span>
              <strong className="text-slate-700">« {selectedType.recommendedCode} »</strong>
              {selectedType.note && <span className="block text-slate-400 mt-0.5">{selectedType.note}</span>}
            </div>
          )}
        </div>

        <div>
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wide block mb-1.5">Code de taxe</label>
          <SearchableSelect
            testId="qb-taxcode-select"
            value={taxCodeId}
            options={taxCodeOptions}
            onChange={setTaxCodeId}
            placeholder="— Aucune taxe —"
          />
          {selectedType ? (
            fiscalOk ? (
              <p className="text-[11px] text-green-700 bg-green-100 rounded px-2 py-1 mt-1.5 leading-snug flex items-center gap-1" data-testid="qb-fiscal-ok">
                <CheckCircle size={11} /> Conforme au statut fiscal « {selectedType.statusLabel} ».
              </p>
            ) : (
              <p className="text-[11px] text-red-700 bg-red-100 rounded px-2 py-1 mt-1.5 leading-snug flex items-center gap-1" data-testid="qb-fiscal-mismatch">
                <AlertCircle size={11} /> Écart : « {selectedType.label} » attend « {selectedType.recommendedCode} », pas « {selectedTaxName || 'Aucune taxe'} ».
              </p>
            )
          ) : (
            <p className="text-[11px] text-slate-500 mt-1.5 leading-snug">
              Présélectionné d'après les montants TPS/TVQ — changez-le au besoin (ex. <strong>TPS/TVQ repas</strong>, <strong>TPS/TVQ kilométrage</strong>).
            </p>
          )}
        </div>
      </div>

      {error && <p className="text-xs text-red-600 bg-red-100 rounded-lg px-3 py-2">{error}</p>}

      <div className="flex gap-2">
        <button className="btn-primary text-xs py-1.5 px-3" data-testid="qb-publish-open" onClick={handlePublish} disabled={submitting}>
          <BookOpen size={12} /> {submitting ? 'Publication…' : 'Publier sur QuickBooks'}
        </button>
      </div>

      {vendorHistory.length > 0 && (
        <div className="border-t border-green-200 pt-3" data-testid="vendor-history">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">
            Déjà comptabilisé pour « {receipt.company} »
          </p>
          <ul className="space-y-1.5">
            {vendorHistory.map(txn => {
              const acc = txn.expense_account_id ? accountById.get(txn.expense_account_id) : null
              const taxName = txn.tax_code_id ? taxNameById.get(txn.tax_code_id) : null
              return (
                <li key={txn.id} className="flex items-center gap-2 text-xs bg-white border border-slate-200 rounded-lg px-2.5 py-1.5">
                  <span className="text-slate-500 w-24 shrink-0">{txn.receipt_date ? fmtDate(txn.receipt_date) : '—'}</span>
                  <span className="tabular-nums font-medium text-slate-700 w-20 shrink-0 text-right">{fmtCad(txn.total)}</span>
                  <span className={`shrink-0 px-1.5 py-0.5 rounded-full ${txn.quickbooks_type === 'bill' ? 'bg-purple-100 text-purple-700' : 'bg-blue-100 text-blue-700'}`}>
                    {txn.quickbooks_type === 'bill' ? 'Facture' : 'Dépense'}
                  </span>
                  <span className="text-slate-500 truncate flex-1 min-w-0" title={acc ? accountLabel(acc) : ''}>
                    {acc ? accountLabel(acc) : <span className="text-slate-300">compte non enregistré</span>}
                    {taxName && <span className="text-slate-400"> · {taxName}</span>}
                  </span>
                  {txn.quickbooks_url && (
                    <a href={txn.quickbooks_url} target="_blank" rel="noopener noreferrer" className="shrink-0 text-green-700 hover:text-green-800" title="Voir dans QuickBooks">
                      <BookOpen size={12} />
                    </a>
                  )}
                  <Link to={`/sale-receipts/${txn.id}`} className="shrink-0 text-slate-400 hover:text-slate-600" title="Ouvrir le reçu">
                    <ReceiptText size={12} />
                  </Link>
                  {acc && (
                    <button
                      type="button"
                      onClick={() => { userTouchedRef.current = true; applyAccountingFields(txn, { withTax: true }) }}
                      data-testid="use-template"
                      className="shrink-0 text-[11px] font-medium text-brand-700 bg-brand-50 hover:bg-brand-100 border border-brand-200 rounded px-2 py-0.5"
                    >
                      Utiliser
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
          <p className="text-[11px] text-slate-400 mt-1.5">« Utiliser » copie le type, le compte de dépense et le code de taxe dans le formulaire ci-dessus.</p>
        </div>
      )}

      <Modal isOpen={showConfirm} onClose={() => !submitting && setShowConfirm(false)} title="Confirmer la publication sur QuickBooks" size="lg">
        <div className="space-y-4 text-sm" data-testid="qb-confirm-modal">
          <div>
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Ce qui va se passer</p>
            <ul className="space-y-1.5 text-slate-700 text-[13px]">
              <li className="flex gap-2"><span className="text-slate-400">•</span>
                {type === 'bill'
                  ? <span>Une <strong>facture fournisseur (Bill)</strong> sera créée dans QuickBooks (compte fournisseurs).</span>
                  : <span>Une <strong>dépense (Purchase)</strong> sera enregistrée dans QuickBooks.</span>}
              </li>
              {vendorMode === 'new' && newVendorName.trim() && (
                <li className="flex gap-2"><span className="text-slate-400">•</span>
                  <span>Un <strong>nouveau fournisseur</strong> « {newVendorName.trim()} » sera créé dans QuickBooks.</span></li>
              )}
              <li className="flex gap-2"><span className="text-slate-400">•</span>
                <span>Montant : <strong className="tabular-nums">{fmtCad(receipt.total)}</strong>{receipt.currency && receipt.currency !== 'CAD' ? ` (${receipt.currency})` : ''}.</span></li>
              <li className="flex gap-2"><span className="text-slate-400">•</span>
                <span>La <strong>pièce justificative</strong> (image/PDF) sera jointe à la transaction.</span></li>
            </ul>
          </div>

          <div className="border-t border-slate-200 pt-3">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Vérification du statut fiscal</p>
            <div className="text-[13px] text-slate-700 space-y-0.5">
              <div>Type : <strong>{selectedType?.label || '—'}</strong></div>
              <div>Statut attendu : <strong>{selectedType?.statusLabel || '—'}</strong> → code QB <strong>« {selectedType?.recommendedCode || '—'} »</strong></div>
              <div>Code sélectionné : <strong>« {selectedTaxName || 'Aucune taxe'} »</strong></div>
            </div>

            {fiscalOk ? (
              <p className="text-[13px] text-green-700 bg-green-100 rounded-lg px-3 py-2 mt-2 flex items-center gap-1.5" data-testid="qb-confirm-fiscal-ok">
                <CheckCircle size={14} /> Le code de taxe correspond au statut fiscal attendu.
              </p>
            ) : (
              <div className="mt-2 space-y-2" data-testid="qb-confirm-fiscal-mismatch">
                <p className="text-[13px] text-red-700 bg-red-100 rounded-lg px-3 py-2 flex items-start gap-1.5">
                  <AlertCircle size={14} className="mt-0.5 shrink-0" />
                  <span>Écart : ce type de transaction attend <strong>« {selectedType?.recommendedCode} »</strong>, mais le code sélectionné est <strong>« {selectedTaxName || 'Aucune taxe'} »</strong>. Corrigez le code, ou justifiez pour forcer la publication.</span>
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    data-testid="qb-fiscal-correct"
                    disabled={!recommendedCodeId}
                    onClick={() => { if (recommendedCodeId) setTaxCodeId(recommendedCodeId) }}
                    className="text-xs font-medium text-green-700 bg-green-50 hover:bg-green-100 border border-green-300 rounded px-2.5 py-1 disabled:opacity-50"
                  >
                    Corriger → utiliser « {selectedType?.recommendedCode} »
                  </button>
                </div>
                <div>
                  <label className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide block mb-1">Justification pour forcer (obligatoire)</label>
                  <textarea
                    data-testid="qb-force-reason"
                    value={forceReason}
                    onChange={e => setForceReason(e.target.value)}
                    rows={2}
                    placeholder="Ex. cas particulier hors-Sheet, fournisseur avec régime spécifique…"
                    className="input-field text-xs w-full"
                  />
                </div>
              </div>
            )}
          </div>

          {error && <p className="text-xs text-red-600 bg-red-100 rounded-lg px-3 py-2">{error}</p>}

          <div className="flex justify-end gap-2 border-t border-slate-200 pt-3">
            <button type="button" className="btn-secondary text-xs py-1.5 px-3" onClick={() => setShowConfirm(false)} disabled={submitting}>Annuler</button>
            <button
              type="button"
              data-testid="qb-confirm-publish"
              className="btn-primary text-xs py-1.5 px-3"
              disabled={submitting || (!fiscalOk && !forceReason.trim())}
              onClick={doPublish}
            >
              {submitting ? <><RefreshCw size={12} className="animate-spin" /> Publication…</> : <><BookOpen size={12} /> {fiscalOk ? 'Confirmer et publier' : 'Forcer la publication'}</>}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}

function CurrencyField({ receipt, onUpdate }) {
  const { addToast } = useToast()
  const [value, setValue] = useState(receipt.currency || '')
  const [saving, setSaving] = useState(false)

  useEffect(() => { setValue(receipt.currency || '') }, [receipt.id, receipt.currency])

  async function commit(next) {
    const normalized = (next || '').trim().toUpperCase() || null
    if (normalized === (receipt.currency || null)) return
    setSaving(true)
    try {
      const updated = await api.saleReceipts.update(receipt.id, { currency: normalized })
      onUpdate?.(updated)
    } catch (e) {
      addToast({ message: 'Erreur: ' + e.message, type: 'error' })
      setValue(receipt.currency || '')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <p className="text-xs text-slate-400 uppercase tracking-wide font-medium">Devise</p>
      <div className="flex items-center gap-2 mt-0.5">
        <select
          className="input-field text-sm py-1 px-2"
          data-testid="receipt-currency"
          value={value}
          onChange={e => { setValue(e.target.value); commit(e.target.value) }}
          disabled={saving}
        >
          <option value="">—</option>
          <option value="CAD">CAD</option>
          <option value="USD">USD</option>
          <option value="EUR">EUR</option>
        </select>
        {saving && <RefreshCw size={12} className="animate-spin text-slate-400" />}
      </div>
    </div>
  )
}

function InfoField({ label, value }) {
  return (
    <div>
      <p className="text-xs text-slate-400 uppercase tracking-wide font-medium">{label}</p>
      <p className="text-sm text-slate-700 mt-0.5">{value || <span className="text-slate-300">—</span>}</p>
    </div>
  )
}

function EditableDateField({ receipt, field, label, onUpdate, testId }) {
  const { addToast } = useToast()
  // Normalise vers YYYY-MM-DD pour l'input type=date (la valeur peut arriver en ISO complet).
  const toDateInput = v => (v ? String(v).slice(0, 10) : '')
  // Affichage lisible (« 31 déc. 2025 ») par défaut ; on bascule sur l'input type=date
  // — qui, lui, rend l'ISO YYYY-MM-DD natif du navigateur — uniquement à l'édition.
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(toDateInput(receipt[field]))
  const [saving, setSaving] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => { setValue(toDateInput(receipt[field])) }, [receipt.id, receipt[field], field])
  useEffect(() => { if (editing) inputRef.current?.focus() }, [editing])

  async function commit(next) {
    const normalized = next || null
    if (normalized === (toDateInput(receipt[field]) || null)) return
    setSaving(true)
    try {
      const updated = await api.saleReceipts.update(receipt.id, { [field]: normalized })
      onUpdate?.(updated)
    } catch (e) {
      addToast({ message: 'Erreur: ' + e.message, type: 'error' })
      setValue(toDateInput(receipt[field]))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <p className="text-xs text-slate-400 uppercase tracking-wide font-medium">{label}</p>
      <div className="flex items-center gap-1 mt-0.5">
        {editing ? (
          <input
            ref={inputRef}
            type="date"
            data-testid={testId}
            value={value}
            onChange={e => { setValue(e.target.value); commit(e.target.value) }}
            onBlur={() => setEditing(false)}
            disabled={saving}
            className="text-sm text-slate-700 bg-transparent border border-transparent hover:border-slate-300 focus:border-brand-500 focus:bg-white rounded px-2 py-0.5 -ml-2 outline-none"
          />
        ) : (
          <button
            type="button"
            data-testid={testId ? `${testId}-display` : undefined}
            onClick={() => setEditing(true)}
            className="text-sm text-slate-700 hover:bg-slate-100 rounded px-2 py-0.5 -ml-2 text-left outline-none"
          >
            {receipt[field] ? fmtDate(receipt[field]) : <span className="text-slate-300">—</span>}
          </button>
        )}
        {saving && <RefreshCw size={11} className="animate-spin text-slate-400 flex-shrink-0" />}
      </div>
    </div>
  )
}

function EditableTextField({ receipt, field, label, placeholder, onUpdate, testId }) {
  const { addToast } = useToast()
  const [value, setValue] = useState(receipt[field] || '')
  const [saving, setSaving] = useState(false)

  useEffect(() => { setValue(receipt[field] || '') }, [receipt.id, receipt[field], field])

  async function commit() {
    const normalized = value.trim() || null
    if (normalized === (receipt[field] || null)) return
    setSaving(true)
    try {
      const updated = await api.saleReceipts.update(receipt.id, { [field]: normalized })
      onUpdate?.(updated)
    } catch (e) {
      addToast({ message: 'Erreur: ' + e.message, type: 'error' })
      setValue(receipt[field] || '')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <p className="text-xs text-slate-400 uppercase tracking-wide font-medium">{label}</p>
      <div className="flex items-center gap-1 mt-0.5">
        <input
          type="text"
          data-testid={testId}
          value={value}
          onChange={e => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
          placeholder={placeholder || '—'}
          disabled={saving}
          className="w-full text-sm text-slate-700 bg-transparent border border-transparent hover:border-slate-300 focus:border-brand-500 focus:bg-white rounded px-2 py-0.5 -ml-2 outline-none"
        />
        {saving && <RefreshCw size={11} className="animate-spin text-slate-400 flex-shrink-0" />}
      </div>
    </div>
  )
}

function EditableMemoField({ receipt, onUpdate }) {
  const { addToast } = useToast()
  const [desc, setDesc] = useState(receipt.general_description || '')
  const [memo, setMemo] = useState(receipt.memo || '')
  const [savingDesc, setSavingDesc] = useState(false)
  const [savingMemo, setSavingMemo] = useState(false)

  useEffect(() => { setDesc(receipt.general_description || '') }, [receipt.id, receipt.general_description])
  useEffect(() => { setMemo(receipt.memo || '') }, [receipt.id, receipt.memo])

  async function commitField(field, value, current, setSaving, reset) {
    const normalized = value.trim() || null
    if (normalized === (current || null)) return
    setSaving(true)
    try {
      const updated = await api.saleReceipts.update(receipt.id, { [field]: normalized })
      onUpdate?.(updated)
    } catch (e) {
      addToast({ message: 'Erreur: ' + e.message, type: 'error' })
      reset()
    } finally {
      setSaving(false)
    }
  }

  // Aperçu de ce qui partira dans le champ « Memo » de QuickBooks : la note perso
  // éventuelle, puis la description générale. Plus jamais la liste des articles.
  const memoPreview = [memo.trim(), desc.trim()].filter(Boolean).join('\n')

  return (
    <div className="space-y-4">
      <div>
        <div className="flex items-baseline justify-between mb-2">
          <h3 className="text-sm font-semibold text-slate-700">Description principale</h3>
          {savingDesc && <RefreshCw size={11} className="animate-spin text-slate-400" />}
        </div>
        <input
          data-testid="receipt-general-description"
          type="text"
          value={desc}
          onChange={e => setDesc(e.target.value)}
          onBlur={() => commitField('general_description', desc, receipt.general_description, setSavingDesc, () => setDesc(receipt.general_description || ''))}
          placeholder="Objet principal de la facture (ex. « Pièces de plomberie »)"
          disabled={savingDesc}
          className="w-full text-sm text-slate-700 bg-white border border-slate-300 hover:border-slate-400 focus:border-brand-500 rounded px-3 py-2 outline-none placeholder:text-slate-300"
        />
        <p className="text-[11px] text-slate-400 mt-1.5 leading-snug">
          Envoyée comme « Memo » dans QuickBooks. Le détail des articles reste sur les lignes de la transaction, mais n'encombre plus le mémo.
        </p>
      </div>

      <div>
        <div className="flex items-baseline justify-between mb-2">
          <h3 className="text-sm font-semibold text-slate-700">Note personnalisée (optionnel)</h3>
          {savingMemo && <RefreshCw size={11} className="animate-spin text-slate-400" />}
        </div>
        <textarea
          data-testid="receipt-memo"
          value={memo}
          onChange={e => setMemo(e.target.value)}
          onBlur={() => commitField('memo', memo, receipt.memo, setSavingMemo, () => setMemo(receipt.memo || ''))}
          rows={2}
          placeholder="Note ajoutée en tête du mémo QuickBooks (avant la description principale)"
          disabled={savingMemo}
          className="w-full text-sm text-slate-700 bg-white border border-slate-300 hover:border-slate-400 focus:border-brand-500 rounded px-3 py-2 outline-none resize-y placeholder:text-slate-300 whitespace-pre-wrap"
        />
        {memoPreview && (
          <p className="text-[11px] text-slate-400 mt-1.5 leading-snug whitespace-pre-wrap">
            Mémo QuickBooks : <span className="text-slate-500">{memoPreview}</span>
          </p>
        )}
      </div>
    </div>
  )
}

function TotalRow({ label, value, bold }) {
  return (
    <div className="flex justify-between items-center">
      <span className={`text-sm ${bold ? 'font-semibold text-slate-800' : 'text-slate-600'}`}>{label}</span>
      <span className={`tabular-nums text-sm ${bold ? 'font-bold text-slate-900 text-base' : 'text-slate-700'}`}>
        {value != null ? fmtCad(value) : '—'}
      </span>
    </div>
  )
}

function EditableItems({ receipt, onUpdate, taxCodes = [] }) {
  const { addToast } = useToast()
  const [items, setItems] = useState(receipt.items || [])
  const [saving, setSaving] = useState(false)
  const initialJsonRef = useRef(JSON.stringify(receipt.items || []))

  // Sync depuis le serveur uniquement quand on change de reçu — sinon les
  // updates optimistes locaux (ajout/suppression/édition en cours) seraient
  // écrasés par le re-render qui suit le PATCH.
  useEffect(() => {
    setItems(receipt.items || [])
    initialJsonRef.current = JSON.stringify(receipt.items || [])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [receipt.id])

  function parseNum(x) {
    if (x === '' || x == null) return null
    const n = Number(String(x).replace(',', '.'))
    return Number.isFinite(n) && n >= 0 ? n : null
  }

  function normalizeItems(list) {
    return list.map(it => ({
      description: it.description || '',
      total:       parseNum(it.total),
      tax_code_id: it.tax_code_id || null,
    }))
  }

  function updateItem(i, patch) {
    setItems(prev => prev.map((it, idx) => idx === i ? { ...it, ...patch } : it))
  }

  function removeItem(i) {
    setItems(prev => prev.filter((_, idx) => idx !== i))
  }

  function addItem() {
    setItems(prev => [...prev, { description: '', total: null, tax_code_id: null }])
  }

  // Sélection d'un code de taxe par ligne : persiste immédiatement (le SearchableSelect
  // n'émet pas de blur). On commit la liste calculée pour ne pas dépendre du setState async.
  function setTaxCode(i, val) {
    const next = items.map((it, idx) => idx === i ? { ...it, tax_code_id: val || null } : it)
    setItems(next)
    commit(next)
  }

  async function commit(list = items) {
    const normalized = normalizeItems(list)
    const nextJson = JSON.stringify(normalized)
    if (nextJson === initialJsonRef.current) return
    setSaving(true)
    try {
      // Cascade : le sous-total suit la somme des lignes. Si un code par défaut du
      // document est défini, les taxes sont recalculées à partir des codes (par ligne
      // + défaut) ; sinon elles gardent leur taux effectif (mise à l'échelle).
      const taxNameById = new Map((taxCodes || []).map(c => [c.Id, c.Name]))
      const payload = { items: normalized, ...recomputeAmounts(receipt, normalized, receipt.tax_code_id, taxNameById) }
      const updated = await api.saleReceipts.update(receipt.id, payload)
      onUpdate?.(updated)
      initialJsonRef.current = JSON.stringify(updated.items || [])
    } catch (e) {
      addToast({ message: 'Erreur: ' + e.message, type: 'error' })
      setItems(receipt.items || [])
    } finally {
      setSaving(false)
    }
  }

  // Sauvegarde à chaque suppression / ajout (la modification d'un champ texte
  // déclenche commit sur blur via l'input lui-même).
  useEffect(() => {
    const json = JSON.stringify(normalizeItems(items))
    if (json !== initialJsonRef.current && items.length !== (receipt.items || []).length) {
      commit()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length])

  // « Aucune taxe » (sentinel NO_TAX) en tête : force une ligne sans code de taxe,
  // distinct de « Code du document » (emptyOption) qui hérite du code global à la publication.
  // (Sans mention « exonéré » : Exonéré/Hors champ/Détaxé sont des codes QB distincts,
  // disponibles ci-dessous — à choisir explicitement si c'est le bon statut.)
  const taxCodeOptions = [
    { value: NO_TAX, label: '— Aucune taxe (sans code) —' },
    ...taxCodes.map(c => ({ value: c.Id, label: c.Name })),
  ]

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-sm font-semibold text-slate-700">Articles</h3>
        <div className="flex items-center gap-2">
          {saving && <RefreshCw size={12} className="animate-spin text-slate-400" />}
          <button
            type="button"
            onClick={addItem}
            data-testid="receipt-item-add"
            className="inline-flex items-center gap-1 px-2 py-1 text-xs text-brand-600 hover:bg-brand-50 rounded"
          >
            <Plus size={12} /> Ajouter une ligne
          </button>
        </div>
      </div>
      <div className="border border-slate-200 rounded-lg overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50">
            <tr>
              <th className="text-left px-3 py-2 text-slate-600 font-medium">Description</th>
              <th className="text-left px-3 py-2 text-slate-600 font-medium w-44">Code de taxe</th>
              <th className="text-right px-3 py-2 text-slate-600 font-medium w-28">Total</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.length === 0 && (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-center text-slate-400 text-xs">
                  Aucun article — cliquez « Ajouter une ligne ».
                </td>
              </tr>
            )}
            {items.map((item, i) => (
              <tr key={i} className="hover:bg-slate-50" data-testid={`receipt-item-row-${i}`}>
                <td className="px-1 py-1">
                  <input
                    type="text"
                    value={item.description || ''}
                    onChange={e => updateItem(i, { description: e.target.value })}
                    onBlur={() => commit()}
                    placeholder="Description"
                    className="w-full px-2 py-1 text-sm bg-transparent border border-transparent hover:border-slate-300 focus:border-brand-500 focus:bg-white rounded outline-none"
                  />
                </td>
                <td className="px-1 py-1">
                  <SearchableSelect
                    testId={`receipt-item-taxcode-${i}`}
                    value={item.tax_code_id || ''}
                    options={taxCodeOptions}
                    emptyOption="— Code du document —"
                    onChange={val => setTaxCode(i, val)}
                    placeholder="— Code du document —"
                  />
                </td>
                <td className="px-1 py-1">
                  <input
                    type="text"
                    inputMode="decimal"
                    value={item.total ?? ''}
                    onChange={e => updateItem(i, { total: e.target.value })}
                    onBlur={() => commit()}
                    placeholder="—"
                    className="w-full px-2 py-1 text-sm text-right tabular-nums font-medium bg-transparent border border-transparent hover:border-slate-300 focus:border-brand-500 focus:bg-white rounded outline-none"
                  />
                </td>
                <td className="px-1 py-1 text-center">
                  <button
                    type="button"
                    onClick={() => removeItem(i)}
                    data-testid={`receipt-item-remove-${i}`}
                    title="Supprimer cette ligne"
                    aria-label="Supprimer cette ligne"
                    className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded"
                  >
                    <Trash2 size={12} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-slate-400 mt-1.5 leading-snug">
        Laissez « Code du document » pour suivre le code de taxe global choisi à la publication.
        Choisissez un code par ligne pour les reçus mixtes (ex. pourboire <strong>Hors champ</strong> + repas <strong>TPS/TVQ repas</strong>).
      </p>
    </div>
  )
}

function EditableAmountRow({ receipt, field, label, bold, onUpdate, readOnly, hint }) {
  const { addToast } = useToast()
  const initial = receipt[field] != null ? String(receipt[field]) : ''
  const [value, setValue] = useState(initial)
  const [saving, setSaving] = useState(false)

  useEffect(() => { setValue(receipt[field] != null ? String(receipt[field]) : '') }, [receipt.id, receipt[field], field])

  // Champ dérivé (ex. sous-total = somme des lignes) : affichage seul, non éditable.
  if (readOnly) {
    const v = receipt[field]
    return (
      <div className="flex justify-between items-center gap-2">
        <span className={`text-sm ${bold ? 'font-semibold text-slate-800' : 'text-slate-600'}`}>
          {label}
          {hint && <span className="text-[11px] text-slate-400 ml-1">{hint}</span>}
        </span>
        <span
          data-testid={`receipt-amount-${field}`}
          className={`tabular-nums text-right px-2 py-0.5 w-28 text-sm ${bold ? 'font-bold text-slate-900 text-base' : 'text-slate-700'}`}
        >
          {v != null ? fmtCad(v) : '—'}
        </span>
      </div>
    )
  }

  async function commit() {
    const trimmed = value.trim()
    const parsed = trimmed === '' ? null : Number(trimmed.replace(',', '.'))
    if (parsed != null && (!Number.isFinite(parsed) || parsed < 0)) {
      addToast({ message: 'Montant invalide', type: 'error' })
      setValue(receipt[field] != null ? String(receipt[field]) : '')
      return
    }
    const current = receipt[field] ?? null
    if (parsed === current) return
    setSaving(true)
    try {
      // Pour un champ de montant (sous-total / taxes), recompose `total` dans le
      // même PATCH afin que « total = articles + taxes » reste vrai en DB.
      const patch = TOTAL_SYNC_FIELDS.has(field)
        ? withRecomputedTotal(receipt, { [field]: parsed })
        : { [field]: parsed }
      const updated = await api.saleReceipts.update(receipt.id, patch)
      onUpdate?.(updated)
    } catch (e) {
      addToast({ message: 'Erreur: ' + e.message, type: 'error' })
      setValue(receipt[field] != null ? String(receipt[field]) : '')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex justify-between items-center gap-2">
      <span className={`text-sm ${bold ? 'font-semibold text-slate-800' : 'text-slate-600'}`}>{label}</span>
      <div className="flex items-center gap-1">
        {saving && <RefreshCw size={11} className="animate-spin text-slate-400" />}
        <input
          type="text"
          inputMode="decimal"
          data-testid={`receipt-amount-${field}`}
          value={value}
          onChange={e => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
          placeholder="—"
          disabled={saving}
          className={`tabular-nums text-right bg-transparent border border-transparent hover:border-slate-300 focus:border-brand-500 focus:bg-white rounded px-2 py-0.5 w-28 text-sm outline-none ${
            bold ? 'font-bold text-slate-900 text-base' : 'text-slate-700'
          }`}
        />
      </div>
    </div>
  )
}

// Recalcule sous-total / taxes / total à partir des lignes d'articles.
// - Le sous-total devient la somme des totaux de lignes.
// - Les taxes conservent leur taux effectif actuel : chaque composante est mise
//   à l'échelle par le ratio (nouveau sous-total / ancien sous-total). Ça préserve
//   les cas particuliers (TPS seule, taux mixte, partiellement exonéré, 0 taxe).
// - Le total = sous-total + taxes.
// Si aucune ligne ne porte de montant, on ne touche à rien (objet vide).
// Si l'ancien sous-total est nul/absent, on ne peut pas déduire de taux : les
// taxes existantes sont laissées telles quelles.
function recalcAmountsFromItems(items, receipt) {
  const lineTotals = items.map(it => it.total).filter(n => n != null)
  if (lineTotals.length === 0) return {}
  const r = x => Math.round(x * 100) / 100
  const newSubtotal = r(lineTotals.reduce((a, b) => a + b, 0))
  const oldSubtotal = receipt.subtotal || 0
  let tps = receipt.tps || 0, tvq = receipt.tvq || 0, other = receipt.other_taxes || 0
  if (oldSubtotal > 0) {
    const f = newSubtotal / oldSubtotal
    tps = r(tps * f); tvq = r(tvq * f); other = r(other * f)
  }
  return {
    subtotal: newSubtotal,
    tps, tvq, other_taxes: other,
    total: r(newSubtotal + tps + tvq + other),
  }
}

// Répartit un total de taxes sur TPS / TVQ / Autres taxes au prorata des valeurs
// actuelles. Sans ventilation existante (tout à 0), applique les taux du Québec
// (TPS 5 % / TVQ 9,975 %). L'écart d'arrondi est reporté sur la plus grosse part.
function splitTaxTotal(newTotal, { tps = 0, tvq = 0, other_taxes = 0 }) {
  const t = tps || 0, v = tvq || 0, o = other_taxes || 0
  const sum = t + v + o
  let parts
  if (sum > 0) {
    parts = { tps: newTotal * t / sum, tvq: newTotal * v / sum, other_taxes: newTotal * o / sum }
  } else {
    const RT = 5, RV = 9.975
    parts = { tps: newTotal * RT / (RT + RV), tvq: newTotal * RV / (RT + RV), other_taxes: 0 }
  }
  const r = x => Math.round(x * 100) / 100
  const rounded = { tps: r(parts.tps), tvq: r(parts.tvq), other_taxes: r(parts.other_taxes) }
  const diff = r(newTotal - (rounded.tps + rounded.tvq + rounded.other_taxes))
  if (diff !== 0) {
    const k = ['tps', 'tvq', 'other_taxes'].reduce((a, b) => (rounded[b] >= rounded[a] ? b : a))
    rounded[k] = r(rounded[k] + diff)
  }
  return rounded
}

function EditableTotalTaxesRow({ receipt, onUpdate }) {
  const { addToast } = useToast()
  const currentTotal = Math.round(((receipt.tps || 0) + (receipt.tvq || 0) + (receipt.other_taxes || 0)) * 100) / 100
  const [value, setValue] = useState(currentTotal ? String(currentTotal) : '')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    const ct = Math.round(((receipt.tps || 0) + (receipt.tvq || 0) + (receipt.other_taxes || 0)) * 100) / 100
    setValue(ct ? String(ct) : '')
  }, [receipt.id, receipt.tps, receipt.tvq, receipt.other_taxes])

  async function commit() {
    const trimmed = value.trim()
    const parsed = trimmed === '' ? 0 : Number(trimmed.replace(',', '.'))
    if (!Number.isFinite(parsed) || parsed < 0) {
      addToast({ message: 'Montant invalide', type: 'error' })
      setValue(currentTotal ? String(currentTotal) : '')
      return
    }
    if (Math.round(parsed * 100) === Math.round(currentTotal * 100)) return
    const parts = splitTaxTotal(parsed, receipt)
    setSaving(true)
    try {
      // Le total des taxes change → le total global suit (sous-total + nouvelles taxes).
      const updated = await api.saleReceipts.update(receipt.id, withRecomputedTotal(receipt, parts))
      onUpdate?.(updated)
    } catch (e) {
      addToast({ message: 'Erreur: ' + e.message, type: 'error' })
      setValue(currentTotal ? String(currentTotal) : '')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex justify-between items-center gap-2 border-t border-slate-200 pt-2 mt-2">
      <span className="text-sm text-slate-600">Total des taxes</span>
      <div className="flex items-center gap-1">
        {saving && <RefreshCw size={11} className="animate-spin text-slate-400" />}
        <input
          type="text"
          inputMode="decimal"
          data-testid="receipt-total-taxes"
          value={value}
          onChange={e => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
          placeholder="—"
          disabled={saving}
          title="Modifier le total des taxes — réparti au prorata sur TPS / TVQ / Autres taxes"
          className="tabular-nums text-right bg-transparent border border-transparent hover:border-slate-300 focus:border-brand-500 focus:bg-white rounded px-2 py-0.5 w-28 text-sm font-medium text-slate-700 outline-none"
        />
      </div>
    </div>
  )
}

// Total dérivé, lecture seule : sous-total (articles) + TPS + TVQ + autres taxes.
// Affiche un repère discret si le total imprimé sur le reçu (receipt.total stocké)
// diverge — signe que les lignes ne sont pas encore HT (ex. prix Amazon taxes
// incluses), pour inviter l'utilisateur à corriger l'article plutôt que de fausser
// la compta.
function DerivedTotalRow({ receipt }) {
  const total = computedTotal(receipt)
  const printed = receipt.total
  const drift = printed != null && Math.abs(round2(printed) - total) > 0.01
  return (
    <div className="flex justify-between items-center gap-2">
      <span className="text-sm font-semibold text-slate-800">
        Total
        <span className="text-[11px] text-slate-400 ml-1 font-normal">(articles + taxes)</span>
      </span>
      <div className="flex items-center gap-2">
        {drift && (
          <span
            className="text-[11px] text-amber-600"
            data-testid="receipt-total-drift"
            title="Le reçu indique un total différent — vérifiez que les lignes d'articles sont hors taxes"
          >
            reçu : {fmtCad(printed)}
          </span>
        )}
        <span
          data-testid="receipt-amount-total"
          className="tabular-nums text-right px-2 py-0.5 w-28 text-base font-bold text-slate-900"
        >
          {fmtCad(total)}
        </span>
      </div>
    </div>
  )
}

// Sélecteur du code de taxe PAR DÉFAUT du document : appliqué à toute ligne qui n'a pas
// son propre code. Le choisir active le mode « piloté par les codes » → TPS/TVQ
// recalculées automatiquement. Le retirer (« Taxes manuelles ») repasse en saisie libre
// sans toucher aux montants courants.
function DocumentTaxCodeRow({ receipt, taxCodes = [], onUpdate }) {
  const { addToast } = useToast()
  const [saving, setSaving] = useState(false)
  const taxNameById = new Map((taxCodes || []).map(c => [c.Id, c.Name]))
  const options = taxCodes.map(c => ({ value: c.Id, label: c.Name }))

  async function change(val) {
    const defaultCode = val || null
    if ((receipt.tax_code_id || null) === defaultCode) return
    setSaving(true)
    try {
      const patch = { tax_code_id: defaultCode }
      if (defaultCode) Object.assign(patch, recomputeAmounts(receipt, receipt.items || [], defaultCode, taxNameById))
      const updated = await api.saleReceipts.update(receipt.id, patch)
      onUpdate?.(updated)
    } catch (e) {
      addToast({ message: 'Erreur: ' + e.message, type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="flex justify-between items-center gap-2">
      <span className="text-sm text-slate-600">
        Code de taxe <span className="text-[11px] text-slate-400">(défaut du document)</span>
      </span>
      <div className="flex items-center gap-1">
        {saving && <RefreshCw size={11} className="animate-spin text-slate-400" />}
        <div className="w-52">
          <SearchableSelect
            testId="receipt-doc-taxcode"
            value={receipt.tax_code_id || ''}
            options={options}
            emptyOption="— Taxes manuelles —"
            onChange={change}
            placeholder="— Taxes manuelles —"
          />
        </div>
      </div>
    </div>
  )
}

// Indicateur de réconciliation (lecture seule) : compare la taxe IMPLIQUÉE par les codes
// de taxe par ligne au total des taxes du document. Ne s'affiche que si au moins une ligne
// porte un code explicite. Ne modifie jamais les taxes du document.
function TaxReconciliationRow({ receipt, taxCodes = [] }) {
  const taxNameById = new Map((taxCodes || []).map(c => [c.Id, c.Name]))
  const rec = impliedTaxFromLineCodes(receipt, taxNameById)
  if (!rec.applicable) return null

  const documentTax = round2((receipt.tps || 0) + (receipt.tvq || 0) + (receipt.other_taxes || 0))
  const diff = round2(rec.implied - documentTax)
  // Réconciliation concluante seulement si toutes les lignes ont un code connu.
  const conclusive = rec.allExplicit && !rec.unknown
  const matches = conclusive && Math.abs(diff) <= 0.02

  let badge
  if (!conclusive) {
    badge = <span className="text-slate-400">vérification partielle{rec.unknown ? ' (taux inconnu)' : ' (lignes au code du document)'}</span>
  } else if (matches) {
    badge = <span className="inline-flex items-center gap-1 text-green-700"><CheckCircle size={11} /> correspond</span>
  } else {
    badge = <span className="inline-flex items-center gap-1 text-red-700"><AlertCircle size={11} /> écart {fmtCad(Math.abs(diff))}</span>
  }

  return (
    <div className="flex justify-between items-center gap-2 text-[11px]" data-testid="receipt-tax-reconciliation">
      <span className="text-slate-500" title="Taxe calculée à partir des codes de taxe choisis sur chaque ligne — sert à vérifier qu'ils correspondent aux taxes saisies.">
        Selon les codes par ligne
      </span>
      <div className="flex items-center gap-2">
        {badge}
        <span className="tabular-nums text-right px-2 w-28 text-slate-600">{fmtCad(rec.implied)}</span>
      </div>
    </div>
  )
}

function TabButton({ active, onClick, children, testId }) {
  return (
    <button
      onClick={onClick}
      data-testid={testId}
      className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
        active ? 'border-brand-500 text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-700'
      }`}
    >
      {children}
    </button>
  )
}

const HISTORY_ACTION_META = {
  created:    { label: 'Document ajouté',       Icon: Plus,           color: 'text-green-700 bg-green-100' },
  updated:    { label: 'Modifié',               Icon: Pencil,         color: 'text-blue-700 bg-blue-100' },
  archived:   { label: 'Archivé',               Icon: Archive,        color: 'text-amber-700 bg-amber-100' },
  unarchived: { label: 'Désarchivé',            Icon: ArchiveRestore, color: 'text-slate-700 bg-slate-200' },
  published:  { label: 'Publié sur QuickBooks', Icon: BookOpen,       color: 'text-green-700 bg-green-100' },
}

function HistoryTab({ events, loading }) {
  if (loading) return <div className="py-10 text-center text-slate-400 text-sm">Chargement de l'historique…</div>
  if (!events || events.length === 0) return <div className="py-10 text-center text-slate-400 text-sm">Aucun historique.</div>

  const created = events.find(e => e.action === 'created')
  return (
    <div className="max-w-2xl" data-testid="history-tab">
      {created && (
        <div className="mb-6 rounded-xl border border-slate-200 bg-slate-50 p-4">
          <p className="text-xs uppercase tracking-wide text-slate-400 font-medium">Ajouté par</p>
          <p className="text-sm text-slate-800 mt-0.5">
            <span className="font-medium" data-testid="history-creator">{created.user_name || 'Utilisateur inconnu'}</span>
            <span className="text-slate-400"> · {fmtDateTime(created.created_at)}</span>
          </p>
        </div>
      )}
      <ol className="relative border-l border-slate-200 ml-3">
        {events.map(ev => {
          const meta = HISTORY_ACTION_META[ev.action] || { label: ev.action, Icon: Clock, color: 'text-slate-600 bg-slate-100' }
          const { Icon } = meta
          return (
            <li key={ev.id} className="mb-6 ml-6">
              <span className={`absolute -left-3 flex items-center justify-center w-6 h-6 rounded-full ring-4 ring-white ${meta.color}`}>
                <Icon size={12} />
              </span>
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-sm text-slate-800">
                  {meta.label}
                  {ev.detail && <span className="text-slate-500"> — {ev.detail}</span>}
                </p>
                <span className="text-xs text-slate-400 whitespace-nowrap">{fmtDateTime(ev.created_at)}</span>
              </div>
              <p className="text-xs text-slate-500 mt-0.5">par {ev.user_name || 'Utilisateur inconnu'}</p>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

export default function SaleReceiptDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { addToast } = useToast()
  const confirm = useConfirm()
  const [receipt, setReceipt] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [fileUrl, setFileUrl] = useState(null)
  const [allIds, setAllIds] = useState([])
  const [acting, setActing] = useState(false)
  const [tab, setTab] = useState('details')
  const [history, setHistory] = useState(null)
  // Codes de taxe QB partagés par le sélecteur de ligne (Articles) et l'indicateur de
  // réconciliation (Montants). Une seule requête ; échec (QB non connecté) → liste vide.
  const [taxCodes, setTaxCodes] = useState([])

  useEffect(() => {
    let cancelled = false
    api.quickbooks.taxCodes()
      .then(codes => { if (!cancelled) setTaxCodes(codes || []) })
      .catch(() => { if (!cancelled) setTaxCodes([]) })
    return () => { cancelled = true }
  }, [])

  // Charge l'historique à la demande quand l'onglet est ouvert (et au changement de reçu).
  useEffect(() => {
    if (tab !== 'history' || !receipt?.id) return
    let cancelled = false
    setHistory(null)
    api.saleReceipts.history(receipt.id)
      .then(r => { if (!cancelled) setHistory(r.data || []) })
      .catch(() => { if (!cancelled) setHistory([]) })
    return () => { cancelled = true }
  }, [tab, receipt?.id])

  async function handleArchiveToggle() {
    if (!receipt) return
    setActing(true)
    try {
      const updated = receipt.archived_at
        ? await api.saleReceipts.unarchive(receipt.id)
        : await api.saleReceipts.archive(receipt.id)
      setReceipt(updated)
      addToast({ message: updated.archived_at ? 'Reçu archivé' : 'Reçu désarchivé', type: 'success' })
      // À l'archivage, on sort du document et on revient à l'interface Extraction de données.
      if (updated.archived_at) navigate('/sale-receipts')
    } catch (e) {
      addToast({ message: 'Erreur: ' + e.message, type: 'error' })
    } finally {
      setActing(false)
    }
  }

  async function handleReExtract() {
    if (!receipt) return
    setActing(true)
    try {
      const updated = await api.saleReceipts.reExtract(receipt.id)
      setReceipt(updated)
      addToast({ message: 'Relance de l\'extraction…', type: 'success' })
    } catch (e) {
      addToast({ message: 'Erreur: ' + e.message, type: 'error' })
    } finally {
      setActing(false)
    }
  }

  async function handleDelete() {
    if (!receipt) return
    const ok = await confirm({
      title: 'Supprimer ce reçu ?',
      message: `Le reçu « ${receipt.company || receipt.original_name} » et son fichier seront supprimés. Cette action est irréversible.`,
      confirmLabel: 'Supprimer',
      danger: true,
    })
    if (!ok) return
    setActing(true)
    try {
      await api.saleReceipts.delete(receipt.id)
      addToast({ message: 'Reçu supprimé', type: 'success' })
      navigate('/sale-receipts')
    } catch (e) {
      addToast({ message: 'Erreur: ' + e.message, type: 'error' })
      setActing(false)
    }
  }

  const load = useCallback(() => {
    setLoading(true)
    setLoadError(null)
    api.saleReceipts.get(id)
      .then(setReceipt)
      .catch((e) => { setReceipt(null); setLoadError(e?.message || 'Erreur de chargement') })
      .finally(() => setLoading(false))
  }, [id])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    // Priorité à l'ordre de la vue mémorisé dans sessionStorage (set par
    // SaleReceipts.jsx au clic sur une ligne). Fallback : ordre DB complet
    // si l'utilisateur arrive directement par URL.
    try {
      const stored = sessionStorage.getItem('sale_receipts:nav_ids')
      if (stored) {
        const arr = JSON.parse(stored)
        if (Array.isArray(arr) && arr.length) {
          setAllIds(arr.map(String))
          return
        }
      }
    } catch {}
    api.saleReceipts.list({ limit: 'all' })
      .then(res => setAllIds((res.data || []).map(r => String(r.id))))
      .catch(() => {})
  }, [])

  useEntityListRealtime('sale_receipt', (updater) => {
    setReceipt(prev => {
      if (!prev) return prev
      const next = typeof updater === 'function' ? updater([prev]) : updater
      if (Array.isArray(next)) {
        const found = next.find(r => String(r.id) === String(id))
        return found || prev
      }
      return prev
    })
  })

  // Poll while the extraction is in progress, just like the old page.
  useEffect(() => {
    if (!receipt || (receipt.status !== 'processing' && receipt.status !== 'pending')) return
    const t = setInterval(async () => {
      try {
        const fresh = await api.saleReceipts.get(id)
        setReceipt(fresh)
        if (fresh.status !== 'processing' && fresh.status !== 'pending') clearInterval(t)
      } catch {}
    }, 2000)
    return () => clearInterval(t)
  }, [receipt?.status, id])

  useEffect(() => {
    setFileUrl(null)
    if (!receipt?.id) return
    let url = null
    const token = localStorage.getItem('erp_token')
    fetch(`/erp/api/sale-receipts/${receipt.id}/file`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
      .then(r => r.ok ? r.blob() : Promise.reject())
      .then(blob => { url = URL.createObjectURL(blob); setFileUrl(url) })
      .catch(() => setFileUrl(null))
    return () => { if (url) URL.revokeObjectURL(url) }
  }, [receipt?.id])

  const currentIdx = allIds.indexOf(String(id))
  const prevId = currentIdx > 0 ? allIds[currentIdx - 1] : null
  const nextId = currentIdx >= 0 && currentIdx < allIds.length - 1 ? allIds[currentIdx + 1] : null

  if (loading) {
    return (
      <Layout>
        <Spinner center />
      </Layout>
    )
  }

  if (loadError && !receipt) {
    return <Layout><DetailLoadError message={loadError} onRetry={load} /></Layout>
  }

  if (!receipt) {
    return (
      <Layout>
        <div className="p-6 max-w-4xl mx-auto">
          <button onClick={() => navigate('/sale-receipts')} className="inline-flex items-center gap-2 text-sm text-slate-500 hover:text-slate-700">
            <ArrowLeft size={16} /> Retour à la liste
          </button>
          <div className="mt-6 text-slate-500">Reçu introuvable.</div>
        </div>
      </Layout>
    )
  }

  const isPdf = receipt.file_type === '.pdf'
  const items = receipt.items || []

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-start gap-4 mb-4">
          <button
            onClick={() => navigate('/sale-receipts')}
            className="mt-1 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg"
            title="Retour à la liste"
            aria-label="Retour"
          >
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-3 flex-wrap">
              <ReceiptText size={20} className="text-slate-400" />
              <h1 className="text-2xl font-bold text-slate-900 truncate">{receipt.company || receipt.original_name}</h1>
              <StatusBadge status={receipt.status} />
              {receipt.quickbooks_id && (
                receipt.quickbooks_url ? (
                  <a
                    href={receipt.quickbooks_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid="qb-link"
                    className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-100 hover:bg-green-200 px-2 py-0.5 rounded-full"
                  >
                    <BookOpen size={10} /> QB #{receipt.quickbooks_id}
                  </a>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-100 px-2 py-0.5 rounded-full">
                    <BookOpen size={10} /> QB #{receipt.quickbooks_id}
                  </span>
                )
              )}
            </div>
            {receipt.address && <p className="text-slate-500 text-sm mt-1">{receipt.address}</p>}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => prevId && navigate(`/sale-receipts/${prevId}`)}
              disabled={!prevId}
              className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed"
              data-testid="receipt-prev"
              title="Reçu précédent"
              aria-label="Reçu précédent"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={() => nextId && navigate(`/sale-receipts/${nextId}`)}
              disabled={!nextId}
              className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg disabled:opacity-30 disabled:hover:bg-transparent disabled:cursor-not-allowed"
              data-testid="receipt-next"
              title="Reçu suivant"
              aria-label="Reçu suivant"
            >
              <ChevronRight size={16} />
            </button>

            <div className="w-px h-5 bg-slate-200 mx-1" />

            <button
              onClick={handleArchiveToggle}
              disabled={acting}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-slate-600 border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50"
              data-testid="receipt-archive"
              title={receipt.archived_at ? 'Désarchiver' : 'Archiver'}
            >
              {receipt.archived_at ? <ArchiveRestore size={14} /> : <Archive size={14} />}
              {receipt.archived_at ? 'Désarchiver' : 'Archiver'}
            </button>
            <button
              onClick={handleDelete}
              disabled={acting}
              className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-red-600 border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50"
              data-testid="receipt-delete"
              title="Supprimer"
            >
              <Trash2 size={14} />
              Supprimer
            </button>
          </div>
        </div>

        {/* Onglets */}
        <div className="flex items-center gap-1 border-b border-slate-200 mb-5">
          <TabButton active={tab === 'details'} onClick={() => setTab('details')} testId="tab-details">Détails</TabButton>
          <TabButton active={tab === 'history'} onClick={() => setTab('history')} testId="tab-history">Historique</TabButton>
        </div>

        {tab === 'history' && <HistoryTab events={history} loading={history === null} />}

        {tab === 'details' && (receipt.status === 'processing' ? (
          <div className="flex flex-col items-center justify-center py-20 text-blue-500 gap-3">
            <RefreshCw size={48} strokeWidth={1} className="animate-spin" />
            <p className="font-medium">Extraction en cours…</p>
            <p className="text-slate-400 text-sm">Les données seront disponibles dans quelques secondes</p>
          </div>
        ) : receipt.status === 'error' ? (
          <div className="flex flex-col items-center justify-center py-20 text-red-500 gap-3">
            <AlertCircle size={48} strokeWidth={1} />
            <p className="font-medium">Erreur d'extraction</p>
            {receipt.error_message && <p className="text-slate-500 text-sm text-center max-w-sm">{receipt.error_message}</p>}
            <button
              onClick={handleReExtract}
              disabled={acting}
              className="mt-2 inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-blue-600 border border-blue-200 rounded-lg hover:bg-blue-50 disabled:opacity-50"
              data-testid="receipt-re-extract"
              title="Relancer l'extraction sur le fichier déjà téléversé"
            >
              <RefreshCw size={14} className={acting ? 'animate-spin' : ''} />
              Relancer l'extraction
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Original file preview */}
            {fileUrl && (
              <div className="bg-slate-100 rounded-xl border border-slate-200 overflow-auto p-3 flex items-start justify-center min-h-[400px]">
                {isPdf ? (
                  <iframe src={fileUrl} title="Reçu original" className="w-full h-full min-h-[600px] rounded shadow" />
                ) : (
                  <img src={fileUrl} alt="Reçu original" className="max-w-full object-contain rounded shadow" />
                )}
              </div>
            )}

            {/* Extracted data */}
            <div className="space-y-6">
              {receipt.status === 'done' && !receipt.quickbooks_id && (
                <QBPublishForm
                  receipt={receipt}
                  onSuccess={(updated) => {
                    setReceipt(updated)
                    addToast({ message: 'Reçu publié sur QuickBooks', type: 'success' })
                    // On sort du document et on revient à l'interface Extraction de données.
                    navigate('/sale-receipts')
                  }}
                />
              )}

              <div className="grid grid-cols-2 gap-4">
                <EditableTextField receipt={receipt} field="company" label="Entreprise" placeholder="Nom du fournisseur" onUpdate={setReceipt} testId="receipt-company" />
                <EditableDateField receipt={receipt} field="receipt_date" label="Date" onUpdate={setReceipt} testId="receipt-date" />
                <EditableTextField receipt={receipt} field="receipt_number" label="N° de reçu" onUpdate={setReceipt} testId="receipt-number" />
                <EditableTextField receipt={receipt} field="payment_method" label="Mode de paiement" onUpdate={setReceipt} testId="receipt-payment-method" />
                <CurrencyField receipt={receipt} onUpdate={setReceipt} />
                <InfoField label="Fichier" value={receipt.original_name} />
              </div>

              <EditableItems receipt={receipt} onUpdate={setReceipt} taxCodes={taxCodes} />

              {(() => {
                // Mode « piloté par les codes » : un code de taxe par défaut est défini
                // et le reçu n'est pas encore publié → TPS/TVQ recalculées des codes
                // (lecture seule). Sinon, saisie manuelle classique.
                const codeDriven = !!receipt.tax_code_id && !receipt.quickbooks_id
                const codeHint = codeDriven ? '(selon les codes)' : undefined
                return (
              <div>
                <div className="flex items-baseline justify-between mb-2">
                  <h3 className="text-sm font-semibold text-slate-700">Montants</h3>
                  <p className="text-[11px] text-slate-400">
                    {codeDriven ? 'Taxes calculées à partir des codes par ligne.' : 'Cliquez pour modifier — ou choisissez un code de taxe par défaut pour calculer les taxes.'}
                  </p>
                </div>
                <div className="bg-slate-50 rounded-lg p-4 space-y-2">
                  <EditableAmountRow receipt={receipt} field="subtotal"    label="Sous-total (avant taxes)" onUpdate={setReceipt} readOnly={(receipt.items || []).some(it => it && it.total != null)} hint={(receipt.items || []).some(it => it && it.total != null) ? '(somme des lignes)' : undefined} />
                  <DocumentTaxCodeRow receipt={receipt} taxCodes={taxCodes} onUpdate={setReceipt} />
                  <EditableAmountRow receipt={receipt} field="tps"         label="TPS / GST"                onUpdate={setReceipt} readOnly={codeDriven} hint={codeHint} />
                  <EditableAmountRow receipt={receipt} field="tvq"         label="TVQ / QST / PST"          onUpdate={setReceipt} readOnly={codeDriven} hint={codeHint} />
                  <EditableAmountRow receipt={receipt} field="other_taxes" label="Autres taxes"             onUpdate={setReceipt} readOnly={codeDriven} hint={codeHint} />
                  {!codeDriven && <EditableTotalTaxesRow receipt={receipt} onUpdate={setReceipt} />}
                  {!codeDriven && <TaxReconciliationRow receipt={receipt} taxCodes={taxCodes} />}
                  <div className="border-t border-slate-200 pt-2 mt-2">
                    <DerivedTotalRow receipt={receipt} />
                  </div>
                </div>
              </div>
                )
              })()}

              <EditableMemoField receipt={receipt} onUpdate={setReceipt} />
            </div>
          </div>
        ))}
      </div>
    </Layout>
  )
}
