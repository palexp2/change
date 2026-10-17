import api from '../lib/api.js'
import { RecordFullPage } from '../components/RecordFullPage.jsx'
import CompanyDetail from './CompanyDetail.jsx'

// Fiche entreprise en pleine page (route /companies/:id).
const loadName = id => api.companies.get(id).then(r => r?.name || '')

export default function CompanyDetailPage() {
  return <RecordFullPage table="companies" listPath="/companies" fallbackTitle="Entreprise" loadName={loadName} Detail={CompanyDetail} />
}
