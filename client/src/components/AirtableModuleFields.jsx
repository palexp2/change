import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Link } from 'react-router-dom'
import { RefreshCw, Trash2, Plus, Sparkles, AlertCircle } from 'lucide-react'
import api from '../lib/api.js'
import { AirtableTypeIcon, airtableTypeLabel } from '../lib/airtableFieldIcons.jsx'
import { invalidate } from '../lib/prefetch.js'
import { useSyncStatus } from '../lib/useSyncStatus.js'
import { useConfirm } from './ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { SearchableSelect } from './SearchableSelect.jsx'
import { CustomFieldModal } from './CustomFieldModal.jsx'
import { DIRECTIONS } from './AirtableCoreMapModal.jsx'
import Spinner from './Spinner.jsx'

// Contrôle des champs Airtable d'un module : pour chaque colonne ERP, son nom
// d'affichage, son type et le champ Airtable qui l'alimente (ou rien = pas
// d'import). Extrait de l'ancienne page /airtable/fields/:module pour être
// intégré dans les onglets Airtable de la page de configuration des champs
// (pages/FieldConfig.jsx), à côté du mapping des champs « cœur ».
//
// `module` : clé du registre AIRTABLE_FIELD_MODULES côté serveur.

// Compat type Airtable (côté ERP) ↔ type colonne ERP. Aligné sur TYPE_COMPAT
// dans server/src/routes/connectors.js.
const TYPE_COMPAT = {
  text:          new Set(['text', 'long_text']),
  long_text:     new Set(['text', 'long_text']),
  number:        new Set(['number']),
  date:          new Set(['date']),
  single_select: new Set(['single_select']),
  multi_select:  new Set(['multi_select']),
  checkbox:      new Set(['checkbox']),
  // Un champ « enregistrement lié » Airtable atterrit dans une colonne TEXTE
  // (elle garde les record IDs, rendus en pastilles cliquables) — c'est l'état
  // des ~80 champs lien déjà importés. 'link' reste pour les colonnes déclarées
  // Lien côté ERP (« Entreprise » / « Vendeur » d'un projet).
  link:          new Set(['link', 'text', 'long_text']),
  attachment:    new Set(['attachment', 'text', 'long_text']),
}
// Le champ Airtable de type `at` peut-il alimenter une colonne ERP de type `erp` ?
// Même relation que `typesCompatible` côté serveur — et dans le même SENS : la
// lire à l'envers excluait de la liste les champs lien et pièce jointe, seuls
// types dont la colonne d'accueil n'a pas le même nom de type qu'eux.
function typesCompatible(at, erp) {
  return TYPE_COMPAT[at]?.has(erp) || false
}
// Types de champs Airtable calculés côté Airtable : l'API refuse toute écriture
// dessus (422). Ils sortent donc de la liste quand la colonne ERP ne peut être
// que POUSSÉE (champ calculé de Boréal). Aligné sur AIRTABLE_READONLY_TYPES
// dans server/src/routes/connectors.js.
const AIRTABLE_READONLY_TYPES = new Set([
  'formula', 'rollup', 'count', 'autoNumber', 'lookup', 'multipleLookupValues',
  'createdTime', 'lastModifiedTime', 'createdBy', 'lastModifiedBy',
  'button', 'externalSyncSource', 'aiText',
])
export const TYPE_OPTIONS = [
  { value: 'text', label: 'Texte' },
  { value: 'long_text', label: 'Texte long' },
  { value: 'number', label: 'Nombre' },
  { value: 'date', label: 'Date' },
  { value: 'single_select', label: 'Choix unique' },
  { value: 'multi_select', label: 'Choix multiple' },
  { value: 'checkbox', label: 'Case' },
  { value: 'link', label: 'Lien' },
]
// Cellule "Nom" inline-editable. Click → input ; Enter / blur → save.
export function NameCell({ value, onSave, disabled }) {
  const [editing, setEditing] = useState(false)
  const [local, setLocal] = useState(value || '')
  useEffect(() => { setLocal(value || '') }, [value])

  async function commit() {
    setEditing(false)
    const trimmed = local.trim()
    if (trimmed === (value || '').trim()) return
    // empty → réinit display_label (fallback sur airtable_field_name côté serveur)
    // false → refusé (nom déjà pris) : on revient au libellé courant.
    const ok = await onSave(trimmed || null)
    if (ok === false) setLocal(value || '')
  }

  if (editing) {
    return (
      <input
        autoFocus
        value={local}
        onChange={e => setLocal(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); commit() }
          if (e.key === 'Escape') { setLocal(value || ''); setEditing(false) }
        }}
        className="input text-sm w-full"
      />
    )
  }
  return (
    <button
      onClick={() => !disabled && setEditing(true)}
      disabled={disabled}
      className="text-left text-sm text-slate-800 hover:text-brand-700 hover:bg-brand-50/40 px-1.5 py-0.5 -mx-1.5 rounded w-full truncate disabled:cursor-not-allowed"
      title={disabled ? 'Lecture seule' : 'Cliquer pour renommer'}
    >
      {value || <span className="text-slate-600 italic">— sans nom —</span>}
    </button>
  )
}

// Une entrée de la liste des champs Airtable : icône du type + nom. L'icône
// remplace l'ancien « (multipleRecordLinks) » collé derrière le nom — le type se
// reconnaît d'un coup d'œil et le nom récupère la largeur de la cellule. Le type
// exact reste lisible au survol de l'icône. Un champ disparu d'Airtable n'a pas
// de type : il garde sa mention rouge, c'est une anomalie à corriger.
function AirtableFieldOption({ option: o }) {
  return (
    <span className="flex items-center gap-1.5 min-w-0">
      {o.missing ? (
        <AlertCircle size={12} className="flex-shrink-0 text-red-500" />
      ) : (
        <span className="flex-shrink-0 flex" title={airtableTypeLabel(o.type) || undefined}>
          <AirtableTypeIcon type={o.type} />
        </span>
      )}
      <span className="truncate">{o.name}</span>
      {o.missing && (
        <span className="flex-shrink-0 text-[10px] text-red-600">introuvable</span>
      )}
      {/* Un champ Airtable peut alimenter plusieurs colonnes Boréal : on ne le
          retire plus de la liste, on dit qui le lit déjà. */}
      {!o.missing && o.also?.length > 0 && (
        <span className="flex-shrink-0 text-[10px] text-slate-500" title={`Alimente déjà : ${o.also.join(', ')}`}>
          → {o.also.join(', ')}
        </span>
      )}
    </span>
  )
}

// Cellule « Champ Airtable » — LE rendu unique de la colonne de mapping du
// tableau des champs (/champs/:table), quel que soit le système qui alimente la
// colonne derrière : mapping dynamique (airtable_field_mappings) ou clé du
// field_map « cœur » du module. L'utilisateur ne doit voir aucune différence
// entre les deux : même liste déroulante recherchable, et le choix s'enregistre
// tout de suite dans les deux cas.
//
// Il n'y a PAS d'étape « Mapper » : la liste est toujours là, avec une position
// vide en tête (« — Non mappé — ») pour couper l'import. Un mapping se pose, se
// change et se retire par le même geste — comme n'importe quel autre champ de
// la page. Même forme que CoreFieldPicker (AirtableCoreMapModal).
//
// Le composant ne sait RIEN de cette distinction — tout arrive en props :
//   options       [{ name, type?, missing? }] champs Airtable proposables
//   mappedIssue   pourquoi le champ mappé n'est pas dans `options`
//                 { level: 'error' | 'info', note, typeLabel? } — la cellule
//                 n'a pas à savoir ce qui rend un champ incompatible
//   mapped        nom du champ Airtable actuellement mappé (null = aucun)
//   onPick        (name, target?) => Promise — enregistre (peut lever)
//   onUnmap       () => Promise — coupe le mapping
//   canUnmap      false pour un champ requis (pas de position vide, mention
//                 « requis » et infobulle honnête)
//   suggestion    nom détecté automatiquement, proposé en un clic
//   requireTarget la colonne ERP est un lien : une table cible est demandée
//                 avant l'enregistrement (defaultTargetFor la pré-remplit)
export function AirtableFieldCell({
  mapped, targetTable, options, suggestion, saving, mappedIssue,
  requireTarget, targetOptions, defaultTargetFor, canUnmap = true, unmapTitle,
  onPick, onUnmap, testId,
}) {
  const [pending, setPending] = useState(null)        // nom choisi, en attente de la table cible
  const [target, setTarget] = useState(targetTable || '')
  const [err, setErr] = useState(null)

  useEffect(() => { setTarget(targetTable || '') }, [targetTable])

  // Le champ mappé reste toujours visible dans la liste, même s'il n'est pas
  // dans les candidats — sinon la cellule se serait affichée « non mappée »
  // alors qu'elle l'est. Deux raisons très différentes de ne pas y être, et
  // c'est l'appelant qui tranche (`mappedIssue`) : le champ a disparu d'Airtable
  // (`error` — l'import est cassé) ou son type ne figure pas dans les types
  // compatibles alors qu'il existe et s'importe très bien (`info`). Marquer le
  // second « introuvable dans Airtable » était faux.
  const opts = useMemo(() => {
    const list = options || []
    if (mapped && !list.some(o => o.name === mapped)) {
      return [...list, {
        name: mapped,
        type: mappedIssue?.typeLabel || null,
        missing: mappedIssue?.level !== 'info',
      }]
    }
    return list
  }, [options, mapped, mappedIssue])

  const noCandidates = !opts.length

  async function commit(name, tgt) {
    setErr(null)
    try {
      await onPick(name, tgt || null)
      setPending(null)
    } catch (e) {
      setErr(e.message || 'Erreur')
    }
  }

  async function unmap() {
    setErr(null)
    setPending(null)
    try { await onUnmap() } catch (e) { setErr(e.message || 'Erreur') }
  }

  function pick(name) {
    // Position vide = « ne pas mapper » : on coupe le mapping tout de suite.
    if (!name) {
      if (mapped) unmap()
      else { setPending(null); setErr(null) }
      return
    }
    if (requireTarget) {
      setPending(name)
      setTarget(defaultTargetFor?.(name) || targetTable || '')
      return
    }
    if (name === mapped) return
    commit(name)
  }

  return (
    <div className="text-xs space-y-1">
      <div className="flex items-center gap-1">
        <div className="min-w-0 flex-1">
          <SearchableSelect
            testId={testId}
            // Même gabarit que le <select> de la colonne « Type » de la même
            // ligne : la liste vit dans un tableau compact, pas dans un
            // formulaire (.input serait deux fois trop haut). Teinte de marque
            // quand c'est mappé — l'œil retrouve les champs importés d'un coup.
            className={`w-full rounded border px-2 py-1 text-xs focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-400 ${
              mapped
                ? 'border-brand-200 bg-brand-50/60 font-medium'
                : 'border-slate-200 bg-white hover:border-slate-300'
            }`}
            value={pending ?? (mapped || '')}
            options={opts}
            getOptionValue={o => o.name}
            // Le type ne s'écrit plus entre parenthèses : il se lit à l'icône
            // (voir lib/airtableFieldIcons.jsx). Le libellé texte reste le nom
            // seul — c'est lui qui sert d'infobulle ; la recherche, elle, passe
            // par `filterOption` pour continuer d'accepter le type.
            getOptionLabel={o => o.missing
              ? `${o.name} (introuvable dans Airtable)`
              : o.name}
            renderOption={o => <AirtableFieldOption option={o} />}
            renderValue={o => <AirtableFieldOption option={o} />}
            filterOption={(o, q) =>
              o.name.toLowerCase().includes(q)
              || airtableTypeLabel(o.type).toLowerCase().includes(q)}
            getOptionKey={o => o.name}
            onChange={pick}
            emptyOption={canUnmap ? '— Non mappé —' : undefined}
            placeholder={noCandidates ? 'Aucun champ compatible' : '— Non mappé —'}
            searchPlaceholder="Rechercher un champ…"
            disabled={saving || noCandidates}
          />
        </div>
        {!canUnmap && unmapTitle && (
          <span className="text-[10px] text-slate-400 cursor-help flex-shrink-0" title={unmapTitle}>requis</span>
        )}
      </div>
      {/* Colonne lien : la table ERP cible est demandée avant l'enregistrement. */}
      {requireTarget && pending !== null && (
        <div className="space-y-1.5 bg-slate-50 p-2 rounded border border-slate-200">
          <SearchableSelect
            testId={testId ? `${testId}-target` : 'mapping-target-table'}
            value={target}
            options={targetOptions || []}
            getOptionValue={t => t}
            getOptionLabel={t => t}
            getOptionKey={t => t}
            onChange={setTarget}
            emptyOption="— Table ERP cible —"
            searchPlaceholder="Rechercher une table…"
            disabled={saving}
          />
          <div className="flex justify-end gap-1">
            <button
              onClick={() => { setPending(null); setTarget(targetTable || ''); setErr(null) }}
              className="text-[11px] px-2 py-0.5 text-slate-600 hover:bg-slate-200 rounded"
            >
              Annuler
            </button>
            <button
              onClick={() => commit(pending, target)}
              disabled={saving || !pending}
              className="text-[11px] px-2 py-0.5 bg-brand-600 text-white rounded hover:bg-brand-700 disabled:opacity-50"
            >
              {saving ? '…' : 'OK'}
            </button>
          </div>
        </div>
      )}
      {mapped && mappedIssue?.note && (
        <div className={`text-[11px] ${mappedIssue.level === 'error' ? 'text-red-600' : 'text-amber-600'}`}>
          {mappedIssue.note}
          {mappedIssue.action && (
            <button
              type="button"
              onClick={() => commit(mapped, targetTable)}
              disabled={saving}
              className="ml-1 underline hover:no-underline disabled:opacity-50"
            >
              {mappedIssue.action}
            </button>
          )}
        </div>
      )}
      {!mapped && suggestion && (
        <button
          type="button"
          onClick={() => commit(suggestion)}
          disabled={saving}
          className="max-w-full text-[11px] text-brand-600 hover:text-brand-800 inline-flex items-center gap-1 disabled:opacity-50"
          title={`Champ Airtable détecté automatiquement par nom : ${suggestion}`}
        >
          <Sparkles size={11} className="flex-shrink-0" />
          <span className="truncate">Suggestion : {suggestion}</span>
        </button>
      )}
      {err && <div className="text-[11px] text-red-600">{err}</div>}
    </div>
  )
}

// Mapping dynamique (airtable_field_mappings) d'une colonne ERP : prépare les
// options et l'enregistrement, le rendu est celui d'AirtableFieldCell — commun
// aux champs « cœur ».
export function MappingPicker({ erpColumn, airtableFields, tableMap, onSave, savingId }) {
  const isLink = erpColumn.field_type === 'link'

  // Champs Airtable candidats : ceux dont le type est compatible avec la
  // colonne. Un champ DÉJÀ mappé reste candidat — il peut alimenter plusieurs
  // colonnes Boréal ; la liste dit seulement lesquelles il nourrit déjà.
  const candidates = useMemo(() => {
    return airtableFields.filter(f =>
      typesCompatible(f.erp_field_type, erpColumn.field_type)
      // Colonne poussée seulement (champ calculé de Boréal) : la cible doit être
      // un champ Airtable écrivable, sinon le PATCH échouerait à chaque envoi.
      && !(erpColumn.push_only && AIRTABLE_READONLY_TYPES.has(f.airtable_field_type))
    )
  }, [airtableFields, erpColumn])

  const options = useMemo(
    () => candidates.map(c => ({
      name: c.airtable_field_name,
      type: c.airtable_field_type,
      // Ce que ce champ alimente déjà : la synchronisation de base du module
      // (clé du field_map) et/ou d'autres colonnes ERP.
      also: [
        ...(c.core_key ? ['sync de base'] : []),
        ...(c.current_mappings || [])
          .filter(m => m.column_name !== erpColumn.column_name)
          .map(m => m.column_name),
      ],
    })),
    [candidates, erpColumn.column_name]
  )

  const linkTargets = useMemo(() => {
    const set = new Set(Object.values(tableMap || {}))
    set.add('companies'); set.add('contacts'); set.add('users')
    return [...set].sort()
  }, [tableMap])

  // Le champ mappé ne figure pas dans les candidats : deux cas très différents.
  // S'il a réellement disparu de la table Airtable, l'import est cassé et il
  // faut le dire. S'il est simplement d'un type que TYPE_COMPAT ne connaît pas
  // (type Airtable exotique déjà importé), tout fonctionne : rien à signaler. On
  // ne remonte alors que son vrai type Airtable, pour que la liste ne
  // l'étiquette pas « introuvable ».
  const mappedIssue = useMemo(() => {
    const name = erpColumn.mapped_airtable_field
    if (!name) return null
    // Partage dormant : le champ existe et alimente déjà la sync de base du
    // module, mais ce second mapping n'a jamais été revendiqué — le sync ne le
    // sert donc pas. Un clic l'active (ré-enregistre la def avec le partage).
    if (erpColumn.core_dormant) {
      return { level: 'warn', note: 'Déjà lu par la sync de base — import inactif.', action: 'Activer' }
    }
    if (candidates.some(c => c.airtable_field_name === name)) return null
    const f = (airtableFields || []).find(x => x.airtable_field_name === name)
    if (!f) {
      return { level: 'error', note: 'Champ absent de la table Airtable — le sync ne remplira rien.' }
    }
    return { level: 'info', typeLabel: f.airtable_field_type }
  }, [erpColumn, candidates, airtableFields])

  return (
    <AirtableFieldCell
      testId="mapping-airtable-field"
      mapped={erpColumn.mapped_airtable_field || null}
      targetTable={erpColumn.target_table || null}
      options={options}
      mappedIssue={mappedIssue}
      saving={savingId === erpColumn.column_name}
      requireTarget={isLink}
      targetOptions={linkTargets}
      defaultTargetFor={name => {
        const f = candidates.find(c => c.airtable_field_name === name)
        return f && tableMap?.[f.linked_table_id]
      }}
      onPick={async (name, target) => {
        // Réactivation d'un mapping déjà posé : le champ peut ne plus figurer
        // parmi les candidats (son type est devenu incompatible avec celui de la
        // colonne). On laisse alors le serveur trancher — son refus dit ce qui
        // cloche, là où « champ introuvable » serait un cul-de-sac.
        const f = candidates.find(c => c.airtable_field_name === name)
          || (airtableFields || []).find(c => c.airtable_field_name === name)
        if (!f) throw new Error('Champ introuvable')
        if (isLink && !target) throw new Error('Choisis une table cible')
        await onSave({
          airtable_field_id: f.airtable_field_id,
          airtable_field_name: f.airtable_field_name,
          airtable_field_type: f.airtable_field_type,
          column_name: erpColumn.column_name,
          link_target_table: isLink ? target : null,
          // Table Airtable visée par un champ lien : le serveur la garde en
          // indice d'affichage (de quelle table sont les record IDs stockés).
          linked_table_id: f.linked_table_id || null,
        })
      }}
      onUnmap={async () => {
        if (!erpColumn.mapped_airtable_field) return
        await onSave({
          airtable_field_id: erpColumn.airtable_field_id,
          airtable_field_name: erpColumn.mapped_airtable_field,
          airtable_field_type: 'singleLineText', // peu importe pour unmap
          // Le démappage vise LA COLONNE : le même champ Airtable peut en
          // alimenter d'autres, qui ne doivent pas sauter avec.
          column_name: erpColumn.column_name,
          unmap: true,
        })
      }}
    />
  )
}

// Bandeau de statut source, pour tous les modules — projets inclus. La config
// base/table vit dans Connecteurs → Airtable ; ici on se contente d'afficher
// l'état + un bouton de sync, et un lien vers la config si non configurée.
export function ModuleSourceStatus({ data, onSynced }) {
  const { status: syncStatus } = useSyncStatus(3000)
  const syncing = !!(data?.sync_key && syncStatus?.[data.sync_key]?.running)
  const [error, setError] = useState(null)

  const wasSyncing = useRef(false)
  useEffect(() => {
    if (syncing) { wasSyncing.current = true; return }
    if (wasSyncing.current) { wasSyncing.current = false; onSynced?.() }
  }, [syncing, onSynced])

  async function handleSync() {
    if (!data?.sync_key || !data.configured) return
    setError(null)
    try { await api.airtable.sync(data.sync_key) } catch (e) { setError(e.message || 'Erreur sync') }
  }

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4 mb-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">Source Airtable</h2>
          <div className="text-xs text-slate-600 flex items-center gap-2 mt-0.5">
            {data?.configured ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                <span>Configurée</span>
              </>
            ) : (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                <span className="text-amber-600">
                  Non configurée — <Link to="/connectors" className="underline hover:text-amber-700">choisir la base/table dans Connecteurs</Link>
                </span>
              </>
            )}
            {syncing && <span className="text-amber-600 font-medium animate-pulse">Synchronisation en cours…</span>}
          </div>
        </div>
        <button onClick={handleSync} disabled={syncing || !data?.configured} className="btn-primary btn-sm flex items-center gap-1.5">
          <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />
          {syncing ? 'Synchronisation…' : 'Synchroniser'}
        </button>
      </div>
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
    </div>
  )
}

// Chargement du mapping-data d'un module + écritures associées. Partagé entre
// ce composant (onglets des modules « enfants ») et la page de configuration
// des champs, qui fusionne ces colonnes dans son tableau unique.
export function useModuleFields(module) {
  const [data, setData] = useState(null)
  const [savingId, setSavingId] = useState(null)
  const { addToast } = useToast()

  const erpTable = data?.erp_table || (module === 'projets' ? 'projects' : null)

  const reload = useCallback(() => {
    if (!module) { setData(null); return Promise.resolve() }
    // Le cache prefetch (TTL 30 s) est indexé par préfixe de ressource : une
    // mutation sur /custom-fields ne le purge pas pour /connectors. Sans cette
    // invalidation, un reload déclenché juste après la suppression d'un champ
    // resservait la réponse d'avant — la colonne supprimée réapparaissait.
    invalidate('/connectors')
    return api.airtable.moduleMappingData(module)
      .then(d => setData(d))
      .catch(e => addToast({ message: e.message || 'Erreur chargement', type: 'error' }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [module])

  useEffect(() => { setData(null); reload() }, [reload])

  // Notifie les DataTable ouverts pour rafraîchir le rendu (labels/types).
  const notify = useCallback((tbl) => {
    if (tbl) window.dispatchEvent(new CustomEvent('views:updated', { detail: { table: tbl } }))
  }, [])

  // Rendu/type d'une colonne = un champ custom_fields. Rename : PUT sur le champ
  // existant. Première adoption d'une colonne orpheline (pas de cf_id) : adopt.
  const applyChange = useCallback(async (col, payload) => {
    setSavingId(col.column_name)
    try {
      if (col.cf_id) {
        await api.customFields.update(col.cf_id, payload)
      } else if (erpTable && payload.type) {
        await api.customFields.adopt(erpTable, { column_name: col.column_name, name: col.label || col.column_name, type: payload.type })
      }
      await reload()
      notify(erpTable)
      return true
    } catch (e) {
      addToast({ message: e.message || 'Erreur', type: 'error' })
      return false
    } finally {
      setSavingId(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [erpTable, reload, notify])

  const saveMapping = useCallback(async (payload) => {
    setSavingId(payload.column_name || '__unmap__')
    try {
      await api.airtable.setModuleFieldMapping(module, payload)
      await reload()
      notify(erpTable)
    } finally {
      setSavingId(null)
    }
  }, [module, erpTable, reload, notify])

  return { data, reload, savingId, setSavingId, applyChange, saveMapping, erpTable, notify }
}

export function AirtableModuleFields({ module: moduleProp }) {
  const module = moduleProp || 'projets'
  const [filter, setFilter] = useState('')
  const [showNewField, setShowNewField] = useState(false)
  const confirm = useConfirm()
  const { addToast } = useToast()
  const { data, reload, savingId, setSavingId, applyChange, saveMapping, erpTable, notify } = useModuleFields(module)

  async function handleRename(col, newLabel) {
    if (newLabel === (col.display_label || '')) return
    // Unicité du nom dans la table (le serveur refuse aussi en 409).
    const taken = cols.find(c => c.column_name !== col.column_name
      && (c.label || '').trim().toLowerCase() === newLabel.trim().toLowerCase())
    if (taken) {
      addToast({ message: `« ${taken.label} » est déjà le nom d'un autre champ de cette table`, type: 'error' })
      return false
    }
    await applyChange(col, { name: newLabel })
  }

  async function handleTypeChange(col, newType) {
    if (newType === col.field_type) return
    // Le type est immuable une fois le champ posé (comportement custom_fields
    // standard, cf. CustomFieldModal) — seule la première adoption d'une
    // colonne orpheline (pas encore de cf_id) peut choisir son type ici.
    if (col.cf_id) {
      addToast({ message: 'Le type ne peut plus être changé — modifiez-le depuis la fiche du champ (clic-droit sur la colonne dans le tableau)', type: 'error' })
      return
    }
    await applyChange(col, { type: newType })
  }

  async function handleDelete(col) {
    if (!col.cf_id) {
      addToast({ message: 'Cette colonne n\'a pas de champ configuré — impossible à supprimer ici', type: 'error' })
      return
    }
    const ok = await confirm(`Retirer le champ « ${col.label} » ? La colonne et ses données sont conservées (retirable de la corbeille des champs) — seul l'affichage disparaît des tableaux.`)
    if (!ok) return
    setSavingId(col.column_name)
    try {
      await api.customFields.delete(col.cf_id)
      addToast({ message: 'Champ retiré', type: 'success' })
      await reload()
      notify(erpTable)
    } catch (e) {
      addToast({ message: e.message || 'Erreur', type: 'error' })
    } finally {
      setSavingId(null)
    }
  }

  const cols = useMemo(() => data?.erp_columns || [], [data])
  const filteredCols = useMemo(() => {
    if (!filter) return cols
    const q = filter.toLowerCase()
    return cols.filter(c =>
      c.column_name.toLowerCase().includes(q)
      || (c.label || '').toLowerCase().includes(q)
      || (c.mapped_airtable_field || '').toLowerCase().includes(q)
    )
  }, [cols, filter])

  return (
    <>
      <div className="space-y-4">
        <p className="text-sm text-slate-600">
          {cols.length} champ{cols.length !== 1 ? 's' : ''}
        </p>

        <ModuleSourceStatus data={data} onSynced={reload} />

        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
            <input
              type="text"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              className="input text-sm w-64"
            />
            <div className="flex items-center gap-3">
              <div className="text-xs text-slate-600">
                Clique sur un nom pour le renommer · Le type s'autosauve · Pas de mapping = pas d'import · Sens ← : import Airtable → ERP seulement
              </div>
              {erpTable && (
                <button
                  onClick={() => setShowNewField(true)}
                  className="btn-secondary btn-sm py-1 flex items-center gap-1"
                  title="Créer une nouvelle colonne ERP, mappable ensuite vers un champ Airtable"
                >
                  <Plus size={12} /> Ajouter un champ
                </button>
              )}
            </div>
          </div>
          {data === null ? (
            <p className="text-sm text-slate-600 px-4 py-8 text-center"><Spinner size="xs" label="Chargement…" /></p>
          ) : filteredCols.length === 0 ? (
            <p className="text-sm text-slate-600 px-4 py-8 text-center">Aucun champ</p>
          ) : (
            <table className="w-full text-sm table-fixed">
              <thead className="bg-slate-50 text-xs font-semibold text-slate-600 uppercase tracking-wide">
                <tr>
                  <th className="text-left px-4 py-2 w-[28%]">Nom</th>
                  <th className="text-left px-4 py-2 w-[22%]">Colonne</th>
                  <th className="text-left px-4 py-2 w-[16%]">Type</th>
                  <th className="px-2 py-2 w-[5%] text-center" title="Sens de synchronisation">Sens</th>
                  <th className="text-left px-4 py-2 w-[25%]">Champ Airtable</th>
                  <th className="px-2 py-2 w-[4%]"></th>
                </tr>
              </thead>
              <tbody>
                {filteredCols.map(col => (
                  <tr key={col.column_name} className="border-t border-slate-200 hover:bg-slate-50/50">
                    <td className="px-4 py-2 align-top">
                      <NameCell
                        value={col.label}
                        onSave={(newLabel) => handleRename(col, newLabel)}
                        disabled={savingId === col.column_name}
                      />
                    </td>
                    <td className="px-4 py-2 align-top overflow-hidden">
                      <code className="text-xs text-slate-600 truncate block" title={col.column_name}>{col.column_name}</code>
                    </td>
                    <td className="px-4 py-2 align-top">
                      <select
                        value={col.field_type}
                        onChange={e => handleTypeChange(col, e.target.value)}
                        disabled={savingId === col.column_name || !!col.cf_id}
                        title={col.cf_id ? 'Type figé après la première configuration — clic-droit sur la colonne dans le tableau pour ses réglages de rendu' : undefined}
                        className="block w-full min-w-[120px] rounded border border-slate-200 bg-white px-2 py-1 text-xs text-slate-800 cursor-pointer hover:border-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-500/30 focus:border-brand-400 disabled:opacity-50"
                      >
                        {TYPE_OPTIONS.map(t => (
                          <option key={t.value} value={t.value}>{t.label}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-2 py-2 align-top text-center">
                      {(() => {
                        // Ces champs dynamiques ne sont jamais réécrits vers Airtable :
                        // le write-back ne couvre que les clés du field_map « cœur »
                        // (cf. WRITEBACK_MODULES, services/airtableWriteback.js). Le sens
                        // est donc toujours unidirectionnel Airtable → ERP, en lecture seule.
                        const dir = DIRECTIONS.pull
                        const Icon = dir.Icon
                        return (
                          <span
                            title={col.mapped ? dir.title : 'Aucun mapping — ce champ n’est pas importé'}
                            data-testid={`modulefields-${module}-${col.column_name}-direction`}
                            data-direction={col.mapped ? 'pull' : 'none'}
                            className={`inline-flex cursor-help ${col.mapped ? 'text-slate-600' : 'text-slate-400'}`}
                          >
                            <Icon size={13} />
                          </span>
                        )
                      })()}
                    </td>
                    <td className="px-4 py-2 align-top">
                      <MappingPicker
                        erpColumn={col}
                        airtableFields={data.airtable_fields}
                        tableMap={data.airtable_table_to_erp}
                        onSave={saveMapping}
                        savingId={savingId}
                      />
                    </td>
                    <td className="px-2 py-2 align-top">
                      <button
                        onClick={() => handleDelete(col)}
                        disabled={savingId === col.column_name || !col.cf_id}
                        className="p-1 text-slate-600 hover:text-red-600 hover:bg-red-50 rounded disabled:opacity-30 disabled:cursor-not-allowed"
                        title={!col.cf_id ? 'Aucun champ configuré — rien à retirer' : 'Retirer le champ'}
                      >
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {data && data.hardcoded.length > 0 && (
          <div className="mt-4 text-xs text-slate-600">
            <p className="font-medium mb-1">{data.hardcoded.length} champ{data.hardcoded.length !== 1 ? 's' : ''} déjà lu{data.hardcoded.length !== 1 ? 's' : ''} par la synchronisation de base (mappables en plus) :</p>
            <p className="text-slate-600">{data.hardcoded.join(', ')}</p>
          </div>
        )}
      </div>

      {erpTable && (
        <CustomFieldModal
          isOpen={showNewField}
          onClose={() => setShowNewField(false)}
          erpTable={erpTable}
          onSaved={async () => {
            setShowNewField(false)
            await reload()
            notify(erpTable)
          }}
        />
      )}
    </>
  )
}

export default AirtableModuleFields
