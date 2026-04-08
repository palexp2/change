/**
 * Migrate data from CRM SQLite → ERP SQLite
 * Usage: node src/migrate-crm.js
 */
import Database from 'better-sqlite3'
import { v4 as uuid } from 'uuid'
import { existsSync } from 'fs'
import { resolve } from 'path'
import dotenv from 'dotenv'

dotenv.config()

const CRM_DB_PATH = resolve('/home/ec2-user/crm/server/data/crm.db')
const ERP_DB_PATH = resolve(process.env.DATABASE_PATH || './data/erp.db')
if (!existsSync(CRM_DB_PATH)) {
  console.error(`CRM DB not found: ${CRM_DB_PATH}`)
  process.exit(1)
}

const crm = new Database(CRM_DB_PATH, { readonly: true })
const erp = new Database(ERP_DB_PATH)
erp.pragma('journal_mode = WAL')
erp.pragma('foreign_keys = ON')

function run() {
  // ── Companies
  console.log('Migrating companies...')
  const crmCompanies = crm.prepare('SELECT * FROM companies').all()
  const companyIdMap = new Map() // crm id → erp id

  const insertCompany = erp.prepare(`
    INSERT OR IGNORE INTO companies (id, name, phone, website, address, notes, airtable_id, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `)

  // Check which airtable_ids already exist to avoid duplicates
  const existingAirtable = new Set(
    erp.prepare('SELECT airtable_id FROM companies WHERE airtable_id IS NOT NULL').all()
      .map(r => r.airtable_id)
  )
  const existingNames = new Map(
    erp.prepare('SELECT id, name FROM companies WHERE 1=1').all().map(r => [r.name.toLowerCase(), r.id])
  )

  let companiesMigrated = 0
  erp.transaction(() => {
    for (const co of crmCompanies) {
      // Skip if airtable_id already in ERP
      if (co.airtable_id && existingAirtable.has(co.airtable_id)) {
        const erpId = erp.prepare('SELECT id FROM companies WHERE airtable_id=?').get(co.airtable_id)?.id
        if (erpId) { companyIdMap.set(co.id, erpId); continue }
      }
      // Skip if same name exists
      const existing = existingNames.get(co.name.toLowerCase())
      if (existing) { companyIdMap.set(co.id, existing); continue }

      const newId = uuid()
      insertCompany.run(newId, co.name, co.phone || null, co.domain || null, co.address || null, co.notes || null, co.airtable_id || null, co.created_at, co.created_at)
      companyIdMap.set(co.id, newId)
      companiesMigrated++
    }
  })()
  console.log(`✅ Companies: ${companiesMigrated} migrated, ${crmCompanies.length - companiesMigrated} skipped`)

  // ── Contacts
  console.log('Migrating contacts...')
  const crmContacts = crm.prepare('SELECT * FROM contacts').all()
  const contactIdMap = new Map()

  const insertContact = erp.prepare(`
    INSERT OR IGNORE INTO contacts (id, first_name, last_name, email, phone, company_id, notes, airtable_id, created_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `)

  const existingEmails = new Map(
    erp.prepare('SELECT id, email FROM contacts WHERE email IS NOT NULL').all().map(r => [r.email.toLowerCase(), r.id])
  )
  const existingContactAirtable = new Set(
    erp.prepare('SELECT airtable_id FROM contacts WHERE airtable_id IS NOT NULL').all().map(r => r.airtable_id)
  )

  let contactsMigrated = 0
  erp.transaction(() => {
    for (const c of crmContacts) {
      if (c.airtable_id && existingContactAirtable.has(c.airtable_id)) {
        const erpId = erp.prepare('SELECT id FROM contacts WHERE airtable_id=?').get(c.airtable_id)?.id
        if (erpId) { contactIdMap.set(c.id, erpId); continue }
      }
      if (c.email && existingEmails.has(c.email.toLowerCase())) {
        const erpId = existingEmails.get(c.email.toLowerCase())
        contactIdMap.set(c.id, erpId)
        continue
      }

      const newId = uuid()
      const companyId = c.company_id ? companyIdMap.get(c.company_id) || null : null
      const nameParts = (c.first_name || '').split(' ')
      const firstName = c.first_name || nameParts[0] || ''
      const lastName = c.last_name || nameParts.slice(1).join(' ') || ''

      insertContact.run(newId, firstName, lastName, c.email || null, c.phone || null, companyId, c.notes || null, c.airtable_id || null, c.created_at)
      contactIdMap.set(c.id, newId)
      contactsMigrated++
    }
  })()
  console.log(`✅ Contacts: ${contactsMigrated} migrated, ${crmContacts.length - contactsMigrated} skipped`)

  // ── Interactions + Calls
  console.log('Migrating interactions...')
  const crmInteractions = crm.prepare('SELECT * FROM interactions').all()
  const interactionIdMap = new Map()

  const insertInteraction = erp.prepare(`
    INSERT OR IGNORE INTO interactions (id, contact_id, company_id, type, direction, timestamp, created_at)
    VALUES (?,?,?,?,?,?,?)
  `)

  let interactionsMigrated = 0
  erp.transaction(() => {
    for (const i of crmInteractions) {
      const newId = uuid()
      const contactId = i.contact_id ? contactIdMap.get(i.contact_id) || null : null
      const companyId = i.company_id ? companyIdMap.get(i.company_id) || null : null
      insertInteraction.run(newId, contactId, companyId, i.type, i.direction || null, i.timestamp, i.created_at)
      interactionIdMap.set(i.id, newId)
      interactionsMigrated++
    }
  })()
  console.log(`✅ Interactions: ${interactionsMigrated} migrated`)

  // ── Calls
  console.log('Migrating calls...')
  const crmCalls = crm.prepare('SELECT * FROM calls').all()
  const insertCall = erp.prepare(`
    INSERT OR IGNORE INTO calls (id, interaction_id, recording_path, transcript, transcript_formatted, language, duration_seconds, caller_number, callee_number, transcription_status, drive_file_id, drive_filename)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `)

  let callsMigrated = 0
  erp.transaction(() => {
    for (const c of crmCalls) {
      const interactionId = c.interaction_id ? interactionIdMap.get(c.interaction_id) || null : null
      if (!interactionId) continue
      const newId = uuid()
      insertCall.run(newId, interactionId, c.recording_path || null, c.transcript || null, c.transcript_formatted || null, c.language || null, c.duration_seconds || null, c.caller_number || null, c.callee_number || null, c.transcription_status || 'pending', c.drive_file_id || null, c.drive_filename || null)
      callsMigrated++
    }
  })()
  console.log(`✅ Calls: ${callsMigrated} migrated`)

  // ── Emails
  console.log('Migrating emails...')
  const crmEmails = crm.prepare('SELECT * FROM emails').all()
  const insertEmail = erp.prepare(`
    INSERT OR IGNORE INTO emails (id, interaction_id, subject, body_html, body_text, from_address, to_address, cc, gmail_message_id, gmail_thread_id)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `)

  let emailsMigrated = 0
  erp.transaction(() => {
    for (const e of crmEmails) {
      const interactionId = e.interaction_id ? interactionIdMap.get(e.interaction_id) || null : null
      if (!interactionId) continue
      // Skip if gmail_message_id already exists in ERP
      if (e.gmail_message_id && erp.prepare('SELECT id FROM emails WHERE gmail_message_id=?').get(e.gmail_message_id)) continue
      insertEmail.run(uuid(), interactionId, e.subject || null, e.body_html || null, e.body_text || null, e.from_address || null, e.to_address || null, e.cc || null, e.gmail_message_id || null, e.gmail_thread_id || null)
      emailsMigrated++
    }
  })()
  console.log(`✅ Emails: ${emailsMigrated} migrated`)

  // ── OAuth tokens → connector_oauth
  console.log('Migrating OAuth tokens...')
  const crmTokens = crm.prepare('SELECT * FROM oauth_tokens').all()
  let tokensMigrated = 0
  erp.transaction(() => {
    for (const t of crmTokens) {
      const existing = erp.prepare(`SELECT id FROM connector_oauth WHERE connector=? AND account_email=?`).get(t.provider, t.account_email)
      if (existing) continue
      erp.prepare(`
        INSERT INTO connector_oauth (id, connector, account_key, account_email, access_token, refresh_token, expiry_date, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?)
      `).run(uuid(), t.provider, t.account_email || t.id, t.account_email || null, t.access_token || null, t.refresh_token || null, t.expiry_date || null, t.created_at, t.updated_at)
      tokensMigrated++
    }
  })()
  console.log(`✅ OAuth tokens: ${tokensMigrated} migrated`)

  // ── Gmail sync state
  const crmGmailState = crm.prepare('SELECT * FROM gmail_sync_state').all()
  erp.transaction(() => {
    for (const s of crmGmailState) {
      // account_key was token.id in CRM, find matching connector_oauth
      const oauthRow = erp.prepare('SELECT id FROM connector_oauth WHERE connector=?').get('google')
      if (!oauthRow) continue
      erp.prepare(`
        INSERT OR IGNORE INTO gmail_sync_state (connector_oauth_id, last_history_id, last_synced_at)
        VALUES (?,?,?)
      `).run(oauthRow.id, s.last_history_id, s.last_synced_at)
    }
  })()

  // ── Airtable sync config
  const crmAirtableConfig = crm.prepare('SELECT * FROM airtable_sync_config WHERE id=1').get()
  if (crmAirtableConfig?.base_id) {
    erp.prepare(`
      INSERT OR IGNORE INTO airtable_sync_config (base_id, contacts_table_id, companies_table_id, field_map_contacts, field_map_companies, last_synced_at)
      VALUES (?,?,?,?,?,?)
    `).run(crmAirtableConfig.base_id, crmAirtableConfig.contacts_table_id, crmAirtableConfig.companies_table_id, crmAirtableConfig.field_map_contacts, crmAirtableConfig.field_map_companies, crmAirtableConfig.last_synced_at)
    console.log('✅ Airtable sync config migrated')
  }

  // ── Inventaire config
  const crmInventaire = crm.prepare('SELECT * FROM airtable_inventaire_config WHERE id=1').get()
  if (crmInventaire?.base_id) {
    erp.prepare(`
      INSERT OR IGNORE INTO airtable_inventaire_config (base_id, projects_table_id, field_map_projects, last_synced_at)
      VALUES (?,?,?,?)
    `).run(crmInventaire.base_id, crmInventaire.projects_table_id, crmInventaire.field_map_projects, crmInventaire.last_synced_at)
    console.log('✅ Inventaire config migrated')
  }

  console.log('\n🎉 Migration complete!')
}

run()
