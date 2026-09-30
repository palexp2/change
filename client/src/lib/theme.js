import { useEffect, useState } from 'react'
import { ALL_LOOKS, AUTO_DARK, AUTO_LIGHT } from './looks.js'

// Looks — `data-look="<id>"` sur <html> (lu par le CSS) + classe `dark` ou
// `light` (lue par ce qui dessine sur <canvas> ou en `srcDoc`). Toutes les
// couleurs Tailwind passent par des variables CSS réécrites par look
// (voir client/tailwind.config.js et lib/looks.js).
//
// Le choix est stocké en localStorage : 'auto' (défaut, suit le système),
// 'light' / 'dark' (looks d'origine) ou l'id d'un look. L'application
// initiale se fait aussi dans un script inline de index.html (anti-flash).

export const THEME_KEY = 'erp.theme'
export const THEME_EVENT = 'erp:theme'

const byId = Object.fromEntries(ALL_LOOKS.map(l => [l.id, l]))

export function prefersDark() {
  try { return window.matchMedia('(prefers-color-scheme: dark)').matches } catch { return false }
}

/** Choix stocké : 'auto' ou un id de look. */
export function getLookChoice() {
  let stored = null
  try { stored = window.localStorage.getItem(THEME_KEY) } catch {}
  return byId[stored] ? stored : 'auto'
}

/** Look effectif (choix, « auto » résolu). */
export function getLook() {
  const c = getLookChoice()
  return byId[c === 'auto' ? (prefersDark() ? AUTO_DARK : AUTO_LIGHT) : c]
}

/** 'light' | 'dark' — mode du look actuel. */
export function getTheme() {
  return getLook().mode
}

export function applyLook(look = getLook()) {
  const root = document.documentElement
  root.setAttribute('data-look', look.id)
  root.classList.toggle('dark', look.mode === 'dark')
  root.classList.toggle('light', look.mode !== 'dark')
  // Looks « salle de lecture » : barre latérale dorée (cf. index.css, `.qne`).
  root.classList.toggle('qne', !!look.panel)
}

// Aperçu au survol du sélecteur : repeint l'app sans rien enregistrer.
// `applyLook()` sans argument revient au look gardé.
export function previewLook(id) {
  if (byId[id]) applyLook(byId[id])
}

export const THEME_MODE_KEY = 'erp.theme-mode'

export function setLook(choice) {
  const look = byId[choice === 'auto' ? (prefersDark() ? AUTO_DARK : AUTO_LIGHT) : choice] || byId[AUTO_LIGHT]
  try {
    window.localStorage.setItem(THEME_KEY, choice)
    window.localStorage.setItem(THEME_MODE_KEY, look.mode)
  } catch {}
  applyLook(look)
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: look.mode }))
}

// Corrige ce qu'a posé le script inline (look retiré depuis, par ex.) et
// « auto » suit le système en direct.
if (typeof window !== 'undefined' && window.matchMedia) {
  try {
    applyLook()
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (getLookChoice() === 'auto') setLook('auto')
    })
  } catch {}
}

// Thème courant sous forme de booléen réactif, pour les rares rendus qui ne
// peuvent pas passer par les classes Tailwind — typiquement un `srcDoc`
// d'iframe, qui n'hérite ni des variables CSS ni de la classe `.dark`.
export function useIsDark() {
  const [dark, setDark] = useState(() => getTheme() === 'dark')
  useEffect(() => {
    const onChange = () => setDark(getTheme() === 'dark')
    window.addEventListener(THEME_EVENT, onChange)
    return () => window.removeEventListener(THEME_EVENT, onChange)
  }, [])
  return dark
}
