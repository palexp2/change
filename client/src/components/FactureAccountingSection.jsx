import { useState } from 'react'
import { CheckCircle2, AlertTriangle, XCircle, ExternalLink, RefreshCw, Hourglass, Receipt, Trash2, HelpCircle } from 'lucide-react'
import api from '../lib/api.js'
import { fmtDate } from '../lib/formatDate.js'
import { Modal } from './Modal.jsx'

function fmtMoney(n, currency = 'CAD') {
  if (n == null) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency }).format(n)
}

const STATUS_STYLES = {
  exists: { Icon: CheckCircle2, color: 'text-emerald-700', bg: 'bg-emerald-50', border: 'border-emerald-200' },
  missing: { Icon: XCircle, color: 'text-rose-700', bg: 'bg-rose-50', border: 'border-rose-200' },
  line_missing: { Icon: AlertTriangle, color: 'text-amber-800', bg: 'bg-amber-50', border: 'border-amber-200' },
  unsupported: { Icon: HelpCircle, color: 'text-slate-700', bg: 'bg-slate-50', border: 'border-slate-200' },
  error: { Icon: AlertTriangle, color: 'text-amber-800', bg: 'bg-amber-50', border: 'border-amber-200' },
}

function CheckBadge({ check }) {
  if (check.consistent === true) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium text-emerald-800 bg-emerald-100 rounded-full">
        <CheckCircle2 size={11} /> Cohérent
      </span>
    )
  }
  if (check.consistent === false) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium text-rose-800 bg-rose-100 rounded-full">
        <XCircle size={11} /> Divergent
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-xs font-medium text-slate-700 bg-slate-100 rounded-full">
      <HelpCircle size={11} /> À vérifier
    </span>
  )
}

export default function FactureAccountingSection({ facture, onChanged }) {
  const [verifying, setVerifying] = useState(false)
  const [checks, setChecks] = useState(null)
  const [checkedAt, setCheckedAt] = useState(null)
  const [verifyError, setVerifyError] = useState(null)
  const [confirm, setConfirm] = useState(null) // { kind: 'deferred'|'recognized' }
  const [clearing, setClearing] = useState(false)

  const hasDeferred = !!facture?.deferred_revenue_at
  const hasRecognized = !!facture?.revenue_recognized_at
  const hasPaid = !!facture?.paid_at
  const hasAnyQbRef = !!(facture?.deferred_revenue_qb_ref || facture?.revenue_recognized_je_id)

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

  const checkByKind = Object.fromEntries((checks || []).map(c => [c.kind, c]))
  const deferredCheck = checkByKind.deferred_revenue
  const recognizedCheck = checkByKind.revenue_recognition

  return (
    <div className="bg-white rounded-xl border border-slate-200 mt-5" data-testid="facture-accounting-section">
      <div className="flex items-center justify-between px-5 py-3 border-b border-slate-100">
        <h2 className="text-sm font-semibold text-slate-900">État comptable QuickBooks</h2>
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

      {verifyError && (
        <div className="px-5 py-2 text-xs text-rose-700 bg-rose-50 border-b border-rose-100">
          {verifyError}
        </div>
      )}

      <div className="px-5 py-4 space-y-3">
        {/* Étape 1 — Encaissement */}
        <TimelineRow
          Icon={Receipt}
          tone="emerald"
          title="Encaissée"
          subtitle={hasPaid
            ? `Réglée le ${fmtDate(facture.paid_at)}${facture.paid_amount ? ` — ${fmtMoney(facture.paid_amount, facture.currency)}` : ''}`
            : 'Aucun paiement enregistré'}
          dim={!hasPaid}
        />

        {/* Étape 2 — Revenu perçu d'avance */}
        <TimelineRow
          Icon={Hourglass}
          tone="amber"
          title="Revenu perçu d'avance (passif 23900)"
          subtitle={hasDeferred ? (
            <>
              Posé le {fmtDate(facture.deferred_revenue_at)}
              {facture.deferred_revenue_amount_cad != null && ` — ${fmtMoney(facture.deferred_revenue_amount_cad, 'CAD')}`}
              {facture.deferred_revenue_qb_ref && (
                <>
                  {' · '}
                  <QbRefLink refStr={facture.deferred_revenue_qb_ref} url={facture.deferred_revenue_qb_url} />
                </>
              )}
            </>
          ) : 'Aucun passif local pour cette facture'}
          dim={!hasDeferred}
          badge={hasDeferred && deferredCheck ? <CheckBadge check={deferredCheck} /> : null}
          message={hasDeferred && deferredCheck ? deferredCheck.message : null}
          messageStatus={deferredCheck?.qb_status}
          onClear={hasDeferred ? () => setConfirm({ kind: 'deferred' }) : null}
          clearLabel="Effacer la référence locale"
        />

        {/* Étape 3 — Constatation de la vente */}
        <TimelineRow
          Icon={CheckCircle2}
          tone="green"
          title="Vente constatée (JE Dr 23900 / Cr 40000)"
          subtitle={hasRecognized ? (
            <>
              Constatée le {fmtDate(facture.revenue_recognized_at)}
              {facture.revenue_recognized_je_id && (
                <>
                  {' · '}
                  <QbRefLink refStr={`journal:${facture.revenue_recognized_je_id}`} url={facture.revenue_recognized_qb_url} />
                </>
              )}
            </>
          ) : 'Vente non constatée localement'}
          dim={!hasRecognized}
          badge={hasRecognized && recognizedCheck ? <CheckBadge check={recognizedCheck} /> : null}
          message={hasRecognized && recognizedCheck ? recognizedCheck.message : null}
          messageStatus={recognizedCheck?.qb_status}
          onClear={hasRecognized ? () => setConfirm({ kind: 'recognized' }) : null}
          clearLabel="Effacer la constatation locale"
        />

        {checkedAt && (
          <div className="text-xs text-slate-400 pt-2 border-t border-slate-100">
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
    </div>
  )
}

function TimelineRow({ Icon, tone, title, subtitle, badge, message, messageStatus, dim, onClear, clearLabel }) {
  const tones = {
    emerald: { ring: 'ring-emerald-200', bg: 'bg-emerald-50', text: 'text-emerald-700' },
    amber: { ring: 'ring-amber-200', bg: 'bg-amber-50', text: 'text-amber-700' },
    green: { ring: 'ring-emerald-200', bg: 'bg-emerald-50', text: 'text-emerald-700' },
  }
  const t = tones[tone] || tones.emerald
  const styles = messageStatus && STATUS_STYLES[messageStatus]
  return (
    <div className={`flex items-start gap-3 ${dim ? 'opacity-50' : ''}`}>
      <div className={`flex-shrink-0 mt-0.5 w-7 h-7 rounded-full flex items-center justify-center ring-1 ${t.ring} ${t.bg}`}>
        <Icon size={14} className={t.text} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium text-slate-900">{title}</span>
          {badge}
          {onClear && (
            <button
              onClick={onClear}
              className="ml-auto inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-medium text-slate-600 hover:text-rose-700 hover:bg-rose-50 rounded border border-slate-200 hover:border-rose-200"
              data-testid={`clear-${title.includes('avance') ? 'deferred' : 'recognized'}-btn`}
            >
              <Trash2 size={10} /> {clearLabel}
            </button>
          )}
        </div>
        <div className="text-xs text-slate-500 mt-0.5 break-words">{subtitle}</div>
        {message && (
          <div className={`mt-1.5 text-xs px-2 py-1 rounded border ${styles?.bg || 'bg-slate-50'} ${styles?.color || 'text-slate-700'} ${styles?.border || 'border-slate-200'}`}>
            {message}
          </div>
        )}
      </div>
    </div>
  )
}

function QbRefLink({ refStr, url }) {
  const label = `réf. QB ${refStr}`
  if (!url) return <span className="text-slate-500">{label}</span>
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-center gap-0.5 text-slate-600 hover:text-blue-700 hover:underline"
    >
      {label} <ExternalLink size={9} />
    </a>
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
