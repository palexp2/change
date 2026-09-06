// Contexte de page joint aux demandes envoyées à l'agent — mécanisme UNIQUE,
// partagé par le FAB « Modifier le système » (FeedbackFab) et le panneau rapide
// de la file de travaux (TravauxQuickPanel).
//
// Trois briques :
//   1. `describeElement` — description compacte d'un élément DOM (ancres
//      exploitables : data-testid, id, aria…) pour que l'agent le retrouve dans
//      le code sans que l'utilisateur ait à le décrire.
//   2. `useElementPicker` — le mode « cliquer sur un élément » (bandeau appelant,
//      surbrillance au survol, clics de la page neutralisés).
//   3. `currentRecordLabel` / `buildPageContext` — la ligne de contexte finale :
//      route courante, fiche affichée, élément ciblé.
import { useEffect, useRef } from 'react'
import { MousePointerClick, X } from 'lucide-react'

/**
 * Description compacte de l'élément DOM cliqué, jointe en contexte de la demande.
 * Priorise les ancres exploitables (data-testid, id, aria).
 */
export function describeElement(el) {
  if (!(el instanceof Element)) return ''
  const attrs = []
  for (const name of ['data-testid', 'id', 'aria-label', 'placeholder', 'title', 'name']) {
    const v = el.getAttribute(name)
    if (v) attrs.push(`${name}="${v}"`)
  }
  const cls = (el.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 4).join(' ')
  if (cls) attrs.push(`class="${cls}"`)
  let desc = `<${el.tagName.toLowerCase()}${attrs.length ? ' ' + attrs.join(' ') : ''}>`
  const text = (el.innerText || el.value || '').trim().replace(/\s+/g, ' ').slice(0, 80)
  if (text) desc += ` « ${text} »`
  // Ancre ancêtre identifiable la plus proche (repère supplémentaire dans le code).
  for (let anc = el.parentElement; anc && anc !== document.body; anc = anc.parentElement) {
    const tid = anc.getAttribute('data-testid')
    if (tid || anc.id) {
      desc += ` — dans <${anc.tagName.toLowerCase()} ${tid ? `data-testid="${tid}"` : `id="${anc.id}"`}>`
      break
    }
  }
  return desc.slice(0, 400)
}

// Plomberie React et cadres sans intérêt pour situer un élément.
const CHAIN_SKIP = new Set([
  'Fragment', 'Suspense', 'Provider', 'Consumer', 'ErrorBoundary', 'RecordScope',
  'Layout', 'ProtectedRoute', 'Routes', 'Route', 'Outlet', 'Router', 'BrowserRouter',
  'App', 'AppRoutes', 'StrictMode', 'Link', 'NavLink', 'LinkWithRef', 'RenderedRoute',
])

/**
 * Composants React qui englobent l'élément, du plus proche au plus lointain
 * (ex. ['Badge', 'DataTable', 'ListPage', 'Orders']). Lu sur le fiber que React
 * accroche au nœud DOM ; suppose `esbuild.keepNames` (vite.config.js).
 */
export function componentChain(el) {
  if (!(el instanceof Element)) return []
  const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'))
  const names = []
  for (let fiber = key && el[key]; fiber && names.length < 8; fiber = fiber.return) {
    const t = fiber.type
    const inner = typeof t === 'function' ? t : (t && typeof t === 'object' ? (t.render || t.type) : null)
    if (!inner) continue
    const name = t.displayName || inner.displayName || inner.name
    if (!name || CHAIN_SKIP.has(name) || !/^[A-Z]/.test(name) || /Provider$|Boundary$|Context$/.test(name)) continue
    if (names[names.length - 1] !== name) names.push(name)
  }
  return names
}

/**
 * Libellé du record affiché quand la page est une fiche détail (`/factures/123`,
 * `/companies/42`…) : le titre `h1` de la page, c'est-à-dire ce que l'utilisateur
 * lit à l'écran. Une page de liste (`/orders`) n'a pas de record affiché — son
 * titre est le nom de la section, la route le dit déjà.
 */
export function currentRecordLabel(pathname = '') {
  if (typeof document === 'undefined') return ''
  const segments = String(pathname).split('/').filter(Boolean)
  if (segments.length < 2) return ''
  const h1 = document.querySelector('main h1') || document.querySelector('h1')
  const text = (h1?.innerText || '').trim().replace(/\s+/g, ' ')
  return text.slice(0, 120)
}

/**
 * Ligne de contexte jointe à la demande. Sans `record` ni `element`, c'est la
 * simple route courante — le format historique du FAB, que la page Agent affiche
 * telle quelle en pastille.
 *
 * `element` accepte une chaîne (un seul élément ciblé — format historique,
 * inchangé) ou un tableau : plusieurs éléments sont alors numérotés sur une seule
 * ligne, la partie « page » du contexte restant en tête (voir PageLink).
 */
export function buildPageContext({ pathname = '', search = '', element = '', record = '', appWide = false, chain = [], scope = 'page' } = {}) {
  const page = `${pathname}${search || ''}`
  const picked = (Array.isArray(element) ? element : [element])
    .map(d => String(d || '').trim())
    .filter(Boolean)
  const isApp = appWide || scope === 'app'
  const component = !isApp && scope !== 'page' ? scope : ''
  return (isApp
    ? `Demande concernant l'ensemble de l'application (pas seulement la page ${page})`
    : page)
    + (record ? ` — fiche affichée : « ${record} »` : '')
    + (picked.length === 1 ? ` — élément ciblé par l'utilisateur : ${picked[0]}` : '')
    + (picked.length > 1
      ? ` — éléments ciblés par l'utilisateur (${picked.length}) : `
        + picked.map((d, i) => `[${i + 1}] ${d}`).join(' ; ')
      : '')
    + (chain.length ? ` — composants englobants : ${chain.join(' ‹ ')}` : '')
    + (component
      ? ` — portée : le composant partagé « ${component} » — modifier ce composant lui-même pour que le changement s'applique partout où il est utilisé, ne pas le dupliquer`
      : (!isApp && chain.length
        ? ` — portée : cette page seulement — si le changement touche un composant partagé, passer par une option/variante du composant plutôt que par une copie`
        : ''))
}

/**
 * Bandeau flottant de l'étape « cliquer sur un élément ». Il porte
 * `data-feedback-picker` : ses propres boutons restent cliquables pendant que le
 * reste de la page est neutralisé.
 *
 * En sélection multiple (`count` > 0), le bandeau devient le compteur de la
 * session : il dit combien d'éléments sont retenus, rappelle qu'un re-clic
 * retire, et le bouton de sortie devient « Terminé » (les éléments sont gardés).
 */
export function PickerBanner({ onSkip, onCancel, skipLabel = 'Demande générale', testIdPrefix = 'feedback', count = 0, multiple = false }) {
  return (
    <div
      data-feedback-picker
      data-testid={`${testIdPrefix}-pick-banner`}
      data-picked-count={count}
      className="fixed top-4 left-1/2 -translate-x-1/2 z-[9991] flex items-center gap-3 bg-slate-900 text-white
        rounded-xl shadow-2xl pl-4 pr-2 py-2 text-sm max-w-[calc(100vw-2rem)]"
    >
      <MousePointerClick size={16} className="text-brand-400 flex-shrink-0" />
      <span className="whitespace-nowrap truncate">
        {count
          ? `${count} élément${count > 1 ? 's' : ''} retenu${count > 1 ? 's' : ''} — cliquez pour en ajouter, re-cliquez pour retirer`
          : multiple
            ? 'Cliquez sur les éléments concernés par votre demande — autant que nécessaire'
            : 'Cliquez sur l\'élément concerné par votre demande'}
      </span>
      <div className="flex items-center gap-1 flex-shrink-0">
        <button
          type="button"
          data-testid={`${testIdPrefix}-skip-pick`}
          onClick={onSkip}
          className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-colors ${count
            ? 'bg-brand-600 hover:bg-brand-500 text-white'
            : 'bg-white/10 hover:bg-white/20'}`}
        >
          {count ? `Terminé · ${count}` : skipLabel}
        </button>
        <button
          type="button"
          data-testid={`${testIdPrefix}-cancel-pick`}
          onClick={onCancel}
          aria-label="Annuler"
          title="Annuler (Échap)"
          className="p-1.5 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white transition-colors"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  )
}

/**
 * Mode « picking » : capture des événements au niveau document (phase capture)
 * pour intercepter le clic AVANT les handlers de la page (aucune navigation /
 * action ne doit se déclencher). Surbrillance de l'élément survolé via un overlay
 * non interactif repositionné au survol et au scroll.
 *
 * Les éléments portant `data-feedback-picker` (bandeau, FAB, panneau appelant)
 * gardent leur comportement normal — ce sont les commandes du picking lui-même.
 *
 * `onPick(description)` : un élément a été choisi. `onCancel()` : Échap.
 *
 * Mode `multiple` : le ciblage ne s'arrête pas au premier clic. Chaque élément
 * retenu garde une bordure verte numérotée, un re-clic dessus le retire, et
 * `onChange(descriptions[])` reçoit à chaque fois la liste complète — les
 * éléments déjà retenus avant la session (`existing`, non démarquables ici) en
 * tête. Sortie par « Terminé » ou Échap, la liste est conservée.
 */
export function useElementPicker(picking, { onPick, onCancel, multiple = false, existing = [], onChange } = {}) {
  // Les callbacks passent par une ref : l'effet ne doit dépendre que de `picking`,
  // sinon il se remonte à chaque render de l'appelant (surbrillance qui saute).
  const cb = useRef({ onPick, onCancel, onChange, existing })
  cb.current = { onPick, onCancel, onChange, existing }

  useEffect(() => {
    if (!picking) return
    const hl = document.createElement('div')
    hl.style.cssText = 'position:fixed;z-index:9990;pointer-events:none;display:none;' +
      'border:2px solid #21B14B;background:rgba(33,177,75,0.10);border-radius:4px;transition:all 60ms ease-out'
    document.body.appendChild(hl)
    const style = document.createElement('style')
    style.textContent = 'body.__feedback-picking *{cursor:crosshair!important}' +
      '[data-feedback-picker], [data-feedback-picker] *{cursor:default!important}' +
      '[data-feedback-picker] button{cursor:pointer!important}'
    document.head.appendChild(style)
    document.body.classList.add('__feedback-picking')

    let hoverEl = null
    const inPicker = t => t instanceof Element && t.closest('[data-feedback-picker]')
    function position(t) {
      const r = t.getBoundingClientRect()
      hl.style.display = 'block'
      hl.style.left = `${r.left - 2}px`
      hl.style.top = `${r.top - 2}px`
      hl.style.width = `${r.width}px`
      hl.style.height = `${r.height}px`
    }
    function onMove(e) {
      const t = e.target
      if (!(t instanceof Element) || inPicker(t) || t === document.body || t === document.documentElement) {
        hoverEl = null
        hl.style.display = 'none'
        return
      }
      hoverEl = t
      position(t)
    }

    // ── Sélection multiple : marques persistantes sur les éléments retenus ──
    // Elles vivent le temps de la session de ciblage ; leur numéro reprend après
    // les éléments déjà retenus avant (offset), pour que le bandeau, les marques
    // et la liste du panneau portent les mêmes numéros.
    // Instantané pris à l'ouverture de la session : `existing` reflète l'état du
    // parent, que nos propres `onChange` font grandir — s'y référer plus tard
    // compterait les éléments de la session deux fois.
    const baseline = multiple ? [...(cb.current.existing || [])] : []
    const offset = baseline.length
    const marks = []
    function placeMark(m) {
      const r = m.el.getBoundingClientRect()
      m.box.style.left = `${r.left - 2}px`
      m.box.style.top = `${r.top - 2}px`
      m.box.style.width = `${r.width}px`
      m.box.style.height = `${r.height}px`
    }
    function renumber() {
      marks.forEach((m, i) => { m.tag.textContent = String(offset + i + 1) })
    }
    function addMark(el) {
      const box = document.createElement('div')
      box.style.cssText = 'position:fixed;z-index:9989;pointer-events:none;border:2px solid #15803d;' +
        'background:rgba(21,128,61,0.10);border-radius:4px'
      const tag = document.createElement('span')
      tag.style.cssText = 'position:absolute;top:-9px;left:-9px;min-width:18px;height:18px;padding:0 4px;' +
        'border-radius:9px;background:#15803d;color:#fff;text-align:center;' +
        'font:600 11px/18px ui-sans-serif,system-ui,sans-serif'
      box.appendChild(tag)
      document.body.appendChild(box)
      const m = { el, box, tag }
      marks.push(m)
      placeMark(m)
      renumber()
    }
    function emitChange() {
      cb.current.onChange?.([...baseline, ...marks.map(m => describeElement(m.el))])
    }

    function onScroll() {
      if (hoverEl) position(hoverEl)
      marks.forEach(placeMark)
    }
    function onDown(e) {
      if (inPicker(e.target)) return
      e.preventDefault()
      e.stopPropagation()
    }
    function onClick(e) {
      if (inPicker(e.target)) return
      e.preventDefault()
      e.stopPropagation()
      const target = hoverEl || (e.target instanceof Element ? e.target : null)
      if (!multiple) { cb.current.onPick?.(describeElement(target), componentChain(target)); return }
      if (!target) return
      // Re-clic sur un élément déjà retenu : on le retire (le plus direct pour
      // corriger une erreur sans quitter le mode ciblage).
      const i = marks.findIndex(m => m.el === target)
      if (i === -1) addMark(target)
      else { marks[i].box.remove(); marks.splice(i, 1); renumber() }
      emitChange()
    }
    function onKey(e) {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      cb.current.onCancel?.()
    }
    document.addEventListener('mouseover', onMove, true)
    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('click', onClick, true)
    document.addEventListener('scroll', onScroll, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mouseover', onMove, true)
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('keydown', onKey, true)
      marks.forEach(m => m.box.remove())
      hl.remove()
      style.remove()
      document.body.classList.remove('__feedback-picking')
    }
  }, [picking, multiple])
}
