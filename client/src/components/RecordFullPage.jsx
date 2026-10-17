import { useEffect, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft } from 'lucide-react'
import { Layout } from './Layout.jsx'
import { PageTitle } from './PageTitle.jsx'
import { RecordScope } from '../lib/recordLive.jsx'
import RecordRevisionHistory from './RecordRevisionHistory.jsx'

// Fiche en pleine page (routes /companies/:id, /contacts/:id) : la fiche
// elle-même (Detail) reste celle de l'aperçu imbriqué — seul ce cadre change
// (Layout + en-tête au lieu du panneau latéral).
//  - `loadName(id)` : promesse du nom affiché en titre.
//  - `closeToList` : la fermeture de la fiche ramène à la liste (sinon : retour).
export function RecordFullPage({ table, listPath, fallbackTitle, loadName, Detail, closeToList = false }) {
  const { id } = useParams()
  const navigate = useNavigate()
  const location = useLocation()
  const [name, setName] = useState('')
  // Retour à la page précédente ; la liste seulement si on est arrivé ici directement.
  const goBack = () => (location.key !== 'default' ? navigate(-1) : navigate(listPath))

  useEffect(() => {
    let cancelled = false
    setName('')
    loadName(id).then(n => { if (!cancelled) setName(n || '') }).catch(() => {})
    return () => { cancelled = true }
  }, [id, loadName])

  return (
    <Layout>
      {/* Pleine hauteur : la barre Historique reste tout en bas, même sur une fiche courte. */}
      <div className="min-h-full flex flex-col">
        <div className="flex items-center gap-3 px-5 pt-4">
          <button
            onClick={goBack}
            className="p-1 -ml-1 text-slate-400 hover:text-slate-600 flex-shrink-0"
            aria-label="Retour"
          >
            <ArrowLeft size={20} />
          </button>
          <PageTitle icon={null}>{name || fallbackTitle}</PageTitle>
        </div>
        <div className="flex-1">
          <RecordScope id={id}>
            <Detail recordId={id} onClose={closeToList ? () => navigate(listPath) : goBack} />
          </RecordScope>
        </div>
        <RecordRevisionHistory table={table} id={id} variant="page" />
      </div>
    </Layout>
  )
}
