import { makeConfigStore } from './configStore.js'

// ── Connecteur Venn ──────────────────────────────────────────────────────────
// Venn est la deuxième banque d'Orisha (un compte CAD, un compte USD). Jusqu'ici
// elle n'existait nulle part dans l'ERP : Antoine-Louis tenait ses soldes à la
// main dans le fichier « Maintien du solde disponible » et rapprochait ses
// mouvements deux fois par semaine, à l'œil. Seule la BNC arrivait toute seule
// (par Plaid).
//
// LECTURE SEULE, sans exception : on lit les comptes, leurs soldes et leurs
// transactions. Aucun ordre de paiement, aucun virement n'est jamais émis par
// l'ERP — même politique que Plaid, décidée pour les mêmes raisons.
//
// La clé d'API vit dans `connector_config` (chiffrée avec
// CONNECTOR_ENCRYPTION_KEY), saisie depuis /connecteurs — jamais dans .env :
// Charles ou Antoine-Louis doit pouvoir la changer sans redéploiement.
//
// POURQUOI LES CHEMINS SONT CONFIGURABLES : comme pour DigiKey, l'adresse de
// l'API et le nom de ses routes peuvent différer de ce qu'on a mis par défaut
// (portail Venn, version de l'API, en-tête d'authentification maison). Pouvoir
// les corriger depuis l'écran évite un déploiement pour un renommage — et
// permet de brancher la clé le jour où elle arrive, sans nous attendre.

const CONNECTOR = 'venn'

export const DEFAULTS = {
  api_base: 'https://api.venn.co',
  accounts_path: '/v1/accounts',
  // `{accountId}` est remplacé par l'identifiant Venn du compte.
  transactions_path: '/v1/accounts/{accountId}/transactions',
  // En-tête d'authentification. `auth_scheme` vide ⇒ la clé est envoyée telle
  // quelle (certaines API attendent `X-Api-Key: <clé>`, sans préfixe).
  auth_header: 'Authorization',
  auth_scheme: 'Bearer',
  page_size: '100',
  // Nombre de jours relus à chaque passage planifié. Large exprès : une
  // transaction peut se poser en retard, et la dédup rend la relecture gratuite.
  lookback_days: '30',
}

const store = makeConfigStore({
  connector: CONNECTOR,
  defaults: DEFAULTS,
  credentialKeys: ['api_key'],
  secretKeys: ['api_key'],
})

export const { getConfig, saveConfig, deleteConfig, publicConfig } = store

export function isVennConfigured() {
  return !!getConfig().api_key
}

export function apiBase(cfg = getConfig()) {
  return String(cfg.api_base || DEFAULTS.api_base).replace(/\/$/, '')
}

/** En-têtes d'appel : authentification + JSON. */
export function authHeaders(cfg = getConfig()) {
  const header = String(cfg.auth_header || DEFAULTS.auth_header).trim() || 'Authorization'
  const scheme = String(cfg.auth_scheme ?? DEFAULTS.auth_scheme).trim()
  return {
    [header]: scheme ? `${scheme} ${cfg.api_key}` : String(cfg.api_key),
    accept: 'application/json',
  }
}
