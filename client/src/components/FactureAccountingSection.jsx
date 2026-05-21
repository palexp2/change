import { useState, useEffect, useMemo } from 'react'
import {
  CheckCircle2, AlertCircle, AlertTriangle, ExternalLink, RefreshCw,
  Hourglass, FileText, CreditCard, Landmark, Package, Undo2,
} from 'lucide-react'
import api from '../lib/api.js'
import { fmtDate } from '../lib/formatDate.js'
import { Modal } from './Modal.jsx'

function fmtMoney(n, currency = 'CAD') {
  if (n == null) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency }).format(n)
}

// Numéro de compte AR selon la devise (plan comptable Orisha) :
// 12000 = Comptes clients CAD, 12100 = Comptes clients USD.
function arAccount(currency) {
  return String(currency || 'CAD').toUpperCase() === 'USD' ? '12100' : '12000'
}

function fmtCompactDateTime(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  const date = d.toLocaleDateString('fr-CA', { day: 'numeric', month: 'short' })
  // Time uniquement si l'horodatage a une composante horaire significative
  const hasTime = /T\d{2}:\d{2}/.test(String(iso))
  if (!hasTime) return date
  const time = d.toLocaleTimeString('fr-CA', { hour: '2-digit', minute: '2-digit', hour12: false })
  return `${date} · ${time}`
}

function shortId(id) {
  if (!id) return ''
  return id.length > 14 ? id.slice(0, 5) + '…' + id.slice(-4) : id
}

const CLOSE_IN_TIME_MS = 60 * 60 * 1000 // 1h — assez large pour absorber webhook+JE
function closeInTime(a, b) {
  if (!a || !b) return false
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) < CLOSE_IN_TIME_MS
}

const METHOD_LABELS = {
  stripe: 'Stripe',
  cheque: 'chèque',
  virement_bancaire: 'virement',
  interac: 'Interac',
  comptant: 'comptant',
  autre: 'autre',
}

const TONE_COLORS = {
  slate: 'text-slate-500',
  emerald: 'text-emerald-600',
  amber: 'text-amber-600',
  green: 'text-emerald-600',
  sky: 'text-sky-600',
  rose: 'text-rose-600',
}

export default function FactureAccountingSection({ facture, onChanged }) {
  const [payments, setPayments] = useState([])
  const [payouts, setPayouts] = useState({})
  const [verifying, setVerifying] = useState(false)
  const [checks, setChecks] = useState(null)
  const [checkedAt, setCheckedAt] = useState(null)
  const [verifyError, setVerifyError] = useState(null)
  const [confirm, setConfirm] = useState(null)
  const [clearing, setClearing] = useState(false)
  const [showRecognizeModal, setShowRecognizeModal] = useState(false)
  const [recognizing, setRecognizing] = useState(false)
  const [recognizeError, setRecognizeError] = useState(null)

  useEffect(() => {
    if (!facture?.id) return
    api.payments.listForFacture(facture.id)
      .then(rows => setPayments(rows || []))
      .catch(() => setPayments([]))
  }, [facture?.id, facture?.updated_at])

  // Charge les payouts Stripe référencés par les payments (1 fetch par payout
  // unique). Évite la N+1 dans `factures/:id` côté serveur.
  useEffect(() => {
    const ids = [...new Set(payments.map(p => p.payout_stripe_id).filter(Boolean))]
    if (ids.length === 0) { setPayouts({}); return }
    let cancelled = false
    Promise.all(ids.map(id =>
      api.stripePayouts.get(id).then(r => [id, r]).catch(() => [id, null])
    )).then(entries => {
      if (cancelled) return
      const map = {}
      for (const [id, data] of entries) {
        if (data) map[id] = data
      }
      setPayouts(map)
    })
    return () => { cancelled = true }
  }, [payments])

  const canRecognize = !facture?.revenue_recognized_at && facture?.kind !== 'subscription'
  const hasAnyQbRef = !!(facture?.deferred_revenue_qb_ref || facture?.revenue_recognized_je_id)

  const checkByKind = useMemo(
    () => Object.fromEntries((checks || []).map(c => [c.kind, c])),
    [checks]
  )

  async function verify() {
    setVerifying(true)
    setVerifyError(null)
    try {
      const res = await api.factures.qbState(facture.id)
      setChecks(res.checks || [])
      setCheckedAt(res.checked_at || new Date().toISOString())
    } catch (e) {
      setVerifyError(e.message || 'Erreur lors de la vérification QuickBooks')
    } finally {
      setVerifying(false)
    }
  }

  async function clearKind(kind) {
    setClearing(true)
    try {
      if (kind === 'deferred') {
        await api.admin.clearFactureDeferredRevenue(facture.id)
      } else if (kind === 'recognized') {
        await api.admin.clearFactureRevenueRecognition(facture.id)
      }
      setConfirm(null)
      setChecks(null)
      setCheckedAt(null)
      if (onChanged) await onChanged()
    } catch (e) {
      setVerifyError(e.message || 'Erreur lors du nettoyage local')
    } finally {
      setClearing(false)
    }
  }

  async function confirmRecognize() {
    setShowRecognizeModal(false)
    setRecognizeError(null)
    setRecognizing(true)
    try {
      await api.factures.recognizeRevenue(facture.id, { bypassShipmentCheck: true })
      if (onChanged) await onChanged()
    } catch (e) {
      setRecognizeError(e.message || 'Erreur lors de la constatation')
    } finally {
      setRecognizing(false)
    }
  }

  const events = useMemo(
    () => buildEvents(facture, payments, payouts, checkByKind),
    [facture, payments, payouts, checkByKind]
  )

  return (
    <div className="bg-white rounded-xl border border-slate-200 mt-5" data-testid="facture-accounting-section">
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100 gap-2">
        <h2 className="text-sm font-semibold text-slate-900">Historique des événements</h2>
        <div className="flex items-center gap-2">
          {canRecognize && (
            <button
              onClick={() => setShowRecognizeModal(true)}
              disabled={recognizing}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-brand-700 bg-brand-50 hover:bg-brand-100 rounded-lg border border-brand-200 disabled:opacity-50"
              title="Poster une JE Dr 23900|AR / Cr 40000 dans QuickBooks pour constater cette vente."
              data-testid="accounting-recognize-btn"
            >
              <AlertCircle size={12} /> {recognizing ? 'Publication…' : 'Constater manuellement'}
            </button>
          )}
          {hasAnyQbRef && (
            <button
              onClick={verify}
              disabled={verifying}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg border border-slate-200 disabled:opacity-50"
              data-testid="verify-qb-btn"
            >
              <RefreshCw size={12} className={verifying ? 'animate-spin' : ''} />
              {verifying ? 'Vérification…' : 'Vérifier dans QB'}
            </button>
          )}
        </div>
      </div>

      {(verifyError || recognizeError) && (
        <div className="px-5 py-2 text-xs text-rose-700 bg-rose-50 border-b border-rose-100" data-testid="accounting-recognize-error">
          {verifyError || `Erreur : ${recognizeError}`}
        </div>
      )}

      <div className="px-5 py-3 overflow-x-auto">
        {events.length === 0 ? (
          <div className="text-xs text-slate-400 italic py-2">Aucun événement comptable pour cette facture.</div>
        ) : (
          <ol className="space-y-1">
            {events.map(ev => (
              <EventRow
                key={ev.id}
                event={ev}
                onAnomalyClick={kind => setConfirm({ kind })}
              />
            ))}
          </ol>
        )}

        {checkedAt && (
          <div className="text-xs text-slate-400 mt-3 pt-2 border-t border-slate-100">
            Vérifié dans QuickBooks le {fmtDate(checkedAt)} à {new Date(checkedAt).toLocaleTimeString('fr-CA')}
          </div>
        )}
      </div>

      <ClearConfirmModal
        confirm={confirm}
        clearing={clearing}
        facture={facture}
        onCancel={() => setConfirm(null)}
        onConfirm={() => clearKind(confirm.kind)}
      />

      <RecognizeConfirmModal
        isOpen={showRecognizeModal}
        facture={facture}
        recognizing={recognizing}
        onCancel={() => setShowRecognizeModal(false)}
        onConfirm={confirmRecognize}
      />
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Builder : facture + payments + payouts + checks → liste d'événements triée.
// Consolidations explicites :
//  - paid_at + deferred_revenue_at proches (<1h) → « Encaissée + déférée »
//  - first_shipped_at + revenue_recognized_at proches (<1h) → « Expédiée + vente constatée »
// ─────────────────────────────────────────────────────────────────────────────
function buildEvents(facture, payments, payouts, checkByKind) {
  if (!facture) return []
  const events = []
  const manualIn = payments.filter(p => p.direction === 'in' && !p.synthetic && p.method !== 'stripe')
  const refunds = payments.filter(p => p.direction === 'out')

  // 1. Création
  if (facture.created_at) {
    events.push({
      id: 'created',
      date: facture.created_at,
      icon: FileText,
      tone: 'slate',
      label: 'Facture créée',
      amount: { value: facture.total_amount, currency: facture.currency },
    })
  }

  // 2. Encaissement Stripe — purement Stripe-side (l'argent est en transit
  // dans le clearing Stripe). Aucun mouvement QB lié à cet événement : le
  // dépôt QB n'est posé qu'au payout, et la constatation/passif différé
  // sont des événements distincts plus bas.
  if (facture.paid_at) {
    const chargeId = facture.paid_charge_id
    events.push({
      id: 'paid-stripe',
      date: facture.paid_at,
      icon: CreditCard,
      tone: 'emerald',
      label: 'Encaissée (Stripe)',
      amount: { value: facture.paid_amount || facture.total_amount, currency: facture.currency },
      stripeLink: chargeId ? { label: shortId(chargeId), url: `https://dashboard.stripe.com/payments/${chargeId}` } : null,
    })
  }

  // Le dépôt QB sur lequel le passif 23900 a été posté (si présent) — sert à
  // fusionner l'événement « Revenu perçu d'avance » avec l'encaissement (manuel
  // ou payout Stripe) qui partage ce même dépôt.
  const deferredDepositId = parseDeferredDepositId(facture.deferred_revenue_qb_ref)
  let deferredAbsorbed = false

  // 3. Encaissements manuels (chèque, Interac, virement, …) — fusion avec le
  // revenu perçu d'avance si le passif 23900 est posté sur le même dépôt QB.
  for (const p of manualIn) {
    const qbLink = p.qb_deposit_id
      ? { label: `DEP #${p.qb_deposit_id}`, url: p.qb_deposit_url }
      : (p.qb_journal_entry_id ? { label: `JE #${p.qb_journal_entry_id}`, url: p.qb_journal_entry_url } : null)
    const withDeferred = !deferredAbsorbed
      && facture.deferred_revenue_at
      && deferredDepositId
      && p.qb_deposit_id
      && String(deferredDepositId) === String(p.qb_deposit_id)
    if (withDeferred) deferredAbsorbed = true
    events.push({
      id: `pay-${p.id}`,
      date: p.received_at,
      icon: CreditCard,
      tone: 'emerald',
      label: withDeferred
        ? `Encaissement ${METHOD_LABELS[p.method] || p.method} + revenu perçu d'avance`
        : `Encaissement ${METHOD_LABELS[p.method] || p.method}`,
      amount: { value: p.amount, currency: p.currency },
      details: withDeferred ? `Dr ${arAccount(p.currency)} · Cr 23900` : null,
      qbLink,
      qbStatus: withDeferred ? checkByKind.deferred_revenue?.qb_status : null,
      qbConsistent: withDeferred ? checkByKind.deferred_revenue?.consistent : null,
      anomalyKind: withDeferred ? 'deferred' : null,
    })
  }

  // 4. Payouts Stripe — fusion avec le revenu perçu d'avance si le passif
  // 23900 est posté sur le même dépôt QB (cas du modèle « deferred posé au
  // payout » : Dr banque · Cr 23900 dans une seule transaction).
  const seenPayouts = new Set()
  for (const p of payments) {
    const sid = p.payout_stripe_id
    if (!sid || seenPayouts.has(sid)) continue
    seenPayouts.add(sid)
    const po = payouts[sid]
    if (!po || !po.payout) continue
    const totalFees = (po.transactions || []).reduce((s, t) => s + (Number(t.fee) || 0), 0)
    const cur = (po.payout.currency || 'cad').toUpperCase()
    const qbLink = po.payout.qb_deposit_id
      ? { label: `DEP #${po.payout.qb_deposit_id}`, url: po.payout.qb_deposit_url }
      : null
    const withDeferred = !deferredAbsorbed
      && facture.deferred_revenue_at
      && deferredDepositId
      && po.payout.qb_deposit_id
      && String(deferredDepositId) === String(po.payout.qb_deposit_id)
    if (withDeferred) deferredAbsorbed = true
    const feesPart = totalFees > 0 ? ` · frais ${fmtMoney(totalFees, cur)}` : ''
    events.push({
      id: `payout-${po.payout.stripe_id}`,
      date: po.payout.arrival_date || po.payout.created_date,
      icon: Landmark,
      tone: 'sky',
      label: withDeferred ? 'Payout Stripe + revenu perçu d\'avance' : 'Payout Stripe vers banque',
      amount: { value: po.payout.amount, currency: cur },
      details: withDeferred
        ? `Dr ${arAccount(cur)} · Cr 23900${feesPart}`
        : (totalFees > 0 ? `frais ${fmtMoney(totalFees, cur)}` : null),
      qbLink,
      qbStatus: withDeferred ? checkByKind.deferred_revenue?.qb_status : null,
      qbConsistent: withDeferred ? checkByKind.deferred_revenue?.consistent : null,
      anomalyKind: withDeferred ? 'deferred' : null,
    })
  }

  // Revenu perçu d'avance posté indépendamment d'un encaissement (cas legacy
  // ou si la JE de passif n'a pas été agrégée sur le même dépôt QB qu'un
  // encaissement manuel ou un payout Stripe).
  if (facture.deferred_revenue_at && !deferredAbsorbed) {
    events.push(makeDeferredEvent(facture, checkByKind))
  }

  // 5. Expédition — toujours affichée comme événement distinct, sauf si la
  // constatation tombe dans la même fenêtre temporelle (auquel cas on les
  // fusionne en « Expédiée + vente constatée »).
  const shippedAt = facture.first_shipped_at
  const shippedConsolidated = shippedAt && facture.revenue_recognized_at
    && closeInTime(shippedAt, facture.revenue_recognized_at)
  if (shippedAt && !shippedConsolidated) {
    events.push({
      id: 'shipped',
      date: shippedAt,
      icon: Package,
      tone: 'slate',
      label: 'Expédiée',
    })
  }

  // 6. Constatation de vente
  if (facture.revenue_recognized_at) {
    const recognizedAmount = facture.deferred_revenue_amount_cad ?? facture.amount_before_tax_cad
    const recognizedCurrency = facture.deferred_revenue_currency || facture.currency
    const detailsBase = facture.kind === 'subscription'
      ? `Dr ${arAccount(recognizedCurrency)} · Cr 41000`
      : (facture.deferred_revenue_at ? 'Dr 23900 · Cr 40000' : `Dr ${arAccount(recognizedCurrency)} · Cr 40000`)
    events.push({
      id: 'recognized',
      date: facture.revenue_recognized_at,
      icon: shippedConsolidated ? Package : CheckCircle2,
      tone: 'green',
      label: shippedConsolidated ? 'Expédiée + vente constatée' : 'Vente constatée',
      amount: { value: recognizedAmount, currency: 'CAD' },
      details: detailsBase,
      qbLink: facture.revenue_recognized_je_id
        ? { label: `JE #${facture.revenue_recognized_je_id}`, url: facture.revenue_recognized_qb_url }
        : null,
      qbStatus: checkByKind.revenue_recognition?.qb_status,
      qbConsistent: checkByKind.revenue_recognition?.consistent,
      anomalyKind: 'recognized',
    })
  }

  // 6. Remboursements
  for (const p of refunds) {
    const qbLink = p.qb_journal_entry_id
      ? { label: `JE #${p.qb_journal_entry_id}`, url: p.qb_journal_entry_url }
      : (p.qb_payment_id ? { label: `RR #${p.qb_payment_id}`, url: p.qb_payment_url }
        : (p.qb_deposit_id ? { label: `DEP #${p.qb_deposit_id}`, url: p.qb_deposit_url } : null))
    const refundId = p.stripe_refund_id
    events.push({
      id: `refund-${p.id}`,
      date: p.received_at,
      icon: Undo2,
      tone: 'rose',
      label: 'Remboursement',
      amount: { value: p.amount, currency: p.currency },
      stripeLink: refundId ? { label: shortId(refundId), url: `https://dashboard.stripe.com/refunds/${refundId}` } : null,
      qbLink,
    })
  }

  // Tri principal par date, mais quand deux événements tombent dans la même
  // fenêtre proche (< 1h) on les départage par priorité sémantique : la création
  // doit toujours précéder l'encaissement, même si l'horodatage Stripe est
  // antérieur (cas typique : facture importée d'Airtable après un paiement déjà
  // encaissé côté Stripe).
  events.sort((a, b) => {
    if (closeInTime(a.date, b.date)) {
      const pa = eventPriority(a.id)
      const pb = eventPriority(b.id)
      if (pa !== pb) return pa - pb
    }
    return String(a.date || '').localeCompare(String(b.date || ''))
  })
  return events
}

function eventPriority(id) {
  if (id === 'created') return 0
  if (id === 'paid-stripe' || id.startsWith('pay-')) return 1
  if (id === 'deferred') return 2
  if (id.startsWith('payout-')) return 3
  if (id === 'shipped' || id === 'recognized') return 4
  if (id.startsWith('refund-')) return 5
  return 99
}

function makeDeferredEvent(facture, checkByKind) {
  return {
    id: 'deferred',
    date: facture.deferred_revenue_at,
    icon: Hourglass,
    tone: 'amber',
    label: 'Revenu perçu d\'avance posté',
    amount: { value: facture.deferred_revenue_amount_cad, currency: 'CAD' },
    details: `Dr ${arAccount(facture.deferred_revenue_currency || facture.currency)} · Cr 23900`,
    qbLink: buildDeferredQbLink(facture),
    qbStatus: checkByKind.deferred_revenue?.qb_status,
    qbConsistent: checkByKind.deferred_revenue?.consistent,
    anomalyKind: 'deferred',
  }
}

function parseDeferredDepositId(ref) {
  if (!ref) return null
  const idx = ref.indexOf(':')
  if (idx < 0) return null
  if (ref.slice(0, idx) !== 'deposit') return null
  return ref.slice(idx + 1)
}

function buildDeferredQbLink(facture) {
  if (!facture.deferred_revenue_qb_ref) return null
  const ref = facture.deferred_revenue_qb_ref
  const idx = ref.indexOf(':')
  if (idx < 0) return { label: ref, url: facture.deferred_revenue_qb_url }
  const type = ref.slice(0, idx)
  const id = ref.slice(idx + 1)
  const labelMap = { deposit: 'DEP', salesreceipt: 'SR', journal: 'JE' }
  const labelPrefix = labelMap[type] || type.toUpperCase()
  return { label: `${labelPrefix} #${id}`, url: facture.deferred_revenue_qb_url }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ligne d'événement — 1 ligne unique, scrollable horizontalement si nécessaire.
// ─────────────────────────────────────────────────────────────────────────────
function EventRow({ event, onAnomalyClick }) {
  const Icon = event.icon
  const iconColor = TONE_COLORS[event.tone] || 'text-slate-500'
  const hasAnomaly = event.qbConsistent === false
    || event.qbStatus === 'missing'
    || event.qbStatus === 'line_missing'
    || event.qbStatus === 'error'
  const hasCheck = event.qbConsistent === true || event.qbStatus === 'exists'

  return (
    <li className="flex items-center gap-2 text-xs text-slate-700 py-0.5 whitespace-nowrap" data-testid={`event-${event.id}`}>
      <span className="text-slate-400 tabular-nums w-28 flex-shrink-0">{fmtCompactDateTime(event.date)}</span>
      <Icon size={13} className={`flex-shrink-0 ${iconColor}`} />
      <span className="font-medium text-slate-800">{event.label}</span>
      {event.amount?.value != null && (
        <span className="text-slate-600 tabular-nums">· {fmtMoney(event.amount.value, event.amount.currency || 'CAD')}</span>
      )}
      {event.details && <span className="text-slate-400">· {event.details}</span>}
      {event.stripeLink && (
        <a
          href={event.stripeLink.url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 text-slate-500 hover:text-blue-700 hover:underline font-mono"
          title={`Voir dans Stripe (${event.stripeLink.label})`}
        >
          <ExternalLink size={10} /> {event.stripeLink.label}
        </a>
      )}
      {event.qbLink && (
        event.qbLink.url ? (
          <a
            href={event.qbLink.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-slate-600 hover:text-blue-700 hover:underline font-mono"
            title="Ouvrir dans QuickBooks"
            data-testid={`qb-link-${event.id}`}
          >
            <ExternalLink size={10} /> {event.qbLink.label}
          </a>
        ) : (
          <span className="inline-flex items-center gap-0.5 text-slate-400 font-mono" title="Lien QB indisponible">
            {event.qbLink.label}
          </span>
        )
      )}
      {hasCheck && (
        <span
          className="text-emerald-600 flex-shrink-0 inline-flex"
          title="Cohérent avec QuickBooks"
          data-testid={`qb-ok-${event.id}`}
        >
          <CheckCircle2 size={11} />
        </span>
      )}
      {hasAnomaly && (
        <button
          onClick={() => event.anomalyKind && onAnomalyClick(event.anomalyKind)}
          className="text-amber-600 hover:text-amber-800 flex-shrink-0 cursor-pointer"
          title="Anomalie côté QuickBooks — cliquer pour effacer la référence locale"
          data-testid={event.anomalyKind ? `clear-${event.anomalyKind}-btn` : `qb-anomaly-${event.id}`}
        >
          <AlertTriangle size={12} />
        </button>
      )}
    </li>
  )
}

function RecognizeConfirmModal({ isOpen, facture, recognizing, onCancel, onConfirm }) {
  if (!isOpen || !facture) return null
  const isDeferred = !!facture.deferred_revenue_at
  const debitAccount = isDeferred
    ? '23900 Revenus perçus d\'avance'
    : (facture.currency === 'USD' ? '12100 Comptes clients USD' : '12000 Comptes clients CAD')
  const amount = isDeferred
    ? (facture.deferred_revenue_amount_native || facture.amount_before_tax_cad)
    : facture.amount_before_tax_cad
  const currency = facture.currency || 'CAD'
  const hasShipment = !!facture.has_linked_shipment
  return (
    <Modal isOpen={true} onClose={onCancel} title="Constater la vente sur QuickBooks" size="md">
      <div className="text-sm text-slate-700 space-y-3">
        <p>Cette action déclenchera les opérations suivantes :</p>
        <ul className="list-disc pl-5 space-y-1.5">
          <li>
            Création d'un <strong>Journal Entry</strong> dans QuickBooks :
            {' '}Dr <strong>{debitAccount}</strong> · Cr <strong>40000 Ventes</strong>
            {isDeferred ? ' (libère le passif)' : ' (ouvre l\'AR)'}
          </li>
          <li>Montant HT : <strong>{fmtMoney(amount, currency)}</strong></li>
          <li>
            La facture sera marquée <strong>Vente constatée</strong> (<code>revenue_recognized_at</code>) — opération irréversible côté ERP.
          </li>
          {!hasShipment && (
            <li className="text-amber-700">
              ⚠ Aucun envoi enregistré sur cette commande — le constat sera <strong>forcé</strong> (bypass du check d'envoi).
            </li>
          )}
        </ul>
      </div>
      <div className="flex justify-end gap-3 mt-6">
        <button onClick={onCancel} className="btn-secondary" disabled={recognizing}>Annuler</button>
        <button
          onClick={onConfirm}
          disabled={recognizing}
          className="btn-primary"
          data-testid="accounting-recognize-confirm"
        >
          {recognizing ? 'Publication…' : 'Constater sur QuickBooks'}
        </button>
      </div>
    </Modal>
  )
}

function ClearConfirmModal({ confirm, clearing, facture, onCancel, onConfirm }) {
  if (!confirm) return null
  const isDeferred = confirm.kind === 'deferred'
  const title = isDeferred ? 'Effacer le passif local 23900 ?' : 'Effacer la constatation locale ?'
  const columns = isDeferred
    ? ['deferred_revenue_at', 'deferred_revenue_qb_ref', 'deferred_revenue_amount_native', 'deferred_revenue_amount_cad', 'deferred_revenue_currency']
    : ['revenue_recognized_at', 'revenue_recognized_je_id']
  const qbRef = isDeferred ? facture?.deferred_revenue_qb_ref : (facture?.revenue_recognized_je_id ? `journal:${facture.revenue_recognized_je_id}` : null)
  return (
    <Modal isOpen={true} onClose={onCancel} title={title} size="md">
      <div className="space-y-3 text-sm text-slate-700">
        <p>
          Cette action <strong>ne touche pas QuickBooks</strong> — elle efface uniquement les colonnes locales suivantes pour la facture {facture?.document_number} :
        </p>
        <ul className="font-mono text-xs bg-slate-50 border border-slate-200 rounded p-2 space-y-0.5">
          {columns.map(c => <li key={c}>• <code>{c}</code> → NULL</li>)}
        </ul>
        {qbRef && (
          <p className="text-xs text-slate-500">
            Référence QB pointée par cette facture : <code>{qbRef}</code>. Cette transaction restera intacte dans QuickBooks.
          </p>
        )}
        <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded p-2">
          À utiliser uniquement quand la transaction QB référencée a été modifiée ou supprimée manuellement, ou ne reflète plus la réalité comptable.
        </p>
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg"
        >
          Annuler
        </button>
        <button
          onClick={onConfirm}
          disabled={clearing}
          className="px-3 py-1.5 text-sm font-medium text-white bg-rose-600 hover:bg-rose-700 rounded-lg disabled:opacity-50"
          data-testid="confirm-clear-btn"
        >
          {clearing ? 'Effacement…' : 'Effacer la référence locale'}
        </button>
      </div>
    </Modal>
  )
}
