import { useState, useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { MessageSquarePlus, Wrench, HelpCircle, MousePointerClick, Crosshair, X, Globe } from 'lucide-react'
import { Modal } from './Modal.jsx'
import { api } from '../lib/api.js'
import { getIsOffline } from '../lib/serverStatus.js'
import { useToast } from '../contexts/ToastContext.jsx'
// Ciblage d'un élément de la page + ligne de contexte : mécanisme partagé avec le
// panneau rapide de la file de travaux (lib/pageContext.jsx).
import { useElementPicker, buildPageContext, PickerBanner } from '../lib/pageContext.jsx'
// Bouton « au début / à la fin de la file » : le même que la page /travaux et le
// panneau rapide — un seul geste à apprendre, où qu'on dépose une tâche.
import { PlacementToggle } from '../lib/travauxQueue.jsx'

// FAB discret « Modifier le système », monté dans Layout donc visible sur
// toutes les pages. Une seule destination : la demande est déposée comme prompt
// dans la file de la section Travaux (/travaux), avec la page courante et
// l'élément ciblé inclus dans le texte du prompt — c'est lui que l'agent reçoit.
// Le serveur relance l'ordonnanceur à la création : si rien ne tourne, la tâche
// part tout de suite ; sinon elle attend son tour — à la fin de la file par
// défaut, ou devant tout le reste si on a basculé le bouton de placement. Le choix de
// destination (« Tout de suite » vs « Ma file Travaux ») a été retiré — les deux
// menaient au même exécuteur, à ceci près que la voie « tout de suite » doublait
// la file au lieu de la respecter.
//
// Le clic sur le FAB ouvre directement le formulaire : par défaut la demande
// est considérée comme générale (concernant la page courante, aucun élément
// ciblé). L'utilisateur peut ensuite, au besoin, cliquer sur « Cibler un
// élément sur la page » pour passer en mode « picking » (bandeau flottant +
// surbrillance au survol) : l'élément cliqué est alors décrit et joint en
// contexte pour qu'il n'ait qu'à expliquer QUOI changer, pas OÙ.

// Persistance par onglet de l'état de la modale (ouverte + brouillon).
// La connexion au serveur se perd typiquement PENDANT que l'utilisateur tape
// une suggestion (l'agent redémarre pm2 / redéploie le frontend) : la modale
// doit survivre au reload forcé par ServerOfflineOverlay quand le bundle JS a
// changé, et à la navigation (Layout est remonté à chaque page).
const STORAGE_KEY = 'erp_feedback_fab_state'

function readPersisted() {
  try { return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || 'null') || {} } catch { return {} }
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
  // Où la demande se dépose dans la file : 'last' (défaut, on respecte l'ordre
  // déjà en place) ou 'first' (elle passe devant tout le reste).
  const [placement, setPlacement] = useState(() => readPersisted().placement === 'first' ? 'first' : 'last')
  // Mode « picking » : transitoire (non persisté), bandeau + surbrillance actifs.
  const [picking, setPicking] = useState(false)
  // Le picking a-t-il été (re)lancé depuis le formulaire ? → Échap y retourne.
  const fromFormRef = useRef(false)
  // Un envoi est-il en vol ? La modale étant refermée sur-le-champ, ce n'est pas
  // un état d'affichage — juste un garde-fou contre un double envoi (deux
  // « Entrée » dans le même rendu).
  const sendingRef = useRef(false)
  const isQuestion = mode === 'question'

  useEffect(() => {
    try {
      if (open) sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ open, text, mode, element, appWide, placement }))
      else sessionStorage.removeItem(STORAGE_KEY)
    } catch { /* stockage indisponible (mode privé strict) — dégradation silencieuse */ }
  }, [open, text, mode, element, appWide, placement])

  // Étape « picking » — surbrillance, neutralisation des clics de la page et
  // description de l'élément choisi : lib/pageContext.jsx.
  useElementPicker(picking, {
    onPick: (desc) => { setElement(desc); setPicking(false); setOpen(true) },
    onCancel: () => { setPicking(false); if (fromFormRef.current) setOpen(true) },
  })

  function reset() {
    setText('')
    setMode('implement')
    setElement('')
    setAppWide(false)
    setPlacement('last')
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
    if (!trimmed || sendingRef.current) return
    sendingRef.current = true
    const context = buildPageContext({
      pathname: location.pathname, search: location.search, element, appWide,
    })
    // Fermeture IMMÉDIATE, sans attendre le serveur : le dépôt dans la file ne
    // peut rien apprendre qui change la fenêtre, et l'aller-retour (réponse, puis
    // rafraîchissements déclenchés en temps réel) laissait la modale figée sur
    // « Envoi… » une demi-seconde ou plus quand le serveur est occupé. Le
    // brouillon est mis de côté : si l'envoi échoue, la fenêtre revient telle
    // qu'elle était, rien n'est perdu.
    const draft = { text, mode, element, appWide, placement }
    setOpen(false)
    reset()
    try {
      // Dépose un prompt dans la file de la section Travaux — le contexte (page +
      // élément ciblé) est inclus dans le prompt, c'est lui que l'agent recevra.
      // Le serveur relance l'ordonnanceur : la tâche part tout de suite si rien
      // ne tourne, sinon elle attend son tour en fin de file.
      const created = await api.travaux.createPrompt({
        prompt: `${trimmed}\n\nContexte (ERP) : ${context}`,
        mode,
        // Les demandes de modification du système appartiennent à la section Agent :
        // elles doivent apparaître dans sa file (/agent/travaux), pas dans celle de
        // l'Espace finance.
        space: 'agent',
        // Le serveur dépose l'item devant la file quand priority est vrai.
        priority: placement === 'first',
      })
      // Pas d'écran de confirmation : la fenêtre est déjà refermée, le toast
      // accuse réception dès que le serveur a confirmé le dépôt.
      addToast({
        message: created?.status === 'running'
          ? 'Demande envoyée — l\'agent s\'y met tout de suite'
          : draft.placement === 'first' ? 'Ajoutée en tête de la file de l\'Agent' : 'Ajoutée à la file de l\'Agent',
        type: 'success',
      })
    } catch {
      // Envoi manqué : on rend la fenêtre et le brouillon exactement comme ils
      // étaient — refermer sans rien déposer perdrait le texte saisi.
      setText(draft.text)
      setMode(draft.mode)
      setElement(draft.element)
      setAppWide(draft.appWide)
      setPlacement(draft.placement)
      setOpen(true)
      addToast({ message: 'Échec de l\'envoi de la suggestion', type: 'error' })
    } finally {
      sendingRef.current = false
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

      {/* Bandeau flottant de l'étape « cliquer sur un élément » (partagé). */}
      {picking && <PickerBanner onSkip={skipPicking} onCancel={cancelPicking} />}

      <Modal
        isOpen={open}
        onClose={close}
        title="Modifier le système"
        size="sm"
      >
        {/* Bouton Envoyer requis : c'est une création de record (exception
            admise à la règle autosave). Ni écran de confirmation, ni attente :
            la fenêtre se referme au clic et l'envoi finit en arrière-plan (un
            toast accuse réception ; un échec rouvre la fenêtre intacte). */}
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
          {/* Placement dans la file — bouton discret, sous le champ : la
              demande part à la fin de la file par défaut, un clic la met au
              début. Même contrôle que la page /travaux. */}
          <div className="flex justify-end -mt-2">
            <PlacementToggle
              testId="feedback-placement"
              value={placement}
              onChange={setPlacement}
            />
          </div>
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
                disabled={!text.trim()}
                className="btn-primary"
              >
                Envoyer
              </button>
            </div>
          </div>
        </form>
      </Modal>
    </>
  )
}
