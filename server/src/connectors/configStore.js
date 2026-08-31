// configStore — fabrique de la config persistée d'un connecteur.
//
// DigiKey, UPS et Purolator recopiaient le même triplet getConfig/saveConfig/
// deleteConfig sur la table connector_config (UPSERT en transaction, secrets
// chiffrés avec CONNECTOR_ENCRYPTION_KEY, « secret vide = ne pas changer »,
// repli sur les variables d'environnement) plus, pour les connecteurs OAuth,
// le duo tokenCache/tokenLock. Cette fabrique factorise tout ça ; ce qui
// diverge (clés, secrets, replis env, normalisation d'environnement) passe en
// options. Aucun db.prepare au chargement du module (harnais de tests).

import db from '../db/database.js'
import { encryptCredentials, decryptCredentials } from '../utils/encryption.js'

/**
 * @param {object} opts
 * @param {string}   opts.connector        Valeur de connector_config.connector.
 * @param {object}   [opts.defaults]       Clés non-crédentielles avec leur défaut.
 * @param {string[]} [opts.credentialKeys] Clés d'identification (initialisées à '').
 * @param {string[]} [opts.secretKeys]     Sous-ensemble chiffré au repos. À la
 *                   sauvegarde, un secret vide veut dire « ne change pas » (le
 *                   champ UI est toujours vide à l'affichage) ; pour effacer,
 *                   DELETE /config. Masqué par publicConfig (`<clé>_set`).
 * @param {object}   [opts.envFallbacks]   { cléConfig: 'VARIABLE_ENV' } — repli
 *                   sur l'environnement si la clé n'a jamais été saisie dans l'UI.
 * @param {boolean}  [opts.includeUnknownKeys=false]  true → getConfig expose
 *                   aussi les lignes DB hors du jeu de clés connu (historique
 *                   DigiKey : chemins d'API d'anciennes versions).
 * @param {Function} [opts.normalize]      (cfg) => void — post-traitement en
 *                   place (ex. défaut/clamp de `environment`).
 * @returns {{ getConfig, saveConfig, deleteConfig, publicConfig, clearTokenCache, getCachedToken }}
 */
export function makeConfigStore({
  connector,
  defaults = {},
  credentialKeys = [],
  secretKeys = [],
  envFallbacks = {},
  includeUnknownKeys = false,
  normalize = null,
}) {
  const secret = new Set(secretKeys)
  const allowed = new Set([...Object.keys(defaults), ...credentialKeys])

  // ── Cache de jeton OAuth (client_credentials) ──────────────────────────────
  // Un jeton en mémoire, reminté à la demande via getCachedToken(mint) ; le
  // lock évite deux mints concurrents. Invalidé à chaque save/delete de config.
  let tokenCache = null // { token, expiresAt }
  let tokenLock = null

  function clearTokenCache() {
    tokenCache = null
  }

  async function getCachedToken(mint) {
    if (tokenCache && Date.now() < tokenCache.expiresAt - 60_000) return tokenCache.token
    if (tokenLock) return tokenLock
    tokenLock = (async () => {
      try {
        const { token, expiresAt } = await mint()
        tokenCache = { token, expiresAt }
        return token
      } finally {
        tokenLock = null
      }
    })()
    return tokenLock
  }

  function getConfig() {
    const rows = db.prepare('SELECT key, value FROM connector_config WHERE connector = ?').all(connector)
    const cfg = { ...defaults }
    for (const k of credentialKeys) cfg[k] = ''
    for (const r of rows) {
      if (!includeUnknownKeys && !allowed.has(r.key)) continue
      cfg[r.key] = secret.has(r.key) ? decryptCredentials(r.value) : r.value
    }
    for (const [key, envVar] of Object.entries(envFallbacks)) {
      if (!cfg[key] && process.env[envVar]) cfg[key] = process.env[envVar]
    }
    if (normalize) normalize(cfg)
    return cfg
  }

  function saveConfig(patch) {
    const upsert = db.prepare(`
      INSERT INTO connector_config (connector, key, value)
      VALUES (?, ?, ?)
      ON CONFLICT (connector, key) DO UPDATE SET value = excluded.value
    `)
    const tx = db.transaction(() => {
      for (const [key, raw] of Object.entries(patch || {})) {
        if (!allowed.has(key)) continue
        if (raw === undefined || raw === null) continue
        const value = String(raw)
        if (secret.has(key)) {
          if (!value) continue
          upsert.run(connector, key, encryptCredentials(value))
        } else {
          upsert.run(connector, key, value)
        }
      }
    })
    tx()
    clearTokenCache()
  }

  function deleteConfig() {
    db.prepare('DELETE FROM connector_config WHERE connector = ?').run(connector)
    clearTokenCache()
  }

  // Le secret ne ressort jamais : l'UI n'affiche que « configuré / pas
  // configuré » (`<clé>_set`), plus les 4 derniers chiffres du numéro de
  // compte quand il est secret — assez pour vérifier le bon compte sans
  // exposer l'identifiant de facturation en clair dans le navigateur.
  function publicConfig() {
    const cfg = getConfig()
    const out = {}
    for (const [k, v] of Object.entries(cfg)) {
      if (!secret.has(k)) out[k] = v
    }
    for (const k of secretKeys) out[`${k}_set`] = !!cfg[k]
    if (secret.has('account_number')) {
      out.account_number_hint = cfg.account_number ? `••••${String(cfg.account_number).slice(-4)}` : null
    }
    return out
  }

  return { getConfig, saveConfig, deleteConfig, publicConfig, clearTokenCache, getCachedToken }
}
