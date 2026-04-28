import db from '../db/database.js'

const ALIASES = ['info@orisha.io', 'support@orisha.io', 'rescue@orisha.io']

export function listFromAddresses() {
  const users = db.prepare(`
    SELECT email FROM users WHERE active=1 AND email LIKE '%@orisha.io' ORDER BY email
  `).all().map(r => r.email).filter(Boolean)
  return [...new Set([...users, ...ALIASES])].sort()
}

export function getDefaultFrom() {
  const row = db.prepare(`
    SELECT value FROM connector_config WHERE connector='postmark' AND key='default_from'
  `).get()
  return row?.value || process.env.POSTMARK_FROM || null
}

export function setDefaultFrom(email) {
  if (!email) {
    db.prepare(`DELETE FROM connector_config WHERE connector='postmark' AND key='default_from'`).run()
    return
  }
  if (!/@orisha\.io$/i.test(email)) {
    throw new Error('Adresse expéditeur invalide : doit se terminer par @orisha.io')
  }
  db.prepare(`
    INSERT INTO connector_config (connector, key, value) VALUES ('postmark', 'default_from', ?)
    ON CONFLICT(connector, key) DO UPDATE SET value=excluded.value
  `).run(email)
}

export function resolveFromAddress(explicit) {
  if (explicit) return explicit
  return getDefaultFrom()
}

// Per-automation override: reads action_config.from from the automations row.
// Used by system email senders (sys_installation_followup, sys_shipment_tracking_email)
// so each automation can ship with its own sender independent of the global default.
export function getAutomationFrom(automationId) {
  try {
    const row = db.prepare(
      'SELECT action_config FROM automations WHERE id = ? AND deleted_at IS NULL'
    ).get(automationId)
    if (row?.action_config) {
      const ac = JSON.parse(row.action_config)
      if (ac?.from) return ac.from
    }
  } catch {}
  return getDefaultFrom()
}
