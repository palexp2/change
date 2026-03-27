import { newId } from '../utils/ids.js'

/**
 * Auto-match contacts in base_records by email/phone and create interaction_links.
 * Returns the number of new links created.
 */
export function autoMatchContacts(db, tenantId, interactionId, interaction) {
  let linksCreated = 0
  const identifiers = []

  if (interaction.from_address) identifiers.push({ type: 'email', value: interaction.from_address })
  if (interaction.to_addresses) {
    const tos = Array.isArray(interaction.to_addresses)
      ? interaction.to_addresses
      : (() => { try { return JSON.parse(interaction.to_addresses || '[]') } catch { return [] } })()
    tos.forEach(addr => { if (addr) identifiers.push({ type: 'email', value: addr }) })
  }
  if (interaction.phone_number) identifiers.push({ type: 'phone', value: interaction.phone_number })

  if (identifiers.length === 0) return 0

  const tables = db.prepare(
    'SELECT id FROM base_tables WHERE tenant_id = ? AND deleted_at IS NULL'
  ).all(tenantId)

  for (const table of tables) {
    const emailFields = db.prepare(
      "SELECT key FROM base_fields WHERE table_id = ? AND type = 'email' AND deleted_at IS NULL"
    ).all(table.id)
    const phoneFields = db.prepare(
      "SELECT key FROM base_fields WHERE table_id = ? AND type IN ('phone','text') AND deleted_at IS NULL"
    ).all(table.id)

    for (const identifier of identifiers) {
      const fieldsToCheck = identifier.type === 'email' ? emailFields : phoneFields
      for (const field of fieldsToCheck) {
        let matchingRecords
        try {
          matchingRecords = db.prepare(`
            SELECT id FROM base_records
            WHERE table_id = ? AND tenant_id = ? AND deleted_at IS NULL
            AND json_extract(data, '$.${field.key}') = ?
          `).all(table.id, tenantId, identifier.value)
        } catch { continue }

        for (const record of matchingRecords) {
          const exists = db.prepare(
            'SELECT 1 FROM base_interaction_links WHERE interaction_id = ? AND record_id = ?'
          ).get(interactionId, record.id)
          if (!exists) {
            db.prepare(`
              INSERT INTO base_interaction_links (id, tenant_id, interaction_id, table_id, record_id)
              VALUES (?, ?, ?, ?, ?)
            `).run(newId('itl'), tenantId, interactionId, table.id, record.id)
            linksCreated++
          }
        }
      }
    }
  }

  return linksCreated
}
