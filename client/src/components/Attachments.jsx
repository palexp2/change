import { useState, useEffect, useCallback, useRef } from 'react'
import { Upload, FileText, Image as ImageIcon, Download, Trash2, Loader2, Paperclip } from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from '../contexts/ToastContext.jsx'
import { useConfirm } from './ConfirmProvider.jsx'

function formatBytes(n) {
  if (!n && n !== 0) return ''
  if (n < 1024) return `${n} o`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} Ko`
  return `${(n / (1024 * 1024)).toFixed(1)} Mo`
}

function isImage(ct, name) {
  if (ct && ct.startsWith('image/')) return true
  return /\.(jpe?g|png|gif|webp|heic)$/i.test(name || '')
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
 */
export default function Attachments({ entityType, entityId, title = 'Pièces jointes', compact = false }) {
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
          <Loader2 size={16} className="text-brand-500 animate-spin" />
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
        <Loader2 size={14} className="animate-spin" /> Chargement…
      </div>
    ) : items.length === 0 ? (
      <p className="text-sm text-slate-400 py-2">Aucune pièce jointe.</p>
    ) : (
      <ul className="divide-y divide-slate-100" data-testid="attachment-list">
        {items.map(att => (
          <li key={att.id} className="flex items-center gap-3 py-2.5" data-testid="attachment-item">
            <span className="flex-shrink-0 text-slate-400">
              {isImage(att.content_type, att.file_name) ? <ImageIcon size={16} /> : <FileText size={16} />}
            </span>
            <div className="min-w-0 flex-1">
              <button
                onClick={() => handleDownload(att)}
                className="text-sm text-slate-800 hover:text-brand-600 hover:underline truncate block max-w-full text-left"
                title={att.file_name}
              >
                {att.file_name}
              </button>
              <div className="text-xs text-slate-400 mt-0.5">
                {formatBytes(att.file_size)}
                {att.uploaded_by_name ? ` · ${att.uploaded_by_name}` : ''}
              </div>
            </div>
            <div className="flex gap-1 flex-shrink-0">
              <button onClick={() => handleDownload(att)} className="text-slate-400 hover:text-brand-600 p-1" title="Télécharger">
                <Download size={14} />
              </button>
              <button onClick={() => handleDelete(att)} className="text-slate-400 hover:text-red-500 p-1" title="Supprimer">
                <Trash2 size={14} />
              </button>
            </div>
          </li>
        ))}
      </ul>
    )
  )

  if (compact) {
    return (
      <div className="space-y-3" data-testid="attachments">
        {dropZone}
        {list}
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
    </div>
  )
}
