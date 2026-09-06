import { Children, isValidElement, useCallback, useEffect, useMemo, useState } from 'react'
import { GripVertical, ChevronUp, ChevronDown, X, SlidersHorizontal, Plus, Check } from 'lucide-react'
import { useAuth } from '../lib/auth.jsx'
import { useReorderDnd } from '../lib/useReorderDnd.js'
import { useDetailFieldLayout, usePeekFieldEdit } from '../lib/detailFieldLayout.jsx'
import { useFieldGate } from '../lib/fieldGate.js'
import { useExtraCustomFields } from '../lib/useDetailFields.jsx'
import { CustomFieldEditor, isEditableCustomField } from './CustomDetailFields.jsx'
import { SearchableSelect } from './SearchableSelect.jsx'
import { FieldPulse } from './FieldPulse.jsx'

// Carte de champs d'une fiche, avec mode édition de la disposition.
//
// Usage : envelopper chaque bloc de champ existant dans <DetailField>. Le
// contenu (l'éditeur du champ) reste celui de la fiche — seuls le libellé,
// l'ordre et la présence sont gérés ici.
//
//   <DetailFieldGrid entityType="tickets">
//     <DetailField id="status" label="Statut" saving={saving.status}>
//       <SearchableSelect … />
//     </DetailField>
//     …
//   </DetailFieldGrid>
//
// En mode édition (bouton dans l'en-tête du panneau latéral, ou au survol de la
// carte sur une page pleine), chaque champ gagne une poignée de déplacement et
// une croix pour le retirer ; un menu en bas remet les champs retirés. Tout est
// enregistré immédiatement (autosave) et partagé par toute l'app — d'où
// l'édition réservée aux admins.
//
// Les enfants qui ne sont pas des <DetailField> (blocs maison, sections liées)
// sont rendus tels quels à la fin de la carte, hors configuration.
//
// `record` : l'enregistrement affiché. Le passer suffit à faire apparaître dans
// la carte les champs PERSONNALISÉS de la table (lecture seule) — créer un champ
// dans /champs/:table ne demande alors aucune retouche de la fiche.
//
// `onSaveCustom(colonne, valeur)` + `savingKeys` : rendent ces champs
// personnalisés MODIFIABLES en place (autosave), comme <CustomDetailFields>. À
// ne fournir que si la route PUT de la table accepte les colonnes cf_.

export function DetailField() {
  // Composant marqueur : c'est DetailFieldGrid qui rend le bloc (il doit
  // pouvoir le réordonner, le masquer et lui ajouter les poignées d'édition).
  return null
}

// `field` : la clé du champ, pour la pastille « mis à jour ailleurs » (une
// modification venue d'Airtable ou d'un collègue s'annonce sur le libellé).
function FieldLabel({ label, saving, field, recordId }) {
  return (
    <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1 flex items-center gap-1">
      {label}
      {saving && <span className="inline-block w-3 h-3 border border-brand-400 border-t-transparent rounded-full animate-spin" />}
      <FieldPulse recordId={recordId} field={field} />
    </div>
  )
}

const NO_SAVING = {}

export function DetailFieldGrid({
  entityType,
  record = null,
  className = 'card p-5 mb-6',
  children,
  testId,
  onSaveCustom = null,
  savingKeys = NO_SAVING,
}) {
  const { user } = useAuth()
  const peek = usePeekFieldEdit()
  const [localEditing, setLocalEditing] = useState(false)

  const { fieldNodes, extras } = useMemo(() => {
    const fieldNodes = []
    const extras = []
    for (const child of Children.toArray(children)) {
      if (isValidElement(child) && child.type === DetailField) fieldNodes.push(child)
      else if (child) extras.push(child)
    }
    return { fieldNodes, extras }
  }, [children])

  // Portier des champs supprimés : un champ à la corbeille sort de la carte —
  // du rendu, du mode édition ET du menu « Ajouter un champ » — sans que la
  // fiche puisse s'y opposer. Le libellé vient de la même source que les
  // tableaux, donc un renommage se voit ici aussi. Voir lib/fieldGate.js.
  const gate = useFieldGate(entityType)

  const codeFields = useMemo(
    () => (gate.ready ? fieldNodes : [])
      .filter(n => {
        if (!n.props.id) {
          console.error('[DetailFieldGrid] <DetailField> sans `id` : impossible de le garder, bloc ignoré.', n.props)
          return false
        }
        return !gate.isDeleted(n.props.id)
      })
      .map(n => ({
        key: n.props.id,
        label: gate.labelFor(n.props.id, n.props.label),
        // `testId` : une fiche peut garder son marqueur historique sur le bloc
        // (les tests E2E existants s'y accrochent).
        testId: n.props.testId || `detail-field-${n.props.id}`,
        span2: n.props.span2,
        saving: n.props.saving,
        children: n.props.children,
      })),
    [fieldNodes, gate],
  )

  // Champs personnalisés de la table : ils rejoignent la carte sans que
  // personne n'ait à toucher au code de la fiche, et se réordonnent ou se
  // retirent comme les autres. Lecture seule (voir CustomDetailFields).
  // Les colonnes venues d'une sync sont du lot, mais repliées d'office
  // (`defaultHidden`) : elles attendent dans « Ajouter un champ ». Sinon un
  // champ existant mais jamais affiché — « Raison de la mise en attente » sur
  // une commande — restait introuvable, sans aucun moyen de le poser sur la fiche.
  const takenKeys = useMemo(() => codeFields.map(f => f.key), [codeFields])
  const extraFields = useExtraCustomFields(entityType, takenKeys, true)

  const declared = useMemo(
    () => [
      ...codeFields,
      ...(record && gate.ready ? extraFields.map(f => {
        const saving = !!savingKeys[f.key]
        const editor = onSaveCustom && isEditableCustomField(f)
          ? <CustomFieldEditor field={f} value={record[f.key]} saving={saving} onSave={onSaveCustom} />
          : null
        return {
          key: f.key,
          label: f.label,
          testId: `detail-cf-${f.key}`,
          saving,
          defaultHidden: f.defaultHidden,
          children: editor || <div className="text-sm text-slate-700">{f.render(record[f.key])}</div>,
        }
      }) : []),
    ],
    [codeFields, extraFields, record, gate, onSaveCustom, savingKeys],
  )

  const { fields, hiddenFields, applyOrder, hide, show } = useDetailFieldLayout(entityType, declared)

  // Édition réservée aux admins : la disposition est commune à tous.
  const canEdit = user?.role === 'admin'
  const editing = canEdit && (peek ? peek.editing : localEditing)

  // Sans cet enregistrement, le panneau latéral ne sait pas qu'il y a des champs
  // à personnaliser et n'affiche pas son bouton.
  const register = peek?.register
  useEffect(() => {
    if (!register || !canEdit || declared.length === 0) return
    return register()
  }, [register, canEdit, declared.length])

  const visibleKeys = useMemo(() => fields.map(f => f.key), [fields])
  const siblingsOf = useCallback(() => visibleKeys, [visibleKeys])
  const dnd = useReorderDnd({ siblingsOf, applyOrder })

  const body = editing ? (
    <div className="space-y-2" data-testid="detail-fields-editing">
      {fields.map(f => (
        <div
          key={f.key}
          data-testid={f.testId}
          data-field-key={f.key}
          onDragOver={e => dnd.dragOver(e, f.key)}
          onDrop={e => dnd.drop(e, f.key)}
          className={`relative flex items-start gap-2 rounded-lg border border-dashed px-2 py-1.5 transition-colors ${
            dnd.dragId === f.key ? 'border-brand-400 bg-brand-50/40 opacity-60' : 'border-slate-200 hover:border-slate-300'
          }`}
        >
          {dnd.dragOverId === f.key && (
            <span className={`absolute left-2 right-2 h-0.5 bg-brand-500 rounded pointer-events-none ${dnd.dragOverSide === 'before' ? '-top-1' : '-bottom-1'}`} />
          )}
          <div className="flex flex-col items-center shrink-0 pt-0.5">
            <button
              type="button"
              className="p-0.5 rounded text-slate-300 hover:text-slate-700 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent"
              title="Monter d'un cran" aria-label={`Monter ${f.label}`}
              data-testid={`detail-field-up-${f.key}`}
              disabled={dnd.isFirst(f.key)} onClick={() => dnd.move(f.key, -1)}
            ><ChevronUp size={13} /></button>
            <span
              draggable
              onDragStart={e => dnd.dragStart(e, f.key)}
              onDragEnd={dnd.dragEnd}
              className="cursor-grab active:cursor-grabbing text-slate-300 hover:text-slate-500"
              title="Glisser pour déplacer le champ"
              data-testid={`detail-field-handle-${f.key}`}
            ><GripVertical size={13} /></span>
            <button
              type="button"
              className="p-0.5 rounded text-slate-300 hover:text-slate-700 hover:bg-slate-100 disabled:opacity-30 disabled:hover:bg-transparent"
              title="Descendre d'un cran" aria-label={`Descendre ${f.label}`}
              data-testid={`detail-field-down-${f.key}`}
              disabled={dnd.isLast(f.key)} onClick={() => dnd.move(f.key, 1)}
            ><ChevronDown size={13} /></button>
          </div>
          <div className="flex-1 min-w-0">
            <FieldLabel label={f.label} saving={f.saving} field={f.key} recordId={record?.id} />
            {f.children}
          </div>
          <button
            type="button"
            onClick={() => hide(f.key)}
            title="Retirer ce champ de la fiche"
            aria-label={`Retirer ${f.label}`}
            data-testid={`detail-field-remove-${f.key}`}
            className="shrink-0 p-1 rounded text-slate-300 hover:text-red-600 hover:bg-red-50"
          ><X size={14} /></button>
        </div>
      ))}
    </div>
  ) : (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 text-sm">
      {fields.map(f => (
        <div
          key={f.key}
          data-testid={f.testId}
          data-field-key={f.key}
          className={f.span2 ? 'sm:col-span-2' : ''}
        >
          <FieldLabel label={f.label} saving={f.saving} field={f.key} recordId={record?.id} />
          {f.children}
        </div>
      ))}
    </div>
  )

  return (
    <div className={`group/fields relative ${className}`} data-testid={testId}>
      {/* Sur une page pleine, l'accès au mode édition se fait au survol de la
          carte. Dans un panneau latéral, c'est le bouton de l'en-tête. */}
      {canEdit && !peek && declared.length > 0 && (
        <button
          type="button"
          onClick={() => setLocalEditing(v => !v)}
          data-testid="detail-fields-toggle"
          aria-pressed={editing}
          title={editing ? 'Terminer la personnalisation des champs' : 'Personnaliser les champs'}
          className={`absolute top-2 right-2 p-1.5 rounded-lg transition-opacity ${
            editing ? 'text-brand-600 bg-brand-50 opacity-100' : 'text-slate-300 hover:text-brand-600 hover:bg-slate-100 opacity-0 group-hover/fields:opacity-100 focus:opacity-100'
          }`}
        >
          {editing ? <Check size={15} /> : <SlidersHorizontal size={15} />}
        </button>
      )}

      {editing && (
        <div className="mb-3 text-xs text-slate-500 flex items-center gap-1.5">
          <SlidersHorizontal size={13} className="text-brand-500" />
          Glisse les champs pour les réordonner, retire ceux qui ne servent pas.
        </div>
      )}

      {body}

      {editing && (
        <div className="mt-3 pt-3 border-t border-slate-100 flex items-center gap-2" data-testid="detail-fields-add-row">
          <Plus size={14} className="text-slate-400 shrink-0" />
          {hiddenFields.length === 0 ? (
            <span className="text-xs text-slate-400">Tous les champs de la table sont affichés.</span>
          ) : (
            <div className="w-64">
              <SearchableSelect
                value=""
                options={hiddenFields.map(f => ({ value: f.key, label: f.label }))}
                onChange={key => key && show(key)}
                placeholder={`Ajouter un champ (${hiddenFields.length})`}
                className="input text-sm w-full"
                size="sm"
                testId="detail-field-add"
              />
            </div>
          )}
          {peek && (
            <button
              type="button"
              onClick={() => peek.setEditing(false)}
              data-testid="detail-fields-done"
              className="ml-auto text-xs font-medium text-brand-600 hover:text-brand-700 hover:bg-brand-50 rounded px-2 py-1"
            >
              Terminé
            </button>
          )}
        </div>
      )}

      {extras.length > 0 && (
        <div className={editing ? 'mt-4' : 'mt-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 text-sm'}>
          {extras}
        </div>
      )}
    </div>
  )
}
