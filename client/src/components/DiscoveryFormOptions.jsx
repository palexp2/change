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

// Nombre de contrôleurs mobiles ; l'ancien format ne portait que la case.
const mobileCount = value => (value.mobile_controllers != null ? Number(value.mobile_controllers) || 0 : value.mobile_controller ? 1 : 0)

// `flat` : capteurs au même niveau que les contrôleurs, sans sous-titre.
// `mobileQty` : contrôleurs Internet mobiles en quantité plutôt qu'en case.
export default function DiscoveryFormOptions({ value, onChange, disabled = false, title = 'Options achetées', flat = false, mobileQty = false }) {
  const setSensor = (role, v) => onChange({ ...value, sensors: { ...value.sensors, [role]: v } })
  const setMobile = v => onChange({ ...value, mobile_controllers: v, mobile_controller: Number(v) > 0 })
  return <fieldset disabled={disabled} className={`${flat ? 'space-y-2' : 'space-y-4'} border-t border-slate-200 pt-4`}>
    <legend className="text-sm font-semibold text-slate-900">{title}</legend>
    <div className="space-y-2 text-sm">
      {mobileQty
        ? <div className="flex items-center justify-between gap-3 text-slate-700">
          <span>Contrôleur Internet mobile</span>
          <CountStepper label="Contrôleur Internet mobile" max={20} value={mobileCount(value)} onChange={setMobile} />
        </div>
        : <label className="flex items-center gap-2"><input type="checkbox" checked={mobileCount(value) > 0} onChange={e => setMobile(e.target.checked ? Math.max(1, mobileCount(value)) : 0)} />Contrôleur Internet mobile</label>}
      <div className="flex items-center justify-between gap-3 text-slate-700">
        <span>Contrôleur central additionnel</span>
        <CountStepper label="Contrôleur central additionnel" max={20} value={value.extra_central_controllers} onChange={v => onChange({ ...value, extra_central_controllers: v })} />
      </div>
    </div>
    <div className="space-y-2">
      {!flat && <p className="text-xs font-medium text-slate-500">Capteurs à fournir</p>}
      {SENSOR_PRODUCTS.map(([role, label]) => (
        <div key={role} className="flex items-center justify-between gap-3 text-sm text-slate-700">
          <span>{label}</span>
          <CountStepper label={label} value={value.sensors?.[role]} onChange={v => setSensor(role, v)} />
        </div>
      ))}
    </div>
  </fieldset>
}
