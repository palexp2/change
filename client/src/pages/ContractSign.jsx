import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import Spinner from '../components/Spinner.jsx'

// Ancien lien de contrat (/contrat/:token) : l'outil Contrats a été remplacé
// par des pages hébergées (Fichiers publics) le 2026-10-09. On redirige vers la
// page qui l'a remplacé, en gardant ?email=…&sig=….
export default function ContractSign() {
  const { token } = useParams()
  const [missing, setMissing] = useState(false)
  useEffect(() => {
    fetch(`/erp/api/public/pages/legacy-contract/${encodeURIComponent(token)}`)
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then(({ url }) => { window.location.replace(url + window.location.search) })
      .catch(() => setMissing(true))
  }, [token])
  return (
    <div className="min-h-screen flex items-center justify-center text-slate-600">
      {missing ? 'Contrat introuvable · Contract not found' : <Spinner />}
    </div>
  )
}
