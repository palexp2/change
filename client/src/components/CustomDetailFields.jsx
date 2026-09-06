import { useMemo } from 'react'
import { Field } from './Field.jsx'
import { SearchableSelect } from './SearchableSelect.jsx'
import { MultiSelectField } from './MultiSelectField.jsx'
import { InlineText, InlineTextarea, InlineUrl, InlineNumber, InlineDate, InlineCheckbox } from './InlineFields.jsx'
import { AttachmentField } from './AttachmentField.jsx'
import { useFieldGate } from '../lib/fieldGate.js'
import { useExtraCustomFields } from '../lib/useDetailFields.jsx'
import { parseSelectChoices, isAirtableLinkField } from '../lib/customFieldDisplay.jsx'

// Les champs personnalisés d'une table, rendus comme des blocs de champ
// ordinaires d'une fiche.
//
// Un champ créé dans /champs/:table apparaissait dans le tableau et nulle part
// ailleurs : chaque fiche déclarant ses champs en dur, il fallait retoucher son
// code pour l'y voir. Ce composant ferme l'écart — on le pose une fois dans la
// carte de champs d'une fiche et tout champ créé ensuite s'y affiche seul.
//
//   <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
//     <Field table="products" id="sku" label="SKU">…</Field>
//     …
//     <CustomDetailFields table="products" record={product} />
//   </div>
//
// Par défaut : une LISTE de blocs, sans conteneur — ils prennent la grille de la
// fiche. `card` les enveloppe plutôt dans leur propre carte, pour les fiches
// découpées en sections où il n'y a pas de grille où les glisser ; la carte
// n'apparaît pas s'il n'y a aucun champ personnalisé. Elle porte un titre si
// `title` en fournit un — `title={null}` donne une carte sans en-tête.
//
// Lecture seule par défaut. `onSave(key, value)` rend les champs MODIFIABLES en
// place (autosave) — à ne fournir que si la route PATCH de la table accepte les
// colonnes cf_ (c'est le cas dès qu'elle utilise getWritableCustomColumns).
// Restent en lecture seule, même avec `onSave` : les champs calculés
// (formule/lookup/rollup) et les champs importés d'Airtable en sens « import »,
// dont l'écriture serait écrasée au prochain sync.
// `savingKeys` : { [colonne]: true } pendant l'aller-retour serveur.
//
// `taken` : colonnes déjà affichées par la fiche, à ne pas répéter (rare — un
// champ perso a sa propre colonne cf_, qu'aucune fiche ne connaît d'avance).
const EMPTY = []
const NO_SAVING = {}

// Un champ personnalisé porte-t-il une valeur qu'on peut écrire ?
export function isEditableCustomField(f) {
  // Un champ LIEN ne se tape pas : sa valeur est un identifiant de fiche. Il
  // s'affiche donc toujours en pastille de lien (rendu commun, cf.
  // LinkedRecordsValue) — sans quoi la fiche offrait un champ texte montrant des
  // « recXXXX » bruts. Les liens se font et se défont dans le tableau
  // (LinkCellEditor) ou depuis la fiche visée.
  if (isAirtableLinkField(f.field) || f.field?.record_link) return false
  return (!f.kind || f.kind === 'data') && f.writable !== false
}

// Éditeur inline correspondant au type du champ. `null` → pas d'éditeur pour ce
// type (image, durée…) : la fiche retombe sur l'affichage.
//
// `recordId` n'est utile qu'au champ Attachement, dont les fichiers sont
// rattachés à l'enregistrement côté serveur.
export function CustomFieldEditor({ field, value, saving, onSave, recordId }) {
  const commit = v => onSave?.(field.key, v)
  switch (field.type) {
    // Attachement : s'écrit tout seul par sa route de dépôt (les octets partent
    // au serveur de toute façon) — d'où l'absence de dépendance à `onSave`.
    case 'attachment':
      return (
        <AttachmentField
          field={field.field}
          recordId={recordId}
          value={value}
          readOnly={field.writable === false}
          onChange={onSave ? (v => commit(v)) : undefined}
        />
      )
    case 'text':
    case 'phone':
      return <InlineText value={value} saving={saving} onSave={commit} testId={`cf-input-${field.key}`} />
    case 'long_text':
      return <InlineTextarea value={value} saving={saving} onSave={commit} testId={`cf-input-${field.key}`} />
    case 'url':
      return <InlineUrl value={value} saving={saving} onSave={commit} testId={`cf-input-${field.key}`} />
    case 'number':
    case 'currency':
      return <InlineNumber value={value} saving={saving} onSave={commit} className="input text-sm w-full" testId={`cf-input-${field.key}`} />
    case 'date':
      return <InlineDate value={value} saving={saving} onSave={commit} testId={`cf-input-${field.key}`} />
    case 'checkbox':
      return <InlineCheckbox value={value} saving={saving} onSave={commit} testId={`cf-input-${field.key}`} />
    case 'single_select':
      return (
        <SearchableSelect
          value={value ?? ''}
          options={parseSelectChoices(field.field).map(c => ({ value: c.label ?? c.id, label: c.label ?? c.id }))}
          emptyOption="—"
          onChange={commit}
          className="input text-sm w-full"
          size="sm"
          disabled={saving}
          testId={`cf-input-${field.key}`}
        />
      )
    case 'multi_select':
      return (
        <MultiSelectField
          value={value}
          options={parseSelectChoices(field.field).map(c => c.label ?? c.id)}
          saving={saving}
          onChange={v => commit(v.length ? JSON.stringify(v) : '')}
          testId={`cf-input-${field.key}`}
        />
      )
    default:
      return null
  }
}

export function CustomDetailFields({
  table,
  record,
  taken = EMPTY,
  span2 = false,
  className = '',
  labelClassName,
  onSave,
  savingKeys = NO_SAVING,
  card = false,
  title = 'Champs personnalisés',
  cardClassName = 'card p-5',
  gridClassName = 'grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4',
}) {
  const takenKey = taken.join(' ')
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const takenStable = useMemo(() => taken, [takenKey])
  const fields = useExtraCustomFields(table, takenStable)
  // Même attente que <Field> : tant que le portier n'a pas répondu, rien n'est
  // rendu — sinon la carte s'affiche vide puis se remplit.
  const gate = useFieldGate(table)

  if (!record || !gate.ready) return null

  const blocks = fields.map(field => {
    const saving = !!savingKeys[field.key]
    // Le champ Attachement passe TOUJOURS par son composant dédié : sans
    // `onSave` parce qu'il écrit sa cellule lui-même (le dépôt de fichier est
    // déjà une écriture serveur), et même en lecture seule parce que lui seul
    // MONTRE les fichiers — le rendu générique, faute des identifiants qui
    // construisent les URL, se contente de les compter (« 1 fichier »).
    const editable = field.type === 'attachment' || (isEditableCustomField(field) && onSave)
    const editor = editable
      ? <CustomFieldEditor field={field} value={record[field.key]} saving={saving} onSave={onSave} recordId={record.id} />
      : null
    return (
      <Field
        key={field.key}
        table={table}
        id={field.key}
        label={field.label}
        saving={saving}
        className={`${span2 ? 'sm:col-span-2 ' : ''}${className}`}
        labelClassName={labelClassName}
        testId={`detail-cf-${field.key}`}
      >
        {editor || <div className="text-sm text-slate-700">{field.render(record[field.key])}</div>}
      </Field>
    )
  })

  if (!card) return blocks
  if (blocks.length === 0) return null

  return (
    <div className={cardClassName} data-testid={`detail-custom-fields-${table}`}>
      {title ? <div className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-4">{title}</div> : null}
      <div className={gridClassName}>{blocks}</div>
    </div>
  )
}

export default CustomDetailFields
