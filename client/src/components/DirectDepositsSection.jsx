import { useState, useEffect, useCallback } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Landmark, AlertCircle, RefreshCw, ExternalLink, CheckCircle2, ChevronRight } from 'lucide-react'
import api from '../lib/api.js'
import { fmtDate } from '../lib/formatDate.js'
import { Badge } from './Badge.jsx'
import { METHOD_LABELS } from './FacturePaymentsSection.jsx'

import { fmtMoney } from '../utils/formatters.js'

// Sous-section « Dépôts directs » de la page Stripe Payouts : encaissements
// reçus directement en banque (virement, chèque, Interac…) donc jamais inclus
// dans un payout Stripe hebdomadaire. Même ergonomie que la liste des payouts :
// cliquer une ligne ouvre la page détail /depots-directs/:id (aperçu de
// l'écriture + bouton « Pousser vers QB » — ou lien vers le Deposit déjà posté).
// Une seule boîte : la liste des dépôts (lignes payments hors Stripe, chacune
// avec son lien QuickBooks). Un bandeau ambré « À comptabiliser » apparaît
// au-dessus seulement s'il existe des factures payées hors bande (paid_at sans
// charge ni payment_intent) sans encaissement saisi.
export default function DirectDepositsSection() {
  const navigate = useNavigate()
  const [data, setData] = useState({ deposits: [], candidates: [] })
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setData(await api.payments.directDeposits())
      setErr(null)
    } catch (e) {
      setErr(e.message || 'Erreur de chargement')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const { deposits, candidates } = data
  const stop = e => e.stopPropagation()

  return (
    <div className="mt-8" data-testid="direct-deposits-section">
      <div className="mb-3">
        <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
          <Landmark size={18} className="text-slate-500" /> Dépôts directs (hors payouts Stripe)
        </h2>
        <p className="text-xs text-slate-500 mt-0.5">
          Encaissements reçus directement en banque (virement, chèque, Interac…) — jamais inclus
          dans un payout Stripe. Cliquer une ligne pour voir l'écriture et la pousser vers QuickBooks.
        </p>
      </div>

      {err && (
        <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2 flex items-center gap-1.5">
          <AlertCircle size={13} className="flex-shrink-0" /> {err}
        </div>
      )}

      {loading ? (
        <div className="text-sm text-slate-400">Chargement…</div>
      ) : (
        <div className="space-y-4">
          {candidates.length > 0 && (
            <div className="bg-white rounded-xl border border-amber-200" data-testid="direct-deposit-candidates">
              <div className="px-5 py-3 border-b border-amber-100 bg-amber-50/60 rounded-t-xl">
                <p className="text-sm font-semibold text-amber-900">
                  À comptabiliser — {candidates.length} facture{candidates.length > 1 ? 's' : ''} payée{candidates.length > 1 ? 's' : ''} hors Stripe sans écriture d'encaissement
                </p>
                <p className="text-xs text-amber-800 mt-0.5">
                  Ces factures ont été marquées payées sans paiement Stripe (l'argent est entré directement en banque).
                  Aucun dépôt n'a encore été enregistré ni poussé dans QuickBooks.
                </p>
              </div>
              <table className="w-full text-sm">
                <thead className="text-xs text-slate-400 uppercase tracking-wide">
                  <tr>
                    <th className="text-left px-5 py-2 font-medium">Payée le</th>
                    <th className="text-left py-2 font-medium">Facture</th>
                    <th className="text-left py-2 font-medium">Client</th>
                    <th className="text-left py-2 font-medium">Type</th>
                    <th className="text-right py-2 font-medium">Montant</th>
                    <th className="px-5 py-2 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map(c => (
                    <tr
                      key={c.id}
                      onClick={() => navigate(`/depots-directs/${c.id}`)}
                      className="border-t border-slate-100 hover:bg-amber-50/40 cursor-pointer"
                      data-testid={`direct-deposit-candidate-${c.document_number}`}
                    >
                      <td className="px-5 py-2 text-slate-500 whitespace-nowrap">{fmtDate(c.paid_at)}</td>
                      <td className="py-2">
                        <Link to={`/factures/${c.id}`} onClick={stop} className="font-mono text-xs text-brand-600 hover:underline">
                          {c.document_number || c.id.slice(0, 8)}
                        </Link>
                      </td>
                      <td className="py-2 text-slate-700">
                        {c.company_id
                          ? <Link to={`/companies/${c.company_id}`} onClick={stop} className="text-brand-600 hover:underline">{c.company_name}</Link>
                          : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="py-2">
                        <Badge color={c.kind === 'subscription' ? 'blue' : 'gray'}>
                          {c.kind === 'subscription' ? 'Abonnement' : 'Commande'}
                        </Badge>
                      </td>
                      <td className="py-2 text-right font-medium text-slate-800 tabular-nums">{fmtMoney(c.total_amount, c.currency)}</td>
                      <td className="px-5 py-2 text-right text-slate-300"><ChevronRight size={16} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="bg-white rounded-xl border border-slate-200" data-testid="direct-deposits-recorded">
            {deposits.length === 0 ? (
              <div className="px-5 py-4 text-xs text-slate-400 italic">Aucun dépôt direct enregistré.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-xs text-slate-400 uppercase tracking-wide">
                  <tr>
                    <th className="text-left px-5 py-2 font-medium">Date</th>
                    <th className="text-left py-2 font-medium">Facture</th>
                    <th className="text-left py-2 font-medium">Client</th>
                    <th className="text-left py-2 font-medium">Mode</th>
                    <th className="text-right py-2 font-medium">Montant</th>
                    <th className="text-left py-2 pl-6 font-medium">QuickBooks</th>
                    <th className="px-5 py-2 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {deposits.map(p => (
                    <tr
                      key={p.id}
                      onClick={() => navigate(`/depots-directs/${p.id}`)}
                      className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer"
                      data-testid={`direct-deposit-row-${p.id}`}
                    >
                      <td className="px-5 py-2 text-slate-500 whitespace-nowrap">{fmtDate(p.received_at)}</td>
                      <td className="py-2">
                        <Link to={`/factures/${p.facture_id}`} onClick={stop} className="font-mono text-xs text-brand-600 hover:underline">
                          {p.document_number || p.facture_id.slice(0, 8)}
                        </Link>
                      </td>
                      <td className="py-2 text-slate-700">
                        {p.company_id
                          ? <Link to={`/companies/${p.company_id}`} onClick={stop} className="text-brand-600 hover:underline">{p.company_name}</Link>
                          : <span className="text-slate-400">—</span>}
                      </td>
                      <td className="py-2 text-slate-600">{METHOD_LABELS[p.method] || p.method}</td>
                      <td className="py-2 text-right font-medium text-slate-800 tabular-nums">{fmtMoney(p.amount, p.currency)}</td>
                      <td className="py-2 pl-6 whitespace-nowrap"><QbStatusCell p={p} /></td>
                      <td className="px-5 py-2 text-right text-slate-300"><ChevronRight size={16} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// Statut QB de la ligne — le lien ouvre QuickBooks directement (stopPropagation
// pour ne pas déclencher la navigation de la ligne) ; les actions (retry, saisie)
// vivent sur la page détail.
function QbStatusCell({ p }) {
  const qbId = p.qb_deposit_id || p.qb_journal_entry_id || p.qb_payment_id
  const qbUrl = p.qb_deposit_url || p.qb_journal_entry_url || p.qb_payment_url
  const label = p.qb_deposit_id ? 'Deposit' : (p.qb_journal_entry_id ? 'Écriture de journal' : 'Paiement')
  if (qbId) {
    return (
      <a
        href={qbUrl || undefined}
        target="_blank"
        rel="noopener noreferrer"
        onClick={e => e.stopPropagation()}
        className="inline-flex items-center gap-1 text-xs text-green-700 bg-green-100 px-2 py-0.5 rounded-full hover:bg-green-200"
        title={`Ouvrir dans QuickBooks (${label} #${qbId})${p.qb_credit_account_name ? ` · Cr ${p.qb_credit_account_name}` : ''}`}
      >
        <CheckCircle2 size={10} /> QuickBooks <ExternalLink size={9} />
      </a>
    )
  }
  if (p.qb_skipped) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-green-700" title="Comptabilisé — saisi manuellement dans QuickBooks (écriture non rattachée)">
        <CheckCircle2 size={10} /> Comptabilisé
      </span>
    )
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-xs text-amber-700 bg-amber-50 px-2 py-0.5 rounded"
      title="Écriture QB non posée — ouvrir la ligne pour pousser"
    >
      <RefreshCw size={10} /> à pousser
    </span>
  )
}
