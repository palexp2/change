import { X, RotateCcw } from 'lucide-react'
import { SearchableSelect } from './SearchableSelect.jsx'

// Bandeau du panneau latéral réglable (mode personnalisation) : quel champ fait
// le titre, lesquels font le sous-titre. Réglage partagé, voir
// useDetailHeaderConfig (lib/detailFieldLayout.jsx).

// Valeur d'un champ en texte de bandeau. Une FK (`company_id`) se lit par son
// libellé joint (`company_name`) ; une case cochée affiche le nom du champ.
export function headerFieldText(record, key, fields) {
  if (!record || !key) return ''
  let v = record[key]
  if (key.endsWith('_id') && record[`${key.slice(0, -3)}_name`]) v = record[`${key.slice(0, -3)}_name`]
  if (typeof v === 'string' && v.startsWith('[')) {
    try { v = JSON.parse(v) } catch { /* texte ordinaire */ }
  }
  if (v === null || v === undefined || v === '' || v === false) return ''
  if (v === true) return fields?.find(f => f.key === key)?.label || ''
  const one = x => (x && typeof x === 'object' ? (x.name ?? x.label ?? x.title ?? '') : x)
  if (Array.isArray(v)) return v.map(one).filter(x => x !== '' && x != null).join(', ')
  return String(one(v) ?? '')
}

export default function PeekHeaderEditor({ fields, header, onChange }) {
  const options = fields.map(f => ({ value: f.key, label: f.label }))
  const subtitle = header?.subtitle || []
  const labelOf = key => fields.find(f => f.key === key)?.label || key
  const set = patch => onChange({ title: header?.title || null, subtitle: header?.subtitle ?? null, ...patch })

  return (
    <div className="flex items-center gap-2 flex-wrap mt-2 text-xs" data-testid="peek-header-editor">
      <div className="w-48">
        <SearchableSelect
          value={header?.title || ''}
          options={options}
          emptyOption="Titre par défaut"
          placeholder="Titre par défaut"
          onChange={v => set({ title: v || null })}
          className="input text-xs w-full"
          size="sm"
          testId="peek-header-title"
        />
      </div>
      {subtitle.map(key => (
        <span key={key} className="inline-flex items-center gap-1 rounded bg-slate-100 text-slate-600 pl-2 pr-1 py-0.5" data-testid={`peek-header-sub-${key}`}>
          {labelOf(key)}
          <button type="button" onClick={() => set({ subtitle: subtitle.filter(k => k !== key) })}
            aria-label={`Retirer ${labelOf(key)}`} className="p-0.5 rounded text-slate-400 hover:text-red-600">
            <X size={11} />
          </button>
        </span>
      ))}
      <div className="w-40">
        <SearchableSelect
          value=""
          options={options.filter(o => !subtitle.includes(o.value))}
          placeholder="+ Sous-titre"
          onChange={v => v && set({ subtitle: [...subtitle, v] })}
          className="input text-xs w-full"
          size="sm"
          testId="peek-header-sub-add"
        />
      </div>
      {header && (
        <button type="button" onClick={() => onChange(null)} title="Bandeau par défaut"
          aria-label="Bandeau par défaut" data-testid="peek-header-reset"
          className="p-1 rounded text-slate-400 hover:text-brand-600 hover:bg-slate-100">
          <RotateCcw size={13} />
        </button>
      )}
    </div>
  )
}
