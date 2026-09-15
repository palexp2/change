// Choix illustré des zones d'irrigation : une zone = une valve sur la conduite,
// de 0 à 4 (le contenu d'un bloc). Le texte est dessiné dans l'image, pour
// qu'on puisse répondre sans rien lire dessous.
const ZONE_LABELS = { 0: 'Aucune zone', 1: '1 zone', 2: '2 zones', 3: '3 zones', 4: '4 zones' }

// Les valves se répartissent sur la conduite ; une seule se place au centre.
function valveX(count, i) {
  return count === 1 ? 120 : 60 + i * (120 / (count - 1))
}

function Valve({ x }) {
  return (
    <g>
      <line x1={x} y1="62" x2={x} y2="78" className="stroke-slate-400" strokeWidth="3" />
      <line x1={x - 7} y1="74" x2={x + 7} y2="74" className="stroke-sky-700" strokeWidth="3" strokeLinecap="round" />
      <rect x={x - 9} y="78" width="18" height="14" rx="3" className="fill-sky-500 stroke-sky-700" strokeWidth="1.5" />
      {/* Le goutte-à-goutte descend de la valve jusqu'au sol. */}
      <line x1={x} y1="92" x2={x} y2="122" className="stroke-sky-300" strokeWidth="2.5" strokeDasharray="4 4" />
    </g>
  )
}

export default function IrrigationValveChoice({ count, checked, onChange, name }) {
  const label = ZONE_LABELS[count]
  return (
    <label className={`relative block cursor-pointer rounded-lg border p-2 ${checked ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:bg-slate-50'}`}>
      <input type="radio" name={name} className="sr-only" checked={checked} onChange={onChange} aria-label={label} />
      <svg viewBox="0 0 240 150" className="w-full h-32" role="img" aria-hidden="true">
        <line x1="10" y1="124" x2="230" y2="124" className="stroke-slate-300" strokeWidth="2" />
        {/* Conduite d'eau qui traverse la serre. */}
        <line x1="16" y1="62" x2="224" y2="62" className="stroke-slate-400" strokeWidth="5" strokeLinecap="round" />
        {Array.from({ length: count }, (_, i) => <Valve key={i} x={valveX(count, i)} />)}
        <text x="120" y="144" textAnchor="middle" fontSize="14" className="fill-slate-700 font-semibold">{label}</text>
      </svg>
    </label>
  )
}
