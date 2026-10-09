import { Link, useLocation } from 'react-router-dom'
import { findFinanceHub } from '../lib/financeSections.js'

// Onglets d'un regroupement de l'Espace finance (Banque, Écritures…), posés en
// haut de chacune de ses pages par Layout. Chaque onglet est une vraie page.
export default function FinanceHubTabs() {
  const location = useLocation()
  const hit = findFinanceHub(location.pathname, location.search)
  if (!hit || hit.hub.hubPages.length < 2) return null
  return (
    <nav data-testid="finance-hub-tabs" aria-label={hit.hub.label}
      className="flex gap-1 px-6 pt-3 border-b border-slate-200 bg-white overflow-x-auto">
      {hit.hub.hubPages.map(page => {
        const active = page === hit.page
        const Icon = page.icon
        return (
          <Link key={page.to} to={page.to} aria-current={active ? 'page' : undefined}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium whitespace-nowrap border-b-2 -mb-px transition-colors ${
              active ? 'border-brand-500 text-brand-600' : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}>
            {Icon && <Icon size={14} />} {page.label}
          </Link>
        )
      })}
    </nav>
  )
}
