import { SENSOR_PRODUCTS } from '../lib/discoveryEquipmentCatalog.js'

export default function DiscoveryFormOptions({ value, onChange, disabled = false }) {
  return <fieldset disabled={disabled} className="space-y-4 border-t border-slate-200 pt-4">
    <legend className="text-sm font-semibold text-slate-900">Options achetées</legend>
    <div className="space-y-2 text-sm">
      <label className="flex items-center gap-2"><input type="checkbox" checked={!!value.mobile_controller} onChange={e => onChange({ ...value, mobile_controller: e.target.checked })} />Contrôleur Internet mobile</label>
      <label className="flex items-center gap-2"><input type="checkbox" checked={!!value.humidity_retention} onChange={e => onChange({ ...value, humidity_retention: e.target.checked })} />Conservation de l’humidité</label>
    </div>
    <div className="space-y-2">
      <p className="text-xs font-medium text-slate-500">Capteurs à fournir</p>
      {SENSOR_PRODUCTS.map(([role, label]) => <label key={role} className="flex items-center justify-between gap-3 text-sm text-slate-700">
        <span>{label}</span><input type="number" min="0" max="100" step="1" aria-label={label} value={value.sensors?.[role] ?? 0} onChange={e => onChange({ ...value, sensors: { ...value.sensors, [role]: e.target.value } })} className="input w-20 shrink-0 text-right tabular-nums" />
      </label>)}
    </div>
  </fieldset>
}
