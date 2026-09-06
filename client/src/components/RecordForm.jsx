import { useState, useMemo, useCallback, useEffect, useRef } from 'react'
import { Eye, EyeOff, Pencil, Check, Search, Lock } from 'lucide-react'
import api from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'
import { useSaveStatus, SaveStatus } from './SaveStatus.jsx'
import { useFieldGate } from '../lib/fieldGate.js'
import { SearchableSelect } from './SearchableSelect.jsx'
import Spinner from './Spinner.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'

// Formulaire d'ajout de record, configurable par l'utilisateur.
//
// Chaque page déclare la liste COMPLÈTE des champs que sa route de création
// accepte (`fields`), avec un défaut `visible` / `required`. L'utilisateur peut
// ensuite, via le crayon « Modifier le formulaire », afficher/masquer un champ
// et le rendre obligatoire — persisté par table dans table_form_configs
// (routes/form-configs.js) et donc partagé par toute l'équipe.
//
// Pourquoi la liste est déclarée par la page et non dérivée du schéma SQL : les
// routes POST de création ont une liste blanche de colonnes. Proposer une colonne
// qu'elles ignorent donnerait un champ qui « ne sauvegarde pas ». Les champs
// proposés ici sont donc exactement ceux que la création sait persister.
//
// `includeAllFields` étend cette liste avec le CATALOGUE du registre de champs
// (GET /api/form-configs/:table/fields → services/formFieldCatalog.js) : tous les
// autres champs saisissables de la table — champs perso ERP et colonnes adoptées
// d'Airtable — moins ceux qui n'ont pas de saisie manuelle (formule, lookup,
// rollup, autonuméro, pièce jointe, champ lien). À n'activer que sur une page
// dont la route de création accepte ces colonnes (aujourd'hui /orders).
//
// Spec d'un champ :
//   field         — clé dans le payload de création (obligatoire, unique)
//   label         — libellé FR (surchargé par la personnalisation de champ)
//   type          — 'text' | 'textarea' | 'number' | 'currency' | 'date'
//                   | 'email' | 'url' | 'select' | 'checkbox' (défaut 'text')
//   options       — pour 'select' : [{ value, label }] ou string[]
//   rows, min, step
//   span          — 2 pour occuper toute la largeur d'une grille 2 colonnes
//   defaultValue  — valeur initiale (défaut '' / false pour checkbox)
//   visible       — défaut d'affichage (défaut true)
//   required      — défaut d'obligation (défaut false)
//   locked        — champ non masquable et non dé-obligeable (ex. le nom)
//   input         — rendu custom ({ value, onChange, values, setValues, id }) => JSX
//   trim          — true pour trimmer la valeur texte au submit (défaut true
//                   pour text/textarea)

const NBSP_LABEL_FALLBACK = 'Champ'

function normalizeOptions(options) {
  if (!Array.isArray(options)) return []
  // Les choix d'un champ Sélection arrivent en { id, label, color } (config du
  // champ) : la valeur enregistrée est le LIBELLÉ. Sans ce repli, l'option
  // n'aurait aucune valeur et le formulaire enverrait du vide.
  return options.map(o => (typeof o === 'string'
    ? { value: o, label: o }
    : { ...o, value: o.value ?? o.label }))
}

// Fusionne les specs de la page avec la configuration enregistrée.
export function resolveFormFields(fields, config) {
  const byField = new Map((config || []).map(c => [c.field, c]))
  return fields.map(f => {
    const saved = byField.get(f.field)
    const visible = f.locked ? true : (saved ? saved.visible !== false : f.visible !== false)
    const required = f.locked ? f.required === true : (saved ? saved.required === true : f.required === true)
    // Un champ en lecture seule ne peut pas être posé dans le formulaire, même
    // si une configuration enregistrée avant son verrouillage le dit visible.
    if (f.readOnly) return { ...f, visible: false, required: false }
    return { ...f, visible, required }
  })
}

function isEmptyValue(v) {
  if (v == null) return true
  if (typeof v === 'string') return v.trim() === ''
  if (Array.isArray(v)) return v.length === 0
  return false
}

function initialValues(fields, initial) {
  const out = {}
  for (const f of fields) {
    out[f.field] = f.defaultValue !== undefined
      ? f.defaultValue
      : (f.type === 'checkbox' ? false : '')
  }
  return { ...out, ...(initial || {}) }
}

// Hook : configuration enregistrée pour la table (liste brute persistée).
export function useFormConfig(table) {
  const [config, setConfig] = useState([])
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!table) { setConfig([]); setLoaded(true); return }
    let alive = true
    api.formConfigs.get(table)
      .then(d => { if (alive) setConfig(Array.isArray(d?.fields) ? d.fields : []) })
      .catch(() => { if (alive) setConfig([]) })
      .finally(() => { if (alive) setLoaded(true) })
    return () => { alive = false }
  }, [table])

  return { config, setConfig, loaded }
}

const NO_CATALOG = []

// Hook : catalogue des champs du registre proposables en plus de ceux déclarés
// par la page (`includeAllFields`). Le serveur en écarte tout ce qui n'a pas de
// saisie manuelle — formules, lookups, rollups, autonuméros, pièces jointes,
// champs lien — et marque `writable: false` ceux qu'Airtable pilote encore.
export function useFormFieldCatalog(table) {
  const [catalog, setCatalog] = useState(NO_CATALOG)
  const [loaded, setLoaded] = useState(!table)

  useEffect(() => {
    if (!table) { setCatalog(NO_CATALOG); setLoaded(true); return }
    let alive = true
    setLoaded(false)
    api.formConfigs.availableFields(table)
      .then(d => { if (alive) setCatalog(Array.isArray(d?.fields) ? d.fields : NO_CATALOG) })
      .catch(() => { if (alive) setCatalog(NO_CATALOG) })
      .finally(() => { if (alive) setLoaded(true) })
    return () => { alive = false }
  }, [table])

  return { catalog, loaded }
}

// Specs de la page + champs du catalogue qu'elle ne déclare pas. La page reste
// prioritaire : son libellé, son rendu custom et ses défauts l'emportent sur la
// définition générique du registre.
export function mergeCatalogFields(fields, catalog) {
  if (!catalog?.length) return fields
  const declared = new Set(fields.map(f => f.field))
  const extra = catalog
    .filter(c => !declared.has(c.field))
    .map(c => ({
      field: c.field,
      label: c.label,
      type: c.type,
      options: c.options,
      decimals: c.decimals,
      visible: false,
      ...(c.writable === false ? { readOnly: true, readOnlyReason: c.readonly_reason } : {}),
    }))
  return extra.length ? [...fields, ...extra] : fields
}

function GenericInput({ spec, value, onChange, id }) {
  // `required` natif : conserve la validation du navigateur (et l'astérisque
  // déjà posée sur le libellé) pour les champs rendus génériquement. Les champs
  // à rendu custom (LinkedRecordField, pickers…) n'ont pas d'équivalent HTML —
  // c'est la validation JS de handleSubmit qui les couvre.
  const common = {
    id,
    'data-form-field': spec.field,
    ...(spec.testId ? { 'data-testid': spec.testId } : {}),
    ...(spec.required ? { required: true } : {}),
  }
  if (spec.type === 'textarea') {
    return <textarea {...common} value={value ?? ''} onChange={e => onChange(e.target.value)} className="input" rows={spec.rows || 3} />
  }
  if (spec.type === 'checkbox') {
    return (
      <input
        {...common}
        type="checkbox"
        checked={!!value}
        onChange={e => onChange(e.target.checked)}
        className="rounded border-slate-300 text-brand-600 focus:ring-brand-500"
      />
    )
  }
  if (spec.type === 'select') {
    const options = normalizeOptions(spec.options)
    // Règle CLAUDE.md : tout dropdown susceptible de dépasser 10 options doit
    // offrir une recherche. `searchable` force le composant recherchable même
    // en dessous du seuil (cohérence avec la fiche détail de la même table).
    if (spec.searchable || options.length > 10) {
      return (
        <SearchableSelect
          value={value ?? ''}
          options={options}
          onChange={onChange}
          emptyOption="—"
          className="input w-full"
          size="sm"
          testId={spec.testId || `form-field-${spec.field}`}
        />
      )
    }
    return (
      <select {...common} value={value ?? ''} onChange={e => onChange(e.target.value)} className="select">
        <option value="">—</option>
        {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    )
  }
  const type = spec.type === 'number' || spec.type === 'currency' ? 'number'
    : spec.type === 'date' ? 'date'
      : spec.type === 'email' ? 'email'
        : 'text'
  const step = spec.step ?? (spec.type === 'currency' ? '0.01' : undefined)
  return (
    <input
      {...common}
      type={type}
      value={value ?? ''}
      onChange={e => onChange(e.target.value)}
      className="input"
      min={spec.min}
      step={step}
    />
  )
}

// Ligne du mode édition : afficher/masquer + obligatoire.
//
// `readOnly` : le champ existe bien sur la table mais l'ERP n'a pas le droit d'y
// écrire (champ Airtable en sens import). Il reste LISTÉ — le masquer laisserait
// croire qu'il n'existe pas — mais non cochable, avec la raison au survol.
function EditRow({ spec, onToggleVisible, onToggleRequired }) {
  const blocked = spec.locked || spec.readOnly
  return (
    <div className="flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-slate-50">
      <button
        type="button"
        onClick={onToggleVisible}
        disabled={blocked}
        title={spec.readOnly ? spec.readOnlyReason : spec.locked ? 'Champ toujours affiché' : (spec.visible ? 'Masquer du formulaire' : 'Ajouter au formulaire')}
        aria-label={spec.visible ? `Masquer ${spec.label}` : `Ajouter ${spec.label}`}
        data-form-edit-visible={spec.field}
        className={`p-1 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${spec.visible ? 'text-brand-600 hover:bg-brand-50' : 'text-slate-400 hover:bg-slate-100'}`}
      >
        {spec.readOnly ? <Lock size={15} /> : spec.visible ? <Eye size={15} /> : <EyeOff size={15} />}
      </button>
      <span className={`flex-1 text-sm ${spec.visible ? 'text-slate-700' : 'text-slate-400'}`} title={spec.readOnly ? spec.readOnlyReason : undefined}>
        {spec.label}
      </span>
      {spec.readOnly ? (
        <span className="text-xs text-slate-400" title={spec.readOnlyReason}>Lecture seule</span>
      ) : (
        <label className={`flex items-center gap-1.5 text-xs ${spec.visible && !spec.locked ? 'text-slate-600 cursor-pointer' : 'text-slate-300 cursor-not-allowed'}`}>
          <input
            type="checkbox"
            checked={spec.required}
            disabled={!spec.visible || spec.locked}
            onChange={onToggleRequired}
            data-form-edit-required={spec.field}
            className="rounded border-slate-300 text-brand-600 focus:ring-brand-500 disabled:opacity-40"
          />
          Obligatoire
        </label>
      )}
    </div>
  )
}

export function RecordForm({
  table,
  fields,
  initial,
  onSubmit,
  onClose,
  submitLabel = 'Enregistrer',
  savingLabel = 'Enregistrement...',
  columns = 1,
  extra,
  transform,
  includeAllFields = false,
}) {
  const { user } = useAuth()
  const canConfigure = user?.role === 'admin'
  const { config, setConfig, loaded: cfgLoaded } = useFormConfig(table)
  // Champs du registre en plus de ceux déclarés par la page — la route de
  // création de la table doit savoir les persister (cf. formFieldCatalog.js).
  const { catalog, loaded: catalogLoaded } = useFormFieldCatalog(includeAllFields ? table : null)
  const loaded = cfgLoaded && catalogLoaded
  // Portier des champs supprimés : un champ à la corbeille n'est plus proposé à
  // la création, ni dans le formulaire ni dans « Modifier le formulaire ».
  const gate = useFieldGate(table)
  const { status: cfgStatus, save: saveCfg } = useSaveStatus()

  const [values, setValues] = useState(() => initialValues(fields, initial))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const [search, setSearch] = useState('')

  // Le premier champ prend le focus quand la configuration est arrivée : la
  // modale, elle, a fait son autofocus alors que le formulaire affichait encore
  // son spinner (aucun champ à focuser à ce moment-là).
  const formRef = useRef(null)
  const focusedRef = useRef(false)
  useEffect(() => {
    if (!loaded || focusedRef.current || !formRef.current) return
    focusedRef.current = true
    const first = formRef.current.querySelector('input:not([type="hidden"]), textarea, select')
    if (first) first.focus()
  }, [loaded])

  // Défauts de tableDefs (libellé, choix d'un select). Le rapprochement entre
  // l'id de colonne du tableau et la colonne SQL du formulaire est fait par le
  // portier (lib/fieldGate.js), qui sert aussi les renommages.
  const meta = useMemo(() => {
    const byField = new Map()
    for (const c of (TABLE_COLUMN_META[table] || [])) byField.set(c.field ?? c.id, c)
    return { byField }
  }, [table])

  const allFields = useMemo(() => mergeCatalogFields(fields, catalog), [fields, catalog])

  const resolved = useMemo(() => {
    const withLabels = gate.keep(allFields).map(f => {
      const col = meta.byField.get(f.field)
      return {
        ...f,
        label: gate.labelFor(f.field, f.label || col?.label) || NBSP_LABEL_FALLBACK,
        // Les choix d'un select viennent de tableDefs quand la page ne les
        // redéclare pas — une seule source de vérité par table.
        options: f.options ?? col?.options,
      }
    })
    return resolveFormFields(withLabels, config)
  }, [allFields, config, meta, gate])

  const visibleFields = useMemo(() => resolved.filter(f => f.visible), [resolved])

  const setValue = useCallback((field, v) => setValues(prev => ({ ...prev, [field]: v })), [])

  // Autosave (règle CLAUDE.md) : chaque bascule persiste immédiatement, pas de
  // bouton « Enregistrer » dans le mode édition.
  const persist = useCallback((next) => {
    setConfig(next)
    saveCfg(() => api.formConfigs.save(table, next))
  }, [saveCfg, setConfig, table])

  const patchConfig = useCallback((field, patch) => {
    // Les champs en lecture seule ne sont pas persistés : leur état n'est pas un
    // choix de l'utilisateur, et il changerait tout seul si le sens de sync du
    // champ change.
    const current = resolved.filter(f => !f.readOnly)
      .map(f => ({ field: f.field, visible: f.visible, required: f.required }))
    persist(current.map(c => (c.field === field ? { ...c, ...patch } : c)))
  }, [resolved, persist])

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')

    for (const f of visibleFields) {
      if (f.required && isEmptyValue(values[f.field])) {
        setError(`Le champ « ${f.label} » est obligatoire.`)
        return
      }
    }

    // Un champ masqué n'envoie rien s'il est vide : certaines routes de création
    // insèrent toute clé présente dans le body (`k in req.body`), et une chaîne
    // vide venue d'un champ que l'utilisateur ne voit même pas n'a pas à écraser
    // le défaut serveur. Les valeurs par défaut non vides (ex. pays « Canada »)
    // continuent de partir, visibles ou non.
    const hiddenEmpty = new Set(resolved.filter(f => !f.visible && isEmptyValue(values[f.field]) && values[f.field] !== false).map(f => f.field))

    // Trim des champs texte au submit pour éviter des records pollués par des
    // espaces seuls.
    const payload = { ...values }
    for (const key of hiddenEmpty) delete payload[key]
    for (const f of allFields) {
      if (hiddenEmpty.has(f.field)) continue
      const shouldTrim = f.trim ?? (f.type === undefined || f.type === 'text' || f.type === 'textarea' || f.type === 'email' || f.type === 'url')
      if (shouldTrim && typeof payload[f.field] === 'string') payload[f.field] = payload[f.field].trim()
    }

    setSaving(true)
    try {
      await onSubmit(transform ? transform(payload) : payload)
      onClose?.()
    } catch (err) {
      setError(err.message || 'Échec de la création')
    } finally {
      setSaving(false)
    }
  }

  const editList = useMemo(() => {
    if (!search.trim()) return resolved
    const q = search.trim().toLowerCase()
    return resolved.filter(f => f.label.toLowerCase().includes(q))
  }, [resolved, search])

  const gridClass = columns === 2 ? 'grid grid-cols-2 gap-4' : 'space-y-4'

  return (
    <form ref={formRef} onSubmit={handleSubmit} className="space-y-4" data-record-form={table} data-record-form-ready={loaded ? '1' : undefined}>
      {canConfigure && loaded && (
        <div className="flex items-center justify-end gap-2 -mt-1">
          <SaveStatus status={cfgStatus} />
          <button
            type="button"
            onClick={() => { setEditing(v => !v); setSearch('') }}
            data-form-edit-toggle
            className={`inline-flex items-center gap-1.5 text-xs font-medium rounded-lg px-2 py-1 transition-colors ${editing ? 'bg-brand-50 text-brand-700' : 'text-slate-500 hover:text-brand-700 hover:bg-slate-50'}`}
          >
            {editing ? <><Check size={13} /> Terminé</> : <><Pencil size={13} /> Modifier le formulaire</>}
          </button>
        </div>
      )}

      {editing ? (
        <div data-form-edit-panel>
          <p className="text-xs text-slate-500 mb-2">
            Choisis les champs affichés dans ce formulaire et ceux qui sont obligatoires. Les changements s’appliquent à toute l’équipe.
          </p>
          {resolved.length > 10 && (
            <div className="relative mb-2">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400" />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                className="w-full pl-7 pr-2 py-1.5 text-xs border border-slate-200 rounded focus:outline-none focus:ring-1 focus:ring-brand-400"
              />
            </div>
          )}
          <div className="max-h-[50vh] overflow-y-auto divide-y divide-slate-100">
            {editList.length === 0
              ? <p className="text-xs text-slate-400 text-center py-3">Aucun champ</p>
              : editList.map(f => (
                <EditRow
                  key={f.field}
                  spec={f}
                  onToggleVisible={() => patchConfig(f.field, { visible: !f.visible, ...(f.visible ? { required: false } : {}) })}
                  onToggleRequired={() => patchConfig(f.field, { required: !f.required })}
                />
              ))}
          </div>
        </div>
      ) : (!loaded || !gate.ready) ? (
        // La configuration des champs et la liste des champs (portier) arrivent
        // du serveur : on attend plutôt que d'afficher les défauts une fraction
        // de seconde puis de les réorganiser sous les yeux de l'utilisateur — ou,
        // pire, de proposer un champ supprimé.
        <div className="py-10 flex justify-center"><Spinner /></div>
      ) : (
        <>
          <div className={gridClass}>
            {visibleFields.map(f => {
              const id = `rf-${table}-${f.field}`
              const spanClass = columns === 2 ? (f.span === 2 ? 'col-span-2' : '') : ''
              const control = f.input
                ? f.input({ value: values[f.field], onChange: v => setValue(f.field, v), values, setValues, id })
                : <GenericInput spec={f} value={values[f.field]} onChange={v => setValue(f.field, v)} id={id} />
              if (f.type === 'checkbox' && !f.input) {
                return (
                  <div key={f.field} className={spanClass}>
                    <label htmlFor={id} className="flex items-center gap-2 text-sm text-slate-700">
                      {control}
                      {f.label}{f.required && <span className="text-red-500"> *</span>}
                    </label>
                  </div>
                )
              }
              return (
                <div key={f.field} className={spanClass}>
                  <label htmlFor={id} className="label">{f.label}{f.required && <span className="text-red-500"> *</span>}</label>
                  {control}
                </div>
              )
            })}
          </div>
          {typeof extra === 'function' ? extra(values) : extra}
          {error && <p className="text-red-600 text-sm" data-form-error>{error}</p>}
          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary">Annuler</button>
            <button type="submit" disabled={saving || !loaded} className="btn-primary">{saving ? savingLabel : submitLabel}</button>
          </div>
        </>
      )}
    </form>
  )
}

export default RecordForm
