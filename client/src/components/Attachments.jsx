import { useState, useEffect, useCallback, useRef } from 'react'
import { Upload, FileText, Download, Trash2, Paperclip, Pencil } from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from '../contexts/ToastContext.jsx'
import { useConfirm } from './ConfirmProvider.jsx'

import { formatBytes } from '../utils/formatters.js'
import Spinner from './Spinner.jsx'
import AttachmentPreview, { AttachmentPreviewModal, attachmentKind } from './AttachmentPreview.jsx'
import ThinkingOrb from './ThinkingOrb'

// URL de service du fichier. `usePrivateFile` (dans AttachmentPreview) sait
// récupérer les chemins `/erp/api/…` avec le jeton et en faire une blob: URL —
// on n'a donc pas à porter le token dans l'URL.
function fileUrl(entityType, entityId, attId) {
  return `/erp/api/attachments/${encodeURIComponent(entityType)}/${encodeURIComponent(entityId)}/${encodeURIComponent(attId)}/download`
}

// Une ligne de la liste : vignette du contenu (image ou 1re page du PDF) et
// nom cliquable qui ouvre le document en modale — jamais un téléchargement
// déguisé. Le téléchargement reste une action à part (bouton ↓).
//
// Les formats qu'on ne sait pas dessiner (doc, zip…) gardent l'icône
// générique et téléchargent au clic : rien à montrer en modale, et on évite de
// rapatrier un gros fichier juste pour afficher « aperçu indisponible ».
// `onRename` (optionnel) : crayon → champ en ligne ; Entrée ou sortie du champ
// enregistre, Échap annule.
function AttachmentRow({ att, entityType, entityId, onDownload, onDelete, onRename }) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const editRef = useRef()
  useEffect(() => {
    if (!editing || !editRef.current) return
    const el = editRef.current
    const dot = draft.lastIndexOf('.')
    el.focus()
    el.setSelectionRange(0, dot > 0 ? dot : draft.length)
  }, [editing]) // eslint-disable-line react-hooks/exhaustive-deps

  function startEdit() { setDraft(att.file_name || ''); setEditing(true) }
  function commit() {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== att.file_name) onRename(next)
  }
  const url = fileUrl(entityType, entityId, att.id)
  const kind = attachmentKind({ fileName: att.file_name, contentType: att.content_type })
  const previewable = kind === 'image' || kind === 'pdf' || kind === 'sheet'

  return (
    <li className="flex items-center gap-3 py-2.5" data-testid="attachment-item">
      {previewable ? (
        // Boîte à taille fixe : la vignette n'apparaît qu'une fois le fichier
        // rapatrié, la ligne ne doit pas sauter entre-temps.
        <span className="flex-shrink-0 w-14 h-14">
          <AttachmentPreview
            url={url}
            fileName={att.file_name}
            contentType={att.content_type}
            kind={kind}
            size="compact"
            showFileName={false}
            testId="attachment-thumb"
          />
        </span>
      ) : (
        <span className="flex-shrink-0 text-slate-400">
          <FileText size={16} />
        </span>
      )}
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            ref={editRef}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); commit() }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(false) }
            }}
            className="input text-sm w-full py-0.5"
            data-testid="attachment-name-input"
          />
        ) : (
          <button
            onClick={() => (previewable ? setOpen(true) : onDownload())}
            className="text-sm text-slate-800 hover:text-brand-700 hover:underline truncate block max-w-full text-left"
            title={att.file_name}
            data-testid="attachment-name"
          >
            {att.file_name}
          </button>
        )}
        <div className="text-xs text-slate-400 mt-0.5">
          {formatBytes(att.file_size)}
          {att.uploaded_by_name ? ` · ${att.uploaded_by_name}` : ''}
        </div>
      </div>
      <div className="flex gap-1 flex-shrink-0">
        {onRename && (
          <button onClick={startEdit} className="text-slate-400 hover:text-brand-600 p-1" title="Renommer" data-testid="attachment-rename">
            <Pencil size={14} />
          </button>
        )}
        <button onClick={onDownload} className="text-slate-400 hover:text-brand-600 p-1" title="Télécharger">
          <Download size={14} />
        </button>
        <button onClick={onDelete} className="text-slate-400 hover:text-red-500 p-1" title="Supprimer">
          <Trash2 size={14} />
        </button>
      </div>
      {open && (
        <AttachmentPreviewModal
          url={url}
          fileName={att.file_name}
          kind={kind}
          onClose={() => setOpen(false)}
        />
      )}
    </li>
  )
}

/**
 * Composant de pièces jointes réutilisable, attachable à n'importe quelle
 * entité via (entityType, entityId). Glisser-déposer + clic pour parcourir,
 * liste avec téléchargement et suppression. Upload immédiat (pas de bouton
 * « Enregistrer » — conforme à la règle autosave).
 *
 * Props :
 *  - entityType : 'companies' | 'contacts' | 'orders' | 'tickets' | … (whitelist serveur)
 *  - entityId   : id de l'enregistrement cible
 *  - title      : titre de section (défaut « Pièces jointes »)
 *  - compact    : variante condensée (sans carte/titre) pour insertion en sidebar
 *  - renamable  : crayon « Renommer » sur chaque fichier
 *  - children   : contenu propre à la page, posé sous la liste (ex. notes)
 */
export default function Attachments({ entityType, entityId, title = 'Pièces jointes', compact = false, renamable = false, children = null }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef()
  const { addToast } = useToast()
  const confirm = useConfirm()

  const load = useCallback(async () => {
    if (!entityType || !entityId) return
    setLoading(true)
    try {
      const data = await api.attachments.list(entityType, entityId)
      setItems(data)
    } catch (e) {
      addToast({ message: `Chargement des pièces jointes échoué : ${e.message}`, type: 'error' })
    } finally {
      setLoading(false)
    }
  }, [entityType, entityId, addToast])

  useEffect(() => { load() }, [load])

  async function handleFiles(fileList) {
    const files = Array.from(fileList || [])
    if (!files.length) return
    setUploading(true)
    try {
      await api.attachments.upload(entityType, entityId, files)
      addToast({ message: files.length > 1 ? `${files.length} fichiers ajoutés` : 'Fichier ajouté', type: 'success' })
      await load()
    } catch (e) {
      addToast({ message: `Téléversement échoué : ${e.message}`, type: 'error' })
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  async function handleDownload(att) {
    try {
      const { blob, filename } = await api.attachments.download(entityType, entityId, att.id)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename || att.file_name
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) {
      addToast({ message: `Téléchargement échoué : ${e.message}`, type: 'error' })
    }
  }

  async function handleDelete(att) {
    if (!(await confirm(`Supprimer « ${att.file_name} » ?`))) return
    try {
      await api.attachments.delete(entityType, entityId, att.id)
      setItems(prev => prev.filter(x => x.id !== att.id))
      addToast({ message: 'Pièce jointe supprimée', type: 'success' })
    } catch (e) {
      addToast({ message: `Suppression échouée : ${e.message}`, type: 'error' })
    }
  }

  async function handleRename(att, fileName) {
    const prevName = att.file_name
    setItems(prev => prev.map(x => (x.id === att.id ? { ...x, file_name: fileName } : x)))
    try {
      const updated = await api.attachments.rename(entityType, entityId, att.id, fileName)
      setItems(prev => prev.map(x => (x.id === att.id ? updated : x)))
    } catch (e) {
      setItems(prev => prev.map(x => (x.id === att.id ? { ...x, file_name: prevName } : x)))
      addToast({ message: `Renommage échoué : ${e.message}`, type: 'error' })
    }
  }

  const dropZone = (
    <div
      data-testid="attachment-dropzone"
      className={`relative border-2 border-dashed rounded-xl px-4 py-5 text-center cursor-pointer transition-colors
        ${dragOver ? 'border-brand-500 bg-brand-50' : 'border-slate-300 hover:border-slate-400 bg-slate-50'}
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
        data-testid="attachment-input"
        onChange={e => handleFiles(e.target.files)}
      />
      {uploading ? (
        <div className="flex items-center justify-center gap-2 text-slate-600">
          <ThinkingOrb size={16} ink className="text-brand-500" />
          <span className="text-sm font-medium">Téléversement en cours…</span>
        </div>
      ) : (
        <div className="flex items-center justify-center gap-3 text-slate-500">
          <Upload size={18} className="text-brand-600" />
          <span className="text-sm font-medium">Glissez des fichiers ici ou cliquez pour parcourir</span>
        </div>
      )}
    </div>
  )

  const list = (
    loading ? (
      <div className="flex items-center gap-2 text-sm text-slate-400 py-3">
        <Spinner size="xs" label="Chargement…" />
      </div>
    ) : items.length === 0 ? (
      <p className="text-sm text-slate-400 py-2">Aucune pièce jointe.</p>
    ) : (
      <ul className="divide-y divide-slate-100" data-testid="attachment-list">
        {items.map(att => (
          <AttachmentRow
            key={att.id}
            att={att}
            entityType={entityType}
            entityId={entityId}
            onDownload={() => handleDownload(att)}
            onDelete={() => handleDelete(att)}
            onRename={renamable ? name => handleRename(att, name) : undefined}
          />
        ))}
      </ul>
    )
  )

  if (compact) {
    return (
      <div className="space-y-3" data-testid="attachments">
        {dropZone}
        {list}
        {children}
      </div>
    )
  }

  return (
    <div className="card p-6" data-testid="attachments">
      <div className="flex items-center gap-2 mb-4">
        <Paperclip size={15} className="text-slate-500" />
        <h3 className="text-sm font-semibold text-slate-700">{title}</h3>
        {items.length > 0 && (
          <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">{items.length}</span>
        )}
      </div>
      {dropZone}
      <div className="mt-3">{list}</div>
      {children && <div className="mt-4">{children}</div>}
    </div>
  )
}
