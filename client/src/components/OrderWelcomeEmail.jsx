import { useEffect, useState } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import api from '../lib/api.js'
import { Modal } from './Modal.jsx'
import EmailComposerModal from './EmailComposerModal.jsx'
import { fmtDateTime } from '../lib/formatDate.js'

// « Courriel au client » d'une commande : part seul à 17 h (heure de l'Est).
// Replié derrière une ligne discrète (état d'envoi) ; déplié : vignette de
// l'aperçu (clic → en grand), langue, bouton Envoyer pour partir plus tôt ;
// une fois parti, l'heure d'envoi et l'historique des ouvertures et clics.
// `refreshKey` change quand l'adresse ou les articles changent : l'aperçu suit.
export default function OrderWelcomeEmail({ orderId, refreshKey }) {
  const [data, setData] = useState(null)
  const [lang, setLang] = useState(null)
  const [open, setOpen] = useState(false)
  const [hist, setHist] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const [compose, setCompose] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let live = true
    api.orders.welcomeEmail(orderId, lang).then(d => { if (live) { setData(d); setError(null) } }).catch(e => live && setError(e.message))
    return () => { live = false }
  }, [orderId, lang, refreshKey])

  if (!data) return error ? <div className="text-sm text-red-600">{error}</div> : null

  const sent = data.sent
  const mail = sent || data
  if (!sent && data.missing === 'address') return <div className="text-sm text-slate-400">En attente d’une adresse de livraison.</div>

  const opens = sent?.events.filter(e => e.kind === 'open').length || 0
  const summary = sent ? `✓ Envoyé le ${fmtDateTime(sent.sent_at)}` : data.auto ? 'Envoi auto à 17 h' : 'Non envoyé'
  if (!expanded) return (
    <button type="button" onClick={() => setExpanded(true)} className="text-sm text-slate-500 hover:text-slate-700 flex items-center gap-1">
      <ChevronRight size={14} /> {summary}
    </button>
  )
  return (
    <div className="flex flex-col gap-2">
      <button type="button" onClick={() => setExpanded(false)} className="text-sm text-slate-500 hover:text-slate-700 flex items-center gap-1 self-start">
        <ChevronDown size={14} /> {summary}
      </button>
      <div className="flex gap-4 items-start">
        <button type="button" onClick={() => setOpen(true)} className="w-[92px] h-[120px] flex-none overflow-hidden rounded-lg border border-slate-200 bg-slate-100 cursor-zoom-in relative" aria-label="Aperçu">
          {/* Même gabarit que la vignette « Documents clients » (92×120). */}
          <iframe title="Aperçu" srcDoc={mail.bodyHtml} className="absolute top-0 left-0 w-[600px] h-[783px] border-0 origin-top-left scale-[.1534] pointer-events-none" tabIndex={-1} />
        </button>
        <div className="flex-1 flex flex-col gap-2 min-w-0">
          <div className="font-semibold text-slate-900">{mail.subject}</div>
          <div className="text-sm text-slate-500">
            {sent ? sent.to : [data.contact_name, data.to].filter(Boolean).join(' · ') || 'Contact sans courriel'}
          </div>
          <div className="flex items-center gap-1.5">
            {(sent ? [sent.lang] : ['fr', 'en']).map(l => (
              <button key={l} type="button" disabled={!!sent} onClick={() => setLang(l)}
                className={`text-[11px] font-semibold px-1.5 rounded border ${(sent ? sent.lang : data.lang) === l ? 'bg-slate-800 text-white border-slate-800' : 'text-slate-500 border-slate-200'}`}>
                {l.toUpperCase()}
              </button>
            ))}
          </div>
          {sent ? (
            <>
              <button type="button" onClick={() => setHist(h => !h)} className="text-sm text-slate-500 flex items-center gap-1 self-start">
                {hist ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Historique · {opens ? `ouvert ${opens} fois` : 'pas encore ouvert'}
              </button>
              {hist && (
                <div className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-1 text-sm pl-3 border-l-2 border-slate-200">
                  {sent.events.map((e, i) => [
                    <span key={`a${i}`} className="text-slate-500">{fmtDateTime(e.at)}</span>,
                    <span key={`b${i}`}>{e.kind === 'open' ? 'Ouvert' : `Clic · ${e.label}`}</span>,
                  ])}
                  <span className="text-slate-500">{fmtDateTime(sent.sent_at)}</span><span>Envoyé</span>
                </div>
              )}
            </>
          ) : (
            <button type="button" className="btn-secondary btn-sm self-start" onClick={() => setCompose(true)}>Envoyer maintenant</button>
          )}
          {error && <div className="text-sm text-red-600">{error}</div>}
        </div>
        <EmailComposerModal
          isOpen={compose}
          onClose={() => setCompose(false)}
          title="Courriel au client"
          signature={false}
          size="xl"
          draft={{ to: data.to || '', from: data.from, subject: data.subject, bodyHtml: data.bodyHtml, lang: data.lang }}
          onSend={({ to, cc, subject, bodyHtml }) => api.orders.sendWelcomeEmail(orderId, { lang: data.lang, to, cc, subject, body_html: bodyHtml })}
          onSent={result => result?.sent && setData({ sent: result.sent })}
        />
        <Modal isOpen={open} onClose={() => setOpen(false)} title={mail.subject} size="lg">
          <iframe title="Courriel" srcDoc={mail.bodyHtml} className="w-full h-[70vh] border-0" />
        </Modal>
      </div>
    </div>
  )
}
