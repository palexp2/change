import { useEffect, useMemo } from 'react'
import { useLocation } from 'react-router-dom'
import { findNavEntry } from '../lib/navItems.js'
import { publishPageTitle } from '../lib/currentPageTitle.js'

// Texte brut du titre, pour le publier (cf. lib/currentPageTitle.js) : les
// titres sont souvent composés (« Configuration des champs — {label} »).
function plainText(node) {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(plainText).join('')
  return plainText(node.props?.children)
}

/**
 * Titre de page — reprend le repère visuel de la sidebar : l'icône de l'entrée
 * de menu à gauche du titre, et un filet dans la teinte de la section
 * (`--acc-*`, cf. index.css) juste dessous.
 *
 * L'icône et la teinte sont déduites de la route courante (`findNavEntry`) :
 * une page n'a rien à redéclarer, et une entrée de menu qui change d'icône ou
 * de section entraîne son titre avec elle. `icon` / `accent` permettent de
 * forcer les deux pour une page absente du menu ; `icon={null}` retire l'icône
 * (en-tête qui porte déjà son propre pictogramme).
 *
 * `titleClassName` remplace la typo du `h1` pour les rares en-têtes compacts
 * (panneau latéral des Paramètres, carte de l'Agent) : le filet reste, la
 * taille du titre s'adapte à son contenant. `as` change la balise pour les
 * blocs réutilisés à l'intérieur d'une autre page (les connecteurs, montrés
 * aussi dans un onglet d'Admin, y restent un `h2`).
 */
export function PageTitle({
  children, icon, accent, className = '', as: Tag = 'h1',
  titleClassName = 'text-2xl font-bold text-slate-900',
  ...rest
}) {
  const { pathname, search } = useLocation()
  const entry = findNavEntry(pathname)

  const text = useMemo(() => plainText(children).replace(/\s+/g, ' ').trim(), [children])
  useEffect(() => {
    if (text) publishPageTitle(pathname + search, text)
  }, [pathname, search, text])

  const Icon = icon === null ? null : (icon || entry?.icon)
  const tint = accent || entry?.accent
  // Hors section (page à plat comme le Dashboard), `--nav-accent` retombe sur
  // le vert de marque posé au `:root`.
  const style = tint ? { '--nav-accent': `var(--acc-${tint})` } : undefined

  return (
    <div className={`inline-block ${className}`} style={style} data-testid="page-title">
      <Tag className={`${titleClassName} flex items-center gap-2.5`} {...rest}>
        {Icon && (
          <Icon
            size={22}
            className="flex-shrink-0"
            style={{ color: 'rgb(var(--nav-accent))' }}
            data-testid="page-title-icon"
          />
        )}
        <span>{children}</span>
      </Tag>
      <div
        className="mt-1.5 h-0.5 rounded-full"
        style={{ background: 'rgb(var(--nav-accent) / 0.5)' }}
        data-testid="page-title-rule"
      />
    </div>
  )
}

export default PageTitle
