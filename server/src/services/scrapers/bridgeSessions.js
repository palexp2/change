import db from '../../db/database.js'
import { encryptCredentials, decryptCredentials } from '../../utils/encryption.js'
import { nowIso } from '../../utils/datetime.js'

// ── Sessions « seules » du pont de session ─────────────────────────────────────
// Le module de navigateur envoie aussi la session de services qui ne sont pas
// des portails de factures : rien à collecter, la session sert à un robot
// (QuickBooks → écran « Rapprocher »). Leur cible porte un account_id préfixé
// `bridge:` que la route push reconnaît — jamais de collecte derrière.

export const SESSION_ONLY_TARGETS = {
  // accounts.intuit.com porte les témoins d'authentification, app.qbo.intuit.com
  // ceux de l'application : `intuit.com` couvre les deux (sous-domaines compris).
  quickbooks: { label: 'QuickBooks', domains: ['intuit.com'], fragment: 'intuit.com' },
}

export const BRIDGE_PREFIX = 'bridge:'

export function bridgeKeyOf(accountId) {
  const s = String(accountId || '')
  if (!s.startsWith(BRIDGE_PREFIX)) return null
  const key = s.slice(BRIDGE_PREFIX.length)
  return SESSION_ONLY_TARGETS[key] ? key : null
}

export function listSessionOnlyTargets() {
  const at = Object.fromEntries(
    db.prepare('SELECT key, storage_state_at FROM bridge_sessions').all().map(r => [r.key, r.storage_state_at])
  )
  return Object.entries(SESSION_ONLY_TARGETS).map(([key, t]) => ({
    account_id: `${BRIDGE_PREFIX}${key}`,
    vendor: key,
    label: t.label,
    domains: t.domains,
    session_at: at[key] || null,
    session_required: false,
  }))
}

export function saveBridgeSession(key, state) {
  db.prepare(`
    INSERT INTO bridge_sessions (key, storage_state_enc, storage_state_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET storage_state_enc=excluded.storage_state_enc, storage_state_at=excluded.storage_state_at
  `).run(key, encryptCredentials(JSON.stringify(state)), nowIso())
}

/** @returns {{ state: object, at: string } | null} */
export function getBridgeSession(key) {
  const row = db.prepare('SELECT storage_state_enc, storage_state_at FROM bridge_sessions WHERE key=?').get(key)
  if (!row?.storage_state_enc) return null
  try {
    return { state: JSON.parse(decryptCredentials(row.storage_state_enc)), at: row.storage_state_at }
  } catch {
    return null
  }
}
