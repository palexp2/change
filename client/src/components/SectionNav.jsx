// Sélecteur de sections d'une fiche : barre horizontale posée en haut du corps
// de la fiche et collante au défilement (avant : une colonne à côté des
// sections, qui mangeait la largeur du panneau).
// Le décalage `SECTION_NAV_INSET` est la hauteur réservée à la barre : les
// pages s'en servent dans leur `goToSection()` pour ne pas caler une section
// juste dessous.
export const SECTION_NAV_INSET = 56

// Bloc de section : ancre pour le scroll-spy + titre et action optionnelle.
export function Section({ id, label, count, action, registerRef, children }) {
  return (
    <section ref={registerRef} data-section={id} className="pt-1 pb-8 scroll-mt-16">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="flex items-center gap-2 text-[13px] font-semibold uppercase tracking-wide text-slate-400">
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

export default function SectionNav({ sections, labels = {}, counts = {}, active, onSelect, embedded = true, testId }) {
  if (!sections?.length) return null
  // La barre déborde du padding de la fiche pour couvrir toute la largeur
  // quand le contenu défile dessous.
  const bleed = embedded ? '-mx-5 px-5' : '-mx-6 px-6'
  return (
    <div className={`sticky top-0 z-20 ${bleed} mb-4 bg-slate-50/95 backdrop-blur-sm border-b border-slate-200`}>
      <nav className="flex items-center gap-1 overflow-x-auto py-2" data-testid={testId}>
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
    </div>
  )
}
