import { useMemo } from 'react'
import { SearchableSelect } from './SearchableSelect.jsx'
import { ChoiceBadge } from '../lib/customFieldDisplay.jsx'
import { selectChoicesWithColors } from '../lib/selectChoices.js'
import { useFieldGate } from '../lib/fieldGate.js'

// Menu déroulant d'un champ Sélection (choix unique) dans une fiche ou un
// formulaire : la valeur et chaque choix en pastille de leur couleur — grise
// quand aucune n'est réglée, texte nu si le champ est réglé « sans couleur ».
// Même rendu que les cellules des tableaux.
//
// `choices` : chaînes ou { value, label, color } (cf. selectChoicesWithColors,
// ou `gate.choicesFor(clé, options)` pour un champ natif). Une valeur en place
// absente de la liste (donnée héritée) reste affichée plutôt que de sembler vide.
// `table` + `field` : champ NATIF d'une table — l'ordre, les libellés et les
// couleurs réglés sur le champ (/champs) s'appliquent aux choix déclarés.
// `colorsOnly` (avec `table` + `field`) : la page ne propose qu'une partie des
// choix du champ, avec ses propres libellés — seule la couleur réglée s'applique.
// `emptyOption={null}` : pas d'entrée vide (champ toujours rempli).
const pill = o => <ChoiceBadge color={o.color || 'gray'} className="single-select-label truncate max-w-full">{o.label}</ChoiceBadge>

export function ChoiceSelect({ value, choices, table = null, field = null, colorsOnly = false, onChange, className = 'input text-sm w-full', size = 'sm', disabled = false, testId, emptyOption = '—' }) {
  const gate = useFieldGate(table)
  const options = useMemo(() => {
    let list = selectChoicesWithColors(choices)
    if (table && field) {
      const configured = gate.choicesFor(field, choices)
      if (colorsOnly) {
        const colorOf = new Map(configured.map(c => [c.value, c.color]))
        list = list.map(c => ({ ...c, color: colorOf.get(c.value) || c.color }))
      } else {
        list = configured
      }
    }
    const v = value == null ? '' : String(value)
    return v && !list.some(c => c.value === v) ? [{ value: v, label: v, color: 'gray' }, ...list] : list
  }, [choices, value, gate, table, field, colorsOnly])
  return (
    <SearchableSelect
      value={value ?? ''}
      options={options}
      onChange={onChange}
      emptyOption={emptyOption ?? undefined}
      renderOption={pill}
      renderValue={pill}
      className={className}
      size={size}
      disabled={disabled}
      testId={testId}
    />
  )
}

// Pastille en lecture seule d'une valeur de Sélection native : couleur réglée
// sur le champ (/champs) d'abord, sinon `color` (couleur prévue par la page),
// sinon gris. `label` : libellé affiché, la valeur brute par défaut.
export function FieldChoiceBadge({ table, field, value, label, color = null, className = '' }) {
  const gate = useFieldGate(table)
  const v = value == null ? '' : String(value)
  const c = gate.choicesFor(field, [{ value: v, color }]).find(o => o.value === v)
  return <ChoiceBadge color={c?.color || 'gray'} className={className}>{label ?? v}</ChoiceBadge>
}

export default ChoiceSelect
