// Mention de source du Registre des entreprises du Québec.
//
// Ce n'est pas de la décoration : la licence du jeu de données est
// CC BY-NC-SA 4.0, et le « BY » rend l'attribution au Registraire OBLIGATOIRE
// partout où les données sont affichées. Le guide d'utilisation officiel exige
// en plus de ne pas présenter les données d'une manière qui « suggère un statut
// officiel du registre » — d'où la mention de fraîcheur (republication deux
// fois par mois, alors que le registre en ligne, lui, est à jour en continu).
//
// `commercial` : à activer sur les écrans dont l'usage est commercial (la
// prospection), pour que la restriction « pas d'utilisation commerciale » soit
// sous les yeux de qui s'en sert, et pas seulement dans un fichier de config.
import { Info } from 'lucide-react'

const LICENCE_URL = 'https://creativecommons.org/licenses/by-nc-sa/4.0/deed.fr'
const DATASET_URL = 'https://www.donneesquebec.ca/recherche/dataset/registre-des-entreprises'

export default function ReqSourceNotice({ commercial = false, className = '' }) {
  return (
    <div
      className={`flex items-start gap-2 text-xs text-slate-400 ${className}`}
      data-testid="req-source-notice"
    >
      <Info size={12} className="flex-shrink-0 mt-0.5" />
      <p>
        Source :{' '}
        <a href={DATASET_URL} target="_blank" rel="noopener noreferrer" className="text-slate-500 hover:text-brand-600 underline">
          Registre des entreprises du Québec
        </a>{' '}
        — Registraire des entreprises, via Données Québec. Republié deux fois par mois : ces
        informations peuvent être moins à jour que le registre officiel, et cet affichage n'a aucune
        valeur officielle. Licence{' '}
        <a href={LICENCE_URL} target="_blank" rel="noopener noreferrer" className="text-slate-500 hover:text-brand-600 underline">
          CC BY-NC-SA 4.0
        </a>
        {commercial && (
          <span data-testid="req-notice-commercial">
            {' '}— qui <strong className="font-semibold text-slate-500">exclut l'utilisation commerciale</strong>.
            Une autorisation du Registraire est à obtenir avant d'exploiter ces listes à des fins de vente.
          </span>
        )}
        .
      </p>
    </div>
  )
}
