import { useCallback, useMemo, useRef, useState } from 'react'
import { Paperclip, Plus, X } from 'lucide-react'
import api from '../lib/api.js'
import { useToast } from '../contexts/ToastContext.jsx'
import {
  parseAttachments, attachmentFileUrl, isImageAttachment, formatFileSize,
} from '../lib/customFieldDisplay.jsx'

// Éditeur d'un champ personnalisé de type « Attachement » : dépose des fichiers
// (PDF, images, tableurs…) sur un enregistrement.
//
// Particularité : ce champ s'écrit TOUT SEUL. Le dépôt est déjà une écriture
// serveur (multipart → disque), donc la même route met la cellule à jour et
// renvoie la nouvelle liste — pas besoin que la route PATCH de la table
// whiteliste la colonne cf_. `onChange(nouvelleValeur)` sert seulement à ce que
// la fiche affiche le résultat sans attendre le prochain rafraîchissement.
//
//   <AttachmentField field={f} recordId={product.id} value={product[f.column_name]} onChange={v => …} />
export function AttachmentField({ field, recordId, value, onChange, readOnly = false }) {
  const { addToast } = useToast()
  const inputRef = useRef(null)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  // La liste vient de la valeur de la cellule ; l'état local ne sert qu'entre
  // deux réponses serveur (la fiche n'a pas toujours de quoi se re-rendre).
  const [local, setLocal] = useState(null)
  const fromValue = useMemo(() => parseAttachments(value), [value])
  const files = local ?? fromValue
  const disabled = readOnly || !field?.id || !recordId

  const publish = useCallback((next) => {
    setLocal(next)
    onChange?.(next.length ? JSON.stringify(next) : null)
  }, [onChange])

  async function addFiles(fileList) {
    const picked = Array.from(fileList || [])
    if (!picked.length || disabled) return
    setBusy(true)
    try {
      const r = await api.customFields.files.upload(field.id, recordId, picked)
      publish(r.data || [])
    } catch (e) {
      addToast({ message: e.message || 'Échec du dépôt', type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  async function removeFile(fileId) {
    if (disabled) return
    setBusy(true)
    try {
      const r = await api.customFields.files.remove(field.id, recordId, fileId)
      publish(r.data || [])
    } catch (e) {
      addToast({ message: e.message || 'Échec de la suppression', type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      data-testid={`cf-attachment-field-${field?.column_name || field?.id || ''}`}
      onDragOver={disabled ? undefined : (e => { e.preventDefault(); setDragging(true) })}
      onDragLeave={disabled ? undefined : (() => setDragging(false))}
      onDrop={disabled ? undefined : (e => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer?.files) })}
      className={`flex flex-wrap items-center gap-2 rounded-md border border-dashed p-1.5 transition-colors ${
        dragging ? 'border-brand-400 bg-brand-50' : 'border-slate-200'
      }${busy ? ' opacity-60' : ''}`}
    >
      {files.map(f => {
        const href = attachmentFileUrl(field.id, recordId, f.id)
        const title = [f.name, formatFileSize(f.size)].filter(Boolean).join(' · ')
        return (
          <span key={f.id} className="group relative inline-flex shrink-0">
            {isImageAttachment(f) ? (
              <a href={href} target="_blank" rel="noopener noreferrer" title={title} className="inline-block">
                <img src={href} alt={f.name || ''} loading="lazy"
                  className="h-12 w-12 rounded border border-slate-200 object-cover bg-white" />
              </a>
            ) : (
              <a
                href={href} target="_blank" rel="noopener noreferrer" title={title}
                className="inline-flex max-w-[11rem] items-center gap-1 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-600 hover:border-brand-300 hover:text-brand-700"
              >
                <Paperclip size={12} className="shrink-0 opacity-70" />
                <span className="truncate">{f.name || 'fichier'}</span>
              </a>
            )}
            {!disabled && (
              <button
                type="button"
                onClick={() => removeFile(f.id)}
                title="Retirer"
                data-testid="cf-attachment-remove"
                className="absolute -right-1.5 -top-1.5 hidden h-4 w-4 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-500 shadow-sm hover:text-red-600 group-hover:flex"
              >
                <X size={10} />
              </button>
            )}
          </span>
        )
      })}
      {!disabled && (
        <>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            title="Ajouter un fichier"
            data-testid="cf-attachment-add"
            className="inline-flex h-8 w-8 items-center justify-center rounded border border-slate-200 text-slate-400 hover:border-brand-300 hover:text-brand-600"
          >
            <Plus size={14} />
          </button>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={e => { addFiles(e.target.files); e.target.value = '' }}
          />
        </>
      )}
      {files.length === 0 && disabled && <span className="text-sm text-slate-400">—</span>}
    </div>
  )
}

export default AttachmentField
