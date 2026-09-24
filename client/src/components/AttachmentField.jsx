import { useCallback, useMemo, useRef, useState } from 'react'
import { Plus, X } from 'lucide-react'
import api from '../lib/api.js'
import AttachmentPreview, { attachmentKind } from './AttachmentPreview.jsx'
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
  // Il est mémorisé avec le contexte (champ + fiche) et la valeur qu'il
  // recouvre : dès que l'un des deux change, la valeur reçue reprend la main.
  const ctx = `${field?.id ?? ''}:${recordId ?? ''}`
  const latest = useRef({ ctx, value })
  latest.current = { ctx, value }
  const [local, setLocal] = useState(null)
  const fromValue = useMemo(() => parseAttachments(value), [value])
  const files = local && local.ctx === ctx && local.base === value ? local.files : fromValue
  const disabled = readOnly || !field?.id || !recordId

  // Une réponse arrivée après un changement de fiche/champ est ignorée : elle
  // décrirait les fichiers d'un autre enregistrement.
  const publish = useCallback((reqCtx, next) => {
    if (latest.current.ctx !== reqCtx) return
    setLocal({ ctx: reqCtx, base: latest.current.value, files: next })
    onChange?.(next.length ? JSON.stringify(next) : null)
  }, [onChange])

  async function addFiles(fileList) {
    const picked = Array.from(fileList || [])
    if (!picked.length || disabled) return
    const reqCtx = ctx
    setBusy(true)
    try {
      const r = await api.customFields.files.upload(field.id, recordId, picked)
      publish(reqCtx, r.data || [])
    } catch (e) {
      addToast({ message: e.message || 'Échec du dépôt', type: 'error' })
    } finally {
      setBusy(false)
    }
  }

  async function removeFile(fileId) {
    if (disabled) return
    const reqCtx = ctx
    setBusy(true)
    try {
      const r = await api.customFields.files.remove(field.id, recordId, fileId)
      publish(reqCtx, r.data || [])
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
          <span key={f.id} className="group relative inline-flex shrink-0" title={title}>
            {/* Vignette (image ou 1re page du PDF) ; un clic ouvre la modale. */}
            <AttachmentPreview
              url={href}
              fileName={f.name || 'fichier'}
              kind={isImageAttachment(f) ? 'image' : attachmentKind({ fileName: f.name, contentType: f.type })}
              size="compact"
              showFileName={false}
              testId="cf-attachment-preview"
            />
            {!disabled && (
              <button
                type="button"
                onClick={e => { e.stopPropagation(); removeFile(f.id) }}
                title="Retirer"
                data-testid="cf-attachment-remove"
                className="absolute -right-1.5 -top-1.5 z-10 hidden h-4 w-4 items-center justify-center rounded-full border border-slate-300 bg-white text-slate-500 shadow-sm hover:text-red-600 group-hover:flex"
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
