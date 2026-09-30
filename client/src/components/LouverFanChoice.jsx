import { useDiscoveryTr } from '../lib/discoveryLang.js'
// Louvre seule ou reliée à son ventilateur, dans le style des choix voisins.
export default function LouverFanChoice({ hasFan, checked, onChange, name }) {
  const tr = useDiscoveryTr()
  const label = tr(hasFan ? 'Avec ventilateur' : 'Sans ventilateur')
  return (
    <label className={`relative block cursor-pointer rounded-lg border p-3 focus-within:ring-2 focus-within:ring-brand-500 focus-within:ring-offset-2 ${checked ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:bg-slate-50'}`}>
      <input type="radio" name={name} value={String(hasFan)} className="sr-only" checked={checked} onChange={onChange} aria-label={label} />
      <svg viewBox="0 0 240 130" className="w-full h-32" aria-hidden="true" focusable="false">
        <g transform={hasFan ? undefined : 'translate(65 0)'}>
          <rect x="18" y="25" width="74" height="80" rx="4" className="fill-white stroke-slate-400" strokeWidth="2.5" />
          {[0, 1, 2, 3, 4].map(i => (
            <path key={i} d={`M28 ${43 + i * 13} L82 ${37 + i * 13}`} className="stroke-slate-400" strokeWidth="5" strokeLinecap="round" />
          ))}
        </g>
        {hasFan && <g>
          {/* Le conduit relie la louvre au ventilateur associé. */}
          <path d="M92 39 H146 M92 91 H146" className="fill-none stroke-slate-300" strokeWidth="2" />
          <path d="M102 65 H135 l-6 -6 M135 65 l-6 6" className="fill-none stroke-sky-600" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="146" y="25" width="76" height="80" rx="4" className="fill-white stroke-slate-400" strokeWidth="2.5" />
          <circle cx="184" cy="65" r="31" className="fill-sky-50 stroke-slate-400" strokeWidth="1.5" />
          {[0, 90, 180, 270].map(angle => (
            <path key={angle} d="M184 65 C192 41 208 39 210 53 C204 61 194 63 184 65 Z"
              transform={`rotate(${angle} 184 65)`} className="fill-sky-400 stroke-sky-600" strokeWidth="1.5" />
          ))}
          <circle cx="184" cy="65" r="6" className="fill-slate-500" />
        </g>}
      </svg>
      <span className="flex items-center justify-center gap-2 text-sm text-slate-700">
        <span aria-hidden="true" className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border ${checked ? 'border-brand-600' : 'border-slate-400'}`}>
          {checked && <span className="h-2 w-2 rounded-full bg-brand-600" />}
        </span>
        {label}
      </span>
    </label>
  )
}
