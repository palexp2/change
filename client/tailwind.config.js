import plugin from 'tailwindcss/plugin'
import palette from 'tailwindcss/colors'

/* Mode nuit — les couleurs Tailwind sont servies via des variables CSS.
   Chaque nuance devient `rgb(var(--c-<palette>-<nuance>) / <alpha>)` ; le mode
   nuit se contente de réécrire les variables sous `.dark`. Aucune classe
   `dark:` à semer dans les ~5000 utilisations de `bg-white` / `text-slate-*`.

   - Neutres (slate, gray, white) : rampe chaude dédiée (fond page crème,
     surface blanche, bordures et textes tièdes), déclinée jour et nuit.
   - Palettes chromatiques : réchauffées en jour (cf. `warmChromatic`), puis
     simplement inversées en nuit (50↔950, 100↔900…), ce qui retourne d'un
     coup les pastilles `bg-amber-50 text-amber-800` et propage le
     réchauffement au thème sombre.
   - `black` reste noir : il ne sert qu'aux voiles de modales.

   Reskin 2026-08 : la rampe neutre est passée d'un gris-bleu froid à un
   crème chaud (teinte 40°). Les *clartés* des nuances slate d'origine sont
   conservées à l'identique — seules la teinte et la saturation changent —
   pour ne pas déplacer les rapports de contraste de l'app. Deux exceptions
   assumées : `slate-50` est légèrement assombri (le fond de page doit lire
   comme du crème, pas comme du blanc), et `slate-950` très légèrement
   éclairci. */

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

// Palettes chromatiques : réchauffées en jour, rampe inversée en mode nuit.
const CHROMATIC = ['red', 'orange', 'amber', 'yellow', 'green', 'emerald', 'teal',
  'cyan', 'sky', 'blue', 'indigo', 'violet', 'purple', 'pink', 'rose']

/* ── Conversions couleur ────────────────────────────────────────────── */

function hexToRgb(hex) {
  const h = hex.replace('#', '')
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

function rgbToHex([r, g, b]) {
  const to = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return '#' + to(r) + to(g) + to(b)
}

function hexToHsl(hex) {
  let [r, g, b] = hexToRgb(hex).map(v => v / 255)
  const max = Math.max(r, g, b), min = Math.min(r, g, b)
  const l = (max + min) / 2
  let h = 0, s = 0
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0))
    else if (max === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h *= 60
  }
  return [h, s * 100, l * 100]
}

function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360
  s = Math.max(0, Math.min(100, s)) / 100
  l = Math.max(0, Math.min(100, l)) / 100
  const k = n => (n + h / 30) % 12
  const a = s * Math.min(l, 1 - l)
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  return rgbToHex([f(0) * 255, f(8) * 255, f(4) * 255])
}

// Mélange linéaire de deux hex — sert à rapprocher les nuances basses des
// palettes chromatiques du fond crème, pour qu'elles cessent de paraître
// grisâtres une fois posées dessus.
function mix(a, b, t) {
  const A = hexToRgb(a), B = hexToRgb(b)
  return rgbToHex([0, 1, 2].map(i => A[i] + (B[i] - A[i]) * t))
}

/* ── Neutres chauds ─────────────────────────────────────────────────── */

const WARM_HUE = 40

// [clarté, saturation] par nuance. Les clartés reprennent celles de `slate`
// (cf. commentaire d'en-tête) ; la saturation croît fortement vers les
// nuances claires — en HSL, à 97 % de clarté, une saturation « normale » ne
// produit plus aucune chroma visible et le crème retombe au blanc.
const WARM_LIGHT_STOPS = {
  50:  [96.8, 40], 100: [94.6, 32], 200: [90.8, 24], 300: [84.5, 18],
  400: [65.1, 13], 500: [46.9, 10], 600: [34.5, 9],  700: [26.3, 10],
  800: [17.8, 11], 900: [11.6, 13], 950: [5.4, 15],
}

// Rampe sombre : même teinte, saturation basse. Fond page ≈ #16130E,
// surfaces (`bg-white`) ≈ #1F1B15. Les clartés reprennent celles de
// l'ancienne rampe GitHub, pour ne rien déplacer côté contraste.
const WARM_DARK_STOPS = {
  50:  [7.8, 9],  100: [15.0, 8], 200: [20.4, 8], 300: [27.0, 7],
  400: [53.0, 6], 500: [60.0, 5], 600: [73.0, 4], 700: [84.0, 4],
  800: [92.0, 5], 900: [96.0, 6], 950: [100, 0],
}

const warmRamp = stops => Object.fromEntries(
  SHADES.map(s => [s, hslToHex(WARM_HUE, stops[s][1], stops[s][0])])
)

const WARM_LIGHT = warmRamp(WARM_LIGHT_STOPS)
const WARM_DARK = warmRamp(WARM_DARK_STOPS)

// `bg-white` : blanc pur en jour (les surfaces se détachent du fond crème),
// une surface tiède au-dessus du fond en nuit.
const WHITE_LIGHT = '#ffffff'
const WHITE_DARK = hslToHex(WARM_HUE, 8, 11)

// Fond de page (`bg-slate-50`) en jour, pour rapprocher les nuances basses
// des palettes chromatiques du crème sur lequel elles reposent.
const CREAM = WARM_LIGHT[50]

/* ── Réchauffement des palettes chromatiques ────────────────────────── */

/* Deux opérations, indépendantes :

   1. Rotation de teinte. Les palettes déjà chaudes ne bougent quasi pas ; les
      froides (cyan → indigo) sont décalées — les bleus vers le sarcelle, les
      indigo/violet vers le prune — pour qu'elles cessent de trancher avec un
      fond crème. Les nuances hautes (600+), qui portent du texte, tournent
      moins : leur rôle est la lisibilité, pas l'ambiance.

   2. Mélange des nuances basses (50 → 200) vers le crème. Ce sont les fonds
      de pastille ; sans ça leur point blanc reste celui d'un fond gris-bleu
      et elles paraissent sales. */

const HUE_SHIFT = {
  red: 2, orange: 1, amber: 0, yellow: 0, rose: 4,
  green: -6, emerald: -8, teal: -12,
  cyan: -14, sky: -16, blue: -14, indigo: 16, violet: 18, purple: 14, pink: 8,
}

const CREAM_MIX = { 50: 0.20, 100: 0.12, 200: 0.06 }

function warmChromatic(name, ramp) {
  const shift = HUE_SHIFT[name] ?? 0
  return Object.fromEntries(SHADES.filter(s => ramp[s]).map(s => {
    const [h, sat, l] = hexToHsl(ramp[s])
    // Les nuances porteuses de texte tournent à moitié.
    const factor = s >= 600 ? 0.5 : 1
    let hex = hslToHex(h + shift * factor, sat, l)
    if (CREAM_MIX[s]) hex = mix(hex, CREAM, CREAM_MIX[s])
    return [s, hex]
  }))
}

/* ── Assemblage des variables ───────────────────────────────────────── */

const THEMED = { slate: WARM_LIGHT, gray: WARM_LIGHT, brand }
for (const name of CHROMATIC) THEMED[name] = warmChromatic(name, palette[name])

function rgb(hex) {
  return hexToRgb(hex).join(' ')
}

// Couleurs exposées à Tailwind : rgb(var(--…) / <alpha-value>)
const colors = { white: 'rgb(var(--c-white) / <alpha-value>)' }
for (const [name, ramp] of Object.entries(THEMED)) {
  colors[name] = Object.fromEntries(
    SHADES.filter(s => ramp[s]).map(s => [s, `rgb(var(--c-${name}-${s}) / <alpha-value>)`])
  )
}

const lightVars = { '--c-white': rgb(WHITE_LIGHT), '--c-shadow': '58 44 24' }
const darkVars = { '--c-white': rgb(WHITE_DARK), '--c-shadow': '0 0 0' }
for (const [name, ramp] of Object.entries(THEMED)) {
  const neutral = name === 'slate' || name === 'gray'
  for (const s of SHADES) {
    if (!ramp[s]) continue
    lightVars[`--c-${name}-${s}`] = rgb(ramp[s])
    darkVars[`--c-${name}-${s}`] = rgb(
      neutral ? WARM_DARK[s] : ramp[SHADES[SHADES.length - 1 - SHADES.indexOf(s)]]
    )
  }
}

/* ── Ombres ─────────────────────────────────────────────────────────── */

/* Reskin 2026-08 : l'ombre ne sert plus qu'à dire « ceci flotte au-dessus du
   contenu ». Les surfaces fixes (cartes, panneaux) se détachent par leur
   bordure chaude sur le fond crème, pas par une ombre.

   La répartition des usages dans l'app tombe juste : `shadow-sm` est posé sur
   du fixe (~50 fois), `shadow-lg`/`xl`/`2xl` sur des modales, menus et
   tiroirs (~65 fois). On ramène donc `sm` à un filet quasi nul et on rend les
   grandes tailles franches. Teinte pilotée par `--c-shadow` : brun chaud en
   jour, noir en nuit (une ombre chaude ne se voit pas sur fond sombre). */

const sh = (a) => `rgb(var(--c-shadow) / ${a})`

const boxShadow = {
  sm: `0 1px 1px ${sh(0.04)}`,
  DEFAULT: `0 1px 2px ${sh(0.05)}`,
  md: `0 1px 3px ${sh(0.06)}, 0 4px 10px -4px ${sh(0.10)}`,
  lg: `0 2px 4px ${sh(0.07)}, 0 14px 34px -10px ${sh(0.26)}`,
  xl: `0 4px 8px ${sh(0.08)}, 0 26px 60px -14px ${sh(0.30)}`,
  '2xl': `0 8px 12px ${sh(0.09)}, 0 40px 90px -20px ${sh(0.38)}`,
  inner: `inset 0 2px 4px 0 ${sh(0.05)}`,
  none: 'none',
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
        // Inter en premier (façon Airtable) — repli sur la pile système
        // d'origine si le CDN de police est indisponible, aucune régression.
        sans: ['Inter', 'InterVariable', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
      colors,
      boxShadow,
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
