import { Router } from 'express'
import { v4 as uuid } from 'uuid'
import { createHash, randomBytes } from 'crypto'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import db from '../db/database.js'
import { readFileSync, writeFileSync, existsSync, statSync, unlinkSync } from 'fs'
import { resolve, join } from 'path'
import { writeFileAtomic, withFileLock } from '../utils/atomicFile.js'

const FTP_USERS_FILE = process.env.FTP_USERS_FILE || '/home/ec2-user/ftp-server/users.json'
const FTP_HOST = process.env.FTP_PUBLIC_IP || '3.132.49.255'
const FTP_PORT = process.env.FTP_PORT_PUBLIC || '2121'

function readFtpUsers() {
  try { return JSON.parse(readFileSync(FTP_USERS_FILE, 'utf8')) } catch { return [] }
}
function writeFtpUsers(users) {
  // Écriture atomique : un lecteur concurrent (ftp-arc) ne voit jamais un fichier tronqué.
  writeFileAtomic(FTP_USERS_FILE, JSON.stringify(users, null, 2))
}
// Exécute un cycle read-modify-write sur le fichier des users FTP sous verrou
// inter-process, pour qu'aucune édition concurrente (deux admins, autre process)
// ne soit silencieusement écrasée.
function mutateFtpUsers(mutator) {
  return withFileLock(FTP_USERS_FILE, () => mutator(readFtpUsers()))
}

import { getAuthUrl as googleAuthUrl, exchangeCode as googleExchange } from '../connectors/google.js'
import { getAuthUrl as airtableAuthUrl, exchangeCode as airtableExchange, airtableFetch, getAccessToken } from '../connectors/airtable.js'
import { getAuthUrl as qbAuthUrl, exchangeCode as qbExchange, qbGet } from '../connectors/quickbooks.js'
import { getAuthUrl as amazonAuthUrl, exchangeCode as amazonExchange, isAmazonConfigured } from '../connectors/amazon.js'
import { syncAmazon } from '../services/amazon.js'
import { syncAllAchatsToQB, importFromQB } from '../services/quickbooks.js'
import { syncAllMailboxes } from '../services/gmail.js'
import { syncDrive } from '../services/drive.js'
import { syncAirtable, syncProjets, syncPieces, syncOrders, syncAchats, syncBillets, syncSerials, syncEnvois, syncSoumissions, syncRetours, syncRetourItems, syncAdresses, syncBomItems, syncSerialStateChanges, syncAssemblages, syncEmployees, syncPaies, syncPaieItems, syncStockMovements } from '../services/airtable.js'
import { tracked, getStatus } from '../services/syncState.js'
import { syncStripeSubscriptions, isStripeConfigured } from '../services/stripe.js'
import { isHubSpotConfigured } from '../connectors/hubspot.js'
import { pullDelta as hsPullDelta, getOwnerMappingStatus as hsOwnerStatus, setUserOwnerOverride as hsSetOwnerOverride, retryFailedPushes as hsRetryFailedPushes } from '../services/hubspotSync.js'
import { isNovoxpressConfigured } from '../services/novoxpress.js'
import { processWebhookPing, registerWebhookForBaseTraced } from '../services/airtableWebhooks.js'
import { listFromAddresses, getDefaultFrom, setDefaultFrom } from '../services/postmarkConfig.js'
import { logSync } from '../services/syncLog.js'
import { listFrozenColumns, setFrozen } from '../services/airtableFrozenColumns.js'

// Wrap a sync call with logging
function trackedWithLog(module, fn, trigger) {
  const t0 = Date.now()
  tracked(module, () => fn()).then(() => {
    logSync(module, trigger, { status: 'success', durationMs: Date.now() - t0 })
  }).catch(e => {
    logSync(module, trigger, { status: 'error', error: e.message, durationMs: Date.now() - t0 })
    console.error(`Sync ${trigger} error (${module}):`, e.message)
  })
}

const router = Router()

// ── Registre des modules Airtable à contrôle de champ ──────────────────────
// Chaque module synchronisé depuis Airtable peut exposer un contrôle fin de
// ses champs importés (mapping colonne↔champ, gel, désactivation d'import).
// L'infra existait déjà mais était câblée uniquement pour 'projets' ; ce
// registre la généralise. `source` indique où lire base_id/table_id/field_map :
//   crm     → airtable_sync_config (colonnes dédiées contacts/companies)
//   projets → airtable_projets_config
//   orders  → airtable_orders_config (orders + order_items partagent la table)
//   module  → airtable_module_config WHERE module=<clé>
// `syncKey` = clé passée à POST /sync/<key> pour relancer la sync du module.
const AIRTABLE_FIELD_MODULES = {
  contacts:     { erpTable: 'contacts',       label: 'Contacts',           source: 'crm',     tableCol: 'contacts_table_id',  mapCol: 'field_map_contacts',  syncKey: 'airtable' },
  companies:    { erpTable: 'companies',      label: 'Entreprises',        source: 'crm',     tableCol: 'companies_table_id', mapCol: 'field_map_companies', syncKey: 'airtable' },
  projets:      { erpTable: 'projects',       label: 'Projets',            source: 'projets', tableCol: 'projects_table_id',  mapCol: 'field_map_projects',  syncKey: 'projets' },
  orders:       { erpTable: 'orders',         label: 'Commandes',          source: 'orders',  tableCol: 'orders_table_id',    mapCol: 'field_map_orders',    syncKey: 'orders' },
  order_items:  { erpTable: 'order_items',    label: 'Lignes de commande', source: 'orders',  tableCol: 'items_table_id',     mapCol: 'field_map_items',     syncKey: 'orders' },
  pieces:       { erpTable: 'products',       label: 'Produits',           source: 'module',  syncKey: 'pieces' },
  achats:       { erpTable: 'purchases',      label: 'Achats',             source: 'module',  syncKey: 'achats' },
  billets:      { erpTable: 'tickets',        label: 'Billets',            source: 'module',  syncKey: 'billets' },
  serials:      { erpTable: 'serial_numbers', label: 'N° de série',        source: 'module',  syncKey: 'serials' },
  envois:       { erpTable: 'shipments',      label: 'Envois',             source: 'module',  syncKey: 'envois' },
  soumissions:  { erpTable: 'soumissions',    label: 'Soumissions',        source: 'module',  syncKey: 'soumissions' },
  retours:      { erpTable: 'returns',        label: 'Retours',            source: 'module',  syncKey: 'retours' },
  retour_items: { erpTable: 'return_items',   label: 'Items de retour',    source: 'module',  syncKey: 'retour_items' },
  adresses:     { erpTable: 'adresses',       label: 'Adresses',           source: 'module',  syncKey: 'adresses' },
  assemblages:  { erpTable: 'assemblages',    label: 'Assemblages',        source: 'module',  syncKey: 'assemblages' },
}

// Résout la config Airtable d'un module : { module, erpTable, label, syncKey,
// baseId, tableId, fieldMap }. Retourne null si le module n'est pas au registre.
function resolveAirtableModule(moduleKey) {
  const reg = AIRTABLE_FIELD_MODULES[moduleKey]
  if (!reg) return null
  let baseId = null, tableId = null, fieldMapRaw = null
  if (reg.source === 'crm') {
    const c = db.prepare('SELECT * FROM airtable_sync_config').get() || {}
    baseId = c.base_id; tableId = c[reg.tableCol]; fieldMapRaw = c[reg.mapCol]
  } else if (reg.source === 'projets') {
    const c = db.prepare('SELECT * FROM airtable_projets_config').get() || {}
    baseId = c.base_id; tableId = c[reg.tableCol]; fieldMapRaw = c[reg.mapCol]
  } else if (reg.source === 'orders') {
    const c = db.prepare('SELECT * FROM airtable_orders_config').get() || {}
    baseId = c.base_id; tableId = c[reg.tableCol]; fieldMapRaw = c[reg.mapCol]
  } else if (reg.source === 'module') {
    const c = db.prepare('SELECT * FROM airtable_module_config WHERE module=?').get(moduleKey) || {}
    baseId = c.base_id; tableId = c.table_id; fieldMapRaw = c.field_map
  }
  let fieldMap = {}
  try { fieldMap = fieldMapRaw ? (typeof fieldMapRaw === 'string' ? JSON.parse(fieldMapRaw) : fieldMapRaw) : {} } catch { fieldMap = {} }
  return { module: moduleKey, erpTable: reg.erpTable, label: reg.label, syncKey: reg.syncKey, baseId, tableId, fieldMap }
}

// ── Airtable webhook ping (pas d'auth — appelé directement par Airtable)
router.post('/airtable/webhook-ping', (req, res) => {
  res.status(200).json({ ok: true }) // répondre immédiatement à Airtable
  const webhookId = req.body?.webhook?.id
  if (webhookId) {
    processWebhookPing(webhookId).catch(e => console.error('Webhook ping error:', e.message))
  }
})

// ── Sync log
router.get('/sync-log', requireAuth, (req, res) => {
  const { module, limit = 100 } = req.query
  let sql = "SELECT * FROM sync_log WHERE created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-7 days')"
  const params = []
  if (module) { sql += ' AND module = ?'; params.push(module) }
  sql += ' ORDER BY created_at DESC'
  if (limit !== 'all') {
    sql += ' LIMIT ?'
    params.push(parseInt(limit))
  }
  const logs = db.prepare(sql).all(...params)
  res.json(logs)
})

// ── List connected accounts
router.get('/', requireAuth, (req, res) => {
  const accounts = db.prepare(`
    SELECT id, connector, account_email, account_key, updated_at,
    CASE WHEN refresh_token IS NOT NULL THEN 1 ELSE 0 END AS connected
    FROM connector_oauth ORDER BY connector, account_email
  `).all()

  const config = {}
  const configRows = db.prepare('SELECT connector, key, value FROM connector_config').all()
  for (const r of configRows) {
    if (!config[r.connector]) config[r.connector] = {}
    config[r.connector][r.key] = r.value
  }

  const airtableSync = db.prepare('SELECT * FROM airtable_sync_config').get() || {}
  const projetsSync = db.prepare('SELECT * FROM airtable_projets_config').get() || {}
  const ordersSync = db.prepare('SELECT * FROM airtable_orders_config').get() || {}

  // Split CRM config into contacts and companies
  const contactsSync = airtableSync.base_id ? {
    base_id: airtableSync.base_id,
    contacts_table_id: airtableSync.contacts_table_id,
    field_map_contacts: airtableSync.field_map_contacts,
    last_synced_at: airtableSync.last_synced_at,
  } : {}
  const companiesSync = airtableSync.base_id ? {
    base_id: airtableSync.base_id,
    companies_table_id: airtableSync.companies_table_id,
    field_map_companies: airtableSync.field_map_companies,
    last_synced_at: airtableSync.last_synced_at,
  } : {}

  const moduleConfigs = {}
  for (const mod of SIMPLE_MODULES) {
    moduleConfigs[mod] = db.prepare("SELECT * FROM airtable_module_config WHERE module=?").get(mod) || {}
  }

  res.json({
    accounts, config,
    airtable_sync: airtableSync, projets_sync: projetsSync, orders_sync: ordersSync,
    contacts_sync: contactsSync, companies_sync: companiesSync,
    stripe_configured: isStripeConfigured(),
    novoxpress_configured: isNovoxpressConfigured(),
    hubspot_configured: isHubSpotConfigured(),
    amazon_configured: isAmazonConfigured(),
    ...moduleConfigs,
  })
})

// ── Postmark : adresses expéditeur disponibles + défaut
router.get('/postmark', requireAuth, (req, res) => {
  res.json({
    addresses: listFromAddresses(),
    default_from: getDefaultFrom(),
  })
})

router.put('/postmark/default', requireAuth, (req, res) => {
  try {
    setDefaultFrom(req.body?.default_from || null)
    res.json({ ok: true, default_from: getDefaultFrom() })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// ── Liste légère des comptes Gmail connectés (pour picker d'envoi).
// `is_current_user` permet au front de défaut sur le compte de l'utilisateur
// actif — si aucun ne match, la modale d'envoi doit refuser de tomber
// silencieusement sur un autre compte.
router.get('/gmail/accounts', requireAuth, (req, res) => {
  const me = db.prepare('SELECT email FROM users WHERE id = ?').get(req.user.id)
  const myEmail = me?.email?.toLowerCase() || null
  const rows = db.prepare(`
    SELECT account_email, id
    FROM connector_oauth
    WHERE connector='google' AND refresh_token IS NOT NULL
    ORDER BY account_email
  `).all()
  res.json(rows.map(r => ({
    ...r,
    is_current_user: !!(myEmail && r.account_email?.toLowerCase() === myEmail),
  })))
})

// ── Google OAuth start
router.get('/google/connect', requireAuth, (req, res) => {
  const state = Buffer.from(JSON.stringify({ user_id: req.user.id })).toString('base64url')
  try {
    const url = googleAuthUrl(state)
    res.redirect(url)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Google OAuth callback
router.get('/google/callback', async (req, res) => {
  const { code, state, error } = req.query
  if (error) return res.redirect('/erp/connectors?error=google_denied')
  try {
    JSON.parse(Buffer.from(state, 'base64url').toString())
    const { tokens, email } = await googleExchange(code)

    const existing = db.prepare(`
      SELECT id FROM connector_oauth WHERE connector='google' AND account_email=?
    `).get(email)

    if (existing) {
      db.prepare(`
        UPDATE connector_oauth SET access_token=?, refresh_token=COALESCE(?,refresh_token),
        expiry_date=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?
      `).run(tokens.access_token, tokens.refresh_token || null, tokens.expiry_date || null, existing.id)
    } else {
      db.prepare(`
        INSERT INTO connector_oauth (id, connector, account_key, account_email, access_token, refresh_token, expiry_date)
        VALUES (?,?,?,?,?,?,?)
      `).run(uuid(), 'google', email, email, tokens.access_token, tokens.refresh_token || null, tokens.expiry_date || null)
    }

    res.redirect('/erp/connectors?success=google')
  } catch (e) {
    console.error('Google callback error:', e.message)
    res.redirect('/erp/connectors?error=google_failed')
  }
})

// ── Airtable OAuth start (PKCE)
router.get('/airtable/connect', requireAuth, (req, res) => {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = Buffer.from(JSON.stringify({ verifier })).toString('base64url')
  try {
    const url = airtableAuthUrl(state, challenge)
    res.redirect(url)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Airtable OAuth callback
router.get('/airtable/callback', async (req, res) => {
  const { code, state, error } = req.query
  if (error) return res.redirect('/erp/connectors?error=airtable_denied')
  try {
    const { verifier } = JSON.parse(Buffer.from(state, 'base64url').toString())
    const tokens = await airtableExchange(code, verifier)

    const existing = db.prepare(`
      SELECT id FROM connector_oauth WHERE connector='airtable'
    `).get()

    const expiry = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null
    if (existing) {
      db.prepare(`
        UPDATE connector_oauth SET access_token=?, refresh_token=?, expiry_date=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?
      `).run(tokens.access_token, tokens.refresh_token, expiry, existing.id)
    } else {
      db.prepare(`
        INSERT INTO connector_oauth (id, connector, account_key, access_token, refresh_token, expiry_date)
        VALUES (?,?,?,?,?,?)
      `).run(uuid(), 'airtable', 'default', tokens.access_token, tokens.refresh_token, expiry)
    }

    res.redirect('/erp/connectors?success=airtable')

    // Enregistrer les webhooks pour les bases déjà configurées (fire & forget)
    const { getConfiguredBases } = await import('../services/airtableWebhooks.js')
    for (const baseId of getConfiguredBases()) {
      registerWebhookForBaseTraced(baseId, 'oauth-callback')
    }
  } catch (e) {
    console.error('Airtable callback error:', e.message)
    res.redirect('/erp/connectors?error=airtable_failed')
  }
})

// ── Amazon Business OAuth start
router.get('/amazon/connect', requireAuth, (req, res) => {
  const state = Buffer.from(JSON.stringify({ user_id: req.user.id })).toString('base64url')
  try {
    const url = amazonAuthUrl(state)
    res.redirect(url)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// ── Amazon Business OAuth callback
router.get('/amazon/callback', async (req, res) => {
  const { code, state, error } = req.query
  if (error) return res.redirect('/erp/connectors?error=amazon_denied')
  try {
    JSON.parse(Buffer.from(state, 'base64url').toString())
    const tokens = await amazonExchange(code)

    const existing = db.prepare(`SELECT id FROM connector_oauth WHERE connector='amazon'`).get()
    const expiry = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null
    if (existing) {
      db.prepare(`
        UPDATE connector_oauth SET access_token=?, refresh_token=COALESCE(?,refresh_token),
        expiry_date=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?
      `).run(tokens.access_token, tokens.refresh_token || null, expiry, existing.id)
    } else {
      db.prepare(`
        INSERT INTO connector_oauth (id, connector, account_key, access_token, refresh_token, expiry_date)
        VALUES (?,?,?,?,?,?)
      `).run(uuid(), 'amazon', 'default', tokens.access_token, tokens.refresh_token || null, expiry)
    }

    res.redirect('/erp/connectors?success=amazon')
  } catch (e) {
    console.error('Amazon callback error:', e.message)
    res.redirect('/erp/connectors?error=amazon_failed')
  }
})

// ── Disconnect account
router.delete('/accounts/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM connector_oauth WHERE id=?').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  db.prepare('DELETE FROM connector_oauth WHERE id=?').run(req.params.id)
  res.json({ ok: true })
})

// ── Save connector config
router.put('/config/:connector', requireAuth, (req, res) => {
  const { connector } = req.params
  for (const [key, value] of Object.entries(req.body)) {
    db.prepare(`
      INSERT INTO connector_config (connector, key, value) VALUES (?,?,?)
      ON CONFLICT(connector, key) DO UPDATE SET value=excluded.value
    `).run(connector, key, value ?? null)
  }
  res.json({ ok: true })
})

// ── Airtable: list bases
router.get('/airtable/bases', requireAuth, async (req, res) => {
  try {
    const token = await getAccessToken()
    const data = await airtableFetch('/meta/bases', token)
    res.json(data.bases || [])
  } catch (e) {
    res.status(503).json({ error: e.message })
  }
})

// ── Airtable: list tables in a base
router.get('/airtable/bases/:baseId/tables', requireAuth, async (req, res) => {
  try {
    const token = await getAccessToken()
    const data = await airtableFetch(`/meta/bases/${req.params.baseId}/tables`, token)
    res.json(data.tables || [])
  } catch {
    res.json([])
  }
})

router.get('/airtable/field-defs/:erpTable', requireAuth, (req, res) => {
  const defs = db.prepare('SELECT airtable_field_name, field_type FROM airtable_field_defs WHERE erp_table=?').all(req.params.erpTable)
  res.json(defs)
})

// Liste des colonnes ERP dont l'import Airtable est désactivé via la modale
// de sync. Le client s'en sert pour cacher la colonne du tableau, du picker
// de champs et de la fiche détail, et pour afficher un warning sur les
// filtres/tris/groupes qui référencent encore une colonne désactivée.
router.get('/airtable/disabled-columns/:erpTable', requireAuth, (req, res) => {
  const rows = db.prepare(
    "SELECT column_name, airtable_field_name FROM airtable_field_defs WHERE erp_table=? AND import_disabled=1"
  ).all(req.params.erpTable)
  res.json({ columns: rows })
})

// Returns the actual SQLite columns of an ERP table (name + sql type), used by
// sync UIs to show what's available on the ERP side independent of any Airtable mapping.
router.get('/erp-table-columns/:erpTable', requireAuth, (req, res) => {
  const t = req.params.erpTable
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(t)) return res.status(400).json({ error: 'Table invalide' })
  let cols
  try { cols = db.prepare(`PRAGMA table_info(${t})`).all() }
  catch { return res.status(400).json({ error: `Table inconnue: ${t}` }) }
  if (!cols.length) return res.status(404).json({ error: `Table inconnue: ${t}` })
  res.json(cols.map(c => ({ name: c.name, type: (c.type || '').toLowerCase() || 'text', notnull: !!c.notnull, pk: !!c.pk })))
})

// Frozen columns: columns that Airtable sync must NOT overwrite.
router.get('/frozen-columns/:erpTable', requireAuth, (req, res) => {
  const t = req.params.erpTable
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(t)) return res.status(400).json({ error: 'Table invalide' })
  res.json(listFrozenColumns(t))
})

router.put('/frozen-columns/:erpTable', requireAuth, (req, res) => {
  const t = req.params.erpTable
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(t)) return res.status(400).json({ error: 'Table invalide' })
  const { column_name, frozen } = req.body || {}
  if (!column_name || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(column_name)) {
    return res.status(400).json({ error: 'column_name invalide' })
  }
  // Confirm column actually exists on the table
  let cols
  try { cols = db.prepare(`PRAGMA table_info(${t})`).all() }
  catch { return res.status(400).json({ error: `Table inconnue: ${t}` }) }
  if (!cols.some(c => c.name === column_name)) {
    return res.status(400).json({ error: `Colonne inconnue: ${t}.${column_name}` })
  }
  setFrozen(t, column_name, !!frozen, req.user?.id || null)
  res.json({ ok: true, frozen: !!frozen })
})

// ── Save Airtable CRM config (legacy full save)
function saveCrmConfig(req, res) {
  const { base_id, contacts_table_id, companies_table_id, field_map_contacts, field_map_companies } = req.body
  db.prepare(`
    INSERT INTO airtable_sync_config (base_id, contacts_table_id, companies_table_id, field_map_contacts, field_map_companies)
    VALUES (?,?,?,?,?)
    ON CONFLICT DO UPDATE SET
      base_id=excluded.base_id, contacts_table_id=excluded.contacts_table_id,
      companies_table_id=excluded.companies_table_id, field_map_contacts=excluded.field_map_contacts,
      field_map_companies=excluded.field_map_companies
  `).run(base_id || null, contacts_table_id || null, companies_table_id || null,
    field_map_contacts ? JSON.stringify(field_map_contacts) : null,
    field_map_companies ? JSON.stringify(field_map_companies) : null)
  res.json({ ok: true })
  if (base_id) registerWebhookForBaseTraced(base_id, 'config-save')
}
router.put('/airtable/sync-config', requireAuth, saveCrmConfig)
router.put('/airtable/crm-config', requireAuth, saveCrmConfig)

// ── Save Airtable Contacts config (partial — only contacts fields)
router.put('/airtable/contacts-config', requireAuth, (req, res) => {
  const { base_id, contacts_table_id, field_map_contacts } = req.body
  const existing = db.prepare('SELECT * FROM airtable_sync_config').get()
  db.prepare(`
    INSERT INTO airtable_sync_config (base_id, contacts_table_id, companies_table_id, field_map_contacts, field_map_companies)
    VALUES (?,?,?,?,?)
    ON CONFLICT DO UPDATE SET
      base_id=excluded.base_id, contacts_table_id=excluded.contacts_table_id,
      field_map_contacts=excluded.field_map_contacts
  `).run(base_id || null, contacts_table_id || null, existing?.companies_table_id || null,
    field_map_contacts ? JSON.stringify(field_map_contacts) : null, existing?.field_map_companies || null)
  res.json({ ok: true })
  if (base_id) registerWebhookForBaseTraced(base_id, 'config-save')
})

// ── Save Airtable Companies config (partial — only companies fields)
router.put('/airtable/companies-config', requireAuth, (req, res) => {
  const { base_id, companies_table_id, field_map_companies } = req.body
  const existing = db.prepare('SELECT * FROM airtable_sync_config').get()
  db.prepare(`
    INSERT INTO airtable_sync_config (base_id, contacts_table_id, companies_table_id, field_map_contacts, field_map_companies)
    VALUES (?,?,?,?,?)
    ON CONFLICT DO UPDATE SET
      base_id=excluded.base_id, companies_table_id=excluded.companies_table_id,
      field_map_companies=excluded.field_map_companies
  `).run(base_id || null, existing?.contacts_table_id || null, companies_table_id || null,
    existing?.field_map_contacts || null, field_map_companies ? JSON.stringify(field_map_companies) : null)
  res.json({ ok: true })
  if (base_id) registerWebhookForBaseTraced(base_id, 'config-save')
})

// ── Save Projets config
function saveProjetsConfig(req, res) {
  const { base_id, projects_table_id, field_map_projects, extra_tables } = req.body

  // Garde-fou : ne JAMAIS blanchir field_map_projects avec un objet vide.
  // La clé `name` (mappée vers le champ Airtable "ID") est l'unique pièce qui
  // n'a pas d'équivalent dynamique (airtable_field_defs) : c'est elle qui sert
  // de garde `if (!name) continue` ET qui déclenche l'INSERT de la ligne dans
  // syncProjets. Sans elle, AUCUN projet n'est importé (le sync rapporte
  // "success / 0 importés" en silence). Or l'UI ProjectFields.jsx envoie
  // `field_map_projects: {}` à chaque sauvegarde de config → sans ce garde,
  // chaque save casse les imports. On préserve donc la map existante quand
  // l'entrée est vide/absente. Idem pour extra_tables.
  const existing = db.prepare('SELECT field_map_projects, extra_tables FROM airtable_projets_config WHERE id=?').get('default')
  const incomingMapEmpty = !field_map_projects || (typeof field_map_projects === 'object' && Object.keys(field_map_projects).length === 0)
  const fieldMapToStore = incomingMapEmpty
    ? (existing?.field_map_projects ?? null)
    : JSON.stringify(field_map_projects)
  const extraToStore = extra_tables?.length
    ? JSON.stringify(extra_tables)
    : (extra_tables === undefined ? (existing?.extra_tables ?? null) : null)

  db.prepare(`
    INSERT INTO airtable_projets_config (base_id, projects_table_id, field_map_projects, extra_tables)
    VALUES (?,?,?,?)
    ON CONFLICT DO UPDATE SET
      base_id=excluded.base_id, projects_table_id=excluded.projects_table_id,
      field_map_projects=excluded.field_map_projects, extra_tables=excluded.extra_tables
  `).run(base_id || null, projects_table_id || null, fieldMapToStore, extraToStore)
  res.json({ ok: true })
  if (base_id) registerWebhookForBaseTraced(base_id, 'config-save')
}
router.put('/airtable/projets-config', requireAuth, saveProjetsConfig)
router.put('/airtable/inv-config', requireAuth, saveProjetsConfig)

// Liste des modules supportant le contrôle de champ Airtable + leur état.
// GET /api/connectors/airtable/field-modules
router.get('/airtable/field-modules', requireAuth, (req, res) => {
  const out = Object.keys(AIRTABLE_FIELD_MODULES).map(key => {
    const r = resolveAirtableModule(key)
    return {
      module: key,
      label: r.label,
      erp_table: r.erpTable,
      sync_key: r.syncKey,
      configured: !!(r.baseId && r.tableId),
    }
  })
  res.json(out)
})

// GET /api/connectors/airtable/module-fields/:module/airtable-fields
// (ancien /airtable/projets/airtable-fields, généralisé par module)
// Retourne la liste des champs Airtable de la table du module configurée,
// EXCLUANT les champs « hardcodés » (mappés vers une colonne ERP fixe). Pour
// chaque champ retourné, on indique l'état import_disabled déduit de airtable_field_defs.
async function airtableFieldsHandler(moduleKey, req, res) {
  const resolved = resolveAirtableModule(moduleKey)
  if (!resolved) return res.status(400).json({ error: `Module inconnu : ${moduleKey}` })
  const { erpTable, baseId, tableId, fieldMap } = resolved
  if (!baseId || !tableId) {
    return res.json({ fields: [], hardcoded: [] })
  }
  let token
  try { token = await getAccessToken() }
  catch (e) { return res.status(500).json({ error: 'Airtable non connecté: ' + e.message }) }

  let tableMeta
  try {
    const data = await airtableFetch(`/meta/bases/${baseId}/tables`, token)
    tableMeta = (data.tables || []).find(t => t.id === tableId)
  } catch (e) { return res.status(500).json({ error: 'Erreur metadata Airtable: ' + e.message }) }
  if (!tableMeta) return res.json({ fields: [], hardcoded: [] })

  // Les "hardcoded" Airtable field names = valeurs string du field_map (les
  // *_choices, etc. sont des objets et ne sont pas des field names).
  const hardcoded = new Set(Object.values(fieldMap).filter(v => typeof v === 'string'))

  const defs = db.prepare(
    'SELECT airtable_field_name, column_name, import_disabled FROM airtable_field_defs WHERE erp_table=?'
  ).all(erpTable)
  const defByName = new Map(defs.map(d => [d.airtable_field_name, d]))

  const fields = (tableMeta.fields || [])
    .filter(f => !hardcoded.has(f.name))
    .map(f => {
      const def = defByName.get(f.name)
      return {
        airtable_field_id: f.id,
        airtable_field_name: f.name,
        airtable_field_type: f.type,
        column_name: def?.column_name || null,
        import_disabled: def?.import_disabled === 1,
      }
    })
    .sort((a, b) => a.airtable_field_name.localeCompare(b.airtable_field_name))

  res.json({ fields, hardcoded: [...hardcoded] })
}
router.get('/airtable/projets/airtable-fields', requireAuth, (req, res) => airtableFieldsHandler('projets', req, res))
router.get('/airtable/module-fields/:module/airtable-fields', requireAuth, (req, res) => airtableFieldsHandler(req.params.module, req, res))

// POST /api/connectors/airtable/module-fields/:module/airtable-field-disabled
// (ancien /airtable/projets/airtable-field-disabled, généralisé par module)
// Body : { airtable_field_name: string, disabled: bool }
// - Toggle import_disabled dans airtable_field_defs (upsert).
// - Si on désactive et qu'une colonne existe : NULL-ifie les valeurs dans la
//   table ERP du module pour disparition immédiate (fiche détail + tableau).
function airtableFieldDisabledHandler(moduleKey, req, res) {
  const resolved = resolveAirtableModule(moduleKey)
  if (!resolved) return res.status(400).json({ error: `Module inconnu : ${moduleKey}` })
  const { erpTable, fieldMap } = resolved

  const { airtable_field_name, disabled } = req.body || {}
  if (!airtable_field_name) return res.status(400).json({ error: 'airtable_field_name requis' })
  const flag = disabled ? 1 : 0

  // Bloc anti-mistake : empêche de désactiver un champ hardcodé (présent dans le field_map).
  const hardcoded = new Set(Object.values(fieldMap).filter(v => typeof v === 'string'))
  if (hardcoded.has(airtable_field_name)) {
    return res.status(400).json({ error: 'Ce champ est requis (hardcodé) et ne peut pas être désactivé' })
  }

  const def = db.prepare(
    'SELECT id, column_name FROM airtable_field_defs WHERE erp_table=? AND airtable_field_name=?'
  ).get(erpTable, airtable_field_name)

  if (def) {
    db.prepare(
      "UPDATE airtable_field_defs SET import_disabled=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?"
    ).run(flag, def.id)
    if (flag === 1 && def.column_name && def.column_name !== '__pending__') {
      // NULL-ifie la colonne dans la table ERP pour disparition immédiate.
      try {
        db.prepare(`UPDATE ${erpTable} SET ${def.column_name}=NULL`).run()
      } catch { /* ignore si la colonne n'existe pas pour une raison quelconque */ }
    }
  } else {
    // Pas encore de def → insère un placeholder désactivé. Au prochain sync,
    // si le champ est ré-activé, la def sera mise à jour avec le column_name réel.
    db.prepare(`
      INSERT INTO airtable_field_defs (id, module, erp_table, airtable_field_id, airtable_field_name, column_name, field_type, options, sort_order, import_disabled)
      VALUES (?, ?, ?, ?, ?, ?, 'text', '{}', 0, ?)
    `).run(uuid(), moduleKey, erpTable, `pending_${Date.now()}`, airtable_field_name, '__pending__', flag)
  }
  res.json({ ok: true })
}
router.post('/airtable/projets/airtable-field-disabled', requireAuth, (req, res) => airtableFieldDisabledHandler('projets', req, res))
router.post('/airtable/module-fields/:module/airtable-field-disabled', requireAuth, (req, res) => airtableFieldDisabledHandler(req.params.module, req, res))

// ── Type compat helpers (mapping Airtable → ERP) ───────────────────────────

const TYPE_COMPAT = {
  text:          new Set(['text', 'long_text']),
  long_text:     new Set(['text', 'long_text']),
  number:        new Set(['number']),
  date:          new Set(['date']),
  single_select: new Set(['single_select']),
  multi_select:  new Set(['multi_select']),
  checkbox:      new Set(['checkbox']),
  link:          new Set(['link']),
}

function typesCompatible(airtableType, erpType) {
  const set = TYPE_COMPAT[airtableType]
  return set ? set.has(erpType) : false
}

// Map Airtable field type from /meta/bases (raw API) to ERP-side enum.
// Mirrors mapAirtableType() in services/airtableAutoSync.js without the
// option-extraction since we only need the type.
function airtableTypeToErp(atType, options) {
  switch (atType) {
    case 'singleLineText':
    case 'richText':
    case 'barcode':
    case 'externalSyncSource':
    case 'email':
    case 'url':
    case 'phoneNumber':
      return 'text'
    case 'multilineText':
      return 'long_text'
    case 'number':
    case 'count':
    case 'autoNumber':
    case 'currency':
    case 'percent':
    case 'rating':
      return 'number'
    case 'singleSelect':
      return 'single_select'
    case 'multipleSelects':
      return 'multi_select'
    case 'checkbox':
      return 'checkbox'
    case 'date':
    case 'dateTime':
    case 'createdTime':
    case 'lastModifiedTime':
      return 'date'
    case 'multipleRecordLinks':
      return 'link'
    case 'rollup':
    case 'lookup':
    case 'multipleLookupValues':
    case 'formula': {
      const r = options?.result?.type
      if (r === 'number' || r === 'currency' || r === 'percent') return 'number'
      if (r === 'date' || r === 'dateTime') return 'date'
      if (r === 'checkbox') return 'checkbox'
      return 'text'
    }
    case 'multipleAttachments':
      return 'text'
    default:
      return 'text'
  }
}

// Construit une map Airtable table_id → ERP table à partir des configs.
// Permet (a) de pré-suggérer la table cible pour un champ lien, et (b) de
// valider qu'une table cible référencée existe bien côté ERP.
function buildAirtableTableToErp() {
  const m = new Map()
  const sync = db.prepare('SELECT contacts_table_id, companies_table_id FROM airtable_sync_config').get()
  if (sync?.contacts_table_id) m.set(sync.contacts_table_id, 'contacts')
  if (sync?.companies_table_id) m.set(sync.companies_table_id, 'companies')
  const projets = db.prepare('SELECT projects_table_id FROM airtable_projets_config').get()
  if (projets?.projects_table_id) m.set(projets.projects_table_id, 'projects')
  const orders = db.prepare('SELECT orders_table_id, items_table_id FROM airtable_orders_config').get()
  if (orders?.orders_table_id) m.set(orders.orders_table_id, 'orders')
  if (orders?.items_table_id) m.set(orders.items_table_id, 'order_items')
  const moduleToErp = {
    pieces: 'products', achats: 'purchases', billets: 'tickets', serials: 'serial_numbers',
    envois: 'shipments', soumissions: 'soumissions', retours: 'returns', retour_items: 'return_items',
    adresses: 'adresses', bom: 'bom_items', assemblages: 'assemblages', employees: 'employees',
    paies: 'paies', paie_items: 'paie_items',
  }
  for (const r of db.prepare('SELECT module, table_id FROM airtable_module_config').all()) {
    if (r.table_id && moduleToErp[r.module]) m.set(r.table_id, moduleToErp[r.module])
  }
  return m
}

// GET /api/connectors/airtable/projets/mapping-data
// Renvoie tout ce qu'il faut à la modale de mapping :
// - airtable_fields : champs Airtable (hors hardcodés) avec leur type ERP, options, et mapping actuel
// - erp_columns     : colonnes mappables de `projects` avec leur type
// - hardcoded       : liste des airtable_field_name déjà gérés en code (read-only)
// - airtable_table_to_erp : map Airtable table_id → erp_table (pour résoudre les liens)
async function mappingDataHandler(moduleKey, req, res) {
  const resolved = resolveAirtableModule(moduleKey)
  if (!resolved) return res.status(400).json({ error: `Module inconnu : ${moduleKey}` })
  const { erpTable, baseId, tableId, fieldMap, label, syncKey } = resolved
  const meta = { module: moduleKey, label, erp_table: erpTable, sync_key: syncKey }
  if (!baseId || !tableId) {
    return res.json({ airtable_fields: [], erp_columns: [], hardcoded: [], airtable_table_to_erp: {}, configured: false, ...meta })
  }

  let token
  try { token = await getAccessToken() }
  catch (e) { return res.status(500).json({ error: 'Airtable non connecté: ' + e.message }) }

  let tableMeta
  try {
    const data = await airtableFetch(`/meta/bases/${baseId}/tables`, token)
    tableMeta = (data.tables || []).find(t => t.id === tableId)
  } catch (e) { return res.status(500).json({ error: 'Erreur metadata Airtable: ' + e.message }) }
  if (!tableMeta) return res.json({ airtable_fields: [], erp_columns: [], hardcoded: [], airtable_table_to_erp: {}, configured: false, ...meta })

  const hardcoded = new Set(Object.values(fieldMap).filter(v => typeof v === 'string'))

  // Defs Airtable existantes pour la table ERP du module (mappings actuels)
  const defs = db.prepare(
    'SELECT id, airtable_field_id, airtable_field_name, display_label, column_name, field_type, options, import_disabled FROM airtable_field_defs WHERE erp_table=?'
  ).all(erpTable)
  const defByAtName = new Map()
  for (const d of defs) defByAtName.set(d.airtable_field_name, d)

  // Colonnes vivantes de la table ERP (PRAGMA)
  const liveCols = new Set(db.prepare(`PRAGMA table_info(${erpTable})`).all().map(c => c.name))

  // Une seule def par column_name (UNIQUE). On indexe par column_name pour
  // dériver toutes les métas de la colonne ERP en un coup.
  const defByColumn = new Map()
  for (const d of defs) {
    if (d.column_name && d.column_name !== '__pending__') {
      defByColumn.set(d.column_name, d)
    }
  }

  const SYSTEM = new Set(['id', 'airtable_id', 'created_at', 'updated_at', 'deleted_at'])
  const erp_columns = [...liveCols]
    .filter(c => !SYSTEM.has(c))
    .map(c => {
      const d = defByColumn.get(c)
      const isNative = d && (d.airtable_field_id || '').startsWith('native_')
      const isMapped = d && !isNative && d.import_disabled !== 1
      let opts = {}
      try { opts = JSON.parse(d?.options || '{}') } catch {}
      return {
        column_name: c,
        // Label affiché : display_label utilisateur prime, puis airtable_field_name
        // (qui pour une native vaut le label hardcodé, ex. "Statut").
        label: d?.display_label || d?.airtable_field_name || c,
        display_label: d?.display_label || null,
        field_type: d?.field_type || 'text',
        target_table: opts.link_target_table || opts.target_table || null,
        mapped: isMapped,
        // Métadonnées pour la page de gestion :
        def_id: d?.id || null,
        is_native: !!isNative,
        mapped_airtable_field: isMapped ? d.airtable_field_name : null,
        airtable_field_id: isMapped ? d.airtable_field_id : null,
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label))

  const airtable_fields = (tableMeta.fields || [])
    .filter(f => !hardcoded.has(f.name))
    .map(f => {
      const erpType = airtableTypeToErp(f.type, f.options)
      const def = defByAtName.get(f.name)
      let currentMapping = null
      if (def && def.column_name && def.column_name !== '__pending__' && def.import_disabled !== 1) {
        let opts = {}
        try { opts = JSON.parse(def.options || '{}') } catch {}
        currentMapping = {
          column_name: def.column_name,
          def_id: def.id,
          link_target_table: opts.link_target_table || null,
        }
      }
      return {
        airtable_field_id: f.id,
        airtable_field_name: f.name,
        airtable_field_type: f.type,        // type brut Airtable (ex: multipleRecordLinks)
        erp_field_type: erpType,            // type normalisé ERP
        linked_table_id: f.options?.linkedTableId || null,
        current_mapping: currentMapping,
      }
    })
    .sort((a, b) => a.airtable_field_name.localeCompare(b.airtable_field_name))

  res.json({
    airtable_fields,
    erp_columns,
    hardcoded: [...hardcoded],
    airtable_table_to_erp: Object.fromEntries(buildAirtableTableToErp()),
    configured: true,
    ...meta,
  })
}
router.get('/airtable/projets/mapping-data', requireAuth, (req, res) => mappingDataHandler('projets', req, res))
router.get('/airtable/module-fields/:module/mapping-data', requireAuth, (req, res) => mappingDataHandler(req.params.module, req, res))

// POST /api/connectors/airtable/projets/airtable-field-mapping
// Body : { airtable_field_id, airtable_field_name, airtable_field_type, column_name?, link_target_table? }
// - Si column_name est falsy → unmap (set column_name='__pending__' + import_disabled=1).
//   La colonne existante n'est pas vidée (différence avec field-disabled). On veut
//   préserver les données déjà importées si l'utilisateur change d'avis.
// - Sinon : valide le mapping (compat de type, table cible si lien) et upsert la def.
function airtableFieldMappingHandler(moduleKey, req, res) {
  const resolved = resolveAirtableModule(moduleKey)
  if (!resolved) return res.status(400).json({ error: `Module inconnu : ${moduleKey}` })
  const { erpTable, fieldMap } = resolved

  const { airtable_field_id, airtable_field_name, airtable_field_type, column_name, link_target_table } = req.body || {}

  if (!airtable_field_name || !airtable_field_type) {
    return res.status(400).json({ error: 'airtable_field_name et airtable_field_type requis' })
  }

  // Refus de remapper un champ hardcodé
  const hardcoded = new Set(Object.values(fieldMap).filter(v => typeof v === 'string'))
  if (hardcoded.has(airtable_field_name)) {
    return res.status(400).json({ error: 'Ce champ est géré en code (hardcodé) et ne peut pas être remappé ici' })
  }

  const erpType = airtableTypeToErp(airtable_field_type, req.body?.airtable_field_options)

  // Def existante portant ce nom de champ Airtable (ailleurs ou ici).
  const defByName = db.prepare(
    'SELECT id, column_name FROM airtable_field_defs WHERE erp_table=? AND airtable_field_name=?'
  ).get(erpTable, airtable_field_name)

  // ── Cas 1 : unmap → on supprime la def. Si la colonne avait une def native
  // (créée via ensureNativeFieldDefs), elle sera recréée au prochain redémarrage.
  if (!column_name) {
    if (defByName) {
      db.prepare('DELETE FROM airtable_field_defs WHERE id=?').run(defByName.id)
    }
    return res.json({ ok: true, mapped: false })
  }

  // ── Cas 2 : mapping vers une colonne ERP
  const liveCols = new Set(db.prepare(`PRAGMA table_info(${erpTable})`).all().map(c => c.name))
  if (!liveCols.has(column_name)) {
    return res.status(400).json({ error: `Colonne ERP "${column_name}" introuvable dans ${erpTable}` })
  }

  // Validation : pour les liens, target_table requis et doit exister.
  // On le fait tôt — avant la vérification d'occupation de slot — pour que l'erreur
  // utilisateur reflète la cause la plus directe (target invalide > slot pris).
  let optionsToStore = {}
  if (erpType === 'link') {
    if (!link_target_table) {
      return res.status(400).json({ error: 'link_target_table requis pour un champ de type lien' })
    }
    const targets = new Set([...buildAirtableTableToErp().values(), 'companies', 'contacts', 'projects', 'users'])
    if (!targets.has(link_target_table)) {
      return res.status(400).json({ error: `Table cible "${link_target_table}" inconnue côté ERP` })
    }
    const targetCols = new Set(db.prepare(`PRAGMA table_info(${link_target_table})`).all().map(c => c.name))
    if (!targetCols.has('airtable_id')) {
      return res.status(400).json({ error: `Table cible "${link_target_table}" n'a pas de colonne airtable_id (résolution impossible)` })
    }
    optionsToStore.link_target_table = link_target_table
  }

  // Def existante occupant le slot (erp_table, column_name) — peut être native
  // (métadonnées de type), un autre Airtable field, ou la même qu'on remappe.
  const defByColumn = db.prepare(
    'SELECT id, airtable_field_id, airtable_field_name, field_type, import_disabled FROM airtable_field_defs WHERE erp_table=? AND column_name=?'
  ).get(erpTable, column_name)

  // Si un autre champ Airtable réel et actif occupe déjà ce slot → refus.
  if (defByColumn
      && defByColumn.airtable_field_name !== airtable_field_name
      && defByColumn.import_disabled !== 1
      && !(defByColumn.airtable_field_id || '').startsWith('native_')) {
    return res.status(400).json({ error: `Colonne déjà mappée par "${defByColumn.airtable_field_name}"` })
  }

  // Type ERP courant de la colonne (via la def occupante, native ou autre).
  const erpColType = defByColumn?.field_type || 'text'
  if (!typesCompatible(erpType, erpColType)) {
    return res.status(400).json({
      error: `Types incompatibles : champ Airtable "${erpType}" ne peut pas être mappé vers colonne ERP "${erpColType}"`,
    })
  }

  const newAtFieldId = airtable_field_id || `pending_${Date.now()}`

  // Stratégie d'upsert :
  // - Si une def porte déjà notre airtable_field_name : on met à jour son column_name
  //   (ce qui peut nécessiter de supprimer une def native ou autre dans le slot cible).
  // - Sinon, si le slot (column_name) est occupé par une def native ou disabled :
  //   on prend possession — UPDATE pour remplacer airtable_field_id, name, type, options.
  // - Sinon : INSERT.
  const tx = db.transaction(() => {
    if (defByName) {
      // L'utilisateur déplace ce champ Airtable vers une autre colonne.
      // Si une def native/disabled occupe le slot cible, on la dégage d'abord.
      if (defByColumn && defByColumn.id !== defByName.id) {
        db.prepare('DELETE FROM airtable_field_defs WHERE id=?').run(defByColumn.id)
      }
      db.prepare(`
        UPDATE airtable_field_defs SET
          airtable_field_id=?, column_name=?, field_type=?, options=?, import_disabled=0,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id=?
      `).run(newAtFieldId, column_name, erpType, JSON.stringify(optionsToStore), defByName.id)
    } else if (defByColumn) {
      // Reuse de la def native/disabled qui occupait le slot.
      db.prepare(`
        UPDATE airtable_field_defs SET
          airtable_field_id=?, airtable_field_name=?, field_type=?, options=?, import_disabled=0,
          updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id=?
      `).run(newAtFieldId, airtable_field_name, erpType, JSON.stringify(optionsToStore), defByColumn.id)
    } else {
      db.prepare(`
        INSERT INTO airtable_field_defs (id, module, erp_table, airtable_field_id, airtable_field_name, column_name, field_type, options, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      `).run(uuid(), moduleKey, erpTable, newAtFieldId, airtable_field_name, column_name, erpType, JSON.stringify(optionsToStore))
    }
  })
  try { tx() }
  catch (e) { return res.status(500).json({ error: e.message }) }

  res.json({ ok: true, mapped: true, column_name, link_target_table: optionsToStore.link_target_table || null })
}
router.post('/airtable/projets/airtable-field-mapping', requireAdmin, (req, res) => airtableFieldMappingHandler('projets', req, res))
router.post('/airtable/module-fields/:module/airtable-field-mapping', requireAdmin, (req, res) => airtableFieldMappingHandler(req.params.module, req, res))

// ── Sync status
router.get('/sync/status', requireAuth, (req, res) => {
  res.json(getStatus())
})

// ── Manual sync triggers
router.post('/sync/gmail', requireAuth, async (req, res) => {
  tracked('gmail', () => syncAllMailboxes('manual')).catch(console.error)
  res.json({ ok: true })
})

router.post('/sync/drive', requireAuth, async (req, res) => {
  tracked('drive', () => syncDrive()).catch(console.error)
  res.json({ ok: true })
})

router.post('/sync/airtable', requireAuth, async (req, res) => {
  trackedWithLog('airtable', syncAirtable, 'manual')
  res.json({ ok: true })
})

router.post('/sync/projets', requireAuth, async (req, res) => {
  trackedWithLog('projets', syncProjets, 'manual')
  res.json({ ok: true })
})

router.post('/sync/amazon', requireAuth, async (req, res) => {
  trackedWithLog('amazon', () => syncAmazon(), 'manual')
  res.json({ ok: true })
})

// ── Save generic module config (pieces, achats, billets, serials, envois)
const SIMPLE_MODULES = ['pieces', 'achats', 'billets', 'serials', 'envois', 'soumissions', 'retours', 'retour_items', 'adresses', 'bom', 'serial_changes', 'assemblages', 'employees', 'paies', 'paie_items']
router.put('/airtable/module-config/:module', requireAuth, (req, res) => {
  const { module } = req.params
  if (!SIMPLE_MODULES.includes(module)) return res.status(400).json({ error: 'Module invalide' })
  const { base_id, table_id, field_map } = req.body
  db.prepare(`
    INSERT INTO airtable_module_config (module, base_id, table_id, field_map)
    VALUES (?,?,?,?)
    ON CONFLICT(module) DO UPDATE SET
      base_id=excluded.base_id, table_id=excluded.table_id, field_map=excluded.field_map
  `).run(module, base_id || null, table_id || null, field_map ? JSON.stringify(field_map) : null)
  res.json({ ok: true })
  if (base_id) registerWebhookForBaseTraced(base_id, 'config-save')
})

router.post('/sync/pieces', requireAuth, async (req, res) => {
  trackedWithLog('pieces', syncPieces, 'manual')
  res.json({ ok: true })
})

// ── Save Orders config
router.put('/airtable/orders-config', requireAuth, (req, res) => {
  const { base_id, orders_table_id, items_table_id, field_map_orders, field_map_items } = req.body
  db.prepare(`
    INSERT INTO airtable_orders_config (base_id, orders_table_id, items_table_id, field_map_orders, field_map_items)
    VALUES (?,?,?,?,?)
    ON CONFLICT DO UPDATE SET
      base_id=excluded.base_id, orders_table_id=excluded.orders_table_id,
      items_table_id=excluded.items_table_id, field_map_orders=excluded.field_map_orders,
      field_map_items=excluded.field_map_items
  `).run(base_id || null, orders_table_id || null, items_table_id || null,
    field_map_orders ? JSON.stringify(field_map_orders) : null,
    field_map_items ? JSON.stringify(field_map_items) : null)
  res.json({ ok: true })
  if (base_id) registerWebhookForBaseTraced(base_id, 'config-save')
})

router.post('/sync/orders', requireAuth, async (req, res) => {
  trackedWithLog('orders', syncOrders, 'manual')
  res.json({ ok: true })
})

router.post('/sync/achats', requireAuth, async (req, res) => {
  trackedWithLog('achats', syncAchats, 'manual')
  res.json({ ok: true })
})

router.post('/sync/billets', requireAuth, async (req, res) => {
  trackedWithLog('billets', syncBillets, 'manual')
  res.json({ ok: true })
})

router.post('/sync/serials', requireAuth, async (req, res) => {
  trackedWithLog('serials', syncSerials, 'manual')
  res.json({ ok: true })
})

router.post('/sync/envois', requireAuth, async (req, res) => {
  trackedWithLog('envois', syncEnvois, 'manual')
  res.json({ ok: true })
})
router.post('/sync/soumissions', requireAuth, async (req, res) => {
  trackedWithLog('soumissions', syncSoumissions, 'manual')
  res.json({ ok: true })
})
router.post('/sync/retours', requireAuth, async (req, res) => {
  trackedWithLog('retours', syncRetours, 'manual')
  res.json({ ok: true })
})
router.post('/sync/retour_items', requireAuth, async (req, res) => {
  trackedWithLog('retour_items', syncRetourItems, 'manual')
  res.json({ ok: true })
})
router.post('/sync/adresses', requireAuth, async (req, res) => {
  trackedWithLog('adresses', syncAdresses, 'manual')
  res.json({ ok: true })
})
router.post('/sync/bom', requireAuth, async (req, res) => {
  trackedWithLog('bom', syncBomItems, 'manual')
  res.json({ ok: true })
})
router.post('/sync/serial_changes', requireAuth, async (req, res) => {
  trackedWithLog('serial_changes', syncSerialStateChanges, 'manual')
  res.json({ ok: true })
})
router.post('/sync/abonnements', requireAuth, async (req, res) => {
  tracked('stripe', () => syncStripeSubscriptions()).catch(console.error)
  res.json({ ok: true })
})
router.post('/sync/assemblages', requireAuth, async (req, res) => {
  trackedWithLog('assemblages', syncAssemblages, 'manual')
  res.json({ ok: true })
})
router.post('/sync/employees', requireAuth, async (req, res) => {
  trackedWithLog('employees', syncEmployees, 'manual')
  res.json({ ok: true })
})
router.post('/sync/paies', requireAuth, async (req, res) => {
  trackedWithLog('paies', syncPaies, 'manual')
  res.json({ ok: true })
})
router.post('/sync/paie_items', requireAuth, async (req, res) => {
  trackedWithLog('paie_items', syncPaieItems, 'manual')
  res.json({ ok: true })
})
router.post('/sync/stock_movements', requireAuth, async (req, res) => {
  trackedWithLog('stock_movements', syncStockMovements, 'manual')
  res.json({ ok: true })
})

router.post('/sync/airtable-all', requireAuth, async (req, res) => {
  const ALL_AIRTABLE_MODULES = [
    ['airtable',      syncAirtable],
    ['projets',       syncProjets],
    ['pieces',        syncPieces],
    ['orders',        syncOrders],
    ['achats',        syncAchats],
    ['billets',       syncBillets],
    ['serials',       syncSerials],
    ['envois',        syncEnvois],
    ['soumissions',   syncSoumissions],
    ['retours',       syncRetours],
    ['retour_items',  syncRetourItems],
    ['adresses',      syncAdresses],
    ['bom',           syncBomItems],
    ['serial_changes',syncSerialStateChanges],
    ['assemblages',   syncAssemblages],
    ['employees',     syncEmployees],
    ['paies',         syncPaies],
    ['paie_items',    syncPaieItems],
    ['stock_movements', syncStockMovements],
  ]
  ALL_AIRTABLE_MODULES.forEach(([key, fn]) => {
    trackedWithLog(key, fn, 'manual')
  })
  res.json({ ok: true })
})

// ── Whisper / OpenAI ─────────────────────────────────────────────────────────

const ENV_FILE = resolve(process.cwd(), '.env')

function updateEnvKey(key, value) {
  let content = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : ''
  const regex = new RegExp(`^${key}=.*$`, 'm')
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`)
  } else {
    content += `\n${key}=${value}`
  }
  writeFileSync(ENV_FILE, content)
  process.env[key] = value
}

// GET /api/connectors/whisper
router.get('/whisper', requireAuth, (req, res) => {
  const configured = !!process.env.OPENAI_API_KEY
  const stats = db.prepare(`SELECT transcription_status, COUNT(*) as total FROM calls
    JOIN interactions i ON calls.interaction_id = i.id
    GROUP BY transcription_status`).all()
  const retranscribable = db.prepare(`SELECT COUNT(*) as total FROM calls
    JOIN interactions i ON calls.interaction_id = i.id
    WHERE recording_path IS NOT NULL AND transcription_status IN ('pending','error')`).get()
  res.json({ configured, stats, retranscribable: retranscribable.total })
})

// PUT /api/connectors/whisper — sauvegarder la clé API
router.put('/whisper', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' })
  const { api_key } = req.body
  if (!api_key?.startsWith('sk-')) return res.status(400).json({ error: 'Clé OpenAI invalide (doit commencer par sk-)' })
  updateEnvKey('OPENAI_API_KEY', api_key)
  res.json({ ok: true })
})

// GET /api/connectors/whisper/drive-status — combien de fichiers Drive manquants
router.get('/whisper/drive-status', requireAuth, async (req, res) => {
  const { join } = await import('path')
  const uploadsDir = join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'calls')
  const calls = db.prepare(`
    SELECT ca.id, ca.recording_path FROM calls ca
    JOIN interactions i ON ca.interaction_id = i.id
    WHERE ca.drive_file_id IS NOT NULL AND ca.recording_path IS NOT NULL
  `).all()

  let missing = 0
  for (const c of calls) {
    if (!existsSync(join(uploadsDir, c.recording_path))) missing++
  }
  res.json({ total: calls.length, missing })
})

// POST /api/connectors/whisper/download-drive — re-télécharger les fichiers Drive manquants
const driveDownloadState = { running: false, done: 0, total: 0, errors: 0 }

router.get('/whisper/download-drive/status', requireAuth, (req, res) => {
  res.json(driveDownloadState)
})

router.post('/whisper/download-drive', requireAuth, async (req, res) => {
  if (driveDownloadState.running) return res.status(409).json({ error: 'Déjà en cours' })

  const oauthRow = db.prepare(`SELECT id FROM connector_oauth WHERE connector='google' ORDER BY updated_at DESC LIMIT 1`).get()
  if (!oauthRow) return res.status(503).json({ error: 'Google Drive non connecté' })

  const { join } = await import('path')
  const { createWriteStream } = await import('fs')
  const { pipeline } = await import('stream/promises')
  const { getDriveClient } = await import('../connectors/google.js')
  const { enqueueTranscription } = await import('../services/whisper.js')
  const uploadsDir = join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'calls')

  const calls = db.prepare(`
    SELECT ca.id, ca.drive_file_id, ca.recording_path, ca.transcription_status FROM calls ca
    JOIN interactions i ON ca.interaction_id = i.id
    WHERE ca.drive_file_id IS NOT NULL AND ca.recording_path IS NOT NULL
  `).all().filter(c => !existsSync(join(uploadsDir, c.recording_path)))

  driveDownloadState.running = true
  driveDownloadState.done = 0
  driveDownloadState.errors = 0
  driveDownloadState.total = calls.length

  res.json({ started: true, total: calls.length })

  // Téléchargement en arrière-plan
  ;(async () => {
    try {
      const drive = await getDriveClient(oauthRow.id)
      for (const call of calls) {
        try {
          const dest = join(uploadsDir, call.recording_path)
          const driveRes = await drive.files.get({ fileId: call.drive_file_id, alt: 'media' }, { responseType: 'stream' })
          await pipeline(driveRes.data, createWriteStream(dest))
          driveDownloadState.done++
          // Transcrire si pas déjà fait
          if (['pending', 'error'].includes(call.transcription_status)) {
            enqueueTranscription(call.id, dest, 'drive-download').catch((err) => {
              // Surfacer l'échec d'enqueue : sans ça, l'appel reste bloqué en pending et
              // l'utilisateur croit la transcription en cours. On marque 'error' pour le rendre
              // visible et relançable via /whisper/retry.
              console.error(`❌ Enqueue transcription échoué (call ${call.id}):`, err?.message || err)
              try { db.prepare(`UPDATE calls SET transcription_status='error' WHERE id=?`).run(call.id) } catch {}
            })
          }
        } catch (e) {
          driveDownloadState.errors++
          console.error(`Drive download error ${call.drive_file_id}:`, e.message)
        }
      }
    } finally {
      driveDownloadState.running = false
      console.log(`✅ Drive download terminé: ${driveDownloadState.done}/${driveDownloadState.total}, erreurs: ${driveDownloadState.errors}`)
    }
  })()
})

// POST /api/connectors/whisper/retry — relancer les transcriptions en attente/erreur
router.post('/whisper/retry', requireAuth, async (req, res) => {
  if (!process.env.OPENAI_API_KEY) return res.status(400).json({ error: 'OPENAI_API_KEY non configuré' })
  const { enqueueTranscription } = await import('../services/whisper.js')
  const { join } = await import('path')
  const uploadsDir = join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'calls')

  const calls = db.prepare(`SELECT calls.id, calls.recording_path FROM calls
    JOIN interactions i ON calls.interaction_id = i.id
    WHERE recording_path IS NOT NULL AND transcription_status IN ('pending','error')
  `).all()

  let queued = 0
  for (const call of calls) {
    const filePath = join(uploadsDir, call.recording_path)
    if (existsSync(filePath)) {
      enqueueTranscription(call.id, filePath, 'whisper-retry').catch((err) => {
        // Surfacer l'échec d'enqueue : marquer 'error' pour garder l'appel visible/relançable
        // au lieu de le laisser coincé en pending sans aucun feedback.
        console.error(`❌ Enqueue transcription échoué (call ${call.id}):`, err?.message || err)
        try { db.prepare(`UPDATE calls SET transcription_status='error' WHERE id=?`).run(call.id) } catch {}
      })
      queued++
    }
  }
  res.json({ queued, total: calls.length })
})

// ── FTP / Cube ACR ────────────────────────────────────────────────────────────

// GET /api/connectors/ftp — infos serveur + liste des téléphones configurés
router.get('/ftp', requireAuth, (req, res) => {
  const ftpUsers = readFtpUsers()
  const erpUsers = db.prepare(`SELECT id, name, ftp_username FROM users WHERE active=1 ORDER BY name`).all()

  const phones = ftpUsers.map(u => {
    const erpUser = erpUsers.find(e => e.ftp_username === u.erpFtpUsername)
    return { ftpUser: u.ftpUser, ftpPass: u.ftpPass, nom: u.nom, erpFtpUsername: u.erpFtpUsername, erpUserId: erpUser?.id || null }
  })

  res.json({ host: FTP_HOST, port: FTP_PORT, folder: '/', phones, erpUsers })
})

// POST /api/connectors/ftp/phones — ajouter un téléphone
router.post('/ftp/phones', requireAuth, (req, res) => {
  const { ftpUser, ftpPass, nom, erpUserId } = req.body
  if (!ftpUser || !ftpPass || !nom || !erpUserId) return res.status(400).json({ error: 'ftpUser, ftpPass, nom et erpUserId requis' })

  // Vérifier que l'user ERP appartient au tenant
  const erpUser = db.prepare(`SELECT id, ftp_username FROM users WHERE id=?`).get(erpUserId)
  if (!erpUser) return res.status(404).json({ error: 'Utilisateur ERP introuvable' })

  const result = mutateFtpUsers(users => {
    if (users.find(u => u.ftpUser === ftpUser)) return { conflict: true }
    users.push({ ftpUser, ftpPass, nom, erpFtpUsername: ftpUser })
    writeFtpUsers(users)
    return { ok: true }
  })
  if (result.conflict) return res.status(409).json({ error: 'Cet identifiant FTP existe déjà' })

  db.prepare(`UPDATE users SET ftp_username=? WHERE id=?`).run(ftpUser, erpUserId)

  res.status(201).json({ ok: true })
})

// DELETE /api/connectors/ftp/phones/:ftpUser — supprimer un téléphone
router.delete('/ftp/phones/:ftpUser', requireAuth, (req, res) => {
  const { ftpUser } = req.params
  const result = mutateFtpUsers(users => {
    const idx = users.findIndex(u => u.ftpUser === ftpUser)
    if (idx === -1) return { notFound: true }
    const erpFtpUsername = users[idx].erpFtpUsername
    users.splice(idx, 1)
    writeFtpUsers(users)
    return { erpFtpUsername }
  })
  if (result.notFound) return res.status(404).json({ error: 'Téléphone introuvable' })

  db.prepare(`UPDATE users SET ftp_username=NULL WHERE ftp_username=?`).run(result.erpFtpUsername)

  res.json({ ok: true })
})

// PUT /api/connectors/ftp/phones/:ftpUser — modifier le mot de passe
router.put('/ftp/phones/:ftpUser', requireAuth, (req, res) => {
  const { ftpPass } = req.body
  if (!ftpPass) return res.status(400).json({ error: 'ftpPass requis' })

  const result = mutateFtpUsers(users => {
    const user = users.find(u => u.ftpUser === req.params.ftpUser)
    if (!user) return { notFound: true }
    user.ftpPass = ftpPass
    writeFtpUsers(users)
    return { ok: true }
  })
  if (result.notFound) return res.status(404).json({ error: 'Téléphone introuvable' })
  res.json({ ok: true })
})

// POST /api/connectors/deduplicate-ftp-calls
// Supprime les appels FTP qui sont des doublons d'appels Drive.
// Critères (par ordre de priorité) :
//   1. Taille fichier identique → doublon certain
//   2. Même numéro (10 derniers chiffres) + même durée (±15s) → très probable
// Pour chaque doublon : supprime l'enregistrement FTP + son fichier audio,
// met à jour le timestamp Drive depuis le nom de fichier.
router.post('/deduplicate-ftp-calls', requireAdmin, (req, res) => {
  const uploadsDir = join(process.cwd(), process.env.UPLOADS_PATH || 'uploads', 'calls')

  function normalize(p) { return p ? p.replace(/\D/g, '').slice(-10) : null }

  function parseTs(filename) {
    const m = filename?.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}-\d{2}-\d{2})/)
    if (!m) return null
    return new Date(`${m[1]}T${m[2].replace(/-/g, ':')}`).toISOString()
  }

  // Appels FTP à mauvais timestamp
  const ftpCalls = db.prepare(`
    SELECT c.id as call_id, c.recording_path, c.callee_number, c.caller_number, c.duration_seconds,
           i.id as interaction_id
    FROM calls c JOIN interactions i ON i.id = c.interaction_id
    WHERE c.drive_filename IS NULL
    AND ABS(strftime('%s', i.timestamp) - strftime('%s', i.created_at)) < 5
  `).all()

  // Appels Drive avec fichier audio
  const driveCalls = db.prepare(`
    SELECT c.id as call_id, c.recording_path, c.callee_number, c.caller_number,
           c.duration_seconds, c.drive_filename, c.drive_file_id,
           i.id as interaction_id, i.timestamp
    FROM calls c JOIN interactions i ON i.id = c.interaction_id
    WHERE c.drive_filename IS NOT NULL AND c.recording_path IS NOT NULL
  `).all()

  // Index Drive par taille de fichier
  const driveBySizeMap = new Map()
  for (const d of driveCalls) {
    try {
      const size = statSync(join(uploadsDir, d.recording_path)).size
      if (!driveBySizeMap.has(size)) driveBySizeMap.set(size, [])
      driveBySizeMap.get(size).push(d)
    } catch {}
  }

  // Index Drive par (numéro normalisé → liste)
  const driveByPhone = new Map()
  for (const d of driveCalls) {
    const p = normalize(d.callee_number) || normalize(d.caller_number)
    if (!p) continue
    if (!driveByPhone.has(p)) driveByPhone.set(p, [])
    driveByPhone.get(p).push(d)
  }

  const deleteFtp = db.prepare('DELETE FROM calls WHERE id = ?')
  const deleteInteraction = db.prepare('DELETE FROM interactions WHERE id = ?')
  const updateDriveTs = db.prepare('UPDATE interactions SET timestamp = ? WHERE id = ?')

  let deletedBySize = 0, deletedByPhoneDur = 0, kept = 0

  const doDelete = db.transaction((ftpCall, driveMatch) => {
    // Corriger le timestamp du Drive depuis le nom de fichier
    const ts = parseTs(driveMatch.drive_filename)
    if (ts) updateDriveTs.run(ts, driveMatch.interaction_id)

    // Supprimer le fichier FTP audio
    try { unlinkSync(join(uploadsDir, ftpCall.recording_path)) } catch {}

    // Supprimer l'enregistrement FTP
    deleteFtp.run(ftpCall.call_id)
    deleteInteraction.run(ftpCall.interaction_id)
  })

  for (const c of ftpCalls) {
    let ftpSize = 0
    try { ftpSize = statSync(join(uploadsDir, c.recording_path)).size } catch {}

    // Critère 1 : taille identique
    const sizeMatches = ftpSize > 0 ? (driveBySizeMap.get(ftpSize) || []) : []
    if (sizeMatches.length === 1) {
      doDelete(c, sizeMatches[0])
      deletedBySize++
      continue
    }

    // Critère 2 : même numéro + même durée (±15s)
    const p = normalize(c.callee_number) || normalize(c.caller_number)
    if (p) {
      const phoneMatches = driveByPhone.get(p) || []
      const durMatch = phoneMatches.find(d =>
        c.duration_seconds != null && d.duration_seconds != null &&
        Math.abs(c.duration_seconds - d.duration_seconds) <= 15
      )
      if (durMatch) {
        doDelete(c, durMatch)
        deletedByPhoneDur++
        continue
      }
    }

    kept++
  }

  res.json({
    deletedBySize,
    deletedByPhoneDur,
    kept,
    total: ftpCalls.length,
    message: `${deletedBySize + deletedByPhoneDur} doublons supprimés, ${kept} appels conservés`,
  })
})

// POST /api/connectors/fix-ftp-timestamps
// Parcourt tous les fichiers Drive, parse leur date depuis le nom, et met à jour
// les appels FTP dont le timestamp est faux (timestamp ≈ created_at) en matchant
// par numéro de téléphone (10 derniers chiffres) + durée (±30s).
router.post('/fix-ftp-timestamps', requireAdmin, async (req, res) => {
  // Récupère les dossiers Drive configurés
  let folders = []
  const foldersRow = db.prepare(`SELECT value FROM connector_config WHERE connector='google' AND key='drive_folders'`).get()
  if (foldersRow?.value) { try { folders = JSON.parse(foldersRow.value) } catch {} }
  if (folders.length === 0) {
    const fRow = db.prepare(`SELECT value FROM connector_config WHERE connector='google' AND key='drive_folder_id'`).get()
    if (fRow?.value) folders = [{ folder_id: fRow.value }]
  }
  if (folders.length === 0) return res.status(400).json({ error: 'Aucun dossier Drive configuré' })

  // Récupère les appels FTP à mauvais timestamp
  const ftpCalls = db.prepare(`
    SELECT c.id as call_id, c.callee_number, c.caller_number, c.duration_seconds,
           i.id as interaction_id, i.timestamp, i.created_at
    FROM calls c JOIN interactions i ON i.id = c.interaction_id
    WHERE c.drive_filename IS NULL
    AND ABS(strftime('%s', i.timestamp) - strftime('%s', i.created_at)) < 5
  `).all()

  if (ftpCalls.length === 0) return res.json({ fixed: 0, total: 0, message: 'Aucun appel à corriger' })

  res.json({ started: true, total: ftpCalls.length })

  // Traitement asynchrone
  ;(async () => {
    const { getDriveClient } = await import('../connectors/google.js')

    function parseTs(filename) {
      const m = filename.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}-\d{2}-\d{2})/)
      if (!m) return null
      return new Date(`${m[1]}T${m[2].replace(/-/g, ':')}`).toISOString()
    }
    function normalizePhone(p) {
      return p ? p.replace(/\D/g, '').slice(-10) : null
    }

    let fixed = 0, scanned = 0

    for (const folder of folders) {
      const oauthRow = db.prepare(`
        SELECT co.id FROM connector_oauth co
        JOIN users u ON u.id = co.user_id
        WHERE co.connector='google'
        ORDER BY co.updated_at DESC LIMIT 1
      `).get()
      if (!oauthRow) continue

      let drive
      try { drive = await getDriveClient(oauthRow.id) } catch { continue }

      let pageToken = null
      do {
        const params = {
          q: `'${folder.folder_id}' in parents and (mimeType contains 'audio/' or mimeType contains 'video/') and trashed=false`,
          fields: 'nextPageToken, files(id, name)',
          pageSize: 200,
          ...(pageToken ? { pageToken } : {}),
        }
        const list = await drive.files.list(params).catch(() => ({ data: {} }))
        const files = list.data.files || []
        pageToken = list.data.nextPageToken || null
        scanned += files.length

        for (const file of files) {
          const ts = parseTs(file.name)
          if (!ts) continue

          // Extraire le numéro depuis le nom de fichier
          const phoneMatch = file.name.match(/\(([+\d\s\-()]{7,})\)/)
          const drivePhone = phoneMatch ? normalizePhone(phoneMatch[1]) : null
          if (!drivePhone) continue

          // Chercher un appel FTP non encore corrigé avec ce numéro
          const candidates = ftpCalls.filter(c => {
            const p = normalizePhone(c.callee_number) || normalizePhone(c.caller_number)
            return p === drivePhone
          })
          if (candidates.length === 0) continue

          // Durée depuis le JSON Drive compagnon (optionnel)
          let driveDuration = null
          try {
            const base = file.name.replace(/\.[^.]+$/, '')
            const jList = await drive.files.list({
              q: `'${folder.folder_id}' in parents and name='${base}.json' and trashed=false`,
              fields: 'files(id)', pageSize: 1,
            })
            const jId = jList.data.files?.[0]?.id
            if (jId) {
              const jData = await drive.files.get({ fileId: jId, alt: 'media' })
              driveDuration = jData.data?.duration ? Math.round(Number(jData.data.duration) / 1000) : null
            }
          } catch {}

          // Choisir le meilleur candidat (par durée si disponible, sinon le premier)
          let best = candidates[0]
          if (driveDuration && candidates.length > 1) {
            best = candidates.reduce((prev, cur) => {
              const dp = Math.abs((prev.duration_seconds || 0) - driveDuration)
              const dc = Math.abs((cur.duration_seconds || 0) - driveDuration)
              return dc < dp ? cur : prev
            })
          }

          // Met à jour le timestamp
          db.prepare('UPDATE interactions SET timestamp=? WHERE id=?').run(ts, best.interaction_id)
          // Retire de la liste pour ne pas le corriger deux fois
          const idx = ftpCalls.indexOf(best)
          if (idx !== -1) ftpCalls.splice(idx, 1)
          fixed++
        }
      } while (pageToken)
    }

    console.log(`✅ fix-ftp-timestamps: ${fixed} corrigés sur ${scanned} fichiers Drive scannés`)
  })().catch(e => console.error('❌ fix-ftp-timestamps:', e.message))
})

// ── QuickBooks OAuth ─────────────────────────────────────────────────────────

router.get('/quickbooks/connect', requireAuth, (req, res) => {
  // scope=me → connexion personnelle : les écritures publiées par cet utilisateur
  // seront attribuées à SON compte QuickBooks dans l'« Historique de vérification ».
  // Sinon → connexion principale ('default'), repli pour les écritures automatiques
  // (webhooks Stripe, syncs). Réautoriser le compte principal exige un admin.
  const personal = req.query.scope === 'me'
  if (!personal && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin requis pour la connexion principale QuickBooks' })
  }
  const accountKey = personal ? req.user.id : 'default'
  const state = Buffer.from(JSON.stringify({ accountKey })).toString('base64url')
  try {
    const url = qbAuthUrl(state)
    res.redirect(url)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/quickbooks/callback', async (req, res) => {
  const { code, state, realmId, error } = req.query
  if (error) return res.redirect('/erp/connectors?error=quickbooks_denied')
  try {
    const parsed = JSON.parse(Buffer.from(state, 'base64url').toString())
    const accountKey = parsed.accountKey || 'default'
    const isPersonal = accountKey !== 'default'

    // Garde-fou : une connexion personnelle DOIT pointer vers la même entreprise QB
    // (realm) que la connexion principale, sinon les écritures de cette personne
    // partiraient dans d'autres livres comptables.
    if (isPersonal) {
      const def = db.prepare(
        "SELECT metadata FROM connector_oauth WHERE connector='quickbooks' AND account_key='default'"
      ).get()
      const defRealm = def ? JSON.parse(def.metadata || '{}').realm_id : null
      if (defRealm && String(defRealm) !== String(realmId)) {
        return res.redirect('/erp/connectors?error=quickbooks_wrong_company')
      }
    }

    const tokens = await qbExchange(code)
    const expiry = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null

    // Nom de l'utilisateur (connexion personnelle) pour l'affichage admin.
    let userName = null
    if (isPersonal) {
      const u = db.prepare('SELECT name, email FROM users WHERE id=?').get(accountKey)
      userName = u?.name || u?.email || null
    }
    const metadata = JSON.stringify({
      realm_id: realmId,
      ...(isPersonal ? { user_id: accountKey, user_name: userName } : {}),
    })

    const existing = db.prepare(
      "SELECT id FROM connector_oauth WHERE connector='quickbooks' AND account_key=?"
    ).get(accountKey)

    if (existing) {
      db.prepare(`
        UPDATE connector_oauth
        SET access_token=?, refresh_token=?, expiry_date=?, metadata=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id=?
      `).run(tokens.access_token, tokens.refresh_token, expiry, metadata, existing.id)
    } else {
      db.prepare(`
        INSERT INTO connector_oauth (id, connector, account_key, access_token, refresh_token, expiry_date, metadata)
        VALUES (?,?,?,?,?,?,?)
      `).run(uuid(), 'quickbooks', accountKey, tokens.access_token, tokens.refresh_token, expiry, metadata)
    }

    res.redirect('/erp/connectors?success=quickbooks')
  } catch (e) {
    console.error('QB callback error:', e.message)
    res.redirect('/erp/connectors?error=quickbooks_failed')
  }
})

// GET /quickbooks/my-connection — statut de la connexion personnelle de l'utilisateur courant
router.get('/quickbooks/my-connection', requireAuth, (req, res) => {
  const r = db.prepare(
    "SELECT metadata, updated_at FROM connector_oauth WHERE connector='quickbooks' AND account_key=?"
  ).get(req.user.id)
  if (!r) return res.json({ connected: false })
  const m = JSON.parse(r.metadata || '{}')
  res.json({ connected: true, realmId: m.realm_id || null, updatedAt: r.updated_at })
})

// DELETE /quickbooks/my-connection — déconnecter sa propre connexion personnelle
router.delete('/quickbooks/my-connection', requireAuth, (req, res) => {
  db.prepare(
    "DELETE FROM connector_oauth WHERE connector='quickbooks' AND account_key=?"
  ).run(req.user.id)
  res.json({ ok: true })
})

// GET /quickbooks/connections — liste de toutes les connexions QB (admin)
router.get('/quickbooks/connections', requireAdmin, (req, res) => {
  const rows = db.prepare(
    "SELECT account_key, metadata, updated_at FROM connector_oauth WHERE connector='quickbooks' ORDER BY (account_key='default') DESC, updated_at DESC"
  ).all()
  res.json(rows.map(r => {
    const m = JSON.parse(r.metadata || '{}')
    return {
      accountKey: r.account_key,
      isDefault: r.account_key === 'default',
      userId: m.user_id || null,
      userName: m.user_name || null,
      realmId: m.realm_id || null,
      updatedAt: r.updated_at,
    }
  }))
})

// DELETE /quickbooks/connections/:accountKey — déconnecter une connexion personnelle (admin)
router.delete('/quickbooks/connections/:accountKey', requireAdmin, (req, res) => {
  const { accountKey } = req.params
  if (accountKey === 'default') {
    return res.status(400).json({ error: "La connexion principale ne se supprime pas ici" })
  }
  db.prepare(
    "DELETE FROM connector_oauth WHERE connector='quickbooks' AND account_key=?"
  ).run(accountKey)
  res.json({ ok: true })
})

// GET /api/connectors/quickbooks/accounts — liste des comptes QB
// Par défaut: Expense + Bank + CreditCard. Avec ?all=1: tous les types actifs (pour journal entries).
router.get('/quickbooks/accounts', requireAuth, async (req, res) => {
  try {
    const all = req.query.all === '1' || req.query.all === 'true'
    const query = all
      ? "SELECT * FROM Account WHERE Active = true MAXRESULTS 1000"
      : "SELECT * FROM Account WHERE AccountType IN ('Expense', 'Other Expense', 'Cost of Goods Sold', 'Other Current Asset', 'Bank', 'Credit Card') MAXRESULTS 300"
    const q = new URLSearchParams({ query })
    const data = await qbGet(`/query?${q}`)
    res.json(data.QueryResponse?.Account || [])
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// GET /api/connectors/quickbooks/tax-codes — liste des codes de taxe QB actifs
router.get('/quickbooks/tax-codes', requireAuth, async (req, res) => {
  try {
    const q = new URLSearchParams({ query: "SELECT * FROM TaxCode WHERE Active = true MAXRESULTS 500" })
    const data = await qbGet(`/query?${q}`)
    const codes = (data.QueryResponse?.TaxCode || []).map(tc => ({
      Id: tc.Id,
      Name: tc.Name,
      Description: tc.Description || null,
      Taxable: tc.Taxable,
    }))
    res.json(codes)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// GET /api/connectors/quickbooks/vendors — liste des fournisseurs QB (paginé)
router.get('/quickbooks/vendors', requireAuth, async (req, res) => {
  try {
    const pageSize = 1000
    let startPos = 1
    const all = []
    while (true) {
      const q = encodeURIComponent(`SELECT * FROM Vendor WHERE Active = true STARTPOSITION ${startPos} MAXRESULTS ${pageSize}`)
      const data = await qbGet(`/query?query=${q}`)
      const batch = data.QueryResponse?.Vendor || []
      all.push(...batch)
      if (batch.length < pageSize) break
      startPos += pageSize
    }
    res.json(all)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// POST /api/connectors/sync/qb-achats — publier les achats fournisseurs non synchronisés
router.post('/sync/qb-achats', requireAuth, (req, res) => {
  tracked('qb-achats', () => syncAllAchatsToQB())
    .catch(console.error)
  res.json({ ok: true })
})

// POST /api/connectors/sync/qb-import — importer Bills + Purchases depuis QB
router.post('/sync/qb-import', requireAuth, async (req, res) => {
  try {
    const result = await importFromQB()
    res.json(result)
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

// ── Stripe ───────────────────────────────────────────────────────────────────

// GET /api/connectors/stripe — état de configuration
router.get('/stripe', requireAuth, (req, res) => {
  const configured = isStripeConfigured()
  const pk = db.prepare("SELECT value FROM connector_config WHERE connector='stripe' AND key='publishable_key'").get()
  res.json({ configured, publishable_key: pk?.value || null })
})

// PUT /api/connectors/stripe — enregistrer la clé secrète (+/- publishable)
router.put('/stripe', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' })
  const { secret_key, publishable_key } = req.body
  if (secret_key !== undefined) {
    if (!secret_key || !secret_key.startsWith('sk_')) {
      return res.status(400).json({ error: 'Clé Stripe invalide (doit commencer par sk_)' })
    }
    db.prepare(`
      INSERT INTO connector_config (connector, key, value) VALUES (?,?,?)
      ON CONFLICT(connector, key) DO UPDATE SET value=excluded.value
    `).run('stripe', 'secret_key', secret_key)
  }
  if (publishable_key !== undefined) {
    if (!publishable_key || !publishable_key.startsWith('pk_')) {
      return res.status(400).json({ error: 'Publishable key invalide (doit commencer par pk_)' })
    }
    db.prepare(`
      INSERT INTO connector_config (connector, key, value) VALUES (?,?,?)
      ON CONFLICT(connector, key) DO UPDATE SET value=excluded.value
    `).run('stripe', 'publishable_key', publishable_key)
  }
  res.json({ ok: true })
})

// GET /api/connectors/stripe/publishable-key — clé publique exposée pour Stripe.js
// (publishable_key est par nature publique, pas d'auth requise — l'iframe du guide
// d'appel l'utilise pour monter Stripe Elements).
router.get('/stripe/publishable-key', (req, res) => {
  const row = db.prepare("SELECT value FROM connector_config WHERE connector='stripe' AND key='publishable_key'").get()
  res.json({ publishable_key: row?.value || null })
})

// DELETE /api/connectors/stripe — supprimer la clé
router.delete('/stripe', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' })
  db.prepare(
    "DELETE FROM connector_config WHERE connector='stripe' AND key IN ('secret_key','publishable_key')"
  ).run()
  res.json({ ok: true })
})

// POST /api/connectors/sync/stripe — déclencher un sync manuel
router.post('/sync/stripe', requireAuth, async (req, res) => {
  tracked('stripe', () => syncStripeSubscriptions()).catch(console.error)
  res.json({ ok: true })
})

// ── HubSpot ──────────────────────────────────────────────────────────────────

// GET /api/connectors/hubspot — état + mapping owners
router.get('/hubspot', requireAuth, async (req, res) => {
  const status = await hsOwnerStatus()
  res.json(status)
})

// PUT /api/connectors/hubspot — enregistrer le token Private App
router.put('/hubspot', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' })
  const { access_token } = req.body
  if (!access_token || !access_token.startsWith('pat-')) {
    return res.status(400).json({ error: 'Token HubSpot invalide (doit commencer par pat-)' })
  }
  db.prepare(`
    INSERT INTO connector_config (connector, key, value) VALUES (?,?,?)
    ON CONFLICT(connector, key) DO UPDATE SET value=excluded.value
  `).run('hubspot', 'access_token', access_token)
  res.json({ ok: true })
})

// DELETE /api/connectors/hubspot — supprimer le token et reset le curseur
router.delete('/hubspot', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' })
  db.prepare("DELETE FROM connector_config WHERE connector='hubspot'").run()
  res.json({ ok: true })
})

// POST /api/connectors/sync/hubspot — pull delta à la demande
router.post('/sync/hubspot', requireAuth, async (req, res) => {
  const full = !!req.body?.full
  trackedWithLog('hubspot_tasks', () => hsPullDelta({ full }), 'manual')
  res.json({ ok: true })
})

// POST /api/connectors/hubspot/retry-pushes — rejoue à la demande les push
// (ERP → HubSpot) persistés en échec dans hubspot_push_failures.
router.post('/hubspot/retry-pushes', requireAuth, async (req, res) => {
  try {
    const out = await hsRetryFailedPushes()
    res.json({ ok: true, ...out })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

// PUT /api/connectors/hubspot/mapping — override explicite user ERP → owner HS
router.put('/hubspot/mapping', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' })
  const { user_id, hubspot_owner_id } = req.body || {}
  if (!user_id) return res.status(400).json({ error: 'user_id requis' })
  try {
    hsSetOwnerOverride(user_id, hubspot_owner_id || null)
    res.json({ ok: true })
  } catch (e) { res.status(400).json({ error: e.message }) }
})

export default router
