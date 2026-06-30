import { AsyncLocalStorage } from 'node:async_hooks'

// Contexte par requête transporté implicitement jusqu'au fond des services, sans
// avoir à passer l'utilisateur en paramètre à travers chaque appel. Posé par
// `requireAuth` (middleware/auth.js) au moment où le JWT est vérifié.
//
// Usage principal : choisir la bonne connexion QuickBooks selon l'utilisateur qui
// déclenche une écriture (voir connectors/quickbooks.js → getAccessToken). Hors
// d'une requête authentifiée (webhooks, syncs planifiées), le store est vide et
// les consommateurs retombent sur la connexion par défaut.
export const requestContext = new AsyncLocalStorage()

export function runWithUser(user, fn) {
  return requestContext.run({ user }, fn)
}

export function getCurrentUser() {
  return requestContext.getStore()?.user || null
}
