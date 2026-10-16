import { hasRole } from '../../../shared/roles.mjs'
import { Children, Fragment, isValidElement, lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { X, Plus, Check, Edit2, Trash2, FolderPlus, Eye, EyeOff, Lock } from 'lucide-react'
import { useAuth } from '../lib/auth.jsx'
import api from '../lib/api.js'
import { useReorderDnd } from '../lib/useReorderDnd.js'
import { useDetailFieldLayout, usePeekFieldEdit, useRecordDeletePolicy } from '../lib/detailFieldLayout.jsx'
import { recordDeleteSpec, deleteAllowedByDefault } from '../lib/recordDelete.js'
import { useUndoableDelete } from '../lib/undoableDelete.js'
import { sync as syncStore } from '../lib/dataSync.js'
import { useConfirm } from './ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { useFieldGate } from '../lib/fieldGate.js'
import { useExtraCustomFields } from '../lib/useDetailFields.jsx'
import { useFieldOverrides, renderOverriddenValue } from '../lib/fieldOverrides.jsx'
import { FieldFormatContext } from '../lib/fieldFormat.js'
import { refreshCustomFields, useCustomFields } from '../lib/useCustomFields.js'
import { fieldKeyForView, sqlTableForView, parseSelectChoices } from '../lib/customFieldDisplay.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { linkedRecordTypeLabel, linkedRecordTypeLabelOfNode } from '../lib/linkedRecordType.js'
import { CustomFieldEditor, isEditableCustomField } from './CustomDetailFields.jsx'
import { CustomFieldModal } from './CustomFieldModal.jsx'
import { FieldAirtableMapping } from './FieldAirtableMapping.jsx'
import { FieldPulse } from './FieldPulse.jsx'
import ThinkingOrb from './ThinkingOrb'
import { useFieldVisibilityRules } from '../lib/useFieldVisibilityRules.js'
import { shouldHide } from '../lib/fieldVisibility.js'

const NO_OVER = { key: null, zone: null }
const GRID_DROP_BAR = {
  left: '-top-1 -bottom-1 -left-2 w-0.5',
  right: '-top-1 -bottom-1 -right-2 w-0.5',
  top: '-left-1 -right-1 -top-2 h-0.5',
  bottom: '-left-1 -right-1 -bottom-2 h-0.5',
}
// Nouvel ordre complet si `src` est déposé dans `zone` de `targetKey`, calculé
// dans la grille affichée (`list`, `cols` colonnes) puis reporté sur l'ordre
// global (`allKeys`).
function planGridMove(src, targetKey, zone, list, cols, allKeys) {
  const local = list.map(f => f.key).filter(k => k !== src)
  const ti = local.indexOf(targetKey)
  if (ti < 0) return null
  let p
  if (zone === 'left') p = ti
  else if (zone === 'right') p = ti + 1
  else if (zone === 'top') p = Math.max(0, ti + 1 - cols)
  else p = ti + cols
  const next = allKeys.filter(k => k !== src)
  if (p >= local.length) next.splice(next.indexOf(local[local.length - 1]) + 1, 0, src)
  else next.splice(next.indexOf(local[p]), 0, src)
  return next
}
// Fiche à deux colonnes, en rangées : chaque rangée a une case gauche et une
// case droite, l'une ou l'autre pouvant rester vide (deux champs côte à côte
// sans rien au-dessus, ou un champ retiré qui laisse sa case vide sans que les
// autres bougent). Un champ large (span2) occupe sa rangée. Sans réglage, les
// champs s'alternent gauche/droite comme l'ancienne grille.
function rowsOf(list, colOf, brkKeys) {
  const rows = []
  let cur = null
  let n = 0
  for (const f of list) {
    if (f.span2) { rows.push({ wide: f }); cur = null; n = 0; continue }
    const stored = colOf.get(f.key)
    const c = stored === 0 || stored === 1 ? stored : n % 2
    n++
    if (c === 1 && cur && !cur.cells[1] && !brkKeys.has(f.key)) cur.cells[1] = f
    else { cur = { cells: [null, null] }; cur.cells[c] = f; rows.push(cur) }
  }
  return rows
}
// Rangées → ordre des clés + case de chaque champ.
function serializeRows(rows, keys, placement) {
  for (const r of rows) {
    if (r.wide) { keys.push(r.wide.key); continue }
    const [a, b] = r.cells
    if (a) { keys.push(a.key); placement[a.key] = { col: 0 } }
    if (b) { keys.push(b.key); placement[b.key] = { col: 1, brk: !a } }
  }
}
// Menu « ajouter un champ » posé au curseur : recherche + champs retirés.
function AddFieldMenu({ x, y, fields, onPick, onClose, onAddGroup, deleteToggle }) {
  const [q, setQ] = useState('')
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose() } }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [onClose])
  const shown = fields.filter(f => f.label.toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={e => { e.preventDefault(); onClose() }} />
      <div
        className="fixed z-50 w-64 bg-white border border-slate-200 rounded-lg shadow-lg overflow-hidden"
        style={{ top: Math.min(y, window.innerHeight - 320), left: Math.min(x, window.innerWidth - 272) }}
        data-testid="detail-field-add-menu"
      >
        <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-100">
          <Plus size={13} className="text-slate-400 shrink-0" />
          <input
            autoFocus
            value={q}
            onChange={e => setQ(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && shown[0]) onPick(shown[0]) }}
            className="w-full text-sm outline-none bg-transparent"
            aria-label="Ajouter un champ"
          />
        </div>
        <div className="max-h-64 overflow-y-auto py-1">
          {shown.length === 0 ? (
            <div className="px-3 py-2 text-xs text-slate-400">—</div>
          ) : shown.map(f => (
            <button
              key={f.key}
              type="button"
              onClick={() => onPick(f)}
              className="block w-full px-3 py-1.5 text-sm text-left text-slate-700 hover:bg-slate-50 truncate"
            >{f.label}</button>
          ))}
        </div>
        {(onAddGroup || deleteToggle) && (
          <div className="border-t border-slate-100 py-1">
            {onAddGroup && (
              <button
                type="button"
                onClick={onAddGroup}
                data-testid="detail-group-add"
                className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-left text-slate-700 hover:bg-slate-50"
              ><FolderPlus size={13} /> Nouveau groupe</button>
            )}
            {deleteToggle && (
              <label className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={deleteToggle.checked}
                  onChange={e => deleteToggle.onChange(e.target.checked)}
                  data-testid="detail-allow-delete"
                  className="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                />
                Suppression permise
              </label>
            )}
          </div>
        )}
      </div>
    </>
  )
}

// Valeur d'un champ natif reformaté : si la page fournit un éditeur, il reste
// (et reçoit le format par contexte) ; si elle ne fait qu'afficher, la valeur
// est rendue selon le nouveau format. Le contenu de la page reste monté (caché)
// pour savoir s'il devient un éditeur.
function OverrideAwareValue({ format, value, children }) {
  const ref = useRef(null)
  const [isEditor, setIsEditor] = useState(true)
  // Relu à chaque rendu (le contenu de la page peut changer), borné par la garde.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const next = !!ref.current?.querySelector('input, select, textarea, [contenteditable="true"]')
    if (next !== isEditor) setIsEditor(next)
  })
  return (
    <FieldFormatContext.Provider value={format}>
      <div ref={ref} className={isEditor ? 'contents' : 'hidden'}>{children}</div>
      {!isEditor && <div className="text-sm py-1.5">{renderOverriddenValue(format, value)}</div>}
    </FieldFormatContext.Provider>
  )
}

// Lecture seule : les éditeurs qui s'ouvrent au clic (pas des contrôles de
// formulaire, que le <fieldset disabled> couvre déjà) sont bloqués aussi ;
// les liens vers d'autres fiches restent cliquables.
function blockEdit(e) {
  if (e.target.closest?.('a[href]')) return
  e.preventDefault()
  e.stopPropagation()
}

const CF_FORMAT_TYPES = new Set(['number', 'currency', 'percent', 'date', 'phone', 'rating'])

const FieldVisibilityRuleModal = lazy(() => import('./FieldVisibilityRuleModal.jsx'))

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
// `shownSynced` : colonnes de sync que la fiche pose d'office (au lieu de les
// laisser repliées dans « Ajouter un champ »). Référence stable.
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
function FieldLabel({ label, saving, field, recordId, dense = false, side = false }) {
  return (
    <div className={`${dense ? 'text-[11px]' : 'text-xs'} ${side ? 'pt-1.5 break-words' : dense ? 'mb-0.5' : 'mb-1'} font-medium text-slate-400 uppercase tracking-wide flex items-center gap-1`}>
      {label}
      {saving && <ThinkingOrb size={12} />}
      <FieldPulse recordId={recordId} field={field} />
    </div>
  )
}

// Nom d'un groupe créé par l'utilisateur : enregistré à la sortie du champ.
function GroupNameInput({ group, autoFocus, onRename }) {
  const commit = e => {
    const v = e.target.value.trim()
    if (v !== group.label) onRename(group.key, v)
  }
  return (
    <input
      key={group.label}
      defaultValue={group.label}
      autoFocus={autoFocus}
      onFocus={e => autoFocus && e.target.select()}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') e.target.blur() }}
      aria-label="Nom du groupe"
      data-testid={`detail-group-name-${group.key}`}
      className="flex-1 min-w-0 bg-transparent text-sm font-semibold text-slate-700 outline-none border-b border-transparent focus:border-brand-400"
    />
  )
}

// Libellé d'un champ renommé en place (option `renameInPlace`) : enregistré à la
// sortie du champ, Échap annule.
function FieldLabelInput({ label, onCommit, onCancel, testId }) {
  return (
    <input
      autoFocus
      defaultValue={label}
      onFocus={e => e.target.select()}
      onBlur={e => onCommit(e.target.value.trim())}
      onKeyDown={e => {
        if (e.key === 'Enter') e.target.blur()
        else if (e.key === 'Escape') { e.stopPropagation(); onCancel() }
      }}
      onMouseDown={e => e.stopPropagation()}
      aria-label="Nom du champ"
      data-testid={testId}
      className="w-full mb-1 bg-transparent text-xs font-medium text-slate-600 uppercase tracking-wide outline-none border-b border-brand-400"
    />
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
  shownSynced = NO_TAKEN,
  // Rend les adresses web des champs texte cliquables, sur demande de la fiche.
  linkifyTextUrls = false,
  onDeleted = null,
  // Restriction des candidats d'un champ LIEN personnalisé, décidée par la
  // fiche parce qu'elle dépend de l'enregistrement affiché (le filtre réglé sur
  // le champ, lui, est fixe) : { [colonne]: [{ column, op, value }] }. La fiche
  // Commande s'en sert pour ne proposer, en adresse de livraison, que les
  // adresses de l'entreprise liée à la commande. Référence stable attendue
  // (useMemo) — elle entre dans le calcul des blocs de champ.
  customFieldLinkFilters = NO_LINK_FILTERS,
  // Champs LIEN dont la liste déroulante s'ouvre large, libellés entiers
  // (adresse de livraison de la fiche Commande). Référence stable attendue.
  wideLinkPickers = NO_TAKEN,
  // Champs nombre affichés sans zéros décimaux inutiles (« 6 », pas « 6.0 »).
  // Référence stable attendue.
  compactNumbers = NO_TAKEN,
  // Enveloppe optionnelle autour de CHAQUE bloc de champ : (field, node) => node.
  // La fiche Facture s'en sert pour garder ses règles de visibilité
  // conditionnelle (<FieldGuard>) sur les champs qu'elles concernent — la carte
  // règle la présence choisie par l'utilisateur, la règle règle celle qui dépend
  // du record.
  wrapField = null,
  // Disposition de lecture propre à une fiche, après l'ordre et la visibilité
  // enregistrés. Le mode personnalisation conserve les champs indépendants.
  arrangeFields = null,
  // Sous-groupes de lecture : [{ id, label, keys }]. Leurs champs quittent la
  // grille principale pour une sous-section titrée (ordre réglé conservé). Le
  // mode personnalisation reste à plat. Référence stable attendue.
  groups = NO_TAKEN,
  // Option : l'utilisateur peut créer ses propres groupes dans le mode
  // personnalisation (bouton « Groupe »). Les groupes déjà créés s'affichent
  // dans tous les cas.
  allowGroups = false,
  // Option : mode personnalisation sans flèches ni poignée — on glisse un champ
  // par son libellé (un groupe, par sa ligne). Fiche Produit.
  bareReorder: _bareReorder = false,
  // Option : en mode personnalisation, un clic sur le libellé d'un champ le
  // renomme sur place (même enregistrement que la modale « Modifier le
  // champ »). Fiche Produit.
  renameInPlace = false,
  // Option : lecture compacte — autant de colonnes que la largeur en permet,
  // espacements serrés. Fiche Commande.
  dense = false,
  // Option : pas d'œil « Masqué sous condition » à droite des champs régis par
  // une règle (la règle reste au clic droit du champ). Fiche Produit.
  hideVisRuleBadge = false,
  // Option : dans la modale de visibilité, un champ Sélection (<DetailField
  // choices> ou champ perso single_select) se teste par menu de pastilles,
  // avec « est l'un des / n'est aucun des » ; une case à cocher (<DetailField
  // checkbox> ou champ perso checkbox) par une case vide ou cochée. Fiche Produit.
  visRuleChoices = false,
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
        // Choix d'un champ Sélection (option `visRuleChoices`) : la modale de
        // visibilité les propose en menu coloré.
        choices: n.props.choices,
        // Case à cocher (option `visRuleChoices`) : la valeur testée se coche.
        checkbox: n.props.checkbox,
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
          ? <CustomFieldEditor field={f} value={record[f.key]} saving={saving} onSave={onSaveCustom} recordId={record.id} linkFilter={customFieldLinkFilters[f.key] || null} widePicker={wideLinkPickers.includes(f.key)} compactNumber={compactNumbers.includes(f.key)} />
          : null
        return {
          key: f.key,
          label: f.label,
          testId: `detail-cf-${f.key}`,
          saving,
          defaultHidden: f.defaultHidden && !shownSynced.includes(f.key),
          // Ligne custom_fields brute : de quoi ouvrir la modale de champ sur
          // le bon champ (clic droit en mode édition).
          cf: f.field,
          children: editor || <div className="text-sm text-slate-700 py-1.5">{f.render(record[f.key], { linkifyTextUrls })}</div>,
        }
      }) : []),
    ],
    [codeFields, extraFields, record, gate, onSaveCustom, savingKeys, linkifyTextUrls, customFieldLinkFilters, wideLinkPickers, compactNumbers, shownSynced],
  )

  const { fields, items, userGroups, hiddenFields, colOf, brkKeys, readonlyKeys, setReadonly, applyOrder, hide, addGroup, renameGroup, removeGroup } = useDetailFieldLayout(entityType, declared)
  const [newGroupKey, setNewGroupKey] = useState(null)
  const allGroups = useMemo(() => {
    if (!userGroups.length) return groups
    const codeKeys = new Set(groups.flatMap(g => g.keys))
    return [...groups, ...userGroups.map(g => ({ ...g, label: g.label || 'Sans titre', keys: g.keys.filter(k => !codeKeys.has(k)) }))]
  }, [groups, userGroups])
  // Visibilité conditionnelle (clic droit en mode édition → « Masquer sous
  // condition… ») : en lecture, un champ dont une règle s'applique au record
  // disparaît ; le mode édition les garde tous, marqués d'un œil barré.
  const visContext = entityType ? `detail:${entityType}` : null
  const { rules: visRules, invalidate: invalidateVisRules } = useFieldVisibilityRules(visContext)
  // Champs masqués par une règle pour CE record. Le bouton « champs cachés »
  // (admin) les remet à l'écran, grisés, pour régler leur affichage.
  const ruleHiddenKeys = useMemo(() => new Set(
    visRules.length ? fields.filter(f => shouldHide(visRules.filter(r => r.field_id === f.key), record)).map(f => f.key) : [],
  ), [fields, visRules, record])
  const isAdmin = hasRole(user, 'admin')
  const revealHidden = isAdmin && (peek ? peek.editing : localEditing)
  const shownFields = useMemo(
    () => (revealHidden || !ruleHiddenKeys.size ? fields : fields.filter(f => !ruleHiddenKeys.has(f.key))),
    [fields, ruleHiddenKeys, revealHidden],
  )
  const displayFields = useMemo(
    () => arrangeFields ? arrangeFields(shownFields) : shownFields,
    [shownFields, arrangeFields],
  )
  const { mainFields, groupSections } = useMemo(() => {
    if (!allGroups.length) return { mainFields: displayFields, groupSections: [] }
    const grouped = new Set(allGroups.flatMap(g => g.keys))
    return {
      mainFields: displayFields.filter(f => !grouped.has(f.key)),
      groupSections: allGroups
        .map(g => ({ ...g, fields: displayFields.filter(f => g.keys.includes(f.key)) }))
        // Un groupe créé par l'admin reste visible vide : on y ajoute des champs.
        .filter(g => g.fields.length || (isAdmin && g.id.startsWith('grp:'))),
    }
  }, [displayFields, allGroups, isAdmin])

  // Édition réservée aux admins : la disposition est commune à tous.
  const canEdit = isAdmin
  const editing = revealHidden

  // Sans cet enregistrement, le panneau latéral ne sait pas qu'il y a des champs
  // à personnaliser et n'affiche pas son bouton.
  const register = peek?.register
  useEffect(() => {
    if (!register || !canEdit || declared.length === 0) return
    return register()
  }, [register, canEdit, declared.length])

  // Bandeau du panneau réglable : le panneau a besoin des champs de la fiche
  // (choix du titre / sous-titre) et de l'enregistrement à jour (leurs valeurs).
  // Publié pour tous, pas seulement les admins : le bandeau choisi vaut pour tout le monde.
  const publishHeader = peek?.publishHeader
  const [headerToken] = useState(() => ({}))
  const headerFields = useMemo(() => declared.map(f => ({ key: f.key, label: f.label })), [declared])
  useEffect(() => {
    if (!publishHeader || !entityType || !record) return
    publishHeader(headerToken, { entityType, fields: headerFields, record })
  }, [publishHeader, headerToken, entityType, headerFields, record])
  useEffect(() => () => publishHeader?.(headerToken, null), [publishHeader, headerToken])

  const visibleKeys = useMemo(() => items.map(f => f.key), [items])
  const siblingsOf = useCallback(() => visibleKeys, [visibleKeys])
  const dnd = useReorderDnd({ siblingsOf, applyOrder })

  // Glisser en lecture (grille à 2 colonnes) : 4 zones de dépôt. Gauche/droite
  // = à côté de la cible ; haut/bas = empilé au-dessus/au-dessous d'elle, en
  // sautant d'une rangée selon le nombre de colonnes réellement affichées.
  // La barre affichée EST le dépôt : le relâcher n'importe où dans la grille
  // (y compris dans l'espace entre deux champs) applique ce qu'elle montre, et
  // elle n'apparaît que si le dépôt change vraiment l'ordre.
  const [gridOver, setGridOver] = useState(NO_OVER)
  const gridPlan = useRef(null) // { next, cols? } | null
  const resetGrid = useCallback(() => { gridPlan.current = null; setGridOver(NO_OVER) }, [])
  // Grilles de lecture de la fiche, dans l'ordre : champs principaux, groupes
  // du code, puis groupes de l'utilisateur (leur en-tête fait partie de l'ordre).
  const layoutLists = useMemo(() => {
    const grouped = new Set(allGroups.flatMap(g => g.keys))
    return [
      { header: null, fields: displayFields.filter(f => !grouped.has(f.key)) },
      ...allGroups.map(g => ({
        header: visibleKeys.includes(g.id) ? g.id : null,
        fields: displayFields.filter(f => g.keys.includes(f.key)),
      })),
    ]
  }, [displayFields, allGroups, visibleKeys])
  const rowsByKeyList = useCallback(() => layoutLists.map(l => ({ header: l.header, rows: rowsOf(l.fields, colOf, brkKeys) })), [layoutLists, colOf, brkKeys])
  const serializeLists = useCallback((lists) => {
    const keys = []
    const placement = {}
    for (const l of lists) {
      if (l.header) keys.push(l.header)
      serializeRows(l.rows, keys, placement)
    }
    // Champs absents des grilles (masqués par une règle…) : gardés après leur
    // prédécesseur d'origine.
    visibleKeys.forEach((k, i) => {
      if (keys.includes(k)) return
      const prev = visibleKeys.slice(0, i).reverse().find(p => keys.includes(p))
      keys.splice(prev ? keys.indexOf(prev) + 1 : 0, 0, k)
    })
    return { next: keys, placement }
  }, [visibleKeys])
  const showPlan = useCallback((plan, key, zone) => {
    gridPlan.current = plan
    const shown = plan ? { key, zone } : NO_OVER
    setGridOver(prev => (prev.key === shown.key && prev.zone === shown.zone ? prev : shown))
  }, [])
  const gridDragOver = useCallback((e, key, list) => {
    const src = dnd.dragId
    if (!src) return
    e.preventDefault()
    e.stopPropagation()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
    // Pile d'une colonne : seul le haut ou le bas de la case compte.
    const r = e.currentTarget.getBoundingClientRect()
    const zone = e.clientY - r.top < r.height / 2 ? 'top' : 'bottom'
    const next = src === key ? null : planGridMove(src, key, zone, list, 1, visibleKeys)
    const changed = next && next.some((k, i) => k !== visibleKeys[i])
    showPlan(changed ? { next } : null, key, zone)
  }, [dnd.dragId, visibleKeys, showPlan])
  // Clic droit sur une case vide / le fond d'une grille → ajouter un champ
  // retiré de la fiche, posé à cet endroit.
  const [addMenu, setAddMenu] = useState(null) // { x, y, target } | null
  const openAddMenu = useCallback((e, target) => {
    if (!canEdit || e.target !== e.currentTarget) return
    e.preventDefault()
    e.stopPropagation()
    setAddMenu({ x: e.clientX, y: e.clientY, target })
  }, [canEdit])
  const addFieldAt = useCallback((f, target) => {
    setAddMenu(null)
    const lists = rowsByKeyList()
    if (target.anchor) {
      const l = lists.find(x => x.rows.some(r => r.cells?.some(c => c?.key === target.anchor)))
      const row = l?.rows.find(r => r.cells?.some(c => c?.key === target.anchor))
      if (!row) return
      if (f.span2) l.rows.splice(l.rows.indexOf(row) + 1, 0, { wide: f })
      else row.cells[target.col] = f
    } else {
      const l = lists[target.list]
      if (!l) return
      l.rows.push(f.span2 ? { wide: f } : { cells: [f, null] })
    }
    const { next, placement } = serializeLists(lists)
    applyOrder(next, f.key, placement)
  }, [rowsByKeyList, serializeLists, applyOrder])

  const gridContainerDragOver = useCallback((e) => {
    if (!dnd.dragId) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  }, [dnd.dragId])
  const gridDrop = useCallback((e) => {
    e.preventDefault()
    const plan = gridPlan.current
    const src = dnd.dragId
    resetGrid()
    dnd.dragEnd()
    if (plan && src) applyOrder(plan.next, src, plan.cols)
  }, [dnd, resetGrid, applyOrder])

  // ── Modifier le champ lui-même (clic droit en mode édition) ────────────────
  // Le mode édition ne réglait que la disposition ; le nom, le type, le format
  // ou la description d'un champ demandaient d'aller dans /champs/:table. C'est
  // la MÊME modale que le clic droit sur un en-tête de tableau — un champ ne se
  // modifie qu'à un seul endroit, quel que soit l'endroit d'où on l'ouvre.
  const fieldTable = entityType ? fieldKeyForView(entityType) : null
  const cfTable = fieldTable ? sqlTableForView(fieldTable) : null
  // Chargé seulement en mode édition : une fiche en lecture n'a rien à faire
  // des personnalisations détaillées (le portier lui suffit pour les libellés).
  const { overrides: fieldOverrides, reload: reloadFieldOverrides } = useFieldOverrides(fieldTable)
  const [fieldMenu, setFieldMenu] = useState(null)   // { x, y, field } | null
  const [fieldModal, setFieldModal] = useState(null) // { cf } | { col } | null
  const [visModal, setVisModal] = useState(null)     // field | null

  // Champs personnalisés de la table, par colonne : une colonne déclarée par la
  // fiche peut en porter un (adoptée d'une sync) — c'est lui qui règle
  // l'affichage et qui s'édite.
  const { fields: tableCfs } = useCustomFields(cfTable)
  const cfOfColumn = useMemo(() => new Map((tableCfs || []).map(c => [c.column_name, c])), [tableCfs])

  const openFieldEditor = useCallback((f) => {
    if (f.cf) { setFieldModal({ cf: f.cf, key: f.key }); return }
    // Champ natif : la modale attend la définition D'ORIGINE de la colonne
    // (pré-override). Les fiches nomment parfois la FK (`company_id`) là où le
    // tableau nomme le libellé joint (`company_name`) — on accepte les deux.
    const cols = TABLE_COLUMN_META[fieldTable] || []
    const meta = cols.find(c => (c.id ?? c.field) === f.key) || cols.find(c => (c.field ?? c.id) === f.key)
    const base = meta || { id: f.key, field: f.key, label: f.origLabel || f.label }
    // Colonne déclarée par la fiche mais devenue un vrai champ personnalisé
    // (adoptée d'une sync, convertie…) : elle s'édite par sa fiche de champ.
    const cf = cfOfColumn.get(base.field || base.id) || cfOfColumn.get(f.key)
    if (cf) { setFieldModal({ cf, key: f.key }); return }
    // Champ lien vers une autre fiche : nommé « Lien vers … », pas « Texte » —
    // déclaré, connu, ou reconnu au lien que porte le bloc déjà rendu. Un bloc
    // de fiche a toujours son rendu (render: true) ; la liste figée ne vaut pas
    // sur la fiche de la table visée (« # Commande » d'une commande).
    const renderTypeLabel = linkedRecordTypeLabel({ render: true, ...base }, [], fieldTable)
      || linkedRecordTypeLabelOfNode(f.children, record?.id)
    setFieldModal({ col: renderTypeLabel ? { ...base, renderTypeLabel } : base, key: f.key })
  }, [fieldTable, cfOfColumn, record?.id])

  // Champ natif dont le type / les décimales / l'indicatif ont été changés dans
  // « Modifier le champ » : la fiche suit, comme les tableaux.
  const formatOf = useCallback((f) => {
    if (f.cf || !fieldTable) return null
    const cols = TABLE_COLUMN_META[fieldTable] || []
    const meta = cols.find(c => (c.id ?? c.field) === f.key) || cols.find(c => c.field === f.key)
    const cf = cfOfColumn.get(meta?.field || meta?.id) || cfOfColumn.get(f.key)
    // Seulement les formats que ce rendu sait faire : une Sélection, un lien…
    // gardent le rendu de la page.
    if (cf && CF_FORMAT_TYPES.has(cf.type)) {
      const cfOv = { type: cf.type, decimals: cf.decimals, options: cf.options, country_code: cf.country_code }
      return { ov: cfOv, column: cf.column_name }
    }
    const ov = fieldOverrides.get(f.key)
    if (!ov) return null
    const origType = meta?.type || 'text'
    const typeChanged = !!ov.type && ov.type !== origType
    const decimalsChanged = Number.isInteger(ov.decimals)
    const phonePref = origType === 'phone' && (ov.country_code === 'show' || ov.country_code === 'hide')
    if (!typeChanged && !decimalsChanged && !phonePref) return null
    return { ov: { ...ov, type: ov.type || origType }, column: meta?.field || meta?.id || f.key }
  }, [fieldOverrides, fieldTable, cfOfColumn])

  const onFieldSaved = useCallback(() => {
    reloadFieldOverrides()
    if (cfTable) refreshCustomFields(cfTable)
  }, [reloadFieldOverrides, cfTable])
  // À la fermeture aussi : la synchro Airtable réglée dans la modale change
  // l'éditabilité du champ sans passer par « onSaved ».
  const closeFieldModal = useCallback(() => { setFieldModal(null); onFieldSaved() }, [onFieldSaved])

  // ── Renommer sur place (option `renameInPlace`) ───────────────────────────
  // Même destination que le champ « Nom » de la modale : custom_fields pour un
  // champ perso, personnalisation cosmétique pour un champ natif.
  const { addToast } = useToast()
  const [renamingKey, setRenamingKey] = useState(null)
  const renameField = useCallback(async (f, next) => {
    setRenamingKey(null)
    if (!next || next === f.label || !fieldTable) return
    try {
      if (f.cf) await api.customFields.update(f.cf.id, { name: next })
      else {
        const cols = TABLE_COLUMN_META[fieldTable] || []
        const meta = cols.find(c => (c.id ?? c.field) === f.key) || cols.find(c => (c.field ?? c.id) === f.key)
        await api.fieldOverrides.save(fieldTable, meta ? (meta.id ?? meta.field) : f.key, { label: next })
      }
      onFieldSaved()
    } catch (e) {
      addToast({ message: e.message || 'Renommage échoué', type: 'error' })
    }
  }, [fieldTable, onFieldSaved, addToast])

  // Sortir du mode édition referme ce qu'il avait ouvert.
  useEffect(() => {
    if (!editing) { setFieldMenu(null); setFieldModal(null); setVisModal(null); setNewGroupKey(null); setRenamingKey(null) }
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


  const body = (() => {
    const cell = (f, list) => wrap(f, (
          <div
            key={f.key}
            data-testid={f.testId}
            data-field-key={f.key}
            // Admin : clic droit (menu du champ) et glisser l'étiquette pour
            // réordonner, sans passer par le mode édition.
            onContextMenu={canEdit ? e => onFieldContextMenu(e, f) : undefined}
            onDragOver={canEdit ? e => gridDragOver(e, f.key, list) : undefined}
            className={`relative min-w-0 flex items-start gap-2 ${dnd.dragId === f.key || ruleHiddenKeys.has(f.key) ? 'opacity-50' : ''}`}
          >
            {canEdit && gridOver.key === f.key && (
              <span className={`absolute bg-brand-500 rounded pointer-events-none ${GRID_DROP_BAR[gridOver.zone]}`} />
            )}
            {renamingKey === f.key ? (
              <div className="shrink-0 w-40">
                <FieldLabelInput
                  label={f.label}
                  onCommit={v => renameField(f, v)}
                  onCancel={() => setRenamingKey(null)}
                  testId={`detail-field-rename-${f.key}`}
                />
              </div>
            ) : canEdit ? (
              <div
                draggable
                onClick={editing && renameInPlace ? () => setRenamingKey(f.key) : undefined}
                onDragStart={e => dnd.dragStart(e, f.key, e.currentTarget.closest('[data-field-key]'))}
                onDragEnd={() => { dnd.dragEnd(); resetGrid() }}
                className="shrink-0 w-40 cursor-grab active:cursor-grabbing"
                title="Glisser pour déplacer · clic droit : options"
                data-testid={`detail-field-drag-${f.key}`}
              >
                <FieldLabel label={f.label} saving={f.saving} field={f.key} recordId={record?.id} dense={dense} side />
              </div>
            ) : <div className="shrink-0 w-40"><FieldLabel label={f.label} saving={f.saving} field={f.key} recordId={record?.id} dense={dense} side /></div>}
            <div className="flex-1 min-w-0">
              {(() => {
                const fmt = formatOf(f)
                const body = fmt
                  ? <OverrideAwareValue format={fmt.ov} value={record?.[fmt.column]}>{f.children}</OverrideAwareValue>
                  : f.children
                return readonlyKeys.has(f.key)
                  ? <fieldset disabled onClickCapture={blockEdit} onMouseDownCapture={blockEdit} onDoubleClickCapture={blockEdit} className="field-readonly contents" data-testid={`detail-field-readonly-${f.key}`}>{body}</fieldset>
                  : body
              })()}
            </div>
            {canEdit && !hideVisRuleBadge && visRules.some(r => r.field_id === f.key) && (
              <button
                type="button"
                onClick={() => setVisModal(f)}
                title="Masqué sous condition"
                data-testid={`detail-field-vis-${f.key}`}
                className="shrink-0 p-1 rounded text-amber-500 hover:bg-amber-50"
              ><EyeOff size={14} /></button>
            )}
          </div>
    ))
    // Une seule colonne : les champs sont toujours empilés, jamais côte à côte.
    const grid = (list, listIdx) => (
      <div
        onDragOver={canEdit ? gridContainerDragOver : undefined}
        onDrop={canEdit ? gridDrop : undefined}
        onContextMenu={canEdit ? e => openAddMenu(e, { list: listIdx }) : undefined}
        className={`grid grid-cols-1 text-sm ${dense ? 'gap-y-2.5' : 'gap-y-3'} ${canEdit && !list.length ? 'min-h-[2rem]' : ''}`}>
        {list.map(f => cell(f, list))}
      </div>
    )
    if (!groupSections.length) return grid(mainFields, 0)
    return (
      <>
        {mainFields.length > 0 && grid(mainFields, 0)}
        {groupSections.map(g => (
          <section key={g.id} className={mainFields.length ? 'mt-5 pt-4 border-t border-slate-100' : ''} data-testid={`detail-group-${g.id}`}>
            {canEdit && g.id.startsWith('grp:') ? (
              <div className="flex items-center gap-2 mb-3" data-testid={`detail-group-row-${g.id}`}>
                <GroupNameInput group={{ key: g.id, label: g.label }} autoFocus={g.id === newGroupKey} onRename={renameGroup} />
                <button
                  type="button"
                  onClick={() => removeGroup(g.id)}
                  title="Retirer le groupe (les champs restent)"
                  aria-label={`Retirer le groupe ${g.label}`}
                  data-testid={`detail-group-remove-${g.id}`}
                  className="shrink-0 p-1 rounded text-slate-300 hover:text-red-600 hover:bg-red-50"
                ><X size={14} /></button>
              </div>
            ) : <h3 className="text-sm font-semibold text-slate-700 mb-3">{g.label}</h3>}
            {grid(g.fields, 1 + allGroups.findIndex(x => x.id === g.id))}
          </section>
        ))}
      </>
    )
  })()

  return (
    <div
      className={`group/fields relative ${className}`}
      data-testid={testId}
      onContextMenu={canEdit ? e => openAddMenu(e, { list: 0 }) : undefined}
    >
      {/* Sur une page pleine, l'accès au mode édition se fait au survol de la
          carte. Dans un panneau latéral, c'est le bouton de l'en-tête. */}
      {canEdit && !peek && declared.length > 0 && (
        <button
          type="button"
          onClick={() => setLocalEditing(v => !v)}
          data-testid="detail-fields-toggle"
          aria-pressed={editing}
          title={editing ? 'Masquer les champs cachés' : 'Afficher les champs cachés'}
          className={`absolute top-2 right-2 p-1.5 rounded-lg transition-opacity ${
            editing ? 'text-brand-600 bg-brand-50 opacity-100' : 'text-slate-300 hover:text-brand-600 hover:bg-slate-100 opacity-0 group-hover/fields:opacity-100 focus:opacity-100'
          }`}
        >
          {editing ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      )}

      {body}

      {deleteAllowed && deleteSpec?.run && record?.id && (
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
        <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 text-sm">
          {extras}
        </div>
      )}

      {addMenu && (
        <AddFieldMenu
          x={addMenu.x}
          y={addMenu.y}
          fields={hiddenFields}
          onPick={f => addFieldAt(f, addMenu.target)}
          onClose={() => setAddMenu(null)}
          onAddGroup={allowGroups ? () => { setAddMenu(null); setNewGroupKey(addGroup('Nouveau groupe')) } : undefined}
          deleteToggle={deleteSpec ? { checked: deleteAllowed, onChange: setDeleteAllowed } : undefined}
        />
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
            <button
              type="button"
              onClick={() => { const f = fieldMenu.field; setFieldMenu(null); setReadonly(f.key, !readonlyKeys.has(f.key)) }}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 text-left"
              data-testid="detail-field-menu-readonly"
            >
              <Lock size={13} /> Lecture seule
              {readonlyKeys.has(fieldMenu.field.key) && <Check size={13} className="ml-auto text-brand-600" />}
            </button>
            {visContext && (
              <button
                type="button"
                onClick={() => { const f = fieldMenu.field; setFieldMenu(null); setVisModal(f) }}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 text-left"
                data-testid="detail-field-menu-visibility"
              >
                <EyeOff size={13} /> {(() => {
                  const n = visRules.filter(r => r.field_id === fieldMenu.field.key).length
                  return n ? `Visibilité (${n})` : 'Afficher sous condition…'
                })()}
              </button>
            )}
          </div>
        </>
      )}

      {visModal && (
        <Suspense fallback={null}>
          <FieldVisibilityRuleModal
            isOpen
            onClose={() => setVisModal(null)}
            context={visContext}
            fieldId={visModal.key}
            fieldLabel={visModal.label}
            record={record}
            fields={declared.map(f => {
              const base = { id: f.key, field: f.key, label: f.label }
              if (!visRuleChoices) return base
              if (f.checkbox || f.cf?.type === 'checkbox') return { ...base, checkbox: true }
              const raw = f.choices || (f.cf?.type === 'single_select' ? parseSelectChoices(f.cf) : null)
              return raw?.length ? { ...base, choices: gate.choicesFor(f.key, raw) } : base
            })}
            existingRules={visRules.filter(r => r.field_id === visModal.key)}
            onChanged={invalidateVisRules}
          />
        </Suspense>
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
          // Noms des autres champs de la fiche : un doublon est signalé dès la saisie.
          siblingFields={declared.filter(f => f.key !== fieldModal.key).map(f => ({ id: f.key, label: f.label }))}
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
