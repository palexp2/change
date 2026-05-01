import { useState, useEffect } from 'react'
import { Plus, ArrowDownCircle, ArrowUpCircle, AlertCircle, RefreshCw, ExternalLink } from 'lucide-react'
import { Link } from 'react-router-dom'
import api from '../lib/api.js'
import { fmtDate } from '../lib/formatDate.js'

function fmtMoney(n, currency = 'CAD') {
  if (n == null) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency }).format(n)
}

const METHOD_LABELS = {
  stripe: 'Stripe',
  cheque: 'Chèque',
  virement_bancaire: 'Virement bancaire',
  interac: 'Interac',
  comptant: 'Comptant',
  autre: 'Autre',
}

const MANUAL_METHODS = ['cheque', 'virement_bancaire', 'interac', 'comptant', 'autre']

export default function FacturePaymentsSection({ factureId, factureCurrency = 'CAD', factureIsPaid = false }) {
  const [payments, setPayments] = useState([])
  const [loading, setLoading] = useState(true)
  const [formOpen, setFormOpen] = useState(null) // null | 'in' | 'out'
  const [submitting, setSubmitting] = useState(false)
  const [err, setErr] = useState(null)

  // Form state
  const [method, setMethod] = useState('cheque')
  const [receivedAt, setReceivedAt] = useState(() => new Date().toISOString().slice(0, 10))
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState(factureCurrency)
  const [notes, setNotes] = useState('')

  function reload() {
    setLoading(true)
    api.payments.listForFacture(factureId)
      .then(rows => setPayments(rows || []))
      .catch(() => setPayments([]))
      .finally(() => setLoading(false))
  }

  useEffect(() => {
    if (!factureId) return
    reload()
  }, [factureId]) // eslint-disable-line react-hooks/exhaustive-deps

  function openForm(direction) {
    setMethod('cheque')
    setReceivedAt(new Date().toISOString().slice(0, 10))
    setAmount('')
    setCurrency(factureCurrency)
    setNotes('')
    setErr(null)
    setFormOpen(direction)
  }

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
      })
      setFormOpen(null)
      if (res.qb_error) setErr(`Saisi mais JE QB échouée : ${res.qb_error}`)
      reload()
    } catch (e) {
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
          <div className="mt-3 flex items-center justify-end gap-2">
            <button
              onClick={() => setFormOpen(null)}
              className="px-3 py-1.5 text-xs text-slate-600 hover:bg-slate-100 rounded-md"
            >Annuler</button>
            <button
              onClick={submit}
              disabled={submitting}
              className={`px-3 py-1.5 text-xs font-medium text-white rounded-md disabled:opacity-50 ${formOpen === 'in' ? 'bg-emerald-600 hover:bg-emerald-700' : 'bg-rose-600 hover:bg-rose-700'}`}
              data-testid="payment-submit"
            >{submitting ? 'Enregistrement…' : 'Enregistrer'}</button>
          </div>
        </div>
      )}

      <div className="px-5 py-3">
        {loading ? (
          <div className="text-xs text-slate-400">Chargement…</div>
        ) : payments.length === 0 ? (
          <div className="text-xs text-slate-400 italic">Aucun paiement enregistré pour cette facture.</div>
        ) : (
          <div className="space-y-3">
            {incoming.length > 0 && (
              <PaymentList title="Paiements reçus" rows={incoming} icon={ArrowDownCircle} colorClass="text-emerald-600" onRetryQb={retryQb} />
            )}
            {outgoing.length > 0 && (
              <PaymentList title="Remboursements émis" rows={outgoing} icon={ArrowUpCircle} colorClass="text-rose-600" onRetryQb={retryQb} />
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function PaymentList({ title, rows, icon: Icon, colorClass, onRetryQb }) {
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
            <th className="text-left pb-2 font-medium">Payout</th>
            <th className="text-left pb-2 font-medium">JE QB</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(p => (
            <tr key={p.id} className="border-t border-slate-100">
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
              <td className="py-2 text-slate-600 whitespace-nowrap">
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
                  // affiche le lien QB s'il existe (deferred ou JE constat),
                  // sinon "comptabilisé au payout" en lecture seule.
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
                    return (
                      <span className="inline-flex items-center gap-1 text-xs text-slate-400" title="La JE QB sera posée au push du payout Stripe">
                        au payout
                      </span>
                    )
                  }
                  const qbId = p.qb_journal_entry_id || p.qb_payment_id
                  const qbUrl = p.qb_journal_entry_url || p.qb_payment_url
                  const label = p.qb_payment_id && !p.qb_journal_entry_id ? 'SR' : 'JE'
                  if (!qbId) {
                    return (
                      <button
                        onClick={() => onRetryQb(p.id)}
                        className="inline-flex items-center gap-1 text-xs text-amber-700 bg-amber-50 hover:bg-amber-100 px-2 py-0.5 rounded"
                        title="JE non posée — réessayer"
                      >
                        <RefreshCw size={10} /> Retry
                      </button>
                    )
                  }
                  return qbUrl ? (
                    <a
                      href={qbUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-xs font-mono text-brand-600 hover:underline"
                      title={`Ouvrir dans QuickBooks (${label} #${qbId})`}
                    >
                      {label} #{qbId} <ExternalLink size={10} />
                    </a>
                  ) : (
                    <span className="text-xs font-mono">{label} #{qbId}</span>
                  )
                })()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
