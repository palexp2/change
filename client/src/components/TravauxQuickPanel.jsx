// Panneau rapide de la file de travaux — accessible depuis N'IMPORTE QUELLE page
// de l'ERP (bouton dans l'en-tête de la barre de gauche + raccourci ⌘/Ctrl + /).
//
// Il fait trois choses, sans quitter la page où on se trouve :
//   1. déposer un prompt dans la file, avec le contexte de la page pré-rempli
//      (route, fiche affichée, et au besoin un ou plusieurs éléments ciblés au
//      clic — même mécanisme que le FAB « Modifier le système », en sélection
//      multiple ici, voir lib/pageContext.jsx) ;
//   2. montrer l'état de la file : ce qui tourne, ce qui attend et à quel rang ;
//   3. répondre à une question de Claude (« À répondre ») — un choix ou du texte
//      libre relance la tâche immédiatement.
//
// Rien n'est réimplémenté ici : la lecture temps réel de la file, la pastille
// d'état, les choix d'une question et la zone de réponse viennent de
// lib/travauxQueue.jsx, partagés avec la page /travaux.
import { createContext, useContext, useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { Link, useLocation } from 'react-router-dom'
import {
  ListOrdered, X, Plus, Loader2, HelpCircle, Crosshair, MousePointerClick,
  ArrowRight, AlertTriangle, PauseCircle,
} from 'lucide-react'
import api from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import {
  inputCls, btnPrimary,
  isAsking, firstLine, StatusPill, QuestionChoices, ReplyBox, PlacementToggle, useTravauxPrompts,
} from '../lib/travauxQueue.jsx'
import { useElementPicker, buildPageContext, currentRecordLabel, PickerBanner } from '../lib/pageContext.jsx'

// Le panneau dépose dans la file de l'Espace finance (/travaux) — la même que le
// FAB « Modifier le système », dont c'est désormais la seule destination.
const SPACE = 'finance'

const Ctx = createContext(null)

/** État partagé du panneau : le bouton déclencheur vit dans la barre de gauche. */
export function useTravauxQuick() { return useContext(Ctx) }

/** Une ligne de file, repliée : rang, pastille d'état, titre. */
function QueueLine({ p, index }) {
  return (
    <div
      className="flex items-start gap-2 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white"
      data-testid="travaux-quick-queue-item"
      data-prompt-id={p.id}
    >
      <span className="mt-0.5 w-5 shrink-0 text-center text-[11px] font-semibold text-slate-400 tabular-nums">{index}</span>
      <div className="min-w-0 flex-1">
        <div className="text-sm text-slate-800 truncate">{p.title || firstLine(p.prompt, 60)}</div>
        <div className="mt-0.5"><StatusPill p={p} /></div>
      </div>
    </div>
  )
}

/** Carte « À répondre » : la question, ses choix, et une réponse libre. */
function AskingCard({ p, onReply }) {
  return (
    <div
      className="rounded-xl border border-violet-300 ring-1 ring-violet-100 bg-white p-2.5 space-y-2"
      data-testid="travaux-quick-asking"
      data-prompt-id={p.id}
    >
      <div className="flex items-center gap-2 min-w-0">
        <StatusPill p={p} />
        <span className="flex-1 min-w-0 truncate text-sm font-medium text-slate-800">{p.title}</span>
      </div>
      {/* La question est rappelée ici : le panneau n'affiche pas le fil complet. */}
      <QuestionChoices p={p} onAnswer={opt => onReply(p.id, opt)} showQuestion />
      <ReplyBox onSend={(text, placement) => onReply(p.id, text, placement)} />
    </div>
  )
}

function QuickPanel({ onClose, data, load }) {
  const location = useLocation()
  const { addToast } = useToast()
  const toast = useMemo(() => ({
    error: m => addToast({ message: m, type: 'error' }),
    success: m => addToast({ message: m, type: 'success' }),
  }), [addToast])

  const [text, setText] = useState('')
  const [priority, setPriority] = useState(false)
  // Plusieurs éléments peuvent être ciblés : une intervention porte souvent sur
  // deux ou trois endroits de la même page (voir pageContext.jsx, mode multiple).
  const [elements, setElements] = useState([])
  const [record, setRecord] = useState('')
  const [picking, setPicking] = useState(false)
  const [sending, setSending] = useState(false)
  const inputRef = useRef(null)

  // Fiche affichée : lue à l'ouverture (et à chaque changement de page tant que le
  // panneau est ouvert) — c'est le titre que l'utilisateur a sous les yeux.
  useEffect(() => { setRecord(currentRecordLabel(location.pathname)) }, [location.pathname, location.search])
  useEffect(() => { inputRef.current?.focus() }, [])

  // Le ciblage reste actif tant que l'utilisateur n'a pas cliqué « Terminé » :
  // chaque clic ajoute un élément (re-clic = retrait), la liste complète revient
  // par `onChange`.
  useElementPicker(picking, {
    multiple: true,
    existing: elements,
    onChange: setElements,
    onCancel: () => setPicking(false),
  })

  const context = buildPageContext({
    pathname: location.pathname, search: location.search, element: elements, record,
  })

  // Création : pas d'autosave possible (aucun id avant l'envoi) — voir CLAUDE.md.
  const submit = async () => {
    const trimmed = text.trim()
    if (!trimmed || sending) return
    setSending(true)
    try {
      await api.travaux.createPrompt({
        // Le contexte suit dans le prompt : c'est lui que l'agent reçoit.
        prompt: `${trimmed}\n\nContexte (ERP) : ${context}`,
        space: SPACE,
        priority,
      })
      setText('')
      setElements([])
      setPriority(false)
      toast.success(priority ? 'Ajouté en tête de ta file' : 'Ajouté à ta file de travaux')
      load()
    } catch (e) { toast.error(e.message) }
    finally { setSending(false) }
  }

  // Répondre relance la tâche (voir page Travaux) : 'front' repart tout de suite,
  // 'back' la remet en fin de file.
  const reply = useCallback(async (id, replyText, placement = 'front') => {
    try {
      await api.travaux.replyToPrompt(id, replyText, placement)
      toast.success(data.queue_paused
        ? 'Réponse enregistrée — la file est en pause, la tâche repartira à la reprise'
        : placement === 'back'
          ? 'Réponse enregistrée — la tâche retourne en fin de file'
          : 'Réponse envoyée — la tâche repart')
      load()
    } catch (e) { toast.error(e.message); throw e }
  }, [data.queue_paused, load, toast])

  // Trois groupes, dans l'ordre où ils intéressent : ce qui attend une réponse, ce
  // qui tourne, puis la file numérotée (déjà remis à l'ordonnanceur d'abord).
  const { asking, running, queue, pausedCount } = useMemo(() => {
    const prompts = data.prompts || []
    const live = prompts.filter(p => p.status === 'running')
    return {
      asking: prompts.filter(isAsking),
      running: live.filter(p => p.run_state === 'executing'),
      queue: [
        ...live.filter(p => p.run_state !== 'executing'),
        ...prompts.filter(p => p.status === 'queued'),
      ],
      pausedCount: prompts.filter(p => p.status === 'paused').length,
    }
  }, [data.prompts])

  return (
    <>
      {picking && <PickerBanner
        onSkip={() => setPicking(false)}
        onCancel={() => setPicking(false)}
        skipLabel="Sans élément"
        testIdPrefix="travaux-quick"
        multiple
        count={elements.length}
      />}

      {/* Pendant le ciblage, le panneau s'efface : la page doit être cliquable. */}
      <div className={picking ? 'hidden' : undefined}>
        <div className="fixed inset-0 z-[9992] bg-slate-900/10" onClick={onClose} />
        {/* Pas de garde-frappe ici (contrairement aux cartes de la page /travaux) :
            tous les champs du panneau tiennent leur texte en état local, un
            rafraîchissement de la file ne peut pas l'écraser. */}
        <aside
          data-testid="travaux-quick-panel"
          className="fixed top-0 right-0 bottom-0 z-[9993] w-full sm:w-[420px] bg-white border-l border-slate-200
            shadow-2xl flex flex-col"
        >
          <div className="flex items-center gap-2 h-14 px-3.5 border-b border-slate-100 flex-shrink-0">
            <ListOrdered size={16} className="text-slate-500" />
            <div className="text-sm font-semibold text-slate-800">File de travaux</div>
            <Link
              to="/travaux"
              onClick={onClose}
              data-testid="travaux-quick-open-page"
              className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:text-brand-700"
            >Ouvrir la page <ArrowRight size={12} /></Link>
            <button
              onClick={onClose}
              data-testid="travaux-quick-close"
              aria-label="Fermer"
              title="Fermer (Échap)"
              className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100"
            ><X size={15} /></button>
          </div>

          <div className="flex-1 overflow-y-auto p-3.5 space-y-4">
            {/* ── Composer : le contexte de la page est déjà là ─────────────── */}
            <div>
              <textarea
                ref={inputRef}
                data-testid="travaux-quick-input"
                className={`${inputCls} w-full`}
                rows={3}
                value={text}
                onChange={e => setText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit() }}
              />
              <div
                data-testid="travaux-quick-context"
                className="mt-1.5 rounded-lg bg-slate-50 border border-slate-200 px-2.5 py-1.5 text-[11px] text-slate-500"
              >
                <div className="font-medium text-slate-600">Contexte joint</div>
                <div className="font-mono break-all">{location.pathname}{location.search}</div>
                {!!record && <div className="truncate" data-testid="travaux-quick-record">Fiche affichée : « {record} »</div>}
                {/* Un ou plusieurs éléments ciblés : chacun numéroté comme dans le
                    contexte joint, retirable individuellement. */}
                {elements.map((desc, i) => (
                  <div key={`${i}-${desc}`} className="mt-1 flex items-start gap-1.5" data-testid="travaux-quick-element">
                    <span className="mt-0.5 inline-flex items-center justify-center min-w-[14px] h-[14px] px-1 rounded-full
                      bg-brand-600 text-white text-[9px] font-semibold leading-none flex-shrink-0 tabular-nums">{i + 1}</span>
                    <span className="font-mono break-all line-clamp-2 flex-1">{desc}</span>
                    <button
                      onClick={() => setElements(list => list.filter((_, j) => j !== i))}
                      data-testid="travaux-quick-element-remove"
                      aria-label={`Retirer l'élément ciblé ${i + 1}`}
                      className="text-slate-400 hover:text-slate-600 flex-shrink-0"
                    ><X size={12} /></button>
                  </div>
                ))}
                <div className="mt-1 flex items-center gap-2 flex-wrap">
                  <button
                    data-testid="travaux-quick-pick-element"
                    onClick={() => setPicking(true)}
                    className="inline-flex items-center gap-1 text-[11px] font-medium text-brand-600 hover:text-brand-700"
                  >
                    {elements.length
                      ? <><MousePointerClick size={12} /> Ajouter un élément</>
                      : <><Crosshair size={12} /> Cibler un ou plusieurs éléments sur la page</>}
                  </button>
                  {elements.length > 1 && (
                    <button
                      data-testid="travaux-quick-element-clear"
                      onClick={() => setElements([])}
                      className="text-[11px] text-slate-400 hover:text-slate-600"
                    >Tout retirer</button>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 mt-2 flex-wrap">
                <button className={btnPrimary} data-testid="travaux-quick-submit" onClick={submit} disabled={sending || !text.trim()}>
                  {sending ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Ajouter à la file
                </button>
                {/* Début ou fin de la file — même bouton que la page /travaux et
                    que le FAB (lib/travauxQueue.jsx). */}
                <PlacementToggle
                  testId="travaux-quick-priority"
                  value={priority ? 'first' : 'last'}
                  onChange={v => setPriority(v === 'first')}
                />
                <span className="text-xs text-slate-400 ml-auto">⌘/Ctrl + Entrée</span>
              </div>
              {!data.agent_enabled && (
                <p className="mt-1.5 text-xs text-amber-700 inline-flex items-center gap-1">
                  <AlertTriangle size={12} /> Agent désactivé — l'item attendra dans la file.
                </p>
              )}
              {data.queue_paused && (
                <p className="mt-1.5 text-xs text-amber-700 inline-flex items-center gap-1" data-testid="travaux-quick-paused">
                  <PauseCircle size={12} /> File en pause — aucune nouvelle tâche ne démarre.
                </p>
              )}
            </div>

            {/* ── À répondre : le seul état où rien n'avance sans nous ──────── */}
            {!!asking.length && (
              <section className="space-y-2">
                <h3 className="text-[11px] uppercase tracking-wide text-violet-700 font-semibold inline-flex items-center gap-1">
                  <HelpCircle size={12} /> À répondre · {asking.length}
                </h3>
                {asking.map(p => <AskingCard key={p.id} p={p} onReply={reply} />)}
              </section>
            )}

            {/* ── En cours ─────────────────────────────────────────────────── */}
            {!!running.length && (
              <section className="space-y-1.5" data-testid="travaux-quick-running">
                <h3 className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold">En cours</h3>
                {running.map(p => (
                  <div key={p.id} className="rounded-lg border border-brand-300 ring-1 ring-brand-100 bg-white px-2.5 py-1.5" data-prompt-id={p.id}>
                    <div className="text-sm text-slate-800 truncate">{p.title || firstLine(p.prompt, 60)}</div>
                    <div className="mt-0.5"><StatusPill p={p} /></div>
                  </div>
                ))}
              </section>
            )}

            {/* ── La file, numérotée : la position, c'est l'ordre de départ ─── */}
            <section className="space-y-1.5">
              <h3 className="text-[11px] uppercase tracking-wide text-slate-400 font-semibold">
                En file · {queue.length}
              </h3>
              {queue.length
                ? queue.map((p, i) => <QueueLine key={p.id} p={p} index={i + 1} />)
                : (
                  <p className="text-xs text-slate-400 rounded-lg border border-dashed border-slate-200 px-3 py-4 text-center">
                    Rien en attente. Ajoute un prompt ci-dessus — il partira tout seul.
                  </p>
                )}
              {!!pausedCount && (
                <p className="text-xs text-slate-400 pt-0.5">
                  {pausedCount} item{pausedCount > 1 ? 's' : ''} de côté — sur la page Travaux.
                </p>
              )}
            </section>
          </div>
        </aside>
      </div>
    </>
  )
}

/**
 * Provider global : l'état du panneau, sa lecture de la file (temps réel) et le
 * raccourci clavier. Monté une seule fois au-dessus des routes (App.jsx) — la
 * sidebar, elle, est remontée à chaque navigation, l'état survit ainsi au
 * changement de page.
 */
export function TravauxQuickProvider({ children }) {
  const { user } = useAuth()
  const [open, setOpen] = useState(false)

  // `active=1` : la file vivante seulement (la réponse complète embarque tout
  // l'historique et ses fils — trop lourde pour un panneau global). Panneau
  // ouvert : sondage serré. Panneau fermé : le temps réel porte l'essentiel,
  // mais ce compte alimente aussi la pastille permanente de l'icône « Travaux »
  // du rail — un filet lent évite qu'un chiffre périmé y reste affiché après une
  // coupure de la connexion temps réel. Erreurs silencieuses : lecture de fond.
  const { data, load } = useTravauxPrompts({
    activeOnly: true,
    enabled: !!user,
    pollMs: open ? 20_000 : 60_000,
  })

  useEffect(() => {
    function onKey(e) {
      if ((e.metaKey || e.ctrlKey) && e.key === '/') {
        e.preventDefault()
        setOpen(o => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // Échap ferme — sauf pendant le ciblage d'un élément, que le picker gère lui-même
  // (il arrête la propagation en phase capture).
  useEffect(() => {
    if (!open) return undefined
    function onKey(e) { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])

  const askingCount = useMemo(() => (data.prompts || []).filter(isAsking).length, [data.prompts])
  const activeCount = useMemo(
    () => (data.prompts || []).filter(p => ['running', 'queued'].includes(p.status) && !isAsking(p)).length,
    [data.prompts])

  const value = useMemo(() => ({ open, setOpen, askingCount, activeCount }), [open, askingCount, activeCount])

  return (
    <Ctx.Provider value={value}>
      {children}
      {user && open && (
        <QuickPanel onClose={() => setOpen(false)} data={data} load={load} />
      )}
    </Ctx.Provider>
  )
}
