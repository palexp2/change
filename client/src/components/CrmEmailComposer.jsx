import { useState, useEffect } from 'react'
import api from '../lib/api.js'
import EmailComposerModal from './EmailComposerModal.jsx'
import { SearchableSelect } from './SearchableSelect.jsx'

// Courriel libre depuis une fiche entreprise ou contact : fenêtre ancrée en bas
// à droite, contacts de la fiche en suggestions, compte Gmail expéditeur au
// choix. L'envoi est consigné au fil de la fiche.
export default function CrmEmailComposer({ isOpen, onClose, contacts = [], companyId, contactId, onSent, recipientSelect = false }) {
  const [accounts, setAccounts] = useState([])
  const [from, setFrom] = useState('')
  useEffect(() => {
    if (!isOpen) return
    api.connectors.gmailAccounts().then(list => {
      setAccounts(list)
      setFrom(list.find(a => a.is_current_user)?.account_email || '')
    }).catch(() => setAccounts([]))
  }, [isOpen])

  const recipients = contacts.filter(c => c.email).map(c => ({
    email: c.email,
    name: [c.first_name, c.last_name].filter(Boolean).join(' ') || c.email,
  }))

  return (
    <EmailComposerModal
      docked
      isOpen={isOpen}
      onClose={onClose}
      title="Nouveau courriel"
      draft={{ to: recipients[0]?.email || '', subject: '', bodyHtml: '', recipients }}
      allowBcc
      recipientSelect={recipientSelect}
      canSend={Boolean(from)}
      headerExtra={
        <SearchableSelect
          testId="crm-email-from"
          size="sm"
          value={from}
          onChange={setFrom}
          options={accounts}
          getOptionValue={a => a.account_email}
          getOptionLabel={a => `De : ${a.account_email}${a.is_current_user ? ' (vous)' : ''}`}
        />
      }
      onSend={({ to, cc, bcc, subject, bodyHtml }) => api.interactions.sendEmail({
        to, cc, bcc, subject, body_html: bodyHtml,
        company_id: companyId || undefined, contact_id: contactId || undefined, from_account: from || undefined,
      })}
      onSent={onSent}
    />
  )
}
