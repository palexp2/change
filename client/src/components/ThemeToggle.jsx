import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Moon, Sun } from 'lucide-react'
import { applyLook, getLook, getLookChoice, previewLook, setLook, THEME_EVENT } from '../lib/theme'
import { CLASSIC, LOOK_ROWS } from '../lib/looks'

// Petite fenêtre de l'app dans un look : bande du panneau, page, ligne de
// titre dorée et trois lignes de texte.
function windowColors(look) {
  if (look.id === 'light') return { frame: '#e9e2d4', rail: '#ffffff', page: '#faf6ef', title: '#21b14b', ink: '#3b342b' }
  if (look.id === 'dark') return { frame: '#0f0d0a', rail: '#1f1b15', page: '#16130e', title: '#4fc978', ink: '#e8e2d8' }
  const v = look.vars, p = look.panel
  return { frame: p['--c-bg'], rail: p['--c-bg'], page: v['--c-bg'], title: v['--c-title'], ink: v['--c-ink'] }
}

function LookWindow({ look, kept, onPreview, onKeep }) {
  const c = windowColors(look)
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={kept}
      aria-label={look.name}
      title={look.name}
      data-testid={`look-${look.id}`}
      onMouseEnter={() => onPreview(look.id)}
      onFocus={() => onPreview(look.id)}
      onClick={() => onKeep(look.id)}
      className={`relative flex w-14 h-9 rounded-md overflow-hidden shadow-md transition-transform hover:-translate-y-px
        focus-visible:outline-none ${kept ? 'ring-2 ring-offset-2 ring-offset-[#1c1f24] ring-[#e2bf76]' : ''}`}
      style={{ background: c.frame }}
    >
      <span className="w-[18%]" style={{ background: c.rail }} />
      <span className="relative flex-1 my-0.5 mr-0.5 rounded-[3px]" style={{ background: c.page }}>
        <i className="absolute h-px left-[35%] right-[35%] top-[22%]" style={{ background: c.title }} />
        {['45%', '60%', '75%'].map((t, i) => (
          <i key={t} className="absolute h-px left-[14%] opacity-55" style={{ top: t, right: i === 2 ? '30%' : '14%', background: c.ink }} />
        ))}
      </span>
    </button>
  )
}

const ROWS = [['Boréal', CLASSIC[0], CLASSIC[1]], ...LOOK_ROWS]

/** Choix du look. Survoler une fenêtre repeint toute l'app sans rien
    enregistrer ; quitter la grille, Échap ou un clic dehors revient au look
    gardé ; un clic garde le look. `compact` = rail / en-tête mobile. */
export default function ThemeToggle({ compact = false, className = '' }) {
  const [choice, setChoice] = useState(() => getLookChoice())
  const [look, setLookState] = useState(() => getLook())
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const btnRef = useRef(null)
  const menuRef = useRef(null)

  useEffect(() => {
    const onChange = () => { setChoice(getLookChoice()); setLookState(getLook()) }
    window.addEventListener(THEME_EVENT, onChange)
    return () => window.removeEventListener(THEME_EVENT, onChange)
  }, [])

  // À côté du bouton, pied aligné sur le pied du bouton.
  useLayoutEffect(() => {
    if (!open || !btnRef.current || !menuRef.current) return
    const r = btnRef.current.getBoundingClientRect()
    const m = menuRef.current
    const left = Math.min(window.innerWidth - m.offsetWidth - 6, r.right + 10)
    const top = Math.max(6, Math.min(window.innerHeight - m.offsetHeight - 6, r.bottom - m.offsetHeight))
    setPos({ left, top })
  }, [open])

  const close = () => { setOpen(false); setPos(null); applyLook() }

  useEffect(() => {
    if (!open) return
    const onDown = (e) => {
      if (!menuRef.current?.contains(e.target) && !btnRef.current?.contains(e.target)) close()
    }
    const onKey = (e) => { if (e.key === 'Escape') close() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const keep = (id) => { setLook(id); setOpen(false); setPos(null) }
  const Icon = look.mode === 'dark' ? Moon : Sun

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        data-testid="theme-toggle"
        data-theme={look.mode}
        data-look={look.id}
        onClick={() => (open ? close() : setOpen(true))}
        title="Thème"
        aria-label="Thème"
        aria-haspopup="menu"
        aria-expanded={open}
        className={
          compact
            ? `p-2 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors ${className}`
            : `p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors ${className}`
        }
      >
        <Icon size={compact ? 16 : 15} />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          role="menu"
          data-testid="look-menu"
          style={{ position: 'fixed', left: pos?.left ?? 0, top: pos?.top ?? 0, visibility: pos ? 'visible' : 'hidden', zIndex: 9999, background: '#1c1f24', color: '#d9ceb2' }}
          className="rounded-xl border border-[#3a3d44] shadow-[0_18px_40px_rgba(0,0,0,.55)] px-3 pt-3 pb-1"
        >
          <div className="grid grid-cols-[auto_56px_56px] gap-x-[11px] gap-y-2 items-center" onMouseLeave={() => applyLook()}>
            <span />
            <Sun size={12} className="justify-self-center text-[#bdb39a]" />
            <Moon size={12} className="justify-self-center text-[#bdb39a]" />
            {ROWS.map(([name, day, night]) => (
              <div key={name} className="contents">
                <span className="pr-2 text-[10.5px] leading-tight tracking-[.16em] uppercase font-medium" style={{ fontFamily: "'Cinzel', Georgia, serif" }}>{name}</span>
                <LookWindow look={day} kept={choice === day.id} onPreview={previewLook} onKeep={keep} />
                <LookWindow look={night} kept={choice === night.id} onPreview={previewLook} onKeep={keep} />
              </div>
            ))}
          </div>
          <div className="h-px bg-[#33363c] mt-2.5 mb-0.5" />
          <button
            type="button"
            data-testid="look-auto"
            onMouseEnter={() => applyLook()}
            onClick={() => keep('auto')}
            className="flex items-center gap-2 w-full px-1 py-2 text-left text-sm text-[#cfc6b0] hover:text-[#e2bf76]"
          >
            <span className="w-3.5 flex-shrink-0">{choice === 'auto' && <Check size={14} className="text-[#e2bf76]" />}</span>
            Automatique (jour / nuit)
          </button>
        </div>,
        document.body
      )}
    </>
  )
}
