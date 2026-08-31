import { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { X, Maximize2 } from 'lucide-react'
import api from '../lib/api.js'

// Drawer latéral (side-peek à la Airtable) : ouvre l'aperçu/édition d'un
// enregistrement par-dessus la liste, sans quitter le contexte de la table.
// Le contenu (`children`) est typiquement une page *Detail.jsx rendue en mode
// `embedded` — l'autosave, le realtime et le chargement restent gérés par la
// fiche elle-même.
//
// Largeur redimensionnable : l'utilisateur tire la frontière gauche du panneau
// pour l'élargir/rétrécir. La largeur choisie est persistée comme préférence
// par utilisateur (PATCH /auth/preferences → peek_width) et réutilisée à la
// prochaine ouverture, sur tous les side-peek de l'app.
//
// Props :
//  - open        : bool — visibilité.
//  - onClose     : () => void — fermeture (overlay, bouton ×, Échap).
//  - title       : string — titre affiché dans l'en-tête du drawer.
//  - subtitle    : string | undefined — sous-titre discret (entreprise, courriel…).
//  - to          : string | undefined — route de la fiche complète ; affiche le
//                  bouton « ouvrir en grand » qui navigue et ferme le drawer.
//                  Sert aussi d'URL affichée dans la barre d'adresse pendant
//                  que le drawer est ouvert (voir « URL partageable » plus bas).
//  - width       : number — largeur par défaut en px (défaut 560), utilisée tant
//                  que l'utilisateur n'a pas défini de préférence.
//  - children    : contenu du corps (scrollable).

const MIN_WIDTH = 360
// Marge minimale (px) laissée visible à gauche du panneau pour garder l'accès à
// la liste sous-jacente / l'overlay.
const EDGE_MARGIN = 80

// Cache module : la préférence de largeur est partagée par toutes les instances
// et mémorisée entre ouvertures pour éviter de re-fetch et pour un rendu instant.
const prefCache = { loaded: false, width: null }

function maxWidth() {
  return Math.max(MIN_WIDTH, window.innerWidth - EDGE_MARGIN)
}

function clampWidth(w) {
  return Math.min(Math.max(w, MIN_WIDTH), maxWidth())
}

export default function RecordPeekDrawer({ open, onClose, title, subtitle, to, width = 560, children }) {
  const navigate = useNavigate()
  // Garde une référence stable sur onClose : l'effet d'URL ne doit pas se
  // rejouer (et re-pousser une entrée d'historique) à chaque rendu du parent.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  // Marqueur : « ouvrir en grand » remplace lui-même l'entrée d'historique,
  // le nettoyage ne doit pas faire de history.back().
  const skipRestoreRef = useRef(false)
  const panelRef = useRef(null)
  const [panelWidth, setPanelWidth] = useState(() => clampWidth(prefCache.width ?? width))
  const [resizing, setResizing] = useState(false)
  // Rejoue l'animation d'entrée seulement à l'ouverture — évite qu'elle ne
  // reparte (et donne l'impression de rebond) au relâchement de la poignée
  // de redimensionnement, quand `resizing` repasse à false.
  const [entering, setEntering] = useState(false)

  // Charge la préférence de largeur persistée (une seule fois par session).
  useEffect(() => {
    if (!open || prefCache.loaded) return
    let cancelled = false
    api.auth.getPreferences()
      .then((d) => {
        prefCache.loaded = true
        const w = Number(d?.peek_width)
        if (Number.isFinite(w) && w > 0) {
          prefCache.width = w
          if (!cancelled) setPanelWidth(clampWidth(w))
        }
      })
      .catch(() => { prefCache.loaded = true })
    return () => { cancelled = true }
  }, [open])

  // Applique la préférence en cache à chaque (ré)ouverture, et re-borne si la
  // fenêtre a été redimensionnée entre-temps.
  useEffect(() => {
    if (!open) return
    setPanelWidth(clampWidth(prefCache.width ?? width))
  }, [open, width])

  // ── URL partageable ───────────────────────────────────────────────────────
  // Pendant que le drawer est ouvert, la barre d'adresse affiche l'URL de la
  // fiche (`to`) pour qu'on puisse copier/partager le chemin exact. On pousse
  // l'entrée directement via window.history (sans passer par le router) : le
  // routeur reste sur la liste, donc la page sous-jacente n'est pas démontée.
  // À la fermeture on revient en arrière ; un « précédent » du navigateur
  // ferme le drawer.
  useEffect(() => {
    if (!open || !to) return
    const here = () => window.location.pathname + window.location.search + window.location.hash
    if (here() === to) return
    window.history.pushState({ ...(window.history.state || {}), peekDrawer: true }, '', to)
    let popped = false
    const onPop = () => { popped = true; onCloseRef.current?.() }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      // Ne revenir en arrière que si notre entrée est toujours la courante :
      // une navigation faite depuis le drawer (lien vers une autre fiche,
      // « ouvrir en grand ») ne doit pas être annulée.
      if (!popped && !skipRestoreRef.current && here() === to) window.history.back()
      skipRestoreRef.current = false
    }
  }, [open, to])

  // Verrou du scroll du body tant que le drawer est ouvert.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  // Joue l'animation de glissement une seule fois par ouverture.
  useEffect(() => {
    if (!open) return
    setEntering(true)
    const t = setTimeout(() => setEntering(false), 200)
    return () => clearTimeout(t)
  }, [open])

  // Fermeture sur Échap. stopPropagation pour ne pas fermer aussi une modale
  // sous-jacente éventuelle.
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.() } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const persistWidth = useCallback((w) => {
    const rounded = Math.round(w)
    if (prefCache.width === rounded) return
    prefCache.width = rounded
    prefCache.loaded = true
    api.auth.updatePreferences({ peek_width: rounded })
      .catch((err) => console.error('[peekDrawer] échec sauvegarde largeur:', err))
  }, [])

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

  function openFull() {
    if (!to) return
    // L'URL est déjà celle de la fiche : on remplace l'entrée poussée par le
    // drawer plutôt que d'en empiler une seconde (« précédent » ramène à la
    // liste, pas au panneau).
    skipRestoreRef.current = true
    onClose?.()
    navigate(to, { replace: true })
  }

  return createPortal(
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" data-testid="record-peek-drawer">
      <div className="fixed inset-0 bg-black/40 animate-fade-in" onClick={onClose} />
      <div
        ref={panelRef}
        className={`fixed top-0 right-0 bottom-0 bg-slate-50 shadow-2xl flex flex-col ${resizing ? 'select-none' : ''} ${entering ? 'animate-slide-in-right' : ''}`}
        style={{ width: `${panelWidth}px`, maxWidth: '100vw' }}
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
          {to && (
            <button
              onClick={openFull}
              data-testid="record-peek-expand"
              title="Ouvrir la fiche complète"
              aria-label="Ouvrir la fiche complète"
              className="p-1.5 text-slate-400 hover:text-brand-600 hover:bg-slate-100 rounded-lg transition-colors"
            >
              <Maximize2 size={16} />
            </button>
          )}
          <button
            onClick={onClose}
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
        <div className="overflow-y-auto flex-1 peek-panel" data-testid="record-peek-body">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  )
}
