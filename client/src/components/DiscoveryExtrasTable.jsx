// Équipements supplémentaires par serre (fournaises, valves, roll-ups, toits, toiles),
// saisis par Orisha à la création d'un formulaire ou en le modifiant.
import { useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { CountStepper } from './DiscoveryFormOptions.jsx'

export const EXTRA_COLUMNS = [['furnaces', 'Chauffage'], ['valves', 'Irrigation'], ['rollups', 'Côtés ouvrants'], ['roofs', 'Toits ouvrants'], ['screens', 'Toiles thermiques']]
// Matériel à envoyer dans la serre (oui/non), coché par Orisha — ou déjà en place (rien à envoyer).
export const MATERIAL_COLUMNS = [['humidity_valve', 'Valve de brumisation'], ['humidity_haf', 'Boîtier 110 V HAF'], ['advanced_temperature_sensor', 'Capteur de température avancé'], ['existing_temp_sensor', 'Sonde de température déjà en place']]
// Permissions oui/non : Ventilation = louvres et ventilateurs de 2 à 4.
export const FLAG_COLUMNS = [['ventilation', 'Ventilation']]
const BOOLEAN_COLUMNS = [...FLAG_COLUMNS, ...MATERIAL_COLUMNS]
const isMaterial = key => BOOLEAN_COLUMNS.some(([k]) => k === key)

export function extraValue(values, card, key) {
  return Math.max(0, parseInt(values[card.key]?.[key]) || 0)
}

export function additionalEquipment(values, cards) {
  return cards.map(card => ({
    ...Object.fromEntries(EXTRA_COLUMNS.map(([key]) => [key, extraValue(values, card, key)])),
    ...Object.fromEntries(BOOLEAN_COLUMNS.filter(([key]) => values[card.key]?.[key] === true).map(([key]) => [key, true])),
  }))
}

// `stepper` : gros boutons − / + par équipement (une carte par serre) au lieu du tableau de champs.
// `checkbox` : une case par équipement — au plus 1 de chaque par serre.
// `collapsible` : section repliée par défaut, un clic sur le titre l'ouvre.
// `columns` : MATERIAL_COLUMNS pour le matériel à envoyer (cases oui/non).
// `helperLabel` : libellé d'une serre Helper à côté de « Serre #n ».
export default function DiscoveryExtrasTable({ cards, values, onChange, disabled, title = 'Équipements supplémentaires par serre', stepper = false, checkbox = false, collapsible = false, columns = EXTRA_COLUMNS, helperLabel = 'Helper' }) {
  const [open, setOpen] = useState(!collapsible)
  if (!cards.length) return null
  const set = (card, key, v) => onChange({ ...values, [card.key]: { ...values[card.key], [key]: v } })
  const legend = collapsible
    ? <legend><button type="button" aria-expanded={open} onClick={() => setOpen(o => !o)} className="flex items-center gap-1 text-sm font-semibold text-slate-900">
        {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}{title}
      </button></legend>
    : <legend className="text-sm font-semibold text-slate-900">{title}</legend>
  if (!open) return <fieldset className="border-t border-slate-200 pt-4">{legend}</fieldset>
  if (checkbox) return (
    <fieldset disabled={disabled} className="space-y-3 border-t border-slate-200 pt-4">
      {legend}
      {cards.map((card, i) => <div key={card.key} className="space-y-1.5">
        <p className="text-sm text-slate-700">Serre #{i + 1} <span className="text-xs text-slate-400">{card.helper ? helperLabel : 'Chef'}</span></p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          {columns.map(([key, label]) => <label key={key} className="flex items-center gap-2 text-xs text-slate-600">
            <input type="checkbox" checked={isMaterial(key) ? values[card.key]?.[key] === true : extraValue(values, card, key) > 0} onChange={e => set(card, key, isMaterial(key) ? e.target.checked : e.target.checked ? 1 : 0)} />
            {label}
          </label>)}
        </div>
      </div>)}
    </fieldset>
  )
  if (stepper) return (
    <fieldset disabled={disabled} className="space-y-3 border-t border-slate-200 pt-4">
      {legend}
      {cards.map((card, i) => <div key={card.key} className="space-y-1.5">
        <p className="text-sm text-slate-700">Serre #{i + 1} <span className="text-xs text-slate-400">{card.helper ? helperLabel : 'Chef'}</span></p>
        <div className="grid grid-cols-2 gap-x-4 gap-y-2">
          {columns.map(([key, label]) => <div key={key} className="flex items-center justify-between gap-2 text-xs text-slate-500">
            <span>{label}</span>
            <CountStepper label={`Serre #${i + 1} · ${label}`} max={50} value={values[card.key]?.[key]} onChange={v => set(card, key, v)} />
          </div>)}
        </div>
      </div>)}
    </fieldset>
  )
  return (
    <fieldset disabled={disabled} className="space-y-2 border-t border-slate-200 pt-4">
      {legend}
      <table className="w-full text-sm">
        <thead>
          <tr className="text-xs text-slate-500">
            <th />
            {columns.map(([key, label]) => <th key={key} className="px-1 font-normal">{label}</th>)}
          </tr>
        </thead>
        <tbody>
          {cards.map((card, i) => <tr key={card.key}>
            <td className="py-1 pr-2 whitespace-nowrap text-slate-700">Serre #{i + 1} <span className="text-xs text-slate-400">{card.helper ? helperLabel : 'Chef'}</span></td>
            {columns.map(([key, label]) => <td key={key} className="px-1 py-1">
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
