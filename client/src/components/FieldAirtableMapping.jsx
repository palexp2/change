import { useState, useEffect, useMemo } from 'react'
import { Lock } from 'lucide-react'
import api from '../lib/api.js'
import { readStale, writeStale } from '../lib/swr.js'
import { prefetch } from '../lib/prefetch.js'
import { AirtableFieldCell, MappingPicker, useModuleFields } from './AirtableModuleFields.jsx'
import { useCoreMap } from './AirtableCoreMapModal.jsx'
import { MappingBlock } from './CustomFieldModal.jsx'
import { isComputedKind } from '../lib/fieldOverrides.jsx'
import { sqlTableForView } from '../lib/customFieldDisplay.jsx'

// Le champ Airtable qui alimente une colonne, partout où l'on modifie un champ.
//
// Deux appelants, deux besoins :
//   - la page /champs/:table a déjà chargé le module, ses champs et le mapping
//     cœur pour son tableau : elle appelle `mappingCellFor` avec ses propres
//     données (une seule source, un seul rafraîchissement) ;
//   - la modale « Modifier le champ » ouverte depuis n'importe quel tableau
//     (clic droit sur l'en-tête → Modifier le champ) ne connaît rien de tout
//     ça : elle monte `<FieldAirtableMapping>`, qui charge ce qu'il faut et
//     n'affiche RIEN si la table n'a pas de source Airtable.
//
// Sans ce second chemin, changer le champ Airtable d'une colonne obligeait à
// quitter la table pour la page de configuration des champs.

// Clés de vue dont la table SQL porte un autre nom, en plus des alias partagés
// de sqlTableForView : `serial_transitions` (vue agrégée des transitions) n'a
// pas de table propre mais configure bien serial_state_changes.
const FIELD_KEY_TO_SQL = {
  serial_transitions: 'serial_state_changes',
  // /champs/product_movements (URL mise en favori avant que la clé de champs ne
  // renvoie vers la table mère) : le module Airtable est celui de
  // `stock_movements`.
  product_movements: 'stock_movements',
}
export function sqlTableForFieldKey(t) {
  return FIELD_KEY_TO_SQL[t] || sqlTableForView(t)
}

// Registre des modules Airtable (deux listes serveur, quelques ko). Persisté
// comme le mapping-data : au retour sur une page de configuration des champs, il
// est connu dès le premier rendu — sans quoi la requête du mapping-data
// n'attendait que lui pour partir (deux allers-retours en série avant le moindre
// champ à l'écran).
const REGISTRY_KEY = 'connectors:airtable-module-registry'

function fetchRegistry() {
  return Promise.all([
    api.airtable.coreMapModules().catch(() => []),
    api.airtable.fieldModules().catch(() => []),
  ]).then(([core, all]) => {
    const reg = { core: core || [], all: all || [] }
    writeStale(REGISTRY_KEY, reg)
    return reg
  })
}

// Modules Airtable de la table courante — et d'elle SEULE. Un module qui
// alimente une autre table ERP (ex. `order_items` vu depuis /champs/orders)
// n'a rien à faire ici : il se règle depuis la page de SA table.
function modulesForTable(reg, table, sqlTable) {
  const { core, all } = reg
  // Les registres serveur parlent en VRAI nom de table SQL (erp_table)…
  // sauf le registre des mappings cœur, où quelques specs désignent la
  // table par sa clé de VUE (`serial_transitions`). On accepte les deux.
  const isOwn = m => m.erp_table === sqlTable || m.erp_table === table
  const mine = list => (list || []).filter(isOwn)
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
    // donc son mapping se fusionne ligne à ligne dans le tableau. Sinon il
    // s'affiche en panneau sous le tableau (CoreMapPane).
    merged.set(m.module, { module: m.module, title: m.label, coremap: true, inline: !!m.inline_columns, fields: fieldKeys.has(m.module) })
  }
  for (const m of linkMine) {
    if (!merged.has(m.module)) merged.set(m.module, { module: m.module, title: m.label, coremap: false, inline: false, fields: true })
  }
  return [...merged.values()]
}

export function useAirtableModules(table, sqlTable) {
  const staleReg = table ? readStale(REGISTRY_KEY) : null
  const [modules, setModules] = useState(() => (staleReg ? modulesForTable(staleReg, table, sqlTable) : []))
  // `loaded` dès le premier rendu quand le registre est déjà connu : la cellule
  // de mapping n'a pas à clignoter en attendant une liste qu'on a déjà.
  const [loaded, setLoaded] = useState(!!staleReg)
  useEffect(() => {
    if (!table) return
    let alive = true
    const known = readStale(REGISTRY_KEY)
    if (known) {
      setModules(modulesForTable(known, table, sqlTable))
      setLoaded(true)
    } else {
      setLoaded(false)
    }
    fetchRegistry().then(reg => {
      if (!alive) return
      setModules(modulesForTable(reg, table, sqlTable))
      setLoaded(true)
    })
    return () => { alive = false }
  }, [table, sqlTable])
  return { modules, loaded }
}

// Précharge tout ce dont la page de configuration des champs a besoin pour
// s'afficher : le registre des modules, puis le mapping-data du module de la
// table. Appelé au SURVOL du bouton « Configurer les champs » d'un tableau —
// la réponse est déjà là (cache de prefetch, TTL 30 s) quand la page monte.
export function prefetchFieldConfig(table) {
  const sqlTable = sqlTableForFieldKey(table)
  if (!table) return
  prefetch(() => api.airtable.directSource(table))
  const known = readStale(REGISTRY_KEY)
  const go = reg => {
    const own = modulesForTable(reg, table, sqlTable).find(m => m.fields)
    if (own) prefetch(() => api.airtable.moduleMappingData(own.module))
  }
  if (known) { go(known); return }
  prefetch(() => fetchRegistry().then(go))
}

// Table lue EN DIRECT dans Airtable (hors miroir) : pas de module, pas de
// mapping en base — mais un champ Airtable par colonne, fixé dans le code du
// lecteur. Sans ce registre, la colonne « Champ Airtable » manquait purement et
// simplement à ces tables. Il est servi par le serveur pour qu'il ne puisse pas
// dériver du lecteur. `null` = table normale.
export function useAirtableDirectSource(table) {
  const key = table ? `connectors:airtable-direct-source:${table}` : null
  const [source, setSource] = useState(() => (key ? readStale(key) : null))
  useEffect(() => {
    setSource(key ? readStale(key) : null)
    if (!table) return
    let alive = true
    api.airtable.directSource(table)
      .then(d => {
        if (!alive) return
        if (d?.fields) { setSource(d); writeStale(key, d) }
      })
      .catch(() => { /* table normale, ou route indisponible : rien à afficher */ })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [table])
  return source
}

// Cellule « Champ Airtable » en lecture seule : le nom du champ, cadenassé, avec
// la raison en infobulle.
export function FixedMappingCell({ field, reason, testId }) {
  return (
    <span
      data-testid={testId}
      data-fixed="1"
      title={reason}
      className="inline-flex items-center gap-1 min-w-0 text-xs text-slate-700 cursor-help"
    >
      <Lock size={11} className="text-slate-400 flex-shrink-0" />
      <span className="truncate">{field}</span>
    </span>
  )
}

// Props de mapping « cœur » d'une colonne — la cellule et son autosave, partagés
// par la ligne du tableau de /champs et par la fiche du champ.
export function buildCoreProps(coreModule, coreField, core) {
  if (!coreField || !coreModule) return null
  return {
    module: coreModule,
    field: coreField,
    value: core.draft[coreField.key] || '',
    options: core.options,
    suggestion: core.data?.suggested?.[coreField.key],
    direction: core.dirs[coreField.key] || coreField.direction,
    saving: core.saving,
    // Autosave, comme un mapping dynamique : plus de barre « Enregistrer le
    // mapping ». La resynchronisation se lance depuis « Synchroniser ».
    onPick: name => core.saveField(coreField.key, name),
    onUnmap: () => core.saveField(coreField.key, ''),
    onDirection: dir => core.changeDirection(coreField.key, dir),
    // « Rafraîchir » du bas du menu : relit les champs de la table Airtable.
    onRefresh: core.refreshFields,
  }
}

// Cellule « Champ Airtable » d'UNE colonne, ou `null` quand il n'y a rien à
// mapper : table sans source Airtable, colonne inconnue du module, ou champ
// calculé (sa valeur est produite par Boréal — sauf s'il est poussé vers
// Airtable, `push_only`, auquel cas le mapping se règle comme les autres).
export function mappingCellFor({
  showMapping, column, cfKind, coreProps, at, airtableFields, tableMap,
  ownModule, onSaveMapping, savingId,
  // Relit la liste des champs Airtable du module (« Rafraîchir » du dropdown).
  onRefreshFields,
  // Table lue en direct : nom du champ Airtable fixé en code pour cette colonne.
  fixedField, fixedReason,
}) {
  const computed = !at?.push_only && (isComputedKind(cfKind) || isComputedKind(at?.cf_kind))
  if (!showMapping || !column || computed) return null
  if (fixedField && !coreProps && !at) {
    return <FixedMappingCell field={fixedField} reason={fixedReason} testId={`fixedmap-${column}`} />
  }
  if (coreProps) {
    return (
      <AirtableFieldCell
        testId={`coremap-${coreProps.module}-${coreProps.field.key}`}
        mapped={coreProps.value || null}
        options={coreProps.options}
        suggestion={coreProps.suggestion}
        saving={coreProps.saving}
        canUnmap={!coreProps.field.required}
        unmapTitle={coreProps.field.required
          ? 'Champ requis par la synchronisation — il ne peut pas être démappé'
          : undefined}
        onPick={coreProps.onPick}
        onUnmap={coreProps.onUnmap}
        onRefresh={coreProps.onRefresh}
      />
    )
  }
  if (at && ownModule) {
    return (
      <MappingPicker
        erpColumn={at}
        airtableFields={airtableFields || []}
        tableMap={tableMap}
        onSave={onSaveMapping}
        savingId={savingId}
        onRefresh={onRefreshFields}
      />
    )
  }
  return null
}

// Bloc « Champ Airtable » autonome : charge lui-même le module de la table et
// affiche la cellule de mapping de la colonne — ou rien du tout. Destiné à la
// modale « Modifier le champ » ouverte depuis un tableau.
export function FieldAirtableMapping({ table, column, cfKind = null }) {
  const sqlTable = sqlTableForFieldKey(table)
  const { modules, loaded } = useAirtableModules(table, sqlTable)
  const ownModule = modules.find(m => m.fields) || null
  const {
    data: atData, savingId, saveMapping, refreshFields,
  } = useModuleFields(ownModule?.module || null)
  const inlineCoreModule = modules.find(m => m.coremap && m.inline) || null
  const core = useCoreMap(inlineCoreModule?.module || null, () => {})
  const directSource = useAirtableDirectSource(table)

  const at = useMemo(
    () => (atData?.erp_columns || []).find(c => c.column_name === column) || null,
    [atData, column]
  )
  const coreField = useMemo(
    () => (core.data?.fields || []).find(f => f.column === column) || null,
    [core.data, column]
  )

  if (!column || !loaded) return null
  // Métadonnées Airtable en route (quelques secondes sur une grosse table) :
  // on le dit plutôt que de laisser le bloc apparaître d'un coup. Tant que la
  // liste des modules n'est pas revenue on n'affiche rien : la plupart des
  // tables n'ont pas de source Airtable, elles n'ont pas à clignoter.
  const pending = (ownModule && !atData)
    || (inlineCoreModule && !core.data && !core.loadError)
  if (pending) {
    return (
      <MappingBlock>
        <p className="text-xs text-slate-500">Chargement des champs Airtable…</p>
      </MappingBlock>
    )
  }

  const fixedField = directSource?.fields?.[column] || null
  const cell = mappingCellFor({
    showMapping: !!(ownModule || inlineCoreModule || fixedField),
    column,
    cfKind,
    coreProps: buildCoreProps(inlineCoreModule?.module || null, coreField, core),
    at,
    airtableFields: atData?.airtable_fields || [],
    tableMap: atData?.airtable_table_to_erp,
    ownModule,
    onSaveMapping: saveMapping,
    savingId,
    onRefreshFields: refreshFields,
    fixedField,
    fixedReason: directSource?.reason,
  })
  if (!cell) return null
  return <MappingBlock>{cell}</MappingBlock>
}

export default FieldAirtableMapping
