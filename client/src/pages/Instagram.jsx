// Instagram — une seule page.
//
// À gauche : les gens qui attendent quelque chose de Philippe, rien d'autre.
// À droite : la conversation de celui qu'il ouvre, et le message écrit d'avance
// juste au-dessus du champ d'envoi.
//
// Une personne contactée quitte la liste, et y revient d'elle-même si elle
// réécrit : c'est ce qui évite la liste de 231 fiches où plus rien ne ressort.
import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Send, RefreshCw, Search, ExternalLink, Sparkles, PauseCircle, X, Check } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import Spinner from '../components/Spinner.jsx'
import { Badge } from '../components/Badge.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { useAuth } from '../lib/auth.jsx'

const WINDOW_MS = 24 * 60 * 60 * 1000

const GROUPS = [
  { key: 'review', label: 'À voir avec toi', tone: 'warn' },
  { key: 'ready', label: 'Prêts à partir', tone: 'plain' },
  { key: 'waiting', label: 'Sans message écrit', tone: 'plain' },
  { key: 'held', label: 'Retenus', tone: 'plain' },
  { key: 'done', label: 'Déjà contactés', tone: 'plain' },
]

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
  if (!lastIncomingAt) return { open: false, label: 'Jamais écrit — Instagram n’autorise pas de message' }
  const left = WINDOW_MS - (Date.now() - new Date(lastIncomingAt).getTime())
  if (left <= 0) return { open: false, label: 'Fenêtre fermée — attendre un nouveau message de sa part' }
  const h = Math.floor(left / 3_600_000)
  return { open: true, label: h >= 1 ? `Fenêtre ouverte encore ${h} h` : 'Fenêtre ouverte moins d’une heure' }
}

export default function Instagram() {
  const { addToast } = useToast()
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [all, setAll] = useState(false)
  const [session, setSession] = useState(null)
  const [scraping, setScraping] = useState(false)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [q, setQ] = useState('')
  const [activeId, setActiveId] = useState(null)
  const [messages, setMessages] = useState([])
  const [thread, setThread] = useState(null)
  const [text, setText] = useState('')
  const bottom = useRef(null)

  const load = useCallback(() => {
    return api.instagram.workbench(all)
      .then(r => { setData(r); setLoading(false); return r })
      .catch(e => { addToast({ message: e.message, type: 'error' }); setLoading(false) })
  }, [addToast, all])
  useEffect(() => { load() }, [load])
  useEffect(() => { api.instagram.session().then(setSession).catch(() => {}) }, [])

  const items = useMemo(() => data?.items || [], [data])
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

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase()
    if (!needle) return items
    return items.filter(i => `${i.ig_username} ${i.full_name || ''}`.toLowerCase().includes(needle))
  }, [items, q])

  const grouped = useMemo(
    () => GROUPS.map(g => ({ ...g, rows: filtered.filter(i => i.group === g.key) })).filter(g => g.rows.length),
    [filtered],
  )

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

  const c = data?.counts || {}
  const ready = c.ready || 0

  return (
    <Layout>
      <div className="max-w-6xl mx-auto px-4 py-5">
        <header className="flex items-center gap-3 flex-wrap mb-3">
          <PageTitle>Instagram</PageTitle>
          <span className="text-sm text-slate-400">
            {c.queued
              ? <>envoi en cours · {c.queued} restant{c.queued > 1 ? 's' : ''}{data?.next_at ? ` · prochain ${inFuture(data.next_at)}` : ''}</>
              : <>{items.length} personne{items.length > 1 ? 's' : ''} à traiter</>}
          </span>
          <div className="ml-auto flex gap-2">
            <button onClick={load} className="btn-secondary btn-sm" title="Actualiser"><RefreshCw size={14} /></button>
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
                <RefreshCw size={14} className={scraping ? 'animate-spin' : ''} /> Relire Instagram
              </button>
            )}
            <button disabled={busy} onClick={() => run(() => api.instagram.writeAllDrafts(), r => r.summary || 'Messages écrits')}
              className="btn-secondary btn-sm"><Sparkles size={14} /> Écrire</button>
            {!!c.queued && (
              <button disabled={busy} onClick={() => run(() => api.instagram.holdDrafts(), 'Envoi arrêté')}
                className="btn-secondary btn-sm"><PauseCircle size={14} /> Retenir</button>
            )}
            <button disabled={busy || !ready} onClick={() => run(() => api.instagram.sendDraftsNow(), r => `${r.sent || 0} parti(s), le reste suit aux ${data?.spacing_seconds || 90} s`)}
              className="btn-primary btn-sm"><Send size={14} /> Envoyer les {ready}</button>
          </div>
        </header>

        {session && !session.configured && (
          <div className="mb-3 px-4 py-2.5 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg">
            La lecture des commentaires est coupée — rouvrir la session dans Connecteurs → Instagram.
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-[320px_1fr] border border-slate-200 rounded-xl overflow-hidden bg-white min-h-[62vh]">
          {/* La liste : uniquement ceux qui attendent quelque chose */}
          <div className="border-b md:border-b-0 md:border-r border-slate-200 flex flex-col max-h-[72vh]">
            <label className="flex items-center gap-2 px-3 py-2 border-b border-slate-100 text-sm">
              <Search size={14} className="text-slate-400" />
              <input className="flex-1 outline-none bg-transparent" value={q} onChange={e => setQ(e.target.value)} />
              <span className="flex items-center gap-1 text-xs text-slate-500 cursor-pointer select-none whitespace-nowrap">
                <input type="checkbox" checked={all} onChange={e => setAll(e.target.checked)}
                  className="w-3.5 h-3.5 rounded border-slate-300 text-brand-600" />
                tout le monde
              </span>
            </label>
            <div className="overflow-y-auto">
              {grouped.map(g => (
                <div key={g.key}>
                  <div className={`px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide border-y ${
                    g.tone === 'warn'
                      ? 'bg-amber-50 text-amber-800 border-amber-100'
                      : 'bg-slate-50 text-slate-500 border-slate-100'}`}>
                    {g.label} · {g.rows.length}
                  </div>
                  {g.rows.map(i => (
                    <button
                      key={i.prospect_id}
                      onClick={() => setActiveId(i.prospect_id)}
                      className={`w-full text-left px-3 py-2.5 border-b border-slate-100 ${
                        activeId === i.prospect_id ? 'bg-brand-50' : 'hover:bg-slate-50'}`}
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-slate-900 truncate">@{i.ig_username}</span>
                        {i.draft_status === 'queued' && <Badge color="green" size="xs">{inFuture(i.scheduled_at)}</Badge>}
                        <span className="ml-auto text-[11px] text-slate-400">{ago(i.last_incoming_at || i.last_message_at)}</span>
                      </div>
                      {!!i.review_label && <div className="text-[11px] text-amber-700 mt-0.5">{i.review_label}</div>}
                      <div className="text-xs text-slate-500 truncate mt-0.5">
                        {i.capture_label || i.last_message_text || '—'}
                      </div>
                    </button>
                  ))}
                </div>
              ))}
              {!grouped.length && (
                <div className="px-4 py-12 text-center text-sm text-slate-400">Personne n’attend de réponse.</div>
              )}
            </div>
          </div>

          {/* Le détail : le fil d'abord, le message écrit d'avance en dessous */}
          {!active ? (
            <div className="flex items-center justify-center text-sm text-slate-400 p-10">
              Choisis quelqu’un à gauche.
            </div>
          ) : (
            <div className="flex flex-col min-w-0">
              <div className="flex items-start gap-3 px-4 py-3 border-b border-slate-100">
                <div className="min-w-0">
                  <a href={`https://www.instagram.com/${active.ig_username}/`} target="_blank" rel="noreferrer"
                     className="text-sm font-semibold text-slate-900 hover:text-brand-700 inline-flex items-center gap-1">
                    @{active.ig_username} <ExternalLink size={11} className="text-slate-400" />
                  </a>
                  {!!active.full_name && <span className="ml-2 text-sm text-slate-400">{active.full_name}</span>}
                  <div className="text-xs text-slate-500 mt-0.5">
                    {active.capture_url
                      ? <a href={active.capture_url} target="_blank" rel="noreferrer" className="hover:text-brand-700 inline-flex items-center gap-1">
                          {active.capture_label} <ExternalLink size={10} />
                        </a>
                      : active.capture_label}
                  </div>
                </div>
                <div className="ml-auto flex items-center gap-2">
                  <span className={`text-[11px] ${win.open ? 'text-emerald-700' : 'text-amber-700'}`}>{win.label}</span>
                  <button disabled={busy} title="Marquer traité"
                    onClick={() => run(() => api.instagram.update(active.prospect_id, { contacted: true }), 'Marqué traité')
                      .then(() => setActiveId(null))}
                    className="btn-secondary btn-sm"><Check size={13} /></button>
                  <button disabled={busy} title="Écarter"
                    onClick={() => run(() => api.instagram.remove(active.prospect_id), 'Écarté').then(() => setActiveId(null))}
                    className="btn-secondary btn-sm"><X size={13} /></button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto bg-slate-50 px-4 py-3 space-y-2 max-h-[46vh]">
                {messages.map(m => (
                  <div key={m.id} className={`max-w-[75%] text-sm px-3 py-2 rounded-xl border ${
                    m.direction === 'out'
                      ? 'ml-auto bg-brand-600 text-white border-brand-600'
                      : 'bg-white border-slate-200 text-slate-700'}`}>
                    {m.link_url
                      ? <a href={m.link_url} target="_blank" rel="noreferrer" className="underline">{m.text}</a>
                      : m.text}
                    <span className={`block text-[10px] mt-1 ${m.direction === 'out' ? 'text-white/70' : 'text-slate-400'}`}>
                      {stamp(m.sent_at)}
                    </span>
                  </div>
                ))}
                {!messages.length && <div className="text-sm text-slate-400 text-center py-8">Aucun échange.</div>}
                <div ref={bottom} />
              </div>

              <div className="border-t border-slate-200 p-3 space-y-2">
                <div className="flex items-center gap-2 text-xs text-slate-500 flex-wrap">
                  {active.draft_id
                    ? <Badge color="violet" size="xs">✦ Brouillon</Badge>
                    : <span>Aucun message écrit pour cette personne.</span>}
                  {!!active.error && <span className="text-amber-700">{active.error}</span>}
                  <button disabled={busy} onClick={() => run(() => api.instagram.writeDraft(active.prospect_id, { force: true }), 'Message réécrit')}
                    className="btn-secondary btn-sm ml-auto"><Sparkles size={13} /> {active.draft_id ? 'Réécrire' : 'Écrire'}</button>
                </div>
                <textarea
                  value={text}
                  onChange={e => setText(e.target.value)}
                  rows={3}
                  disabled={!win.open}
                  placeholder={win.open ? '' : 'Instagram n’autorise pas de message maintenant'}
                  className={`w-full text-sm rounded-lg px-3 py-2 border focus:outline-none focus:ring-1 focus:ring-brand-500 ${
                    active.draft_id ? 'border-violet-300 bg-violet-50/60' : 'border-slate-200'}`}
                />
                <div className="flex items-center gap-2">
                  <button disabled={busy || !win.open || !text.trim()} onClick={send} className="btn-primary btn-sm">
                    <Send size={13} /> Envoyer
                  </button>
                  {active.draft_status === 'queued' && (
                    <button disabled={busy} onClick={() => run(() => api.instagram.updateDraft(active.draft_id, { action: 'hold' }), 'Retenu')}
                      className="btn-secondary btn-sm">Retenir</button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </Layout>
  )
}
