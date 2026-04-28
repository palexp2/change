import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, RefreshCw, ExternalLink, CheckCircle2, AlertCircle, Eye, Send, X } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { ConfirmModal } from '../components/Modal.jsx'
import { fmtDate } from '../lib/formatDate.js'

function fmtMoney(n, currency = 'CAD') {
  if (n == null) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: (currency || 'CAD').toUpperCase() }).format(n)
}

const STATUS_COLORS = {
  paid: 'green', pending: 'yellow', in_transit: 'blue', canceled: 'gray', failed: 'red',
}

// Render a compact TPS/TVQ breakdown used in the transactions table.
function TaxSplit({ gst, qst, currency }) {
  const hasG = Math.abs(gst || 0) > 0.001
  const hasQ = Math.abs(qst || 0) > 0.001
  if (!hasG && !hasQ) return <span className="text-slate-300">—</span>
  return (
    <div className="text-xs tabular-nums leading-tight">
      {hasG && <div>TPS {fmtMoney(gst, currency)}</div>}
      {hasQ && <div>TVQ {fmtMoney(qst, currency)}</div>}
    </div>
  )
}

const TX_TYPE_LABELS = {
  charge: 'Vente',
  payment: 'Vente',
  refund: 'Remboursement',
  payment_refund: 'Remboursement',
  stripe_fee: 'Frais Stripe',
  application_fee: 'Frais app',
  adjustment: 'Ajustement',
  dispute: 'Litige',
  payout: 'Payout',
}

function InfoField({ label, value }) {
  return (
    <div>
      <p className="text-xs text-slate-400 uppercase tracking-wide font-medium">{label}</p>
      <p className="text-sm text-slate-700 mt-0.5 break-words">{value ?? <span className="text-slate-300">—</span>}</p>
    </div>
  )
}

export default function StripePayoutDetail() {
  const { stripeId } = useParams()
  const navigate = useNavigate()
  const [payout, setPayout] = useState(null)
  const [transactions, setTransactions] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const [syncing, setSyncing] = useState(false)
  const [preview, setPreview] = useState(null)
  const [previewing, setPreviewing] = useState(false)
  const [pushing, setPushing] = useState(false)
  const [unlinking, setUnlinking] = useState(false)
  const [actionError, setActionError] = useState(null)
  const [actionInfo, setActionInfo] = useState(null)
  const [confirmState, setConfirmState] = useState(null)

  // Replacement for window.confirm: returns a promise that resolves to true/false
  // when the user answers the modal. Keeps handler control flow async-linear.
  const askConfirm = (opts) => new Promise((resolve) => {
    setConfirmState({
      ...opts,
      onConfirm: () => { setConfirmState(null); resolve(true) },
      onClose:   () => { setConfirmState(null); resolve(false) },
    })
  })

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await api.stripePayouts.get(stripeId)
      setPayout(data.payout)
      setTransactions(data.transactions || [])
    } catch (e) {
      setError(e.message || 'Erreur de chargement')
    } finally {
      setLoading(false)
    }
  }, [stripeId])

  useEffect(() => { load() }, [load])

  async function handleSyncTx() {
    setActionError(null)
    setActionInfo(null)
    setSyncing(true)
    try {
      const res = await api.stripePayouts.syncTransactions(stripeId)
      setActionInfo(`${res.transactions?.length || 0} transactions synchronisées`)
      setPreview(null)
      await load()
    } catch (e) {
      setActionError(e.message || 'Erreur de synchronisation')
    } finally {
      setSyncing(false)
    }
  }

  async function handlePreview() {
    setActionError(null)
    setActionInfo(null)
    setPreviewing(true)
    try {
      const res = await api.stripePayouts.previewDeposit(stripeId)
      setPreview(res)
    } catch (e) {
      setActionError(e.message || 'Erreur preview')
      setPreview(null)
    } finally {
      setPreviewing(false)
    }
  }

  async function handleUnlink() {
    const ok = await askConfirm({
      title: 'Délier le Deposit QB',
      message: `Délier le Deposit QB #${payout.qb_deposit_id} de ce payout ? L'ERP vérifiera auprès de QuickBooks que le Deposit n'existe plus avant de délier.`,
      confirmLabel: 'Délier',
      danger: true,
    })
    if (!ok) return
    setActionError(null)
    setActionInfo(null)
    setUnlinking(true)
    try {
      const res = await api.stripePayouts.unlinkDeposit(stripeId)
      setActionInfo(`Deposit QB #${res.previous_qb_deposit_id} délié — le payout peut être repoussé`)
      await load()
    } catch (e) {
      // If QB confirms the deposit still exists, offer a forced unlink
      if (/409|existe encore/i.test(e.message)) {
        const force = await askConfirm({
          title: 'Forcer le déliement',
          message: `${e.message} Délier quand même ?`,
          confirmLabel: 'Forcer',
          danger: true,
        })
        if (force) {
          try {
            const res = await api.stripePayouts.unlinkDeposit(stripeId, { force: true })
            setActionInfo(`Deposit QB #${res.previous_qb_deposit_id} délié (forcé)`)
            await load()
          } catch (e2) {
            setActionError(e2.message || 'Erreur unlink (force)')
          }
        }
      } else {
        setActionError(e.message || 'Erreur unlink QB')
      }
    } finally {
      setUnlinking(false)
    }
  }

  async function handlePush() {
    const ok = await askConfirm({
      title: 'Pousser vers QuickBooks',
      message: `Créer un dépôt QuickBooks de ${fmtMoney(payout.amount, payout.currency)} pour ce payout ?`,
      confirmLabel: 'Pousser',
    })
    if (!ok) return
    setActionError(null)
    setActionInfo(null)
    setPushing(true)
    try {
      const res = await api.stripePayouts.pushDeposit(stripeId)
      setActionInfo(
        res.qb_deposit_url ? (
          <span>
            Deposit QB #{res.qb_deposit_id} créé —{' '}
            <a href={res.qb_deposit_url} target="_blank" rel="noreferrer" className="underline font-medium inline-flex items-center gap-1">
              ouvrir dans QuickBooks <ExternalLink size={12} />
            </a>
          </span>
        ) : `Deposit QB #${res.qb_deposit_id} créé`
      )
      await load()
    } catch (e) {
      setActionError(e.message || 'Erreur push QB')
    } finally {
      setPushing(false)
    }
  }

  if (loading) return <Layout><div className="p-6 text-slate-500">Chargement…</div></Layout>
  if (error || !payout) return (
    <Layout>
      <div className="p-6">
        <button onClick={() => navigate('/stripe-payouts')} className="flex items-center gap-2 text-slate-600 hover:text-slate-900 mb-4">
          <ArrowLeft size={16} /> Retour
        </button>
        <div className="text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm">{error || 'Payout introuvable'}</div>
      </div>
    </Layout>
  )

  const alreadyPushed = !!payout.qb_deposit_id

  return (
    <Layout>
      <div className="p-6 max-w-6xl mx-auto">
        <button onClick={() => navigate('/stripe-payouts')} className="flex items-center gap-2 text-slate-600 hover:text-slate-900 mb-4">
          <ArrowLeft size={16} /> Retour aux payouts
        </button>

        {/* Header */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 mb-4">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-2xl font-bold text-slate-900 tabular-nums">{fmtMoney(payout.amount, payout.currency)}</h1>
                {payout.status && <Badge color={STATUS_COLORS[payout.status] || 'gray'}>{payout.status}</Badge>}
                {alreadyPushed && (
                  payout.qb_deposit_url ? (
                    <a
                      href={payout.qb_deposit_url}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-100 px-2 py-0.5 rounded-full hover:bg-green-200 hover:text-green-800 transition-colors"
                      title="Ouvrir le Deposit dans QuickBooks"
                    >
                      <CheckCircle2 size={10} /> QB Deposit #{payout.qb_deposit_id}
                      <ExternalLink size={10} />
                    </a>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-100 px-2 py-0.5 rounded-full">
                      <CheckCircle2 size={10} /> QB Deposit #{payout.qb_deposit_id}
                    </span>
                  )
                )}
              </div>
              <p className="text-sm text-slate-500 mt-1 font-mono">{payout.stripe_id}</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handleSyncTx}
                disabled={syncing}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50"
              >
                <RefreshCw size={14} className={syncing ? 'animate-spin' : ''} />
                {syncing ? 'Sync…' : 'Sync transactions'}
              </button>
              {payout.stripe_url && (
                <a href={payout.stripe_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50">
                  <ExternalLink size={14} /> Stripe
                </a>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-5 pt-4 border-t border-slate-100">
            <InfoField label="Date de dépôt" value={fmtDate(payout.arrival_date)} />
            <InfoField label="Devise" value={payout.currency} />
            <InfoField label="Méthode" value={payout.method} />
            <InfoField label="Type" value={payout.type} />
            <InfoField label="Banque" value={payout.bank_name ? `${payout.bank_name}${payout.bank_last4 ? ' …' + payout.bank_last4 : ''}` : null} />
            <InfoField label="Automatique" value={payout.automatic ? 'Oui' : 'Non'} />
            <InfoField label="Créé le" value={fmtDate(payout.created_date)} />
            <InfoField label="Envoyé à QB" value={payout.qb_pushed_at ? fmtDate(payout.qb_pushed_at) : null} />
          </div>

          {payout.description && (
            <div className="mt-4 pt-4 border-t border-slate-100">
              <InfoField label="Description" value={payout.description} />
            </div>
          )}

          {payout.failure_message && (
            <div className="mt-4 flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />
              <div>
                <div className="font-medium">{payout.failure_code}</div>
                <div>{payout.failure_message}</div>
              </div>
            </div>
          )}
        </div>

        {/* QB actions */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 mb-4">
          <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">QuickBooks</h2>
              <p className="text-xs text-slate-500 mt-0.5">Construire et pousser un Deposit à partir des balance_transactions.</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={handlePreview}
                disabled={previewing || transactions.length === 0}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50"
                title={transactions.length === 0 ? 'Synchroniser les transactions d\'abord' : 'Aperçu du Deposit QuickBooks'}
              >
                <Eye size={14} /> {previewing ? 'Aperçu…' : 'Aperçu Deposit'}
              </button>
              {alreadyPushed && (
                <button
                  onClick={handleUnlink}
                  disabled={unlinking}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-red-700 bg-white border border-red-200 rounded-lg hover:bg-red-50 disabled:opacity-50"
                  title="Délier le Deposit QB si supprimé/annulé dans QuickBooks"
                >
                  <X size={14} /> {unlinking ? 'Déliage…' : 'Délier'}
                </button>
              )}
              <button
                onClick={handlePush}
                disabled={pushing || alreadyPushed || transactions.length === 0}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
                title={alreadyPushed ? 'Déjà envoyé à QuickBooks' : 'Créer le Deposit dans QuickBooks'}
              >
                <Send size={14} /> {pushing ? 'Envoi…' : alreadyPushed ? 'Déjà envoyé' : 'Pousser vers QB'}
              </button>
            </div>
          </div>

          {actionError && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3 whitespace-pre-wrap">{actionError}</div>
          )}
          {actionInfo && (
            <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2 mb-3">{actionInfo}</div>
          )}

          {preview && <PreviewPanel preview={preview} currency={payout.currency} />}
        </div>

        {/* Transactions list */}
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-sm font-semibold text-slate-900">
              Transactions <span className="text-slate-400 font-normal">({transactions.length})</span>
            </h2>
          </div>

          {transactions.length === 0 ? (
            <div className="text-sm text-slate-400 italic py-6 text-center">
              Aucune transaction synchronisée — cliquer « Sync transactions » ci-dessus.
            </div>
          ) : (
            <div className="overflow-x-auto -mx-5">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-xs text-slate-500 uppercase tracking-wide">
                  <tr>
                    <th className="text-left px-3 py-2">Date</th>
                    <th className="text-left px-3 py-2">Type</th>
                    <th className="text-left px-3 py-2">Client</th>
                    <th className="text-left px-3 py-2">Facture</th>
                    <th className="text-right px-3 py-2">Montant</th>
                    <th className="text-right px-3 py-2" title="TPS/TVQ collectées du client (extraites de la facture Stripe)">Tx. vente</th>
                    <th className="text-right px-3 py-2" title="Frais Stripe de traitement (sans taxe)">Frais</th>
                    <th className="text-right px-3 py-2" title="TPS/TVQ que Stripe a ajoutées à ses propres frais (CTI/RTI récupérables)">Tx. frais</th>
                    <th className="text-right px-3 py-2">Net</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {transactions.map(bt => {
                    const feeTaxGst = bt.fee_tax_gst || 0
                    const feeTaxQst = bt.fee_tax_qst || 0
                    const invoiceTaxGst = bt.invoice_tax_gst || 0
                    const invoiceTaxQst = bt.invoice_tax_qst || 0
                    // Frais de traitement = bt.fee - portion taxe (bt.fee inclut la taxe sur les charges).
                    // Pour stripe_fee, bt.fee est purement la taxe → processing = 0.
                    const isStripeFee = bt.type === 'stripe_fee' || bt.type === 'application_fee'
                    const processingFee = isStripeFee ? 0 : (bt.fee || 0) - feeTaxGst - feeTaxQst
                    return (
                      <tr key={bt.stripe_id} className="hover:bg-slate-50">
                        <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{fmtDate(bt.created_date)}</td>
                        <td className="px-3 py-2">
                          <span className="inline-block text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-700">
                            {TX_TYPE_LABELS[bt.type] || bt.type}
                          </span>
                          {bt.is_subscription ? <span className="ml-1 text-[10px] text-indigo-600">abo</span> : null}
                        </td>
                        <td className="px-3 py-2 text-slate-700">{bt.customer_name || <span className="text-slate-300">—</span>}</td>
                        <td className="px-3 py-2 text-slate-600">{bt.invoice_number || <span className="text-slate-300">—</span>}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(bt.amount, bt.currency)}</td>
                        <td className="px-3 py-2 text-right text-slate-600">
                          <TaxSplit gst={invoiceTaxGst} qst={invoiceTaxQst} currency={bt.currency} />
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-slate-500">
                          {Math.abs(processingFee) > 0.001 ? fmtMoney(-processingFee, bt.currency) : <span className="text-slate-300">—</span>}
                        </td>
                        <td className="px-3 py-2 text-right text-slate-600">
                          <TaxSplit gst={-feeTaxGst} qst={-feeTaxQst} currency={bt.currency} />
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums font-medium">{fmtMoney(bt.net, bt.currency)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
      <ConfirmModal
        isOpen={!!confirmState}
        onClose={confirmState?.onClose ?? (() => {})}
        onConfirm={confirmState?.onConfirm ?? (() => {})}
        title={confirmState?.title}
        message={confirmState?.message}
        confirmLabel={confirmState?.confirmLabel}
        danger={confirmState?.danger}
      />
    </Layout>
  )
}

function PreviewPanel({ preview, currency }) {
  const { summary, warnings, deposit } = preview
  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden">
      <div className="bg-slate-50 px-4 py-2 border-b border-slate-200">
        <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wide">Aperçu Deposit</h3>
      </div>
      <div className="p-4 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <InfoField label="Montant" value={fmtMoney(summary.amount, currency)} />
        <InfoField label="Compte bancaire" value={summary.bank_account} />
        <InfoField label="Lignes" value={summary.lines_count} />
        <InfoField label="Devise" value={summary.currency} />
        <InfoField label="Ventes" value={fmtMoney(summary.revenue_sale, currency)} />
        <InfoField label="Abonnements" value={fmtMoney(summary.revenue_subscription, currency)} />
        <InfoField label="Remboursements" value={fmtMoney(summary.refunds, currency)} />
        <InfoField label="Frais Stripe (total)" value={fmtMoney(summary.fees_total, currency)} />
        {summary.taxes_on_fees_gst ? (
          <InfoField label="TPS sur frais Stripe (CTI)" value={fmtMoney(summary.taxes_on_fees_gst, currency)} />
        ) : null}
        {summary.taxes_on_fees_qst ? (
          <InfoField label="TVQ sur frais Stripe (RTI)" value={fmtMoney(summary.taxes_on_fees_qst, currency)} />
        ) : null}
      </div>

      {summary.fees_by_category && Object.values(summary.fees_by_category).some(v => Math.abs(v) > 0.001) ? (
        <div className="px-4 pb-4 pt-0">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-2">Ventilation des frais Stripe</p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
            {Object.entries(summary.fees_by_category)
              .filter(([, v]) => Math.abs(v) > 0.001)
              .map(([k, v]) => (
                <InfoField
                  key={k}
                  label={summary.fee_category_labels?.[k] || k}
                  value={fmtMoney(v, currency)}
                />
              ))}
          </div>
        </div>
      ) : null}

      {warnings && warnings.length > 0 && (
        <div className="border-t border-amber-200 bg-amber-50 px-4 py-2 space-y-1">
          <div className="text-xs font-semibold text-amber-800 flex items-center gap-1.5">
            <AlertCircle size={12} /> Avertissements ({warnings.length})
          </div>
          <ul className="text-xs text-amber-900 list-disc list-inside space-y-0.5">
            {warnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        </div>
      )}

      {deposit?.Line && (
        <details className="border-t border-slate-200">
          <summary className="px-4 py-2 text-xs text-slate-600 cursor-pointer hover:bg-slate-50">
            Lignes du Deposit ({deposit.Line.length})
          </summary>
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500 uppercase">
              <tr>
                <th className="text-left px-3 py-1.5">Description</th>
                <th className="text-right px-3 py-1.5">Montant</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {deposit.Line.map((l, i) => (
                <tr key={i}>
                  <td className="px-3 py-1.5 text-slate-700">{l.Description || '—'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{fmtMoney(l.Amount, currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
    </div>
  )
}
