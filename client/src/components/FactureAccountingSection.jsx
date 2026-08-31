import { useState, useEffect, useMemo } from 'react'
import {
  CheckCircle2, AlertCircle, AlertTriangle, ExternalLink, RefreshCw,
  Hourglass, FileText, CreditCard, Landmark, Package, Undo2, Link2, Pencil,
} from 'lucide-react'
import api from '../lib/api.js'
import { fmtDate, fmtDateTime } from '../lib/formatDate.js'
import { Modal } from './Modal.jsx'
import { useAuth } from '../lib/auth.jsx'

import { fmtMoney } from '../utils/formatters.js'

// Doit refléter QB_FACTURE_DATE_CUTOFF côté serveur (server/src/services/quickbooks.js).
// Toute écriture QB pour une facture dont document_date est antérieur est bloquée,
// sauf override explicite (bypassCutoff). Comparaison lexicographique sûre — les
// document_date sont stockés en 'YYYY-MM-DD'.
const QB_FACTURE_DATE_CUTOFF = '2026-05-01'
function isFacturerePreCutoff(facture) {
  return !!(facture?.document_date && facture.document_date < QB_FACTURE_DATE_CUTOFF)
}

// Numéro de compte AR selon la devise (plan comptable Orisha) :
// 12000 = Comptes clients CAD, 12100 = Comptes clients USD.
function arAccount(currency) {
  return String(currency || 'CAD').toUpperCase() === 'USD' ? '12100' : '12000'
}

// Compte crédité par la ligne de Deposit QB correspondant à *cette* facture
// au moment du push de payout. Reproduit la même logique de routage que
// `buildDepositFromPayout` (server/src/services/quickbooks.js) :
//   - abonnement                            → 41000 Revenus de service
//   - facture constatée + AR ouvert         → 12000/12100 Comptes clients
//   - facture en revenu reçu d'avance       → 23900 Revenus perçus d'avance
//   - sinon (cas « constatée direct depo ») → 40000 Ventes
// On ne peut pas relire la ligne réelle du Deposit (pas exposée par l'API),
// donc on dérive de l'état facture actuel — qui reflète l'état au push.
function payoutCreditAccount(facture) {
  if (facture?.kind === 'subscription') return '41000'
  if (facture?.revenue_recognized_at && Number(facture?.balance_due) > 0) {
    return arAccount(facture?.currency)
  }
  if (facture?.deferred_revenue_at) return '23900'
  return '40000'
}

function fmtCompactDateTime(iso) {
  if (!iso) return ''
  const s = String(iso)
  // Date-only (YYYY-MM-DD) : pas de conversion de fuseau, rendue telle quelle.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  const d = new Date(s)
  if (isNaN(d)) return ''
  const hasTime = /T\d{2}:\d{2}/.test(s)
  // Convention : un timestamp posé via <input type="date"> est stocké à minuit
  // local — heure non significative, on l'omet (sinon on affiche « 00:00 »).
  if (!hasTime || (d.getHours() === 0 && d.getMinutes() === 0)) return fmtDate(s)
  return fmtDateTime(s)
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
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
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
  const [linkKind, setLinkKind] = useState(null) // 'recognized' | 'deferred' | null
  const [linking, setLinking] = useState(false)
  const [linkError, setLinkError] = useState(null)
  // Édition manuelle de la date d'un événement de l'historique (admin only).
  // { event, value, saving, error } — null quand fermé.
  const [editEvent, setEditEvent] = useState(null)

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
  const canLinkDeferred = !facture?.deferred_revenue_at && facture?.kind !== 'subscription'
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

  async function submitLink({ kind, jeId, qbRef }) {
    setLinking(true)
    setLinkError(null)
    try {
      if (kind === 'recognized') {
        await api.admin.linkFactureRevenueRecognition(facture.id, jeId)
      } else if (kind === 'deferred') {
        await api.admin.linkFactureDeferredRevenue(facture.id, qbRef)
      }
      setLinkKind(null)
      if (onChanged) await onChanged()
    } catch (e) {
      setLinkError(e.message || 'Erreur lors du lien')
    } finally {
      setLinking(false)
    }
  }

  async function confirmRecognize(bypassCutoff) {
    setShowRecognizeModal(false)
    setRecognizeError(null)
    setRecognizing(true)
    try {
      await api.factures.recognizeRevenue(facture.id, { bypassShipmentCheck: true, bypassCutoff: bypassCutoff === true })
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
          {canRecognize && (
            <button
              onClick={() => { setLinkError(null); setLinkKind('recognized') }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg border border-slate-200"
              title="Lier une Journal Entry QB déjà existante (sans rien créer dans QuickBooks)."
              data-testid="accounting-link-recognized-btn"
            >
              <Link2 size={12} /> Lier JE existante
            </button>
          )}
          {canLinkDeferred && (
            <button
              onClick={() => { setLinkError(null); setLinkKind('deferred') }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg border border-slate-200"
              title="Lier un Deposit/SR/JE QB déjà existant qui pose le passif 23900 (sans rien créer dans QuickBooks)."
              data-testid="accounting-link-deferred-btn"
            >
              <Link2 size={12} /> Lier revenu différé
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
      {linkError && !linkKind && (
        <div className="px-5 py-2 text-xs text-rose-700 bg-rose-50 border-b border-rose-100" data-testid="accounting-link-error">
          Erreur : {linkError}
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
                canEdit={isAdmin && !!ev.editSource}
                onEditClick={() => { const v = toLocalInputValue(ev.date); setEditEvent({ event: ev, value: v, savedValue: v, saving: false, error: null, justSaved: false }) }}
              />
            ))}
          </ol>
        )}

        {checkedAt && (
          <div className="text-xs text-slate-400 mt-3 pt-2 border-t border-slate-100">
            Vérifié dans QuickBooks le {fmtDateTime(checkedAt)}
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

      <LinkQbModal
        kind={linkKind}
        facture={facture}
        linking={linking}
        error={linkError}
        onCancel={() => { setLinkKind(null); setLinkError(null) }}
        onSubmit={submitLink}
      />

      <EditEventDateModal
        state={editEvent}
        onChange={patch => setEditEvent(s => s ? { ...s, ...patch } : s)}
        onClose={() => setEditEvent(null)}
        onCommit={async (value) => {
          if (!editEvent) return
          const { event, savedValue } = editEvent
          const src = event.editSource
          if (!src) return
          // Autosave on blur : ne rien faire si la valeur n'a pas changé.
          if (value === savedValue) return
          // Empty input = clear (NULL). Sinon convertir le datetime-local
          // (heure locale du navigateur) en ISO UTC pour respecter la
          // convention DB (CLAUDE.md).
          const payload = value ? new Date(value).toISOString() : null
          setEditEvent(s => s ? { ...s, saving: true, error: null, justSaved: false } : s)
          try {
            if (src.kind === 'facture') {
              await api.admin.factureRawUpdate(facture.id, { [src.column]: payload })
            } else if (src.kind === 'payment') {
              await api.admin.paymentRawUpdate(src.id, { [src.column]: payload })
            }
            // La modale reste ouverte (autosave) ; on mémorise la valeur sauvée
            // et on affiche un indicateur « Enregistré ».
            setEditEvent(s => s ? { ...s, saving: false, savedValue: value, justSaved: true, error: null } : s)
            if (onChanged) await onChanged()
          } catch (e) {
            setEditEvent(s => s ? { ...s, saving: false, error: e?.message || 'Erreur lors de la sauvegarde' } : s)
          }
        }}
      />
    </div>
  )
}

// Convertit un ISO UTC en valeur acceptée par <input type="datetime-local">
// (« YYYY-MM-DDTHH:mm » en heure locale du navigateur). Renvoie '' si la
// date n'est pas parsable — l'utilisateur pourra alors saisir une valeur.
function toLocalInputValue(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function EditEventDateModal({ state, onChange, onClose, onCommit }) {
  if (!state) return null
  const { event, value, savedValue, saving, error, justSaved } = state
  const dirty = value !== savedValue
  return (
    <Modal isOpen={true} onClose={saving ? () => {} : onClose} title={`Modifier la date — ${event.label}`} size="sm">
      <div className="space-y-3 text-sm text-slate-700">
        <p className="text-xs text-slate-500">
          Édition manuelle de la colonne <code className="font-mono">{event.editSource?.column}</code> sur la table <code className="font-mono">{event.editSource?.kind === 'payment' ? 'payments' : 'factures'}</code>.
          Aucun mouvement QuickBooks ou Stripe n'est déclenché — seule la date locale change.
        </p>
        <label className="block">
          <span className="text-xs font-medium text-slate-600 block mb-1">Nouvelle date / heure</span>
          <input
            type="datetime-local"
            value={value}
            onChange={e => onChange({ value: e.target.value })}
            onBlur={() => onCommit(value)}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }}
            className="input w-full"
            data-testid="edit-event-date-input"
            disabled={saving}
          />
        </label>
        <p className="text-xs text-slate-400">
          Laisser vide pour effacer la valeur (NULL). Sauvegarde automatique.
        </p>
        {/* Indicateur d'état de l'autosave — non bloquant (CLAUDE.md). */}
        <div className="h-4 text-xs" data-testid="edit-event-date-status">
          {saving && <span className="text-slate-500">Enregistrement…</span>}
          {!saving && !error && justSaved && !dirty && <span className="text-emerald-600">Enregistré ✓</span>}
        </div>
        {error && (
          <p className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2">{error}</p>
        )}
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <button onClick={onClose} disabled={saving} className="px-3 py-1.5 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg disabled:opacity-50" data-testid="edit-event-date-close">
          Fermer
        </button>
      </div>
    </Modal>
  )
}

function LinkQbModal({ kind, facture, linking, error, onCancel, onSubmit }) {
  const [qbId, setQbId] = useState('')
  const [refType, setRefType] = useState('deposit')
  useEffect(() => {
    if (kind) { setQbId(''); setRefType('deposit') }
  }, [kind])
  if (!kind || !facture) return null
  const isRecognized = kind === 'recognized'
  const title = isRecognized
    ? 'Lier une Journal Entry QB existante'
    : 'Lier un passif Revenus perçus d\'avance existant'
  const handleSubmit = () => {
    const trimmed = qbId.trim()
    if (!trimmed) return
    if (isRecognized) onSubmit({ kind, jeId: trimmed })
    else onSubmit({ kind, qbRef: `${refType}:${trimmed}` })
  }
  return (
    <Modal isOpen={true} onClose={onCancel} title={title} size="md">
      <div className="space-y-3 text-sm text-slate-700">
        <p>
          Cette action <strong>ne crée rien dans QuickBooks</strong> — elle enregistre uniquement la référence locale pour la facture {facture.document_number}. La transaction QB est validée par une lecture (refusée si introuvable).
        </p>
        {!isRecognized && (
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Type de transaction</label>
            <select
              value={refType}
              onChange={e => setRefType(e.target.value)}
              disabled={linking}
              className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm"
              data-testid="link-deferred-type-select"
            >
              <option value="deposit">Deposit</option>
              <option value="salesreceipt">Sales Receipt</option>
              <option value="journal">Journal Entry</option>
            </select>
          </div>
        )}
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">
            {isRecognized ? 'ID Journal Entry QuickBooks' : 'ID de la transaction QuickBooks'}
          </label>
          <input
            type="text"
            value={qbId}
            onChange={e => setQbId(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSubmit() }}
            disabled={linking}
            placeholder="ex. 12345"
            className="w-full border border-slate-300 rounded-lg px-2 py-1.5 text-sm font-mono"
            data-testid="link-qb-id-input"
            autoFocus
          />
        </div>
        <p className="text-xs text-slate-500">
          {isRecognized
            ? <>La date de la JE (TxnDate) sera utilisée comme <code>revenue_recognized_at</code>.</>
            : <>La date de la transaction (TxnDate) sera utilisée comme <code>deferred_revenue_at</code>. Le montant <code>amount_before_tax_cad</code> de la facture sera repris pour <code>deferred_revenue_amount_*</code>.</>}
        </p>
        {error && (
          <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded p-2" data-testid="link-modal-error">
            {error}
          </div>
        )}
      </div>
      <div className="flex justify-end gap-2 mt-5">
        <button
          onClick={onCancel}
          disabled={linking}
          className="px-3 py-1.5 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg disabled:opacity-50"
        >
          Annuler
        </button>
        <button
          onClick={handleSubmit}
          disabled={linking || !qbId.trim()}
          className="px-3 py-1.5 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50"
          data-testid="link-qb-confirm-btn"
        >
          {linking ? 'Vérification…' : 'Lier'}
        </button>
      </div>
    </Modal>
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
      editSource: { kind: 'facture', column: 'created_at' },
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
      editSource: { kind: 'facture', column: 'paid_at' },
    })
  }

  // Le dépôt QB sur lequel le passif 23900 a été posté (si présent) — sert à
  // fusionner l'événement « Revenu perçu d'avance » avec l'encaissement (manuel
  // ou payout Stripe) qui partage ce même dépôt.
  const deferredDepositId = parseDeferredDepositId(facture.deferred_revenue_qb_ref)
  let deferredAbsorbed = false

  // 3. Encaissements manuels (chèque, Interac, virement, …) — fusion avec le
  // revenu perçu d'avance si le passif 23900 est posté sur le même dépôt QB.
  // Fusion additionnelle « + vente constatée » quand la ligne du Deposit QB
  // crédite directement un compte de revenu (4xxxx) — équivalent manuel du cas
  // « constatation directe par la ligne 40000 d'un Deposit Stripe ».
  let manualDirectRecognitionAbsorbed = false
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
    const creditAcct = (p.qb_credit_account_name || '').trim()
    const creditAcctNum = creditAcct.match(/^(\d{4,5})/)?.[1] || ''
    const withDirectRecognition = !withDeferred
      && !manualDirectRecognitionAbsorbed
      && p.qb_deposit_id
      && (creditAcctNum.startsWith('40') || creditAcctNum.startsWith('41'))
    if (withDirectRecognition) manualDirectRecognitionAbsorbed = true
    let label = `Encaissement ${METHOD_LABELS[p.method] || p.method}`
    let details = null
    if (withDeferred) {
      label += ` + revenu perçu d'avance`
      details = `Dr ${arAccount(p.currency)} · Cr 23900`
    } else if (withDirectRecognition) {
      label += ` + vente constatée`
      details = `Dr Banque · Cr ${creditAcct || '40000'}`
    }
    events.push({
      id: `pay-${p.id}`,
      date: p.received_at,
      icon: withDirectRecognition ? CheckCircle2 : CreditCard,
      tone: withDirectRecognition ? 'green' : 'emerald',
      label,
      amount: { value: p.amount, currency: p.currency },
      details,
      qbLink,
      qbStatus: withDeferred
        ? checkByKind.deferred_revenue?.qb_status
        : (withDirectRecognition ? checkByKind.revenue_recognition?.qb_status : null),
      qbConsistent: withDeferred
        ? checkByKind.deferred_revenue?.consistent
        : (withDirectRecognition ? checkByKind.revenue_recognition?.consistent : null),
      anomalyKind: withDeferred ? 'deferred' : (withDirectRecognition ? 'recognized' : null),
      editSource: { kind: 'payment', id: p.id, column: 'received_at' },
    })
  }

  // Détection du cas « constatation directe par la ligne 40000 d'un Deposit » :
  // pas de JE séparée, l'AR n'a jamais été ouvert (paiement Stripe encaissé
  // avant le push QB). Dans ce cas, la constatation vit sur la même ligne
  // que le payout — on l'absorbe dans l'événement du payout plutôt que de
  // l'afficher en double.
  const directRecognition = facture.revenue_recognized_at
    && !facture.revenue_recognized_je_id
    && !facture.deferred_revenue_at
    && facture.kind !== 'subscription'
  let recognitionAbsorberSid = null
  if (directRecognition) {
    let bestDelta = Infinity
    for (const p of payments) {
      const sid = p.payout_stripe_id
      if (!sid) continue
      const po = payouts[sid]?.payout
      if (!po?.qb_deposit_id) continue
      const ref = po.qb_pushed_at || po.arrival_date || po.created_date
      if (!ref) continue
      const delta = Math.abs(new Date(facture.revenue_recognized_at).getTime() - new Date(ref).getTime())
      if (delta < bestDelta) {
        bestDelta = delta
        recognitionAbsorberSid = sid
      }
    }
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
    const qbLink = po.payout.qb_deposit_id
      ? { label: `DEP #${po.payout.qb_deposit_id}`, url: po.payout.qb_deposit_url }
      : null
    const withDeferred = !deferredAbsorbed
      && facture.deferred_revenue_at
      && deferredDepositId
      && po.payout.qb_deposit_id
      && String(deferredDepositId) === String(po.payout.qb_deposit_id)
    if (withDeferred) deferredAbsorbed = true
    const withRecognition = sid === recognitionAbsorberSid
    // Affiche le couple Dr/Cr de la ligne de cette facture dans le Deposit QB
    // — plutôt que le total du payout + frais (qui sont des agrégats du dépôt
    // entier, pas propres à cette facture).
    const creditAccount = withDeferred ? '23900' : payoutCreditAccount(facture)
    // Montant constaté dans la devise native de la facture (HT = total - taxes)
    // — cohérent avec ce qu'on a affiché plus haut sur « Encaissée (Stripe) ».
    const taxesTotal = Array.isArray(facture.taxes)
      ? facture.taxes.reduce((s, t) => s + (Number(t?.amount) || 0), 0)
      : 0
    const recognizedNative = (Number(facture.total_amount) || 0) - taxesTotal
    const recognizedNativeCurrency = facture.currency || 'CAD'
    let label = 'Payout Stripe vers banque'
    if (withDeferred) label = 'Payout Stripe + revenu perçu d\'avance'
    else if (withRecognition) label = 'Payout Stripe + vente constatée'
    events.push({
      id: `payout-${po.payout.stripe_id}`,
      date: po.payout.arrival_date || po.payout.created_date,
      icon: withRecognition ? CheckCircle2 : Landmark,
      tone: withRecognition ? 'green' : 'sky',
      label,
      amount: withRecognition ? { value: recognizedNative, currency: recognizedNativeCurrency } : undefined,
      details: `Dr Banque · Cr ${creditAccount}`,
      qbLink,
      qbStatus: withDeferred
        ? checkByKind.deferred_revenue?.qb_status
        : (withRecognition ? checkByKind.revenue_recognition?.qb_status : null),
      qbConsistent: withDeferred
        ? checkByKind.deferred_revenue?.consistent
        : (withRecognition ? checkByKind.revenue_recognition?.consistent : null),
      anomalyKind: withDeferred ? 'deferred' : (withRecognition ? 'recognized' : null),
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

  // 6. Constatation de vente — sautée si déjà absorbée par l'événement du payout
  // ou de l'encaissement manuel (cas « ligne 40000 d'un Deposit »).
  if (facture.revenue_recognized_at && !recognitionAbsorberSid && !manualDirectRecognitionAbsorbed) {
    const recognizedAmount = facture.deferred_revenue_amount_cad ?? facture.amount_before_tax_cad
    const recognizedCurrency = facture.deferred_revenue_currency || facture.currency
    // Cas « constatation directe par la ligne 40000 d'un Deposit » : pas de JE
    // séparée, l'AR n'a jamais été ouvert (paiement Stripe encaissé avant le
    // push QB). La ligne du Deposit fait Dr Banque · Cr 40000. La banque est
    // routée par la devise du payout (BNC CAD ou Venn USD).
    const directDepositRecognition = !facture.revenue_recognized_je_id && !facture.deferred_revenue_at && facture.kind !== 'subscription'
    const bankLabel = (recognizedCurrency || facture.currency || 'CAD').toUpperCase() === 'USD' ? 'Venn USD' : 'BNC'
    const detailsBase = facture.kind === 'subscription'
      ? `Dr ${arAccount(recognizedCurrency)} · Cr 41000`
      : (facture.deferred_revenue_at
        ? 'Dr 23900 · Cr 40000'
        : (directDepositRecognition ? `Dr ${bankLabel} · Cr 40000` : `Dr ${arAccount(recognizedCurrency)} · Cr 40000`))
    // Fallback : quand `revenue_recognized_je_id` est null, la constatation a
    // été posée par la ligne 40000 d'un Deposit Stripe (pas de JE séparée).
    // On reconstitue le lien comptable via le payout dont le qb_deposit_id
    // partage l'horodatage de la constatation.
    let qbLink = null
    let recognizedDateOverride = null
    if (facture.revenue_recognized_je_id) {
      qbLink = { label: `JE #${facture.revenue_recognized_je_id}`, url: facture.revenue_recognized_qb_url }
    } else {
      const recognizedAt = facture.revenue_recognized_at
      let best = null
      let bestDelta = Infinity
      for (const p of payments) {
        const sid = p.payout_stripe_id
        if (!sid) continue
        const po = payouts[sid]?.payout
        if (!po?.qb_deposit_id) continue
        const ref = po.qb_pushed_at || po.arrival_date || po.created_date
        if (!ref) continue
        const delta = Math.abs(new Date(recognizedAt).getTime() - new Date(ref).getTime())
        if (delta < bestDelta) {
          bestDelta = delta
          best = po
        }
      }
      if (best?.qb_deposit_id) {
        qbLink = { label: `DEP #${best.qb_deposit_id}`, url: best.qb_deposit_url }
      }
      // La date comptable de la constatation = date du Deposit (= arrival_date
      // du payout), pas l'horodatage du push qui peut tomber un jour plus tard
      // si l'utilisateur a poussé le payout en retard.
      if (best?.arrival_date) recognizedDateOverride = best.arrival_date
    }
    events.push({
      id: 'recognized',
      date: recognizedDateOverride || facture.revenue_recognized_at,
      icon: shippedConsolidated ? Package : CheckCircle2,
      tone: 'green',
      label: shippedConsolidated ? 'Expédiée + vente constatée' : 'Vente constatée',
      amount: { value: recognizedAmount, currency: 'CAD' },
      details: detailsBase,
      qbLink,
      qbStatus: checkByKind.revenue_recognition?.qb_status,
      qbConsistent: checkByKind.revenue_recognition?.consistent,
      anomalyKind: 'recognized',
      editSource: { kind: 'facture', column: 'revenue_recognized_at' },
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
      editSource: { kind: 'payment', id: p.id, column: 'received_at' },
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
    editSource: { kind: 'facture', column: 'deferred_revenue_at' },
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
function EventRow({ event, onAnomalyClick, canEdit, onEditClick }) {
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
      {canEdit && (
        <button
          onClick={onEditClick}
          className="text-slate-300 hover:text-slate-700 flex-shrink-0 cursor-pointer ml-1"
          title="Modifier manuellement la date de cet événement"
          data-testid={`edit-event-${event.id}`}
        >
          <Pencil size={11} />
        </button>
      )}
    </li>
  )
}

function RecognizeConfirmModal({ isOpen, facture, recognizing, onCancel, onConfirm }) {
  const [bypassCutoff, setBypassCutoff] = useState(false)
  // Réinitialise le consentement de bypass chaque ouverture — on ne veut jamais
  // forcer un cutoff par inadvertance à cause d'un état laissé coché.
  useEffect(() => {
    if (isOpen) setBypassCutoff(false)
  }, [isOpen])
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
  const preCutoff = isFacturerePreCutoff(facture)
  // Quand pré-cutoff, la confirmation est bloquée tant que l'opérateur n'a pas
  // explicitement coché le bypass.
  const blocked = preCutoff && !bypassCutoff
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
        {preCutoff && (
          <div className="text-xs bg-rose-50 border border-rose-200 rounded-lg p-3 space-y-2" data-testid="recognize-cutoff-warning">
            <p className="text-rose-800">
              ⚠ Cette facture est datée du <strong>{fmtDate(facture.document_date)}</strong>, soit <strong>avant le cutoff comptable du {fmtDate(QB_FACTURE_DATE_CUTOFF)}</strong>.
              La compta historique est figée — toute écriture QB est normalement bloquée pour cette période.
            </p>
            <label className="flex items-start gap-2 cursor-pointer text-rose-900 font-medium">
              <input
                type="checkbox"
                checked={bypassCutoff}
                onChange={e => setBypassCutoff(e.target.checked)}
                className="mt-0.5"
                data-testid="recognize-bypass-cutoff"
              />
              <span>Forcer l'écriture malgré le cutoff du {fmtDate(QB_FACTURE_DATE_CUTOFF)} (j'assume l'impact sur la compta historique).</span>
            </label>
          </div>
        )}
      </div>
      <div className="flex justify-end gap-3 mt-6">
        <button onClick={onCancel} className="btn-secondary" disabled={recognizing}>Annuler</button>
        <button
          onClick={() => onConfirm(bypassCutoff)}
          disabled={recognizing || blocked}
          className="btn-primary"
          data-testid="accounting-recognize-confirm"
        >
          {recognizing ? 'Publication…' : (preCutoff ? 'Forcer la constatation' : 'Constater sur QuickBooks')}
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
