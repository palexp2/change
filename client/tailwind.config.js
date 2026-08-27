import plugin from 'tailwindcss/plugin'
import palette from 'tailwindcss/colors'

/* Mode nuit — les couleurs Tailwind sont servies via des variables CSS.
   Chaque nuance devient `rgb(var(--c-<palette>-<nuance>) / <alpha>)` ; le mode
   nuit se contente de réécrire les variables sous `.dark`. Aucune classe
   `dark:` à semer dans les ~5000 utilisations de `bg-white` / `text-slate-*`.

   - Neutres (slate, gray, white) : rampe sombre dédiée (fond page, surface,
     bordures, textes) — inversée mais calibrée à la main pour le contraste.
   - Palettes chromatiques : rampe simplement inversée (50↔950, 100↔900…),
     ce qui retourne d'un coup les pastilles `bg-amber-50 text-amber-800`.
   - `black` reste noir : il ne sert qu'aux voiles de modales. */

const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950]

const brand = {
  50:  '#EEFAF1',
  100: '#D2F4DD',
  200: '#A2E8B6',
  300: '#6BD588',
  400: '#43CC6E',
  500: '#2BC25C',
  600: '#21B14B',
  700: '#1B8E3C',
  800: '#167030',
  900: '#115825',
  950: '#062F12',
}

// Palettes chromatiques : rampe inversée en mode nuit.
const CHROMATIC = ['red', 'orange', 'amber', 'yellow', 'green', 'emerald', 'teal',
  'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'pink', 'rose']

// Neutres : surface #161b22 (cartes), fond page #0d1117, textes clairs.
const NEUTRAL_DARK = {
  50:  '#0d1117',
  100: '#21262d',
  200: '#2b323b',
  300: '#3d444d',
  400: '#7d8590',
  500: '#9198a1',
  600: '#b1bac4',
  700: '#d0d7de',
  800: '#e6edf3',
  900: '#f0f6fc',
  950: '#ffffff',
}
const NEUTRAL_WHITE_DARK = '#161b22'

function rgb(hex) {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16)
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`
}

const THEMED = { slate: palette.slate, gray: palette.gray, brand }
for (const name of CHROMATIC) THEMED[name] = palette[name]

// Couleurs exposées à Tailwind : rgb(var(--…) / <alpha-value>)
const colors = { white: 'rgb(var(--c-white) / <alpha-value>)' }
for (const [name, ramp] of Object.entries(THEMED)) {
  colors[name] = Object.fromEntries(
    SHADES.filter(s => ramp[s]).map(s => [s, `rgb(var(--c-${name}-${s}) / <alpha-value>)`])
  )
}

const lightVars = { '--c-white': rgb('#ffffff') }
const darkVars = { '--c-white': rgb(NEUTRAL_WHITE_DARK) }
for (const [name, ramp] of Object.entries(THEMED)) {
  const neutral = name === 'slate' || name === 'gray'
  for (const s of SHADES) {
    if (!ramp[s]) continue
    lightVars[`--c-${name}-${s}`] = rgb(ramp[s])
    darkVars[`--c-${name}-${s}`] = rgb(neutral ? NEUTRAL_DARK[s] : ramp[SHADES[SHADES.length - 1 - SHADES.indexOf(s)]])
  }
}

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      colors,
    },
  },
  plugins: [
    plugin(({ addBase }) => {
      addBase({
        ':root': lightVars,
        '.dark': { ...darkVars, 'color-scheme': 'dark' },
        // Échappatoire : sous-arbre qui reste en mode jour même en mode nuit.
        // Pour les écrans déjà conçus « sombres » (page de connexion), qui
        // s'inverseraient à contresens. Les variables les plus proches gagnent.
        '.theme-light': { ...lightVars, 'color-scheme': 'light' },
      })
    }),
  ],
}
