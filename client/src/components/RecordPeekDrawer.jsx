import { useEffect, useMemo, useRef, useState, useCallback, Suspense } from 'react'
import { createPortal } from 'react-dom'
import { useHref } from 'react-router-dom'
import { X, SlidersHorizontal } from 'lucide-react'
import api from '../lib/api.js'
import { hasOpenModal } from './Modal.jsx'
import { OVERLAY_BASE, registerOverlay } from '../lib/overlayLayers.js'
import { PeekFieldEditProvider } from '../lib/detailFieldLayout.jsx'
import { PEEK_ROUTES, matchPeekRoute } from '../lib/recordPeekRoutes.jsx'
import Spinner from './Spinner.jsx'

// Drawer latéral (side-peek à la Airtable) : ouvre l'aperçu/édition d'un
// enregistrement par-dessus la liste, sans quitter le contexte de la table.
// Le contenu (`children`) est typiquement une page *Detail.jsx rendue en mode
// `embedded` — l'autosave, le realtime et le chargement restent gérés par la
// fiche elle-même.
//
// Largeur redimensionnable, mémorisée PAR RESSOURCE : l'utilisateur tire la
// frontière gauche du panneau, et la largeur choisie vaut désormais pour cette
// ressource-là (les commandes larges, les contacts étroits), pas pour tous les
// panneaux de l'app. La clé est `peekKey`, à défaut le premier segment de `to`
// (« /orders/42 » → `orders`).
//
// Double persistance, chacune pour ce qu'elle sait faire :
//  - localStorage (`boreal.peekWidths`) — lu SYNCHRONEMENT au premier rendu,
//    donc la bonne largeur est là dès le rechargement de la page, sans attendre
//    l'API (avant, le panneau s'ouvrait à la largeur par défaut puis sautait) ;
//  - préférences utilisateur (PATCH /auth/preferences → peek_widths) — suit
//    l'utilisateur d'un navigateur/poste à l'autre. Au chargement, la carte du
//    serveur fait foi et rafraîchit le cache local.
// Le scalaire historique `peek_width` reste lu comme repli pour les ressources
// jamais redimensionnées ; plus personne ne l'écrit.
//
// Props :
//  - open        : bool — visibilité.
//  - onClose     : () => void — fermeture (overlay, bouton ×, Échap).
//  - title       : string — titre affiché dans l'en-tête du drawer.
//  - subtitle    : string | undefined — sous-titre discret (entreprise, courriel…).
//  - to          : string | undefined — route de la fiche complète ; sert d'URL
//                  affichée dans la barre d'adresse pendant que le drawer est
//                  ouvert (voir « URL partageable » plus bas), et de repère
//                  pour ne pas empiler un panneau sur l'enregistrement déjà
//                  affiché. Le panneau n'offre pas d'ouverture en pleine page.
//  - syncUrl     : bool (défaut true) — réécrire l'URL affichée avec `to`
//                  pendant l'ouverture. À passer à false quand l'URL courante
//                  EST déjà celle de la fiche (panneau ouvert par la route,
//                  voir RecordRoutePanel) : sinon on empilerait une entrée
//                  d'historique en double.
//  - width       : number — largeur par défaut en px (défaut 560), utilisée tant
//                  que l'utilisateur n'a pas défini de préférence POUR CETTE
//                  ressource.
//  - peekKey     : string | undefined — clé sous laquelle mémoriser la largeur.
//                  Par défaut, la ressource déduite de `to`. À fournir pour les
//                  panneaux sans `to` (formulaire d'achat, écriture de journal…)
//                  sans quoi ils partagent tous la clé `default`.
//  - children    : contenu du corps (scrollable).
//
// Mode édition des champs : si la fiche embarquée rend une carte
// <DetailFieldGrid>, l'en-tête affiche un bouton « Personnaliser les champs »
// qui bascule la carte en mode édition (réordonner / retirer / ajouter).

const MIN_WIDTH = 360
// Durée de l'animation de fermeture, alignée sur `.animate-slide-out-right`
// dans index.css : le panneau glisse vers la droite AVANT que le parent ne le
// démonte (ou ne navigue), symétrique de l'ouverture.
const EXIT_MS = 180

// Sans animation demandée par le système : on ferme sec, pas de délai à vide.
function prefersReducedMotion() {
  return typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

// Marge minimale (px) laissée visible à gauche du panneau pour garder l'accès à
// la liste sous-jacente / l'overlay.
const EDGE_MARGIN = 80

// Pile des drawers ouverts (du plus ancien au plus récent). Les panneaux
// s'empilent : depuis la fiche d'une entreprise ouverte en side-peek, cliquer
// un abonnement / une commande ouvre un second panneau par-dessus. Seul le
// panneau du dessus doit réagir à Échap ; sans cette pile, `document`
// recevrait la touche sur toutes les instances et fermerait toute la pile
// d'un coup (stopPropagation n'arrête pas les autres écouteurs du même nœud).
const openStack = []

// Clé de mémorisation d'une largeur : explicite, sinon la ressource de l'URL
// de la fiche (« /orders/42?x=1 » → `orders`), sinon un seau commun.
function widthKey(peekKey, to) {
  if (peekKey) return String(peekKey).slice(0, 64)
  if (typeof to === 'string') {
    const seg = to.split(/[?#]/)[0].split('/').filter(Boolean)[0]
    if (seg) return seg.slice(0, 64)
  }
  return 'default'
}

const LS_WIDTHS = 'boreal.peekWidths'

function readStoredWidths() {
  try {
    const parsed = JSON.parse(localStorage.getItem(LS_WIDTHS) || '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out = {}
    for (const [k, v] of Object.entries(parsed)) {
      const n = Math.round(Number(v))
      if (Number.isFinite(n) && n > 0) out[k] = n
    }
    return out
  } catch { return {} }
}

// Cache module : les largeurs sont partagées par toutes les instances et
// mémorisées entre ouvertures pour éviter de re-fetch et pour un rendu instant.
// `widths` part du localStorage — d'où la persistance au rechargement.
// `legacy` = ancien scalaire `peek_width`, repli des ressources sans entrée.
// `dirty` : clés redimensionnées pendant CETTE session. La réponse du serveur
// ne doit pas les écraser — l'utilisateur vient de tirer la poignée, son geste
// est plus récent que ce que le GET a lu.
const prefCache = { loaded: false, widths: readStoredWidths(), legacy: null, dirty: new Set() }

function storeWidths() {
  try { localStorage.setItem(LS_WIDTHS, JSON.stringify(prefCache.widths)) } catch { /* mode privé / quota */ }
}

// Largeur à appliquer pour une clé : préférence de la ressource, sinon ancienne
// préférence globale, sinon défaut du registre.
function preferredWidth(key, fallback) {
  return prefCache.widths[key] ?? prefCache.legacy ?? fallback
}

function maxWidth() {
  return Math.max(MIN_WIDTH, window.innerWidth - EDGE_MARGIN)
}

function clampWidth(w) {
  return Math.min(Math.max(w, MIN_WIDTH), maxWidth())
}

export default function RecordPeekDrawer({ open, onClose, title, subtitle, to, syncUrl = true, width = 560, peekKey, children }) {
  const wKey = widthKey(peekKey, to)
  // `to` est une route du routeur (« /projects/:id ») ; l'app est servie sous
  // le basename /erp. window.history ne connaît pas ce basename : sans cette
  // résolution, l'URL affichée pendant l'ouverture du drawer tombait à côté
  // (http://host/projects/:id) et n'était donc ni partageable ni rechargeable.
  const toHref = useHref(to || '/')
  // Garde une référence stable sur onClose : l'effet d'URL ne doit pas se
  // rejouer (et re-pousser une entrée d'historique) à chaque rendu du parent.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const panelRef = useRef(null)
  // Identité stable de cette instance dans `openStack`.
  const stackIdRef = useRef({})
  const [panelWidth, setPanelWidth] = useState(() => clampWidth(preferredWidth(wKey, width)))
  // Panneaux ouverts DEPUIS celui-ci (clic sur un lien d'enregistrement dans
  // le corps) — voir « Panneaux empilés » plus bas.
  const [nested, setNested] = useState([])
  const [resizing, setResizing] = useState(false)
  // Rejoue l'animation d'entrée seulement à l'ouverture — évite qu'elle ne
  // reparte (et donne l'impression de rebond) au relâchement de la poignée
  // de redimensionnement, quand `resizing` repasse à false.
  const [entering, setEntering] = useState(false)
  // Profondeur d'empilement : 0 = premier panneau, 1+ = panneau ouvert
  // par-dessus un autre (voile plus léger, panneau légèrement décalé pour
  // laisser deviner le panneau parent).
  const [depth, setDepth] = useState(0)
  // Fermeture en cours : le panneau glisse vers la droite, puis seulement on
  // prévient le parent (qui démonte / navigue).
  const [closing, setClosing] = useState(false)
  const closeTimerRef = useRef(null)

  // Toutes les fermetures « utilisateur » (×, voile, Échap, retour navigateur)
  // passent par ici : jouer l'animation avant de rendre la main au parent.
  const requestClose = useCallback(() => {
    if (closeTimerRef.current) return
    if (prefersReducedMotion()) { onCloseRef.current?.(); return }
    setClosing(true)
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null
      onCloseRef.current?.()
    }, EXIT_MS)
  }, [])

  useEffect(() => () => { if (closeTimerRef.current) clearTimeout(closeTimerRef.current) }, [])

  // ── Mode édition des champs ───────────────────────────────────────────────
  // La fiche embarquée (DetailFieldGrid) s'enregistre ; le bouton n'apparaît
  // que s'il y a une carte de champs personnalisable dessous.
  const [editableFields, setEditableFields] = useState(0)
  const [editingFields, setEditingFields] = useState(false)
  const registerFieldGrid = useCallback(() => {
    setEditableFields(n => n + 1)
    return () => setEditableFields(n => n - 1)
  }, [])
  const fieldEditCtx = useMemo(
    () => ({ editing: editingFields, setEditing: setEditingFields, register: registerFieldGrid }),
    [editingFields, registerFieldGrid],
  )
  // Une nouvelle ouverture repart en lecture, jamais en mode édition.
  useEffect(() => { if (!open) setEditingFields(false) }, [open])

  // Inscription dans la pile des drawers ouverts.
  useEffect(() => {
    if (!open) return
    const me = stackIdRef.current
    openStack.push(me)
    setDepth(openStack.length - 1)
    return () => {
      const i = openStack.indexOf(me)
      if (i >= 0) openStack.splice(i, 1)
    }
  }, [open])

  // Plan d'empilement de ce panneau, publié au registre des couches flottantes
  // pour que toute modale ouverte ensuite (confirmation de suppression…) se
  // place au-dessus — y compris au-dessus du panneau le plus haut d'une pile.
  const panelZ = OVERLAY_BASE + depth * 2
  useEffect(() => {
    if (!open) return
    return registerOverlay(panelZ)
  }, [open, panelZ])

  // Charge les préférences persistées (une seule fois par session). Le cache
  // local a déjà servi au premier rendu : ce fetch ne fait que réconcilier avec
  // ce qui a pu être choisi ailleurs (autre navigateur, autre poste), le
  // serveur faisant foi.
  useEffect(() => {
    if (!open || prefCache.loaded) return
    let cancelled = false
    api.auth.getPreferences()
      .then((d) => {
        prefCache.loaded = true
        const legacy = Number(d?.peek_width)
        if (Number.isFinite(legacy) && legacy > 0) prefCache.legacy = legacy
        const server = d?.peek_widths
        if (server && typeof server === 'object' && !Array.isArray(server)) {
          const merged = { ...prefCache.widths }
          for (const [k, v] of Object.entries(server)) {
            if (prefCache.dirty.has(k)) continue
            const n = Math.round(Number(v))
            if (Number.isFinite(n) && n > 0) merged[k] = n
          }
          prefCache.widths = merged
          storeWidths()
        }
        if (!cancelled) setPanelWidth(clampWidth(preferredWidth(wKey, width)))
      })
      .catch(() => { prefCache.loaded = true })
    return () => { cancelled = true }
  }, [open, wKey, width])

  // Applique la préférence en cache à chaque (ré)ouverture — et à chaque
  // changement de ressource affichée — puis re-borne si la fenêtre a été
  // redimensionnée entre-temps.
  useEffect(() => {
    if (!open) return
    setPanelWidth(clampWidth(preferredWidth(wKey, width)))
  }, [open, width, wKey])

  // ── URL partageable ───────────────────────────────────────────────────────
  // Pendant que le drawer est ouvert, la barre d'adresse affiche l'URL de la
  // fiche (`to`) pour qu'on puisse copier/partager le chemin exact. On pousse
  // l'entrée directement via window.history (sans passer par le router) : le
  // routeur reste sur la liste, donc la page sous-jacente n'est pas démontée.
  // À la fermeture on revient en arrière ; un « précédent » du navigateur
  // ferme le drawer.
  //
  // Seul le panneau du bas de la pile réécrit l'URL. Si un panneau empilé le
  // faisait aussi, sa fermeture déclencherait un history.back() : le routeur
  // écoute popstate et naviguerait alors pour de vrai vers l'URL du panneau
  // parent, démontant la liste — et donc toute la pile de panneaux.
  useEffect(() => {
    if (!open || !to || !syncUrl) return
    if (openStack.indexOf(stackIdRef.current) > 0) return
    const here = () => window.location.pathname + window.location.search + window.location.hash
    if (here() === toHref) return
    window.history.pushState({ ...(window.history.state || {}), peekDrawer: true }, '', toHref)
    let popped = false
    const onPop = () => { popped = true; requestClose() }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      // Ne revenir en arrière que si notre entrée est toujours la courante :
      // une navigation faite depuis le drawer (lien vers une autre fiche) ne
      // doit pas être annulée.
      if (!popped && here() === toHref) window.history.back()
    }
  }, [open, to, toHref, syncUrl, requestClose])

  // Verrou du scroll du body tant que le drawer est ouvert.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  // Joue l'animation de glissement une seule fois par ouverture. Une réouverture
  // (instance réutilisée) repart d'un état non fermant.
  useEffect(() => {
    if (!open) return
    if (closeTimerRef.current) { clearTimeout(closeTimerRef.current); closeTimerRef.current = null }
    setClosing(false)
    setEntering(true)
    const t = setTimeout(() => setEntering(false), 200)
    return () => clearTimeout(t)
  }, [open])

  // Fermeture sur Échap — uniquement pour le panneau du dessus de la pile.
  // stopPropagation pour ne pas fermer aussi une modale sous-jacente éventuelle.
  // Une modale ouverte PAR-DESSUS le panneau (« Modifier le système », un
  // formulaire de la fiche…) a la priorité : Échap la referme, elle seule — sans
  // ce garde-fou les deux écouteurs de `document` se déclenchaient et la touche
  // emportait aussi le panneau.
  useEffect(() => {
    if (!open) return
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      if (hasOpenModal()) return
      if (openStack[openStack.length - 1] !== stackIdRef.current) return
      e.stopPropagation()
      requestClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, requestClose])

  // ── Panneaux empilés ──────────────────────────────────────────────────────
  // Un lien vers un enregistrement cliqué DANS le panneau (le produit d'une
  // ligne de commande, l'entreprise d'un contact…) n'emmène plus sur la fiche
  // pleine page — ce qui démontait la liste et le panneau : il ouvre un second
  // panneau par-dessus. Fermer celui du dessus laisse celui du dessous en
  // place, puisque les panneaux enfants ne sont que l'état de leur parent.
  //
  // Interception en phase de capture : les liens à l'intérieur d'un tableau
  // appellent `stopPropagation` pour ne pas déclencher le clic de ligne, ce qui
  // rendrait un écouteur en bulle aveugle.
  const basename = useHref('/')
  const onBodyClickCapture = useCallback((e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    const a = e.target?.closest?.('a[href]')
    if (!a) return
    if (a.target && a.target !== '_self') return
    if (a.hasAttribute('download') || a.dataset.noPeek !== undefined) return
    let url
    try { url = new URL(a.getAttribute('href'), window.location.origin) } catch { return }
    if (url.origin !== window.location.origin) return
    const hit = matchPeekRoute(url.pathname, basename)
    if (!hit) return
    // Lien vers l'enregistrement déjà affiché : rien à empiler.
    if (to && hit.path === to) return
    e.preventDefault()
    e.stopPropagation()
    setNested(list => [...list, { ...hit, key: `${hit.resource}:${hit.id}:${Date.now()}` }])
  }, [basename, to])
  // Une fermeture (ou un changement d'enregistrement affiché) repart d'une pile vide.
  useEffect(() => { setNested(list => (list.length ? [] : list)) }, [open, to])

  // Persiste la largeur pour CETTE ressource : localStorage d'abord (le
  // rechargement de page doit retrouver la largeur même hors ligne), puis la
  // préférence utilisateur côté serveur. Le PATCH n'envoie que la clé touchée —
  // le serveur fusionne, donc un autre onglet/poste n'est pas écrasé.
  const persistWidth = useCallback((w) => {
    const rounded = Math.round(w)
    if (prefCache.widths[wKey] === rounded) return
    prefCache.widths = { ...prefCache.widths, [wKey]: rounded }
    prefCache.dirty.add(wKey)
    storeWidths()
    api.auth.updatePreferences({ peek_widths: { [wKey]: rounded } })
      .catch((err) => console.error('[peekDrawer] échec sauvegarde largeur:', err))
  }, [wKey])

  // Drag de la poignée gauche : la largeur = distance du bord droit de l'écran
  // au curseur. Persistée au relâchement.
  const startResize = useCallback((e) => {
    e.preventDefault()
    setResizing(true)
    const onMove = (ev) => {
      const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX
      setPanelWidth(clampWidth(window.innerWidth - clientX))
    }
    const onUp = () => {
      setResizing(false)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onUp)
      setPanelWidth((w) => { persistWidth(w); return w })
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.addEventListener('touchmove', onMove, { passive: false })
    document.addEventListener('touchend', onUp)
  }, [persistWidth])

  if (!open) return null

  return createPortal(
    <div
      className="fixed inset-0"
      style={{ zIndex: panelZ }}
      role="dialog"
      aria-modal="true"
      data-testid="record-peek-drawer"
      data-peek-depth={depth}
      data-peek-closing={closing ? '' : undefined}
    >
      {/* Voile plus léger quand le panneau est empilé : le panneau parent reste
          lisible derrière plutôt que de disparaître dans le noir. */}
      <div
        className={`fixed inset-0 ${closing ? 'animate-fade-out' : 'animate-fade-in'} ${depth > 0 ? 'bg-black/20' : 'bg-black/40'}`}
        onClick={requestClose}
      />
      {/* Panneau empilé : décalé de quelques pixels vers la gauche pour laisser
          entrevoir le bord du panneau parent (repère « il y en a un dessous »). */}
      <div
        ref={panelRef}
        className={`fixed top-0 right-0 bottom-0 bg-slate-50 shadow-2xl flex flex-col ${resizing ? 'select-none' : ''} ${closing ? 'animate-slide-out-right pointer-events-none' : entering ? 'animate-slide-in-right' : ''}`}
        style={{ width: `${panelWidth}px`, maxWidth: '100vw', right: depth * 10 }}
      >
        {/* Poignée de redimensionnement sur la frontière gauche du panneau. */}
        <div
          onMouseDown={startResize}
          onTouchStart={startResize}
          data-testid="record-peek-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Redimensionner le panneau"
          title="Glisser pour redimensionner"
          className="group absolute top-0 left-0 bottom-0 w-2 -ml-1 cursor-col-resize z-10 flex items-center justify-center"
        >
          <div className={`h-full w-px transition-colors ${resizing ? 'bg-brand-500' : 'bg-transparent group-hover:bg-brand-400'}`} />
        </div>
        <div className="flex items-center gap-1.5 px-6 py-4 border-b border-slate-200 bg-white flex-shrink-0">
          <div className="flex-1 min-w-0">
            {/* Titre à la Airtable : gros et gras, c'est le nom de l'enregistrement. */}
            <div className="text-xl font-bold text-slate-900 truncate leading-tight" data-testid="record-peek-title">{title}</div>
            {subtitle && <div className="text-xs text-slate-400 truncate">{subtitle}</div>}
          </div>
          {editableFields > 0 && (
            <button
              onClick={() => setEditingFields(v => !v)}
              data-testid="record-peek-edit-fields"
              aria-pressed={editingFields}
              title={editingFields ? 'Terminer la personnalisation des champs' : 'Personnaliser les champs de la fiche'}
              aria-label="Personnaliser les champs"
              className={`p-1.5 rounded-lg transition-colors ${editingFields ? 'text-brand-600 bg-brand-50' : 'text-slate-400 hover:text-brand-600 hover:bg-slate-100'}`}
            >
              <SlidersHorizontal size={16} />
            </button>
          )}
          <button
            onClick={requestClose}
            data-testid="record-peek-close"
            aria-label="Fermer"
            className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <X size={18} />
          </button>
        </div>
        {/* Overlay transparent pendant le drag : capte les events pour que le
            survol d'un iframe/embed ne coupe pas le mousemove. */}
        {resizing && <div className="absolute inset-0 z-20 cursor-col-resize" />}
        {/* `peek-panel` : c'est ce marqueur qui déclenche le layout Airtable des
            champs (libellé à gauche, valeur pleine largeur à droite, cartes
            aplaties) — voir les règles `.peek-panel` dans index.css. */}
        <div
          className="overflow-y-auto flex-1 peek-panel"
          data-testid="record-peek-body"
          onClickCapture={onBodyClickCapture}
        >
          <PeekFieldEditProvider value={fieldEditCtx}>
            {children}
          </PeekFieldEditProvider>
        </div>
      </div>
      {/* Panneaux ouverts depuis celui-ci. Rendus hors du corps : leurs propres
          liens sont interceptés par LEUR panneau, pas par celui-ci (les events
          d'un portail remontent l'arbre React, pas le DOM). */}
      {nested.map(entry => (
        <NestedRecordPeek
          key={entry.key}
          entry={entry}
          onClose={() => setNested(list => list.filter(n => n.key !== entry.key))}
        />
      ))}
    </div>,
    document.body,
  )
}

// Un panneau empilé : l'URL ne porte que l'id, donc le titre/sous-titre vient
// d'un GET du record (mutualisé avec la fiche embarquée par le cache de `api`),
// et la fiche elle-même est chargée en import dynamique depuis le registre.
function NestedRecordPeek({ entry, onClose }) {
  const def = PEEK_ROUTES[entry.resource]
  const [record, setRecord] = useState(null)

  useEffect(() => {
    let cancelled = false
    def?.load?.(entry.id)
      .then(r => { if (!cancelled && r) setRecord(r) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [def, entry.id])

  if (!def) return null
  const { Component } = def
  return (
    <RecordPeekDrawer
      open
      onClose={onClose}
      title={(record && def.title(record)) || def.label}
      subtitle={record ? def.subtitle?.(record) : ''}
      to={entry.path}
      width={def.width}
      peekKey={entry.resource}
    >
      <Suspense fallback={<div className="p-6 text-sm text-slate-400"><Spinner size="xs" label="Chargement…" /></div>}>
        <Component recordId={entry.id} embedded onClose={onClose} />
      </Suspense>
    </RecordPeekDrawer>
  )
}
