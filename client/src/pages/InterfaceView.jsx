import { useState, useEffect, useCallback } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import ReactGridLayout from 'react-grid-layout'
import { Layout } from '../components/Layout.jsx'
import { DynamicIcon } from '../components/ui/DynamicIcon.jsx'
import BlockRenderer from '../components/interface/BlockRenderer.jsx'
import BlockEditorPanel from '../components/interface/BlockEditorPanel.jsx'
import { useAuth } from '../lib/auth.jsx'
import { useToast } from '../components/ui/ToastProvider.jsx'
import { api } from '../lib/api.js'
import {
  Plus, Settings, GripHorizontal, ExternalLink, X,
  Hash, BarChart3, List, FileText, ClipboardList,
  MousePointer, Type, Filter, MessageSquare
} from 'lucide-react'

// ── Helpers ───────────────────────────────────────────────────────────────────

function evaluateBlockCondition(condition, filterValues, selectedRecordId) {
  if (!condition) return true
  try {
    const cond = typeof condition === 'string' ? JSON.parse(condition) : condition
    const sourceValue = filterValues[cond.source_block_id]
    switch (cond.op) {
      case 'is_not_empty': return sourceValue != null && sourceValue !== ''
      case 'is_empty':     return !sourceValue
      case 'equals':       return sourceValue === cond.value
      case 'not_equals':   return sourceValue !== cond.value
      default:             return true
    }
  } catch { return true }
}

// ── BlockPickerDropdown ───────────────────────────────────────────────────────

const BLOCK_TYPES = [
  { type: 'metric',               icon: Hash,          label: 'Métrique',    desc: 'Chiffre clé agrégé' },
  { type: 'chart',                icon: BarChart3,      label: 'Graphique',   desc: 'Barres ou ligne' },
  { type: 'list',                 icon: List,           label: 'Liste',       desc: 'Tableau de records' },
  { type: 'detail',               icon: FileText,       label: 'Détail',      desc: "Fiche d'un record" },
  { type: 'form',                 icon: ClipboardList,  label: 'Formulaire',  desc: 'Saisie de données' },
  { type: 'button',               icon: MousePointer,   label: 'Bouton',      desc: 'Action rapide' },
  { type: 'text',                 icon: Type,           label: 'Texte',       desc: 'Titre ou description' },
  { type: 'filter',               icon: Filter,         label: 'Filtre',      desc: 'Filtrer les blocs' },
  { type: 'interaction_timeline', icon: MessageSquare,  label: 'Timeline',    desc: 'Interactions CRM' },
]

function BlockPickerDropdown({ onSelect }) {
  const [open, setOpen] = useState(false)

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 px-3 py-1.5 text-sm bg-white border rounded-lg hover:bg-gray-50"
      >
        <Plus size={14} /> Ajouter un bloc
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-0 mt-2 w-72 bg-white rounded-xl shadow-xl border z-50 p-3 grid grid-cols-2 gap-2">
            {BLOCK_TYPES.map(bt => (
              <button
                key={bt.type}
                onClick={() => { onSelect(bt.type); setOpen(false) }}
                className="flex items-start gap-2.5 p-2.5 rounded-lg hover:bg-gray-50 text-left"
              >
                <bt.icon size={18} className="text-indigo-500 mt-0.5 shrink-0" />
                <div>
                  <div className="text-sm font-medium text-gray-700">{bt.label}</div>
                  <div className="text-[11px] text-gray-400">{bt.desc}</div>
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}

// ── InterfaceView ─────────────────────────────────────────────────────────────

export default function InterfaceView() {
  const { id } = useParams()
  const [searchParams, setSearchParams] = useSearchParams()
  const [iface, setIface] = useState(null)
  const [pages, setPages] = useState([])
  const [blocks, setBlocks] = useState([])
  const [activePageId, setActivePageId] = useState(null)
  const [editMode, setEditMode] = useState(false)
  const [editingBlockId, setEditingBlockId] = useState(null)
  const [selectedRecord, setSelectedRecord] = useState(null)
  const [filterValues, setFilterValues] = useState({})
  const [gridWidth, setGridWidth] = useState(1200)
  const { user } = useAuth()
  const { addToast } = useToast()
  const isAdmin = user?.role === 'admin'

  // Measure container width for responsive grid
  const gridRef = useCallback(node => {
    if (!node) return
    const ro = new ResizeObserver(entries => {
      for (const entry of entries) setGridWidth(entry.contentRect.width || 1200)
    })
    ro.observe(node)
  }, [])

  useEffect(() => { loadInterface() }, [id])

  async function loadInterface() {
    try {
      const [ifaceData, pagesData] = await Promise.all([
        api.interfaces.get(id),
        api.interfaces.pages(id),
      ])
      setIface(ifaceData)
      const pageArr = Array.isArray(pagesData) ? pagesData : []
      setPages(pageArr)

      const pageId = searchParams.get('page') || pageArr[0]?.id
      if (pageId) {
        setActivePageId(pageId)
        loadBlocks(pageId)
      }
    } catch (err) {
      addToast({ message: err.message || 'Erreur chargement', type: 'error' })
    }
  }

  async function loadBlocks(pageId) {
    try {
      const data = await api.interfaces.blocks(pageId)
      setBlocks(Array.isArray(data) ? data : [])
    } catch {}
  }

  function handlePageChange(pageId) {
    setActivePageId(pageId)
    setSearchParams({ page: pageId })
    loadBlocks(pageId)
    setSelectedRecord(null)
    setFilterValues({})
    setEditingBlockId(null)
  }

  async function handleAddPage() {
    const name = prompt('Nom de la page :')
    if (!name?.trim()) return
    try {
      const page = await api.interfaces.createPage(id, { name: name.trim() })
      setPages(prev => [...prev, page])
      handlePageChange(page.id)
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    }
  }

  async function handleDeletePage(pageId) {
    if (!confirm('Supprimer cette page et tous ses blocs ?')) return
    try {
      await api.interfaces.deletePage(pageId)
      const remaining = pages.filter(p => p.id !== pageId)
      setPages(remaining)
      if (activePageId === pageId) {
        const next = remaining[0]
        if (next) handlePageChange(next.id)
        else { setActivePageId(null); setBlocks([]) }
      }
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    }
  }

  async function handleAddBlock(type) {
    if (!activePageId) return
    try {
      const block = await api.interfaces.createBlock(activePageId, { type })
      setBlocks(prev => [...prev, block])
      setEditingBlockId(block.id)
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    }
  }

  async function handleDeleteBlock(blockId) {
    try {
      await api.interfaces.deleteBlock(blockId)
      setBlocks(prev => prev.filter(b => b.id !== blockId))
      if (editingBlockId === blockId) setEditingBlockId(null)
    } catch (err) {
      addToast({ message: err.message, type: 'error' })
    }
  }

  async function handleLayoutChange(newLayout) {
    if (!editMode || !activePageId) return
    const updates = newLayout.map(item => ({
      id: item.i,
      grid_x: item.x,
      grid_y: item.y,
      grid_w: item.w,
      grid_h: item.h,
    }))
    try {
      await api.interfaces.saveLayout(activePageId, updates)
      // Update local state
      setBlocks(prev => prev.map(b => {
        const u = updates.find(u => u.id === b.id)
        return u ? { ...b, grid_x: u.grid_x, grid_y: u.grid_y, grid_w: u.grid_w, grid_h: u.grid_h } : b
      }))
    } catch {}
  }

  function handleFilterChange(blockId, value) {
    setFilterValues(prev => ({ ...prev, [blockId]: value }))
  }

  async function handleBlockConfigChange(blockId, partialConfig) {
    try {
      const res = await api.interfaces.updateBlock(blockId, { config: partialConfig })
      setBlocks(prev => prev.map(b => b.id === blockId ? { ...b, config: res.config ?? b.config } : b))
    } catch (err) {
      addToast({ message: err.message || 'Erreur config', type: 'error' })
    }
  }

  const layout = blocks.map(b => ({
    i: b.id,
    x: b.grid_x ?? 0,
    y: b.grid_y ?? 0,
    w: b.grid_w ?? 6,
    h: b.grid_h ?? 3,
  }))

  if (!iface) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-64 text-gray-400 text-sm">Chargement…</div>
      </Layout>
    )
  }

  const editingBlock = editingBlockId ? blocks.find(b => b.id === editingBlockId) : null

  return (
    <Layout>
      <div className="flex flex-col h-full">
        {/* Header */}
        <div className="flex items-center gap-3 px-6 py-3 border-b bg-white shrink-0">
          <DynamicIcon name={iface.icon || 'LayoutDashboard'} size={20} className={`text-${iface.color || 'indigo'}-600`} />
          <h1 className="text-lg font-semibold text-gray-900">{iface.name}</h1>

          {/* Page tabs */}
          <div className="flex items-center gap-1 ml-6 overflow-x-auto">
            {pages.map(page => (
              <div key={page.id} className="flex items-center group">
                <button
                  onClick={() => handlePageChange(page.id)}
                  className={`px-3 py-1.5 text-sm rounded transition-colors whitespace-nowrap ${
                    activePageId === page.id
                      ? 'bg-gray-100 font-medium text-gray-900'
                      : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50'
                  }`}
                >
                  {page.name}
                </button>
                {editMode && pages.length > 1 && (
                  <button
                    onClick={() => handleDeletePage(page.id)}
                    className="opacity-0 group-hover:opacity-100 p-0.5 text-gray-400 hover:text-red-500 transition-opacity"
                  >
                    <X size={12} />
                  </button>
                )}
              </div>
            ))}
            {editMode && (
              <button
                onClick={handleAddPage}
                className="px-2 py-1.5 text-sm text-gray-400 hover:text-gray-600 hover:bg-gray-50 rounded"
              >
                <Plus size={14} />
              </button>
            )}
          </div>

          {/* Edit button */}
          {isAdmin && (
            <button
              onClick={() => { setEditMode(!editMode); setEditingBlockId(null) }}
              className={`ml-auto px-3 py-1.5 text-sm rounded-lg transition-colors ${
                editMode
                  ? 'bg-indigo-600 text-white hover:bg-indigo-700'
                  : 'border border-gray-200 text-gray-600 hover:bg-gray-50'
              }`}
            >
              {editMode ? '✓ Terminer' : 'Modifier'}
            </button>
          )}
        </div>

        {/* Edit toolbar */}
        {editMode && (
          <div className="flex items-center gap-3 px-6 py-2 bg-indigo-50 border-b shrink-0">
            <BlockPickerDropdown onSelect={handleAddBlock} />
            <span className="text-xs text-indigo-500">Mode édition — glissez et redimensionnez les blocs</span>
          </div>
        )}

        {/* Grid area */}
        <div className="flex-1 overflow-y-auto bg-gray-50">
          <div ref={gridRef} className="relative">
            {blocks.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-24 text-gray-400">
                <p className="text-sm">Cette page est vide.</p>
                {editMode && (
                  <p className="text-xs mt-1">Utilisez "+ Ajouter un bloc" pour commencer.</p>
                )}
              </div>
            ) : (
              <ReactGridLayout
                className="layout"
                layout={layout}
                cols={12}
                rowHeight={80}
                width={gridWidth}
                isDraggable={editMode}
                isResizable={editMode}
                onLayoutChange={handleLayoutChange}
                draggableHandle=".block-drag-handle"
                compactType="vertical"
                margin={[16, 16]}
              >
                {blocks.map(block => {
                  // Conditional visibility in view mode
                  if (!editMode && block.condition) {
                    if (!evaluateBlockCondition(block.condition, filterValues, selectedRecord?.id)) {
                      return <div key={block.id} />
                    }
                  }

                  const isEditing = editingBlockId === block.id

                  return (
                    <div
                      key={block.id}
                      className={`bg-white rounded-lg border shadow-sm overflow-hidden relative group ${
                        isEditing ? 'ring-2 ring-indigo-400' : ''
                      }`}
                    >
                      {/* Edit overlay */}
                      {editMode && (
                        <div className="absolute top-0 left-0 right-0 z-10 flex items-center gap-1 px-2 py-1 bg-white/90 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity border-b">
                          <span className="block-drag-handle cursor-grab active:cursor-grabbing text-gray-400 hover:text-gray-600">
                            <GripHorizontal size={14} />
                          </span>
                          <span className="text-[10px] text-gray-400 uppercase tracking-wider flex-1">
                            {BLOCK_TYPES.find(bt => bt.type === block.type)?.label || block.type}
                          </span>
                          <button
                            onClick={() => setEditingBlockId(isEditing ? null : block.id)}
                            className={`p-0.5 transition-colors ${isEditing ? 'text-indigo-600' : 'text-gray-400 hover:text-indigo-600'}`}
                          >
                            <Settings size={13} />
                          </button>
                          <button
                            onClick={() => handleDeleteBlock(block.id)}
                            className="p-0.5 text-gray-400 hover:text-red-500"
                          >
                            <X size={13} />
                          </button>
                        </div>
                      )}

                      {/* Block content */}
                      <div className={`h-full ${editMode ? 'pt-7' : ''} p-3`}>
                        <BlockRenderer
                          block={block}
                          filterValues={filterValues}
                          selectedRecord={selectedRecord}
                          onRecordSelect={setSelectedRecord}
                          onFilterChange={handleFilterChange}
                          onRecordChange={() => loadBlocks(activePageId)}
                        />
                      </div>
                    </div>
                  )
                })}
              </ReactGridLayout>
            )}
          </div>
        </div>

        {/* BlockEditorPanel */}
        {editMode && editingBlock && (
          <BlockEditorPanel
            block={editingBlock}
            blocks={blocks}
            pageId={activePageId}
            onConfigChange={partial => handleBlockConfigChange(editingBlock.id, partial)}
            onClose={() => setEditingBlockId(null)}
            onDelete={() => handleDeleteBlock(editingBlock.id)}
          />
        )}
      </div>
    </Layout>
  )
}
