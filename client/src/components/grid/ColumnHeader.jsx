import { useRef } from 'react'
import {
  Type, Hash, ToggleLeft, Calendar, Mail, Link2, List,
  Paperclip, Link, Sigma, Eye, Clock, SortAsc, SortDesc,
  ChevronDown, Phone, Globe, AlignLeft, Layers
} from 'lucide-react'

const TYPE_ICONS = {
  text: Type,
  long_text: AlignLeft,
  number: Hash,
  boolean: ToggleLeft,
  date: Calendar,
  datetime: Calendar,
  email: Mail,
  phone: Phone,
  url: Globe,
  select: List,
  multi_select: Layers,
  attachment: Paperclip,
  link: Link,
  formula: Sigma,
  lookup: Eye,
  rollup: Sigma,
  created_at: Clock,
  updated_at: Clock,
  autonumber: Hash,
}

export function ColumnHeader({ field, width, sort, onSort, onResize, onMenuOpen }) {
  const resizeRef = useRef()
  const Icon = TYPE_ICONS[field.type] || Type

  // Drag-to-resize
  function onMouseDown(e) {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = width

    function onMove(me) {
      const delta = me.clientX - startX
      onResize(Math.max(80, startW + delta))
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  function handleSort() {
    if (!onSort) return
    if (!sort) onSort('asc')
    else if (sort === 'asc') onSort('desc')
    else onSort(null)
  }

  return (
    <div
      className="relative flex items-center h-full px-2 gap-1 select-none group bg-slate-50 border-r border-slate-200 hover:bg-slate-100 cursor-pointer"
      style={{ width }}
      onClick={handleSort}
    >
      <Icon size={13} className="flex-shrink-0 text-slate-400" />
      <span className="flex-1 text-xs font-medium text-slate-700 truncate">{field.name}</span>

      {sort === 'asc' && <SortAsc size={13} className="flex-shrink-0 text-indigo-500" />}
      {sort === 'desc' && <SortDesc size={13} className="flex-shrink-0 text-indigo-500" />}

      {onMenuOpen && (
        <button
          className="opacity-0 group-hover:opacity-100 flex-shrink-0 p-0.5 rounded hover:bg-slate-200 transition-opacity"
          onClick={e => { e.stopPropagation(); onMenuOpen(field, e) }}
        >
          <ChevronDown size={12} className="text-slate-500" />
        </button>
      )}

      {/* Resize handle */}
      <div
        ref={resizeRef}
        className="absolute right-0 top-0 bottom-0 w-2 cursor-col-resize hover:bg-indigo-500/20 group-hover:opacity-100 opacity-0 transition-opacity"
        onMouseDown={onMouseDown}
        onClick={e => e.stopPropagation()}
      />
    </div>
  )
}
