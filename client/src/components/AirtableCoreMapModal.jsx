import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import { RefreshCw, AlertCircle, CheckCircle2, Sparkles, ArrowLeft, ArrowRight, ArrowLeftRight } from 'lucide-react'
import api from '../lib/api.js'
import { invalidate } from '../lib/prefetch.js'
import { useRealtimeChannel } from '../lib/useRealtimeChannel.js'
import { readStale, writeStale, pruneStale } from '../lib/swr.js'
import { RefreshFieldsButton, refreshAirtableSchema, useRefreshFields } from './AirtableRefreshFields.jsx'
import { Modal } from './Modal.jsx'
import { SearchableSelect } from './SearchableSelect.jsx'
import { SyncDetails } from './SyncDetails.jsx'
import { MODULE_TO_TABLE } from '../lib/syncSources.js'
import Spinner from './Spinner.jsx'

// Modale de mapping des champs « cœur » d'un ou plusieurs modules Airtable
// (field_map de airtable_module_config). Chaque ligne = champ ERP fixe →
// champ Airtable choisi parmi les colonnes réelles de la table configurée
// (routes /connectors/airtable/module-fields/:module/core-map).
//
// `modules` : [{ module: 'serial_changes', title: "Changements d'état" }, …]
// — un onglet par module quand il y en a plusieurs.
export function AirtableCoreMapModal({ isOpen, onClose, modules, title = 'Correspondance des champs Airtable', onSaved }) {
  const [tab, setTab] = useState(modules[0]?.module)

  // Ré-ouvre toujours sur le premier onglet
  useEffect(() => { if (isOpen) setTab(modules[0]?.module) }, [isOpen]) // eslint-disable-line react-hooks/exhaustive-deps

  // Préchauffe les caches (prefetch client + cache meta Airtable côté serveur)
  // dès le montage de la page hôte : la première ouverture de la modale
  // n'attend plus l'API meta d'Airtable (souvent plusieurs secondes).
  useEffect(() => {
    modules.forEach(m => { api.airtable.moduleCoreMap(m.module).catch(() => {}) })
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size="lg">
      {modules.length > 1 && (
        <div className="flex gap-0.5 border-b border-slate-200 mb-4">
          {modules.map(m => (
            <button
              key={m.module}
              onClick={() => setTab(m.module)}
              data-testid={`coremap-tab-${m.module}`}
              className={`px-3 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${tab === m.module ? 'border-brand-600 text-brand-600' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
            >
              {m.title}
            </button>
          ))}
        </div>
      )}
      {modules.map(m => (
        // Les panneaux restent montés pour conserver les brouillons en changeant d'onglet
        <div key={m.module} className={tab === m.module ? '' : 'hidden'}>
          {isOpen && <CoreMapPane module={m.module} onSaved={onSaved} />}
        </div>
      ))}
    </Modal>
  )
}

// Sens du mapping (à la Airtable) entre la colonne ERP (gauche) et la colonne
// Airtable (droite). `direction` vient du serveur (fieldMapDirection) :
// 'both' = import + write-back, 'pull' = Airtable → ERP, 'push' = ERP → Airtable.
export const DIRECTIONS = {
  both: { Icon: ArrowLeftRight, title: 'Bidirectionnel — importé depuis Airtable et réécrit vers Airtable à la modification dans l’ERP' },
  pull: { Icon: ArrowLeft, title: 'Airtable → ERP — import seulement, jamais réécrit vers Airtable' },
  push: { Icon: ArrowRight, title: 'ERP → Airtable — export seulement' },
}
// Infobulle honnête d'un sens verrouillé en 'pull' : dit POURQUOI le sens n'est
// pas modifiable, selon la raison servie par le serveur (direction_reason des
// réponses core-map et mapping-data). Null si aucune raison spécifique →
// l'appelant retombe sur le titre générique DIRECTIONS.pull.title.
export function directionLockTitle(reason, moduleLabel) {
  if (reason === 'module_no_writeback') {
    return `Import seulement — ce module${moduleLabel ? ` (${moduleLabel})` : ''} ne supporte pas encore la réécriture vers Airtable`
  }
  if (reason === 'link_field') return 'Les champs lien ne sont pas réécrits vers Airtable'
  // Formule (ou rollup, lookup, autoNumber…) côté Airtable : Airtable rejette
  // tout PATCH dessus, donc ni « Bidirectionnel » ni « Boréal → Airtable ».
  if (reason === 'airtable_computed') {
    return 'Champ calculé dans Airtable (formule, rollup, lookup…) : Airtable en refuse toute modification — import seulement'
  }
  if (reason === 'computed_push_only') {
    return 'Champ calculé dans Boréal — poussé vers Airtable, jamais importé'
  }
  if (reason === 'core_skip') return 'Champ géré par la synchronisation cœur — sens non modifiable'
  if (reason === 'resolved_ref') {
    return 'Le nom importé est résolu vers un enregistrement Boréal — import seulement'
  }
  return null
}

const DIR_OPTIONS = [
  { value: 'both', Icon: ArrowLeftRight, label: 'Bidirectionnel', hint: 'Importé depuis Airtable et réécrit à la modification dans l’ERP' },
  { value: 'pull', Icon: ArrowLeft, label: 'Airtable → ERP', hint: 'Import seulement — jamais réécrit vers Airtable' },
  { value: 'push', Icon: ArrowRight, label: 'ERP → Airtable', hint: 'Export seulement — la valeur Airtable n’est plus importée' },
]

// Contrôle de sens. Pour un champ non configurable (linked record / champ dérivé),
// icône statique en lecture seule. Pour un champ configurable, bouton ouvrant un
// petit menu où l'utilisateur choisit pull / push / both (autosave immédiat).
// `compact` : sans padding vertical, pour une rangée déjà centrée (tableau des
// champs de /champs/:table) plutôt que la grille alignée en haut du CoreMapPane.
// `noPush` : pas d'« ERP → Airtable » (rattachement requis à l'import).
export function DirectionControl({ module, fieldKey, direction, configurable, mapped, onChange, compact, lockTitle, noPush }) {
  const [open, setOpen] = useState(false)
  const current = DIRECTIONS[direction] || DIRECTIONS.pull
  const CurIcon = current.Icon

  if (!configurable) {
    return (
      <span
        title={lockTitle || current.title}
        data-testid={`coremap-${module}-${fieldKey}-direction`}
        data-direction={direction || 'pull'}
        className={`inline-flex ${compact ? '' : 'pt-2'} cursor-help ${mapped ? 'text-slate-600' : 'text-slate-400'}`}
      >
        <CurIcon size={13} />
      </span>
    )
  }

  return (
    <span className={`relative inline-flex ${compact ? '' : 'pt-1'}`}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        title={`${current.title} — cliquer pour changer le sens`}
        data-testid={`coremap-${module}-${fieldKey}-direction`}
        data-direction={direction || 'both'}
        className={`inline-flex items-center justify-center w-6 h-6 rounded transition-colors hover:bg-slate-100 ${mapped ? 'text-slate-700' : 'text-slate-400'}`}
      >
        <CurIcon size={13} />
      </button>
      {open && (
        <>
          {/* Capture-clic hors du menu pour le fermer */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div
            className="absolute z-20 top-8 left-1/2 -translate-x-1/2 w-60 bg-white border border-slate-200 rounded-lg shadow-lg p-1"
            data-testid={`coremap-${module}-${fieldKey}-direction-menu`}
          >
            {DIR_OPTIONS.filter(opt => !(noPush && opt.value === 'push')).map(opt => {
              const OptIcon = opt.Icon
              const active = direction === opt.value
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => { setOpen(false); if (!active) onChange(opt.value) }}
                  data-testid={`coremap-${module}-${fieldKey}-direction-${opt.value}`}
                  className={`w-full flex items-start gap-2 px-2 py-1.5 rounded text-left transition-colors ${active ? 'bg-brand-50' : 'hover:bg-slate-50'}`}
                >
                  <OptIcon size={13} className={`mt-0.5 flex-shrink-0 ${active ? 'text-brand-600' : 'text-slate-400'}`} />
                  <span className="min-w-0">
                    <span className={`block text-xs font-medium ${active ? 'text-brand-700' : 'text-slate-700'}`}>{opt.label}</span>
                    <span className="block text-[10px] text-slate-400 leading-snug">{opt.hint}</span>
                  </span>
                </button>
              )
            })}
          </div>
        </>
      )}
    </span>
  )
}

// État complet du mapping cœur d'un module : chargement, brouillon, sens de
// sync, enregistrement. Partagé entre le panneau ci-dessous et la page
// /champs/:table, qui fusionne ces mêmes champs dans son tableau unique.
// `module` peut être null (table sans mapping cœur fusionnable) : rien n'est
// chargé et `data` reste null.
// Mapping « cœur » persisté, comme le mapping-data des champs dynamiques : au
// retour sur la page, les cellules « Champ Airtable » s'affichent remplies dès
// le premier rendu, le serveur ne fait que confirmer derrière.
function coreMapCacheKey(module) {
  return `connectors:airtable-core-map:${module}`
}

export function useCoreMap(module, onSaved) {
  const stale = module ? readStale(coreMapCacheKey(module)) : null
  const [data, setData] = useState(stale)
  const [loadError, setLoadError] = useState('')
  const [draft, setDraft] = useState(() => ({ ...(stale?.field_map || {}) }))
  const [dirs, setDirs] = useState(
    () => Object.fromEntries((stale?.fields || []).map(f => [f.key, f.direction]))
  )
  const [resyncAfter, setResyncAfter] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [savedMsg, setSavedMsg] = useState('')
  // Clé → valeur enregistrée ailleurs pendant qu'un brouillon local la couvre.
  const [conflicts, setConflicts] = useState({})
  const draftRef = useRef(draft)
  useEffect(() => { draftRef.current = draft }, [draft])

  // `moduleRef` : garde contre la réponse d'un module qu'on a quitté entre-temps.
  const moduleRef = useRef(module)
  useEffect(() => { moduleRef.current = module }, [module])
  const load = useCallback(() => {
    if (!module) { setData(null); return Promise.resolve() }
    return api.airtable.moduleCoreMap(module)
      .then(d => {
        if (moduleRef.current !== module) return
        setLoadError('')
        setData(d)
        setDraft({ ...d.field_map })
        setDirs(Object.fromEntries(d.fields.map(f => [f.key, f.direction])))
        writeStale(coreMapCacheKey(module), d)
        pruneStale('connectors:airtable-core-map:', 4)
      })
      .catch(e => { if (moduleRef.current === module) setLoadError(e.message) })
  }, [module])

  // Relecture sans écraser les brouillons (modification venue d'une autre
  // session ou de l'API, ou « Rafraîchir » des champs). Une clé dont le
  // brouillon diffère du dernier état serveur connu reste telle quelle ; si le
  // serveur a changé cette même clé entre-temps, elle est signalée en conflit.
  // Lève en cas d'échec — l'appelant décide quoi en faire.
  const dataRef = useRef(data)
  useEffect(() => { dataRef.current = data }, [data])
  const pendingDirs = useRef(new Set())
  const mergeRemote = useCallback(() => {
    if (!module) return Promise.resolve()
    invalidate(`/connectors/airtable/module-fields/${module}/core-map`)
    return api.airtable.moduleCoreMap(module)
      .then(d => {
        if (moduleRef.current !== module) return
        const base = dataRef.current?.field_map || {}
        const local = draftRef.current
        const next = { ...d.field_map }
        const clash = {}
        for (const k of new Set([...Object.keys(local), ...Object.keys(base)])) {
          const mine = local[k] || ''
          if (mine === (base[k] || '')) continue
          next[k] = mine
          const theirs = d.field_map[k] || ''
          if (theirs !== (base[k] || '') && theirs !== mine) clash[k] = theirs
        }
        setLoadError('')
        setData(d)
        setDraft(next); draftRef.current = next
        setDirs(prev => Object.fromEntries(d.fields.map(f => [
          f.key, pendingDirs.current.has(f.key) ? prev[f.key] : f.direction,
        ])))
        setConflicts(c => {
          const kept = Object.fromEntries(Object.entries(c).filter(([k]) => (next[k] || '') !== (d.field_map[k] || '')))
          return { ...kept, ...clash }
        })
        writeStale(coreMapCacheKey(module), d)
      })
  }, [module])
  const onRemoteChange = useCallback(() => { mergeRemote().catch(() => {}) }, [mergeRemote])
  useRealtimeChannel(module ? `airtable_core_map:${module}` : null, onRemoteChange)

  // Changement de module : on repart de SON dernier état connu (sinon les
  // cellules afficheraient un instant le mapping du module précédent).
  useEffect(() => {
    const known = module ? readStale(coreMapCacheKey(module)) : null
    setData(known)
    setDraft({ ...(known?.field_map || {}) })
    setDirs(Object.fromEntries((known?.fields || []).map(f => [f.key, f.direction])))
    setConflicts({})
    load()
  }, [module, load])

  // « Rafraîchir » du bas du sélecteur de champ : le serveur oublie les
  // métadonnées Airtable mémorisées, puis on relit — un champ créé à l'instant
  // dans la table apparaît dans la liste, les choix non enregistrés restent.
  const refreshFields = useCallback(async () => {
    if (!module) return
    await refreshAirtableSchema(module)
    await mergeRemote()
  }, [module, mergeRemote])

  // Choix du sens de sync d'un champ — autosave immédiat (revert visuel si échec).
  async function changeDirection(fieldKey, direction) {
    const prev = dirs[fieldKey]
    setDirs(d => ({ ...d, [fieldKey]: direction }))
    setSaveError(''); setSavedMsg('')
    pendingDirs.current.add(fieldKey)
    try {
      await api.airtable.setModuleFieldDirection(module, fieldKey, direction)
      setSavedMsg('Sens de synchronisation mis à jour.')
    } catch (e) {
      setDirs(d => ({ ...d, [fieldKey]: prev }))
      setSaveError(e.message)
    } finally {
      pendingDirs.current.delete(fieldKey)
    }
  }

  // Autosave d'UNE clé du mapping — utilisé par le tableau des champs de
  // /champs/:table, où la cellule « Champ Airtable » est la même pour les clés
  // cœur et les mappings dynamiques : le choix s'enregistre tout de suite, sans
  // barre « Enregistrer le mapping » (elle ne subsiste que dans CoreMapPane,
  // pour les modules dont les clés ne se rattachent à aucune colonne ERP).
  // La resynchronisation n'est PAS déclenchée ici : le bouton « Synchroniser »
  // de l'en-tête Source Airtable la lance, comme pour un mapping dynamique.
  // Lève en cas d'échec — l'appelant affiche l'erreur dans la cellule.
  async function saveField(fieldKey, name) {
    const prev = draftRef.current
    const next = { ...prev, [fieldKey]: name || '' }
    setDraft(next); draftRef.current = next
    setSaveError(''); setSavedMsg('')
    setSaving(true)
    try {
      const r = await api.airtable.saveModuleCoreMap(module, next)
      setData(d => ({ ...d, field_map: r.field_map }))
      setDraft({ ...r.field_map }); draftRef.current = { ...r.field_map }
      onSaved?.()
    } catch (e) {
      setDraft(prev); draftRef.current = prev
      throw e
    } finally {
      setSaving(false)
    }
  }

  // Un conflit n'a plus lieu d'être dès que le brouillon rejoint le serveur.
  const openConflicts = useMemo(() => Object.fromEntries(Object.entries(conflicts)
    .filter(([k]) => (draft[k] || '') !== (data?.field_map?.[k] || ''))), [conflicts, draft, data])

  const dirty = useMemo(() => {
    if (!data) return false
    return data.fields.some(f => (draft[f.key] || '') !== (data.field_map[f.key] || ''))
  }, [data, draft])

  // Options du picker : champs Airtable réels + valeurs mappées introuvables
  // dans les métadonnées (champ renommé/supprimé côté Airtable) pour que la
  // sélection courante reste visible et signalée.
  const options = useMemo(() => {
    if (!data) return []
    const known = new Set(data.airtable_fields.map(f => f.name))
    const orphans = [...new Set(Object.values(draft).filter(v => v && !known.has(v)))]
      .map(name => ({ name, type: null, missing: true }))
    return [...data.airtable_fields, ...orphans]
  }, [data, draft])

  async function save() {
    setSaving(true); setSaveError(''); setSavedMsg('')
    try {
      const r = await api.airtable.saveModuleCoreMap(module, draft)
      setData(d => ({ ...d, field_map: r.field_map }))
      setDraft({ ...r.field_map })
      setConflicts({})
      if (resyncAfter) {
        api.airtable.sync(data.sync_key)
        setSavedMsg('Correspondance enregistrée — resynchronisation lancée en arrière-plan.')
      } else {
        setSavedMsg('Correspondance enregistrée.')
      }
      onSaved?.()
    } catch (e) {
      setSaveError(e.message)
    } finally {
      setSaving(false)
    }
  }

  return {
    data, loadError, draft, setDraft, dirs, conflicts: openConflicts, changeDirection, dirty, options,
    save, saveField, saving, saveError, savedMsg, setSavedMsg, resyncAfter, setResyncAfter,
    refreshFields,
  }
}

// Cellule « champ Airtable » d'une clé cœur : picker recherchable + alerte si le
// champ mappé n'existe plus côté Airtable + suggestion par nom. Partagée entre
// le panneau ci-dessous et le tableau des champs de /champs/:table.
export function CoreFieldPicker({ module, field, value, onChange, options, suggestion, onRefresh }) {
  const current = options.find(o => o.name === value)
  const refresh = useRefreshFields(onRefresh)
  return (
    <>
      <SearchableSelect
        className="input"
        size="sm"
        value={value || ''}
        onChange={onChange}
        options={options}
        getOptionValue={o => o.name}
        getOptionLabel={o => o.missing ? `${o.name} (introuvable dans Airtable)` : o.name}
        getOptionKey={o => o.name}
        emptyOption={field.required ? undefined : '— Non mappé —'}
        searchPlaceholder="Rechercher un champ…"
        testId={`coremap-${module}-${field.key}`}
        footer={onRefresh ? (
          <RefreshFieldsButton
            onClick={refresh.run}
            refreshing={refresh.refreshing}
            testId={`coremap-${module}-${field.key}-refresh`}
          />
        ) : undefined}
      />
      {refresh.error && <p className="text-[11px] text-red-600 mt-0.5">{refresh.error}</p>}
      {current?.missing && (
        <p className="text-[11px] text-red-600 mt-0.5 flex items-center gap-1">
          <AlertCircle size={11} /> Champ absent de la table Airtable — le sync ne remplira rien.
        </p>
      )}
      {!value && suggestion && (
        <button
          type="button"
          onClick={() => onChange(suggestion)}
          className="max-w-full text-[11px] text-brand-600 hover:text-brand-800 mt-0.5 inline-flex items-center gap-1"
          title={`Champ Airtable détecté automatiquement par nom : ${suggestion}`}
        >
          <Sparkles size={11} className="flex-shrink-0" />
          {/* truncate : un nom de champ Airtable long ne doit pas élargir la modale */}
          <span className="truncate">Suggestion : {suggestion}</span>
        </button>
      )}
    </>
  )
}

// Barre d'enregistrement du mapping cœur : messages + case « resynchroniser »
// + bouton. Pas d'autosave — changer le mapping est transactionnel (peut
// déclencher une resynchronisation complète du module).
export function CoreMapSaveBar({ module, core }) {
  const { dirty, save, saving, saveError, savedMsg, resyncAfter, setResyncAfter } = core
  return (
    <>
      {saveError && <p className="text-sm text-red-600">{saveError}</p>}
      {savedMsg && (
        <p className="text-sm text-green-700 flex items-center gap-1.5" data-testid={`coremap-${module}-saved`}>
          <CheckCircle2 size={14} /> {savedMsg}
        </p>
      )}
      <div className="flex items-center justify-between pt-2 border-t border-slate-100">
        <label className="flex items-center gap-2 text-xs text-slate-600">
          <input
            type="checkbox"
            checked={resyncAfter}
            onChange={e => setResyncAfter(e.target.checked)}
            data-testid={`coremap-${module}-resync`}
          />
          Resynchroniser le module après enregistrement
        </label>
        <button
          onClick={save}
          disabled={saving || !dirty}
          className="btn-primary btn-sm"
          data-testid={`coremap-${module}-save`}
        >
          {saving ? <RefreshCw size={13} className="animate-spin" /> : null}
          {saving ? 'Enregistrement…' : 'Enregistrer la correspondance'}
        </button>
      </div>
    </>
  )
}

// `showSync` : afficher les détails de sync en tête du panneau. À couper quand
// l'hôte les affiche déjà (page /champs/:table, qui montre l'état de la source
// Airtable au-dessus du tableau des champs).
export function CoreMapPane({ module, onSaved, showSync = true }) {
  const core = useCoreMap(module, onSaved)
  const { data, loadError, draft, setDraft, dirs, conflicts, changeDirection, options, setSavedMsg, refreshFields } = core

  // Détails de sync de la table ERP alimentée par ce module — affichés en
  // tête du panneau, y compris pendant le chargement et en cas d'erreur.
  const syncDetails = showSync
    ? <SyncDetails table={MODULE_TO_TABLE[module] || module} connector="Airtable" />
    : null

  if (loadError) {
    return (
      <div className="space-y-4">
        {syncDetails}
        <div className="p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700 flex items-start gap-2">
          <AlertCircle size={14} className="mt-0.5 flex-shrink-0" /> {loadError}
        </div>
      </div>
    )
  }
  if (!data) {
    return (
      <div className="space-y-4">
        {syncDetails}
        <p className="text-sm text-slate-400 py-6 text-center"><Spinner size="xs" label="Chargement…" /></p>
      </div>
    )
  }
  if (!data.configured) {
    return (
      <div className="space-y-4">
        {syncDetails}
        <div className="p-3 bg-amber-50 border border-amber-200 rounded text-sm text-amber-800">
          Base et table Airtable non configurées pour « {data.label} ». Configurez-les d'abord dans
          Paramètres → Connecteurs → Airtable.
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {syncDetails}
      <p className="text-xs text-slate-500">
        Chaque champ ERP ci-dessous est alimenté par le champ Airtable choisi lors de la
        synchronisation du module « {data.label} ».
      </p>

      {data.airtable_error && (
        <div className="p-3 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800 flex items-start gap-2">
          <AlertCircle size={13} className="mt-0.5 flex-shrink-0" />
          <span>Impossible de lister les champs de la table Airtable ({data.airtable_error}). Le mapping actuel reste affiché.</span>
        </div>
      )}

      <div className="space-y-2.5">
        {/* En-têtes de colonnes (à la Airtable) : source ERP à gauche, champ Airtable à droite */}
        <div className="grid grid-cols-[1fr_auto_1fr] gap-3 pb-1.5 border-b border-slate-200" data-testid={`coremap-${module}-headers`}>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Champ ERP</div>
          {/* Colonne centrale : icône de sens du mapping — invisible pour caler la largeur */}
          <div aria-hidden="true" className="invisible"><ArrowLeftRight size={13} /></div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Champ Airtable</div>
        </div>
        {data.fields.map(f => {
          // min-w-0 sur les cellules : sans lui, un nom de champ Airtable long
          // (whitespace-nowrap dans le picker/suggestion) gonfle la piste 1fr
          // et brise la mise en page de la modale.
          return (
            <div key={f.key} className="grid grid-cols-[1fr_auto_1fr] gap-3 items-start">
              <div className="pt-1.5 min-w-0">
                <div className="text-sm text-slate-700">
                  {f.label}{f.required && <span className="text-red-500 ml-0.5">*</span>}
                </div>
                {f.hint && <div className="text-[11px] text-slate-400 mt-0.5">{f.hint}</div>}
              </div>
              <DirectionControl
                module={module}
                fieldKey={f.key}
                direction={dirs[f.key] || f.direction}
                configurable={f.configurable}
                mapped={!!draft[f.key]}
                onChange={dir => changeDirection(f.key, dir)}
                lockTitle={directionLockTitle(f.direction_reason, data.label)}
              />
              <div className="min-w-0">
                <CoreFieldPicker
                  module={module}
                  field={f}
                  value={draft[f.key] || ''}
                  onChange={v => { setDraft(d => ({ ...d, [f.key]: v })); setSavedMsg('') }}
                  options={options}
                  suggestion={data.suggested[f.key]}
                  onRefresh={refreshFields}
                />
                {f.key in conflicts && (
                  <button
                    type="button"
                    onClick={() => { setDraft(d => ({ ...d, [f.key]: conflicts[f.key] })); setSavedMsg('') }}
                    className="max-w-full text-[11px] text-amber-700 hover:text-amber-900 mt-0.5 inline-flex items-center gap-1"
                    title="Enregistré ailleurs pendant votre modification — cliquer pour reprendre cette valeur"
                    data-testid={`coremap-${module}-${f.key}-conflict`}
                  >
                    <AlertCircle size={11} className="flex-shrink-0" />
                    <span className="truncate">Modifié ailleurs : {conflicts[f.key] || '— Non mappé —'}</span>
                  </button>
                )}
              </div>
            </div>
          )
        })}
      </div>

      <CoreMapSaveBar module={module} core={core} />
    </div>
  )
}

export default AirtableCoreMapModal
