import { Link } from 'react-router-dom'
import { BookUser, Receipt, RefreshCw } from 'lucide-react'

// Sous-onglets de la section Fournisseurs — trois pages distinctes réunies
// sous une seule entrée de nav, URLs partageables (pattern Admin.jsx).
const TABS = [
  { key: 'profils', to: '/fournisseurs', label: 'Profils', icon: BookUser },
  { key: 'achats', to: '/fournisseurs/achats', label: 'Achats', icon: Receipt },
  { key: 'abonnements', to: '/fournisseurs/abonnements', label: 'Abonnements', icon: RefreshCw },
]

export function VendorTabs({ active }) {
  return (
    <div className="flex gap-1 mb-6 border-b border-slate-200">
      {TABS.map(tab => {
        const Icon = tab.icon
        return (
          <Link key={tab.key} to={tab.to}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              active === tab.key
                ? 'border-brand-500 text-brand-600'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}>
            <Icon size={14} /> {tab.label}
          </Link>
        )
      })}
    </div>
  )
}
