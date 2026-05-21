import { useState } from 'react'
import { Plus, Trash2, Save, FolderPlus } from 'lucide-react'
import { Modal } from './Modal.jsx'
import { FieldSelect } from './FilterRow.jsx'
import api from '../lib/api.js'
import { patchCachedRules } from '../lib/useFieldVisibilityRules.js'
import { evaluateConditions } from '../lib/fieldVisibility.js'

const OPERATORS = [
  { value: 'populated',  label: 'est rempli' },
  { value: 'empty',      label: 'est vide' },
  { value: 'equals',     label: '=' },
  { value: 'not_equals', label: '≠' },
]

function newLeaf(defaultField = '') {
  return { field: defaultField, operator: 'populated' }
}
function newGroup() {
  return { op: 'AND', rules: [newLeaf()] }
}
function emptyRule() {
  return { id: null, conditions: newGroup(), _dirty: true }
}

// Édition d'une feuille (condition simple).
function LeafEditor({ node, onChange, onRemove, fieldsForPicker }) {
  const needsValue = node.operator === 'equals' || node.operator === 'not_equals'
  return (
    <div className="flex items-center gap-2 py-1">
      <div className="flex-1 min-w-0">
        <FieldSelect
          columns={fieldsForPicker}
          value={node.field}
          onChange={f => onChange({ ...node, field: f })}
          cls="text-xs"
        />
      </div>
      <select
        value={node.operator}
        onChange={e => {
          const op = e.target.value
          const next = { ...node, operator: op }
          if (op !== 'equals' && op !== 'not_equals') delete next.value
          else if (next.value === undefined) next.value = ''
          onChange(next)
        }}
        className="select text-xs"
      >
        {OPERATORS.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {needsValue && (
        <input
          type="text"
          value={node.value ?? ''}
          onChange={e => onChange({ ...node, value: e.target.value })}
          className="input text-xs w-32"
          placeholder="valeur"
        />
      )}
      <button
        type="button"
        onClick={onRemove}
        className="p-1 text-slate-400 hover:text-red-600"
        title="Retirer cette condition"
      >
        <Trash2 size={13} />
      </button>
    </div>
  )
}

// Éditeur récursif d'un groupe AND/OR.
function GroupEditor({ node, onChange, onRemove, depth = 0, fieldsForPicker }) {
  function updateChild(idx, next) {
    const rules = node.rules.slice()
    rules[idx] = next
    onChange({ ...node, rules })
  }
  function removeChild(idx) {
    const rules = node.rules.filter((_, i) => i !== idx)
    if (rules.length === 0) {
      // Un groupe vide ne sert à rien — on le supprime si on peut
      if (onRemove) onRemove()
      else onChange({ ...node, rules: [newLeaf()] })
      return
    }
    onChange({ ...node, rules })
  }
  function addLeaf() {
    onChange({ ...node, rules: [...node.rules, newLeaf()] })
  }
  function addGroup() {
    if (depth >= 4) return
    onChange({ ...node, rules: [...node.rules, newGroup()] })
  }

  return (
    <div className={`rounded-lg border ${depth === 0 ? 'border-slate-200 bg-slate-50/50' : 'border-slate-200 bg-white'} p-2`}>
      <div className="flex items-center justify-between mb-1.5">
        <div className="inline-flex items-center gap-1 text-xs">
          <span className="text-slate-500">Combinaison :</span>
          <select
            value={node.op}
            onChange={e => onChange({ ...node, op: e.target.value })}
            className="select text-xs px-1.5 py-0.5"
          >
            <option value="AND">ET (toutes)</option>
            <option value="OR">OU (au moins une)</option>
          </select>
        </div>
        {onRemove && (
          <button
            type="button"
            onClick={onRemove}
            className="p-1 text-slate-400 hover:text-red-600"
            title="Retirer ce groupe"
          >
            <Trash2 size={12} />
          </button>
        )}
      </div>
      <div className="space-y-1 pl-2 border-l-2 border-slate-200">
        {node.rules.map((child, i) => (
          'op' in child ? (
            <GroupEditor
              key={i}
              node={child}
              onChange={next => updateChild(i, next)}
              onRemove={() => removeChild(i)}
              depth={depth + 1}
              fieldsForPicker={fieldsForPicker}
            />
          ) : (
            <LeafEditor
              key={i}
              node={child}
              onChange={next => updateChild(i, next)}
              onRemove={() => removeChild(i)}
              fieldsForPicker={fieldsForPicker}
            />
          )
        ))}
      </div>
      <div className="flex gap-2 mt-2 pt-1.5 border-t border-slate-200/60">
        <button
          type="button"
          onClick={addLeaf}
          className="inline-flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700"
        >
          <Plus size={11} /> Condition
        </button>
        {depth < 4 && (
          <button
            type="button"
            onClick={addGroup}
            className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
          >
            <FolderPlus size={11} /> Sous-groupe
          </button>
        )}
      </div>
    </div>
  )
}

// Éditeur d'une règle (un arbre racine). Affiche un aperçu d'évaluation
// contre le record courant pour aider l'utilisateur à vérifier.
function RuleEditor({ rule, onChange, onSave, onDelete, fieldsForPicker, record, saving }) {
  let evalResult = null
  try {
    evalResult = evaluateConditions(rule.conditions, record)
  } catch (e) {
    evalResult = null
  }
  return (
    <div className="rounded-lg border border-slate-200 p-3 bg-white">
      <GroupEditor
        node={rule.conditions}
        onChange={next => onChange({ ...rule, conditions: next, _dirty: true })}
        fieldsForPicker={fieldsForPicker}
      />
      <div className="flex items-center justify-between mt-3 pt-2 border-t border-slate-100">
        <div className="text-xs">
          {evalResult === true && (
            <span className="text-amber-600">
              ✓ Sur ce record : <strong>cacherait le champ</strong>
            </span>
          )}
          {evalResult === false && (
            <span className="text-slate-400">
              Sur ce record : ne cacherait pas
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {rule.id && (
            <button
              type="button"
              onClick={onDelete}
              disabled={saving}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 text-red-600 hover:bg-red-50 rounded disabled:opacity-50"
            >
              <Trash2 size={12} /> Supprimer
            </button>
          )}
          <button
            type="button"
            onClick={onSave}
            disabled={saving || !rule._dirty}
            className="inline-flex items-center gap-1 text-xs px-2.5 py-1 bg-brand-600 text-white rounded hover:bg-brand-700 disabled:opacity-50"
          >
            <Save size={12} /> {rule.id ? 'Enregistrer' : 'Créer la règle'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function FieldVisibilityRuleModal({
  isOpen,
  onClose,
  context,
  fieldId,
  fieldLabel,
  record,
  fields,
  existingRules,
  onChanged,
}) {
  // Copie locale éditable. Les règles existantes sont marquées comme non-dirty.
  const [rules, setRules] = useState(() =>
    existingRules.map(r => ({ ...r, _dirty: false }))
  )
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  // Construit la liste de champs disponibles pour les pickers. Si `fields`
  // n'a pas été fourni, on tombe sur les clés du record. On enrichit avec les
  // labels de tableDefs si possible — déjà fait par le caller normalement.
  const fieldsForPicker = (fields && fields.length > 0)
    ? fields
    : (record ? Object.keys(record).map(k => ({ id: k, field: k, label: k })) : [])

  function setRule(idx, next) {
    setRules(rules.map((r, i) => i === idx ? next : r))
  }
  function addRule() {
    // Pré-remplit avec le fieldId du champ qu'on cherche le plus souvent à
    // tester (ex. quand on configure « Envoyée » on veut probablement tester
    // « subscription_id »). On ne devine pas — on laisse l'utilisateur choisir.
    setRules([...rules, emptyRule()])
  }
  function removeLocalRule(idx) {
    setRules(rules.filter((_, i) => i !== idx))
  }

  async function saveRule(idx) {
    const r = rules[idx]
    setSaving(true)
    setError(null)
    try {
      if (r.id) {
        const updated = await api.fieldVisibilityRules.update(r.id, { conditions: r.conditions })
        setRule(idx, { ...updated, _dirty: false })
        patchCachedRules(context, list => list.map(x => x.id === updated.id ? updated : x))
      } else {
        const created = await api.fieldVisibilityRules.create({
          context,
          field_id: fieldId,
          conditions: r.conditions,
        })
        setRule(idx, { ...created, _dirty: false })
        patchCachedRules(context, list => [...list, created])
      }
      onChanged?.()
    } catch (e) {
      setError(e?.message || 'Erreur à la sauvegarde')
    } finally {
      setSaving(false)
    }
  }

  async function deleteRule(idx) {
    const r = rules[idx]
    if (!r.id) {
      removeLocalRule(idx)
      return
    }
    if (!confirm('Supprimer cette règle ?')) return
    setSaving(true)
    setError(null)
    try {
      await api.fieldVisibilityRules.delete(r.id)
      removeLocalRule(idx)
      patchCachedRules(context, list => list.filter(x => x.id !== r.id))
      onChanged?.()
    } catch (e) {
      setError(e?.message || 'Erreur à la suppression')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Visibilité du champ « ${fieldLabel} »`} size="lg">
      <p className="text-sm text-slate-600 mb-1">
        Le champ sera masqué dès qu'<strong>au moins une règle</strong> évalue à vrai.
      </p>
      <p className="text-xs text-slate-400 mb-4">
        Contexte : <code className="px-1 py-0.5 bg-slate-100 rounded">{context}</code>{' '}
        · Field ID : <code className="px-1 py-0.5 bg-slate-100 rounded">{fieldId}</code>
      </p>

      {error && (
        <div className="mb-3 p-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded">
          {error}
        </div>
      )}

      <div className="space-y-3">
        {rules.length === 0 ? (
          <p className="text-sm text-slate-400 italic text-center py-4">
            Aucune règle. Le champ est toujours visible.
          </p>
        ) : rules.map((r, i) => (
          <RuleEditor
            key={r.id || `new-${i}`}
            rule={r}
            onChange={next => setRule(i, next)}
            onSave={() => saveRule(i)}
            onDelete={() => deleteRule(i)}
            fieldsForPicker={fieldsForPicker}
            record={record}
            saving={saving}
          />
        ))}
      </div>

      <div className="mt-4 flex justify-between items-center pt-3 border-t border-slate-200">
        <button
          type="button"
          onClick={addRule}
          className="inline-flex items-center gap-1.5 text-sm text-brand-600 hover:text-brand-700"
        >
          <Plus size={14} /> Ajouter une règle
        </button>
        <button
          type="button"
          onClick={onClose}
          className="btn-secondary text-sm"
        >
          Fermer
        </button>
      </div>
    </Modal>
  )
}
