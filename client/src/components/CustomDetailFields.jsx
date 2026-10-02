import { useMemo } from 'react'
import { Field } from './Field.jsx'
import { SearchableSelect } from './SearchableSelect.jsx'
import { MultiSelectField } from './MultiSelectField.jsx'
import { InlineText, InlineTextarea, InlineUrl, InlineNumber, InlineDuration, InlineDate, InlineCheckbox } from './InlineFields.jsx'
import { AttachmentField } from './AttachmentField.jsx'
import { RatingInput } from './RatingStars.jsx'
import { useFieldGate } from '../lib/fieldGate.js'
import { useExtraCustomFields } from '../lib/useDetailFields.jsx'
import { parseSelectChoices, colorForChoice, ChoiceBadge, isAirtableLinkField, LinkedRecordsValue, dateFormatOf, durationFormatOf } from '../lib/customFieldDisplay.jsx'
import { dateFormatHasTime } from '../lib/formatDate.js'

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
  return (!f.kind || f.kind === 'data') && f.writable !== false
}

// Champ dont la valeur est un identifiant de fiche : il ne se tape pas, il se
// choisit dans un picker recherchable (CLAUDE.md → « champs référence »). Un
// LOOKUP qui rapatrie un lien porte la même métadonnée sans être écrivable pour
// autant — c'est isEditableCustomField (kind) qui l'écarte.
export function isLinkCustomField(f) {
  return isAirtableLinkField(f?.field) || !!f?.field?.record_link
}

// Éditeur inline correspondant au type du champ. `null` → pas d'éditeur pour ce
// type (image…) : la fiche retombe sur l'affichage.
//
// `recordId` n'est utile qu'au champ Attachement, dont les fichiers sont
// rattachés à l'enregistrement côté serveur.
//
// `selectPills` : variante d'affichage d'une Sélection — la valeur choisie et
// les options du menu portent la pastille de couleur configurée sur le champ,
// comme dans les tableaux. Par défaut l'éditeur reste en texte simple.
//
// `linkFilter` : pour un champ LIEN, restriction supplémentaire des candidats
// proposés, décidée par la fiche (cf. LinkedRecordsValue → `extraFilter`).
// `widePicker` : pour un champ LIEN, liste déroulante large aux libellés entiers.
export function CustomFieldEditor({ field, value, saving, onSave, recordId, selectPills = false, linkFilter = null, widePicker = false, compactNumber = false }) {
  const commit = v => onSave?.(field.key, v)
  // Champ lien : la valeur est un (ou des) identifiant(s) de fiche — pastille
  // cliquable + picker recherchable de la table cible, le même dans toutes les
  // fiches. Traité avant le switch : son type STOCKÉ est 'text'.
  if (isLinkCustomField(field)) {
    return <LinkedRecordsValue field={field.field} value={value} detail onChange={commit} saving={saving} extraFilter={linkFilter} widePicker={widePicker} />
  }
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
      return <InlineNumber value={value} saving={saving} onSave={commit} compact={compactNumber} className="input text-sm w-full" testId={`cf-input-${field.key}`} />
    // Pourcentage : la colonne porte le nombre de pourcents — on saisit 45, le
    // « % » est là pour le dire (la barre de progression, elle, est un rendu de
    // lecture : cf. PercentValue).
    case 'percent':
      return <InlineNumber value={value} saving={saving} onSave={commit} suffix="%" className="input text-sm w-full" testId={`cf-input-${field.key}`} />
    case 'duration':
      return <InlineDuration value={value} saving={saving} onSave={commit} format={durationFormatOf(field.field)} testId={`cf-input-${field.key}`} />
    case 'date':
      return <InlineDate value={value} saving={saving} onSave={commit} withTime={dateFormatHasTime(dateFormatOf(field.field))} testId={`cf-input-${field.key}`} />
    case 'checkbox':
      return <InlineCheckbox value={value} saving={saving} onSave={commit} testId={`cf-input-${field.key}`} />
    // Évaluation : les 5 étoiles, cliquables (re-cliquer l'étoile courante
    // retire la note). Autosave comme les autres champs de fiche.
    case 'rating':
      return <RatingInput value={value} disabled={saving} onChange={commit} testId={`cf-input-${field.key}`} />
    case 'single_select': {
      const choices = parseSelectChoices(field.field)
      const pill = o => <ChoiceBadge color={colorForChoice(choices, o.label)} className="single-select-label">{o.label}</ChoiceBadge>
      return (
        <SearchableSelect
          value={value ?? ''}
          options={choices.map(c => ({ value: c.label ?? c.id, label: c.label ?? c.id }))}
          emptyOption="—"
          onChange={commit}
          className="input text-sm w-full"
          size="sm"
          disabled={saving}
          renderValue={selectPills ? pill : undefined}
          renderOption={selectPills ? pill : undefined}
          testId={`cf-input-${field.key}`}
        />
      )
    }
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
