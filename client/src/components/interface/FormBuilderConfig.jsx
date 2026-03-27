import { useState } from 'react'
import { Plus, X, Settings, GripVertical } from 'lucide-react'

const SKIP_TYPES = ['autonumber', 'formula', 'rollup', 'lookup', 'created_at', 'updated_at']

function Field({ label, children }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1">{label}</label>
      {children}
    </div>
  )
}

function TableSelect({ value, tables, onChange }) {
  return (
    <select value={value || ''} onChange={e => onChange(e.target.value)}
      className="w-full border rounded px-2 py-1.5 text-sm">
      <option value="">Choisir une table…</option>
      {tables.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
    </select>
  )
}

export default function FormBuilderConfig({ config, tables, fields, onChange }) {
  const [expandedIdx, setExpandedIdx] = useState(null)
  const fieldConfigs = config.field_configs || []
  const editableFields = fields.filter(f => !SKIP_TYPES.includes(f.type))
  const usedKeys = fieldConfigs.map(fc => fc.field_key)
  const availableFields = editableFields.filter(f => !usedKeys.includes(f.key))

  function addField(fieldKey) {
    const field = editableFields.find(f => f.key === fieldKey)
    const newFc = {
      field_key: fieldKey,
      label: field?.name || fieldKey,
      placeholder: '',
      help_text: '',
      required: !!field?.required,
      width: 'full',
      visible_if: null,
    }
    onChange({ field_configs: [...fieldConfigs, newFc] })
  }

  function removeField(idx) {
    onChange({ field_configs: fieldConfigs.filter((_, i) => i !== idx) })
    if (expandedIdx === idx) setExpandedIdx(null)
  }

  function updateFc(idx, key, value) {
    onChange({ field_configs: fieldConfigs.map((fc, i) => i === idx ? { ...fc, [key]: value } : fc) })
  }

  function moveField(fromIdx, toIdx) {
    const updated = [...fieldConfigs]
    const [moved] = updated.splice(fromIdx, 1)
    updated.splice(toIdx, 0, moved)
    onChange({ field_configs: updated })
  }

  return (
    <div className="space-y-4">
      <Field label="Table">
        <TableSelect value={config.table_id} tables={tables}
          onChange={v => onChange({ table_id: v, field_configs: [] })} />
      </Field>

      <Field label="Texte du bouton">
        <input type="text" defaultValue={config.submit_label || ''}
          onBlur={e => onChange({ submit_label: e.target.value })}
          className="w-full border rounded px-2 py-1.5 text-sm" placeholder="Enregistrer" />
      </Field>

      <Field label="Message de succès">
        <input type="text" defaultValue={config.on_success?.message || ''}
          onBlur={e => onChange({ on_success: { type: 'message', message: e.target.value } })}
          className="w-full border rounded px-2 py-1.5 text-sm" placeholder="Enregistrement créé !" />
      </Field>

      <div className="border-t pt-3">
        <h4 className="text-xs font-semibold text-gray-500 mb-2 uppercase tracking-wider">Champs du formulaire</h4>

        <div className="space-y-1 mb-3">
          {fieldConfigs.map((fc, idx) => (
            <div key={fc.field_key}>
              <div
                className="flex items-center gap-1.5 p-2 bg-gray-50 rounded border group cursor-default"
                draggable
                onDragStart={e => e.dataTransfer.setData('idx', String(idx))}
                onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); moveField(Number(e.dataTransfer.getData('idx')), idx) }}
              >
                <GripVertical size={12} className="text-gray-300 cursor-grab shrink-0" />
                <span className="text-sm flex-1 truncate">{fc.label || fc.field_key}</span>
                <span className={`text-[10px] px-1 rounded shrink-0 ${fc.required ? 'bg-orange-100 text-orange-600' : 'bg-gray-100 text-gray-400'}`}>
                  {fc.required ? 'Requis' : 'Opt.'}
                </span>
                <button
                  onClick={() => setExpandedIdx(expandedIdx === idx ? null : idx)}
                  className="p-0.5 text-gray-400 hover:text-gray-600 opacity-0 group-hover:opacity-100"
                >
                  <Settings size={12} />
                </button>
                <button
                  onClick={() => removeField(idx)}
                  className="p-0.5 text-gray-400 hover:text-red-500 opacity-0 group-hover:opacity-100"
                >
                  <X size={12} />
                </button>
              </div>

              {expandedIdx === idx && (
                <div className="ml-3 p-3 border-l-2 border-indigo-200 space-y-2 mt-1 mb-1 bg-indigo-50/40 rounded-r">
                  <div>
                    <label className="block text-[10px] text-gray-500 mb-0.5">Label</label>
                    <input type="text" value={fc.label}
                      onChange={e => updateFc(idx, 'label', e.target.value)}
                      className="w-full border rounded px-2 py-1 text-xs" />
                  </div>
                  <div>
                    <label className="block text-[10px] text-gray-500 mb-0.5">Texte d'aide</label>
                    <input type="text" value={fc.help_text || ''}
                      onChange={e => updateFc(idx, 'help_text', e.target.value)}
                      className="w-full border rounded px-2 py-1 text-xs" />
                  </div>
                  <div className="flex gap-3 items-center">
                    <label className="flex items-center gap-1.5 text-xs">
                      <input type="checkbox" checked={fc.required}
                        onChange={e => updateFc(idx, 'required', e.target.checked)} />
                      Obligatoire
                    </label>
                    <label className="flex items-center gap-1.5 text-xs">
                      Largeur :
                      <select value={fc.width || 'full'}
                        onChange={e => updateFc(idx, 'width', e.target.value)}
                        className="border rounded px-1 py-0.5 text-xs">
                        <option value="full">Pleine</option>
                        <option value="half">Demi</option>
                      </select>
                    </label>
                  </div>

                  <details className="mt-1">
                    <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700">
                      Afficher seulement si…
                    </summary>
                    <div className="mt-2 space-y-2 pl-2">
                      <select
                        value={fc.visible_if?.field_key || ''}
                        onChange={e => updateFc(idx, 'visible_if', e.target.value
                          ? { field_key: e.target.value, op: 'is_not_empty', value: null }
                          : null)}
                        className="w-full border rounded px-2 py-1 text-xs"
                      >
                        <option value="">Toujours visible</option>
                        {fieldConfigs.filter((_, i) => i !== idx).map(otherFc => (
                          <option key={otherFc.field_key} value={otherFc.field_key}>{otherFc.label || otherFc.field_key}</option>
                        ))}
                      </select>
                      {fc.visible_if && (
                        <>
                          <select value={fc.visible_if.op}
                            onChange={e => updateFc(idx, 'visible_if', { ...fc.visible_if, op: e.target.value })}
                            className="w-full border rounded px-2 py-1 text-xs">
                            <option value="is_not_empty">n'est pas vide</option>
                            <option value="is_empty">est vide</option>
                            <option value="equals">est égal à</option>
                            <option value="not_equals">n'est pas égal à</option>
                          </select>
                          {['equals', 'not_equals'].includes(fc.visible_if.op) && (
                            <input type="text" value={fc.visible_if.value || ''}
                              onChange={e => updateFc(idx, 'visible_if', { ...fc.visible_if, value: e.target.value })}
                              className="w-full border rounded px-2 py-1 text-xs" placeholder="Valeur" />
                          )}
                        </>
                      )}
                    </div>
                  </details>
                </div>
              )}
            </div>
          ))}
        </div>

        {availableFields.length > 0 && (
          <div>
            <h5 className="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Ajouter un champ</h5>
            <div className="space-y-0.5 max-h-40 overflow-y-auto">
              {availableFields.map(f => (
                <button key={f.key} onClick={() => addField(f.key)}
                  className="w-full flex items-center gap-2 px-2 py-1.5 text-xs text-gray-500 hover:bg-gray-50 rounded transition-colors">
                  <Plus size={12} /> {f.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
