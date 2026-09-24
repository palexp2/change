import { encryptCredentials, decryptCredentials } from '../../utils/encryption.js'
export const id = '077-encrypt-oauth-tokens'
export const description = 'Chiffrer les jetons OAuth existants au repos'
export function up(db) {
  const rows = db.prepare("SELECT id, access_token, refresh_token FROM connector_oauth WHERE connector IN ('google','airtable','amazon','quickbooks')").all()
  const update = db.prepare('UPDATE connector_oauth SET access_token=?, refresh_token=? WHERE id=?')
  for (const row of rows) update.run(
    encryptCredentials(decryptCredentials(row.access_token)),
    encryptCredentials(decryptCredentials(row.refresh_token)), row.id)
  const secrets = db.prepare(`SELECT connector, key, value FROM connector_config WHERE
    (connector='stripe' AND key IN ('secret_key','webhook_secret')) OR
    (connector='hubspot' AND key='access_token') OR
    (connector='quickbooks' AND key='webhook_verifier_token')`).all()
  const save = db.prepare('UPDATE connector_config SET value=? WHERE connector=? AND key=?')
  for (const row of secrets) save.run(encryptCredentials(decryptCredentials(row.value)), row.connector, row.key)
  return { encryptedAccounts: rows.length, encryptedSettings: secrets.length }
}
