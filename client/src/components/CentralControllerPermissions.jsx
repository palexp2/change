import {
  Fan, Wind, Flame, Heater, Waves, CloudDrizzle, Tent, Gauge, Blinds, SlidersHorizontal,
  ShieldCheck, Droplets, Sprout, AlignVerticalSpaceAround,
} from 'lucide-react'
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

// Vue en tuiles : libellé court (le groupe « Serres » porte déjà le préfixe) + icône.
const TILE_META = {
  maxNumberOfCirculationFans: ['Circulation', Fan],
  maxNumberOfFans: ['Ventilateurs', Fan],
  maxNumberOfVentilationFans: ['Extraction', Wind],
  maxNumberOfHeaters: ['Chaufferettes', Heater],
  maxNumberOfHeatPipes: ['Tuyaux chauffants', Waves],
  maxNumberOfMisters: ['Brumisateurs', CloudDrizzle],
  maxNumberOfRoofs: ['Toits', Tent],
  maxNumberOfTensiometers: ['Tensiomètres', Gauge],
  maxNumberOfThermalScreens: ['Écrans thermiques', Blinds],
  maxNumberOfValves: ['Valves', SlidersHorizontal],
  maxNumberOfGreenhousesWithAdvancedVentilation: ['Ventilation avancée', Wind],
  maxNumberOfGreenhousesWithDiseasePrevention: ['Prévention maladies', ShieldCheck],
  maxNumberOfGreenhousesWithHeating: ['Chauffage', Flame],
  maxNumberOfGreenhousesWithHumidityConservation: ['Humidité', Droplets],
  maxNumberOfGreenhousesWithIrrigation: ['Irrigation', Sprout],
  maxNumberOfGreenhousesWithRollupVentilation: ['Rouleaux', AlignVerticalSpaceAround],
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

// Le contrôleur renvoie ses permissions sous plusieurs formes : objet, ou
// liste de chaînes contenant du JSON, des lignes « clé: valeur », ou un
// message d'erreur (« Configuration JWT inconnue »). On ramène tout à
// { values: {clé: valeur}, notes: [texte non décodable] }.
function parseChunk(s, values, notes) {
  const text = String(s).trim()
  if (!text) return
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object') { collect(parsed, values, notes); return }
  } catch { /* pas du JSON */ }
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  const kv = lines.map(l => l.match(/^([A-Za-z]\w*)\s*[:=]\s*(.*)$/))
  if (kv.length && kv.every(Boolean)) {
    for (const [, k, v] of kv) values[k] = v
    return
  }
  notes.push(text)
}

function collect(input, values, notes) {
  if (input == null) return
  if (Array.isArray(input)) { input.forEach(x => collect(x, values, notes)); return }
  if (typeof input === 'string') { parseChunk(input, values, notes); return }
  if (typeof input === 'object') {
    for (const [k, v] of Object.entries(input)) {
      if (v && typeof v === 'object') collect(v, values, notes)
      else values[k] = v
    }
  }
}

function normalize(permissions) {
  const values = {}
  const notes = []
  collect(permissions, values, notes)
  return { entries: Object.entries(values), notes }
}

function Tile({ k, v }) {
  const [label, Icon] = TILE_META[k] || [formatLabel(k), SlidersHorizontal]
  const n = Number(v)
  const off = v === '' || v == null || (Number.isFinite(n) && n === 0)
  return (
    <div
      className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 ${off ? 'border-slate-100 text-slate-300' : 'border-slate-200 bg-white'}`}
      title={formatLabel(k)}
    >
      <Icon size={16} className={off ? 'text-slate-300' : 'text-brand-500'} />
      <span className={`text-lg font-semibold tabular-nums leading-none ${off ? '' : 'text-slate-900'}`}>{formatValue(v)}</span>
      <span className={`text-xs truncate ${off ? '' : 'text-slate-500'}`}>{label}</span>
    </div>
  )
}

function Tiles({ entries, notes }) {
  const greenhouses = entries.filter(([k]) => k.startsWith('maxNumberOfGreenhousesWith'))
  const equipment = entries.filter(([k]) => !k.startsWith('maxNumberOfGreenhousesWith'))
  const group = (title, list) => list.length > 0 && (
    <div>
      <div className="text-[11px] text-slate-400 mb-1">{title}</div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-1.5">
        {list.map(([k, v]) => <Tile key={k} k={k} v={v} />)}
      </div>
    </div>
  )
  return (
    <div className="space-y-2">
      {group('Serres', greenhouses)}
      {group('Équipements', equipment)}
      {notes.map((n, i) => <div key={i} className="text-xs text-amber-600">{n}</div>)}
    </div>
  )
}

export function CentralControllerPermissions({ permissions, compact = false, tiles = false }) {
  if (!permissions || typeof permissions !== 'object' || Object.keys(permissions).length === 0) {
    return null
  }
  const { entries, notes } = normalize(permissions)
  if (entries.length === 0 && notes.length === 0) return null
  if (tiles) return <Tiles entries={entries} notes={notes} />
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
        {notes.map((n, i) => <span key={i} className="text-xs text-amber-600">{n}</span>)}
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
      {notes.map((n, i) => <div key={i} className="col-span-full text-xs text-amber-600">{n}</div>)}
    </div>
  )
}

export default CentralControllerPermissions
