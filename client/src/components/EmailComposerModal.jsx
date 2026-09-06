import { useState, useEffect, useRef } from 'react'
import { Mail, Paperclip, AlertTriangle } from 'lucide-react'
import { Modal } from './Modal.jsx'
import Spinner from './Spinner.jsx'
import { useUndoSend } from './UndoSendProvider.jsx'
import { useToast } from '../contexts/ToastContext.jsx'
import { splitEmailHtml, joinEmailHtml, isValidEmailList } from '../lib/emailHtml.js'
import ErrorBanner from './ErrorBanner.jsx'

// Modale de composition unique pour TOUS les courriels partant de l'ERP
// (instructions de retour, suivi d'un envoi, bon de commande au fournisseur…).
// Il n'y a plus de bouton « Aperçu » séparé : « Envoyer » ouvre cette modale,
// qui EST l'aperçu — destinataire, Cc, objet et corps modifiables, pièces
// jointes listées. Le bouton « Envoyer » ferme la modale et planifie l'envoi
// avec la fenêtre d'annulation de 3 s (UndoSendProvider) : pas de confirmation
// supplémentaire, l'action est réversible.
//
// Le corps est édité en place (contentEditable) : l'enveloppe du document
// (<head>, styles du <body>) est conservée et recollée à l'envoi, cf.
// lib/emailHtml.js.
export default function EmailComposerModal({
  isOpen,
  onClose,
  title = 'Envoyer un courriel',
  size = 'lg',
  load,                 // async () => { to, cc, from, subject, bodyHtml, attachments, notice }
  draft: draftProp,     // brouillon fourni directement (quand la page l'a déjà)
  headerExtra = null,   // ex. sélecteur du compte expéditeur
  sendLabel = 'Envoyer',
  undoMessage = to => `Envoi à ${to}…`,
  successMessage = to => `Courriel envoyé à ${to}`,
  onSend,               // async ({ to, cc, subject, bodyHtml }) => any
  onSent,
  canSend = true,
}) {
  const scheduleSend = useUndoSend()
  const { addToast } = useToast()
  const [draft, setDraft] = useState(null)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [to, setTo] = useState('')
  const [cc, setCc] = useState('')
  const [showCc, setShowCc] = useState(false)
  const [subject, setSubject] = useState('')
  const [error, setError] = useState('')
  const bodyRef = useRef(null)
  const partsRef = useRef({ prefix: '', suffix: '' })

  useEffect(() => {
    if (!isOpen) { setDraft(null); setError(''); setLoadError(''); return }
    let alive = true
    const apply = (d) => {
      if (!alive) return
      setDraft(d || {})
      setTo(d?.to || '')
      setCc(d?.cc || '')
      setShowCc(Boolean(d?.cc))
      setSubject(d?.subject || '')
    }
    if (load) {
      setLoading(true)
      Promise.resolve(load())
        .then(apply)
        .catch(e => { if (alive) setLoadError(e.message || "Impossible de préparer le courriel") })
        .finally(() => { if (alive) setLoading(false) })
    } else {
      apply(draftProp)
    }
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen])

  // Injection du corps une seule fois par brouillon : React ne doit pas
  // re-rendre l'intérieur d'un contentEditable, sinon le curseur saute à
  // chaque frappe.
  useEffect(() => {
    if (!draft || !bodyRef.current) return
    const parts = splitEmailHtml(draft.bodyHtml || '')
    partsRef.current = { prefix: parts.prefix, suffix: parts.suffix }
    bodyRef.current.innerHTML = parts.inner
  }, [draft])

  function handleSend() {
    const cleanTo = String(to || '').trim()
    if (!/.+@.+\..+/.test(cleanTo)) { setError('Adresse courriel invalide'); return }
    const cleanCc = String(cc || '').trim()
    if (cleanCc && !isValidEmailList(cleanCc)) { setError('Adresse en Cc invalide'); return }
    const cleanSubject = String(subject || '').trim()
    if (!cleanSubject) { setError('Objet requis'); return }
    setError('')

    const bodyHtml = joinEmailHtml(partsRef.current, bodyRef.current?.innerHTML || '')
    onClose()
    scheduleSend({
      message: undoMessage(cleanTo),
      onRun: async () => {
        try {
          const result = await onSend({ to: cleanTo, cc: cleanCc || undefined, subject: cleanSubject, bodyHtml })
          addToast({ message: successMessage(cleanTo), type: 'success' })
          onSent?.(result, { to: cleanTo, cc: cleanCc || undefined, subject: cleanSubject })
        } catch (e) {
          addToast({ message: e.message || "Erreur lors de l'envoi", type: 'error' })
        }
      },
      onCancel: () => addToast({ message: 'Envoi annulé', type: 'info' }),
    })
  }

  const attachments = draft?.attachments || []
  const suggestions = (draft?.recipients || []).filter(r => r.email && r.email !== to)

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title} size={size}>
      {loading ? (
        <Spinner center />
      ) : loadError ? (
        <div className="space-y-4" data-testid="email-composer-error">
          <div className="flex items-start gap-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-4 py-3">
            <AlertTriangle size={15} className="text-red-600 mt-0.5 shrink-0" />
            <span>{loadError}</span>
          </div>
          <div className="flex justify-end"><button onClick={onClose} className="btn-secondary">Fermer</button></div>
        </div>
      ) : (
        <div className="space-y-3" data-testid="email-composer">
          {headerExtra}

          {draft?.from && (
            <div className="text-xs text-slate-500">De <span className="font-mono text-slate-700">{draft.from}</span></div>
          )}

          <div className="grid grid-cols-[3.5rem_1fr] items-center gap-x-2 gap-y-2">
            <label className="text-xs text-slate-500" htmlFor="email-composer-to">À</label>
            <input
              id="email-composer-to"
              type="email"
              className="input"
              value={to}
              onChange={e => setTo(e.target.value)}
              data-testid="email-composer-to"
            />
            {showCc ? (
              <>
                <label className="text-xs text-slate-500" htmlFor="email-composer-cc">Cc</label>
                <input
                  id="email-composer-cc"
                  className="input"
                  value={cc}
                  onChange={e => setCc(e.target.value)}
                  data-testid="email-composer-cc"
                />
              </>
            ) : (
              <>
                <span />
                <button onClick={() => setShowCc(true)} className="text-xs text-brand-600 hover:underline w-fit" data-testid="email-composer-add-cc">+ Cc</button>
              </>
            )}
            <label className="text-xs text-slate-500" htmlFor="email-composer-subject">Objet</label>
            <input
              id="email-composer-subject"
              className="input"
              value={subject}
              onChange={e => setSubject(e.target.value)}
              data-testid="email-composer-subject"
            />
          </div>

          {suggestions.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {suggestions.map(r => (
                <button
                  key={r.email}
                  onClick={() => setTo(r.email)}
                  className="text-xs px-2 py-0.5 rounded-full border border-slate-200 text-slate-600 hover:border-brand-400 hover:text-brand-700"
                  title={r.email}
                >
                  {r.name || r.email}
                </button>
              ))}
            </div>
          )}

          <div
            ref={bodyRef}
            contentEditable
            suppressContentEditableWarning
            className="border border-slate-200 rounded-xl bg-white px-4 py-3 text-sm overflow-y-auto focus:outline-none focus:border-brand-400"
            style={{ maxHeight: 360, minHeight: 160 }}
            data-testid="email-composer-body"
          />

          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5" data-testid="email-composer-attachments">
              {attachments.map((a, i) => {
                const name = typeof a === 'string' ? a : a.name
                const url = typeof a === 'string' ? null : a.url
                const chip = <span className="inline-flex items-center gap-1"><Paperclip size={11} /> {name}</span>
                return url ? (
                  <a key={i} href={url} target="_blank" rel="noopener noreferrer" className="text-xs px-2 py-0.5 rounded-lg border border-slate-200 text-brand-600 hover:underline">{chip}</a>
                ) : (
                  <span key={i} className="text-xs px-2 py-0.5 rounded-lg border border-slate-200 text-slate-600">{chip}</span>
                )
              })}
            </div>
          )}

          {draft?.notice && (
            <div className="flex items-start gap-2 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
              <AlertTriangle size={14} className="text-amber-600 mt-0.5 shrink-0" />
              <span>{draft.notice}</span>
            </div>
          )}

          {error && <ErrorBanner>{error}</ErrorBanner>}

          <div className="flex justify-end gap-2 pt-1">
            <button onClick={onClose} className="btn-secondary">Annuler</button>
            <button
              onClick={handleSend}
              disabled={!to || !canSend}
              className="btn-primary flex items-center gap-1.5"
              data-testid="email-composer-send"
            >
              <Mail size={14} /> {sendLabel}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}
