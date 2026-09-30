// Looks — les dix ambiances du design QNE « salle de lecture »
// (QNE-design-reference.html, section 6). Chaque look est posé par
// `data-look="<id>"` sur <html> ; tailwind.config.js en dérive les rampes
// Tailwind (slate/gray/white/brand) et publie aussi les variables brutes
// (`--c-bg`, `--c-accent`, `--pnl`…). Le sous-arbre `.look-panel` (barre
// latérale) reçoit les couleurs du panneau.
// Pur JS sans import : lu à la fois par Tailwind (Node) et par le client.
//
// Jour : page crème, encre de la couleur du panneau, or foncé pour ce qui
// porte le sens (titres, liens, élément courant), panneau d'un seul ton
// profond. Nuit : fond d'un ton profond de la même couleur, texte blanc
// cassé, titres couleur pierre. Candlelit : nuit brun chaud, texte ambre.

function hex(c) { const n = parseInt(c.slice(1), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255] }
// Part `t` de `b` dans `a` (0 = a pur, 1 = b pur).
function mix(a, b, t) {
  const A = hex(a), B = hex(b)
  return '#' + A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('')
}

const CREAM = '#f2ecdf'
const PANEL_INK = '#f1e8d4'
const PANEL_GOLD = '#e2bf76'
const WARM_GREY = '#7b7572'

// Panneau (barre latérale) : un ton profond de la couleur, texte crème, or.
function panelVars(bg, ink, gold) {
  return {
    '--c-bg': bg, '--c-bg-2': bg,
    '--c-surface': mix(bg, ink, 0.08), '--c-surface-2': mix(bg, ink, 0.1), '--c-surface-3': mix(bg, ink, 0.18),
    '--c-border': mix(bg, ink, 0.14), '--c-border-2': mix(bg, ink, 0.22), '--c-border-3': mix(bg, ink, 0.35),
    '--c-ink': ink, '--c-ink-2': mix(bg, ink, 0.86), '--c-ink-3': mix(gold, ink, 0.55),
    '--c-ink-4': mix(gold, ink, 0.55), '--c-ink-5': mix(bg, ink, 0.62),
    '--c-accent': gold, '--c-on-accent': bg,
  }
}

function dayLook(id, name, pnl, ink, title = '#75561d') {
  const deep = mix(pnl, '#000000', 0.3)
  return {
    id, name, mode: 'light',
    vars: {
      '--pnl': pnl, '--c-title': title,
      '--c-bg': CREAM, '--c-bg-2': '#ece6da',
      '--c-surface': '#f9f6ef', '--c-surface-2': '#ebe4d6', '--c-surface-3': '#dfd8ca',
      '--c-border': '#dcd3c1', '--c-border-2': '#cdc5b7', '--c-border-3': '#b6b1a7',
      '--c-ink': ink, '--c-ink-2': mix(ink, WARM_GREY, 0.3), '--c-ink-3': mix(ink, WARM_GREY, 0.62),
      '--c-ink-4': mix(ink, WARM_GREY, 0.82), '--c-ink-5': WARM_GREY,
      '--c-accent': title, '--c-on-accent': PANEL_INK,
      '--orb-1': title, '--orb-2': '#e1d1b5', '--orb-inv': '0',
    },
    panel: panelVars(deep, PANEL_INK, PANEL_GOLD),
  }
}

function nightLook(id, name, pnl) {
  const ink = '#e4e2dc', title = '#d8d2c2'
  const bg = mix(pnl, '#000000', 0.45)
  return {
    id, name, mode: 'dark',
    vars: {
      '--pnl': mix(pnl, '#000000', 0.62), '--c-title': title,
      '--c-bg': bg, '--c-bg-2': mix(pnl, '#000000', 0.55),
      '--c-surface': mix(pnl, '#000000', 0.34), '--c-surface-2': mix(pnl, '#000000', 0.26), '--c-surface-3': mix(pnl, '#000000', 0.16),
      '--c-border': mix(pnl, '#ffffff', 0.1), '--c-border-2': mix(pnl, '#ffffff', 0.18), '--c-border-3': mix(pnl, '#ffffff', 0.3),
      '--c-ink': ink, '--c-ink-2': '#cfccc4', '--c-ink-3': '#aaa79f', '--c-ink-4': '#95928b', '--c-ink-5': '#827f79',
      '--c-accent': title, '--c-on-accent': '#15171b',
      '--orb-1': mix(pnl, '#ffffff', 0.25), '--orb-2': title, '--orb-inv': '1',
    },
    panel: panelVars(mix(pnl, '#000000', 0.55), ink, title),
  }
}

const candle = {
  id: 'candle', name: 'Candlelit library', mode: 'dark',
  vars: {
    '--pnl': '#20160e', '--c-title': '#e0a95a',
    '--c-bg': '#1a120c', '--c-bg-2': '#170f0a',
    '--c-surface': '#221710', '--c-surface-2': '#2a1d13', '--c-surface-3': '#3a2716',
    '--c-border': '#3a2a1b', '--c-border-2': '#4a3622', '--c-border-3': '#5e4630',
    '--c-ink': '#e8d3ad', '--c-ink-2': '#d4bd97', '--c-ink-3': '#b59c78', '--c-ink-4': '#9d8566', '--c-ink-5': '#877156',
    '--c-accent': '#e0a95a', '--c-on-accent': '#1a120c',
    '--orb-1': '#8a5a1f', '--orb-2': '#e0a95a', '--orb-inv': '1',
  },
  panel: panelVars('#1d140d', '#e8d3ad', '#e0a95a'),
}

// Une ligne du sélecteur = une couleur : son look de jour, son look de nuit.
export const LOOK_ROWS = [
  ['Navy', dayLook('creamnavy', 'Navy', '#2c3e5c', '#1d2a40'), nightLook('nightnavy', 'Navy, starlit', '#2c3e5c')],
  ['Slate teal', dayLook('creamteal', 'Slate teal', '#2e454b', '#1b2b2f'), nightLook('nightteal', 'Slate teal, starlit', '#2e454b')],
  ['Dark olive', dayLook('creamolive', 'Dark olive', '#363a1f', '#252815'), nightLook('nightolive', 'Dark olive, starlit', '#363a1f')],
  ['Rosewood', dayLook('creamrose', 'Rosewood', '#3b1a1c', '#2e1618'), nightLook('nightrose', 'Rosewood, starlit', '#3b1a1c')],
  ['Candlelit', dayLook('creamcandle', 'Candlelit', '#3a2716', '#2b1d12', '#8a5a1f'), candle],
]

export const LOOKS = LOOK_ROWS.flatMap(([, day, night]) => [day, night])

// Couleurs actuelles de Boréal (rampe crème / nuit de tailwind.config.js).
// « Automatique » alterne entre ces deux-là : ceux qui n'ont rien choisi
// gardent l'app telle qu'elle était.
export const CLASSIC = [
  { id: 'light', name: 'Boréal', mode: 'light' },
  { id: 'dark', name: 'Boréal, nuit', mode: 'dark' },
]

export const ALL_LOOKS = [...CLASSIC, ...LOOKS]
export const AUTO_LIGHT = 'light'
export const AUTO_DARK = 'dark'
