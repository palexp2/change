import { useMemo } from 'react'
import { useTable } from '../lib/dataStore.js'
import { SearchableSelect } from './SearchableSelect.jsx'
import LinkCellEditor from './LinkCellEditor.jsx'

// Champ « Utilisateur » (User d'Airtable) : la valeur stockée est le NOM du
// membre de l'équipe — comme toutes les colonnes « Assigné à » / « Qui » de
// l'app, ce qui garde le filtre « Est moi » et le tri par nom tels quels.

function useActiveUserNames() {
  const users = useTable('users')
  return useMemo(() => users
    .filter(u => u.active !== 0 && !u.deleted_at && u.name)
    .map(u => u.name)
    .sort((a, b) => a.localeCompare(b, 'fr')), [users])
}

// Fiche : liste recherchable des membres, « — » pour vider.
export function UserSelect({ value, onSave, saving, testId }) {
  const names = useActiveUserNames()
  // Un ancien membre (désactivé) reste affiché tant qu'on ne change pas.
  const options = useMemo(() => (value && !names.includes(value) ? [value, ...names] : names), [value, names])
  return (
    <SearchableSelect
      value={value || ''}
      options={options}
      getOptionValue={n => n}
      getOptionLabel={n => n}
      onChange={v => { if ((v || '') !== (value || '')) onSave(v || null) }}
      emptyOption="—"
      disabled={saving}
      size="sm"
      className="input text-sm w-full"
      testId={testId}
    />
  )
}

// Tableau : même liste que la fiche, dans l'éditeur de cellule des liens.
export function UserCellEditor({ value, onCommit, onCancel }) {
  const names = useActiveUserNames()
  const col = useMemo(() => ({
    linkOptions: [{ id: '', label: '—' }, ...names.map(n => ({ id: n, label: n }))],
  }), [names])
  return <LinkCellEditor col={col} value={value} showCurrent={false} onCommit={v => onCommit(v || null)} onCancel={onCancel} />
}
