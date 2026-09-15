// Tout ce que Boréal a préparé et qui attend un clic, sur un seul écran.
//
// Les propositions se voient déjà ligne par ligne dans le rapprochement ; il
// manquait l'endroit où les traiter en série, sans ouvrir onze comptes. Même
// règle qu'ailleurs : rien n'est appliqué sans geste, et un refus est définitif.
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Check, X, RefreshCw } from 'lucide-react'
import { Layout } from '../components/Layout.jsx'
import Spinner from '../components/Spinner.jsx'
import ErrorBanner from '../components/ErrorBanner.jsx'
import api from '../lib/api.js'
import { fmtMoney } from '../utils/formatters.js'
import { fmtDate } from '../lib/formatDate.js'

// Ce que chaque nature veut dire, en clair. Deux d'entre elles publient dans
// QuickBooks une fois acceptées : elles le disent.
const KIND = {
  qb_link: { label: 'Écriture retrouvée dans QuickBooks' },
  doc_match: { label: 'Pièce que nous avions déjà' },
  invoice_found: { label: 'Facture retrouvée' },
  vendor_expense: { label: 'Dépense sans facture', publishes: true },
  payment_clear: { label: 'Paiement passé au compte' },
  paie_debit: { label: 'Débit de la paie' },
  aga_repartition: { label: 'Assurance collective', publishes: true },
  debt_payment: { label: 'Versement de dette' },
}

const STATUSES = [
  ['proposee', 'À confirmer'],
  ['acceptee', 'Acceptées'],
  ['refusee', 'Refusées'],
  ['perimee', 'Périmées'],
]

export default function Propositions() {
  const [status, setStatus] = useState('proposee')
  const [rows, setRows] = useState(null)
  const [counts, setCounts] = useState({})
  const [busy, setBusy] = useState(null)
  const [error, setError] = useState(null)

  const load = useCallback(() => {
    setRows(null)
    api.bank.proposals({ status, limit: 300 }).then(setRows).catch((e) => { setRows([]); setError(e.message) })
    api.bank.proposalsSummary().then((s) => setCounts(s || {})).catch(() => {})
  }, [status])

  useEffect(() => { load() }, [load])

  // Groupées par nature : on traite une nature à la fois, c'est ainsi qu'on
  // prend une décision cohérente plutôt qu'au cas par cas.
  const groups = useMemo(() => {
    const m = new Map()
    for (const p of rows || []) {
      if (!m.has(p.kind)) m.set(p.kind, [])
      m.get(p.kind).push(p)
    }
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length)
  }, [rows])

  const decide = async (p, accept) => {
    setBusy(p.id); setError(null)
    try {
      if (accept) await api.bank.acceptProposal(p.id)
      else await api.bank.refuseProposal(p.id)
      setRows((r) => r.filter((x) => x.id !== p.id))
      api.bank.proposalsSummary().then((s) => setCounts(s || {})).catch(() => {})
    } catch (e) { setError(e.message) } finally { setBusy(null) }
  }

  const acceptGroup = async (list) => {
    setBusy('lot'); setError(null)
    try {
      await api.bank.acceptProposals(list.map((p) => p.id))
      load()
    } catch (e) { setError(e.message) } finally { setBusy(null) }
  }

  const total = (rows || []).length

  return (
    <Layout>
      <div className="p-4 max-w-3xl space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <h1 className="text-lg font-semibold text-slate-800 mr-auto">Propositions</h1>
          <button type="button" onClick={load}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-slate-300 hover:bg-slate-50">
            <RefreshCw size={14} /> Relire
          </button>
        </div>

        <div className="flex gap-1 flex-wrap">
          {STATUSES.map(([key, label]) => (
            <button key={key} type="button" onClick={() => setStatus(key)}
              className={`px-2.5 py-1 text-xs rounded-lg ${status === key ? 'bg-slate-800 text-white' : 'text-slate-500 hover:bg-slate-100'}`}>
              {label}{key === 'proposee' && counts.total ? ` ${counts.total}` : ''}
            </button>
          ))}
        </div>

        {error && <ErrorBanner>{error}</ErrorBanner>}

        {!rows ? <Spinner /> : !total ? (
          <div className="text-sm text-slate-400 py-10 text-center">Rien ici.</div>
        ) : groups.map(([kind, list]) => (
          <div key={kind} className="border border-slate-200 rounded-lg overflow-hidden">
            <div className="flex items-center gap-2 px-3 py-2 bg-slate-50">
              <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                {KIND[kind]?.label || kind}
              </span>
              {KIND[kind]?.publishes && (
                <span className="text-[11px] text-amber-700">publie dans QuickBooks</span>
              )}
              <span className="ml-auto text-xs text-slate-400 tabular-nums">{list.length}</span>
              {status === 'proposee' && list.length > 1 && !KIND[kind]?.publishes && (
                <button type="button" disabled={busy === 'lot'} onClick={() => acceptGroup(list)}
                  className="text-xs px-2 py-0.5 rounded-lg border border-slate-300 text-slate-600 hover:bg-white disabled:opacity-40">
                  Tout confirmer
                </button>
              )}
            </div>

            <div className="divide-y divide-slate-100">
              {list.map((p) => (
                <div key={p.id} className="flex items-start gap-3 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2 text-sm">
                      <span className="text-xs text-slate-400 tabular-nums shrink-0">{fmtDate(p.txn_date)}</span>
                      <Link to={`/rapprochement?compte=${p.account_id}&ligne=${p.bank_txn_id}`}
                        className="truncate text-slate-700 hover:text-brand-600 hover:underline">
                        {p.txn_label}
                      </Link>
                      <span className="ml-auto tabular-nums shrink-0 text-slate-600">
                        {fmtMoney(p.txn_amount, p.currency || 'CAD')}
                      </span>
                    </div>
                    <div className="text-xs text-slate-400 truncate">
                      {p.account_name}
                      {(p.evidence || []).map((e) => ` · ${e.label}${e.detail ? ` ${e.detail}` : ''}`).join('')}
                    </div>
                    {p.last_error && <div className="text-xs text-red-600">{p.last_error}</div>}
                  </div>

                  {status === 'proposee' && (
                    <div className="flex gap-1 shrink-0">
                      <button type="button" title="C'est bien ça" disabled={busy === p.id}
                        onClick={() => decide(p, true)}
                        className="p-1.5 rounded-lg text-emerald-600 hover:bg-emerald-50 disabled:opacity-40">
                        <Check size={15} />
                      </button>
                      <button type="button" title="Ce n'est pas ça — définitif" disabled={busy === p.id}
                        onClick={() => decide(p, false)}
                        className="p-1.5 rounded-lg text-slate-300 hover:text-red-600 hover:bg-red-50 disabled:opacity-40">
                        <X size={15} />
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </div>
        ))}

        <div className="text-xs text-slate-400">Un refus est définitif : la proposition ne revient plus.</div>
      </div>
    </Layout>
  )
}
