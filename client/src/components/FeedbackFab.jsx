import { useState, useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'
import { MessageSquarePlus, Wrench, HelpCircle, MousePointerClick, Crosshair, X, Globe, File, Component } from 'lucide-react'
import { Modal } from './Modal.jsx'
import { api } from '../lib/api.js'
import { getIsOffline } from '../lib/serverStatus.js'
import { useToast } from '../contexts/ToastContext.jsx'
// Ciblage d'un élément de la page + ligne de contexte : mécanisme partagé avec le
// panneau rapide de la file de travaux (lib/pageContext.jsx).
import { useElementPicker, buildPageContext, PickerBanner } from '../lib/pageContext.jsx'
// Moment du départ (« maintenant / ce soir 19 h ») : bascule partagée avec la page
// /travaux et le panneau rapide — un seul geste à apprendre, où qu'on dépose une
// tâche. Le placement dans la file (« au début / à la fin ») a été retiré d'ici :
// une demande déposée à la main part à la fin, comme tout le reste.
import { StartToggle, eveningStart } from '../lib/travauxQueue.jsx'
import { CodexUsageStrip } from './ClaudeUsage.jsx'

// Modèle qui traitera la demande, choisi ici même : deux choix seulement, Opus
// (défaut) ou Astra. Les petits modèles (Sonnet, Haiku) ne sont plus proposés —
// personne ne les choisissait pour une demande écrite à la main. Le repli quota
// s'applique ensuite comme d'habitude côté serveur.
const MODELS = ['opus', 'codex']
const MODEL_NAMES = { opus: 'Opus', codex: 'Astra' }
const DEFAULT_MODEL = 'opus'

// FAB discret « Modifier le système », monté dans Layout donc visible sur
// toutes les pages. Une seule destination : la demande est déposée comme prompt
// dans la file de la section Travaux (/travaux), avec la page courante et
// l'élément ciblé inclus dans le texte du prompt — c'est lui que l'agent reçoit.
// Le serveur relance l'ordonnanceur à la création : si rien ne tourne, la tâche
// part tout de suite ; sinon elle attend son tour, à la fin de la file. Le choix de
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

// `contextRecord` : libellé de ce qui est affiché à l'écran, joint au contexte
// de la demande. Utile sur les pages publiques montées hors Layout (formulaire
// de découverte : /d/:token), dont la route seule — un jeton opaque — ne dit pas
// à l'agent de quelle page il s'agit.
export function FeedbackFab({ contextRecord = '' }) {
  const location = useLocation()
  const { addToast } = useToast()
  const [open, setOpen] = useState(() => !!readPersisted().open)
  const [text, setText] = useState(() => readPersisted().text || '')
  // mode : 'implement' (l'agent code un correctif) ou 'question' (l'agent répond
  // sans rien modifier — la réponse apparaît sur la carte de la page Travaux).
  const [mode, setMode] = useState(() => readPersisted().mode === 'question' ? 'question' : 'implement')
  // Descriptif de l'élément de la page cliqué en étape 1 ('' = demande générale).
  const [element, setElement] = useState(() => readPersisted().element || '')
  // Composants React qui englobent l'élément ciblé, du plus proche au plus lointain.
  const [chain, setChain] = useState(() => readPersisted().chain || [])
  // Portée : 'page' (défaut), 'app', ou le nom d'un composant partagé de `chain`
  // — le changement est alors demandé sur le composant lui-même, pour partout.
  const [scope, setScope] = useState(() => {
    const p = readPersisted()
    return p.scope || (p.appWide ? 'app' : 'page')
  })
  // Quand la tâche démarre : 'now' (défaut, dès qu'un poste est libre) ou 'evening'
  // — elle entre dans la file tout de suite, mais ne partira qu'à 19 h.
  const [start, setStart] = useState(() => readPersisted().start === 'evening' ? 'evening' : 'now')
  // Modèle qui traitera la demande — Opus par défaut.
  const [model, setModel] = useState(() => {
    const m = readPersisted().model
    return MODELS.includes(m) ? m : DEFAULT_MODEL
  })
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
      if (open) sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ open, text, mode, element, chain, scope, model, start }))
      else sessionStorage.removeItem(STORAGE_KEY)
    } catch { /* stockage indisponible (mode privé strict) — dégradation silencieuse */ }
  }, [open, text, mode, element, chain, scope, model, start])

  // Étape « picking » — surbrillance, neutralisation des clics de la page et
  // description de l'élément choisi : lib/pageContext.jsx.
  useElementPicker(picking, {
    onPick: (desc, names) => { setElement(desc); setChain(names || []); setPicking(false); setOpen(true) },
    onCancel: () => { setPicking(false); if (fromFormRef.current) setOpen(true) },
  })

  function reset() {
    setText('')
    setMode('implement')
    setElement('')
    setChain([])
    setScope('page')
    setModel(DEFAULT_MODEL)
    setStart('now')
  }

  function removeElement() {
    setElement('')
    setChain([])
    if (scope !== 'app') setScope('page')
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
      pathname: location.pathname, search: location.search, element, chain, scope,
      record: contextRecord,
    })
    // Fermeture IMMÉDIATE, sans attendre le serveur : le dépôt dans la file ne
    // peut rien apprendre qui change la fenêtre, et l'aller-retour (réponse, puis
    // rafraîchissements déclenchés en temps réel) laissait la modale figée sur
    // « Envoi… » une demi-seconde ou plus quand le serveur est occupé. Le
    // brouillon est mis de côté : si l'envoi échoue, la fenêtre revient telle
    // qu'elle était, rien n'est perdu.
    const draft = { text, mode, element, chain, scope, model, start }
    setOpen(false)
    reset()
    try {
      // Dépose un prompt dans la file de la page Travaux — le contexte (page +
      // élément ciblé) est inclus dans le prompt, c'est lui que l'agent recevra.
      // Le serveur relance l'ordonnanceur : la tâche part tout de suite si rien
      // ne tourne, sinon elle attend son tour en fin de file.
      const created = await api.travaux.createPrompt({
        prompt: `${trimmed}\n\nContexte (ERP) : ${context}`,
        mode,
        space: 'finance',
        // Modèle choisi pour CETTE demande : il l'emporte sur le modèle préféré de
        // l'agent, l'effort restant celui du calibre décidé côté serveur.
        model,
        // Départ programmé : l'item entre dans la file tout de suite, mais
        // l'ordonnanceur ne le prendra pas avant cette heure (absent = tout de suite).
        start_at: start === 'evening' ? eveningStart() : null,
      })
      // Pas d'écran de confirmation : la fenêtre est déjà refermée, le toast
      // accuse réception dès que le serveur a confirmé le dépôt.
      addToast({
        message: draft.start === 'evening'
          ? 'Ajoutée à la file — départ programmé à 19 h'
          : created?.status === 'running'
            ? 'Demande envoyée — l\'agent s\'y met tout de suite'
            : 'Ajoutée à la file de Travaux',
        type: 'success',
      })
    } catch {
      // Envoi manqué : on rend la fenêtre et le brouillon exactement comme ils
      // étaient — refermer sans rien déposer perdrait le texte saisi.
      setText(draft.text)
      setMode(draft.mode)
      setElement(draft.element)
      setChain(draft.chain)
      setScope(draft.scope)
      setModel(draft.model)
      setStart(draft.start)
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

      {/* z 95 : au-dessus de la pile des panneaux latéraux (RecordPeekDrawer
          empile à 50 + profondeur×2), sinon la fenêtre s'ouvrait DERRIÈRE un
          panneau empilé — invisible, et le clic suivant tombait sur le voile du
          panneau du dessus, qui se refermait. Reste sous l'overlay hors-ligne et
          les toasts (100), le FAB (9989) et le bandeau de ciblage (9991). */}
      <Modal
        isOpen={open}
        onClose={close}
        title="Modifier le système"
        size="sm"
        zIndex={95}
      >
        {/* Bouton Envoyer requis : c'est une création de record (exception
            admise à la règle autosave). Ni écran de confirmation, ni attente :
            la fenêtre se referme au clic et l'envoi finit en arrière-plan (un
            toast accuse réception ; un échec rouvre la fenêtre intacte). */}
        <form onSubmit={submit} className="space-y-4">
          {/* Choix du mode : demande d'implémentation vs simple question.
              Une question n'implémente rien — l'agent répond dans le compte-rendu
              de la carte (page Travaux). */}
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
                onClick={removeElement}
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
          />
          {model === 'codex' && <CodexUsageStrip />}
          {/* Sous le champ, deux réglages discrets : le modèle qui traitera la
              demande (bascule Opus / Astra, Opus par défaut) et le moment du
              départ (tout de suite, ou programmé à 19 h — même contrôle que
              /travaux). */}
          <div className="flex justify-end items-center gap-2 -mt-2 flex-wrap">
            <div
              className="inline-flex items-center gap-0.5 p-0.5 bg-slate-100 rounded-lg"
              role="radiogroup"
              aria-label="Modèle"
            >
              {MODELS.map(m => (
                <button
                  key={m}
                  type="button"
                  data-testid={`feedback-model-${m}`}
                  role="radio"
                  aria-checked={model === m}
                  onClick={() => setModel(m)}
                  className={`px-2 py-1 rounded-md text-xs font-medium transition-colors ${model === m ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  {MODEL_NAMES[m]}
                </button>
              ))}
            </div>
            <StartToggle
              testId="feedback-start"
              value={start}
              onChange={setStart}
            />
          </div>
          <div className="space-y-2 pt-1">
            {/* Portée : toutes les options côte à côte — la page, chaque
                composant partagé qui englobe l'élément ciblé (le changement se
                fait alors sur le composant, donc partout), toute l'app. */}
            <div
              className="flex items-center gap-0.5 p-0.5 bg-slate-100 rounded-lg flex-wrap"
              role="radiogroup"
              aria-label="Portée de la demande"
            >
              <button
                type="button"
                data-testid="feedback-scope-page"
                role="radio"
                aria-checked={scope === 'page'}
                onClick={() => setScope('page')}
                title="La demande concerne la page courante"
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium min-w-0 transition-colors ${scope === 'page' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
              >
                <File size={12} className="flex-shrink-0" />
                <span className="font-mono truncate max-w-[10rem]">{location.pathname}{location.search}</span>
              </button>
              {chain.slice(0, 5).map(name => (
                <button
                  key={name}
                  type="button"
                  data-testid={`feedback-scope-component-${name}`}
                  role="radio"
                  aria-checked={scope === name}
                  onClick={() => setScope(name)}
                  title={`Modifier le composant ${name} — partout où il est utilisé`}
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${scope === name ? 'bg-white text-violet-700 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
                >
                  <Component size={12} className="flex-shrink-0" />
                  <span className="font-mono">{name}</span>
                </button>
              ))}
              <button
                type="button"
                data-testid="feedback-scope-app"
                role="radio"
                aria-checked={scope === 'app'}
                onClick={() => setScope('app')}
                title="La demande concerne toute l'application, pas seulement cette page"
                className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${scope === 'app' ? 'bg-white text-brand-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}
              >
                <Globe size={12} className="flex-shrink-0" />
                Toute l'app
              </button>
            </div>
            {scope !== 'page' && scope !== 'app' && (
              <p className="text-xs text-violet-700" data-testid="feedback-scope-hint">
                Le changement s'appliquera partout où « {scope} » est utilisé.
              </p>
            )}
            <div className="flex justify-end gap-3">
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
