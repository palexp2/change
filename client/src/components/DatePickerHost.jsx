import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ChevronLeft, ChevronRight } from 'lucide-react'

// Calendrier unique de l'app pour TOUS les <input type="date"> : monté une fois
// dans App.jsx, il remplace le sélecteur natif (flèches haut/bas pour changer de
// mois) par un calendrier à bandeaux latéraux ‹ ›. Aucun appelant à modifier :
// un clic sur le champ (ou Alt+↓ / F4, ou input.showPicker()) ouvre le nôtre,
// et le jour choisi est écrit via le setter natif + événement `input` — React
// voit un onChange ordinaire. La saisie au clavier dans le champ reste native.
// Les champs date + heure (datetime-local) gardent le sélecteur du navigateur.

const WEEKDAYS = ['Di', 'Lu', 'Ma', 'Me', 'Je', 'Ve', 'Sa']
const pad = n => String(n).padStart(2, '0')
const iso = (y, m, d) => `${y}-${pad(m + 1)}-${pad(d)}`
const todayIso = () => { const t = new Date(); return iso(t.getFullYear(), t.getMonth(), t.getDate()) }
const isDateInput = el => el instanceof HTMLInputElement && el.type === 'date' && !el.disabled && !el.readOnly

function setInputValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

let openFromOutside = null
if (typeof HTMLInputElement !== 'undefined' && HTMLInputElement.prototype.showPicker) {
  const nativeShowPicker = HTMLInputElement.prototype.showPicker
  HTMLInputElement.prototype.showPicker = function showPicker() {
    if (isDateInput(this) && openFromOutside) return openFromOutside(this)
    return nativeShowPicker.call(this)
  }
}

const W = 288
const H = 290

export default function DatePickerHost() {
  const [input, setInput] = useState(null)
  const [view, setView] = useState({ y: 0, m: 0 })
  const [pos, setPos] = useState(null)
  const popRef = useRef(null)

  const open = useCallback((el) => {
    const [y, m] = (el.value || todayIso()).split('-').map(Number)
    setView({ y, m: m - 1 })
    setInput(el)
  }, [])
  const close = useCallback(() => { setInput(null); setPos(null) }, [])

  useEffect(() => {
    openFromOutside = open
    const onClick = (e) => {
      if (!isDateInput(e.target)) return
      e.preventDefault()
      open(e.target)
    }
    const onKey = (e) => {
      if (!isDateInput(e.target)) return
      if ((e.altKey && e.key === 'ArrowDown') || e.key === 'F4') { e.preventDefault(); open(e.target) }
    }
    document.addEventListener('click', onClick, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      openFromOutside = null
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const place = useCallback(() => {
    if (!input) return
    if (!input.isConnected) { close(); return }
    const r = input.getBoundingClientRect()
    const below = window.innerHeight - r.bottom >= H + 8 || r.top < H + 8
    setPos({
      top: below ? r.bottom + 4 : r.top - H - 4,
      left: Math.max(8, Math.min(r.left, window.innerWidth - W - 8)),
    })
  }, [input, close])

  useLayoutEffect(() => { place() }, [place])

  useEffect(() => {
    if (!input) return
    const onDown = (e) => {
      if (e.target === input || popRef.current?.contains(e.target)) return
      close()
    }
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      e.preventDefault(); e.stopImmediatePropagation(); close()
    }
    const onBlur = () => close()
    document.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    input.addEventListener('blur', onBlur)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
      input.removeEventListener('blur', onBlur)
    }
  }, [input, place, close])

  if (!input || !pos) return null

  const { y, m } = view
  const shift = (d) => setView(({ y, m }) => { const t = new Date(y, m + d, 1); return { y: t.getFullYear(), m: t.getMonth() } })
  const pick = (v) => { if (v !== input.value) setInputValue(input, v); close() }
  const selected = input.value
  const today = todayIso()
  const min = input.min || null
  const max = input.max || null
  const lead = new Date(y, m, 1).getDay()
  const days = new Date(y, m + 1, 0).getDate()
  const cells = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)]
  const title = new Date(y, m, 1).toLocaleDateString('fr-CA', { month: 'long', year: 'numeric' })
  const band = 'w-7 shrink-0 flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors'

  return createPortal(
    <div
      ref={popRef}
      data-testid="date-picker"
      onMouseDown={e => e.preventDefault()}
      style={{ position: 'fixed', top: pos.top, left: pos.left, width: W, zIndex: 10000 }}
      className="flex bg-white border border-slate-200 rounded-lg shadow-lg overflow-hidden select-none"
    >
      <button type="button" aria-label="Mois précédent" data-testid="date-picker-prev"
        className={`${band} border-r border-slate-100`} onClick={() => shift(-1)}>
        <ChevronLeft size={16} />
      </button>
      <div className="flex-1 px-2 py-2">
        <div className="flex items-center justify-between px-1 pb-1.5">
          <span className="text-sm font-semibold text-slate-800 first-letter:uppercase">{title}</span>
          <button type="button" className="text-xs text-slate-500 hover:text-brand-600"
            disabled={(min && today < min) || (max && today > max)} onClick={() => pick(today)}>
            Aujourd'hui
          </button>
        </div>
        <div className="grid grid-cols-7 text-center text-[11px] text-slate-400 pb-1">
          {WEEKDAYS.map(d => <span key={d}>{d}</span>)}
        </div>
        <div className="grid grid-cols-7 gap-0.5 text-center text-sm">
          {cells.map((d, i) => {
            if (d == null) return <span key={`e${i}`} />
            const v = iso(y, m, d)
            const off = (min && v < min) || (max && v > max)
            const cls = v === selected
              ? 'bg-brand-600 text-white font-semibold'
              : v === today
                ? 'ring-1 ring-inset ring-slate-300 text-slate-800 hover:bg-slate-100'
                : 'text-slate-700 hover:bg-slate-100'
            return (
              <button key={v} type="button" disabled={off} data-date={v}
                className={`h-8 rounded ${off ? 'text-slate-300 cursor-default' : cls}`}
                onClick={() => pick(v)}>
                {d}
              </button>
            )
          })}
        </div>
      </div>
      <button type="button" aria-label="Mois suivant" data-testid="date-picker-next"
        className={`${band} border-l border-slate-100`} onClick={() => shift(1)}>
        <ChevronRight size={16} />
      </button>
    </div>,
    document.body,
  )
}
