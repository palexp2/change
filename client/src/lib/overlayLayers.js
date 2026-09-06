// Empilement des couches flottantes de l'app : panneaux latéraux
// (RecordPeekDrawer) et modales (Modal / ConfirmModal).
//
// Pourquoi un registre plutôt que des z-index en dur : les panneaux latéraux
// s'empilent (fiche entreprise → commande → produit) et montent d'un cran par
// profondeur (BASE + profondeur×2). Une modale figée à BASE finissait donc
// DERRIÈRE le second panneau — une confirmation de suppression invisible, et le
// clic suivant tombait sur le voile du panneau, qui se refermait.
//
// Chaque couche visible s'inscrit ici avec son z-index ; une nouvelle modale
// demande `nextModalZ()` et se place juste au-dessus de la plus haute couche
// déjà ouverte, panneaux empilés ET modales comprises.
export const OVERLAY_BASE = 50

// Plafond : au-dessus vivent des éléments volontairement toujours visibles
// (toasts et overlay hors-ligne à 100, FAB à 9989, bandeaux à 9990+). Une pile
// absurdement profonde ne doit pas passer par-dessus eux.
const OVERLAY_MAX = 99

const layers = new Map()
let seq = 0

// Inscrit une couche ; retourne la fonction de retrait (à appeler au démontage).
export function registerOverlay(zIndex) {
  const token = ++seq
  layers.set(token, zIndex)
  return () => { layers.delete(token) }
}

// z-index de la couche la plus haute actuellement ouverte (0 si aucune).
export function topOverlayZ() {
  let top = 0
  for (const z of layers.values()) if (z > top) top = z
  return top
}

// Plan d'empilement à donner à une modale qui s'ouvre maintenant.
export function nextModalZ() {
  return Math.min(OVERLAY_MAX, Math.max(OVERLAY_BASE, topOverlayZ() + 1))
}
