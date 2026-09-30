// Choix illustré de la commande d'une louvre : chaque combinaison offerte est
// une image (ressort 110 V, piston ou moteur 24 V à signaux ouvrir/fermer,
// autre). Le voltage et le type de commande ne se demandent plus séparément —
// c'est la même question.
export const LOUVER_COMBOS = [
  { value: 'spring_110', voltage: '110', control_type: 'spring_loaded' },
  { value: 'open_close_24', voltage: '24', control_type: 'open_close' },
  // « Autre » ne porte aucun voltage : le client sera appelé.
  { value: 'other', voltage: '', control_type: 'other' },
]

// Combinaison cochée pour une louvre déjà saisie. Une réponse plus ancienne
// (12 V, autre voltage…) ne correspond à aucune image : rien n'est coché, mais
// elle reste lisible ailleurs.
export function louverComboValue(louver = {}) {
  return LOUVER_COMBOS.find(c => c.control_type === louver.control_type
    && (c.control_type === 'other' || c.voltage === louver.voltage))?.value || ''
}

const CONTROL_LABELS = { spring_loaded: 'Spring loaded', open_close: 'Signaux ouvrir/fermer', other: 'Autre / Je ne sais pas — appeler le client' }

// Résumé d'une louvre en une ligne, y compris pour les réponses plus anciennes
// qui ne tombent sur aucune combinaison offerte.
export function louverSummary(louver = {}, tr = s => s) {
  const voltage = louver.control_type === 'other' ? '' : louver.voltage === 'other' ? (louver.voltage_other || '') : louver.voltage ? `${louver.voltage} V` : ''
  return [tr(CONTROL_LABELS[louver.control_type]), voltage].filter(Boolean).join(' · ')
}

// Cadre de la louvre, vue de face, commun aux trois images.
function Frame() {
  return (
    <g>
      <rect x="54" y="26" width="86" height="84" rx="4" className="fill-white stroke-slate-400" strokeWidth="2.5" />
      {[0, 1, 2, 3, 4].map(i => (
        <path key={i} d={`M64 ${44 + i * 15} L130 ${38 + i * 15}`} className="stroke-slate-400" strokeWidth="5" strokeLinecap="round" />
      ))}
    </g>
  )
}

function Badge({ text }) {
  return (
    <g>
      <rect x="8" y="10" width="52" height="20" rx="10" className="fill-brand-50 stroke-brand-500" strokeWidth="1.5" />
      <text x="34" y="24" textAnchor="middle" fontSize="12" className="fill-slate-700 font-semibold">{text}</text>
    </g>
  )
}

// Ressort de rappel : la louvre s'ouvre au courant et se referme seule.
function Spring() {
  return (
    <g>
      <path d="M140 68 l10 -12 l10 24 l10 -24 l10 24 l10 -12" className="fill-none stroke-amber-600" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      <rect x="190" y="56" width="10" height="24" rx="2" className="fill-slate-300 stroke-slate-500" strokeWidth="1.5" />
    </g>
  )
}

// Piston ou moteur commandé par deux signaux : ouvrir, fermer.
function Piston() {
  return (
    <g>
      <path d="M140 68 H160" className="stroke-slate-500" strokeWidth="4" strokeLinecap="round" />
      <rect x="160" y="54" width="40" height="28" rx="5" className="fill-slate-200 stroke-slate-500" strokeWidth="2" />
      <path d="M180 46 V32 M174 38 l6 -6 l6 6" className="fill-none stroke-emerald-600" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M180 90 V104 M174 98 l6 6 l6 -6" className="fill-none stroke-rose-600" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
    </g>
  )
}

const DRAWINGS = {
  spring_110: { badge: '110 V', extra: <Spring /> },
  open_close_24: { badge: '24 V', extra: <Piston /> },
  other: { extra: <text x="170" y="84" textAnchor="middle" fontSize="52" className="fill-slate-400 font-semibold">?</text> },
}

export default function LouverTypeChoice({ combo, label, checked, onChange, name }) {
  const drawing = DRAWINGS[combo] || DRAWINGS.other
  return (
    <label className={`relative block cursor-pointer rounded-lg border p-2 ${checked ? 'border-brand-500 bg-brand-50' : 'border-slate-200 hover:bg-slate-50'}`}>
      <input type="radio" name={name} className="sr-only" checked={checked} onChange={onChange} aria-label={label} />
      <svg viewBox="0 0 210 120" className="w-full h-28" role="img" aria-hidden="true">
        <Frame />
        {drawing.badge && <Badge text={drawing.badge} />}
        {drawing.extra}
      </svg>
      <span className="mt-1 block text-center text-sm text-slate-700">{label}</span>
    </label>
  )
}
