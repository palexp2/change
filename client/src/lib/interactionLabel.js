// Titre d'une interaction — le même dans le panneau ouvert depuis la liste,
// depuis un lien, ou par l'URL /interactions/<id>.
//
// Une interaction n'a pas de nom propre : ce qui l'identifie dépend de son
// type — l'objet d'un courriel, le titre d'une réunion, sinon le type
// lui-même (« Appel », « Note »).
import { INTERACTION_TYPE_LABELS } from '../components/Badge.jsx'
import { fmtDateTime } from './formatDate.js'

export function interactionTitle(row) {
  if (!row) return 'Interaction'
  const meeting = row.meeting_title && row.meeting_title !== 'Note' ? row.meeting_title : ''
  return row.subject || meeting || INTERACTION_TYPE_LABELS[row.type] || 'Interaction'
}

// Sous-titre : avec qui, et quand.
export function interactionSubtitle(row) {
  return [row?.contact_name?.trim(), row?.company_name, fmtDateTime(row?.timestamp)]
    .filter(Boolean).join(' · ')
}
