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
import { Copy, Send, RefreshCw, Search, ExternalLink, Sparkles, PauseCircle, X, Check, Filter, PanelLeftClose, PanelLeftOpen } from 'lucide-react'
import api from '../lib/api.js'
import { fmtDate, fmtTime } from '../lib/formatDate.js'
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

// Le fil prêt à afficher : séparateurs de jour, gestes (commentaire, clic),
// et pour chaque bulle son auteur et si elle termine une suite du même auteur.
function threadItems(messages) {
  const authorOf = m => (m.direction !== 'out' ? 'her' : m.kind === 'msgout_instagram' ? 'auto' : 'us')
  const items = []
  let lastDay = null
  messages.forEach((m, i) => {
    const day = m.sent_at ? fmtDate(m.sent_at) : null
    if (day && day !== lastDay) { items.push({ kind: 'day', key: `d${i}`, label: day }); lastDay = day }
    if (m.direction === 'in' && EVENT.test(m.text || '')) { items.push({ kind: 'event', m }); return }
    items.push({ kind: authorOf(m), m })
  })
  items.forEach((it, i) => {
    if (!['her', 'us', 'auto'].includes(it.kind)) return
    const next = items[i + 1]
    it.last = !next || next.kind !== it.kind
  })
  return items
}

function clock(iso) {
  return fmtTime(iso)
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
      className={`flex items-center gap-1.5 pb-3 border-b-2 -mb-px text-sm transition-colors ${
        active ? 'border-slate-900 font-semibold text-slate-900' : 'border-transparent font-medium text-slate-500 hover:text-slate-700'}`}
    >
      {label}<span className="text-[11px] font-normal text-slate-400">{n}</span>
    </button>
  )
}

// Où en est le message de la personne, en un point de couleur et un mot.
function statusOf(i) {
  if (i.draft_status === 'queued') return { dot: 'bg-emerald-500', label: `Part ${inFuture(i.scheduled_at)}` }
  if (i.reopened) return { dot: 'bg-sky-500', label: 'A réécrit' }
  if (i.draft_status === 'draft') return { dot: 'bg-emerald-500', label: 'Prêt' }
  if (i.draft_status === 'review') return { dot: 'bg-amber-500', label: 'À relire' }
  if (['held', 'failed'].includes(i.draft_status)) return { dot: 'bg-amber-500', label: 'Retenu' }
  return { dot: 'bg-amber-500', label: 'À écrire' }
}

function Avatar({ name, size = 'sm' }) {
  return (
    <div className={`${size === 'lg' ? 'w-11 h-11 text-base' : 'w-9 h-9 text-[13px]'} rounded-full bg-slate-100 text-slate-500 font-semibold flex items-center justify-center shrink-0`}>
      {(name || '?').slice(0, 1).toUpperCase()}
    </div>
  )
}

// Gestes enregistrés par ManyChat (« 📝 A commenté », « 🔗 A cliqué un lien »…) :
// une ligne discrète au milieu du fil, pas une bulle.
const EVENT = /^(📝|🔗|✨|💬 A |💬 Réponse|📣|👤)/u

function Row({ i, active, onPick }) {
  const st = statusOf(i)
  return (
    <button
      onClick={() => onPick(i.prospect_id)}
      className={`w-full text-left flex gap-3 px-5 py-3 border-b border-slate-100 ${
        active ? 'bg-slate-50 shadow-[inset_3px_0_0_theme(colors.slate.900)]' : 'hover:bg-slate-50'}`}
    >
      <Avatar name={i.ig_username} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-slate-900 truncate">{i.ig_username}</span>
          <span className="ml-auto text-[11px] text-slate-400 shrink-0">{ago(i.last_incoming_at || i.last_message_at || i.first_comment_at)}</span>
        </div>
        <div className="text-[12.5px] text-slate-500 truncate">{i.profile_who || i.arrival || i.last_message_text || '—'}</div>
        <div className="mt-1 flex items-center gap-1.5 text-xs font-medium text-slate-600" title={i.review_label || ''}>
          <span className={`w-[7px] h-[7px] rounded-full ${st.dot}`} />{st.label}
        </div>
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
  // La boîte du message grandit avec son texte : on voit toujours le message en entier.
  const box = useRef(null)

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

  // Deux groupes : ceux à qui on peut écrire en privé (fenêtre de 24 h ouverte),
  // et les autres, à qui on répond directement sur Instagram, sous leur commentaire.
  // Ceux à qui on peut écrire en privé (fenêtre de 24 h ouverte) passent devant.
  const ordered = useMemo(() => (tab === 'done' ? rows : [...rows.filter(i => i.window_open), ...rows.filter(i => !i.window_open)]), [rows, tab])

  const active = useMemo(() => items.find(i => i.prospect_id === activeId) || null, [items, activeId])

  // Le fil se charge à l'ouverture ; le brouillon remplit la boîte d'écriture.
  useEffect(() => {
    if (!active?.manychat_user_id) { setMessages([]); setThread(null); return }
    api.instagram.conversationMessages(active.manychat_user_id)
      .then(r => { setMessages(r.messages || []); setThread(r.thread || null) })
      .catch(e => addToast({ message: e.message, type: 'error' }))
  }, [active?.manychat_user_id, addToast])
  // La suggestion se retouche sur place : chaque frappe s'enregistre seule dans
  // le brouillon, c'est donc bien le texte retouché qui partira avec la file.
  // Un message tapé sans suggestion au départ est gardé lui aussi, et chaque
  // frappe est d'abord posée dans le navigateur : fermer la page au milieu d'une
  // phrase ne perd rien.
  const pending = useRef(null)
  const saveTimer = useRef(null)
  const flush = useCallback(() => {
    clearTimeout(saveTimer.current)
    const p = pending.current
    pending.current = null
    if (!p) return Promise.resolve()
    const done = () => { try { localStorage.removeItem(`ig.draft.${p.prospect}`) } catch { /* rien à nettoyer */ } }
    if (p.id) {
      setData(d => d && ({ ...d, items: d.items.map(i => i.draft_id === p.id ? { ...i, draft_text: p.raw, edited: 1 } : i) }))
      return api.instagram.updateDraft(p.id, { text: p.raw.trim() }).then(done).catch(e => addToast({ message: e.message, type: 'error' }))
    }
    return api.instagram.saveManualDraft(p.prospect, p.raw.trim()).then(r => {
      done()
      const d = r?.draft
      if (d) setData(x => x && ({ ...x, items: x.items.map(i => i.prospect_id === p.prospect
        ? { ...i, draft_id: d.id, draft_text: d.text, draft_status: d.status, edited: 1 } : i) }))
    }).catch(e => addToast({ message: e.message, type: 'error' }))
  }, [addToast])
  useEffect(() => () => { flush() }, [active?.prospect_id, flush])
  useEffect(() => {
    const out = () => { flush() }
    window.addEventListener('pagehide', out)
    return () => window.removeEventListener('pagehide', out)
  }, [flush])
  // Un message réécrit par le serveur (changement de pile…) remplace l'affiché,
  // sauf pendant une retouche en cours. Un texte resté dans le navigateur (page
  // fermée avant l'enregistrement) reprend sa place et repart au serveur.
  useEffect(() => {
    if (pending.current || !active) return
    let kept = null
    try { kept = localStorage.getItem(`ig.draft.${active.prospect_id}`) } catch { /* navigateur sans stockage */ }
    if (kept && kept.trim() && kept !== active.draft_text) {
      setText(kept)
      pending.current = { id: active.draft_id || null, prospect: active.prospect_id, raw: kept }
      flush()
      return
    }
    setText(active.draft_text || '')
  }, [active?.prospect_id, active?.draft_id, active?.draft_text]) // eslint-disable-line react-hooks/exhaustive-deps
  const edit = v => {
    setText(v)
    if (!active || !v.trim()) return
    try { localStorage.setItem(`ig.draft.${active.prospect_id}`, v) } catch { /* le serveur suffit */ }
    pending.current = { id: active.draft_id || null, prospect: active.prospect_id, raw: v }
    clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(flush, 700)
  }
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'end' }) }, [messages])
  useEffect(() => {
    const el = box.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text, activeId])

  const run = async (fn, okMsg) => {
    setBusy(true)
    try {
      await flush()
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
      pending.current = null
      try { localStorage.removeItem(`ig.draft.${active.prospect_id}`) } catch { /* rien à nettoyer */ }
      // Répondu = traité : la personne quitte la pile tout de suite.
      setData(d => d && ({ ...d, items: d.items.filter(i => i.prospect_id !== active.prospect_id) }))
      setActiveId(null)
      addToast({ message: 'Message envoyé', type: 'success' })
      await load()
    } catch (e) { addToast({ message: e.message, type: 'error' }) } finally { setBusy(false) }
  }

  const copyAndOpen = async url => {
    awaiting.current = active?.prospect_id || null
    try { await navigator.clipboard.writeText(text.trim()); addToast({ message: 'Message copié', type: 'success' }) } catch { /* copie refusée : Instagram s'ouvre quand même */ }
    window.open(url, '_blank', 'noopener')
  }

  // Au retour dans l'onglet, Boréal regarde si le message est parti d'Instagram :
  // si oui, la personne est traitée sans qu'on ait à cliquer.
  const awaiting = useRef(null)
  useEffect(() => {
    const back = async () => {
      if (document.visibilityState !== 'visible' || !awaiting.current) return
      const id = awaiting.current
      try {
        const r = await api.instagram.checkSent(id)
        if (!r?.handled) return
        awaiting.current = null
        setData(d => d && ({ ...d, items: d.items.filter(i => i.prospect_id !== id) }))
        setActiveId(a => (a === id ? null : a))
        try { localStorage.removeItem(`ig.draft.${id}`) } catch { /* rien */ }
        addToast({ message: 'Message vu dans Instagram : traité', type: 'success' })
        load()
      } catch { /* on revérifiera au prochain retour */ }
    }
    document.addEventListener('visibilitychange', back)
    window.addEventListener('focus', back)
    return () => { document.removeEventListener('visibilitychange', back); window.removeEventListener('focus', back) }
  }, [addToast, load])

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
        {ordered.map(i => <Row key={i.prospect_id} i={i} active={activeId === i.prospect_id} onPick={setActiveId} />)}
        {!rows.length && <div className="px-4 py-14 text-center text-sm text-slate-400">Rien ici.</div>}
      </div>
    </div>
  )

  return (
    <Layout>
      {/* Une seule barre : le titre, les piles, et l'envoi à droite. */}
      <div className="flex items-end gap-6 px-6 pt-3 border-b border-slate-200 flex-wrap">
        <div className="pb-2.5"><PageTitle>Instagram</PageTitle></div>
        {segments.map(s => (
          <Tab key={s.key} label={SHORT[s.key] || s.label} n={counts[s.key] || 0}
            active={tab === s.key} onClick={() => { setTab(s.key); setActiveId(null) }} />
        ))}
        <Tab label="Déjà traités" n={done ? counts.done || 0 : ''} active={done}
          onClick={() => { setTab(done ? segments[0]?.key : 'done'); setActiveId(null) }} />
        <div className="ml-auto pb-2 flex items-center gap-1.5">
          {!!counts.queued && <span className="text-xs text-slate-400 mr-1">{counts.queued} en route{data?.next_at ? ` · prochain ${inFuture(data.next_at)}` : ''}</span>}
          {isAdmin && (
            <button disabled={scraping} title="Relire les commentaires Instagram"
              onClick={async () => {
                setScraping(true)
                try { await api.instagram.scrape(); await load() }
                catch (e) { addToast({ message: e.message, type: 'error' }) }
                finally { setScraping(false) }
              }}
              className="p-2 rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-100"
            ><RefreshCw size={15} className={scraping ? 'animate-spin' : ''} /></button>
          )}
          {isAdmin && (
            <button disabled={sorting} title="Trier : ranger par pile, écarter les robots et les déjà traités"
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
              className="p-2 rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-100"
            ><Filter size={15} className={sorting ? 'animate-pulse' : ''} /></button>
          )}
          <button disabled={busy} title="Écrire les messages manquants"
            onClick={() => run(() => api.instagram.writeAllDrafts(), r => r.summary || 'Messages écrits')}
            className="p-2 rounded-full text-slate-400 hover:text-slate-700 hover:bg-slate-100"><Sparkles size={15} /></button>
          {!!counts.queued && (
            <button disabled={busy} onClick={() => run(() => api.instagram.holdDrafts(), 'Envoi arrêté')}
              className="btn-secondary btn-sm"><PauseCircle size={14} /> Retenir</button>
          )}
          <button disabled={busy || !ready} onClick={() => run(() => api.instagram.sendDraftsNow(), r => `${r.sent || 0} parti(s), le reste suit aux ${data?.spacing_seconds || 90} s`)}
            className="btn-primary btn-sm rounded-full"><Send size={14} /> Envoyer les {ready} prêts</button>
        </div>
      </div>

      {session && (!session.configured || session.expired?.length > 0) && (
        <div className="mx-6 mt-3 px-4 py-2.5 text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg">
          Déconnecté : {[!session.configured || session.expired?.includes('instagram') ? 'Instagram' : null,
            session.expired?.includes('manychat') ? 'ManyChat' : null].filter(Boolean).join(' + ')} — reconnecter dans Connecteurs.
        </div>
      )}

      <div className="relative flex overflow-hidden" style={{ height: 'calc(100vh - 64px)' }}>

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

        {/* La conversation : en-tête pleine largeur, fil et message centrés. */}
        <div className="flex-1 min-w-0 bg-slate-50 flex flex-col overflow-hidden">
          {!active ? (
            <div className="m-auto text-sm text-slate-400">Choisis quelqu’un à gauche.</div>
          ) : (
            <>
              <div className="shrink-0 flex items-center gap-3 px-8 py-4 bg-white border-b border-slate-200">
                <Avatar name={active.ig_username} size="lg" />
                <div className="min-w-0">
                  <a href={`https://www.instagram.com/${active.ig_username}/`} target="_blank" rel="noreferrer"
                     className="text-base font-semibold text-slate-900 hover:text-brand-700 inline-flex items-center gap-1">
                    {active.ig_username} <ExternalLink size={12} className="text-slate-400" />
                  </a>
                  <div className="text-[13px] text-slate-500 truncate" title={active.profile_who || ''}>
                    {active.profile_who || active.full_name || (active.profile_status === 'missing' ? 'Compte introuvable' : 'Profil pas encore lu')}
                  </div>
                </div>
                <div className="ml-auto flex items-center gap-2 shrink-0">
                  <span className={`text-xs ${win.open ? 'text-emerald-700' : 'text-slate-400'}`}>{win.label}</span>
                  {/* Corriger le rangement : ce choix n'est jamais réécrit. */}
                  <select
                    value={active.segment || 'commentaire'}
                    onChange={e => run(() => api.instagram.setSegment(active.prospect_id, e.target.value), 'Rangé')}
                    className="text-xs font-medium border-0 rounded-full px-3 py-1 bg-slate-100 text-slate-700"
                  >
                    {segments.map(sg => <option key={sg.key} value={sg.key}>{SHORT[sg.key] || sg.label}</option>)}
                  </select>
                  <button disabled={busy} title="C’est fait : sort de la liste, revient si elle réécrit"
                    onClick={() => {
                      const id = active.prospect_id
                      setActiveId(null)
                      setData(d => d && ({ ...d, items: d.items.filter(i => i.prospect_id !== id) }))
                      run(() => api.instagram.update(id, { contacted: true }), 'Marqué traité')
                    }}
                    className="btn-secondary btn-sm rounded-full"><Check size={13} /> Traité</button>
                  <button disabled={busy} title="Pas un prospect : retirée de la liste (revient seulement si elle réécrit)"
                    onClick={() => run(() => api.instagram.remove(active.prospect_id), 'Écarté').then(() => setActiveId(null))}
                    className="btn-secondary btn-sm rounded-full"><X size={13} /> Écarter</button>
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto">
                <div className="max-w-[760px] mx-auto px-8 py-6 flex flex-col gap-2.5">
                  {/* Ce qu'elle a écrit en arrivant, quand le fil ne le porte pas. */}
                  {!!active.arrival_quote && !messages.length && (
                    <>
                      <div className="self-center text-[11.5px] text-slate-400">
                        {active.arrival_url
                          ? <a href={active.arrival_url} target="_blank" rel="noreferrer" className="hover:text-slate-600 inline-flex items-center gap-1">{active.arrival_head || 'A commenté'} <ExternalLink size={10} /></a>
                          : active.arrival_head || 'A commenté'}
                      </div>
                      <div className="self-start max-w-[72%] text-sm leading-relaxed px-3.5 py-2.5 rounded-2xl bg-white border border-slate-200 text-slate-700 whitespace-pre-line">{active.arrival_quote}</div>
                    </>
                  )}
                  {threadItems(messages).map(it => {
                    if (it.kind === 'day') {
                      return <div key={it.key} className="self-center my-1.5 text-[11px] font-semibold text-slate-500 bg-white border border-slate-200 rounded-full px-2.5 py-0.5">{it.label}</div>
                    }
                    const m = it.m
                    if (it.kind === 'event') {
                      const label = m.text.replace(EVENT, '').trim()
                      return (
                        <div key={m.id} className="self-center text-[11.5px] text-slate-400">
                          {m.link_url ? <a href={m.link_url} target="_blank" rel="noreferrer" className="hover:text-slate-600">{label}</a> : label}
                        </div>
                      )
                    }
                    // Comme Instagram : elle à gauche en blanc, nous à droite en bleu,
                    // la réponse automatique de ManyChat en pointillé. Le nom et
                    // l'heure ne s'affichent qu'au bas d'une suite du même auteur.
                    const mine = it.kind !== 'her'
                    const bubble = it.kind === 'her'
                      ? 'bg-white border border-slate-200 text-slate-700 rounded-bl-md'
                      : it.kind === 'auto'
                        ? 'border border-dashed border-slate-300 text-slate-500 rounded-br-md'
                        : 'bg-[#3797f0] text-white rounded-br-md'
                    return (
                      <div key={m.id} className={`flex gap-2 items-end ${mine ? 'flex-row-reverse' : ''} ${it.last ? '' : '-mb-1.5'}`}>
                        <div className={`w-7 h-7 shrink-0 rounded-full text-[11px] font-bold flex items-center justify-center ${it.last ? '' : 'invisible'} ${
                          it.kind === 'her' ? 'bg-violet-100 text-violet-700' : it.kind === 'auto' ? 'bg-slate-200 text-slate-500' : 'bg-emerald-600 text-white'}`}>
                          {it.kind === 'her' ? (active.ig_username || '?').slice(0, 1).toUpperCase() : it.kind === 'auto' ? 'A' : 'O'}
                        </div>
                        <div className={`flex flex-col gap-0.5 max-w-[72%] ${mine ? 'items-end' : 'items-start'}`}>
                          <div className={`text-sm leading-relaxed px-3.5 py-2 rounded-[18px] whitespace-pre-line ${bubble}`}>
                            {m.link_url ? <a href={m.link_url} target="_blank" rel="noreferrer" className="underline">{m.text}</a> : m.text}
                          </div>
                          {it.last && (
                            <div className="text-[11px] text-slate-400 px-1">
                              {it.kind === 'her' ? active.ig_username : it.kind === 'auto' ? 'Réponse automatique' : 'Orisha'} · {clock(m.sent_at)}
                            </div>
                          )}
                        </div>
                      </div>
                    )
                  })}
                  <div ref={bottom} />
                </div>
              </div>

              {/* Le message écrit d'avance. */}
              <div className="shrink-0 px-8 pb-6">
                <div className="max-w-[760px] mx-auto bg-white border border-slate-200 rounded-2xl px-4 py-3.5 flex flex-col gap-3">
                  <label htmlFor="ig-msg" className="sr-only">Message</label>
                  <textarea
                    id="ig-msg"
                    ref={box}
                    value={text}
                    onChange={e => edit(e.target.value)}
                    rows={2}
                    className="w-full max-h-[55vh] overflow-y-auto text-sm leading-relaxed bg-transparent border-none outline-none resize-none text-slate-900"
                  />
                  <div className="flex items-center gap-2 flex-wrap">
                    {active.draft_id
                      ? <Badge color="violet" size="xs">{active.edited ? 'Retouché' : 'Suggestion'}</Badge>
                      : <span className="text-xs text-slate-400">À écrire toi-même</span>}
                    {!!active.error && <span className="text-xs text-amber-700">{active.error}</span>}
                    <span className="flex-1" />
                    {!!active.draft_id && (
                      <button disabled={busy} title="Jeter la suggestion et écrire toi-même"
                        onClick={() => { setText(''); pending.current = null; try { localStorage.removeItem(`ig.draft.${active.prospect_id}`) } catch { /* rien */ } run(() => api.instagram.updateDraft(active.draft_id, { action: 'drop' })) }}
                        className="btn-secondary btn-sm rounded-full">J’écris</button>
                    )}
                    {!active.draft_id && (
                      <button disabled={busy} title="Proposer un message" onClick={() => run(() => api.instagram.writeDraft(active.prospect_id, { force: true }), 'Message écrit')}
                        className="btn-secondary btn-sm rounded-full"><Sparkles size={13} /></button>
                    )}
                    {win.open ? (
                      <button disabled={busy || !text.trim()} onClick={send} className="btn-primary btn-sm rounded-full">
                        <Send size={13} /> Envoyer
                      </button>
                    ) : (
                      // Fenêtre fermée : Boréal ne peut plus écrire, mais Phil, lui, le peut
                      // depuis Instagram. Le message est copié, il n'a qu'à le coller.
                      <>
                        {!!active.arrival_url && (
                          <button title="Copie le message et ouvre le post : colle-le en réponse à son commentaire"
                            onClick={() => copyAndOpen(active.arrival_url)} className="btn-secondary btn-sm rounded-full">
                            <Copy size={13} /> Répondre au commentaire
                          </button>
                        )}
                        <button title="Copie le message et ouvre la conversation privée dans Instagram"
                          onClick={() => copyAndOpen(`https://ig.me/m/${active.ig_username}`)} className="btn-primary btn-sm rounded-full">
                          <Copy size={13} /> Écrire sur Instagram
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </Layout>
  )
}
