import { useState, useEffect } from 'react'
import { api } from '../lib/api.js'
import EmailComposerModal from './EmailComposerModal.jsx'
import { SearchableSelect } from './SearchableSelect.jsx'

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
