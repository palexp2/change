import { useState, useEffect, useCallback, useRef } from 'react'
import { X, ArrowUp } from 'lucide-react'
import api from '../lib/api.js'
import { invalidate } from '../lib/prefetch.js'
import { subscribe } from '../lib/realtime.js'
import { fmtMoney } from '../utils/formatters.js'
import { fmtDate } from '../lib/formatDate.js'

// Bulle « Claude » du rapprochement (Charles, 2026-10-13, maquette B2 « projecteur »).
// Les anomalies du compte arrivent comme des messages ; la bulle ouverte éclaire
// la ligne concernée (onFocus) et estompe les autres. « Voir » ouvre la ligne.
export default function ClaudeBubble({ accountId, currency, onFocus, onShow, onChanged }) {
  const [open, setOpen] = useState(false)
  const [data, setData] = useState({ open: 0, messages: [] })
  const [typing, setTyping] = useState(false)
  const [hover, setHover] = useState(null)
  const [draft, setDraft] = useState('')
  const [fixes, setFixes] = useState({ fixes: [], manual: [] })
  const feed = useRef(null)

  const load = useCallback(() => {
    if (!accountId) return
    invalidate(`/bank/accounts/${accountId}/claude`)
    api.bank.claude(accountId).then(setData).catch(() => {})
    api.bank.claudeFixes(accountId).then(setFixes).catch(() => {})
  }, [accountId])

  useEffect(() => { setData({ open: 0, messages: [] }); setFixes({ fixes: [], manual: [] }); load() }, [load])
  useEffect(() => {
    if (!accountId) return undefined
    return subscribe(`bank_claude:${accountId}`, (msg) => {
      if (msg?.type === 'bank_claude:typing') { setTyping(true); return }
      setTyping(false)
      load()
    })
  }, [accountId, load])

  useEffect(() => { if (open) load() }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  const openItems = data.messages.filter((m) => m.role === 'claude' && m.finding_key && !m.resolved_at)
  // La ligne éclairée : celle survolée, sinon la plus récente anomalie ouverte.
  const focusId = open ? (hover || openItems[openItems.length - 1]?.txn_id || fixes.fixes[0]?.txn_id || null) : null
  useEffect(() => { onFocus?.(focusId) }, [focusId]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onFocus?.(null), []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (feed.current) feed.current.scrollTop = feed.current.scrollHeight }, [data.messages.length, fixes.fixes.length, open, typing])

  const send = (e) => {
    e.preventDefault()
    const text = draft.trim()
    if (!text) return
    setDraft('')
    setTyping(true)
    api.bank.claudeSay(accountId, text, focusId).then(load).catch(() => setTyping(false))
  }

  if (!accountId) return null
  return (
    <>
      {open && (
        <div className="claude-pop fixed right-5 bottom-[84px] z-[9990] w-[360px] max-w-[calc(100vw-2.5rem)] h-[440px] max-h-[70vh] flex flex-col rounded-xl border border-slate-300 bg-white shadow-2xl overflow-hidden" data-testid="claude-pop">
          <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-slate-200 font-semibold">
            <span className="claude-av">C</span>Claude
            <button type="button" className="ml-auto text-slate-400 hover:text-slate-700" onClick={() => setOpen(false)} aria-label="Fermer"><X size={16} /></button>
          </div>
          <div ref={feed} className="flex-1 overflow-y-auto p-3 flex flex-col gap-2.5 bg-slate-50">
            {data.messages.map((m) => <Msg key={m.id} m={m} currency={currency}
              onEnter={() => m.txn_id && !m.resolved_at && setHover(m.txn_id)} onLeave={() => setHover(null)}
              onShow={() => m.txn_id && onShow?.(m.txn_id)}
              onDismiss={() => api.bank.claudeDismiss(m.id).then(load)} />)}
            {(fixes.fixes.length > 0 || fixes.manual.length > 0) && (
              <FixList key={fixes.fixes.map((f) => f.txn_id).join()} fixes={fixes} currency={currency}
                gap={openItems.find((m) => m.kind === 'ecart_compte')?.card?.amount ?? null}
                onHover={setHover} onShow={onShow}
                onDone={() => { invalidate('/bank'); load(); onChanged?.() }} />
            )}
            {typing && <div className="flex gap-2 items-center text-xs text-slate-400"><span className="claude-av">C</span>…</div>}
          </div>
          <form onSubmit={send} className="flex gap-2 p-2.5 border-t border-slate-200">
            <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Répondre à Claude"
              className="flex-1 min-w-0 h-9 rounded-full border border-slate-300 px-3.5 text-sm bg-white" data-testid="claude-input" />
            <button className="w-9 h-9 rounded-full bg-green-600 text-white flex items-center justify-center disabled:opacity-40" disabled={!draft.trim()} aria-label="Envoyer"><ArrowUp size={16} /></button>
          </form>
        </div>
      )}
      <button type="button" onClick={() => setOpen((o) => !o)} data-testid="claude-fab"
        className="claude-fab fixed bottom-5 right-[76px] z-[9989] w-11 h-11 rounded-full text-white font-bold text-lg shadow-lg flex items-center justify-center"
        title="Claude">
        C
        {data.open + fixes.fixes.length > 0 && <span className="absolute -top-1 -right-1 min-w-[20px] h-5 px-1 rounded-full bg-red-600 text-white text-[11px] font-bold flex items-center justify-center border-2 border-white">{data.open + fixes.fixes.length}</span>}
      </button>
    </>
  )
}

function Msg({ m, currency, onEnter, onLeave, onShow, onDismiss }) {
  if (m.role === 'sys') {
    return <div className="text-[11.5px] text-slate-500 flex gap-1.5"><span className="text-green-600 font-bold">✓</span>{m.body}</div>
  }
  if (m.role === 'user') {
    return <div className="self-end max-w-[85%] rounded-xl rounded-tr-sm bg-sky-600 text-white px-3 py-2 text-sm whitespace-pre-wrap">{m.body}</div>
  }
  const live = m.finding_key && !m.resolved_at
  const c = m.card
  return (
    <div className="flex gap-2 items-start" onMouseEnter={onEnter} onMouseLeave={onLeave}>
      <span className="claude-av">C</span>
      <div className={`min-w-0 flex-1 rounded-xl rounded-tl-sm border bg-white px-3 py-2 text-sm ${live ? 'claude-warn' : 'border-slate-200'}${m.resolved_at && m.finding_key ? ' opacity-60' : ''}`}>
        {c?.date && (
          <button type="button" onClick={onShow} className="claude-card w-full text-left grid grid-cols-[auto_1fr_auto] gap-x-2.5 items-center rounded-lg border border-slate-300 bg-slate-50 px-2.5 py-1.5 mb-2">
            <span className="text-slate-600">{fmtDate(c.date)}</span>
            <b className="truncate">{c.label}</b>
            <b className="tabular-nums">{fmtMoney(c.amount, currency)}</b>
            <span />
            <span className="text-[11.5px] text-slate-500 truncate">{c.title}</span>
            <span className="text-[11.5px] text-slate-500">{c.qb || ''}</span>
          </button>
        )}
        <div className="whitespace-pre-wrap">{m.body}</div>
        {live && (
          <div className="flex gap-1.5 mt-2">
            <button type="button" onClick={onShow} className="h-6 px-2.5 rounded-full bg-green-600 text-white text-xs font-semibold">Voir</button>
            <button type="button" onClick={onDismiss} className="h-6 px-2.5 rounded-full border border-slate-300 text-xs font-semibold">Ignorer</button>
          </div>
        )}
      </div>
    </div>
  )
}

// Corrections prêtes (maquette K3) : cochées par défaut sauf celles qui
// méritent un regard ; « Tout faire » les passe une à une par les routes
// habituelles et l'écart avant → après se recalcule à chaque coche.
async function runFix(f) {
  if (f.how === 'proposal') return api.bank.acceptProposal(f.proposal_id)
  if (f.how === 'publish_matched') return api.bank.publishMatched(f.txn_id)
  if (f.how === 'transfer') return api.bank.transfer(f.txn_id, { counterpart_txn_id: f.counterpart_txn_id })
  if (f.how === 'exclude') return api.bank.updateTransaction(f.txn_id, { status: 'ignore' })
  return null
}

function FixList({ fixes, currency, gap, onHover, onShow, onDone }) {
  const [checked, setChecked] = useState(() => new Set(fixes.fixes.filter((f) => !f.warn).map((f) => f.txn_id)))
  const [busy, setBusy] = useState(false)
  const [errors, setErrors] = useState({})
  const picked = fixes.fixes.filter((f) => checked.has(f.txn_id))
  const after = gap == null ? null : gap - picked.filter((f) => f.moves).reduce((s, f) => s + Number(f.amount || 0), 0)
  const closes = after != null && Math.abs(after) < 0.005
  const doAll = async () => {
    setBusy(true)
    const errs = {}
    for (const f of picked) {
      try { await runFix(f) } catch (e) { errs[f.txn_id] = e?.message || 'Échec' }
    }
    setErrors(errs)
    setBusy(false)
    onDone()
  }
  const toggle = (id) => setChecked((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n })
  return (
    <div className="flex gap-2 items-start" data-testid="claude-fixes">
      <span className="claude-av">C</span>
      <div className="min-w-0 flex-1 rounded-xl rounded-tl-sm border bg-white px-3 py-2 text-sm claude-warn">
        {fixes.fixes.length > 0 && <>
          <div>{fixes.fixes.length} correction{fixes.fixes.length > 1 ? 's' : ''} {closes ? (fixes.fixes.length > 1 ? "ferment l'écart" : "ferme l'écart") : 'prête' + (fixes.fixes.length > 1 ? 's' : '')} :</div>
          <div className="mt-2 rounded-lg border border-slate-300 overflow-hidden">
            {fixes.fixes.map((f) => (
              <label key={f.txn_id} className="grid grid-cols-[18px_1fr] gap-2 items-start px-2.5 py-1.5 border-t first:border-t-0 border-slate-200 cursor-pointer hover:bg-slate-50"
                onMouseEnter={() => onHover(f.txn_id)} onMouseLeave={() => onHover(null)}>
                <input type="checkbox" className="mt-1 accent-green-600" checked={checked.has(f.txn_id)} onChange={() => toggle(f.txn_id)} disabled={busy} />
                <span className="min-w-0">
                  <b className="truncate">{f.label}</b> <span className="tabular-nums">{fmtMoney(f.amount, currency)}</span>
                  <span className={`block text-[11.5px] ${f.warn ? 'text-amber-600' : 'text-slate-500'}`}>→ {f.text}</span>
                  {errors[f.txn_id] && <span className="block text-[11.5px] text-red-600">{errors[f.txn_id]}</span>}
                </span>
              </label>
            ))}
          </div>
          {gap != null && (
            <div className="flex items-center gap-2 mt-2 text-[12.5px]">
              Écart <s className="text-slate-400 tabular-nums">{fmtMoney(gap, currency)}</s> → <b className={`tabular-nums ${closes ? 'text-green-700' : ''}`}>{fmtMoney(after, currency)}</b>
            </div>
          )}
          <button type="button" disabled={busy || !picked.length} onClick={doAll} data-testid="claude-fix-all"
            className="mt-2 h-7 px-3 rounded-full bg-green-600 text-white text-xs font-semibold disabled:opacity-40">
            {busy ? '…' : `Tout faire (${picked.length})`}
          </button>
        </>}
        {fixes.manual.length > 0 && (
          <div className={fixes.fixes.length ? 'mt-3' : ''}>
            <div className="text-[11.5px] text-slate-500 mb-1">À faire à la main :</div>
            {fixes.manual.map((m) => (
              <button key={m.txn_id} type="button" onClick={() => onShow?.(m.txn_id)}
                onMouseEnter={() => onHover(m.txn_id)} onMouseLeave={() => onHover(null)}
                className="w-full flex justify-between gap-2 text-left text-[12.5px] py-0.5 hover:text-sky-700">
                <span className="truncate">{m.label}</span><span className="tabular-nums">{fmtMoney(m.amount, currency)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
