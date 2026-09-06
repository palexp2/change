import { useState, useEffect, useMemo } from 'react'
import { useParams, useLocation, useNavigate } from 'react-router-dom'
import { Pencil, Trash2, Plus, ArrowLeft, Search } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import { TABLE_LABELS, TABLE_COLUMN_META } from '../lib/tableDefs.js'
import {
  typeLabel, kindLabel, useFieldOverrides, applyFieldOverrides, applyFieldOrder,
  isComputedKind, isPushOnlyKind, noMappingReason, pushOnlyMappingReason,
} from '../lib/fieldOverrides.jsx'
import { FieldTypeIcon } from '../lib/fieldTypeIcons.jsx'
import {
  CoreMapPane, DirectionControl, useCoreMap, DIRECTIONS, directionLockTitle,
} from '../components/AirtableCoreMapModal.jsx'
import { CustomFieldModal, MappingBlock } from '../components/CustomFieldModal.jsx'
import {
  MappingPicker, AirtableFieldCell, ModuleSourceStatus,
  useModuleFields, TYPE_OPTIONS,
} from '../components/AirtableModuleFields.jsx'
import {
  useAirtableModules, buildCoreProps, mappingCellFor, sqlTableForFieldKey,
  useAirtableDirectSource, FixedMappingCell,
} from '../components/FieldAirtableMapping.jsx'
import { useCustomFields } from '../lib/useCustomFields.js'
import {
  customFieldToColumn, CUSTOM_FIELD_TABLES, isAirtableLinkField,
} from '../lib/customFieldDisplay.jsx'
import { groupDependents, DEPENDENT_CATEGORY_LABELS } from '../lib/customFieldDeps.js'

// Icônes de sens, partagées avec le mapping des champs cœur.
const DirPullIcon = DIRECTIONS.pull.Icon
const DirPushIcon = DIRECTIONS.push.Icon
import { useToast } from '../contexts/ToastContext.jsx'

// Page pleine largeur de configuration des champs d'une table — ouverte par le
// bouton « Configurer les champs » de la barre d'outils de chaque DataTable
// (route /champs/:table). Remplace l'ancienne modale de mapping Airtable
// (ouverte page par page) en élargissant son périmètre :
// Un seul tableau réunit tout ce qui concerne un champ : son nom (renommage
// inline), son type, sa colonne SQL, le champ Airtable qui l'alimente
// (ex-page /airtable/fields/:module, fusionnée ici) et ses actions
// (édition complète via CustomFieldModal, réinitialisation, suppression).
//
// L'ordre des champs ne se règle PAS ici : le drag & drop a été retiré de cette
// page, l'ordre des colonnes se change en glissant leurs en-têtes dans la table
// elle-même (ordre propre à la vue). Un `sort_order` déjà enregistré reste
// appliqué à l'affichage de cette page pour qu'elle suive celui de la table.
//
// Le mapping des champs « cœur » (field_map du module) y est fusionné lui aussi
// dès que la spec serveur déclare la colonne ERP de chaque clé
// (`inline_columns` — cf. CORE_FIELD_SPECS). Rien ne distingue alors ces champs
// des autres : la colonne « Champ Airtable » est LA MÊME cellule
// (AirtableFieldCell) pour les deux systèmes, et le choix s'y enregistre tout
// de suite. La resynchronisation reste explicite — bouton « Synchroniser » de
// l'en-tête Source Airtable.
//
// UNE page = UNE table. La page ne montre QUE les champs de la table depuis
// laquelle elle a été ouverte : pas d'onglet, pas de module « enfant » invité.
// Pour régler les champs des lignes de commande, on ouvre la configuration
// depuis le tableau des lignes de commande (/champs/order_items), pas depuis
// celui des commandes. Le mapping cœur non rattachable à une colonne
// (CoreMapPane — clés de spec sans `column`) s'affiche sous le tableau des
// champs, dans la même page.

// Supprimer un champ ne demande AUCUNE confirmation : la ligne part tout de
// suite et un toast « Annuler » laisse ce délai pour revenir en arrière.
const UNDO_DELETE_MS = 4000

// Version courte du rapport de dépendances, taillée pour un toast (le résumé
// multi-lignes de customFieldDeps est fait pour un dialogue) : on nomme les
// catégories touchées, pas chaque dépendance.
function shortDependentsNote(dependents) {
  if (!dependents?.length) return ''
  const cats = groupDependents(dependents)
    .map(([cat, items]) => `${items.length} ${DEPENDENT_CATEGORY_LABELS[cat].toLowerCase()}`)
  return ` — ⚠️ ${cats.join(', ')} à ajuster`
}

// URL /champs/:table → vraie table SQL : `sqlTableForFieldKey` (partagé avec la
// modale de champ des tableaux). Les lookups (custom_fields, modules Airtable)
// se font TOUJOURS en vrai nom SQL ; l'URL et les overrides gardent la clé de
// vue historique.

// Réciproque, pour rediriger les anciennes URL /airtable/fields/:module vers la
// clé d'URL /champs/:table historique de la table ERP du module.
const SQL_TABLE_TO_URL = {
  returns: 'retours',
  serial_state_changes: 'serial_transitions',
}
function urlTableForSql(t) {
  return SQL_TABLE_TO_URL[t] || t
}

// Colonne ERP que le mapping Airtable alimente pour une ligne du tableau —
// celle du champ, sauf quand la définition en désigne une autre (`mappingColumn`
// dans tableDefs.js : « Vendeur » s'affiche depuis `vendeur_label` et s'importe
// dans `vendeur_ref`).
function mappingKey(col) {
  return col.mappingColumn || col.field
}

// En-tête du tableau des champs. Les largeurs suivent exactement celles de
// `FieldRow` (w-6 / flex-1 / w-28 / w-5 / w-64 / actions) : toute
// modification ici doit être répercutée là-bas, sinon les colonnes décalent.
// `mapping` : la table a-t-elle une source Airtable (colonnes « Sens » et
// « Champ Airtable » affichées) ?
function FieldsHeader({ mapping }) {
  return (
    <div
      data-testid="fieldcfg-header"
      className="flex items-center gap-3 px-3 py-2 border-b border-slate-200 rounded-t-xl bg-slate-50 text-[11px] font-semibold uppercase tracking-wide text-slate-600"
    >
      <span className="w-6 flex-shrink-0 text-right">#</span>
      <span className="flex-1 min-w-0">Nom</span>
      <span className="w-28 flex-shrink-0 truncate">Type</span>
      {mapping && (
        // Colonne de 20 px : le libellé déborde un peu dans les gouttières
        // voisines (12 px de chaque côté) plutôt que d'être tronqué.
        <span className="w-5 flex-shrink-0 text-center text-[10px] whitespace-nowrap" title="Sens de synchronisation">Sens</span>
      )}
      {mapping && <span className="w-64 flex-shrink-0 truncate">Champ Airtable</span>}
      {/* 56 px = les deux boutons d'action de la ligne (22 px) et leur gouttière. */}
      <span className="w-[56px] flex-shrink-0 text-center">Actions</span>
    </div>
  )
}

// Une ligne de champ : nom éditable (autosave au blur), type, et actions
// (éditer / supprimer).
function FieldRow({
  col, cf, index, onRename, onEdit, onDelete, onDeleteNative,
  // Volet Airtable (fusionné depuis l'ancien onglet) : `at` = entrée mapping-data
  // de la colonne, `airtableFields` / `tableMap` = données du picker.
  // `onAdoptType` n'est fourni que pour les colonnes ERP que la table n'affiche
  // pas encore : choisir leur type les matérialise en champ. Une colonne native
  // de la DataTable se règle via « Modifier le champ » (crayon).
  at, airtableFields, tableMap, onSaveMapping, onAdoptType, savingId,
  // Colonne ERP alimentée par le mapping quand ce n'est pas celle de la ligne :
  // « Vendeur » s'affiche depuis `vendeur_label` mais c'est `vendeur_ref` que le
  // sync remplit (cf. `mappingColumn` dans tableDefs.js). Seules les cellules
  // « Sens » et « Champ Airtable » suivent cette colonne — le type, le renommage
  // et la suppression restent ceux du champ de la ligne.
  mappingAt,
  // `showMapping` : la table a une source Airtable → toutes les lignes portent
  // les colonnes « Sens » et « Champ Airtable », même celles sans mapping (sinon
  // les lignes se décalent entre elles et sous l'en-tête).
  showMapping,
  // Mapping « cœur » (field_map du module) fusionné : quand la colonne est
  // portée par une clé cœur, c'est ce mapping-là qui l'alimente — le picker des
  // champs dynamiques n'a plus rien à y faire (il créerait un doublon d'import).
  core,
  // Sens de sync d'un champ dynamique mappé (module write-back) : `dynModule` =
  // module Airtable de la table, `dynDirection` = sens courant ('pull' défaut),
  // `onDynDirection` = autosave du choix. Absents → icône statique.
  dynModule, dynDirection, onDynDirection,
  // Libellé du module Airtable de la table — pour l'infobulle du sens verrouillé.
  moduleLabel,
  // Table lue en direct dans Airtable (hors miroir) : le champ qui alimente la
  // colonne est fixé en code — il s'affiche, cadenassé, au lieu du picker.
  fixedField, fixedReason,
}) {
  const [name, setName] = useState(col.label)
  const [saving, setSaving] = useState(false)
  useEffect(() => { setName(col.label) }, [col.label])

  async function commit() {
    const next = name.trim()
    if (!next || next === col.label) { setName(col.label); return }
    setSaving(true)
    // onRename renvoie false quand le renommage est refusé (nom déjà pris,
    // erreur réseau) : on revient au libellé courant plutôt que de laisser
    // l'input afficher une valeur non enregistrée.
    try {
      const ok = await onRename(next)
      if (ok === false) setName(col.label)
    } finally { setSaving(false) }
  }

  // Champ calculé (formule, lookup, rollup, « créé le / créé par », bouton) :
  // sa valeur est produite par l'ERP, aucun champ Airtable ne peut l'alimenter.
  // Le kind vient des métadonnées serveur (`cf_kind`) et, à défaut, du champ
  // perso chargé par la page.
  const computedKind = isComputedKind(at?.cf_kind)
    ? at.cf_kind
    : (isComputedKind(cf?.kind) ? cf.kind : null)
  // …sauf qu'un champ calculé se POUSSE vers Airtable : le serveur marque alors
  // la colonne `push_only` (cf. mapping-data). Le mapping est donc proposé
  // normalement, avec un sens figé à « Boréal → Airtable ».
  const pushOnly = !!at?.push_only && isPushOnlyKind(computedKind)
  // Entrée mapping-data qui pilote les deux cellules Airtable de la ligne.
  const mapAt = mappingAt || at

  return (
    <div
      data-testid={`fieldcfg-row-${col.id}`}
      className="group flex items-center gap-3 px-3 py-2 border-b border-slate-200 last:border-b-0 hover:bg-slate-50 transition-colors"
    >
      <span className="text-[11px] text-slate-600 tabular-nums w-6 flex-shrink-0 text-right">{index + 1}</span>
      <input
        value={name}
        onChange={e => setName(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') { setName(col.label); e.currentTarget.blur() }
        }}
        disabled={saving}
        data-testid={`fieldcfg-name-${col.id}`}
        data-column={col.field}
        title={`Nom technique de la colonne : ${col.field}`}
        className="input flex-1 min-w-0 text-sm py-1"
      />
      {/* Type : figé dès qu'un champ existe (édition via la fiche du champ) ;
          sélecteur d'adoption pour une colonne ERP encore sans présentation. */}
      {/* Un champ lien (mapping avec table cible) n'a pas de type d'affichage à
          adopter : sa colonne porte un identifiant de record, et le sélecteur de
          type laissait croire le contraire. Il s'affiche donc en « Lien ». */}
      {at && !at.cf_id && onAdoptType && !at.target_table
        ? (
          <span className="w-28 flex-shrink-0 flex items-center gap-1.5 min-w-0">
            <FieldTypeIcon
              type={at.field_type || 'text'}
              data-testid={`fieldcfg-typeicon-${col.id}`}
              className="text-slate-500"
            />
            <select
              value={at.field_type || 'text'}
              onChange={e => onAdoptType(e.target.value)}
              disabled={savingId === col.field}
              title="Choisir le type d'affichage adopte cette colonne"
              data-testid={`fieldcfg-type-${col.id}`}
              className="flex-1 min-w-0 rounded border border-slate-200 bg-white px-1.5 py-1 text-xs text-slate-800 cursor-pointer hover:border-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-500/30 disabled:opacity-50"
            >
              {TYPE_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </span>
        )
        : (
          // Icône ET libellé viennent du champ perso quand il y en a un : une
          // formule ou un lookup qui rend du texte n'est pas un champ texte, et
          // le seul type de colonne les confondait. Sinon, type d'affichage de
          // la colonne native.
          (() => {
            // Champ perso : sa famille (Formule, Lookup…) ou, pour un champ
            // « donnée », son PROPRE type — celui du champ, pas celui auquel la
            // colonne se ramène (une devise se ramène à un nombre).
            const own = !col.renderTypeLabel && cf ? (kindLabel(cf.kind) || typeLabel(cf.type)) : null
            // Champ lien Airtable : stocké en texte (l'id du record lié), mais
            // c'est un lien — le nommer « Texte » n'apprenait rien à l'utilisateur.
            const atLink = isAirtableLinkField(cf) || !!at?.target_table
            return (
              <span
                className="text-xs text-slate-600 w-28 flex-shrink-0 flex items-center gap-1.5 min-w-0"
                title={atLink
                  ? (at?.target_table
                    ? `Champ lien Airtable — la colonne ${col.field} porte l'id Boréal du record lié dans « ${at.target_table} »`
                    : `Champ lien Airtable — la colonne ${col.field} porte le record ID Airtable du record lié`)
                  : `Colonne : ${col.field}`}
              >
                <FieldTypeIcon
                  // `fieldType` = type choisi par l'utilisateur (override), plus
                  // fidèle que `type`, que la DataTable aplatit (devise → nombre,
                  // lien → texte).
                  type={atLink ? 'link' : (col.fieldType || cf || col.type)}
                  data-testid={`fieldcfg-typeicon-${col.id}`}
                  className="text-slate-500"
                />
                <span className="truncate">{atLink ? kindLabel('link') : (col.renderTypeLabel || own || typeLabel(col.type))}</span>
              </span>
            )
          })()
        )}
      {/* Sens de sync. Champ cœur : réglable via le field_map du module. Champ
          dynamique mappé d'un module write-back : réglable aussi (clé `dyn:<colonne>`,
          défaut Airtable → ERP — cf. services/airtableWriteback.js). Sinon (champ
          lien, module sans write-back, non mappé) : icône statique en lecture seule. */}
      {/* Champ calculé : aucun champ Airtable ne l'alimente. Soit il n'y a rien
          à synchroniser du tout (bouton, table sans écriture vers Airtable) →
          icône grisée avec la raison en infobulle ; soit il est poussable
          (`push_only`) → flèche « Boréal → Airtable » figée, jamais un choix. */}
      {showMapping && computedKind && !pushOnly && (
        <span
          title={noMappingReason(computedKind)}
          data-testid={`fieldcfg-direction-${col.id}`}
          data-direction="none"
          className="w-5 flex-shrink-0 inline-flex justify-center cursor-help text-slate-400"
        >
          <DirPullIcon size={13} />
        </span>
      )}
      {showMapping && pushOnly && (
        <span
          title={pushOnlyMappingReason(computedKind)}
          data-testid={`fieldcfg-direction-${col.id}`}
          data-direction="push"
          className={`w-5 flex-shrink-0 inline-flex justify-center cursor-help ${at?.mapped ? 'text-slate-600' : 'text-slate-400'}`}
        >
          <DirPushIcon size={13} />
        </span>
      )}
      {/* Table lue en direct : le sens est forcément Airtable → Boréal, et il
          n'est pas réglable (rien n'est écrit vers Airtable). */}
      {showMapping && !computedKind && fixedField && (
        <span
          title={fixedReason}
          data-testid={`fieldcfg-direction-${col.id}`}
          data-direction="pull"
          className="w-5 flex-shrink-0 inline-flex justify-center cursor-help text-slate-600"
        >
          <DirPullIcon size={13} />
        </span>
      )}
      {showMapping && !computedKind && !fixedField && (
        core
          ? (
            <span className="w-5 flex-shrink-0 inline-flex justify-center">
              <DirectionControl
                compact
                module={core.module}
                fieldKey={core.field.key}
                direction={core.direction}
                configurable={core.field.configurable}
                mapped={!!core.value}
                onChange={core.onDirection}
                lockTitle={directionLockTitle(core.field.direction_reason, moduleLabel)}
              />
            </span>
          )
          : mapAt?.mapped && mapAt.direction_configurable && dynModule && onDynDirection
            ? (
              <span className="w-5 flex-shrink-0 inline-flex justify-center">
                <DirectionControl
                  compact
                  module={dynModule}
                  fieldKey={`dyn-${mapAt.column_name}`}
                  direction={dynDirection || 'pull'}
                  configurable
                  mapped
                  onChange={onDynDirection}
                />
              </span>
            )
            : (
              <span
                // Sens verrouillé : infobulle honnête selon la raison serveur
                // (module sans write-back, champ lien) plutôt que le même texte
                // générique que le sens « pull » librement choisi.
                title={mapAt?.mapped
                  ? (directionLockTitle(mapAt.direction_reason, moduleLabel) || DIRECTIONS.pull.title)
                  : 'Aucun mapping Airtable — ce champ n’est pas importé'}
                data-testid={`fieldcfg-direction-${col.id}`}
                data-direction={mapAt?.mapped ? 'pull' : 'none'}
                className={`w-5 flex-shrink-0 inline-flex justify-center cursor-help ${mapAt?.mapped ? 'text-slate-600' : 'text-slate-400'}`}
              >
                <DirPullIcon size={13} />
              </span>
            )
      )}
      {/* Champ Airtable qui alimente la colonne — vide = pas d'import. Même
          cellule (AirtableFieldCell) pour une clé « cœur » et pour un mapping
          dynamique : rien ne doit distinguer les deux à l'écran, et le choix
          s'enregistre tout de suite dans les deux cas. */}
      {showMapping && (
        <span
          className="w-64 flex-shrink-0"
          data-testid={`fieldcfg-airtable-${col.id}`}
          data-core={core ? '1' : undefined}
          data-mappable={computedKind && !pushOnly ? '0' : '1'}
          title={computedKind && !pushOnly ? noMappingReason(computedKind) : undefined}
        >
          {computedKind && !pushOnly
            ? <span className="text-[11px] text-slate-400 italic cursor-help">non mappable</span>
            : fixedField
            ? <FixedMappingCell field={fixedField} reason={fixedReason} testId={`fixedmap-${col.field}`} />
            : core
            ? (
              <AirtableFieldCell
                testId={`coremap-${core.module}-${core.field.key}`}
                mapped={core.value || null}
                options={core.options}
                suggestion={core.suggestion}
                saving={core.saving}
                // Une clé requise du sync ne peut pas être démappée (le serveur
                // refuse) : pas de × trompeur, on dit pourquoi.
                canUnmap={!core.field.required}
                unmapTitle={core.field.required
                  ? 'Champ requis par la synchronisation — il ne peut pas être démappé'
                  : undefined}
                onPick={core.onPick}
                onUnmap={core.onUnmap}
              />
            )
            : mapAt
              ? (
                <MappingPicker
                  erpColumn={mapAt}
                  airtableFields={airtableFields}
                  tableMap={tableMap}
                  onSave={onSaveMapping}
                  savingId={savingId}
                />
              )
              : <span className="text-[11px] text-slate-600">—</span>}
        </span>
      )}
      <button
        type="button"
        onClick={onEdit}
        title="Modifier le champ (type, options…)"
        data-testid={`fieldcfg-edit-${col.id}`}
        className="p-1 text-slate-600 hover:text-slate-900 flex-shrink-0"
      >
        <Pencil size={14} />
      </button>
      {cf
        ? (
          <button
            type="button"
            onClick={onDelete}
            title="Supprimer le champ (annulable pendant quelques secondes)"
            data-testid={`fieldcfg-delete-${col.id}`}
            className="p-1 text-slate-600 hover:text-red-500 flex-shrink-0"
          >
            <Trash2 size={14} />
          </button>
        )
        : (at && !at.cf_id
          ? (
            // Colonne ERP sans champ configuré : typiquement le résidu d'un champ
            // supprimé (la colonne SQLite n'est jamais droppée) ou une colonne
            // jamais adoptée. Rien à supprimer — c'est le mapping qui l'alimente.
            <span
              title="Colonne ERP sans champ configuré — rien à supprimer ici. Videz son « Champ Airtable » pour couper l’import."
              data-testid={`fieldcfg-delete-disabled-${col.id}`}
              className="p-1 text-slate-400 cursor-not-allowed flex-shrink-0"
            >
              <Trash2 size={14} />
            </span>
          )
          : (
            // Champ natif : « Supprimer » le retire de partout et l'envoie à la
            // corbeille (Paramètres → Corbeille) — même geste que le menu d'en-tête
            // de la DataTable.
            <button
              type="button"
              onClick={onDeleteNative}
              title="Supprimer le champ (restaurable depuis la corbeille)"
              data-testid={`fieldcfg-delete-${col.id}`}
              className="p-1 text-slate-600 hover:text-red-500 flex-shrink-0"
            >
              <Trash2 size={14} />
            </button>
          ))}
    </div>
  )
}

export default function FieldConfig() {
  const { table } = useParams()
  // Table SQL réelle derrière la clé d'URL (ex. /champs/retours → returns) :
  // les appels custom-fields / modules Airtable parlent en vrai nom SQL, les
  // overrides et métadonnées de vue restent sous la clé d'URL.
  const sqlTable = sqlTableForFieldKey(table)
  const location = useLocation()
  const navigate = useNavigate()
  const { addToast } = useToast()

  // Colonnes réelles de la table telles que la page hôte les affiche, passées
  // en state de navigation par DataTable (labels/types déjà résolus). En accès
  // direct par URL (favori, rechargement), on retombe sur les métadonnées
  // partagées de tableDefs.js.
  const baseColumns = useMemo(() => {
    const fromNav = location.state?.columns
    if (Array.isArray(fromNav) && fromNav.length > 0) return fromNav
    return TABLE_COLUMN_META[table] || []
  }, [location.state, table])
  // Ce state de navigation est figé dans l'entrée d'historique : il SURVIT au
  // rechargement (même forcé). Supprimer un champ depuis cette page laissait donc
  // sa colonne dans `fromNav`, et elle réapparaissait à chaque F5 — la suppression
  // semblait ne pas prendre. On ne se fie plus aveuglément au state : les colonnes
  // qui ne sont ni natives ni un champ perso actif sont revalidées plus bas.
  const nativeIds = useMemo(
    () => new Set((TABLE_COLUMN_META[table] || []).map(c => c.id ?? c.field)),
    [table]
  )
  const fromNavState = Array.isArray(location.state?.columns) && location.state.columns.length > 0
  const backTo = location.state?.fromPath || null

  const { modules } = useAirtableModules(table, sqlTable)

  // Table lue en direct dans Airtable (hors miroir, ex. les commissions d'un
  // projet) : aucun module ne l'alimente, mais chaque colonne a bien son champ
  // Airtable — fixé en code. On l'affiche en lecture seule plutôt que de laisser
  // la colonne « Champ Airtable » disparaître sans explication.
  const directSource = useAirtableDirectSource(table)
  const directFields = directSource?.fields || null

  // Module Airtable qui alimente CETTE table : son contrôle par champ est
  // fusionné dans le tableau principal (colonne « Champ Airtable »).
  const ownModule = modules.find(m => m.fields) || null
  const {
    data: atData, savingId: atSavingId, applyChange: atApplyChange, saveMapping: atSaveMapping,
    reload: reloadAirtableColumns,
  } = useModuleFields(ownModule?.module || null)
  const [filter, setFilter] = useState('')

  const { overrides, reload: reloadOverrides } = useFieldOverrides(table)
  const selfManagedCF = CUSTOM_FIELD_TABLES.has(sqlTable)
  const { fields: customFields, loaded: cfLoaded, reload: reloadCustomFields } = useCustomFields(selfManagedCF ? sqlTable : null)

  // Mapping des champs « cœur » de CETTE table, quand chaque clé de la spec
  // déclare sa colonne ERP : il se fusionne ligne à ligne dans le tableau.
  const inlineCoreModule = modules.find(m => m.coremap && m.inline) || null
  // Sinon (clés cœur sans colonne ERP : items de paie…),
  // le mapping s'affiche en panneau sous le tableau — toujours dans la page de
  // la table concernée, jamais dans celle d'une autre.
  const paneCoreModule = modules.find(m => m.coremap && !m.inline) || null
  const core = useCoreMap(inlineCoreModule?.module || null, () => reloadCustomFields())
  const coreByColumn = useMemo(() => {
    const m = new Map()
    for (const f of (core.data?.fields || [])) if (f.column) m.set(f.column, f)
    return m
  }, [core.data])
  // Champs supprimés pendant la session : colonne → id du champ retiré. Retrait
  // optimiste — la ligne s'en va dès que le serveur a accusé la suppression, sans
  // attendre le rechargement des champs perso NI celui des métadonnées Airtable
  // (plusieurs secondes sur une grosse table ; entre-temps la ligne s'attardait
  // sous la forme d'une « colonne ERP sans champ configuré »). Le masquage se
  // lève tout seul si une AUTRE définition vient occuper la colonne.
  const [removedColumns, setRemovedColumns] = useState(() => new Map())
  const forgetColumn = (field) => {
    if (!field?.column_name) return
    setRemovedColumns(prev => new Map(prev).set(field.column_name, field.id))
  }
  // Inverse de forgetColumn : la ligne revient (annulation d'une suppression).
  const unforgetColumn = (field) => {
    if (!field?.column_name) return
    setRemovedColumns(prev => {
      const next = new Map(prev)
      next.delete(field.column_name)
      return next
    })
  }
  const [cfModal, setCfModal] = useState(null)          // { editing } — champ perso (création / édition)
  const [nativeModal, setNativeModal] = useState(null)  // { col } — champ natif (renommage / type)

  const cfByColumn = useMemo(() => {
    const m = new Map()
    for (const f of customFields) m.set(f.column_name, f)
    return m
  }, [customFields])

  // Colonnes de la page + champs perso pas encore présents, puis overrides
  // (libellés / types) et ordre utilisateur — exactement ce que voit la DataTable.
  // Définitions D'ORIGINE (pré-override) : la modale de champ natif s'en sert
  // pour afficher « nom / type d'origine » et détecter un retour à l'original.
  const atByColumn = useMemo(() => {
    const m = new Map()
    for (const c of (atData?.erp_columns || [])) m.set(c.column_name, c)
    return m
  }, [atData])

  const mergedBase = useMemo(() => {
    // Colonnes venues du state de navigation : purge des champs supprimés depuis
    // (voir `fromNavState`). La liste des champs perso suffit à trancher pour une
    // colonne `cf_*` ; pour les autres on attend les métadonnées Airtable, sans
    // quoi on retirerait à tort une colonne encore mappée.
    const live = (!fromNavState || !cfLoaded)
      ? baseColumns
      : baseColumns.filter(c => {
        const key = c.field ?? c.id
        if (nativeIds.has(c.id ?? c.field) || nativeIds.has(key)) return true
        if (cfByColumn.has(key)) return true
        // Colonne `cf_*` sans champ perso actif : résidu physique d'un champ
        // supprimé (la colonne SQLite n'est jamais droppée). Le serveur ne la
        // liste même plus dans les colonnes ERP, donc `at` est vide et la règle
        // ci-dessous la gardait — la ligne survivait à la suppression ET au
        // rechargement, puisque le state de navigation est figé dans l'historique.
        if (String(key).startsWith('cf_')) return false
        // À partir d'ici il faut la vérité Airtable pour décider.
        if (ownModule && !atData) return true
        const at = atByColumn.get(key)
        // Colonne inconnue des deux registres : colonne sur-mesure d'une page
        // (render maison, pas un champ configurable) — on la garde.
        if (!at) return true
        return !!(at.mapped || at.cf_id)
      })
    const ids = new Set(live.map(c => c.id ?? c.field))
    const extra = customFields.filter(f => !ids.has(f.column_name)).map(customFieldToColumn)
    const known = new Set([...ids, ...customFields.map(f => f.column_name)])
    // Colonne ERP déjà pilotée par la ligne d'un champ affiché (`mappingColumn`,
    // ex. `vendeur_ref` sous « Vendeur ») : pas de seconde ligne pour elle.
    for (const c of live) if (c.mappingColumn) known.add(c.mappingColumn)
    // Colonnes ERP que la table n'affiche pas (jamais mises en colonne, ou
    // simplement pas encore adoptées) : elles étaient listées par l'ancien
    // onglet Airtable, elles restent visibles ici.
    // Une colonne ERP hors DataTable n'a sa place ici que si elle est encore
    // reliée à quelque chose : mappée depuis Airtable, ou portée par un champ.
    // Sinon c'est un résidu (la colonne SQLite d'un champ supprimé n'est jamais
    // droppée) — l'afficher donnait l'impression que la suppression n'avait
    // pas pris.
    const fromAirtable = [...atByColumn.values()]
      .filter(c => !known.has(c.column_name))
      .filter(c => c.mapped || c.cf_id)
      .map(c => ({
        id: c.column_name,
        field: c.column_name,
        label: c.label || c.column_name,
        type: c.field_type || 'text',
        unlisted: true, // pas une colonne de la DataTable
      }))
    // Colonnes portées par une clé de mapping « cœur » : elles doivent avoir
    // leur ligne même si la table ne les affiche pas (ex. priority, address_id
    // sur les commandes) — sinon leur mapping resterait invisible après la
    // fusion de l'onglet Airtable dans ce tableau.
    for (const c of fromAirtable) known.add(c.column_name)
    const fromCore = [...coreByColumn.values()]
      .filter(f => !known.has(f.column))
      .map(f => ({
        id: f.column,
        field: f.column,
        label: f.label,
        type: atByColumn.get(f.column)?.field_type || 'text',
        unlisted: true,
      }))
    return [...live, ...extra, ...fromAirtable, ...fromCore].filter(c => {
      if (c.alwaysVisible) return false
      const key = c.field ?? c.id
      if (!removedColumns.has(key)) return true
      const cf = cfByColumn.get(key)
      return !!cf && cf.id !== removedColumns.get(key)
    })
  }, [baseColumns, customFields, atByColumn, cfByColumn, cfLoaded, ownModule, atData, fromNavState, nativeIds, removedColumns, coreByColumn])
  const baseById = useMemo(() => new Map(mergedBase.map(c => [c.id, c])), [mergedBase])

  // Un champ supprimé sort du tableau : le serveur republie les lignes
  // supprimées sous le drapeau `hidden`, et c'est ici qu'on les retire. Il n'y a
  // pas de section « champs masqués » — un champ supprimé n'apparaît plus nulle
  // part dans l'app, il se récupère depuis la corbeille (Paramètres → Corbeille).
  const columns = useMemo(
    () => applyFieldOrder(applyFieldOverrides(mergedBase, overrides), overrides)
      .filter(c => !overrides.get(c.id)?.hidden),
    [mergedBase, overrides]
  )

  // Supprimer un champ NATIF : la ligne part à la corbeille et le champ
  // disparaît partout — même geste que le menu d'en-tête de la DataTable, avec
  // « Annuler » au lieu d'une confirmation.
  async function deleteNativeField(col) {
    try {
      await api.customFields.setNativeHidden(table, col.id, true, col.label)
      await reloadOverrides()
      addToast({
        type: 'undo',
        message: `Champ « ${col.label} » supprimé`,
        duration: UNDO_DELETE_MS,
        action: {
          label: 'Annuler',
          onClick: async () => {
            try {
              await api.customFields.setNativeHidden(table, col.id, false)
              await reloadOverrides()
              addToast({ message: 'Champ restauré', type: 'success', duration: 2000 })
            } catch (e) {
              addToast({ message: 'Restauration échouée : ' + (e.message || 'erreur'), type: 'error' })
            }
          },
        },
      })
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    }
  }

  // Recherche : filtre l'affichage seulement.
  const visibleRows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return columns
    const coreValue = c => {
      const f = coreByColumn.get(c.field)
      return f ? (core.draft[f.key] || '') : ''
    }
    return columns.filter(c =>
      (c.label || '').toLowerCase().includes(q)
      || (c.field || '').toLowerCase().includes(q)
      || (atByColumn.get(mappingKey(c))?.mapped_airtable_field || '').toLowerCase().includes(q)
      || coreValue(c).toLowerCase().includes(q)
    )
  }, [columns, filter, atByColumn, coreByColumn, core.draft])

  async function renameField(col, cf, nextLabel) {
    // Unicité du nom dans la table : le serveur refuse aussi (409), mais lui ne
    // connaît que les champs perso et les renommages enregistrés — les champs
    // natifs non renommés ne vivent que côté client (tableDefs.js). Le contrôle
    // complet se fait donc ici, sur la liste réellement affichée.
    const taken = columns.find(c => c.id !== col.id && (c.label || '').trim().toLowerCase() === nextLabel.trim().toLowerCase())
    if (taken) {
      addToast({ message: `« ${taken.label} » est déjà le nom d'un autre champ de cette table`, type: 'error' })
      return false
    }
    try {
      if (cf) {
        await api.customFields.update(cf.id, { name: nextLabel })
        await reloadCustomFields()
      } else {
        await api.fieldOverrides.save(table, col.id, { label: nextLabel })
        await reloadOverrides()
      }
      addToast({ message: 'Champ renommé', type: 'success' })
      return true
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
      return false
    }
  }

  // Suppression d'un champ perso : pas de confirmation, la ligne part tout de
  // suite et le toast offre « Annuler » pendant UNDO_DELETE_MS. L'appel serveur
  // n'est envoyé qu'à l'expiration de ce délai : rien n'est détruit tant que la
  // fenêtre d'annulation est ouverte — ce qui compte pour un champ « lien »,
  // dont la suppression emporte définitivement les lignes de jonction (la
  // corbeille ne les rendrait pas). Le rapport de dépendances (champs calculés,
  // automations, vues, règles) est résumé dans le toast plutôt que dans une
  // modale bloquante.
  async function deleteCustomField(field) {
    let dependents = []
    try { dependents = (await api.customFields.dependents(field.id))?.dependents || [] } catch { /* rapport optionnel */ }
    forgetColumn(field)
    let cancelled = false
    const timer = setTimeout(async () => {
      if (cancelled) return
      try {
        await api.customFields.delete(field.id)
        // Les colonnes Airtable aussi : sans ce reload, la colonne physique du
        // champ supprimé reste dans `atData` et la ligne se réaffiche en
        // « colonne ERP non adoptée » jusqu'au prochain chargement de la page.
        await Promise.all([reloadCustomFields(), reloadAirtableColumns()])
      } catch (e) {
        unforgetColumn(field)
        addToast({ message: e.message, type: 'error' })
      }
    }, UNDO_DELETE_MS)
    addToast({
      type: 'undo',
      message: `Champ « ${field.name} » supprimé${shortDependentsNote(dependents)}`,
      duration: UNDO_DELETE_MS,
      action: {
        label: 'Annuler',
        onClick: () => {
          cancelled = true
          clearTimeout(timer)
          unforgetColumn(field)
          addToast({ message: 'Suppression annulée', type: 'success', duration: 2000 })
        },
      },
    })
  }

  // Sens de sync des champs dynamiques mappés (surcouche optimiste sur la valeur
  // servie par mapping-data) — autosave immédiat, revert si le serveur refuse.
  const [dynDirs, setDynDirs] = useState({})
  async function changeDynDirection(column, dir) {
    const prev = dynDirs[column] ?? atByColumn.get(column)?.direction ?? 'pull'
    setDynDirs(d => ({ ...d, [column]: dir }))
    try {
      await api.airtable.setModuleFieldDirection(ownModule.module, `dyn:${column}`, dir)
      addToast({ message: 'Sens de synchronisation mis à jour', type: 'success' })
    } catch (e) {
      setDynDirs(d => ({ ...d, [column]: prev }))
      addToast({ message: e.message, type: 'error' })
    }
  }

  // Adoption d'une colonne ERP encore sans présentation : choisir son type la
  // matérialise comme champ (custom_fields), ce qui débloque renommage et
  // suppression. Ensuite le type se change depuis la fiche du champ.
  async function adoptColumnType(col, type) {
    const at = atByColumn.get(col.field)
    if (!at || at.cf_id) return
    const ok = await atApplyChange(at, { type })
    if (ok) {
      await reloadCustomFields()
      addToast({ message: 'Champ configuré', type: 'success' })
    }
  }

  // Champs Airtable « mappés en dur » restant à signaler : ceux du field_map du
  // module qui ne sont PAS déjà pilotés par une ligne du tableau (mapping cœur
  // fusionné) — sinon on annoncerait « non modifiable ici » juste au-dessous du
  // picker qui les modifie.
  // Un champ converti en champ personnalisé (« Contact », « # de retour ») y
  // reste listé, et c'est exact : ce que la note décrit est le BRANCHEMENT
  // Airtable→colonne, qui vit toujours dans le plan cœur du miroir — le champ
  // ERP, lui, se renomme et se supprime dans le tableau ci-dessus.
  const hardcodedLeft = useMemo(() => {
    const shown = new Set([...coreByColumn.values()].map(f => core.draft[f.key]).filter(Boolean))
    return (atData?.hardcoded || []).filter(n => !shown.has(n))
  }, [atData, coreByColumn, core.draft])

  const showMapping = !!(ownModule || inlineCoreModule || directFields)

  // Props de mapping « cœur » d'une colonne — construites une seule fois pour
  // la ligne du tableau ET pour la fiche du champ (même cellule, même autosave).
  function buildCore(coreField) {
    return buildCoreProps(inlineCoreModule?.module || null, coreField, core)
  }

  // Champ ouvert dans la modale « Modifier le champ » → sa cellule de mapping,
  // injectée dans la modale. Le mapping se change donc là où l'utilisateur est
  // déjà (l'ancien texte de la modale renvoyait à une page qui n'existe plus).
  // Même cellule que dans le tableau : la page a déjà tout chargé, elle ne
  // repasse pas par <FieldAirtableMapping> (qui refetcherait pour rien et
  // laisserait la ligne du tableau en arrière d'un mapping).
  const editingColumn = cfModal?.editing?.column_name
    || nativeModal?.col?.field || nativeModal?.col?.id || null
  const editingCell = mappingCellFor({
    showMapping,
    column: editingColumn,
    cfKind: cfModal?.editing?.kind || null,
    coreProps: buildCore(editingColumn ? coreByColumn.get(editingColumn) : null),
    at: editingColumn ? atByColumn.get(editingColumn) : null,
    airtableFields: atData?.airtable_fields || [],
    tableMap: atData?.airtable_table_to_erp,
    ownModule,
    onSaveMapping: atSaveMapping,
    savingId: atSavingId,
    fixedField: editingColumn ? (directFields?.[editingColumn] || null) : null,
    fixedReason: directSource?.reason,
  })
  const mappingSlot = editingCell ? <MappingBlock>{editingCell}</MappingBlock> : null

  return (
    <Layout>
      {/* pb-28 : le bouton flottant de feedback masquerait la dernière ligne du
          tableau (avant, la barre d'enregistrement du mapping cœur portait cette
          marge — elle a disparu avec l'autosave). */}
      <div className="p-6 pb-28">
        <div className="flex items-start justify-between mb-6 gap-4">
          <div className="min-w-0">
            {backTo && (
              <button
                onClick={() => navigate(backTo)}
                data-testid="fieldcfg-back"
                title="Retour à la table"
                aria-label="Retour à la table"
                className="text-slate-600 hover:text-slate-900 inline-flex items-center mb-5 mr-2.5"
              >
                <ArrowLeft size={16} />
              </button>
            )}
            <PageTitle>
              Configuration des champs — {TABLE_LABELS[table] || table}
            </PageTitle>
          </div>
          {selfManagedCF && (
            <button
              onClick={() => setCfModal({ editing: null })}
              data-testid="fieldcfg-add-field"
              className="btn-primary flex items-center gap-1.5 flex-shrink-0"
            >
              <Plus size={15} /> Nouveau champ
            </button>
          )}
        </div>

        {/* Pas d'onglets : la page ne configure que la table d'où elle vient. */}
        <div data-testid="fieldcfg-panel">
          {/* Source Airtable de la table (état + sync) — ex-en-tête de l'onglet Airtable */}
          {ownModule && (
            <div className="mb-4">
              {atData
                ? <ModuleSourceStatus data={atData} onSynced={() => reloadCustomFields()} />
                : (
                  // Tant que les métadonnées Airtable ne sont pas revenues, on ne
                  // prétend pas que la source est « non configurée ».
                  <div className="bg-white border border-slate-200 rounded-lg p-4">
                    <h2 className="text-sm font-semibold text-slate-800">Source Airtable</h2>
                    <p className="text-xs text-slate-600 mt-0.5">Chargement de la configuration…</p>
                  </div>
                )}
            </div>
          )}

          {/* Table lue en direct : même place que l'en-tête « Source Airtable »
              d'un module, mais rien à synchroniser ni à régler. */}
          {!ownModule && directSource && (
            <div
              data-testid="fieldcfg-direct-source"
              className="mb-4 bg-white border border-slate-200 rounded-lg p-4"
            >
              <h2 className="text-sm font-semibold text-slate-800">Source Airtable — {directSource.label}</h2>
              <p className="text-xs text-slate-600 mt-0.5">{directSource.reason}</p>
            </div>
          )}

          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-600" />
              <input
                value={filter}
                onChange={e => setFilter(e.target.value)}
                data-testid="fieldcfg-search"
                className="input text-sm py-1 pl-7 w-64"
              />
            </div>
            <span className="text-xs text-slate-600">
              {/* Les métadonnées Airtable mettent quelques secondes : on le dit
                  plutôt que de laisser la liste s'allonger sans explication. */}
              {ownModule && !atData && <span className="text-slate-600 mr-2">Chargement des champs Airtable…</span>}
              {visibleRows.length} champ{visibleRows.length !== 1 ? 's' : ''}
            </span>
          </div>

          <div className="card">
            {visibleRows.length > 0 && <FieldsHeader mapping={showMapping} />}
            {visibleRows.length === 0
              ? <p className="text-sm text-slate-600 p-6">Aucun champ{filter ? ' ne correspond à cette recherche' : ' pour cette table'}.</p>
              : visibleRows.map((col, i) => {
                const cf = cfByColumn.get(col.field) || cfByColumn.get(col.id) || null
                const coreField = coreByColumn.get(col.field) || null
                return (
                  <FieldRow
                    key={col.id}
                    col={col}
                    cf={cf}
                    index={i}
                    onRename={next => renameField(col, cf, next)}
                    onEdit={() => (cf ? setCfModal({ editing: cf }) : setNativeModal({ col: baseById.get(col.id) || col }))}
                    onDelete={() => deleteCustomField(cf)}
                    onDeleteNative={() => deleteNativeField(col)}
                    at={atByColumn.get(col.field) || null}
                    mappingAt={col.mappingColumn ? (atByColumn.get(col.mappingColumn) || null) : null}
                    moduleLabel={atData?.label || ownModule?.title || null}
                    airtableFields={atData?.airtable_fields || []}
                    tableMap={atData?.airtable_table_to_erp}
                    savingId={atSavingId}
                    onSaveMapping={ownModule ? atSaveMapping : null}
                    showMapping={showMapping}
                    dynModule={ownModule?.module || null}
                    dynDirection={dynDirs[mappingKey(col)] ?? atByColumn.get(mappingKey(col))?.direction ?? 'pull'}
                    onDynDirection={ownModule ? (dir => changeDynDirection(mappingKey(col), dir)) : null}
                    // Une colonne portée par une clé « cœur » n'est jamais adoptée
                    // en champ perso depuis ici : c'est le field_map du module qui
                    // l'alimente, et son type est fixé par le sync.
                    onAdoptType={ownModule && col.unlisted && !coreField ? (type => adoptColumnType(col, type)) : null}
                    core={buildCore(coreField)}
                    fixedField={directFields?.[col.field] || null}
                    fixedReason={directSource?.reason}
                  />
                )
              })}
          </div>

          {/* Pas de section « Champs masqués » : un champ supprimé disparaît
              vraiment (corbeille dans Paramètres → Corbeille). */}

          {/* Mapping « cœur » fusionné : chaque cellule s'enregistre elle-même
              (voir AirtableFieldCell) — il n'y a plus de barre
              « Enregistrer le mapping », qui aurait signalé à l'utilisateur une
              différence de nature entre ces champs et les autres. Seule
              l'erreur de chargement du mapping reste à dire. */}
          {inlineCoreModule && core.loadError && (
            <p className="mt-3 text-sm text-red-600">{core.loadError}</p>
          )}

          {hardcodedLeft.length > 0 && (
            <div className="mt-4 text-xs text-slate-600">
              <p className="font-medium mb-1">
                {hardcodedLeft.length} champ{hardcodedLeft.length !== 1 ? 's' : ''} Airtable
                géré{hardcodedLeft.length !== 1 ? 's' : ''} en code (mappé{hardcodedLeft.length !== 1 ? 's' : ''} en dur, non modifiable{hardcodedLeft.length !== 1 ? 's' : ''} ici) :
              </p>
              <p className="text-slate-600">{hardcodedLeft.join(', ')}</p>
            </div>
          )}

          {/* Mapping « cœur » de CETTE table dont les clés n'ont pas de colonne
              ERP déclarée : il ne peut pas se fusionner ligne à ligne, il vit
              donc juste sous le tableau (ex-onglet). mb-24 : dernier élément de
              la page — sans cette marge son bouton finit sous le bouton flottant
              de feedback. */}
          {paneCoreModule && (
            <div className="mt-6 mb-24 max-w-4xl" data-testid={`fieldcfg-coremap-${paneCoreModule.module}`}>
              <h2 className="text-sm font-semibold text-slate-800 mb-2">
                Champs alimentés par Airtable
              </h2>
              <CoreMapPane
                module={paneCoreModule.module}
                // Les détails de sync sont déjà affichés en tête de page.
                showSync={false}
                onSaved={() => reloadCustomFields()}
              />
            </div>
          )}
        </div>
      </div>

      {/* Modale commune de champ : champs perso (création / édition) et champs
          natifs (renommage / changement de type via field_overrides). */}
      <CustomFieldModal
        isOpen={!!cfModal || !!nativeModal}
        onClose={() => { setCfModal(null); setNativeModal(null) }}
        // Mode natif (override cosmétique) : clé de vue — les overrides sont
        // stockés par vue. Mode champ perso : vraie table SQL (custom_fields).
        erpTable={nativeModal ? table : sqlTable}
        editing={cfModal?.editing || null}
        native={nativeModal?.col
          ? { column: nativeModal.col, override: overrides.get(nativeModal.col.id) || null }
          : null}
        mappingSlot={mappingSlot}
        onSaved={() => { nativeModal ? reloadOverrides() : reloadCustomFields() }}
        onDeleted={(field) => { forgetColumn(field); reloadCustomFields(); reloadAirtableColumns() }}
      />
    </Layout>
  )
}

// Redirection des anciennes URL de contrôle des champs Airtable
// (/airtable/fields/:module et /projects/fields) vers la page de configuration
// des champs de la table du module, où cette interface vit maintenant.
export function AirtableFieldsRedirect() {
  const { module: moduleParam } = useParams()
  const module = moduleParam || 'projets'
  const navigate = useNavigate()
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    api.airtable.fieldModules()
      .then(list => {
        if (!alive) return
        const hit = (list || []).find(m => m.module === module)
        if (!hit?.erp_table) { setError(`Module Airtable inconnu : ${module}`); return }
        navigate(`/champs/${urlTableForSql(hit.erp_table)}`, { replace: true })
      })
      .catch(e => alive && setError(e.message))
    return () => { alive = false }
  }, [module, navigate])

  return (
    <Layout>
      <div className="p-6">
        {error
          ? <p className="text-sm text-red-600">{error}</p>
          : <p className="text-sm text-slate-600">Redirection…</p>}
      </div>
    </Layout>
  )
}
