import { makeConfigStore } from './configStore.js'

// ── Connecteur Purolator ─────────────────────────────────────────────────────
// E-Ship Web Services (SOAP) : Estimating (tarif), Shipping (création d'envoi +
// étiquette), Tracking (statut). Authentification HTTP Basic — la « Key » PWS
// comme username, le « Password » PWS comme password (paire délivrée ensemble
// par Purolator lors de l'inscription au développeur E-Ship) — plus un numéro
// de compte Purolator (payeur des étiquettes), placé dans le corps de chaque
// requête SOAP (PaymentInformation.RegisteredAccountNumber).
//
// Comme UPS : deux environnements strictement séparés — Dev (bac à sable
// PWS, aucune facturation, endpoints devwebservices.purolator.com) et
// Production (webservices.purolator.com). Défaut : variable d'environnement
// PUROLATOR_ENV (`dev` | `production`), surchargeable depuis l'UI. On démarre
// toujours en dev tant que l'utilisateur n'a pas confirmé les identifiants prod.
//
// Les identifiants vivent dans `connector_config`, CHIFFRÉS avec
// CONNECTOR_ENCRYPTION_KEY (même mécanisme que UPS/DigiKey).

const CONNECTOR = 'purolator'

export const DEV_BASE = 'https://devwebservices.purolator.com'
export const PROD_BASE = 'https://webservices.purolator.com'

export const DEFAULTS = {
  environment: '', // '' → repli sur PUROLATOR_ENV, puis 'dev'
}

// Pas d'OAuth (Basic Auth par requête SOAP) : le cache de jeton de la fabrique
// reste simplement inutilisé.
const store = makeConfigStore({
  connector: CONNECTOR,
  defaults: DEFAULTS,
  credentialKeys: ['key', 'password', 'account_number'],
  secretKeys: ['key', 'password', 'account_number'],
  // Repli sur l'environnement si les clés n'ont jamais été saisies dans l'UI —
  // demandées à l'utilisateur (CLAUDE.md : jamais écrire .env sans confirmation).
  envFallbacks: {
    key: 'PUROLATOR_KEY',
    password: 'PUROLATOR_PASSWORD',
    account_number: 'PUROLATOR_ACCOUNT',
  },
  normalize: (cfg) => {
    if (!cfg.environment) cfg.environment = (process.env.PUROLATOR_ENV || 'dev').toLowerCase()
    if (cfg.environment !== 'production') cfg.environment = 'dev'
  },
})

export const { getConfig, saveConfig, deleteConfig, publicConfig } = store

export function isPurolatorConfigured() {
  const cfg = getConfig()
  return !!(cfg.key && cfg.password && cfg.account_number)
}

export function apiBase(cfg = getConfig()) {
  return cfg.environment === 'production' ? PROD_BASE : DEV_BASE
}
