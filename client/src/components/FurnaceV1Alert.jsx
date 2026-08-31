import { Link } from 'react-router-dom'
import { AlertTriangle } from 'lucide-react'

// Signale la combinaison « permission fournaise + module d'activation V1 ».
// Le module d'activation V1 ne pilote pas les fournaises : un client dont les
// contrôleurs centraux autorisent des chaufferettes alors qu'il n'a que des
// modules V1 sur le terrain doit être repéré (remplacement par un V2).
//
// Tout est dérivé des données déjà chargées par la fiche : aucune requête
// supplémentaire, aucune colonne en DB.

// Nom produit du boîtier/module d'activation première génération. On tolère
// l'apostrophe droite ou typographique, et on exclut les PCB et les V2.
const V1_MODULE_RE = /^module d.activation v1$/i

// Clé de permission « fournaise » côté contrôleur central (heaters).
const FURNACE_PERMISSION_KEY = 'maxNumberOfHeaters'

function isOperational(status) {
  return typeof status === 'string' && status.startsWith('Opérationnel')
}

// Somme des permissions fournaise sur les contrôleurs centraux opérationnels.
export function furnacePermissionCount(centralControllers) {
  return (centralControllers || []).reduce((sum, cc) => {
    const n = Number(cc?.permissions?.[FURNACE_PERMISSION_KEY])
    return sum + (Number.isFinite(n) ? n : 0)
  }, 0)
}

// Numéros de série des modules d'activation V1 encore en service chez le client.
export function activationV1Units(serials) {
  return (serials || []).filter(
    s => V1_MODULE_RE.test((s.product_name || '').trim()) && isOperational(s.status)
  )
}

export function FurnaceV1Alert({ centralControllers, serials }) {
  const furnaces = furnacePermissionCount(centralControllers)
  const units = activationV1Units(serials)
  if (furnaces <= 0 || units.length === 0) return null

  return (
    <div
      data-testid="furnace-v1-alert"
      className="mb-4 flex items-start gap-2.5 px-4 py-3 rounded-lg bg-amber-50 border border-amber-200 text-sm text-amber-900"
    >
      <AlertTriangle size={16} className="text-amber-600 flex-shrink-0 mt-0.5" />
      <div className="min-w-0">
        <div className="font-medium">Permission fournaise avec module d’activation V1</div>
        <div className="mt-0.5 text-amber-800">
          {furnaces} permission{furnaces > 1 ? 's' : ''} de fournaise et {units.length} module
          {units.length > 1 ? 's' : ''} d’activation V1 en service : vérifier la compatibilité
          (le V1 ne pilote pas les fournaises).
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {units.map(u => (
            <Link
              key={u.id}
              to={`/serials/${u.id}`}
              className="inline-flex items-center px-2 py-0.5 rounded-md bg-amber-100 hover:bg-amber-200 font-mono text-xs text-amber-900"
            >
              {u.serial || u.address || '—'}
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}

export default FurnaceV1Alert
