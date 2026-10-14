// Revenus perçus d'avance — le compte 23900, prouvé.
//
// Le compte porte l'argent encaissé pour des commandes pas encore expédiées :
// l'encaissement le crédite, l'expédition le libère. Une seule liste, un point
// de couleur par dossier : vert = expédié, à constater ; rouge = à corriger ;
// gris = en attente de livraison. La légende filtre. Un clic ouvre l'écriture
// sous la ligne — rien ne part dans QuickBooks sans le bouton.
import { useState, useEffect, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { CalendarClock, AlertTriangle, RotateCw, ChevronRight, ChevronDown, CheckCircle2 } from 'lucide-react'
import api from '../lib/api.js'
import { ListPage } from '../components/ListPage.jsx'
import Spinner from '../components/Spinner.jsx'
import { fmtMoney } from '../utils/formatters.js'
import { useToast } from '../contexts/ToastContext.jsx'

const money = v => (v == null ? '—' : fmtMoney(v, 'CAD'))
const NUM = 'tabular-nums text-right w-[110px] shrink-0'

const FILES = [
  { k: 'constater', label: 'À constater', dot: 'bg-emerald-500', cta: 'Constater', btn: 'bg-emerald-600 hover:bg-emerald-700' },
  { k: 'corriger', label: 'À corriger', dot: 'bg-red-500', cta: 'Corriger', btn: 'bg-red-600 hover:bg-red-700' },
  { k: 'attente', label: 'En attente', dot: 'bg-slate-300' },
]
const FILE = Object.fromEntries(FILES.map(f => [f.k, f]))

// Un encaissement et une libération du même montant s'annulent (commande
// livrée) : on ne garde que ce qui fait le solde.
export function openLines(lines) {
  const sorted = [...(lines || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)))
  const gone = new Set()
  sorted.forEach((d, i) => {
    if (!(d.debit > 0)) return
    const j = sorted.findIndex((c, k) => !gone.has(k) && c.credit > 0 && Math.abs(c.credit - d.debit) < 0.01)
    if (j >= 0) { gone.add(i); gone.add(j) }
  })
  return sorted.filter((_, k) => !gone.has(k))
}

// Ce que le grand livre QuickBooks porte pour ce dossier : d'où vient le solde.
function Ledger({ lines }) {
  const shown = openLines(lines)
  if (!shown.length) return null
  return (
    <table className="mb-3 text-xs text-slate-500" data-testid="entry-ledger">
      <tbody>
        {shown.map((l, i) => (
          <tr key={i}>
            <td className="pr-4 py-0.5 tabular-nums">{l.date}</td>
            <td className="pr-4 py-0.5">{l.type}{l.doc_num && l.doc_num !== l.memo ? ` n° ${l.doc_num}` : ''}</td>
            <td className="pr-4 py-0.5 max-w-[260px] truncate">{[l.name, l.memo].filter(Boolean).join(' · ')}</td>
            <td className={`py-0.5 text-right tabular-nums ${l.debit > 0 ? 'text-red-600' : 'text-slate-700'}`}>
              {l.credit > 0 ? `+${money(l.credit)}` : `−${money(l.debit)}`}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Entry({ group, onDone }) {
  const c = group.correction
  const [busy, setBusy] = useState(false)
  const [date, setDate] = useState(c.txn_date)
  const { addToast } = useToast()
  // Un dépôt en attente se constate quand même, à la main.
  const meta = FILE[group.file].cta ? FILE[group.file] : FILE.constater

  async function send() {
    setBusy(true)
    try {
      const out = await api.deferredRevenue.publishCorrection({
        key: group.key, lines: c.lines, memo: c.memo, txn_date: date, facture_ids: c.facture_ids,
      })
      addToast({ message: `Envoyé (JE #${out.qb_je_id})`, type: 'success' })
      await onDone()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-end justify-between gap-4 pl-6 pb-4 border-b border-slate-100" data-testid="deferred-entry">
      <div className="text-sm">
        {group.file === 'corriger' && (
          <div className="mb-1 text-xs text-red-600">{group.anomalies?.[0]?.label}</div>
        )}
        <Ledger lines={group.lines} />
        <table>
          <tbody>
            {c.lines.map((l, i) => (
              <tr key={i}>
                <td className="pr-5 py-0.5 text-slate-400">
                  {i === 0 && (
                    <input
                      type="date" value={date} onChange={e => setDate(e.target.value)} data-testid="entry-date"
                      className="bg-transparent text-slate-500 border-0 p-0 text-sm"
                    />
                  )}
                </td>
                <td className="pr-5 py-0.5 text-slate-700">{l.acctnum} {l.acctnum === '23900' ? "Revenus perçus d'avance" : 'Ventes de produits'}</td>
                <td className="pr-5 py-0.5 text-right tabular-nums">{l.posting === 'Debit' ? money(l.amount) : ''}</td>
                <td className="py-0.5 text-right tabular-nums">{l.posting === 'Credit' ? money(l.amount) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        onClick={send} disabled={busy} data-testid="send-correction"
        className={`h-8 px-4 rounded-full text-sm font-semibold text-white disabled:opacity-50 ${meta.btn}`}
      >
        {busy ? 'Envoi…' : meta.cta}
      </button>
    </div>
  )
}

function Row({ group, open, onToggle, onDone }) {
  const meta = FILE[group.file]
  const can = !!group.correction
  const muted = group.file === 'attente'
  return (
    <>
      <div
        onClick={can ? onToggle : undefined}
        data-testid="deferred-row" data-file={group.file}
        className={`flex items-center gap-4 py-3.5 border-b border-slate-100 ${can ? 'cursor-pointer hover:bg-slate-50' : ''} ${open ? 'border-b-0' : ''}`}
      >
        <i className={`w-2 h-2 rounded-full shrink-0 ${meta.dot}`} />
        <div className="flex-1 min-w-0 truncate font-medium">
          {group.company_id
            ? <Link to={`/companies/${group.company_id}`} onClick={e => e.stopPropagation()} className={muted ? 'text-slate-500 hover:underline' : 'text-slate-800 hover:underline'}>{group.company_name}</Link>
            : <span className="text-slate-500">{group.company_name}</span>}
        </div>
        <div className={`${NUM} font-medium ${group.solde < 0 ? 'text-red-600' : muted ? 'text-slate-500' : 'text-slate-800'}`}>
          {money(group.solde)}
        </div>
        <div className="w-5 text-slate-300">
          {can && (open ? <ChevronDown size={16} /> : <ChevronRight size={16} />)}
        </div>
      </div>
      {open && can && <Entry group={group} onDone={onDone} />}
    </>
  )
}

export default function RevenusReportes() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [shown, setShown] = useState({ constater: true, corriger: true, attente: true })
  const [openKey, setOpenKey] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await api.deferredRevenue.state())
    } catch (e) {
      setError(e.message || 'Chargement impossible')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const all = useMemo(() => {
    const order = { constater: 0, corriger: 1, attente: 2 }
    return (data?.groups || [])
      // Un dossier à 0 $ n'a rien à montrer ni à corriger.
      .filter(g => g.file in order && Math.abs(g.solde) >= 0.01)
      .sort((a, b) => (order[a.file] - order[b.file]) || (Math.abs(b.solde) - Math.abs(a.solde)))
  }, [data])
  const counts = useMemo(() => all.reduce((m, g) => ({ ...m, [g.file]: (m[g.file] || 0) + 1 }), {}), [all])
  const rows = all.filter(g => shown[g.file])
  const allShown = FILES.every(f => shown[f.k])
  const sum = k => Math.round(rows.reduce((t, g) => t + (Number(g[k]) || 0), 0) * 100) / 100

  return (
    <ListPage
      title="Revenus perçus d'avance"
      icon={CalendarClock}
      actions={(
        <>
          <button
            onClick={load} disabled={loading} data-testid="reload-state" title="Relire QuickBooks"
            className="p-2 text-slate-500 rounded-lg hover:bg-slate-100 disabled:opacity-50"
          >
            <RotateCw size={15} className={loading ? 'animate-spin' : ''} />
          </button>
        </>
      )}
      banner={error && (
        <div className="flex items-center gap-2 mb-3 px-3 py-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg">
          <AlertTriangle size={15} /> {error}
        </div>
      )}
    >
      <div className="max-w-3xl bg-white rounded-xl border border-slate-200 px-6 py-4">
        <div className="flex flex-wrap gap-5 text-sm mb-2">
          {FILES.map(f => (
            <button
              key={f.k} onClick={() => setShown(s => ({ ...s, [f.k]: !s[f.k] }))}
              data-testid={`legend-${f.k}`}
              className={`inline-flex items-center gap-2 ${shown[f.k] ? 'text-slate-800 font-medium' : 'text-slate-400 opacity-60'}`}
            >
              <i className={`w-2 h-2 rounded-full ${f.dot}`} />{f.label} {counts[f.k] || 0}
            </button>
          ))}
        </div>
        {!!rows.length && (
          <div className="flex items-center gap-4 pt-2 pb-1.5 border-b border-slate-200 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
            <i className="w-2 shrink-0" />
            <div className="flex-1">Client</div>
            <div className={NUM}>Solde</div>
            <div className="w-5" />
          </div>
        )}
        {!data && loading && <div className="py-10 flex justify-center"><Spinner /></div>}
        {data && !rows.length && (
          <div className="py-10 flex flex-col items-center gap-2 text-slate-400 text-sm">
            <CheckCircle2 size={22} /> Tout est soldé
          </div>
        )}
        {rows.map(g => (
          <Row
            key={g.key} group={g} open={openKey === g.key}
            onToggle={() => setOpenKey(k => (k === g.key ? null : g.key))}
            onDone={async () => { setOpenKey(null); await load() }}
          />
        ))}
        {!!rows.length && (
          <div className="mt-1 pt-3 border-t-2 border-slate-300" data-testid="deferred-totals">
            <div className="flex items-baseline gap-4 font-semibold">
              <div className="flex-1">Total</div>
              <div className={NUM} data-testid="total-solde">{money(sum('solde'))}</div>
              <div className="w-5" />
            </div>
            {data && allShown && (
              <div className="flex gap-4 mt-0.5 text-xs">
                <div className="flex-1" />
                {data.ecart
                  ? <div className={`${NUM} text-amber-600`} data-testid="qb-ecart">écart QuickBooks {money(data.ecart)}</div>
                  : data.qb_balance != null && <div className={`${NUM} text-emerald-600`}>= QuickBooks</div>}
                <div className="w-5" />
              </div>
            )}
          </div>
        )}
      </div>
    </ListPage>
  )
}
