// Choix illustré des ventilateurs de bout de serre : l'image porte la réponse
// (aucun, un, ou deux ventilateurs sur le mur de bout) et le texte est dessiné
// dedans, pour qu'on puisse répondre sans rien lire sous l'image.
const FAN_LABELS = { 0: 'Aucun ventilateur', 1: '1 ventilateur', 2: '2 ventilateurs' }

// Un seul ventilateur se place au centre du bout, deux se répartissent.
function fanX(count, i) {
  return count === 1 ? 120 : 92 + i * 56
}

function Fan({ x }) {
  const cy = 92
  return (
    <g>
      <rect x={x - 19} y={cy - 19} width="38" height="38" rx="4" className="fill-white stroke-slate-400" strokeWidth="2" />
      <circle cx={x} cy={cy} r="15" className="fill-sky-50 stroke-slate-400" strokeWidth="1.5" />
      {[0, 90, 180, 270].map(a => (
        <path
          key={a}
          d={`M${x} ${cy} C${x + 4} ${cy - 12} ${x + 12} ${cy - 13} ${x + 13} ${cy - 6} C${x + 10} ${cy - 2} ${x + 5} ${cy - 1} ${x} ${cy} Z`}
          transform={`rotate(${a} ${x} ${cy})`}
          className="fill-sky-400 stroke-sky-600"
          strokeWidth="1"
        />
      ))}
      <circle cx={x} cy={cy} r="3" className="fill-slate-500" />
    </g>
  )
}

export default function EndFanChoice({ count, checked, onChange, name }) {
  const label = FAN_LABELS[count]
  return (
    <label className={`relative block cursor-pointer rounded-lg border p-2 ${checked ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:bg-slate-50'}`}>
      <input type="radio" name={name} className="sr-only" checked={checked} onChange={onChange} aria-label={label} />
      <svg viewBox="0 0 240 150" className="w-full h-32" role="img" aria-hidden="true">
        <line x1="10" y1="124" x2="230" y2="124" className="stroke-slate-300" strokeWidth="2" />
        {/* Mur de bout de serre, vu de face. */}
        <path d="M36 124 V88 C36 34 204 34 204 88 V124 Z" className="fill-brand-50 stroke-slate-400" strokeWidth="2.5" strokeLinejoin="round" />
        {Array.from({ length: count }, (_, i) => <Fan key={i} x={fanX(count, i)} />)}
        <text x="120" y="144" textAnchor="middle" fontSize="14" className="fill-slate-700 font-semibold">{label}</text>
      </svg>
    </label>
  )
}
