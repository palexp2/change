import { hasRole } from '../../../shared/roles.mjs'
// Instagram — une seule page.
//
// En haut : un onglet par TYPE de demande — coaching, fleurs, questions,
// commentaires, abonnés — plus les déjà traités, repliés au bout de la rangée.
// À gauche : les gens de l'onglet ouvert. Au centre : la conversation, lue dans
// une colonne, et le message écrit d'avance dans une carte juste en dessous.
//
// Tout ce qui concerne la personne (son type, sa fenêtre de 24 h, « traité »,
// « écarter ») vit dans l'en-tête de cette colonne : pas de barre latérale.
//
// Une personne contactée quitte la liste, et y revient d'elle-même si elle
// réécrit : c'est ce qui évite la liste de 231 fiches où plus rien ne ressort.
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Send, RefreshCw, Search, ExternalLink, Sparkles, PauseCircle, X, Check, Filter, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import Spinner from '../components/Spinner.jsx'
import { Badge } from '../components/Badge.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { useAuth } from '../lib/auth.jsx'

const WINDOW_MS = 24 * 60 * 60 * 1000

const FALLBACK_SEGMENTS = [
  { key: 'coach', label: 'Ont demandé le coaching' },
  { key: 'fleurs', label: 'Font pousser des fleurs' },
  { key: 'question', label: 'Posent une question' },
  { key: 'commentaire', label: 'Ont simplement commenté' },
  { key: 'abonne', label: 'Abonnés qu’on peut aborder' },
]

// Les onglets portent un libellé plus court que la liste déroulante : une
// rangée d'onglets se lit d'un coup d'œil, pas en phrases.
const SHORT = {
  coach: 'Coaching', fleurs: 'Fleurs', question: 'Questions',
  commentaire: 'Commentaires', abonne: 'Abonnés',
}

function ago(iso) {
  if (!iso) return ''
  const diff = Date.now() - new Date(iso).getTime()
  const h = Math.floor(diff / 3_600_000)
  if (h < 1) return `${Math.max(1, Math.floor(diff / 60_000))} min`
  if (h < 24) return `${h} h`
  return `${Math.floor(h / 24)} j`
}

function inFuture(iso) {
  if (!iso) return ''
  const diff = new Date(iso).getTime() - Date.now()
  if (diff <= 0) return 'maintenant'
  const m = Math.round(diff / 60000)
  return m < 60 ? `dans ${m} min` : `dans ${Math.round(m / 60)} h`
}

function stamp(iso) {
  if (!iso) return ''
  return new Date(iso).toLocaleString('fr-CA', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
}

function windowState(lastIncomingAt) {
  if (!lastIncomingAt) return { open: false, label: 'Jamais écrit' }
  const left = WINDOW_MS - (Date.now() - new Date(lastIncomingAt).getTime())
  if (left <= 0) return { open: false, label: 'Fenêtre fermée' }
  const h = Math.floor(left / 3_600_000)
  return { open: true, label: h >= 1 ? `Fenêtre ${h} h` : 'Fenêtre < 1 h' }
}

function Tab({ label, n, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 px-0.5 pb-2 border-b-2 -mb-px transition-colors ${
        active ? 'border-brand-600' : 'border-transparent hover:border-slate-200'}`}
    >
      <span className={`text-sm ${active ? 'font-bold text-slate-900' : 'font-medium text-slate-500'}`}>{label}</span>
      <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${
        active ? 'bg-brand-600 text-white' : 'bg-slate-100 text-slate-500'}`}>{n}</span>
    </button>
  )
}

function Row({ i, active, onPick }) {
  return (
    <button
      onClick={() => onPick(i.prospect_id)}
      className={`w-full text-left px-5 py-3.5 border-b border-slate-100 border-l-[3px] ${
        active ? 'bg-brand-50 border-l-brand-600' : 'border-l-transparent hover:bg-slate-50'}`}
    >
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold text-slate-900 truncate">@{i.ig_username}</span>
        {i.draft_status === 'queued' && <Badge color="green" size="xs">{inFuture(i.scheduled_at)}</Badge>}
        {i.reopened && <Badge color="amber" size="xs">a réécrit</Badge>}
        <span className="ml-auto text-[11px] text-slate-400 shrink-0">{ago(i.last_incoming_at || i.last_message_at)}</span>
      </div>
      {!!i.review_label && <div className="text-[11px] text-amber-700 mt-0.5">{i.review_label}</div>}
      <div className="text-xs text-slate-500 mt-0.5 line-clamp-2">
        {i.profile_who || i.arrival || i.last_message_text || '—'}
      </div>
    </button>
  )
}

export default function Instagram() {
  const { addToast } = useToast()
  const { user } = useAuth()
  const isAdmin = hasRole(user, 'admin')
  const [tab, setTab] = useState(null)
  const [session, setSession] = useState(null)
  const [scraping, setScraping] = useState(false)
  const [sorting, setSorting] = useState(false)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [q, setQ] = useState('')
  const [activeId, setActiveId] = useState(null)
  const [messages, setMessages] = useState([])
  const [thread, setThread] = useState(null)
  const [text, setText] = useState('')
  // La liste se replie pour laisser toute la largeur à la conversation ; repliée,
  // elle se rouvre au survol du bord gauche et se referme dès qu'on s'en éloigne.
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem('ig.list.collapsed') === '1' } catch { return false }
  })
  const [peek, setPeek] = useState(false)
  const peekTimer = useRef(null)
  const bottom = useRef(null)

  const toggleList = () => setCollapsed(v => {
    const next = !v
    try { localStorage.setItem('ig.list.collapsed', next ? '1' : '0') } catch { /* stockage refusé : le pli ne survit pas au rechargement */ }
    if (next) setPeek(false)
    return next
  })
  const openPeek = () => { clearTimeout(peekTimer.current); setPeek(true) }
  const closePeek = () => { clearTimeout(peekTimer.current); peekTimer.current = setTimeout(() => setPeek(false), 180) }
  useEffect(() => () => clearTimeout(peekTimer.current), [])

  const done = tab === 'done'
  const load = useCallback(() => {
    return api.instagram.workbench(done)
      .then(r => { setData(r); setLoading(false); return r })
      .catch(e => { addToast({ message: e.message, type: 'error' }); setLoading(false) })
  }, [addToast, done])
  useEffect(() => { load() }, [load])
  useEffect(() => { api.instagram.session().then(setSession).catch(() => {}) }, [])

  const items = useMemo(() => data?.items || [], [data])
  const segments = useMemo(() => (data?.segments?.length ? data.segments : FALLBACK_SEGMENTS), [data])
  const counts = useMemo(() => data?.counts || {}, [data])

  // Le premier onglet qui a du monde s'ouvre tout seul : personne ne veut
  // atterrir sur une pile vide.
  useEffect(() => {
    if (tab || !data) return
    setTab(segments.find(s => counts[s.key])?.key || segments[0]?.key || 'coach')
  }, [tab, data, segments, counts])

  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return items
      .filter(i => i.group === tab)
      .filter(i => !needle || `${i.ig_username} ${i.full_name || ''}`.toLowerCase().includes(needle))
  }, [items, tab, q])

  const active = useMemo(() => items.find(i => i.prospect_id === activeId) || null, [items, activeId])

  // Le fil se charge à l'ouverture ; le brouillon remplit la boîte d'écriture.
  useEffect(() => {
    if (!active?.manychat_user_id) { setMessages([]); setThread(null); return }
    api.instagram.conversationMessages(active.manychat_user_id)
      .then(r => { setMessages(r.messages || []); setThread(r.thread || null) })
      .catch(e => addToast({ message: e.message, type: 'error' }))
  }, [active?.manychat_user_id, addToast])
  useEffect(() => { setText(active?.draft_text || '') }, [active?.prospect_id, active?.draft_text])
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }) }, [messages])

  const run = async (fn, okMsg) => {
    setBusy(true)
    try {
      const r = await fn()
      if (r?.error) throw new Error(r.error)
      if (okMsg) addToast({ message: typeof okMsg === 'function' ? okMsg(r) : okMsg, type: 'success' })
      await load()
      return r
    } catch (e) { addToast({ message: e.message, type: 'error' }) } finally { setBusy(false) }
  }

  const win = windowState(thread?.last_incoming_at || active?.last_incoming_at)

  const send = async () => {
    if (!active || !text.trim()) return
    setBusy(true)
    try {
      const r = await api.instagram.sendMessage(active.manychat_user_id, text.trim())
      setMessages(r.messages || [])
      setText('')
      addToast({ message: 'Message envoyé', type: 'success' })
      await load()
    } catch (e) { addToast({ message: e.message, type: 'error' }) } finally { setBusy(false) }
  }

  if (loading) return <Layout><div className="p-10"><Spinner label="Chargement…" /></div></Layout>

  const ready = counts.ready || 0

  const listPanel = (
    <div className="h-full flex flex-col border-r border-slate-200 bg-white">
      <label className="flex items-center gap-2 px-5 py-2.5 border-b border-slate-100 text-sm">
        <Search size={14} className="text-slate-400" />
        <input className="flex-1 outline-none bg-transparent" value={q} onChange={e => setQ(e.target.value)} />
        <button onClick={toggleList} title="Replier la liste" className="text-slate-400 hover:text-slate-600">
          <PanelLeftClose size={15} />
        </button>
      </label>
      <div className="flex-1 overflow-y-auto">
        {rows.map(i => <Row key={i.prospect_id} i={i} active={activeId === i.prospect_id} onPick={setActiveId} />)}
        {!rows.length && <div className="px-4 py-14 text-center text-sm text-slate-400">Rien ici.</div>}
      </div>
    </div>
  )

  return (
    <Layout>
      <div className="px-6 pt-4">
        <header className="flex items-center gap-3 flex-wrap">
          <PageTitle>Instagram</PageTitle>
          <span className="text-sm text-slate-400">
            {counts.queued
              ? <>envoi en cours · {counts.queued} restant{counts.queued > 1 ? 's' : ''}{data?.next_at ? ` · prochain ${inFuture(data.next_at)}` : ''}</>
              : <>{counts.todo || 0} à traiter</>}
          </span>
          <div className="ml-auto flex gap-2">
            {isAdmin && (
              <button
                disabled={scraping}
                title="Relire tout de suite les commentaires Instagram"
                onClick={async () => {
                  setScraping(true)
                  try { await api.instagram.scrape(); await load() }
                  catch (e) { addToast({ message: e.message, type: 'error' }) }
                  finally { setScraping(false) }
                }}
                className="btn-secondary btn-sm"
              >
                <RefreshCw size={14} className={scraping ? 'animate-spin' : ''} /> Relire
              </button>
            )}
            {isAdmin && (
              <button
                disabled={sorting}
                title="Ranger par type de demande, écarter les robots et sortir les déjà traités"
                onClick={async () => {
                  setSorting(true)
                  try {
                    const r = await api.instagram.sortSegments()
                    if (r?.error) throw new Error(r.error)
                    addToast({ message: r.summary || 'Trié', type: 'success' })
                    await load()
                  } catch (e) { addToast({ message: e.message, type: 'error' }) }
                  finally { setSorting(false) }
                }}
                className="btn-secondary btn-sm"
              ><Filter size={14} className={sorting ? 'animate-pulse' : ''} /> Trier</button>
            )}
            <button disabled={busy} onClick={() => run(() => api.instagram.writeAllDrafts(), r => r.summary || 'Messages écrits')}
              className="btn-secondary btn-sm"><Sparkles size={14} /> Écrire</button>
            {!!counts.queued && (
              <button disabled={busy} onClick={() => run(() => api.instagram.holdDrafts(), 'Envoi arrêté')}
                className="btn-secondary btn-sm"><PauseCircle size={14} /> Retenir</button>
            )}
            <button disabled={busy || !ready} onClick={() => run(() => api.instagram.sendDraftsNow(), r => `${r.sent || 0} parti(s), le reste suit aux ${data?.spacing_seconds || 90} s`)}
              className="btn-primary btn-sm"><Send size={14} /> Envoyer les {ready}</button>
          </div>
        </header>

        {/* Les piles : un onglet chacune, les déjà traités au bout. */}
        <div className="flex items-end gap-7 mt-3 border-b border-slate-200">
          {segments.map(s => (
            <Tab key={s.key} label={SHORT[s.key] || s.label} n={counts[s.key] || 0}
              active={tab === s.key} onClick={() => { setTab(s.key); setActiveId(null) }} />
          ))}
          <button onClick={() => { setTab(done ? segments[0]?.key : 'done'); setActiveId(null) }}
            className={`ml-auto pb-2 text-xs ${done ? 'font-semibold text-slate-700' : 'text-slate-400 hover:text-slate-600'}`}>
            Déjà traités{done ? ` · ${counts.done || 0}` : ''}
          </button>
        </div>
      </div>

      {session && !session.configured && (
        <div className="mx-6 mt-3 px-4 py-2.5 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg">
          La lecture des commentaires est coupée — rouvrir la session dans Connecteurs → Instagram.
        </div>
      )}

      <div className="relative flex border-t border-slate-200 overflow-hidden" style={{ height: 'calc(100vh - 186px)' }}>

        {/* La liste de l'onglet ouvert, aérée : deux lignes d'aperçu par personne.
            Repliée, elle revient en surimpression au survol du bord gauche. */}
        {!collapsed && <div className="w-[372px] shrink-0">{listPanel}</div>}
        {collapsed && (
          <>
            {/* Repliée, la liste laisse un rail : une pastille par personne, la
                pile en cours en haut. Le survol ramène la liste complète. */}
            <div
              onMouseEnter={openPeek}
              className="w-14 shrink-0 flex flex-col items-center gap-2 py-2.5 border-r border-slate-200 bg-white"
            >
              <button onClick={toggleList} title="Déplier la liste" className="text-slate-400 hover:text-slate-600 p-1">
                <PanelLeftOpen size={16} />
              </button>
              <span className="text-[10px] font-semibold text-slate-400">{rows.length}</span>
              <div className="flex-1 w-full overflow-y-auto flex flex-col items-center gap-1.5 pt-1">
                {rows.map(i => (
                  <button
                    key={i.prospect_id}
                    onClick={() => setActiveId(i.prospect_id)}
                    title={`@${i.ig_username}`}
                    className={`w-8 h-8 shrink-0 rounded-full text-xs font-semibold flex items-center justify-center border-2 ${
                      activeId === i.prospect_id
                        ? 'bg-brand-600 text-white border-brand-600'
                        : 'bg-slate-100 text-slate-500 border-transparent hover:border-slate-300'}`}
                  >{(i.ig_username || '?').slice(0, 1).toUpperCase()}</button>
                ))}
              </div>
            </div>
            <div
              onMouseEnter={openPeek}
              onMouseLeave={closePeek}
              className={`absolute left-0 top-0 bottom-0 w-[372px] z-20 shadow-2xl transition-transform duration-150 ${
                peek ? 'translate-x-0' : '-translate-x-full'}`}
            >{listPanel}</div>
          </>
        )}

        {/* La conversation, lue dans une colonne centrée. */}
        <div className="flex-1 min-w-0 bg-slate-50 flex justify-center overflow-hidden">
          {!active ? (
            <div className="flex items-center text-sm text-slate-400">Choisis quelqu’un à gauche.</div>
          ) : (
            <div className="w-full max-w-[780px] flex flex-col gap-5 px-10 py-6 min-h-0">

              <div className="flex items-center gap-3 shrink-0">
                <div className="w-11 h-11 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center text-base font-semibold shrink-0">
                  {(active.ig_username || '?').slice(0, 1).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <a href={`https://www.instagram.com/${active.ig_username}/`} target="_blank" rel="noreferrer"
                     className="text-[17px] font-bold tracking-tight text-slate-900 hover:text-brand-700 inline-flex items-center gap-1">
                    @{active.ig_username} <ExternalLink size={12} className="text-slate-400" />
                  </a>
                  <div className="text-[13px] text-slate-700 truncate" title={active.profile_who || ''}>
                    {active.profile_who || active.full_name || (active.profile_status === 'missing' ? 'Compte introuvable' : active.profile_status ? '' : 'Profil pas encore lu')}
                  </div>
                  <div className="text-xs text-slate-500 truncate" title={active.arrival || ''}>
                    {active.arrival_url
                      ? <a href={active.arrival_url} target="_blank" rel="noreferrer" className="hover:text-brand-700">{active.arrival}</a>
                      : active.arrival}
                  </div>
                </div>
                <div className="ml-auto flex items-center gap-2 shrink-0">
                  {/* Corriger le rangement : ce choix n'est jamais réécrit. */}
                  <select
                    value={active.segment || 'commentaire'}
                    onChange={e => run(() => api.instagram.setSegment(active.prospect_id, e.target.value), 'Rangé')}
                    className="text-[11px] border border-slate-200 rounded-full px-2.5 py-1 bg-white text-slate-600"
                  >
                    {segments.map(sg => <option key={sg.key} value={sg.key}>{sg.label}</option>)}
                  </select>
                  <span className={`text-xs ${win.open ? 'text-emerald-700' : 'text-amber-700'}`}>{win.label}</span>
                  <button disabled={busy} title="Marquer traité"
                    onClick={() => run(() => api.instagram.update(active.prospect_id, { contacted: true }), 'Marqué traité')
                      .then(() => setActiveId(null))}
                    className="btn-secondary btn-sm"><Check size={13} /></button>
                  <button disabled={busy} title="Écarter"
                    onClick={() => run(() => api.instagram.remove(active.prospect_id), 'Écarté').then(() => setActiveId(null))}
                    className="btn-secondary btn-sm"><X size={13} /></button>
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-3.5">
                {messages.map(m => (
                  <div key={m.id} className={`flex flex-col gap-1 ${m.direction === 'out' ? 'items-end' : 'items-start'}`}>
                    <span className="text-[10px] uppercase tracking-wider text-slate-400">
                      {m.direction === 'out' ? 'Nous' : 'Elle'} · {stamp(m.sent_at)}
                    </span>
                    <div className={`max-w-[78%] text-sm leading-relaxed px-4 py-3 rounded-2xl border whitespace-pre-line ${
                      m.direction === 'out'
                        ? 'bg-brand-600 text-white border-brand-600'
                        : 'bg-white border-slate-200 text-slate-700'}`}>
                      {m.link_url
                        ? <a href={m.link_url} target="_blank" rel="noreferrer" className="underline">{m.text}</a>
                        : m.text}
                    </div>
                  </div>
                ))}
                {!messages.length && <div className="text-sm text-slate-400 text-center py-10">Aucun échange.</div>}
                <div ref={bottom} />
              </div>

              {/* Le message écrit d'avance, dans sa carte. */}
              <div className="shrink-0 bg-white border border-slate-200 rounded-2xl p-4 flex flex-col gap-3 shadow-sm">
                <label htmlFor="ig-msg" className="sr-only">Message</label>
                <textarea
                  id="ig-msg"
                  value={text}
                  onChange={e => setText(e.target.value)}
                  rows={4}
                  disabled={!win.open}
                  className="w-full text-sm leading-relaxed bg-transparent border-none outline-none resize-none text-slate-900"
                />
                <div className="flex items-center gap-2 flex-wrap">
                  {active.draft_id
                    ? <Badge color="violet" size="xs">✦ Suggestion</Badge>
                    : <span className="text-xs text-slate-400">Aucun message écrit.</span>}
                  {!!active.error && <span className="text-xs text-amber-700">{active.error}</span>}
                  <span className="flex-1" />
                  {!!active.draft_id && (
                    <button disabled={busy} title="Jeter la suggestion et écrire toi-même"
                      onClick={() => { setText(''); run(() => api.instagram.updateDraft(active.draft_id, { action: 'drop' })) }}
                      className="btn-secondary btn-sm"><X size={13} /> J’écris</button>
                  )}
                  <button disabled={busy} onClick={() => run(() => api.instagram.writeDraft(active.prospect_id, { force: true }), 'Message réécrit')}
                    className="btn-secondary btn-sm"><Sparkles size={13} /> {active.draft_id ? 'Réécrire' : 'Écrire'}</button>
                  <button disabled={busy || !win.open || !text.trim()} onClick={send} className="btn-primary btn-sm">
                    <Send size={13} /> Envoyer
                  </button>
                </div>
              </div>

            </div>
          )}
        </div>
      </div>
    </Layout>
  )
}
