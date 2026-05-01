import { useState, useEffect, useMemo } from 'react'
import { Send, Mail, ChevronDown } from 'lucide-react'
import { Modal } from './Modal.jsx'
import api from '../lib/api.js'
import { useToast } from '../contexts/ToastContext.jsx'

// Modale d'envoi du lien de paiement (pending_invoice).
// Charge les défauts via /email-defaults, laisse l'utilisateur éditer
// destinataire / sujet / message, puis appelle stripeInvoices.send.
export function SendPaymentLinkModal({ pendingInvoiceId, isOpen, onClose, onSent }) {
  const { addToast } = useToast()
  const [loading, setLoading] = useState(false)
  const [defaults, setDefaults] = useState(null)
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [recipientPickerOpen, setRecipientPickerOpen] = useState(false)
  const [recipientQuery, setRecipientQuery] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    if (!isOpen || !pendingInvoiceId) return
    setLoading(true)
    setError(null)
    api.stripeInvoices.emailDefaults(pendingInvoiceId)
      .then(d => {
        setDefaults(d)
        setTo(d.defaults?.to || '')
        setSubject(d.defaults?.subject || '')
        setMessage(d.defaults?.message || '')
      })
      .catch(e => setError(e.message))
      .finally(() => setLoading(false))
  }, [isOpen, pendingInvoiceId])

  const recipientOptions = useMemo(() => {
    if (!defaults) return []
    const arr = []
    if (defaults.company?.email) {
      arr.push({ key: 'co', label: defaults.company.name, email: defaults.company.email, source: 'Entreprise' })
    }
    for (const c of defaults.contacts || []) {
      arr.push({ key: c.id, label: c.name, email: c.email, source: 'Contact' })
    }
    // dédup par email (lowercase)
    const seen = new Set()
    return arr.filter(o => {
      const k = (o.email || '').toLowerCase()
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })
  }, [defaults])

  const filteredRecipients = useMemo(() => {
    const q = recipientQuery.trim().toLowerCase()
    if (!q) return recipientOptions
    return recipientOptions.filter(o =>
      (o.email || '').toLowerCase().includes(q) || (o.label || '').toLowerCase().includes(q)
    )
  }, [recipientOptions, recipientQuery])

  async function handleSend() {
    setError(null)
    const cleanTo = String(to || '').trim()
    if (!cleanTo) { setError('Adresse courriel requise'); return }
    if (!/.+@.+\..+/.test(cleanTo)) { setError('Adresse courriel invalide'); return }
    setSending(true)
    try {
      const r = await api.stripeInvoices.send(pendingInvoiceId, {
        to: cleanTo,
        subject: subject?.trim() || undefined,
        message: message?.trim() || undefined,
      })
      addToast({ message: `Courriel envoyé à ${r.email?.sent_to || cleanTo}`, type: 'success' })
      onSent?.(r)
      onClose?.()
    } catch (e) {
      setError(e.message || 'Erreur')
    } finally {
      setSending(false)
    }
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Envoyer le lien de paiement" size="lg">
      {loading ? (
        <div className="py-10 text-center text-slate-400">Chargement…</div>
      ) : !defaults ? (
        <div className="py-10 text-center text-red-600">{error || 'Impossible de charger les valeurs par défaut'}</div>
      ) : (
        <div className="space-y-4">
          {/* Destinataire */}
          <div>
            <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Destinataire</label>
            <div className="relative">
              <div className="flex items-stretch gap-2">
                <div className="relative flex-1">
                  <Mail size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 pointer-events-none" />
                  <input
                    type="email"
                    value={to}
                    onChange={e => setTo(e.target.value)}
                    placeholder="email@exemple.com"
                    className="w-full text-sm rounded-lg border border-slate-200 bg-white pl-9 pr-3 py-2 hover:border-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-400"
                  />
                </div>
                {recipientOptions.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setRecipientPickerOpen(o => !o)}
                    className="inline-flex items-center gap-1 px-3 py-2 text-sm text-slate-600 border border-slate-200 rounded-lg hover:bg-slate-50"
                  >
                    Choisir <ChevronDown size={14} />
                  </button>
                )}
              </div>
              {recipientPickerOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setRecipientPickerOpen(false)} />
                  <div className="absolute right-0 mt-1 z-20 bg-white border border-slate-200 rounded-lg shadow-lg w-80 max-h-72 flex flex-col">
                    <div className="p-2 border-b border-slate-100">
                      <input
                        autoFocus
                        value={recipientQuery}
                        onChange={e => setRecipientQuery(e.target.value)}
                        placeholder="Rechercher…"
                        className="w-full text-sm focus:outline-none"
                      />
                    </div>
                    <div className="overflow-y-auto">
                      {filteredRecipients.length === 0 ? (
                        <div className="p-3 text-xs text-slate-400">Aucun courriel trouvé</div>
                      ) : filteredRecipients.map(o => (
                        <button
                          key={o.key}
                          type="button"
                          onClick={() => {
                            setTo(o.email)
                            setRecipientPickerOpen(false)
                            setRecipientQuery('')
                          }}
                          className="w-full text-left px-3 py-2 text-sm hover:bg-brand-50"
                        >
                          <div className="font-medium text-slate-900 truncate">{o.label}</div>
                          <div className="text-xs text-slate-500 truncate">
                            <span className="text-slate-400">{o.source} · </span>{o.email}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Objet */}
          <div>
            <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Objet</label>
            <input
              type="text"
              value={subject}
              onChange={e => setSubject(e.target.value)}
              className="w-full text-sm rounded-lg border border-slate-200 bg-white px-3 py-2 hover:border-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-400"
            />
          </div>

          {/* Message */}
          <div>
            <label className="block text-xs font-medium text-slate-500 uppercase tracking-wide mb-1">Message</label>
            <textarea
              value={message}
              onChange={e => setMessage(e.target.value)}
              rows={6}
              className="w-full text-sm rounded-lg border border-slate-200 bg-white px-3 py-2 hover:border-slate-300 focus:outline-none focus:ring-2 focus:ring-brand-400 resize-y"
            />
            <div className="mt-1 text-xs text-slate-400">
              Le bouton "Voir et payer la facture" et la signature sont ajoutés automatiquement.
            </div>
          </div>

          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div>
          )}

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={onClose} disabled={sending} className="px-3 py-2 text-sm text-slate-700 hover:bg-slate-100 rounded-lg">Annuler</button>
            <button
              onClick={handleSend}
              disabled={sending}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-white bg-brand-600 hover:bg-brand-700 rounded-lg disabled:opacity-50"
            >
              <Send size={14} /> {sending ? 'Envoi…' : 'Envoyer'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  )
}

export default SendPaymentLinkModal
