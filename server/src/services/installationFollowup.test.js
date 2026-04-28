// Tests for the installation follow-up email automation.
// Focuses on the eligibility query — the SQL is the single most dangerous piece
// of this feature: a wrong JOIN or filter could mass-email the wrong customers.

import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'

import {
  selectEligibleCompanies,
  sendInstallationFollowups,
  buildFeedbackUrl,
  INSTALLATION_FOLLOWUP_EARLIEST_SHIPMENT,
} from './installationFollowup.js'

// Minimal schema covering every table the service touches. Kept in sync by
// hand with schema.js — if a test fails because of a missing column, add it
// here rather than importing the full ERP schema.
function makeDb() {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE companies (
      id TEXT PRIMARY KEY,
      name TEXT,
      language TEXT,
      lifecycle_phase TEXT,
      installation_followup_sent_at DATETIME,
      deleted_at DATETIME
    );
    CREATE TABLE orders (
      id TEXT PRIMARY KEY,
      company_id TEXT,
      deleted_at DATETIME
    );
    CREATE TABLE shipments (
      id TEXT PRIMARY KEY,
      order_id TEXT,
      shipped_at DATETIME,
      address_id TEXT,
      deleted_at DATETIME
    );
    CREATE TABLE adresses (
      id TEXT PRIMARY KEY,
      contact_id TEXT,
      company_id TEXT,
      address_type TEXT,
      created_at DATETIME DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      first_name TEXT,
      last_name TEXT,
      email TEXT,
      language TEXT,
      company_id TEXT
    );
    CREATE TABLE interactions (
      id TEXT PRIMARY KEY,
      contact_id TEXT,
      company_id TEXT,
      type TEXT,
      direction TEXT,
      timestamp DATETIME
    );
    CREATE TABLE emails (
      id TEXT PRIMARY KEY,
      interaction_id TEXT,
      subject TEXT,
      body_html TEXT,
      from_address TEXT,
      to_address TEXT,
      automated INTEGER
    );
  `)
  return db
}

// Builds one consistent eligible customer. Each test overrides only what it cares about.
function seedEligibleCustomer(db, overrides = {}) {
  const {
    companyId = 'co1',
    companyName = 'Acme Farm',
    lifecyclePhase = 'Customer',
    language = 'English',
    followupSentAt = null,
    orderCount = 1,
    // Must be >= INSTALLATION_FOLLOWUP_EARLIEST_SHIPMENT ('2026-04-16') AND
    // 21+ days before NOW. The default NOW below is '2026-05-15', so '2026-04-20' works.
    shippedAt = '2026-04-20',
    addressType = 'Livraison',
    contactEmail = 'ship@acme.test',
    contactLanguage = null,
    addressCreatedAt = '2026-04-01',
  } = overrides

  db.prepare(`INSERT INTO companies (id, name, language, lifecycle_phase, installation_followup_sent_at)
    VALUES (?, ?, ?, ?, ?)`).run(companyId, companyName, language, lifecyclePhase, followupSentAt)

  db.prepare(`INSERT INTO contacts (id, first_name, last_name, email, language, company_id)
    VALUES (?, ?, ?, ?, ?, ?)`).run(`${companyId}-ct`, 'Jo', 'Doe', contactEmail, contactLanguage, companyId)

  db.prepare(`INSERT INTO adresses (id, contact_id, company_id, address_type, created_at)
    VALUES (?, ?, ?, ?, ?)`).run(`${companyId}-adr`, `${companyId}-ct`, companyId, addressType, addressCreatedAt)

  for (let i = 0; i < orderCount; i++) {
    db.prepare(`INSERT INTO orders (id, company_id) VALUES (?, ?)`).run(`${companyId}-o${i}`, companyId)
  }
  // Shipment only on the first order (mirrors the "first shipment" logic).
  db.prepare(`INSERT INTO shipments (id, order_id, shipped_at, address_id)
    VALUES (?, ?, ?, ?)`).run(`${companyId}-s0`, `${companyId}-o0`, shippedAt, `${companyId}-adr`)
}

const NOW = '2026-05-15T12:00:00Z' // 25 days after the default shippedAt '2026-04-20'

test('selects a single-order customer 21+ days after first shipment', () => {
  const db = makeDb()
  seedEligibleCustomer(db)
  const rows = selectEligibleCompanies(db, { nowIso: NOW })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].company_id, 'co1')
  assert.equal(rows[0].contact_email, 'ship@acme.test')
})

test('excludes customer with 2 orders', () => {
  const db = makeDb()
  seedEligibleCustomer(db, { orderCount: 2 })
  assert.equal(selectEligibleCompanies(db, { nowIso: NOW }).length, 0)
})

test('excludes customer already marked as followup sent', () => {
  const db = makeDb()
  seedEligibleCustomer(db, { followupSentAt: '2026-04-01 12:00:00' })
  assert.equal(selectEligibleCompanies(db, { nowIso: NOW }).length, 0)
})

test('excludes company whose lifecycle_phase is not Customer', () => {
  const db = makeDb()
  seedEligibleCustomer(db, { lifecyclePhase: 'Prospect' })
  assert.equal(selectEligibleCompanies(db, { nowIso: NOW }).length, 0)
})

test('excludes shipment older than the earliest cutoff', () => {
  const db = makeDb()
  // Shipment 2 years before the default earliestShipment ('2026-04-16').
  seedEligibleCustomer(db, { shippedAt: '2024-01-15' })
  assert.equal(selectEligibleCompanies(db, { nowIso: NOW }).length, 0)
})

test('excludes customer shipped less than 21 days ago', () => {
  const db = makeDb()
  seedEligibleCustomer(db, { shippedAt: '2026-05-10' }) // 5 days before NOW
  // Relax the earliest cutoff so only the <21d rule can reject it.
  const rows = selectEligibleCompanies(db, { nowIso: NOW, earliestShipment: '2000-01-01' })
  assert.equal(rows.length, 0)
})

test('includes customer exactly at 21 days', () => {
  const db = makeDb()
  seedEligibleCustomer(db, { shippedAt: '2026-04-24' }) // exactly 21d before NOW (2026-05-15)
  const rows = selectEligibleCompanies(db, { nowIso: NOW, earliestShipment: '2000-01-01' })
  assert.equal(rows.length, 1)
})

test('excludes customer without a shipping contact email', () => {
  const db = makeDb()
  seedEligibleCustomer(db, { contactEmail: null })
  assert.equal(selectEligibleCompanies(db, { nowIso: NOW }).length, 0)
})

test('excludes customer whose contact email is malformed (no @)', () => {
  const db = makeDb()
  seedEligibleCustomer(db, { contactEmail: 'not-an-email' })
  assert.equal(selectEligibleCompanies(db, { nowIso: NOW }).length, 0)
})

test('excludes soft-deleted company', () => {
  const db = makeDb()
  seedEligibleCustomer(db)
  db.prepare(`UPDATE companies SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = 'co1'`).run()
  assert.equal(selectEligibleCompanies(db, { nowIso: NOW }).length, 0)
})

test('excludes customer whose only order is soft-deleted', () => {
  const db = makeDb()
  seedEligibleCustomer(db)
  db.prepare(`UPDATE orders SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE company_id = 'co1'`).run()
  assert.equal(selectEligibleCompanies(db, { nowIso: NOW }).length, 0)
})

test('picks the EARLIEST shipping address when several exist', () => {
  const db = makeDb()
  seedEligibleCustomer(db)
  // Add a second, LATER shipping address attached to a different contact with a different email.
  db.prepare(`INSERT INTO contacts (id, first_name, email, company_id)
    VALUES ('co1-ct2', 'Later', 'later@acme.test', 'co1')`).run()
  db.prepare(`INSERT INTO adresses (id, contact_id, company_id, address_type, created_at)
    VALUES ('co1-adr2', 'co1-ct2', 'co1', 'Livraison', '2026-04-10')`).run()

  const rows = selectEligibleCompanies(db, { nowIso: NOW })
  assert.equal(rows.length, 1)
  // Must be the earliest address (original), not the newer one.
  assert.equal(rows[0].contact_email, 'ship@acme.test')
})

test('sendInstallationFollowups sends, writes interaction+email, sets the flag', async () => {
  const db = makeDb()
  seedEligibleCustomer(db)

  const sent = []
  const out = await sendInstallationFollowups(db, {
    appUrl: 'https://test.local',
    fromAddress: 'hello@orisha.io',
    nowIso: NOW,
    sendFn: async (data) => { sent.push(data); return { MessageID: 'x' } },
  })

  assert.equal(out.total, 1)
  assert.equal(out.sent, 1)
  assert.equal(out.errors, 0)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].To, 'ship@acme.test')
  assert.ok(sent[0].HtmlBody.includes('company=co1'), 'email must contain feedback link with company_id')

  const flag = db.prepare('SELECT installation_followup_sent_at FROM companies WHERE id = ?').get('co1')
  assert.ok(flag.installation_followup_sent_at, 'installation_followup_sent_at must be set after send')

  const interactions = db.prepare('SELECT * FROM interactions').all()
  assert.equal(interactions.length, 1)
  assert.equal(interactions[0].type, 'email')
  assert.equal(interactions[0].direction, 'out')

  const emails = db.prepare('SELECT * FROM emails').all()
  assert.equal(emails.length, 1)
  assert.equal(emails[0].to_address, 'ship@acme.test')
  assert.equal(emails[0].automated, 1)
})

test('idempotence: a second pass after a successful send returns 0 rows', async () => {
  const db = makeDb()
  seedEligibleCustomer(db)
  await sendInstallationFollowups(db, {
    appUrl: 'https://test.local',
    fromAddress: 'hello@orisha.io',
    nowIso: NOW,
    sendFn: async () => ({ MessageID: 'x' }),
  })
  const rows = selectEligibleCompanies(db, { nowIso: NOW })
  assert.equal(rows.length, 0, 'company should not be re-selected after its flag is set')
})

test('dry-run does not persist anything and does not call sendFn', async () => {
  const db = makeDb()
  seedEligibleCustomer(db)

  let sendCalls = 0
  const out = await sendInstallationFollowups(db, {
    appUrl: 'https://test.local',
    fromAddress: 'hello@orisha.io',
    nowIso: NOW,
    dryRun: true,
    sendFn: async () => { sendCalls++ },
  })

  assert.equal(out.skipped, 1)
  assert.equal(out.sent, 0)
  assert.equal(sendCalls, 0)
  const flag = db.prepare('SELECT installation_followup_sent_at FROM companies WHERE id = ?').get('co1')
  assert.equal(flag.installation_followup_sent_at, null)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM interactions').get().c, 0)
  assert.equal(db.prepare('SELECT COUNT(*) c FROM emails').get().c, 0)
})

test('send failure does not set the flag (customer stays eligible for retry)', async () => {
  const db = makeDb()
  seedEligibleCustomer(db)

  const out = await sendInstallationFollowups(db, {
    appUrl: 'https://test.local',
    fromAddress: 'hello@orisha.io',
    nowIso: NOW,
    sendFn: async () => { throw new Error('postmark down') },
  })

  assert.equal(out.errors, 1)
  assert.equal(out.sent, 0)
  const flag = db.prepare('SELECT installation_followup_sent_at FROM companies WHERE id = ?').get('co1')
  assert.equal(flag.installation_followup_sent_at, null, 'flag must not be set when send fails')
  assert.equal(selectEligibleCompanies(db, { nowIso: NOW }).length, 1, 'customer should remain eligible')
})

test('French contact gets a French email and French button labels', async () => {
  const db = makeDb()
  seedEligibleCustomer(db, { contactLanguage: 'French' })
  const sent = []
  await sendInstallationFollowups(db, {
    appUrl: 'https://test.local',
    fromAddress: 'hello@orisha.io',
    nowIso: NOW,
    sendFn: async (d) => { sent.push(d); return {} },
  })
  assert.equal(sent[0].Subject, "Comment s'est passé l'installation ?")
  assert.ok(sent[0].HtmlBody.includes("C'était pénible"))
})

test('buildFeedbackUrl encodes answer, language and company id', () => {
  const u = buildFeedbackUrl('https://app.test', 'stuck', 'French', 'co-xyz')
  assert.ok(u.startsWith('https://app.test/erp/api/public/installation-feedback?'))
  assert.ok(u.includes('answer=stuck'))
  assert.ok(u.includes('lang=French'))
  assert.ok(u.includes('company=co-xyz'))
})

test('earliest-shipment constant is present and ISO-formatted', () => {
  assert.match(INSTALLATION_FOLLOWUP_EARLIEST_SHIPMENT, /^\d{4}-\d{2}-\d{2}$/)
})
