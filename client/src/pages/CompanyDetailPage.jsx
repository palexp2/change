import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import { RecordScope } from '../lib/recordLive.jsx'
import RecordRevisionHistory from '../components/RecordRevisionHistory.jsx'
import api from '../lib/api.js'
import CompanyDetail from './CompanyDetail.jsx'

// Fiche entreprise en pleine page (route /companies/:id) : la fiche elle-même
// (CompanyDetail) reste identique à celle utilisée en aperçu imbriqué — seul
// ce cadre change (Layout + en-tête au lieu du panneau latéral).
export default function CompanyDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const goBack = () => (location.key !== 'default' ? navigate(-1) : navigate('/companies'))
  const [name, setName] = useState('')

  useEffect(() => {
    let cancelled = false
    setName('')
    api.companies.get(id).then(r => { if (!cancelled) setName(r?.name || '') }).catch(() => {})
    return () => { cancelled = true }
  }, [id])

  return (
    <Layout>
      <div className="flex items-center gap-3 px-5 pt-4">
        <button
          onClick={goBack}
          className="p-1 -ml-1 text-slate-400 hover:text-slate-600 flex-shrink-0"
          aria-label="Retour"
        >
          <ArrowLeft size={20} />
        </button>
        <PageTitle icon={null}>{name || 'Entreprise'}</PageTitle>
      </div>
      <RecordScope id={id}>
        <CompanyDetail recordId={id} onClose={goBack} />
      </RecordScope>
      <RecordRevisionHistory table="companies" id={id} variant="page" />
    </Layout>
  )
}
