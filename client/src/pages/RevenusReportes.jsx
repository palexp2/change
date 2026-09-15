// Revenus perçus d'avance — ce qui a été encaissé pour des mois à venir.
//
// Une facture dont la période de service déborde le mois de l'encaissement
// porte du revenu pas encore gagné : la portion des mois suivants est reportée,
// puis constatée mois par mois (Dr revenus reportés / Cr revenus). Le calcul est
// servi par le serveur ; la page choisit le mois, montre le détail, prépare
// l'écriture et laisse l'utilisateur la comptabiliser — jamais automatique.
import { useState, useEffect, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { CalendarClock, ChevronLeft, ChevronRight, CheckCircle2, AlertTriangle, RotateCw, Trash2, Send } from 'lucide-react'
import api from '../lib/api.js'
import { ListPage } from '../components/ListPage.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { Modal } from '../components/Modal.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDayShort } from '../lib/formatDate.js'
import { fmtMoney } from '../utils/formatters.js'
import { useToast } from '../contexts/ToastContext.jsx'

const MONTHS = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre']
const monthLabel = m => `${MONTHS[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`
const currentMonth = () => new Date().toISOString().slice(0, 7)
const shift = (month, delta) => {
  const d = new Date(`${month}-15T12:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() + delta)
  return d.toISOString().slice(0, 7)
}

const money = v => (v == null ? '—' : fmtMoney(v, 'CAD'))

// « 27 juil. – 27 août », l'année seulement quand la période en change (annuels).
function periodLabel(start, end) {
  const s = String(start).slice(0, 10)
  const e = String(end).slice(0, 10)
  if (s.slice(0, 4) === e.slice(0, 4)) return `${fmtDayShort(s)} – ${fmtDayShort(e)}`
  return `${fmtDayShort(s)} ${s.slice(0, 4)} – ${fmtDayShort(e)} ${e.slice(0, 4)}`
}

const RENDERS = {
  company_name: row => (row.company_id
    ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="link-record">{row.company_name}</Link>
    : <span className="text-slate-600">{row.company_name}</span>),
  document_number: row => (
    <Link to={`/factures/${row.facture_id}`} onClick={e => e.stopPropagation()} className="link-record">{row.document_number}</Link>
  ),
  source: row => <span className="text-slate-600">{row.source}</span>,
  periode: row => <span className="text-slate-500">{row.periode}</span>,
  total_ht_cad: row => <span className="tabular-nums text-slate-600">{money(row.total_ht_cad)}</span>,
  recognized_before_cad: row => <span className="tabular-nums text-slate-500">{money(row.recognized_before_cad)}</span>,
  to_recognize_cad: row => <span className="tabular-nums font-medium text-slate-800">{money(row.to_recognize_cad)}</span>,
  remaining_cad: row => <span className="tabular-nums text-slate-600">{money(row.remaining_cad)}</span>,
  deferral_acctnum: row => <span className="font-mono text-xs text-slate-500">{row.deferral_acctnum}</span>,
  etat: row => (row.recognized
    ? (
      <span className="inline-flex items-center gap-1 text-xs text-emerald-600">
        <CheckCircle2 size={12} />
        {row.qb_je_url ? <a href={row.qb_je_url} target="_blank" rel="noreferrer" className="underline">JE #{row.qb_je_id}</a> : 'Constaté'}
      </span>
    )
    : <span className="text-xs text-slate-400">{row.etat}</span>),
}

const COLUMNS = TABLE_COLUMN_META.revenus_reportes.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

// ── Brouillon d'écriture ────────────────────────────────────────────────────

function DraftModal({ month, draft, onClose, onChanged }) {
  const [lines, setLines] = useState(draft.lines)
  const [memo, setMemo] = useState(draft.memo || '')
  const [busy, setBusy] = useState(null)
  const { addToast } = useToast()
  useEffect(() => { setLines(draft.lines); setMemo(draft.memo || '') }, [draft])

  const total = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0)
  const pushed = !!draft.pushed_at

  const setAmount = (i, v) => setLines(ls => ls.map((l, n) => (n === i ? { ...l, amount: v === '' ? 0 : Number(v) } : l)))

  async function run(key, fn, done) {
    setBusy(key)
    try {
      const out = await fn()
      if (done) addToast({ message: done(out), type: 'success' })
      await onChanged()
      if (key !== 'save') onClose()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <Modal isOpen onClose={onClose} title={`Écriture — ${monthLabel(month)}`} size="xl">
      <div className="space-y-3">
        <input
          value={memo} onChange={e => setMemo(e.target.value)} disabled={pushed}
          className="w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg disabled:bg-slate-50"
        />
        <div className="max-h-80 overflow-auto border border-slate-100 rounded-lg">
          <table className="w-full text-sm">
            <tbody>
              <tr className="border-b border-slate-100 bg-slate-50">
                <td className="py-1.5 px-3 text-slate-500">Dr #{draft.deferral_acctnum}</td>
                <td className="py-1.5 px-3 text-right tabular-nums font-medium">{fmtMoney(total, 'CAD')}</td>
              </tr>
              {lines.map((l, i) => (
                <tr key={i} className="border-b border-slate-50">
                  <td className="py-1.5 px-3">
                    <span className="text-slate-400 mr-2">Cr #{l.revenue_acctnum}</span>
                    <span className="text-slate-700">{l.label}</span>
                  </td>
                  <td className="py-1.5 px-3 text-right">
                    <input
                      type="number" step="0.01" value={l.amount} disabled={pushed}
                      onChange={e => setAmount(i, e.target.value)}
                      className="w-28 px-2 py-1 text-sm text-right tabular-nums border border-slate-200 rounded disabled:bg-slate-50"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between gap-2">
          {pushed
            ? (
              <span className="inline-flex items-center gap-1 text-sm text-emerald-600">
                <CheckCircle2 size={14} />
                {draft.qb_je_url ? <a href={draft.qb_je_url} target="_blank" rel="noreferrer" className="underline">JE #{draft.qb_je_id}</a> : 'Comptabilisé'}
              </span>
            )
            : (
              <button
                onClick={() => run('delete', () => api.deferredRevenue.deleteDraft(month))}
                disabled={!!busy}
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm text-slate-500 hover:text-red-600 disabled:opacity-50"
              >
                <Trash2 size={14} /> Supprimer
              </button>
            )}
          {!pushed && (
            <div className="flex items-center gap-2">
              <button
                onClick={() => run('save', () => api.deferredRevenue.saveDraft(month, { lines, memo }), () => 'Brouillon enregistré')}
                disabled={!!busy}
                className="px-3 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50"
              >
                Enregistrer
              </button>
              <button
                onClick={() => run('publish', async () => {
                  await api.deferredRevenue.saveDraft(month, { lines, memo })
                  return api.deferredRevenue.publish(month)
                }, out => `Comptabilisé (JE #${out.qb_je_id})`)}
                disabled={!!busy || !total}
                data-testid="publish-deferred-revenue"
                className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50"
              >
                <Send size={14} /> {busy === 'publish' ? 'Envoi…' : `Comptabiliser — ${fmtMoney(total, 'CAD')}`}
              </button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  )
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function RevenusReportes() {
  const [month, setMonth] = useState(currentMonth)
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [qb, setQb] = useState(null)
  const [aggregated, setAggregated] = useState(false)
  const [proposing, setProposing] = useState(false)
  const [showDraft, setShowDraft] = useState(false)
  const { addToast } = useToast()

  const load = useCallback(async () => {
    setError(null)
    try {
      setData(await api.deferredRevenue.month(month))
    } catch (e) {
      setError(e.message || 'Chargement impossible')
    }
  }, [month])

  useEffect(() => { setData(null); setQb(null); load() }, [load])

  // Le bilan QuickBooks est lent : chargé après coup, sans retarder le tableau.
  useEffect(() => {
    let alive = true
    api.deferredRevenue.qb(month)
      .then(r => { if (alive) setQb(r) })
      .catch(e => { if (alive) setQb({ error: e.message }) })
    return () => { alive = false }
  }, [month])

  const rows = useMemo(() => (data?.rows || []).map(r => ({
    ...r,
    periode: periodLabel(r.period_start, r.period_end),
    etat: r.recognized ? 'Constaté' : (r.to_recognize_cad > 0 ? 'À constater' : 'Reporté'),
  })), [data])

  async function propose() {
    setProposing(true)
    try {
      await api.deferredRevenue.propose(month, aggregated)
      await load()
      setShowDraft(true)
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setProposing(false)
    }
  }

  const totals = data?.totals
  const draft = data?.draft

  return (
    <ListPage
      title="Revenus perçus d'avance"
      icon={CalendarClock}
      titleExtra={(
        <div className="flex items-center gap-1">
          <button onClick={() => setMonth(m => shift(m, -1))} className="p-1 text-slate-400 hover:text-slate-600"><ChevronLeft size={18} /></button>
          <span className="text-sm font-semibold text-slate-800 w-32 text-center" data-testid="month-label">{monthLabel(month)}</span>
          <button onClick={() => setMonth(m => shift(m, 1))} className="p-1 text-slate-400 hover:text-slate-600"><ChevronRight size={18} /></button>
        </div>
      )}
      actions={(
        <>
          <label className="flex items-center gap-1.5 text-xs text-slate-500">
            <input type="checkbox" checked={aggregated} onChange={e => setAggregated(e.target.checked)} className="rounded border-slate-300" />
            Agrégée
          </label>
          {draft && (
            <button onClick={() => setShowDraft(true)} data-testid="open-draft"
              className="px-3 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50">
              Écriture {draft.pushed_at ? '✓' : `(${draft.lines.length})`}
            </button>
          )}
          <button onClick={propose} disabled={proposing || !totals?.pending_count} data-testid="propose-entry"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50">
            <RotateCw size={14} className={proposing ? 'animate-spin' : ''} /> Proposer l'écriture
          </button>
        </>
      )}
      banner={(
        <>
          {error && (
            <div className="flex items-center gap-2 mb-3 px-3 py-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle size={15} /> {error}
            </div>
          )}
          {!!data?.warnings?.length && (
            <div className="mb-3 px-3 py-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg space-y-0.5">
              {data.warnings.map((w, i) => <div key={i}>{w}</div>)}
            </div>
          )}
        </>
      )}
    >
      <DataTable
        table="revenus_reportes"
        manageViews
        columns={COLUMNS}
        data={rows}
        loading={!data && !error}
        searchFields={['company_name', 'document_number', 'source']}
        height="calc(100vh - 330px)"
        emptyState={{ icon: CalendarClock, title: 'Rien de reporté', description: 'Aucune période de service ne déborde ce mois-ci.' }}
      />

      {/* Pied : ce qu'on vient chercher ici — le montant à constater, le report
          qui reste, et l'écart avec le compte de report dans QuickBooks. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg">
        <span className="text-slate-500">À constater <b className="tabular-nums text-slate-900" data-testid="total-to-recognize">{money(totals?.to_recognize)}</b></span>
        <span className="text-slate-500">Report fin de mois <b className="tabular-nums text-slate-900" data-testid="total-remaining">{money(totals?.remaining)}</b></span>
        <span className="text-slate-400 text-xs">
          QB #{data?.deferral_acctnum || '23900'}{' '}
          {qb?.error
            ? <span className="text-amber-600">{qb.error}</span>
            : qb
              ? <>
                {money(qb.qb_balance)}
                {qb.ecart ? <b className="text-amber-600" data-testid="qb-ecart"> · écart {money(qb.ecart)}</b> : <span className="text-emerald-600"> · aligné</span>}
              </>
              : '…'}
        </span>
      </div>

      {showDraft && draft && (
        <DraftModal month={month} draft={draft} onClose={() => setShowDraft(false)} onChanged={load} />
      )}
    </ListPage>
  )
}
