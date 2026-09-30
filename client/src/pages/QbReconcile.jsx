import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CheckCircle2, Circle, AlertCircle, RefreshCw, ExternalLink } from 'lucide-react'
import { Layout } from '../components/Layout.jsx'
import { DataTable } from '../components/DataTable.jsx'
import SearchableSelect from '../components/SearchableSelect.jsx'
import { api } from '../lib/api.js'

// « Rapprocher (QBO) » — l'écran Rapprocher de QuickBooks tel que le robot l'a
// laissé à son dernier passage : bandeau des soldes et grille cochée. Lecture
// seule ; « Actualiser » relance le robot (il ne clique jamais « Terminer »).

const money = (v) => (v == null ? '—' : `${Number(v).toLocaleString('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $`)

function Figure({ value, label, big }) {
  return (
    <div className="text-center min-w-0">
      <div className={`${big ? 'text-2xl' : 'text-lg'} tabular-nums text-slate-800`}>{money(value)}</div>
      <div className="text-[11px] uppercase tracking-wide text-slate-500 truncate">{label}</div>
    </div>
  )
}

export default function QbReconcile() {
  const [params, setParams] = useSearchParams()
  const [accounts, setAccounts] = useState([])
  const [state, setState] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const timer = useRef(null)
  const accountId = params.get('compte') || ''
  const [toClose, setToClose] = useState([])
  useEffect(() => { api.bank.monthClose().then(r => setToClose(r?.ready || [])).catch(() => {}) }, [state])

  useEffect(() => {
    api.bank.accounts().then((list) => {
      const mapped = (list || []).filter((a) => a.qb_account_id)
      setAccounts(mapped)
      if (!params.get('compte') && mapped[0]) setParams({ compte: mapped[0].id }, { replace: true })
    }).catch((e) => setError(e.message))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    if (!accountId) return
    try {
      const s = await api.bank.qbReconcileLast(accountId)
      setState(s)
      clearTimeout(timer.current)
      if (s?.running) timer.current = setTimeout(load, 5000)
    } catch (e) { setError(e.message) }
  }, [accountId])

  useEffect(() => { setState(null); load(); return () => clearTimeout(timer.current) }, [load])

  const refresh = async () => {
    setBusy(true); setError(null)
    try { await api.bank.qbReconcileRun(accountId); await load() } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  const last = state?.last
  const view = last?.view
  const sum = view?.summary || {}

  const { columns, rows } = useMemo(() => {
    const headers = view?.headers || []
    const cols = headers
      .map((h, i) => ({ h, i }))
      .filter(({ h }) => h && h.trim())
      .map(({ h, i }) => ({
        id: `c${i}`, field: `c${i}`, label: h.replace(/\s*[▲▼↑↓]\s*$/, ''),
        width: /m[ée]mo|compte|b[ée]n[ée]ficiaire/i.test(h) ? 220 : /d[ée]bit|paiement|d[ée]p[ôo]t|cr[ée]dit/i.test(h) ? 120 : 130,
      }))
    cols.push({
      id: 'checked', field: 'checked', label: '✓', width: 60,
      render: (r) => (r.checked ? <CheckCircle2 size={16} className="text-green-700" /> : <Circle size={16} className="text-slate-300" />),
    })
    const data = (view?.rows || []).map((r, n) => {
      const o = { id: String(n), checked: r.checked }
      r.cells.forEach((c, i) => { o[`c${i}`] = c })
      return o
    })
    return { columns: cols, rows: data }
  }, [view])

  const ok = sum.difference != null && Math.abs(sum.difference) < 0.005

  return (
    <Layout>
      <div className="p-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="w-72">
            <SearchableSelect
              value={accountId}
              onChange={(v) => setParams({ compte: v }, { replace: true })}
              options={accounts.map((a) => ({ value: a.id, label: a.name }))}
            />
          </div>
          <button type="button" onClick={refresh} disabled={busy || state?.running || !accountId} data-testid="qbo-refresh"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm rounded-lg border border-slate-300 hover:bg-slate-50 disabled:opacity-50">
            <RefreshCw size={14} className={state?.running ? 'animate-spin' : ''} /> {state?.running ? 'Robot en cours…' : 'Actualiser'}
          </button>
          <a href="https://qbo.intuit.com/app/reconcile" target="_blank" rel="noreferrer"
            className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
            <ExternalLink size={14} /> QuickBooks
          </a>
          {last?.at && <span className="text-xs text-slate-400 ml-auto">{new Date(last.at).toLocaleString('fr-CA')}</span>}
        </div>

        {toClose.length > 0 && (
          <div data-testid="month-close" className="flex items-center gap-2 flex-wrap text-sm">
            <span className="text-amber-700 font-medium">À terminer ({toClose.length})</span>
            {toClose.map(a => (
              <button key={a.account_id} type="button" onClick={() => setParams({ compte: a.account_id }, { replace: true })}
                className={`px-2 py-0.5 rounded-full border ${a.account_id === accountId ? 'border-amber-500 bg-amber-50' : 'border-slate-300 hover:bg-slate-50'}`}>
                {a.account_name} · {a.statement_date}
              </button>
            ))}
          </div>
        )}
        {error && <div className="text-sm text-red-700">{error}</div>}
        {last && !last.ok && <div className="text-sm text-amber-700">{last.error || 'Dernier passage en échec'}</div>}

        {view ? (
          <>
            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <div className="flex items-baseline justify-between gap-3 mb-3">
                <div className="min-w-0">
                  <div className="text-xl text-slate-800 truncate">{sum.title || accounts.find((a) => a.id === accountId)?.name}</div>
                  {sum.end_date_label && <div className="text-sm text-slate-500">Date de fin du relevé : {sum.end_date_label}</div>}
                </div>
              </div>
              <div className="grid grid-cols-[1fr_auto] gap-4 items-center">
                <div className="space-y-3">
                  <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2">
                    <Figure big value={sum.ending_balance} label="Solde de fermeture du relevé" />
                    <span className="text-slate-400 text-xl">−</span>
                    <Figure big value={sum.cleared_balance} label="Solde compensé" />
                  </div>
                  <div className="grid grid-cols-[1fr_auto_1fr_auto_1fr] items-center gap-2 border-t border-slate-100 pt-3">
                    <Figure value={sum.beginning_balance} label="Solde initial" />
                    <span className="text-slate-400">±</span>
                    <Figure value={sum.out_total} label={sum.out_label || 'Débits'} />
                    <span className="text-slate-400">±</span>
                    <Figure value={sum.in_total} label={sum.in_label || 'Paiements'} />
                  </div>
                </div>
                <div className="flex items-center gap-2 pl-4 border-l border-slate-200" data-testid="qbo-difference">
                  {ok ? <CheckCircle2 size={28} className="text-green-600" /> : <AlertCircle size={28} className="text-amber-500" />}
                  <Figure big value={sum.difference} label="Différence" />
                </div>
              </div>
            </div>
            <DataTable table="qbo_reconcile_view" columns={columns} data={rows} height="calc(100vh - 380px)" />
          </>
        ) : (
          last && <div className="text-sm text-slate-500">Aucune vue enregistrée — Actualiser.</div>
        )}
      </div>
    </Layout>
  )
}
