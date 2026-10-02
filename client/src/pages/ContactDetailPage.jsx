import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { Layout } from '../components/Layout.jsx'
import { PageTitle } from '../components/PageTitle.jsx'
import { RecordScope } from '../lib/recordLive.jsx'
import RecordRevisionHistory from '../components/RecordRevisionHistory.jsx'
import api from '../lib/api.js'
import ContactDetail from './ContactDetail.jsx'

// Fiche contact en pleine page (route /contacts/:id) : voir CompanyDetailPage.jsx.
export default function ContactDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const [name, setName] = useState('')
  // Retour à la page précédente ; la liste seulement si on est arrivé ici directement.
  const goBack = () => (location.key !== 'default' ? navigate(-1) : navigate('/contacts'))

  useEffect(() => {
    let cancelled = false
    setName('')
    api.contacts.get(id).then(r => { if (!cancelled) setName(`${r?.first_name || ''} ${r?.last_name || ''}`.trim()) }).catch(() => {})
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
        <PageTitle icon={null}>{name || 'Contact'}</PageTitle>
      </div>
      <RecordScope id={id}>
        <ContactDetail recordId={id} onClose={() => navigate('/contacts')} />
      </RecordScope>
      <RecordRevisionHistory table="contacts" id={id} variant="page" />
    </Layout>
  )
}
