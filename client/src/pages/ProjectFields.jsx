import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ChevronLeft, RefreshCw, Trash2, Plus, X } from 'lucide-react'
import { Layout } from '../components/Layout.jsx'
import api from '../lib/api.js'
import { useSyncStatus } from '../lib/useSyncStatus.js'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { SearchableSelect } from '../components/SearchableSelect.jsx'
import { fmtDate } from '../lib/formatDate.js'

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
  link:          new Set(['link']),
}
const TYPE_OPTIONS = [
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
function NameCell({ value, onSave, disabled }) {
  const [editing, setEditing] = useState(false)
  const [local, setLocal] = useState(value || '')
  useEffect(() => { setLocal(value || '') }, [value])

  function commit() {
    setEditing(false)
    const trimmed = local.trim()
    if (trimmed === (value || '').trim()) return
    onSave(trimmed || null) // empty → réinit display_label (fallback sur airtable_field_name côté serveur)
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
      {value || <span className="text-slate-300 italic">— sans nom —</span>}
    </button>
  )
}

// Picker de mapping Airtable inline. Affiche soit le mapping courant avec
// bouton ×, soit un bouton « Mapper » qui ouvre le picker.
function MappingPicker({ erpColumn, airtableFields, tableMap, onSave, savingId }) {
  const [editing, setEditing] = useState(false)
  const [atFieldName, setAtFieldName] = useState('')
  const [target, setTarget] = useState(erpColumn.target_table || '')
  const [err, setErr] = useState(null)

  const isLink = erpColumn.field_type === 'link'

  // Champs Airtable candidats : type compat avec la colonne, pas déjà mappés
  // ailleurs (sauf si ce sont déjà nos mappés).
  const candidates = useMemo(() => {
    const compatTypes = TYPE_COMPAT[erpColumn.field_type] || new Set()
    return airtableFields.filter(f =>
      compatTypes.has(f.erp_field_type)
      && (!f.current_mapping || f.airtable_field_name === erpColumn.mapped_airtable_field)
    )
  }, [airtableFields, erpColumn])

  const linkTargets = useMemo(() => {
    const set = new Set(Object.values(tableMap || {}))
    set.add('companies'); set.add('contacts'); set.add('users')
    return [...set].sort()
  }, [tableMap])

  const selected = candidates.find(c => c.airtable_field_name === atFieldName)
  // Pré-remplit target depuis linkedTableId si on choisit un champ lien
  useEffect(() => {
    if (!isLink || !selected) return
    if (target) return
    const auto = tableMap?.[selected.linked_table_id]
    if (auto) setTarget(auto)
  }, [selected, isLink, tableMap, target])

  async function save() {
    setErr(null)
    if (!atFieldName) { setErr('Choisis un champ Airtable'); return }
    const f = candidates.find(c => c.airtable_field_name === atFieldName)
    if (!f) { setErr('Champ introuvable'); return }
    if (isLink && !target) { setErr('Choisis une table cible'); return }
    try {
      await onSave({
        airtable_field_id: f.airtable_field_id,
        airtable_field_name: f.airtable_field_name,
        airtable_field_type: f.airtable_field_type,
        column_name: erpColumn.column_name,
        link_target_table: isLink ? target : null,
      })
      setEditing(false)
    } catch (e) {
      setErr(e.message || 'Erreur')
    }
  }

  async function unmap() {
    if (!erpColumn.mapped_airtable_field) return
    setErr(null)
    try {
      await onSave({
        airtable_field_id: erpColumn.airtable_field_id,
        airtable_field_name: erpColumn.mapped_airtable_field,
        airtable_field_type: 'singleLineText', // peu importe pour unmap
        column_name: null,
      })
    } catch (e) {
      setErr(e.message || 'Erreur')
    }
  }

  if (erpColumn.mapped_airtable_field && !editing) {
    return (
      <div className="flex items-center gap-1 text-xs">
        <span className="px-1.5 py-0.5 rounded bg-brand-50 text-brand-700 font-medium truncate">
          {erpColumn.mapped_airtable_field}
        </span>
        {erpColumn.target_table && (
          <span className="text-[10px] text-slate-400">→ {erpColumn.target_table}</span>
        )}
        <button
          onClick={unmap}
          disabled={savingId === erpColumn.column_name}
          className="text-slate-400 hover:text-red-600 p-0.5"
          title="Déconnecter le mapping"
        >
          <X size={12} />
        </button>
      </div>
    )
  }

  if (!editing) {
    const noCandidates = candidates.length === 0
    return (
      <button
        onClick={() => { setAtFieldName(''); setTarget(erpColumn.target_table || ''); setEditing(true) }}
        disabled={noCandidates}
        className="text-xs px-1.5 py-0.5 rounded text-slate-500 hover:text-brand-700 hover:bg-brand-50 disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-1"
        title={noCandidates ? 'Aucun champ Airtable compatible' : 'Mapper un champ Airtable'}
      >
        <Plus size={12} /> {noCandidates ? 'Aucun champ compat.' : 'Mapper'}
      </button>
    )
  }

  return (
    <div className="space-y-1.5 bg-slate-50 p-2 rounded border border-slate-200">
      <SearchableSelect
        testId="mapping-airtable-field"
        value={atFieldName}
        options={candidates}
        getOptionValue={c => c.airtable_field_name}
        getOptionLabel={c => `${c.airtable_field_name} (${c.airtable_field_type})`}
        getOptionKey={c => c.airtable_field_name}
        onChange={setAtFieldName}
        emptyOption="— Champ Airtable —"
        placeholder="— Champ Airtable —"
        searchPlaceholder="Rechercher un champ…"
      />
      {isLink && (
        <SearchableSelect
          testId="mapping-target-table"
          value={target}
          options={linkTargets}
          getOptionValue={t => t}
          getOptionLabel={t => t}
          getOptionKey={t => t}
          onChange={setTarget}
          emptyOption="— Table ERP cible —"
          placeholder="— Table ERP cible —"
          searchPlaceholder="Rechercher une table…"
        />
      )}
      {err && <div className="text-[11px] text-red-600">{err}</div>}
      <div className="flex justify-end gap-1">
        <button onClick={() => { setEditing(false); setErr(null) }} className="text-[11px] px-2 py-0.5 text-slate-600 hover:bg-slate-200 rounded">Annuler</button>
        <button onClick={save} disabled={savingId === erpColumn.column_name} className="text-[11px] px-2 py-0.5 bg-brand-600 text-white rounded hover:bg-brand-700 disabled:opacity-50">
          {savingId === erpColumn.column_name ? '…' : 'OK'}
        </button>
      </div>
    </div>
  )
}

// Section header : config base/table + sync trigger. Identique à l'ancien
// AirtableSyncButton mais inline en page (pas en modal).
function AirtableConfigSection({ onSynced }) {
  const [config, setConfig] = useState(null)
  const [bases, setBases] = useState([])
  const [tables, setTables] = useState([])
  const [baseId, setBaseId] = useState('')
  const [tableId, setTableId] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const { status: syncStatus } = useSyncStatus(3000)
  const syncing = !!syncStatus?.projets?.running

  useEffect(() => {
    api.connectors.list().then(d => {
      const cfg = d.projets_sync || {}
      setConfig(cfg)
      if (cfg.base_id) setBaseId(cfg.base_id)
      if (cfg.projects_table_id) setTableId(cfg.projects_table_id)
    }).catch(() => {})
    api.airtable.bases().then(b => setBases(b || [])).catch(() => {})
  }, [])

  useEffect(() => {
    if (!baseId) { setTables([]); return }
    api.airtable.tables(baseId).then(t => setTables(t || [])).catch(() => setTables([]))
  }, [baseId])

  const wasSyncing = useRef(false)
  useEffect(() => {
    if (syncing) { wasSyncing.current = true; return }
    if (wasSyncing.current) {
      wasSyncing.current = false
      api.connectors.list().then(d => setConfig(d.projets_sync || {})).catch(() => {})
      onSynced?.()
    }
  }, [syncing, onSynced])

  async function handleSave() {
    setSaving(true); setError(null)
    try {
      await api.airtable.saveConfig('projets', {
        base_id: baseId, projects_table_id: tableId, field_map_projects: {},
      })
      const d = await api.connectors.list()
      setConfig(d.projets_sync || {})
    } catch (e) { setError(e.message || 'Erreur') }
    finally { setSaving(false) }
  }

  async function handleSync() {
    if (!baseId || !tableId) return
    setError(null)
    try { await api.airtable.sync('projets') } catch (e) { setError(e.message || 'Erreur sync') }
  }

  const configured = !!(config?.base_id && config?.projects_table_id)

  return (
    <div className="bg-white border border-slate-200 rounded-lg p-4 mb-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-700">Source Airtable</h2>
          <div className="text-xs text-slate-500 flex items-center gap-2 mt-0.5">
            {configured ? (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                <span>{config.last_synced_at ? `Dernière sync : ${fmtDate(config.last_synced_at)}` : 'Configurée'}</span>
              </>
            ) : (
              <>
                <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
                <span className="text-amber-600">Non configurée</span>
              </>
            )}
            {syncing && <span className="text-amber-600 font-medium animate-pulse">Synchronisation en cours…</span>}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={handleSave} disabled={saving || !baseId || !tableId} className="btn-secondary btn-sm">
            {saving ? 'Enregistrement…' : 'Enregistrer'}
          </button>
          <button onClick={handleSync} disabled={syncing || !configured} className="btn-primary btn-sm flex items-center gap-1.5">
            <RefreshCw size={13} className={syncing ? 'animate-spin' : ''} />
            {syncing ? 'Synchronisation…' : 'Synchroniser'}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-xs text-slate-500 mb-1">Base</label>
          <SearchableSelect
            testId="projets-base-select"
            className="input"
            size="sm"
            value={baseId}
            options={bases}
            getOptionValue={b => b.id}
            getOptionLabel={b => b.name}
            onChange={v => { setBaseId(v); setTableId('') }}
            emptyOption="— Sélectionner —"
            placeholder="Choisir une base…"
            searchPlaceholder="Rechercher une base…"
          />
        </div>
        <div>
          <label className="block text-xs text-slate-500 mb-1">Table projets</label>
          <SearchableSelect
            testId="projets-table-select"
            className="input"
            size="sm"
            value={tableId}
            options={tables}
            getOptionValue={t => t.id}
            getOptionLabel={t => t.name}
            onChange={setTableId}
            emptyOption="— Sélectionner —"
            placeholder="Choisir une table…"
            searchPlaceholder="Rechercher une table…"
            disabled={!baseId}
          />
        </div>
      </div>
      {error && <p className="text-xs text-red-600 mt-2">{error}</p>}
    </div>
  )
}

// Bandeau de statut source pour les modules autres que projets. La config
// base/table de ces modules vit dans Connecteurs → Airtable ; ici on se contente
// d'afficher l'état + un bouton de sync, et un lien vers la config si non
// configurée.
function ModuleSourceStatus({ data, onSynced }) {
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
          <h2 className="text-sm font-semibold text-slate-700">Source Airtable</h2>
          <div className="text-xs text-slate-500 flex items-center gap-2 mt-0.5">
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

export default function ProjectFields() {
  const { module: moduleParam } = useParams()
  const module = moduleParam || 'projets'
  const [data, setData] = useState(null)
  const [filter, setFilter] = useState('')
  const [savingId, setSavingId] = useState(null)
  const confirm = useConfirm()
  const { addToast } = useToast()

  // Table ERP cible du module (pour upsert orphelines + invalidation DataTable).
  // Fallback 'projects' tant que la mapping-data n'est pas chargée.
  const erpTable = data?.erp_table || (module === 'projets' ? 'projects' : null)

  const reload = useCallback(() => {
    return api.airtable.moduleMappingData(module)
      .then(d => setData(d))
      .catch(e => addToast({ message: e.message || 'Erreur chargement', type: 'error' }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [module])

  useEffect(() => { setData(null); reload() }, [reload])

  // Rendu/type d'une colonne = un champ custom_fields (fusion avec l'ex-
  // airtable_field_defs). Rename : PUT sur le champ existant. Première
  // adoption d'une colonne orpheline (pas encore de cf_id) : POST .../adopt.
  async function applyChange(col, payload) {
    setSavingId(col.column_name)
    try {
      if (col.cf_id) {
        await api.customFields.update(col.cf_id, payload)
      } else if (erpTable && payload.type) {
        await api.customFields.adopt(erpTable, { column_name: col.column_name, name: col.label || col.column_name, type: payload.type })
      }
      await reload()
      // Notifie les DataTable ouverts pour rafraîchir le rendu (labels/types).
      if (erpTable) window.dispatchEvent(new CustomEvent('views:updated', { detail: { table: erpTable } }))
    } catch (e) {
      addToast({ message: e.message || 'Erreur', type: 'error' })
    } finally {
      setSavingId(null)
    }
  }

  async function handleRename(col, newLabel) {
    if (newLabel === (col.display_label || '')) return
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

  async function handleMappingSave(payload) {
    setSavingId(payload.column_name || '__unmap__')
    try {
      await api.airtable.setModuleFieldMapping(module, payload)
      await reload()
      if (erpTable) window.dispatchEvent(new CustomEvent('views:updated', { detail: { table: erpTable } }))
    } finally {
      setSavingId(null)
    }
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
      if (erpTable) window.dispatchEvent(new CustomEvent('views:updated', { detail: { table: erpTable } }))
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
    <Layout>
      <div className="p-6 max-w-6xl">
        <div className="flex items-center gap-3 mb-4">
          <Link to={module === 'projets' ? '/pipeline' : '/connectors'} className="text-slate-400 hover:text-slate-600">
            <ChevronLeft size={20} />
          </Link>
          <div>
            <h1 className="text-2xl font-bold text-slate-900">Champs — {data?.label || (module === 'projets' ? 'Projets' : module)}</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              {cols.length} champ{cols.length !== 1 ? 's' : ''}
              {data && (
                <> · <span className="text-brand-600 font-medium">{cols.filter(c => c.mapped).length} mappé{cols.filter(c => c.mapped).length !== 1 ? 's' : ''} depuis Airtable</span></>
              )}
            </p>
          </div>
        </div>

        {module === 'projets'
          ? <AirtableConfigSection onSynced={reload} />
          : <ModuleSourceStatus data={data} onSynced={reload} />}

        <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
          <div className="px-4 py-3 border-b border-slate-100 flex items-center justify-between">
            <input
              type="text"
              value={filter}
              onChange={e => setFilter(e.target.value)}
              placeholder="Rechercher un champ…"
              className="input text-sm w-64"
            />
            <div className="text-xs text-slate-400">
              Clique sur un nom pour le renommer · Le type s'autosauve · Pas de mapping = pas d'import
            </div>
          </div>
          {data === null ? (
            <p className="text-sm text-slate-400 px-4 py-8 text-center">Chargement…</p>
          ) : filteredCols.length === 0 ? (
            <p className="text-sm text-slate-400 px-4 py-8 text-center">Aucun champ</p>
          ) : (
            <table className="w-full text-sm table-fixed">
              <thead className="bg-slate-50 text-xs font-semibold text-slate-500 uppercase tracking-wide">
                <tr>
                  <th className="text-left px-4 py-2 w-[28%]">Nom</th>
                  <th className="text-left px-4 py-2 w-[22%]">Colonne</th>
                  <th className="text-left px-4 py-2 w-[18%]">Type</th>
                  <th className="text-left px-4 py-2 w-[28%]">Champ Airtable</th>
                  <th className="px-2 py-2 w-[4%]"></th>
                </tr>
              </thead>
              <tbody>
                {filteredCols.map(col => (
                  <tr key={col.column_name} className="border-t border-slate-100 hover:bg-slate-50/50">
                    <td className="px-4 py-2 align-top">
                      <NameCell
                        value={col.label}
                        onSave={(newLabel) => handleRename(col, newLabel)}
                        disabled={savingId === col.column_name}
                      />
                    </td>
                    <td className="px-4 py-2 align-top overflow-hidden">
                      <code className="text-xs text-slate-400 truncate block" title={col.column_name}>{col.column_name}</code>
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
                    <td className="px-4 py-2 align-top">
                      <MappingPicker
                        erpColumn={col}
                        airtableFields={data.airtable_fields}
                        tableMap={data.airtable_table_to_erp}
                        onSave={handleMappingSave}
                        savingId={savingId}
                      />
                    </td>
                    <td className="px-2 py-2 align-top">
                      <button
                        onClick={() => handleDelete(col)}
                        disabled={savingId === col.column_name || !col.cf_id}
                        className="p-1 text-slate-400 hover:text-red-600 hover:bg-red-50 rounded disabled:opacity-30 disabled:cursor-not-allowed"
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
          <div className="mt-4 text-xs text-slate-400">
            <p className="font-medium mb-1">{data.hardcoded.length} champ{data.hardcoded.length !== 1 ? 's' : ''} géré{data.hardcoded.length !== 1 ? 's' : ''} en code (non éditable{data.hardcoded.length !== 1 ? 's' : ''} ici) :</p>
            <p className="text-slate-500">{data.hardcoded.join(', ')}</p>
          </div>
        )}
      </div>
    </Layout>
  )
}
