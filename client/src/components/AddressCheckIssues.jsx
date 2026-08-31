import { AlertTriangle } from 'lucide-react'
import { Badge } from './Badge.jsx'

// Rendu partagé du verdict du vérificateur d'adresses postales
// (server/src/services/addressCheck.js) : une pastille de statut + la liste des
// problèmes trouvés. Utilisé par Paramètres → Adresses et par la fiche
// entreprise, pour que le même problème se lise exactement pareil aux deux
// endroits.

const LABEL = { error: 'À corriger', warning: 'À surveiller' }

/** Pastille de statut. Ne rend rien si l'adresse est conforme ou non vérifiée. */
export function AddressCheckBadge({ status, className = '' }) {
  if (status !== 'error' && status !== 'warning') return null
  return (
    <Badge color={status === 'error' ? 'red' : 'orange'} className={className}>
      {LABEL[status]}
    </Badge>
  )
}

/** Liste des problèmes. `issues` = tableau {code, field, severity, message}. */
export function AddressCheckIssues({ issues, className = '' }) {
  const list = Array.isArray(issues) ? issues : []
  if (!list.length) return null
  return (
    <ul className={`space-y-1 ${className}`} data-testid="address-check-issues">
      {list.map((issue, i) => (
        <li
          key={issue.code || i}
          className={`text-xs flex items-start gap-1.5 ${issue.severity === 'error' ? 'text-red-600' : 'text-orange-600'}`}
        >
          <AlertTriangle size={12} className="flex-shrink-0 mt-0.5" />
          <span>{issue.message}</span>
        </li>
      ))}
    </ul>
  )
}

/** Parse la colonne `check_issues` (JSON en DB) en tableau exploitable. */
export function parseCheckIssues(raw) {
  if (Array.isArray(raw)) return raw
  try { return JSON.parse(raw || '[]') } catch { return [] }
}

export default AddressCheckIssues
