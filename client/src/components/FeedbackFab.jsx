import { useState, useEffect, useRef } from 'react'
import { useLocation, Link } from 'react-router-dom'
import { MessageSquarePlus, CheckCircle, ArrowRight, Wrench, HelpCircle, MousePointerClick, Crosshair, X, Globe } from 'lucide-react'
import { Modal } from './Modal.jsx'
import { api } from '../lib/api.js'
import { getIsOffline } from '../lib/serverStatus.js'
import { useToast } from '../contexts/ToastContext.jsx'

// FAB discret « Modifier le système », monté dans Layout donc visible sur
// toutes les pages. Envoie le texte vers les suggestions de l'agent
// (POST /api/agent/backlog) avec la route courante en contexte — l'agent
// implémente directement (opus, effort élevé), sans proposition ni
// approbation. Si une implémentation est déjà en cours, la tâche est mise
// en file d'attente automatiquement par le runner (voir busy dans
// taskRunner.js).
//
// Le clic sur le FAB ouvre directement le formulaire : par défaut la demande
// est considérée comme générale (concernant la page courante, aucun élément
// ciblé). L'utilisateur peut ensuite, au besoin, cliquer sur « Cibler un
// élément sur la page » pour passer en mode « picking » (bandeau flottant +
// surbrillance au survol) : l'élément cliqué est alors décrit et joint en
// contexte pour qu'il n'ait qu'à expliquer QUOI changer, pas OÙ.

// Persistance par onglet de l'état de la modale (ouverte + brouillon + envoyé).
// La connexion au serveur se perd typiquement PENDANT que l'utilisateur tape
// une suggestion (l'agent redémarre pm2 / redéploie le frontend) : la modale
// doit survivre au reload forcé par ServerOfflineOverlay quand le bundle JS a
// changé, et à la navigation (Layout est remonté à chaque page).
const STORAGE_KEY = 'erp_feedback_fab_state'

function readPersisted() {
  try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null') || {} } catch { return {} }
}

// Description compacte de l'élément DOM cliqué, jointe en contexte de la
// suggestion pour que l'agent le retrouve dans le code sans que l'utilisateur
// ait à le décrire. Priorise les ancres exploitables (data-testid, id, aria).
function describeElement(el) {
  if (!(el instanceof Element)) return ''
  const attrs = []
  for (const name of ['data-testid', 'id', 'aria-label', 'placeholder', 'title', 'name']) {
    const v = el.getAttribute(name)
    if (v) attrs.push(`${name}="${v}"`)
  }
  const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 4).join(' ')
  if (cls) attrs.push(`class="${cls}"`)
  let desc = `<${el.tagName.toLowerCase()}${attrs.length ? ' ' + attrs.join(' ') : ''}>`
  const text = (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 80)
  if (text) desc += ` « ${text} »`
  // Ancre ancêtre identifiable la plus proche (repère supplémentaire dans le code).
  for (let anc = el.parentElement; anc && anc !== document.body; anc = anc.parentElement) {
    const tid = anc.getAttribute('data-testid')
    if (tid || anc.id) {
      desc += ` — dans <${anc.tagName.toLowerCase()} ${tid ? `data-testid="${tid}"` : `id="${anc.id}"`}>`
      break
    }
  }
  return desc.slice(0, 400)
}

export function FeedbackFab() {
  const location = useLocation()
  const { addToast } = useToast()
  const [open, setOpen] = useState(() => !!readPersisted().open)
  const [text, setText] = useState(() => readPersisted().text || '')
  // mode : 'implement' (l'agent code un correctif) ou 'question' (l'agent répond
  // sans rien modifier — la réponse apparaît sur la carte de la page Agent).
  const [mode, setMode] = useState(() => readPersisted().mode === 'question' ? 'question' : 'implement')
  // Descriptif de l'élément de la page cliqué en étape 1 ('' = demande générale).
  const [element, setElement] = useState(() => readPersisted().element || '')
  // Portée de la demande : false = liée à la page courante (défaut), true = concerne
  // l'ensemble de l'app. Change le contexte joint (chemin de page vs mention globale).
  const [appWide, setAppWide] = useState(() => !!readPersisted().appWide)
  // Mode « picking » : transitoire (non persisté), bandeau + surbrillance actifs.
  const [picking, setPicking] = useState(false)
  // Le picking a-t-il été (re)lancé depuis le formulaire ? → Échap y retourne.
  const fromFormRef = useRef(false)
  const [saving, setSaving] = useState(false)
  const [sent, setSent] = useState(() => !!readPersisted().sent)
  const isQuestion = mode === 'question'

  useEffect(() => {
    try {
      if (open) sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ open, text, sent, mode, element, appWide }))
      else sessionStorage.removeItem(STORAGE_KEY)
    } catch { /* stockage indisponible (mode privé strict) — dégradation silencieuse */ }
  }, [open, text, sent, mode, element, appWide])

  // Étape « picking » : capture des événements au niveau document (phase
  // capture) pour intercepter le clic AVANT les handlers de la page (aucune
  // navigation / action ne doit se déclencher). Surbrillance de l'élément
  // survolé via un overlay non interactif repositionné au survol et au scroll.
  useEffect(() => {
    if (!picking) return
    const hl = document.createElement('div')
    hl.style.cssText = 'position:fixed;z-index:9990;pointer-events:none;display:none;' +
      'border:2px solid #21B14B;background:rgba(33,177,75,0.10);border-radius:4px;transition:all 60ms ease-out'
    document.body.appendChild(hl)
    const style = document.createElement('style')
    style.textContent = 'body.__feedback-picking *{cursor:crosshair!important}' +
      '[data-feedback-picker], [data-feedback-picker] *{cursor:default!important}' +
      '[data-feedback-picker] button{cursor:pointer!important}'
    document.head.appendChild(style)
    document.body.classList.add('__feedback-picking')

    let hoverEl = null
    const inPicker = t => t instanceof Element && t.closest('[data-feedback-picker]')
    function position(t) {
      const r = t.getBoundingClientRect()
      hl.style.display = 'block'
      hl.style.left = `${r.left - 2}px`
      hl.style.top = `${r.top - 2}px`
      hl.style.width = `${r.width}px`
      hl.style.height = `${r.height}px`
    }
    function onMove(e) {
      const t = e.target
      if (!(t instanceof Element) || inPicker(t) || t === document.body || t === document.documentElement) {
        hoverEl = null
        hl.style.display = 'none'
        return
      }
      hoverEl = t
      position(t)
    }
    function onScroll() { if (hoverEl) position(hoverEl) }
    function onDown(e) {
      if (inPicker(e.target)) return
      e.preventDefault()
      e.stopPropagation()
    }
    function onClick(e) {
      if (inPicker(e.target)) return
      e.preventDefault()
      e.stopPropagation()
      const target = hoverEl || (e.target instanceof Element ? e.target : null)
      setElement(describeElement(target))
      setPicking(false)
      setOpen(true)
    }
    function onKey(e) {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setPicking(false)
      if (fromFormRef.current) setOpen(true)
    }
    document.addEventListener('mouseover', onMove, true)
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('scroll', onScroll, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mouseover', onMove, true)
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('keydown', onKey, true)
      hl.remove()
      style.remove()
      document.body.classList.remove('__feedback-picking')
    }
  }, [picking])

  function reset() {
    setText('')
    setSent(false)
    setMode('implement')
    setElement('')
    setAppWide(false)
  }

  function close() {
    // Connexion au serveur perdue : ignorer toute fermeture (ex. Échap pendant
    // que l'overlay hors-ligne recouvre la modale) — fermer effacerait le
    // brouillon en cours de frappe.
    if (getIsOffline()) return
    setOpen(false)
    reset()
  }

  // Ouvre directement le formulaire en demande générale (page courante, aucun
  // élément ciblé). Le ciblage d'un élément reste accessible depuis le
  // formulaire via « Cibler un élément sur la page ».
  function openForm() {
    setPicking(false)
    setOpen(true)
  }

  // (Re)lancer le ciblage depuis le formulaire — le brouillon reste en état.
  function repickFromForm() {
    fromFormRef.current = true
    setOpen(false)
    setPicking(true)
  }

  function skipPicking() {
    setPicking(false)
    setOpen(true)
  }

  function cancelPicking() {
    setPicking(false)
    if (fromFormRef.current) setOpen(true)
  }

  async function submit(e) {
    e.preventDefault()
    const trimmed = text.trim()
    if (!trimmed || saving) return
    setSaving(true)
    try {
      await api.agent.addBacklog(trimmed, {
        context: (appWide
          ? `Demande concernant l'ensemble de l'application (pas seulement la page ${location.pathname}${location.search || ''})`
          : `${location.pathname}${location.search || ''}`)
          + (element ? ` — élément ciblé par l'utilisateur : ${element}` : ''),
        mode,
      })
      setSent(true)
    } catch {
      addToast({ message: 'Échec de l\'envoi de la suggestion', type: 'error' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <>
      {/* z-[9989] : au-dessus des modales/drawers de l'app (z-50) pour rester
          cliquable même quand une modale est ouverte — la demande peut concerner
          un élément DANS une modale. Reste sous la bannière de picking (9991) et
          l'overlay de surbrillance (9990). Masqué pendant que SA propre modale
          est ouverte (open) pour ne pas chevaucher son pied de page. */}
      <button
        type="button"
        data-testid="feedback-fab"
        data-feedback-picker
        onClick={openForm}
        title="Modifier le système"
        aria-label="Modifier le système"
        className={`fixed bottom-5 right-5 z-[9989] w-11 h-11 rounded-full bg-brand-600 text-white shadow-lg
          items-center justify-center hover:bg-brand-700 hover:scale-105 active:scale-95
          transition-all opacity-60 hover:opacity-100 print:hidden ${open ? 'hidden' : 'flex'}`}
      >
        <MessageSquarePlus size={18} />
      </button>

      {/* Bandeau flottant de l'étape « cliquer sur un élément ». */}
      {picking && (
        <div
          data-feedback-picker
          data-testid="feedback-pick-banner"
          className="fixed top-4 left-1/2 -translate-x-1/2 z-[9991] flex items-center gap-3 bg-slate-900 text-white
            rounded-xl shadow-2xl pl-4 pr-2 py-2 text-sm max-w-[calc(100vw-2rem)]"
        >
          <MousePointerClick size={16} className="text-brand-400 flex-shrink-0" />
          <span className="whitespace-nowrap truncate">
            Cliquez sur l'élément concerné par votre demande
          </span>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              type="button"
              data-testid="feedback-skip-pick"
              onClick={skipPicking}
              className="px-2.5 py-1 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-medium transition-colors"
            >
              Demande générale
            </button>
            <button
              type="button"
              data-testid="feedback-cancel-pick"
              onClick={cancelPicking}
              aria-label="Annuler"
              title="Annuler (Échap)"
              className="p-1.5 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition-colors"
            >
              <X size={14} />
            </button>
          </div>
        </div>
      )}

      <Modal
        isOpen={open}
        onClose={close}
        title="Modifier le système"
        size="sm"
      >
        {!sent ? (
          /* Bouton Envoyer requis : c'est une création de record (exception
             admise à la règle autosave). */
          <form onSubmit={submit} className="space-y-4">
            {/* Choix du mode : demande d'implémentation vs simple question.
                Une question n'implémente rien — l'agent répond dans le compte-rendu
                de la carte (page Agent). */}
            <div className="grid grid-cols-2 gap-1 p-1 bg-slate-100 rounded-lg" role="radiogroup" aria-label="Type de demande">
              <button
                type="button"
                data-testid="feedback-mode-implement"
                role="radio"
                aria-checked={!isQuestion}
                onClick={() => setMode('implement')}
                className={`flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-sm font-medium transition-colors ${!isQuestion ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
              >
                <Wrench size={14} /> Implémentation
              </button>
              <button
                type="button"
                data-testid="feedback-mode-question"
                role="radio"
                aria-checked={isQuestion}
                onClick={() => setMode('question')}
                className={`flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-sm font-medium transition-colors ${isQuestion ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
              >
                <HelpCircle size={14} /> Question
              </button>
            </div>

            {/* Élément ciblé en étape 1 — joint en contexte, retirable. */}
            {element ? (
              <div data-testid="feedback-element-chip" className="flex items-start gap-2 bg-brand-50 border border-brand-200 rounded-lg px-3 py-2">
                <MousePointerClick size={14} className="text-brand-600 flex-shrink-0 mt-0.5" />
                <div className="flex-1 min-w-0">
                  <div className="text-[11px] font-semibold text-brand-800">Élément ciblé — joint en contexte</div>
                  <div className="text-xs font-mono text-slate-600 break-all line-clamp-2">{element}</div>
                </div>
                <button
                  type="button"
                  data-testid="feedback-element-remove"
                  onClick={() => setElement('')}
                  aria-label="Retirer l'élément ciblé"
                  title="Retirer l'élément ciblé"
                  className="text-slate-400 hover:text-slate-600 flex-shrink-0 mt-0.5"
                >
                  <X size={14} />
                </button>
              </div>
            ) : (
              <button
                type="button"
                data-testid="feedback-pick-element"
                onClick={repickFromForm}
                className="inline-flex items-center gap-1.5 text-xs text-brand-600 hover:text-brand-700 font-medium"
              >
                <Crosshair size={13} /> Cibler un élément sur la page
              </button>
            )}

            <p className="text-sm text-slate-500" data-testid="feedback-mode-hint">
              {isQuestion
                ? (element
                  ? 'Posez votre question sur l\'élément ciblé — pas besoin de le décrire, il est joint. L\'agent répondra sans rien modifier.'
                  : 'Posez votre question sur le système. L\'agent y répondra sans rien modifier — la réponse apparaîtra sur la carte.')
                : (element
                  ? 'Décrivez ce que vous voulez changer — pas besoin de décrire l\'élément, il est joint en contexte.'
                  : 'Décrivez le problème ou l\'amélioration souhaitée. L\'agent implémentera le correctif.')}
            </p>
            <textarea
              data-testid="feedback-fab-text"
              value={text}
              onChange={e => setText(e.target.value)}
              rows={5}
              autoFocus
              className="input w-full resize-y"
              placeholder={isQuestion
                ? 'Ex. : Comment le total d\'une facture est-il calculé quand il y a un rabais ?'
                : (element
                  ? 'Ex. : Rendre ce bouton plus visible et l\'aligner à droite…'
                  : 'Ex. : Le filtre par date ne garde pas ma sélection quand je change de page…')}
            />
            <div className="flex items-center justify-between gap-3 pt-1">
              {/* Portée de la demande : par défaut la page courante est jointe en
                  contexte ; le bouton bascule vers « toute l'application » quand
                  la demande n'est pas propre à cette page. */}
              <button
                type="button"
                data-testid="feedback-scope-toggle"
                onClick={() => setAppWide(v => !v)}
                title={appWide
                  ? 'La demande concerne toute l\'application — cliquer pour la relier à la page courante'
                  : 'La demande concerne cette page — cliquer pour l\'appliquer à toute l\'application'}
                className={`inline-flex items-center gap-1.5 text-xs font-medium truncate transition-colors min-w-0 ${appWide ? 'text-brand-600' : 'text-slate-400 hover:text-slate-600'}`}
              >
                {appWide ? (
                  <>
                    <Globe size={12} className="flex-shrink-0" />
                    <span className="truncate">Toute l'application</span>
                  </>
                ) : (
                  <span className="font-mono truncate">{location.pathname}{location.search}</span>
                )}
              </button>
              <div className="flex gap-3 flex-shrink-0">
                <button type="button" onClick={close} className="btn-secondary">Annuler</button>
                <button
                  type="submit"
                  data-testid="feedback-fab-submit"
                  disabled={saving || !text.trim()}
                  className="btn-primary"
                >
                  {saving ? 'Envoi…' : 'Envoyer'}
                </button>
              </div>
            </div>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-600 whitespace-pre-wrap">
              {text}
            </div>
            <div className="flex items-center gap-2 text-emerald-600 text-sm font-medium bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2.5" data-testid="feedback-approved">
              <CheckCircle size={16} className="flex-shrink-0" />
              {isQuestion
                ? 'L\'agent prépare la réponse — elle apparaîtra sur la carte de la page Agent (rien ne sera modifié).'
                : 'L\'agent implémente le correctif (ou le mettra en file d\'attente si une autre implémentation est en cours).'}
            </div>
            <div className="flex gap-2">
              <button onClick={close} className="flex-1 sm:flex-none btn-secondary">Fermer</button>
            </div>
            <Link
              to="/agent"
              onClick={close}
              data-testid="feedback-open-agent"
              className="inline-flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700 font-medium"
            >
              Voir les suggestions et correctifs <ArrowRight size={12} />
            </Link>
          </div>
        )}
      </Modal>
    </>
  )
}
