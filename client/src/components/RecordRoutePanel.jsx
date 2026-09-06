import { Suspense, useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import RecordPeekDrawer from './RecordPeekDrawer.jsx'
import ErrorBoundary from './ErrorBoundary.jsx'
import { PEEK_ROUTES } from '../lib/recordPeekRoutes.jsx'
import { RecordScope } from '../lib/recordLive.jsx'
import Spinner from './Spinner.jsx'

// Panneau d'une fiche atteinte par son URL (/orders/<id>) : navigation depuis
// n'importe où dans l'app, lien partagé, signet, rechargement.
//
// Une fiche ne s'affiche JAMAIS en pleine page : App.jsx ne monte plus de route
// de fiche, il rend la page de fond (la page d'où l'on vient, ou la liste
// d'origine de la ressource si on arrive directement sur l'URL) et superpose ce
// panneau. C'est le même drawer que celui ouvert depuis un tableau, donc la
// même fiche embarquée, le même empilement des liens internes, la même largeur
// mémorisée pour la ressource.
//
// Props :
//  - match       : { resource, id, path } issu de matchPeekRoute.
//  - canGoBack   : true si la page de fond vient de l'historique de navigation
//                  (on peut donc revenir en arrière pour fermer) ; false quand
//                  la fiche a été ouverte directement — fermer mène à la liste.
export default function RecordRoutePanel({ match, canGoBack }) {
  const def = PEEK_ROUTES[match.resource]
  const navigate = useNavigate()
  const [record, setRecord] = useState(null)

  // Titre/sous-titre de l'en-tête : l'URL ne porte que l'id, donc on charge le
  // record (le cache de `api` partage l'appel avec la fiche embarquée).
  useEffect(() => {
    let cancelled = false
    setRecord(null)
    def?.load?.(match.id)
      .then(r => { if (!cancelled && r) setRecord(r) })
      .catch(() => {})
    return () => { cancelled = true }
  }, [def, match.id])

  const close = useCallback(() => {
    if (canGoBack) navigate(-1)
    else navigate(def?.list || '/dashboard', { replace: true })
  }, [canGoBack, navigate, def])

  if (!def) return null
  const { Component } = def

  return (
    <RecordPeekDrawer
      open
      onClose={close}
      title={(record && def.title(record)) || def.label}
      subtitle={record ? def.subtitle?.(record) : ''}
      to={match.path}
      // L'URL EST déjà celle de la fiche : rien à réécrire (sinon le drawer
      // empilerait une entrée d'historique en double).
      syncUrl={false}
      width={def.width}
      peekKey={match.resource}
    >
      <ErrorBoundary resetKey={match.path}>
        <Suspense fallback={<div className="p-6 text-sm text-slate-400"><Spinner size="xs" label="Chargement…" /></div>}>
          {/* Les champs de la fiche n'ont pas à recevoir l'id un par un : le
              panneau l'annonce, et chaque <Field> y lit sa pastille « mis à
              jour ailleurs ». */}
          <RecordScope id={match.id}>
            <Component recordId={match.id} embedded onClose={close} />
          </RecordScope>
        </Suspense>
      </ErrorBoundary>
    </RecordPeekDrawer>
  )
}
