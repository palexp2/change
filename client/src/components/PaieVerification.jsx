import { useState, useEffect, useCallback } from 'react'
import { Link } from 'react-router-dom'
import api from '../lib/api.js'
import { fmtMoney, fmtNumber } from '../utils/formatters.js'
import { fmtDate, fmtDateTime } from '../lib/formatDate.js'
import { useToast } from '../contexts/ToastContext.jsx'
import Spinner from './Spinner.jsx'

// Vérification d'une paie (fiche Paie) : chaque montant saisi avec sa source,
// clic = la preuve. Maquette choisie : /erp/maquettes/paie-fiche/ (V1).

const COLS = [
  { k: 'hours', label: 'Heures', src: { boreal: 'Boréal', none: 'Airtable' }, unit: 'h' },
  { k: 'holiday', label: 'Férié 1/20', src: { calc: 'calcul' } },
  { k: 'vacation', label: 'Vacances', src: { releve: 'relevé' } },
  { k: 'reimb', label: 'Remb.', src: { qb: 'QuickBooks' } },
  { k: 'commission', label: 'Commission', src: { vendeurs: 'Vendeurs' } },
]
const FLAG_TEXT = {
  mismatch: 'ne tombe pas sur la source',
  decimals: 'décimales cachées',
  includes_reimb: 'remboursement compté dans la base',
  under_min: 'sous 200 $',
  conge_unpaid: 'congé non payé',
}
const LABEL = Object.fromEntries(COLS.map(c => [c.k, c.label]))
const fmtH = n => (n == null ? '' : fmtNumber(n, { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
const fmtJ = n => `${String(n).replace('.', ',')} j`
const fmtVal = (k, n) => (k === 'hours' ? fmtH(n) : fmtMoney(n).replace(/\s*\$$/, ''))

function SourceBox({ title, action, children }) {
  return (
    <div className="max-w-xl rounded-lg border border-slate-200 overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-slate-50 border-b border-slate-200 text-xs font-semibold text-slate-600">
        <span className="flex-1">{title}</span>{action}
      </div>
      <div className="text-xs">{children}</div>
    </div>
  )
}

function Rows({ rows }) {
  return (
    <table className="w-full">
      <tbody>
        {rows.map(([a, b, cls], i) => (
          <tr key={i} className={`border-b border-slate-100 last:border-0 ${cls || ''}`}>
            <td className="px-3 py-1">{a}</td><td className="px-3 py-1 text-right tabular-nums">{b}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

function Proof({ row, k, periodStart }) {
  const c = row.cells[k]
  if (k === 'hours') {
    if (c.source !== 'boreal') return <p className="text-sm text-slate-500">Rien dans Boréal pour cette période — heures tenues dans Airtable.</p>
    return (
      <>
        <SourceBox
          title={`Boréal · feuille de temps de ${row.name.split(' ')[0]}`}
          action={<Link to="/feuille-de-temps" state={{ timesheetOf: { userId: c.user_id, date: periodStart } }} className="text-blue-600">Ouvrir ↗</Link>}
        >
          <Rows rows={[
            ...c.weeks.map(w => [`${fmtDate(w.start)} → ${fmtDate(w.end)}`, `${fmtH(w.hours)} h`]),
            ['Total', `${fmtH(c.total)} h`, 'font-semibold'],
          ]} />
        </SourceBox>
        {c.contractual && <p className="text-sm text-slate-500 mt-2">Heures à contrat : Boréal est indicatif.</p>}
        {c.flag === 'mismatch' && <p className="text-sm text-amber-700 mt-2">Saisi {fmtH(c.value)} h, Boréal dit {fmtH(c.total)} h.</p>}
        {c.flag === 'decimals' && <p className="text-sm text-amber-700 mt-2">Saisi avec plus de 2 décimales ({c.value}) : écart d'un sou dans Nethris.</p>}
      </>
    )
  }
  if (k === 'holiday') {
    return (
      <>
        <SourceBox title="1/20 des 2 paies précédentes, sans remboursements ni commissions">
          <Rows rows={[
            ...c.previous.map(p => [
              `Paie du ${fmtDate(p.period_end)}`,
              `${fmtVal('x', p.gains)}${p.expense_reimb || p.commission ? ` (${fmtVal('x', p.total_pay)}${p.expense_reimb ? ` − ${fmtVal('x', p.expense_reimb)} remb.` : ''}${p.commission ? ` − ${fmtVal('x', p.commission)} comm.` : ''})` : ''}`,
            ]),
            ['÷ 20', fmtVal('x', c.expected), 'font-semibold'],
          ]} />
        </SourceBox>
        {c.flag === 'includes_reimb' && <p className="text-sm text-amber-700 mt-2">Airtable compte le remboursement : {fmtVal('x', c.value)} au lieu de {fmtVal('x', c.expected)}. Nethris calcule {fmtVal('x', c.expected)}.</p>}
        {c.flag === 'mismatch' && <p className="text-sm text-amber-700 mt-2">Saisi {fmtVal('x', c.value)}, calcul {fmtVal('x', c.expected)}.</p>}
      </>
    )
  }
  if (k === 'vacation') {
    if (!c.conges?.length) return <p className="text-sm text-slate-500">Aucun congé inscrit dans la feuille de temps.</p>
    return (
      <>
        <SourceBox title={`🌴 Congés · ${row.name.split(' ')[0]}`}>
          <Rows rows={[
            ...c.conges.map(x => [x.half ? `${x.label} · ½` : x.label, fmtJ(x.days)]),
            ['Total à payer en congé', fmtJ(c.days), 'font-semibold'],
          ]} />
        </SourceBox>
        {c.flag === 'conge_unpaid' && <p className="text-sm text-amber-700 mt-2">{fmtJ(c.days)} de congé, aucun montant « Vacances ».</p>}
      </>
    )
  }
  if (k === 'commission') {
    return c.flag === 'under_min'
      ? <p className="text-sm text-amber-700">Commission sous {fmtVal('x', c.min)} $ payée — d'habitude on la laisse s'accumuler.</p>
      : <p className="text-sm text-slate-500">Inventaire › Vendeurs · commission à payer.</p>
  }
  return <p className="text-sm text-slate-400">Source pas encore branchée.</p>
}

export default function PaieVerification({ paieId }) {
  const { addToast } = useToast()
  const [v, setV] = useState(null)
  const [sel, setSel] = useState(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    api.paies.verification(paieId).then(out => {
      setV(out)
      setSel(cur => cur || (out.flags[0] ? [out.flags[0].item_id, out.flags[0].field] : null))
    }).catch(e => addToast({ message: e.message, type: 'error' }))
  }, [paieId, addToast])
  useEffect(() => { load() }, [load])

  async function verify(undo) {
    setBusy(true)
    try { setV(await api.paies.verify(paieId, { undo })) } catch (e) { addToast({ message: e.message, type: 'error' }) } finally { setBusy(false) }
  }

  if (!v) return <p className="text-sm text-slate-400"><Spinner size="xs" label="Vérification…" /></p>
  const locked = !!v.verified_at
  const selRow = sel && v.rows.find(r => r.item_id === sel[0])
  const n = v.flags.length

  return (
    <div className="space-y-3" data-testid="paie-verification">
      <div className={`flex items-center gap-3 flex-wrap rounded-lg px-3 py-2 text-sm ${locked ? 'bg-green-50 text-green-800' : n ? 'bg-amber-50 text-amber-800' : 'bg-green-50 text-green-800'}`}>
        {locked ? (
          <><b>Approuvée par {v.verified_by || '—'}</b><span>{fmtDateTime(v.verified_at)}</span><span className="flex-1" />
            <button onClick={() => verify(true)} disabled={busy} className="font-semibold underline-offset-2 hover:underline">Rouvrir</button></>
        ) : (
          <><b>{n ? `${n} à regarder` : 'Tout tombe sur les sources'}</b>
            <span className="truncate">{v.flags.map(f => `${f.name.split(' ')[0]} · ${LABEL[f.field].toLowerCase()}`).join(' — ')}</span>
            <span className="flex-1" />
            <button onClick={() => verify(false)} disabled={busy} className="btn-primary text-sm" data-testid="paie-verify">Approuver</button></>
        )}
      </div>

      <div className="rounded-lg border border-slate-200 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-xs text-slate-500 border-b border-slate-200">
                <th className="text-left font-semibold px-3 py-2">Employé</th>
                {COLS.map(c => <th key={c.k} className="text-right font-semibold px-3 py-2 whitespace-nowrap">{c.label}</th>)}
                <th className="text-right font-semibold px-3 py-2">Paie</th>
              </tr>
            </thead>
            <tbody>
              {v.rows.map(r => (
                <tr key={r.item_id} className="border-b border-slate-100">
                  <td className="px-3 py-1.5 font-semibold whitespace-nowrap">
                    <Link to={`/employees/${r.employee_id}`} className="hover:underline">{r.name}</Link>
                  </td>
                  {COLS.map(col => {
                    const c = r.cells[col.k]
                    if (!c || (c.value == null && !c.conges?.length)) return <td key={col.k} className="px-3 py-1.5 text-right text-slate-300">—</td>
                    const flag = !locked && c.flag
                    const on = sel && sel[0] === r.item_id && sel[1] === col.k
                    return (
                      <td key={col.k} onClick={() => setSel([r.item_id, col.k])}
                        className={`px-3 py-1.5 text-right tabular-nums cursor-pointer whitespace-nowrap ${flag ? 'bg-amber-50' : 'hover:bg-blue-50'} ${on ? 'ring-2 ring-inset ' + (flag ? 'ring-amber-500' : 'ring-blue-500') : ''}`}>
                        {c.value == null ? fmtJ(c.days) : fmtVal(col.k, c.value)}
                        {c.value != null && c.days > 0 && <span className="text-[10px] text-slate-400"> · 🌴 {fmtJ(c.days)}</span>}
                        <span className={`block text-[10px] font-medium ${flag ? 'text-amber-700' : 'text-slate-400'}`}>
                          {flag ? FLAG_TEXT[c.flag] || 'à regarder' : `${locked ? '✓ ' : ''}${col.src[c.source] || ''}`}
                        </span>
                      </td>
                    )
                  })}
                  <td className="px-3 py-1.5 text-right font-semibold tabular-nums whitespace-nowrap">{fmtMoney(r.total_pay)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-slate-50 font-semibold">
                <td className="px-3 py-2">Total</td>
                {COLS.map(c => <td key={c.k} className="px-3 py-2 text-right tabular-nums">{fmtVal(c.k, v.totals[c.k])}</td>)}
                <td className="px-3 py-2 text-right tabular-nums">{fmtMoney(v.totals.pay)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        {selRow && selRow.cells[sel[1]] && (
          <div className="grid sm:grid-cols-[200px_1fr] border-t border-slate-200">
            <div className="p-3 bg-slate-50 sm:border-r border-slate-200">
              <div className="text-xs text-slate-500">{selRow.name}</div>
              <div className="text-base font-semibold tabular-nums">{selRow.cells[sel[1]].value == null ? fmtJ(selRow.cells[sel[1]].days) : `${fmtVal(sel[1], selRow.cells[sel[1]].value)} ${sel[1] === 'hours' ? 'h' : '$'}`}</div>
              <div className="text-xs text-slate-500">{LABEL[sel[1]]}</div>
            </div>
            <div className="p-3"><Proof row={selRow} k={sel[1]} periodStart={v.period_start} /></div>
          </div>
        )}
      </div>
    </div>
  )
}
