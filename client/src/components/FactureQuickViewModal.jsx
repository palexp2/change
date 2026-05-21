import { useState, useEffect } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink, ArrowRight, CheckCircle2, Hourglass, AlertCircle } from 'lucide-react'
import api from '../lib/api.js'
import { Modal } from './Modal.jsx'
import { Badge } from './Badge.jsx'
import { fmtDate } from '../lib/formatDate.js'

const STATUS_COLORS = {
  'Payé': 'green',
  'Payée': 'green',
  'À payer': 'yellow',
  'Partielle': 'yellow',
  'En retard': 'red',
  'Envoyée': 'blue',
  'Draft': 'gray',
  'Brouillon': 'gray',
  'Annulée': 'red',
  'Void': 'gray',
  'Supprimé': 'gray',
  'Note de crédit': 'purple',
  'Remboursement': 'purple',
  'Uncollectible': 'red',
}

function fmtMoney(n, currency = 'CAD') {
  if (n == null || n === '') return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: (currency || 'CAD').toUpperCase() }).format(Number(n))
}

function buildStripeUrl(facture) {
  if (facture.lien_stripe) return facture.lien_stripe
  const id = facture.invoice_id
  if (!id) return null
  if (id.startsWith('in_')) return `https://dashboard.stripe.com/invoices/${id}`
  if (id.startsWith('re_')) return `https://dashboard.stripe.com/refunds/${id}`
  if (id.startsWith('ch_') || id.startsWith('pi_') || id.startsWith('py_') || id.startsWith('pyr_')) {
    return `https://dashboard.stripe.com/payments/${id}`
  }
  return null
}

function Field({ label, children }) {
  return (
    <div>
      <p className="text-xs text-slate-400 uppercase tracking-wide font-medium">{label}</p>
      <p className="text-sm text-slate-700 mt-0.5 break-words">{children ?? <span className="text-slate-300">—</span>}</p>
    </div>
  )
}

export function FactureQuickViewModal({ factureId, isOpen, onClose }) {
  const [facture, setFacture] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!isOpen || !factureId) {
      setFacture(null)
      setError(null)
      return
    }
    setLoading(true)
    setError(null)
    api.factures.get(factureId)
      .then(setFacture)
      .catch(e => setError(e.message || 'Erreur de chargement'))
      .finally(() => setLoading(false))
  }, [isOpen, factureId])

  const title = facture?.document_number
    ? `Facture ${facture.document_number}`
    : (factureId ? `Facture #${factureId}` : 'Facture')

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="lg">
      {loading && (
        <div className="flex items-center justify-center py-10">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-brand-600" />
        </div>
      )}

      {error && !loading && (
        <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {facture && !loading && (
        <div className="space-y-4" data-testid="facture-quick-view">
          {/* Header: status + Stripe link */}
          <div className="flex items-center gap-2 flex-wrap">
            {facture.status && (
              <Badge color={STATUS_COLORS[facture.status] || 'gray'} size="md">
                {facture.status}
              </Badge>
            )}
            {facture.kind && (
              <span className="inline-block text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-700">
                {facture.kind === 'subscription' ? 'Abonnement' : facture.kind === 'order' ? 'Commande' : facture.kind}
              </span>
            )}
            {(() => {
              const stripeUrl = buildStripeUrl(facture)
              return stripeUrl ? (
                <a
                  href={stripeUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-brand-600 bg-brand-50 hover:bg-brand-100 rounded-lg border border-brand-200"
                >
                  <ExternalLink size={12} /> Stripe
                </a>
              ) : null
            })()}
            {facture.revenue_recognized_at ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-emerald-700 bg-emerald-50 rounded-lg border border-emerald-200">
                <CheckCircle2 size={12} /> Vente constatée
              </span>
            ) : facture.deferred_revenue_at ? (
              <span className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg border border-slate-200">
                <Hourglass size={12} /> Revenu perçu d'avance
              </span>
            ) : null}
          </div>

          {/* Core info grid */}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Client">
              {facture.company_id ? (
                <Link
                  to={`/companies/${facture.company_id}`}
                  className="text-brand-600 hover:underline"
                  onClick={onClose}
                >
                  {facture.company_name || `Entreprise #${facture.company_id}`}
                </Link>
              ) : (
                facture.company_name
              )}
            </Field>
            <Field label="Projet">
              {facture.project_id ? (
                <Link
                  to={`/projects/${facture.project_id}`}
                  className="text-brand-600 hover:underline"
                  onClick={onClose}
                >
                  {facture.project_name || `Projet #${facture.project_id}`}
                </Link>
              ) : null}
            </Field>
            <Field label="Date facture">{fmtDate(facture.document_date)}</Field>
            <Field label="Échéance">{fmtDate(facture.due_date)}</Field>
            <Field label="Date paiement">
              {fmtDate(facture.paid_at)}
              {facture.paid_at && facture.paid_amount != null ? (
                <span className="text-xs text-slate-500"> · {fmtMoney(facture.paid_amount, facture.currency)}</span>
              ) : null}
            </Field>
            <Field label="Devise">{(facture.currency || 'CAD').toUpperCase()}</Field>
            <Field label="Montant avant taxes">
              {fmtMoney(facture.amount_before_tax_cad, facture.currency)}
            </Field>
            <Field label="Total">
              <span className="font-medium">{fmtMoney(facture.total_amount, facture.currency)}</span>
            </Field>
            <Field label="Solde dû">
              {Number(facture.balance_due) > 0 ? (
                <span className="text-amber-700 font-medium">{fmtMoney(facture.balance_due, facture.currency)}</span>
              ) : (
                <span className="text-emerald-700">{fmtMoney(0, facture.currency)}</span>
              )}
            </Field>
            <Field label="ID Stripe">
              {facture.invoice_id ? (
                <code className="text-xs text-slate-600">{facture.invoice_id}</code>
              ) : null}
            </Field>
            {facture.order_id ? (
              <Field label="Commande">
                <Link
                  to={`/orders/${facture.order_id_resolved || facture.order_id}`}
                  className="text-brand-600 hover:underline"
                  onClick={onClose}
                >
                  {facture.order_number || `Commande #${facture.order_id_resolved || facture.order_id}`}
                </Link>
              </Field>
            ) : null}
            {facture.subscription_local_id ? (
              <Field label="Abonnement">
                <Link
                  to={`/abonnements/${facture.subscription_local_id}`}
                  className="text-brand-600 hover:underline"
                  onClick={onClose}
                >
                  {facture.subscription_stripe_id || `#${facture.subscription_local_id}`}
                </Link>
              </Field>
            ) : null}
          </div>

          {facture.deferred_revenue_at && !facture.revenue_recognized_at && (
            <div className="text-xs text-slate-600 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 flex items-start gap-2">
              <AlertCircle size={14} className="mt-0.5 text-slate-500 flex-shrink-0" />
              <div>
                Comptabilisée en <strong>23900 Revenus perçus d'avance</strong>
                {facture.deferred_revenue_amount_cad ? ` pour ${fmtMoney(facture.deferred_revenue_amount_cad, 'CAD')}` : ''}.
                {facture.has_linked_shipment
                  ? " Un envoi a été enregistré — vente constatable."
                  : " La vente sera constatable lorsqu'un envoi sera fait sur une commande liée."}
              </div>
            </div>
          )}

          <div className="pt-2 border-t border-slate-100 flex justify-end">
            <Link
              to={`/factures/${facture.id}`}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-brand-700 bg-brand-50 hover:bg-brand-100 rounded-lg"
              onClick={onClose}
            >
              Ouvrir la fiche complète <ArrowRight size={14} />
            </Link>
          </div>
        </div>
      )}
    </Modal>
  )
}

export default FactureQuickViewModal
