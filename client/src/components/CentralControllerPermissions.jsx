import { fmtNumber } from '../utils/formatters.js'

const PERMISSION_LABELS = {
  maxNumberOfCirculationFans: 'Ventilateurs de circulation',
  maxNumberOfFans: 'Ventilateurs',
  maxNumberOfVentilationFans: 'Ventilateurs d’extraction',
  maxNumberOfHeaters: 'Chaufferettes',
  maxNumberOfHeatPipes: 'Tuyaux chauffants',
  maxNumberOfMisters: 'Brumisateurs',
  maxNumberOfRoofs: 'Toits',
  maxNumberOfTensiometers: 'Tensiomètres',
  maxNumberOfThermalScreens: 'Écrans thermiques',
  maxNumberOfValves: 'Valves',
  maxNumberOfGreenhousesWithAdvancedVentilation: 'Serres — ventilation avancée',
  maxNumberOfGreenhousesWithDiseasePrevention: 'Serres — prévention maladies',
  maxNumberOfGreenhousesWithHeating: 'Serres — chauffage',
  maxNumberOfGreenhousesWithHumidityConservation: 'Serres — conservation humidité',
  maxNumberOfGreenhousesWithIrrigation: 'Serres — irrigation',
  maxNumberOfGreenhousesWithRollupVentilation: 'Serres — ventilation par rouleau',
}

function formatLabel(key) {
  if (PERMISSION_LABELS[key]) return PERMISSION_LABELS[key]
  return key.replace(/^maxNumberOf/, '').replace(/([A-Z])/g, ' $1').trim()
}

function formatValue(v) {
  if (v === '' || v == null) return '—'
  const n = Number(v)
  if (!Number.isFinite(n)) return String(v)
  return fmtNumber(n)
}

export function CentralControllerPermissions({ permissions, compact = false }) {
  if (!permissions || typeof permissions !== 'object' || Object.keys(permissions).length === 0) {
    return null
  }
  const entries = Object.entries(permissions)
  if (compact) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {entries.map(([k, v]) => (
          <span
            key={k}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 text-xs"
            title={formatLabel(k)}
          >
            <span className="text-slate-500">{formatLabel(k)}</span>
            <span className="font-medium text-slate-900">{formatValue(v)}</span>
          </span>
        ))}
      </div>
    )
  }
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1.5 text-sm">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-baseline justify-between gap-2">
          <span className="text-slate-500 truncate">{formatLabel(k)}</span>
          <span className="font-mono font-medium text-slate-900">{formatValue(v)}</span>
        </div>
      ))}
    </div>
  )
}

export default CentralControllerPermissions
