// Choix illustré des côtés ouvrants à automatiser : l'image porte la réponse
// (aucun côté, un seul, ou un de chaque côté — un moteur par côté automatisé)
// et le texte est dessiné dedans, pour qu'on puisse répondre sans rien lire
// sous l'image.
const COUNT_LABELS = { 0: 'Aucun côté ouvrant', 1: '1 côté ouvrant', 2: '2 côtés ouvrants' }

function Motor({ side }) {
  const x = side === 'left' ? 14 : 204
  const shaft = side === 'left' ? 36 : 196
  return (
    <g>
      <rect x={shaft} y="93" width="8" height="6" rx="1" className="fill-amber-600" />
      <rect x={x} y="87" width="22" height="18" rx="3" className="fill-amber-500 stroke-amber-700" strokeWidth="1.5" />
    </g>
  )
}

export default function SideVentCountChoice({ count, checked, onChange, name }) {
  const label = COUNT_LABELS[count]
  return (
    <label className={`relative block cursor-pointer rounded-lg border p-2 ${checked ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:bg-slate-50'}`}>
      <input type="radio" name={name} className="sr-only" checked={checked} onChange={onChange} aria-label={label} />
      <svg viewBox="0 0 240 150" className="w-full h-32" role="img" aria-hidden="true">
        <line x1="10" y1="124" x2="230" y2="124" className="stroke-slate-300" strokeWidth="2" />
        {/* Toile fixe : de la barre d'enroulement jusqu'au faîte. */}
        <path d="M40 96 V84 C40 44 200 44 200 84 V96" className="fill-brand-50 stroke-slate-400" strokeWidth="2.5" strokeLinejoin="round" />
        {['left', 'right'].map((side, i) => {
          const x = side === 'left' ? 40 : 200
          // Côté automatisé : la toile est enroulée sur son tuyau, il ne reste
          // que le vide. Côté laissé tel quel : elle descend jusqu'au sol.
          const automated = count > i
          return automated ? (
            <g key={side}>
              <line x1={x} y1="98" x2={x} y2="124" className="stroke-slate-300" strokeWidth="2.5" strokeDasharray="5 4" />
              <circle cx={x} cy="96" r="6" className="fill-slate-200 stroke-slate-400" strokeWidth="1.5" />
              <circle cx={x} cy="96" r="2" className="fill-slate-400" />
              <Motor side={side} />
            </g>
          ) : (
            <rect key={side} x={side === 'left' ? 37 : 194} y="96" width="6" height="28" className="fill-brand-50 stroke-slate-400" strokeWidth="2" />
          )
        })}
        <text x="120" y="144" textAnchor="middle" fontSize="14" className="fill-slate-700 font-semibold">{label}</text>
      </svg>
    </label>
  )
}
