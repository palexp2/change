import { useLocation } from 'react-router-dom'
import { findNavEntry } from '../lib/navItems.js'

/**
 * Titre de page — reprend le repère visuel de la sidebar : l'icône de l'entrée
 * de menu à gauche du titre, et un filet dans la teinte de la section
 * (`--acc-*`, cf. index.css) juste dessous.
 *
 * L'icône et la teinte sont déduites de la route courante (`findNavEntry`) :
 * une page n'a rien à redéclarer, et une entrée de menu qui change d'icône ou
 * de section entraîne son titre avec elle. `icon` / `accent` permettent de
 * forcer les deux pour une page absente du menu.
 */
export function PageTitle({ children, icon, accent, className = '', ...rest }) {
  const { pathname } = useLocation()
  const entry = findNavEntry(pathname)
  const Icon = icon || entry?.icon
  const tint = accent || entry?.accent
  // Hors section (page à plat comme le Dashboard), `--nav-accent` retombe sur
  // le vert de marque posé au `:root`.
  const style = tint ? { '--nav-accent': `var(--acc-${tint})` } : undefined

  return (
    <div className={`inline-block ${className}`} style={style} data-testid="page-title">
      <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-2.5" {...rest}>
        {Icon && (
          <Icon
            size={22}
            className="flex-shrink-0"
            style={{ color: 'rgb(var(--nav-accent))' }}
            data-testid="page-title-icon"
          />
        )}
        <span>{children}</span>
      </h1>
      <div
        className="mt-1.5 h-0.5 rounded-full"
        style={{ background: 'rgb(var(--nav-accent) / 0.5)' }}
        data-testid="page-title-rule"
      />
    </div>
  )
}

export default PageTitle
