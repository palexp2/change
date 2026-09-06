import { Link } from 'react-router-dom'
import { Inbox } from 'lucide-react'

/**
 * État vide réutilisable : icône contextuelle + message + (optionnel) CTA.
 *
 * Remplace les « Aucun résultat / Aucune commande » gris et secs des tableaux
 * et listes. Donne à l'utilisateur un repère visuel (icône), une explication
 * (description) et un point d'entrée pour agir (CTA).
 *
 * Props :
 *  - icon        : composant icône lucide (défaut Inbox)
 *  - title       : titre court (string)
 *  - description : phrase d'explication (string, optionnel)
 *  - cta         : { label, to?, onClick?, icon? } — bouton/lien d'action principale
 *  - secondaryCta: { label, onClick? } — action secondaire (ex. réinitialiser les filtres)
 *  - compact     : true pour les listes encartées des fiches détail (moins de padding)
 *  - className   : classes supplémentaires sur le conteneur
 */
export default function EmptyState({
  icon: Icon = Inbox,
  title = 'Aucun résultat',
  description,
  cta,
  secondaryCta,
  compact = false,
  className = '',
}) {
  const CtaIcon = cta?.icon
  return (
    <div
      data-testid="empty-state"
      className={`flex flex-col items-center justify-center text-center ${compact ? 'py-7 px-4' : 'py-10 px-6'} ${className}`}
    >
      <div
        className={`flex items-center justify-center rounded-full bg-slate-100 text-slate-400 mb-3 ${compact ? 'w-10 h-10' : 'w-12 h-12'}`}
      >
        {Icon && <Icon size={compact ? 18 : 22} strokeWidth={1.75} />}
      </div>
      <p className={`font-medium text-slate-600 ${compact ? 'text-sm' : 'text-[15px]'}`}>{title}</p>
      {description && (
        <p className="mt-1 text-[13px] text-slate-400 max-w-sm leading-relaxed">{description}</p>
      )}
      {(cta || secondaryCta) && (
        <div className="mt-4 flex items-center gap-2">
          {cta && (cta.to ? (
            <Link to={cta.to} className="btn-primary btn-sm">
              {CtaIcon && <CtaIcon size={14} />}{cta.label}
            </Link>
          ) : (
            <button type="button" onClick={cta.onClick} className="btn-primary btn-sm">
              {CtaIcon && <CtaIcon size={14} />}{cta.label}
            </button>
          ))}
          {secondaryCta && (
            <button type="button" onClick={secondaryCta.onClick} className="btn-secondary btn-sm">
              {secondaryCta.label}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
