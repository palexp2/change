import { useDiscoveryTr } from '../lib/discoveryLang.js'
// Choix illustré des côtés ouvrants à automatiser : l'image porte la réponse
// (aucun côté, un seul, ou un de chaque côté — un moteur par côté automatisé)
// et le texte est dessiné dedans, pour qu'on puisse répondre sans rien lire
// sous l'image. Au-delà de deux côtés : une seule serre en vue isométrique,
// un moteur par coin, la barre d'enroulement coupée au centre du côté.
const COUNT_LABELS = { 0: 'Aucun côté ouvrant', 1: '1 côté ouvrant', 2: '2 côtés ouvrants', 3: '3 côtés ouvrants', 4: '4 côtés ouvrants' }
const HOUSE = [40, 200]

// Moteur monté sur le tuyau, vers l'extérieur de la serre.
function Motor({ x, outward, width }) {
  return (
    <g>
      <rect x={x - 4} y="93" width="8" height="6" rx="1" className="fill-amber-600" />
      <rect x={outward < 0 ? x - 4 - width : x + 4} y="87" width={width} height="18" rx="3" className="fill-amber-500 stroke-amber-700" strokeWidth="1.5" />
    </g>
  )
}

function FrontView({ count }) {
  const [left, right] = HOUSE
  return (
    <g>
      <line x1="10" y1="124" x2="230" y2="124" className="stroke-slate-300" strokeWidth="2" />
      {/* Toile fixe : de la barre d'enroulement jusqu'au faîte. */}
      <path d={`M${left} 96 V84 C${left} 44 ${right} 44 ${right} 84 V96`} className="fill-brand-50 stroke-slate-400" strokeWidth="2.5" strokeLinejoin="round" />
      {[left, right].map((x, s) => (
        // Côté automatisé : la toile est enroulée sur son tuyau, il ne reste
        // que le vide. Côté laissé tel quel : elle descend jusqu'au sol.
        count > s ? (
          <g key={s}>
            <line x1={x} y1="98" x2={x} y2="124" className="stroke-slate-300" strokeWidth="2.5" strokeDasharray="5 4" />
            <circle cx={x} cy="96" r="6" className="fill-slate-200 stroke-slate-400" strokeWidth="1.5" />
            <circle cx={x} cy="96" r="2" className="fill-slate-400" />
            <Motor x={x} outward={s === 0 ? -1 : 1} width={22} />
          </g>
        ) : (
          <rect key={s} x={x - 3} y="96" width="6" height="28" className="fill-brand-50 stroke-slate-400" strokeWidth="2" />
        )
      ))}
    </g>
  )
}

// Serre vue de biais : u = longueur, v = largeur (0 = côté proche), z = hauteur.
const L = 130, W = 64, BAR = 16, EAVE = 24, PEAK = 50, GAP = 4
const iso = (u, v, z) => [74 + 1.15 * (u * 0.9 - v * 0.6), 126 - 1.15 * (u * 0.24 + v * 0.4 + z)]
const pts = list => list.map(p => iso(...p).map(n => n.toFixed(1)).join(',')).join(' ')
const ARCH = Array.from({ length: 17 }, (_, i) => [W * i / 16, EAVE + (PEAK - EAVE) * Math.sin(Math.PI * i / 16) ** 0.6])

// Barre d'enroulement d'un côté (v) : entière avec un moteur à l'avant, ou
// coupée au centre avec un moteur à chaque coin.
function IsoSide({ v, split }) {
  const bars = split ? [[0, L / 2 - GAP], [L / 2 + GAP, L]] : [[0, L]]
  const motors = split ? [[0, -1], [L, 1]] : [[0, -1]]
  const seg = (a, b) => { const [x1, y1] = iso(a, v, BAR); const [x2, y2] = iso(b, v, BAR); return { x1, y1, x2, y2 } }
  return (
    <g strokeLinecap="round">
      {bars.map(([a, b], i) => (
        <g key={i}>
          <line {...seg(a, b)} className="stroke-slate-400" strokeWidth="5" />
          <line {...seg(a, b)} className="stroke-slate-200" strokeWidth="2.5" />
        </g>
      ))}
      {motors.map(([u, dir]) => (
        <g key={u}>
          <line {...seg(u, u + dir * 13)} className="stroke-amber-700" strokeWidth="12" />
          <line {...seg(u, u + dir * 13)} className="stroke-amber-500" strokeWidth="9" />
        </g>
      ))}
    </g>
  )
}

function IsoView({ count }) {
  const [px, py] = iso(L / 2, 0, 0)
  return (
    <g strokeLinejoin="round">
      <polygon points={pts([[0, 0, 0], [L, 0, 0], [L, W, 0], [0, W, 0]])} className="fill-slate-100" />
      <IsoSide v={W} split={count > 3} />
      {/* Toile translucide : on devine le côté du fond au travers. */}
      <g opacity="0.65">
        {ARCH.slice(1).map(([v, z], i) => (
          <polygon key={i} points={pts([[0, ...ARCH[i]], [0, v, z], [L, v, z], [L, ...ARCH[i]]])} className="fill-brand-50 stroke-brand-50" strokeWidth="0.6" />
        ))}
        {[0, W].map(v => <polygon key={v} points={pts([[0, v, BAR], [L, v, BAR], [L, v, EAVE], [0, v, EAVE]])} className="fill-brand-50" />)}
        <polygon points={pts([[0, 0, 0], ...ARCH.map(([v, z]) => [0, v, z]), [0, W, 0]])} className="fill-brand-50 stroke-slate-400" strokeWidth="2" />
      </g>
      {[L / 4, L / 2, 3 * L / 4, L].map(u => <polyline key={u} points={pts(ARCH.map(([v, z]) => [u, v, z]))} fill="none" className="stroke-slate-300" strokeWidth="1.2" />)}
      <polyline points={pts([[0, 0, EAVE], [L, 0, EAVE]])} fill="none" className="stroke-slate-400" strokeWidth="1.5" />
      <polyline points={pts([[L, 0, BAR], [L, 0, 0]])} fill="none" className="stroke-slate-400" strokeWidth="1.5" />
      {/* Côté proche ouvert : le vide sous la barre, un poteau au centre. */}
      <polyline points={pts([[0, 0, 0], [L, 0, 0]])} fill="none" className="stroke-slate-300" strokeWidth="2" strokeDasharray="5 4" />
      <line x1={px} y1={py} x2={px} y2={py - BAR} className="stroke-slate-400" strokeWidth="1.5" />
      <IsoSide v={0} split />
    </g>
  )
}

export default function SideVentCountChoice({ count, checked, onChange, name }) {
  const tr = useDiscoveryTr()
  const label = tr(COUNT_LABELS[count])
  return (
    <label className={`relative block cursor-pointer rounded-lg border p-2 ${checked ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:bg-slate-50'}`}>
      <input type="radio" name={name} className="sr-only" checked={checked} onChange={onChange} aria-label={label} />
      <svg viewBox="0 0 240 150" className="w-full h-32" role="img" aria-hidden="true">
        {count > 2 ? <IsoView count={count} /> : <FrontView count={count} />}
        <text x="120" y="144" textAnchor="middle" fontSize="14" className="fill-slate-700 font-semibold">{label}</text>
      </svg>
    </label>
  )
}
