import { useEffect, useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import { getTheme, toggleTheme, THEME_EVENT } from '../lib/theme'

/** Bouton mode jour / mode nuit. `compact` = version icône seule (rail replié,
    en-tête mobile) ; sinon icône + libellé pour la sidebar dépliée. */
export default function ThemeToggle({ compact = false, className = '' }) {
  const [theme, setThemeState] = useState(() => getTheme())

  useEffect(() => {
    const onChange = (e) => setThemeState(e.detail || getTheme())
    window.addEventListener(THEME_EVENT, onChange)
    return () => window.removeEventListener(THEME_EVENT, onChange)
  }, [])

  const dark = theme === 'dark'
  const label = dark ? 'Mode jour' : 'Mode nuit'
  const Icon = dark ? Sun : Moon

  return (
    <button
      type="button"
      data-testid="theme-toggle"
      data-theme={theme}
      onClick={() => setThemeState(toggleTheme())}
      title={label}
      aria-label={label}
      aria-pressed={dark}
      className={
        compact
          ? `p-2 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors ${className}`
          : `p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors ${className}`
      }
    >
      <Icon size={compact ? 16 : 15} />
    </button>
  )
}
