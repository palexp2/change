import { useState, useEffect, useMemo, useRef } from 'react'
import { useParams, useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { Pencil, Trash2, RotateCcw, Plus, Sparkles, ArrowLeft, Search } from 'lucide-react'
import api from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { TABLE_LABELS, TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { typeLabel, useFieldOverrides, applyFieldOverrides, applyFieldOrder } from '../lib/fieldOverrides.jsx'
import {
  CoreMapPane, CoreFieldPicker, CoreMapSaveBar, DirectionControl, useCoreMap, DIRECTIONS,
} from '../components/AirtableCoreMapModal.jsx'
import { CustomFieldModal } from '../components/CustomFieldModal.jsx'
import { SyncDetails } from '../components/SyncDetails.jsx'
import {
  AirtableModuleFields, MappingPicker, ModuleSourceStatus, AirtableConfigSection,
  useModuleFields, TYPE_OPTIONS,
} from '../components/AirtableModuleFields.jsx'
import { useCustomFields } from '../lib/useCustomFields.js'
import { customFieldToColumn, CUSTOM_FIELD_TABLES } from '../lib/customFieldDisplay.jsx'
import { summarizeDependents } from '../lib/customFieldDeps.js'
import { useConfirm } from '../components/ConfirmProvider.jsx'

// Icône du sens « Airtable → ERP », partagée avec le mapping des champs cœur.
const DirPullIcon = DIRECTIONS.pull.Icon
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
// (`inline_columns` — cf. CORE_FIELD_SPECS) : la ligne du champ porte alors le
// picker du mapping cœur au lieu de celui des champs dynamiques, et une barre
// « Enregistrer le mapping » apparaît sous le tableau (ce mapping n'est pas
// autosauvé : il peut déclencher une resynchronisation complète).
//
// Un onglet séparé subsiste pour les mappings cœur non rattachables à une
// colonne (CoreMapPane — clés de spec sans `column`) et pour les modules
// « enfants » qui alimentent une AUTRE table ERP (ex. lignes de commande sur
// /champs/orders).

// Modules à mapping cœur supplémentaires à afficher pour une table donnée : les
// lignes d'un document se configurent depuis la page du document parent.
const EXTRA_MODULES_BY_TABLE = {
  orders: ['order_items'],
  paies: ['paie_items'],
  serial_transitions: ['serials'],
  serial_accounting_rules: ['serial_changes', 'serials'],
}

// Tables ERP des modules Airtable dont le nom diffère de la clé de vue
// DataTable (registre serveur AIRTABLE_FIELD_MODULES).
const MODULE_ERP_TABLE_ALIAS = {
  returns: 'retours',
  serial_state_changes: 'serial_transitions',
}

function normalizeErpTable(t) {
  return MODULE_ERP_TABLE_ALIAS[t] || t
}

// Modules Airtable à présenter en onglets pour la table courante :
//   • `kind: 'coremap'` — le module a un mapping des champs cœur (CoreMapPane).
//   • `kind: 'link'`    — le module n'a que le contrôle de champ par module
//     (page /airtable/fields/:module) : on affiche les détails de sync et un
//     lien vers cette page plutôt que de dupliquer son interface.
function useAirtableModules(table) {
  const [modules, setModules] = useState([])
  useEffect(() => {
    if (!table) return
    let alive = true
    Promise.all([
      api.airtable.coreMapModules().catch(() => []),
      api.airtable.fieldModules().catch(() => []),
    ])
      .then(([core, all]) => {
        if (!alive) return
        const extras = EXTRA_MODULES_BY_TABLE[table] || []
        const isOwn = m => normalizeErpTable(m.erp_table) === table
        const rank = m => (isOwn(m) ? -1 : extras.indexOf(m.module))
        const mine = list => (list || [])
          .filter(m => normalizeErpTable(m.erp_table) === table || extras.includes(m.module))
          .sort((a, b) => rank(a) - rank(b))
        const coreMine = mine(core)
        const coreKeys = new Set((core || []).map(m => m.module))
        const linkMine = mine(all).filter(m => !coreKeys.has(m.module))
        // Modules du registre de contrôle de champ (peuvent aussi avoir un mapping cœur).
        // Un module peut avoir les deux : mapping cœur (colonnes ERP fixes) ET
        // contrôle des champs Airtable supplémentaires. On fusionne par clé.
        const fieldKeys = new Set((all || []).map(m => m.module))
        const merged = new Map()
        for (const m of coreMine) {
          // `inline` : toutes les clés cœur du module déclarent leur colonne ERP,
          // donc son mapping se fusionne dans le tableau (pas d'onglet dédié).
          merged.set(m.module, { module: m.module, title: m.label, coremap: true, inline: !!m.inline_columns, fields: fieldKeys.has(m.module), own: isOwn(m) })
        }
        for (const m of linkMine) {
          if (!merged.has(m.module)) merged.set(m.module, { module: m.module, title: m.label, coremap: false, inline: false, fields: true, own: isOwn(m) })
        }
        setModules([...merged.values()])
      })
    return () => { alive = false }
  }, [table])
  return modules
}

// En-tête du tableau des champs. Les largeurs suivent exactement celles de
// `FieldRow` (w-6 / flex-1 / w-28 / w-16 / w-5 / w-64 / actions) : toute
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
      <span className="w-16 flex-shrink-0 truncate">Origine</span>
      {mapping && (
        // Colonne de 20 px : le libellé déborde un peu dans les gouttières
        // voisines (12 px de chaque côté) plutôt que d'être tronqué.
        <span className="w-5 flex-shrink-0 text-center text-[10px] whitespace-nowrap" title="Sens de synchronisation">Sens</span>
      )}
      {mapping && <span className="w-64 flex-shrink-0 truncate">Champ Airtable</span>}
      {/* 90 px = les trois boutons d'action de la ligne (22 px) et leurs gouttières. */}
      <span className="w-[90px] flex-shrink-0 text-center">Actions</span>
    </div>
  )
}

// Une ligne de champ : nom éditable (autosave au blur), type, et actions
// (éditer / réinitialiser / supprimer).
function FieldRow({
  col, cf, override, index, onRename, onEdit, onReset, onDelete,
  // Volet Airtable (fusionné depuis l'ancien onglet) : `at` = entrée mapping-data
  // de la colonne, `airtableFields` / `tableMap` = données du picker.
  // `onAdoptType` n'est fourni que pour les colonnes ERP que la table n'affiche
  // pas encore : choisir leur type les matérialise en champ. Une colonne native
  // de la DataTable se règle via « Modifier le champ » (crayon).
  at, airtableFields, tableMap, onSaveMapping, onAdoptType, savingId,
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
      {at && !at.cf_id && onAdoptType
        ? (
          <select
            value={at.field_type || 'text'}
            onChange={e => onAdoptType(e.target.value)}
            disabled={savingId === col.field}
            title="Choisir le type d'affichage adopte cette colonne"
            data-testid={`fieldcfg-type-${col.id}`}
            className="w-28 flex-shrink-0 rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-800 cursor-pointer hover:border-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-500/30 disabled:opacity-50"
          >
            {TYPE_OPTIONS.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
        )
        : (
          <span className="text-xs text-slate-600 w-28 flex-shrink-0 truncate" title={`Colonne : ${col.field}`}>
            {col.renderTypeLabel || typeLabel(col.type)}
          </span>
        )}
      <span className="w-16 flex-shrink-0">
        {cf && (
          <span className="text-[10px] text-brand-600 bg-brand-50 rounded px-1.5 py-0.5 inline-flex items-center gap-1">
            <Sparkles size={9} /> perso
          </span>
        )}
      </span>
      {/* Sens de sync. Champ cœur : réglable via le field_map du module. Champ
          dynamique mappé d'un module write-back : réglable aussi (clé `dyn:<colonne>`,
          défaut Airtable → ERP — cf. services/airtableWriteback.js). Sinon (champ
          lien, module sans write-back, non mappé) : icône statique en lecture seule. */}
      {showMapping && (
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
              />
            </span>
          )
          : at?.mapped && at.direction_configurable && dynModule && onDynDirection
            ? (
              <span className="w-5 flex-shrink-0 inline-flex justify-center">
                <DirectionControl
                  compact
                  module={dynModule}
                  fieldKey={`dyn-${col.field}`}
                  direction={dynDirection || 'pull'}
                  configurable
                  mapped
                  onChange={onDynDirection}
                />
              </span>
            )
            : (
              <span
                title={at?.mapped ? DIRECTIONS.pull.title : 'Aucun mapping Airtable — ce champ n’est pas importé'}
                data-testid={`fieldcfg-direction-${col.id}`}
                data-direction={at?.mapped ? 'pull' : 'none'}
                className={`w-5 flex-shrink-0 inline-flex justify-center cursor-help ${at?.mapped ? 'text-slate-600' : 'text-slate-400'}`}
              >
                <DirPullIcon size={13} />
              </span>
            )
      )}
      {/* Champ Airtable qui alimente la colonne — vide = pas d'import. */}
      {showMapping && (
        <span
          className="w-64 flex-shrink-0"
          data-testid={`fieldcfg-airtable-${col.id}`}
          data-core={core ? '1' : undefined}
          title={core ? `Champ « cœur » du module — alimente la colonne ${col.field} à chaque synchronisation` : undefined}
        >
          {core
            ? (
              <CoreFieldPicker
                module={core.module}
                field={core.field}
                value={core.value}
                onChange={core.onChange}
                options={core.options}
                suggestion={core.suggestion}
              />
            )
            : at
              ? (
                <MappingPicker
                  erpColumn={at}
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
      {/* Place réservée même sans bouton « réinitialiser » : les actions restent
          alignées d'une ligne à l'autre, et sous l'en-tête. */}
      {!(!cf && override && (override.label || override.type)) && <span className="w-[22px] flex-shrink-0" aria-hidden="true" />}
      {!cf && override && (override.label || override.type) && (
        <button
          type="button"
          onClick={onReset}
          title="Réinitialiser le nom et le type d'origine"
          data-testid={`fieldcfg-reset-${col.id}`}
          className="p-1 text-slate-600 hover:text-amber-600 flex-shrink-0"
        >
          <RotateCcw size={14} />
        </button>
      )}
      {cf
        ? (
          <button
            type="button"
            onClick={onDelete}
            title="Supprimer le champ"
            data-testid={`fieldcfg-delete-${col.id}`}
            className="p-1 text-slate-600 hover:text-red-500 flex-shrink-0"
          >
            <Trash2 size={14} />
          </button>
        )
        : (
          <span
            title={at && !at.cf_id
              // Colonne ERP sans champ configuré : typiquement le résidu d'un champ
              // supprimé (la colonne SQLite n'est jamais droppée) ou une colonne
              // jamais adoptée. Rien à supprimer — c'est le mapping qui l'alimente.
              ? 'Colonne ERP sans champ configuré — rien à supprimer ici. Videz son « Champ Airtable » pour couper l’import.'
              : 'Champ natif — non supprimable (masquez-le depuis le panneau « Champs » de la table)'}
            data-testid={`fieldcfg-delete-disabled-${col.id}`}
            className="p-1 text-slate-400 cursor-not-allowed flex-shrink-0"
          >
            <Trash2 size={14} />
          </span>
        )}
    </div>
  )
}

export default function FieldConfig() {
  const { table } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const confirm = useConfirm()
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

  const modules = useAirtableModules(table)
  // ?tab=<module> : deep-link vers un onglet Airtable (utilisé par la
  // redirection des anciennes URL /airtable/fields/:module).
  const [searchParams, setSearchParams] = useSearchParams()
  const askedTab = searchParams.get('tab')
  const [tab, setTabRaw] = useState(askedTab || 'fields')
  const setTab = (next) => {
    setTabRaw(next)
    const sp = new URLSearchParams(searchParams)
    if (next === 'fields') sp.delete('tab')
    else sp.set('tab', next)
    // `state` reconduit : sans lui, le replace perd les colonnes passées par la
    // DataTable et le chemin de retour.
    setSearchParams(sp, { replace: true, state: location.state })
  }

  // Module Airtable qui alimente CETTE table : son contrôle par champ est
  // fusionné dans le tableau principal (colonne « Champ Airtable »).
  const ownModule = modules.find(m => m.own && m.fields) || null
  const {
    data: atData, savingId: atSavingId, applyChange: atApplyChange, saveMapping: atSaveMapping,
    reload: reloadAirtableColumns,
  } = useModuleFields(ownModule?.module || null)
  const [filter, setFilter] = useState('')

  const { overrides, reload: reloadOverrides } = useFieldOverrides(table)
  const selfManagedCF = CUSTOM_FIELD_TABLES.has(table)
  const { fields: customFields, loaded: cfLoaded, reload: reloadCustomFields } = useCustomFields(selfManagedCF ? table : null)

  // Mapping des champs « cœur » de CETTE table, quand chaque clé de la spec
  // déclare sa colonne ERP : il se fusionne ligne à ligne dans le tableau plutôt
  // que dans un onglet à part.
  const inlineCoreModule = modules.find(m => m.own && m.coremap && m.inline) || null
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

  const columns = useMemo(
    () => applyFieldOrder(applyFieldOverrides(mergedBase, overrides), overrides),
    [mergedBase, overrides]
  )

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
      || (atByColumn.get(c.field)?.mapped_airtable_field || '').toLowerCase().includes(q)
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

  async function resetField(col) {
    try {
      await api.fieldOverrides.reset(table, col.id)
      await reloadOverrides()
      addToast({ message: 'Champ réinitialisé', type: 'success' })
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    }
  }

  // Suppression d'un champ perso : rapport de dépendances (champs calculés,
  // automations, vues, règles) avant de les casser en silence — même logique
  // que le menu contextuel d'en-tête de DataTable.
  async function deleteCustomField(field) {
    let dependents = []
    try { dependents = (await api.customFields.dependents(field.id))?.dependents || [] } catch { /* rapport optionnel */ }
    const depMsg = summarizeDependents(dependents)
    if (!(await confirm({
      title: 'Supprimer le champ',
      message: `Supprimer le champ "${field.name}" ? Restaurable depuis la corbeille.${depMsg}`,
      confirmLabel: dependents.length ? 'Supprimer quand même' : 'Supprimer',
    }))) return
    try {
      await api.customFields.delete(field.id)
      forgetColumn(field)
      addToast({ message: 'Champ supprimé', type: 'success' })
      // Les colonnes Airtable aussi : sans ce reload, la colonne physique du
      // champ supprimé reste dans `atData` et la ligne se réaffiche en
      // « colonne ERP non adoptée » jusqu'au prochain chargement de la page.
      await Promise.all([reloadCustomFields(), reloadAirtableColumns()])
    } catch (e) {
      addToast({ message: e.message, type: 'error' })
    }
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
  const hardcodedLeft = useMemo(() => {
    const shown = new Set([...coreByColumn.values()].map(f => core.draft[f.key]).filter(Boolean))
    return (atData?.hardcoded || []).filter(n => !shown.has(n))
  }, [atData, coreByColumn, core.draft])

  // Onglets restants : mappings « cœur » non rattachables à une colonne, et
  // modules enfants (autre table ERP). Le module de la table courante est
  // fusionné dans le tableau principal — contrôle par champ ET, quand la spec
  // déclare les colonnes (`inline`), mapping cœur.
  const tabModules = modules.filter(m => (m.coremap && !(m.own && m.inline)) || !m.own)
  const tabs = [
    { key: 'fields', title: 'Champs' },
    ...tabModules.map(m => ({ key: m.module, title: `Airtable · ${m.title}` })),
  ]
  // ?tab= pointant vers un module fusionné dans le tableau (ex. l'ancienne URL
  // /airtable/fields/contacts) ou inconnu : on retombe sur « Champs » — sans ça
  // la page n'afficherait rien. `modules` arrive en asynchrone : tant qu'il est
  // vide on garde l'onglet demandé.
  const activeTab = (modules.length === 0 || tabs.some(t => t.key === tab)) ? tab : 'fields'

  // Les anciennes URL /airtable/fields/:module visaient le contrôle par champ.
  // Quand ce module est celui de la table courante, ce contrôle vit désormais
  // dans le tableau principal → on y bascule (l'onglet du module, s'il existe
  // encore, ne porte plus que le mapping des champs « cœur »).
  // N'agit que sur le ?tab d'ARRIVÉE : un clic sur l'onglet « cœur » d'un module
  // fusionné doit rester possible (il porte encore le mapping des champs cœur).
  const initialTabRef = useRef(askedTab)
  const tabIntentDone = useRef(false)
  useEffect(() => {
    const asked = initialTabRef.current
    if (tabIntentDone.current || !asked || asked === 'fields' || modules.length === 0) return
    tabIntentDone.current = true
    const m = modules.find(x => x.module === asked)
    if (m && m.own && (m.fields || m.inline)) setTabRaw('fields')
  }, [modules])

  return (
    <Layout>
      <div className="p-6">
        <div className="flex items-start justify-between mb-6 gap-4">
          <div className="min-w-0">
            {backTo && (
              <button
                onClick={() => navigate(backTo)}
                data-testid="fieldcfg-back"
                className="text-xs text-slate-600 hover:text-slate-900 inline-flex items-center gap-1 mb-1"
              >
                <ArrowLeft size={12} /> Retour à la table
              </button>
            )}
            <h1 className="text-2xl font-bold text-slate-900">
              Configuration des champs — {TABLE_LABELS[table] || table}
            </h1>
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

        <div className={`flex gap-0.5 border-b border-slate-200 mb-5 ${tabs.length > 1 ? '' : 'hidden'}`}>
          {tabs.map(t => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              data-testid={`fieldcfg-tab-${t.key}`}
              className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
                activeTab === t.key ? 'border-brand-600 text-brand-600' : 'border-transparent text-slate-600 hover:text-slate-900'
              }`}
            >
              {t.title}
            </button>
          ))}
        </div>

        <div className={activeTab === 'fields' ? '' : 'hidden'}>
          <p className="text-xs text-slate-600 mb-3 max-w-3xl">
            Le nom de chaque champ se modifie directement
            ci-dessous{ownModule || inlineCoreModule ? ", et la dernière colonne choisit le champ Airtable qui alimente chacun (vide = pas d'import)" : ''} ;
            les colonnes SQL et les synchronisations ne sont pas touchées.
            {ownModule && " La colonne « Sens » règle la direction de synchronisation de chaque champ mappé (Airtable → ERP, ERP → Airtable ou bidirectionnel)."}
            {inlineCoreModule && " Les champs « cœur » du module s'enregistrent avec le bouton sous le tableau : leur mapping peut relancer une synchronisation complète."}
          </p>

          {/* Source Airtable de la table (état + sync) — ex-en-tête de l'onglet Airtable */}
          {ownModule && (
            <div className="mb-4">
              {ownModule.module === 'projets'
                ? <AirtableConfigSection onSynced={() => reloadCustomFields()} />
                : atData
                  ? <ModuleSourceStatus data={atData} onSynced={() => reloadCustomFields()} />
                  : (
                    // Tant que les métadonnées Airtable ne sont pas revenues, on ne
                    // prétend pas que la source est « non configurée ».
                    <div className="bg-white border border-slate-200 rounded-lg p-4">
                      <h2 className="text-sm font-semibold text-slate-800">Source Airtable</h2>
                      <p className="text-xs text-slate-600 mt-0.5">Chargement de la configuration…</p>
                    </div>
                  )}
              {/* Détails de sync de la table — ex-en-tête du panneau de mapping
                  cœur, conservés ici puisque son onglet a fusionné. */}
              {inlineCoreModule && <div className="mt-4"><SyncDetails table={table} connector="Airtable" /></div>}
            </div>
          )}

          <div className="flex items-center justify-between gap-3 mb-2">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-600" />
              <input
                value={filter}
                onChange={e => setFilter(e.target.value)}
                placeholder="Rechercher un champ…"
                data-testid="fieldcfg-search"
                className="input text-sm py-1 pl-7 w-64"
              />
            </div>
            <span className="text-xs text-slate-600">
              {/* Les métadonnées Airtable mettent quelques secondes : on le dit
                  plutôt que de laisser la liste s'allonger sans explication. */}
              {ownModule && !atData && <span className="text-slate-600 mr-2">Chargement des champs Airtable…</span>}
              {visibleRows.length} champ{visibleRows.length !== 1 ? 's' : ''}
              {atData && (() => {
                // Mappés = champs dynamiques mappés + clés « cœur » mappées
                // (les deux alimentent la table depuis Airtable).
                const n = atData.erp_columns.filter(c => c.mapped).length
                  + [...coreByColumn.values()].filter(f => core.draft[f.key]).length
                return <> · <span className="text-brand-600 font-medium">
                  {n} mappé{n !== 1 ? 's' : ''} depuis Airtable
                </span></>
              })()}
            </span>
          </div>

          <div className="card">
            {visibleRows.length > 0 && <FieldsHeader mapping={!!(ownModule || inlineCoreModule)} />}
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
                    override={overrides.get(col.id) || null}
                    onRename={next => renameField(col, cf, next)}
                    onEdit={() => (cf ? setCfModal({ editing: cf }) : setNativeModal({ col: baseById.get(col.id) || col }))}
                    onReset={() => resetField(col)}
                    onDelete={() => deleteCustomField(cf)}
                    at={atByColumn.get(col.field) || null}
                    airtableFields={atData?.airtable_fields || []}
                    tableMap={atData?.airtable_table_to_erp}
                    savingId={atSavingId}
                    onSaveMapping={ownModule ? atSaveMapping : null}
                    showMapping={!!(ownModule || inlineCoreModule)}
                    dynModule={ownModule?.module || null}
                    dynDirection={dynDirs[col.field] ?? atByColumn.get(col.field)?.direction ?? 'pull'}
                    onDynDirection={ownModule ? (dir => changeDynDirection(col.field, dir)) : null}
                    // Une colonne portée par une clé « cœur » n'est jamais adoptée
                    // en champ perso depuis ici : c'est le field_map du module qui
                    // l'alimente, et son type est fixé par le sync.
                    onAdoptType={ownModule && col.unlisted && !coreField ? (type => adoptColumnType(col, type)) : null}
                    core={coreField && {
                      module: inlineCoreModule.module,
                      field: coreField,
                      value: core.draft[coreField.key] || '',
                      options: core.options,
                      suggestion: core.data?.suggested?.[coreField.key],
                      direction: core.dirs[coreField.key] || coreField.direction,
                      onChange: v => { core.setDraft(d => ({ ...d, [coreField.key]: v })); core.setSavedMsg('') },
                      onDirection: dir => core.changeDirection(coreField.key, dir),
                    }}
                  />
                )
              })}
          </div>

          {/* Mapping « cœur » : pas d'autosave (il peut relancer une
              resynchronisation complète du module) — enregistrement explicite. */}
          {inlineCoreModule && core.data && (
            // mb-24 : la barre est le dernier élément de la page — sans cette
            // marge, son bouton finit sous le bouton flottant de feedback.
            <div className="card mt-3 mb-24 px-3 py-2 space-y-2">
              {core.loadError && <p className="text-sm text-red-600">{core.loadError}</p>}
              <CoreMapSaveBar module={inlineCoreModule.module} core={core} />
            </div>
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
        </div>

        {tabModules.map(m => (
          <div key={m.module} className={activeTab === m.module ? '' : 'hidden'}>
            {m.coremap && (
              <div className="max-w-4xl">
                <CoreMapPane module={m.module} onSaved={() => reloadCustomFields()} />
              </div>
            )}
            {m.coremap && m.fields && !m.own && <div className="border-t border-slate-200 my-6" />}
            {m.fields && !m.own && (
              <>
                {m.coremap && (
                  <h2 className="text-sm font-semibold text-slate-800 mb-2">
                    Champs Airtable supplémentaires
                  </h2>
                )}
                <AirtableModuleFields module={m.module} />
              </>
            )}
            {!m.coremap && !(m.fields && !m.own) && (
              <div className="max-w-4xl space-y-4">
                <SyncDetails table={table} connector="Airtable" />
                <p className="text-xs text-slate-600">Ce module n'expose aucun réglage de champ.</p>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Modale commune de champ : champs perso (création / édition) et champs
          natifs (renommage / changement de type via field_overrides). */}
      <CustomFieldModal
        isOpen={!!cfModal || !!nativeModal}
        onClose={() => { setCfModal(null); setNativeModal(null) }}
        erpTable={table}
        editing={cfModal?.editing || null}
        native={nativeModal?.col
          ? { column: nativeModal.col, override: overrides.get(nativeModal.col.id) || null }
          : null}
        onSaved={() => { nativeModal ? reloadOverrides() : reloadCustomFields() }}
        onDeleted={(field) => { forgetColumn(field); reloadCustomFields(); reloadAirtableColumns() }}
      />
    </Layout>
  )
}

// Redirection des anciennes URL de contrôle des champs Airtable
// (/airtable/fields/:module et /projects/fields) vers l'onglet correspondant de
// la page de configuration des champs, où cette interface vit maintenant.
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
        navigate(`/champs/${normalizeErpTable(hit.erp_table)}?tab=${module}`, { replace: true })
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
