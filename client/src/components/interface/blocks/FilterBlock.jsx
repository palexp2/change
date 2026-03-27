import { useState } from 'react'

export default function FilterBlock({ config, onFilterChange }) {
  const [value, setValue] = useState('')

  function handleChange(newVal) {
    setValue(newVal)
    onFilterChange(newVal)
  }

  const label = config.label || 'Filtre'
  const className = "flex-1 border rounded-lg px-2 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-300"

  if (config.field_type === 'single_select') {
    return (
      <div className="flex items-center gap-2 h-full px-2">
        <label className="text-sm text-gray-600 shrink-0">{label}</label>
        <select value={value} onChange={e => handleChange(e.target.value)} className={className}>
          <option value="">Tous</option>
          {(config.options || []).map(opt => <option key={opt} value={opt}>{opt}</option>)}
        </select>
      </div>
    )
  }

  if (config.field_type === 'boolean') {
    return (
      <div className="flex items-center gap-2 h-full px-2">
        <label className="text-sm text-gray-600 shrink-0">{label}</label>
        <select value={value} onChange={e => handleChange(e.target.value)} className={className}>
          <option value="">Tous</option>
          <option value="true">Oui</option>
          <option value="false">Non</option>
        </select>
      </div>
    )
  }

  if (config.field_type === 'date' || config.field_type === 'datetime') {
    return (
      <div className="flex items-center gap-2 h-full px-2">
        <label className="text-sm text-gray-600 shrink-0">{label}</label>
        <input type="date" value={value} onChange={e => handleChange(e.target.value)} className={className} />
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2 h-full px-2">
      <label className="text-sm text-gray-600 shrink-0">{label}</label>
      <input
        type="text"
        value={value}
        onChange={e => handleChange(e.target.value)}
        placeholder="Filtrer…"
        className={className}
      />
    </div>
  )
}
