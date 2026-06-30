// Registre de schémas pour l'API de mutation générique (routes/records.js).
//
// Pourquoi : aujourd'hui chaque mutation est hand-rollée (≈282 endpoints, deux
// styles : boucle `allowed` inline vs buildPartialUpdate). L'objectif à terme est
// que le front appelle une API générique `PATCH /api/records/:table/:id` plutôt
// qu'une route par ressource. Ce registre décrit, par table, ce qu'un PATCH
// générique est autorisé à toucher et comment coercer chaque champ.
//
// PHASE 1 — couverture volontairement limitée aux tables CRUD *simples* : pas de
// side-effect métier (pas de cascade, pas d'email/Stripe/QB, pas de transition de
// statut spéciale, pas d'auth par rôle au-delà de requireAuth). Toute table à
// logique métier reste servie par sa route dédiée. On n'ajoute une table ici
// qu'après avoir vérifié que sa route PATCH existante est un pur update de champs.
//
// Chaque entrée :
//   table         — nom SQL réel (hardcodé → safe pour l'interpolation SQL).
//   idColumn      — PK (toutes les tables ERP utilisent 'id').
//   entity        — nom d'entité pour l'émission realtime (emitEntity). Doit
//                   matcher ce que la route dédiée émettait pour ne rien casser.
//   softDelete    — true si la table a une colonne deleted_at (DELETE = soft,
//                   et les lectures filtrent deleted_at IS NULL).
//   touchUpdatedAt— true si la table a une colonne updated_at à rafraîchir.
//   allowed       — liste blanche des colonnes patchables.
//   nonNullable   — colonnes qui rejettent null/'' (400).
//   coerce        — transform par colonne, appliqué avant le check nonNullable.

import { toBool, toBoolDefaultTrue, trimOrNull } from '../utils/partialUpdate.js'

export const RECORD_REGISTRY = {
  // Miroir de routes/activity-codes.js PATCH /:id (requireAuth, sans side-effect).
  activity_codes: {
    table: 'activity_codes',
    idColumn: 'id',
    entity: 'activity_code',
    softDelete: true,
    touchUpdatedAt: true,
    allowed: ['name', 'description', 'active', 'payable', 'rsde_default'],
    nonNullable: new Set(['name']),
    coerce: {
      name: trimOrNull,
      active: toBool,
      payable: toBool,
      rsde_default: toBool,
    },
  },

  // Miroir de routes/vacations.js PATCH /:id (requireAuth, sans side-effect).
  vacations: {
    table: 'vacations',
    idColumn: 'id',
    entity: 'vacation',
    softDelete: false,
    touchUpdatedAt: true,
    allowed: ['start_date', 'end_date', 'paid', 'notes'],
    nonNullable: new Set(),
    coerce: {
      paid: toBoolDefaultTrue,
    },
  },
}

export function getRecordSpec(key) {
  if (!key || !Object.prototype.hasOwnProperty.call(RECORD_REGISTRY, key)) return null
  return RECORD_REGISTRY[key]
}

// Liste des clés gérées — utile pour le diagnostic / tests.
export function listRecordTables() {
  return Object.keys(RECORD_REGISTRY)
}
