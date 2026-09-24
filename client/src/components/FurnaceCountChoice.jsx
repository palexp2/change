function Furnace({ x }) {
  return (
    <g transform={`translate(${x} 65)`}>
      <path d="M-14 0 V-13 M14 0 V-13" className="stroke-slate-400" strokeWidth="2" />
      <rect x="-24" width="48" height="38" rx="4" className="fill-slate-200 stroke-slate-500" strokeWidth="2" />
      <circle cx="-6" cy="19" r="12" className="fill-slate-50 stroke-slate-500" strokeWidth="1.5" />
      <path d="M-14 14 L2 24 M-14 24 L2 14 M-6 9 V29" className="stroke-slate-500" strokeWidth="2" />
      <rect x="11" y="10" width="7" height="18" rx="2" className="fill-amber-500" />
      <path d="M-14 44 Q-20 49 -14 54 M0 44 Q-6 49 0 54 M14 44 Q8 49 14 54" className="fill-none stroke-amber-600" strokeWidth="2" strokeLinecap="round" />
    </g>
  )
}

export function FurnaceIllustration({ count = 1, label, className = 'w-full h-32', style, variant }) {
  const showWire = variant === 'control-wire'
  return (
    <svg viewBox="0 0 240 150" className={className} style={style} role={label ? 'img' : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      <line x1="10" y1="124" x2="230" y2="124" className="stroke-slate-300" strokeWidth="2" />
      <path d="M30 124 V85 C30 17 210 17 210 85 V124 Z" className="fill-brand-50 stroke-slate-400" strokeWidth="2.5" />
      {showWire ? <>
        <Furnace x={88} />
        <path d="M112 84 H142 Q148 84 148 78 V67 Q148 61 154 61 H169" className="fill-none stroke-brand-600" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <rect x="169" y="48" width="22" height="30" rx="3" className="fill-slate-200 stroke-slate-500" strokeWidth="2" />
        <rect x="174" y="54" width="12" height="8" rx="1.5" className="fill-brand-600" />
        <circle cx="180" cy="70" r="3" className="fill-slate-500" />
      </> : <>
        {Array.from({ length: count }, (_, i) => <Furnace key={i} x={count === 1 ? 120 : 82 + i * 76} />)}
        <text x="120" y="144" textAnchor="middle" fontSize="14" className="fill-slate-700 font-semibold">{count === 0 ? 'Aucune' : String(count)}</text>
      </>}
    </svg>
  )
}

export default function FurnaceCountChoice({ count, checked, onChange, name }) {
  const label = count === 0 ? 'Aucune' : String(count)
  return (
    <label className={`relative block cursor-pointer rounded-lg border p-2 focus-within:ring-2 focus-within:ring-brand-500 focus-within:ring-offset-2 ${checked ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:bg-slate-50'}`}>
      <input type="radio" name={name} value={count} className="sr-only" checked={checked} onChange={onChange} aria-label={label} />
      <FurnaceIllustration count={count} />
    </label>
  )
}
