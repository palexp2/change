import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { ChevronDown, Plus } from 'lucide-react'

// Layout CRM des fiches Entreprise et Contact (référence de design : HubSpot).
//
//   informations à gauche | fil des événements au centre | records liés à droite
//
// Ces fiches vivent dans un panneau latéral redimensionnable : le nombre de
// colonnes suit la largeur DU CONTENEUR (ResizeObserver), pas celle de la
// fenêtre — une media query ne verrait pas la poignée de redimensionnement.
//   ≥ 1040 px : 3 colonnes
//   ≥  720 px : 2 colonnes (les records liés passent sous les informations)
//   <  720 px : tout empilé
const THREE_COL = 1040
const TWO_COL = 720

export function CrmDetailLayout({ left, center, right }) {
  const ref = useRef(null)
  const [cols, setCols] = useState(3)

  useEffect(() => {
    const el = ref.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect?.width || 0
      if (!w) return
      setCols(w >= THREE_COL ? 3 : w >= TWO_COL ? 2 : 1)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const columns = cols === 3
    ? 'minmax(0, 18rem) minmax(0, 1fr) minmax(0, 19rem)'
    : cols === 2
      ? 'minmax(0, 18rem) minmax(0, 1fr)'
      : 'minmax(0, 1fr)'

  return (
    <div ref={ref} data-testid="crm-layout" data-crm-cols={cols}>
      <div className="grid gap-4 items-start" style={{ gridTemplateColumns: columns }}>
        {/* `crm-side` : crochet des règles CSS qui remettent le libellé
            AU-DESSUS du champ dans une colonne étroite (cf. index.css). */}
        <div className="crm-side space-y-4 min-w-0">{left}</div>
        <div className="space-y-4 min-w-0">{center}</div>
        {cols === 3
          ? <div className="crm-side space-y-3 min-w-0">{right}</div>
          : null}
      </div>
      {/* Colonnes réduites : les records liés passent sous les deux autres —
          en deux colonnes de cartes s'il y a la place. */}
      {cols !== 3 && (
        <div className={`crm-side min-w-0 mt-4 ${cols === 2 ? 'grid grid-cols-2 gap-3 items-start' : 'space-y-3'}`}>{right}</div>
      )}
    </div>
  )
}

// « Tout voir » de la bande de droite ouvre le tableau au centre — mais le clic
// part souvent bien plus bas que ce tableau, qui apparaît alors hors écran. On
// remonte donc le conteneur qui défile (le panneau latéral de la fiche, sinon
// la fenêtre) à partir du bouton cliqué.
export function scrollCrmToTop(el) {
  let node = el instanceof Element ? el.parentElement : null
  while (node) {
    const overflowY = getComputedStyle(node).overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 1) {
      node.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    node = node.parentElement
  }
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

// Carte de la colonne latérale : titre, compteur, action, corps repliable.
// `defaultOpen` est réévalué à chaque rendu tant que l'utilisateur n'a pas
// cliqué le chevron — les records liés arrivent après le premier rendu, une
// carte vide au départ s'ouvre donc d'elle-même quand ses lignes tombent.
// `onOpen` : le titre ouvre alors le tableau complet au centre (le chevron
// reste le repli de la carte).
export function CrmCard({ title, count, action, footer, onOpen, defaultOpen = true, collapsible = true, className = '', testId, children }) {
  const [manual, setManual] = useState(null)
  const open = !collapsible || (manual ?? defaultOpen)

  return (
    <div className={`card ${className}`} data-testid={testId}>
      <div className="flex items-center gap-1.5 px-2.5 py-2">
        {collapsible && (
          <button
            type="button"
            onClick={() => setManual(!open)}
            aria-expanded={open}
            aria-label={open ? 'Replier' : 'Déplier'}
            className="p-0.5 rounded text-slate-400 hover:text-slate-700 hover:bg-slate-100"
          >
            <ChevronDown size={14} className={`transition-transform ${open ? '' : '-rotate-90'}`} />
          </button>
        )}
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            className="min-w-0 text-left text-[13px] font-semibold text-slate-600 hover:text-brand-700 truncate"
          >
            {title}
          </button>
        ) : (
          <span className="text-[13px] font-semibold text-slate-600 truncate">{title}</span>
        )}
        {count > 0 && (
          <span className="bg-slate-100 text-slate-500 text-[11px] font-medium px-1.5 py-0.5 rounded-full leading-none">{count}</span>
        )}
        {action && <div className="ml-auto flex items-center gap-1">{action}</div>}
      </div>
      {open && (
        <div className="px-1.5 pb-1.5">
          {children}
          {footer}
        </div>
      )}
    </div>
  )
}

// Une ligne de record lié : un clic ouvre la fiche (lien → panneau empilé) ou
// déclenche `onClick` (modale, pour les tables sans fiche propre).
export function CrmRow({ to, onClick, primary, secondary, meta }) {
  const body = (
    <>
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-slate-800 truncate">{primary || '—'}</span>
        {secondary && <span className="block text-xs text-slate-400 truncate">{secondary}</span>}
      </span>
      {meta && <span className="text-xs text-slate-500 shrink-0">{meta}</span>}
    </>
  )
  const cls = 'flex items-center gap-2 w-full px-2 py-1.5 rounded-lg text-left hover:bg-slate-50'
  if (to) return <Link to={to} className={cls}>{body}</Link>
  return <button type="button" onClick={onClick} className={cls}>{body}</button>
}

// Bouton « + » d'en-tête de carte (ajouter un record lié).
export function CrmAdd({ onClick, to, label }) {
  const cls = 'p-1 rounded-lg text-slate-400 hover:text-brand-600 hover:bg-slate-100'
  if (to) return <Link to={to} className={cls} title={label} aria-label={label}><Plus size={14} /></Link>
  return <button type="button" onClick={onClick} className={cls} title={label} aria-label={label}><Plus size={14} /></button>
}

// Sélecteur du contenu de la colonne centrale (fil, ou un tableau lié ouvert
// depuis la colonne de droite).
export function CrmCenterTabs({ tabs, active, onSelect }) {
  return (
    <div className="flex items-center gap-1 flex-wrap">
      {tabs.map(t => (
        <button
          key={t.key}
          type="button"
          onClick={() => onSelect(t.key)}
          data-center-tab={t.key}
          data-active={active === t.key ? 'true' : 'false'}
          className={`px-3 py-1.5 rounded-lg text-sm font-medium ${
            active === t.key ? 'bg-brand-50 text-brand-700' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
          }`}
        >
          {t.label}
          {t.count > 0 && <span className="ml-1.5 text-xs text-slate-400">{t.count}</span>}
        </button>
      ))}
    </div>
  )
}

export default CrmDetailLayout
