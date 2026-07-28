import { Zap, Clock, Hand } from 'lucide-react'
import { SYNC_SOURCES, MODE_LABELS } from '../lib/syncSources.js'

const MODE_ICONS = { webhook: Zap, scheduled: Clock, manual: Hand }

// Encadré « Synchronisation des données » affiché en tête des modales de
// mapping de champs (AirtableCoreMapModal, StripeFieldMapModal…) : détaille,
// pour la table concernée, chaque source externe et son type de déclenchement
// (webhook temps réel / planifié / manuel). Rendu nul si la table n'est pas
// dans le registre SYNC_SOURCES.
//
// `connector` (optionnel) : ne montre que les sources de ce connecteur. Une
// table peut être alimentée par plusieurs connecteurs (ex. `factures` : Stripe
// + Airtable) ; une modale de mapping propre à un connecteur ne doit afficher
// que le sien (la modale Stripe montre Stripe, la modale Airtable montre
// Airtable). Rendu nul si aucune source ne correspond.
export function SyncDetails({ table, connector }) {
  const all = SYNC_SOURCES[table]
  const sources = connector ? all?.filter(s => s.connector === connector) : all
  if (!sources?.length) return null

  return (
    <div
      className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-2.5"
      data-testid={`sync-details-${table}`}
    >
      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Synchronisation des données</p>
      {sources.map((s, i) => {
        const Icon = MODE_ICONS[s.mode]
        return (
          <div key={i} className="flex items-start gap-2">
            <Icon size={13} className="text-slate-400 mt-0.5 flex-shrink-0" />
            <div className="min-w-0">
              <p className="text-xs font-medium text-slate-700">
                {s.connector}
                <span className="ml-1.5 text-[10px] font-normal text-slate-400 uppercase tracking-wide">{MODE_LABELS[s.mode]}</span>
              </p>
              <p className="text-[11px] text-slate-500 leading-snug">{s.detail}</p>
            </div>
          </div>
        )
      })}
    </div>
  )
}
