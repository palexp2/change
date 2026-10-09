import { useState, useEffect, useRef, lazy, Suspense } from 'react'
import { ExternalLink } from 'lucide-react'
import AttachmentPreview from './AttachmentPreview.jsx'
import api from '../lib/api.js'
import RecordPeekDrawer from './RecordPeekDrawer.jsx'
import Spinner from './Spinner.jsx'
import LinkedRecordField from './LinkedRecordField.jsx'
import { SubscriptionHistory } from './SubscriptionHistory.jsx'
import { fmtDate } from '../lib/formatDate.js'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'
import { intervalAmount, intervalLabel, subscriptionTotals } from '../lib/subscriptionPricing.js'
import { fmtCad } from '../utils/formatters.js'
import { Badge, SUBSCRIPTION_STATUS, STRIPE_INVOICE_STATUS } from './Badge.jsx'

function StatusBadge({ map, status, size }) {
  const s = map[status]
  return <Badge color={s?.color} size={size}>{s?.label || status}</Badge>
}

// Import différé : FactureDetail importe ce module (side-peek abonnement d'une
// facture). Un import statique créerait un cycle à l'évaluation ; `lazy` casse
// le cycle en le résolvant seulement au moment où on ouvre la facture.
const FactureDetail = lazy(() => import('../pages/FactureDetail.jsx'))

// Fiche abonnement : toujours rendue dans un RecordPeekDrawer (side-peek à la
// Airtable), par-dessus la liste ou par-dessus un autre panneau (depuis la
// fiche d'une entreprise, d'une facture…).
// `stripeButton` : le lien Stripe devient un bouton en tête de fiche (fiche
// entreprise) au lieu d'une petite cellule de la grille.

// Infobulle d'un produit : métadonnées Stripe de sa ligne, puis de l'abonnement
// (ex. erp_contact_id = signataire d'une page avec acceptation).
function metadataTooltip(item) {
  const lines = [
    ...(item.metadata || []).map(([k, v]) => `${k} : ${v}`),
    ...((item.subscription_metadata || []).length ? ['— abonnement —', ...item.subscription_metadata.map(([k, v]) => `${k} : ${v}`)] : []),
  ]
  return lines.length ? lines.join('\n') : undefined
}

export function AbonnementDetailModal({ abonnement, onClose, onChange, stripeButton = false }) {
  // Facture ouverte par-dessus le panneau abonnement (clic sur une ligne de la
  // section « Factures »).
  const [facturePeek, setFacturePeek] = useState(null)
  const [details, setDetails] = useState(null)
  const [loading, setLoading] = useState(true)
  const [companies, setCompanies] = useState([])
  const [savingCompany, setSavingCompany] = useState(false)
  const [localAbo, setLocalAbo] = useState(null)

  useEffect(() => {
    setLocalAbo(abonnement)
    setFacturePeek(null)
  }, [abonnement])

  // Seule la dernière requête a le droit d'écrire : une réponse tardive d'un
  // abonnement quitté (ou d'un rechargement dépassé) est ignorée.
  const detailsReq = useRef(0)
  function loadDetails(id, { initial = false } = {}) {
    const gen = ++detailsReq.current
    const isCurrent = () => gen === detailsReq.current
    if (initial) { setDetails(null); setLoading(true) }
    return api.abonnements.stripeDetails(id)
      .then(d => { if (isCurrent()) setDetails(d) })
      .catch(() => {})
      .finally(() => { if (isCurrent()) setLoading(false) })
  }

  useEffect(() => {
    if (!abonnement) return
    loadDetails(abonnement.id, { initial: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abonnement?.id])

  useEffect(() => {
    api.companies.lookup().then(setCompanies).catch(() => setCompanies([]))
  }, [])

  // Temps réel (hook avant le return anticipé) : `subscription:updated` porte la
  // ligne à jour (édition d'un collègue, webhook Stripe, sync) → en-tête ;
  // `subscription_event:*` → historique et produits Stripe.
  useRealtimeChannel(abonnement?.id ? `subscription:${abonnement.id}` : null, (msg) => {
    if (msg.type === 'subscription:updated') {
      setLocalAbo(prev => ({ ...(prev?.id === abonnement.id ? prev : abonnement), ...msg.payload }))
    } else if (msg.type?.startsWith('subscription_event:')) {
      loadDetails(abonnement.id)
    }
  })

  if (!abonnement) return null

  // Pendant le render qui suit le changement de prop `abonnement`, le useEffect
  // qui met à jour localAbo n'a pas encore tourné — on retombe sur la prop
  // pour éviter un crash sur localAbo null ou désynchronisé d'un autre record.
  const aboState = (localAbo && localAbo.id === abonnement.id) ? localAbo : abonnement

  async function handleCompanyChange(newCompanyId) {
    setSavingCompany(true)
    try {
      await api.abonnements.patch(aboState.id, { company_id: newCompanyId || null })
      const co = newCompanyId ? companies.find(c => c.id === newCompanyId) : null
      const updated = { ...aboState, company_id: newCompanyId || null, company_name: co?.name || null }
      setLocalAbo(updated)
      onChange?.(updated)
    } finally {
      setSavingCompany(false)
    }
  }

  async function handleContactChange(newContactId) {
    setSavingCompany(true)
    try {
      await api.abonnements.patch(aboState.id, { contact_id: newContactId || null })
      const fresh = await api.abonnements.get(aboState.id)
      const updated = { ...aboState, contact_id: fresh.contact_id, contact_name: fresh.contact_name }
      setLocalAbo(updated)
      onChange?.(updated)
    } finally {
      setSavingCompany(false)
    }
  }

  // Montant avant taxes au cycle : en-tête, ligne « Rabais » et pied du tableau
  // lisent les mêmes totaux. Fallback sur intervalAmount pendant le chargement.
  const totals = details?.items?.length ? subscriptionTotals(details) : null
  const displayedAmount = totals ? totals.subtotal : intervalAmount(aboState)

  const body = (
      <div className="space-y-5">
        {stripeButton && aboState.stripe_url && (
          <a href={aboState.stripe_url} target="_blank" rel="noopener noreferrer" className="btn-secondary inline-flex items-center gap-1.5" data-testid="abo-stripe-button">
            <ExternalLink size={14} /> Stripe
          </a>
        )}
        <div className="flex items-center justify-between pb-3 border-b border-slate-100">
          <div>
            <div className="text-sm text-slate-500 mb-1">Entreprise</div>
            <LinkedRecordField
              name="company_id"
              value={aboState.company_id}
              options={companies}
              labelFn={c => c.name}
              getHref={c => `/companies/${c.id}`}
              saving={savingCompany}
              onChange={handleCompanyChange}
            />
            <div className="text-sm text-slate-500 mt-2 mb-1">Contact</div>
            <LinkedRecordField
              name="contact_id"
              value={aboState.contact_id}
              options={aboState.contact_id ? [{ id: aboState.contact_id, name: aboState.contact_name }] : []}
              searchTarget="contacts"
              getHref={c => `/contacts/${c.id}`}
              saving={savingCompany}
              onChange={handleContactChange}
            />
          </div>
          <div className="flex items-center gap-3">
            <StatusBadge map={SUBSCRIPTION_STATUS} status={aboState.status} />
            <span className="text-lg font-bold text-slate-800" data-testid="abo-modal-cycle-amount" title="Avant taxes">{fmtCad(displayedAmount)}<span className="text-xs font-normal text-slate-400">/{intervalLabel(aboState)}</span><span className="text-[10px] font-normal text-slate-400 ml-1">av. tx</span></span>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div><div className="text-xs text-slate-400 mb-0.5">Début</div><div className="text-slate-700">{fmtDate(aboState.start_date)}</div></div>
          <div><div className="text-xs text-slate-400 mb-0.5">Fin</div><div className="text-slate-700">{fmtDate(aboState.end_date || aboState.cancel_date)}</div></div>
          <div><div className="text-xs text-slate-400 mb-0.5">Client Stripe</div><div className="text-slate-700 font-mono text-xs">{aboState.customer_email || '—'}</div></div>
          {!stripeButton && (
            <div>
              <div className="text-xs text-slate-400 mb-0.5">Stripe</div>
              {aboState.stripe_url
                ? <a href={aboState.stripe_url} target="_blank" rel="noopener noreferrer" className="link-record text-xs inline-flex items-center gap-1"><ExternalLink size={11} /> Voir</a>
                : <span className="text-slate-400">—</span>}
            </div>
          )}
        </div>

        {loading ? (
          <Spinner center />
        ) : !details ? (
          <p className="text-center py-8 text-slate-400 text-sm">Impossible de charger les détails Stripe</p>
        ) : (
          <>
            <div>
              <h4 className="text-sm font-semibold text-slate-700 mb-2">Produits</h4>
              <div className="border border-slate-200 rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-slate-50 border-b border-slate-200">
                      <th className="text-left px-4 py-2 text-xs font-semibold text-slate-500">Produit</th>
                      <th className="text-right px-4 py-2 text-xs font-semibold text-slate-500">Prix unitaire</th>
                      <th className="text-right px-4 py-2 text-xs font-semibold text-slate-500">Qté</th>
                      <th className="text-right px-4 py-2 text-xs font-semibold text-slate-500">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {details.items.map(item => (
                      <tr key={item.id} className="border-b border-slate-100 last:border-0">
                        <td className="px-4 py-2.5" title={metadataTooltip(item)} data-testid="abo-item">
                          <div className="font-medium text-slate-800">{item.product_name}</div>
                          {item.description && <div className="text-xs text-slate-400 mt-0.5">{item.description}</div>}
                          {item.interval && <div className="text-xs text-slate-400">/ {item.interval_count > 1 ? `${item.interval_count} ` : ''}{item.interval === 'month' ? 'mois' : item.interval === 'year' ? 'an' : item.interval}</div>}
                        </td>
                        <td className="px-4 py-2.5 text-right text-slate-600">{item.unit_amount != null ? `${item.unit_amount.toFixed(2)} ${item.currency}` : '—'}</td>
                        <td className="px-4 py-2.5 text-right text-slate-600">{item.quantity}</td>
                        <td className="px-4 py-2.5 text-right font-medium text-slate-800">{item.total != null ? `${item.total.toFixed(2)} ${item.currency}` : '—'}</td>
                      </tr>
                    ))}
                    {totals?.discountAmt > 0 && (
                      <tr className="border-b border-slate-100 last:border-0">
                        <td className="px-4 py-2.5 text-slate-600" colSpan={3}>
                          Rabais : {details.discount.name}{details.discount.percent_off != null && ` (${details.discount.percent_off}%)`}
                        </td>
                        <td className="px-4 py-2.5 text-right font-medium text-slate-600">−{totals.discountAmt.toFixed(2)} {totals.currency}</td>
                      </tr>
                    )}
                  </tbody>
                  {totals && (
                    <tfoot>
                      <tr className="bg-slate-50 border-t border-slate-200">
                        <td className="px-4 py-2 text-xs font-semibold text-slate-500" colSpan={3}>Total avant taxes</td>
                        <td className="px-4 py-2 text-right font-semibold text-slate-800">{totals.subtotal.toFixed(2)} {totals.currency}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </div>

            <SubscriptionHistory
              subscriptionId={aboState.id}
              history={details.history}
              onChanged={() => loadDetails(aboState.id)}
            />

            {details.invoices.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold text-slate-700 mb-2">Factures ({details.invoices.length})</h4>
                <div className="border border-slate-200 rounded-lg overflow-hidden divide-y divide-slate-100">
                  {details.invoices.map((inv, i) => (
                    <div
                      key={i}
                      data-testid={inv.facture_id ? `abo-invoice-row-${inv.facture_id}` : undefined}
                      className={`px-4 py-2.5 ${inv.facture_id ? 'hover:bg-slate-50 cursor-pointer' : ''}`}
                      onClick={() => { if (inv.facture_id) setFacturePeek({ id: inv.facture_id, number: inv.number }) }}
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className={`text-xs font-mono ${inv.facture_id ? 'link-record' : 'text-slate-700'}`}>{inv.number || '—'}</span>
                          <span className="text-xs text-slate-400">{fmtDate(inv.date)}</span>
                          <StatusBadge map={STRIPE_INVOICE_STATUS} status={inv.status} size="xs" />
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="font-medium text-slate-700 text-sm">{inv.amount.toFixed(2)} {inv.currency}</span>
                          {/* stopPropagation : la vignette et sa modale (portail, mais même arbre
                              React) ne doivent pas ouvrir la fiche facture de la ligne. */}
                          {inv.pdf && inv.id && (
                            <span onClick={e => e.stopPropagation()} className="inline-flex">
                              <AttachmentPreview
                                url={`/erp/api/projets/abonnements/${aboState.id}/invoices/${inv.id}/pdf`}
                                fileName={`${inv.number || inv.id}.pdf`}
                                title={inv.number || 'Facture'}
                                kind="pdf"
                                size="compact"
                                showFileName={false}
                                overModal
                                testId={`abo-invoice-pdf-${inv.id}`}
                              />
                            </span>
                          )}
                        </div>
                      </div>
                      {(inv.lines?.length > 0 || inv.discounts?.length > 0) && (
                        <div className="mt-1.5 space-y-0.5">
                          {inv.lines?.map((li, j) => (
                            <div key={j} className={`flex items-center justify-between text-xs ${li.proration ? 'text-amber-600' : 'text-slate-400'}`}>
                              <span className="truncate mr-4">{li.proration ? '↕ ' : ''}{li.description}</span>
                              <span className="flex-shrink-0 font-mono">{li.amount >= 0 ? '' : '-'}{Math.abs(li.amount).toFixed(2)} $</span>
                            </div>
                          ))}
                          {inv.discounts?.map((d, j) => (
                            <div key={`d${j}`} className="flex items-center justify-between text-xs text-slate-400">
                              <span className="truncate mr-4">Rabais{d.label ? ` : ${d.label}` : ''}</span>
                              <span className="flex-shrink-0 font-mono">−{d.amount.toFixed(2)} $</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </div>
  )

  return (
    <RecordPeekDrawer
      open
      onClose={onClose}
      title={aboState.product_name || "Détails de l'abonnement"}
      subtitle={aboState.company_name || aboState.customer_email || undefined}
      width={640}
      peekKey="abonnements"
    >
      <div className="px-5 py-4">{body}</div>
      {/* Facture empilée par-dessus l'abonnement — on ne quitte pas le contexte. */}
      {facturePeek && (
        <RecordPeekDrawer
          open
          onClose={() => setFacturePeek(null)}
          title={facturePeek.number || `Facture #${facturePeek.id}`}
          to={`/factures/${facturePeek.id}`}
          width={720}
        >
          <Suspense fallback={<Spinner center />}>
            <FactureDetail recordId={facturePeek.id} embedded onClose={() => setFacturePeek(null)} />
          </Suspense>
        </RecordPeekDrawer>
      )}
    </RecordPeekDrawer>
  )
}
