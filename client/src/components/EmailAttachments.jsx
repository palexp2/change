import { useState, useEffect, useCallback } from 'react'
import { FileText, Image as ImageIcon, Download, Paperclip } from 'lucide-react'
import { api } from '../lib/api'
import { useToast } from '../contexts/ToastContext.jsx'
import { formatBytes } from '../utils/formatters.js'
import Spinner from './Spinner.jsx'

function isImage(ct, name) {
  if (ct && ct.startsWith('image/')) return true
  return /\.(jpe?g|png|gif|webp|heic)$/i.test(name || '')
}

/**
 * Pièces jointes de courriels Gmail — lecture seule (elles viennent de Gmail,
 * pas d'un upload manuel). Pour la variante manipulable générique
 * (upload/suppression), voir Attachments.jsx.
 *
 * Deux portées, une seule liste : `contactId` = toutes celles du contact
 * (fiche contact), `interactionId` = celles du seul courriel (fiche
 * interaction). `embedded` rend le bloc sans sa carte, pour être posé dans une
 * carte existante ; `hideWhenEmpty` le fait disparaître s'il n'y a rien.
 */
export default function EmailAttachments({ contactId, interactionId, embedded = false, hideWhenEmpty = false }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const { addToast } = useToast()

  const load = useCallback(async () => {
    if (!contactId && !interactionId) return
    setLoading(true)
    try {
      setItems(contactId
        ? await api.contacts.emailAttachments(contactId)
        : await api.interactions.attachments(interactionId))
    } catch (e) {
      addToast({ message: `Chargement des pièces jointes échoué : ${e.message}`, type: 'error' })
    } finally {
      setLoading(false)
    }
  }, [contactId, interactionId, addToast])

  useEffect(() => { load() }, [load])

  async function handleDownload(att) {
    try {
      const { blob, filename } = contactId
        ? await api.contacts.downloadEmailAttachment(contactId, att.id)
        : await api.interactions.downloadAttachment(interactionId, att.id)
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

  if (hideWhenEmpty && !loading && items.length === 0) return null

  const body = loading ? (
    <div className="flex items-center gap-2 text-sm text-slate-400 py-2">
      <Spinner size="xs" label="Chargement…" />
    </div>
  ) : items.length === 0 ? (
    <p className="text-sm text-slate-400 py-1">Aucune pièce jointe.</p>
  ) : (
    <ul className="divide-y divide-slate-100" data-testid="email-attachment-list">
      {items.map(att => (
        <li key={att.id} className="flex items-center gap-3 py-2.5" data-testid="email-attachment-item">
          <span className="flex-shrink-0 text-slate-400">
            {isImage(att.content_type, att.file_name) ? <ImageIcon size={16} /> : <FileText size={16} />}
          </span>
          <div className="min-w-0 flex-1">
            <button
              onClick={() => handleDownload(att)}
              className="text-sm text-slate-800 hover:text-brand-700 hover:underline truncate block max-w-full text-left"
              title={att.file_name}
            >
              {att.file_name}
            </button>
            <div className="text-xs text-slate-400 mt-0.5 truncate">
              {formatBytes(att.file_size)}{!interactionId && att.email_subject ? ` · ${att.email_subject}` : ''}
            </div>
          </div>
          <button onClick={() => handleDownload(att)} className="text-slate-400 hover:text-brand-600 p-1 flex-shrink-0" title="Télécharger">
            <Download size={14} />
          </button>
        </li>
      ))}
    </ul>
  )

  if (embedded) {
    return (
      <div data-testid="email-attachments">
        <div className="text-xs font-medium text-slate-400 uppercase tracking-wide mb-1.5 flex items-center gap-1.5">
          <Paperclip size={12} />
          Pièces jointes
          {items.length > 0 && <span className="text-slate-500">({items.length})</span>}
        </div>
        {body}
      </div>
    )
  }

  return (
    <div className="card p-4" data-testid="email-attachments">
      <div className="flex items-center gap-2 mb-3">
        <Paperclip size={15} className="text-slate-500" />
        <h3 className="text-sm font-semibold text-slate-700">Pièces jointes (courriels)</h3>
        {items.length > 0 && (
          <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">{items.length}</span>
        )}
      </div>
      {body}
    </div>
  )
}
