import { useMemo, useRef, useState } from 'react'

// Vue 3D d'une serre, rendue en SVG (aucune dépendance 3D : projection
// perspective maison, tri en peintre, ombrage par normale).
//
// Chaque question du formulaire de découverte passe un `focus` : la scène ne
// dessine que ce qui éclaire la question, et met en évidence les pièces
// concernées (les autres restent en contexte, atténuées). La liste des focus
// vit dans lib/greenhouseFocus.js — c'est elle que les pages consultent.
//
// Couleurs : variables Tailwind (`--c-<rampe>-<nuance>`), donc le mode nuit
// suit tout seul. L'ombrage choisit une nuance de la rampe plutôt que de mixer
// des couleurs, ce qui garde l'ensemble cohérent dans les deux thèmes.

const L = 12          // longueur (x)
const W = 6           // largeur (z)
const WALL = 1.9      // hauteur des côtés
const PEAK = 4.6      // hauteur au faîte

const SHADES = [100, 200, 300, 400, 500, 600, 700, 800, 900]
const LIGHT = norm([0.42, 0.86, 0.3])

const FILM = { ramp: 'sky', shade: 200, opacity: 0.32 }
const GLASS = { ramp: 'sky', shade: 300, opacity: 0.5 }
const FRAME = { ramp: 'slate', shade: 500, w: 1.3 }
const HOOP = { ramp: 'slate', shade: 400, w: 1.1 }
const PIPE = { ramp: 'slate', shade: 500, w: 2.2 }
const GROUND = { ramp: 'brand', shade: 200, opacity: 0.45, flat: true }
const SOIL = { ramp: 'brand', shade: 300, opacity: 0.5 }
const METAL = { ramp: 'slate', shade: 600 }
const HEAT = { ramp: 'orange', shade: 400, keep: true }
const WATER = { ramp: 'cyan', shade: 400, w: 1.6 }
const WIRE = { ramp: 'amber', shade: 500, w: 1.2 }
const DIM = { ramp: 'slate', shade: 500, w: 1.1 }
const WOOD = { ramp: 'amber', shade: 300, keep: true }

const ACCENT_FACE = { ramp: 'brand', shade: 400, opacity: 0.75 }
const ACCENT_LINE = { ramp: 'brand', shade: 600, w: 2.6 }

/* ── Petite algèbre ────────────────────────────────────────────────────── */

function norm(v) {
  const n = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / n, v[1] / n, v[2] / n]
}

function faceNormal(pts) {
  const [a, b, c] = pts
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
  const v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
  return norm([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]])
}

function tone(mat, lit) {
  const i = SHADES.indexOf(mat.shade)
  const off = mat.flat ? 0 : lit > 0.78 ? -1 : lit > 0.5 ? 0 : lit > 0.26 ? 1 : 2
  const s = SHADES[Math.max(0, Math.min(SHADES.length - 1, i + off))]
  return `rgb(var(--c-${mat.ramp}-${s}))`
}

/* ── Géométrie ─────────────────────────────────────────────────────────── */

const poly = (pts, mat, tags) => ({ kind: 'poly', pts, mat, tags })
const line = (pts, mat, tags) => ({ kind: 'line', pts, mat, tags })
const dot = (pt, r, mat, tags) => ({ kind: 'dot', pts: [pt], r, mat, tags })

// Profil de l'arceau : t = 0 → côté gauche, t = 1 → côté droit.
function arch(t, x, dz = 0) {
  const a = Math.PI * t
  return [x, WALL + (PEAK - WALL) * Math.sin(a), dz - (W / 2) * Math.cos(a)]
}

function box(c, s, mat, tags) {
  const [x, y, z] = c
  const [a, b, d] = [s[0] / 2, s[1] / 2, s[2] / 2]
  const v = [
    [x - a, y - b, z - d], [x + a, y - b, z - d], [x + a, y + b, z - d], [x - a, y + b, z - d],
    [x - a, y - b, z + d], [x + a, y - b, z + d], [x + a, y + b, z + d], [x - a, y + b, z + d],
  ]
  const f = [[0, 1, 2, 3], [5, 4, 7, 6], [4, 0, 3, 7], [1, 5, 6, 2], [3, 2, 6, 7], [4, 5, 1, 0]]
  return f.map(ix => poly(ix.map(i => v[i]), mat, tags))
}

function shell(out, dz = 0, tags = ['shell']) {
  const N = 7
  for (let i = 0; i < N; i++) {
    const t0 = i / N, t1 = (i + 1) / N
    out.push(poly([arch(t0, -L / 2, dz), arch(t1, -L / 2, dz), arch(t1, L / 2, dz), arch(t0, L / 2, dz)], FILM, tags))
  }
  for (const x of [-L / 2, -L / 6, L / 6, L / 2]) {
    out.push(line(Array.from({ length: N + 1 }, (_, i) => arch(i / N, x, dz)), HOOP, tags))
  }
  out.push(line([[-L / 2, PEAK, dz], [L / 2, PEAK, dz]], FRAME, tags))
  for (const x of [-L / 2, L / 2]) {
    const prof = Array.from({ length: N + 1 }, (_, i) => arch(i / N, x, dz))
    out.push(poly([[x, 0, dz - W / 2], ...prof, [x, 0, dz + W / 2]], GLASS, tags))
  }
}

// Côtés ouvrants : le film bas, la barre d'enroulement, le moteur.
function vents(out, dz = 0) {
  for (const s of [-1, 1]) {
    const z = dz + s * (W / 2)
    out.push(poly([[-L / 2, 0, z], [L / 2, 0, z], [L / 2, WALL, z], [-L / 2, WALL, z]],
      { ...FILM, shade: 300, opacity: 0.55 }, ['side_vents', 'vent_height']))
    out.push(line([[-L / 2, WALL + 0.12, z], [L / 2, WALL + 0.12, z]], PIPE, ['side_pipe', 'side_vents']))
  }
  out.push(...box([-L / 2 + 0.8, WALL + 0.12, dz - W / 2], [1, 0.6, 0.6], METAL, ['side_pipe', 'side_vents']))
}

function guides(out, dz = 0) {
  for (const s of [-1, 1]) {
    for (const x of [-4.5, -1.5, 1.5, 4.5]) {
      out.push(line([[x, 0, dz + s * (W / 2)], [x, WALL + 0.5, dz + s * (W / 2)]], { ...FRAME, w: 1.6 }, ['guide_pipes']))
    }
  }
}

function furnaces(out) {
  for (const x of [-3.4, 3.4]) {
    out.push(...box([x, 2.8, -1.7], [1.8, 1.1, 1.1], HEAT, ['furnaces', 'furnace_wire']))
    out.push(line([[x, 3.4, -1.7], [x, PEAK + 0.7, -1.7]], { ...METAL, w: 2 }, ['furnaces']))
  }
  out.push(...box([-L / 2 + 0.35, 1.7, -2.3], [0.4, 0.9, 0.7], METAL, ['furnace_wire', 'network']))
  out.push(line([[-3.4, 2.3, -1.7], [-3.4, 0.15, -2.5], [-L / 2 + 0.5, 0.15, -2.5], [-L / 2 + 0.5, 1.4, -2.4]], WIRE, ['furnace_wire']))
}

// Thermostat de secours : boîtier mural, relié à la fournaise par un fil.
function thermostat(out) {
  const at = [-0.6, 2.0, -W / 2 + 0.2]
  out.push(...box(at, [0.9, 1, 0.26], { ramp: 'orange', shade: 300, keep: true }, ['thermostat']))
  out.push(line([[at[0], at[1] + 0.4, at[2]], [at[0], 3.2, at[2]], [-3.4, 3.2, -1.7]], WIRE, ['thermostat']))
}

function irrigation(out) {
  for (const z of [-1.9, 0, 1.9]) {
    out.push(poly([[-4.8, 0.02, z - 0.55], [4.8, 0.02, z - 0.55], [4.8, 0.02, z + 0.55], [-4.8, 0.02, z + 0.55]], SOIL, ['irrigation']))
    out.push(line([[-5.2, 0.16, z], [4.8, 0.16, z]], WATER, ['irrigation']))
  }
  out.push(...box([-5.6, 0.55, 0], [0.5, 0.9, 4.4], METAL, ['valves', 'irrigation']))
  for (const z of [-1.9, 0, 1.9]) out.push(dot([-5.6, 1.1, z], 2.4, { ramp: 'cyan', shade: 500 }, ['valves']))
}

function network(out, mobile) {
  const tags = ['network', 'network_mobile']
  out.push(...box([-L / 2 + 0.35, 2.2, 1.9], [0.4, 1, 0.8], METAL, tags))
  const tip = [-L / 2 - 1.6, mobile ? 4.2 : 5.6, 2.6]
  out.push(line([[tip[0], 0, tip[2]], tip], { ...METAL, w: 1.8 }, tags))
  for (let k = 1; k <= 3; k++) {
    const r = 0.5 * k
    out.push(line(Array.from({ length: 9 }, (_, i) => {
      const a = -Math.PI / 3 + (i / 8) * (2 * Math.PI / 3)
      return [tip[0] + r * Math.sin(a), tip[1] + r * Math.cos(a) * 0.9 + 0.4, tip[2]]
    }), { ramp: mobile ? 'violet' : 'sky', shade: 500, w: 1.1 }, tags))
  }
  if (!mobile) out.push(line([[tip[0], 0.1, tip[2]], [-9.5, 0.1, 5.5]], { ramp: 'sky', shade: 500, w: 1.4 }, tags))
}

function house(out, tags) {
  out.push(...box([-9.5, 1.1, 6.2], [3.2, 2.2, 2.6], WOOD, tags))
  const r = [[-11.1, 2.2, 4.9], [-7.9, 2.2, 4.9], [-7.9, 2.2, 7.5], [-11.1, 2.2, 7.5]]
  const top = [[-11.1, 3.4, 6.2], [-7.9, 3.4, 6.2]]
  out.push(poly([r[0], r[1], top[1], top[0]], { ramp: 'red', shade: 400, keep: true }, tags))
  out.push(poly([r[3], r[2], top[1], top[0]], { ramp: 'red', shade: 500, keep: true }, tags))
}

function pin(out, at, tags) {
  out.push(line([[at[0], 0, at[2]], [at[0], at[1], at[2]]], { ramp: 'brand', shade: 600, w: 1.4 }, tags))
  out.push(dot([at[0], at[1], at[2]], 4, { ramp: 'brand', shade: 500 }, tags))
}

function truck(out, tags) {
  out.push(...box([9.6, 1.6, 5.4], [4.4, 2.4, 2.4], { ramp: 'slate', shade: 400, keep: true }, tags))
  out.push(...box([6.8, 1.2, 5.4], [1.8, 1.6, 2.2], { ramp: 'brand', shade: 500, keep: true }, tags))
  for (const x of [7, 8.6, 10.8]) for (const z of [4.4, 6.4]) out.push(dot([x, 0.5, z], 2.6, { ramp: 'slate', shade: 700, keep: true }, tags))
}

/* ── Scènes ────────────────────────────────────────────────────────────── */

const NEIGHBOURS = ['count', 'site']

function buildScene(focus) {
  const out = []
  const wide = NEIGHBOURS.includes(focus) || focus === 'farm' || focus === 'shipping'
  const gx = wide ? 15 : 9.5
  const gz = wide ? 14 : 7
  out.push(poly([[-gx, 0, -gz], [gx, 0, -gz], [gx, 0, gz], [-gx, 0, gz]], GROUND, ['ground']))

  if (NEIGHBOURS.includes(focus)) {
    for (const dz of [-9, 9]) { shell(out, dz); vents(out, dz) }
  }
  shell(out)
  vents(out)
  guides(out)

  if (['overview', 'furnaces', 'furnace_wire', 'thermostat'].includes(focus)) furnaces(out)
  if (focus === 'thermostat') thermostat(out)
  if (['overview', 'irrigation', 'valves'].includes(focus)) irrigation(out)
  if (['overview', 'network', 'network_mobile', 'site'].includes(focus)) network(out, focus === 'network_mobile')
  if (focus === 'farm') { house(out, ['farm']); pin(out, [-2, 6.4, 0], ['farm']) }
  if (focus === 'shipping') { truck(out, ['shipping']); pin(out, [9.6, 5.4, 5.4], ['shipping']) }
  if (focus === 'length') {
    const z = W / 2 + 1.6
    out.push(line([[-L / 2, 0.05, z], [L / 2, 0.05, z]], DIM, ['length']))
    for (const x of [-L / 2, L / 2]) out.push(line([[x, 0.05, z - 0.5], [x, 0.05, z + 0.5]], DIM, ['length']))
  }
  if (focus === 'vent_height') {
    const x = L / 2 + 1.2
    out.push(line([[x, 0, W / 2], [x, WALL, W / 2]], DIM, ['vent_height']))
    for (const y of [0, WALL]) out.push(line([[x - 0.4, y, W / 2], [x + 0.4, y, W / 2]], DIM, ['vent_height']))
  }
  return out
}

const SCENES = new Map()
function scene(focus) {
  if (!SCENES.has(focus)) SCENES.set(focus, buildScene(focus))
  return SCENES.get(focus)
}

/* ── Rendu ─────────────────────────────────────────────────────────────── */

const VB = { w: 240, h: 150, pad: 8 }
// Ces focus montrent la scène entière : rien n'y est atténué.
const FULL = ['overview', 'site', 'count']

function projector(view) {
  const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw)
  const cp = Math.cos(view.pitch), sp = Math.sin(view.pitch)
  const dist = 42
  return (p) => {
    const x = p[0] * cy + p[2] * sy
    const zr = -p[0] * sy + p[2] * cy
    const y = p[1] * cp - zr * sp
    const z = p[1] * sp + zr * cp
    const f = dist / (dist + z)
    return [x * 15 * f, -y * 15 * f, z, f]
  }
}

// Cadrage : la scène est mise à l'échelle pour remplir la vue, le sol exclu
// (il déborde volontairement, c'est le champ). Sans ça, une antenne ou un
// camion sortait du cadre selon l'angle.
function fitTransform(projected) {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const { pts, tags } of projected) {
    if (tags[0] === 'ground') continue
    for (const p of pts) {
      if (p[0] < minX) minX = p[0]
      if (p[0] > maxX) maxX = p[0]
      if (p[1] < minY) minY = p[1]
      if (p[1] > maxY) maxY = p[1]
    }
  }
  if (!Number.isFinite(minX)) return { s: 1, dx: VB.w / 2, dy: VB.h / 2 }
  const s = Math.min((VB.w - 2 * VB.pad) / Math.max(1, maxX - minX), (VB.h - 2 * VB.pad) / Math.max(1, maxY - minY))
  return { s, dx: VB.w / 2 - ((minX + maxX) / 2) * s, dy: VB.h / 2 - ((minY + maxY) / 2) * s }
}

function shapes(parts, view, focus) {
  const proj = projector(view)
  const lit = (pts) => {
    const n = faceNormal(pts)
    return 0.18 + 0.82 * Math.abs(n[0] * LIGHT[0] + n[1] * LIGHT[1] + n[2] * LIGHT[2])
  }
  const projected = parts.map(part => ({ part, tags: part.tags, pts: part.pts.map(proj) }))
  const { s, dx, dy } = fitTransform(projected)
  return projected.map(({ part, pts: raw }, i) => {
    const pts = raw.map(p => [dx + p[0] * s, dy + p[1] * s, p[2], p[3]])
    const depth = pts.reduce((a, p) => a + p[2], 0) / pts.length
    const on = part.tags.includes(focus)
    const off = !FULL.includes(focus) && !on && part.tags[0] !== 'ground'
    // Les objets qui portent leur propre identité (fournaise, camion,
    // maison) gardent leur couleur : ils ressortent par leur contour.
    const mat = on && !part.mat.keep ? (part.kind === 'poly' ? ACCENT_FACE : ACCENT_LINE) : part.mat
    const fill = tone(mat, part.kind === 'poly' ? lit(part.pts) : 0.6)
    const opacity = (mat.opacity ?? 1) * (off ? 0.4 : 1)
    const d = pts.map((p, j) => `${j ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join('')
    return { i, depth, on, kind: part.kind, d, fill, opacity, r: (part.r || 3) * s, pts, w: mat.w || 1 }
  }).sort((a, b) => b.depth - a.depth)
}

const FALLBACK_LABEL = 'Vue 3D de la serre'

export default function GreenhouseView3D({ focus = 'overview', height = 128, label, className = '' }) {
  const [view, setView] = useState({ yaw: -0.68, pitch: 0.4 })
  const drag = useRef(null)
  const parts = scene(focus)
  const items = useMemo(() => shapes(parts, view, focus), [parts, view, focus])

  function down(e) {
    drag.current = { x: e.clientX, y: e.clientY, ...view }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  function move(e) {
    const d = drag.current
    if (!d) return
    setView({
      yaw: d.yaw + (e.clientX - d.x) * 0.008,
      pitch: Math.max(-0.12, Math.min(1.15, d.pitch + (e.clientY - d.y) * 0.006)),
    })
  }
  const up = () => { drag.current = null }

  return (
    <svg
      viewBox={`0 0 ${VB.w} ${VB.h}`}
      style={{ height, width: (height * VB.w) / VB.h, touchAction: 'none' }}
      className={`shrink-0 cursor-grab active:cursor-grabbing select-none ${className}`}
      role="img"
      aria-label={label || FALLBACK_LABEL}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      <title>{label || FALLBACK_LABEL}</title>
      {items.map(s => (s.kind === 'dot' ? (
        <circle key={s.i} cx={s.pts[0][0]} cy={s.pts[0][1]} r={s.r * s.pts[0][3]} fill={s.fill} opacity={s.opacity} />
      ) : s.kind === 'line' ? (
        <path key={s.i} d={s.d} fill="none" stroke={s.fill} strokeWidth={s.w} strokeLinecap="round" strokeLinejoin="round" opacity={s.opacity} />
      ) : (
        <path
          key={s.i}
          d={`${s.d}Z`}
          fill={s.fill}
          opacity={s.opacity}
          stroke={s.on ? s.fill : 'rgb(var(--c-slate-500))'}
          strokeWidth={s.on ? 1.2 : 0.4}
          strokeOpacity={s.on ? 0.9 : 0.35}
        />
      )))}
    </svg>
  )
}
