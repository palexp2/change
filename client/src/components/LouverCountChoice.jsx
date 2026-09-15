// Choix illustré des louvres à automatiser : l'image porte la réponse (aucune,
// une, ou deux louvres sur le bout de serre) et le texte est dessiné dedans,
// pour qu'on puisse répondre sans rien lire sous l'image.
const LOUVER_LABELS = { 0: 'Aucune louvre', 1: '1 louvre', 2: '2 louvres' }

// Une seule louvre se place au centre du bout, deux se répartissent.
function louverX(count, i) {
  return count === 1 ? 120 : 92 + i * 56
}

// Persienne motorisée : cadre, lames inclinées, petit moteur sur le côté.
function Louver({ x }) {
  const top = 73
  return (
    <g>
      <rect x={x - 19} y={top} width="38" height="38" rx="3" className="fill-white stroke-slate-400" strokeWidth="2" />
      {[0, 1, 2, 3].map(i => (
        <path key={i} d={`M${x - 14} ${top + 12 + i * 8} L${x + 14} ${top + 7 + i * 8}`} className="stroke-slate-400" strokeWidth="3" strokeLinecap="round" />
      ))}
      <rect x={x + 19} y={top + 12} width="9" height="14" rx="2" className="fill-amber-500 stroke-amber-700" strokeWidth="1.5" />
    </g>
  )
}

export default function LouverCountChoice({ count, checked, onChange, name }) {
  const label = LOUVER_LABELS[count]
  return (
    <label className={`relative block cursor-pointer rounded-lg border p-2 ${checked ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:bg-slate-50'}`}>
      <input type="radio" name={name} className="sr-only" checked={checked} onChange={onChange} aria-label={label} />
      <svg viewBox="0 0 240 150" className="w-full h-32" role="img" aria-hidden="true">
        <line x1="10" y1="124" x2="230" y2="124" className="stroke-slate-300" strokeWidth="2" />
        {/* Mur de bout de serre, vu de face. */}
        <path d="M36 124 V88 C36 34 204 34 204 88 V124 Z" className="fill-brand-50 stroke-slate-400" strokeWidth="2.5" strokeLinejoin="round" />
        {Array.from({ length: count }, (_, i) => <Louver key={i} x={louverX(count, i)} />)}
        <text x="120" y="144" textAnchor="middle" fontSize="14" className="fill-slate-700 font-semibold">{label}</text>
      </svg>
    </label>
  )
}
