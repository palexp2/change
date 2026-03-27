import { useState, useEffect, useCallback, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Layout } from '../components/Layout.jsx'
import { GridView } from '../components/grid/GridView.jsx'
import { ViewToolbar } from '../components/grid/ViewToolbar.jsx'
import { RecordSidePanel } from '../components/grid/RecordSidePanel.jsx'
import { FieldConfigPanel } from '../components/grid/FieldConfigPanel.jsx'
import { PastePreviewModal } from '../components/modals/PastePreviewModal.jsx'
import { TableSettingsModal } from '../components/modals/TableSettingsModal.jsx'
import { ImportModal } from '../components/modals/ImportModal.jsx'
import { DynamicIcon } from '../components/ui/DynamicIcon.jsx'
import { useRealtime } from '../hooks/useRealtime.js'
import { baseAPI } from '../hooks/useBaseAPI.js'
import { useUndoRedo } from '../hooks/useUndoRedo.jsx'
import TableFieldsPage from './TableFieldsPage.jsx'
import { Plus, Loader2, Settings, AlertCircle } from 'lucide-react'
import { filterHasRules } from '../components/grid/FilterBuilder.jsx'

export default function TablePage() {
  const { slug, recordId: urlRecordId } = useParams()
  const navigate = useNavigate()

  // ── Core state ─────────────────────────────────────────────────────────────
  const [table, setTable] = useState(null)
  const [fields, setFields] = useState([])
  const [records, setRecords] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [activeTab, setActiveTab] = useState('data') // 'data' | 'fields'

  // ── View / filter / sort / group state ────────────────────────────────────
  const [activeViewId, setActiveViewId] = useState(null)
  const [filters, setFilters] = useState({ conjunction: 'AND', rules: [] })
  const [sorts, setSorts] = useState([])
  const [groupBy, setGroupBy] = useState([])
  const [groupSummaries, setGroupSummaries] = useState({})
  const [search, setSearch] = useState('')

  // ── UI state ───────────────────────────────────────────────────────────────
  const [expandedRecord, setExpandedRecord] = useState(null) // full record object
  const [showAddField, setShowAddField] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [showPastePreview, setShowPastePreview] = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [pasteText, setPasteText] = useState('')

  const allTablesRef = useRef([])
  const { pushFromAPIResponse } = useUndoRedo()

  // ── Data loading ───────────────────────────────────────────────────────────

  async function loadTable() {
    const res = await baseAPI.tables()
    allTablesRef.current = res.tables || []
    const t = allTablesRef.current.find(t => t.slug === slug || t.id === slug)
    if (!t) { setError('Table introuvable'); setLoading(false); return null }
    setTable(t)
    return t
  }

  async function loadFields(tableId) {
    const res = await baseAPI.fields(tableId)
    const f = res.fields || []
    setFields(f)
    return f
  }

  async function loadRecords(tableId, viewId, currentFilters, currentSorts, currentGroupBy, currentGroupSummaries, currentSearch) {
    const params = { limit: 500 }
    if (viewId) params.view_id = viewId
    if (filterHasRules(currentFilters)) params.filters = JSON.stringify(currentFilters)
    if (currentSorts?.length) params.sorts = JSON.stringify(currentSorts)
    if (currentGroupBy?.length) params.group_by = JSON.stringify(currentGroupBy)
    if (currentGroupSummaries && Object.keys(currentGroupSummaries).length) {
      params.group_summaries = JSON.stringify(currentGroupSummaries)
    }
    if (currentSearch?.trim()) params.search = currentSearch.trim()
    const res = await baseAPI.records(tableId, params)
    setRecords(res.data || [])
  }

  async function init() {
    setLoading(true)
    setError(null)
    try {
      const t = await loadTable()
      if (!t) return
      await loadFields(t.id)
      // Views are loaded by ViewToolbar; we start with no view
      await loadRecords(t.id, null, { conjunction: 'AND', rules: [] }, [], [], {}, '')
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { init() }, [slug])

  // Recharger après undo/redo
  useEffect(() => {
    function onUndoRedo() {
      if (table) loadRecords(table.id, activeViewId, filters, sorts, groupBy, groupSummaries, search)
    }
    window.addEventListener('undo-redo', onUndoRedo)
    return () => window.removeEventListener('undo-redo', onUndoRedo)
  }, [table, activeViewId, filters, sorts, groupBy, groupSummaries, search])

  // Ouvrir le side panel si un recordId est dans l'URL
  useEffect(() => {
    if (!urlRecordId || !records.length) return
    const found = records.find(r => r.id === urlRecordId)
    if (found) setExpandedRecord(found)
  }, [urlRecordId, records])

  // Re-fetch when query params change
  useEffect(() => {
    if (!table) return
    loadRecords(table.id, activeViewId, filters, sorts, groupBy, groupSummaries, search)
  }, [filters, sorts, groupBy, groupSummaries, search, activeViewId])

  // ── Realtime ───────────────────────────────────────────────────────────────

  useRealtime(table?.id, useCallback((msg) => {
    if (msg.type === 'record:created') {
      setRecords(prev => [...prev, msg.record])
    } else if (msg.type === 'record:updated') {
      setRecords(prev => prev.map(r => r.id === msg.record.id ? msg.record : r))
      // Sync expanded record
      setExpandedRecord(prev => prev?.id === msg.record.id ? msg.record : prev)
    } else if (msg.type === 'record:deleted') {
      setRecords(prev => prev.filter(r => r.id !== msg.record_id))
      setExpandedRecord(prev => prev?.id === msg.record_id ? null : prev)
    } else if (msg.type === 'field:created' || msg.type === 'field:updated' || msg.type === 'field:deleted') {
      if (table) loadFields(table.id)
    }
  }, [table]))

  // ── Paste import ───────────────────────────────────────────────────────────

  useEffect(() => {
    function onPaste(e) {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return
      const text = e.clipboardData.getData('text/plain')
      if (text.includes('\t') && text.includes('\n')) {
        setPasteText(text)
        setShowPastePreview(true)
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [])

  // ── Event handlers ─────────────────────────────────────────────────────────

  async function handleCellSave(recordId, changes) {
    const res = await baseAPI.updateRecord(table.id, recordId, { data: changes })
    setRecords(prev => prev.map(r =>
      r.id === recordId ? { ...r, data: { ...r.data, ...changes } } : r
    ))
    setExpandedRecord(prev =>
      prev?.id === recordId ? { ...prev, data: { ...prev.data, ...changes } } : prev
    )
    if (res?.undo) {
      const fieldKey = Object.keys(changes)[0] || 'champ'
      pushFromAPIResponse(
        res,
        { method: 'PATCH', url: `/erp/api/base/records/${recordId}`, body: { data: changes } },
        `modification de ${fieldKey}`
      )
    }
  }

  async function handleAddRecord() {
    const res = await baseAPI.createRecord(table.id, { data: {} })
    setRecords(prev => [...prev, res])
    // Auto-expand new record
    setExpandedRecord(res)
  }

  async function handleAddField(fieldData) {
    const res = await baseAPI.createField(table.id, fieldData)
    setFields(prev => [...prev, res.field])
  }

  async function handleBulkDelete(ids) {
    await baseAPI.bulkDelete(table.id, ids)
    setRecords(prev => prev.filter(r => !ids.includes(r.id)))
  }

  async function handlePasteImport(rows) {
    await baseAPI.bulkCreate(table.id, rows)
    await loadRecords(table.id, activeViewId, filters, sorts, groupBy, groupSummaries, search)
  }

  function handleViewChange(viewId, view) {
    setActiveViewId(viewId)
    if (view) {
      const cfg = view.config || {}
      setFilters(cfg.filters?.rules ? cfg.filters : { conjunction: 'AND', rules: [] })
      setSorts(Array.isArray(cfg.sorts) ? cfg.sorts : [])
      setGroupBy(Array.isArray(cfg.group_by) ? cfg.group_by : [])
      setGroupSummaries(cfg.group_summaries && typeof cfg.group_summaries === 'object' ? cfg.group_summaries : {})
    }
  }

  function handleExpandRecord(record) {
    setExpandedRecord(record)
  }

  function handleRecordChange() {
    // Reload records to reflect changes (add/delete/update)
    if (table) {
      loadRecords(table.id, activeViewId, filters, sorts, groupBy, groupSummaries, search)
    }
  }

  // ── Loading / error ────────────────────────────────────────────────────────

  if (loading) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-64 text-slate-400">
          <Loader2 size={24} className="animate-spin mr-2" />
          Chargement…
        </div>
      </Layout>
    )
  }

  if (error) {
    return (
      <Layout>
        <div className="flex flex-col items-center justify-center h-64 gap-3 text-slate-500">
          <AlertCircle size={32} className="text-red-400" />
          <p>{error}</p>
          <button onClick={() => navigate('/tables')} className="btn-secondary">
            Retour aux tables
          </button>
        </div>
      </Layout>
    )
  }

  const activeFields = fields.filter(f => !f.deleted_at)

  return (
    <Layout>
      <div className="flex flex-col h-full overflow-hidden">
        {/* Top bar */}
        <div className="flex-shrink-0 flex items-center gap-3 px-5 h-12 border-b border-slate-200 bg-white">
          {table?.icon && <DynamicIcon name={table.icon} size={18} className="text-slate-500" />}
          <h1 className="font-semibold text-slate-900 text-sm">{table?.name}</h1>
          <span className="text-xs text-slate-400">{records.length} ligne{records.length !== 1 ? 's' : ''}</span>

          {/* Tabs */}
          <div className="flex items-center gap-0.5 ml-4 bg-slate-100 rounded-lg p-0.5">
            <button
              onClick={() => setActiveTab('data')}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                activeTab === 'data' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              Données
            </button>
            <button
              onClick={() => setActiveTab('fields')}
              className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                activeTab === 'fields' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              Champs
            </button>
          </div>

          {/* Right actions */}
          <div className="flex items-center gap-2 ml-auto">
            {activeTab === 'data' && (
              <button onClick={handleAddRecord} className="btn-primary text-xs flex items-center gap-1.5 py-1.5">
                <Plus size={13} /> Ajouter
              </button>
            )}
            <button
              onClick={() => setShowSettings(true)}
              className="p-1.5 text-slate-400 hover:text-slate-600 hover:bg-slate-100 rounded-lg"
              title="Paramètres"
            >
              <Settings size={16} />
            </button>
          </div>
        </div>

        {/* Tab content */}
        {activeTab === 'data' ? (
          <>
            {/* ViewToolbar */}
            <ViewToolbar
              tableId={table.id}
              fields={activeFields}
              activeViewId={activeViewId}
              filters={filters}
              sorts={sorts}
              groupBy={groupBy}
              groupSummaries={groupSummaries}
              search={search}
              onViewChange={handleViewChange}
              onFiltersChange={setFilters}
              onSortsChange={setSorts}
              onGroupByChange={(gb, gs) => { setGroupBy(gb); setGroupSummaries(gs) }}
              onSearchChange={setSearch}
              onImportClick={() => setShowImport(true)}
            />

            {/* GridView */}
            <div className="flex-1 overflow-hidden">
              <GridView
                fields={activeFields}
                records={records}
                loading={loading}
                sorts={sorts}
                onSortChange={setSorts}
                onCellSave={handleCellSave}
                onAddRecord={handleAddRecord}
                onAddField={() => setShowAddField(true)}
                onBulkDelete={handleBulkDelete}
                onExpandRecord={handleExpandRecord}
              />
            </div>
          </>
        ) : (
          <div className="flex-1 overflow-y-auto">
            <TableFieldsPage tableId={table.id} />
          </div>
        )}
      </div>

      {/* Record side panel */}
      {expandedRecord && (
        <RecordSidePanel
          recordId={expandedRecord.id}
          tableId={table.id}
          initialRecord={expandedRecord}
          initialFields={fields}
          onClose={() => setExpandedRecord(null)}
          onRecordChange={handleRecordChange}
        />
      )}

      {/* Add field panel (FieldConfigPanel) */}
      {showAddField && (
        <FieldConfigPanel
          tableId={table.id}
          field={null}
          allFields={activeFields}
          onClose={() => setShowAddField(false)}
          onSaved={() => loadFields(table.id)}
        />
      )}

      {/* Table settings modal */}
      {showSettings && (
        <TableSettingsModal
          table={table}
          onClose={() => setShowSettings(false)}
          onSaved={updated => setTable(updated)}
          onDeleted={() => navigate('/tables')}
        />
      )}

      {/* Import modal */}
      {showImport && (
        <ImportModal
          tableId={table.id}
          fields={activeFields}
          onClose={() => setShowImport(false)}
          onImported={() => loadRecords(table.id, activeViewId, filters, sorts, groupBy, groupSummaries, search)}
        />
      )}

      {/* Paste preview */}
      <PastePreviewModal
        open={showPastePreview}
        onClose={() => setShowPastePreview(false)}
        rawText={pasteText}
        fields={activeFields.filter(f => !['formula', 'lookup', 'rollup', 'created_at', 'updated_at', 'autonumber'].includes(f.type))}
        onImport={handlePasteImport}
      />
    </Layout>
  )
}
