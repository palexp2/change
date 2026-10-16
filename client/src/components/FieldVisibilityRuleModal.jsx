import { useState, useRef, useEffect } from 'react'
import { Plus, Trash2, Save, FolderPlus, Eye, EyeOff } from 'lucide-react'
import { Modal } from './Modal.jsx'
import { FieldSelect } from './FilterRow.jsx'
import { ChoiceSelect } from './ChoiceSelect.jsx'
import { MultiSelectField } from './MultiSelectField.jsx'
import { useConfirm } from './ConfirmProvider.jsx'
import api from '../lib/api.js'
import { patchCachedRules } from '../lib/useFieldVisibilityRules.js'
import { evaluateConditions, isChecked } from '../lib/fieldVisibility.js'

const OPERATORS = [
  { value: 'populated',  label: 'est rempli' },
  { value: 'empty',      label: 'est vide' },
  { value: 'equals',     label: '=' },
  { value: 'not_equals', label: '≠' },
]
// Réservés aux champs Sélection (le champ porte `choices`) : value = tableau.
const LIST_OPERATORS = [
  { value: 'any_of',  label: 'est l\'un des' },
  { value: 'none_of', label: 'n\'est aucun des' },
]
const isListOp = op => op === 'any_of' || op === 'none_of'

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
  // Champ Sélection : choix en pastilles de leur couleur (fournis par l'appelant).
  const picked = fieldsForPicker.find(f => (f.field || f.id) === node.field)
  const choices = picked?.choices || null
  // Case à cocher : la valeur testée est vrai/faux, saisie par une case.
  const checkbox = !!picked?.checkbox
  // Ancienne valeur texte (« True ») → booléen, pour que case et test concordent.
  useEffect(() => {
    if (checkbox && needsValue && typeof node.value !== 'boolean') onChange({ ...node, value: isChecked(node.value) })
  }, [checkbox, needsValue, node, onChange])
  const operators = choices ? [...OPERATORS, ...LIST_OPERATORS] : OPERATORS
  const colorOf = v => choices?.find(c => c.value === v)?.color
  const listValue = Array.isArray(node.value) ? node.value : (node.value ? [String(node.value)] : [])
  return (
    <div className="grid grid-cols-[minmax(0,1.4fr)_8.5rem_minmax(0,1fr)_1.75rem] items-center gap-2">
      <div className="min-w-0 flex">
        <FieldSelect
          columns={fieldsForPicker}
          value={node.field}
          onChange={f => {
            const next = { ...node, field: f }
            // Un opérateur de liste n'a de sens que sur un champ Sélection.
            const nextChoices = fieldsForPicker.find(x => (x.field || x.id) === f)?.choices
            if (isListOp(next.operator) && !nextChoices) { next.operator = 'equals'; next.value = '' }
            onChange(next)
          }}
          cls="text-sm"
        />
      </div>
      <select
        value={node.operator}
        onChange={e => {
          const op = e.target.value
          const next = { ...node, operator: op }
          if (isListOp(op)) next.value = Array.isArray(node.value) ? node.value : (node.value ? [String(node.value)] : [])
          else if (op !== 'equals' && op !== 'not_equals') delete next.value
          else if (next.value === undefined || Array.isArray(next.value)) next.value = Array.isArray(next.value) ? (next.value[0] ?? '') : ''
          onChange(next)
        }}
        className="select select-caret text-sm"
      >
        {operators.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {isListOp(node.operator) ? (
        <div className="min-w-0">
          <MultiSelectField
            value={listValue}
            options={(choices || []).map(c => c.value)}
            onChange={vals => onChange({ ...node, value: vals })}
            allowCreate={false}
            colorOf={colorOf}
          />
        </div>
      ) : needsValue && checkbox ? (
        <label className="flex items-center h-full cursor-pointer">
          <input
            type="checkbox"
            className="rounded"
            checked={node.value === true}
            onChange={e => onChange({ ...node, value: e.target.checked })}
          />
        </label>
      ) : needsValue && choices ? (
        <div className="min-w-0">
          <ChoiceSelect
            value={node.value ?? ''}
            choices={choices}
            onChange={v => onChange({ ...node, value: v })}
            className="input text-sm w-full"
          />
        </div>
      ) : needsValue ? (
        <input
          type="text"
          value={node.value ?? ''}
          onChange={e => onChange({ ...node, value: e.target.value })}
          className="input text-sm min-w-0"
        />
      ) : <span />}
      <button
        type="button"
        onClick={onRemove}
        className="p-1 rounded text-slate-300 hover:text-red-600 hover:bg-red-50"
        title="Retirer cette condition"
      >
        <Trash2 size={14} />
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
    <div className={depth === 0 ? '' : 'rounded-lg border border-slate-200 bg-slate-50/60 p-2.5'}>
      <div className={`flex items-center justify-between ${node.rules.length > 1 || onRemove ? 'mb-2' : ''}`}>
        {node.rules.length > 1 ? (
          <select
            value={node.op}
            onChange={e => onChange({ ...node, op: e.target.value })}
            className="select select-caret text-xs !w-auto py-1"
          >
            <option value="AND">Toutes les conditions</option>
            <option value="OR">Au moins une condition</option>
          </select>
        ) : <span />}
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
      <div className="space-y-2">
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
      <div className="flex gap-3 mt-2">
        <button
          type="button"
          onClick={addLeaf}
          className="inline-flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700"
        >
          <Plus size={12} /> Condition
        </button>
        {depth < 4 && (
          <button
            type="button"
            onClick={addGroup}
            className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700"
          >
            <FolderPlus size={12} /> Groupe
          </button>
        )}
      </div>
    </div>
  )
}

// Éditeur d'une règle (un arbre racine). Affiche un aperçu d'évaluation
// contre le record courant pour aider l'utilisateur à vérifier.
//
// Règle existante (rule.id présent) → autosave (pas de bouton Enregistrer,
// cf. règle « autosave partout » du CLAUDE.md). On affiche juste un indicateur
// d'état (Enregistrement… / Enregistré / Échec).
// Règle nouvelle (sans id) → création explicite via bouton « Créer la règle »
// (exception autosave : pas encore d'id en DB).
function RuleEditor({ rule, onChange, onCreate, onDelete, fieldsForPicker, record, status, busy }) {
  let evalResult = null
  try {
    evalResult = evaluateConditions(rule.conditions, record)
  } catch {
    evalResult = null
  }
  const isNew = !rule.id
  return (
    <div className="rounded-xl border border-slate-200 p-4 bg-white">
      <GroupEditor
        node={rule.conditions}
        onChange={next => onChange({ ...rule, conditions: next, _dirty: true })}
        fieldsForPicker={fieldsForPicker}
      />
      <div className="flex items-center justify-between mt-3 pt-3 border-t border-slate-100">
        <div className="text-xs">
          {evalResult === true && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">
              <Eye size={11} /> Vraie ici
            </span>
          )}
          {evalResult === false && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">
              <EyeOff size={11} /> Fausse ici
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
          {!isNew && status === 'saving' && (
            <span data-testid="rule-autosave-status" className="text-xs text-slate-400">Enregistrement…</span>
          )}
          {!isNew && status === 'saved' && (
            <span data-testid="rule-autosave-status" className="text-xs text-emerald-600">Enregistré ✓</span>
          )}
          {!isNew && status === 'error' && (
            <span data-testid="rule-autosave-status" className="text-xs text-red-600">Échec — réessayez</span>
          )}
          {rule.id && (
            <button
              type="button"
              onClick={onDelete}
              disabled={busy}
              className="inline-flex items-center gap-1 text-xs px-2 py-1 text-red-600 hover:bg-red-50 rounded disabled:opacity-50"
            >
              <Trash2 size={12} /> Supprimer
            </button>
          )}
          {isNew && (
            <button
              type="button"
              onClick={onCreate}
              disabled={busy || !rule._dirty}
              className="inline-flex items-center gap-1 text-xs px-2.5 py-1 bg-brand-600 text-white rounded hover:bg-brand-700 disabled:opacity-50"
            >
              <Save size={12} /> Créer la règle
            </button>
          )}
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
  // État de création d'une nouvelle règle (bouton explicite).
  const [creating, setCreating] = useState(false)
  // État d'autosave par règle existante : id → 'editing' | 'saving' | 'saved' | 'error'.
  const [statusById, setStatusById] = useState({})
  const [error, setError] = useState(null)
  const confirm = useConfirm()

  // Miroir des règles pour que les autosaves différés lisent toujours la valeur
  // courante (et non une closure périmée).
  const rulesRef = useRef(rules)
  useEffect(() => { rulesRef.current = rules }, [rules])
  // Timers de debounce par id de règle.
  const timersRef = useRef({})
  // Nettoie les timers en suspens au démontage.
  useEffect(() => () => {
    Object.values(timersRef.current).forEach(t => t && clearTimeout(t))
  }, [])

  // Construit la liste de champs disponibles pour les pickers. Si `fields`
  // n'a pas été fourni, on tombe sur les clés du record. On enrichit avec les
  // labels de tableDefs si possible — déjà fait par le caller normalement.
  const fieldsForPicker = (fields && fields.length > 0)
    ? fields
    : (record ? Object.keys(record).map(k => ({ id: k, field: k, label: k })) : [])

  function setRule(idx, next) {
    setRules(prev => prev.map((r, i) => i === idx ? next : r))
  }
  function addRule() {
    // Pré-remplit avec le fieldId du champ qu'on cherche le plus souvent à
    // tester (ex. quand on configure « Envoyée » on veut probablement tester
    // « subscription_id »). On ne devine pas — on laisse l'utilisateur choisir.
    setRules(prev => [...prev, emptyRule()])
  }
  function removeLocalRule(idx) {
    setRules(prev => prev.filter((_, i) => i !== idx))
  }

  // Édition d'une règle. Pour une règle existante (id en DB), on débounce un
  // autosave ; pour une nouvelle règle, on attend le clic « Créer la règle ».
  function handleRuleChange(idx, next) {
    setRule(idx, next)
    if (next.id) {
      setStatusById(s => ({ ...s, [next.id]: 'editing' }))
      scheduleAutosave(next.id)
    }
  }

  function scheduleAutosave(ruleId) {
    if (timersRef.current[ruleId]) clearTimeout(timersRef.current[ruleId])
    timersRef.current[ruleId] = setTimeout(() => {
      timersRef.current[ruleId] = null
      autosaveRule(ruleId)
    }, 500)
  }

  async function autosaveRule(ruleId) {
    const r = rulesRef.current.find(x => x.id === ruleId)
    if (!r || !r._dirty) return
    const savedConditions = r.conditions
    setStatusById(s => ({ ...s, [ruleId]: 'saving' }))
    setError(null)
    try {
      const updated = await api.fieldVisibilityRules.update(ruleId, { conditions: savedConditions })
      // Si l'utilisateur a continué d'éditer pendant la requête, on garde ses
      // conditions courantes (un nouvel autosave est déjà planifié) et on ne
      // touche pas au flag _dirty.
      setRules(prev => prev.map(x => {
        if (x.id !== ruleId) return x
        const stillDirty = JSON.stringify(x.conditions) !== JSON.stringify(savedConditions)
        return stillDirty ? x : { ...updated, _dirty: false }
      }))
      patchCachedRules(context, list => list.map(x => x.id === updated.id ? updated : x))
      setStatusById(s => ({ ...s, [ruleId]: 'saved' }))
      onChanged?.()
    } catch (e) {
      setError(e?.message || 'Erreur à la sauvegarde')
      setStatusById(s => ({ ...s, [ruleId]: 'error' }))
    }
  }

  async function createRule(idx) {
    const r = rulesRef.current[idx]
    if (!r || r.id) return
    setCreating(true)
    setError(null)
    try {
      const created = await api.fieldVisibilityRules.create({
        context,
        field_id: fieldId,
        conditions: r.conditions,
      })
      setRule(idx, { ...created, _dirty: false })
      patchCachedRules(context, list => [...list, created])
      onChanged?.()
    } catch (e) {
      setError(e?.message || 'Erreur à la sauvegarde')
    } finally {
      setCreating(false)
    }
  }

  async function deleteRule(idx) {
    const r = rulesRef.current[idx]
    if (!r.id) {
      removeLocalRule(idx)
      return
    }
    const ok = await confirm({
      title: 'Supprimer cette règle ?',
      message: 'Cette règle de visibilité sera supprimée définitivement.',
      confirmLabel: 'Supprimer',
      danger: true,
    })
    if (!ok) return
    // Annule un autosave en attente pour cette règle.
    if (timersRef.current[r.id]) { clearTimeout(timersRef.current[r.id]); timersRef.current[r.id] = null }
    setStatusById(s => ({ ...s, [r.id]: 'saving' }))
    setError(null)
    try {
      await api.fieldVisibilityRules.delete(r.id)
      removeLocalRule(idx)
      patchCachedRules(context, list => list.filter(x => x.id !== r.id))
      onChanged?.()
    } catch (e) {
      setError(e?.message || 'Erreur à la suppression')
      setStatusById(s => ({ ...s, [r.id]: 'error' }))
    }
  }

  // À la fermeture : flush des autosaves en attente pour ne perdre aucune édition.
  async function flushPending() {
    Object.entries(timersRef.current).forEach(([id, t]) => {
      if (t) { clearTimeout(t); timersRef.current[id] = null }
    })
    const dirty = rulesRef.current.filter(r => r.id && r._dirty)
    for (const r of dirty) {
      await autosaveRule(r.id)
    }
  }

  async function handleClose() {
    await flushPending()
    onClose()
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title={`Visibilité du champ « ${fieldLabel} »`} size="lg">
      <p className="text-sm text-slate-500 mb-4">Visible si une règle est vraie.</p>

      {error && (
        <div className="mb-3 p-2 text-xs text-red-700 bg-red-50 border border-red-200 rounded">
          {error}
        </div>
      )}

      <div className="space-y-3">
        {rules.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-6">Toujours visible.</p>
        ) : rules.map((r, i) => (
          <RuleEditor
            key={r.id || `new-${i}`}
            rule={r}
            onChange={next => handleRuleChange(i, next)}
            onCreate={() => createRule(i)}
            onDelete={() => deleteRule(i)}
            fieldsForPicker={fieldsForPicker}
            record={record}
            status={r.id ? (statusById[r.id] || 'idle') : 'idle'}
            busy={r.id ? statusById[r.id] === 'saving' : creating}
          />
        ))}
      </div>

      <div className="mt-5 flex justify-between items-center">
        <button
          type="button"
          onClick={addRule}
          className="inline-flex items-center gap-1.5 text-sm text-brand-600 hover:text-brand-700"
        >
          <Plus size={14} /> Règle
        </button>
        <button
          type="button"
          onClick={handleClose}
          className="btn-secondary text-sm"
        >
          Fermer
        </button>
      </div>
    </Modal>
  )
}
