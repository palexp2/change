import db from '../db/database.js'
import { encryptCredentials, decryptCredentials } from '../utils/encryption.js'

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

const SECRET_KEYS = new Set(['key', 'password', 'account_number'])
const ALLOWED_KEYS = new Set([...Object.keys(DEFAULTS), 'key', 'password', 'account_number'])

export function getConfig() {
  const rows = db.prepare('SELECT key, value FROM connector_config WHERE connector = ?').all(CONNECTOR)
  const cfg = { ...DEFAULTS, key: '', password: '', account_number: '' }
  for (const r of rows) {
    if (!ALLOWED_KEYS.has(r.key)) continue
    cfg[r.key] = SECRET_KEYS.has(r.key) ? decryptCredentials(r.value) : r.value
  }
  // Repli sur l'environnement si les clés n'ont jamais été saisies dans l'UI —
  // demandées à l'utilisateur (CLAUDE.md : jamais écrire .env sans confirmation).
  if (!cfg.key && process.env.PUROLATOR_KEY) cfg.key = process.env.PUROLATOR_KEY
  if (!cfg.password && process.env.PUROLATOR_PASSWORD) cfg.password = process.env.PUROLATOR_PASSWORD
  if (!cfg.account_number && process.env.PUROLATOR_ACCOUNT) cfg.account_number = process.env.PUROLATOR_ACCOUNT
  if (!cfg.environment) cfg.environment = (process.env.PUROLATOR_ENV || 'dev').toLowerCase()
  if (cfg.environment !== 'production') cfg.environment = 'dev'
  return cfg
}

export function saveConfig(patch) {
  const upsert = db.prepare(`
    INSERT INTO connector_config (connector, key, value)
    VALUES (?, ?, ?)
    ON CONFLICT (connector, key) DO UPDATE SET value = excluded.value
  `)
  const tx = db.transaction(() => {
    for (const [key, raw] of Object.entries(patch || {})) {
      if (!ALLOWED_KEYS.has(key)) continue
      if (raw === undefined || raw === null) continue
      const value = String(raw)
      // Un secret vide veut dire « ne change pas » (le champ UI est toujours
      // vide à l'affichage) ; pour effacer, DELETE /config.
      if (SECRET_KEYS.has(key)) {
        if (!value) continue
        upsert.run(CONNECTOR, key, encryptCredentials(value))
      } else {
        upsert.run(CONNECTOR, key, value)
      }
    }
  })
  tx()
}

export function deleteConfig() {
  db.prepare('DELETE FROM connector_config WHERE connector = ?').run(CONNECTOR)
}

export function isPurolatorConfigured() {
  const cfg = getConfig()
  return !!(cfg.key && cfg.password && cfg.account_number)
}

export function apiBase(cfg = getConfig()) {
  return cfg.environment === 'production' ? PROD_BASE : DEV_BASE
}
