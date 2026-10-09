import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { Download, ExternalLink, Minus, Plus } from 'lucide-react'
import pdfWorkerSrc from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker&url'

// Surlignage document ↔ champs : survoler un champ allume l'endroit du PDF d'où
// la valeur a été lue ; survoler le PDF allume le champ correspondant.
//
//   <DocHighlightProvider>
//     <DocHighlightViewer url={blobUrl} isPdf />
//     <Hl k="total" spec={{ amount: 465.08 }}>…champ…</Hl>
//   </DocHighlightProvider>
//
// Aucune position n'est stockée à l'extraction : la valeur est RETROUVÉE dans la
// couche texte du PDF (montant comparé en nombre, date sous ses formats usuels,
// texte en minuscules sans accents). Une image (photo de reçu) n'a pas de couche
// texte : rien ne s'allume.

const Ctx = createContext(null)

export function DocHighlightProvider({ children }) {
  const registry = useRef(new Map())
  const [version, setVersion] = useState(0)
  const [active, setActive] = useState(null)
  const [hasText, setHasText] = useState(false)
  const register = useCallback((k, spec) => {
    registry.current.set(k, spec)
    setVersion(v => v + 1)
    return () => { registry.current.delete(k); setVersion(v => v + 1) }
  }, [])
  const value = useMemo(() => ({
    registry, version, register, active, setActive, enabled: true, hasText, setHasText,
  }), [version, register, active, hasText])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useDocHighlight() { return useContext(Ctx) }

// Enveloppe d'un champ. `spec` : { text } | { amount } | { date } ou un tableau.
export function Hl({ k, spec, className = '', children }) {
  const ctx = useContext(Ctx)
  const specKey = JSON.stringify(spec ?? null)
  useEffect(() => {
    if (!ctx || spec == null) return undefined
    return ctx.register(k, Array.isArray(spec) ? spec : [spec])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx?.register, k, specKey])
  if (!ctx) return <div className={className}>{children}</div>
  const lit = ctx.enabled && ctx.hasText && ctx.active === k
  return (
    <div
      className={`${className} rounded-md transition-colors ${lit ? 'bg-sky-50 ring-2 ring-sky-300 ring-offset-2 ring-offset-white' : ''}`}
      onMouseEnter={() => ctx.setActive(k)}
      onMouseLeave={() => ctx.setActive(a => (a === k ? null : a))}
      data-hl={k}
    >
      {children}
    </div>
  )
}

// ── Recherche d'une valeur dans la couche texte ────────────────────────────────

const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim()

// Nombres écrits dans un fragment : « 1 204,77 », « 1,204.77 », « 465.08 $ », « -12,50 ».
function numbersIn(str) {
  const out = []
  const re = /-?\d{1,3}(?:[ \u00a0\u202f.,]\d{3})*[.,]\d{2}(?!\d)|-?\d+[.,]\d{2}(?!\d)/g
  let m
  while ((m = re.exec(str))) {
    const raw = m[0]
    const dec = raw.slice(-3, -2)
    const whole = raw.slice(0, -3).replace(/[ \u00a0\u202f.,]/g, '')
    const n = Number(`${whole}.${raw.slice(-2)}`)
    if (Number.isFinite(n) && (dec === '.' || dec === ',')) out.push(Math.abs(n))
  }
  return out
}

const MONTHS = [
  ['janvier', 'janv', 'jan', 'january'], ['fevrier', 'fevr', 'fev', 'february', 'feb'], ['mars', 'march', 'mar'],
  ['avril', 'avr', 'april', 'apr'], ['mai', 'may'], ['juin', 'june', 'jun'], ['juillet', 'juil', 'july', 'jul'],
  ['aout', 'august', 'aug'], ['septembre', 'sept', 'september', 'sep'], ['octobre', 'oct', 'october'],
  ['novembre', 'nov', 'november'], ['decembre', 'dec', 'december'],
]

function dateNeedles(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''))
  if (!m) return []
  const [, y, mo, d] = m
  const yy = y.slice(2)
  const di = String(Number(d))
  const mi = String(Number(mo))
  const out = [
    `${y}-${mo}-${d}`, `${y}/${mo}/${d}`, `${d}/${mo}/${y}`, `${mo}/${d}/${y}`, `${di}/${mi}/${y}`, `${mi}/${di}/${y}`,
    `${d}-${mo}-${y}`, `${mo}-${d}-${y}`, `${d}.${mo}.${y}`, `${d}/${mo}/${yy}`, `${mo}/${d}/${yy}`, `${di}/${mi}/${yy}`, `${mi}/${di}/${yy}`, `${y}${mo}${d}`,
  ]
  for (const name of MONTHS[Number(mo) - 1]) {
    for (const n of [name, `${name}.`]) {
      out.push(`${di} ${n} ${y}`, `${d} ${n} ${y}`, `${n} ${di}, ${y}`, `${n} ${d}, ${y}`, `${n} ${di} ${y}`, `${di}-${n}-${y}`, `${d}-${n}-${y}`, `${di}-${n}-${yy}`)
    }
  }
  return out.map(norm)
}

// pages : [{ items: [{ s, x, y, w, h }], full, spans: [[start, end, idx]] }]
function findRects(pages, spec) {
  const rects = []
  const pushItem = (pi, it) => rects.push({ page: pi, x: it.x, y: it.y, w: it.w, h: it.h })
  const searchText = needles => {
    let hit = false
    pages.forEach((p, pi) => {
      for (const n of needles) {
        if (!n || n.length < 3) continue
        let from = 0
        let at
        while ((at = p.full.indexOf(n, from)) !== -1) {
          hit = true
          const end = at + n.length
          for (const [s, e, idx] of p.spans) if (s < end && e > at) pushItem(pi, p.items[idx])
          from = end
        }
      }
    })
    return hit
  }
  if (spec.amount != null) {
    const target = Math.abs(Number(spec.amount))
    if (!Number.isFinite(target) || target < 0.005) return rects
    pages.forEach((p, pi) => p.items.forEach(it => {
      if (numbersIn(it.s).some(n => Math.abs(n - target) < 0.005)) pushItem(pi, it)
    }))
  } else if (spec.date) {
    searchText(dateNeedles(spec.date))
  } else if (spec.text) {
    const full = norm(spec.text)
    if (!searchText([full])) {
      // Repli : le mot le plus long (le nom imprimé diffère souvent du nom saisi).
      const word = full.split(/[^a-z0-9]+/).filter(w => w.length >= 4).sort((a, b) => b.length - a.length)[0]
      if (word) searchText([word])
    }
  }
  return rects
}

// ── Visionneuse ────────────────────────────────────────────────────────────────

export function DocHighlightViewer({ url, isPdf, title = 'Document', fileName }) {
  const ctx = useContext(Ctx)
  const wrapRef = useRef(null)
  const [width, setWidth] = useState(0)
  // zoom = échelle de rendu du PDF ; liveZoom = échelle affichée. Pendant un
  // pincement au trackpad, seul liveZoom bouge (agrandissement CSS immédiat) ;
  // le PDF est redessiné net à la nouvelle échelle une fois le geste fini.
  const [zoom, setZoom] = useState(1)
  const [liveZoom, setLiveZoom] = useState(1)
  const liveRef = useRef(1)
  const commitTimer = useRef(null)
  const applyZoom = useCallback(z => {
    clearTimeout(commitTimer.current)
    liveRef.current = z; setLiveZoom(z); setZoom(z)
  }, [])
  const [doc, setDoc] = useState(null)
  const [pages, setPages] = useState([]) // [{ w, h, items, full, spans }]
  const canvases = useRef([])
  const textLayers = useRef([])
  const [failed, setFailed] = useState(false)
  const setHasText = ctx?.setHasText

  useEffect(() => {
    const el = wrapRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(entries => {
      const w = Math.floor(entries[0].contentRect.width)
      setWidth(prev => (Math.abs(prev - w) > 4 ? w : prev))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Pincer au trackpad (le navigateur l'envoie comme une molette + Ctrl).
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return undefined
    const onWheel = e => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const z = Math.min(4, Math.max(0.5, liveRef.current * Math.exp(-e.deltaY * 0.01)))
      liveRef.current = z
      setLiveZoom(z)
      clearTimeout(commitTimer.current)
      commitTimer.current = setTimeout(() => setZoom(+z.toFixed(2)), 250)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => { el.removeEventListener('wheel', onWheel); clearTimeout(commitTimer.current) }
  }, [isPdf, failed])

  useEffect(() => {
    setDoc(null); setPages([]); setFailed(false); setHasText?.(false)
    if (!isPdf || !url) return undefined
    let cancelled = false
    let task = null
    ;(async () => {
      try {
        const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerSrc
        task = pdfjs.getDocument({ url })
        const d = await task.promise
        if (!cancelled) setDoc({ d, pdfjs })
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => { cancelled = true; task?.destroy()?.catch(() => {}) }
  }, [url, isPdf, setHasText])

  useEffect(() => {
    if (!doc || !width) return undefined
    let cancelled = false
    ;(async () => {
      const { d, pdfjs } = doc
      const out = []
      const n = Math.min(d.numPages, 15)
      for (let i = 1; i <= n; i++) {
        const page = await d.getPage(i)
        if (cancelled) return
        const base = page.getViewport({ scale: 1 })
        const scale = (width / base.width) * zoom
        const vp = page.getViewport({ scale })
        const tc = await page.getTextContent()
        if (cancelled) return
        const items = []
        const spans = []
        let full = ''
        for (const it of tc.items) {
          if (!it.str || !it.str.trim()) continue
          const tx = pdfjs.Util.transform(vp.transform, it.transform)
          const h = Math.hypot(tx[2], tx[3])
          items.push({ s: it.str, x: tx[4], y: tx[5] - h, w: it.width * scale, h })
          const piece = norm(it.str)
          spans.push([full.length, full.length + piece.length, items.length - 1])
          full += piece + ' '
        }
        out.push({ w: vp.width, h: vp.height, items, full, spans, page, vp, tc, pdfjs })
      }
      if (cancelled) return
      setPages(out)
      setHasText?.(out.some(p => p.items.length > 0))
    })().catch(() => { if (!cancelled) setFailed(true) })
    return () => { cancelled = true }
  }, [doc, width, zoom, setHasText])

  // Dessin des pages, une fois leurs canvases montés.
  useEffect(() => {
    const renders = []
    const layers = []
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    pages.forEach((p, i) => {
      const canvas = canvases.current[i]
      if (!canvas) return
      const vp = p.page.getViewport({ scale: p.vp.scale * dpr })
      canvas.width = Math.round(vp.width)
      canvas.height = Math.round(vp.height)
      const c2 = canvas.getContext('2d')
      c2.fillStyle = '#fff'
      c2.fillRect(0, 0, canvas.width, canvas.height)
      const r = p.page.render({ canvasContext: c2, viewport: vp })
      renders.push(r)
      r.promise.catch(() => {})
      // Couche texte invisible posée sur l'image : permet de sélectionner et copier.
      const tl = textLayers.current[i]
      if (tl) {
        tl.replaceChildren()
        tl.style.setProperty('--scale-factor', String(p.vp.scale))
        const layer = new p.pdfjs.TextLayer({ textContentSource: p.tc, container: tl, viewport: p.vp })
        layers.push(layer)
        layer.render().catch(() => {})
      }
    })
    return () => {
      renders.forEach(r => { try { r.cancel() } catch { /* fini */ } })
      layers.forEach(l => { try { l.cancel() } catch { /* fini */ } })
    }
  }, [pages])

  const matches = useMemo(() => {
    const m = new Map()
    if (!ctx || !pages.length) return m
    for (const [k, specs] of ctx.registry.current) {
      const rects = specs.flatMap(s => findRects(pages, s))
      if (rects.length) m.set(k, rects)
    }
    return m
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pages, ctx?.version])

  const on = ctx?.enabled
  const activeRects = on && ctx.active ? (matches.get(ctx.active) || []) : []

  function onMove(e, pi) {
    if (!on) return
    const box = e.currentTarget.getBoundingClientRect()
    const x = e.clientX - box.left
    const y = e.clientY - box.top
    let best = null
    let bestArea = Infinity
    for (const [k, rects] of matches) {
      for (const r of rects) {
        if (r.page !== pi) continue
        if (x >= r.x - 2 && x <= r.x + r.w + 2 && y >= r.y - 2 && y <= r.y + r.h + 2) {
          const a = r.w * r.h
          if (a < bestArea) { best = k; bestArea = a }
        }
      }
    }
    if (best !== ctx.active) ctx.setActive(best)
  }

  const step = d => applyZoom(Math.min(4, Math.max(0.5, +(Math.round(liveZoom * 4) / 4 + d).toFixed(2))))
  const toolbar = (
    <div className="sticky top-0 z-10 flex justify-end gap-1 mb-2 pointer-events-none">
      <div className="pointer-events-auto flex items-center gap-0.5 bg-white/90 border border-slate-200 rounded-lg shadow-sm px-1 py-0.5">
        <button type="button" onClick={() => step(-0.25)} className="p-1 text-slate-500 hover:text-slate-800" aria-label="Réduire" title="Réduire"><Minus size={13} /></button>
        <button type="button" onClick={() => applyZoom(1)} className="px-1 text-[11px] text-slate-500 tabular-nums whitespace-nowrap min-w-[2.75rem]" title="Taille normale">{Math.round(liveZoom * 100)} %</button>
        <button type="button" onClick={() => step(0.25)} className="p-1 text-slate-500 hover:text-slate-800" aria-label="Agrandir" title="Agrandir"><Plus size={13} /></button>
        <a href={url} download={fileName || title} data-testid="doc-download" className="p-1 text-slate-500 hover:text-slate-800" title="Télécharger" aria-label="Télécharger"><Download size={13} /></a>
        <a href={url} target="_blank" rel="noopener noreferrer" className="p-1 text-slate-500 hover:text-slate-800" title="Ouvrir dans un onglet" aria-label="Ouvrir le document"><ExternalLink size={13} /></a>
      </div>
    </div>
  )

  if (!isPdf) {
    return (
      <div ref={wrapRef} className="w-full relative">
        {toolbar}
        <div className={liveZoom > 1 ? 'overflow-auto' : 'flex justify-center'}>
          {url && <img src={url} alt={title} style={{ width: `${liveZoom * 100}%` }}
            className={`${liveZoom > 1 ? 'max-w-none' : 'max-w-full'} object-contain rounded shadow mx-auto`} />}
        </div>
      </div>
    )
  }

  if (failed) {
    return (
      <div ref={wrapRef} className="w-full h-full min-h-[600px]">
        <iframe src={url} title={title} className="w-full h-full min-h-[600px] rounded shadow" />
      </div>
    )
  }

  return (
    <div ref={wrapRef} className="w-full relative" data-testid="doc-viewer">
      {toolbar}
      <div className={liveZoom > 1 ? 'overflow-x-auto' : ''}>
        <div style={liveZoom !== zoom ? { zoom: liveZoom / zoom } : undefined}>
        {!pages.length && <div className="min-h-[500px]" />}
        {pages.map((p, i) => (
          <div
            key={i}
            className="relative mx-auto mb-3 shadow bg-white"
            style={{ width: p.w, height: p.h }}
            onMouseMove={e => onMove(e, i)}
            onMouseLeave={() => on && ctx.setActive(null)}
          >
            <canvas ref={el => { canvases.current[i] = el }} style={{ width: p.w, height: p.h }} className="block" aria-label={title} role="img" />
            <div ref={el => { textLayers.current[i] = el }} className="textLayer" />
            {activeRects.filter(r => r.page === i).map((r, j) => (
              <div
                key={j}
                className="absolute pointer-events-none rounded-sm bg-sky-400/25 ring-2 ring-sky-500"
                style={{ left: r.x - 2, top: r.y - 2, width: r.w + 4, height: r.h + 4 }}
              />
            ))}
          </div>
        ))}
        </div>
      </div>
    </div>
  )
}
