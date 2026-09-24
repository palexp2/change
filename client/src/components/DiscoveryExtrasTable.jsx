// Équipements supplémentaires par serre (fournaises, valves, roll-ups, toits),
// saisis par Orisha à la création d'un formulaire ou en le modifiant.
import { CountStepper } from './DiscoveryFormOptions.jsx'

export const EXTRA_COLUMNS = [['furnaces', 'Chauffage'], ['valves', 'Irrigation'], ['rollups', 'Côtés ouvrants'], ['roofs', 'Toits ouvrants']]

export function extraValue(values, card, key) {
  return Math.max(0, parseInt(values[card.key]?.[key]) || 0)
}

export function additionalEquipment(values, cards) {
  return cards.map(card => Object.fromEntries(EXTRA_COLUMNS.map(([key]) => [key, extraValue(values, card, key)])))
}

// `stepper` : gros boutons − / + par équipement (une carte par serre) au lieu du tableau de champs.
export default function DiscoveryExtrasTable({ cards, values, onChange, disabled, title = 'Équipements supplémentaires par serre', stepper = false }) {
  if (!cards.length) return null
  const set = (card, key, v) => onChange({ ...values, [card.key]: { ...values[card.key], [key]: v } })
  if (stepper) return (
    <fieldset disabled={disabled} className="space-y-3 border-t border-slate-200 pt-4">
      <legend className="text-sm font-semibold text-slate-900">{title}</legend>
      {cards.map((card, i) => <div key={card.key} className="space-y-1.5">
        <p className="text-sm text-slate-700">Serre #{i + 1} <span className="text-xs text-slate-400">{card.helper ? 'Helper' : 'Chef'}</span></p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          {EXTRA_COLUMNS.map(([key, label]) => <div key={key} className="flex items-center justify-between gap-2 text-xs text-slate-500">
            <span>{label}</span>
            <CountStepper label={`Serre #${i + 1} · ${label}`} max={50} value={values[card.key]?.[key]} onChange={v => set(card, key, v)} />
          </div>)}
        </div>
      </div>)}
    </fieldset>
  )
  return (
    <fieldset disabled={disabled} className="space-y-2 border-t border-slate-200 pt-4">
      <legend className="text-sm font-semibold text-slate-900">{title}</legend>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-slate-500">
            <th />
            {EXTRA_COLUMNS.map(([key, label]) => <th key={key} className="px-1 font-normal">{label}</th>)}
          </tr>
        </thead>
        <tbody>
          {cards.map((card, i) => <tr key={card.key}>
            <td className="py-1 pr-2 whitespace-nowrap text-slate-700">Serre #{i + 1} <span className="text-xs text-slate-400">{card.helper ? 'Helper' : 'Chef'}</span></td>
            {EXTRA_COLUMNS.map(([key, label]) => <td key={key} className="px-1 py-1">
              <input type="number" min={0} max={50} step={1} aria-label={`Serre #${i + 1} · ${label}`} className="input text-center"
                value={values[card.key]?.[key] ?? 0}
                onChange={e => set(card, key, e.target.value)} />
            </td>)}
          </tr>)}
        </tbody>
      </table>
    </fieldset>
  )
}
