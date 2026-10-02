import { ChevronUp, ChevronDown, GripVertical } from 'lucide-react'

// Sélecteur de sections d'une fiche : barre horizontale posée en haut du corps
// de la fiche et collante au défilement (avant : une colonne à côté des
// sections, qui mangeait la largeur du panneau).
// Le décalage `SECTION_NAV_INSET` est la hauteur réservée à la barre : les
// pages s'en servent dans leur `goToSection()` pour ne pas caler une section
// juste dessous.
export const SECTION_NAV_INSET = 56

// Bloc de section : ancre pour le scroll-spy + titre et action optionnelle.
// `reorder` (optionnel) : l'objet de useReorderDnd sur les clés de section —
// la section devient déplaçable (flèches + poignée + cible de dépôt). La fiche
// ne le passe qu'en mode personnalisation.
export function Section({ id, label, count, action, registerRef, reorder, children }) {
  const dnd = reorder
  return (
    <section
      ref={registerRef}
      data-section={id}
      className={`relative pt-1 pb-8 scroll-mt-16 ${dnd ? `rounded-lg ${dnd.dragId === id ? 'opacity-50' : ''}` : ''}`}
      onDragOver={dnd ? e => dnd.dragOver(e, id) : undefined}
      onDrop={dnd ? e => dnd.drop(e, id) : undefined}
    >
      {dnd?.dragOverId === id && (
        <span className={`absolute left-0 right-0 h-0.5 bg-brand-500 rounded pointer-events-none ${dnd.dragOverSide === 'before' ? '-top-1' : 'bottom-3'}`} />
      )}
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wide text-slate-400">
          {dnd && (
            <span className="flex items-center normal-case tracking-normal" data-testid={`section-reorder-${id}`}>
              <button
                type="button"
                className="p-0.5 rounded text-slate-300 hover:text-slate-700 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent"
                title="Monter la section" aria-label={`Monter ${label}`}
                data-testid={`section-up-${id}`}
                disabled={dnd.isFirst(id)} onClick={() => dnd.move(id, -1)}
              ><ChevronUp size={14} /></button>
              <span
                draggable
                onDragStart={e => dnd.dragStart(e, id, e.currentTarget.closest('section'))}
                onDragEnd={dnd.dragEnd}
                className="cursor-grab active:cursor-grabbing text-slate-300 hover:text-slate-500"
                title="Glisser pour déplacer la section"
                data-testid={`section-handle-${id}`}
              ><GripVertical size={14} /></span>
              <button
                type="button"
                className="p-0.5 rounded text-slate-300 hover:text-slate-700 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent"
                title="Descendre la section" aria-label={`Descendre ${label}`}
                data-testid={`section-down-${id}`}
                disabled={dnd.isLast(id)} onClick={() => dnd.move(id, 1)}
              ><ChevronDown size={14} /></button>
            </span>
          )}
          {label}
          {count > 0 && (
            <span className="bg-slate-100 text-slate-500 text-[11px] font-medium px-1.5 py-0.5 rounded-full leading-none normal-case tracking-normal">{count}</span>
          )}
        </h2>
        {action}
      </div>
      {children}
    </section>
  )
}

// `trailing` : contenu posé à droite de la barre (ex. bouton Enregistrer d'un
// éditeur) — il reste visible avec la barre pendant le défilement.
export default function SectionNav({ sections, labels = {}, counts = {}, active, onSelect, embedded = true, testId, trailing }) {
  if (!sections?.length) return null
  // La barre déborde du padding de la fiche pour couvrir toute la largeur
  // quand le contenu défile dessous.
  const bleed = embedded ? '-mx-5 px-5' : '-mx-6 px-6'
  return (
    <div className={`sticky top-0 z-20 ${bleed} mb-4 bg-slate-50/95 backdrop-blur-sm border-b border-slate-200 flex items-center gap-3`}>
      <nav className="flex-1 min-w-0 flex items-center gap-1 overflow-x-auto py-2" data-testid={testId}>
        {sections.map(t => {
          const count = counts[t]
          const isActive = active === t
          return (
            <button
              key={t}
              onClick={() => onSelect(t)}
              aria-current={isActive ? 'true' : undefined}
              data-section-link={t}
              data-active={isActive ? 'true' : 'false'}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium whitespace-nowrap transition-colors ${
                isActive
                  ? 'bg-brand-50 text-brand-700'
                  : 'text-slate-500 hover:text-slate-700 hover:bg-slate-100'
              }`}
            >
              <span>{labels[t] || t}</span>
              {count > 0 && (
                <span className="bg-slate-200 text-slate-600 text-xs px-1.5 py-0.5 rounded-full leading-none flex-shrink-0">{count}</span>
              )}
            </button>
          )
        })}
      </nav>
      {trailing && <div className="flex items-center gap-2 shrink-0 py-2 pl-3 border-l border-slate-200">{trailing}</div>}
    </div>
  )
}
