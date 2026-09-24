// Revenus perçus d'avance — le compte 23900, prouvé.
//
// Le compte porte l'argent encaissé pour des commandes pas encore expédiées :
// l'encaissement le crédite, l'expédition le libère. La page répond à une
// seule question : est-ce que tout ce qui est entré en est ressorti une fois,
// et une seule ? Ce qui reste à constater d'un côté, ce qui cloche de l'autre —
// avec, pour chaque anomalie, l'écriture de correction toute prête. Rien ne
// part dans QuickBooks sans un clic.
import { useState, useEffect, useCallback, useMemo } from 'react'
import { Link } from 'react-router-dom'
import { CalendarClock, AlertTriangle, RotateCw, Send, CheckCircle2, Layers } from 'lucide-react'
import api from '../lib/api.js'
import { ListPage } from '../components/ListPage.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { Modal } from '../components/Modal.jsx'
import Spinner from '../components/Spinner.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'
import { fmtMoney } from '../utils/formatters.js'
import { useToast } from '../contexts/ToastContext.jsx'

// La vue « Tous » mémorise ses colonnes par navigateur et prime sur les
// colonnes par défaut : la page ayant changé de contenu, on efface la mémoire
// une fois, sinon l'ancienne grille survit.
function resetMemorizedColumns() {
  try {
    const flag = 'erp_revenusReportes_compte23900'
    if (localStorage.getItem(flag)) return
    localStorage.setItem(flag, '1')
    localStorage.removeItem('erp_allView_cols_revenus_reportes')
  } catch { /* stockage indisponible */ }
}
resetMemorizedColumns()

const money = v => (v == null ? '—' : fmtMoney(v, 'CAD'))

const ETAT_STYLE = {
  'À constater': 'text-slate-600',
  Anomalie: 'text-red-600',
  Réglé: 'text-emerald-600',
}

const RENDERS = {
  company_name: row => (
    <span className="inline-flex items-center gap-1.5">
      {row.company_id
        ? <Link to={`/companies/${row.company_id}`} onClick={e => e.stopPropagation()} className="link-record">{row.company_name}</Link>
        : <span className="text-slate-700">{row.company_name}</span>}
      {row.multi_versements && (
        <span title={`${row.versements} versements`} className="text-slate-400"><Layers size={12} /></span>
      )}
    </span>
  ),
  document_number: row => (row.facture_id
    ? <Link to={`/factures/${row.facture_id}`} onClick={e => e.stopPropagation()} className="link-record">{row.document_number}</Link>
    : <span className="text-slate-400">—</span>),
  last_date: row => <span className="text-slate-500">{row.last_date ? fmtDate(row.last_date) : '—'}</span>,
  first_date: row => <span className="text-slate-500">{row.first_date ? fmtDate(row.first_date) : '—'}</span>,
  encaisse: row => <span className="tabular-nums text-slate-600">{money(row.encaisse)}</span>,
  libere: row => <span className="tabular-nums text-slate-600">{money(row.libere)}</span>,
  solde: row => <span className={`tabular-nums font-medium ${row.solde < 0 ? 'text-red-600' : 'text-slate-800'}`}>{money(row.solde)}</span>,
  etat: row => (
    <span className={`inline-flex items-center gap-1 text-xs ${ETAT_STYLE[row.etat] || 'text-slate-500'}`}>
      {row.etat === 'Réglé' && <CheckCircle2 size={12} />}
      {row.anomalies?.length ? row.anomalies[0].label : row.etat}
    </span>
  ),
}

const COLUMNS = TABLE_COLUMN_META.revenus_reportes.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

// ── L'écriture qui solde un dossier ─────────────────────────────────────────

function CorrectionModal({ group, onClose, onDone }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const { addToast } = useToast()

  useEffect(() => {
    let alive = true
    api.deferredRevenue.correction(group.key)
      .then(r => { if (alive) setData(r.correction) })
      .catch(e => { if (alive) setError(e.message) })
    return () => { alive = false }
  }, [group.key])

  async function send() {
    setBusy(true)
    try {
      const out = await api.deferredRevenue.publishCorrection({
        key: group.key, lines: data.lines, memo: data.memo, txn_date: data.txn_date,
      })
      addToast({ message: `Envoyé (JE #${out.qb_je_id})`, type: 'success' })
      await onDone()
      onClose()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal isOpen onClose={onClose} title={group.company_name} size="lg">
      {error && <div className="px-3 py-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg">{error}</div>}
      {!data && !error && <div className="py-8 flex justify-center"><Spinner /></div>}
      {data && (
        <div className="space-y-3">
          <input
            id="correction-memo" value={data.memo}
            onChange={e => setData(d => ({ ...d, memo: e.target.value }))}
            className="w-full px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg"
          />
          <table className="w-full text-sm border border-slate-100 rounded-lg overflow-hidden">
            <tbody>
              {data.lines.map((l, i) => (
                <tr key={i} className="border-b border-slate-50 last:border-0">
                  <td className="py-2 px-3">
                    <span className="text-slate-400 mr-2">{l.posting === 'Debit' ? 'Dr' : 'Cr'} #{l.acctnum}</span>
                    <span className="text-slate-700">{l.label}</span>
                  </td>
                  <td className="py-2 px-3 text-right tabular-nums font-medium">{money(l.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="flex justify-end">
            <button
              onClick={send} disabled={busy} data-testid="send-correction"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 rounded-lg hover:bg-brand-700 disabled:opacity-50"
            >
              <Send size={14} /> {busy ? 'Envoi…' : `Envoyer — ${money(data.amount)}`}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

// ── Page ────────────────────────────────────────────────────────────────────

export default function RevenusReportes() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState(null)

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

  // Les dossiers soldés n'ont plus rien à dire : ils sortent de l'écran — sauf
  // celui qui porte un signalement, sinon le compte des anomalies annonce des
  // lignes introuvables.
  const rows = useMemo(
    () => (data?.groups || []).filter(g => g.etat !== 'Réglé' || g.anomalies?.length),
    [data],
  )
  const totals = data?.totals

  return (
    <ListPage
      title="Revenus perçus d'avance"
      icon={CalendarClock}
      titleExtra={<span className="text-xs text-slate-400">compte {data?.acctnum || '23900'}</span>}
      actions={(
        <button
          onClick={load} disabled={loading} data-testid="reload-state"
          className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 disabled:opacity-50"
        >
          <RotateCw size={14} className={loading ? 'animate-spin' : ''} /> Relire QuickBooks
        </button>
      )}
      banner={(
        <>
          {error && (
            <div className="flex items-center gap-2 mb-3 px-3 py-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-lg">
              <AlertTriangle size={15} /> {error}
            </div>
          )}
          {!!totals?.anomalies_count && (
            <div className="mb-3 px-3 py-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg">
              {totals.anomalies_count} dossier{totals.anomalies_count > 1 ? 's' : ''} à corriger — clique la ligne.
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
        loading={loading && !data}
        searchFields={['company_name', 'document_number']}
        onRowClick={row => (row.anomalies?.some(a => a.fix) ? setSelected(row) : null)}
        height="calc(100vh - 330px)"
        emptyState={{ icon: CheckCircle2, title: 'Tout est soldé', description: 'Aucun dépôt ouvert, aucune anomalie.' }}
      />

      {/* Le pied dit si la page et QuickBooks racontent la même chose. */}
      <div className="mt-3 flex flex-wrap items-center gap-x-6 gap-y-1 px-3 py-2 text-sm bg-slate-50 border border-slate-200 rounded-lg">
        <span className="text-slate-500">À constater <b className="tabular-nums text-slate-900" data-testid="total-a-constater">{money(totals?.a_constater)}</b></span>
        {!!totals?.anomalies && <span className="text-slate-500">Anomalies <b className="tabular-nums text-red-600">{money(totals.anomalies)}</b></span>}
        <span className="text-slate-500">Solde <b className="tabular-nums text-slate-900" data-testid="total-solde">{money(totals?.solde)}</b></span>
        <span className="text-slate-400 text-xs">
          QB #{data?.acctnum || '23900'} {money(data?.qb_balance)}
          {data?.ecart ? <b className="text-amber-600" data-testid="qb-ecart"> · écart {money(data.ecart)}</b> : <span className="text-emerald-600"> · aligné</span>}
        </span>
      </div>

      {selected && (
        <CorrectionModal group={selected} onClose={() => setSelected(null)} onDone={load} />
      )}
    </ListPage>
  )
}
