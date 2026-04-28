import { useState, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { ArrowLeft, X, Download, ExternalLink, Send, Hourglass, AlertCircle, CheckCircle2 } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { Badge } from '../components/Badge.jsx'
import { AbonnementDetailModal } from '../components/AbonnementDetailModal.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import { fmtDate } from '../lib/formatDate.js'


function fmtMoney(n, currency = 'CAD') {
  if (!n && n !== 0) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency }).format(n)
}

function formatTechValue(v) {
  if (v === null || v === undefined || v === '') return <span className="text-slate-300">—</span>
  if (typeof v === 'boolean') return v ? 'Oui' : 'Non'
  return String(v)
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

export default function FactureDetail() {
  const { id } = useParams()
  const navigate = useNavigate()
  const [facture, setFacture] = useState(null)
  const [loading, setLoading] = useState(true)
  const [projects, setProjects] = useState([])
  const [orders, setOrders] = useState([])
  const [companies, setCompanies] = useState([])
  const [saving, setSaving] = useState(false)
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [pdfBlobUrl, setPdfBlobUrl] = useState(null)
  const [_pdfLoading, _setPdfLoading] = useState(false)
  const [showPdfModal, setShowPdfModal] = useState(false)
  const [subscriptionModal, setSubscriptionModal] = useState(null)
  const [loadingSubscription, setLoadingSubscription] = useState(false)
  const [sendingInvoice, setSendingInvoice] = useState(false)
  const [sendError, setSendError] = useState(null)
  const [recognizingRevenue, setRecognizingRevenue] = useState(false)
  const [recognizeError, setRecognizeError] = useState(null)

  async function handleRecognizeRevenue() {
    setRecognizeError(null)
    setRecognizingRevenue(true)
    try {
      const res = await api.factures.recognizeRevenue(id)
      setFacture(res.facture)
    } catch (e) {
      setRecognizeError(e.message || 'Erreur')
    } finally {
      setRecognizingRevenue(false)
    }
  }

  async function handleSendInvoice() {
    // Only pending invoices can be sent from the ERP. The new endpoint expects
    // the pending_invoice_id (which is the same as facture.id when source='pending').
    if (facture?.source !== 'pending') return
    setSendError(null)
    setSendingInvoice(true)
    try {
      const r = await api.stripeInvoices.send(facture.id)
      setFacture(f => ({ ...f, status: 'En attente', last_session_url: r.checkout_session_url || f.last_session_url, pending_status: 'sent' }))
    } catch (e) {
      setSendError(e.message || 'Erreur')
    } finally {
      setSendingInvoice(false)
    }
  }

  async function openSubscriptionModal() {
    if (!facture.subscription_local_id) return
    setLoadingSubscription(true)
    try {
      const sub = await api.abonnements.get(facture.subscription_local_id)
      setSubscriptionModal(sub)
    } finally {
      setLoadingSubscription(false)
    }
  }

  useEffect(() => {
    setLoading(true)
    api.factures.get(id)
      .then(async data => {
        setFacture(data)
        setSelectedProjectId(data.project_id || '')
        if (data.airtable_pdf_path) {
          const token = localStorage.getItem('erp_token')
          fetch(`/erp/api/projets/factures/${id}/pdf`, {
            headers: { Authorization: `Bearer ${token}` }
          }).then(r => r.ok ? r.blob() : null)
            .then(blob => blob && setPdfBlobUrl(URL.createObjectURL(blob)))
            .catch(() => {})
        }
        if (data.company_id) {
          const [projectsRes, ordersRes] = await Promise.all([
            api.projects.list({ company_id: data.company_id, limit: 'all' }),
            api.orders.list({ company_id: data.company_id, limit: 'all' }),
          ])
          setProjects(projectsRes.data || [])
          setOrders(ordersRes.data || [])
        } else {
          setProjects([])
          setOrders([])
        }
      })
      .catch(() => setFacture(null))
      .finally(() => setLoading(false))
  }, [id])

  useEffect(() => {
    api.companies.lookup().then(setCompanies).catch(() => setCompanies([]))
  }, [])

  async function handleProjectChange(newProjectId) {
    setSelectedProjectId(newProjectId || '')
    setSaving(true)
    try {
      const updated = await api.factures.update(id, { project_id: newProjectId || null })
      setFacture(updated)
    } finally {
      setSaving(false)
    }
  }

  async function handleOrderChange(newOrderId) {
    setSaving(true)
    try {
      const updated = await api.factures.update(id, { order_id: newOrderId || null })
      setFacture(updated)
    } finally {
      setSaving(false)
    }
  }

  async function handleCompanyChange(newCompanyId) {
    setSaving(true)
    try {
      const updated = await api.factures.update(id, { company_id: newCompanyId || null })
      setFacture(updated)
      setSelectedProjectId(updated.project_id || '')
      if (updated.company_id) {
        const [projectsRes, ordersRes] = await Promise.all([
          api.projects.list({ company_id: updated.company_id, limit: 'all' }),
          api.orders.list({ company_id: updated.company_id, limit: 'all' }),
        ])
        setProjects(projectsRes.data || [])
        setOrders(ordersRes.data || [])
      } else {
        setProjects([])
        setOrders([])
      }
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-indigo-600" />
        </div>
      </Layout>
    )
  }
  if (!facture) return <Layout><div className="p-6 text-slate-500">Facture introuvable.</div></Layout>

  return (
    <Layout>
      <div className="p-6 max-w-4xl mx-auto">
        {/* Header */}
        <div className="flex items-start gap-4 mb-6">
          <button onClick={() => navigate('/factures')} className="mt-1 p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg">
            <ArrowLeft size={18} />
          </button>
          <div className="flex-1">
            <div className="flex items-center gap-3 flex-wrap">
              <h1 className="text-2xl font-bold text-slate-900">{facture.document_number || `Facture #${id}`}</h1>
              {facture.status && (
                <Badge color={STATUS_COLORS[facture.status] || 'gray'} size="md">
                  {facture.status}
                </Badge>
              )}
              {(() => {
                const stripeUrl = buildStripeUrl(facture)
                if (!stripeUrl) return null
                return (
                  <a
                    href={stripeUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg border border-indigo-200"
                    title="Ouvrir dans Stripe"
                  >
                    <ExternalLink size={12} /> Stripe
                  </a>
                )
              })()}
              {facture.source === 'pending' && (facture.pending_status === 'draft' || facture.pending_status === 'sent') && (
                <button
                  onClick={handleSendInvoice}
                  disabled={sendingInvoice}
                  className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-50"
                  title="Créer/rafraîchir la session Checkout et envoyer le lien par email Gmail"
                >
                  <Send size={12} /> {sendingInvoice ? 'Envoi…' : facture.pending_status === 'sent' ? 'Renvoyer par email' : 'Envoyer par email'}
                </button>
              )}
              {facture.source === 'pending' && facture.pay_url && (
                <a
                  href={facture.pay_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg"
                  title="Lien permanent de paiement (à partager au client si besoin)"
                >
                  <ExternalLink size={12} /> Lien de paiement
                </a>
              )}
              {/* Revenu reçu d'avance — états */}
              {facture.revenue_recognized_at ? (
                <span
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-emerald-700 bg-emerald-50 rounded-lg border border-emerald-200"
                  title={`Vente constatée le ${fmtDate(facture.revenue_recognized_at)}${facture.revenue_recognized_je_id ? ` — JE QB #${facture.revenue_recognized_je_id}` : ''}`}
                  data-testid="revenue-status-recognized"
                >
                  <CheckCircle2 size={12} /> Vente constatée
                </span>
              ) : facture.deferred_revenue_at && facture.has_linked_shipment ? (
                <button
                  onClick={handleRecognizeRevenue}
                  disabled={recognizingRevenue}
                  className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-amber-900 bg-amber-100 hover:bg-amber-200 rounded-lg border border-amber-300 disabled:opacity-50"
                  title="Poster une écriture de journal QB qui débite Revenus perçus d'avance et crédite Ventes pour constater la vente."
                  data-testid="revenue-recognize-btn"
                >
                  <AlertCircle size={12} /> {recognizingRevenue ? 'Publication…' : 'Constater la vente'}
                </button>
              ) : facture.deferred_revenue_at ? (
                <span
                  className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg border border-slate-200"
                  title={`Comptabilisé dans le compte Revenus perçus d'avance (23900) le ${fmtDate(facture.deferred_revenue_at)}. La vente sera constatée après le premier envoi sur une commande liée.`}
                  data-testid="revenue-status-deferred"
                >
                  <Hourglass size={12} /> Revenu perçu d'avance
                </span>
              ) : null}
            </div>
            {sendError && (
              <div className="mt-2 text-xs text-red-600">{sendError === 'gmail_not_connected' ? "Aucun compte Gmail connecté pour votre utilisateur." : sendError === 'no_recipient_email' ? "Aucune adresse email trouvée pour l'entreprise ou ses contacts." : sendError}</div>
            )}
            {recognizeError && (
              <div className="mt-2 text-xs text-red-600">Erreur constatation : {recognizeError}</div>
            )}
            {facture.deferred_revenue_at && !facture.revenue_recognized_at && (
              <div className="mt-2 text-xs text-slate-500">
                Cette facture est comptabilisée dans le compte <strong>23900 Revenus perçus d'avance</strong>
                {facture.deferred_revenue_amount_cad
                  ? ` pour ${fmtMoney(facture.deferred_revenue_amount_cad, 'CAD')}`
                  : ''}.
                {facture.has_linked_shipment
                  ? " Un envoi a été enregistré — autoriser l'écriture de journal pour constater la vente."
                  : " La vente sera constatable lorsqu'un envoi sera fait sur une commande liée."}
              </div>
            )}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
          {/* Entreprise */}
          <div className="grid grid-cols-2 gap-4 p-5">
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Entreprise</p>
              <LinkedRecordField
                name="company_id"
                value={facture.company_id}
                options={companies}
                labelFn={c => c.name}
                getHref={c => `/companies/${c.id}`}
                placeholder="Entreprise"
                saving={saving}
                onChange={handleCompanyChange}
              />
            </div>
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Projet</p>
              {facture.company_id ? (
                <LinkedRecordField
                  name="project_id"
                  value={selectedProjectId}
                  options={projects}
                  labelFn={p => p.name}
                  getHref={p => `/projects/${p.id}`}
                  placeholder="Projet"
                  saving={saving}
                  onChange={handleProjectChange}
                />
              ) : (
                <span className="text-slate-400 text-sm">Associer une entreprise d'abord</span>
              )}
            </div>
          </div>

          {/* Commande / Abonnement */}
          <div className="grid grid-cols-2 gap-4 p-5">
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Commande</p>
              {facture.company_id ? (
                <LinkedRecordField
                  name="order_id"
                  value={facture.order_id}
                  options={orders}
                  labelFn={o => `#${o.order_number}`}
                  getHref={o => `/orders/${o.id}`}
                  placeholder="Commande"
                  saving={saving}
                  onChange={handleOrderChange}
                />
              ) : (
                <span className="text-slate-400 text-sm">Associer une entreprise d'abord</span>
              )}
            </div>
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Abonnement</p>
              {facture.subscription_local_id
                ? <button onClick={openSubscriptionModal} disabled={loadingSubscription} className="text-indigo-600 hover:underline font-medium disabled:opacity-50 font-mono text-sm">{facture.subscription_stripe_id || facture.subscription_id}</button>
                : facture.subscription_id
                  ? <span className="text-slate-500 font-mono text-sm">{facture.subscription_id}</span>
                  : <span className="text-slate-400 text-sm">—</span>}
            </div>
          </div>

          {/* PDF thumbnail */}
          {pdfBlobUrl && (
            <div className="p-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Aperçu</p>
              <div
                className="relative cursor-pointer overflow-hidden rounded-lg border border-slate-200 bg-slate-50 hover:border-indigo-300 transition-colors"
                style={{ height: 200, width: 154 }}
                onClick={() => setShowPdfModal(true)}
              >
                <iframe
                  src={`${pdfBlobUrl}#toolbar=0&navpanes=0&scrollbar=0`}
                  className="absolute top-0 left-0 origin-top-left pointer-events-none"
                  style={{ width: '200%', height: '200%', transform: 'scale(0.5)' }}
                  title="Aperçu facture"
                />
                <div className="absolute inset-0 flex items-end justify-center pb-2 opacity-0 hover:opacity-100 transition-opacity bg-gradient-to-t from-black/20">
                  <span className="text-xs text-white font-medium">Agrandir</span>
                </div>
              </div>
            </div>
          )}

          {/* Dates */}
          <div className="grid grid-cols-3 gap-4 p-5">
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Date de facturation</p>
              <p className="text-sm text-slate-700">{fmtDate(facture.document_date)}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Date d'échéance</p>
              <p className="text-sm text-slate-700">{fmtDate(facture.due_date)}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Devise</p>
              <p className="text-sm font-mono text-slate-700">{facture.currency || '—'}</p>
            </div>
          </div>

          {/* Montants */}
          <div className="grid grid-cols-3 gap-4 p-5">
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Avant taxes</p>
              <p className="text-sm font-medium text-slate-700">{fmtMoney(
                facture.montant_avant_taxes != null ? parseFloat(facture.montant_avant_taxes) : facture.amount_before_tax_cad,
                facture.currency,
              )}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Total</p>
              <p className="text-sm font-medium text-slate-700">{fmtMoney(facture.total_amount, facture.currency)}</p>
            </div>
            <div>
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Solde dû</p>
              <p className={`text-sm font-medium ${facture.balance_due > 0 ? 'text-red-600' : 'text-green-600'}`}>
                {fmtMoney(facture.balance_due, facture.currency)}
              </p>
            </div>
          </div>

          {/* Notes */}
          {facture.notes && (
            <div className="p-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Notes</p>
              <p className="text-sm text-slate-700 whitespace-pre-wrap">{facture.notes}</p>
            </div>
          )}
        </div>

        {/* Pending invoice line items */}
        {facture.source === 'pending' && Array.isArray(facture.items) && facture.items.length > 0 && (
          <div className="bg-white rounded-xl border border-slate-200 mt-5 p-5">
            <h2 className="text-sm font-semibold text-slate-900 mb-3">Lignes de la facture</h2>
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-400 uppercase tracking-wide">
                <tr><th className="text-left pb-2">Description</th><th className="text-right pb-2 w-16">Qté</th><th className="text-right pb-2 w-32">Prix unit.</th><th className="text-right pb-2 w-32">Total</th></tr>
              </thead>
              <tbody>
                {facture.items.map((it, i) => (
                  <tr key={i} className="border-t border-slate-100">
                    <td className="py-2 text-slate-700">{it.description}</td>
                    <td className="py-2 text-right">{it.qty}</td>
                    <td className="py-2 text-right">{fmtMoney(Number(it.unit_price), facture.currency)}</td>
                    <td className="py-2 text-right">{fmtMoney(Number(it.qty) * Number(it.unit_price), facture.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Tech responses (paid Stripe invoices only) */}
        {Array.isArray(facture.tech_responses) && facture.tech_responses.length > 0 && (
          <div className="bg-white rounded-xl border border-slate-200 mt-5 p-5">
            <h2 className="text-sm font-semibold text-slate-900 mb-3">Informations techniques fournies par le client</h2>
            <div className="space-y-4">
              {facture.tech_responses.map(r => (
                <div key={r.id} className="border border-slate-100 rounded-lg p-3">
                  <div className="flex items-baseline justify-between mb-2">
                    <div className="font-medium text-slate-800">{r.product_name || r.product_sku || 'Produit'}</div>
                    {r.submitted_at && <div className="text-xs text-slate-400">Soumis le {fmtDate(r.submitted_at)}</div>}
                  </div>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-sm">
                    {(r.tech_info_fields || []).map(f => (
                      <div key={f.key} className="contents">
                        <dt className="text-xs text-slate-500 uppercase tracking-wide self-center">{f.label}</dt>
                        <dd className="text-slate-800">{formatTechValue(r.responses?.[f.key])}</dd>
                      </div>
                    ))}
                  </dl>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* PDF viewer modal */}
      {showPdfModal && pdfBlobUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/60" onClick={() => setShowPdfModal(false)} />
          <div className="relative bg-white rounded-xl shadow-2xl w-[95vw] max-w-6xl h-[92vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
              <span className="text-sm font-semibold text-slate-900">{facture.document_number}</span>
              <div className="flex items-center gap-2">
                <a href={pdfBlobUrl} download={`${facture.document_number}.pdf`} className="btn-secondary btn-sm flex items-center gap-1.5">
                  <Download size={13} /> Télécharger
                </a>
                <button onClick={() => setShowPdfModal(false)} className="p-1.5 text-slate-400 hover:text-slate-600 rounded">
                  <X size={16} />
                </button>
              </div>
            </div>
            <iframe src={pdfBlobUrl} className="flex-1 w-full" title="Facture PDF" />
          </div>
        </div>
      )}

      {subscriptionModal && (
        <AbonnementDetailModal abonnement={subscriptionModal} onClose={() => setSubscriptionModal(null)} />
      )}
    </Layout>
  )
}
