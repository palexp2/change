import { useState, useEffect } from 'react'
import { X } from 'lucide-react'
import { baseAPI } from '../../hooks/useBaseAPI.js'
import { api } from '../../lib/api.js'
import FormBuilderConfig from './FormBuilderConfig.jsx'

// ── Shared helpers ─────────────────────────────────────────────────────────

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

function ColorPicker({ value, onChange }) {
  const COLORS = [
    { id: 'indigo', hex: '#6366f1' },
    { id: 'green',  hex: '#22c55e' },
    { id: 'red',    hex: '#ef4444' },
    { id: 'orange', hex: '#f97316' },
    { id: 'purple', hex: '#a855f7' },
    { id: 'cyan',   hex: '#06b6d4' },
  ]
  return (
    <div className="flex gap-2">
      {COLORS.map(c => (
        <button key={c.id} type="button" onClick={() => onChange(c.id)}
          className={`w-6 h-6 rounded-full border-2 transition-transform ${value === c.id ? 'border-gray-800 scale-110' : 'border-transparent'}`}
          style={{ backgroundColor: c.hex }} />
      ))}
    </div>
  )
}

// ── Type-specific config panels ────────────────────────────────────────────

function MetricConfig({ config, tables, fields, onChange }) {
  const numericFields = fields.filter(f => ['number', 'currency', 'percent'].includes(f.type))
  return (
    <>
      <Field label="Étiquette">
        <input type="text" defaultValue={config.label || ''}
          onBlur={e => onChange('label', e.target.value)}
          className="w-full border rounded px-2 py-1.5 text-sm" />
      </Field>
      <Field label="Table">
        <TableSelect value={config.table_id} tables={tables} onChange={v => onChange('table_id', v)} />
      </Field>
      <Field label="Champ">
        <select value={config.field_key || ''} onChange={e => onChange('field_key', e.target.value || null)}
          className="w-full border rounded px-2 py-1.5 text-sm">
          <option value="">Nombre d'enregistrements</option>
          {numericFields.map(f => <option key={f.key} value={f.key}>{f.name}</option>)}
        </select>
      </Field>
      <Field label="Agrégat">
        <select value={config.aggregate || 'COUNT'} onChange={e => onChange('aggregate', e.target.value)}
          className="w-full border rounded px-2 py-1.5 text-sm">
          <option value="COUNT">Nombre</option>
          <option value="SUM">Somme</option>
          <option value="AVG">Moyenne</option>
          <option value="MIN">Min</option>
          <option value="MAX">Max</option>
        </select>
      </Field>
      <Field label="Format">
        <select value={config.format || 'number'} onChange={e => onChange('format', e.target.value)}
          className="w-full border rounded px-2 py-1.5 text-sm">
          <option value="number">Nombre</option>
          <option value="currency">Devise CAD</option>
          <option value="currency_usd">Devise USD</option>
          <option value="percent">Pourcentage</option>
          <option value="integer">Entier</option>
        </select>
      </Field>
    </>
  )
}

function ChartConfig({ config, tables, fields, onChange }) {
  const groupableFields = fields.filter(f => ['date', 'datetime', 'single_select', 'text'].includes(f.type))
  const numericFields = fields.filter(f => ['number', 'currency', 'percent'].includes(f.type))
  return (
    <>
      <Field label="Titre">
        <input type="text" defaultValue={config.label || ''}
          onBlur={e => onChange('label', e.target.value)}
          className="w-full border rounded px-2 py-1.5 text-sm" />
      </Field>
      <Field label="Type de graphique">
        <div className="flex gap-2">
          {[['bar', 'Barres'], ['line', 'Ligne']].map(([t, l]) => (
            <button key={t} type="button" onClick={() => onChange('chart_type', t)}
              className={`flex-1 py-1.5 text-sm rounded border transition-colors ${
                (config.chart_type || 'bar') === t
                  ? 'bg-indigo-50 border-indigo-300 text-indigo-700'
                  : 'border-gray-200 text-gray-500 hover:bg-gray-50'
              }`}>
              {l}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Table">
        <TableSelect value={config.table_id} tables={tables} onChange={v => onChange('table_id', v)} />
      </Field>
      <Field label="Axe X">
        <select value={config.x_field_key || ''} onChange={e => onChange('x_field_key', e.target.value)}
          className="w-full border rounded px-2 py-1.5 text-sm">
          <option value="">Choisir un champ…</option>
          {groupableFields.map(f => <option key={f.key} value={f.key}>{f.name}</option>)}
        </select>
      </Field>
      <Field label="Grouper par">
        <select value={config.x_group_by || ''} onChange={e => onChange('x_group_by', e.target.value)}
          className="w-full border rounded px-2 py-1.5 text-sm">
          <option value="">Aucun</option>
          <option value="day">Jour</option>
          <option value="week">Semaine</option>
          <option value="month">Mois</option>
          <option value="year">Année</option>
        </select>
      </Field>
      <Field label="Axe Y">
        <select value={config.y_field_key || ''} onChange={e => onChange('y_field_key', e.target.value)}
          className="w-full border rounded px-2 py-1.5 text-sm">
          <option value="">Nombre de records</option>
          {numericFields.map(f => <option key={f.key} value={f.key}>{f.name}</option>)}
        </select>
      </Field>
      <Field label="Agrégat Y">
        <select value={config.y_aggregate || 'SUM'} onChange={e => onChange('y_aggregate', e.target.value)}
          className="w-full border rounded px-2 py-1.5 text-sm">
          <option value="COUNT">Nombre</option>
          <option value="SUM">Somme</option>
          <option value="AVG">Moyenne</option>
        </select>
      </Field>
      <Field label="Couleur">
        <ColorPicker value={config.color} onChange={v => onChange('color', v)} />
      </Field>
    </>
  )
}

function ListConfig({ config, tables, fields, views, blocks, onChange }) {
  const filterBlocks = blocks.filter(b => b.type === 'filter')
  return (
    <>
      <Field label="Table">
        <TableSelect value={config.table_id} tables={tables} onChange={v => onChange('table_id', v)} />
      </Field>
      <Field label="Vue (optionnel)">
        <select value={config.view_id || ''} onChange={e => onChange('view_id', e.target.value || null)}
          className="w-full border rounded px-2 py-1.5 text-sm">
          <option value="">Aucune vue</option>
          {views.map(v => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
      </Field>
      <Field label="Limite">
        <input type="number" min={1} max={500} value={config.limit || 50}
          onChange={e => onChange('limit', Number(e.target.value))}
          className="w-full border rounded px-2 py-1.5 text-sm" />
      </Field>
      <Field label="Champs affichés">
        <div className="space-y-1 max-h-40 overflow-y-auto border rounded p-2">
          {fields.filter(f => !f.deleted_at).map(f => (
            <label key={f.key} className="flex items-center gap-2 text-xs">
              <input type="checkbox"
                checked={config.fields ? config.fields.includes(f.key) : true}
                onChange={e => {
                  const current = config.fields || fields.map(x => x.key)
                  onChange('fields', e.target.checked
                    ? [...current, f.key]
                    : current.filter(k => k !== f.key))
                }} />
              {f.name}
            </label>
          ))}
        </div>
      </Field>
      {filterBlocks.length > 0 && (
        <Field label="Blocs filtre">
          <div className="space-y-1">
            {filterBlocks.map(b => {
              const bCfg = (() => { try { return JSON.parse(b.config || '{}') } catch { return {} } })()
              return (
                <label key={b.id} className="flex items-center gap-2 text-xs">
                  <input type="checkbox"
                    checked={(config.filter_block_ids || []).includes(b.id)}
                    onChange={e => {
                      const ids = config.filter_block_ids || []
                      onChange('filter_block_ids', e.target.checked ? [...ids, b.id] : ids.filter(id => id !== b.id))
                    }} />
                  {bCfg.label || 'Filtre'} ({b.type})
                </label>
              )
            })}
          </div>
        </Field>
      )}
    </>
  )
}

function DetailConfig({ config, tables, fields, blocks, onChange }) {
  const listBlocks = blocks.filter(b => b.type === 'list')
  return (
    <>
      <Field label="Table">
        <TableSelect value={config.table_id} tables={tables} onChange={v => onChange('table_id', v)} />
      </Field>
      <Field label="Bloc liste source">
        <select value={config.source_list_block_id || ''} onChange={e => onChange('source_list_block_id', e.target.value || null)}
          className="w-full border rounded px-2 py-1.5 text-sm">
          <option value="">Aucun (sélection manuelle)</option>
          {listBlocks.map(b => {
            const bCfg = (() => { try { return JSON.parse(b.config || '{}') } catch { return {} } })()
            return <option key={b.id} value={b.id}>{bCfg.label || `Liste (${b.id.slice(0, 6)})`}</option>
          })}
        </select>
      </Field>
      <Field label="Champs affichés">
        <div className="space-y-1 max-h-40 overflow-y-auto border rounded p-2">
          {fields.filter(f => !f.deleted_at).map(f => (
            <label key={f.key} className="flex items-center gap-2 text-xs">
              <input type="checkbox"
                checked={config.fields ? config.fields.includes(f.key) : true}
                onChange={e => {
                  const current = config.fields || fields.map(x => x.key)
                  onChange('fields', e.target.checked
                    ? [...current, f.key]
                    : current.filter(k => k !== f.key))
                }} />
              {f.name}
            </label>
          ))}
        </div>
      </Field>
      <Field label="Mode">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!!config.editable}
            onChange={e => onChange('editable', e.target.checked)} />
          Permettre la modification
        </label>
      </Field>
    </>
  )
}

function ButtonConfig({ config, blocks, fields, automations, onChange }) {
  const listBlocks = blocks.filter(b => b.type === 'list')
  return (
    <>
      <Field label="Étiquette">
        <input type="text" defaultValue={config.label || ''}
          onBlur={e => onChange('label', e.target.value)}
          className="w-full border rounded px-2 py-1.5 text-sm" />
      </Field>
      <Field label="Couleur">
        <ColorPicker value={config.color} onChange={v => onChange('color', v)} />
      </Field>
      <Field label="Action">
        <select value={config.action_type || ''} onChange={e => onChange('action_type', e.target.value)}
          className="w-full border rounded px-2 py-1.5 text-sm">
          <option value="">Choisir…</option>
          <option value="update_field">Modifier un champ</option>
          <option value="run_automation">Lancer une automation</option>
          <option value="open_url">Ouvrir une URL</option>
        </select>
      </Field>
      {config.action_type === 'update_field' && (
        <>
          <Field label="Champ cible">
            <select value={config.target_field_key || ''} onChange={e => onChange('target_field_key', e.target.value)}
              className="w-full border rounded px-2 py-1.5 text-sm">
              <option value="">Choisir…</option>
              {fields.map(f => <option key={f.key} value={f.key}>{f.name}</option>)}
            </select>
          </Field>
          <Field label="Valeur cible">
            <input type="text" defaultValue={config.target_value || ''}
              onBlur={e => onChange('target_value', e.target.value)}
              className="w-full border rounded px-2 py-1.5 text-sm" />
          </Field>
        </>
      )}
      {config.action_type === 'run_automation' && (
        <Field label="Automation">
          <select value={config.automation_id || ''} onChange={e => onChange('automation_id', e.target.value)}
            className="w-full border rounded px-2 py-1.5 text-sm">
            <option value="">Choisir…</option>
            {automations.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </Field>
      )}
      {config.action_type === 'open_url' && (
        <Field label="URL">
          <input type="url" defaultValue={config.url || ''}
            onBlur={e => onChange('url', e.target.value)}
            className="w-full border rounded px-2 py-1.5 text-sm" placeholder="https://…" />
        </Field>
      )}
    </>
  )
}

function TextConfig({ config, onChange }) {
  return (
    <>
      <Field label="Contenu (Markdown)">
        <textarea
          defaultValue={config.content || ''}
          onBlur={e => onChange('content', e.target.value)}
          rows={8}
          className="w-full border rounded px-2 py-1.5 text-sm font-mono resize-y"
          placeholder="# Titre&#10;**Gras** *italique*&#10;[lien](url)"
        />
      </Field>
      <Field label="Alignement">
        <div className="flex gap-2">
          {[['left', 'Gauche'], ['center', 'Centre']].map(([v, l]) => (
            <button key={v} type="button" onClick={() => onChange('align', v)}
              className={`flex-1 py-1.5 text-sm rounded border transition-colors ${
                (config.align || 'left') === v
                  ? 'bg-indigo-50 border-indigo-300 text-indigo-700'
                  : 'border-gray-200 text-gray-500 hover:bg-gray-50'
              }`}>
              {l}
            </button>
          ))}
        </div>
      </Field>
    </>
  )
}

function FilterConfig({ config, tables, fields, onChange }) {
  // Derive field_type from selected field
  const selectedField = fields.find(f => f.key === config.field_key)
  return (
    <>
      <Field label="Étiquette">
        <input type="text" defaultValue={config.label || ''}
          onBlur={e => onChange('label', e.target.value)}
          className="w-full border rounded px-2 py-1.5 text-sm" />
      </Field>
      <Field label="Table">
        <TableSelect value={config.table_id} tables={tables} onChange={v => onChange('table_id', v)} />
      </Field>
      <Field label="Champ">
        <select value={config.field_key || ''} onChange={e => {
          const f = fields.find(x => x.key === e.target.value)
          onChange('field_key', e.target.value)
          if (f) onChange('field_type', f.type)
        }}
          className="w-full border rounded px-2 py-1.5 text-sm">
          <option value="">Choisir…</option>
          {fields.map(f => <option key={f.key} value={f.key}>{f.name} ({f.type})</option>)}
        </select>
      </Field>
      {selectedField?.type === 'single_select' && (
        <Field label="Options">
          <div className="text-xs text-gray-400">Options issues du champ</div>
        </Field>
      )}
    </>
  )
}

function VisibilityConditionConfig({ block, blocks, onSave }) {
  const condition = (() => {
    try { return block.condition ? JSON.parse(block.condition) : null } catch { return null }
  })()

  const sourceBlocks = blocks.filter(b => b.id !== block.id && ['filter', 'list'].includes(b.type))

  function handleChange(newCond) {
    api.interfaces.updateBlock(block.id, { condition: newCond ? JSON.stringify(newCond) : null })
      .catch(() => {})
  }

  return (
    <details className="border-t pt-3 mt-2">
      <summary className="text-xs font-medium text-gray-500 cursor-pointer hover:text-gray-700 select-none">
        Visibilité conditionnelle
      </summary>
      <div className="mt-3 space-y-2">
        <select
          value={condition?.source_block_id || ''}
          onChange={e => {
            if (!e.target.value) { handleChange(null); return }
            handleChange({ source_block_id: e.target.value, op: 'is_not_empty', value: null })
          }}
          className="w-full border rounded px-2 py-1.5 text-xs"
        >
          <option value="">Toujours visible</option>
          {sourceBlocks.map(b => {
            const bCfg = (() => { try { return JSON.parse(b.config || '{}') } catch { return {} } })()
            return <option key={b.id} value={b.id}>{bCfg.label || b.type} ({b.type})</option>
          })}
        </select>
        {condition && (
          <>
            <select value={condition.op}
              onChange={e => handleChange({ ...condition, op: e.target.value })}
              className="w-full border rounded px-2 py-1.5 text-xs">
              <option value="is_not_empty">a une valeur</option>
              <option value="is_empty">est vide</option>
              <option value="equals">est égal à</option>
              <option value="not_equals">n'est pas égal à</option>
            </select>
            {['equals', 'not_equals'].includes(condition.op) && (
              <input type="text" value={condition.value || ''}
                onChange={e => handleChange({ ...condition, value: e.target.value })}
                className="w-full border rounded px-2 py-1.5 text-xs" placeholder="Valeur" />
            )}
          </>
        )}
      </div>
    </details>
  )
}

function InteractionTimelineConfig({ config, blocks, onChange }) {
  const listBlocks = blocks.filter(b => b.type === 'list')
  const TYPES = ['call','email','sms','note','meeting']
  const selectedTypes = config.types || TYPES

  return (
    <>
      <Field label="Bloc liste source (optionnel)">
        <select value={config.list_block_id || ''} onChange={e => onChange('list_block_id', e.target.value || null)}
          className="w-full border rounded px-2 py-1.5 text-sm">
          <option value="">Aucun</option>
          {listBlocks.map(b => {
            const bCfg = (() => { try { return JSON.parse(b.config || '{}') } catch { return {} } })()
            return <option key={b.id} value={b.id}>{bCfg.label || `Liste (${b.id.slice(-4)})`}</option>
          })}
        </select>
      </Field>
      <Field label="Types affichés">
        <div className="space-y-1">
          {TYPES.map(t => (
            <label key={t} className="flex items-center gap-2 text-sm">
              <input type="checkbox"
                checked={selectedTypes.includes(t)}
                onChange={e => {
                  const next = e.target.checked
                    ? [...selectedTypes, t]
                    : selectedTypes.filter(x => x !== t)
                  onChange('types', next)
                }} />
              {{ call: 'Appels', email: 'Courriels', sms: 'SMS', note: 'Notes', meeting: 'Réunions' }[t]}
            </label>
          ))}
        </div>
      </Field>
      <Field label="Limite">
        <input type="number" min="5" max="100" defaultValue={config.limit || 20}
          onBlur={e => onChange('limit', Number(e.target.value))}
          className="w-full border rounded px-2 py-1.5 text-sm" />
      </Field>
      <Field label="Options">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!!config.show_stats}
            onChange={e => onChange('show_stats', e.target.checked)} />
          Afficher les statistiques
        </label>
        <label className="flex items-center gap-2 text-sm mt-1">
          <input type="checkbox" checked={!!config.allow_create}
            onChange={e => onChange('allow_create', e.target.checked)} />
          Permettre la création
        </label>
      </Field>
    </>
  )
}

// ── BlockEditorPanel ────────────────────────────────────────────────────────

const BLOCK_TYPE_LABELS = {
  metric: 'Métrique', chart: 'Graphique', list: 'Liste', detail: 'Détail',
  form: 'Formulaire', button: 'Bouton', text: 'Texte', filter: 'Filtre',
  interaction_timeline: 'Timeline',
}

export default function BlockEditorPanel({ block, blocks, pageId, onConfigChange, onDelete, onClose }) {
  const config = (() => { try { return JSON.parse(block.config || '{}') } catch { return {} } })()
  const [tables, setTables] = useState([])
  const [fields, setFields] = useState([])
  const [views, setViews] = useState([])
  const [automations, setAutomations] = useState([])
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    baseAPI.tables()
      .then(res => setTables((res.tables || []).filter(t => !t.deleted_at)))
      .catch(() => {})
    api.automations.list()
      .then(res => setAutomations(Array.isArray(res) ? res : []))
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!config.table_id) { setFields([]); setViews([]); return }
    baseAPI.fields(config.table_id)
      .then(res => setFields((res.fields || []).filter(f => !f.deleted_at)))
      .catch(() => {})
    baseAPI.views(config.table_id)
      .then(res => setViews(res.views || []))
      .catch(() => {})
  }, [config.table_id])

  function updateConfig(key, value) {
    onConfigChange({ [key]: value })
  }

  return (
    <div className="fixed right-0 top-0 h-full w-80 bg-white border-l border-slate-200 shadow-xl z-50 flex flex-col animate-slide-in-right">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
        <span className="text-sm font-semibold text-gray-900">
          {BLOCK_TYPE_LABELS[block.type] || block.type}
        </span>
        <button onClick={onClose} className="p-1 text-gray-400 hover:text-gray-600 rounded">
          <X size={16} />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {block.type === 'metric' && (
          <MetricConfig config={config} tables={tables} fields={fields} onChange={updateConfig} />
        )}
        {block.type === 'chart' && (
          <ChartConfig config={config} tables={tables} fields={fields} onChange={updateConfig} />
        )}
        {block.type === 'list' && (
          <ListConfig config={config} tables={tables} fields={fields} views={views} blocks={blocks} onChange={updateConfig} />
        )}
        {block.type === 'detail' && (
          <DetailConfig config={config} tables={tables} fields={fields} blocks={blocks} onChange={updateConfig} />
        )}
        {block.type === 'form' && (
          <FormBuilderConfig config={config} tables={tables} fields={fields} onChange={onConfigChange} />
        )}
        {block.type === 'button' && (
          <ButtonConfig config={config} blocks={blocks} fields={fields} automations={automations} onChange={updateConfig} />
        )}
        {block.type === 'text' && (
          <TextConfig config={config} onChange={updateConfig} />
        )}
        {block.type === 'filter' && (
          <FilterConfig config={config} tables={tables} fields={fields} onChange={updateConfig} />
        )}
        {block.type === 'interaction_timeline' && (
          <InteractionTimelineConfig config={config} blocks={blocks} onChange={updateConfig} />
        )}

        <VisibilityConditionConfig block={block} blocks={blocks} />
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t shrink-0">
        {confirmDelete ? (
          <div className="flex items-center gap-3">
            <span className="text-xs text-red-600">Confirmer ?</span>
            <button onClick={onDelete} className="text-xs text-red-600 font-medium hover:text-red-700">
              Oui, supprimer
            </button>
            <button onClick={() => setConfirmDelete(false)} className="text-xs text-gray-500 hover:text-gray-700">
              Annuler
            </button>
          </div>
        ) : (
          <button onClick={() => setConfirmDelete(true)}
            className="text-sm text-red-600 hover:text-red-700 transition-colors">
            Supprimer ce bloc
          </button>
        )}
      </div>
    </div>
  )
}
