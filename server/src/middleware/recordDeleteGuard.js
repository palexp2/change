import db from '../db/database.js'

// « Suppression permise » — garde-fou serveur du réglage posé dans le mode de
// personnalisation d'une fiche (case à cocher de <DetailFieldGrid>, stockée
// dans detail_field_configs.allow_delete).
//
// Sans lui, décocher la case ne ferait que cacher un bouton : l'appel DELETE
// resterait ouvert à qui connaît l'URL. Le réglage vaut donc pour TOUTES les
// suppressions de l'enregistrement (fiche, tableau, API).
//
// Non réglé (NULL) = rien ne change : seul un `allow_delete = 0` explicite
// bloque. C'est ce qui rend le montage sans risque sur les routes existantes.
//
// Chemins gardés : « /<ressource>/<id> » relatifs au montage (/api). La clé de
// droite est l'`entityType` de la fiche — celui passé à <DetailFieldGrid>.
const GUARDED = [
  ['companies', 'companies'],
  ['contacts', 'contacts'],
  ['orders', 'orders'],
  ['products', 'products'],
  ['projects', 'projects'],
  ['tickets', 'tickets'],
  ['purchases', 'purchases'],
  ['shipments', 'shipments'],
  ['ops-issues', 'ops_issues'],
  ['projets/adresses', 'adresses'],
]

function entityForPath(path) {
  for (const [prefix, entity] of GUARDED) {
    if (!path.startsWith(`/${prefix}/`)) continue
    // Un seul segment après le préfixe : c'est bien l'enregistrement lui-même
    // qu'on supprime, pas une de ses sous-ressources (articles, pièces jointes…).
    if (path.slice(prefix.length + 2).includes('/')) continue
    return entity
  }
  return null
}

export function recordDeleteGuard(req, res, next) {
  if (req.method !== 'DELETE') return next()
  const entity = entityForPath(req.path)
  if (!entity) return next()
  const row = db.prepare('SELECT allow_delete FROM detail_field_configs WHERE entity_type=?').get(entity)
  if (row?.allow_delete === 0) {
    return res.status(403).json({ error: 'Suppression désactivée pour cette fiche' })
  }
  next()
}

export default recordDeleteGuard
