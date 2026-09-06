import { useEffect, useRef, useState } from 'react'
import { SECTION_NAV_INSET } from '../components/SectionNav.jsx'

// Le conteneur de défilement est le panneau latéral (ou <main>) : on le
// retrouve en remontant le DOM plutôt que de le supposer.
function scrollParentOf(el) {
  let p = el?.parentElement
  while (p) {
    if (/(auto|scroll|overlay)/.test(getComputedStyle(p).overflowY)) return p
    p = p.parentElement
  }
  return document.scrollingElement
}

function viewportHeightOf(root) {
  if (!root || root === document.scrollingElement) return window.innerHeight
  return root.clientHeight || window.innerHeight
}

// Sections empilées d'une fiche + scroll-spy : `activeSection` suit le
// défilement, `goToSection` défile vers une section, `registerSection(key)`
// rend le callback de ref à poser sur chaque <Section>.
// `ready` : le contenu est peint (record chargé). `deps` : valeurs dont le
// changement fait grandir les sections (longueurs de sous-tableaux).
export function useSectionNav(sections, { ready = true, deps = [] } = {}) {
  const [activeSection, setActiveSection] = useState(sections[0])
  const sectionEls = useRef(new Map())
  const sectionsRef = useRef(sections)
  sectionsRef.current = sections
  const spyMutedUntil = useRef(0)
  // Callbacks de ref mémoïsés par section : sinon React les rejouerait
  // (null puis el) à chaque rendu.
  const sectionRefCbs = useRef(new Map())
  const registerSection = (key) => {
    if (!sectionRefCbs.current.has(key)) {
      sectionRefCbs.current.set(key, (el) => {
        if (el) sectionEls.current.set(key, el)
        else sectionEls.current.delete(key)
      })
    }
    return sectionRefCbs.current.get(key)
  }

  useEffect(() => {
    if (!ready) return
    const first = sectionEls.current.get(sectionsRef.current[0])
    const root = scrollParentOf(first)
    if (!root) return
    const target = root === document.scrollingElement ? window : root
    let raf = 0
    const compute = () => {
      raf = 0
      if (Date.now() < spyMutedUntil.current) return
      const rootTop = root === document.scrollingElement ? 0 : root.getBoundingClientRect().top
      // Sonde à mi-hauteur : même repère que goToSection(), qui centre la section
      // visée. Sinon le surlignage retomberait sur la section précédente juste
      // après le clic.
      const probe = rootTop + viewportHeightOf(root) / 2
      const keys = sectionsRef.current
      let current = keys[0]
      for (const key of keys) {
        const el = sectionEls.current.get(key)
        if (!el) continue
        if (el.getBoundingClientRect().top <= probe) current = key
      }
      // Bas de page : la dernière section est forcément « celle où on est rendu »,
      // même si son haut n'a pas franchi la ligne de sonde — seulement si la fiche
      // défile vraiment (au montage, avant les sous-tableaux, tout tient à l'écran).
      const scrollable = root.scrollHeight > root.clientHeight + 4
      if (scrollable && root.scrollHeight - root.scrollTop - root.clientHeight < 6) current = keys[keys.length - 1]
      setActiveSection(prev => (prev === current ? prev : current))
    }
    const onScroll = () => { if (!raf) raf = requestAnimationFrame(compute) }
    target.addEventListener('scroll', onScroll, { passive: true })
    compute()
    return () => {
      target.removeEventListener('scroll', onScroll)
      if (raf) cancelAnimationFrame(raf)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, sections, ...deps])

  function goToSection(key) {
    setActiveSection(key)
    const el = sectionEls.current.get(key)
    if (!el) return
    // On coupe le scroll-spy pendant l'animation, sinon les sections traversées
    // feraient sauter le surlignage.
    spyMutedUntil.current = Date.now() + 900
    const root = scrollParentOf(el)
    const height = el.getBoundingClientRect().height
    if (!root || root === document.scrollingElement) {
      // Une section plus haute que l'écran est calée en haut : la centrer
      // pousserait son titre hors du champ.
      const fits = height < window.innerHeight
      el.scrollIntoView({ behavior: 'smooth', block: fits ? 'center' : 'start' })
      return
    }
    const viewport = viewportHeightOf(root)
    const offset = height < viewport ? Math.max(SECTION_NAV_INSET, (viewport - height) / 2) : SECTION_NAV_INSET
    const delta = el.getBoundingClientRect().top - root.getBoundingClientRect().top
    root.scrollTo({ top: Math.max(0, root.scrollTop + delta - offset), behavior: 'smooth' })
  }

  return { activeSection, goToSection, registerSection }
}

export default useSectionNav
