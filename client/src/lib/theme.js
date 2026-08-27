// Mode nuit — une classe `dark` sur <html> suffit : toutes les couleurs
// Tailwind passent par des variables CSS réécrites sous `.dark`
// (voir client/tailwind.config.js).
//
// Le choix est stocké en localStorage ; sans choix explicite on suit la
// préférence système. L'application initiale se fait aussi dans un script
// inline de index.html pour éviter le flash blanc au chargement.

export const THEME_KEY = 'erp.theme'
export const THEME_EVENT = 'erp:theme'

export function prefersDark() {
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches } catch { return false }
}

/** 'light' | 'dark' — thème actuellement souhaité. */
export function getTheme() {
  let stored = null
  try { stored = window.localStorage.getItem(THEME_KEY) } catch {}
  if (stored === 'light' || stored === 'dark') return stored
  return prefersDark() ? 'dark' : 'light'
}

export function applyTheme(theme) {
  document.documentElement.classList.toggle('dark', theme === 'dark')
}

export function setTheme(theme) {
  try { window.localStorage.setItem(THEME_KEY, theme) } catch {}
  applyTheme(theme)
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: theme }))
}

export function toggleTheme() {
  const next = getTheme() === 'dark' ? 'light' : 'dark'
  setTheme(next)
  return next
}
