import { Minus, Plus } from 'lucide-react'
import { SENSOR_PRODUCTS } from '../lib/discoveryEquipmentCatalog.js'

const MAX_SENSORS = 100
const stepBtn = 'grid h-9 w-9 shrink-0 place-items-center rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 active:bg-slate-200 disabled:opacity-40 disabled:hover:bg-white'

// Compteur − [n] + ; `onChange` reçoit un nombre (boutons) ou le texte saisi.
export function CountStepper({ id, label, value, onChange, max = MAX_SENSORS }) {
  const n = Number(value) || 0
  const bound = v => Math.min(max, Math.max(0, v))
  return <div className="flex shrink-0 items-center gap-1.5">
    <button type="button" aria-label={`Retirer : ${label}`} onClick={() => onChange(bound(n - 1))} disabled={n <= 0} className={stepBtn}><Minus size={16} /></button>
    <input id={id} type="number" min="0" max={max} step="1" aria-label={label} value={value ?? 0} onChange={e => onChange(e.target.value)} className="input w-14 text-center tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none" />
    <button type="button" aria-label={`Ajouter : ${label}`} onClick={() => onChange(bound(n + 1))} disabled={n >= max} className={stepBtn}><Plus size={16} /></button>
  </div>
}

export default function DiscoveryFormOptions({ value, onChange, disabled = false }) {
  const setSensor = (role, v) => onChange({ ...value, sensors: { ...value.sensors, [role]: v } })
  return <fieldset disabled={disabled} className="space-y-4 border-t border-slate-200 pt-4">
    <legend className="text-sm font-semibold text-slate-900">Options achetées</legend>
    <div className="space-y-2 text-sm">
      <label className="flex items-center gap-2"><input type="checkbox" checked={!!value.mobile_controller} onChange={e => onChange({ ...value, mobile_controller: e.target.checked })} />Contrôleur Internet mobile</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={!!value.humidity_retention} onChange={e => onChange({ ...value, humidity_retention: e.target.checked })} />Conservation de l’humidité</label>
    </div>
    <div className="space-y-2">
      <p className="text-xs font-medium text-slate-500">Capteurs à fournir</p>
      {SENSOR_PRODUCTS.map(([role, label]) => (
        <div key={role} className="flex items-center justify-between gap-3 text-sm text-slate-700">
          <span>{label}</span>
          <CountStepper label={label} value={value.sensors?.[role]} onChange={v => setSensor(role, v)} />
        </div>
      ))}
    </div>
  </fieldset>
}
