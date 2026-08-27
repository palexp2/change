# ERP Orisha — Style & organisation de l'interface

Le langage visuel de l'app, puis le code qui le porte. Référence assumée :
**Airtable** — dense, calme, tout se fait sur place, rien ne clignote.

---

# 1. Le langage visuel

## Palette

Tout passe par **Tailwind**, avec une seule couleur de marque et une seule rampe
de neutres. Aucune couleur en dur dans les composants.

| Rôle | Jeton | Valeur (jour) |
|---|---|---|
| Marque (actions, actif, focus) | `brand-600` | `#21B14B` (vert Orisha) |
| Marque — fonds légers | `brand-50/100` | `#EEFAF1` / `#D2F4DD` |
| Fond de page | `slate-50` | |
| Surface (cartes, panneaux, sidebar) | `white` | |
| Bordures | `slate-200` (`slate-100` pour les séparateurs internes) | |
| Texte principal | `slate-900` | |
| Texte secondaire | `slate-500` | |
| Texte tertiaire / icônes inactives | `slate-400` | |
| Succès / attention / erreur | `green-*` / `amber-*` / `red-*` en 50-100 (fond) + 700-800 (texte) | |

**Mode nuit** : aucune classe `dark:` nulle part. Chaque nuance Tailwind est servie
comme `rgb(var(--c-<palette>-<nuance>))` et le mode nuit réécrit les variables sous
`.dark` (neutres = rampe sombre calibrée à la main, surface `#161b22`, fond page
`#0d1117` ; palettes chromatiques simplement inversées 50↔950). Voir
`tailwind.config.js` plus bas. Échappatoire : `.theme-light` pour un sous-arbre qui
doit rester clair (écrans déjà conçus sombres, ex. la page de connexion).

## Typographie

- Police système (`-apple-system, BlinkMacSystemFont, Segoe UI, Roboto`).
- **`text-sm` est la taille par défaut de l'interface.** `text-xs` pour les
  métadonnées, libellés de colonnes, badges. `text-2xl font-bold` pour le titre de
  page, `text-lg font-semibold` pour un titre de section ou de modale.
- Graisses : `font-medium` pour les libellés et éléments actifs, `font-semibold`
  pour les titres, `font-bold` réservé au H1. Jamais de majuscules forcées.
- Les nombres d'argent et les quantités sont alignés à droite en tabulaire.

## Espacement & formes

- Page : `p-6`, contenu contraint (`max-w-5xl`) sur les pages de travail, pleine
  largeur pour les tableaux.
- Rayons : `rounded-lg` pour les cartes et les champs, `rounded-xl` pour les menus
  flottants et les gros panneaux, `rounded-full` pour les badges et les pastilles.
- Ombres : quasi absentes à plat (`border` suffit) ; `shadow-xl` / `shadow-2xl`
  uniquement pour ce qui flotte au-dessus (menus, drawer, modales).
- Densité : lignes de tableau compactes, `gap-1.5`/`gap-2` entre éléments liés,
  `mb-4`/`mb-5` entre blocs.

## Chrome de l'application

- **Sidebar blanche à gauche** (`w-60`, `bg-white border-r border-slate-200`),
  repliable en rail d'icônes de `w-12` — l'état est mémorisé
  (`localStorage: erp.sidebar.collapsed`). Replié, le survol du rail ouvre un
  *peek* flottant en `left-12`. Pas de barre de navigation en haut : la décision de
  la barre supérieure a été abandonnée.
- Les entrées de nav sont réordonnables (glisser), regroupées en sections, avec
  sous-menus (`?onglet=…`). Le survol d'un lien **préfetche** la liste de la page
  après 120 ms d'intention.
- **⌘K** ouvre la recherche globale unifiée ; **?** liste les raccourcis clavier
  (source unique : `NAV_SHORTCUTS` dans `Layout.jsx`).
- En bas à droite : le FAB « Modifier le système », le bouton du panneau Travaux,
  l'interrupteur jour/nuit.

## Règles d'interaction (celles qui font le « feel »)

1. **Autosave partout.** Tout champ éditable sauvegarde au blur ou en debounce
   ~500 ms. Pas de bouton « Enregistrer » dans les fiches détail. L'état de
   sauvegarde est visible mais ne bloque jamais (`SaveStatus.jsx`).
2. **Aucune re-confirmation sur une action réversible.** Un clic = fait, la ligne
   part tout de suite (UI optimiste), l'annulation est offerte après coup
   (`UndoSendProvider.jsx`, `undoableDelete.js`). `ConfirmProvider` est réservé au
   destructeur non réversible.
3. **Tout menu de plus de 10 options a une zone de recherche** (`SearchableSelect`,
   `FilterRow`, `ViewToolbar`).
4. **Un champ qui référence un autre record** offre deux affordances : un picker
   recherchable *et* un lien cliquable vers la fiche (`LinkedRecordField.jsx`) —
   jamais un simple libellé texte.
5. **Ouvrir sans quitter la page** : le side-peek drawer (`RecordPeekDrawer.jsx`)
   monte la page détail dans un panneau latéral (`peek` sur `DataTable`).
6. **Le feedback est un toast**, jamais une alerte bloquante (`ToastProvider.jsx`).
7. **Les tableaux sont des vues** : colonnes, filtres, tris, groupes, pills de vues
   sauvegardées — le tout persisté côté serveur (`ViewToolbar.jsx`,
   `useTableView.js`).
8. **États vides et erreurs sont dessinés**, pas laissés en blanc
   (`EmptyState.jsx`, `DetailLoadError.jsx`, `ErrorBoundary.jsx`,
   `ServerOfflineOverlay.jsx` quand le serveur redémarre).

## Organisation du code

```
client/src/
  components/       primitives partagées + gros composants (DataTable, ViewToolbar…)
    ui/             providers et micro-composants (toasts, icônes dynamiques)
    modals/         modales spécifiques à un domaine
  pages/            une page = une route ; *Detail.jsx = fiche d'un record
  lib/              hooks et logique sans JSX (api, vues, thème, nav, realtime…)
  contexts/         contextes React globaux
  index.css         CSS global (le reste est en classes Tailwind)
```

Règle de fond : **codebase clean et minimaliste, on réutilise le plus possible.**
Un nouveau composant ne naît que si aucune primitive existante ne couvre le besoin.

---

# 2. Le code


# 2.1 — Fondations du thème


---

## `client/tailwind.config.js`

**Le cœur du système de couleurs** : palette de marque, rampes, et le mécanisme mode nuit par variables CSS.

```js
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
```


---

## `client/index.html (extrait)`

Bootstrap du thème avant le premier rendu — évite le flash blanc.

```html
    <link rel="icon" type="image/png" href="/erp/favicon.png" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Orisha ERP</title>
    <!-- Mode nuit appliqué avant le premier rendu : évite le flash blanc.
         Même logique que client/src/lib/theme.js (clé erp.theme). -->
    <script>
      (function () {
        try {
          var t = localStorage.getItem('erp.theme')
          if (t !== 'light' && t !== 'dark') {
            t = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
          }
          if (t === 'dark') document.documentElement.classList.add('dark')
        } catch (e) {}
      })()
    </script>
```


---

## `client/src/lib/theme.js`

État du thème : localStorage `erp.theme`, défaut = préférence système, événement `erp:theme`.

```js
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
```


---

## `client/src/components/ThemeToggle.jsx`

L'interrupteur jour / nuit.

```jsx
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
```


---

## `client/src/index.css`

CSS global : animations, sliders. Tout le reste est en classes Tailwind.

```css
@import 'react-grid-layout/css/styles.css';
@import 'react-resizable/css/styles.css';

@tailwind base;
@tailwind components;
@tailwind utilities;

@keyframes slide-in-up {
  from { transform: translateY(16px); opacity: 0; }
  to   { transform: translateY(0);    opacity: 1; }
}
.animate-slide-in-up {
  animation: slide-in-up 0.2s ease-out;
}

/* Dual range slider — used in Dashboard top-products date picker */
.range-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  background: transparent;
  pointer-events: none;
}
.range-slider-thumb::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  pointer-events: auto;
  width: 18px;
  height: 18px;
  border-radius: 9999px;
  background: rgb(var(--c-white));
  border: 2px solid #21B14B;
  box-shadow: 0 1px 3px rgba(0,0,0,0.15);
  cursor: grab;
}
.range-slider-thumb::-webkit-slider-thumb:active { cursor: grabbing; }
.range-slider-thumb::-moz-range-thumb {
  pointer-events: auto;
  width: 18px;
  height: 18px;
  border-radius: 9999px;
  background: rgb(var(--c-white));
  border: 2px solid #21B14B;
  box-shadow: 0 1px 3px rgba(0,0,0,0.15);
  cursor: grab;
}
.range-slider-thumb::-moz-range-track { background: transparent; border: none; }

@layer base {
  * {
    box-sizing: border-box;
  }
  body {
    @apply bg-slate-50 text-slate-900 antialiased;
  }

  /* Custom scrollbar — subtle, matches the ERP aesthetic */
  ::-webkit-scrollbar { width: 6px; height: 6px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { @apply bg-slate-300 rounded-full; }
  ::-webkit-scrollbar-thumb:hover { @apply bg-slate-400; }

  /* Dark areas use a dark scrollbar */
  .bg-slate-900 ::-webkit-scrollbar-thumb,
  .bg-slate-950 ::-webkit-scrollbar-thumb { @apply bg-slate-700; }
  .bg-slate-900 ::-webkit-scrollbar-thumb:hover,
  .bg-slate-950 ::-webkit-scrollbar-thumb:hover { @apply bg-slate-600; }
}

@layer utilities {
  /* Texte posé sur une surface toujours sombre (voile noir d'une modale,
     vignette d'image) : reste blanc même en mode nuit, contrairement à
     `text-white` qui suit la variable de surface. */
  .text-fixed-white { color: #fff; }
}

@layer components {
  .btn {
    @apply inline-flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-all focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed;
  }
  .btn-primary {
    @apply btn bg-brand-600 text-white hover:bg-brand-500 focus:ring-brand-500 shadow-sm shadow-brand-200;
  }
  .btn-secondary {
    @apply btn bg-white text-slate-700 border border-slate-200 hover:bg-slate-50 hover:border-slate-300 focus:ring-brand-500 shadow-sm;
  }
  .btn-danger {
    @apply btn bg-red-600 text-white hover:bg-red-500 focus:ring-red-500 shadow-sm shadow-red-100;
  }
  .btn-sm {
    @apply px-3 py-1.5 text-xs;
  }
  .card {
    @apply bg-white rounded-xl border border-slate-200/80 shadow-sm;
  }
  .input {
    @apply block w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-400 transition-all;
  }
  .label {
    @apply block text-sm font-medium text-slate-600 mb-1;
  }
  .select {
    @apply input appearance-none cursor-pointer;
  }
  .table-row-hover {
    @apply hover:bg-slate-50/80 cursor-pointer transition-colors;
  }
}

@keyframes slide-in-right {
  from { transform: translateX(100%); }
  to   { transform: translateX(0); }
}
.animate-slide-in-right {
  animation: slide-in-right 0.2s ease-out;
}

@keyframes fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
.animate-fade-in {
  animation: fade-in 0.15s ease-out;
}

/* DataTable — indicateur live « modifié par un autre utilisateur ».
   Halo vert sur la cellule changée + badge éditeur, qui s'estompent.
   Durée alignée sur FLASH_MS dans DataTable.jsx (3.6s). */
@keyframes dtCellFlash {
  0%   { background-color: rgba(16, 185, 129, 0.30); box-shadow: inset 0 0 0 2px rgba(16, 185, 129, 0.70); }
  70%  { background-color: rgba(16, 185, 129, 0.12); box-shadow: inset 0 0 0 2px rgba(16, 185, 129, 0.30); }
  100% { background-color: transparent;             box-shadow: inset 0 0 0 2px transparent; }
}
.dt-cell-flash {
  animation: dtCellFlash 3.6s ease-out forwards;
  border-radius: 4px;
}
@keyframes dtEditorBadge {
  0%   { opacity: 0; transform: translateY(-50%) translateX(6px); }
  12%  { opacity: 1; transform: translateY(-50%) translateX(0); }
  75%  { opacity: 1; transform: translateY(-50%) translateX(0); }
  100% { opacity: 0; transform: translateY(-50%) translateX(0); }
}
.dt-editor-badge {
  animation: dtEditorBadge 3.6s ease-out forwards;
}
```


# 2.2 — Chassis : sidebar, navigation, recherche


---

## `client/src/components/Layout.jsx`

**Le chassis de toutes les pages** : sidebar blanche repliable (rail 48 px + peek au survol), sections et sous-menus, réordonnancement par glisser, prefetch au survol, raccourcis clavier, montage du FAB et du panneau Travaux.

```jsx
import { useState, useEffect, useRef, useLayoutEffect, useMemo, createContext, useContext } from 'react'
import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import {
  Settings,
  ChevronRight, ChevronDown, LogOut, Menu, X,
  Search, ExternalLink, Sparkles, Bot,
  PanelLeftClose, PanelLeftOpen, GripVertical,
} from 'lucide-react'
import { useAuth } from '../lib/auth.jsx'
import { useNavPrefs } from '../lib/navPrefs.jsx'
import { defaultNavItems, applyNavOrder, navKey } from '../lib/navItems.js'
import { getSubsections, resolveSubsections } from '../lib/navSubsections.js'
import { NAV_TAB_CLAIMS } from '../lib/financeSections.js'
import { api } from '../lib/api.js'
import { prefetch } from '../lib/prefetch.js'
import { connect as realtimeConnect, disconnect as realtimeDisconnect } from '../lib/realtime.js'
import { hasUnseenChangelog, CHANGELOG_SEEN_EVENT } from '../lib/changelog.js'
import { Modal } from './Modal.jsx'
import { KeyboardShortcutsModal } from './KeyboardShortcutsModal.jsx'
import { GlobalSearch as CRMSearch } from './GlobalSearch.jsx'
import { FeedbackFab } from './FeedbackFab.jsx'
import ThemeToggle from './ThemeToggle.jsx'
import { TravauxQuickButton } from './TravauxQuickPanel.jsx'

// Raccourcis clavier de navigation globaux — source unique de vérité.
// Le handler clavier de Layout construit sa table de routage à partir d'ici,
// et la modale d'aide (« ? ») les liste pour les rendre découvrables. Ajouter
// un raccourci = ajouter une entrée ici (et rien d'autre).
export const NAV_SHORTCUTS = [
  { key: 'd', label: 'Tableau de bord', to: '/dashboard' },
  { key: 't', label: 'Feuille de temps', to: '/feuille-de-temps' },
  { key: 'b', label: 'Tickets', to: '/tickets' },
  { key: 'p', label: 'Pipeline', to: '/pipeline' },
  { key: 'c', label: 'Commandes', to: '/orders' },
]

// When the user hovers a nav link, kick off the page's primary list fetch.
// The request-level cache in prefetch.js keeps the in-flight promise, so the
// fetch fired on page mount (the real <NavLink> click) reuses it instead of
// re-hitting the server. Each entry mirrors the exact args the target page
// passes to its first api.*.list(...) call — ordering matters for the
// cache key (URLSearchParams preserves insertion order).
// Note : les pages qui lisent depuis le cache global (`useTable` hydraté par
// /api/bootstrap) ne sont pas listées ici — leur prefetch serait gaspillé.
// Pages cachées actuellement : /contacts, /products, /orders, /tickets,
// /tasks, /retours, /purchases, /items-vendus.
const NAV_PREFETCH = {
  '/interactions':  () => api.interactions.list({ limit: 'all', offset: 0 }),
  '/companies':     () => api.companies.list({ limit: 'all', page: 1 }),
  '/factures':      () => api.factures.list({ limit: 'all', page: 1 }),
  '/abonnements':   () => api.abonnements.list({ limit: 'all', page: 1 }),
  '/abonnements/mouvements': () => api.abonnements.events({ limit: 'all', page: 1 }),
  '/discovery-forms': () => api.discoveryForms.list({ limit: 'all' }),
}

// Short delay so sweeping the mouse across the sidebar doesn't trigger a
// dozen fetches — only hovers that last this long count as intent.
const PREFETCH_DELAY_MS = 120

function useHoverPrefetch(to) {
  const timerRef = useRef(null)
  const firedRef = useRef(false)
  const getter = NAV_PREFETCH[to]
  const onEnter = () => {
    if (!getter || firedRef.current) return
    timerRef.current = setTimeout(() => {
      firedRef.current = true
      prefetch(getter)
    }, PREFETCH_DELAY_MS)
  }
  const onLeave = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
  }
  return { onMouseEnter: onEnter, onMouseLeave: onLeave }
}

// `compact` : dimensions des sous-items d'un groupe (vs ligne pleine hauteur).
function NavItem({ to, href, external, icon: Icon, label, compact = false }) {
  const hover = useHoverPrefetch(to)
  if (external) {
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        data-testid="nav-external"
        className={`flex items-center text-sm font-medium transition-all
          text-slate-600 hover:text-slate-900 hover:bg-slate-100
          ${compact ? 'gap-2.5 px-3 py-1.5 rounded-md' : 'gap-3 px-3 py-2 rounded-lg'}`}
      >
        <Icon size={compact ? 14 : 16} className="flex-shrink-0" />
        <span className="flex-1">{label}</span>
        <ExternalLink size={12} className="flex-shrink-0 text-slate-400" />
      </a>
    )
  }
  return (
    <NavLink
      to={to}
      {...hover}
      className={({ isActive }) =>
        `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all
        ${isActive
          ? 'bg-brand-600 text-white shadow-sm'
          : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
        }`
      }
    >
      <Icon size={16} className="flex-shrink-0" />
      <span className="flex-1">{label}</span>
    </NavLink>
  )
}

// ── Chaîne de survol des panneaux flottants ─────────────────────────────────
// Un panneau se ferme quand la souris le quitte. Avec des sous-menus imbriqués,
// entrer dans l'enfant, c'est quitter le parent : sans coordination, le parent
// se fermerait et emporterait l'enfant. Chaque panneau ouvert s'annonce donc à
// son parent, qui compte les rectangles de ses descendants comme « dedans ».
const FlyoutChainContext = createContext(null)

function useFlyoutChain(panelRef, open) {
  const parent = useContext(FlyoutChainContext)
  const childRectsRef = useRef(new Set())
  const chain = useMemo(() => ({
    add: (fn) => childRectsRef.current.add(fn),
    remove: (fn) => childRectsRef.current.delete(fn),
  }), [])

  useEffect(() => {
    if (!parent || !open) return
    const getRect = () => panelRef.current?.getBoundingClientRect()
    parent.add(getRect)
    return () => parent.remove(getRect)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parent, open])

  const childRects = () => [...childRectsRef.current].map(fn => fn()).filter(Boolean)
  return { chain, childRects }
}

// Position d'un panneau à droite de son déclencheur : remonté s'il déborderait
// en bas, rabattu à gauche s'il déborderait à droite (tiroir mobile, sous-menu
// de sous-menu).
function useFlyoutPosition(triggerRef, panelRef, open) {
  const [pos, setPos] = useState(null)

  const seed = () => {
    const r = triggerRef.current?.getBoundingClientRect()
    if (r) setPos({ top: r.top, left: r.right + 4 })
  }

  useLayoutEffect(() => {
    if (!open) return
    const t = triggerRef.current?.getBoundingClientRect()
    const p = panelRef.current
    if (!t || !p) return
    const { offsetWidth: w, offsetHeight: h } = p
    setPos({
      top: Math.max(8, Math.min(t.top, window.innerHeight - h - 8)),
      left: t.right + w + 8 > window.innerWidth ? Math.max(8, t.left - w - 4) : t.right + 4,
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  return [pos, seed]
}

// Fermeture au survol sortant (sauf si épinglé au clic), Échap et clic dehors.
function useFlyoutDismiss({ open, pinned, triggerRef, panelRef, childRects, close }) {
  useEffect(() => {
    if (!open || pinned) return
    let closeTimer = null
    function onMove(e) {
      const inside = (r) => r && e.clientX >= r.left - 4 && e.clientX <= r.right + 4 && e.clientY >= r.top - 4 && e.clientY <= r.bottom + 4
      const hit = inside(triggerRef.current?.getBoundingClientRect())
        || inside(panelRef.current?.getBoundingClientRect())
        || childRects().some(inside)
      if (hit) {
        if (closeTimer) { clearTimeout(closeTimer); closeTimer = null }
      } else if (!closeTimer) {
        closeTimer = setTimeout(close, 150)
      }
    }
    document.addEventListener('mousemove', onMove)
    return () => {
      document.removeEventListener('mousemove', onMove)
      if (closeTimer) clearTimeout(closeTimer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pinned])

  useEffect(() => {
    if (!open) return
    function onKey(e) { if (e.key === 'Escape') close() }
    function onDown(e) {
      if (panelRef.current?.contains(e.target) || triggerRef.current?.contains(e.target)) return
      close()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])
}

/**
 * Ligne de menu d'une page, avec au survol le sous-menu de ses propres
 * sections (onglets de la page, vues d'un tableau, comptes du rapprochement).
 * La ligne reste un lien : un clic ouvre la page telle quelle, le sous-menu
 * n'est qu'un raccourci vers une section précise.
 *
 * `variant` :
 *   - 'flyout'  : dans un panneau flottant
 *   - 'group'   : sous-item compact d'un groupe de la sidebar
 *   - 'bottom'  : ligne pleine hauteur (bas de la sidebar)
 */
// Une entrée peut viser un onglet précis d'une page (`?onglet=`). L'état actif
// de react-router ne regarde que le chemin : sans ça, « Comptes prépayés » et
// « Douanes (ASFC) » s'allumeraient ensemble. L'entrée sans onglet reste active
// pour tous les onglets qu'aucune autre entrée ne revendique.
function tabAwareActive(to, location, isActive) {
  const [path, query] = String(to || '').split('?')
  const claims = NAV_TAB_CLAIMS[path]
  if (!claims) return isActive
  const itemTab = new URLSearchParams(query || '').get('onglet')
  const currentTab = new URLSearchParams(location.search).get('onglet')
  if (itemTab) return location.pathname === path && currentTab === itemTab
  return isActive && !claims.includes(currentTab)
}

function NavRow({ item, variant }) {
  const hover = useHoverPrefetch(item.to)
  const [items, setItems] = useState(null)
  const [open, setOpen] = useState(false)
  const rowRef = useRef(null)
  const panelRef = useRef(null)
  const location = useLocation()
  const { chain, childRects } = useFlyoutChain(panelRef, open)
  const [pos, seedPos] = useFlyoutPosition(rowRef, panelRef, open)
  const hasSubsections = !!getSubsections(item.to)

  useFlyoutDismiss({ open, pinned: false, triggerRef: rowRef, panelRef, childRects, close: () => setOpen(false) })
  useEffect(() => { setOpen(false) }, [location.pathname, location.search])

  const pendingRef = useRef(false)
  function onEnter() {
    hover.onMouseEnter?.()
    if (!hasSubsections) return
    seedPos()
    if (items) { setOpen(true); return }
    if (pendingRef.current) return
    pendingRef.current = true
    resolveSubsections(item.to).then(list => {
      pendingRef.current = false
      setItems(list)
      if (list.length) setOpen(true)
    })
  }

  const inFlyout = variant === 'flyout'
  // 'bottom' : mêmes dimensions que les NavItem pleine hauteur, pour que la
  // ligne porte un sous-menu au survol sans détonner visuellement.
  const inBottom = variant === 'bottom'
  const cls = ({ isActive: routerActive }) => {
    const isActive = tabAwareActive(item.to, location, routerActive)
    return inBottom
      ? `flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-all
         ${isActive ? 'bg-brand-600 text-white shadow-sm' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'}`
      : `flex items-center gap-2.5 rounded-md text-sm font-medium transition-colors
     ${inFlyout ? 'px-3 py-2 mx-1' : 'px-3 py-1.5'}
     ${isActive
        ? 'bg-brand-600 text-white'
        : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'}`
  }

  return (
    <>
      <NavLink
        to={item.to}
        ref={rowRef}
        end={item.exactActive}
        onMouseEnter={onEnter}
        // Filet de sécurité : pendant que la colonne finit de se mettre en
        // page, un mousemove synthétique peut refermer le panneau sans que
        // mouseenter ne se re-déclenche (la bordure n'est jamais re-croisée).
        // Tout mouvement au-dessus de la ligne rouvre donc le sous-menu.
        onMouseMove={() => { if (hasSubsections && !open) onEnter() }}
        onMouseLeave={hover.onMouseLeave}
        className={cls}
      >
        <item.icon size={inBottom ? 16 : inFlyout ? 15 : 14} className="flex-shrink-0" />
        <span className="flex-1">{item.label}</span>
        {hasSubsections && <ChevronRight size={11} className="flex-shrink-0 opacity-50" />}
      </NavLink>

      {open && items?.length > 0 && (
        <FlyoutChainContext.Provider value={chain}>
          <div
            ref={panelRef}
            role="menu"
            aria-label={item.label}
            data-testid="nav-subsection-panel"
            data-nav-flyout=""
            data-route={item.to}
            className="fixed bg-white rounded-xl shadow-xl border border-slate-200 py-1.5 min-w-52 max-w-72 z-[210] overflow-y-auto"
            style={pos
              ? { top: pos.top, left: pos.left, maxHeight: `calc(100vh - ${pos.top + 8}px)` }
              : { top: 0, left: 0, visibility: 'hidden' }}
          >
            <p className="px-3 pb-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wider truncate">
              {item.label}
            </p>
            {items.map(sub => (
              <NavLink
                key={sub.to}
                to={sub.to}
                className={`flex items-center gap-2 px-3 py-1.5 mx-1 rounded-md text-sm transition-colors ${
                  location.pathname + location.search === sub.to
                    ? 'bg-brand-600 text-white font-medium'
                    : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'
                }`}
              >
                <span className="truncate">{sub.label}</span>
              </NavLink>
            ))}
          </div>
        </FlyoutChainContext.Provider>
      )}
    </>
  )
}

function FlyoutNavLink({ item }) {
  return <NavRow item={item} variant="flyout" />
}

function GroupNavLink({ item }) {
  return <NavRow item={item} variant="group" />
}

// Routes couvertes par une entrée de nav. Une entrée à sous-menu flottant
// (`flyoutGroups`, ex. Espace finance) n'a pas de page à elle : elle compte
// comme active — et rend son groupe parent actif — dès qu'on est sur l'une de
// ses sections. Sans ça, le groupe Comptabilité resterait replié et éteint
// pendant qu'on travaille dans l'Espace finance.
function navItemPaths(item) {
  if (item.flyoutGroups) return item.flyoutGroups.flatMap(g => g.items.map(s => s.to))
  return [item.to]
}

function navItemMatches(pathname, item) {
  return navItemPaths(item).some(to => to && (pathname === to || pathname.startsWith(to + '/')))
}

/**
 * Entrée de menu qui déploie ses sections dans un panneau flottant au survol —
 * un survol puis un clic mènent directement à la page, en pleine largeur.
 * Utilisée par l'Espace finance (sections regroupées par famille), en
 * sous-section du groupe Comptabilité.
 *
 * Le clic sur la ligne épingle le panneau (ouvert jusqu'à Échap / clic
 * ailleurs) : c'est le seul chemin possible au doigt, où il n'y a pas de survol.
 */
function NavFlyoutItem({ icon: Icon, label, groups }) {
  const [open, setOpen] = useState(false)
  const [pinned, setPinned] = useState(false)
  const triggerRef = useRef(null)
  const panelRef = useRef(null)
  const location = useLocation()
  const { chain, childRects } = useFlyoutChain(panelRef, open)
  const [pos, seedPos] = useFlyoutPosition(triggerRef, panelRef, open)

  const isActive = navItemMatches(location.pathname, { flyoutGroups: groups })

  function openMenu() {
    seedPos()
    setOpen(true)
  }

  const close = () => { setOpen(false); setPinned(false) }
  useFlyoutDismiss({ open, pinned, triggerRef, panelRef, childRects, close })

  // Un clic sur une section referme le menu.
  useEffect(() => { close() }, [location.pathname, location.search])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onMouseEnter={openMenu}
        onMouseMove={() => { if (!open) openMenu() }}
        onFocus={openMenu}
        onClick={() => {
          // Au doigt il n'y a pas de survol : le tap ouvre puis referme.
          if (open && pinned) { setOpen(false); setPinned(false); return }
          if (!open) openMenu()
          setPinned(true)
        }}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="nav-flyout-trigger"
        className={`flex items-center w-full gap-2.5 px-3 py-1.5 rounded-md text-sm font-medium transition-all
          ${isActive ? 'bg-brand-600 text-white' : 'text-slate-600 hover:text-slate-900 hover:bg-slate-100'}`}
      >
        <Icon size={14} className="flex-shrink-0" />
        <span className="flex-1 text-left">{label}</span>
        <ChevronRight size={11} className={`flex-shrink-0 ${isActive ? 'text-brand-200' : 'text-slate-400'}`} />
      </button>

      {open && (
        <div
          ref={panelRef}
          role="menu"
          aria-label={label}
          data-testid="nav-flyout-panel"
          data-nav-flyout=""
          className="fixed bg-white rounded-xl shadow-xl border border-slate-200 py-2 min-w-56 z-[200] overflow-y-auto"
          style={pos
            ? { top: pos.top, left: pos.left, maxHeight: `calc(100vh - ${pos.top + 8}px)` }
            : { top: 0, left: 0, visibility: 'hidden' }}
        >
          <FlyoutChainContext.Provider value={chain}>
            {groups.map((group, gi) => (
              <div key={group.label} className={gi > 0 ? 'mt-1.5 pt-1.5 border-t border-slate-100' : ''}>
                <p className="px-3 pb-1 text-[10px] font-semibold text-slate-400 uppercase tracking-wider">
                  {group.label}
                </p>
                {group.items.map(item => (
                  <FlyoutNavLink key={item.to} item={item} />
                ))}
              </div>
            ))}
          </FlyoutChainContext.Provider>
        </div>
      )}
    </>
  )
}

// ── Réordonnancement du menu ────────────────────────────────────────────────
// Sections et sous-sections se déplacent au glisser-déposer, mais uniquement
// depuis une petite poignée qui n'apparaît qu'au survol de la ligne : impossible
// de déplacer une entrée par accident en cliquant un lien, un geste suffit
// quand on le veut. L'ordre est une préférence par utilisateur (nav_order),
// sauvegardée automatiquement.
const NavReorderContext = createContext(null)

function NavReorderProvider({ items, order, setOrder, children }) {
  const [drag, setDrag] = useState(null) // { container, key, targetKey, before }
  const stateRef = useRef(null)

  const start = (container, key, e) => {
    e.preventDefault()
    const next = { container, key, targetKey: null, before: true }
    stateRef.current = next
    setDrag(next)
  }

  // Déplace `key` avant/après `targetKey` dans son conteneur. On raisonne sur la
  // liste NON filtrée : sinon les entrées cachées par l'utilisateur tomberaient
  // silencieusement à la fin de l'ordre enregistré.
  const commit = (cur) => {
    const list = cur.container === 'root'
      ? items
      : (items.find(i => navKey(i) === cur.container)?.items || [])
    const keys = list.map(navKey)
    if (!keys.includes(cur.key) || !keys.includes(cur.targetKey)) return
    const next = keys.filter(k => k !== cur.key)
    const at = next.indexOf(cur.targetKey) + (cur.before ? 0 : 1)
    next.splice(at, 0, cur.key)
    if (next.join('\u0000') === keys.join('\u0000')) return
    setOrder({ ...order, [cur.container]: next })
  }

  useEffect(() => {
    if (!drag) return
    const prevSelect = document.body.style.userSelect
    document.body.style.userSelect = 'none'

    function onMove(e) {
      const cur = stateRef.current
      if (!cur) return
      const row = document.elementFromPoint(e.clientX, e.clientY)?.closest?.('[data-nav-sortable]')
      let targetKey = null
      let before = true
      if (row && row.dataset.navContainer === cur.container) {
        const r = row.getBoundingClientRect()
        targetKey = row.dataset.navSortable
        before = e.clientY < r.top + r.height / 2
      }
      if (targetKey === cur.targetKey && before === cur.before) return
      const next = { ...cur, targetKey, before }
      stateRef.current = next
      setDrag(next)
    }
    function finish(apply) {
      const cur = stateRef.current
      stateRef.current = null
      setDrag(null)
      if (apply && cur?.targetKey && cur.targetKey !== cur.key) commit(cur)
    }
    const onUp = () => finish(true)
    const onKey = (e) => { if (e.key === 'Escape') finish(false) }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('keydown', onKey)
      document.body.style.userSelect = prevSelect
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag, items, order])

  const value = useMemo(() => ({ drag, start }), [drag])
  return <NavReorderContext.Provider value={value}>{children}</NavReorderContext.Provider>
}

// Enveloppe une ligne de menu : poignée de glissement + trait d'insertion.
function NavSortable({ container, itemKey, children }) {
  const ctx = useContext(NavReorderContext)
  if (!ctx || !itemKey) return children
  const { drag, start } = ctx
  const dragging = drag?.container === container && drag.key === itemKey
  const isTarget = drag?.container === container && drag.targetKey === itemKey && drag.key !== itemKey

  return (
    <div
      data-nav-sortable={itemKey}
      data-nav-container={container}
      className={`relative group/sortable ${dragging ? 'opacity-40' : ''}`}
    >
      {children}
      {/* Poignée et trait d'insertion rendus APRÈS la ligne : ils sont
          positionnés en absolu, et la ligne reste le premier enfant du
          conteneur (des tests et des styles s'appuient sur cet ordre). */}
      <span
        role="button"
        aria-label="Déplacer"
        title="Glisser pour réordonner"
        data-testid={`nav-drag-${itemKey}`}
        onPointerDown={(e) => { if (e.button === 0) start(container, itemKey, e) }}
        className={`absolute left-0 top-1/2 -translate-y-1/2 z-20 flex items-center justify-center w-3 h-5
          text-slate-300 hover:text-slate-500 cursor-grab active:cursor-grabbing transition-opacity
          ${drag ? 'opacity-100' : 'opacity-0 group-hover/sortable:opacity-100'}`}
      >
        <GripVertical size={11} />
      </span>
      {isTarget && (
        <span
          data-testid="nav-drop-indicator"
          className={`pointer-events-none absolute left-1 right-1 h-0.5 bg-brand-500 rounded-full z-20 ${drag.before ? '-top-0.5' : '-bottom-0.5'}`}
        />
      )}
    </div>
  )
}

function NavGroup({ group, icon: Icon, items }) {
  const location = useLocation()
  const isActive = items.some(item => navItemMatches(location.pathname, item))

  const storageKey = `erp.navgroup.${group}`
  const [open, setOpen] = useState(() => {
    if (typeof window === 'undefined') return isActive
    const stored = window.localStorage.getItem(storageKey)
    if (stored === '1') return true
    if (stored === '0') return false
    return isActive
  })

  useEffect(() => {
    if (isActive && !open) setOpen(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive])

  function toggle() {
    setOpen(prev => {
      const next = !prev
      try { window.localStorage.setItem(storageKey, next ? '1' : '0') } catch {}
      return next
    })
  }

  return (
    <div>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium w-full transition-all
          ${isActive ? 'bg-brand-600 text-white' : 'text-slate-700 hover:text-slate-900 hover:bg-slate-100'}`}
      >
        <Icon size={16} className="flex-shrink-0" />
        <span className="flex-1 text-left">{group}</span>
        <ChevronDown
          size={12}
          className={`flex-shrink-0 transition-transform duration-150 ${open ? '' : '-rotate-90'} ${isActive ? 'text-brand-200' : 'text-slate-400'}`}
        />
      </button>

      {open && (
        <div className="mt-0.5 ml-4 pl-2 border-l border-slate-200 space-y-0.5">
          {items.map(item => (
            <NavSortable key={item.to || item.href} container={`group:${group}`} itemKey={item.to || item.href}>
              {item.flyoutGroups
                ? <NavFlyoutItem {...item} groups={item.flyoutGroups} />
                : item.external
                  // Lien externe (ex. Admin Chatbot) : un vrai <a target="_blank">,
                  // pas un NavLink de routeur — `to` n'existe pas ici.
                  ? <NavItem {...item} compact />
                  : <GroupNavLink item={item} />}
            </NavSortable>
          ))}
        </div>
      )}
    </div>
  )
}

// Ligne de compte en bas de la sidebar : avatar + nom, menu au survol
// (Nouveautés, Paramètres perso, Déconnexion) qui s'ouvre au-dessus.
function UserAvatarMenu({ user, roleLabel, onLogout, hasUnseenNews }) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState(null)
  const triggerRef = useRef(null)
  const flyoutRef = useRef(null)

  const parts = (user?.name || '').trim().split(/\s+/)
  const firstInitial = parts[0]?.[0]?.toUpperCase() || 'U'
  const lastInitial = parts.length > 1 ? parts[parts.length - 1][0].toUpperCase() : ''
  const initials = firstInitial + lastInitial

  function openMenu() {
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) setPos({ bottom: window.innerHeight - rect.top + 6, left: rect.left })
    setOpen(true)
  }

  useEffect(() => {
    if (!open) return
    let closeTimer = null
    function onMove(e) {
      const tRect = triggerRef.current?.getBoundingClientRect()
      const fRect = flyoutRef.current?.getBoundingClientRect()
      const inside = (r) => r && e.clientX >= r.left - 4 && e.clientX <= r.right + 4 && e.clientY >= r.top - 4 && e.clientY <= r.bottom + 4
      if (inside(tRect) || inside(fRect)) {
        if (closeTimer) { clearTimeout(closeTimer); closeTimer = null }
      } else if (!closeTimer) {
        closeTimer = setTimeout(() => setOpen(false), 150)
      }
    }
    document.addEventListener('mousemove', onMove)
    return () => {
      document.removeEventListener('mousemove', onMove)
      if (closeTimer) clearTimeout(closeTimer)
    }
  }, [open])

  return (
    <>
      <div
        ref={triggerRef}
        data-testid="user-avatar-trigger"
        onMouseEnter={openMenu}
        className="flex items-center gap-2.5 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-slate-100 transition-colors"
      >
        <div className="relative w-7 h-7 flex-shrink-0 bg-gradient-to-br from-brand-500 to-emerald-700 rounded-full flex items-center justify-center">
          <span className="text-white text-[11px] font-semibold tracking-tight">{initials}</span>
          {hasUnseenNews && (
            <span
              data-testid="changelog-badge"
              className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 bg-amber-400 rounded-full ring-2 ring-white"
              title="Nouveautés disponibles"
            />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-medium text-slate-700 truncate">{user?.name}</div>
        </div>
      </div>

      {open && pos && (
        <div
          ref={flyoutRef}
          className="fixed bg-white rounded-xl shadow-xl border border-slate-200 py-2 min-w-56 z-[200]"
          style={pos}
        >
          <div className="px-3 py-2 border-b border-slate-100">
            <div className="text-slate-800 text-sm font-medium truncate">{user?.name}</div>
            <div className="text-slate-500 text-xs mt-0.5">{roleLabel[user?.role] || user?.role}</div>
          </div>
          <NavLink
            to="/changelog"
            data-testid="user-menu-changelog"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 w-full px-3 py-2 mt-1 mx-1 rounded-md text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition-colors"
            style={{ width: 'calc(100% - 0.5rem)' }}
          >
            <Sparkles size={14} />
            <span className="flex-1 text-left">Nouveautés</span>
            {hasUnseenNews && <span className="w-2 h-2 bg-amber-400 rounded-full" />}
          </NavLink>
          <NavLink
            to="/settings"
            data-testid="user-menu-settings"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2.5 w-full px-3 py-2 mx-1 rounded-md text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition-colors"
            style={{ width: 'calc(100% - 0.5rem)' }}
          >
            <Settings size={14} />
            Paramètres
          </NavLink>
          <button
            onClick={onLogout}
            className="flex items-center gap-2.5 w-full px-3 py-2 mx-1 rounded-md text-sm text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition-colors"
            style={{ width: 'calc(100% - 0.5rem)' }}
          >
            <LogOut size={14} />
            Déconnexion
          </button>
        </div>
      )}
    </>
  )
}

function ChangePasswordModal({ onClose }) {
  const [form, setForm] = useState({ current: '', next: '', confirm: '' })
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    if (form.next.length < 8) return setError('Minimum 8 caractères')
    if (form.next !== form.confirm) return setError('Les mots de passe ne correspondent pas')
    setSaving(true)
    setError('')
    try {
      await api.auth.changePassword(form.current, form.next)
      onClose()
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div>
        <label className="label">Mot de passe actuel</label>
        <input type="password" value={form.current} onChange={e => setForm(f => ({ ...f, current: e.target.value }))} className="input" required />
      </div>
      <div>
        <label className="label">Nouveau mot de passe</label>
        <input type="password" value={form.next} onChange={e => setForm(f => ({ ...f, next: e.target.value }))} className="input" placeholder="Minimum 8 caractères" required />
      </div>
      <div>
        <label className="label">Confirmer</label>
        <input type="password" value={form.confirm} onChange={e => setForm(f => ({ ...f, confirm: e.target.value }))} className="input" required />
      </div>
      {error && <p className="text-red-600 text-sm">{error}</p>}
      <div className="flex justify-end gap-3 pt-2">
        <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
        <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Enregistrement...' : 'Changer le mot de passe'}</button>
      </div>
    </form>
  )
}

export function Layout({ children }) {
  const navigate = useNavigate()
  // Sidebar façon Claude : repliable en un mince rail (logo, réouverture,
  // recherche). L'état survit aux rechargements.
  const [collapsed, setCollapsed] = useState(() => {
    try { return window.localStorage.getItem('erp.sidebar.collapsed') === '1' } catch { return false }
  })
  // Menu replié : le survol du rail le rouvre en surimpression (façon Claude),
  // et il se referme dès que la souris le quitte. Rien n'est persisté — c'est un
  // coup d'œil, pas un changement d'état.
  const [peek, setPeek] = useState(false)
  const [mobileOpen, setMobileOpen] = useState(false)
  const [showChangePw, setShowChangePw] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [showShortcuts, setShowShortcuts] = useState(false)
  const { user, logout } = useAuth()
  const { isHidden, order, setOrder } = useNavPrefs()
  const [hasUnseenNews, setHasUnseenNews] = useState(() => hasUnseenChangelog())
  const location = useLocation()
  const railRef = useRef(null)
  const peekRef = useRef(null)
  const peekArmRef = useRef(null)

  function setSidebarCollapsed(next) {
    try { window.localStorage.setItem('erp.sidebar.collapsed', next ? '1' : '0') } catch {}
    setCollapsed(next)
    if (!next) setPeek(false)
  }

  function toggleSidebar() {
    setSidebarCollapsed(!collapsed)
  }

  // Court délai d'intention : balayer l'écran de gauche à droite ne doit pas
  // faire jaillir le menu.
  function armPeek() {
    if (peek || peekArmRef.current) return
    peekArmRef.current = setTimeout(() => { peekArmRef.current = null; setPeek(true) }, 90)
  }
  function cancelPeekArm() {
    if (peekArmRef.current) { clearTimeout(peekArmRef.current); peekArmRef.current = null }
  }

  // Fermeture du coup d'œil : la souris doit avoir quitté le panneau, le rail ET
  // les sous-menus flottants (qui vivent hors du panneau, en position fixe).
  useEffect(() => {
    if (!peek) return
    let closeTimer = null
    const inside = (e, r) => r && e.clientX >= r.left - 4 && e.clientX <= r.right + 4 && e.clientY >= r.top - 4 && e.clientY <= r.bottom + 4
    function onMove(e) {
      const hit = e.target?.closest?.('[data-nav-flyout]')
        || inside(e, peekRef.current?.getBoundingClientRect())
        || inside(e, railRef.current?.getBoundingClientRect())
      if (hit) {
        if (closeTimer) { clearTimeout(closeTimer); closeTimer = null }
      } else if (!closeTimer) {
        closeTimer = setTimeout(() => setPeek(false), 180)
      }
    }
    function onKey(e) { if (e.key === 'Escape') setPeek(false) }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('keydown', onKey)
      if (closeTimer) clearTimeout(closeTimer)
    }
  }, [peek])

  // Naviguer depuis le coup d'œil le referme (la page demandée reste en vue).
  useEffect(() => { setPeek(false); cancelPeekArm() }, [location.pathname, location.search])
  useEffect(() => () => cancelPeekArm(), [])

  // Pastille « nouveautés » : initialisée depuis localStorage, retirée quand la
  // page Changelog émet l'événement `changelog:seen` au montage.
  useEffect(() => {
    const onSeen = () => setHasUnseenNews(false)
    window.addEventListener(CHANGELOG_SEEN_EVENT, onSeen)
    return () => window.removeEventListener(CHANGELOG_SEEN_EVENT, onSeen)
  }, [])

  // Raccourcis clavier globaux
  useEffect(() => {
    const NAV_MAP = Object.fromEntries(NAV_SHORTCUTS.map(s => [s.key, s.to]))
    function onKey(e) {
      // Cmd+K → recherche globale
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        const tag = document.activeElement?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA') return
        e.preventDefault()
        setShowSearch(s => !s)
        return
      }
      // Lettres simples → navigation. Ignorer si on tape dans un champ ou si
      // un modificateur est actif.
      if (e.metaKey || e.ctrlKey || e.altKey) return
      const ae = document.activeElement
      const tag = ae?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ae?.isContentEditable) return
      // Un scanner code-barre est monté (ex. fiche commande) : les frappes sont
      // des caractères de code, pas des raccourcis — ne pas naviguer.
      if (window.__barcodeScannerActive) return
      // « ? » → overlay d'aide des raccourcis (standard GitHub/Linear/Gmail).
      // e.key vaut '?' (Shift+/) ; on tolère aussi shiftKey sans le bloquer.
      if (e.key === '?') {
        e.preventDefault()
        setShowShortcuts(s => !s)
        return
      }
      const target = NAV_MAP[e.key.toLowerCase()]
      if (target) {
        e.preventDefault()
        navigate(target)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navigate])

  // WebSocket global — connexion + reconnexion gérées par lib/realtime.js.
  // CustomEvents back-compat (agent:task:*, sync:progress) sont re-dispatchés
  // par la lib pour ne pas casser les écouteurs existants.
  useEffect(() => {
    realtimeConnect()
    return () => realtimeDisconnect()
  }, [])

  const roleLabel = { admin: 'Admin', rh: 'RH', sales: 'Ventes', support: 'Support', ops: 'Opérations' }
  const isHR = ['admin', 'rh'].includes(user?.role)
  // Filtrage en deux temps : d'abord les permissions de rôle (hrOnly), puis les
  // préférences perso de l'utilisateur (items/groupes cachés via Paramètres).
  // Clés : item = `to`, groupe = `group:<nom>`.
  // Ordre personnalisé appliqué avant filtrage : `orderedNavItems` (non filtré)
  // reste la référence du glisser-déposer, pour ne pas perdre la position des
  // entrées cachées.
  const orderedNavItems = useMemo(() => applyNavOrder(defaultNavItems, order), [order])
  const filteredNavItems = orderedNavItems
    .map(item => {
      // Liens externes : toujours préservés, hors logique de rôle/préférences
      // (pas de `to` interne à filtrer).
      if (item.external) return item
      if (!item.group) {
        return isHidden(item.to) ? null : item
      }
      if (isHidden(`group:${item.group}`)) return null
      const items = item.items.filter(i => (!i.hrOnly || isHR) && !isHidden(i.to))
      if (items.length === 0) return null
      return { ...item, items }
    })
    .filter(Boolean)

  // Contenu de la sidebar (partagé desktop / tiroir mobile). Rendu par appel
  // direct (pas un composant JSX) : défini pendant le render, il perdrait son
  // état à chaque frappe s'il était monté comme composant.
  const sidebarBody = ({ mobile = false, peeking = false } = {}) => (
    <div className={`flex flex-col h-full bg-white ${mobile ? 'w-72' : 'w-60'}`}>
      {/* En-tête : logo + repli */}
      <div className="flex items-center h-14 px-3 border-b border-slate-100 flex-shrink-0 gap-2">
        <NavLink to="/dashboard" className="flex items-center gap-2 min-w-0" title="Tableau de bord">
          <img src="/erp/favicon.png" alt="Orisha ERP" className="h-7 w-auto" />
          <span className="text-[15px] font-semibold text-slate-800 tracking-tight">Orisha</span>
        </NavLink>
        {/* File de travaux : joignable depuis n'importe quelle page (⌘/Ctrl + /). */}
        <TravauxQuickButton className="ml-auto" />
        <ThemeToggle />
        {!mobile && (
          <button
            onClick={() => setSidebarCollapsed(!peeking && !collapsed)}
            data-testid={peeking ? 'sidebar-pin' : 'sidebar-collapse'}
            title={peeking ? 'Garder le menu ouvert' : 'Replier le menu'}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors"
          >
            {peeking ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
          </button>
        )}
      </div>

      {/* Recherche unifiée : pages/sections ET contenu, dans la même palette */}
      <div className="px-3 pt-3 pb-1.5 flex-shrink-0">
        <button
          data-testid="sidebar-search"
          onClick={() => setShowSearch(true)}
          className="flex items-center gap-2 w-full px-2.5 py-1.5 rounded-lg border border-slate-200 bg-slate-50 text-slate-400 hover:border-slate-300 hover:text-slate-500 transition-colors"
        >
          <Search size={14} className="flex-shrink-0" />
          <span className="flex-1 text-left text-[13px]">Rechercher…</span>
          <kbd className="text-[10px] text-slate-400 bg-white border border-slate-200 px-1 py-0.5 rounded">⌘K</kbd>
        </button>
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto py-1.5 px-2 space-y-0.5">
        {filteredNavItems.map(item => (
          <NavSortable key={navKey(item)} container="root" itemKey={navKey(item)}>
            {item.group ? <NavGroup {...item} /> : <NavItem {...item} />}
          </NavSortable>
        ))}
      </nav>

      {/* Bas de barre : Agent, Paramètres admin, compte */}
      <div className="border-t border-slate-100 py-2 px-2 space-y-0.5 flex-shrink-0">
        {/* Agent visible par tous : suggestions + correctifs (bulle d'aide).
            La ligne porte un sous-menu au survol (Agent autonome, file de
            prompts de l'agent, suggestions, idées). */}
        <NavRow item={{ to: '/agent', icon: Bot, label: 'Agent' }} variant="bottom" />
        {user?.role === 'admin' && (
          <NavItem to="/admin" icon={Settings} label="Paramètres" />
        )}
        <div className="pt-1">
          <UserAvatarMenu user={user} roleLabel={roleLabel} onLogout={logout} hasUnseenNews={hasUnseenNews} />
        </div>
      </div>
    </div>
  )

  return (
    <NavReorderProvider items={orderedNavItems} order={order} setOrder={setOrder}>
    <div className="flex h-screen overflow-hidden bg-slate-50">
      {/* Sidebar desktop — repliable en rail */}
      <div
        data-testid="app-sidebar"
        className={`hidden md:flex relative flex-shrink-0 bg-white border-r border-slate-200 transition-[width] duration-200 overflow-hidden ${collapsed ? 'w-12' : 'w-60'}`}
      >
        {collapsed ? (
          // Rail replié : logo, réouverture, recherche — rien d'autre, tout
          // l'écran reste à la tâche en cours. Le survol du rail rouvre le menu
          // en surimpression le temps d'un coup d'œil.
          <div
            ref={railRef}
            data-testid="sidebar-rail"
            onMouseEnter={armPeek}
            onMouseMove={armPeek}
            onMouseLeave={cancelPeekArm}
            className="flex flex-col items-center w-12 py-3 gap-1.5"
          >
            <img src="/erp/favicon.png" alt="Orisha ERP" className="h-6 w-auto mb-1" />
            <button
              onClick={toggleSidebar}
              data-testid="sidebar-reopen"
              title="Ouvrir le menu"
              className="p-2 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors"
            >
              <PanelLeftOpen size={16} />
            </button>
            <button
              onClick={() => setShowSearch(true)}
              title="Rechercher (⌘K)"
              className="p-2 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-100 transition-colors"
            >
              <Search size={16} />
            </button>
            <TravauxQuickButton compact />
            <ThemeToggle compact />
          </div>
        ) : (
          <>
            {sidebarBody({})}
            {/* Barre verticale de repli, sur toute la hauteur du bord droit :
                cliquer n'importe où le long de la sidebar la replie. */}
            <button
              type="button"
              data-testid="sidebar-collapse-edge"
              onClick={toggleSidebar}
              title="Replier le menu"
              aria-label="Replier le menu"
              className="absolute inset-y-0 right-0 w-1.5 z-10 group cursor-w-resize"
            >
              <span className="absolute inset-y-0 right-0 w-[3px] group-hover:bg-brand-500/60 transition-colors" />
            </button>
          </>
        )}
      </div>

      {/* Coup d'œil au survol du rail : le menu complet par-dessus la page, sans
          pousser le contenu ni changer l'état replié. Décalé de la largeur du
          rail, qui reste visible et cliquable (son bouton épingle le menu). */}
      {collapsed && peek && (
        <div
          ref={peekRef}
          data-testid="sidebar-peek"
          className="hidden md:block fixed left-12 top-0 bottom-0 z-[120] w-60 bg-white border-r border-slate-200 shadow-2xl"
        >
          {sidebarBody({ peeking: true })}
        </div>
      )}

      {/* Mobile sidebar */}
      {mobileOpen && (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="fixed inset-0 bg-black/40" onClick={() => setMobileOpen(false)} />
          <div className="fixed left-0 top-0 bottom-0 z-50 flex shadow-2xl">
            {sidebarBody({ mobile: true })}
            <button
              onClick={() => setMobileOpen(false)}
              className="absolute top-4 right-4 text-slate-500"
            >
              <X size={20} />
            </button>
          </div>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Mobile header */}
        <div className="md:hidden flex items-center h-14 px-4 bg-white border-b border-slate-200">
          <button onClick={() => setMobileOpen(true)} className="text-slate-600 mr-3">
            <Menu size={20} />
          </button>
          <img src="/erp/favicon.png" alt="Orisha ERP" className="h-7 w-auto" />
          <TravauxQuickButton compact className="ml-auto" />
          <ThemeToggle compact />
        </div>

        {/* Page content */}
        <main className="flex-1 overflow-y-auto">
          {children}
        </main>
      </div>

      <Modal isOpen={showChangePw} onClose={() => setShowChangePw(false)} title="Changer mon mot de passe" size="sm">
        <ChangePasswordModal onClose={() => setShowChangePw(false)} />
      </Modal>

      <CRMSearch open={showSearch} onClose={() => setShowSearch(false)} />

      <KeyboardShortcutsModal isOpen={showShortcuts} onClose={() => setShowShortcuts(false)} />

      <FeedbackFab />
    </div>
    </NavReorderProvider>
  )
}
```


---

## `client/src/lib/navItems.js`

Source de vérité des entrées de navigation + ordre par défaut.

```js
import {
  LayoutDashboard,
  TrendingUp, ShoppingCart, Package, LifeBuoy,
  ShoppingBag, Truck, RotateCcw, FileText, RefreshCw, Wrench,
  Barcode, MessageSquare, CheckSquare,
  Receipt, ReceiptText, Landmark, Users, Banknote, Contact, BookOpen,
  ArrowLeftRight, Clock, Tag, Wallet, Mail, PhoneCall,
  FolderOpen, Building2, ListChecks, Bot, Activity, Zap, Plug
} from 'lucide-react'
import { FINANCE_GROUPS } from './financeSections.js'

// Structure canonique du menu de gauche, partagée entre la sidebar (Layout)
// et la page Paramètres (customisation afficher/cacher).
//
// Clés de customisation (cf. nav_hidden / navPrefs) :
//   - item à plat ou sous-item d'un groupe → clé = `item.to`
//   - groupe entier → clé = `group:<group>`
//
// Ordre personnalisé (cf. nav_order / navPrefs) : objet
// { root: [clés], 'group:<nom>': [clés] } — clé d'un item = `to` (ou `href`
// pour un lien externe), clé d'un groupe = `group:<nom>`. Sémantique partielle :
// toute clé absente de la liste garde sa position par défaut, à la suite.
export function navKey(item) {
  if (item.group) return `group:${item.group}`
  return item.to || item.href
}

function sortByKeys(list, keys) {
  if (!Array.isArray(keys) || keys.length === 0) return list
  const rank = new Map(keys.map((k, i) => [k, i]))
  // Tri stable : les clés inconnues (nouvelle entrée ajoutée au code depuis)
  // conservent leur ordre par défaut, après les clés explicitement ordonnées.
  const unknown = keys.length
  const rankOf = (item) => (rank.has(navKey(item)) ? rank.get(navKey(item)) : unknown)
  return [...list].sort((a, b) => rankOf(a) - rankOf(b))
}

// Applique l'ordre personnalisé aux sections et à leurs sous-items.
export function applyNavOrder(items, order) {
  if (!order || typeof order !== 'object') return items
  return sortByKeys(items, order.root).map(item => (
    item.items ? { ...item, items: sortByKeys(item.items, order[navKey(item)]) } : item
  ))
}

export const defaultNavItems = [
  { to: '/dashboard',    icon: LayoutDashboard, label: 'Dashboard' },
  { group: 'Clients', icon: Contact, items: [
    { to: '/contacts',     icon: Contact,       label: 'Contacts' },
    { to: '/companies',    icon: Building2,     label: 'Entreprises' },
    { to: '/pipeline',     icon: TrendingUp,    label: 'Projets' },
    { to: '/tasks',        icon: CheckSquare,   label: 'Tâches' },
    { to: '/tickets',      icon: LifeBuoy,      label: 'Billets' },
    { to: '/interactions', icon: MessageSquare, label: 'Interactions' },
    { to: '/qualification-call', icon: PhoneCall, label: 'Appels de qualification' },
    { to: '/relance-qualification', icon: Mail, label: 'Relances qualification' },
    { to: '/discovery-forms', icon: FileText, label: 'Formulaires de découverte' },
  ]},
  { group: 'Envois', icon: Truck, items: [
    { to: '/orders',   icon: ShoppingCart, label: 'Commandes' },
    { to: '/envois',   icon: Truck,        label: 'Envois' },
    { to: '/retours',  icon: RotateCcw,    label: 'Retours' },
  ]},
  { group: 'Comptabilité', icon: Landmark, items: [
    // Espace finance, en tête du groupe : hub du suivi comptable quotidien.
    // `flyoutGroups` en fait une entrée qui déploie ses sections dans un
    // panneau flottant au survol (NavFlyoutItem) au lieu de mener à une page —
    // les liens vont droit aux pages, en pleine largeur. Sections définies dans
    // lib/financeSections.js.
    { to: '/finance',               icon: Landmark,   label: 'Espace finance', flyoutGroups: FINANCE_GROUPS },
    { to: '/factures',              icon: FileText,   label: 'Factures clients' },
    { to: '/paiements',             icon: Banknote,   label: 'Paiements' },
    { to: '/items-vendus',          icon: Tag,        label: 'Items vendus' },
    { to: '/abonnements',           icon: RefreshCw,  label: 'Abonnements' },
    { to: '/abonnements/mouvements', icon: RefreshCw, label: "Mouvements d'abonnements" },
    { to: '/sale-receipts',         icon: ReceiptText,label: 'Extraction de données' },
    { to: '/journal-entries',       icon: BookOpen,   label: 'Écritures de journal' },
    { to: '/comptabilite/regles-serials', icon: BookOpen, label: 'Mouvements numéros de série' },
    { to: '/stock-movement',        icon: ArrowLeftRight, label: "Mouvements d'inventaire" },
  ]},
  { group: 'Inventaire', icon: Package, items: [
    { to: '/purchases',    icon: ShoppingBag, label: 'Achats' },
    { to: '/assemblages',  icon: Wrench,      label: 'Assemblages' },
    { to: '/products',     icon: Package,     label: 'Pièces/Produits' },
    { to: '/serials',      icon: Barcode,     label: 'Numéros de série' },
  ]},
  { group: 'RH', icon: Users, items: [
    { to: '/employees',        icon: Users,    label: 'Employés',              hrOnly: true },
    { to: '/feuille-de-temps', icon: Clock,    label: 'Feuille de temps' },
    { to: '/codes-activite',   icon: Tag,      label: "Codes d'activité",      hrOnly: true },
    { to: '/paies',            icon: Banknote, label: 'Paies' },
    { to: '/banque-heures',    icon: Wallet,   label: "Banque d'heures" },
  ]},
  { group: 'Autres outils', icon: Wrench, items: [
    { to: '/priorite-assemblage', icon: ListChecks, label: "Priorité d'assemblage" },
    { to: '/automations',  icon: Zap,             label: 'Automatisations' },
    // La page existait mais n'était joignable que par l'onglet Connecteurs de
    // /admin (réservé aux admins) : introuvable pour tout le monde d'autre, et
    // absente de la palette ⌘K qui se construit sur cette même liste. Entrée à
    // plat, comme la route (ProtectedRoute sans adminOnly) et l'API (requireAuth).
    { to: '/connectors',   icon: Plug,            label: 'Connecteurs' },
    { to: '/public-files', icon: FolderOpen,      label: 'Fichiers publics' },
    { external: true, href: 'https://customer.orisha.io/chatbot/admin', icon: Bot, label: 'Admin Chatbot' },
  ]},
]
```


---

## `client/src/lib/navPrefs.jsx`

Préférences de nav par utilisateur (ordre, épinglés) — persistées côté serveur.

```jsx
import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from './auth.jsx'
import api from './api.js'

// État partagé des préférences d'affichage du menu de gauche.
// `hidden` = liste de clés cachées (blacklist). Chargée au login, mutée par la
// page Paramètres, lue par la sidebar (Layout) → toggle instantané + autosave DB.
// `order` = ordre personnalisé { conteneur: [clés] }, muté par le glisser-déposer
// des sections/sous-sections dans la sidebar (même cycle : instantané + autosave).
const NavPrefsContext = createContext(null)

export function NavPrefsProvider({ children }) {
  const { user } = useAuth()
  const [hidden, setHiddenState] = useState([])
  const [order, setOrderState] = useState({})
  const [loaded, setLoaded] = useState(false)
  // Compteur d'écritures locales : le chargement initial peut résoudre APRÈS
  // une première modification (GET lent pendant le bootstrap) et écraserait
  // alors la valeur fraîche par l'état serveur d'avant. Toute réponse
  // antérieure à une écriture est ignorée.
  const writeSeq = useRef(0)

  useEffect(() => {
    let cancelled = false
    const seq = writeSeq.current
    if (!user) {
      setHiddenState([])
      setOrderState({})
      setLoaded(false)
      return
    }
    api.auth.getPreferences()
      .then((d) => {
        if (cancelled || writeSeq.current !== seq) return
        setHiddenState(Array.isArray(d?.nav_hidden) ? d.nav_hidden : [])
        setOrderState(d?.nav_order && typeof d.nav_order === 'object' && !Array.isArray(d.nav_order) ? d.nav_order : {})
        setLoaded(true)
      })
      .catch(() => { if (!cancelled) setLoaded(true) })
    return () => { cancelled = true }
  }, [user])

  const persist = useCallback((next) => {
    writeSeq.current += 1
    setHiddenState(next)
    api.auth.updatePreferences({ nav_hidden: next })
      .catch((err) => console.error('[navPrefs] échec sauvegarde:', err))
  }, [])

  const persistOrder = useCallback((next) => {
    writeSeq.current += 1
    setOrderState(next)
    api.auth.updatePreferences({ nav_order: next })
      .catch((err) => console.error('[navPrefs] échec sauvegarde ordre:', err))
  }, [])

  const isHidden = useCallback((key) => hidden.includes(key), [hidden])

  const toggle = useCallback((key) => {
    const next = hidden.includes(key) ? hidden.filter((k) => k !== key) : [...hidden, key]
    persist(next)
  }, [hidden, persist])

  return (
    <NavPrefsContext.Provider value={{ hidden, isHidden, toggle, setHidden: persist, order, setOrder: persistOrder, loaded }}>
      {children}
    </NavPrefsContext.Provider>
  )
}

export function useNavPrefs() {
  const ctx = useContext(NavPrefsContext)
  // Hors provider (ex. pages publiques) : tout visible, no-op.
  if (!ctx) return { hidden: [], isHidden: () => false, toggle: () => {}, setHidden: () => {}, order: {}, setOrder: () => {}, loaded: true }
  return ctx
}
```


---

## `client/src/lib/navSubsections.js`

Sous-menus d'une entrée (onglets d'une page exposés dans la sidebar).

```js
import api from './api.js'

// Sous-sections d'une page — ce qu'on voit comme onglets/vues en haut de la
// page, exposé aussi au survol de son entrée dans le menu de gauche.
//
// Trois natures :
//   - `tabs`    : onglets codés en dur, adressables par ?<param>=<valeur>
//   - `routes`  : la page a de vraies sous-routes (rien à traduire)
//   - `views`   : les vues (pills) configurables d'un DataTable, adressables
//                 par ?vue=<id> — chargées à la demande depuis le serveur
//   - `accounts`: comptes bancaires du rapprochement, adressables par ?compte=
//
// Les pages sans onglet (dashboard comptabilité, état du close, Stripe Payouts,
// dettes long terme, écritures de fin de mois, mouvements d'abonnements) sont
// volontairement absentes : leur entrée de menu reste un simple lien.
export const NAV_SUBSECTIONS = {
  // ── Espace finance ────────────────────────────────────────────────────────
  '/travaux': {
    kind: 'tabs', param: 'onglet', items: [
      { value: 'file', label: 'Ma file de prompts' },
      { value: 'suggestions', label: 'Suggestions de Claude' },
      { value: 'idees', label: 'De côté & idées' },
      { value: 'recurrents', label: 'Travaux récurrents' },
    ],
  },
  '/paiements-emis': {
    kind: 'tabs', param: 'onglet', items: [
      { value: 'cedule', label: 'À payer (cédule)' },
      { value: 'pending', label: 'À passer à la banque' },
      { value: 'cleared', label: 'Passés' },
      { value: 'all', label: 'Tous' },
    ],
  },
  '/comptes-prepayes': {
    kind: 'tabs', param: 'onglet', items: [
      { value: 'ledger', label: 'Soldes fournisseurs' },
      { value: 'fpa', label: 'Cédule FPA' },
    ],
  },
  '/inventaire-drive': {
    kind: 'tabs', param: 'onglet', items: [
      { value: 'suggestions', label: 'Suggestions' },
      { value: 'documents', label: 'Documents' },
    ],
  },
  '/fournisseurs': {
    kind: 'routes', items: [
      { to: '/fournisseurs', label: 'Profils' },
      { to: '/fournisseurs/achats', label: 'Achats' },
      { to: '/fournisseurs/abonnements', label: 'Abonnements' },
    ],
  },
  '/rapprochement': { kind: 'accounts', param: 'compte' },

  // ── Agent (entrée du bas de la sidebar) ───────────────────────────────────
  // La section Agent a ses propres travaux : une file de prompts DISTINCTE de
  // celle de l'Espace finance (même page, space='agent'), plus les suggestions
  // et les idées — partagées entre les deux sections.
  '/agent': {
    kind: 'routes', items: [
      { to: '/agent', label: 'Agent autonome' },
      { to: '/agent/travaux?onglet=file', label: "File de prompts de l'agent" },
      { to: '/agent/travaux?onglet=suggestions', label: 'Suggestions de Claude' },
      { to: '/agent/travaux?onglet=idees', label: 'De côté & idées' },
    ],
  },

  // ── Groupe Comptabilité ───────────────────────────────────────────────────
  '/factures':        { kind: 'views', param: 'vue', table: 'factures' },
  '/paiements':       { kind: 'views', param: 'vue', table: 'payments' },
  '/items-vendus':    { kind: 'views', param: 'vue', table: 'stripe_invoice_items' },
  '/abonnements':     { kind: 'views', param: 'vue', table: 'abonnements' },
  '/sale-receipts':   { kind: 'views', param: 'vue', table: 'sale_receipts' },
  '/journal-entries': { kind: 'views', param: 'vue', table: 'journal_entries' },
  '/stock-movement':  { kind: 'views', param: 'vue', table: 'stock_movements' },
  '/comptabilite/regles-serials': { kind: 'views', param: 'vue', table: 'serial_missing_valuations' },
}

export function getSubsections(route) {
  return NAV_SUBSECTIONS[route] || null
}

// Les listes dynamiques (vues, comptes) ne changent quasi jamais pendant une
// session : un cache par route évite de refrapper le serveur à chaque survol.
const cache = new Map()

function link(route, param, value, label) {
  return { to: `${route}?${param}=${encodeURIComponent(value)}`, label }
}

/**
 * Sous-sections prêtes à afficher pour une route : `[{ to, label }]`.
 * Renvoie [] si la route n'en a pas (ou si le chargement échoue — un sous-menu
 * est un raccourci, jamais un point de blocage).
 */
export async function resolveSubsections(route) {
  const desc = getSubsections(route)
  if (!desc) return []
  if (cache.has(route)) return cache.get(route)

  let items = []
  try {
    if (desc.kind === 'routes') {
      items = desc.items.map(i => ({ to: i.to, label: i.label }))
    } else if (desc.kind === 'tabs') {
      items = desc.items.map(i => link(route, desc.param, i.value, i.label))
    } else if (desc.kind === 'views') {
      const { pills } = await api.views.get(desc.table)
      items = (pills || []).map(p => link(route, desc.param, p.id, p.label))
    } else if (desc.kind === 'accounts') {
      const list = await api.bank.accounts()
      items = (list || []).map(a => link(route, desc.param, a.id, a.name))
    }
  } catch {
    items = []
  }
  // Les listes vides ne sont pas mises en cache : une vue créée juste après
  // apparaîtra au survol suivant.
  if (items.length) cache.set(route, items)
  return items
}
```


---

## `client/src/lib/financeSections.js`

Espace finance : le flyout qui regroupe les pages de comptabilité derrière une seule entrée.

```js
import {
  Landmark, ListChecks, BookUser, Wallet, CalendarCheck,
  Banknote, ArrowLeftRight, CreditCard, Ship, Megaphone, HardDrive,
} from 'lucide-react'

// Espace finance — les pages du suivi comptable quotidien, réunies derrière une
// seule entrée de menu qui déploie son sous-menu au survol (voir NavFlyoutItem
// dans components/Layout.jsx). Les liens pointent vers les pages elles-mêmes,
// en pleine largeur : un survol + un clic suffisent, sans page intermédiaire.
//
// Ce module ne contient QUE des métadonnées (pas d'import de page) : il est lu
// par navItems.js et par la palette de recherche, elle-même importée par
// Layout — importer les pages ici créerait un cycle.
export const FINANCE_SECTIONS = [
  { to: '/comptabilite',     label: 'Dashboard comptabilité',   icon: Landmark,       group: 'Pilotage' },
  { to: '/travaux',          label: 'Travaux',                  icon: ListChecks,     group: 'Pilotage' },

  { to: '/paiements-emis',   label: 'Paiements émis',           icon: Banknote,       group: 'Trésorerie' },
  { to: '/rapprochement',    label: 'Rapprochement bancaire',   icon: ArrowLeftRight, group: 'Trésorerie' },
  { to: '/stripe-payouts',   label: 'Stripe Payouts',           icon: CreditCard,     group: 'Trésorerie' },
  { to: '/comptes-prepayes', label: 'Comptes prépayés',         icon: Wallet,         group: 'Trésorerie' },
  // Le compte CARM de l'ASFC est un compte prépayé : il vit dans un onglet de
  // la page ci-dessus, l'entrée de menu y saute directement.
  { to: '/comptes-prepayes?onglet=douanes', label: 'Douanes (ASFC)', icon: Ship,      group: 'Trésorerie' },

  { to: '/fournisseurs',     label: 'Fournisseurs',             icon: BookUser,       group: 'Fournisseurs & engagements' },
  { to: '/dettes-lt',        label: 'Dettes long terme',        icon: Landmark,       group: 'Fournisseurs & engagements' },

  { to: '/budget-marketing', label: 'Budget marketing',         icon: Megaphone,      group: 'Fournisseurs & engagements' },

  { to: '/fin-de-mois',      label: 'Écritures de fin de mois', icon: CalendarCheck,  group: 'Écritures' },

  { to: '/inventaire-drive', label: 'Inventaire Drive',         icon: HardDrive,      group: 'Pilotage' },
]

// Onglets revendiqués par une entrée de menu, par page (`/page` → ['douanes']).
// Sert à l'état actif de la sidebar : deux entrées visant la même page sur des
// onglets différents ne doivent pas s'allumer ensemble.
export const NAV_TAB_CLAIMS = FINANCE_SECTIONS.reduce((claims, s) => {
  const [path, query] = s.to.split('?')
  const tab = new URLSearchParams(query || '').get('onglet')
  if (tab) (claims[path] ||= []).push(tab)
  return claims
}, {})

// Groupes du sous-menu, dérivés des sections pour qu'ajouter une entrée dans un
// groupe existant suffise.
export const FINANCE_GROUPS = FINANCE_SECTIONS.reduce((groups, s) => {
  const found = groups.find(g => g.label === s.group)
  if (found) found.items.push(s)
  else groups.push({ label: s.group, items: [s] })
  return groups
}, [])

// Compatibilité : la première version de l'Espace finance était une page
// d'accueil à /finance/<section>. Ces URLs redirigent vers la page pleine
// largeur correspondante pour ne casser aucun signet.
export function legacyFinanceTarget(rest) {
  const clean = '/' + String(rest || '').replace(/^\/+|\/+$/g, '')
  const hit = FINANCE_SECTIONS.find(s => clean === s.to || clean.startsWith(s.to + '/'))
  return hit ? clean : '/comptabilite'
}
```


---

## `client/src/lib/pageIcons.js`

Icône canonique par page — réutilisée par la nav, la recherche et les cartes.

```js
import {
  LayoutDashboard,
  Landmark,
  FolderOpen,
  Folder,
  TrendingUp,
  CheckSquare,
  LifeBuoy,
  MessageSquare,
  PhoneCall,
  Mail,
  ShoppingCart,
  Truck,
  RotateCcw,
  FileText,
  Tag,
  RefreshCw,
  Receipt,
  ReceiptText,
  CreditCard,
  BookOpen,
  ArrowLeftRight,
  ShoppingBag,
  Wrench,
  Package,
  Barcode,
  Users,
  Clock,
  Banknote,
  Wallet,
  Contact,
  Building2,
  Settings,
  Plug,
  Zap,
  Bot,
  LogIn,
  Ship,
  Megaphone,
  HardDrive,
} from 'lucide-react'

// Order matters: most specific patterns first.
const ROUTES = [
  [/^\/login/, LogIn],
  [/^\/setup/, Settings],
  [/^\/dashboard/, LayoutDashboard],
  [/^\/public-files/, FolderOpen],
  [/^\/pipeline/, TrendingUp],
  [/^\/projects\/fields/, FolderOpen],
  [/^\/projects\//, Folder],
  [/^\/soumissions/, FileText],
  [/^\/tasks/, CheckSquare],
  [/^\/tickets/, LifeBuoy],
  [/^\/interactions/, MessageSquare],
  [/^\/qualification-call/, PhoneCall],
  [/^\/relance-qualification/, Mail],
  [/^\/orders/, ShoppingCart],
  [/^\/envois/, Truck],
  [/^\/retours/, RotateCcw],
  [/^\/factures/, FileText],
  [/^\/paiements/, Banknote],
  [/^\/items-vendus/, Tag],
  [/^\/finance/, Landmark],
  [/^\/comptes-prepayes/, Wallet],
  [/^\/inventaire-drive/, HardDrive],
  [/^\/dettes-lt/, Landmark],
  [/^\/budget-marketing/, Megaphone],
  [/^\/douanes/, Ship],
  [/^\/abonnements/, RefreshCw],
  [/^\/comptabilite/, Landmark],
  [/^\/fournisseurs/, Receipt],
  [/^\/depenses/, Receipt],
  [/^\/factures-fournisseurs/, Receipt],
  [/^\/sale-receipts/, ReceiptText],
  [/^\/stripe-payouts/, CreditCard],
  [/^\/journal-entries/, BookOpen],
  [/^\/comptabilite\/regles-serials/, BookOpen],
  [/^\/stock-movement/, ArrowLeftRight],
  [/^\/purchases/, ShoppingBag],
  [/^\/assemblages/, Wrench],
  [/^\/products/, Package],
  [/^\/serials/, Barcode],
  [/^\/employees/, Users],
  [/^\/feuille-de-temps/, Clock],
  [/^\/codes-activite/, Tag],
  [/^\/paies/, Banknote],
  [/^\/banque-heures/, Wallet],
  [/^\/contacts/, Contact],
  [/^\/companies/, Building2],
  [/^\/connectors/, Plug],
  [/^\/automations/, Zap],
  [/^\/agent/, Bot],
  [/^\/admin/, Settings],
]

export function iconForPath(pathname) {
  for (const [pattern, icon] of ROUTES) {
    if (pattern.test(pathname)) return icon
  }
  return LayoutDashboard
}
```


---

## `client/src/components/GlobalSearch.jsx`

Recherche globale ⌘K, unifiée sur toutes les entités.

```jsx
import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, Building2, Users, TrendingUp, ShoppingCart, Package, LifeBuoy, MessageSquare, X, Barcode, FileText, Receipt, CornerDownLeft, Clock, Truck, RotateCcw, Boxes, UserRound } from 'lucide-react'
import api from '../lib/api.js'
import { defaultNavItems } from '../lib/navItems.js'
import { useRecentRecords, clearRecentRecords } from '../lib/useRecentRecords.js'

const TYPE_ICON = {
  company: Building2,
  contact: Users,
  project: TrendingUp,
  order: ShoppingCart,
  product: Package,
  serial: Barcode,
  ticket: LifeBuoy,
  interaction: MessageSquare,
  bill: FileText,
  expense: Receipt,
  // Types additionnels pour le fil « Récemment consultés ».
  facture: FileText,
  purchase: Boxes,
  return: RotateCcw,
  shipment: Truck,
  sale_receipt: Receipt,
  employee: UserRound,
}

const TYPE_LABEL = {
  company: 'Entreprise',
  contact: 'Contact',
  project: 'Projet',
  order: 'Commande',
  product: 'Produit',
  serial: 'N° de série',
  ticket: 'Ticket',
  interaction: 'Interaction',
  bill: 'Facture fourn.',
  expense: 'Dépense',
  facture: 'Facture',
  purchase: 'Achat',
  return: 'Retour',
  shipment: 'Envoi',
  sale_receipt: 'Reçu de vente',
  employee: 'Employé',
}

// Liste à plat de toutes les pages navigables, dérivée de la même définition de
// nav que la sidebar (navItems.js). Construite une seule fois au chargement du
// module. Les liens externes (`external`) sont exclus — la palette ne fait que
// du routage interne.
const PAGE_ITEMS = (() => {
  const pages = []
  // Une entrée à sous-menu flottant (Espace finance) n'est pas navigable
  // elle-même : ce sont ses sections qui le sont, sous son propre libellé.
  const push = (item, group) => {
    if (item.flyoutGroups) {
      for (const sub of item.flyoutGroups) {
        for (const s of sub.items) {
          pages.push({ to: s.to, label: s.label, icon: s.icon, group: item.label })
        }
      }
    } else if (item.to) {
      pages.push({ to: item.to, label: item.label, icon: item.icon, group })
    }
  }
  for (const item of defaultNavItems) {
    if (item.external) continue
    if (item.group) for (const sub of item.items) push(sub, item.group)
    else push(item, null)
  }
  return pages
})()

// Normalisation insensible à la casse et aux accents pour le filtrage des pages.
const norm = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')

const MAX_PAGE_MATCHES = 12

function matchPages(query) {
  const q = norm(query.trim())
  if (!q) return PAGE_ITEMS // requête vide → palette de lancement : toutes les pages
  return PAGE_ITEMS
    .filter(p => norm(p.label).includes(q) || (p.group && norm(p.group).includes(q)))
    .slice(0, MAX_PAGE_MATCHES)
}

export function GlobalSearch({ open, onClose }) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState(0)
  const inputRef = useRef(null)
  const navigate = useNavigate()
  const timerRef = useRef(null)
  const recent = useRecentRecords()

  useEffect(() => {
    if (open) {
      setQuery('')
      setResults([])
      setSelected(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [open])

  const search = useCallback(async (q) => {
    if (q.length < 2) { setResults([]); return }
    setLoading(true)
    try {
      const { results: res } = await api.search.query(q)
      setResults(res || [])
    } finally {
      setLoading(false)
    }
  }, [])

  function handleChange(e) {
    const q = e.target.value
    setQuery(q)
    setSelected(0)
    clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => search(q), 220)
  }

  // Liste combinée récents + pages + records, dans l'ordre d'affichage, pour la
  // navigation clavier (un seul index `selected` couvre toutes les sections).
  // Le fil « Récemment consultés » n'apparaît que lorsque la requête est vide.
  const queryEmpty = query.trim() === ''
  const recentItems = queryEmpty ? recent.map(r => ({ ...r, kind: 'record' })) : []
  const pageMatches = matchPages(query)
  const pageItems = pageMatches.map(p => ({ ...p, kind: 'page' }))
  const recordItems = results.map(r => ({ ...r, kind: 'record' }))
  const allItems = [...recentItems, ...pageItems, ...recordItems]

  function go(item) {
    if (!item) return
    navigate(item.kind === 'page' ? item.to : item.url)
    onClose()
  }

  function handleKeyDown(e) {
    if (e.key === 'Escape') { onClose(); return }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(s => Math.min(s + 1, allItems.length - 1)) }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(s => Math.max(s - 1, 0)) }
    if (e.key === 'Enter') { e.preventDefault(); go(allItems[selected]) }
  }

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-[10vh]">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full max-w-xl bg-white rounded-xl shadow-2xl overflow-hidden">
        {/* Input */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-slate-200">
          <Search size={18} className="text-slate-400 flex-shrink-0" />
          <input
            ref={inputRef}
            data-testid="global-search-input"
            value={query}
            onChange={handleChange}
            onKeyDown={handleKeyDown}
            placeholder="Rechercher ou aller à une page…"
            className="flex-1 text-sm outline-none text-slate-900 placeholder-slate-400"
          />
          {loading && (
            <div className="w-4 h-4 border-2 border-brand-500 border-t-transparent rounded-full animate-spin flex-shrink-0" />
          )}
          {!loading && query && (
            <button onClick={() => { setQuery(''); setResults([]); setSelected(0) }} className="text-slate-400 hover:text-slate-600">
              <X size={14} />
            </button>
          )}
          <kbd className="hidden sm:inline text-xs text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded border border-slate-200">Esc</kbd>
        </div>

        {/* Results */}
        {allItems.length > 0 && (
          <ul className="max-h-80 overflow-y-auto py-1">
            {recentItems.length > 0 && (
              <li className="flex items-center justify-between px-4 pt-2 pb-1 select-none">
                <span className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                  <Clock size={12} /> Récemment consultés
                </span>
                <button
                  data-testid="global-search-clear-recent"
                  className="text-[11px] font-medium text-slate-400 hover:text-slate-600 normal-case tracking-normal"
                  onClick={(e) => { e.stopPropagation(); clearRecentRecords() }}
                >
                  Effacer
                </button>
              </li>
            )}
            {recentItems.map((r, i) => {
              const Icon = TYPE_ICON[r.type] || Clock
              const idx = i
              return (
                <li key={`recent-${r.url}`}>
                  <button
                    data-testid={`global-search-recent-${r.url}`}
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${idx === selected ? 'bg-brand-50' : 'hover:bg-slate-50'}`}
                    onClick={() => go(r)}
                    onMouseEnter={() => setSelected(idx)}
                  >
                    <div className="w-7 h-7 rounded-lg bg-slate-100 flex items-center justify-center flex-shrink-0">
                      <Icon size={14} className="text-slate-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-900 truncate">{r.label}</div>
                      {r.sub && <div className="text-xs text-slate-400 truncate">{r.sub}</div>}
                    </div>
                    <span className="text-xs text-slate-400 flex-shrink-0">{TYPE_LABEL[r.type] || ''}</span>
                  </button>
                </li>
              )
            })}

            {pageItems.length > 0 && (
              <li className="px-4 pt-2 pb-1 text-[11px] font-semibold text-slate-400 uppercase tracking-wider select-none">Aller à</li>
            )}
            {pageItems.map((p, i) => {
              const Icon = p.icon || Search
              const idx = recentItems.length + i
              return (
                <li key={`page-${p.to}`}>
                  <button
                    data-testid={`global-search-page-${p.to}`}
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${idx === selected ? 'bg-brand-50' : 'hover:bg-slate-50'}`}
                    onClick={() => go(p)}
                    onMouseEnter={() => setSelected(idx)}
                  >
                    <div className="w-7 h-7 rounded-lg bg-slate-100 flex items-center justify-center flex-shrink-0">
                      <Icon size={14} className="text-slate-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-900 truncate">{p.label}</div>
                      {p.group && <div className="text-xs text-slate-400 truncate">{p.group}</div>}
                    </div>
                    {idx === selected
                      ? <CornerDownLeft size={13} className="text-slate-400 flex-shrink-0" />
                      : <span className="text-xs text-slate-400 flex-shrink-0">Page</span>}
                  </button>
                </li>
              )
            })}

            {recordItems.length > 0 && (
              <li className="px-4 pt-2 pb-1 text-[11px] font-semibold text-slate-400 uppercase tracking-wider select-none">Résultats</li>
            )}
            {recordItems.map((r, i) => {
              const Icon = TYPE_ICON[r.type] || Search
              const idx = recentItems.length + pageItems.length + i
              return (
                <li key={`${r.type}-${r.id}`}>
                  <button
                    className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${idx === selected ? 'bg-brand-50' : 'hover:bg-slate-50'}`}
                    onClick={() => go(r)}
                    onMouseEnter={() => setSelected(idx)}
                  >
                    <div className="w-7 h-7 rounded-lg bg-slate-100 flex items-center justify-center flex-shrink-0">
                      <Icon size={14} className="text-slate-500" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium text-slate-900 truncate">{r.label}</div>
                      {r.sub && <div className="text-xs text-slate-400 truncate">{r.sub}</div>}
                    </div>
                    <span className="text-xs text-slate-400 flex-shrink-0">{TYPE_LABEL[r.type]}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {query.length >= 2 && !loading && allItems.length === 0 && (
          <div className="py-10 text-center text-slate-400 text-sm">Aucun résultat pour « {query} »</div>
        )}
      </div>
    </div>
  )
}
```


---

## `client/src/components/KeyboardShortcutsModal.jsx`

L'aide « ? » — construite à partir de `NAV_SHORTCUTS`, donc jamais désynchronisée.

```jsx
import { Modal } from './Modal.jsx'
import { NAV_SHORTCUTS } from './Layout.jsx'

// Touche d'affichage : Mac montre ⌘, le reste Ctrl.
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')
const cmdKey = isMac ? '⌘' : 'Ctrl'

// Raccourcis « système » qui ne sont pas de la simple navigation. Listés en
// plus de NAV_SHORTCUTS pour que la modale documente tout le comportement.
const SYSTEM_SHORTCUTS = [
  { keys: [cmdKey, 'K'], label: 'Recherche globale' },
  { keys: [cmdKey, '/'], label: 'File de travaux (ajouter un prompt, répondre à Claude)' },
  { keys: ['?'], label: 'Afficher cette aide' },
]

// Raccourcis disponibles sur une fiche détail (facture, billet) pour parcourir
// la file d'enregistrements sans la souris. Implémentés par useRecordKeyNav.
const RECORD_SHORTCUTS = [
  { keys: ['J', '↓'], label: 'Enregistrement suivant' },
  { keys: ['K', '↑'], label: 'Enregistrement précédent' },
]

function Kbd({ children }) {
  return (
    <kbd className="inline-flex items-center justify-center min-w-[1.75rem] h-7 px-2 text-sm font-semibold text-slate-700 bg-slate-100 border border-slate-300 border-b-2 rounded-md">
      {children}
    </kbd>
  )
}

function ShortcutRow({ keys, label }) {
  return (
    <div className="flex items-center justify-between py-2">
      <span className="text-sm text-slate-700">{label}</span>
      <span className="flex items-center gap-1" data-testid="shortcut-keys">
        {keys.map((k, i) => (
          <Kbd key={i}>{k}</Kbd>
        ))}
      </span>
    </div>
  )
}

export function KeyboardShortcutsModal({ isOpen, onClose }) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Raccourcis clavier" size="md">
      <div data-testid="keyboard-shortcuts-modal">
        <section>
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">Navigation</h3>
          <div className="divide-y divide-slate-100">
            {NAV_SHORTCUTS.map(s => (
              <ShortcutRow key={s.key} keys={[s.key.toUpperCase()]} label={s.label} />
            ))}
          </div>
        </section>

        <section className="mt-5">
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">Sur une fiche</h3>
          <div className="divide-y divide-slate-100">
            {RECORD_SHORTCUTS.map((s, i) => (
              <ShortcutRow key={i} keys={s.keys} label={s.label} />
            ))}
          </div>
        </section>

        <section className="mt-5">
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">Général</h3>
          <div className="divide-y divide-slate-100">
            {SYSTEM_SHORTCUTS.map((s, i) => (
              <ShortcutRow key={i} keys={s.keys} label={s.label} />
            ))}
          </div>
        </section>

        <p className="mt-5 text-xs text-slate-400">
          Les raccourcis d'une seule touche sont ignorés pendant la saisie dans un champ.
        </p>
      </div>
    </Modal>
  )
}
```


# 2.3 — Primitives partagées


---

## `client/src/components/Modal.jsx`

Modale : verrou du scroll, autofocus du premier champ, focus-trap, fermeture Échap. Tailles `sm|md|lg|xl`.

```jsx
import { useEffect, useRef } from 'react'
import { X } from 'lucide-react'

// Sélecteur des éléments réellement focusables à l'intérieur de la modale.
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'textarea:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function getFocusable(container) {
  if (!container) return []
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
    (el) => el.offsetParent !== null || el.getClientRects().length > 0,
  )
}

export function Modal({ isOpen, onClose, title, children, size = 'md' }) {
  const contentRef = useRef(null)

  // Verrou du scroll du body quand la modale est ouverte
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => { document.body.style.overflow = '' }
  }, [isOpen])

  // Autofocus du premier champ à l'ouverture : on privilégie le premier
  // input/textarea/select ; à défaut, le premier élément focusable (hors bouton X).
  useEffect(() => {
    if (!isOpen) return
    // rAF pour laisser le DOM se peindre avant de focus
    const raf = requestAnimationFrame(() => {
      const container = contentRef.current
      if (!container) return
      const focusables = getFocusable(container)
      const firstField = focusables.find((el) =>
        /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName),
      )
      const target = firstField || focusables.find((el) => el.dataset.modalClose === undefined)
      if (target) target.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [isOpen])

  // Fermeture sur Échap + focus-trap (Tab / Shift+Tab cyclent dans la modale)
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose?.()
        return
      }
      if (e.key === 'Tab') {
        const focusables = getFocusable(contentRef.current)
        if (focusables.length === 0) {
          e.preventDefault()
          return
        }
        const first = focusables[0]
        const last = focusables[focusables.length - 1]
        const active = document.activeElement
        // Si le focus est hors de la modale, le ramener dedans
        if (!contentRef.current?.contains(active)) {
          e.preventDefault()
          first.focus()
          return
        }
        if (e.shiftKey && active === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && active === last) {
          e.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) return null

  const sizes = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
      <div
        className="fixed inset-0 bg-black/50"
        onClick={onClose}
      />
      <div ref={contentRef} className={`relative bg-white rounded-2xl shadow-2xl w-full ${sizes[size]} max-h-[90vh] flex flex-col`}>
        {title && (
          <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 flex-shrink-0">
            <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
            <button
              onClick={onClose}
              data-modal-close
              aria-label="Fermer"
              className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
            >
              <X size={18} />
            </button>
          </div>
        )}
        <div className="overflow-y-auto flex-1 px-6 py-4">
          {children}
        </div>
      </div>
    </div>
  )
}

export function ConfirmModal({ isOpen, onClose, onConfirm, title, message, confirmLabel = 'Confirmer', danger = false }) {
  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="sm">
      <p className="text-slate-600 mb-6 whitespace-pre-line">{message}</p>
      <div className="flex justify-end gap-3">
        <button onClick={onClose} className="btn-secondary">Annuler</button>
        <button
          onClick={() => { onConfirm(); onClose(); }}
          className={danger ? 'btn-danger' : 'btn-primary'}
        >
          {confirmLabel}
        </button>
      </div>
    </Modal>
  )
}
```


---

## `client/src/components/ui/ToastProvider.jsx`

Toasts — le canal de feedback par défaut.

```jsx
import { createContext, useContext, useState, useCallback } from 'react'
import { X } from 'lucide-react'

const ToastContext = createContext(null)

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])

  const addToast = useCallback(({ message, type = 'info', action, duration = 4000 }) => {
    const id = Date.now() + Math.random()
    setToasts(prev => [...prev, { id, message, type, action, duration }])
    if (duration > 0) {
      setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), duration)
    }
    return id
  }, [])

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id))
  }, [])

  return (
    <ToastContext.Provider value={{ addToast, removeToast }}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={removeToast} />
    </ToastContext.Provider>
  )
}

export function useToast() {
  return useContext(ToastContext)
}

function ToastContainer({ toasts, onDismiss }) {
  return (
    <div className="fixed bottom-4 left-4 z-[100] flex flex-col gap-2 max-w-sm">
      {toasts.map(toast => (
        <div key={toast.id}
          className={`flex items-center gap-3 px-4 py-3 rounded-lg shadow-lg text-sm animate-slide-in-up ${
            toast.type === 'success' ? 'bg-green-600 text-white' :
            toast.type === 'error'   ? 'bg-red-600 text-white' :
            toast.type === 'warning' ? 'bg-amber-600 text-white' :
            toast.type === 'undo'    ? 'bg-gray-800 text-white' :
                                       'bg-gray-700 text-white'
          }`}>
          <span className="flex-1">{toast.message}</span>
          {toast.action && (
            <button onClick={() => { toast.action.onClick(); onDismiss(toast.id) }}
              className="text-xs font-medium underline hover:no-underline shrink-0">
              {toast.action.label}
            </button>
          )}
          <button onClick={() => onDismiss(toast.id)}
            className="text-white/60 hover:text-white shrink-0">
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}
```


---

## `client/src/components/ConfirmProvider.jsx`

Confirmation — réservée au destructeur non réversible.

```jsx
import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react'
import { ConfirmModal } from './Modal.jsx'

const ConfirmContext = createContext(null)

export function ConfirmProvider({ children }) {
  const [state, setState] = useState(null)
  const resolveRef = useRef(null)

  const confirm = useCallback((opts) => {
    const config = typeof opts === 'string' ? { message: opts } : (opts || {})
    return new Promise((resolve) => {
      resolveRef.current = resolve
      setState({
        title: config.title || 'Confirmer',
        message: config.message || '',
        confirmLabel: config.confirmLabel || 'Confirmer',
        danger: config.danger !== false,
      })
    })
  }, [])

  const handleClose = useCallback(() => {
    if (resolveRef.current) { resolveRef.current(false); resolveRef.current = null }
    setState(null)
  }, [])

  const handleConfirm = useCallback(() => {
    if (resolveRef.current) { resolveRef.current(true); resolveRef.current = null }
    setState(null)
  }, [])

  useEffect(() => {
    if (!state) return
    const onKey = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); handleConfirm() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [state, handleConfirm])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <ConfirmModal
        isOpen={!!state}
        onClose={handleClose}
        onConfirm={handleConfirm}
        title={state?.title}
        message={state?.message}
        confirmLabel={state?.confirmLabel}
        danger={state?.danger}
      />
    </ConfirmContext.Provider>
  )
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error('useConfirm must be used within ConfirmProvider')
  return ctx
}
```


---

## `client/src/components/UndoSendProvider.jsx`

Annulation après coup (10 s) : `scheduleSend()` pour tout envoi client-facing.

```jsx
import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react'

// Délai d'annulation avant l'exécution réelle d'un envoi (email client-facing).
// Pendant ce délai, un toast avec barre de progression laisse l'utilisateur annuler.
const COUNTDOWN_MS = 10000

const UndoSendContext = createContext(null)

export function UndoSendProvider({ children }) {
  const [pending, setPending] = useState(null) // { id, message, onRun, onCancel }
  const timerRef = useRef(null)
  const pendingRef = useRef(null)
  const seqRef = useRef(0)

  const finish = useCallback(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null }
    pendingRef.current = null
    setPending(null)
  }, [])

  // Planifie un envoi qui s'exécutera après COUNTDOWN_MS sauf annulation.
  // onRun: l'action réelle (appel API + toast de résultat). onCancel: feedback d'annulation.
  const scheduleSend = useCallback(({ message, onRun, onCancel }) => {
    // Si un envoi est déjà en attente, on le déclenche immédiatement avant d'en planifier un nouveau.
    if (timerRef.current) {
      clearTimeout(timerRef.current)
      timerRef.current = null
      const prev = pendingRef.current
      prev?.onRun?.()
    }
    const entry = { id: ++seqRef.current, message, onRun, onCancel }
    pendingRef.current = entry
    setPending(entry)
    timerRef.current = setTimeout(() => {
      const e = pendingRef.current
      finish()
      e?.onRun?.()
    }, COUNTDOWN_MS)
  }, [finish])

  const cancel = useCallback(() => {
    const e = pendingRef.current
    finish()
    e?.onCancel?.()
  }, [finish])

  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current) }, [])

  return (
    <UndoSendContext.Provider value={scheduleSend}>
      {children}
      {pending && (
        <UndoSendToast
          key={pending.id}
          message={pending.message}
          durationMs={COUNTDOWN_MS}
          onCancel={cancel}
        />
      )}
    </UndoSendContext.Provider>
  )
}

function UndoSendToast({ message, durationMs, onCancel }) {
  const [width, setWidth] = useState(100)
  useEffect(() => {
    // rAF pour laisser le navigateur peindre 100% avant de lancer la transition vers 0%.
    const raf = requestAnimationFrame(() => setWidth(0))
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <div
      data-testid="undo-send-toast"
      className="fixed bottom-4 left-4 z-[110] w-80 max-w-[calc(100vw-2rem)] bg-gray-800 text-white rounded-lg shadow-lg overflow-hidden animate-slide-in-up"
    >
      <div className="flex items-center gap-3 px-4 py-3 text-sm">
        <span className="flex-1">{message}</span>
        <button
          type="button"
          onClick={onCancel}
          data-testid="undo-send-cancel"
          className="text-xs font-medium underline hover:no-underline shrink-0"
        >
          Annuler
        </button>
      </div>
      <div className="h-1 bg-white/20">
        <div
          className="h-full bg-white/70"
          style={{ width: `${width}%`, transition: `width ${durationMs}ms linear` }}
        />
      </div>
    </div>
  )
}

export function useUndoSend() {
  const ctx = useContext(UndoSendContext)
  if (!ctx) throw new Error('useUndoSend must be used within UndoSendProvider')
  return ctx
}
```


---

## `client/src/components/Badge.jsx`

Pastilles : tons + mapping statut → couleur (une seule source de vérité des couleurs de statut).

```jsx
export function Badge({ children, color = 'gray', size = 'sm' }) {
  const colors = {
    gray: 'bg-slate-100 text-slate-700',
    slate: 'bg-slate-200 text-slate-800',
    blue: 'bg-blue-100 text-blue-800',
    indigo: 'bg-brand-100 text-brand-800',
    green: 'bg-green-100 text-green-800',
    yellow: 'bg-yellow-100 text-yellow-800',
    orange: 'bg-orange-100 text-orange-800',
    red: 'bg-red-100 text-red-800',
    purple: 'bg-purple-100 text-purple-800',
    pink: 'bg-pink-100 text-pink-800',
    teal: 'bg-teal-100 text-teal-800',
  }
  const sizes = {
    xs: 'text-xs px-1.5 py-0.5',
    sm: 'text-xs px-2.5 py-0.5',
    md: 'text-sm px-3 py-1',
  }
  return (
    <span className={`inline-flex items-center rounded-full font-medium ${colors[color] || colors.gray} ${sizes[size] || sizes.sm}`}>
      {children}
    </span>
  )
}

export function phaseBadgeColor(phase) {
  const map = {
    'Contact': 'gray',
    'Qualified': 'slate',
    'Problem aware': 'yellow',
    'Solution aware': 'orange',
    'Lead': 'blue',
    'Quote Sent': 'purple',
    'Customer': 'green',
    'Not a Client Anymore': 'red',
  }
  return map[phase] || 'gray'
}

export function orderStatusColor(status) {
  const map = {
    'Commande vide': 'gray',
    "Gel d'envois": 'orange',
    'En attente': 'blue',
    'Items à fabriquer ou à acheter': 'yellow',
    'Tous les items sont disponibles': 'indigo',
    'Tout est dans la boite': 'purple',
    'Partiellement envoyé': 'orange',
    'JWT-config': 'blue',
    "Envoyé aujourd'hui": 'green',
    'Envoyé': 'green',
    'Drop ship seulement': 'teal',
    'ERREUR SYSTÈME': 'red',
  }
  return map[status] || 'gray'
}

export function ticketStatusColor(status) {
  const map = {
    'Waiting on us': 'orange',
    'Waiting on them': 'yellow',
    'Closed': 'green',
  }
  return map[status] || 'gray'
}

export function projectStatusColor(status) {
  const map = {
    'Ouvert': 'blue',
    'Gagné': 'green',
    'Perdu': 'red',
  }
  return map[status] || 'gray'
}

export function stockStatusColor(product) {
  if (!product.min_stock || product.min_stock === 0) return 'gray'
  if (product.stock_qty <= 0) return 'red'
  if (product.stock_qty <= product.min_stock) return 'red'
  if (product.stock_qty <= product.min_stock * 2) return 'yellow'
  return 'green'
}

export function stockStatusLabel(product) {
  if (!product.min_stock || product.min_stock === 0) return 'N/A'
  if (product.stock_qty <= 0) return 'Rupture'
  if (product.stock_qty <= product.min_stock) return 'Critique'
  if (product.stock_qty <= product.min_stock * 2) return 'Faible'
  return 'OK'
}
```


---

## `client/src/components/Spinner.jsx`

Indicateurs de chargement.

```jsx
/**
 * Spinner réutilisable : indicateur de chargement homogène pour toute l'app.
 *
 * Remplace les `<div className="animate-spin rounded-full …" />` dupliqués dans
 * les fiches détail et les `<div>Chargement…</div>` en texte brut sans feedback
 * visuel. Complète <EmptyState> (états vides) côté états de chargement.
 *
 * Props :
 *  - size       : 'xs' | 'sm' | 'md' | 'lg' (défaut 'md') — diamètre du cercle
 *  - color      : 'brand' | 'white' | 'slate' | 'emerald' (défaut 'brand')
 *  - label      : texte optionnel affiché à côté du cercle (ex. « Chargement… »)
 *  - center     : true → centre le spinner dans une zone h-64 (loader de page détail)
 *  - fullscreen : true → centre le spinner en plein écran (min-h-screen, pages publiques)
 *  - className  : classes supplémentaires sur le conteneur
 *
 * Exemples :
 *  <Spinner center />                          // loader de fiche détail
 *  <Spinner center label="Chargement…" />      // loader avec libellé
 *  <Spinner size="sm" color="white" />         // dans un bouton
 *  <Spinner fullscreen label="Chargement…" />  // page publique plein écran
 */
const SIZES = {
  xs: 'h-3.5 w-3.5',
  sm: 'h-5 w-5',
  md: 'h-8 w-8',
  lg: 'h-10 w-10',
}
const COLORS = {
  brand: 'border-brand-600',
  white: 'border-white',
  slate: 'border-slate-500',
  emerald: 'border-emerald-600',
}

export default function Spinner({
  size = 'md',
  color = 'brand',
  label,
  center = false,
  fullscreen = false,
  className = '',
}) {
  const circle = (
    <span
      data-testid="spinner"
      aria-hidden="true"
      className={`inline-block animate-spin rounded-full border-b-2 ${SIZES[size] || SIZES.md} ${COLORS[color] || COLORS.brand}`}
    />
  )

  if (center || fullscreen) {
    return (
      <div
        role="status"
        aria-label={label || 'Chargement…'}
        className={`flex items-center justify-center gap-3 ${fullscreen ? 'min-h-screen' : 'h-64'} ${className}`}
      >
        {circle}
        {label && <span className="text-sm text-slate-400">{label}</span>}
        {!label && <span className="sr-only">Chargement…</span>}
      </div>
    )
  }

  if (label) {
    return (
      <span role="status" className={`inline-flex items-center gap-2 text-sm text-slate-400 ${className}`}>
        {circle}
        <span>{label}</span>
      </span>
    )
  }

  return (
    <span role="status" className={className}>
      {circle}
      <span className="sr-only">Chargement…</span>
    </span>
  )
}
```


---

## `client/src/components/EmptyState.jsx`

État vide dessiné, avec action de sortie.

```jsx
import { Link } from 'react-router-dom'
import { Inbox } from 'lucide-react'

/**
 * État vide réutilisable : icône contextuelle + message + (optionnel) CTA.
 *
 * Remplace les « Aucun résultat / Aucune commande » gris et secs des tableaux
 * et listes. Donne à l'utilisateur un repère visuel (icône), une explication
 * (description) et un point d'entrée pour agir (CTA).
 *
 * Props :
 *  - icon        : composant icône lucide (défaut Inbox)
 *  - title       : titre court (string)
 *  - description : phrase d'explication (string, optionnel)
 *  - cta         : { label, to?, onClick?, icon? } — bouton/lien d'action principale
 *  - secondaryCta: { label, onClick? } — action secondaire (ex. réinitialiser les filtres)
 *  - compact     : true pour les listes encartées des fiches détail (moins de padding)
 *  - className   : classes supplémentaires sur le conteneur
 */
export default function EmptyState({
  icon: Icon = Inbox,
  title = 'Aucun résultat',
  description,
  cta,
  secondaryCta,
  compact = false,
  className = '',
}) {
  const CtaIcon = cta?.icon
  return (
    <div
      data-testid="empty-state"
      className={`flex flex-col items-center justify-center text-center ${compact ? 'py-10 px-4' : 'py-16 px-6'} ${className}`}
    >
      <div
        className={`flex items-center justify-center rounded-full bg-slate-100 text-slate-400 mb-4 ${compact ? 'w-12 h-12' : 'w-16 h-16'}`}
      >
        {Icon && <Icon size={compact ? 22 : 28} strokeWidth={1.75} />}
      </div>
      <p className={`font-medium text-slate-600 ${compact ? 'text-sm' : 'text-base'}`}>{title}</p>
      {description && (
        <p className="mt-1 text-sm text-slate-400 max-w-sm leading-relaxed">{description}</p>
      )}
      {(cta || secondaryCta) && (
        <div className="mt-5 flex items-center gap-2">
          {cta && (cta.to ? (
            <Link to={cta.to} className="btn-primary btn-sm">
              {CtaIcon && <CtaIcon size={14} />}{cta.label}
            </Link>
          ) : (
            <button type="button" onClick={cta.onClick} className="btn-primary btn-sm">
              {CtaIcon && <CtaIcon size={14} />}{cta.label}
            </button>
          ))}
          {secondaryCta && (
            <button type="button" onClick={secondaryCta.onClick} className="btn-secondary btn-sm">
              {secondaryCta.label}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
```


---

## `client/src/components/SaveStatus.jsx`

Le témoin d'autosave : discret, non bloquant.

```jsx
import { useState, useRef, useCallback } from 'react'
import { Check, AlertCircle } from 'lucide-react'
import { useToast } from '../contexts/ToastContext.jsx'

/**
 * Indicateur d'autosave unifié pour les fiches détail.
 *
 * États :
 *   - 'idle'   : rien affiché (aucune sauvegarde récente)
 *   - 'saving' : spinner discret + « Sauvegarde… »
 *   - 'saved'  : ✓ « Sauvegardé » (s'efface tout seul après un délai)
 *   - 'error'  : ⚠ « Échec » (en plus du toast d'erreur réseau)
 *
 * Usage recommandé via le hook `useSaveStatus()` qui gère le cycle de vie
 * complet (saving → saved/error) et remonte les échecs réseau en toast.
 */
export function SaveStatus({ status, className = '' }) {
  if (!status || status === 'idle') return null

  const base = `inline-flex items-center gap-1.5 text-xs font-medium transition-opacity ${className}`

  if (status === 'saving') {
    return (
      <span className={`${base} text-slate-400`} aria-live="polite">
        <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-slate-500" />
        Sauvegarde…
      </span>
    )
  }
  if (status === 'saved') {
    return (
      <span className={`${base} text-green-600`} aria-live="polite">
        <Check size={13} /> Sauvegardé
      </span>
    )
  }
  if (status === 'error') {
    return (
      <span className={`${base} text-red-600`} aria-live="assertive">
        <AlertCircle size={13} /> Échec
      </span>
    )
  }
  return null
}

/**
 * Hook qui pilote un `SaveStatus` et remonte les échecs réseau en toast.
 *
 * Retourne `{ status, save }` :
 *   - `status` : à passer à `<SaveStatus status={status} />`
 *   - `save(fn)` : enveloppe une promesse de sauvegarde (ex. `() => api.x.update(...)`).
 *     Passe en 'saving', puis 'saved' (effacé après `savedMs`) en cas de succès,
 *     ou 'error' + toast en cas d'échec. Renvoie `true`/`false` selon le résultat.
 */
export function useSaveStatus({ savedMs = 1800 } = {}) {
  const [status, setStatus] = useState('idle')
  const { addToast } = useToast()
  const clearTimer = useRef(null)

  const save = useCallback(async (fn) => {
    clearTimeout(clearTimer.current)
    setStatus('saving')
    try {
      await fn()
      setStatus('saved')
      clearTimer.current = setTimeout(() => setStatus('idle'), savedMs)
      return true
    } catch (err) {
      setStatus('error')
      addToast({ message: `Échec de la sauvegarde : ${err?.message || 'erreur réseau'}`, type: 'error' })
      return false
    }
  }, [addToast, savedMs])

  return { status, save }
}
```


---

## `client/src/components/SearchableSelect.jsx`

Le select recherchable — obligatoire au-delà de 10 options.

```jsx
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { ChevronDown, Search, Check } from 'lucide-react'

// Id stable du menu en portail. Un seul menu est ouvert à la fois, donc un id
// fixe suffit — et il reste rétro-compatible avec les tests E2E historiques qui
// ciblent `#qb-select-portal`. Les nouveaux tests utilisent plutôt le data-testid
// `${testId}-menu`.
const PORTAL_ID = 'qb-select-portal'

// Select recherchable rendu via portail (évite le clipping par overflow des parents).
// Utilisé pour toute liste pouvant dépasser 10 options — voir règle de design
// « dropdowns avec recherche » (CLAUDE.md).
//
// Rétro-compatible avec l'API initiale `{ value, label }` :
//   <SearchableSelect value options={[{value,label}]} onChange placeholder testId />
//
// Props additionnelles pour les listes d'objets arbitraires :
//  - getOptionValue(opt)   : valeur retournée par onChange. Défaut: opt.value.
//  - getOptionLabel(opt)   : libellé affiché et recherché. Défaut: opt.label.
//  - getOptionKey(opt)     : clé React. Défaut: getOptionValue.
//  - renderOption(opt)     : JSX custom dans la liste (sinon getOptionLabel).
//  - filterOption(opt, q)  : filtre custom (q déjà en minuscules).
//  - emptyOption           : libellé d'une entrée « vide » (value '') ajoutée en tête.
//  - className             : classes du bouton déclencheur. Défaut: ancien look QB.
//  - size                  : 'xs' | 'sm' — taille typographique du menu. Défaut 'xs'.
//  - disabled              : bool.
export function SearchableSelect({
  value,
  options = [],
  onChange,
  placeholder = 'Sélectionner…',
  searchPlaceholder = 'Rechercher…',
  getOptionValue = o => o.value,
  getOptionLabel = o => o.label,
  getOptionKey,
  renderOption,
  filterOption,
  emptyOption,
  className = 'input-field text-xs w-full',
  size = 'xs',
  disabled = false,
  testId,
}) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [activeIdx, setActiveIdx] = useState(0)
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0, openUp: false })
  const btnRef = useRef(null)
  const inputRef = useRef(null)
  const keyOf = getOptionKey || getOptionValue
  const txt = size === 'sm' ? 'text-sm' : 'text-xs'

  const selected = useMemo(
    () => options.find(o => String(getOptionValue(o)) === String(value)),
    [options, value, getOptionValue]
  )

  // Tooltip natif avec le libellé complet quand il est tronqué (les libellés
  // peuvent être du JSX via getOptionLabel custom — on ne met un title que sur
  // les chaînes/nombres).
  const titleOf = o => {
    const l = getOptionLabel(o)
    return typeof l === 'string' || typeof l === 'number' ? String(l) : undefined
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return options
    const match = filterOption || ((o, query) => String(getOptionLabel(o) ?? '').toLowerCase().includes(query))
    return options.filter(o => match(o, q))
  }, [options, search, filterOption, getOptionLabel])

  const computePos = useCallback(() => {
    const rect = btnRef.current?.getBoundingClientRect()
    if (!rect) return
    const spaceBelow = window.innerHeight - rect.bottom
    const openUp = spaceBelow < 260 && rect.top > spaceBelow
    setPos({
      top: openUp ? rect.top - 4 : rect.bottom + 4,
      left: rect.left,
      width: Math.max(rect.width, 240),
      openUp,
    })
  }, [])

  useEffect(() => {
    if (!open) return
    computePos()
    setActiveIdx(0)
    setTimeout(() => inputRef.current?.focus(), 0)
    function onDown(e) {
      if (!btnRef.current?.contains(e.target) && !document.getElementById(PORTAL_ID)?.contains(e.target)) {
        setOpen(false)
        setSearch('')
      }
    }
    function onReflow() { computePos() }
    document.addEventListener('mousedown', onDown)
    window.addEventListener('scroll', onReflow, true)
    window.addEventListener('resize', onReflow)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('scroll', onReflow, true)
      window.removeEventListener('resize', onReflow)
    }
  }, [open, computePos])

  function commit(v) {
    onChange(v)
    setOpen(false)
    setSearch('')
  }

  function onKeyDown(e) {
    if (!open) {
      if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); setOpen(true) }
      return
    }
    if (e.key === 'Escape') { e.preventDefault(); setOpen(false); setSearch('') }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx(i => Math.min(i + 1, filtered.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx(i => Math.max(i - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (filtered[activeIdx]) commit(getOptionValue(filtered[activeIdx])) }
  }

  const showEmpty = emptyOption !== undefined && !search.trim()

  return (
    <div className="relative w-full">
      <button
        ref={btnRef}
        type="button"
        disabled={disabled}
        data-testid={testId}
        onClick={() => !disabled && setOpen(o => !o)}
        onKeyDown={onKeyDown}
        title={selected ? titleOf(selected) : undefined}
        className={`${className} flex items-center justify-between gap-1 text-left ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
      >
        <span className={`truncate ${selected ? 'text-slate-700' : 'text-slate-400'}`}>
          {selected ? getOptionLabel(selected) : placeholder}
        </span>
        <ChevronDown size={12} className="flex-shrink-0 text-slate-400" />
      </button>
      {open && createPortal(
        <div
          id={PORTAL_ID}
          data-testid={testId ? `${testId}-menu` : undefined}
          style={{
            position: 'fixed',
            top: pos.openUp ? undefined : pos.top,
            bottom: pos.openUp ? window.innerHeight - pos.top : undefined,
            left: pos.left,
            width: pos.width,
            zIndex: 9999,
          }}
          className="bg-white border border-slate-200 rounded-lg shadow-xl overflow-hidden flex flex-col"
        >
          <div className="p-2 border-b border-slate-100">
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                ref={inputRef}
                value={search}
                onChange={e => { setSearch(e.target.value); setActiveIdx(0) }}
                onKeyDown={onKeyDown}
                className={`w-full pl-7 pr-2 py-1.5 ${txt} border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400`}
                placeholder={searchPlaceholder}
              />
            </div>
          </div>
          <div className="max-h-64 overflow-y-auto">
            {showEmpty && (
              <button
                type="button"
                onClick={() => commit('')}
                className={`w-full text-left px-3 py-2 ${txt} hover:bg-slate-50 flex items-center gap-2 ${String(value) === '' ? 'text-brand-600 font-medium bg-brand-50' : 'text-slate-500'}`}
              >
                <Check size={13} className={`flex-shrink-0 ${String(value) === '' ? 'text-brand-600' : 'text-transparent'}`} />
                <span className="truncate">{emptyOption}</span>
              </button>
            )}
            {filtered.length === 0 ? (
              <p className={`${txt} text-slate-400 text-center py-3`}>Aucun résultat</p>
            ) : filtered.map((o, idx) => {
              const isSel = String(getOptionValue(o)) === String(value)
              return (
                <button
                  key={keyOf(o) ?? idx}
                  type="button"
                  onClick={() => commit(getOptionValue(o))}
                  onMouseEnter={() => setActiveIdx(idx)}
                  title={titleOf(o)}
                  className={`w-full text-left px-3 py-2 ${txt} flex items-center gap-2 transition-colors ${idx === activeIdx ? 'bg-slate-50' : ''} ${isSel ? 'text-brand-600 font-medium' : 'text-slate-700'}`}
                >
                  <Check size={13} className={`flex-shrink-0 ${isSel ? 'text-brand-600' : 'text-transparent'}`} />
                  <span className="flex-1 min-w-0 truncate">
                    {renderOption ? renderOption(o) : getOptionLabel(o)}
                  </span>
                </button>
              )
            })}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

export default SearchableSelect
```


---

## `client/src/components/LinkedRecordField.jsx`

Champ référence : picker recherchable + lien cliquable vers la fiche.

```jsx
import { useState, useRef, useEffect, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router-dom'
import { Plus, X, Search } from 'lucide-react'

export default function LinkedRecordField({
  value,
  options,
  labelFn,
  getHref,
  placeholder,
  saving = false,
  disabled = false,
  onChange,
  allowClear = true,
  name,
}) {
  const fieldTestId = name ? `linked-record-field-${name}` : 'linked-record-field'
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 })
  const btnRef = useRef(null)
  const inputRef = useRef(null)

  const getLabel = labelFn || (o => o?.name ?? String(o?.id ?? ''))
  const hasValue = value != null && value !== ''
  const selected = hasValue ? options.find(o => String(o.id) === String(value)) : null

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return options.slice(0, 60)
    return options.filter(o => getLabel(o).toLowerCase().includes(q)).slice(0, 60)
  }, [options, search, getLabel])

  useEffect(() => {
    if (!open) { setSearch(''); return }
    const rect = btnRef.current?.getBoundingClientRect()
    if (rect) setPos({ top: rect.bottom + 4, left: rect.left, width: Math.max(rect.width, 240) })
    const focusTimer = setTimeout(() => inputRef.current?.focus(), 0)
    function handler(e) {
      const portal = document.getElementById('linked-record-portal')
      if (!btnRef.current?.contains(e.target) && !portal?.contains(e.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => {
      clearTimeout(focusTimer)
      document.removeEventListener('mousedown', handler)
    }
  }, [open])

  const spinner = saving && (
    <span className="inline-block w-3 h-3 border border-slate-400 border-t-transparent rounded-full animate-spin flex-shrink-0" />
  )

  if (selected) {
    const href = getHref ? getHref(selected) : null
    const label = getLabel(selected)
    const bodyCls = 'text-sm text-slate-700 truncate'
    return (
      <div className="flex items-center gap-1.5 min-w-0" data-testid={fieldTestId} data-state="selected">
        <span className="inline-flex items-center gap-0.5 bg-slate-100 hover:bg-slate-200/70 rounded-md max-w-full transition-colors">
          {href ? (
            <Link
              to={href}
              className={`${bodyCls} pl-2.5 pr-1 py-1 hover:text-brand-600 hover:underline`}
              data-testid="linked-record-link"
            >
              {label}
            </Link>
          ) : (
            <span className={`${bodyCls} pl-2.5 pr-1 py-1`}>{label}</span>
          )}
          {allowClear && (
            <button
              type="button"
              onClick={() => !saving && !disabled && onChange(null)}
              disabled={saving || disabled}
              className="p-1 mr-0.5 rounded text-slate-400 hover:text-red-500 hover:bg-slate-300/60 disabled:opacity-50"
              aria-label="Délier"
              data-testid="linked-record-clear"
            >
              <X size={12} />
            </button>
          )}
        </span>
        {spinner}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-1.5 min-w-0" data-testid={fieldTestId} data-state="empty">
      <button
        ref={btnRef}
        type="button"
        onClick={() => !disabled && !saving && setOpen(o => !o)}
        disabled={disabled || saving}
        className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md bg-slate-100 text-slate-400 hover:bg-slate-200 hover:text-slate-600 disabled:opacity-50 transition-colors"
        data-testid="linked-record-add"
      >
        <Plus size={12} />
        {placeholder && <span>{placeholder}</span>}
      </button>
      {spinner}
      {open && createPortal(
        <div
          id="linked-record-portal"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, zIndex: 9999 }}
          className="bg-white border border-slate-200 rounded-lg shadow-xl overflow-hidden"
        >
          <div className="p-2 border-b border-slate-100">
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                ref={inputRef}
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full pl-7 pr-2 py-1.5 text-xs border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400"
                placeholder="Rechercher..."
              />
            </div>
          </div>
          <div className="max-h-52 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-3">Aucun résultat</p>
            ) : filtered.map(o => (
              <button
                key={o.id}
                type="button"
                onClick={() => { onChange(o.id); setOpen(false) }}
                className="w-full text-left px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
              >
                {getLabel(o)}
              </button>
            ))}
            {!search && options.length > 60 && (
              <div className="px-3 py-2 text-xs text-slate-400 border-t border-slate-100">
                {options.length - 60} autres — affinez la recherche
              </div>
            )}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
```


---

## `client/src/components/ui/DynamicIcon.jsx`

Icône lucide résolue par nom (icônes stockées en DB).

```jsx
import * as Icons from 'lucide-react'

const FALLBACK = Icons.Table2

export function DynamicIcon({ name, size = 16, className }) {
  const Icon = (name && Icons[name]) ? Icons[name] : FALLBACK
  return <Icon size={size} className={className} />
}
```


---

## `client/src/components/ErrorBoundary.jsx`

Garde-fou de rendu.

```jsx
import { Component } from 'react'
import { AlertTriangle, RefreshCw, Home } from 'lucide-react'

// ErrorBoundary global — capture toute erreur de rendu dans l'arbre React et
// affiche un fallback exploitable au lieu de l'écran blanc total (le défaut
// React : une exception non rattrapée pendant le render démonte toute l'app).
//
// L'app étant l'outil d'opérations quotidien, un crash sur une page (null ref,
// state corrompu, données inattendues d'un sync realtime) ne doit pas bloquer
// l'utilisateur sans recours ni diagnostic. Le fallback offre :
//   - « Réessayer » : remonte l'arbre en place (utile si l'erreur était
//     transitoire — ex. donnée pas encore arrivée).
//   - « Tableau de bord » : navigation dure vers /dashboard (reload complet,
//     repart d'un état propre quand la page courante est définitivement cassée).
//
// Les error boundaries DOIVENT être des composants classe : seuls
// getDerivedStateFromError / componentDidCatch capturent les erreurs de rendu
// des enfants (pas de hook équivalent).
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // Trace en console pour le diagnostic (la stack React n'est pas visible
    // autrement une fois le fallback affiché).
    console.error('[ErrorBoundary] render crash:', error, info?.componentStack)
  }

  handleRetry = () => {
    this.setState({ error: null })
  }

  handleHome = () => {
    // Navigation dure (pas react-router) : on est dans un état de crash, le
    // routeur lui-même peut être compromis. basename = /erp (voir main.jsx).
    window.location.assign('/erp/dashboard')
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div
        data-testid="error-boundary-fallback"
        className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/80 p-4"
      >
        <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-md w-full text-center">
          <div className="w-14 h-14 rounded-full bg-red-100 flex items-center justify-center mx-auto mb-4">
            <AlertTriangle size={26} className="text-red-600" />
          </div>
          <h2 className="text-lg font-semibold text-slate-900 mb-2">
            Une erreur est survenue
          </h2>
          <p className="text-sm text-slate-600 mb-6">
            Cette page a rencontré un problème inattendu. Tu peux réessayer ou
            revenir au tableau de bord. Si le problème persiste, signale-le.
          </p>

          {error?.message && (
            <pre className="text-left text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg p-3 mb-6 overflow-auto max-h-32 whitespace-pre-wrap break-words">
              {String(error.message)}
            </pre>
          )}

          <div className="flex items-center justify-center gap-3">
            <button
              onClick={this.handleRetry}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 text-white text-sm font-medium hover:bg-slate-700"
            >
              <RefreshCw size={16} />
              Réessayer
            </button>
            <button
              onClick={this.handleHome}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-300 text-slate-700 text-sm font-medium hover:bg-slate-50"
            >
              <Home size={16} />
              Tableau de bord
            </button>
          </div>
        </div>
      </div>
    )
  }
}
```


---

## `client/src/components/ServerOfflineOverlay.jsx`

Le serveur redémarre (déploiement) : voile + reprise automatique.

```jsx
import { useEffect, useState, useRef } from 'react'
import { Loader2, ServerOff, RefreshCw, WifiOff } from 'lucide-react'
import { subscribe, getIsOffline, getReason, getKnownBootId, markOnline, subscribeServerRestart, acceptBootId } from '../lib/serverStatus.js'
import { sync } from '../lib/dataSync.js'
import { connect as reconnectRealtime } from '../lib/realtime.js'

// Fullscreen overlay shown when the server is unreachable. Pings /api/health
// every 10 s; on success, compare the returned boot_id with the one we saw
// before the outage:
//   - boot_id identique ou inconnu → simple blip réseau → on masque l'overlay
//     SANS recharger la page : un reload fermerait toute modale ouverte et
//     perdrait les modifications en cours (ex. modale de modification d'une
//     automation système). Les données sont rattrapées via un delta dataSync
//     immédiat + reconnexion WS.
//   - boot_id changé → pm2 a redémarré. On vérifie alors si le bundle JS
//     servi a changé (hash Vite dans index.html) :
//       - bundle identique (pm2 restart sans rebuild client — cas fréquent) →
//         même traitement qu'un blip : pas de reload, resync en place.
//       - bundle différent (vrai déploiement frontend) → message "Mise à jour
//         de l'app en cours" puis reload pour charger le nouveau code.
//
// L'apparition est debouncée 400 ms côté serverStatus.js — les blips < 400 ms
// (reconnexion WS, requête transiente) ne déclenchent jamais l'overlay.
//
// Triggered by lib/serverStatus → see realtime.js (WS abnormal close) and
// api.js (network error / 502 / 503 / 504).

// Compare le bundle JS actuellement chargé avec celui que le serveur sert.
// Vite content-hash les assets (dist/assets/index-XXXX.js) : si le hash de
// index.html correspond au <script> déjà chargé, un reload ne changerait
// rien — on l'évite pour préserver l'état de la page (modales ouvertes,
// champs en cours d'édition). En cas de doute (fetch raté, marqueur
// introuvable), on retourne true → comportement historique (reload).
async function bundleChanged() {
  try {
    const current = document.querySelector('script[src*="assets/index-"]')?.getAttribute('src')
    if (!current) return true
    const res = await fetch('/erp/', { cache: 'no-store' })
    if (!res.ok) return true
    const html = await res.text()
    const m = html.match(/assets\/index-[^"']+\.js/)
    if (!m) return true
    return !current.includes(m[0])
  } catch {
    return true
  }
}

function describeReason(reason) {
  if (!reason) return {
    icon: ServerOff,
    title: 'Connexion au serveur perdue',
    body: 'Nouvelle tentative de connexion en cours.',
  }
  if (reason === 'no-internet') return {
    icon: WifiOff,
    title: 'Pas de connexion Internet',
    body: 'Vérifie ta connexion réseau — la page se rechargera dès qu\'elle reviendra.',
  }
  if (reason.startsWith('gateway-')) {
    const code = reason.slice('gateway-'.length)
    return {
      icon: ServerOff,
      title: 'Serveur indisponible',
      body: `Le serveur a renvoyé une erreur ${code}. Il est probablement en train de redémarrer.`,
    }
  }
  if (reason.startsWith('ws-close-')) return {
    icon: ServerOff,
    title: 'Connexion au serveur perdue',
    body: 'La connexion temps-réel a été coupée. Le serveur est peut-être en train de redémarrer.',
  }
  if (reason === 'network') return {
    icon: ServerOff,
    title: 'Connexion au serveur perdue',
    body: 'Impossible de joindre le serveur. Nouvelle tentative en cours.',
  }
  return {
    icon: ServerOff,
    title: 'Connexion au serveur perdue',
    body: 'Nouvelle tentative de connexion en cours.',
  }
}

export default function ServerOfflineOverlay() {
  const [offline, setOffline] = useState(getIsOffline())
  const [reason, setReason] = useState(getReason())
  const [countdown, setCountdown] = useState(10)
  const [restartDetected, setRestartDetected] = useState(false)
  const pingingRef = useRef(false)
  const bundleCheckRef = useRef(false)

  useEffect(() => subscribe((isOffline) => {
    setOffline(isOffline)
    setReason(getReason())
  }), [])

  // Détection de redéploiement « à chaud » — quand le serveur redémarre assez
  // rapidement pour qu'aucune requête ne tombe (les nouvelles réponses
  // arrivent avec un nouveau X-Boot-Id). Sans ça, le client resterait
  // indéfiniment sur l'ancien bundle JS après un déploiement frontend.
  // Un pm2 restart sans rebuild client (cas fréquent) ne reload PAS : ça
  // fermerait toute modale ouverte et perdrait l'état de la page.
  useEffect(() => subscribeServerRestart((newBootId) => {
    if (bundleCheckRef.current) return // check déjà en cours
    bundleCheckRef.current = true
    bundleChanged().then((changed) => {
      if (!changed) {
        // Même bundle → accepter le nouveau boot_id (sinon chaque réponse
        // re-déclencherait ce handler) et rattraper les données manquées.
        acceptBootId(newBootId)
        sync()
        reconnectRealtime()
        return
      }
      setRestartDetected(true)
      // Laisse 1.2s pour que d'éventuelles requêtes en vol (autosave) puissent
      // finir et afficher l'overlay « Mise à jour » avant le reload.
      setTimeout(() => window.location.reload(), 1200)
    }).finally(() => { bundleCheckRef.current = false })
  }), [])

  useEffect(() => {
    if (!offline) return

    setCountdown(10)

    const tryPing = () => {
      if (pingingRef.current) return
      pingingRef.current = true
      fetch('/erp/api/health', { cache: 'no-store' })
        .then(async (res) => {
          if (!res.ok) return
          const bootIdHeader = res.headers.get('X-Boot-Id')
          let bootId = bootIdHeader
          if (!bootId) {
            try { const j = await res.json(); bootId = j.boot_id } catch {}
          }
          const previous = getKnownBootId()
          const restarted = previous && bootId && previous !== bootId
          if (restarted) {
            // Serveur redémarré pendant l'outage. Reload uniquement si le
            // bundle client a changé (vrai déploiement frontend) — un pm2
            // restart sans rebuild garde le même bundle et un reload ne
            // ferait que fermer les modales ouvertes.
            const changed = await bundleChanged()
            if (changed) {
              // setRestartDetected DOIT précéder markOnline — sinon offline=false
              // démonte le composant et l'écran "Mise à jour" ne s'affiche pas.
              setRestartDetected(true)
              setTimeout(() => { markOnline(); window.location.reload() }, 1200)
            } else {
              acceptBootId(bootId)
              markOnline()
              sync()
              reconnectRealtime()
            }
          } else {
            // Simple blip réseau (même serveur, même bundle) : masquer
            // l'overlay en place — surtout PAS de window.location.reload(),
            // qui fermerait les modales ouvertes et perdrait l'état de la
            // page. On rattrape les changements manqués via un delta
            // immédiat et on relance le WS sans attendre son backoff.
            markOnline()
            sync()
            reconnectRealtime()
          }
        })
        .catch(() => { /* still down — wait for next tick */ })
        .finally(() => { pingingRef.current = false })
    }

    const tick = setInterval(() => {
      setCountdown((c) => {
        if (c > 1) return c - 1
        tryPing()
        return 10
      })
    }, 1000)

    return () => clearInterval(tick)
  }, [offline])

  if (!offline && !restartDetected) return null

  if (restartDetected) {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/80">
        <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-md mx-4 text-center">
          <div className="w-14 h-14 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-4">
            <RefreshCw size={26} className="text-emerald-600 animate-spin" style={{ animationDuration: '1.6s' }} />
          </div>
          <h2 className="text-lg font-semibold text-slate-900 mb-2">
            Mise à jour de l'app en cours
          </h2>
          <p className="text-sm text-slate-600">
            Une nouvelle version vient d'être déployée. Rechargement…
          </p>
        </div>
      </div>
    )
  }

  const { icon: Icon, title, body } = describeReason(reason)

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/80">
      <div className="bg-white rounded-2xl shadow-2xl p-8 max-w-md mx-4 text-center">
        <div className="w-14 h-14 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-4">
          <Icon size={26} className="text-slate-600" />
        </div>
        <h2 className="text-lg font-semibold text-slate-900 mb-2">
          {title}
        </h2>
        <p className="text-sm text-slate-600 mb-6">
          {body}
        </p>
        <div className="flex items-center justify-center gap-2 text-sm text-slate-700">
          <Loader2 size={16} className="animate-spin text-slate-500" />
          <span>Nouvelle tentative dans <span className="font-semibold tabular-nums">{countdown}</span>&nbsp;s</span>
        </div>
        <button
          onClick={() => window.location.reload()}
          className="mt-6 text-xs text-slate-500 hover:text-slate-900 underline underline-offset-2"
        >
          Réessayer maintenant
        </button>
      </div>
    </div>
  )
}
```


# 2.4 — Tableaux et fiches


---

## `client/src/components/DataTable.jsx`

**Le composant central de l'app** : colonnes, tri, groupes, sélection, édition en ligne, champs personnalisés, side-peek (`peek`).

```jsx
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ChevronRight, ChevronDown, Trash2, Plus, Edit2, Layers, Filter, ArrowUp, ArrowDown, EyeOff, RotateCcw, Inbox, Sigma, Check, HelpCircle, GripVertical } from 'lucide-react'
import EmptyState from './EmptyState.jsx'
import { useTableView } from '../lib/useTableView.js'
import { applyFilter, applyFilterGroup, countFilterRules } from '../lib/tableFilters.js'
import { ViewToolbar, ROW_COLOR_STYLES } from './ViewToolbar.jsx'
import { defaultOpForType } from './FilterRow.jsx'
import api from '../lib/api.js'
import { fmtDate } from '../lib/formatDate.js'
import { useRealtimeChannel, diffFields } from '../lib/useRealtimeChannel.js'
import { getRecord } from '../lib/dataStore.js'
import { getUser } from '../lib/auth.jsx'
import { useConfirm } from './ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { CustomFieldModal } from './CustomFieldModal.jsx'
import { useCustomFields } from '../lib/useCustomFields.js'
import { customFieldToColumn, CUSTOM_FIELD_TABLES } from '../lib/customFieldDisplay.jsx'
import { summarizeDependents } from '../lib/customFieldDeps.js'
import { useFieldOverrides, applyFieldOverrides } from '../lib/fieldOverrides.jsx'
import RecordPeekDrawer from './RecordPeekDrawer.jsx'
import { useDecimalPrefs, formatDecimals } from '../lib/decimalPrefs.jsx'
import { parseDurationToSeconds, formatDurationSeconds } from '../lib/duration.js'

// Durée du surlignage « modifié en direct » — doit matcher la keyframe
// dtCellFlash / dtEditorBadge dans index.css.
const FLASH_MS = 3600

export function fmtPhone(val) {
  if (!val) return ''
  const digits = String(val).replace(/\D/g, '')
  const d = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`
  return val
}

// ── Édition « tableur » (copier/coller, fill-down) ─────────────────────────
// Coercition d'une valeur texte (saisie ou collée) vers le type de la colonne.
// Retourne `null` pour vider, une valeur typée, ou `undefined` si invalide
// (ex. nombre non-parsable) → le changement est alors ignoré silencieusement.
function coerceCellValue(col, str) {
  const s = String(str ?? '').trim()
  const t = col?.type
  if (t === 'number' || t === 'currency') {
    if (s === '') return null
    let cleaned = s.replace(/[\s$]/g, '')
    // « 1 234,56 » (fr-CA) → on traite la virgule comme séparateur décimal
    // quand il n'y a pas de point.
    if (cleaned.includes(',') && !cleaned.includes('.')) cleaned = cleaned.replace(',', '.')
    const n = Number(cleaned)
    return Number.isFinite(n) ? n : undefined
  }
  if (t === 'duration') {
    // Durée stockée en secondes. « 1:30 » → 5400 ; saisie invalide → undefined
    // (rejetée, la cellule garde sa valeur).
    if (s === '') return null
    const sec = parseDurationToSeconds(s)
    return sec == null ? undefined : sec
  }
  if (t === 'boolean') {
    // Checkbox stockée en 0/1. Tolère les formes textuelles courantes au
    // collage / fill-down ; saisie non reconnue → undefined (ignorée).
    if (s === '') return null
    const low = s.toLowerCase()
    if (['1', 'true', 'vrai', 'oui', 'yes', 'x', '✓', '✔', 'coché'].includes(low)) return 1
    if (['0', 'false', 'faux', 'non', 'no'].includes(low)) return 0
    return undefined
  }
  return s === '' ? null : s
}

// Parse un presse-papier TSV (format Excel/Sheets/Airtable) en matrice de
// chaînes : lignes séparées par \n, colonnes par \t.
function parseClipboard(text) {
  const norm = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const body = norm.endsWith('\n') ? norm.slice(0, -1) : norm
  if (body === '') return []
  return body.split('\n').map(line => line.split('\t'))
}

function DynamicCell({ value, col, decimals }) {
  if (value === null || value === undefined || value === '') return <span className="text-slate-300">—</span>
  const type = col.type

  if (type === 'single_select') {
    return <span className="inline-block text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-700">{value}</span>
  }
  if (type === 'multi_select') {
    let items = value
    try { items = JSON.parse(value) } catch {}
    if (!Array.isArray(items)) items = [items]
    return (
      <div className="flex gap-1 flex-wrap">
        {items.map((v, i) => <span key={i} className="text-xs px-2 py-0.5 rounded-full bg-brand-50 text-brand-700">{v}</span>)}
      </div>
    )
  }
  if (type === 'checkbox' || type === 'boolean') {
    // Tolère les multiples formes héritées : 1/true (sync récente),
    // '1' (cast SQLite TEXT), '1.0' (ancien parseFloat de la sync legacy).
    const truthy = value === 1 || value === true || value === '1' || value === '1.0' || Number(value) === 1
    return <span>{truthy ? '✓' : '—'}</span>
  }
  if (type === 'date') {
    let formatted
    try { formatted = fmtDate(value) } catch { formatted = null }
    return formatted
      ? <span className="text-slate-500 text-sm">{formatted}</span>
      : <span>{value}</span>
  }
  if (type === 'number') {
    // Décimales : préférence utilisateur (passée par DataTable) sinon col.decimals
    // (custom fields Airtable). Si aucune, rendu brut.
    const d = decimals != null ? decimals : (Number.isInteger(col.decimals) ? col.decimals : null)
    const formatted = formatDecimals(value, d)
    return <span className="tabular-nums">{formatted != null ? formatted : value}</span>
  }
  if (type === 'duration') {
    const n = Number(value)
    if (!Number.isFinite(n)) return <span>{value}</span>
    return <span className="tabular-nums">{formatDurationSeconds(n, col.durationFormat)}</span>
  }
  if (type === 'phone') {
    return <span className="font-mono text-sm">{fmtPhone(value)}</span>
  }
  // Image URL — render as thumbnail
  if (type === 'text' && col.options?.format === 'url') {
    const str = String(value)
    if (/\.(jpe?g|png|gif|webp|svg|avif)(\?.*)?$/i.test(str) || str.includes('/product-images/')) {
      return <img src={str} alt="" className="h-6 w-6 object-cover rounded" loading="lazy" />
    }
  }
  // text, long_text, link, etc.
  const str = String(value)
  return <span className="truncate">{str.length > 100 ? str.slice(0, 100) + '…' : str}</span>
}

// Pastilles de couleur pour l'éditeur inline de select (mêmes fonds que Badge).
const SELECT_DOT = {
  gray: 'bg-slate-300', slate: 'bg-slate-400', blue: 'bg-blue-400', indigo: 'bg-brand-400',
  green: 'bg-green-400', yellow: 'bg-yellow-400', orange: 'bg-orange-400', red: 'bg-red-400',
  purple: 'bg-purple-400', pink: 'bg-pink-400', teal: 'bg-teal-400',
}

// Éditeur inline (mode tableur) pour une cellule single_select / multi_select.
// `col.selectChoices` = [{ id, label, color }]. Single : un clic commit le label
// (ou vide). Multi : cases à cocher → commit un tableau JSON au « Terminé » ou au
// clic en dehors.
function SelectCellEditor({ col, value, onCommit, onCancel }) {
  const multi = col.type === 'multi_select'
  const choices = Array.isArray(col.selectChoices) ? col.selectChoices : []
  const initial = useMemo(() => {
    if (!multi) return value == null ? [] : [String(value)]
    if (Array.isArray(value)) return value.map(String)
    if (typeof value === 'string' && value.startsWith('[')) {
      try { const a = JSON.parse(value); return Array.isArray(a) ? a.map(String) : [] } catch { return [] }
    }
    return value ? [String(value)] : []
  }, [value, multi])
  const [sel, setSel] = useState(initial)
  const rootRef = useRef(null)

  useEffect(() => { rootRef.current?.focus() }, [])

  function commitMulti(next) { onCommit(JSON.stringify(next)) }
  function toggle(label) {
    if (multi) {
      setSel(prev => prev.includes(label) ? prev.filter(x => x !== label) : [...prev, label])
    } else {
      onCommit(sel[0] === label ? '' : label)
    }
  }

  return (
    <div
      ref={rootRef}
      tabIndex={-1}
      data-testid="datatable-select-editor"
      onMouseDown={e => e.stopPropagation()}
      onClick={e => e.stopPropagation()}
      onDoubleClick={e => e.stopPropagation()}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Escape') { e.preventDefault(); onCancel() }
        else if (e.key === 'Enter' && multi) { e.preventDefault(); commitMulti(sel) }
      }}
      onBlur={e => {
        // Commit (multi) / annule (single) quand le focus quitte le panneau.
        if (!e.currentTarget.contains(e.relatedTarget)) {
          if (multi) commitMulti(sel); else onCancel()
        }
      }}
      className="absolute z-30 left-0 top-full min-w-[180px] max-h-56 overflow-y-auto rounded-lg border border-brand-500 bg-white shadow-lg py-1"
    >
      {!multi && (
        <button
          type="button"
          onClick={() => onCommit('')}
          className="flex w-full items-center gap-2 px-3 py-1.5 text-sm text-slate-400 hover:bg-slate-50"
        >
          — Aucun —
        </button>
      )}
      {choices.length === 0 && (
        <div className="px-3 py-1.5 text-xs text-slate-400">Aucun choix configuré</div>
      )}
      {choices.map(c => {
        const active = sel.includes(c.label)
        return (
          <button
            type="button"
            key={c.id || c.label}
            data-testid={`datatable-select-opt-${c.label}`}
            onClick={() => toggle(c.label)}
            className={`flex w-full items-center gap-2 px-3 py-1.5 text-sm hover:bg-slate-50 ${active ? 'bg-brand-50' : ''}`}
          >
            <span className={`h-3 w-3 rounded-full ${SELECT_DOT[c.color] || SELECT_DOT.gray}`} />
            <span className="flex-1 text-left truncate text-slate-700">{c.label}</span>
            {active && <Check size={14} className="text-brand-600" />}
          </button>
        )
      })}
      {multi && (
        <div className="border-t border-slate-100 mt-1 pt-1 px-2">
          <button
            type="button"
            onClick={() => commitMulti(sel)}
            className="w-full text-xs text-brand-600 hover:text-brand-700 py-1"
          >
            Terminé
          </button>
        </div>
      )}
    </div>
  )
}

// Rendu d'une cellule. Priorité au render() custom de la colonne. Sinon, pour
// les colonnes dynamiques (Airtable) on délègue à DynamicCell, et pour les
// colonnes standard type:'number' on applique le formatage décimal préféré de
// l'utilisateur (`decimals`). Toute autre colonne : valeur brute.
function renderCell(col, item, decimals) {
  if (col.render) return col.render(item)
  const value = item[col.field]
  if (col.dynamic) return <DynamicCell value={value} col={col} decimals={decimals} />
  if (col.type === 'number' && decimals != null) {
    const formatted = formatDecimals(value, decimals)
    if (formatted != null) return <span className="tabular-nums">{formatted}</span>
  }
  return value ?? '—'
}

// ── Barre de totaux en pied (summary bar à la Airtable) ────────────────────
// Agrégations disponibles par colonne. `numeric` = nécessite des valeurs
// numériques (sum/avg/min/max) ; les autres (count/empty) marchent partout.
const AGG_LABELS = {
  sum: 'Somme',
  avg: 'Moyenne',
  min: 'Min',
  max: 'Max',
  count: 'Rempli',
  empty: 'Vides',
}
const NUMERIC_AGGS = ['sum', 'avg', 'min', 'max', 'count', 'empty']
const TEXT_AGGS = ['count', 'empty']

function isNumericCol(col) {
  return col?.type === 'number' || col?.type === 'currency'
}

// Agrégations proposées dans le menu pour une colonne donnée.
function aggOptionsFor(col) {
  return isNumericCol(col) ? NUMERIC_AGGS : TEXT_AGGS
}

// Calcule la valeur d'agrégation d'une colonne sur les lignes filtrées.
// Retourne { label, value, isCount } ou null si type === 'none'.
function computeAggregation(type, rows, field) {
  if (!type || type === 'none') return null
  if (type === 'count' || type === 'empty') {
    let n = 0
    for (const r of rows) {
      const v = r[field]
      const blank = v === null || v === undefined || v === ''
      if (type === 'count' ? !blank : blank) n++
    }
    return { label: AGG_LABELS[type], value: n, isCount: true }
  }
  let sum = 0, count = 0, min = Infinity, max = -Infinity
  for (const r of rows) {
    const v = parseFloat(r[field])
    if (Number.isNaN(v)) continue
    sum += v; count++
    if (v < min) min = v
    if (v > max) max = v
  }
  if (count === 0) return { label: AGG_LABELS[type], value: null, isCount: false }
  let value
  if (type === 'sum') value = sum
  else if (type === 'avg') value = sum / count
  else if (type === 'min') value = min
  else if (type === 'max') value = max
  return { label: AGG_LABELS[type], value, isCount: false }
}

// Formate une valeur d'agrégation. Les counts restent entiers ; les valeurs
// numériques suivent les décimales préférées de l'utilisateur (sinon max 2).
function formatAggValue(agg, decimals) {
  if (!agg) return ''
  if (agg.value == null) return '—'
  if (agg.isCount) return agg.value.toLocaleString('fr-CA')
  if (decimals != null) {
    const f = formatDecimals(agg.value, decimals)
    if (f != null) return f
  }
  return agg.value.toLocaleString('fr-CA', { maximumFractionDigits: 2 })
}

// Normalise groupBy en tableau de field names. Accepte legacy string / null
// / array. Filtre les valeurs vides pour éviter les niveaux fantômes.
function normalizeGroupBy(g) {
  if (g == null) return []
  if (Array.isArray(g)) return g.filter(Boolean)
  return g ? [g] : []
}

function ResizeHandle({ onResize }) {
  const startX = useRef(0)
  const startW = useRef(0)

  function onPointerDown(e) {
    e.preventDefault()
    e.stopPropagation()
    startX.current = e.clientX
    startW.current = e.currentTarget.parentElement.offsetWidth
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  function onPointerMove(e) {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    const delta = e.clientX - startX.current
    const newW = Math.max(50, startW.current + delta)
    onResize(newW)
  }

  function onPointerUp(e) {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  return (
    <div
      className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize z-10 bg-transparent group-hover/header:bg-slate-200 hover:!bg-brand-400 active:!bg-brand-500"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  )
}

// Petit « ? » survolable dans l'en-tête de colonne. Affiche la `description`
// (provenance/unité/calcul) en infobulle. Positionnée en `fixed` à partir du
// getBoundingClientRect de l'icône pour ne pas être clippée par l'en-tête
// sticky/overflow. Esprit Airtable : discret au repos, contrasté au survol.
function ColumnHelp({ description }) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null) // { x, y } ou null = caché

  function show() {
    const r = ref.current?.getBoundingClientRect()
    if (r) setPos({ x: r.left + r.width / 2, y: r.bottom + 6 })
  }
  function hide() { setPos(null) }

  return (
    <span
      ref={ref}
      // Empêche le drag de colonne / le tri quand on interagit avec l'icône.
      draggable={false}
      onDragStart={e => { e.preventDefault(); e.stopPropagation() }}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onClick={e => e.stopPropagation()}
      onContextMenu={e => e.stopPropagation()}
      tabIndex={0}
      aria-label={description}
      data-testid="datatable-col-help"
      className="inline-flex items-center align-middle text-slate-300 hover:text-brand-500 focus:text-brand-500 focus:outline-none cursor-help transition-colors"
    >
      <HelpCircle size={12} strokeWidth={2.25} />
      {pos && (
        <div
          role="tooltip"
          className="fixed z-50 max-w-xs px-2.5 py-1.5 rounded-md bg-slate-800 text-white text-[11px] font-normal normal-case tracking-normal leading-snug shadow-lg pointer-events-none"
          style={{ top: pos.y, left: pos.x, transform: 'translateX(-50%)' }}
        >
          {description}
        </div>
      )}
    </span>
  )
}

export function DataTable({
  table,
  columns,
  data,
  loading,
  onRowClick,
  searchFields = [],
  height = 'calc(100vh - 260px)',
  initialGroupBy = null,
  initialGroupOrder = null, // 'asc' | 'desc' | 'default' | array (aligné sur initialGroupBy)
  forceAllView = false,
  onBulkDelete,
  bulkActions = [],         // actions groupées custom : [{ key, label, icon, className, busyLabel, show?(rows), onClick(ids) }]
  bulkDeleteAlways = false, // affiche les cases de sélection sans dépendre du toggle admin de config
  manageViews = false,      // affiche le crayon « Gérer les vues » (admin) en bout de barre des vues
  disabledColumns = null, // Map<column_name, { airtable_field_name }> | null
  onAddCustomField,       // () => void — affiche le bouton "+" en bout de header
  customFieldsByColumn,   // Map<column_name, { id, name, type, decimals }> — pour right-click menu
  customFieldsLoaded,     // bool — les champs custom fournis ont-ils fini de charger ? (voir cfLoaded / auto-affichage). À fournir dès que customFieldsByColumn l'est.
  onEditCustomField,      // (field) => void
  onDeleteCustomField,    // (field) => void
  onFilteredDataChange,   // (rows) => void — notifie le parent à chaque update de la vue filtrée
  realtimeEntity,         // string | undefined — préfixe du canal WS (`${realtimeEntity}:list`). Active l'indicateur live « modifié par X » (halo vert + badge) quand un AUTRE utilisateur édite une ligne affichée.
  emptyState,             // { icon, title, description, cta } | undefined — état vide contextuel quand la table n'a aucun enregistrement (voir EmptyState.jsx). L'état « filtré, aucun résultat » est géré automatiquement.
  renderExpanded,         // (item) => JSX | null — si fourni, chaque ligne devient expandable : une colonne chevron est ajoutée en tête et le contenu retourné s'affiche sous la ligne dépliée (hauteur mesurée dynamiquement).
  rowKey = 'id',          // champ servant d'identifiant unique de ligne pour le suivi d'expansion (ex. 'employee_id' quand les lignes n'ont pas d'`id`).
  onToggleExpand,         // (item, willExpand) => void — notifié à chaque (dé)pliage, utile pour charger les détails à la demande.
  onCellEdit,             // (row, col, value) => void|Promise — si fourni, active le mode « tableur » : navigation cellule, sélection multi-cellules, copier/coller (Ctrl+C/V), remplissage vers le bas (Ctrl+D) et édition inline. Les colonnes éditables doivent porter `editable: true`. La navigation de ligne (`onRowClick`) passe alors au double-clic.
  peek,                   // { title, subtitle?, to?, width?, render } — si fourni, un clic sur une ligne ouvre un drawer latéral (side-peek à la Airtable) au lieu de naviguer. Chaque champ est soit une valeur, soit une fonction (item) => valeur ; `render(item, { close })` retourne le corps du drawer (typiquement une page *Detail.jsx en mode `embedded`). `to(item)` active le bouton « ouvrir en grand ». Prend le pas sur `onRowClick` pour le clic simple.
  onRowReorder,           // (orderedIds) => void — active une poignée de drag & drop en tête de chaque ligne pour réordonner manuellement (ordre custom persisté par le parent, ex. sort_order). Actif seulement quand l'ordre affiché == l'ordre réel des données : sans tri, groupage, recherche ni filtre.
  rowClassName,           // (item) => string — classes CSS additionnelles par ligne (ex. font-semibold pour un reçu non lu).
}) {
  const [visibleCols, setVisibleCols] = useState([])
  // groupBy : tableau de field names. Hérité du legacy : accepte aussi null /
  // string (single-level) et normalise vers array. Tableau vide = pas de
  // groupage. Plusieurs niveaux = groupage imbriqué.
  const [groupBy, setGroupByRaw] = useState(() => normalizeGroupBy(initialGroupBy))
  // groupOrder : tableau de ('asc' | 'desc' | 'default' | null) par niveau.
  // Aligné sur groupBy. Niveau manquant = 'default'.
  const [groupOrder, setGroupOrderRaw] = useState(() => {
    if (initialGroupOrder == null) return []
    return Array.isArray(initialGroupOrder) ? initialGroupOrder : [initialGroupOrder]
  })
  const [collapsedGroups, setCollapsedGroups] = useState(new Set())
  // Formatage conditionnel par vue : [{ id, color, filters }] — première règle
  // qui matche colore la ligne. Chargé depuis la pill active, persisté par
  // l'autosave de ViewToolbar (color_rules).
  const [colorRules, setColorRules] = useState([])
  const [colWidths, setColWidths] = useState({})
  // Barre de totaux en pied : { [colId]: 'sum'|'avg'|'count'|'empty'|'min'|'max' }
  const [footerAggs, setFooterAggs] = useState({})
  const [footerMenu, setFooterMenu] = useState(null) // { col, x, y } pour le picker d'agrégation
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [deleting, setDeleting] = useState(false)
  const [busyAction, setBusyAction] = useState(null) // key de l'action groupée custom en cours
  const [colMenu, setColMenu] = useState(null) // { x, y, source: 'native'|'airtable', field } pour right-click menu
  const [expandedKeys, setExpandedKeys] = useState(() => new Set()) // rowKey des lignes dépliées (si renderExpanded)
  const expandable = typeof renderExpanded === 'function'
  const [peekItem, setPeekItem] = useState(null) // ligne ouverte dans le side-peek (si `peek` fourni)
  const peekEnabled = peek && typeof peek.render === 'function'
  // Ouverture programmée du side-peek : `peek.openId` demande l'ouverture du
  // drawer sur la ligne correspondante dès qu'elle apparaît dans `data` (ex.:
  // bouton « revenir au panneau latéral » d'une fiche plein écran, qui navigue
  // vers la liste avec l'id en state). `peek.onOpenConsumed` est appelé une
  // fois la demande honorée pour que le parent l'efface (sinon rouvrirait).
  const peekOpenId = peekEnabled ? peek.openId : undefined
  const peekOnOpenConsumed = peekEnabled ? peek.onOpenConsumed : undefined
  useEffect(() => {
    if (peekOpenId == null) return
    const item = (data || []).find(d => String(d?.[rowKey]) === String(peekOpenId))
    if (!item) return
    setPeekItem(item)
    peekOnOpenConsumed?.()
  }, [peekOpenId, data, rowKey, peekOnOpenConsumed])
  // Résout un champ de config `peek` qui peut être une valeur littérale ou une
  // fonction (item) => valeur.
  const resolvePeek = useCallback((key, item) => {
    if (!peek || item == null) return undefined
    const v = peek[key]
    return typeof v === 'function' ? v(item) : v
  }, [peek])

  // ── Mode « tableur » : sélection de cellules, copier/coller, fill-down ────
  // Activé uniquement quand le parent fournit `onCellEdit`. Voir le bloc
  // d'opérations plus bas (géométrie de sélection, clavier, édition inline).
  const gridMode = typeof onCellEdit === 'function'
  const [sel, setSel] = useState(null) // { anchor:{rowId,colId}, focus:{rowId,colId} } | null
  const [editingCell, setEditingCell] = useState(null) // { rowId, colId } | null
  const [editValue, setEditValue] = useState('')
  const [gridSaving, setGridSaving] = useState(false)
  const internalClipRef = useRef('') // fallback presse-papier intra-app (si readText refusé)
  const keyHandlerRef = useRef(null)
  const isColEditable = useCallback((col) => gridMode && !!col?.editable, [gridMode])
  // Tracks previously seen custom-field column ids so we can auto-show newly
  // created fields in the active view (the user vient de créer le champ, on
  // suppose qu'ils veulent le voir tout de suite).
  const prevCustomFieldKeys = useRef(null)
  const confirm = useConfirm()
  const { addToast } = useToast()
  const { getDecimals } = useDecimalPrefs()

  // ── Champs custom auto-gérés ──────────────────────────────────────────────
  // Quand la table supporte les champs custom (miroir client de ALLOWED_TABLES
  // serveur) et que la page n'a pas branché son propre câblage
  // (onAddCustomField), DataTable devient autonome : bouton « + » en bout
  // d'en-tête, CustomFieldModal interne, colonnes custom fusionnées et menu
  // contextuel Modifier / Supprimer. Les pages déjà câblées (Factures,
  // Pipeline) gardent leur comportement — leurs props ont priorité.
  const selfManagedCF = !onAddCustomField && CUSTOM_FIELD_TABLES.has(table)
  const { fields: ownCustomFields, loaded: ownCfLoaded, reload: reloadOwnCustomFields } = useCustomFields(selfManagedCF ? table : null)
  const [ownCfModal, setOwnCfModal] = useState(null) // { editing: field|null }
  const columnsWithOwnCf = useMemo(() => {
    if (!selfManagedCF || ownCustomFields.length === 0) return columns
    // Une colonne fournie par la page (via `columns`) portant le même id/field
    // qu'un champ custom auto-géré REMPLACE ce dernier : la page peut ainsi
    // donner un render sur-mesure à un champ custom (ex. le champ Airtable
    // « # de série » d'order_items, rendu en liens vers les fiches série plutôt
    // qu'en recordID bruts). Sans cet override, on aurait une colonne dupliquée.
    const pageColIds = new Set(columns.map(c => c.id ?? c.field))
    // editable: false — l'édition inline exige un onCellEdit page + une route
    // PATCH qui whiteliste les colonnes cf_ (branché seulement sur projects).
    const autoCfCols = ownCustomFields
      .filter(f => !pageColIds.has(f.column_name))
      .map(f => ({ ...customFieldToColumn(f), editable: false }))
    return [...columns, ...autoCfCols]
  }, [selfManagedCF, columns, ownCustomFields])
  const ownCfByColumn = useMemo(() => {
    if (!selfManagedCF) return null
    const m = new Map()
    for (const f of ownCustomFields) m.set(f.column_name, f)
    return m
  }, [selfManagedCF, ownCustomFields])
  // Versions effectives (prop page > interne auto-géré) utilisées partout plus bas.
  const cfByColumn = customFieldsByColumn || ownCfByColumn
  // Les champs custom ont-ils fini de charger ? Load-bearing pour l'auto-affichage
  // ci-dessous : quand la page fournit customFieldsByColumn (Map dérivée d'un
  // useCustomFields asynchrone), elle doit AUSSI fournir customFieldsLoaded, sinon
  // la Map vide initiale serait prise pour la baseline et ré-afficherait tous les
  // champs masqués au (re)chargement. Chemin auto-géré : on connaît le flag en interne.
  const cfLoaded = customFieldsByColumn
    ? customFieldsLoaded === true
    : (selfManagedCF ? ownCfLoaded : true)
  // useMemo : identité stable exigée par le memo de gridTemplate plus bas.
  const addCustomField = useMemo(
    () => onAddCustomField || (selfManagedCF ? () => setOwnCfModal({ editing: null }) : null),
    [onAddCustomField, selfManagedCF]
  )
  const editCustomField = onEditCustomField || (selfManagedCF ? (f) => setOwnCfModal({ editing: f }) : null)
  const deleteCustomField = onDeleteCustomField || (!selfManagedCF ? null : async (field) => {
    // Rapport d'usage : liste les dépendances (champs calculés, automations,
    // vues, règles de visibilité) que la suppression va affecter, avant de les
    // casser en silence (#ERROR). Même logique que Factures/Pipeline.
    let dependents = []
    try { dependents = (await api.customFields.dependents(field.id))?.dependents || [] } catch {}
    const depMsg = summarizeDependents(dependents)
    if (!(await confirm({
      title: 'Supprimer le champ',
      message: `Supprimer le champ "${field.name}" ? Restaurable depuis la corbeille.${depMsg}`,
      confirmLabel: dependents.length ? 'Supprimer quand même' : 'Supprimer',
    }))) return
    try {
      await api.customFields.delete(field.id)
      addToast({ message: 'Champ supprimé', type: 'success' })
      await reloadOwnCustomFields()
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    }
  })

  // ── Overrides de champs natifs (renommage / changement de type) ──────────
  // Les colonnes définies en dur dans tableDefs.js deviennent éditables via le
  // menu contextuel d'en-tête (« Modifier le champ ») → CustomFieldModal (mode natif).
  // L'override (persisté serveur, table field_overrides) remplace le label
  // et/ou le type d'affichage/tri/filtre — les colonnes SQL et syncs ne
  // bougent pas. Appliqué AVANT useTableView pour que les panneaux Champs /
  // Filtres / Grouper voient les libellés et types overridés.
  const { overrides: fieldOverrides, reload: reloadFieldOverrides } = useFieldOverrides(table)
  const [fieldOverrideModal, setFieldOverrideModal] = useState(null) // { col } | null — col = définition d'origine
  const columnsWithOverrides = useMemo(
    () => applyFieldOverrides(columnsWithOwnCf, fieldOverrides),
    [columnsWithOwnCf, fieldOverrides]
  )

  const view = useTableView({ table, columns: columnsWithOverrides, data, searchFields, forceAllView })
  const { filteredData, configReady, allColumns, bulkDeleteEnabled, search, setSearch, filters, setFilters } = view

  useEffect(() => {
    if (typeof onFilteredDataChange === 'function') onFilteredDataChange(filteredData)
  }, [filteredData, onFilteredDataChange])
  const hasBulkActions = Array.isArray(bulkActions) && bulkActions.length > 0
  const selectionActive = (bulkDeleteEnabled || bulkDeleteAlways) && (typeof onBulkDelete === 'function' || hasBulkActions)
  // Use allColumns (hardcoded + dynamic Airtable fields) everywhere
  const mergedColumns = allColumns || columnsWithOverrides
  // Helper passé aux consumers pour savoir si une colonne est désactivée
  // (import Airtable coupé via la modale de sync). Comparaison sur field OU id.
  const isDisabled = useCallback((c) => {
    if (!disabledColumns || disabledColumns.size === 0 || !c) return false
    return disabledColumns.has(c.field) || disabledColumns.has(c.id)
  }, [disabledColumns])

  const parentRef = useRef(null)
  const saveWidthsTimer = useRef(null)
  const saveFooterTimer = useRef(null)

  // ── Indicateur live « modifié par un autre utilisateur » ────────────────
  // Quand `realtimeEntity` est fourni, on s'abonne au canal `${entity}:list`.
  // À chaque event `updated` venant d'un AUTRE utilisateur, on diffe le payload
  // contre la ligne actuellement affichée pour repérer les champs changés, on
  // résout l'auteur (actorUserId → users), et on déclenche un halo vert + un
  // badge éditeur sur la ligne, qui s'estompe après FLASH_MS.
  // flashes : Map<rowId, { fields:Set<field>, values:Record<field,val>, actorName, ts }>
  const [flashes, setFlashes] = useState(() => new Map())
  const rowsByIdRef = useRef(new Map())
  const flashTimers = useRef(new Map())
  const currentUserId = useMemo(() => getUser()?.id ?? null, [])

  // Garde une vue id→ligne du `data` courant, lue dans le handler WS (qui n'est
  // pas dans le render path) pour differ le payload contre l'état affiché.
  useEffect(() => {
    const m = new Map()
    for (const r of (data || [])) if (r && r.id != null) m.set(r.id, r)
    rowsByIdRef.current = m
  }, [data])

  useEffect(() => () => {
    for (const t of flashTimers.current.values()) clearTimeout(t)
    flashTimers.current.clear()
  }, [])

  useRealtimeChannel(realtimeEntity ? `${realtimeEntity}:list` : null, (msg) => {
    const verb = msg.type?.split(':').slice(1).join(':')
    if (verb !== 'updated') return
    // Seules les modifs d'AUTRES utilisateurs sont signalées.
    if (msg.actorUserId && currentUserId && String(msg.actorUserId) === String(currentUserId)) return
    const payload = msg.payload
    if (!payload || payload.id == null) return
    const prevRow = rowsByIdRef.current.get(payload.id)
    if (!prevRow) return // ligne pas dans cette vue → rien à surligner
    const changed = diffFields(prevRow, payload)
    if (changed.length === 0) return

    const values = {}
    for (const f of changed) values[f] = payload[f]
    const actorName = (msg.actorUserId && getRecord('users', msg.actorUserId)?.name) || 'Quelqu’un'
    const ts = msg.ts || Date.now()

    setFlashes(prev => {
      const next = new Map(prev)
      next.set(payload.id, { fields: new Set(changed), values, actorName, ts })
      return next
    })

    const existing = flashTimers.current.get(payload.id)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      flashTimers.current.delete(payload.id)
      setFlashes(prev => {
        const cur = prev.get(payload.id)
        if (!cur || cur.ts !== ts) return prev // un flash plus récent a pris la place
        const next = new Map(prev)
        next.delete(payload.id)
        return next
      })
    }, FLASH_MS)
    flashTimers.current.set(payload.id, timer)
  })

  // Charge les largeurs persistées. Désormais par vue : on ré-applique à chaque
  // changement de vue active (et plus seulement à l'init) pour que chaque vue
  // garde sa propre mise en page. Reset à {} quand la vue n'a pas de largeurs
  // (view.columnWidths inclut déjà le fallback legacy table-level).
  useEffect(() => {
    if (!view.configReady) return
    setColWidths(view.columnWidths || {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.configReady, view.activeViewId])

  function handleColResize(colId, width) {
    setColWidths(prev => {
      const next = { ...prev, [colId]: width }
      clearTimeout(saveWidthsTimer.current)
      // Persiste sur la vue active (pill) ; fallback table-level uniquement quand
      // aucune vue n'est sélectionnée (vue « Tous »/forceAllView).
      const viewId = view.activeViewId
      saveWidthsTimer.current = setTimeout(() => {
        if (viewId) {
          api.views.savePillColumnWidths(table, viewId, next).catch(() => {})
          view.patchLocalView?.(viewId, { column_widths: next })
        } else {
          api.views.saveColumnWidths(table, next).catch(() => {})
        }
      }, 500)
      return next
    })
  }

  // Charge la config de la barre de totaux persistée (par table).
  useEffect(() => {
    if (!view.configReady) return
    if (view.footerAggregations && Object.keys(view.footerAggregations).length > 0) {
      setFooterAggs(view.footerAggregations)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.configReady])

  // Définit (ou retire avec type 'none') l'agrégation d'une colonne et persiste.
  function setColAggregation(colId, type) {
    setFooterAggs(prev => {
      const next = { ...prev }
      if (!type || type === 'none') delete next[colId]
      else next[colId] = type
      clearTimeout(saveFooterTimer.current)
      saveFooterTimer.current = setTimeout(() => {
        api.views.saveFooterAggregations(table, next).catch(() => {})
      }, 400)
      return next
    })
  }

  // Wrappers : autorisent l'appelant à passer string|array|null (ergonomie
  // legacy), normalisent vers array en interne.
  const setGroupBy = useCallback(v => setGroupByRaw(normalizeGroupBy(v)), [])
  const setGroupOrder = useCallback(v => {
    if (v == null) setGroupOrderRaw([])
    else if (Array.isArray(v)) setGroupOrderRaw(v)
    else setGroupOrderRaw([v])
  }, [])

  // Colonnes `alwaysVisible: true` (colonnes d'ACTION, pas de données) : elles
  // sont réinjectées dans toute liste de colonnes restaurée. Sans ça, une liste
  // mémorisée AVANT l'ajout de la colonne (localStorage `erp_allView_cols_*`,
  // pill, ou config admin) la masque définitivement pour cet utilisateur —
  // le bouton n'apparaît jamais alors qu'il est bien dans le code.
  const withAlwaysVisible = useCallback(cols => {
    const forced = mergedColumns.filter(c => c.alwaysVisible).map(c => c.id)
    if (!forced.length) return cols
    const missing = forced.filter(id => !cols.includes(id))
    if (!missing.length) return cols
    // Insérée juste après sa voisine de gauche déclarée dans le meta, pour ne
    // pas casser l'ordre de colonnes que l'utilisateur a pu réorganiser.
    const order = mergedColumns.map(c => c.id)
    const next = [...cols]
    for (const id of missing) {
      const metaIdx = order.indexOf(id)
      let at = 0
      for (let i = metaIdx - 1; i >= 0; i--) {
        const pos = next.indexOf(order[i])
        if (pos !== -1) { at = pos + 1; break }
      }
      next.splice(at, 0, id)
    }
    return next
  }, [mergedColumns])

  // Apply view config when active view changes
  useEffect(() => {
    if (!view.configReady) return
    setVisibleCols(withAlwaysVisible(view.viewVisibleColumns))
    const rules = view.activeView?.color_rules
    setColorRules(Array.isArray(rules) ? rules : [])
    if (!forceAllView) {
      const newGroupBy = normalizeGroupBy(view.viewGroupBy)
      setGroupByRaw(newGroupBy)
      const o = view.viewGroupOrder
      setGroupOrderRaw(o == null ? [] : Array.isArray(o) ? o : [o])
      // Sync prevGroupByRef avec la nouvelle signature pour éviter que le
      // useEffect [groupBySig] détecte un changement et reset les groupes
      // collapsés qu'on est en train de restaurer depuis le serveur.
      prevGroupByRef.current = newGroupBy.join('|')
      // Restore collapsed groups : priorité au state sauvé sur la pill (sync
      // cross-device), fallback localStorage pour le legacy. Quand aucun des
      // deux n'est dispo on part déplié.
      let initial = null
      const persisted = view.activeView?.collapsed_groups
      if (Array.isArray(persisted)) {
        initial = persisted
      } else {
        try {
          const key = `erp_collapsed_${table}_${view.activeViewId || '__all__'}`
          initial = JSON.parse(localStorage.getItem(key) || '[]')
        } catch { initial = [] }
      }
      setCollapsedGroups(new Set(initial || []))
    } else {
      // forceAllView : pas de pill server-side, localStorage uniquement.
      try {
        const key = `erp_collapsed_${table}_forceAll`
        const stored = JSON.parse(localStorage.getItem(key) || '[]')
        setCollapsedGroups(new Set(stored))
      } catch { setCollapsedGroups(new Set()) }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.activeViewId, view.configReady])

  // Auto-show newly created custom fields in the active view : on diffe les
  // clés de customFieldsByColumn entre renders ; toute nouvelle clé est
  // ajoutée à visibleCols (l'autosave de ViewToolbar persiste). Skippé au
  // premier render pour ne pas clobber la liste initiale chargée du serveur.
  //
  // Garde `cfLoaded` : tant que les champs custom ne sont pas chargés, cfByColumn
  // est une Map vide TRANSITOIRE. Sans cette garde, cette Map vide était capturée
  // comme baseline puis, à l'arrivée des champs, TOUTES les clés paraissaient
  // « nouvelles » et étaient ré-ajoutées à visibleCols — écrasant silencieusement
  // les colonnes que l'utilisateur venait de masquer (bug : masquage non persistant
  // au rechargement). En attendant le chargement, la baseline est établie à partir
  // de l'ensemble RÉEL des champs, donc seule une création ultérieure déclenche l'ajout.
  useEffect(() => {
    if (!view.configReady) return
    if (!cfByColumn) return
    if (!cfLoaded) return
    const currentKeys = new Set(cfByColumn.keys())
    const prev = prevCustomFieldKeys.current
    if (prev) {
      const newOnes = [...currentKeys].filter(k => !prev.has(k))
      if (newOnes.length > 0) {
        setVisibleCols(cols => {
          const set = new Set(cols)
          for (const k of newOnes) set.add(k)
          return [...set]
        })
      }
    }
    prevCustomFieldKeys.current = currentKeys
  }, [cfByColumn, cfLoaded, view.configReady])

  const visibleColumns = useMemo(
    () => visibleCols
      .map(id => mergedColumns.find(c => c.id === id))
      .filter(Boolean)
      .filter(c => !isDisabled(c)), // colonnes dont l'import Airtable est désactivé : on les retire du rendu
    [mergedColumns, visibleCols, isDisabled]
  )

  const [dragOverCol, setDragOverCol] = useState(null)
  const [dragOverSide, setDragOverSide] = useState(null) // 'before' | 'after'
  const dragColRef = useRef(null)

  function handleColDragStart(e, colId) {
    dragColRef.current = colId
    e.dataTransfer.effectAllowed = 'move'
    try { e.dataTransfer.setData('text/plain', colId) } catch {}
  }
  function handleColDragOver(e, colId) {
    if (!dragColRef.current) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const rect = e.currentTarget.getBoundingClientRect()
    const side = (e.clientX - rect.left) < rect.width / 2 ? 'before' : 'after'
    if (dragOverCol !== colId) setDragOverCol(colId)
    if (dragOverSide !== side) setDragOverSide(side)
  }
  function handleColDrop(e) {
    e.preventDefault()
    const sourceId = dragColRef.current
    const targetId = dragOverCol
    const side = dragOverSide
    dragColRef.current = null
    setDragOverCol(null)
    setDragOverSide(null)
    if (!sourceId || !targetId || sourceId === targetId) return
    const next = visibleCols.filter(id => id !== sourceId)
    let idx = next.indexOf(targetId)
    if (idx === -1) return
    if (side === 'after') idx += 1
    next.splice(idx, 0, sourceId)
    setVisibleCols(next)
  }
  function handleColDragEnd() {
    dragColRef.current = null
    setDragOverCol(null)
    setDragOverSide(null)
  }

  // ── Réordonnancement manuel de lignes (drag & drop, opt-in) ───────────────
  // Actif seulement quand l'ordre affiché correspond à l'ordre réel des données
  // (aucun tri, groupage, recherche ni filtre) — sinon la position cible serait
  // ambiguë pour les lignes masquées/re-triées.
  const reorderFiltersActive = Array.isArray(filters) ? filters.length > 0 : !!(filters?.rules?.length)
  const reorderActive = typeof onRowReorder === 'function' && groupBy.length === 0
    && (view.sorts?.length || 0) === 0 && !search && !reorderFiltersActive
  const [dragRowId, setDragRowId] = useState(null)
  const [dragOverRowId, setDragOverRowId] = useState(null)
  function handleRowDrop(targetId) {
    const src = dragRowId
    setDragRowId(null); setDragOverRowId(null)
    if (!src || src === targetId) return
    const ids = filteredData.map(r => r.id)
    const from = ids.indexOf(src), to = ids.indexOf(targetId)
    if (from === -1 || to === -1) return
    ids.splice(from, 1); ids.splice(to, 0, src)
    onRowReorder(ids)
  }

  const gridTemplate = useMemo(() => {
    const cols = visibleColumns.map(c => colWidths[c.id] ? `${colWidths[c.id]}px` : 'minmax(120px, 1fr)').join(' ')
    // Si on a un bouton d'ajout de champ, on réserve une colonne `auto` à la
    // fin pour le "+" — les rows de données auront simplement une cellule vide.
    const withAdd = addCustomField ? `${cols} 36px` : cols
    // Colonne chevron d'expansion en tête (après la case de sélection si présente).
    const withExpand = expandable ? `34px ${withAdd}` : withAdd
    const withSelect = selectionActive ? `40px ${withExpand}` : withExpand
    // Poignée de réordonnancement tout à gauche.
    return reorderActive ? `28px ${withSelect}` : withSelect
  }, [visibleColumns, colWidths, selectionActive, addCustomField, expandable, reorderActive])

  // Reset selection when data changes (e.g., after delete, filter)
  const visibleIds = useMemo(() => filteredData.map(r => r.id).filter(Boolean), [filteredData])
  const allVisibleSelected = selectionActive && visibleIds.length > 0 && visibleIds.every(id => selectedIds.has(id))
  const someVisibleSelected = selectionActive && !allVisibleSelected && visibleIds.some(id => selectedIds.has(id))

  useEffect(() => {
    // Purge stale IDs when data shrinks (after delete or filter)
    if (!selectionActive) return
    setSelectedIds(prev => {
      if (prev.size === 0) return prev
      const dataIds = new Set(data.map(r => r.id))
      const next = new Set([...prev].filter(id => dataIds.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [data, selectionActive])

  function toggleRow(id) {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const toggleExpand = useCallback((item) => {
    const k = item?.[rowKey]
    if (k == null) return
    const willExpand = !expandedKeys.has(k)
    setExpandedKeys(prev => {
      const next = new Set(prev)
      next.has(k) ? next.delete(k) : next.add(k)
      return next
    })
    onToggleExpand?.(item, willExpand)
  }, [rowKey, expandedKeys, onToggleExpand])

  function toggleAllVisible() {
    setSelectedIds(prev => {
      if (allVisibleSelected) {
        const next = new Set(prev)
        for (const id of visibleIds) next.delete(id)
        return next
      }
      const next = new Set(prev)
      for (const id of visibleIds) next.add(id)
      return next
    })
  }

  async function handleBulkDelete() {
    const ids = [...selectedIds]
    if (!ids.length) return
    if (!(await confirm(`Supprimer ${ids.length} enregistrement${ids.length > 1 ? 's' : ''} ? Cette action est irréversible.`))) return
    setDeleting(true)
    try {
      await onBulkDelete(ids)
      setSelectedIds(new Set())
    } catch (err) {
      addToast({ message: 'Erreur lors de la suppression : ' + (err?.message || 'inconnue'), type: 'error' })
    } finally {
      setDeleting(false)
    }
  }

  async function runBulkAction(action) {
    const ids = [...selectedIds]
    if (!ids.length) return
    setBusyAction(action.key)
    try {
      await action.onClick(ids)
      setSelectedIds(new Set())
    } catch (err) {
      addToast({ message: 'Erreur : ' + (err?.message || 'inconnue'), type: 'error' })
    } finally {
      setBusyAction(null)
    }
  }

  // Lignes actuellement sélectionnées (objets data) — sert aux prédicats show() des actions custom.
  const selectedRows = useMemo(
    () => (hasBulkActions ? data.filter(r => selectedIds.has(r.id)) : []),
    [data, selectedIds, hasBulkActions]
  )
  const visibleBulkActions = useMemo(
    () => bulkActions.filter(a => typeof a.show !== 'function' || a.show(selectedRows)),
    [bulkActions, selectedRows]
  )

  // Clé localStorage : conserve la persistence locale comme fallback (utile
  // pour forceAllView, ou comme cache rapide avant la réponse serveur).
  const collapsedStorageKey = forceAllView
    ? `erp_collapsed_${table}_forceAll`
    : `erp_collapsed_${table}_${view.activeViewId || '__all__'}`
  const storageKeyRef = useRef(collapsedStorageKey)
  storageKeyRef.current = collapsedStorageKey

  // Debounce le save serveur des collapsed_groups : l'utilisateur peut
  // cliquer rapidement plusieurs groupes d'affilée, on bundle les writes.
  const saveCollapsedTimer = useRef(null)
  const activeViewIdRef = useRef(view.activeViewId)
  activeViewIdRef.current = view.activeViewId

  function saveCollapsed(set) {
    try { localStorage.setItem(storageKeyRef.current, JSON.stringify([...set])) } catch {}
    // Persiste côté serveur si une pill est active (sinon : pas de pill =
    // pas de stockage server, fallback localStorage seulement).
    if (!forceAllView && activeViewIdRef.current) {
      clearTimeout(saveCollapsedTimer.current)
      const viewId = activeViewIdRef.current
      const arr = [...set]
      saveCollapsedTimer.current = setTimeout(() => {
        api.views.updatePill(table, viewId, { collapsed_groups: arr }).catch(() => {})
      }, 400)
    }
  }

  const toggleGroup = useCallback(key => {
    setCollapsedGroups(prev => {
      const next = new Set(prev)
      next.has(key) ? next.delete(key) : next.add(key)
      saveCollapsed(next)
      return next
    })
  }, [])

  // groupBy changeant (identité du tableau OU son contenu) → on reset les
  // groupes collapsés pour repartir d'un état déplié propre.
  const groupBySig = groupBy.join('|')
  const prevGroupByRef = useRef(groupBySig)
  useEffect(() => {
    if (prevGroupByRef.current !== groupBySig) {
      setCollapsedGroups(new Set())
      prevGroupByRef.current = groupBySig
    }
  }, [groupBySig])

  const numberColumns = useMemo(
    () => mergedColumns.filter(c => c.type === 'number' || c.type === 'currency'),
    [mergedColumns]
  )

  // Valeurs de la barre de totaux : agrégation calculée sur les lignes filtrées
  // (le total « courant » reflète la recherche + les filtres actifs).
  const hasFooter = useMemo(
    () => visibleColumns.some(c => footerAggs[c.id]),
    [visibleColumns, footerAggs]
  )
  const footerValues = useMemo(() => {
    const m = new Map()
    if (!hasFooter) return m
    for (const col of visibleColumns) {
      const type = footerAggs[col.id]
      if (!type) continue
      m.set(col.id, computeAggregation(type, filteredData, col.field))
    }
    return m
  }, [hasFooter, visibleColumns, footerAggs, filteredData])

  // Formatage conditionnel : résout la couleur de chaque ligne visible. Les
  // règles sont évaluées dans l'ordre — la première qui matche gagne (sémantique
  // Airtable). Réutilise le moteur de filtres des vues (applyFilterGroup), donc
  // mêmes opérateurs, y compris is_me/is_not_me via le contexte utilisateur.
  const currentUserName = useMemo(() => getUser()?.name || null, [])
  const rowColorById = useMemo(() => {
    const m = new Map()
    if (!Array.isArray(colorRules) || colorRules.length === 0) return m
    const active = colorRules.filter(r => r && ROW_COLOR_STYLES[r.color] && countFilterRules(r.filters) > 0)
    if (active.length === 0) return m
    const ctx = { userName: currentUserName }
    for (const row of filteredData) {
      if (row?.id == null) continue
      for (const rule of active) {
        const f = rule.filters
        const match = Array.isArray(f)
          ? f.every(x => applyFilter(row, x, ctx))
          : applyFilterGroup(row, f, ctx)
        if (match) { m.set(row.id, rule.color); break }
      }
    }
    return m
  }, [filteredData, colorRules, currentUserName])

  const virtualItems = useMemo(() => {
    if (!groupBy.length) return filteredData

    const cmpAlpha = (a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base', numeric: true })

    // Construction récursive : pour chaque niveau, on regroupe les rows par
    // la valeur du champ courant, on ordonne les clés, on émet le header
    // puis (si déplié) les enfants — soit le niveau suivant, soit les rows.
    // pathKey = clés du niveau 0 jusqu'à ce niveau, jointes par '||' ; sert
    // d'identifiant unique pour le set `collapsedGroups`.
    function buildLevel(rows, levelIdx, parentPath) {
      if (levelIdx >= groupBy.length) return rows
      const field = groupBy[levelIdx]
      const order = groupOrder[levelIdx] || null

      const groups = new Map()
      for (const row of rows) {
        const k = String(row[field] ?? '(vide)')
        if (!groups.has(k)) groups.set(k, [])
        groups.get(k).push(row)
      }

      const groupCol = mergedColumns.find(c => c.field === field)
      const hasOptions = Array.isArray(groupCol?.options) && groupCol.options.length > 0
      let keys = [...groups.keys()]
      if (order === 'asc') {
        keys.sort(cmpAlpha)
      } else if (order === 'desc') {
        keys.sort(cmpAlpha).reverse()
      } else if (hasOptions) {
        const orderIdx = new Map(groupCol.options.map((o, i) => [String(o), i]))
        keys.sort((a, b) => {
          const ia = orderIdx.has(a) ? orderIdx.get(a) : Number.MAX_SAFE_INTEGER
          const ib = orderIdx.has(b) ? orderIdx.get(b) : Number.MAX_SAFE_INTEGER
          if (ia !== ib) return ia - ib
          return cmpAlpha(a, b)
        })
      } else {
        keys.sort(cmpAlpha)
      }

      const flat = []
      for (const key of keys) {
        const groupRows = groups.get(key)
        const path = parentPath ? `${parentPath}||${key}` : key
        const collapsed = collapsedGroups.has(path)

        const sums = {}
        if (numberColumns.length > 0) {
          for (const col of numberColumns) {
            let total = 0
            for (const row of groupRows) {
              const v = parseFloat(row[col.field])
              if (!isNaN(v)) total += v
            }
            if (total !== 0) sums[col.field] = total
          }
        }

        flat.push({
          __isGroup: true,
          __key: key,
          __pathKey: path,
          __level: levelIdx,
          __count: groupRows.length,
          __collapsed: collapsed,
          __sums: sums,
        })
        if (!collapsed) {
          flat.push(...buildLevel(groupRows, levelIdx + 1, path))
        }
      }
      return flat
    }

    return buildLevel(filteredData, 0, null)
  }, [filteredData, groupBy, groupOrder, collapsedGroups, numberColumns, mergedColumns])

  // Insère, après chaque ligne dépliée, un pseudo-item d'expansion dont la
  // hauteur est mesurée dynamiquement par le virtualizer (renderExpanded).
  const displayItems = useMemo(() => {
    if (!expandable || expandedKeys.size === 0) return virtualItems
    const out = []
    for (const it of virtualItems) {
      out.push(it)
      if (!it.__isGroup) {
        const k = it[rowKey]
        if (k != null && expandedKeys.has(k)) {
          out.push({ __isExpansion: true, __expandKey: k, __row: it })
        }
      }
    }
    return out
  }, [virtualItems, expandedKeys, expandable, rowKey])

  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: displayItems.length,
    getScrollElement: () => parentRef.current,
    estimateSize: i => displayItems[i]?.__isExpansion ? 220 : displayItems[i]?.__isGroup ? 26 : 32,
    overscan: 12,
  })

  // ── Mode tableur — géométrie & opérations ────────────────────────────────
  // Les lignes de données (hors groupes/expansions) en ordre d'affichage, plus
  // les index id→position pour résoudre la sélection (stockée par id, robuste
  // aux re-tris/realtime). displayIndexById sert au scroll-into-view.
  const { gridRows, rowIndexById, displayIndexById } = useMemo(() => {
    const rows = [], rIdx = new Map(), dIdx = new Map()
    if (gridMode) {
      displayItems.forEach((it, i) => {
        if (it && !it.__isGroup && !it.__isExpansion && it.id != null) {
          rIdx.set(it.id, rows.length)
          dIdx.set(it.id, i)
          rows.push(it)
        }
      })
    }
    return { gridRows: rows, rowIndexById: rIdx, displayIndexById: dIdx }
  }, [displayItems, gridMode])

  const colIndexById = useMemo(() => {
    const m = new Map()
    visibleColumns.forEach((c, i) => m.set(c.id, i))
    return m
  }, [visibleColumns])

  // Rectangle de sélection courant en indices { minR, maxR, minC, maxC } | null.
  const selBounds = useCallback(() => {
    if (!sel) return null
    const aR = rowIndexById.get(sel.anchor.rowId), aC = colIndexById.get(sel.anchor.colId)
    const fR = rowIndexById.get(sel.focus.rowId), fC = colIndexById.get(sel.focus.colId)
    if (aR == null || aC == null || fR == null || fC == null) return null
    return { minR: Math.min(aR, fR), maxR: Math.max(aR, fR), minC: Math.min(aC, fC), maxC: Math.max(aC, fC) }
  }, [sel, rowIndexById, colIndexById])
  const gridBounds = useMemo(() => (gridMode ? selBounds() : null), [gridMode, selBounds])

  const cellAt = useCallback((r, c) => {
    const row = gridRows[r], col = visibleColumns[c]
    if (!row || !col) return null
    return { rowId: row.id, colId: col.id }
  }, [gridRows, visibleColumns])

  const focusGrid = useCallback(() => { try { parentRef.current?.focus({ preventScroll: true }) } catch {} }, [])

  const moveCursor = useCallback((r, c, extend) => {
    const rr = Math.max(0, Math.min(gridRows.length - 1, r))
    const cc = Math.max(0, Math.min(visibleColumns.length - 1, c))
    const cell = cellAt(rr, cc)
    if (!cell) return
    if (extend) setSel(s => ({ anchor: s?.anchor || cell, focus: cell }))
    else setSel({ anchor: cell, focus: cell })
    const di = displayIndexById.get(cell.rowId)
    if (di != null) { try { virtualizer.scrollToIndex(di, { align: 'auto' }) } catch {} }
  }, [gridRows, visibleColumns, cellAt, displayIndexById, virtualizer])

  // Applique une liste de { row, col, value } via onCellEdit (un appel par
  // cellule). Les valeurs `undefined` (collage invalide) sont écartées.
  const applyCellChanges = useCallback(async (changes) => {
    const valid = changes.filter(c => c && c.value !== undefined)
    if (!valid.length) return
    setGridSaving(true)
    try { await Promise.all(valid.map(c => Promise.resolve(onCellEdit(c.row, c.col, c.value)))) }
    catch { /* le parent gère ses propres toasts d'erreur */ }
    finally { setGridSaving(false) }
  }, [onCellEdit])

  const startEdit = useCallback((rowId, colId, seed) => {
    const col = visibleColumns[colIndexById.get(colId)]
    const row = gridRows[rowIndexById.get(rowId)]
    if (!row || !isColEditable(col)) return
    const raw = row[col.field]
    // Checkbox : pas de mode édition texte — un double-clic / Enter / frappe
    // bascule directement la valeur (0 ⇄ 1) et persiste.
    if (col.type === 'boolean') {
      setSel({ anchor: { rowId, colId }, focus: { rowId, colId } })
      const truthy = raw === 1 || raw === true || raw === '1' || raw === '1.0' || Number(raw) === 1
      applyCellChanges([{ row, col, value: truthy ? 0 : 1 }])
      focusGrid()
      return
    }
    setSel({ anchor: { rowId, colId }, focus: { rowId, colId } })
    setEditingCell({ rowId, colId })
    // Durée : on amorce l'édition avec la valeur formatée (h:mm ou h:mm:ss selon
    // la précision) plutôt que les secondes brutes — sans perte de précision.
    let initial = raw == null ? '' : String(raw)
    if (col.type === 'duration' && raw != null && raw !== '' && Number.isFinite(Number(raw))) {
      const n = Number(raw)
      initial = formatDurationSeconds(n, n % 60 === 0 ? 'h:mm' : 'h:mm:ss')
    }
    setEditValue(seed != null ? seed : initial)
  }, [visibleColumns, gridRows, colIndexById, rowIndexById, isColEditable, applyCellChanges, focusGrid])

  const cancelEdit = useCallback(() => { setEditingCell(null); focusGrid() }, [focusGrid])

  const commitEdit = useCallback((move) => {
    const ec = editingCell
    if (ec) {
      const col = visibleColumns[colIndexById.get(ec.colId)]
      const row = gridRows[rowIndexById.get(ec.rowId)]
      if (col && row) {
        const value = coerceCellValue(col, editValue)
        if (value !== undefined) {
          const cur = row[col.field]
          const curNorm = cur == null ? null : (col.type === 'number' || col.type === 'currency' || col.type === 'duration' ? Number(cur) : String(cur))
          if (value !== curNorm) applyCellChanges([{ row, col, value }])
        }
        if (move) {
          const r = rowIndexById.get(ec.rowId), c = colIndexById.get(ec.colId)
          if (move === 'down') moveCursor(r + 1, c, false)
          else if (move === 'right') moveCursor(r, c + 1, false)
          else if (move === 'left') moveCursor(r, c - 1, false)
        }
      }
    }
    setEditingCell(null)
    focusGrid()
  }, [editingCell, visibleColumns, gridRows, colIndexById, rowIndexById, editValue, applyCellChanges, moveCursor, focusGrid])

  const copyCells = useCallback((b) => {
    const lines = []
    for (let r = b.minR; r <= b.maxR; r++) {
      const parts = []
      for (let c = b.minC; c <= b.maxC; c++) {
        const v = gridRows[r]?.[visibleColumns[c]?.field]
        parts.push(v == null ? '' : String(v))
      }
      lines.push(parts.join('\t'))
    }
    const text = lines.join('\n')
    internalClipRef.current = text
    try { navigator.clipboard?.writeText(text) } catch {}
    const n = (b.maxR - b.minR + 1) * (b.maxC - b.minC + 1)
    addToast({ message: `${n} cellule${n > 1 ? 's' : ''} copiée${n > 1 ? 's' : ''}`, type: 'success' })
  }, [gridRows, visibleColumns, addToast])

  const fillDown = useCallback((b) => {
    if (b.maxR <= b.minR) return
    const changes = []
    for (let c = b.minC; c <= b.maxC; c++) {
      const col = visibleColumns[c]
      if (!isColEditable(col)) continue
      const src = gridRows[b.minR]?.[col.field]
      const value = coerceCellValue(col, src == null ? '' : String(src))
      if (value === undefined) continue
      for (let r = b.minR + 1; r <= b.maxR; r++) changes.push({ row: gridRows[r], col, value })
    }
    applyCellChanges(changes)
  }, [gridRows, visibleColumns, isColEditable, applyCellChanges])

  const pasteCells = useCallback(async (b) => {
    let text = internalClipRef.current || ''
    try { const t = await navigator.clipboard.readText(); if (t) text = t } catch {}
    if (!text) return
    const grid = parseClipboard(text)
    if (!grid.length) return
    const changes = []
    const single = grid.length === 1 && grid[0].length === 1
    if (single && (b.maxR > b.minR || b.maxC > b.minC)) {
      // Une seule valeur collée sur une plage → on remplit toute la plage.
      for (let r = b.minR; r <= b.maxR; r++) for (let c = b.minC; c <= b.maxC; c++) {
        const col = visibleColumns[c]; if (!isColEditable(col)) continue
        const value = coerceCellValue(col, grid[0][0]); if (value === undefined) continue
        changes.push({ row: gridRows[r], col, value })
      }
    } else {
      for (let i = 0; i < grid.length; i++) for (let j = 0; j < grid[i].length; j++) {
        const r = b.minR + i, c = b.minC + j
        const row = gridRows[r], col = visibleColumns[c]
        if (!row || !col || !isColEditable(col)) continue
        const value = coerceCellValue(col, grid[i][j]); if (value === undefined) continue
        changes.push({ row, col, value })
      }
      const er = Math.min(gridRows.length - 1, b.minR + grid.length - 1)
      const ec = Math.min(visibleColumns.length - 1, b.minC + (grid[0]?.length || 1) - 1)
      const a = cellAt(b.minR, b.minC), f = cellAt(er, ec)
      if (a && f) setSel({ anchor: a, focus: f })
    }
    applyCellChanges(changes)
  }, [gridRows, visibleColumns, isColEditable, applyCellChanges, cellAt])

  const clearCells = useCallback((b) => {
    const changes = []
    for (let r = b.minR; r <= b.maxR; r++) for (let c = b.minC; c <= b.maxC; c++) {
      const col = visibleColumns[c]; if (!isColEditable(col)) continue
      changes.push({ row: gridRows[r], col, value: null })
    }
    applyCellChanges(changes)
  }, [gridRows, visibleColumns, isColEditable, applyCellChanges])

  // Raccourcis clavier globaux quand une cellule est sélectionnée. On ignore
  // les frappes si un champ (recherche, filtre, input inline) a le focus.
  const onGridKeyDown = useCallback((e) => {
    if (!gridMode || editingCell) return
    const ae = document.activeElement
    const tag = ae?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ae?.isContentEditable) return
    if (!sel) return
    const b = selBounds(); if (!b) return
    const mod = e.metaKey || e.ctrlKey
    const k = e.key
    if (mod && (k === 'c' || k === 'C')) { e.preventDefault(); copyCells(b); return }
    if (mod && (k === 'v' || k === 'V')) { e.preventDefault(); pasteCells(b); return }
    if (mod && (k === 'd' || k === 'D')) { e.preventDefault(); fillDown(b); return }
    const fR = rowIndexById.get(sel.focus.rowId), fC = colIndexById.get(sel.focus.colId)
    if (fR == null || fC == null) return
    if (k === 'ArrowUp') { e.preventDefault(); moveCursor(fR - 1, fC, e.shiftKey) }
    else if (k === 'ArrowDown') { e.preventDefault(); moveCursor(fR + 1, fC, e.shiftKey) }
    else if (k === 'ArrowLeft') { e.preventDefault(); moveCursor(fR, fC - 1, e.shiftKey) }
    else if (k === 'ArrowRight') { e.preventDefault(); moveCursor(fR, fC + 1, e.shiftKey) }
    else if (k === 'Escape') { e.preventDefault(); setSel(null) }
    else if (k === 'Enter' || k === 'F2') { e.preventDefault(); startEdit(sel.focus.rowId, sel.focus.colId) }
    else if (k === 'Backspace' || k === 'Delete') { e.preventDefault(); clearCells(b) }
    else if (k.length === 1 && !mod && !e.altKey) {
      if (isColEditable(visibleColumns[fC])) { e.preventDefault(); startEdit(sel.focus.rowId, sel.focus.colId, k) }
    }
  }, [gridMode, editingCell, sel, selBounds, copyCells, pasteCells, fillDown, moveCursor, startEdit, clearCells, rowIndexById, colIndexById, visibleColumns, isColEditable])

  keyHandlerRef.current = onGridKeyDown
  useEffect(() => {
    if (!gridMode) return
    const h = (e) => keyHandlerRef.current?.(e)
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [gridMode])

  // Tous les pathKeys actuellement matérialisés (utile pour "Tout fermer").
  // Note : avec le nested grouping, ne contient que les groupes des niveaux
  // dépliés — un groupe parent fermé masque ses enfants donc ils n'apparaissent
  // pas ici. "Tout fermer" sur les niveaux visibles est suffisant ; un second
  // appel après que l'utilisateur ait déplié des niveaux fermera ceux-là.
  const groupKeys = useMemo(
    () => virtualItems.filter(i => i.__isGroup).map(i => i.__pathKey),
    [virtualItems]
  )

  const collapseAll = useCallback(() => {
    const s = new Set(groupKeys)
    setCollapsedGroups(s)
    saveCollapsed(s)
  }, [groupKeys])
  const expandAll = useCallback(() => {
    const s = new Set()
    setCollapsedGroups(s)
    saveCollapsed(s)
  }, [])

  if (!configReady) return null

  return (
    <div className="card overflow-hidden flex flex-col">

      <ViewToolbar
        table={table}
        columns={mergedColumns}
        sorts={view.sorts} setSorts={view.setSorts}
        filters={view.filters} setFilters={view.setFilters}
        search={view.search} setSearch={view.setSearch}
        searchFields={searchFields}
        views={view.views}
        onReorderViews={view.reorderViews}
        activeViewId={view.activeViewId}
        setActiveViewId={view.setActiveViewId}
        patchLocalView={view.patchLocalView}
        processedCount={filteredData.length}
        visibleCols={visibleCols} setVisibleCols={setVisibleCols}
        groupBy={groupBy} setGroupBy={setGroupBy}
        groupOrder={groupOrder} setGroupOrder={setGroupOrder}
        colorRules={colorRules} setColorRules={setColorRules}
        onCollapseAll={collapseAll} onExpandAll={expandAll}
        data={data}
        disabledColumns={disabledColumns}
        manageViews={manageViews}
        manageViewsBulkDelete={typeof onBulkDelete === 'function' && !bulkDeleteAlways}
      />

      {selectionActive && selectedIds.size > 0 && (
        <div className="flex items-center justify-between gap-3 px-4 py-2 bg-brand-50 border-b border-brand-100">
          <span className="text-sm text-brand-900">
            {selectedIds.size} sélectionné{selectedIds.size > 1 ? 's' : ''}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setSelectedIds(new Set())}
              className="text-xs text-slate-500 hover:text-slate-700 px-2 py-1"
            >
              Désélectionner
            </button>
            {visibleBulkActions.map(action => {
              const Icon = action.icon
              const busy = busyAction === action.key
              return (
                <button
                  key={action.key}
                  onClick={() => runBulkAction(action)}
                  disabled={busy || busyAction !== null}
                  className={action.className || 'inline-flex items-center gap-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-50 px-3 py-1.5 rounded transition-colors'}
                >
                  {Icon && <Icon size={13} />}
                  {busy ? (action.busyLabel || 'En cours...') : action.label}
                </button>
              )
            })}
            {typeof onBulkDelete === 'function' && (
              <button
                onClick={handleBulkDelete}
                disabled={deleting}
                className="inline-flex items-center gap-1.5 text-xs font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 px-3 py-1.5 rounded transition-colors"
              >
                <Trash2 size={13} />
                {deleting ? 'Suppression...' : 'Supprimer'}
              </button>
            )}
          </div>
        </div>
      )}

      {gridMode && sel && gridBounds && (
        <div data-testid="datatable-grid-bar" className="flex items-center gap-3 px-4 py-1.5 bg-slate-50 border-b border-slate-100 text-xs text-slate-500">
          <span className="font-medium text-slate-600">
            {(gridBounds.maxR - gridBounds.minR + 1) * (gridBounds.maxC - gridBounds.minC + 1)} cellule(s)
          </span>
          <span className="text-slate-300">·</span>
          <span className="hidden sm:inline">⌘/Ctrl+C copier · ⌘/Ctrl+V coller · ⌘/Ctrl+D remplir vers le bas · double-clic pour ouvrir</span>
          {gridSaving && (
            <span className="ml-auto flex items-center gap-1.5 text-slate-400">
              <span className="inline-block w-3 h-3 border border-slate-300 border-t-transparent rounded-full animate-spin" />
              Enregistrement…
            </span>
          )}
        </div>
      )}

      <div ref={parentRef} tabIndex={gridMode ? -1 : undefined} className="overflow-auto outline-none" style={{ height }}>
        <div style={{ minWidth: 'max-content' }}>
          <div
            className="group/header grid border-b border-slate-200 bg-slate-50 sticky top-0 z-10"
            style={{ gridTemplateColumns: gridTemplate }}
          >
            {reorderActive && <div aria-hidden />}
            {selectionActive && (
              <div className="flex items-center justify-center px-2">
                <input
                  type="checkbox"
                  aria-label="Tout sélectionner"
                  checked={allVisibleSelected}
                  ref={el => { if (el) el.indeterminate = someVisibleSelected }}
                  onChange={toggleAllVisible}
                  className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 cursor-pointer"
                />
              </div>
            )}
            {expandable && <div aria-hidden />}
            {visibleColumns.map(col => {
              const customField = cfByColumn?.get(col.field) || cfByColumn?.get(col.id)
              return (
                <div
                  key={col.id}
                  draggable
                  onDragStart={e => handleColDragStart(e, col.id)}
                  onDragOver={e => handleColDragOver(e, col.id)}
                  onDrop={handleColDrop}
                  onDragEnd={handleColDragEnd}
                  onDragLeave={() => setDragOverCol(prev => prev === col.id ? null : prev)}
                  onContextMenu={(e) => {
                    e.preventDefault()
                    setColMenu({
                      x: e.clientX,
                      y: e.clientY,
                      col,
                      source: customField ? (customField.source || 'native') : null,
                      field: customField || null,
                    })
                  }}
                  className="relative px-4 py-2.5 text-xs font-semibold text-slate-500 uppercase tracking-wide leading-tight break-words select-none cursor-grab active:cursor-grabbing"
                >
                  <span className="inline-flex items-baseline gap-1">
                    {col.label}
                    {col.description && <ColumnHelp description={col.description} />}
                  </span>
                  {dragOverCol === col.id && dragColRef.current && dragColRef.current !== col.id && (
                    <div
                      className={`absolute top-0 bottom-0 w-0.5 bg-brand-500 pointer-events-none ${dragOverSide === 'before' ? '-left-px' : '-right-px'}`}
                    />
                  )}
                  <ResizeHandle onResize={w => handleColResize(col.id, w)} />
                </div>
              )
            })}
            {addCustomField && (
              <div className="flex items-center justify-center">
                <button
                  type="button"
                  onClick={addCustomField}
                  className="p-1 rounded text-slate-400 hover:text-brand-600 hover:bg-brand-50 transition-colors"
                  title="Ajouter un champ"
                  aria-label="Ajouter un champ"
                >
                  <Plus size={14} />
                </button>
              </div>
            )}
          </div>

          {colMenu && (() => {
            const c = colMenu.col
            const canGroup = c?.groupable !== false && c?.field
            const canSort = c?.sortable !== false && c?.field
            const canFilter = c?.filterable !== false && c?.field
            const itemCls = 'flex items-center gap-2 w-full px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 text-left'
            return (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setColMenu(null)} onContextMenu={e => { e.preventDefault(); setColMenu(null) }} />
                <div
                  className="fixed z-50 bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[200px]"
                  style={{ top: colMenu.y, left: colMenu.x }}
                >
                  {canGroup && (
                    <button onClick={() => { setGroupBy(c.field); setColMenu(null) }} className={itemCls}>
                      <Layers size={13} /> Grouper par cette colonne
                    </button>
                  )}
                  {canFilter && (
                    <button
                      onClick={() => {
                        const op = defaultOpForType(c.type)
                        const newRule = { field: c.field, op, value: '' }
                        const cur = view.filters
                        const nextFilters = (cur && cur.rules)
                          ? { ...cur, rules: [...cur.rules, newRule] }
                          : (Array.isArray(cur) ? [...cur, newRule] : [newRule])
                        view.setFilters(nextFilters)
                        window.dispatchEvent(new CustomEvent('datatable:open-panel', { detail: { table, panel: 'filter' } }))
                        setColMenu(null)
                      }}
                      className={itemCls}
                    >
                      <Filter size={13} /> Filtrer cette colonne
                    </button>
                  )}
                  {canSort && (
                    <button onClick={() => { view.setSorts([{ field: c.field, dir: 'asc' }]); setColMenu(null) }} className={itemCls}>
                      <ArrowUp size={13} /> Trier croissant
                    </button>
                  )}
                  {canSort && (
                    <button onClick={() => { view.setSorts([{ field: c.field, dir: 'desc' }]); setColMenu(null) }} className={itemCls}>
                      <ArrowDown size={13} /> Trier décroissant
                    </button>
                  )}
                  <button
                    onClick={() => {
                      setVisibleCols(prev => prev.filter(id => id !== c.id))
                      setColMenu(null)
                    }}
                    className={itemCls}
                  >
                    <EyeOff size={13} /> Cacher cette colonne
                  </button>
                  {/* Champ natif (défini dans tableDefs, pas un champ custom/Airtable) :
                      renommage + changement de type via la modale commune
                      (CustomFieldModal en mode natif). */}
                  {!colMenu.source && table && columnsWithOwnCf.some(x => x.id === c.id) && (
                    <>
                      <div className="my-1 border-t border-slate-100" />
                      <button
                        onClick={() => {
                          // La modale attend la définition D'ORIGINE (pré-override)
                          // pour afficher « nom/type d'origine » et détecter un reset.
                          const orig = columnsWithOwnCf.find(x => x.id === c.id) || c
                          setFieldOverrideModal({ col: orig })
                          setColMenu(null)
                        }}
                        className={itemCls}
                        data-testid="colmenu-edit-native-field"
                      >
                        <Edit2 size={13} /> Modifier le champ
                      </button>
                    </>
                  )}
                  {colMenu.source && (
                    <>
                      <div className="my-1 border-t border-slate-100" />
                      <button
                        onClick={() => {
                          editCustomField?.(colMenu.field)
                          setColMenu(null)
                        }}
                        className={itemCls}
                      >
                        <Edit2 size={13} /> Modifier le champ
                      </button>
                      <button
                        onClick={() => {
                          const f = colMenu.field
                          setColMenu(null)
                          deleteCustomField?.(f)
                        }}
                        className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 text-left"
                      >
                        <Trash2 size={13} /> Supprimer le champ
                      </button>
                    </>
                  )}
                </div>
              </>
            )
          })()}

          {/* Modale UNIQUE de modification de champ — commune aux champs custom
              auto-gérés (création/édition) et aux champs natifs (renommage /
              changement de type via field_overrides). Les valeurs calculées
              (formule/lookup) d'un nouveau champ apparaissent au prochain
              rechargement des données de la page ; un champ data neuf est vide
              de toute façon. */}
          <CustomFieldModal
            isOpen={!!ownCfModal || !!fieldOverrideModal}
            onClose={() => { setOwnCfModal(null); setFieldOverrideModal(null) }}
            erpTable={table}
            editing={ownCfModal?.editing || null}
            native={fieldOverrideModal?.col
              ? { column: fieldOverrideModal.col, override: fieldOverrides.get(fieldOverrideModal.col.id) || null }
              : null}
            onSaved={() => { fieldOverrideModal ? reloadFieldOverrides() : reloadOwnCustomFields() }}
            onDeleted={() => { reloadOwnCustomFields() }}
          />


          {loading ? (
            <div className="flex items-center justify-center text-slate-400 text-sm py-12">
              Chargement...
            </div>
          ) : virtualItems.length === 0 ? (
            (() => {
              const hasRows = Array.isArray(data) && data.length > 0
              const filtersActive = Array.isArray(filters)
                ? filters.length > 0
                : !!(filters?.rules?.length)
              // Des lignes existent mais la recherche/les filtres les masquent toutes.
              if (hasRows && (search || filtersActive)) {
                return (
                  <EmptyState
                    icon={Filter}
                    title="Aucun résultat ne correspond"
                    description="Aucune ligne ne correspond à votre recherche ou à vos filtres actifs."
                    cta={{
                      label: 'Réinitialiser',
                      icon: RotateCcw,
                      onClick: () => { setSearch?.(''); setFilters?.([]) },
                    }}
                  />
                )
              }
              // Table réellement vide : message contextuel fourni par le parent, sinon défaut.
              return (
                <EmptyState
                  icon={emptyState?.icon || Inbox}
                  title={emptyState?.title || 'Aucune donnée'}
                  description={emptyState?.description || 'Cette table ne contient encore aucun enregistrement.'}
                  cta={emptyState?.cta}
                />
              )
            })()
          ) : (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map(vItem => {
              const item = displayItems[vItem.index]

              if (item.__isExpansion) {
                return (
                  <div
                    key={vItem.key}
                    data-index={vItem.index}
                    data-testid={`datatable-expansion-${item.__expandKey}`}
                    ref={virtualizer.measureElement}
                    style={{ position: 'absolute', top: vItem.start, left: 0, right: 0, width: '100%' }}
                    className="border-b border-slate-100 bg-slate-50/40"
                  >
                    {renderExpanded(item.__row)}
                  </div>
                )
              }

              if (item.__isGroup) {
                const sums = item.__sums || {}
                // Niveau 0 = la teinte la plus marquée ; chaque niveau imbriqué
                // s'éclaircit légèrement pour visualiser la hiérarchie. Cap au
                // niveau 2 pour éviter de devenir invisible.
                const lvl = item.__level || 0
                // Reformate la clé du groupe via la colonne du niveau (utile
                // pour ex. afficher "mai 2026" pour un YYYY-MM ou "Upgrade"
                // pour la catégorie brute "upgrade").
                const lvlField = groupBy[lvl]
                const lvlCol = lvlField ? mergedColumns.find(c => c.field === lvlField) : null
                const groupLabel = lvlCol?.formatGroupKey
                  ? lvlCol.formatGroupKey(item.__key)
                  : item.__key
                const groupBg = lvl === 0
                  ? 'bg-slate-100 hover:bg-slate-200'
                  : lvl === 1
                    ? 'bg-slate-50 hover:bg-slate-100'
                    : 'bg-white hover:bg-slate-50'
                return (
                  <div
                    key={vItem.key}
                    data-testid={`datatable-group-${item.__pathKey}`}
                    data-group-level={lvl}
                    style={{
                      position: 'absolute', top: vItem.start, left: 0, right: 0, height: vItem.size,
                      display: 'grid',
                      gridTemplateColumns: gridTemplate,
                      alignItems: 'center',
                    }}
                    className={`${groupBg} border-b border-slate-200 cursor-pointer transition-colors select-none`}
                    onClick={() => toggleGroup(item.__pathKey)}
                  >
                    {reorderActive && <div />}
                    {selectionActive && <div />}
                    {expandable && <div />}
                    <div className="flex items-center gap-2 px-3" style={{ paddingLeft: `${12 + lvl * 16}px` }}>
                      {item.__collapsed
                        ? <ChevronRight size={13} className="text-slate-400 flex-shrink-0" />
                        : <ChevronDown size={13} className="text-slate-400 flex-shrink-0" />
                      }
                      <span className="text-xs font-semibold text-slate-600 truncate capitalize">{groupLabel}</span>
                      <span className="text-xs text-slate-400 flex-shrink-0">({item.__count})</span>
                    </div>
                    {visibleColumns.slice(1).map(col => (
                      <div key={col.id} className="px-4 text-xs tabular-nums">
                        {sums[col.field] != null && (
                          <span className="font-medium text-slate-500">
                            {sums[col.field].toLocaleString('fr-CA', { maximumFractionDigits: 2 })}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                )
              }

              const rowFlash = flashes.size > 0 ? flashes.get(item.id) : null
              // Pendant le flash, on affiche les nouvelles valeurs venues du
              // payload realtime (le store, lui, ne rattrape qu'au prochain poll).
              const renderItem = rowFlash ? { ...item, ...rowFlash.values } : item
              const rowColor = rowColorById.size > 0 ? rowColorById.get(item.id) : undefined
              const rowColorStyle = rowColor ? ROW_COLOR_STYLES[rowColor] : null

              return (
                <div
                  key={vItem.key}
                  data-row-id={item.id}
                  data-row-color={rowColor}
                  style={{
                    position: 'absolute',
                    top: vItem.start,
                    left: 0,
                    right: 0,
                    height: vItem.size,
                    display: 'grid',
                    gridTemplateColumns: gridTemplate,
                    alignItems: 'center',
                    ...(rowColorStyle ? { background: rowColorStyle.bg, boxShadow: `inset 3px 0 0 0 ${rowColorStyle.bar}` } : {}),
                  }}
                  onClick={() => { if (gridMode) return; if (peekEnabled) setPeekItem(item); else if (onRowClick) onRowClick(item); else if (expandable) toggleExpand(item) }}
                  onDoubleClick={gridMode ? (peekEnabled ? () => setPeekItem(item) : (onRowClick ? () => onRowClick(item) : undefined)) : undefined}
                  onDragOver={reorderActive && dragRowId ? (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; if (dragOverRowId !== item.id) setDragOverRowId(item.id) } : undefined}
                  onDrop={reorderActive && dragRowId ? (e) => { e.preventDefault(); handleRowDrop(item.id) } : undefined}
                  className={`border-b border-slate-100 hover:bg-slate-50${gridMode ? '' : ' cursor-pointer'}${reorderActive && dragRowId === item.id ? ' opacity-40' : ''}${reorderActive && dragOverRowId === item.id && dragRowId && dragRowId !== item.id ? ' bg-brand-50 border-t-2 border-t-brand-400' : ''}${rowClassName ? ` ${rowClassName(item) || ''}` : ''}`}
                >
                  {reorderActive && (
                    <div
                      draggable
                      data-testid={`datatable-row-drag-${item.id}`}
                      onDragStart={e => {
                        setDragRowId(item.id)
                        e.dataTransfer.effectAllowed = 'move'
                        try { e.dataTransfer.setData('text/plain', String(item.id)) } catch {}
                      }}
                      onDragEnd={() => { setDragRowId(null); setDragOverRowId(null) }}
                      onMouseDown={e => e.stopPropagation()}
                      onClick={e => e.stopPropagation()}
                      className="flex items-center justify-center h-full text-slate-300 hover:text-slate-500 cursor-grab active:cursor-grabbing"
                    >
                      <GripVertical size={13} />
                    </div>
                  )}
                  {selectionActive && (
                    <div className="flex items-center justify-center px-2" onClick={e => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label="Sélectionner la ligne"
                        checked={selectedIds.has(item.id)}
                        onChange={() => toggleRow(item.id)}
                        className="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 cursor-pointer"
                      />
                    </div>
                  )}
                  {expandable && (
                    <div
                      className="flex items-center justify-center text-slate-400 hover:text-slate-600"
                      onClick={e => { e.stopPropagation(); toggleExpand(item) }}
                      data-testid={`datatable-expand-toggle-${item[rowKey]}`}
                      aria-label={expandedKeys.has(item[rowKey]) ? 'Replier' : 'Déplier'}
                    >
                      {expandedKeys.has(item[rowKey])
                        ? <ChevronDown size={14} />
                        : <ChevronRight size={14} />}
                    </div>
                  )}
                  {visibleColumns.map((col, ci) => {
                    const flashing = rowFlash && rowFlash.fields.has(col.field)
                    if (gridMode) {
                      const ri = rowIndexById.get(item.id)
                      const inSel = gridBounds && ri != null
                        && ri >= gridBounds.minR && ri <= gridBounds.maxR
                        && ci >= gridBounds.minC && ci <= gridBounds.maxC
                      const isActive = sel && sel.focus.rowId === item.id && sel.focus.colId === col.id
                      const editable = isColEditable(col)
                      const isEditing = editingCell && editingCell.rowId === item.id && editingCell.colId === col.id
                      return (
                        <div
                          key={col.id}
                          data-grid-cell={`${item.id}|${col.id}`}
                          onMouseDown={e => {
                            if (e.button !== 0) return
                            const cell = { rowId: item.id, colId: col.id }
                            if (e.shiftKey && sel) setSel(s => ({ anchor: s.anchor, focus: cell }))
                            else setSel({ anchor: cell, focus: cell })
                            focusGrid()
                          }}
                          onDoubleClick={e => { if (editable) { e.stopPropagation(); startEdit(item.id, col.id) } }}
                          className={`relative px-4 text-sm select-none${flashing ? ' dt-cell-flash' : ''}${inSel ? ' bg-brand-50' : ''}${isActive ? ' z-[1] ring-2 ring-inset ring-brand-500' : ''}`}
                        >
                          {isEditing ? (
                            (col.type === 'single_select' || col.type === 'multi_select') ? (
                              <>
                                <span className="block truncate opacity-50">{renderCell(col, renderItem, getDecimals(table, col.field))}</span>
                                <SelectCellEditor
                                  col={col}
                                  value={item[col.field]}
                                  onCommit={(val) => {
                                    const cur = item[col.field]
                                    if (val !== (cur == null ? '' : String(cur))) applyCellChanges([{ row: item, col, value: val }])
                                    setEditingCell(null); focusGrid()
                                  }}
                                  onCancel={() => { setEditingCell(null); focusGrid() }}
                                />
                              </>
                            ) : (
                            <input
                              autoFocus
                              data-testid="datatable-cell-input"
                              value={editValue}
                              onChange={e => setEditValue(e.target.value)}
                              onMouseDown={e => e.stopPropagation()}
                              onClick={e => e.stopPropagation()}
                              onDoubleClick={e => e.stopPropagation()}
                              onBlur={() => commitEdit(null)}
                              onKeyDown={e => {
                                e.stopPropagation()
                                if (e.key === 'Enter') { e.preventDefault(); commitEdit('down') }
                                else if (e.key === 'Tab') { e.preventDefault(); commitEdit(e.shiftKey ? 'left' : 'right') }
                                else if (e.key === 'Escape') { e.preventDefault(); cancelEdit() }
                              }}
                              className="w-full bg-white border border-brand-500 rounded px-1.5 py-0.5 text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                            />
                            )
                          ) : (
                            <span className="block truncate">{renderCell(col, renderItem, getDecimals(table, col.field))}</span>
                          )}
                        </div>
                      )
                    }
                    return (
                      <div key={col.id} className={`px-4 truncate text-sm${flashing ? ' dt-cell-flash' : ''}`}>
                        {renderCell(col, renderItem, getDecimals(table, col.field))}
                      </div>
                    )
                  })}
                  {rowFlash && (
                    <div
                      className="dt-editor-badge"
                      data-editor-badge={rowFlash.actorName}
                      style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', zIndex: 5 }}
                    >
                      <span className="inline-flex items-center gap-1 rounded-full bg-emerald-500 text-white text-[10px] font-medium px-2 py-0.5 shadow-sm whitespace-nowrap">
                        <span className="h-1.5 w-1.5 rounded-full bg-white/90" />
                        {rowFlash.actorName}
                      </span>
                    </div>
                  )}
                </div>
              )
            })}
            </div>
          )}

          {/* Barre de totaux configurable (summary bar à la Airtable). Toujours
              visible (cellules vides cliquables pour ajouter un total), épinglée
              en bas du conteneur scrollable et alignée sur la grille. Les valeurs
              reflètent les lignes filtrées/recherchées (« total courant »). */}
          {!loading && visibleColumns.length > 0 && (
            <div
              data-testid="datatable-footer"
              className="grid border-t border-slate-200 bg-slate-50/95 backdrop-blur-sm sticky bottom-0 z-10"
              style={{ gridTemplateColumns: gridTemplate }}
            >
              {reorderActive && <div aria-hidden />}
              {selectionActive && <div aria-hidden />}
              {expandable && <div aria-hidden />}
              {visibleColumns.map(col => {
                const aggType = footerAggs[col.id]
                const agg = footerValues.get(col.id)
                const formatted = aggType ? formatAggValue(agg, getDecimals(table, col.field)) : ''
                return (
                  <div
                    key={col.id}
                    data-testid={`datatable-footer-cell-${col.id}`}
                    onClick={e => { e.stopPropagation(); setFooterMenu({ col, x: e.clientX, y: e.clientY }) }}
                    className="group/foot relative px-4 py-1.5 text-xs cursor-pointer hover:bg-slate-100 transition-colors flex items-baseline justify-end gap-1.5 overflow-hidden select-none"
                    title="Cliquer pour choisir un total (somme, moyenne, compte, min, max…)"
                  >
                    {aggType ? (
                      <>
                        <span className="text-[10px] uppercase tracking-wide text-slate-400 truncate">{agg?.label}</span>
                        <span className="font-semibold text-slate-700 tabular-nums truncate">{formatted}</span>
                      </>
                    ) : (
                      <span className="text-[10px] text-slate-300 opacity-0 group-hover/foot:opacity-100 transition-opacity inline-flex items-center gap-1">
                        <Sigma size={11} /> Total
                      </span>
                    )}
                  </div>
                )
              })}
              {addCustomField && <div aria-hidden />}
            </div>
          )}

          {footerMenu && (() => {
            const c = footerMenu.col
            const opts = aggOptionsFor(c)
            const current = footerAggs[c.id] || 'none'
            const itemCls = 'flex items-center justify-between gap-3 w-full px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 text-left'
            return (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setFooterMenu(null)} onContextMenu={e => { e.preventDefault(); setFooterMenu(null) }} />
                <div
                  className="fixed z-50 bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[180px]"
                  style={{ top: footerMenu.y - 8, left: footerMenu.x, transform: 'translateY(-100%)' }}
                >
                  <div className="px-3 py-1 text-[10px] uppercase tracking-wide text-slate-400 truncate">{c.label}</div>
                  <button onClick={() => { setColAggregation(c.id, 'none'); setFooterMenu(null) }} className={itemCls}>
                    <span>Aucun</span>{current === 'none' && <Check size={13} className="text-brand-600 flex-shrink-0" />}
                  </button>
                  {opts.map(o => (
                    <button key={o} onClick={() => { setColAggregation(c.id, o); setFooterMenu(null) }} className={itemCls}>
                      <span>{AGG_LABELS[o]}</span>{current === o && <Check size={13} className="text-brand-600 flex-shrink-0" />}
                    </button>
                  ))}
                </div>
              </>
            )
          })()}
        </div>
      </div>

      {peekEnabled && (
        <RecordPeekDrawer
          open={!!peekItem}
          onClose={() => setPeekItem(null)}
          title={resolvePeek('title', peekItem) || ''}
          subtitle={resolvePeek('subtitle', peekItem)}
          to={resolvePeek('to', peekItem)}
          width={peek.width}
        >
          {peekItem && peek.render(peekItem, { close: () => setPeekItem(null) })}
        </RecordPeekDrawer>
      )}
    </div>
  )
}
```


---

## `client/src/components/ViewToolbar.jsx`

La barre de vues façon Airtable : pills de vues sauvegardées, champs, filtres, tri, groupes.

```jsx
import { useState, useRef, useEffect, useLayoutEffect } from 'react'
import { createPortal } from 'react-dom'
import { Eye, Filter, ArrowUpDown, Layers, X, Plus, ChevronUp, ChevronDown, Check, Search, ChevronsDownUp, ChevronsUpDown, AlertTriangle, Lock, Unlock, Pencil, Trash2, Paintbrush } from 'lucide-react'
import { useAuth } from '../lib/auth.jsx'
import { FilterRow, FieldSelect, defaultOpForType } from './FilterRow.jsx'
import { TableConfigModal } from './TableConfigModal.jsx'
import { useConfirm } from './ConfirmProvider.jsx'
import { countFilterRules } from '../lib/tableFilters.js'
import api from '../lib/api.js'

function ToolbarBtn({ icon, label, active, badge, onClick, dataPanelBtn, disabled }) {
  return (
    <button
      onClick={(e) => { if (!disabled) onClick(e) }}
      disabled={disabled}
      data-panel-btn={dataPanelBtn}
      title={disabled ? 'Vue verrouillée — déverrouillez-la pour la modifier' : undefined}
      className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium transition-colors ${
        disabled
          ? 'text-slate-300 cursor-not-allowed'
          : active ? 'bg-brand-50 text-brand-700' : 'text-slate-600 hover:bg-slate-100'
      }`}
    >
      {icon}
      {label}
      {badge > 0 && (
        <span className="bg-brand-600 text-white rounded-full w-4 h-4 flex items-center justify-center text-[10px] leading-none">
          {badge}
        </span>
      )}
    </button>
  )
}

// Rendu via portal dans <body> en position fixed : les panneaux ne sont plus
// clippés par le `overflow-hidden` du card DataTable (problème visible quand la
// fenêtre / le tableau est très petit). Position clampée au viewport
// (horizontal + hauteur max) et recalculée sur scroll/resize.
function Panel({ children, className = '', anchorEl }) {
  const ref = useRef(null)
  const [pos, setPos] = useState(null)

  useLayoutEffect(() => {
    function place() {
      const el = ref.current
      const btnRect = anchorEl?.getBoundingClientRect()
      if (!el || !btnRect) return
      const margin = 8
      const width = el.offsetWidth
      let left = btnRect.left
      if (left + width > window.innerWidth - margin) {
        left = Math.max(margin, window.innerWidth - width - margin)
      }
      const top = btnRect.bottom + 4
      const maxHeight = Math.max(160, window.innerHeight - top - margin)
      setPos({ top, left, maxHeight })
    }
    place()
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
    }
  }, [anchorEl])

  return createPortal(
    <div
      ref={ref}
      data-viewtoolbar-panel
      style={{
        position: 'fixed',
        top: pos?.top ?? -9999,
        left: pos?.left ?? -9999,
        maxHeight: pos?.maxHeight,
        zIndex: 9998, // sous les portals FieldSelect/ValueSelect (9999)
      }}
      className={`bg-white border border-slate-200 rounded-lg shadow-xl p-4 overflow-y-auto ${className}`}
    >
      {children}
    </div>,
    document.body
  )
}

function PanelTitle({ children }) {
  return <p className="text-xs font-semibold text-slate-400 uppercase tracking-wide mb-3">{children}</p>
}

export function FieldsPanel({ columns, visibleCols, onChange, anchorEl }) {
  const [search, setSearch] = useState('')
  const filtered = search
    ? columns.filter(c => c.label.toLowerCase().includes(search.toLowerCase()))
    : columns

  const filteredIds = filtered.map(c => c.id)
  const allVisible = filteredIds.every(id => visibleCols.includes(id))
  const noneVisible = filteredIds.every(id => !visibleCols.includes(id))

  function showAll() {
    onChange(v => Array.from(new Set([...v, ...filteredIds])))
  }
  function hideAll() {
    const hideSet = new Set(filteredIds)
    onChange(v => v.filter(id => !hideSet.has(id)))
  }

  return (
    <Panel className="w-64" anchorEl={anchorEl}>
      <PanelTitle>Colonnes visibles</PanelTitle>
      <div className="relative mb-2">
        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full pl-7 pr-2 py-1.5 text-xs border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400"
          placeholder="Rechercher..."
          autoFocus
        />
      </div>
      <div className="space-y-0.5 max-h-64 overflow-y-auto">
        {filtered.length === 0
          ? <p className="text-xs text-slate-400 text-center py-2">Aucun résultat</p>
          : filtered.map(col => (
          <label key={col.id} className="flex items-center gap-2.5 px-1 py-1.5 rounded hover:bg-slate-50 cursor-pointer">
            <input
              type="checkbox"
              checked={visibleCols.includes(col.id)}
              onChange={e => {
                if (e.target.checked) onChange(v => [...v, col.id])
                else onChange(v => v.filter(id => id !== col.id))
              }}
              className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            />
            <span className="text-sm text-slate-700">{col.label}</span>
          </label>
        ))}
      </div>
      {filtered.length > 0 && (
        <div className="mt-2 pt-2 border-t border-slate-100 flex items-center gap-1.5">
          <button
            type="button"
            onClick={showAll}
            disabled={allVisible}
            className="flex-1 text-xs font-medium text-slate-600 hover:text-brand-700 hover:bg-brand-50 rounded px-2 py-1.5 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-slate-600 disabled:cursor-not-allowed"
          >
            Tout voir
          </button>
          <button
            type="button"
            onClick={hideAll}
            disabled={noneVisible}
            className="flex-1 text-xs font-medium text-slate-600 hover:text-brand-700 hover:bg-brand-50 rounded px-2 py-1.5 disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-slate-600 disabled:cursor-not-allowed"
          >
            Tout cacher
          </button>
        </div>
      )}
    </Panel>
  )
}

// Profondeur d'imbrication max des groupes de filtres. Le moteur SQL serveur
// (buildGroupSQL) plafonne à 3 ; on reste sous cette limite côté UI. depth 0 =
// groupe racine, donc on autorise « Ajouter un groupe » tant que depth < 2
// (→ deux niveaux de parenthèses imbriquées, largement suffisant et sûr).
const MAX_FILTER_GROUP_DEPTH = 2

function isGroupNode(node) {
  return !!(node && node.conjunction && Array.isArray(node.rules))
}

function emptyRule(filterableCols) {
  const first = filterableCols[0]
  const type = first?.type || 'text'
  return { field: first?.field ?? '', op: defaultOpForType(type), value: '' }
}

// Bascule ET / OU compacte appliquée aux enfants directs d'un groupe.
function ConjunctionToggle({ value, onChange }) {
  return (
    <div className="flex items-center gap-0.5 bg-slate-100 rounded p-0.5">
      <button onClick={() => onChange('AND')}
        className={`text-xs px-2.5 py-1 rounded transition-colors font-medium ${value === 'AND' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
        ET
      </button>
      <button onClick={() => onChange('OR')}
        className={`text-xs px-2.5 py-1 rounded transition-colors font-medium ${value === 'OR' ? 'bg-white text-slate-800 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
        OU
      </button>
    </div>
  )
}

// Éditeur récursif d'un groupe de filtres : ses enfants sont soit des règles
// feuilles (FilterRow), soit des sous-groupes (parenthèses) eux-mêmes rendus
// par ce composant. La conjonction (ET/OU) s'applique aux enfants directs.
function FilterGroupEditor({ group, onChange, onRemove, columns, filterableCols, data, disabledColumns, depth }) {
  const conjunction = group.conjunction === 'OR' ? 'OR' : 'AND'
  const rules = group.rules || []
  const isDisabledField = (fieldName) => !!(disabledColumns && fieldName && disabledColumns.has(fieldName))

  function setConjunction(c) { onChange({ ...group, conjunction: c }) }
  function updateChild(i, child) { onChange({ ...group, rules: rules.map((r, idx) => idx === i ? child : r) }) }
  function removeChild(i) { onChange({ ...group, rules: rules.filter((_, idx) => idx !== i) }) }
  function addRule() { onChange({ ...group, rules: [...rules, emptyRule(filterableCols)] }) }
  function addGroup() {
    onChange({ ...group, rules: [...rules, { conjunction: 'AND', rules: [emptyRule(filterableCols)] }] })
  }

  const nested = depth > 0
  return (
    <div data-filter-group={depth} className={nested ? 'rounded-lg border border-slate-200 bg-slate-50/70 p-2' : ''}>
      <div className="flex items-center justify-between mb-2">
        {rules.length > 1
          ? <ConjunctionToggle value={conjunction} onChange={setConjunction} />
          : <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">{nested ? 'Groupe' : ''}</span>}
        {nested && (
          <button onClick={onRemove} className="text-slate-300 hover:text-red-500 flex-shrink-0" title="Retirer ce groupe">
            <X size={14} />
          </button>
        )}
      </div>

      <div className="space-y-1">
        {rules.length === 0 && (
          <p className="text-sm text-slate-400 py-1">Aucun filtre actif</p>
        )}
        {rules.map((child, i) => {
          const childIsGroup = isGroupNode(child)
          const fieldName = childIsGroup ? null : (child.field_key || child.field)
          const broken = fieldName ? isDisabledField(fieldName) : false
          return (
            <div key={i}>
              {i > 0 && (
                <div className="flex items-center gap-2 my-1.5">
                  <div className="flex-1 h-px bg-slate-100" />
                  <span className="text-[10px] font-bold text-slate-400 tracking-wide">{conjunction === 'OR' ? 'OU' : 'ET'}</span>
                  <div className="flex-1 h-px bg-slate-100" />
                </div>
              )}
              {childIsGroup ? (
                <FilterGroupEditor
                  group={child}
                  onChange={c => updateChild(i, c)}
                  onRemove={() => removeChild(i)}
                  columns={columns}
                  filterableCols={filterableCols}
                  data={data}
                  disabledColumns={disabledColumns}
                  depth={depth + 1}
                />
              ) : (
                <>
                  <FilterRow
                    columns={columns}
                    filter={child}
                    onChange={updated => updateChild(i, updated)}
                    onRemove={() => removeChild(i)}
                    size="xs"
                    data={data}
                  />
                  {broken && (
                    <div className="flex items-start gap-1 mt-0.5 ml-1 text-[11px] text-amber-700">
                      <AlertTriangle size={11} className="mt-0.5 flex-shrink-0" />
                      <span>Le champ <code className="font-mono">{fieldName}</code> a été désactivé dans la sync Airtable. Ce filtre ne renverra plus rien — supprime-le ou change le champ.</span>
                    </div>
                  )}
                </>
              )}
            </div>
          )
        })}
      </div>

      <div className="mt-3 flex items-center gap-4">
        <button onClick={addRule} className="flex items-center gap-1.5 text-xs text-brand-600 hover:text-brand-800 font-medium">
          <Plus size={13} /> Ajouter un filtre
        </button>
        {depth < MAX_FILTER_GROUP_DEPTH && (
          <button onClick={addGroup} className="flex items-center gap-1.5 text-xs text-brand-600 hover:text-brand-800 font-medium" title="Regrouper des conditions entre parenthèses">
            <Plus size={13} /> Ajouter un groupe
          </button>
        )}
      </div>
    </div>
  )
}

// ── Formatage conditionnel (règles de couleur par vue, à la Airtable) ────────
// Teintes de fond + barre latérale appliquées aux lignes du DataTable. Les clés
// sont persistées dans table_view_pills.color_rules ; les valeurs restent côté
// client pour pouvoir ajuster la palette sans migration.
export const ROW_COLOR_STYLES = {
  red:    { bg: '#fef2f2', bar: '#f87171', label: 'Rouge' },
  orange: { bg: '#fff7ed', bar: '#fb923c', label: 'Orange' },
  yellow: { bg: '#fefce8', bar: '#facc15', label: 'Jaune' },
  green:  { bg: '#f0fdf4', bar: '#4ade80', label: 'Vert' },
  teal:   { bg: '#f0fdfa', bar: '#2dd4bf', label: 'Sarcelle' },
  blue:   { bg: '#eff6ff', bar: '#60a5fa', label: 'Bleu' },
  purple: { bg: '#faf5ff', bar: '#c084fc', label: 'Violet' },
  pink:   { bg: '#fdf2f8', bar: '#f472b6', label: 'Rose' },
  gray:   { bg: '#f8fafc', bar: '#94a3b8', label: 'Gris' },
}

function newColorRule(filterableCols, usedColors) {
  // Prend la première couleur de la palette pas encore utilisée (sinon rouge).
  const color = Object.keys(ROW_COLOR_STYLES).find(c => !usedColors.has(c)) || 'red'
  return {
    id: `cr_${Math.random().toString(36).slice(2, 10)}`,
    color,
    filters: { conjunction: 'AND', rules: [emptyRule(filterableCols)] },
  }
}

// Une règle de couleur : swatch picker + conditions (mêmes FilterRow/groupes que
// le panneau Filtrer). L'ordre des règles compte : la première qui matche gagne.
function ColorRuleCard({ rule, index, total, onChange, onRemove, onMove, columns, filterableCols, data, disabledColumns }) {
  const normalized = Array.isArray(rule.filters)
    ? { conjunction: 'AND', rules: rule.filters }
    : (rule.filters?.rules ? rule.filters : { conjunction: 'AND', rules: [] })
  return (
    <div data-color-rule={index} className="rounded-lg border border-slate-200 bg-white p-2.5">
      <div className="flex items-center gap-1.5 mb-2">
        <span className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide flex-shrink-0">Règle {index + 1}</span>
        <div className="flex items-center gap-1 ml-1 flex-wrap">
          {Object.entries(ROW_COLOR_STYLES).map(([key, c]) => (
            <button
              key={key}
              type="button"
              data-color-swatch={key}
              onClick={() => onChange({ ...rule, color: key })}
              title={c.label}
              aria-label={c.label}
              className={`h-5 w-5 rounded-full border transition-transform ${
                rule.color === key ? 'ring-2 ring-offset-1 ring-brand-500 border-transparent scale-110' : 'border-slate-200 hover:scale-110'
              }`}
              style={{ background: c.bar }}
            />
          ))}
        </div>
        <div className="ml-auto flex items-center gap-0.5 flex-shrink-0">
          <button
            onClick={() => onMove(index, -1)}
            disabled={index === 0}
            className="p-0.5 text-slate-400 hover:text-slate-700 disabled:opacity-30 disabled:hover:text-slate-400"
            title="Monter (priorité plus forte)"
          >
            <ChevronUp size={13} />
          </button>
          <button
            onClick={() => onMove(index, 1)}
            disabled={index === total - 1}
            className="p-0.5 text-slate-400 hover:text-slate-700 disabled:opacity-30 disabled:hover:text-slate-400"
            title="Descendre (priorité plus faible)"
          >
            <ChevronDown size={13} />
          </button>
          <button onClick={onRemove} className="p-0.5 text-slate-300 hover:text-red-500" title="Supprimer cette règle">
            <X size={14} />
          </button>
        </div>
      </div>
      <FilterGroupEditor
        group={normalized}
        onChange={g => onChange({ ...rule, filters: g })}
        columns={columns}
        filterableCols={filterableCols}
        data={data}
        disabledColumns={disabledColumns}
        depth={0}
      />
    </div>
  )
}

function ColorPanel({ columns, rules, onChange, data, anchorEl, disabledColumns }) {
  const filterableCols = columns.filter(c => c.filterable !== false && c.field)
  const list = Array.isArray(rules) ? rules : []

  function addRule() {
    onChange([...list, newColorRule(filterableCols, new Set(list.map(r => r.color)))])
  }
  function updateRule(i, next) { onChange(list.map((r, idx) => idx === i ? next : r)) }
  function removeRule(i) { onChange(list.filter((_, idx) => idx !== i)) }
  function moveRule(i, delta) {
    const tgt = i + delta
    if (tgt < 0 || tgt >= list.length) return
    const next = [...list]
    ;[next[i], next[tgt]] = [next[tgt], next[i]]
    onChange(next)
  }

  return (
    <Panel className="w-[560px] max-w-[calc(100vw-16px)]" anchorEl={anchorEl}>
      <PanelTitle>Couleur des lignes</PanelTitle>
      <div data-testid="color-rules-panel" className="max-h-[60vh] overflow-y-auto space-y-2">
        {list.length === 0 && (
          <p className="text-sm text-slate-400 py-1">
            Aucune règle de couleur — ajoutez-en une pour colorer les lignes selon leurs valeurs.
          </p>
        )}
        {list.map((rule, i) => (
          <ColorRuleCard
            key={rule.id || i}
            rule={rule}
            index={i}
            total={list.length}
            onChange={next => updateRule(i, next)}
            onRemove={() => removeRule(i)}
            onMove={moveRule}
            columns={columns}
            filterableCols={filterableCols}
            data={data}
            disabledColumns={disabledColumns}
          />
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <button onClick={addRule} className="flex items-center gap-1.5 text-xs text-brand-600 hover:text-brand-800 font-medium">
          <Plus size={13} /> Ajouter une règle
        </button>
        {list.length > 1 && (
          <span className="text-[10px] text-slate-400">La première règle qui correspond colore la ligne.</span>
        )}
      </div>
    </Panel>
  )
}

function FilterPanel({ columns, filters, onChange, data, anchorEl, disabledColumns }) {
  const filterableCols = columns.filter(c => c.filterable !== false && c.field)

  // Normalize to {conjunction, rules} format (le format plat array reste accepté
  // en lecture pour les vues legacy ; toute édition repasse en format imbriqué).
  const normalized = Array.isArray(filters)
    ? { conjunction: 'AND', rules: filters }
    : (filters?.rules ? filters : { conjunction: 'AND', rules: [] })

  return (
    <Panel className="w-[560px] max-w-[calc(100vw-16px)]" anchorEl={anchorEl}>
      <PanelTitle>Filtres</PanelTitle>
      <div className="max-h-[60vh] overflow-y-auto">
        <FilterGroupEditor
          group={normalized}
          onChange={onChange}
          columns={columns}
          filterableCols={filterableCols}
          data={data}
          disabledColumns={disabledColumns}
          depth={0}
        />
      </div>
    </Panel>
  )
}

function SortPanel({ columns, sorts, onChange, anchorEl, disabledColumns }) {
  const isDisabledField = (fieldName) => !!(disabledColumns && fieldName && disabledColumns.has(fieldName))
  function add() {
    const used = new Set(sorts.map(s => s.field))
    const next = columns.find(c => !used.has(c.field))
    if (!next) return
    onChange(s => [...s, { field: next.field, dir: 'asc' }])
  }
  function update(i, patch) {
    onChange(s => s.map((item, idx) => idx === i ? { ...item, ...patch } : item))
  }
  function remove(i) {
    onChange(s => s.filter((_, idx) => idx !== i))
  }

  return (
    <Panel className="w-80" anchorEl={anchorEl}>
      <PanelTitle>Trier par</PanelTitle>
      <div className="space-y-2 max-h-60 overflow-y-auto">
        {sorts.length === 0 && <p className="text-sm text-slate-400 py-1">Aucun tri actif</p>}
        {sorts.map((s, i) => {
          const broken = isDisabledField(s.field)
          // Si le tri référence un champ désactivé, on l'ajoute en option "ghost"
          // pour que le select puisse afficher la valeur courante.
          const optionsForRow = broken
            ? [{ id: `__broken_${s.field}`, field: s.field, label: s.field }, ...columns]
            : columns
          return (
            <div key={i}>
              <div className="flex items-center gap-2">
                <FieldSelect
                  columns={optionsForRow}
                  value={s.field}
                  onChange={f => update(i, { field: f })}
                  cls="text-xs py-1.5"
                />
                <button onClick={() => update(i, { dir: s.dir === 'asc' ? 'desc' : 'asc' })} className="flex items-center gap-1 px-2.5 py-1.5 text-xs border border-slate-200 rounded hover:bg-slate-50 flex-shrink-0 text-slate-600">
                  {s.dir === 'asc' ? <><ChevronUp size={12} /> Croissant</> : <><ChevronDown size={12} /> Décroissant</>}
                </button>
                <button onClick={() => remove(i)} className="text-slate-300 hover:text-red-500 flex-shrink-0"><X size={14} /></button>
              </div>
              {broken && (
                <div className="flex items-start gap-1 mt-0.5 ml-1 text-[11px] text-amber-700">
                  <AlertTriangle size={11} className="mt-0.5 flex-shrink-0" />
                  <span>Le champ <code className="font-mono">{s.field}</code> a été désactivé dans la sync Airtable. Ce tri n'a plus d'effet.</span>
                </div>
              )}
            </div>
          )
        })}
      </div>
      <button onClick={add} className="mt-3 flex items-center gap-1.5 text-xs text-brand-600 hover:text-brand-800 font-medium">
        <Plus size={13} /> Ajouter un tri
      </button>
    </Panel>
  )
}

// Panel de groupage multi-niveau. `groupBy` est un array de field names :
// chaque entrée = un niveau de groupage imbriqué (niveau 0 = parent). Compat
// legacy : accepte aussi `null` ou string single-level, normalisé en array.
// `groupOrder` est un array aligné sur `groupBy` (orders par niveau).
function GroupPanel({ columns, groupBy, onChange, groupOrder, setGroupOrder, onCollapseAll, onExpandAll, anchorEl, disabledColumns }) {
  const [search, setSearch] = useState('')
  const groupByArr = Array.isArray(groupBy) ? groupBy : (groupBy ? [groupBy] : [])
  const groupOrderArr = Array.isArray(groupOrder) ? groupOrder : (groupOrder ? [groupOrder] : [])
  const usedFields = new Set(groupByArr)

  const available = columns.filter(c => !usedFields.has(c.field))
  const filtered = search
    ? available.filter(c => c.label.toLowerCase().includes(search.toLowerCase()))
    : available

  function addLevel(field) {
    onChange([...groupByArr, field])
    setSearch('')
  }
  function removeLevel(idx) {
    onChange(groupByArr.filter((_, i) => i !== idx))
    if (setGroupOrder) setGroupOrder(groupOrderArr.filter((_, i) => i !== idx))
  }
  function moveLevel(idx, delta) {
    const tgt = idx + delta
    if (tgt < 0 || tgt >= groupByArr.length) return
    const next = [...groupByArr]
    ;[next[idx], next[tgt]] = [next[tgt], next[idx]]
    onChange(next)
    if (setGroupOrder) {
      const o = [...groupOrderArr]
      while (o.length < groupByArr.length) o.push(null)
      ;[o[idx], o[tgt]] = [o[tgt], o[idx]]
      setGroupOrder(o)
    }
  }
  function setLevelOrder(idx, order) {
    if (!setGroupOrder) return
    const next = [...groupOrderArr]
    while (next.length <= idx) next.push(null)
    next[idx] = order
    setGroupOrder(next)
  }
  function clearAll() {
    onChange([])
    if (setGroupOrder) setGroupOrder([])
  }

  function orderBtnCls(active) {
    return `flex items-center gap-1 flex-1 justify-center px-1.5 py-0.5 text-[10px] rounded border transition-colors ${
      active ? 'bg-brand-50 text-brand-700 border-brand-200' : 'text-slate-500 hover:bg-slate-100 border-slate-200'
    }`
  }

  return (
    <Panel className="w-72" anchorEl={anchorEl}>
      <PanelTitle>Grouper par</PanelTitle>

      {groupByArr.length > 0 && (
        <div className="mb-3 space-y-1.5">
          {groupByArr.map((field, idx) => {
            const col = columns.find(c => c.field === field)
            const broken = !!(disabledColumns && disabledColumns.has(field))
            const order = groupOrderArr[idx] || null
            const hasOpts = Array.isArray(col?.options) && col.options.length > 0
            return (
              <div key={`${field}-${idx}`} className="bg-slate-50 border border-slate-200 rounded p-1.5">
                <div className="flex items-center gap-1">
                  <span className="text-[10px] font-semibold text-slate-400 w-7 flex-shrink-0">N°{idx + 1}</span>
                  <span className="flex-1 truncate text-xs font-medium text-slate-700">
                    {col?.label || field}
                  </span>
                  <button
                    onClick={() => moveLevel(idx, -1)}
                    disabled={idx === 0}
                    className="p-0.5 text-slate-400 hover:text-slate-700 disabled:opacity-30 disabled:hover:text-slate-400"
                    title="Monter d'un niveau"
                  >
                    <ChevronUp size={12} />
                  </button>
                  <button
                    onClick={() => moveLevel(idx, 1)}
                    disabled={idx === groupByArr.length - 1}
                    className="p-0.5 text-slate-400 hover:text-slate-700 disabled:opacity-30 disabled:hover:text-slate-400"
                    title="Descendre d'un niveau"
                  >
                    <ChevronDown size={12} />
                  </button>
                  <button
                    onClick={() => removeLevel(idx)}
                    className="p-0.5 text-slate-400 hover:text-rose-600"
                    title="Retirer ce niveau"
                  >
                    <X size={12} />
                  </button>
                </div>
                {broken && (
                  <div className="flex items-start gap-1 mt-1 text-[10px] text-amber-700">
                    <AlertTriangle size={10} className="mt-0.5 flex-shrink-0" />
                    <span>Champ désactivé dans la sync Airtable</span>
                  </div>
                )}
                {setGroupOrder && (
                  <div className="flex items-center gap-1 mt-1">
                    {hasOpts && (
                      <button
                        onClick={() => setLevelOrder(idx, 'default')}
                        className={orderBtnCls(order === 'default' || order == null)}
                        title={`Ordre des options (${col.options.slice(0, 3).join(', ')}${col.options.length > 3 ? '…' : ''})`}
                      >
                        Défaut
                      </button>
                    )}
                    <button
                      onClick={() => setLevelOrder(idx, 'asc')}
                      className={orderBtnCls(order === 'asc' || (order == null && !hasOpts))}
                      title="Tri alphabétique croissant"
                    >
                      <ChevronUp size={10} /> A → Z
                    </button>
                    <button
                      onClick={() => setLevelOrder(idx, 'desc')}
                      className={orderBtnCls(order === 'desc')}
                      title="Tri alphabétique décroissant"
                    >
                      <ChevronDown size={10} /> Z → A
                    </button>
                  </div>
                )}
              </div>
            )
          })}
          <div className="flex items-center gap-1">
            <button onClick={onExpandAll} className="flex items-center gap-1 flex-1 justify-center px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100 rounded border border-slate-200 transition-colors">
              <ChevronsUpDown size={11} /> Tout ouvrir
            </button>
            <button onClick={onCollapseAll} className="flex items-center gap-1 flex-1 justify-center px-2 py-1 text-[11px] text-slate-600 hover:bg-slate-100 rounded border border-slate-200 transition-colors">
              <ChevronsDownUp size={11} /> Tout fermer
            </button>
          </div>
          <button onClick={clearAll} className="w-full px-2 py-1 text-[11px] text-rose-600 hover:bg-rose-50 rounded border border-slate-200">
            Tout retirer
          </button>
        </div>
      )}

      <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">
        {groupByArr.length === 0 ? 'Choisir un champ' : 'Ajouter un niveau'}
      </div>
      <div className="relative mb-2">
        <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="w-full pl-7 pr-2 py-1.5 text-xs border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400"
          placeholder="Rechercher..."
          autoFocus
        />
      </div>
      <div className="space-y-0.5 max-h-60 overflow-y-auto">
        {filtered.length === 0
          ? <p className="text-xs text-slate-400 text-center py-2">{available.length === 0 ? 'Tous les champs sont utilisés' : 'Aucun résultat'}</p>
          : filtered.map(col => (
            <button
              key={col.id}
              onClick={() => addLevel(col.field)}
              className="flex items-center justify-between w-full px-2 py-1.5 rounded text-sm text-left transition-colors hover:bg-slate-50 text-slate-600"
            >
              {col.label}
              <Plus size={13} className="text-slate-400" />
            </button>
          ))}
      </div>
    </Panel>
  )
}

export function ViewToolbar({
  table,
  columns,
  sorts, setSorts,
  filters, setFilters,
  search, setSearch,
  searchFields = [],
  views = [],
  onReorderViews,
  activeViewId,
  setActiveViewId,
  patchLocalView,
  processedCount,
  visibleCols, setVisibleCols,
  groupBy, setGroupBy,
  groupOrder, setGroupOrder,
  colorRules, setColorRules,
  onCollapseAll, onExpandAll,
  data,
  disabledColumns = null,
  manageViews = false,
  manageViewsBulkDelete = false,
}) {
  const [openPanel, setOpenPanel] = useState(null)
  // Élément bouton servant d'ancre au panneau (rendu en portal position:fixed).
  const [panelAnchor, setPanelAnchor] = useState(null)
  const toolbarRef = useRef(null)

  function togglePanel(name, e) {
    if (openPanel === name) { setOpenPanel(null); return }
    const btn = e?.currentTarget
    if (btn) setPanelAnchor(btn)
    setOpenPanel(name)
  }
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const confirm = useConfirm()

  // Menu contextuel (clic droit, admin) sur un onglet de vue : renommer,
  // verrouiller/déverrouiller, supprimer — mêmes actions que la modale
  // « Gérer les vues » (crayon), sans avoir à l'ouvrir.
  // { x, y, viewId } + { renaming: true, name } en mode renommage inline.
  const [viewMenu, setViewMenu] = useState(null)

  // Vue verrouillée (lecture seule) : ses filtres/tris/colonnes ne peuvent pas
  // dériver. On désactive les panneaux de config et on bloque l'autosave.
  // Un ref garde la valeur fraîche pour les closures d'autosave (flushSave).
  const activeViewLocked = !!views.find(v => v.id === activeViewId)?.locked
  const lockedRef = useRef(activeViewLocked)
  lockedRef.current = activeViewLocked

  // Actions du menu contextuel de vue. Après chaque mutation, l'événement
  // `views:updated` force useTableView à recharger les pills (même mécanisme
  // que TableConfigModal).
  async function renameViewFromMenu() {
    const m = viewMenu
    const v = views.find(x => x.id === m?.viewId)
    const name = m?.name?.trim()
    setViewMenu(null)
    if (!v || !name || name === v.label) return
    try {
      await api.views.updatePill(table, v.id, { label: name })
      window.dispatchEvent(new CustomEvent('views:updated', { detail: { table } }))
    } catch {}
  }

  async function toggleViewLockFromMenu(v) {
    setViewMenu(null)
    try {
      await api.views.setPillLocked(table, v.id, !v.locked)
      window.dispatchEvent(new CustomEvent('views:updated', { detail: { table } }))
    } catch {}
  }

  async function deleteViewFromMenu(v) {
    setViewMenu(null)
    if (!(await confirm(`Supprimer la vue « ${v.label} » ?`))) return
    try {
      await api.views.deletePill(table, v.id)
      window.dispatchEvent(new CustomEvent('views:updated', { detail: { table } }))
    } catch {}
  }

  // Bouton « + » de la barre des vues (admin) : crée une vue vide et l'active
  // aussitôt. Le renommage / verrouillage / suppression se font ensuite par
  // clic droit sur l'onglet — plus besoin d'une modale « Gérer les vues ».
  async function createViewInline() {
    try {
      const pill = await api.views.createPill(table, {
        label: `Vue ${views.length + 1}`,
        color: 'blue',
        filters: [],
        visible_columns: [],
        sort: [],
        group_by: null,
        sort_order: views.length,
      })
      setActiveViewId?.(pill.id)
      window.dispatchEvent(new CustomEvent('views:updated', { detail: { table } }))
    } catch {}
  }

  const [draggingId, _setDraggingId] = useState(null)
  const draggingIdRef = useRef(null)
  function setDraggingId(v) { draggingIdRef.current = v; _setDraggingId(v) }
  const [dragPreview, _setDragPreview] = useState(null)
  const dragPreviewRef = useRef(null)
  function setDragPreview(v) { dragPreviewRef.current = v; _setDragPreview(v) }
  const tabsRef = useRef(null)
  const tabElsRef = useRef({})
  const flipRectsRef = useRef({})

  // Liste des onglets : uniquement les pills réelles. La vue virtuelle « Tous »
  // a été retirée — toutes les vues sont des pills configurables et supprimables.
  const mergedViews = views
    .map((v, i) => ({ ...v, __sortOrder: v.sort_order ?? i }))
    .sort((a, b) => a.__sortOrder - b.__sortOrder)

  const displayViews = dragPreview || mergedViews

  function captureRects() {
    const rects = {}
    for (const [id, el] of Object.entries(tabElsRef.current)) {
      if (el) rects[id] = el.getBoundingClientRect()
    }
    flipRectsRef.current = rects
  }

  // FLIP animation after reorder
  useLayoutEffect(() => {
    const prev = flipRectsRef.current
    if (!Object.keys(prev).length) return
    flipRectsRef.current = {}
    for (const [id, el] of Object.entries(tabElsRef.current)) {
      if (!el || !prev[id]) continue
      if (id === draggingIdRef.current) continue
      const newRect = el.getBoundingClientRect()
      const dx = prev[id].left - newRect.left
      if (Math.abs(dx) < 1) continue
      el.style.transform = `translateX(${dx}px)`
      el.style.transition = 'none'
      el.offsetHeight
      el.style.transition = 'transform 150ms ease'
      el.style.transform = ''
    }
  })

  // Auto-save view on any change (filters, sorts, visible columns, group by)
  const autoSaveRef = useRef(null)
  const pendingSaveRef = useRef(null)
  const flushSaveRef = useRef(null)

  function flushSave() {
    // Vue verrouillée : on n'écrit jamais (le serveur refuserait en 423).
    if (lockedRef.current) { pendingSaveRef.current = null; return }
    const p = pendingSaveRef.current
    if (!p) return
    pendingSaveRef.current = null
    clearTimeout(autoSaveRef.current)
    // group_by / group_order : envoyer null si vide pour éviter de stocker
    // des arrays vides ; sinon, envoyer tel quel — le serveur encode les
    // arrays en JSON et accepte aussi les strings (legacy single-level).
    const normGroupBy = Array.isArray(p.groupBy)
      ? (p.groupBy.length > 0 ? p.groupBy : null)
      : (p.groupBy || null)
    const normGroupOrder = Array.isArray(p.groupOrder)
      ? (p.groupOrder.length > 0 ? p.groupOrder : null)
      : (p.groupOrder || null)
    const payload = {
      sort: p.sorts,
      filters: p.filters || [],
      visible_columns: p.visibleCols || [],
      group_by: normGroupBy,
      group_order: normGroupOrder,
    }
    // color_rules : envoyé seulement si la feature est câblée sur cette table
    // (prop fournie) — sinon on écraserait les règles existantes avec [].
    if (p.colorRules !== undefined) payload.color_rules = p.colorRules || []
    api.views.updatePill(p.table, p.viewId, payload).catch(() => {})
    // Sync l'état local — sinon, au retour sur cette vue après en avoir
    // visité une autre, on relit la version pré-drag du `views` state et
    // l'autosave qui suit écrase la sauvegarde qu'on vient de faire.
    patchLocalView?.(p.viewId, payload)
  }
  flushSaveRef.current = flushSave

  const prevActiveViewIdRef = useRef(activeViewId)
  useEffect(() => {
    if (prevActiveViewIdRef.current && prevActiveViewIdRef.current !== activeViewId) {
      flushSaveRef.current()
    }
    prevActiveViewIdRef.current = activeViewId
  }, [activeViewId])

  useEffect(() => {
    if (!table) return
    if (activeViewId) {
      if (lockedRef.current) return // vue verrouillée : pas d'autosave
      pendingSaveRef.current = { table, viewId: activeViewId, sorts, filters, visibleCols, groupBy, groupOrder, colorRules }
      clearTimeout(autoSaveRef.current)
      autoSaveRef.current = setTimeout(() => flushSaveRef.current(), 600)
    } else if (visibleCols && visibleCols.length > 0) {
      try { localStorage.setItem(`erp_allView_cols_${table}`, JSON.stringify(visibleCols)) } catch {}
    }
  }, [table, activeViewId, sorts, filters, visibleCols, groupBy, groupOrder, colorRules])

  useEffect(() => {
    function onBeforeUnload() { flushSaveRef.current() }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      flushSaveRef.current()
    }
  }, [])


  // Vue verrouillée : fermer tout panneau de config ouvert (ex. ouvert avant
  // le verrouillage, ou via le clic-droit d'un header DataTable).
  useEffect(() => {
    if (activeViewLocked) setOpenPanel(null)
  }, [activeViewLocked])

  useEffect(() => {
    if (!openPanel) return
    function handler(e) {
      if (toolbarRef.current && !toolbarRef.current.contains(e.target) && !e.target.closest?.('[data-viewtoolbar-panel]') && !document.getElementById('field-select-portal')?.contains(e.target) && !document.getElementById('value-select-portal')?.contains(e.target)) setOpenPanel(null)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [openPanel])

  // Listen to context-menu requests from DataTable column headers — opens
  // the relevant toolbar panel (filter/sort/group/fields) and aligns it under
  // the matching toolbar button.
  useEffect(() => {
    function onOpenPanel(e) {
      if (e.detail?.table !== table) return
      const panel = e.detail?.panel
      if (!panel) return
      const btn = toolbarRef.current?.querySelector(`[data-panel-btn="${panel}"]`)
      if (btn) setPanelAnchor(btn)
      setOpenPanel(panel)
    }
    window.addEventListener('datatable:open-panel', onOpenPanel)
    return () => window.removeEventListener('datatable:open-panel', onOpenPanel)
  }, [table])

  const tabCls = (id) =>
    `px-4 py-2.5 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition-colors ${
      activeViewId === id
        ? 'border-brand-600 text-brand-600'
        : 'border-transparent text-slate-500 hover:text-slate-700 hover:border-slate-300'
    }`

  return (
    <div className="border-b border-slate-200">

      {/* View tabs — reorderable via pointer drag with live preview.
          Affichée aussi avec ≤1 vue quand la gestion des vues est active (admin) :
          le crayon en bout de barre remplace l'ancienne roue dentelée du header. */}
      {(displayViews.length > 1 || (manageViews && isAdmin)) && (
        <div ref={tabsRef} className="flex items-end gap-0 px-2 overflow-x-auto overflow-y-hidden border-b border-slate-200">
          {displayViews.map((v, _idx) => {
            const canDrag = isAdmin && !!onReorderViews
            const isDragging = draggingId === v.id
            return (
              <button
                key={v.id}
                ref={el => { if (el) tabElsRef.current[v.id] = el }}
                className={`${tabCls(v.id)} select-none ${isDragging ? 'opacity-40 scale-95' : ''}`}
                onClick={() => { if (!draggingId) { flushSave(); setActiveViewId(v.id) } }}
                onContextMenu={isAdmin ? (e) => {
                  e.preventDefault()
                  setViewMenu({ x: e.clientX, y: e.clientY, viewId: v.id })
                } : undefined}
                onPointerDown={canDrag ? (e) => {
                  if (e.button !== 0) return
                  setDraggingId(v.id)
                  setDragPreview([...mergedViews])
                  e.currentTarget.setPointerCapture(e.pointerId)
                } : undefined}
                onPointerMove={canDrag ? (e) => {
                  if (!draggingIdRef.current) return
                  const container = tabsRef.current
                  if (!container) return
                  const preview = dragPreviewRef.current || mergedViews
                  const dragIdx = preview.findIndex(x => x.id === draggingIdRef.current)
                  if (dragIdx === -1) return
                  const tabs = [...container.children]
                  let insertIdx = 0
                  let count = 0
                  for (let i = 0; i < tabs.length; i++) {
                    if (i === dragIdx) continue
                    const rect = tabs[i].getBoundingClientRect()
                    if (e.clientX > rect.left + rect.width / 2) insertIdx = count + 1
                    count++
                  }
                  const draggedItem = preview[dragIdx]
                  const without = preview.filter(x => x.id !== draggingIdRef.current)
                  const newPreview = [...without]
                  newPreview.splice(insertIdx, 0, draggedItem)
                  if (newPreview.every((x, i) => x.id === preview[i]?.id)) return
                  captureRects()
                  setDragPreview(newPreview)
                } : undefined}
                onPointerUp={canDrag ? () => {
                  if (!draggingIdRef.current) { setDraggingId(null); setDragPreview(null); return }
                  const preview = dragPreviewRef.current
                  if (preview) {
                    captureRects()
                    onReorderViews(preview)
                  }
                  setDraggingId(null)
                  setDragPreview(null)
                } : undefined}
                style={canDrag ? { cursor: isDragging ? 'grabbing' : 'grab' } : undefined}
              >
                <span className="inline-flex items-center gap-1">
                  {v.locked && <Lock size={11} className="text-amber-600 flex-shrink-0" title="Vue verrouillée (lecture seule)" />}
                  {v.label}
                </span>
              </button>
            )
          })}
          {manageViews && table && isAdmin && (
            <button
              onClick={createViewInline}
              data-testid="view-add-btn"
              className="self-center p-1.5 mx-1 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded transition-colors flex-shrink-0"
              title="Nouvelle vue"
            >
              <Plus size={16} />
            </button>
          )}
          {manageViews && table && isAdmin && manageViewsBulkDelete && (
            <TableConfigModal table={table} bulkDelete={manageViewsBulkDelete} />
          )}
        </div>
      )}

      {/* Menu contextuel de vue (clic droit sur un onglet, admin only).
          Position fixed → pas clippé par l'overflow-x-auto de la barre. */}
      {viewMenu && (() => {
        const v = views.find(x => x.id === viewMenu.viewId)
        if (!v) return null
        const itemCls = 'flex items-center gap-2 w-full px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 text-left'
        const lastView = views.length <= 1
        return (
          <>
            <div className="fixed inset-0 z-40" onClick={() => setViewMenu(null)} onContextMenu={e => { e.preventDefault(); setViewMenu(null) }} />
            <div
              data-testid="view-context-menu"
              className="fixed z-50 bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[200px]"
              style={{ top: viewMenu.y, left: viewMenu.x }}
            >
              {viewMenu.renaming ? (
                <div className="px-2 py-1 flex items-center gap-1.5">
                  <input
                    autoFocus
                    data-testid="view-rename-input"
                    value={viewMenu.name}
                    onChange={e => setViewMenu(m => ({ ...m, name: e.target.value }))}
                    onKeyDown={e => {
                      if (e.key === 'Enter') renameViewFromMenu()
                      if (e.key === 'Escape') setViewMenu(null)
                    }}
                    className="input text-sm flex-1 min-w-[160px]"
                  />
                  <button onClick={renameViewFromMenu} className="p-1 text-brand-600 hover:text-brand-800" title="Enregistrer">
                    <Check size={15} />
                  </button>
                </div>
              ) : (
                <>
                  {/* Vue verrouillée : renommage et suppression masqués (mêmes
                      règles que la modale « Gérer les vues ») — il faut d'abord
                      déverrouiller. */}
                  {!v.locked && (
                    <button
                      data-testid="view-menu-rename"
                      onClick={() => setViewMenu(m => ({ ...m, renaming: true, name: v.label }))}
                      className={itemCls}
                    >
                      <Pencil size={13} /> Renommer
                    </button>
                  )}
                  <button data-testid="view-menu-lock" onClick={() => toggleViewLockFromMenu(v)} className={itemCls}>
                    {v.locked ? <Unlock size={13} /> : <Lock size={13} />}
                    {v.locked ? 'Déverrouiller' : 'Verrouiller'}
                  </button>
                  {!v.locked && (
                    <>
                      <div className="my-1 border-t border-slate-100" />
                      <button
                        data-testid="view-menu-delete"
                        onClick={() => { if (!lastView) deleteViewFromMenu(v) }}
                        disabled={lastView}
                        title={lastView ? 'Impossible de supprimer la dernière vue' : undefined}
                        className={lastView
                          ? 'flex items-center gap-2 w-full px-3 py-1.5 text-sm text-slate-300 cursor-not-allowed text-left'
                          : 'flex items-center gap-2 w-full px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 text-left'}
                      >
                        <Trash2 size={13} /> Supprimer
                      </button>
                    </>
                  )}
                </>
              )}
            </div>
          </>
        )
      })()}

      {/* Toolbar */}
      <div ref={toolbarRef} className="relative">
        <div className="flex items-center gap-1 px-3 py-2 flex-wrap">

          {searchFields.length > 0 && (
            <div className="relative mr-2">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="input text-xs py-1.5 pl-7 pr-7 w-52"
                placeholder="Rechercher..."
              />
              {search && (
                <button onClick={() => setSearch('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-300 hover:text-slate-500">
                  <X size={12} />
                </button>
              )}
            </div>
          )}

          {visibleCols && setVisibleCols && (
            <ToolbarBtn icon={<Eye size={14} />} label="Champs" active={openPanel === 'fields'}
              dataPanelBtn="fields" disabled={activeViewLocked}
              onClick={(e) => togglePanel('fields', e)} />
          )}

          <ToolbarBtn icon={<Filter size={14} />} label="Filtrer" active={openPanel === 'filter'}
            badge={countFilterRules(filters)}
            dataPanelBtn="filter" disabled={activeViewLocked}
            onClick={(e) => togglePanel('filter', e)} />

          <ToolbarBtn icon={<ArrowUpDown size={14} />} label="Trier" active={openPanel === 'sort'}
            badge={sorts.length}
            dataPanelBtn="sort" disabled={activeViewLocked}
            onClick={(e) => togglePanel('sort', e)} />

          {setGroupBy && (
            <ToolbarBtn
              icon={<Layers size={14} />}
              label="Grouper"
              active={openPanel === 'group' || (Array.isArray(groupBy) ? groupBy.length > 0 : !!groupBy)}
              badge={Array.isArray(groupBy) && groupBy.length > 1 ? groupBy.length : 0}
              dataPanelBtn="group" disabled={activeViewLocked}
              onClick={(e) => togglePanel('group', e)} />
          )}

          {setColorRules && (
            <ToolbarBtn
              icon={<Paintbrush size={14} />}
              label="Couleur"
              active={openPanel === 'color'}
              badge={Array.isArray(colorRules) ? colorRules.length : 0}
              dataPanelBtn="color" disabled={activeViewLocked}
              onClick={(e) => togglePanel('color', e)} />
          )}

          {activeViewLocked && (
            <span
              className="flex items-center gap-1 px-2 py-1 text-xs font-medium text-amber-700 bg-amber-50 rounded"
              title="Vue verrouillée en lecture seule (modifiable par un admin via le menu des vues)"
            >
              <Lock size={12} /> Lecture seule
            </span>
          )}


          <span className="ml-auto text-xs text-slate-400 tabular-nums">
            {processedCount} ligne{processedCount !== 1 ? 's' : ''}
          </span>
        </div>

        {openPanel === 'fields' && visibleCols && setVisibleCols && (
          <FieldsPanel
            columns={columns.filter(c => !disabledColumns?.has(c.field) && !disabledColumns?.has(c.id))}
            visibleCols={visibleCols} onChange={setVisibleCols} anchorEl={panelAnchor}
          />
        )}
        {openPanel === 'filter' && (
          <FilterPanel
            columns={columns.filter(c => c.filterable !== false && !disabledColumns?.has(c.field) && !disabledColumns?.has(c.id))}
            filters={filters} onChange={setFilters} data={data} anchorEl={panelAnchor}
            disabledColumns={disabledColumns}
          />
        )}
        {openPanel === 'sort' && (
          <SortPanel
            columns={columns.filter(c => c.sortable !== false && !disabledColumns?.has(c.field) && !disabledColumns?.has(c.id))}
            sorts={sorts} onChange={setSorts} anchorEl={panelAnchor}
            disabledColumns={disabledColumns}
          />
        )}
        {openPanel === 'color' && setColorRules && (
          <ColorPanel
            columns={columns.filter(c => c.filterable !== false && !disabledColumns?.has(c.field) && !disabledColumns?.has(c.id))}
            rules={colorRules} onChange={setColorRules} data={data} anchorEl={panelAnchor}
            disabledColumns={disabledColumns}
          />
        )}
        {openPanel === 'group' && setGroupBy && (
          <GroupPanel
            columns={columns.filter(c => c.groupable !== false && !disabledColumns?.has(c.field) && !disabledColumns?.has(c.id))}
            groupBy={groupBy}
            onChange={setGroupBy}
            groupOrder={groupOrder}
            setGroupOrder={setGroupOrder}
            onCollapseAll={onCollapseAll} onExpandAll={onExpandAll} anchorEl={panelAnchor}
            disabledColumns={disabledColumns}
          />
        )}
      </div>
    </div>
  )
}
```


---

## `client/src/components/FilterRow.jsx`

Une ligne de filtre : champ / opérateur / valeur, tous les menus recherchables.

```jsx
import { useState, useRef, useEffect } from 'react'
import { createPortal } from 'react-dom'
import { X, Search, ChevronDown } from 'lucide-react'

export function FieldSelect({ columns, value, onChange, cls }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 })
  const btnRef = useRef(null)
  const inputRef = useRef(null)

  const selected = columns.find(c => c.field === value)
  const filtered = search
    ? columns.filter(c => c.label.toLowerCase().includes(search.toLowerCase()))
    : columns

  useEffect(() => {
    if (!open) return
    // Position dropdown relative to button using fixed coords
    const rect = btnRef.current?.getBoundingClientRect()
    if (rect) setPos({ top: rect.bottom + 4, left: rect.left, width: Math.max(rect.width, 224) })
    inputRef.current?.focus()
    function handler(e) {
      if (!btnRef.current?.contains(e.target) && !document.getElementById('field-select-portal')?.contains(e.target)) {
        setOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div className="relative flex-1 min-w-0">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`select ${cls} w-full flex items-center justify-between gap-1 text-left`}
      >
        <span className="truncate">{selected?.label || '—'}</span>
        <ChevronDown size={12} className="flex-shrink-0 text-slate-400" />
      </button>
      {open && createPortal(
        <div
          id="field-select-portal"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, zIndex: 9999 }}
          className="bg-white border border-slate-200 rounded-lg shadow-xl overflow-hidden"
        >
          <div className="p-2 border-b border-slate-100">
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                ref={inputRef}
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full pl-7 pr-2 py-1.5 text-xs border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400"
                placeholder="Rechercher un champ..."
              />
            </div>
          </div>
          <div className="max-h-52 overflow-y-auto">
            {filtered.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-3">Aucun résultat</p>
            ) : filtered.map(c => (
              <button
                key={c.id}
                type="button"
                onClick={() => { onChange(c.field); setOpen(false); setSearch('') }}
                className={`w-full text-left px-3 py-2 text-xs hover:bg-slate-50 transition-colors ${c.field === value ? 'text-brand-600 font-medium bg-brand-50' : 'text-slate-700'}`}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

// Searchable single-value picker for single_select / user filter values.
// Same portal + live-search pattern as FieldSelect, but options are plain strings.
export function ValueSelect({ options, value, onChange, cls, placeholder = '—' }) {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const [pos, setPos] = useState({ top: 0, left: 0, width: 0 })
  const btnRef = useRef(null)
  const inputRef = useRef(null)

  const filtered = search
    ? options.filter(o => o.toLowerCase().includes(search.toLowerCase()))
    : options

  useEffect(() => {
    if (!open) return
    const rect = btnRef.current?.getBoundingClientRect()
    if (rect) setPos({ top: rect.bottom + 4, left: rect.left, width: Math.max(rect.width, 224) })
    inputRef.current?.focus()
    function handler(e) {
      if (!btnRef.current?.contains(e.target) && !document.getElementById('value-select-portal')?.contains(e.target)) {
        setOpen(false)
        setSearch('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div className="relative flex-1 min-w-0">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`select ${cls} w-full flex items-center justify-between gap-1 text-left`}
      >
        <span className={`truncate ${value ? '' : 'text-slate-400'}`}>{value || placeholder}</span>
        <ChevronDown size={12} className="flex-shrink-0 text-slate-400" />
      </button>
      {open && createPortal(
        <div
          id="value-select-portal"
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: pos.width, zIndex: 9999 }}
          className="bg-white border border-slate-200 rounded-lg shadow-xl overflow-hidden"
        >
          <div className="p-2 border-b border-slate-100">
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                ref={inputRef}
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full pl-7 pr-2 py-1.5 text-xs border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400"
                placeholder="Rechercher une valeur..."
              />
            </div>
          </div>
          <div className="max-h-52 overflow-y-auto">
            <button
              type="button"
              onClick={() => { onChange(''); setOpen(false); setSearch('') }}
              className={`w-full text-left px-3 py-2 text-xs hover:bg-slate-50 transition-colors ${!value ? 'text-brand-600 font-medium bg-brand-50' : 'text-slate-400'}`}
            >
              —
            </button>
            {filtered.length === 0 ? (
              <p className="text-xs text-slate-400 text-center py-3">Aucun résultat</p>
            ) : filtered.map(o => (
              <button
                key={o}
                type="button"
                onClick={() => { onChange(o); setOpen(false); setSearch('') }}
                className={`w-full text-left px-3 py-2 text-xs hover:bg-slate-50 transition-colors ${o === value ? 'text-brand-600 font-medium bg-brand-50' : 'text-slate-700'}`}
              >
                {o}
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}

export const OPS_BY_TYPE = {
  text: [
    { value: 'contains',     label: 'Contient' },
    { value: 'not_contains', label: 'Ne contient pas' },
    { value: 'equals',       label: 'Est égal à' },
    { value: 'not_equals',   label: "N'est pas égal à" },
    { value: 'starts_with',  label: 'Commence par' },
    { value: 'ends_with',    label: 'Finit par' },
    { value: 'is_empty',     label: 'Est vide' },
    { value: 'is_not_empty', label: "N'est pas vide" },
  ],
  single_select: [
    { value: 'equals',       label: 'Est' },
    { value: 'not_equals',   label: "N'est pas" },
    { value: 'is_any_of',    label: "Est l'un des" },
    { value: 'is_none_of',   label: "N'est aucun des" },
    { value: 'is_empty',     label: 'Est vide' },
    { value: 'is_not_empty', label: "N'est pas vide" },
  ],
  multi_select: [
    { value: 'has_any_of',   label: "Contient l'un des" },
    { value: 'has_all_of',   label: 'Contient tous' },
    { value: 'has_none_of',  label: "Ne contient aucun des" },
    { value: 'is_empty',     label: 'Est vide' },
    { value: 'is_not_empty', label: "N'est pas vide" },
  ],
  number: [
    { value: 'equals',       label: 'Est égal à' },
    { value: 'not_equals',   label: "N'est pas égal à" },
    { value: 'gt',           label: 'Supérieur à' },
    { value: 'gte',          label: 'Supérieur ou égal à' },
    { value: 'lt',           label: 'Inférieur à' },
    { value: 'lte',          label: 'Inférieur ou égal à' },
    { value: 'is_empty',     label: 'Est vide' },
    { value: 'is_not_empty', label: "N'est pas vide" },
  ],
  date: [
    { value: 'equals',              label: 'Le' },
    { value: 'before',              label: 'Avant le' },
    { value: 'after',               label: 'Après le' },
    { value: 'between',             label: 'Est entre' },
    { value: 'last_n_days',         label: 'Il y a moins de X jours' },
    { value: 'more_than_n_days_ago', label: 'Il y a plus de X jours' },
    { value: 'next_n_days',         label: 'Dans les X prochains jours' },
    { value: 'more_than_n_days_ahead', label: 'Dans plus de X jours' },
    { value: 'today',               label: "Aujourd'hui" },
    { value: 'yesterday',           label: 'Hier' },
    { value: 'this_week',           label: 'Cette semaine' },
    { value: 'this_month',          label: 'Ce mois-ci' },
    { value: 'last_month',          label: 'Le mois dernier' },
    { value: 'is_empty',            label: 'Est vide' },
    { value: 'is_not_empty',        label: "N'est pas vide" },
  ],
  boolean: [
    { value: 'is_true',  label: 'Est vrai' },
    { value: 'is_false', label: 'Est faux' },
  ],
  user: [
    { value: 'is_me',        label: 'Est moi' },
    { value: 'is_not_me',    label: "N'est pas moi" },
    { value: 'equals',       label: 'Est' },
    { value: 'not_equals',   label: "N'est pas" },
    { value: 'is_any_of',    label: "Est l'un des" },
    { value: 'is_none_of',   label: "N'est aucun des" },
    { value: 'is_empty',     label: 'Est vide' },
    { value: 'is_not_empty', label: "N'est pas vide" },
  ],
}

export const VALUE_LESS_OPS = new Set([
  'is_empty', 'is_not_empty', 'is_true', 'is_false',
  'today', 'yesterday', 'this_week', 'this_month', 'last_month',
  'is_me', 'is_not_me',
])
export const MULTI_SELECT_OPS = new Set(['is_any_of', 'is_none_of', 'has_any_of', 'has_all_of', 'has_none_of'])
export const DAYS_OPS = new Set(['last_n_days', 'next_n_days', 'more_than_n_days_ago', 'more_than_n_days_ahead'])
export const DATE_PICKER_OPS = new Set(['before', 'after', 'equals'])
// Opérateurs de plage : la value est un tuple [from, to] (deux sélecteurs de date).
export const RANGE_OPS = new Set(['between'])

export function getFieldType(columns, fieldValue) {
  const col = columns.find(c => c.field === fieldValue)
  return col?.type || 'text'
}

export function getFieldOptions(columns, fieldValue, data) {
  const col = columns.find(c => c.field === fieldValue)
  // Normalize options: can be an array, an object with choices, or an object (Airtable metadata)
  let hardcoded = col?.options || []
  if (!Array.isArray(hardcoded)) {
    hardcoded = Array.isArray(hardcoded.choices) ? hardcoded.choices : []
  }
  // Les choix peuvent être des objets { id, label, color } (champs custom
  // single/multi select) — on ne garde que le label affichable.
  hardcoded = hardcoded
    .map(o => (o && typeof o === 'object') ? (o.label ?? o.value ?? '') : o)
    .filter(x => x !== '' && x != null)
  // Enrich with unique values from actual data
  if (data?.length && col?.field) {
    const fromData = new Set(hardcoded)
    for (const row of data) {
      const v = row[col.field]
      if (v === null || v === undefined || v === '') continue
      if (col.type === 'multi_select') {
        // Valeurs stockées en tableau JSON — on déplie chaque label.
        let arr = v
        if (typeof v === 'string' && v.startsWith('[')) { try { arr = JSON.parse(v) } catch { arr = [] } }
        if (Array.isArray(arr)) arr.forEach(x => { if (x != null && x !== '') fromData.add(String(x)) })
        else fromData.add(String(v))
      } else {
        fromData.add(String(v))
      }
    }
    return [...fromData].sort((a, b) => a.localeCompare(b, 'fr'))
  }
  return hardcoded
}

export function getOpsForType(type) {
  return OPS_BY_TYPE[type] || OPS_BY_TYPE.text
}

export function defaultOpForType(type) {
  if (type === 'boolean') return 'is_true'
  if (type === 'date') return 'before'
  if (type === 'number') return 'equals'
  if (type === 'single_select') return 'equals'
  if (type === 'multi_select') return 'has_any_of'
  if (type === 'user') return 'is_me'
  return 'contains'
}

export function FilterRow({ columns, filter, onChange, onRemove, size = 'sm', data }) {
  const filterableCols = columns.filter(c => c.filterable !== false && c.field)
  const fieldType = getFieldType(filterableCols, filter.field)
  const fieldOptions = getFieldOptions(filterableCols, filter.field, data)
  const ops = getOpsForType(fieldType)
  const needsValue = !VALUE_LESS_OPS.has(filter.op)
  const isMulti = MULTI_SELECT_OPS.has(filter.op)
  const isDays = DAYS_OPS.has(filter.op)
  const isDatePicker = DATE_PICKER_OPS.has(filter.op)
  const isRange = RANGE_OPS.has(filter.op)

  const cls = size === 'xs' ? 'text-xs py-1.5' : 'text-sm'

  // Plage de dates : value === [from, to]. On normalise pour tolérer un ancien
  // format scalaire ou un tableau incomplet.
  const range = Array.isArray(filter.value) ? filter.value : ['', '']
  function setRange(idx, v) {
    const next = [range[0] ?? '', range[1] ?? '']
    next[idx] = v
    onChange({ ...filter, value: next })
  }

  const selectedValues = isMulti
    ? (Array.isArray(filter.value) ? filter.value : (filter.value ? [filter.value] : []))
    : []

  function toggleMultiValue(opt) {
    const next = selectedValues.includes(opt)
      ? selectedValues.filter(v => v !== opt)
      : [...selectedValues, opt]
    onChange({ ...filter, value: next })
  }

  return (
    <div className="flex items-start gap-2 flex-wrap">
      <FieldSelect
        columns={filterableCols}
        value={filter.field}
        cls={cls}
        onChange={field => {
          const newType = getFieldType(filterableCols, field)
          onChange({ field, op: defaultOpForType(newType), value: '' })
        }}
      />
      <select
        value={filter.op}
        onChange={e => {
          const newOp = e.target.value
          const newVal = VALUE_LESS_OPS.has(newOp) ? '' : RANGE_OPS.has(newOp) ? ['', ''] : MULTI_SELECT_OPS.has(newOp) ? [] : (Array.isArray(filter.value) ? '' : filter.value)
          onChange({ ...filter, op: newOp, value: newVal })
        }}
        className={`select ${cls} flex-1 min-w-0`}
      >
        {ops.map(op => <option key={op.value} value={op.value}>{op.label}</option>)}
      </select>

      {needsValue && (fieldType === 'single_select' || fieldType === 'user') && !isMulti && (
        <ValueSelect
          options={fieldOptions}
          value={filter.value}
          cls={cls}
          onChange={v => onChange({ ...filter, value: v })}
        />
      )}
      {needsValue && (fieldType === 'single_select' || fieldType === 'user' || fieldType === 'multi_select') && isMulti && (
        <div className="flex-1 min-w-0 border border-slate-200 rounded-lg bg-white max-h-40 overflow-y-auto">
          {fieldOptions.map(o => (
            <label key={o} className="flex items-center gap-2 px-3 py-1.5 hover:bg-slate-50 cursor-pointer">
              <input
                type="checkbox"
                checked={selectedValues.includes(o)}
                onChange={() => toggleMultiValue(o)}
                className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              <span className={`${size === 'xs' ? 'text-xs' : 'text-sm'} text-slate-700`}>{o}</span>
            </label>
          ))}
          {selectedValues.length > 0 && (
            <div className="px-3 py-1 border-t border-slate-100 text-xs text-slate-400">
              {selectedValues.length} sélectionné{selectedValues.length > 1 ? 's' : ''}
            </div>
          )}
        </div>
      )}
      {needsValue && fieldType === 'date' && isDatePicker && (
        <input type="date" value={filter.value} onChange={e => onChange({ ...filter, value: e.target.value })} className={`input ${cls} flex-1 min-w-0`} />
      )}
      {needsValue && fieldType === 'date' && isDays && (
        <input type="number" min="1" value={filter.value} onChange={e => onChange({ ...filter, value: e.target.value })} className={`input ${cls} flex-1 min-w-0`} placeholder="Jours" />
      )}
      {needsValue && fieldType === 'date' && isRange && (
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <input type="date" value={range[0] ?? ''} max={range[1] || undefined} onChange={e => setRange(0, e.target.value)} className={`input ${cls} flex-1 min-w-0`} />
          <span className="text-xs text-slate-400 flex-shrink-0">et</span>
          <input type="date" value={range[1] ?? ''} min={range[0] || undefined} onChange={e => setRange(1, e.target.value)} className={`input ${cls} flex-1 min-w-0`} />
        </div>
      )}
      {needsValue && fieldType === 'number' && (
        <input type="number" value={filter.value} onChange={e => onChange({ ...filter, value: e.target.value })} className={`input ${cls} flex-1 min-w-0`} placeholder="Valeur" />
      )}
      {needsValue && fieldType !== 'single_select' && fieldType !== 'multi_select' && fieldType !== 'user' && fieldType !== 'date' && fieldType !== 'number' && fieldType !== 'boolean' && (
        <input value={filter.value} onChange={e => onChange({ ...filter, value: e.target.value })} className={`input ${cls} flex-1 min-w-0`} placeholder="Valeur" />
      )}

      <button onClick={onRemove} className="text-slate-300 hover:text-red-500 flex-shrink-0 mt-1"><X size={14} /></button>
    </div>
  )
}
```


---

## `client/src/components/RecordPeekDrawer.jsx`

Side-peek : la page détail montée dans un panneau latéral (`recordId` / `embedded`).

```jsx
import { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router-dom'
import { X, Maximize2 } from 'lucide-react'
import api from '../lib/api.js'

// Drawer latéral (side-peek à la Airtable) : ouvre l'aperçu/édition d'un
// enregistrement par-dessus la liste, sans quitter le contexte de la table.
// Le contenu (`children`) est typiquement une page *Detail.jsx rendue en mode
// `embedded` — l'autosave, le realtime et le chargement restent gérés par la
// fiche elle-même.
//
// Largeur redimensionnable : l'utilisateur tire la frontière gauche du panneau
// pour l'élargir/rétrécir. La largeur choisie est persistée comme préférence
// par utilisateur (PATCH /auth/preferences → peek_width) et réutilisée à la
// prochaine ouverture, sur tous les side-peek de l'app.
//
// Props :
//  - open        : bool — visibilité.
//  - onClose     : () => void — fermeture (overlay, bouton ×, Échap).
//  - title       : string — titre affiché dans l'en-tête du drawer.
//  - subtitle    : string | undefined — sous-titre discret (entreprise, courriel…).
//  - to          : string | undefined — route de la fiche complète ; affiche le
//                  bouton « ouvrir en grand » qui navigue et ferme le drawer.
//  - width       : number — largeur par défaut en px (défaut 560), utilisée tant
//                  que l'utilisateur n'a pas défini de préférence.
//  - children    : contenu du corps (scrollable).

const MIN_WIDTH = 360
// Marge minimale (px) laissée visible à gauche du panneau pour garder l'accès à
// la liste sous-jacente / l'overlay.
const EDGE_MARGIN = 80

// Cache module : la préférence de largeur est partagée par toutes les instances
// et mémorisée entre ouvertures pour éviter de re-fetch et pour un rendu instant.
const prefCache = { loaded: false, width: null }

function maxWidth() {
  return Math.max(MIN_WIDTH, window.innerWidth - EDGE_MARGIN)
}

function clampWidth(w) {
  return Math.min(Math.max(w, MIN_WIDTH), maxWidth())
}

export default function RecordPeekDrawer({ open, onClose, title, subtitle, to, width = 560, children }) {
  const navigate = useNavigate()
  const panelRef = useRef(null)
  const [panelWidth, setPanelWidth] = useState(() => clampWidth(prefCache.width ?? width))
  const [resizing, setResizing] = useState(false)

  // Charge la préférence de largeur persistée (une seule fois par session).
  useEffect(() => {
    if (!open || prefCache.loaded) return
    let cancelled = false
    api.auth.getPreferences()
      .then((d) => {
        prefCache.loaded = true
        const w = Number(d?.peek_width)
        if (Number.isFinite(w) && w > 0) {
          prefCache.width = w
          if (!cancelled) setPanelWidth(clampWidth(w))
        }
      })
      .catch(() => { prefCache.loaded = true })
    return () => { cancelled = true }
  }, [open])

  // Applique la préférence en cache à chaque (ré)ouverture, et re-borne si la
  // fenêtre a été redimensionnée entre-temps.
  useEffect(() => {
    if (!open) return
    setPanelWidth(clampWidth(prefCache.width ?? width))
  }, [open, width])

  // Verrou du scroll du body tant que le drawer est ouvert.
  useEffect(() => {
    if (!open) return
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [open])

  // Fermeture sur Échap. stopPropagation pour ne pas fermer aussi une modale
  // sous-jacente éventuelle.
  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose?.() } }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const persistWidth = useCallback((w) => {
    const rounded = Math.round(w)
    if (prefCache.width === rounded) return
    prefCache.width = rounded
    prefCache.loaded = true
    api.auth.updatePreferences({ peek_width: rounded })
      .catch((err) => console.error('[peekDrawer] échec sauvegarde largeur:', err))
  }, [])

  // Drag de la poignée gauche : la largeur = distance du bord droit de l'écran
  // au curseur. Persistée au relâchement.
  const startResize = useCallback((e) => {
    e.preventDefault()
    setResizing(true)
    const onMove = (ev) => {
      const clientX = ev.touches ? ev.touches[0].clientX : ev.clientX
      setPanelWidth(clampWidth(window.innerWidth - clientX))
    }
    const onUp = () => {
      setResizing(false)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onUp)
      setPanelWidth((w) => { persistWidth(w); return w })
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
    document.addEventListener('touchmove', onMove, { passive: false })
    document.addEventListener('touchend', onUp)
  }, [persistWidth])

  if (!open) return null

  function openFull() {
    if (!to) return
    onClose?.()
    navigate(to)
  }

  return createPortal(
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" data-testid="record-peek-drawer">
      <div className="fixed inset-0 bg-black/40 animate-fade-in" onClick={onClose} />
      <div
        ref={panelRef}
        className={`fixed top-0 right-0 bottom-0 bg-slate-50 shadow-2xl flex flex-col ${resizing ? 'select-none' : 'animate-slide-in-right'}`}
        style={{ width: `${panelWidth}px`, maxWidth: '100vw' }}
      >
        {/* Poignée de redimensionnement sur la frontière gauche du panneau. */}
        <div
          onMouseDown={startResize}
          onTouchStart={startResize}
          data-testid="record-peek-resizer"
          role="separator"
          aria-orientation="vertical"
          aria-label="Redimensionner le panneau"
          title="Glisser pour redimensionner"
          className="group absolute top-0 left-0 bottom-0 w-2 -ml-1 cursor-col-resize z-10 flex items-center justify-center"
        >
          <div className={`h-full w-px transition-colors ${resizing ? 'bg-brand-500' : 'bg-transparent group-hover:bg-brand-400'}`} />
        </div>
        <div className="flex items-center gap-1.5 px-4 py-3 border-b border-slate-200 bg-white flex-shrink-0">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold text-slate-900 truncate" data-testid="record-peek-title">{title}</div>
            {subtitle && <div className="text-xs text-slate-400 truncate">{subtitle}</div>}
          </div>
          {to && (
            <button
              onClick={openFull}
              data-testid="record-peek-expand"
              title="Ouvrir la fiche complète"
              aria-label="Ouvrir la fiche complète"
              className="p-1.5 text-slate-400 hover:text-brand-600 hover:bg-slate-100 rounded-lg transition-colors"
            >
              <Maximize2 size={16} />
            </button>
          )}
          <button
            onClick={onClose}
            data-testid="record-peek-close"
            aria-label="Fermer"
            className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
          >
            <X size={18} />
          </button>
        </div>
        {/* Overlay transparent pendant le drag : capte les events pour que le
            survol d'un iframe/embed ne coupe pas le mousemove. */}
        {resizing && <div className="absolute inset-0 z-20 cursor-col-resize" />}
        <div className="overflow-y-auto flex-1" data-testid="record-peek-body">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  )
}
```


---

## `client/src/components/RecordHistory.jsx`

Historique des modifications d'un record.

```jsx
// Panneau « Historique » réutilisable par enregistrement.
//
// Affiche la timeline « qui a fait quoi, quand » d'un record, alimentée par
// GET /api/records/:table/:id/history (activity_log + change_log côté serveur).
// Calqué sur le HistoryTab de SaleReceiptDetail, mais générique : n'importe
// quelle fiche détail le branche avec sa table et l'id du record.
//
// Usage :
//   <RecordHistory table="companies" id={company.id} />
//
// Le chargement est paresseux : passer `active={false}` (ex. onglet fermé)
// diffère le fetch jusqu'à ce que le panneau soit réellement affiché.

import { useEffect, useState } from 'react'
import { Plus, Pencil, Trash2, Clock, RefreshCw } from 'lucide-react'
import api from '../lib/api.js'
import { fmtDateTime } from '../lib/formatDate.js'

const ACTION_META = {
  created:  { label: 'Créé',      Icon: Plus,      color: 'text-green-700 bg-green-100' },
  create:   { label: 'Créé',      Icon: Plus,      color: 'text-green-700 bg-green-100' },
  updated:  { label: 'Modifié',   Icon: Pencil,    color: 'text-blue-700 bg-blue-100' },
  update:   { label: 'Modifié',   Icon: Pencil,    color: 'text-blue-700 bg-blue-100' },
  deleted:  { label: 'Supprimé',  Icon: Trash2,    color: 'text-red-700 bg-red-100' },
  delete:   { label: 'Supprimé',  Icon: Trash2,    color: 'text-red-700 bg-red-100' },
}

export default function RecordHistory({ table, id, active = true }) {
  const [events, setEvents] = useState(null)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (!active || !table || !id) return
    let cancelled = false
    setEvents(null)
    setError(false)
    api.records.history(table, id)
      .then(r => { if (!cancelled) setEvents(r.data || []) })
      .catch(() => { if (!cancelled) { setEvents([]); setError(true) } })
    return () => { cancelled = true }
  }, [table, id, active])

  if (!active) return null
  if (events === null) {
    return <div className="py-8 text-center text-slate-400 text-sm" data-testid="record-history-loading">Chargement de l'historique…</div>
  }
  if (error) {
    return <div className="py-8 text-center text-slate-400 text-sm" data-testid="record-history-error">Impossible de charger l'historique.</div>
  }
  if (events.length === 0) {
    return <div className="py-8 text-center text-slate-400 text-sm" data-testid="record-history-empty">Aucun historique.</div>
  }

  return (
    <ol className="relative border-l border-slate-200 ml-3" data-testid="record-history">
      {events.map(ev => {
        const meta = ACTION_META[ev.action] || { label: ev.action, Icon: Clock, color: 'text-slate-600 bg-slate-100' }
        const { Icon } = meta
        const isSystem = ev.source === 'system'
        // « Modifié » sans acteur humain = sync externe (Airtable/Stripe/Gmail) ;
        // on le signale avec une icône dédiée pour distinguer du système.
        const ShownIcon = isSystem && (ev.action === 'updated' || ev.action === 'update') ? RefreshCw : Icon
        const actor = ev.user_name || (isSystem ? 'Synchronisation / système' : 'Utilisateur inconnu')
        return (
          <li key={ev.id} className="mb-6 ml-6" data-testid="record-history-event">
            <span className={`absolute -left-3 flex items-center justify-center w-6 h-6 rounded-full ring-4 ring-white ${meta.color}`}>
              <ShownIcon size={12} />
            </span>
            <div className="flex items-baseline justify-between gap-3">
              <p className="text-sm text-slate-800">
                {meta.label}
                {ev.detail && <span className="text-slate-500"> — {ev.detail}</span>}
              </p>
              <span className="text-xs text-slate-400 whitespace-nowrap">{fmtDateTime(ev.created_at)}</span>
            </div>
            <p className="text-xs text-slate-500 mt-0.5" data-testid="record-history-actor">par {actor}</p>
          </li>
        )
      })}
    </ol>
  )
}
```


---

## `client/src/components/Attachments.jsx`

Pièces jointes : dépôt, aperçu, suppression.

```jsx
import { useState, useEffect, useCallback, useRef } from 'react'
import { Upload, FileText, Image as ImageIcon, Download, Trash2, Loader2, Paperclip } from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from '../contexts/ToastContext.jsx'
import { useConfirm } from './ConfirmProvider.jsx'

function formatBytes(n) {
  if (!n && n !== 0) return ''
  if (n < 1024) return `${n} o`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`
  return `${(n / (1024 * 1024)).toFixed(1)} Mo`
}

function isImage(ct, name) {
  if (ct && ct.startsWith('image/')) return true
  return /\.(jpe?g|png|gif|webp|heic)$/i.test(name || '')
}

/**
 * Composant de pièces jointes réutilisable, attachable à n'importe quelle
 * entité via (entityType, entityId). Glisser-déposer + clic pour parcourir,
 * liste avec téléchargement et suppression. Upload immédiat (pas de bouton
 * « Enregistrer » — conforme à la règle autosave).
 *
 * Props :
 *  - entityType : 'companies' | 'contacts' | 'orders' | 'tickets' | … (whitelist serveur)
 *  - entityId   : id de l'enregistrement cible
 *  - title      : titre de section (défaut « Pièces jointes »)
 *  - compact    : variante condensée (sans carte/titre) pour insertion en sidebar
 */
export default function Attachments({ entityType, entityId, title = 'Pièces jointes', compact = false }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef()
  const { addToast } = useToast()
  const confirm = useConfirm()

  const load = useCallback(async () => {
    if (!entityType || !entityId) return
    setLoading(true)
    try {
      const data = await api.attachments.list(entityType, entityId)
      setItems(data)
    } catch (e) {
      addToast({ message: `Chargement des pièces jointes échoué : ${e.message}`, type: 'error' })
    } finally {
      setLoading(false)
    }
  }, [entityType, entityId, addToast])

  useEffect(() => { load() }, [load])

  async function handleFiles(fileList) {
    const files = Array.from(fileList || [])
    if (!files.length) return
    setUploading(true)
    try {
      await api.attachments.upload(entityType, entityId, files)
      addToast({ message: files.length > 1 ? `${files.length} fichiers ajoutés` : 'Fichier ajouté', type: 'success' })
      await load()
    } catch (e) {
      addToast({ message: `Téléversement échoué : ${e.message}`, type: 'error' })
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  async function handleDownload(att) {
    try {
      const { blob, filename } = await api.attachments.download(entityType, entityId, att.id)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename || att.file_name
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) {
      addToast({ message: `Téléchargement échoué : ${e.message}`, type: 'error' })
    }
  }

  async function handleDelete(att) {
    if (!(await confirm(`Supprimer « ${att.file_name} » ?`))) return
    try {
      await api.attachments.delete(entityType, entityId, att.id)
      setItems(prev => prev.filter(x => x.id !== att.id))
      addToast({ message: 'Pièce jointe supprimée', type: 'success' })
    } catch (e) {
      addToast({ message: `Suppression échouée : ${e.message}`, type: 'error' })
    }
  }

  const dropZone = (
    <div
      data-testid="attachment-dropzone"
      className={`relative border-2 border-dashed rounded-xl px-4 py-5 text-center cursor-pointer transition-colors
        ${dragOver ? 'border-brand-500 bg-brand-50' : 'border-slate-300 hover:border-slate-400 bg-slate-50'}
        ${uploading ? 'opacity-60 pointer-events-none' : ''}`}
      onDragOver={e => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files) }}
      onClick={() => inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        data-testid="attachment-input"
        onChange={e => handleFiles(e.target.files)}
      />
      {uploading ? (
        <div className="flex items-center justify-center gap-2 text-slate-600">
          <Loader2 size={16} className="text-brand-500 animate-spin" />
          <span className="text-sm font-medium">Téléversement en cours…</span>
        </div>
      ) : (
        <div className="flex items-center justify-center gap-3 text-slate-500">
          <Upload size={18} className="text-brand-600" />
          <span className="text-sm font-medium">Glissez des fichiers ici ou cliquez pour parcourir</span>
        </div>
      )}
    </div>
  )

  const list = (
    loading ? (
      <div className="flex items-center gap-2 text-sm text-slate-400 py-3">
        <Loader2 size={14} className="animate-spin" /> Chargement…
      </div>
    ) : items.length === 0 ? (
      <p className="text-sm text-slate-400 py-2">Aucune pièce jointe.</p>
    ) : (
      <ul className="divide-y divide-slate-100" data-testid="attachment-list">
        {items.map(att => (
          <li key={att.id} className="flex items-center gap-3 py-2.5" data-testid="attachment-item">
            <span className="flex-shrink-0 text-slate-400">
              {isImage(att.content_type, att.file_name) ? <ImageIcon size={16} /> : <FileText size={16} />}
            </span>
            <div className="min-w-0 flex-1">
              <button
                onClick={() => handleDownload(att)}
                className="text-sm text-slate-800 hover:text-brand-600 hover:underline truncate block max-w-full text-left"
                title={att.file_name}
              >
                {att.file_name}
              </button>
              <div className="text-xs text-slate-400 mt-0.5">
                {formatBytes(att.file_size)}
                {att.uploaded_by_name ? ` · ${att.uploaded_by_name}` : ''}
              </div>
            </div>
            <div className="flex gap-1 flex-shrink-0">
              <button onClick={() => handleDownload(att)} className="text-slate-400 hover:text-brand-600 p-1" title="Télécharger">
                <Download size={14} />
              </button>
              <button onClick={() => handleDelete(att)} className="text-slate-400 hover:text-red-500 p-1" title="Supprimer">
                <Trash2 size={14} />
              </button>
            </div>
          </li>
        ))}
      </ul>
    )
  )

  if (compact) {
    return (
      <div className="space-y-3" data-testid="attachments">
        {dropZone}
        {list}
      </div>
    )
  }

  return (
    <div className="card p-6" data-testid="attachments">
      <div className="flex items-center gap-2 mb-4">
        <Paperclip size={15} className="text-slate-500" />
        <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
        {items.length > 0 && (
          <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">{items.length}</span>
        )}
      </div>
      {dropZone}
      <div className="mt-3">{list}</div>
    </div>
  )
}
```
