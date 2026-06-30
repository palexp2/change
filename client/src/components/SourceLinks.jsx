import { ExternalLink } from 'lucide-react'

// Badges « Ouvrir le record source » vers les systèmes externes synchronisés
// (Stripe / QuickBooks / Airtable). Rend une rangée de liens à partir de
// l'objet `external_links` sérialisé par le serveur (voir
// server/src/services/externalLinks.js). N'affiche que les liens présents.
//
// Couleurs alignées sur la marque de chaque service pour reconnaissance immédiate.
const PROVIDERS = {
  stripe:     { label: 'Stripe',     className: 'text-[#635bff] bg-[#635bff]/10 hover:bg-[#635bff]/20 border-[#635bff]/20' },
  quickbooks: { label: 'QuickBooks', className: 'text-green-700 bg-green-50 hover:bg-green-100 border-green-200' },
  airtable:   { label: 'Airtable',   className: 'text-amber-700 bg-amber-50 hover:bg-amber-100 border-amber-200' },
}

// Ordre d'affichage stable (système de paiement → comptabilité → source de données).
const ORDER = ['stripe', 'quickbooks', 'airtable']

export default function SourceLinks({ links, className = '' }) {
  if (!links) return null
  const keys = ORDER.filter(k => links[k])
  if (keys.length === 0) return null
  return (
    <div className={`inline-flex items-center gap-1.5 flex-wrap ${className}`} data-testid="source-links">
      {keys.map(k => {
        const p = PROVIDERS[k]
        return (
          <a
            key={k}
            href={links[k]}
            target="_blank"
            rel="noopener noreferrer"
            className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded-lg border transition-colors ${p.className}`}
            title={`Ouvrir le record source dans ${p.label}`}
            data-testid={`source-link-${k}`}
          >
            <ExternalLink size={12} /> {p.label}
          </a>
        )
      })}
    </div>
  )
}
