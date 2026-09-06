import { useState, useEffect, useRef, useCallback } from 'react'
import { Upload, Folder, FolderOpen, Copy, ExternalLink, FileText, Image as ImageIcon, File, RefreshCw, X } from 'lucide-react'
import { api } from '../lib/api.js'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import RecordPeekDrawer from '../components/RecordPeekDrawer.jsx'
import { DataTable } from '../components/DataTable.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { useConfirm } from '../components/ConfirmProvider.jsx'
import { TABLE_COLUMN_META } from '../lib/tableDefs.js'
import { fmtDate } from '../lib/formatDate.js'

const ROOT_LABEL = '— Racine —'

function publicUrl(token) {
  return `${window.location.origin}/erp/p/${token}`
}

import { formatBytes as humanSize } from '../utils/formatters.js'

function FileTypeIcon({ mime, size = 16 }) {
  if (!mime) return <File size={size} className="text-slate-400" />
  if (mime.startsWith('image/')) return <ImageIcon size={size} className="text-emerald-500" />
  if (mime === 'application/pdf') return <FileText size={size} className="text-red-500" />
  return <File size={size} className="text-slate-400" />
}

function UploadZone({ onUpload, uploading, defaultFolder }) {
  const { addToast } = useToast()
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef()

  function handleFiles(files) {
    if (!files?.length) return
    for (const file of files) {
      if (file.size > 100 * 1024 * 1024) {
        addToast({ message: `${file.name}: dépasse 100 Mo`, type: 'error' })
        continue
      }
      const fd = new FormData()
      fd.append('file', file)
      fd.append('folder', defaultFolder || '')
      onUpload(fd, file.name)
    }
  }

  return (
    <div
      className={`relative border-2 border-dashed rounded-xl p-6 text-center transition-colors cursor-pointer
        ${dragOver ? 'border-brand-500 bg-brand-50' : 'border-slate-300 bg-white hover:border-brand-400 hover:bg-slate-50'}
        ${uploading ? 'opacity-60 pointer-events-none' : ''}`}
      onDragOver={e => { e.preventDefault(); setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files) }}
      onClick={() => inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        onChange={e => { handleFiles(e.target.files); e.target.value = '' }}
        data-testid="public-files-input"
      />
      {uploading ? (
        <div className="flex flex-col items-center gap-2">
          <RefreshCw size={22} className="text-brand-500 animate-spin" />
          <p className="text-slate-600 text-sm font-medium">Téléversement…</p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-2">
          <div className="w-12 h-12 bg-brand-100 rounded-full flex items-center justify-center">
            <Upload size={20} className="text-brand-600" />
          </div>
          <div>
            <p className="text-slate-700 font-semibold text-sm">Glissez un ou plusieurs fichiers</p>
            <p className="text-slate-400 text-xs mt-0.5">ou cliquez pour parcourir — max 100 Mo / fichier</p>
            {defaultFolder
              ? <p className="text-brand-600 text-xs mt-1">→ dossier <strong>{defaultFolder}</strong></p>
              : <p className="text-slate-400 text-xs mt-1">→ racine</p>}
          </div>
        </div>
      )}
    </div>
  )
}

function FolderList({ folders, current, onSelect }) {
  const [search, setSearch] = useState('')
  const filtered = search
    ? folders.filter(f => (f.folder || ROOT_LABEL).toLowerCase().includes(search.toLowerCase()))
    : folders

  return (
    <div className="space-y-2">
      {folders.length > 10 && (
        <input
          type="text"
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="input-field text-xs w-full"
        />
      )}
      <button
        onClick={() => onSelect(null)}
        className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-sm transition-colors
          ${current === null ? 'bg-brand-600 text-white' : 'text-slate-700 hover:bg-slate-100'}`}
      >
        <FolderOpen size={14} className="flex-shrink-0" />
        <span className="flex-1 text-left truncate">Tous les fichiers</span>
      </button>
      {filtered.map(f => {
        const label = f.folder || ROOT_LABEL
        const active = current === f.folder
        return (
          <button
            key={f.folder || '__root__'}
            onClick={() => onSelect(f.folder)}
            className={`w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-sm transition-colors
              ${active ? 'bg-brand-600 text-white' : 'text-slate-700 hover:bg-slate-100'}`}
          >
            <Folder size={14} className="flex-shrink-0" />
            <span className="flex-1 text-left truncate">{label}</span>
            <span className={`text-xs ${active ? 'text-brand-100' : 'text-slate-400'}`}>{f.count}</span>
          </button>
        )
      })}
    </div>
  )
}

function CopyLinkButton({ token, label, dataTestid }) {
  const { addToast } = useToast()
  const [copied, setCopied] = useState(false)
  async function handle(e) {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(publicUrl(token))
      setCopied(true)
      addToast({ message: 'Lien copié', type: 'success' })
      setTimeout(() => setCopied(false), 1500)
    } catch {
      addToast({ message: 'Impossible de copier', type: 'error' })
    }
  }
  return (
    <button
      onClick={handle}
      className="inline-flex items-center gap-1 text-xs text-brand-600 hover:text-brand-700 hover:underline"
      data-testid={dataTestid}
    >
      <Copy size={12} />
      {copied ? 'Copié !' : (label || 'Copier le lien')}
    </button>
  )
}

function EditFileModal({ file, onClose, onChange }) {
  const { addToast } = useToast()
  const confirm = useConfirm()
  const [folder, setFolder] = useState(file.folder || '')
  const [description, setDescription] = useState(file.description || '')
  const [tagsText, setTagsText] = useState((file.tags || []).join(', '))
  const [originalName, setOriginalName] = useState(file.original_name || '')
  const [saving, setSaving] = useState(false)
  const [replacing, setReplacing] = useState(false)
  const replaceInputRef = useRef(null)

  const dirtyRef = useRef(false)
  useEffect(() => { dirtyRef.current = true }, [folder, description, tagsText, originalName])

  // Autosave debounced — pas de bouton "Enregistrer" (règle ERP).
  useEffect(() => {
    if (!dirtyRef.current) return
    const t = setTimeout(async () => {
      setSaving(true)
      try {
        const tags = tagsText.split(',').map(t => t.trim()).filter(Boolean)
        const updated = await api.publicFiles.update(file.id, {
          folder: folder.trim(),
          description: description.trim() || null,
          tags,
          original_name: originalName.trim() || file.original_name,
        })
        onChange?.(updated)
      } catch (e) {
        addToast({ message: 'Erreur: ' + e.message, type: 'error' })
      } finally {
        setSaving(false)
      }
    }, 500)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folder, description, tagsText, originalName])

  async function handleReplaceFile(e) {
    const picked = e.target.files?.[0]
    e.target.value = '' // permet de re-choisir le même fichier ensuite
    if (!picked) return

    const ok = await confirm({
      title: 'Remplacer le fichier ?',
      message: `Le contenu actuel de "${file.original_name}" sera remplacé par "${picked.name}". `
        + `L'ancien fichier sera supprimé définitivement. Le lien public reste identique : `
        + `tout endroit qui l'affiche montrera désormais le nouveau fichier.`,
      confirmLabel: 'Remplacer',
      danger: true,
    })
    if (!ok) return

    setReplacing(true)
    try {
      const fd = new FormData()
      fd.append('file', picked)
      const updated = await api.publicFiles.replace(file.id, fd)
      setOriginalName(updated.original_name || '')
      dirtyRef.current = false // évite un autosave parasite sur le nouveau nom
      onChange?.(updated)
      addToast({ message: 'Fichier remplacé', type: 'success' })
    } catch (err) {
      addToast({ message: 'Erreur: ' + err.message, type: 'error' })
    } finally {
      setReplacing(false)
    }
  }

  async function handleDelete() {
    const ok = await confirm({
      title: 'Supprimer ce fichier ?',
      message: `Le fichier "${file.original_name}" sera définitivement supprimé et le lien public deviendra inaccessible.`,
      confirmLabel: 'Supprimer',
      danger: true,
    })
    if (!ok) return
    try {
      await api.publicFiles.delete(file.id)
      onChange?.(null)
      onClose()
    } catch (e) {
      addToast({ message: 'Erreur: ' + e.message, type: 'error' })
    }
  }

  return (
    <RecordPeekDrawer open onClose={onClose} title={originalName || 'Détails du fichier'} width={680} peekKey="public_files">
      <div className="space-y-4 px-5 py-4">
        <div>
          <label className="label">Nom</label>
          <input
            className="input"
            value={originalName}
            onChange={e => setOriginalName(e.target.value)}
            data-testid="edit-original-name"
          />
        </div>
        <div>
          <label className="label">Dossier</label>
          <input
            className="input"
            value={folder}
            onChange={e => setFolder(e.target.value)}
            data-testid="edit-folder"
          />
          <p className="text-xs text-slate-400 mt-1">Organise les fichiers sans affecter l'URL publique.</p>
        </div>
        <div>
          <label className="label">Description</label>
          <textarea
            className="input min-h-[60px]"
            value={description}
            onChange={e => setDescription(e.target.value)}
            data-testid="edit-description"
          />
        </div>
        <div>
          <label className="label">Étiquettes</label>
          <input
            className="input"
            value={tagsText}
            onChange={e => setTagsText(e.target.value)}
            data-testid="edit-tags"
          />
        </div>
        <div className="border-t border-slate-200 pt-3">
          <label className="label">Lien public</label>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs bg-slate-100 px-2 py-1.5 rounded break-all">{publicUrl(file.token)}</code>
            <CopyLinkButton token={file.token} dataTestid="edit-copy" />
            <a
              href={publicUrl(file.token)}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-slate-600 hover:text-slate-900"
            >
              <ExternalLink size={12} /> Ouvrir
            </a>
          </div>
          <div className="mt-3">
            <input
              ref={replaceInputRef}
              type="file"
              className="hidden"
              data-testid="replace-file-input"
              onChange={handleReplaceFile}
            />
            <button
              type="button"
              onClick={() => replaceInputRef.current?.click()}
              disabled={replacing}
              data-testid="replace-file-btn"
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-slate-300 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              {replacing
                ? <><RefreshCw size={14} className="animate-spin" /> Remplacement…</>
                : <><Upload size={14} /> Remplacer le fichier</>}
            </button>
            <p className="text-xs text-slate-400 mt-1">Garde le même lien public — remplace seulement le contenu.</p>
          </div>
        </div>
        <div className="flex items-center justify-between pt-2">
          <button
            onClick={handleDelete}
            className="text-sm text-red-500 hover:text-red-700 hover:underline"
            data-testid="edit-delete"
          >
            Supprimer ce fichier
          </button>
          <span className="text-xs text-slate-400">
            {saving ? <span className="inline-flex items-center gap-1"><RefreshCw size={11} className="animate-spin" /> Sauvegarde…</span> : 'Sauvegarde automatique'}
          </span>
        </div>
      </div>
    </RecordPeekDrawer>
  )
}

export default function PublicFiles() {
  const { addToast } = useToast()
  const confirm = useConfirm()
  const [files, setFiles] = useState([])
  const [folders, setFolders] = useState([])
  const [currentFolder, setCurrentFolder] = useState(null) // null = tous
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [editing, setEditing] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const params = currentFolder !== null ? { folder: currentFolder } : {}
      const [{ data }, foldersResp] = await Promise.all([
        api.publicFiles.list(params),
        api.publicFiles.folders(),
      ])
      setFiles(data || [])
      setFolders(foldersResp.data || [])
    } finally {
      setLoading(false)
    }
  }, [currentFolder])

  useEffect(() => { load() }, [load])

  async function handleUpload(formData, name) {
    setUploading(true)
    try {
      await api.publicFiles.upload(formData)
      addToast({ message: `${name} téléversé`, type: 'success' })
      await load()
    } catch (e) {
      addToast({ message: `${name}: ${e.message}`, type: 'error' })
    } finally {
      setUploading(false)
    }
  }

  async function handleBulkDelete(ids) {
    const ok = await confirm({
      title: `Supprimer ${ids.length} fichier${ids.length > 1 ? 's' : ''} ?`,
      message: 'Les liens publics correspondants deviendront inaccessibles. Action irréversible.',
      confirmLabel: 'Supprimer',
      danger: true,
    })
    if (!ok) return
    try {
      await Promise.all(ids.map(id => api.publicFiles.delete(id)))
      await load()
      addToast({ message: `${ids.length} fichier${ids.length > 1 ? 's' : ''} supprimé${ids.length > 1 ? 's' : ''}`, type: 'success' })
    } catch (e) {
      addToast({ message: 'Erreur: ' + e.message, type: 'error' })
    }
  }

  const RENDERS = {
    original_name: (row) => (
      <div className="flex items-center gap-2">
        <FileTypeIcon mime={row.mime_type} />
        <span className="text-sm font-medium text-slate-900 truncate">{row.original_name}</span>
      </div>
    ),
    folder: (row) => row.folder
      ? <span className="inline-flex items-center gap-1 text-xs bg-slate-100 text-slate-700 px-2 py-0.5 rounded"><Folder size={11} />{row.folder}</span>
      : <span className="text-slate-400 text-xs">—</span>,
    description: (row) => row.description
      ? <span className="text-sm text-slate-600 line-clamp-1">{row.description}</span>
      : <span className="text-slate-300 text-xs">—</span>,
    tags: (row) => Array.isArray(row.tags) && row.tags.length > 0
      ? (
        <div className="flex flex-wrap gap-1">
          {row.tags.map((t, i) => (
            <span key={i} className="text-xs bg-brand-100 text-brand-700 px-1.5 py-0.5 rounded">{t}</span>
          ))}
        </div>
      )
      : <span className="text-slate-300 text-xs">—</span>,
    mime_type: (row) => <span className="text-xs text-slate-500">{row.mime_type || '—'}</span>,
    size: (row) => <span className="text-sm text-slate-600 tabular-nums">{humanSize(row.size)}</span>,
    uploaded_by_name: (row) => row.uploaded_by_name || <span className="text-slate-400">—</span>,
    created_at: (row) => fmtDate(row.created_at),
    link: (row) => (
      <div className="flex items-center gap-2">
        <CopyLinkButton token={row.token} dataTestid={`copy-${row.id}`} />
        <a
          href={publicUrl(row.token)}
          target="_blank"
          rel="noopener noreferrer"
          onClick={e => e.stopPropagation()}
          className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-slate-800"
        >
          <ExternalLink size={11} />
        </a>
      </div>
    ),
  }

  const COLUMNS = TABLE_COLUMN_META.public_files.map(meta => ({ ...meta, render: RENDERS[meta.id] }))

  return (
    <Layout>
      <div className="flex h-full overflow-hidden">
        {/* Sidebar dossiers */}
        <div className="w-64 flex-shrink-0 bg-white border-r border-slate-200 flex flex-col overflow-hidden">
          <div className="px-4 pt-5 pb-3 border-b border-slate-100">
            <h2 className="text-sm font-bold text-slate-900">Dossiers</h2>
            <p className="text-xs text-slate-400 mt-0.5">{folders.length} dossier{folders.length !== 1 ? 's' : ''}</p>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            <FolderList folders={folders} current={currentFolder} onSelect={setCurrentFolder} />
          </div>
        </div>

        {/* Main */}
        <div className="flex-1 flex flex-col overflow-hidden bg-slate-50">
          <div className="px-6 pt-6 pb-4 border-b border-slate-200 bg-white">
            <div className="flex items-center justify-between mb-4">
              <div>
                <PageTitle>Fichiers publics</PageTitle>
                <p className="text-sm text-slate-500 mt-0.5">
                  {currentFolder !== null
                    ? <>Dossier : <strong>{currentFolder || ROOT_LABEL}</strong> — {files.length} fichier{files.length !== 1 ? 's' : ''}</>
                    : <>{files.length} fichier{files.length !== 1 ? 's' : ''} au total</>}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {currentFolder !== null && (
                  <button
                    onClick={() => setCurrentFolder(null)}
                    className="btn-secondary text-xs"
                    title="Effacer le filtre de dossier"
                  >
                    <X size={12} /> Tous
                  </button>
                )}
              </div>
            </div>
            <UploadZone
              onUpload={handleUpload}
              uploading={uploading}
              defaultFolder={currentFolder || ''}
            />
          </div>

          <div className="flex-1 overflow-auto p-6">
            <DataTable
              table="public_files"
              manageViews
              columns={COLUMNS}
              data={files}
              loading={loading}
              onRowClick={(row) => setEditing(row)}
              searchFields={['original_name', 'description', 'folder']}
              onBulkDelete={handleBulkDelete}
            />
          </div>
        </div>
      </div>

      {editing && (
        <EditFileModal
          file={editing}
          onClose={() => setEditing(null)}
          onChange={(updated) => {
            if (updated === null) {
              setEditing(null)
              load()
            } else {
              setFiles(fs => fs.map(f => f.id === updated.id ? updated : f))
              setEditing(updated)
            }
          }}
        />
      )}
    </Layout>
  )
}
