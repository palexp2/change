import { useState, useEffect } from 'react'
import { Plus, ArrowDownCircle, ArrowUpCircle, AlertCircle, RefreshCw, ExternalLink, RotateCcw } from 'lucide-react'
import { Link } from 'react-router-dom'
import api from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'
import { fmtDate, localISODate } from '../lib/formatDate.js'
import { Modal } from './Modal.jsx'

import { fmtMoney } from '../utils/formatters.js'

export const METHOD_LABELS = {
  stripe: 'Stripe',
  cheque: 'Chèque',
  virement_bancaire: 'Virement bancaire',
  interac: 'Interac',
  comptant: 'Comptant',
  autre: 'Autre',
}

export const MANUAL_METHODS = ['cheque', 'virement_bancaire', 'interac', 'comptant', 'autre']

export default function FacturePaymentsSection({
  factureId,
  factureCurrency = 'CAD',
  factureIsPaid = false,
  facturePaidAt = null,
  facturePaidChargeId = null,
  facturePaidPaymentIntent = null,
  factureTotalAmount = null,
  onFactureChanged,
}) {
  const { user } = useAuth()
  const [payments, setPayments] = useState([])
  const [loading, setLoading] = useState(true)
  const [formOpen, setFormOpen] = useState(null) // null | 'in' | 'out'
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState(null)
  const [convertOpen, setConvertOpen] = useState(false)
  const [converting, setConverting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)

  // Form state
  const [method, setMethod] = useState('cheque')
  const [receivedAt, setReceivedAt] = useState(() => localISODate())
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState(factureCurrency)
  const [notes, setNotes] = useState('')
  const [skipQb, setSkipQb] = useState(false)

  // Heuristique : paid_at posé sans aucune trace réelle d'un paiement Stripe
  // (ni charge_id ni payment_intent). Cas typique : invoice Stripe marquée
  // "paid out of band" → l'argent est entré ailleurs (Interac, virement, chèque).
  // On expose alors un bouton admin pour réinitialiser l'état "payé" et saisir
  // le vrai paiement.
  // NB : Stripe pousse amount_paid = total (et non 0) pour les invoices
  // marquées paid-out-of-band, donc on ne peut pas filtrer sur paid_amount.
  // L'absence simultanée de charge_id ET de payment_intent suffit : un vrai
  // paiement Stripe expose toujours au moins un des deux.
  // On déclenche sur paid_at (et non sur factureIsPaid) parce que balance_due=0
  // hérité d'un paiement Stripe précédent peut maintenir factureIsPaid=true même
  // après reset — l'absence de paid_at est notre signal fiable de "déjà nettoyé".
  const looksPaidOutOfBand = !!facturePaidAt
    && !facturePaidChargeId
    && !facturePaidPaymentIntent
  const isAdmin = user?.role === 'admin'

  function reload() {
    setLoading(true)
    return api.payments.listForFacture(factureId)
      .then(rows => setPayments(rows || []))
      .catch(() => setPayments([]))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    if (!factureId) return
    reload()
  }, [factureId]) // eslint-disable-line react-hooks/exhaustive-deps

  function openForm(direction, opts = {}) {
    setMethod(opts.method || 'cheque')
    setReceivedAt(opts.receivedAt || localISODate())
    setAmount(opts.amount != null ? String(opts.amount) : '')
    setCurrency(opts.currency || factureCurrency)
    setNotes(opts.notes || '')
    setSkipQb(!!opts.skipQb)
    setErr(null)
    setFormOpen(direction)
  }

  async function confirmConvert() {
    setConverting(true)
    setErr(null)
    try {
      await api.admin.clearFacturePaidStatus(factureId)
      setConvertOpen(false)
      if (onFactureChanged) await onFactureChanged()
      // Préremplit le formulaire avec la date et le total connus du Stripe.
      // skipQb par défaut : si l'invoice a été marquée paid-out-of-band dans
      // Stripe, l'encaissement réel est souvent déjà entré manuellement dans QB
      // — l'utilisateur décoche s'il veut au contraire qu'on poste le Deposit.
      const prefillDate = facturePaidAt ? facturePaidAt.slice(0, 10) : localISODate()
      openForm('in', {
        method: 'interac',
        receivedAt: prefillDate,
        amount: factureTotalAmount,
        currency: factureCurrency,
        skipQb: true,
      })
      reload()
    } catch (e) {
      setErr(e.message || 'Erreur lors de la conversion')
    } finally {
      setConverting(false)
    }
  }

  // Étape 1 : valider le montant puis ouvrir la modale de confirmation des
  // side effects (mouvement monétaire + push QuickBooks). On ne crée le
  // paiement qu'après confirmation explicite — voir règle « confirmation des
  // side effects » du CLAUDE.md.
  function requestSubmit() {
    setErr(null)
    const amt = parseFloat(amount)
    if (!Number.isFinite(amt) || amt <= 0) {
      setErr('Le montant doit être supérieur à 0.')
      return
    }
    setConfirmOpen(true)
  }

  // Étape 2 : exécution réelle après confirmation dans la modale.
  async function submit() {
    setErr(null)
    const amt = parseFloat(amount)
    if (!Number.isFinite(amt) || amt <= 0) {
      setErr('Le montant doit être supérieur à 0.')
      return
    }
    setSubmitting(true)
    try {
      const res = await api.payments.create({
        facture_id: factureId,
        direction: formOpen,
        method,
        received_at: receivedAt,
        amount: amt,
        currency,
        notes: notes.trim() || undefined,
        skip_qb: skipQb || undefined,
      })
      setConfirmOpen(false)
      setFormOpen(null)
      if (res.qb_error) setErr(`Saisi mais écriture QB échouée : ${res.qb_error}`)
      reload()
    } catch (e) {
      setConfirmOpen(false)
      setErr(e.message || 'Erreur')
    } finally {
      setSubmitting(false)
    }
  }

  async function retryQb(id) {
    try {
      await api.payments.retryQb(id)
      reload()
    } catch (e) {
      setErr(e.message)
    }
  }

  const incoming = payments.filter(p => p.direction === 'in')
  const outgoing = payments.filter(p => p.direction === 'out')

  return (
    <div className="bg-white rounded-xl border border-slate-200 mt-5">
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
        <h2 className="text-sm font-semibold text-slate-900">Paiements et remboursements</h2>
        <div className="flex items-center gap-2">
          {!factureIsPaid && (
            <button
              onClick={() => openForm('in')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 rounded-lg border border-emerald-200"
              data-testid="add-payment-in"
            >
              <Plus size={12} /> Paiement (hors Stripe)
            </button>
          )}
          <button
            onClick={() => openForm('out')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-rose-700 bg-rose-50 hover:bg-rose-100 rounded-lg border border-rose-200"
            data-testid="add-payment-out"
          >
            <Plus size={12} /> Remboursement (hors Stripe)
          </button>
        </div>
      </div>

      {err && (
        <div className="px-5 py-2 text-xs text-red-700 bg-red-50 border-b border-red-100 flex items-center gap-1.5">
          <AlertCircle size={12} /> {err}
        </div>
      )}

      {looksPaidOutOfBand && isAdmin && (
        <div className="px-5 py-3 border-b border-amber-100 bg-amber-50/60 flex items-start gap-2.5">
          <AlertCircle size={14} className="text-amber-700 mt-0.5 flex-shrink-0" />
          <div className="flex-1 text-xs text-amber-900">
            <p className="font-medium">
              Facture marquée payée par Stripe, mais sans détails de paiement
              (montant Stripe à 0, pas de charge ni de payment intent).
            </p>
            <p className="mt-0.5 text-amber-800">
              Si l'argent est entré hors Stripe (Interac, virement, chèque…),
              réinitialise pour saisir le vrai paiement et générer la JE
              d'encaissement dans QuickBooks.
            </p>
          </div>
          <button
            onClick={() => setConvertOpen(true)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-amber-800 bg-white hover:bg-amber-100 rounded-lg border border-amber-300"
            data-testid="convert-to-off-stripe-btn"
          >
            <RotateCcw size={12} /> Convertir en paiement hors Stripe
          </button>
        </div>
      )}

      <ConvertConfirmModal
        isOpen={convertOpen}
        converting={converting}
        facturePaidAt={facturePaidAt}
        onCancel={() => setConvertOpen(false)}
        onConfirm={confirmConvert}
      />


      {formOpen && (
        <div className="px-5 py-4 border-b border-slate-100 bg-slate-50/60">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Mode</label>
              <select
                value={method}
                onChange={e => setMethod(e.target.value)}
                className="w-full text-sm border border-slate-300 rounded-md px-2 py-1.5"
              >
                {MANUAL_METHODS.map(m => (
                  <option key={m} value={m}>{METHOD_LABELS[m]}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Date</label>
              <input
                type="date"
                value={receivedAt}
                onChange={e => setReceivedAt(e.target.value)}
                className="w-full text-sm border border-slate-300 rounded-md px-2 py-1.5"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Montant</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                placeholder="0.00"
                className="w-full text-sm border border-slate-300 rounded-md px-2 py-1.5"
                data-testid="payment-amount"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-500 mb-1">Devise</label>
              <select
                value={currency}
                onChange={e => setCurrency(e.target.value)}
                className="w-full text-sm border border-slate-300 rounded-md px-2 py-1.5"
              >
                <option value="CAD">CAD</option>
                <option value="USD">USD</option>
              </select>
            </div>
          </div>
          <div className="mt-3">
            <label className="block text-xs font-medium text-slate-500 mb-1">Notes (optionnel)</label>
            <input
              type="text"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Numéro de chèque, référence, etc."
              className="w-full text-sm border border-slate-300 rounded-md px-2 py-1.5"
            />
          </div>
          {/* Skip QB : utile quand l'écriture comptable a déjà été posée
              manuellement dans QuickBooks (ex. facture Stripe paid-out-of-band
              dont l'encaissement Interac a été saisi à la main avant la
              conversion). La row payments est créée pour la traçabilité ERP
              mais aucun Deposit/JE n'est posté. */}
          <div className="mt-3">
            <label className="inline-flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
              <input
                type="checkbox"
                checked={skipQb}
                onChange={e => setSkipQb(e.target.checked)}
                className="rounded border-slate-300"
                data-testid="payment-skip-qb"
              />
              <span>Écriture déjà postée dans QuickBooks (ne pas re-poster)</span>
            </label>
          </div>
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              onClick={() => setFormOpen(null)}
              className="px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded-md"
            >Annuler</button>
            <button
              onClick={requestSubmit}
              disabled={submitting}
              className={`px-3 py-1.5 text-xs font-medium text-white rounded-md disabled:opacity-50 ${formOpen === 'in' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-rose-600 hover:bg-rose-700'}`}
              data-testid="payment-submit"
            >{submitting ? 'Enregistrement…' : 'Enregistrer'}</button>
          </div>
        </div>
      )}

      <PaymentConfirmModal
        isOpen={confirmOpen}
        submitting={submitting}
        direction={formOpen}
        method={method}
        amount={parseFloat(amount)}
        currency={currency}
        skipQb={skipQb}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={submit}
      />

      <div className="px-5 py-3">
        {loading ? (
          <div className="text-xs text-slate-400">Chargement…</div>
        ) : payments.length === 0 ? (
          <div className="text-xs text-slate-400 italic">Aucun paiement enregistré pour cette facture.</div>
        ) : (
          <div className="space-y-3">
            {incoming.length > 0 && (
              <PaymentList title="Paiements reçus" rows={incoming} icon={ArrowDownCircle} colorClass="text-emerald-600" onRetryQb={retryQb} isAdmin={isAdmin} onChanged={reload} />
            )}
            {outgoing.length > 0 && (
              <PaymentList title="Remboursements émis" rows={outgoing} icon={ArrowUpCircle} colorClass="text-rose-600" onRetryQb={retryQb} isAdmin={isAdmin} onChanged={reload} />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function ConvertConfirmModal({ isOpen, converting, facturePaidAt, onCancel, onConfirm }) {
  if (!isOpen) return null
  return (
    <Modal isOpen={true} onClose={onCancel} title="Convertir en paiement hors Stripe" size="md">
      <div className="text-sm text-slate-700 space-y-3">
        <p>Cette action effectue les opérations locales suivantes :</p>
        <ul className="list-disc pl-5 space-y-1.5">
          <li>
            Remise à <strong>NULL</strong> de <code>paid_at</code>{facturePaidAt ? ` (actuellement ${fmtDate(facturePaidAt)})` : ''},
            <code> paid_amount</code>, <code>paid_charge_id</code>, <code>paid_payment_intent</code>.
          </li>
          <li>
            Le <strong>statut</strong> de la facture repasse de <em>Payé</em> à <em>À payer</em> ou <em>En retard</em> (selon la date d'échéance).
          </li>
          <li>
            Ouverture du formulaire de saisie d'un paiement hors Stripe. Par
            défaut, la case <em>« Écriture déjà postée dans QuickBooks »</em>
            sera cochée — l'encaissement réel est souvent déjà entré
            manuellement quand la facture a été marquée payée hors Stripe.
            Décoche-la pour poster un <strong>Deposit</strong> dans QuickBooks
            (<em>Dr Banque / Cr 12000</em>).
          </li>
        </ul>
        <p className="text-xs text-slate-500">
          Aucune action n'est faite côté Stripe ou QuickBooks à cette étape —
          uniquement la mise à jour des colonnes locales de la facture.
        </p>
      </div>
      <div className="flex justify-end gap-3 mt-6">
        <button
          onClick={onCancel}
          disabled={converting}
          className="px-3 py-1.5 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg disabled:opacity-50"
        >
          Annuler
        </button>
        <button
          onClick={onConfirm}
          disabled={converting}
          className="px-3 py-1.5 text-sm font-medium text-white bg-amber-600 hover:bg-amber-700 rounded-lg disabled:opacity-50"
          data-testid="convert-to-off-stripe-confirm"
        >
          {converting ? 'Conversion…' : 'Confirmer la conversion'}
        </button>
      </div>
    </Modal>
  )
}

// Modale de confirmation des side effects à la saisie manuelle d'un paiement
// (direction 'in') ou d'un remboursement (direction 'out'). Liste explicitement
// le mouvement monétaire enregistré ET l'écriture poussée dans QuickBooks
// (sauf si « écriture déjà postée » est coché) — règle « confirmation des side
// effects » du CLAUDE.md.
export function PaymentConfirmModal({ isOpen, submitting, direction, method, amount, currency, skipQb, onCancel, onConfirm }) {
  if (!isOpen) return null
  const isIn = direction === 'in'
  const money = fmtMoney(Number.isFinite(amount) ? amount : 0, currency)
  const methodLabel = METHOD_LABELS[method] || method
  return (
    <Modal
      isOpen={true}
      onClose={onCancel}
      title={isIn ? 'Confirmer le paiement (hors Stripe)' : 'Confirmer le remboursement (hors Stripe)'}
      size="md"
    >
      <div className="text-sm text-slate-700 space-y-3" data-testid="payment-confirm-body">
        <p>Cette action déclenche les effets suivants :</p>
        <ul className="list-disc pl-5 space-y-1.5">
          <li>
            {isIn ? (
              <>Enregistrement d'un <strong>paiement reçu</strong> de <strong>{money}</strong> ({methodLabel}) sur cette facture.</>
            ) : (
              <>Enregistrement d'un <strong>remboursement émis</strong> de <strong>{money}</strong> ({methodLabel}) sur cette facture.</>
            )}
          </li>
          <li>
            Mise à jour du <strong>solde dû</strong> et du <strong>statut</strong> de la facture en conséquence.
          </li>
          {skipQb ? (
            <li>
              <strong>Aucune écriture</strong> ne sera postée dans QuickBooks
              (case <em>« Écriture déjà postée »</em> cochée). La ligne est créée
              uniquement pour la traçabilité ERP.
            </li>
          ) : (
            <li>
              {isIn ? (
                <>Pose d'un <strong>Deposit</strong> dans <strong>QuickBooks</strong> pour l'encaissement de {money}.</>
              ) : (
                <>Traitement d'un <strong>remboursement</strong> dans <strong>QuickBooks</strong> pour {money} (écriture / Refund Receipt).</>
              )}
            </li>
          )}
        </ul>
        {!skipQb && (
          <p className="text-xs text-slate-500">
            Si la pose QuickBooks échoue, la ligne reste enregistrée et un bouton
            <em> Retry</em> permettra de réessayer l'écriture comptable.
          </p>
        )}
      </div>
      <div className="flex justify-end gap-3 mt-6">
        <button
          onClick={onCancel}
          disabled={submitting}
          className="px-3 py-1.5 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg disabled:opacity-50"
        >
          Annuler
        </button>
        <button
          onClick={onConfirm}
          disabled={submitting}
          className={`px-3 py-1.5 text-sm font-medium text-white rounded-lg disabled:opacity-50 ${isIn ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-rose-600 hover:bg-rose-700'}`}
          data-testid="payment-confirm-submit"
        >
          {submitting ? 'Enregistrement…' : (isIn ? 'Confirmer le paiement' : 'Confirmer le remboursement')}
        </button>
      </div>
    </Modal>
  )
}

// Cellule QB pour les payments qb_skipped (écriture déjà saisie manuellement
// dans QB). Permet à un admin de rattacher l'id du Deposit/JE/SalesReceipt
// créé à la main, ce qui transforme la cellule en lien cliquable vers QB
// (et préserve l'historique côté ERP).
const QB_LINK_TYPES = [
  { value: 'qb_deposit_id', label: 'Deposit', prefix: 'DEP' },
  { value: 'qb_journal_entry_id', label: 'Journal Entry', prefix: 'JE' },
  { value: 'qb_payment_id', label: 'Sales Receipt', prefix: 'SR' },
]
const fmtMoneyShort = (n, currency = 'CAD') => fmtMoney(n, currency, { fallback: '', maximumFractionDigits: 0 })
function QbSkippedCell({ payment, isAdmin, onChanged }) {
  const [editing, setEditing] = useState(false)
  const [col, setCol] = useState('qb_deposit_id')
  const [qbId, setQbId] = useState('')
  const [creditAcctId, setCreditAcctId] = useState('')
  const [creditAcctName, setCreditAcctName] = useState('')
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState(null)
  const [suggestions, setSuggestions] = useState(null) // null = pas encore chargé, [] = chargé vide
  const [loadingSugg, setLoadingSugg] = useState(false)

  // Charge les suggestions QB la première fois qu'on ouvre le form.
  useEffect(() => {
    if (!editing || suggestions !== null) return
    setLoadingSugg(true)
    api.payments.qbLinkSuggestions(payment.id)
      .then(r => setSuggestions(r.suggestions || []))
      .catch(() => setSuggestions([]))
      .finally(() => setLoadingSugg(false))
  }, [editing, suggestions, payment.id])

  function pickSuggestion(s) {
    setCol(s.column)
    setQbId(s.qb_id)
    setCreditAcctId(s.credit_account_id || '')
    setCreditAcctName(s.credit_account_name || '')
  }

  async function save() {
    const trimmed = qbId.trim()
    if (!trimmed) { setErr('ID QB requis'); return }
    setSaving(true)
    setErr(null)
    try {
      const payload = {
        [col]: trimmed,
        qb_credit_account_id: creditAcctId.trim() || null,
        qb_credit_account_name: creditAcctName.trim() || null,
      }
      const res = await api.admin.paymentRawUpdate(payment.id, payload)
      if (res?.rejected && Object.keys(res.rejected).length) {
        setErr(`Rejeté : ${JSON.stringify(res.rejected)}`)
        return
      }
      setEditing(false)
      setQbId('')
      setCreditAcctId('')
      setCreditAcctName('')
      if (onChanged) await onChanged()
    } catch (e) {
      setErr(e.message || 'Erreur')
    } finally {
      setSaving(false)
    }
  }

  if (editing) {
    return (
      <div className="inline-flex flex-col gap-1.5 align-top" data-testid={`payment-qb-link-form-${payment.id}`}>
        <div className="inline-flex items-center gap-1">
          <select
            value={col}
            onChange={e => setCol(e.target.value)}
            className="text-xs border border-slate-300 rounded px-1 py-0.5"
            disabled={saving}
          >
            {QB_LINK_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <input
            type="text"
            value={qbId}
            onChange={e => setQbId(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }}
            placeholder="ID"
            className="w-20 text-xs border border-slate-300 rounded px-1 py-0.5"
            autoFocus
            disabled={saving}
            data-testid={`payment-qb-link-input-${payment.id}`}
          />
          <button
            onClick={save}
            disabled={saving}
            className="text-xs px-1.5 py-0.5 bg-brand-600 hover:bg-brand-700 text-white rounded disabled:opacity-50"
            data-testid={`payment-qb-link-save-${payment.id}`}
          >
            {saving ? '…' : 'OK'}
          </button>
          <button
            onClick={() => { setEditing(false); setErr(null) }}
            disabled={saving}
            className="text-xs px-1.5 py-0.5 text-slate-500 hover:bg-slate-100 rounded"
          >
            ✕
          </button>
          {err && <span className="text-xs text-red-600 ml-1" title={err}>!</span>}
        </div>
        {/* Compte crédité — auto-rempli depuis QB quand on choisit une
            suggestion (Deposit/JE), éditable pour saisie manuelle. Trace
            comptable : Revenus perçus d'avance (23900) / Ventes (40000) /
            Revenus de service (41000) / Comptes clients (12000). */}
        <div className="inline-flex items-center gap-1">
          <label className="text-[10px] text-slate-500 uppercase tracking-wide">Cr</label>
          <input
            type="text"
            value={creditAcctName}
            onChange={e => setCreditAcctName(e.target.value)}
            placeholder="ex. 23900 Revenus perçus d'avance"
            className="text-xs border border-slate-300 rounded px-1 py-0.5 w-64"
            disabled={saving}
            data-testid={`payment-qb-credit-name-${payment.id}`}
          />
        </div>
        {/* Suggestions : opérations QB du client dans une fenêtre de ±90 jours
            autour de la date du paiement. Clic = remplit le type + l'ID. */}
        <div className="border border-slate-200 rounded bg-white max-w-md" data-testid={`payment-qb-suggestions-${payment.id}`}>
          {loadingSugg && (
            <div className="text-[11px] text-slate-400 px-2 py-1.5">Chargement des opérations QB…</div>
          )}
          {!loadingSugg && suggestions && suggestions.length === 0 && (
            <div className="text-[11px] text-slate-400 px-2 py-1.5 italic">
              Aucune opération QB trouvée pour ce client dans ±90 jours.
            </div>
          )}
          {!loadingSugg && suggestions && suggestions.length > 0 && (
            <ul className="max-h-44 overflow-y-auto divide-y divide-slate-100">
              {suggestions.map(s => {
                const selected = qbId === s.qb_id && col === s.column
                return (
                  <li key={`${s.type}:${s.qb_id}`}>
                    <button
                      onClick={() => pickSuggestion(s)}
                      className={`w-full text-left px-2 py-1 text-[11px] hover:bg-slate-50 ${selected ? 'bg-brand-50' : ''}`}
                      data-testid={`payment-qb-suggestion-${s.type}-${s.qb_id}`}
                    >
                      <div>
                        <span className="font-mono text-slate-700">{s.prefix} #{s.qb_id}</span>
                        <span className="text-slate-400 mx-1.5">·</span>
                        <span className="text-slate-600">{s.txn_date}</span>
                        <span className="text-slate-400 mx-1.5">·</span>
                        <span className="text-slate-700">{fmtMoneyShort(s.amount, payment.currency)}</span>
                      </div>
                      {s.credit_account_name && (
                        <div className="text-slate-500 mt-0.5">
                          Cr <span className="text-slate-700">{s.credit_account_name}</span>
                        </div>
                      )}
                      {s.description && !s.credit_account_name && (
                        <div className="text-slate-400 truncate mt-0.5">{s.description}</div>
                      )}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      </div>
    )
  }

  return (
    <span
      className="inline-flex items-center gap-1.5 text-xs text-slate-500"
      title="L'écriture QB a été marquée comme déjà postée manuellement à la création du paiement"
      data-testid={`payment-qb-skipped-${payment.id}`}
    >
      saisi à la main
      {isAdmin && (
        <button
          onClick={() => setEditing(true)}
          className="text-brand-600 hover:underline text-[11px]"
          title="Rattacher l'id du Deposit / JE / SalesReceipt créé manuellement dans QuickBooks"
          data-testid={`payment-qb-link-btn-${payment.id}`}
        >
          lier QB
        </button>
      )}
    </span>
  )
}

// Éditeur inline du compte crédité QB, affiché sous le lien QB d'un payment
// déjà rattaché. Permet à un admin d'ajouter ou modifier l'annotation Cr xxxx
// sans repasser par le flow de liaison complet. Bouton "auto" qui fetch QB
// directement (utile pour rattraper les rows liées avant que la capture
// automatique soit en place).
function QbCreditAccountInline({ payment, isAdmin, onChanged }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(payment.qb_credit_account_name || '')
  const [acctId, setAcctId] = useState(payment.qb_credit_account_id || '')
  const [saving, setSaving] = useState(false)
  const [autoLoading, setAutoLoading] = useState(false)
  const [err, setErr] = useState(null)

  async function save() {
    setSaving(true)
    setErr(null)
    try {
      const res = await api.admin.paymentRawUpdate(payment.id, {
        qb_credit_account_id: acctId.trim() || null,
        qb_credit_account_name: name.trim() || null,
      })
      if (res?.rejected && Object.keys(res.rejected).length) {
        setErr(`Rejeté : ${JSON.stringify(res.rejected)}`)
        return
      }
      setEditing(false)
      if (onChanged) await onChanged()
    } catch (e) {
      setErr(e.message || 'Erreur')
    } finally {
      setSaving(false)
    }
  }

  async function autoDetect() {
    setAutoLoading(true)
    setErr(null)
    try {
      const r = await api.payments.qbCreditAccount(payment.id)
      if (r.credit_account_name) {
        setName(r.credit_account_name)
        setAcctId(r.credit_account_id || '')
      } else {
        setErr('Aucun compte crédité détecté dans QB pour ce client')
      }
    } catch (e) {
      setErr(e.message || 'Erreur QB')
    } finally {
      setAutoLoading(false)
    }
  }

  if (editing) {
    return (
      <div className="inline-flex items-center gap-1 mt-0.5" data-testid={`payment-qb-credit-form-${payment.id}`}>
        <span className="text-[10px] text-slate-500 uppercase">Cr</span>
        <input
          type="text"
          value={name}
          onChange={e => setName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') save(); if (e.key === 'Escape') setEditing(false) }}
          placeholder="ex. 23900 Revenus perçus d'avance"
          className="text-[11px] border border-slate-300 rounded px-1 py-0.5 w-56"
          autoFocus
          disabled={saving}
          data-testid={`payment-qb-credit-input-${payment.id}`}
        />
        <button
          onClick={autoDetect}
          disabled={saving || autoLoading}
          className="text-[10px] px-1.5 py-0.5 text-brand-700 hover:bg-brand-50 rounded border border-brand-200 disabled:opacity-50"
          title="Détecter le compte crédité depuis QuickBooks"
          data-testid={`payment-qb-credit-auto-${payment.id}`}
        >
          {autoLoading ? '…' : 'auto'}
        </button>
        <button
          onClick={save}
          disabled={saving}
          className="text-[10px] px-1.5 py-0.5 bg-brand-600 hover:bg-brand-700 text-white rounded disabled:opacity-50"
          data-testid={`payment-qb-credit-save-${payment.id}`}
        >
          {saving ? '…' : 'OK'}
        </button>
        <button
          onClick={() => { setEditing(false); setErr(null); setName(payment.qb_credit_account_name || ''); setAcctId(payment.qb_credit_account_id || '') }}
          disabled={saving}
          className="text-[10px] px-1 text-slate-500 hover:bg-slate-100 rounded"
        >
          ✕
        </button>
        {err && <span className="text-[10px] text-red-600 ml-1" title={err}>!</span>}
      </div>
    )
  }

  if (payment.qb_credit_account_name) {
    return (
      <span
        className="text-[10px] text-slate-500 mt-0.5"
        title="Compte crédité dans QuickBooks pour cette opération"
        data-testid={`payment-qb-credit-display-${payment.id}`}
      >
        Cr {payment.qb_credit_account_name}
        {isAdmin && (
          <button
            onClick={() => setEditing(true)}
            className="ml-1 text-brand-600 hover:underline"
            title="Modifier le compte crédité"
            data-testid={`payment-qb-credit-edit-${payment.id}`}
          >
            ✎
          </button>
        )}
      </span>
    )
  }

  if (!isAdmin) return null
  return (
    <button
      onClick={() => setEditing(true)}
      className="text-[10px] text-brand-600 hover:underline mt-0.5 w-fit"
      title="Annoter le compte crédité dans QB pour la traçabilité comptable"
      data-testid={`payment-qb-credit-add-${payment.id}`}
    >
      + compte crédité
    </button>
  )
}

function PaymentList({ title, rows, icon: Icon, colorClass, onRetryQb, isAdmin, onChanged }) {
  return (
    <div>
      <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2 flex items-center gap-1.5">
        <Icon size={12} className={colorClass} /> {title}
      </p>
      <table className="w-full text-sm">
        <thead className="text-xs text-slate-400 uppercase tracking-wide">
          <tr>
            <th className="text-left pb-2 font-medium">Date</th>
            <th className="text-left pb-2 font-medium">Mode</th>
            <th className="text-right pb-2 font-medium w-32">Montant</th>
            <th className="text-left pb-2 pl-4 font-medium">Payout</th>
            <th className="text-left pb-2 font-medium">QB</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(p => (
            <PaymentRow
              key={p.id}
              p={p}
              isAdmin={isAdmin}
              onRetryQb={onRetryQb}
              onChanged={onChanged}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

function PaymentRow({ p, isAdmin, onRetryQb, onChanged }) {
  return (
    <>
      <tr className="border-t border-slate-100">
        <td className="py-2 text-slate-700 whitespace-nowrap">{fmtDate(p.received_at)}</td>
        <td className="py-2 text-slate-600">
          {METHOD_LABELS[p.method] || p.method}
          {p.stripe_charge_id && (
            <a
              href={`https://dashboard.stripe.com/payments/${p.stripe_charge_id}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-0.5 ml-1.5 text-brand-600 hover:underline"
              title="Voir dans Stripe"
            >
              <ExternalLink size={10} />
            </a>
          )}
        </td>
        <td className="py-2 text-right font-medium text-slate-800">{fmtMoney(p.amount, p.currency)}</td>
        <td className="py-2 pl-4 text-slate-600 whitespace-nowrap">
          {p.payout_stripe_id ? (
            <Link
              to={`/stripe-payouts/${p.payout_stripe_id}`}
              className="inline-flex items-center gap-1 text-xs font-mono text-brand-600 hover:underline"
              title="Voir le payout Stripe"
            >
              {p.payout_stripe_id.slice(-8)}
            </Link>
          ) : null}
        </td>
        <td className="py-2 text-slate-600 whitespace-nowrap">
          {(() => {
            // Cas paiement Stripe synthétique (pas de row payments) :
            // affiche le lien QB s'il existe (deferred ou JE constat).
            if (p.synthetic) {
              if (p.qb_payment_url) {
                return (
                  <a
                    href={p.qb_payment_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-mono text-brand-600 hover:underline"
                    title="Ouvrir dans QuickBooks"
                  >
                    QB <ExternalLink size={10} />
                  </a>
                )
              }
              // Pas de JE par paiement, mais le payout a été poussé en QB →
              // lien vers le Deposit du payout (où cette ligne est comptabilisée).
              if (p.payout_qb_deposit_id) {
                return (
                  <a
                    href={p.payout_qb_deposit_url || undefined}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-mono text-brand-600 hover:underline"
                    title={`Comptabilisé via le Deposit du payout (DEP #${p.payout_qb_deposit_id})`}
                  >
                    DEP #{p.payout_qb_deposit_id} <ExternalLink size={10} />
                  </a>
                )
              }
              return (
                <span className="inline-flex items-center gap-1 text-xs text-slate-400" title="La JE QB sera posée au push du payout Stripe">
                  au payout
                </span>
              )
            }
            // Nouvelles rows : qb_deposit_id (Deposit QB). Rows historiques :
            // qb_journal_entry_id (JE) ou qb_payment_id (SalesReceipt).
            const qbId = p.qb_deposit_id || p.qb_journal_entry_id || p.qb_payment_id
            const qbUrl = p.qb_deposit_url || p.qb_journal_entry_url || p.qb_payment_url
            const label = p.qb_deposit_id ? 'DEP' : (p.qb_journal_entry_id ? 'JE' : 'SR')
            if (!qbId) {
              // qb_skipped : QB intentionnellement non posté à la création
              // (encaissement déjà saisi à la main par le comptable). Pas de
              // Retry — relancer poserait un Deposit en double. On expose un
              // bouton "lier" pour rattacher l'id du Deposit/JE/SR créé à la
              // main dans QB, ce qui transforme la cellule en lien cliquable.
              if (p.qb_skipped) {
                return <QbSkippedCell payment={p} isAdmin={isAdmin} onChanged={onChanged} />
              }
              // Paiement/refund Stripe (row payments réelle) : la pose comptable
              // se fait au payout, pas par ligne. Pas de Retry — on affiche le
              // Deposit du payout s'il a été poussé, sinon "au payout".
              if (p.method === 'stripe') {
                if (p.payout_qb_deposit_id) {
                  return (
                    <a
                      href={p.payout_qb_deposit_url || undefined}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-mono text-brand-600 hover:underline"
                      title={`Comptabilisé via le Deposit du payout (DEP #${p.payout_qb_deposit_id})`}
                    >
                      DEP #{p.payout_qb_deposit_id} <ExternalLink size={10} />
                    </a>
                  )
                }
                return (
                  <span className="inline-flex items-center gap-1 text-xs text-slate-400" title="La JE QB sera posée au push du payout Stripe">
                    au payout
                  </span>
                )
              }
              return (
                <button
                  onClick={() => onRetryQb(p.id)}
                  className="inline-flex items-center gap-1 text-xs text-amber-700 bg-amber-50 hover:bg-amber-100 px-2 py-0.5 rounded"
                  title="Écriture QB non posée — réessayer"
                >
                  <RefreshCw size={10} /> Retry
                </button>
              )
            }
            // Compte crédité capturé lors de la liaison (suggestions QB ou
            // saisie manuelle) — affiché en seconde ligne pour la traçabilité
            // comptable (23900 perçus d'avance / 40000 ventes / 41000 service
            // / 12000 AR). Sans cette annotation, il faudrait rouvrir QB pour
            // identifier le compte.
            return (
              <div className="flex flex-col">
                {qbUrl ? (
                  <a
                    href={qbUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-mono text-brand-600 hover:underline w-fit"
                    title={`Ouvrir dans QuickBooks (${label} #${qbId})`}
                  >
                    {label} #{qbId} <ExternalLink size={10} />
                  </a>
                ) : (
                  <span className="text-xs font-mono">{label} #{qbId}</span>
                )}
                <QbCreditAccountInline payment={p} isAdmin={isAdmin} onChanged={onChanged} />
              </div>
            )
          })()}
        </td>
      </tr>
    </>
  )
}
