import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import { ExternalLink, Send, Hourglass, Trash2 } from 'lucide-react'
import api from '../lib/api.js'
import { DetailShell, detailPending } from '../components/DetailShell.jsx'
import { Badge, FACTURE_STATUS_COLORS as STATUS_COLORS } from '../components/Badge.jsx'
import { Modal } from '../components/Modal.jsx'
import { AbonnementDetailModal } from '../components/AbonnementDetailModal.jsx'
import { SendPaymentLinkModal } from '../components/SendPaymentLinkModal.jsx'
import LinkedRecordField from '../components/LinkedRecordField.jsx'
import FacturePaymentsSection from '../components/FacturePaymentsSection.jsx'
import FactureAccountingSection from '../components/FactureAccountingSection.jsx'
import { FieldGuard, FieldGuardProvider } from '../components/FieldGuard.jsx'
import { Field } from '../components/Field.jsx'
import { CustomDetailFields } from '../components/CustomDetailFields.jsx'
import { useAuth } from '../lib/auth.jsx'
import { fmtDate } from '../lib/formatDate.js'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'
import { invalidate } from '../lib/prefetch.js'
import AttachmentPreview from '../components/AttachmentPreview.jsx'

// Champs disponibles pour le builder de règles de visibilité. Le picker
// utilise `field` (clé du record) et `label` (humain). On expose un
// sur-ensemble de `TABLE_COLUMN_META.factures` car les pages détail montrent
// plus de champs que les tables (subscription_id, kind, source, etc.).
const FACTURE_RULE_FIELDS = [
  { id: 'company_id',          field: 'company_id',          label: 'Entreprise (id)' },
  { id: 'company_name',        field: 'company_name',        label: 'Entreprise (nom)' },
  { id: 'customer_email',      field: 'customer_email',      label: 'Courriel client (Stripe)' },
  { id: 'project_id',          field: 'project_id',          label: 'Projet (id)' },
  { id: 'project_name',        field: 'project_name',        label: 'Projet (nom)' },
  { id: 'order_id',            field: 'order_id',            label: 'Commande (id)' },
  { id: 'order_number',        field: 'order_number',        label: 'Commande (n°)' },
  { id: 'subscription_id',     field: 'subscription_id',     label: 'Abonnement (id Stripe)' },
  { id: 'subscription_local_id', field: 'subscription_local_id', label: 'Abonnement (id local)' },
  { id: 'kind',                field: 'kind',                label: 'Type (kind : order/subscription)' },
  { id: 'source',              field: 'source',              label: 'Source (stripe/pending)' },
  { id: 'status',              field: 'status',              label: 'Statut' },
  { id: 'currency',            field: 'currency',            label: 'Devise' },
  { id: 'is_sent',             field: 'is_sent',             label: 'Envoyée' },
  { id: 'is_sent_manual',      field: 'is_sent_manual',      label: 'Envoyée forcée manuellement' },
  { id: 'has_linked_shipment', field: 'has_linked_shipment', label: 'A un envoi lié' },
  { id: 'deferred_revenue_at', field: 'deferred_revenue_at', label: 'Comptabilisé en revenu reçu d\'avance' },
  { id: 'revenue_recognized_at', field: 'revenue_recognized_at', label: 'Vente constatée' },
  { id: 'paid_at',             field: 'paid_at',             label: 'Date de paiement' },
  { id: 'balance_due',         field: 'balance_due',         label: 'Solde dû' },
  { id: 'document_date',       field: 'document_date',       label: 'Date document' },
  { id: 'due_date',            field: 'due_date',            label: 'Date d\'échéance' },
  { id: 'invoice_id',          field: 'invoice_id',          label: 'ID Stripe/source' },
]


import { fmtMoney } from '../utils/formatters.js'


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


function FactureNotesField({ value, onSave }) {
  const [local, setLocal] = useState(value || '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  useEffect(() => { setLocal(value || '') }, [value])
  async function commit(val) {
    if (val === (value || '')) return
    setSaving(true)
    setError(null)
    try {
      await onSave(val)
    } catch (e) {
      setError(e?.message || 'Erreur d\'enregistrement')
    } finally {
      setSaving(false)
    }
  }
  return (
    <Field table="factures" id="notes" label="Notes" saving={saving} className="p-5">
      <textarea
        data-testid="facture-notes-input"
        value={local}
        onChange={e => setLocal(e.target.value)}
        onBlur={e => commit(e.target.value)}
        rows={3}
        className="input text-sm w-full resize-y"
      />
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </Field>
  )
}

// `onClose` ferme le drawer (utilisé après suppression du record).
export default function FactureDetail({ recordId, onClose }) {
  const id = recordId
  const { user } = useAuth()
  const [facture, setFacture] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)
  const [projects, setProjects] = useState([])
  const [orders, setOrders] = useState([])
  const [companies, setCompanies] = useState([])
  const [saving, setSaving] = useState(false)
  const [selectedProjectId, setSelectedProjectId] = useState('')
  const [pdfBlobUrl, setPdfBlobUrl] = useState(null)
  const [_pdfLoading, _setPdfLoading] = useState(false)
  const [subscriptionModal, setSubscriptionModal] = useState(null)
  const [loadingSubscription, setLoadingSubscription] = useState(false)
  const [sendModalOpen, setSendModalOpen] = useState(false)
  const [deleteModalOpen, setDeleteModalOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState(null)
  const [retryingPdf, setRetryingPdf] = useState(false)
  const [pdfRetryError, setPdfRetryError] = useState(null)

  async function handleDelete() {
    setDeleting(true)
    setDeleteError(null)
    try {
      await api.factures.delete(id)
      setDeleteModalOpen(false)
      onClose?.()
    } catch (e) {
      setDeleteError(e?.message || 'Erreur lors de la suppression')
      setDeleting(false)
    }
  }
  async function handleRetryPdf() {
    setRetryingPdf(true)
    setPdfRetryError(null)
    try {
      await api.factures.retryPdf(id)
      // Recharge la facture : airtable_pdf_path est maintenant posé, ce qui
      // déclenche le fetch du blob et l'affichage de l'aperçu.
      load()
    } catch (e) {
      setPdfRetryError(e?.message || 'Échec du re-téléchargement du PDF')
    } finally {
      setRetryingPdf(false)
    }
  }

  function openSendModal() {
    if (facture?.source !== 'pending') return
    setSendModalOpen(true)
  }

  function handleSent(r) {
    setFacture(f => ({ ...f, status: 'En attente', last_session_url: r.checkout_session_url || f.last_session_url, pending_status: 'sent' }))
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

  const load = useCallback(() => {
    setLoading(true)
    setLoadError(null)
    setProjects([])
    setOrders([])
    api.factures.get(id)
      .then(data => {
        setFacture(data)
        setSelectedProjectId(data.project_id || '')
        // Affichage débloqué ici — le reste se charge en arrière-plan.
        setLoading(false)
        if (data.airtable_pdf_path) {
          api.factures.pdfBlob(id)
            .then(blob => blob && setPdfBlobUrl(URL.createObjectURL(blob)))
            .catch(() => {})
        }
        // Rabais Stripe — round-trip live, chargé en parallèle pour ne pas
        // bloquer le rendu de la page.
        api.factures.discounts(id)
          .then(r => setFacture(f => f ? { ...f, discounts: r.discounts || [] } : f))
          .catch(() => {})
        // Projets + commandes de l'entreprise pour les pickers. Pas nécessaires
        // au premier rendu — chargés en différé.
        if (data.company_id) {
          Promise.all([
            api.projects.list({ company_id: data.company_id, limit: 'all' }),
            api.orders.list({ company_id: data.company_id, limit: 'all' }),
          ]).then(([projectsRes, ordersRes]) => {
            setProjects(projectsRes.data || [])
            setOrders(ordersRes.data || [])
          }).catch(() => {})
        }
      })
      .catch((e) => {
        setFacture(null)
        setLoadError(e?.message || 'Erreur de chargement')
        setLoading(false)
      })
  }, [id])

  useEffect(() => { load() }, [load])

  // Relit la facture après une action qui la modifie indirectement (saisie d'un
  // paiement, écriture comptable…). L'invalidation est obligatoire : les GET
  // sont cachés 30 s et une mutation sur une AUTRE ressource (/payments) ne
  // purge pas /projets/factures/:id — sans ça on réécrasait l'état frais avec
  // la version périmée du cache.
  const refreshFacture = useCallback(async () => {
    invalidate(`/projets/factures/${id}`)
    const fresh = await api.factures.get(id)
    setFacture(f => (f ? { ...f, ...fresh } : fresh))
  }, [id])

  useRealtimeChannel(id ? `facture:${id}` : null, (msg) => {
    if (msg.type === 'facture:updated') setFacture(f => f ? { ...f, ...msg.payload } : f)
    else if (msg.type === 'facture:deleted') onClose?.()
  })

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

  const pending = detailPending({ loading, loadError, onRetry: load, record: facture, notFound: 'Facture introuvable.' })
  if (pending) return pending

  return (
    <FieldGuardProvider context="facture" record={facture} fields={FACTURE_RULE_FIELDS}>
      <DetailShell
        header={{
          badge: (
            <>
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
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-brand-600 bg-brand-50 hover:bg-brand-100 rounded-lg border border-brand-200"
                    title="Ouvrir dans Stripe"
                  >
                    <ExternalLink size={12} /> Stripe
                  </a>
                )
              })()}
              {facture.source === 'pending' && (facture.pending_status === 'draft' || facture.pending_status === 'sent') && (
                <button
                  onClick={openSendModal}
                  className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg"
                  title="Personnaliser et envoyer le lien de paiement par email"
                >
                  <Send size={12} /> {facture.pending_status === 'sent' ? 'Renvoyer par email' : 'Envoyer par email'}
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
              {/* Badge « Revenu perçu d'avance » : affichée tant que la vente n'est pas
                  constatée. L'état post-constatation est désormais visible dans
                  l'historique des événements en bas de page. */}
              {facture.deferred_revenue_at && !facture.revenue_recognized_at && (
                facture.deferred_revenue_qb_url ? (
                  <a
                    href={facture.deferred_revenue_qb_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg border border-slate-200"
                    title={`Comptabilisé dans le compte Revenus perçus d'avance (23900) le ${fmtDate(facture.deferred_revenue_at)} — ouvrir la transaction QB`}
                    data-testid="revenue-status-deferred"
                  >
                    <Hourglass size={12} /> Revenu perçu d'avance <ExternalLink size={10} />
                  </a>
                ) : (
                  <span
                    className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-700 bg-slate-100 rounded-lg border border-slate-200"
                    title={`Comptabilisé dans le compte Revenus perçus d'avance (23900) le ${fmtDate(facture.deferred_revenue_at)}. La vente sera constatée après le premier envoi sur une commande liée.`}
                    data-testid="revenue-status-deferred"
                  >
                    <Hourglass size={12} /> Revenu perçu d'avance
                  </span>
                )
              )}
            </>
          ),
          meta: facture.deferred_revenue_at && !facture.revenue_recognized_at && (
              <div className="mt-2 text-xs text-slate-500">
                Cette facture est comptabilisée dans le compte <strong>23900 Revenus perçus d'avance</strong>
                {facture.deferred_revenue_amount_cad
                  ? ` pour ${fmtMoney(facture.deferred_revenue_amount_cad, 'CAD')}`
                  : ''}
                {facture.deferred_revenue_qb_ref
                  ? ` (réf. QB ${facture.deferred_revenue_qb_ref})`
                  : ''}.
                {facture.has_linked_shipment
                  ? " Un envoi a été enregistré — autoriser l'écriture de journal pour constater la vente."
                  : " La vente sera constatable lorsqu'un envoi sera fait sur une commande liée."}
              </div>
          ),
        }}
      >
        <div className="bg-white rounded-xl border border-slate-200 divide-y divide-slate-100">
          {/* Entreprise */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-5">
            <Field table="factures" id="company_name" label="Entreprise">
              <LinkedRecordField
                name="company_id"
                value={facture.company_id}
                options={companies}
                labelFn={c => c.name}
                getHref={c => `/companies/${c.id}`}
                saving={saving}
                onChange={handleCompanyChange}
              />
              {/* Courriel du client Stripe (mapping configurable) — surtout utile
                  quand la facture n'est rattachée à aucune entreprise ERP. */}
              {facture.customer_email && (
                <p className="text-xs text-slate-500 mt-1" data-testid="facture-customer-email">
                  <a href={`mailto:${facture.customer_email}`} className="hover:underline hover:text-brand-600">
                    {facture.customer_email}
                  </a>
                </p>
              )}
            </Field>
            <Field table="factures" id="project_name" label="Projet">
              {facture.company_id ? (
                <LinkedRecordField
                  name="project_id"
                  value={selectedProjectId}
                  options={projects}
                  labelFn={p => p.name}
                  getHref={p => `/projects/${p.id}`}
                  saving={saving}
                  onChange={handleProjectChange}
                />
              ) : (
                <span className="text-slate-400 text-sm">Associer une entreprise d'abord</span>
              )}
            </Field>
          </div>

          {/* Commande / Abonnement */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 p-5">
            <FieldGuard fieldId="order_field" label="Commande">
              <Field table="factures" id="order_number" label="Commande" testId="order_field">
                {facture.company_id ? (
                  <LinkedRecordField
                    name="order_id"
                    value={facture.order_id}
                    options={orders}
                    labelFn={o => `#${o.order_number}`}
                    getHref={o => `/orders/${o.id}`}
                    saving={saving}
                    onChange={handleOrderChange}
                  />
                ) : (
                  <span className="text-slate-400 text-sm">Associer une entreprise d'abord</span>
                )}
              </Field>
            </FieldGuard>
            <FieldGuard fieldId="subscription_field" label="Abonnement">
              <div data-field-id="subscription_field">
                <p className="label">Abonnement</p>
                {facture.subscription_local_id
                  ? <button onClick={openSubscriptionModal} disabled={loadingSubscription} className="text-brand-600 hover:underline font-medium disabled:opacity-50 font-mono text-sm">{facture.subscription_stripe_id || facture.subscription_id}</button>
                  : facture.subscription_id
                    ? <span className="text-slate-500 font-mono text-sm">{facture.subscription_id}</span>
                    : <span className="text-slate-400 text-sm">—</span>}
              </div>
            </FieldGuard>
          </div>

          {/* PDF manquant — re-télécharger depuis Stripe. Le download peut avoir
              échoué au webhook (airtable_pdf_path null) ; rien ne le retente
              automatiquement, donc on l'offre à la demande sur les factures Stripe. */}
          {!facture.airtable_pdf_path && facture.invoice_id && (
            <div className="p-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">PDF Stripe</p>
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
                <p className="text-sm text-amber-800 mb-2">Le PDF de cette facture n'a pas pu être récupéré depuis Stripe.</p>
                <button
                  onClick={handleRetryPdf}
                  disabled={retryingPdf}
                  className="btn-secondary btn-sm disabled:opacity-50"
                >
                  {retryingPdf ? 'Récupération…' : 'Re-télécharger le PDF Stripe'}
                </button>
                {pdfRetryError && (
                  <p className="text-xs text-red-600 mt-2">{pdfRetryError}</p>
                )}
              </div>
            </div>
          )}

          {/* PDF thumbnail — composant partagé avec les étiquettes et bons de
              livraison (vignette cliquable → visionneuse plein écran). */}
          {pdfBlobUrl && (
            <div className="p-5">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wide mb-2">Aperçu</p>
              <AttachmentPreview
                url={pdfBlobUrl}
                fileName={`${facture.document_number}.pdf`}
                title={facture.document_number}
                kind="pdf"
                size="md"
                showFileName={false}
                testId="facture-pdf-attachment"
              />
            </div>
          )}

          {/* Dates */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 p-5">
            <Field table="factures" id="document_date" label="Date de facturation">
              <p className="text-sm text-slate-700">{fmtDate(facture.document_date)}</p>
            </Field>
            <Field table="factures" id="due_date" label="Date d'échéance">
              <p className="text-sm text-slate-700">{fmtDate(facture.due_date)}</p>
            </Field>
            <Field table="factures" id="currency" label="Devise">
              <p className="text-sm font-mono text-slate-700">{facture.currency || '—'}</p>
            </Field>
            <FieldGuard fieldId="is_sent" label="Envoyée">
              <Field table="factures" id="is_sent" label="Envoyée" testId="is_sent">
                {facture.is_sent ? (
                  <Badge color="green" size="sm">Envoyée</Badge>
                ) : (
                  <span className="text-sm text-slate-400">—</span>
                )}
              </Field>
            </FieldGuard>
            <CustomDetailFields table="factures" record={facture} />
          </div>


          {/* Solde dû */}
          <Field table="factures" id="balance_due" label="Solde dû" className="p-5">
            <p className={`text-sm font-medium ${facture.balance_due > 0 ? 'text-red-600' : 'text-green-600'}`}>
              {fmtMoney(facture.balance_due, facture.currency)}
            </p>
          </Field>

          {/* Notes — éditable, autosave on blur */}
          <FactureNotesField
            value={facture.notes || ''}
            onSave={async (val) => {
              const updated = await api.factures.update(id, { notes: val })
              setFacture(updated)
            }}
          />

        </div>

        {/* Lignes de la facture — 1 par produit (Stripe items ou pending items) + sommaires */}
        {((Array.isArray(facture.items) && facture.items.length > 0) || facture.total_amount != null || (Array.isArray(facture.taxes) && facture.taxes.length > 0)) && (
          <div className="bg-white rounded-xl border border-slate-200 mt-5 p-5" data-testid="facture-items">
            <h2 className="text-sm font-semibold text-slate-900 mb-3">Lignes de la facture</h2>
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-400 uppercase tracking-wide">
                <tr>
                  <th className="text-left pb-2">Produit</th>
                  <th className="text-left pb-2">Description</th>
                  <th className="text-right pb-2 w-16">Qté</th>
                  <th className="text-right pb-2 w-32">Prix unit.</th>
                  <th className="text-right pb-2 w-32">Total</th>
                </tr>
              </thead>
              <tbody>
                {(facture.items || []).map((it, i) => {
                  const qty = Number(it.qty) || 0
                  const unit = it.unit_price != null ? Number(it.unit_price) : null
                  const total = it.total != null ? Number(it.total) : (unit != null ? qty * unit : null)
                  return (
                    <tr key={it.id || i} className="border-t border-slate-100">
                      <td className="py-2 text-slate-700">
                        {it.product_id
                          ? <Link to={`/products/${it.product_id}`} className="text-brand-600 hover:underline">{it.product_name || it.product_sku || '—'}</Link>
                          : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="py-2 text-slate-700">{it.description || <span className="text-slate-400">—</span>}</td>
                      <td className="py-2 text-right tabular-nums">{qty}</td>
                      <td className="py-2 text-right tabular-nums">{unit != null ? fmtMoney(unit, facture.currency) : '—'}</td>
                      <td className="py-2 text-right tabular-nums">{total != null ? fmtMoney(total, facture.currency) : '—'}</td>
                    </tr>
                  )
                })}
                {Array.isArray(facture.discounts) && facture.discounts.map((d, i) => (
                  <tr key={`disc-${i}`} className="border-t border-slate-100 text-slate-700">
                    <td className="py-2" colSpan={2}>Rabais{d.label ? ` : ${d.label}` : ''}</td>
                    <td className="py-2"></td>
                    <td className="py-2"></td>
                    <td className="py-2 text-right tabular-nums">−{fmtMoney(d.amount, facture.currency)}</td>
                  </tr>
                ))}
                {/* Sous-total avant taxes — le montant stocké est DÉJÀ net de rabais :
                    le sync Stripe prend `total_excluding_tax` (HT après rabais), pas
                    `subtotal_excluding_tax` (voir services/stripeFactureFieldMap.js).
                    Ne rien redéduire ici : les lignes de rabais ci-dessus expliquent
                    l'écart entre la somme des lignes et ce sous-total, elles ne
                    s'appliquent pas une deuxième fois. */}
                {(() => {
                  const displayedBeforeTax = facture.montant_avant_taxes != null
                    ? parseFloat(facture.montant_avant_taxes)
                    : facture.amount_before_tax_cad
                  return (
                    <tr className="border-t-2 border-slate-200 text-slate-700" data-testid="facture-line-subtotal">
                      <td className="pt-3 pb-2 font-medium" colSpan={4}>Avant taxes</td>
                      <td className="pt-3 pb-2 text-right tabular-nums font-medium">{fmtMoney(displayedBeforeTax, facture.currency)}</td>
                    </tr>
                  )
                })()}
                {/* Taxes — split par juridiction (TPS / TVQ / HST / etc.) */}
                {Array.isArray(facture.taxes) && facture.taxes.map((t, i) => (
                  <tr key={`tax-${i}`} className="border-t border-slate-100 text-slate-700" data-testid="facture-line-tax">
                    <td className="py-2" colSpan={4}>
                      {t.name}
                      {t.percentage != null && <span className="text-slate-400 ml-1">({t.percentage}%)</span>}
                    </td>
                    <td className="py-2 text-right tabular-nums">{fmtMoney(t.amount, facture.currency)}</td>
                  </tr>
                ))}
                {/* Total */}
                <tr className="border-t-2 border-slate-300 text-slate-900" data-testid="facture-line-total">
                  <td className="pt-2 pb-1 font-semibold" colSpan={4}>Total</td>
                  <td className="pt-2 pb-1 text-right tabular-nums font-semibold">{fmtMoney(facture.total_amount, facture.currency)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        )}

        {/* Paiements et remboursements (Stripe + saisis manuellement) */}
        <FacturePaymentsSection
          factureId={id}
          factureCurrency={facture.currency || 'CAD'}
          factureIsPaid={facture.status === 'Payé' || facture.status === 'Payée' || (facture.balance_due != null && Number(facture.balance_due) <= 0 && Number(facture.total_amount) > 0)}
          facturePaidAt={facture.paid_at}
          facturePaidChargeId={facture.paid_charge_id}
          facturePaidPaymentIntent={facture.paid_payment_intent}
          factureTotalAmount={facture.total_amount}
          onFactureChanged={refreshFacture}
        />

        <FactureAccountingSection
          facture={facture}
          onChanged={refreshFacture}
        />

        {user?.role === 'admin' && (
          <div className="mt-8 pt-6 border-t border-slate-200 flex justify-end">
            <button
              onClick={() => { setDeleteError(null); setDeleteModalOpen(true) }}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-red-700 bg-white hover:bg-red-50 rounded-lg border border-red-200"
              data-testid="facture-delete-button"
            >
              <Trash2 size={14} /> Supprimer la facture
            </button>
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
      </DetailShell>

      {subscriptionModal && (
        <AbonnementDetailModal abonnement={subscriptionModal} onClose={() => setSubscriptionModal(null)} />
      )}

      <SendPaymentLinkModal
        pendingInvoiceId={facture?.id}
        isOpen={sendModalOpen}
        onClose={() => setSendModalOpen(false)}
        onSent={handleSent}
      />

      <Modal
        isOpen={deleteModalOpen}
        onClose={() => !deleting && setDeleteModalOpen(false)}
        title="Supprimer cette facture ?"
        size="md"
      >
        <div className="space-y-4 text-sm text-slate-700">
          <p>
            Cette action supprime <strong>uniquement le record local</strong> dans l'ERP.
            Aucun appel n'est fait à Stripe, Airtable ni QuickBooks.
          </p>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <div><span className="text-slate-500">N°</span> <strong>{facture.document_number || facture.id}</strong></div>
            {facture.invoice_id && (
              <div><span className="text-slate-500">ID source</span> <code className="text-xs">{facture.invoice_id}</code></div>
            )}
            <div><span className="text-slate-500">Montant</span> <strong>{fmtMoney(facture.total_amount, facture.currency)}</strong></div>
          </div>

          <div>
            <div className="font-semibold text-slate-900 mb-1.5">Ce qui sera supprimé :</div>
            <ul className="list-disc pl-5 space-y-1 text-slate-600">
              <li>Le record <code className="text-xs">factures</code></li>
              <li>Les lignes <code className="text-xs">stripe_invoice_items</code> attachées (cascade)</li>
            </ul>
          </div>

          {(facture.revenue_recognized_at || facture.deferred_revenue_at || facture.paid_at) && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2.5 text-amber-900">
              <div className="font-semibold mb-1">⚠ Cette facture a déjà été comptabilisée</div>
              <ul className="list-disc pl-5 space-y-0.5 text-xs">
                {facture.revenue_recognized_at && (
                  <li>
                    Vente constatée le {fmtDate(facture.revenue_recognized_at)}
                    {facture.revenue_recognized_je_id && <> — JE QuickBooks <strong>#{facture.revenue_recognized_je_id}</strong> existe toujours côté QB</>}
                  </li>
                )}
                {facture.deferred_revenue_at && !facture.revenue_recognized_at && (
                  <li>Revenu perçu d'avance comptabilisé le {fmtDate(facture.deferred_revenue_at)}</li>
                )}
                {facture.paid_at && <li>Paiement reçu le {fmtDate(facture.paid_at)} ({fmtMoney(facture.paid_amount, facture.currency)})</li>}
              </ul>
              <div className="text-xs mt-1.5">La trace locale est perdue mais les écritures QB / mouvements Stripe demeurent.</div>
            </div>
          )}

          {deleteError && (
            <div className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-red-800 text-xs">
              {deleteError}
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button
              onClick={() => setDeleteModalOpen(false)}
              disabled={deleting}
              className="btn-secondary"
            >
              Annuler
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="btn-danger"
              data-testid="facture-delete-confirm"
            >
              {deleting ? 'Suppression…' : 'Supprimer définitivement'}
            </button>
          </div>
        </div>
      </Modal>
    </FieldGuardProvider>
  )
}
