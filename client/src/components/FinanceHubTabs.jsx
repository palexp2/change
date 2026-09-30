import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { api } from '../lib/api.js'
import { findFinanceHub } from '../lib/financeSections.js'

// Onglets d'un regroupement de l'Espace finance (Banque, Écritures…), posés en
// haut de chacune de ses pages par Layout. Chaque onglet est une vraie page.
export default function FinanceHubTabs() {
  const location = useLocation()
  const hit = findFinanceHub(location.pathname, location.search)
  const monthClose = useMonthCloseCount(hit?.hub.hubPages.some(p => p.to === '/rapprochement-qbo'))
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
            {page.to === '/rapprochement-qbo' && monthClose > 0 && (
              <span data-testid="month-close-count" title="Mois à fermer : rapprochements à 0 $ à terminer dans QuickBooks"
                className="ml-0.5 min-w-[18px] h-[18px] px-1 rounded-full bg-amber-500 text-white text-[11px] leading-[18px] text-center">{monthClose}</span>
            )}
          </Link>
        )
      })}
    </nav>
  )
}

// « Fermer le mois » : rapprochements préparés à 0 $ qui attendent « Terminer ».
function useMonthCloseCount(enabled) {
  const [count, setCount] = useState(0)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    api.bank.monthClose().then(r => { if (alive) setCount(r?.badge_count || 0) }).catch(() => {})
    return () => { alive = false }
  }, [enabled])
  return count
}
