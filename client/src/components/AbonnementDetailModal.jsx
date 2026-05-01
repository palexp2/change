import { useState, useEffect } from 'react'
import { ExternalLink, FileText } from 'lucide-react'
import api from '../lib/api.js'
import { Modal } from './Modal.jsx'
import LinkedRecordField from './LinkedRecordField.jsx'
import { fmtDate } from '../lib/formatDate.js'

function fmtCad(n) {
  if (!n && n !== 0) return '—'
  return new Intl.NumberFormat('fr-CA', { style: 'currency', currency: 'CAD' }).format(n)
}

export function AbonnementDetailModal({ abonnement, onClose, onChange }) {
  const [details, setDetails] = useState(null)
  const [loading, setLoading] = useState(true)
  const [companies, setCompanies] = useState([])
  const [savingCompany, setSavingCompany] = useState(false)
  const [localAbo, setLocalAbo] = useState(abonnement)

  useEffect(() => {
    setLocalAbo(abonnement)
  }, [abonnement])

  useEffect(() => {
    if (!abonnement) return
    setLoading(true)
    api.abonnements.stripeDetails(abonnement.id)
      .then(setDetails)
      .catch(() => setDetails(null))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [abonnement?.id])

  useEffect(() => {
    api.companies.lookup().then(setCompanies).catch(() => setCompanies([]))
  }, [])

  async function handleCompanyChange(newCompanyId) {
    setSavingCompany(true)
    try {
      await api.abonnements.patch(localAbo.id, { company_id: newCompanyId || null })
      const co = newCompanyId ? companies.find(c => c.id === newCompanyId) : null
      const updated = { ...localAbo, company_id: newCompanyId || null, company_name: co?.name || null }
      setLocalAbo(updated)
      onChange?.(updated)
    } finally {
      setSavingCompany(false)
    }
  }

  if (!abonnement) return null

  return (
    <Modal isOpen onClose={onClose} title="Détails de l'abonnement" size="xl">
      <div className="space-y-5">
        <div className="flex items-center justify-between pb-3 border-b border-slate-100">
          <div>
            <div className="text-sm text-slate-500 mb-1">Entreprise</div>
            <LinkedRecordField
              name="company_id"
              value={localAbo.company_id}
              options={companies}
              labelFn={c => c.name}
              getHref={c => `/companies/${c.id}`}
              placeholder="Entreprise"
              saving={savingCompany}
              onChange={handleCompanyChange}
            />
          </div>
          <div className="flex items-center gap-3">
            <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-medium ${abonnement.status === 'active' ? 'bg-green-100 text-green-700' : abonnement.status === 'canceled' ? 'bg-red-100 text-red-700' : abonnement.status === 'past_due' ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700'}`}>
              {abonnement.status === 'active' ? 'Actif' : abonnement.status === 'canceled' ? 'Annulé' : abonnement.status === 'past_due' ? 'En retard' : abonnement.status === 'trialing' ? 'Essai' : abonnement.status}
            </span>
            <span className="text-lg font-bold text-slate-800">{fmtCad(abonnement.amount_cad ?? abonnement.amount_monthly)}<span className="text-xs font-normal text-slate-400">/{abonnement.interval_type === 'year' ? 'an' : 'mois'}</span></span>
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
          <div><div className="text-xs text-slate-400 mb-0.5">Début</div><div className="text-slate-700">{fmtDate(abonnement.start_date)}</div></div>
          <div><div className="text-xs text-slate-400 mb-0.5">Fin</div><div className="text-slate-700">{fmtDate(abonnement.end_date || abonnement.cancel_date)}</div></div>
          <div><div className="text-xs text-slate-400 mb-0.5">Client Stripe</div><div className="text-slate-700 font-mono text-xs">{abonnement.customer_email || '—'}</div></div>
          <div>
            <div className="text-xs text-slate-400 mb-0.5">Stripe</div>
            {abonnement.stripe_url
              ? <a href={abonnement.stripe_url} target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline text-xs inline-flex items-center gap-1"><ExternalLink size={11} /> Voir</a>
              : <span className="text-slate-400">—</span>}
          </div>
        </div>

        {loading ? (
          <div className="flex justify-center py-10"><div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-600" /></div>
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
                        <td className="px-4 py-2.5">
                          <div className="font-medium text-slate-800">{item.product_name}</div>
                          {item.description && <div className="text-xs text-slate-400 mt-0.5">{item.description}</div>}
                          {item.interval && <div className="text-xs text-slate-400">/ {item.interval_count > 1 ? `${item.interval_count} ` : ''}{item.interval === 'month' ? 'mois' : item.interval === 'year' ? 'an' : item.interval}</div>}
                        </td>
                        <td className="px-4 py-2.5 text-right text-slate-600">{item.unit_amount != null ? `${item.unit_amount.toFixed(2)} ${item.currency}` : '—'}</td>
                        <td className="px-4 py-2.5 text-right text-slate-600">{item.quantity}</td>
                        <td className="px-4 py-2.5 text-right font-medium text-slate-800">{item.total != null ? `${item.total.toFixed(2)} ${item.currency}` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {details.discount && (
                <div className="mt-2 text-xs text-brand-600">
                  Rabais: {details.discount.name}
                  {details.discount.percent_off && ` (${details.discount.percent_off}%)`}
                  {details.discount.amount_off && ` (${details.discount.amount_off} $)`}
                </div>
              )}
            </div>

            {details.history.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold text-slate-700 mb-2">Historique des changements</h4>
                <div className="border border-slate-200 rounded-lg divide-y divide-slate-100">
                  {details.history.map((h, i) => (
                    <div key={i} className="flex items-start gap-3 px-4 py-2.5 text-sm">
                      <div className="flex-shrink-0 pt-0.5 w-28">
                        <div className="text-xs text-slate-400">{fmtDate(h.date)}</div>
                        <div className={`text-[10px] font-medium mt-0.5 ${h.type === 'creation' ? 'text-green-600' : 'text-amber-600'}`}>
                          {h.type === 'creation' ? 'Création' : 'Modification'}
                        </div>
                      </div>
                      <div className="flex-1 space-y-0.5">
                        {h.changes.map((c, j) => (
                          <div key={j} className="text-slate-600 text-sm">{typeof c === 'string' ? c : `${c.field}: ${c.from || ''} → ${c.to || ''}`}</div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {details.invoices.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold text-slate-700 mb-2">Factures ({details.invoices.length})</h4>
                <div className="border border-slate-200 rounded-lg overflow-hidden divide-y divide-slate-100">
                  {details.invoices.map((inv, i) => (
                    <div key={i} className={`px-4 py-2.5 ${inv.facture_id ? 'hover:bg-slate-50 cursor-pointer' : ''}`} onClick={() => { if (inv.facture_id) { onClose?.(); window.location.href = `/erp/factures/${inv.facture_id}` } }}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <span className={`text-xs font-mono ${inv.facture_id ? 'text-brand-600 hover:underline' : 'text-slate-700'}`}>{inv.number || '—'}</span>
                          <span className="text-xs text-slate-400">{fmtDate(inv.date)}</span>
                          <span className={`inline-flex px-2 py-0.5 rounded-full text-[10px] font-medium ${inv.status === 'paid' ? 'bg-green-100 text-green-700' : inv.status === 'open' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600'}`}>
                            {inv.status === 'paid' ? 'Payée' : inv.status === 'open' ? 'Ouverte' : inv.status === 'draft' ? 'Brouillon' : inv.status}
                          </span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="font-medium text-slate-700 text-sm">{inv.amount.toFixed(2)} {inv.currency}</span>
                          {inv.pdf && <a onClick={e => e.stopPropagation()} href={inv.pdf} target="_blank" rel="noopener noreferrer" className="text-brand-600 hover:underline text-xs inline-flex items-center gap-1"><FileText size={11} /></a>}
                        </div>
                      </div>
                      {inv.lines && inv.lines.length > 0 && (
                        <div className="mt-1.5 space-y-0.5">
                          {inv.lines.map((li, j) => (
                            <div key={j} className={`flex items-center justify-between text-xs ${li.proration ? 'text-amber-600' : 'text-slate-400'}`}>
                              <span className="truncate mr-4">{li.proration ? '↕ ' : ''}{li.description}</span>
                              <span className="flex-shrink-0 font-mono">{li.amount >= 0 ? '' : '-'}{Math.abs(li.amount).toFixed(2)} $</span>
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
    </Modal>
  )
}
