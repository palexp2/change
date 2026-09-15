import { Children, Fragment, isValidElement, useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { GripVertical, ChevronUp, ChevronDown, X, SlidersHorizontal, Plus, Check, Edit2, Trash2 } from 'lucide-react'
import { useAuth } from '../lib/auth.jsx'
import { useReorderDnd } from '../lib/useReorderDnd.js'
import { useDetailFieldLayout, usePeekFieldEdit, useRecordDeletePolicy } from '../lib/detailFieldLayout.jsx'
import { recordDeleteSpec, deleteAllowedByDefault } from '../lib/recordDelete.js'
import { useUndoableDelete } from '../lib/undoableDelete.js'
import { sync as syncStore } from '../lib/dataSync.js'
import { useConfirm } from './ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { useFieldGate } from '../lib/fieldGate.js'
import { useExtraCustomFields } from '../lib/useDetailFields.jsx'
import { useFieldOverrides } from '../lib/fieldOverrides.jsx'
import { refreshCustomFields } from '../lib/useCustomFields.js'
import { fieldKeyForView, sqlTableForView } from '../lib/customFieldDisplay.jsx'
import { TABLE_COLUMN_META, LINKED_RECORD_TYPE_LABELS } from '../lib/tableDefs.js'
import { CustomFieldEditor, isEditableCustomField } from './CustomDetailFields.jsx'
import { CustomFieldModal } from './CustomFieldModal.jsx'
import { FieldAirtableMapping } from './FieldAirtableMapping.jsx'
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
//
// `selectPills` : variante d'affichage — les champs personnalisés de type
// Sélection montrent la pastille de couleur du choix (valeur et menu) au lieu du
// texte nu. Par défaut non, les fiches gardent leur rendu texte.
//
// `taken` : colonnes que la fiche rend AILLEURS que dans la carte (en-tête du
// panneau, bloc maison) ou seulement dans certains cas — elles ne doivent pas
// revenir en double par la liste des champs personnalisés. Doit être une
// référence stable (constante de module ou useMemo).
//
// Le mode édition porte aussi la case « Suppression permise » : elle dit si un
// utilisateur peut supprimer CETTE fiche (réglage partagé, cf.
// lib/detailFieldLayout.jsx et lib/recordDelete.js). Cochée sur une fiche qui
// n'offrait pas la suppression, la carte pose l'action elle-même ; décochée,
// l'action disparaît partout et le serveur refuse le DELETE.
//
// `onDeleted` : quoi faire après cette suppression (fermer le panneau…). À
// défaut, on retourne à la liste d'origine de la ressource.

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
const NO_TAKEN = []
const NO_LINK_FILTERS = {}

export function DetailFieldGrid({
  entityType,
  record = null,
  className = 'card p-5 mb-6',
  children,
  testId,
  onSaveCustom = null,
  savingKeys = NO_SAVING,
  taken = NO_TAKEN,
  selectPills = false,
  onDeleted = null,
  // Restriction des candidats d'un champ LIEN personnalisé, décidée par la
  // fiche parce qu'elle dépend de l'enregistrement affiché (le filtre réglé sur
  // le champ, lui, est fixe) : { [colonne]: [{ column, op, value }] }. La fiche
  // Commande s'en sert pour ne proposer, en adresse de livraison, que les
  // adresses de l'entreprise liée à la commande. Référence stable attendue
  // (useMemo) — elle entre dans le calcul des blocs de champ.
  customFieldLinkFilters = NO_LINK_FILTERS,
  // Enveloppe optionnelle autour de CHAQUE bloc de champ : (field, node) => node.
  // La fiche Facture s'en sert pour garder ses règles de visibilité
  // conditionnelle (<FieldGuard>) sur les champs qu'elles concernent — la carte
  // règle la présence choisie par l'utilisateur, la règle règle celle qui dépend
  // du record.
  wrapField = null,
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
        // Libellé D'ORIGINE (celui du code) : la modale « Modifier le champ »
        // doit montrer le nom d'avant renommage pour pouvoir le réinitialiser.
        origLabel: n.props.label,
        // `testId` : une fiche peut garder son marqueur historique sur le bloc
        // (les tests E2E existants s'y accrochent).
        testId: n.props.testId || `detail-field-${n.props.id}`,
        span2: n.props.span2,
        saving: n.props.saving,
        // Champ codé qui attend dans « Ajouter un champ » au lieu de se poser
        // d'office : les fiches qui déclarent TOUS leurs champs (même les
        // secondaires) s'en servent pour garder leur carte lisible au départ.
        defaultHidden: n.props.defaultHidden,
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
  const takenKeys = useMemo(() => [...codeFields.map(f => f.key), ...taken], [codeFields, taken])
  const extraFields = useExtraCustomFields(entityType, takenKeys, true)

  const declared = useMemo(
    () => [
      ...codeFields,
      ...(record && gate.ready ? extraFields.map(f => {
        const saving = !!savingKeys[f.key]
        // Un attachement écrit sa propre cellule (voir AttachmentField) : il est
        // utilisable même sans route PUT acceptant les colonnes cf_, donc sans
        // `onSaveCustom`. Même règle que <CustomDetailFields>.
        const editable = f.type === 'attachment' || (isEditableCustomField(f) && onSaveCustom)
        const editor = editable
          ? <CustomFieldEditor field={f} value={record[f.key]} saving={saving} onSave={onSaveCustom} recordId={record.id} selectPills={selectPills} linkFilter={customFieldLinkFilters[f.key] || null} />
          : null
        return {
          key: f.key,
          label: f.label,
          testId: `detail-cf-${f.key}`,
          saving,
          defaultHidden: f.defaultHidden,
          // Ligne custom_fields brute : de quoi ouvrir la modale de champ sur
          // le bon champ (clic droit en mode édition).
          cf: f.field,
          children: editor || <div className="text-sm text-slate-700">{f.render(record[f.key])}</div>,
        }
      }) : []),
    ],
    [codeFields, extraFields, record, gate, onSaveCustom, savingKeys, selectPills, customFieldLinkFilters],
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

  // ── Modifier le champ lui-même (clic droit en mode édition) ────────────────
  // Le mode édition ne réglait que la disposition ; le nom, le type, le format
  // ou la description d'un champ demandaient d'aller dans /champs/:table. C'est
  // la MÊME modale que le clic droit sur un en-tête de tableau — un champ ne se
  // modifie qu'à un seul endroit, quel que soit l'endroit d'où on l'ouvre.
  const fieldTable = entityType ? fieldKeyForView(entityType) : null
  const cfTable = fieldTable ? sqlTableForView(fieldTable) : null
  // Chargé seulement en mode édition : une fiche en lecture n'a rien à faire
  // des personnalisations détaillées (le portier lui suffit pour les libellés).
  const { overrides: fieldOverrides, reload: reloadFieldOverrides } = useFieldOverrides(editing ? fieldTable : null)
  const [fieldMenu, setFieldMenu] = useState(null)   // { x, y, field } | null
  const [fieldModal, setFieldModal] = useState(null) // { cf } | { col } | null

  const openFieldEditor = useCallback((f) => {
    if (f.cf) { setFieldModal({ cf: f.cf }); return }
    // Champ natif : la modale attend la définition D'ORIGINE de la colonne
    // (pré-override). Les fiches nomment parfois la FK (`company_id`) là où le
    // tableau nomme le libellé joint (`company_name`) — on accepte les deux.
    const cols = TABLE_COLUMN_META[fieldTable] || []
    const meta = cols.find(c => (c.id ?? c.field) === f.key) || cols.find(c => (c.field ?? c.id) === f.key)
    const base = meta || { id: f.key, field: f.key, label: f.origLabel || f.label }
    const renderTypeLabel = LINKED_RECORD_TYPE_LABELS[base.id]
    setFieldModal({ col: renderTypeLabel ? { ...base, renderTypeLabel } : base })
  }, [fieldTable])

  const closeFieldModal = useCallback(() => setFieldModal(null), [])
  const onFieldSaved = useCallback(() => {
    reloadFieldOverrides()
    if (cfTable) refreshCustomFields(cfTable)
  }, [reloadFieldOverrides, cfTable])

  // Sortir du mode édition referme ce qu'il avait ouvert.
  useEffect(() => {
    if (!editing) { setFieldMenu(null); setFieldModal(null) }
  }, [editing])

  // Le menu se ferme aussi à Échap : il est posé au curseur, sans ancre visible.
  // En phase de CAPTURE + stopPropagation : sinon la touche refermait aussi le
  // panneau latéral qui porte la fiche.
  useEffect(() => {
    if (!fieldMenu) return
    const onKey = (e) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      setFieldMenu(null)
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [fieldMenu])

  // ── Suppression de la fiche ────────────────────────────────────────────────
  // La case vit dans le mode édition, l'action dans la carte. Les fiches qui
  // ont leur propre bouton Supprimer (contact, produit, projet…) n'ont pas de
  // `run` au registre : elles se contentent de lire la case.
  const deleteSpec = recordDeleteSpec(entityType)
  const { allowed: deleteAllowed, setAllowed: setDeleteAllowed } =
    useRecordDeletePolicy(entityType, deleteAllowedByDefault(entityType))
  const undoableDelete = useUndoableDelete()
  const confirm = useConfirm()
  const { addToast } = useToast()
  const navigate = useNavigate()
  const [deleting, setDeleting] = useState(false)

  const handleDelete = useCallback(async () => {
    if (!record?.id || !deleteSpec?.run || deleting) return
    // Suppression réversible (toast « Annuler » 8 s) : rien à confirmer avant.
    if (deleteSpec.confirm && !(await confirm({ message: deleteSpec.confirm, confirmLabel: 'Supprimer' }))) return
    setDeleting(true)
    try {
      if (deleteSpec.undoTable) {
        await undoableDelete({
          table: deleteSpec.undoTable,
          id: record.id,
          deleteFn: () => deleteSpec.run(record.id),
          label: deleteSpec.toast,
          onChange: () => { syncStore().catch(() => {}) },
        })
      } else {
        await deleteSpec.run(record.id)
        syncStore().catch(() => {})
        addToast({ message: deleteSpec.toast || 'Supprimé', type: 'success' })
      }
      if (onDeleted) onDeleted()
      else if (deleteSpec.list) navigate(deleteSpec.list)
    } catch (e) {
      addToast({ message: e.message || 'Suppression échouée', type: 'error' })
    } finally {
      setDeleting(false)
    }
  }, [record?.id, deleteSpec, deleting, confirm, undoableDelete, addToast, onDeleted, navigate])

  const onFieldContextMenu = useCallback((e, f) => {
    e.preventDefault()
    e.stopPropagation()
    setFieldMenu({ x: e.clientX, y: e.clientY, field: f })
  }, [])

  const wrap = useCallback(
    (f, node) => (wrapField ? <Fragment key={f.key}>{wrapField(f, node)}</Fragment> : node),
    [wrapField],
  )

  const body = editing ? (
    <div className="space-y-2" data-testid="detail-fields-editing">
      {fields.map(f => wrap(f, (
        <div
          key={f.key}
          data-testid={f.testId}
          data-field-key={f.key}
          onContextMenu={e => onFieldContextMenu(e, f)}
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
      )))}
    </div>
  ) : (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 text-sm">
      {fields.map(f => wrap(f, (
        <div
          key={f.key}
          data-testid={f.testId}
          data-field-key={f.key}
          className={f.span2 ? 'sm:col-span-2' : ''}
        >
          <FieldLabel label={f.label} saving={f.saving} field={f.key} recordId={record?.id} />
          {f.children}
        </div>
      )))}
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
          Glisse pour réordonner, clic droit pour modifier le champ.
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

      {/* Un utilisateur peut-il supprimer cette fiche ? Réglage partagé, comme
          la disposition des champs. */}
      {editing && deleteSpec && (
        <label className="mt-2 flex items-center gap-2 text-xs text-slate-500 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={deleteAllowed}
            onChange={e => setDeleteAllowed(e.target.checked)}
            data-testid="detail-allow-delete"
            className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
          />
          Suppression permise
        </label>
      )}

      {!editing && deleteAllowed && deleteSpec?.run && record?.id && (
        <div className="mt-4 pt-3 border-t border-slate-100">
          <button
            type="button"
            onClick={handleDelete}
            disabled={deleting}
            data-testid="detail-record-delete"
            className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-red-600 disabled:opacity-50"
          >
            <Trash2 size={13} /> {deleting ? 'Suppression…' : deleteSpec.label}
          </button>
        </div>
      )}

      {extras.length > 0 && (
        <div className={editing ? 'mt-4' : 'mt-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 text-sm'}>
          {extras}
        </div>
      )}

      {fieldMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setFieldMenu(null)}
            onContextMenu={e => { e.preventDefault(); setFieldMenu(null) }}
          />
          <div
            className="fixed z-50 bg-white border border-slate-200 rounded-lg shadow-lg py-1 min-w-[180px]"
            style={{ top: fieldMenu.y, left: fieldMenu.x }}
            data-testid="detail-field-menu"
          >
            <button
              type="button"
              onClick={() => { const f = fieldMenu.field; setFieldMenu(null); openFieldEditor(f) }}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 text-left"
              data-testid="detail-field-menu-edit"
            >
              <Edit2 size={13} /> Modifier le champ
            </button>
            <button
              type="button"
              onClick={() => { const f = fieldMenu.field; setFieldMenu(null); hide(f.key) }}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 text-left"
              data-testid="detail-field-menu-hide"
            >
              <X size={13} /> Retirer de la fiche
            </button>
          </div>
        </>
      )}

      {/* Modale UNIQUE de modification de champ — la même que le clic droit sur
          un en-tête de tableau. Champ perso → édition du champ ; champ natif →
          personnalisation (nom, type d'affichage, description) sans toucher à la
          colonne SQL ni aux syncs. */}
      {fieldModal && (
        <CustomFieldModal
          isOpen
          onClose={closeFieldModal}
          erpTable={fieldModal.col ? fieldTable : cfTable}
          editing={fieldModal.cf || null}
          native={fieldModal.col
            ? { column: fieldModal.col, override: fieldOverrides.get(fieldModal.col.id) || fieldOverrides.get(fieldModal.col.field) || null }
            : null}
          mappingSlot={(() => {
            const column = fieldModal.col
              ? (fieldModal.col.field || fieldModal.col.id)
              : fieldModal.cf?.column_name
            if (!column || !fieldTable) return null
            return <FieldAirtableMapping table={fieldTable} column={column} cfKind={fieldModal.cf?.kind || null} />
          })()}
          onSaved={onFieldSaved}
          onDeleted={() => { onFieldSaved(); closeFieldModal() }}
        />
      )}
    </div>
  )
}
