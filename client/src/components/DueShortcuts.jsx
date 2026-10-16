import { localISODate } from '../lib/formatDate.js'

// Raccourcis d'échéance, comptés depuis aujourd'hui.
const DUE_SHORTCUTS = [
  { label: '1 j', days: 1 },
  { label: '3 j', days: 3 },
  { label: '1 sem', days: 7 },
  { label: '2 sem', days: 14 },
  { label: '1 mois', months: 1 },
]

export function dueFromShortcut({ days = 0, months = 0 }) {
  const d = new Date()
  if (months) d.setMonth(d.getMonth() + months)
  d.setDate(d.getDate() + days)
  return localISODate(d)
}

export default function DueShortcuts({ value, onPick }) {
  return (
    <div className="flex flex-wrap gap-1 mt-1.5">
      {DUE_SHORTCUTS.map(s => {
        const v = dueFromShortcut(s)
        return (
          <button
            key={s.label}
            type="button"
            onClick={() => onPick(v)}
            className={`btn-secondary btn-sm${value === v ? ' ring-1 ring-brand-500' : ''}`}
          >
            {s.label}
          </button>
        )
      })}
    </div>
  )
}
