import Spinner from './Spinner.jsx'
import { DetailLoadError } from './DetailLoadError.jsx'
import SectionNav from './SectionNav.jsx'

// Cadre commun des fiches (toujours montées dans le panneau latéral, qui porte
// déjà titre et sous-titre).
//
//   const pending = detailPending({ loading, loadError, onRetry: reload, record: order, notFound: 'Commande introuvable.' })
//   if (pending) return pending
//   return (
//     <DetailShell header={{ leading, badge, status, meta, actions }}
//       nav={{ sections, labels, counts, active, onSelect, testId }} beforeNav={…}>
//       {…}
//     </DetailShell>
//   )
//
// `detailPending` est un retour anticipé et non un prop du shell : le JSX des
// enfants est évalué par la page avant que le shell ne rende, donc `record.x`
// y planterait tant que le record n'est pas chargé.
export function detailPending({ loading, loadError, onRetry, retrying, record, notFound }) {
  if (loading) return <Spinner center />
  if (loadError && !record) return <DetailLoadError message={loadError} onRetry={onRetry} retrying={retrying} />
  if (!record) return <div className="p-6 text-slate-500">{notFound}</div>
  return null
}

export function DetailShell({ header, nav, beforeNav, className = 'px-5 py-4', children }) {
  const { leading, badge, status, meta, actions } = header || {}
  const hasRow = badge || status
  return (
    <div className={className}>
      {header && (
        <div className="flex items-start gap-4 mb-6">
          {leading}
          <div className="flex-1 min-w-0">
            {hasRow && (
              <div className="flex items-center gap-3 flex-wrap">
                {badge}
                {status}
              </div>
            )}
            {meta && <div className="text-sm text-slate-500 mt-1 flex items-center gap-3 flex-wrap">{meta}</div>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </div>
      )}
      {beforeNav}
      {nav && (
        <SectionNav
          sections={nav.sections}
          labels={nav.labels}
          counts={nav.counts}
          active={nav.active}
          onSelect={nav.onSelect}
          testId={nav.testId}
        />
      )}
      {children}
    </div>
  )
}

export default DetailShell
