import { Plug } from 'lucide-react'
import { usePulse, useRecordScope } from '../lib/recordLive.jsx'

// Pastille « ce champ vient d'être mis à jour ailleurs ».
//
// S'affiche quelques secondes à côté du libellé du champ, puis s'efface :
//  - initiales de l'auteur quand c'est une personne (un collègue édite la même
//    fiche dans un autre navigateur) ;
//  - icône de prise quand c'est une API (miroir Airtable, QuickBooks, Stripe) —
//    autrement dit « ce champ ne s'édite pas ici, il arrive d'ailleurs ».
//
// L'id du record n'est pas passé champ par champ : il vient du panneau qui
// monte la fiche (voir RecordScope dans lib/recordLive.jsx). `recordId` reste
// acceptable pour les rares fiches montées hors panneau.
export function FieldPulse({ recordId, field, className = '' }) {
  const scopeId = useRecordScope()
  const pulse = usePulse(recordId || scopeId, field)
  if (!pulse) return null

  return (
    <span
      className={`field-pulse inline-flex items-center justify-center rounded-full bg-emerald-500 text-white ${
        pulse.initials ? 'text-[9px] font-semibold leading-none px-1.5 py-[3px]' : 'p-[3px]'
      } ${className}`}
      title={pulse.title}
      data-testid={`field-pulse-${field}`}
      data-pulse-source={pulse.source || (pulse.actorId ? 'user' : 'system')}
    >
      {pulse.initials || <Plug size={9} strokeWidth={2.5} />}
    </span>
  )
}

export default FieldPulse
