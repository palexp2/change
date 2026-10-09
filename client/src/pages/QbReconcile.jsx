import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Check, Pause, Clock, ExternalLink, RefreshCw, Combine, Split, Unlink, Loader2 } from 'lucide-react'
import { Layout } from '../components/Layout.jsx'
import { api } from '../lib/api.js'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'

// Rapprochement d'un compte, mois par mois (Charles, 2026-10-06) : barre des
// comptes rétractable à gauche (les mois sous le compte ouvert), puis le relevé
// face à QuickBooks, ligne contre ligne. Les lignes faites sont fines et
// grises ; celles qui restent à régler ressortent avec leur geste au milieu.
// On y arrive en cliquant l'écart de la page Transactions.

const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.']
const MONTHS_LONG = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
const monthShort = (ym) => MONTHS[Number(ym.slice(5, 7)) - 1]
const monthLong = (ym) => `${MONTHS_LONG[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`
const day = (d) => (d ? `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}` : '')
const money = (v, cur) => (v == null ? '—' : `${v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} $${cur && cur !== 'CAD' ? ` ${cur}` : ''}`)
const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase()

function MonthMark({ m }) {
  if (m.closed) return <Check size={13} className="text-green-700" />
  if (m.todo) return <span className="text-red-600 tabular-nums">{m.todo}</span>
  if (m.open) return <span className="text-slate-300">…</span>
  return <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
}

// Barre de gauche : 44 px au repos, s'ouvre au survol par-dessus la page.
// Survoler ou cliquer un compte déplie ses mois sans l'ouvrir ; c'est le clic
// sur un mois qui affiche la feuille (Charles, 2026-10-06).
function AccountRail({ accounts, accountId, sheet, ready, onMonth }) {
  const [openAcc, setOpenAcc] = useState(accountId)
  const [monthsOf, setMonthsOf] = useState({})
  useEffect(() => { setOpenAcc(accountId) }, [accountId])
  const unfold = (id) => {
    setOpenAcc(id)
    if (id === accountId || monthsOf[id]) return
    const cached = sheetCache.get(cacheKey(id, ''))
    if (cached) { setMonthsOf((m) => ({ ...m, [id]: cached.months })); return }
    api.bank.reconcileSheet(id).then((s) => {
      remember(id, '', s)
      setMonthsOf((m) => ({ ...m, [id]: s.months }))
    }).catch(() => setMonthsOf((m) => ({ ...m, [id]: [] })))
  }
  const listFor = (id) => (id === accountId && sheet?.account?.id === id ? sheet.months : monthsOf[id])
  return (
    <div className="relative w-11 shrink-0 z-20">
      <nav data-testid="reconcile-rail" onMouseLeave={() => setOpenAcc(accountId)}
        className="group absolute inset-y-0 left-0 w-11 hover:w-60 transition-[width] duration-150 overflow-hidden bg-slate-50 border-r border-slate-200 hover:shadow-xl">
        <div className="w-60 py-2">
          {accounts.map((a) => {
            const on = a.id === accountId
            const unfolded = a.id === openAcc
            const list = unfolded ? listFor(a.id) : null
            return (
              <div key={a.id}>
                <button type="button" onClick={() => unfold(a.id)} onMouseEnter={() => unfold(a.id)} title={a.name}
                  className={`flex items-center gap-3 w-full h-9 pl-2.5 pr-4 text-left text-sm ${on ? 'bg-white font-semibold text-slate-900 shadow-[inset_3px_0_0_#2ca01c]' : unfolded ? 'bg-white text-slate-800' : 'text-slate-600 hover:bg-white'}`}>
                  <span className={`w-6 h-6 shrink-0 rounded-md flex items-center justify-center text-[10px] font-bold ${on ? 'bg-slate-900 text-white' : 'bg-slate-200 text-slate-600'}`}>{initials(a.name)}</span>
                  <span className="truncate opacity-0 group-hover:opacity-100">{a.name}</span>
                  {ready.has(a.id) && <span className="ml-auto w-2 h-2 rounded-full bg-amber-500 shrink-0" />}
                </button>
                {unfolded && (
                  <div className="hidden group-hover:block pl-11 pr-4 pb-2">
                    {!list && <RefreshCw size={12} className="animate-spin text-slate-400 my-1" />}
                    {list && [...list].reverse().map((m) => (
                      <button key={m.month} type="button" onClick={() => onMonth(a.id, m.month)}
                        className={`flex items-center w-full py-1 text-[12.5px] ${on && m.month === sheet?.month ? 'text-slate-900 font-semibold' : 'text-slate-500 hover:text-slate-800'}`}>
                        {monthShort(m.month)} {m.month.slice(0, 4)}
                        <span className="ml-auto flex items-center"><MonthMark m={m} /></span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </nav>
    </div>
  )
}

const GRID = 'grid grid-cols-[64px_minmax(0,1fr)_112px_132px_64px_minmax(0,1fr)_112px] items-center'

// Pastilles des cas bizarres (S3) : une couleur par groupe.
const GROUP_TONES = ['bg-violet-700', 'bg-cyan-700', 'bg-rose-700', 'bg-teal-700', 'bg-orange-700']
const GROUP_BGS = ['bg-violet-100', 'bg-cyan-100', 'bg-rose-100', 'bg-teal-100', 'bg-orange-100']
const GROUP_TINTS = [
  'bg-violet-200 ring-2 ring-inset ring-violet-600', 'bg-cyan-200 ring-2 ring-inset ring-cyan-600',
  'bg-rose-200 ring-2 ring-inset ring-rose-600', 'bg-teal-200 ring-2 ring-inset ring-teal-600',
  'bg-orange-200 ring-2 ring-inset ring-orange-600',
]
const toneOf = (id, list = GROUP_TONES) => list[(id.charCodeAt(0) - 65) % list.length]
function GroupTag({ id }) {
  return <span className={`${toneOf(id)} text-white text-[10px] font-bold w-4 h-4 rounded-full inline-flex items-center justify-center mr-1.5 align-[-2px] shrink-0`}>{id}</span>
}
function groupText(g, cur) {
  if (g.kind === 'retour') return 'Aller-retour = 0'
  if (g.kind === 'rembourse') return 'Remboursement sans écriture'
  const head = `${g.count} → 1`
  return Math.abs(g.gap) < 0.005 ? `${head} ✓` : <>{head} · <span className="text-red-600">écart {money(Math.abs(g.gap), cur)}</span></>
}

function Side({ part, cur, dateCls = 'text-slate-500', empty, group, onRegroup }) {
  if (!part) return <><span /><span className="px-2.5 italic text-slate-400">{empty}</span><span /></>
  return (
    <>
      <span className={`px-2.5 ${dateCls}`}>{day(part.date)}</span>
      <span className="px-2.5 truncate" title={part.label}>
        {group && <GroupTag id={group} />}
        {part.url ? <a href={part.url} target="_blank" rel="noreferrer" className="hover:underline">{part.label || '—'}</a> : part.label || '—'}
        {part.other_account && <span className="ml-1.5 text-[11px] text-slate-400">{part.other_account}</span>}
        {onRegroup && (part.group_count || part.group_parent_id) && (
          <button type="button" onClick={() => onRegroup(part)} title={part.group_count ? `Dégrouper (${part.group_count})` : 'Regrouper'}
            className="ml-1.5 text-slate-400 hover:text-slate-700 align-[-2px]">
            {part.group_count ? <Split size={12} /> : <Combine size={12} />}
          </button>
        )}
      </span>
      <span className="px-2.5 text-right tabular-nums whitespace-nowrap">{money(part.amount, cur)}</span>
    </>
  )
}

// Ligne rapprochée : survolée, la coche devient « Annuler la correspondance »
// dans le flux bancaire QuickBooks (Charles, 2026-10-06) — le robot fait le
// geste, l'écriture QuickBooks reste.
function UndoMatch({ r, onUndo }) {
  const [busy, setBusy] = useState(false)
  if (busy) return <Loader2 size={13} className="animate-spin text-slate-400" />
  return (
    <span className="group/undo relative w-[18px] h-[18px]">
      <span className="absolute inset-0 rounded-full bg-green-100 text-green-700 flex items-center justify-center group-hover/undo:hidden"><Check size={11} strokeWidth={3} /></span>
      <button type="button" title="Annuler la correspondance dans QuickBooks" data-testid="qb-feed-undo"
        onClick={async () => { setBusy(true); try { await onUndo(r) } finally { setBusy(false) } }}
        className="absolute inset-0 rounded-full bg-white border border-slate-300 text-slate-600 hover:text-red-600 hidden group-hover/undo:flex items-center justify-center"><Unlink size={10} /></button>
    </span>
  )
}

function FaceRow({ r, cur, accountId, lit, onGroup, onRegroup, onUndo }) {
  const done = r.kind === 'ok'
  const tint = r.kind === 'bank' ? 'bg-sky-50' : r.kind === 'qb' ? 'bg-amber-50' : ''
  const size = done ? 'min-h-[30px] text-[12px] text-slate-500' : 'min-h-[42px] text-[13px] text-slate-800'
  let mid
  if (done && r.bank && r.qb) mid = <UndoMatch r={r} onUndo={onUndo} />
  else if (done) mid = <span className="w-[18px] h-[18px] rounded-full bg-green-100 text-green-700 flex items-center justify-center"><Check size={11} strokeWidth={3} /></span>
  else if (r.kind === 'bank') mid = (
    <Link to={`/rapprochement?compte=${accountId}&ligne=${r.bank.id}`}
      className="qbo-go h-[26px] px-3 rounded-full text-xs font-medium inline-flex items-center">Comptabiliser</Link>
  )
  else if (r.kind === 'qb') mid = r.qb.url
    ? <a href={r.qb.url} target="_blank" rel="noreferrer" className="h-[26px] px-3 rounded-full text-xs font-medium inline-flex items-center gap-1 border border-slate-300 bg-white hover:bg-slate-50">Ouvrir <ExternalLink size={11} /></a>
    : null
  else if (r.kind === 'wait') mid = <Pause size={13} className="text-slate-400" />
  else mid = <Clock size={13} className="text-slate-400" />
  return (
    <div data-testid={`face-row-${r.kind}`}
      onMouseEnter={r.group ? () => onGroup(r.group) : undefined} onMouseLeave={r.group ? () => onGroup(null) : undefined}
      className={`${GRID} ${size} ${lit ? toneOf(r.group, GROUP_TINTS) : r.group ? toneOf(r.group, GROUP_BGS) : tint} border-b border-slate-100 transition-colors`}>
      <Side part={r.bank} cur={cur} empty={r.kind === 'wait' ? 'pas encore passé' : '—'} group={r.bank && r.group} onRegroup={onRegroup} />
      <span className="self-stretch flex items-center justify-center border-x border-slate-100">{mid}</span>
      <Side part={r.qb} cur={cur} dateCls={r.shifted ? 'text-amber-600' : 'text-slate-500'} empty={r.kind === 'fresh' ? 'trop récent' : '—'} group={r.qb && r.group} />
    </div>
  )
}

// Feuilles déjà vues ou préchargées : changer de compte ou de mois s'affiche
// tout de suite, puis se rafraîchit en arrière-plan (Charles, 2026-10-06).
const sheetCache = new Map() // `${compte}|${mois}` → feuille
const cacheKey = (acc, m) => `${acc}|${m || ''}`
function remember(acc, askedMonth, s) {
  sheetCache.set(cacheKey(acc, askedMonth), s)
  sheetCache.set(cacheKey(acc, s.month), s)
}
let prefetching = false
// Après la première feuille : les autres mois du compte, puis le mois par
// défaut des autres comptes — un à la fois pour ne pas charger le serveur.
async function prefetchSheets(accountId, months, accounts) {
  if (prefetching) return
  prefetching = true
  try {
    const jobs = [
      ...(months || []).map((m) => [accountId, m.month]),
      ...accounts.filter((a) => a.id !== accountId).map((a) => [a.id, '']),
    ]
    for (const [acc, m] of jobs) {
      if (sheetCache.has(cacheKey(acc, m))) continue
      try { remember(acc, m, await api.bank.reconcileSheet(acc, m || undefined)) } catch { /* facultatif */ }
    }
  } finally { prefetching = false }
}

export default function QbReconcile() {
  const [params, setParams] = useSearchParams()
  const accountId = params.get('compte') || ''
  const month = params.get('mois') || ''
  const [accounts, setAccounts] = useState([])
  const [ready, setReady] = useState(new Set())
  const [sheet, setSheet] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [robot, setRobot] = useState(null)
  const [reload, setReload] = useState(0)
  const [now, setNow] = useState(Date.now())
  const timer = useRef(null)
  const wasRunning = useRef(false)

  useEffect(() => {
    api.bank.accounts().then((list) => {
      const mapped = (list || []).filter((a) => a.qb_account_id)
      setAccounts(mapped)
      if (!params.get('compte') && mapped[0]) setParams({ compte: mapped[0].id }, { replace: true })
    }).catch((e) => setError(e.message))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api.bank.monthClose().then((r) => setReady(new Set((r?.ready || []).map((x) => x.account_id)))).catch(() => {})
  }, [reload])

  useEffect(() => {
    if (!accountId) return
    let alive = true
    const cached = sheetCache.get(cacheKey(accountId, month))
    if (cached) setSheet(cached)
    else setSheet((prev) => (prev?.account?.id === accountId ? prev : null))
    setLoading(true); setError(null)
    api.bank.reconcileSheet(accountId, month || undefined)
      .then((s) => {
        remember(accountId, month, s)
        if (!alive) return
        setSheet(s)
        prefetchSheets(accountId, s.months, accounts)
      })
      .catch((e) => { if (alive && !cached) { setSheet(null); setError(e.message) } })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [accountId, month, reload]) // eslint-disable-line react-hooks/exhaustive-deps

  // Dégrouper une ligne regroupée, ou refaire le groupe depuis une de ses lignes.
  const toggleGroup = async (part) => {
    try {
      if (part.group_count) await api.bank.ungroupTxn(part.id)
      else await api.bank.regroupTxn(part.id)
      sheetCache.clear()
      setReload((n) => n + 1)
    } catch (e) { setError(e.message) }
  }

  const undoMatch = async (r) => {
    setError(null)
    try {
      await api.bank.qbFeedUndo(r.bank.id)
      sheetCache.clear()
      setReload((n) => n + 1)
    } catch (e) { setError(e.message) }
  }

  const loadRobot = useCallback(async () => {
    if (!accountId) return
    try {
      const s = await api.bank.qbReconcileLast(accountId)
      setRobot(s)
      clearTimeout(timer.current)
      if (s?.running) timer.current = setTimeout(loadRobot, 4000)
      // Fin d'un passage : la feuille relit QuickBooks (mois fermé, coches).
      else if (wasRunning.current) setReload((n) => n + 1)
      wasRunning.current = !!s?.running
    } catch { /* le robot est facultatif */ }
  }, [accountId])
  useEffect(() => { loadRobot(); return () => clearTimeout(timer.current) }, [loadRobot])
  // Passage terminé ailleurs (autre onglet, planificateur) : on relit aussi.
  useRealtimeChannel('bank:reconcile', (msg) => {
    if (msg.payload?.account_id === accountId) loadRobot().then(() => setReload((n) => n + 1))
  })

  useEffect(() => {
    if (!robot?.running) return undefined
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [robot?.running])

  // Un seul bouton : le robot coche, puis clique « Terminer » si la différence
  // est à 0 $ ; sinon il enregistre et on propose d'ouvrir QuickBooks.
  const finish = async () => {
    setError(null)
    try { await api.bank.qbReconcileRun(accountId, { finish: true }); await loadRobot() } catch (e) { setError(e.message) }
  }
  const elapsed = robot?.started_at ? Math.max(0, Math.round((now - Date.parse(robot.started_at)) / 1000)) : 0

  const go = (next) => setParams(next, { replace: true })
  const cur = sheet?.account?.currency
  const rows = sheet?.rows || []
  const [litGroup, setLitGroup] = useState(null)
  const doneCount = rows.filter((r) => r.kind === 'ok').length
  const todoCount = rows.filter((r) => r.kind === 'bank' || r.kind === 'qb').length
  const account = accounts.find((a) => a.id === accountId)

  return (
    <Layout>
      <div className="flex min-h-[calc(100vh-56px)] bg-white">
        <AccountRail accounts={accounts} accountId={accountId} sheet={sheet} ready={ready}
          onMonth={(id, m) => go({ compte: id, mois: m })} />
        <div className="flex-1 min-w-0 flex flex-col">
          <header className="flex items-center gap-4 px-6 py-4 border-b border-slate-200 flex-wrap">
            <Link to={`/rapprochement?compte=${accountId}`} title="Transactions" className="text-slate-400 hover:text-slate-700"><ArrowLeft size={18} /></Link>
            <h1 className="text-lg font-semibold text-slate-900">
              {account?.name || sheet?.account?.name || '—'}
              {sheet && <span className="ml-2 font-normal text-slate-500">{monthLong(sheet.month)}</span>}
            </h1>
            {loading && <RefreshCw size={14} className="animate-spin text-slate-400" />}
          </header>

          {sheet && (
            <div className="flex items-center gap-5 px-6 py-3 border-b border-slate-200 flex-wrap">
              <Figure label={`${sheet.provisional ? "Transactions" : "Relevé"} · ${day(sheet.end)}`} value={money(sheet.bank_balance, cur)} />
              <span className="text-slate-300">−</span>
              <Figure label="QuickBooks" value={sheet.qb_error ? 'indisponible' : money(sheet.qb_balance, cur)} />
              {!!sheet.in_transit && <>
                <span className="text-slate-300">−</span>
                <Figure label="En transit" value={money(sheet.in_transit, cur)} />
              </>}
              <span className="text-slate-300">=</span>
              <div data-testid="reconcile-sheet-difference"
                className={`px-3.5 py-1.5 rounded-lg ${sheet.balanced ? 'bg-green-50 text-green-700' : sheet.difference == null ? 'bg-slate-50 text-slate-400' : 'bg-red-50 text-red-600'}`}>
                <div className="text-[11px] opacity-80">Différence</div>
                <div className="text-lg font-semibold tabular-nums">{money(sheet.difference, cur)}{sheet.balanced ? ' ✓' : ''}</div>
              </div>
              <div className="ml-auto flex items-center gap-2 text-xs text-slate-500">
                <span className="w-28 h-1.5 rounded-full bg-slate-100 overflow-hidden">
                  <i className="block h-full bg-green-600" style={{ width: `${rows.length ? Math.round(100 * doneCount / rows.length) : 0}%` }} />
                </span>
                <span className="tabular-nums">{doneCount} / {rows.length}</span>
                {todoCount > 0 && <span className="text-red-600">· {todoCount} à régler</span>}
              </div>
            </div>
          )}

          {error && <div className="px-6 py-3 text-sm text-red-700">{error}</div>}

          {sheet && (
            <div className="flex-1 overflow-auto">
              <div className="min-w-[860px]">
                <div className={`${GRID} sticky top-0 z-10 bg-slate-50 border-b border-slate-200 text-[11.5px] font-semibold text-slate-500`}>
                  <span className="col-span-3 px-2.5 py-2">Relevé</span>
                  <span />
                  <span className="col-span-3 px-2.5 py-2">QuickBooks</span>
                </div>
                {rows.map((r, i) => <FaceRow key={r.bank?.id || `qb${i}`} r={r} cur={cur} accountId={accountId}
                  lit={!!r.group && r.group === litGroup} onGroup={setLitGroup} onRegroup={toggleGroup} onUndo={undoMatch} />)}
                {!rows.length && <div className="px-6 py-10 text-center text-sm text-slate-400">—</div>}
              </div>
            </div>
          )}

          {sheet && (() => { const monthClosed = !!sheet.months?.find((m) => m.month === sheet.month)?.closed; return (
            <footer className="sticky bottom-0 flex items-center gap-3 px-6 py-3 border-t border-slate-200 bg-white">
              {monthClosed && !robot?.running && <span className="text-sm text-green-700 inline-flex items-center gap-1.5"><Check size={14} /> Rapproché</span>}
              {!monthClosed && !robot?.running && robot?.last?.finished && <span className="text-sm text-green-700">Terminé dans QuickBooks ✓</span>}
              {!monthClosed && !robot?.running && robot?.last && !robot.last.finished && (robot.last.finish_note || !robot.last.ok) && (
                <span className="text-xs text-amber-700 truncate">{robot.last.finish_note || robot.last.error || 'Échec'}</span>
              )}
              {(sheet.groups || []).map((g) => (
                <span key={g.id} onMouseEnter={() => setLitGroup(g.id)} onMouseLeave={() => setLitGroup(null)}
                  className="text-xs text-slate-600 inline-flex items-center rounded-full border border-slate-200 px-2 py-0.5 cursor-default" data-testid="reconcile-group">
                  <GroupTag id={g.id} />{groupText(g, cur)}
                </span>
              ))}
              <span className="flex-1" />
              {!monthClosed && !robot?.running && robot?.last && !robot.last.finished && (robot.last.finish_note || !robot.last.ok) ? (
                <a href="https://qbo.intuit.com/app/reconcile" target="_blank" rel="noreferrer"
                  className="qbo-go h-9 px-4 rounded-full text-sm font-medium inline-flex items-center gap-2">
                  Ouvrir dans QuickBooks <ExternalLink size={13} />
                </a>
              ) : (
                <a href="https://qbo.intuit.com/app/reconcile" target="_blank" rel="noreferrer" title="Ouvrir dans QuickBooks"
                  className="h-9 w-9 rounded-full border border-slate-300 hover:bg-slate-50 inline-flex items-center justify-center text-slate-500">
                  <ExternalLink size={14} />
                </a>
              )}
              {(!monthClosed || robot?.running) && <button type="button" onClick={finish} disabled={robot?.running} data-testid="qbo-finish"
                className="qbo-go h-9 px-4 rounded-full text-sm font-medium inline-flex items-center gap-2 disabled:opacity-70">
                {robot?.running && <RefreshCw size={14} className="animate-spin" />}
                {robot?.running ? `Robot… ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}` : 'Terminer dans QuickBooks'}
              </button>}
            </footer>
          ) })()}
        </div>
      </div>
    </Layout>
  )
}

function Figure({ label, value }) {
  return (
    <div>
      <div className="text-[11px] text-slate-500">{label}</div>
      <div className="text-base font-medium tabular-nums text-slate-800">{value}</div>
    </div>
  )
}
