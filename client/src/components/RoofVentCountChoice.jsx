import { useDiscoveryTr } from '../lib/discoveryLang.js'
// Choix illustré des toits ouvrants : serre vue de bout, toit fermé, relevé
// d'un côté du faîte, ou des deux. Pour deux toits, deux possibilités côte à
// côte : la même serre, et une multichapelle de deux chapelles à un toit
// ouvrant chacune. Le texte est dessiné dans l'image.
const COUNT_LABELS = { 0: 'Aucun toit ouvrant', 1: '1 toit ouvrant', 2: '2 toits ouvrants' }
const VENT = 'M120 44 Q148 44 170 54'

// Toit relevé depuis le faîte, poussé par sa crémaillère et son moteur ; le
// côté gauche est le miroir du droit.
function Vent({ mirror }) {
  return (
    <g transform={mirror ? 'translate(240 0) scale(-1 1)' : undefined}>
      <path d={VENT} fill="none" className="stroke-slate-300" strokeWidth="2" strokeDasharray="5 4" />
      <line x1="160" y1="34" x2="160" y2="66" className="stroke-slate-400" strokeWidth="2.5" strokeLinecap="round" />
      <rect x="153" y="64" width="14" height="10" rx="2" className="fill-amber-500 stroke-amber-700" strokeWidth="1.5" />
      <path d={VENT} transform="rotate(-22 120 44)" fill="none" className="stroke-slate-500" strokeWidth="3.5" strokeLinecap="round" />
    </g>
  )
}

// Serre à une chapelle, sans sol ni légende.
function Single({ count }) {
  return (
    <>
      <path d="M40 124 V84 Q44 66 70 54 Q92 44 120 44 Q148 44 170 54 Q196 66 200 84 V124 Z" className="fill-brand-50" />
      <path d={`M40 124 V84 Q44 66 70 54${count > 1 ? '' : ' Q92 44 120 44'}${count > 0 ? ' M170 54' : ' Q148 44 170 54'} Q196 66 200 84 V124`}
        fill="none" className="stroke-slate-400" strokeWidth="2.5" strokeLinejoin="round" />
      {count > 0 && <Vent />}
      {count > 1 && <Vent mirror />}
      <circle cx="120" cy="44" r="3" className="fill-white stroke-slate-500" strokeWidth="1.5" />
    </>
  )
}

// Multichapelle de deux chapelles (faîtes en 80,46 et 160,46, chéneau en 120),
// chacune relevée du côté droit de son faîte.
const arch = c => `Q${c - 39} 66 ${c - 27} 56 Q${c - 15} 46 ${c} 46 Q${c + 15} 46 ${c + 27} 56 Q${c + 39} 66 ${c + 40} 84`
function MultiChapel() {
  return (
    <>
      <path d={`M40 124 V84 ${arch(80)} ${arch(160)} V124 Z`} className="fill-brand-50" />
      <line x1="120" y1="84" x2="120" y2="124" className="stroke-slate-300" strokeWidth="2" />
      {[80, 160].map(c => {
        const vent = `M${c} 46 Q${c + 15} 46 ${c + 27} 56`
        return (
          <g key={c}>
            <path d={`M${c - 40} ${c === 80 ? '124 V84' : '84'} Q${c - 39} 66 ${c - 27} 56 Q${c - 15} 46 ${c} 46 M${c + 27} 56 Q${c + 39} 66 ${c + 40} 84${c === 160 ? ' V124' : ''}`}
              fill="none" className="stroke-slate-400" strokeWidth="2.5" strokeLinejoin="round" />
            <path d={vent} fill="none" className="stroke-slate-300" strokeWidth="2" strokeDasharray="5 4" />
            <line x1={c + 20} y1="36" x2={c + 20} y2="64" className="stroke-slate-400" strokeWidth="2.5" strokeLinecap="round" />
            <rect x={c + 14} y="62" width="12" height="9" rx="2" className="fill-amber-500 stroke-amber-700" strokeWidth="1.5" />
            <path d={vent} transform={`rotate(-24 ${c} 46)`} fill="none" className="stroke-slate-500" strokeWidth="3.5" strokeLinecap="round" />
            <circle cx={c} cy="46" r="3" className="fill-white stroke-slate-500" strokeWidth="1.5" />
          </g>
        )
      })}
    </>
  )
}

// Deux dessins réduits autour des centres 60 et 180, au même sol.
const S = 0.72
const at = cx => `translate(${cx - 120 * S} ${124 - 124 * S}) scale(${S})`

export default function RoofVentCountChoice({ count, checked, onChange, name }) {
  const tr = useDiscoveryTr()
  const label = tr(COUNT_LABELS[count])
  return (
    <label className={`relative block cursor-pointer rounded-lg border p-2 focus-within:ring-2 focus-within:ring-brand-500 focus-within:ring-offset-2 ${checked ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:bg-slate-50'}`}>
      <input type="radio" name={name} value={count} className="sr-only" checked={checked} onChange={onChange} aria-label={label} />
      <svg viewBox="0 0 240 150" className="w-full h-32" role="img" aria-hidden="true">
        {count > 1 ? (
          <>
            <line x1="2" y1="124" x2="118" y2="124" className="stroke-slate-300" strokeWidth="2" />
            <line x1="122" y1="124" x2="238" y2="124" className="stroke-slate-300" strokeWidth="2" />
            <g transform={at(60)}><Single count={2} /></g>
            <g transform={at(180)}><MultiChapel /></g>
            {/* Cassure : l'une ou l'autre serre, pas les deux. */}
            <line x1="120" y1="6" x2="120" y2="130" className="stroke-slate-400" strokeWidth="1.5" strokeDasharray="4 3" />
            <rect x="107" y="50" width="26" height="16" rx="8" className="fill-white stroke-slate-400" strokeWidth="1.5" />
            <text x="120" y="62" textAnchor="middle" fontSize="11" className="fill-slate-600 font-semibold">{tr('ou')}</text>
          </>
        ) : (
          <>
            <line x1="10" y1="124" x2="230" y2="124" className="stroke-slate-300" strokeWidth="2" />
            <Single count={count} />
          </>
        )}
        <text x="120" y="144" textAnchor="middle" fontSize="14" className="fill-slate-700 font-semibold">{label}</text>
      </svg>
    </label>
  )
}
