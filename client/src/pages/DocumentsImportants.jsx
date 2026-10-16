import { useMemo, useRef, useState } from 'react'
import { FileArchive, Upload } from 'lucide-react'
import api from '../lib/api.js'
import { useTable } from '../lib/dataStore.js'
import { useListData } from '../lib/useListData.js'
import { ListPage } from '../components/ListPage.jsx'
import { DataTable } from '../components/DataTable.jsx'
import ErrorBanner from '../components/ErrorBanner.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'
import { RecordOps } from '../lib/recordOps.js'

// Documents importants de l'entreprise : statuts, assurances, permis…
// Un dépôt = un document par fichier ; le reste s'édite dans le tableau.
const DASH = <span className="text-slate-300">—</span>
const SOON_DAYS = 60

function expiryRender(row) {
  if (!row.expires_at) return DASH
  const days = (new Date(row.expires_at) - new Date()) / 86400000
  const cls = days < 0 ? 'text-red-600 font-medium' : days < SOON_DAYS ? 'text-amber-600 font-medium' : 'text-slate-600'
  return <span className={cls}>{fmtDate(row.expires_at)}</span>
}

const RENDERS = {
  name: row => <span className="text-slate-800 truncate">{row.name}</span>,
  expires_at: expiryRender,
  file: row => row.original_name
    ? <a href={api.importantDocuments.fileUrl(row.id)} target="_blank" rel="noreferrer" onClick={e => e.stopPropagation()} className="link-record truncate">{row.original_name}</a>
    : DASH,
  created_at: row => <span className="text-slate-500">{fmtDate(row.created_at)}</span>,
}

const EDITABLE = new Set(['name', 'category', 'expires_at', 'notes'])
const COLUMNS = TABLE_COLUMN_META.important_documents.map(meta => ({
  ...meta,
  render: RENDERS[meta.id],
  editable: EDITABLE.has(meta.id),
}))

export default function DocumentsImportants() {
  const { addToast } = useToast()
  const users = useTable('users')
  const inputRef = useRef(null)
  const [uploading, setUploading] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState(null)
  const { rows, loading, setRows } = useListData({
    fetch: () => api.importantDocuments.list(),
    cacheKey: 'important_documents',
    realtime: 'important_document',
  })

  const docs = useMemo(() => {
    const byId = new Map(users.map(u => [u.id, u.name]))
    return rows.map(r => ({ ...r, uploaded_by_name: r.uploaded_by ? byId.get(r.uploaded_by) || null : null }))
  }, [rows, users])

  async function uploadFiles(fileList) {
    const files = [...(fileList || [])]
    if (!files.length) return
    setUploading(true); setError(null)
    try {
      const { data } = await api.importantDocuments.upload(files)
      setRows(prev => [...prev.filter(r => !data.some(d => d.id === r.id)), ...data])
    } catch (e) { setError(e.message) }
    finally { setUploading(false); if (inputRef.current) inputRef.current.value = '' }
  }

  async function handleCellEdit(row, col, value) {
    try {
      const updated = await api.importantDocuments.update(row.id, { [col.field]: value === '' ? null : value })
      setRows(prev => prev.map(r => r.id === row.id ? { ...r, ...updated } : r))
    } catch (e) {
      addToast({ message: e.message || 'Modification impossible', type: 'error' })
      throw e
    }
  }

  const ops = useMemo(() => new RecordOps({
    labels: { delete: 'Supprimer le document', deleted: 'Document supprimé' },
    remove: async row => {
      await api.importantDocuments.delete(row.id)
      setRows(prev => prev.filter(r => r.id !== row.id))
    },
    deleteConfirm: row => `Supprimer « ${row.name} » ?`,
  }), [setRows])

  const onDrop = e => {
    if (!e.dataTransfer?.files?.length) return
    e.preventDefault(); setDragging(false)
    uploadFiles(e.dataTransfer.files)
  }

  return (
    <ListPage
      title="Documents importants"
      icon={FileArchive}
      banner={error && <ErrorBanner>{error}</ErrorBanner>}
      actions={
        <>
          <input ref={inputRef} type="file" multiple className="hidden" onChange={e => uploadFiles(e.target.files)} />
          <button type="button" className="btn-primary" disabled={uploading} onClick={() => inputRef.current?.click()}>
            <Upload size={16} /> {uploading ? 'Envoi…' : 'Ajouter'}
          </button>
        </>
      }
    >
      <div
        onDragOver={e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); setDragging(true) } }}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false) }}
        onDrop={onDrop}
        className={dragging ? 'rounded-lg ring-2 ring-brand-400 ring-offset-2' : ''}
      >
        <DataTable
          table="important_documents"
          columns={COLUMNS}
          data={docs}
          loading={loading}
          onCellEdit={handleCellEdit}
          dateCellPicker
          fullHeightCells
          seamlessCellInput
          recordOps={ops}
          searchFields={['name', 'category', 'notes', 'original_name']}
          emptyState={{
            icon: FileArchive,
            title: 'Aucun document',
            cta: { label: 'Ajouter', icon: Upload, onClick: () => inputRef.current?.click() },
          }}
        />
      </div>
    </ListPage>
  )
}
