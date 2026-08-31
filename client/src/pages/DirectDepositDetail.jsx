import { useState, useEffect, useCallback } from 'react'
import { useParams, useNavigate, Link } from 'react-router-dom'
import { ArrowLeft, ExternalLink, CheckCircle2, AlertCircle, Eye, Send, RefreshCw } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import Spinner from '../components/Spinner.jsx'
import { Badge } from '../components/Badge.jsx'
import { DetailLoadError } from '../components/DetailLoadError.jsx'
import { fmtDate } from '../lib/formatDate.js'
import { METHOD_LABELS, MANUAL_METHODS, PaymentConfirmModal } from '../components/FacturePaymentsSection.jsx'

import { fmtMoney } from '../utils/formatters.js'

function InfoField({ label, value }) {
  return (
    <div>
      <p className="text-xs text-slate-400 uppercase tracking-wide font-medium">{label}</p>
      <p className="text-sm text-slate-700 mt-0.5 break-words">{value ?? <span className="text-slate-300">—</span>}</p>
    </div>
  )
}

// Détail d'un dépôt direct (encaissement hors payouts Stripe) — miroir de
// StripePayoutDetail : header montant + badge QB cliquable, carte « QuickBooks »
// avec Aperçu Deposit et bouton Pousser mis en évidence.
//
// Deux modes selon ce que l'API renvoie pour :id :
//   - candidate : facture payée hors bande sans encaissement saisi → formulaire
//     (mode/date/montant/devise) + Aperçu + « Pousser vers QuickBooks » (le push
//     crée la ligne payments et poste le Deposit via le flux existant).
//   - deposit   : ligne payments existante → lien vers le Deposit QB, ou Retry
//     si la pose a échoué.
export default function DirectDepositDetail() {
  const { id } = useParams()
  const navigate = useNavigate()

  const [data, setData] = useState(null) // { kind, deposit?, candidate? }
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  // Formulaire (mode candidate)
  const [method, setMethod] = useState('virement_bancaire')
  const [receivedAt, setReceivedAt] = useState('')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState('CAD')
  const [notes, setNotes] = useState('')
  const [skipQb, setSkipQb] = useState(false)

  const [preview, setPreview] = useState(null)
  const [previewing, setPreviewing] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [pushing, setPushing] = useState(false)
  const [actionError, setActionError] = useState(null)
  const [actionInfo, setActionInfo] = useState(null)

  const load = useCallback(async (targetId = id) => {
    setLoading(true)
    setError(null)
    try {
      const res = await api.payments.directDeposit(targetId)
      if (res.kind === 'redirect') {
        // La facture a déjà un encaissement — bascule sur la vue du payment
        // sans recharger la page (l'URL reste utilisable dans les deux sens).
        return load(res.payment_id)
      }
      setData(res)
      if (res.kind === 'candidate') {
        const c = res.candidate
        setMethod('virement_bancaire')
        setReceivedAt((c.paid_at || '').slice(0, 10))
        setAmount(String(c.total_amount ?? ''))
        setCurrency((c.currency || 'CAD').toUpperCase())
      }
    } catch (e) {
      setError(e.message || 'Erreur de chargement')
    } finally {
      setLoading(false)
    }
  }, [id])

  useEffect(() => { load() }, [load])

  // Tout changement d'un champ qui influence l'écriture invalide l'aperçu.
  const invalidating = (setter) => (v) => { setter(v); setPreview(null) }

  async function handlePreview() {
    const amt = parseFloat(amount)
    if (!Number.isFinite(amt) || amt <= 0) { setActionError('Le montant doit être supérieur à 0.'); return }
    setActionError(null)
    setPreviewing(true)
    try {
      setPreview(await api.payments.previewDeposit({
        facture_id: data.candidate.id,
        amount: amt,
        currency,
        method,
        received_at: receivedAt || undefined,
      }))
    } catch (e) {
      setPreview(null)
      setActionError(e.message || 'Erreur aperçu')
    } finally {
      setPreviewing(false)
    }
  }

  function requestPush() {
    const amt = parseFloat(amount)
    if (!Number.isFinite(amt) || amt <= 0) { setActionError('Le montant doit être supérieur à 0.'); return }
    setActionError(null)
    setConfirmOpen(true)
  }

  async function push() {
    const amt = parseFloat(amount)
    setPushing(true)
    setActionError(null)
    setActionInfo(null)
    try {
      // clear_paid_status : efface l'état « payé » hérité du paid-out-of-band
      // Stripe dans la même transaction que la création du paiement (qui pousse
      // le Deposit QB). Route standard — pas de dépendance admin.
      const res = await api.payments.create({
        facture_id: data.candidate.id,
        direction: 'in',
        method,
        received_at: receivedAt || undefined,
        amount: amt,
        currency,
        notes: notes.trim() || undefined,
        skip_qb: skipQb || undefined,
        clear_paid_status: true,
      })
      setConfirmOpen(false)
      if (res.qb_error) {
        setActionError(`Paiement enregistré mais écriture QB échouée : ${res.qb_error} — bouton Réessayer ci-dessous.`)
      } else if (res.qb?.qb_deposit_id) {
        setActionInfo(
          <span>
            Deposit QB #{res.qb.qb_deposit_id} créé
            {res.qb.qb_deposit_url && (
              <>
                {' — '}
                <a href={res.qb.qb_deposit_url} target="_blank" rel="noreferrer" className="underline font-medium inline-flex items-center gap-1">
                  ouvrir dans QuickBooks <ExternalLink size={12} />
                </a>
              </>
            )}
          </span>
        )
      } else if (res.qb_skipped) {
        setActionInfo('Paiement enregistré — écriture QB marquée comme déjà postée (rien envoyé).')
      }
      await load(res.payment?.id || id)
    } catch (e) {
      setConfirmOpen(false)
      setActionError(e.message || 'Erreur')
    } finally {
      setPushing(false)
    }
  }

  async function retryQb() {
    setPushing(true)
    setActionError(null)
    setActionInfo(null)
    try {
      const r = await api.payments.retryQb(data.deposit.id)
      if (r.qb_deposit_id) setActionInfo(`Deposit QB #${r.qb_deposit_id} créé`)
      await load(data.deposit.id)
    } catch (e) {
      setActionError(e.message || 'Erreur push QB')
    } finally {
      setPushing(false)
    }
  }

  if (loading && !data) return <Layout><Spinner center label="Chargement…" /></Layout>
  if (error && !data) return <Layout><DetailLoadError message={error} onRetry={() => load()} retrying={loading} /></Layout>
  if (!data) return null

  const isCandidate = data.kind === 'candidate'
  const c = data.candidate
  const p = data.deposit
  const cur = isCandidate ? (c.currency || 'CAD') : (p.currency || 'CAD')
  const displayAmount = isCandidate ? c.total_amount : p.amount
  const documentNumber = isCandidate ? c.document_number : p.document_number
  const factureId = isCandidate ? c.id : p.facture_id
  const companyId = isCandidate ? c.company_id : p.company_id
  const companyName = isCandidate ? c.company_name : p.company_name

  const qbId = !isCandidate ? (p.qb_deposit_id || p.qb_journal_entry_id || p.qb_payment_id) : null
  const qbUrl = !isCandidate ? (p.qb_deposit_url || p.qb_journal_entry_url || p.qb_payment_url) : null
  const qbLabel = !isCandidate ? (p.qb_deposit_id ? 'Deposit' : (p.qb_journal_entry_id ? 'JE' : 'SR')) : null

  return (
    <Layout>
      <div className="p-6 max-w-4xl mx-auto">
        <button onClick={() => navigate('/stripe-payouts')} className="flex items-center gap-2 text-slate-600 hover:text-slate-900 mb-4">
          <ArrowLeft size={16} /> Retour aux payouts
        </button>

        {/* Header — miroir du détail payout */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 mb-4" data-testid="direct-deposit-header">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="flex items-center gap-3 flex-wrap">
                <h1 className="text-2xl font-bold text-slate-900 tabular-nums">{fmtMoney(displayAmount, cur)}</h1>
                {isCandidate ? (
                  <Badge color="yellow">À comptabiliser</Badge>
                ) : qbId ? (
                  <a
                    href={qbUrl || undefined}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-100 px-2 py-0.5 rounded-full hover:bg-green-200 hover:text-green-800 transition-colors"
                    title={`Ouvrir le ${qbLabel} dans QuickBooks`}
                    data-testid="direct-deposit-qb-pill"
                  >
                    <CheckCircle2 size={10} /> QB {qbLabel} #{qbId}
                    <ExternalLink size={10} />
                  </a>
                ) : p.qb_skipped ? (
                  <Badge color="gray">Saisi à la main dans QB</Badge>
                ) : (
                  <Badge color="red">QB non posté</Badge>
                )}
              </div>
              <p className="text-sm text-slate-500 mt-1">
                Dépôt direct (hors payouts Stripe) — facture{' '}
                <Link to={`/factures/${factureId}`} className="font-mono text-brand-600 hover:underline">{documentNumber || factureId}</Link>
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mt-5 pt-4 border-t border-slate-100">
            <InfoField
              label="Client"
              value={companyId
                ? <Link to={`/companies/${companyId}`} className="text-brand-600 hover:underline">{companyName}</Link>
                : companyName}
            />
            <InfoField label="Type de facture" value={(isCandidate ? c.kind : p.kind) === 'subscription' ? 'Abonnement' : 'Commande'} />
            <InfoField label="Devise" value={cur} />
            {isCandidate ? (
              <InfoField label="Marquée payée le" value={fmtDate(c.paid_at)} />
            ) : (
              <>
                <InfoField label="Reçu le" value={fmtDate(p.received_at)} />
                <InfoField label="Méthode" value={METHOD_LABELS[p.method] || p.method} />
                {p.exchange_rate && cur !== 'CAD' && <InfoField label={`Taux ${cur}→CAD`} value={p.exchange_rate} />}
                {p.qb_credit_account_name && <InfoField label="Compte crédité (Cr)" value={p.qb_credit_account_name} />}
                {p.notes && <InfoField label="Notes" value={p.notes} />}
              </>
            )}
          </div>
        </div>

        {/* Carte QuickBooks — l'action de push mise en évidence */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 mb-4">
          <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">QuickBooks</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {isCandidate
                  ? 'Construire et pousser un Deposit pour cet encaissement reçu directement en banque.'
                  : qbId
                    ? 'Écriture comptabilisée — ouvrir le Deposit dans QuickBooks via le badge ci-dessus.'
                    : p.qb_skipped
                      ? 'Écriture marquée comme déjà saisie manuellement dans QuickBooks (rattachable depuis la fiche facture).'
                      : 'La pose QuickBooks a échoué à la création — réessayer ci-dessous.'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {isCandidate && (
                <button
                  onClick={handlePreview}
                  disabled={previewing}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50"
                  title="Construire l'écriture QuickBooks sans l'envoyer"
                  data-testid="direct-deposit-preview"
                >
                  <Eye size={14} /> {previewing ? 'Aperçu…' : 'Aperçu Deposit'}
                </button>
              )}
              {isCandidate ? (
                <button
                  onClick={requestPush}
                  disabled={pushing}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Enregistrer l'encaissement et créer le Deposit dans QuickBooks"
                  data-testid="direct-deposit-push"
                >
                  <Send size={14} /> {pushing ? 'Envoi…' : (skipQb ? 'Enregistrer (sans pousser)' : 'Pousser vers QB')}
                </button>
              ) : qbId ? (
                <button
                  disabled
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed"
                  title="Déjà envoyé à QuickBooks"
                >
                  <Send size={14} /> Déjà envoyé
                </button>
              ) : !p.qb_skipped ? (
                <button
                  onClick={retryQb}
                  disabled={pushing}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50"
                  data-testid="direct-deposit-retry"
                >
                  <RefreshCw size={14} className={pushing ? 'animate-spin' : ''} /> {pushing ? 'Envoi…' : 'Pousser vers QB'}
                </button>
              ) : null}
            </div>
          </div>

          {actionError && (
            <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 mb-3 whitespace-pre-wrap">{actionError}</div>
          )}
          {actionInfo && (
            <div className="text-sm text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2 mb-3">{actionInfo}</div>
          )}

          {isCandidate && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 pt-3 border-t border-slate-100">
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Mode</label>
                  <select value={method} onChange={e => invalidating(setMethod)(e.target.value)} className="w-full text-sm border border-slate-300 rounded-md px-2 py-1.5">
                    {MANUAL_METHODS.map(m => <option key={m} value={m}>{METHOD_LABELS[m]}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Date de réception</label>
                  <input type="date" value={receivedAt} onChange={e => invalidating(setReceivedAt)(e.target.value)} className="w-full text-sm border border-slate-300 rounded-md px-2 py-1.5" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Montant</label>
                  <input
                    type="number" step="0.01" min="0" value={amount}
                    onChange={e => invalidating(setAmount)(e.target.value)}
                    className="w-full text-sm border border-slate-300 rounded-md px-2 py-1.5"
                    data-testid="direct-deposit-amount"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Devise</label>
                  <select value={currency} onChange={e => invalidating(setCurrency)(e.target.value)} className="w-full text-sm border border-slate-300 rounded-md px-2 py-1.5">
                    <option value="CAD">CAD</option>
                    <option value="USD">USD</option>
                  </select>
                </div>
              </div>
              <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3 items-end">
                <div>
                  <label className="block text-xs font-medium text-slate-500 mb-1">Notes (optionnel)</label>
                  <input
                    type="text" value={notes} onChange={e => setNotes(e.target.value)}
                    placeholder="Référence du virement, numéro de chèque, etc."
                    className="w-full text-sm border border-slate-300 rounded-md px-2 py-1.5"
                  />
                </div>
                <label className="inline-flex items-center gap-2 text-xs text-slate-600 cursor-pointer pb-2">
                  <input type="checkbox" checked={skipQb} onChange={e => setSkipQb(e.target.checked)} className="rounded border-slate-300" />
                  <span>Écriture déjà postée dans QuickBooks (ne pas re-poster)</span>
                </label>
              </div>

              {preview && <DepositPreviewPanel preview={preview} />}
            </>
          )}
        </div>
      </div>

      <PaymentConfirmModal
        isOpen={confirmOpen}
        submitting={pushing}
        direction="in"
        method={method}
        amount={parseFloat(amount)}
        currency={currency}
        skipQb={skipQb}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={push}
      />
    </Layout>
  )
}

// Aperçu du Deposit QB — même contrat visuel que le PreviewPanel du détail payout.
function DepositPreviewPanel({ preview }) {
  const { summary, warnings } = preview
  const cur = summary.currency
  return (
    <div className="mt-4 border border-slate-200 rounded-lg overflow-hidden" data-testid="direct-deposit-preview-panel">
      <div className="bg-slate-50 px-4 py-2 border-b border-slate-200">
        <h3 className="text-xs font-semibold text-slate-700 uppercase tracking-wide">Aperçu Deposit</h3>
      </div>
      <div className="p-4 grid grid-cols-2 md:grid-cols-3 gap-3 text-sm">
        <InfoField label="Dépôt (Dr banque)" value={summary.bank_account} />
        <InfoField label="Compte crédité" value={summary.credit_account} />
        <InfoField label="Montant reçu (TTC)" value={fmtMoney(summary.amount, cur)} />
        <InfoField label="Base HT" value={fmtMoney(summary.line_ht, cur)} />
        <InfoField label="Taxes (calculées par QB)" value={summary.taxes ? fmtMoney(summary.taxes, cur) : null} />
        <InfoField label="Code de taxe" value={summary.tax_code} />
        <InfoField label="Date" value={summary.txn_date} />
        {cur !== 'CAD' && <InfoField label={`Taux ${cur}→CAD`} value={summary.exchange_rate} />}
        <InfoField label="Client QB" value={summary.customer_name} />
      </div>
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
    </div>
  )
}
