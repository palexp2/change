import { useState, useEffect, useRef } from 'react'
import {
  X, Plus, Type, AlignLeft, Hash, DollarSign, Percent,
  Calendar, Clock, ChevronDown, List, CheckSquare, Link2,
  User, Phone, Mail, ExternalLink, Calculator, Search,
  Paperclip, ToggleLeft, GripVertical, AlertCircle, Loader2
} from 'lucide-react'
import { baseAPI } from '../../hooks/useBaseAPI.js'

// ── Constants ─────────────────────────────────────────────────────────────────

const READ_ONLY_TYPES = ['formula', 'lookup', 'rollup', 'created_at', 'updated_at', 'autonumber']

const FIELD_TYPE_LABELS = {
  text: 'Texte court',
  long_text: 'Texte long',
  number: 'Nombre',
  currency: 'Devise',
  percent: 'Pourcentage',
  date: 'Date',
  datetime: 'Date et heure',
  select: 'Sélection unique',
  multi_select: 'Sélection multiple',
  boolean: 'Case à cocher',
  link: 'Lien vers une table',
  user: 'Utilisateur',
  phone: 'Téléphone',
  email: 'Email',
  url: 'URL',
  formula: 'Formule',
  rollup: 'Rollup',
  lookup: 'Lookup',
  autonumber: 'Auto-numéro',
  attachment: 'Fichier',
  created_at: 'Date création',
  updated_at: 'Date modification',
}

const FIELD_CATEGORIES = [
  {
    label: 'Texte',
    types: [
      { type: 'text', label: 'Texte court', desc: 'Nom, titre, etc.', icon: Type },
      { type: 'long_text', label: 'Texte long', desc: 'Description, notes', icon: AlignLeft },
    ]
  },
  {
    label: 'Nombre',
    types: [
      { type: 'number', label: 'Nombre', desc: 'Quantité, score', icon: Hash },
      { type: 'currency', label: 'Devise', desc: 'Montant en $', icon: DollarSign },
      { type: 'percent', label: 'Pourcentage', desc: '0–100%', icon: Percent },
    ]
  },
  {
    label: 'Date & Heure',
    types: [
      { type: 'date', label: 'Date', desc: 'Jour/Mois/Année', icon: Calendar },
      { type: 'datetime', label: 'Date et heure', desc: 'Avec horodatage', icon: Clock },
    ]
  },
  {
    label: 'Choix',
    types: [
      { type: 'select', label: 'Sélection unique', desc: 'Un seul choix', icon: ChevronDown },
      { type: 'multi_select', label: 'Sélection multiple', desc: 'Plusieurs choix', icon: List },
      { type: 'boolean', label: 'Case à cocher', desc: 'Oui / Non', icon: CheckSquare },
    ]
  },
  {
    label: 'Relations',
    types: [
      { type: 'link', label: 'Lien vers une table', desc: 'Relation entre tables', icon: Link2 },
      { type: 'user', label: 'Utilisateur', desc: "Membre de l'équipe", icon: User },
    ]
  },
  {
    label: 'Contact',
    types: [
      { type: 'phone', label: 'Téléphone', desc: 'Numéro cliquable', icon: Phone },
      { type: 'email', label: 'Email', desc: 'Adresse email', icon: Mail },
      { type: 'url', label: 'URL', desc: 'Lien web', icon: ExternalLink },
    ]
  },
  {
    label: 'Avancé',
    types: [
      { type: 'formula', label: 'Formule', desc: 'Calcul automatique', icon: Calculator },
      { type: 'rollup', label: 'Rollup', desc: 'Agrégation de liens', icon: Calculator },
      { type: 'lookup', label: 'Lookup', desc: "Valeur d'un lien", icon: Search },
      { type: 'autonumber', label: 'Auto-numéro', desc: 'Séquence auto', icon: Hash },
      { type: 'attachment', label: 'Fichier', desc: 'Documents, images', icon: Paperclip },
    ]
  },
]

const SELECT_COLORS = ['gray', 'red', 'orange', 'yellow', 'green', 'blue', 'indigo', 'purple', 'pink']

// ── FieldTypePicker ───────────────────────────────────────────────────────────

function FieldTypePicker({ value, onChange }) {
  return (
    <div className="space-y-3">
      {FIELD_CATEGORIES.map(cat => (
        <div key={cat.label}>
          <p className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1.5">
            {cat.label}
          </p>
          <div className="grid grid-cols-2 gap-1.5">
            {cat.types.map(({ type, label, desc, icon: Icon }) => (
              <button
                key={type}
                type="button"
                onClick={() => onChange(type)}
                className={`flex items-start gap-2.5 p-2.5 rounded-lg border text-left transition-colors ${
                  value === type
                    ? 'border-indigo-400 bg-indigo-50 text-indigo-700'
                    : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50 text-slate-700'
                }`}
              >
                <Icon size={15} className="shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <p className="text-xs font-medium leading-tight truncate">{label}</p>
                  <p className="text-xs text-slate-400 leading-tight truncate">{desc}</p>
                </div>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── SelectOptionsEditor ───────────────────────────────────────────────────────

function SelectOptionsEditor({ options, onChange }) {
  const choices = options?.choices || []
  const [draggingIdx, setDraggingIdx] = useState(null)
  const [dragOverIdx, setDragOverIdx] = useState(null)

  function addChoice() {
    const next = [...choices, { value: `option_${Date.now()}`, label: 'Nouvelle option', color: 'gray' }]
    onChange({ ...options, choices: next })
  }

  function updateChoice(i, key, val) {
    const next = choices.map((c, ci) => ci === i ? { ...c, [key]: val } : c)
    onChange({ ...options, choices: next })
  }

  function removeChoice(i) {
    onChange({ ...options, choices: choices.filter((_, ci) => ci !== i) })
  }

  function handleDrop(targetIdx) {
    if (draggingIdx === null || draggingIdx === targetIdx) return
    const next = [...choices]
    const [moved] = next.splice(draggingIdx, 1)
    next.splice(targetIdx, 0, moved)
    onChange({ ...options, choices: next })
    setDraggingIdx(null)
    setDragOverIdx(null)
  }

  return (
    <div>
      <div className="space-y-1.5 mb-2">
        {choices.map((c, i) => (
          <div
            key={i}
            draggable
            onDragStart={() => setDraggingIdx(i)}
            onDragOver={e => { e.preventDefault(); setDragOverIdx(i) }}
            onDrop={() => handleDrop(i)}
            onDragEnd={() => { setDraggingIdx(null); setDragOverIdx(null) }}
            className={`flex items-center gap-2 p-1 rounded border ${
              dragOverIdx === i ? 'border-indigo-300 bg-indigo-50' : 'border-transparent'
            }`}
          >
            <GripVertical size={13} className="text-slate-300 cursor-grab shrink-0" />
            <input
              type="text"
              value={c.label}
              onChange={e => updateChoice(i, 'label', e.target.value)}
              className="flex-1 text-sm border border-slate-200 rounded px-2 py-1 focus:ring-1 focus:ring-indigo-400 focus:border-indigo-400 outline-none"
              placeholder="Libellé"
            />
            <div className="flex gap-0.5">
              {SELECT_COLORS.map(col => (
                <button
                  key={col}
                  type="button"
                  onClick={() => updateChoice(i, 'color', col)}
                  className={`w-4 h-4 rounded-full bg-${col}-400 shrink-0 transition-transform ${
                    c.color === col ? 'scale-125 ring-2 ring-offset-1 ring-${col}-400' : 'hover:scale-110'
                  }`}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={() => removeChoice(i)}
              className="text-slate-400 hover:text-red-500 shrink-0"
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={addChoice}
        className="text-xs text-indigo-600 hover:text-indigo-700 flex items-center gap-1"
      >
        <Plus size={12} /> Ajouter un choix
      </button>
    </div>
  )
}

// ── LinkFieldOptions ──────────────────────────────────────────────────────────

function LinkFieldOptions({ options, onChange }) {
  const [tables, setTables] = useState([])
  useEffect(() => {
    baseAPI.tables().then(res => setTables(res.tables || []))
  }, [])

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-slate-700 mb-1">Table cible</label>
        <select
          value={options?.target_table_id || ''}
          onChange={e => onChange({ ...options, target_table_id: e.target.value })}
          className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-400 focus:border-transparent outline-none"
        >
          <option value="">— choisir une table —</option>
          {tables.map(t => (
            <option key={t.id} value={t.id}>{t.name}</option>
          ))}
        </select>
      </div>
      <label className="flex items-center gap-2 text-sm cursor-pointer">
        <input
          type="checkbox"
          checked={!!options?.allow_multiple}
          onChange={e => onChange({ ...options, allow_multiple: e.target.checked })}
          className="w-4 h-4 rounded border-slate-300 text-indigo-600"
        />
        Autoriser les liens multiples
      </label>
      <p className="text-xs text-slate-400 bg-slate-50 rounded-lg px-3 py-2">
        Un champ miroir sera créé automatiquement dans la table cible.
      </p>
    </div>
  )
}

// ── FormulaEditor ─────────────────────────────────────────────────────────────

function FormulaEditor({ options, onChange, fields }) {
  const textareaRef = useRef()
  const [showHelp, setShowHelp] = useState(false)

  function insertAtCursor(text) {
    const el = textareaRef.current
    if (!el) return
    const start = el.selectionStart
    const end = el.selectionEnd
    const val = options?.formula || ''
    const next = val.slice(0, start) + text + val.slice(end)
    onChange({ ...options, formula: next })
    setTimeout(() => {
      el.focus()
      el.setSelectionRange(start + text.length, start + text.length)
    }, 0)
  }

  return (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-slate-700 mb-1">Expression</label>
      <textarea
        ref={textareaRef}
        value={options?.formula || ''}
        onChange={e => onChange({ ...options, formula: e.target.value })}
        rows={3}
        placeholder="Ex: IF({prix} > 1000, 'VIP', 'Standard')"
        className="w-full text-sm font-mono border border-slate-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-400 focus:border-transparent outline-none resize-none"
      />

      <button
        type="button"
        onClick={() => setShowHelp(s => !s)}
        className="text-xs text-indigo-600 hover:text-indigo-700"
      >
        {showHelp ? "Masquer l'aide" : "Afficher l'aide syntaxe"}
      </button>

      {showHelp && (
        <div className="text-xs text-slate-500 bg-slate-50 rounded-lg p-3 space-y-1">
          <p>Référencez les champs avec <code className="text-indigo-600">{'{nom_du_champ}'}</code></p>
          <p><strong>Fonctions :</strong> UPPER(), LOWER(), ROUND(), IF(), CONCAT(), TODAY(), NOW(), LEN(), TRIM()</p>
          <p><strong>Opérateurs :</strong> + - * / % == != &lt; &gt; &amp;&amp; ||</p>
        </div>
      )}

      {fields.filter(f => !f.deleted_at).length > 0 && (
        <div>
          <p className="text-xs text-slate-500 mb-1">Champs disponibles :</p>
          <div className="flex flex-wrap gap-1">
            {fields.filter(f => !f.deleted_at).map(f => (
              <button
                key={f.key}
                type="button"
                onClick={() => insertAtCursor(`{${f.key}}`)}
                className="text-xs px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded hover:bg-indigo-100 hover:text-indigo-700"
              >
                {f.name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── RollupOptions ─────────────────────────────────────────────────────────────

function RollupOptions({ options, onChange, fields }) {
  const [linkedFields, setLinkedFields] = useState([])
  const linkFields = fields.filter(f => !f.deleted_at && f.type === 'link')
  const selectedLink = linkFields.find(f => f.key === options?.link_field_key)

  useEffect(() => {
    if (!selectedLink?.options?.target_table_id) { setLinkedFields([]); return }
    baseAPI.fields(selectedLink.options.target_table_id)
      .then(res => setLinkedFields(res.fields || []))
      .catch(() => setLinkedFields([]))
  }, [selectedLink?.options?.target_table_id])

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-slate-700 mb-1">Champ lien</label>
        <select
          value={options?.link_field_key || ''}
          onChange={e => onChange({ ...options, link_field_key: e.target.value, target_field_key: '' })}
          className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-400 outline-none"
        >
          <option value="">— choisir —</option>
          {linkFields.map(f => <option key={f.key} value={f.key}>{f.name}</option>)}
        </select>
      </div>
      <div>
        <label className="block text-xs font-medium text-slate-700 mb-1">Champ cible</label>
        <select
          value={options?.target_field_key || ''}
          onChange={e => onChange({ ...options, target_field_key: e.target.value })}
          className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-400 outline-none"
          disabled={!linkedFields.length}
        >
          <option value="">— choisir —</option>
          {linkedFields.map(f => <option key={f.key} value={f.key}>{f.name}</option>)}
        </select>
      </div>
      <div>
        <label className="block text-xs font-medium text-slate-700 mb-1">Agrégat</label>
        <select
          value={options?.aggregate || 'COUNT'}
          onChange={e => onChange({ ...options, aggregate: e.target.value })}
          className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-400 outline-none"
        >
          <option value="COUNT">Nombre (COUNT)</option>
          <option value="SUM">Somme (SUM)</option>
          <option value="AVG">Moyenne (AVG)</option>
          <option value="MIN">Minimum (MIN)</option>
          <option value="MAX">Maximum (MAX)</option>
          <option value="CONCAT">Concaténer (CONCAT)</option>
        </select>
      </div>
    </div>
  )
}

// ── LookupOptions ─────────────────────────────────────────────────────────────

function LookupOptions({ options, onChange, fields }) {
  const [linkedFields, setLinkedFields] = useState([])
  const linkFields = fields.filter(f => !f.deleted_at && f.type === 'link')
  const selectedLink = linkFields.find(f => f.key === options?.link_field_key)

  useEffect(() => {
    if (!selectedLink?.options?.target_table_id) { setLinkedFields([]); return }
    baseAPI.fields(selectedLink.options.target_table_id)
      .then(res => setLinkedFields(res.fields || []))
      .catch(() => setLinkedFields([]))
  }, [selectedLink?.options?.target_table_id])

  return (
    <div className="space-y-3">
      <div>
        <label className="block text-xs font-medium text-slate-700 mb-1">Champ lien</label>
        <select
          value={options?.link_field_key || ''}
          onChange={e => onChange({ ...options, link_field_key: e.target.value, target_field_key: '' })}
          className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-400 outline-none"
        >
          <option value="">— choisir —</option>
          {linkFields.map(f => <option key={f.key} value={f.key}>{f.name}</option>)}
        </select>
      </div>
      <div>
        <label className="block text-xs font-medium text-slate-700 mb-1">Champ cible</label>
        <select
          value={options?.target_field_key || ''}
          onChange={e => onChange({ ...options, target_field_key: e.target.value })}
          className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-400 outline-none"
          disabled={!linkedFields.length}
        >
          <option value="">— choisir —</option>
          {linkedFields.map(f => <option key={f.key} value={f.key}>{f.name}</option>)}
        </select>
      </div>
    </div>
  )
}

// ── FieldTypeOptions ──────────────────────────────────────────────────────────

function FieldTypeOptions({ type, options, onChange, fields }) {
  switch (type) {
    case 'select':
    case 'multi_select':
      return (
        <div>
          <label className="block text-xs font-medium text-slate-700 mb-2">Options</label>
          <SelectOptionsEditor options={options} onChange={onChange} />
        </div>
      )
    case 'link':
      return <LinkFieldOptions options={options} onChange={onChange} />
    case 'formula':
      return <FormulaEditor options={options} onChange={onChange} fields={fields} />
    case 'rollup':
      return <RollupOptions options={options} onChange={onChange} fields={fields} />
    case 'lookup':
      return <LookupOptions options={options} onChange={onChange} fields={fields} />
    case 'currency':
      return (
        <div>
          <label className="block text-xs font-medium text-slate-700 mb-1">Symbole</label>
          <select
            value={options?.symbol || 'CAD'}
            onChange={e => onChange({ ...options, symbol: e.target.value })}
            className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-400 outline-none"
          >
            <option value="CAD">$ CAD</option>
            <option value="USD">$ USD</option>
            <option value="EUR">€ EUR</option>
          </select>
        </div>
      )
    default:
      return null
  }
}

// ── FieldConfigPanel (export) ─────────────────────────────────────────────────

export function FieldConfigPanel({ tableId, field, allFields = [], onClose, onSaved }) {
  const [name, setName] = useState(field?.name || '')
  const [type, setType] = useState(field?.type || 'text')
  const [required, setRequired] = useState(!!field?.required)
  const [options, setOptions] = useState(field?.options || {})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  // For creation, show type picker; for edition, show type label
  const isCreating = !field
  const isPrimary = !!field?.is_primary
  const showRequired = !isPrimary && !READ_ONLY_TYPES.includes(type)

  async function handleSave() {
    if (!name.trim()) { setError('Le nom est requis'); return }
    setSaving(true)
    setError('')
    try {
      const payload = {
        name: name.trim(),
        required: required ? 1 : 0,
        options,
      }
      if (isCreating) {
        payload.type = type
        await baseAPI.createField(tableId, payload)
      } else {
        // For edit, only name/required/options can change (type is locked)
        await baseAPI.updateField(tableId, field.id, payload)
      }
      onSaved?.()
      onClose()
    } catch (e) {
      setError(e.message || 'Erreur lors de la sauvegarde')
    } finally {
      setSaving(false)
    }
  }

  async function handleDelete() {
    const isLink = field.type === 'link'
    const message = isLink
      ? `Supprimer "${field.name}" et son champ miroir dans la table liée ?\nLes données resteront en base mais ne seront plus visibles.`
      : `Supprimer "${field.name}" ?\nLes données resteront en base mais ne seront plus visibles.`
    if (!confirm(message)) return
    setSaving(true)
    try {
      await baseAPI.deleteField(tableId, field.id)
      onSaved?.()
      onClose()
    } catch (e) {
      setError(e.message || 'Erreur lors de la suppression')
      setSaving(false)
    }
  }

  return (
    <div
      className="fixed inset-0 bg-black/30 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl w-[480px] max-h-[85vh] flex flex-col"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 shrink-0">
          <h3 className="font-semibold text-slate-900">
            {isCreating ? 'Nouveau champ' : 'Modifier le champ'}
          </h3>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 p-1 rounded">
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Nom</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              autoFocus
              placeholder="Nom du champ"
              className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-400 focus:border-transparent outline-none"
            />
          </div>

          {/* Type */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">Type</label>
            {isPrimary ? (
              // Primary field: limited type choice
              <select
                value={type}
                onChange={e => setType(e.target.value)}
                className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm focus:ring-2 focus:ring-indigo-400 outline-none"
              >
                {['text', 'number', 'autonumber', 'formula'].map(t => (
                  <option key={t} value={t}>{FIELD_TYPE_LABELS[t]}</option>
                ))}
              </select>
            ) : !isCreating ? (
              // Editing: type is locked
              <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 rounded-lg text-sm text-slate-600 border border-slate-200">
                <span>{FIELD_TYPE_LABELS[type] || type}</span>
                <span className="text-xs text-slate-400 ml-auto">(non modifiable)</span>
              </div>
            ) : (
              // Creating: full type picker
              <FieldTypePicker value={type} onChange={setType} />
            )}
          </div>

          {/* Type-specific options */}
          <FieldTypeOptions
            type={type}
            options={options}
            onChange={setOptions}
            fields={allFields}
          />

          {/* Required */}
          {showRequired && (
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={required}
                onChange={e => setRequired(e.target.checked)}
                className="w-4 h-4 rounded border-slate-300 text-indigo-600"
              />
              Champ obligatoire
            </label>
          )}

          {error && (
            <div className="flex items-center gap-2 text-red-600 bg-red-50 px-3 py-2 rounded-lg text-sm">
              <AlertCircle size={14} /> {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-slate-200 bg-slate-50 shrink-0">
          {field && !isPrimary ? (
            <button
              onClick={handleDelete}
              disabled={saving}
              className="text-sm text-red-600 hover:text-red-700 disabled:opacity-50"
            >
              Supprimer ce champ
            </button>
          ) : (
            <div />
          )}
          <div className="flex gap-2">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg"
            >
              Annuler
            </button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 text-sm text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg disabled:opacity-50 flex items-center gap-2"
            >
              {saving && <Loader2 size={13} className="animate-spin" />}
              {isCreating ? 'Créer le champ' : 'Enregistrer'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
