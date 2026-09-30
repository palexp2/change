/**
 * ThinkingOrb — indicateur « occupé » animé (Thinking Orbs v0.3.2, MIT).
 *
 * Un nuage de points 3D dessiné sur <canvas>, teinté par l'accent de marque
 * (`--acc-brand`, suit le mode nuit). Variante `ink` : prend la couleur du
 * texte de l'élément hôte (orbe posé sur un bouton plein).
 *
 * Une seule boucle requestAnimationFrame anime toutes les orbes de la page ;
 * `prefers-reduced-motion` fige l'orbe sur sa première image.
 *
 * États : working · searching · solving · listening · connecting · weaving ·
 * composing · breathing (défaut, repos générique) · shaping.
 *
 *  <ThinkingOrb />                          // 20 px, breathing
 *  <ThinkingOrb state="searching" size={64} />
 *  <ThinkingOrb size={16} ink />            // dans un bouton bg-brand-600 text-white
 *  <ThinkingOrb state={orbForPhase(phase)} size={40} />
 */
import { useEffect, useRef } from 'react'
import { MODE_FRAMES, paintFrame, resolvePreset } from '../lib/thinkingOrbs/engine'

export const ORB_STATES = ['working', 'searching', 'solving', 'listening', 'connecting', 'weaving', 'composing', 'breathing', 'shaping']

/** Libellé de phase libre → état d'orbe. */
export function orbForPhase(phase) {
  const s = String(phase || '')
  if (/librar|look|search|find|catalog|cherch|trouv|scan/i.test(s)) return 'searching'
  if (/read|page|filing|file|lecture|lit |lis |import|sync/i.test(s)) return 'working'
  if (/fold|recap|branch|weav|fusion|relie|rapproch/i.test(s)) return 'weaving'
  if (/plan|brief|draft|brouillon|rédig|redig/i.test(s)) return 'shaping'
  if (/connect|branch|liaison|lien/i.test(s)) return 'connecting'
  if (/écri|ecri|compos|répon|repon|stream|génér|gener/i.test(s)) return 'composing'
  if (/solv|résou|resou|calcul|vérif|verif|test/i.test(s)) return 'solving'
  if (/écout|ecout|listen|dict/i.test(s)) return 'listening'
  return 'breathing'
}

// ── Boucle partagée ────────────────────────────────────────────────────────
const orbs = new Set()
let raf = 0
let theme = null // { dark, tint } résolu depuis <html>, invalidé au changement de thème

const reducedMq = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-reduced-motion: reduce)') : null
const reduced = () => !!reducedMq?.matches

function parseRgb(str) {
  const m = String(str || '').match(/(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)/)
  return m ? { r: +m[1], g: +m[2], b: +m[3] } : null
}

function currentTheme() {
  if (!theme) {
    const root = document.documentElement
    theme = {
      dark: root.classList.contains('dark'),
      tint: parseRgb(getComputedStyle(root).getPropertyValue('--acc-brand')) || { r: 33, g: 177, b: 75 },
    }
  }
  return theme
}

function tick(now) {
  raf = 0
  const t = now / 1000
  for (const o of orbs) if (o.visible) o.draw(t)
  if (orbs.size && !reduced()) raf = requestAnimationFrame(tick)
}

/** Relance la boucle (nouvelle orbe, thème changé, onglet revenu). */
export function kickOrbs() {
  if (!raf && orbs.size && typeof requestAnimationFrame !== 'undefined') raf = requestAnimationFrame(tick)
}

if (typeof window !== 'undefined') {
  const repaintAll = () => {
    theme = null
    for (const o of orbs) { o.refresh(); o.draw(reduced() ? 0.6 : performance.now() / 1000) }
    kickOrbs()
  }
  new MutationObserver(repaintAll).observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme', 'data-look'] })
  reducedMq?.addEventListener?.('change', repaintAll)
  window.qneOrbKick = kickOrbs
}

// ── Composant ──────────────────────────────────────────────────────────────
function tierFor(size) {
  return size >= 48 ? 64 : size >= 26 ? 32 : 20
}

export default function ThinkingOrb({ state = 'breathing', size = 20, ink = false, className = '', style }) {
  const hostRef = useRef(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const st = ORB_STATES.includes(state) ? state : 'breathing'
    const canvas = document.createElement('canvas')
    canvas.style.width = `${size}px`
    canvas.style.height = `${size}px`
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(size * dpr)
    canvas.height = Math.round(size * dpr)
    host.appendChild(canvas)
    const ctx = canvas.getContext('2d')
    if (!ctx) { canvas.remove(); return }

    const { mode, speed, opts } = resolvePreset(st, tierFor(size))
    const frameFn = MODE_FRAMES[mode]
    let inkTint = null
    const orb = {
      visible: true,
      refresh() { inkTint = ink ? parseRgb(getComputedStyle(host).color) : null },
      draw(t) {
        const th = currentTheme()
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, size, size)
        // `ink` : la couleur du texte hôte est l'encre pleine, sans inversion.
        paintFrame(ctx, frameFn(size, t * speed, opts), ink ? false : th.dark, inkTint || th.tint)
      },
    }
    orb.refresh()
    orb.draw(reduced() ? 0.6 : performance.now() / 1000)
    orbs.add(orb)
    kickOrbs()

    const io = typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver(([e]) => { orb.visible = e.isIntersecting; if (orb.visible) kickOrbs() })
      : null
    io?.observe(host)
    return () => { io?.disconnect(); orbs.delete(orb); canvas.remove() }
  }, [state, size, ink])

  return (
    <span
      ref={hostRef}
      className={`torb${ink ? ' torb--ink' : ''}${className ? ` ${className}` : ''}`}
      data-orb={state}
      data-size={size}
      aria-hidden="true"
      style={{ width: size, height: size, ...style }}
    />
  )
}
