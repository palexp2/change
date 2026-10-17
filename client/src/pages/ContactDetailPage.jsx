import api from '../lib/api.js'
import { RecordFullPage } from '../components/RecordFullPage.jsx'
import ContactDetail from './ContactDetail.jsx'

// Fiche contact en pleine page (route /contacts/:id).
const loadName = id => api.contacts.get(id).then(r => `${r?.first_name || ''} ${r?.last_name || ''}`.trim())

export default function ContactDetailPage() {
  return <RecordFullPage table="contacts" listPath="/contacts" fallbackTitle="Contact" loadName={loadName} Detail={ContactDetail} closeToList />
}
