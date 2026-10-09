import { useState, useEffect } from 'react'
import { Send, Eye, ChevronDown } from 'lucide-react'
import { api } from '../lib/api.js'
import { fmtDateTime } from '../lib/formatDate.js'
import EmailComposerModal from './EmailComposerModal.jsx'
import { SearchableSelect } from './SearchableSelect.jsx'

// Déjà envoyée au client ? (`sent_at` n'existe que pour les envois faits depuis
// l'ERP ; le statut couvre les plus anciens.)
export const soumissionWasSent = s => Boolean(s?.sent_at) || ['Envoyée', 'Acceptée', 'Refusée'].includes(s?.status)

// Heure du dernier envoi et de la 1re ouverture du courriel (pixel de suivi).
// `history` : dernière ouverture à la place, et un chevron qui déplie tous les
// envois et toutes leurs ouvertures.
export function SoumissionSentStamp({ soumission: s, history = false }) {
  const [open, setOpen] = useState(false)
  const [sends, setSends] = useState(null)
  const id = s?.id
  useEffect(() => {
    if (!open || !id) return
    let alive = true
    api.documents.soumissions.sends(id).then(r => { if (alive) setSends(r) }).catch(() => { if (alive) setSends([]) })
    return () => { alive = false }
  }, [open, id, s?.sent_at, s?.sends_updated_at])
  if (!s?.sent_at) return null
  const openedAt = history ? (s.sent_last_opened_at || s.sent_opened_at) : s.sent_opened_at
  const stamp = (
    <div className="text-[11px] text-slate-500 leading-tight tabular-nums" data-testid="soumission-sent-stamp">
      <div className="flex items-center gap-1" title="Envoyée"><Send size={11} /> {fmtDateTime(s.sent_at)}</div>
      <div className={`flex items-center gap-1 ${openedAt ? 'text-green-600' : 'text-slate-300'}`}
        title={openedAt ? 'Ouverte' : 'Pas encore ouverte'}>
        <Eye size={11} /> {openedAt ? fmtDateTime(openedAt) : '—'}
      </div>
    </div>
  )
  if (!history) return stamp
  return (
    <div className="relative flex items-center gap-0.5">
      {stamp}
      <button type="button" onClick={() => setOpen(o => !o)} title="Historique" data-testid="soumission-sent-history-toggle"
        className="p-0.5 rounded text-slate-400 hover:text-slate-600 hover:bg-slate-100">
        <ChevronDown size={12} className={open ? 'rotate-180' : ''} />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 w-64 max-h-72 overflow-auto bg-white border rounded-lg shadow-lg p-2 text-[11px] tabular-nums space-y-2"
          data-testid="soumission-sent-history">
          {!sends ? <p className="text-slate-400">…</p> : sends.length === 0 ? <p className="text-slate-400">—</p> : sends.map(e => (
            <div key={e.email_id}>
              <div className="flex items-center gap-1 text-slate-600" title={e.to_address || ''}>
                <Send size={11} /> {fmtDateTime(e.sent_at)}
                <span className="truncate text-slate-400">{e.to_address}</span>
              </div>
              {e.opens.length === 0
                ? <div className="flex items-center gap-1 pl-3 text-slate-300"><Eye size={11} /> —</div>
                : e.opens.map((o, i) => (
                  <div key={i} className="flex items-center gap-1 pl-3 text-green-600"><Eye size={11} /> {fmtDateTime(o)}</div>
                ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// Envoi d'une soumission au client : destinataire = contact du projet, autres
// contacts de l'entreprise en suggestions (objet et corps suivent leur langue
// et leur prénom tant qu'ils n'ont pas été retouchés), Cc/Cci, PDF joint.
export default function SoumissionSendModal({ soumissionId, isOpen, onClose, onSent }) {
  const [accounts, setAccounts] = useState([])
  const [from, setFrom] = useState('')
  useEffect(() => {
    if (!isOpen) return
    api.connectors.gmailAccounts().then(list => {
      setAccounts(list)
      setFrom(list.find(a => a.is_current_user)?.account_email || '')
    }).catch(() => setAccounts([]))
  }, [isOpen])

  return (
    <EmailComposerModal
      isOpen={isOpen && Boolean(soumissionId)}
      onClose={onClose}
      title="Envoyer la soumission"
      load={() => api.documents.soumissions.emailDraft(soumissionId)}
      allowBcc
      attachmentSize="sm"
      bodyClassName="leading-relaxed [&_p]:mb-4 [&_p:last-child]:mb-0"
      onPickRecipient={r => ({ subject: r.subject, bodyHtml: r.bodyHtml })}
      canSend={Boolean(from)}
      fromAccount={from}
      headerExtra={
        <div>
          <label className="block text-xs text-slate-500 mb-1">De</label>
          <SearchableSelect
            testId="soumission-from-account"
            size="sm"
            value={from}
            onChange={setFrom}
            options={accounts}
            getOptionValue={a => a.account_email}
            getOptionLabel={a => `${a.account_email}${a.is_current_user ? ' (vous)' : ''}`}
          />
        </div>
      }
      onSend={({ to, cc, bcc, subject, bodyHtml }) => api.documents.soumissions.sendEmail(soumissionId, {
        to, cc, bcc, subject, body_html: bodyHtml, from_account: from || undefined,
      })}
      onSent={onSent}
      successMessage={to => `Soumission envoyée à ${to}`}
    />
  )
}
