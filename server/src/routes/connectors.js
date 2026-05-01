import { Router } from 'express'
import { v4 as uuid } from 'uuid'
import { createHash, randomBytes } from 'crypto'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import db from '../db/database.js'
import { readFileSync, writeFileSync, existsSync, statSync, unlinkSync } from 'fs'
import { resolve, join } from 'path'

const FTP_USERS_FILE = process.env.FTP_USERS_FILE || '/home/ec2-user/ftp-server/users.json'
const FTP_HOST = process.env.FTP_PUBLIC_IP || '3.132.49.255'
const FTP_PORT = process.env.FTP_PORT_PUBLIC || '2121'

function readFtpUsers() {
  try { return JSON.parse(readFileSync(FTP_USERS_FILE, 'utf8')) } catch { return [] }
}
function writeFtpUsers(users) {
  writeFileSync(FTP_USERS_FILE, JSON.stringify(users, null, 2))
}

import { getAuthUrl as googleAuthUrl, exchangeCode as googleExchange } from '../connectors/google.js'
import { getAuthUrl as airtableAuthUrl, exchangeCode as airtableExchange, airtableFetch, getAccessToken } from '../connectors/airtable.js'
import { getAuthUrl as qbAuthUrl, exchangeCode as qbExchange, qbGet } from '../connectors/quickbooks.js'
import { syncAllAchatsToQB, importFromQB } from '../services/quickbooks.js'
import { syncAllMailboxes } from '../services/gmail.js'
import { syncDrive } from '../services/drive.js'
import { syncAirtable, syncProjets, syncPieces, syncOrders, syncAchats, syncBillets, syncSerials, syncEnvois, syncSoumissions, syncRetours, syncRetourItems, syncAdresses, syncBomItems, syncSerialStateChanges, syncAssemblages, syncEmployees, syncPaies, syncPaieItems, syncStockMovements } from '../services/airtable.js'
import { tracked, getStatus } from '../services/syncState.js'
import { syncStripeSubscriptions, isStripeConfigured } from '../services/stripe.js'
import { isHubSpotConfigured } from '../connectors/hubspot.js'
import { pullDelta as hsPullDelta, getOwnerMappingStatus as hsOwnerStatus, setUserOwnerOverride as hsSetOwnerOverride } from '../services/hubspotSync.js'
import { isNovoxpressConfigured } from '../services/novoxpress.js'
import { processWebhookPing, registerWebhookForBase } from '../services/airtableWebhooks.js'
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
      registerWebhookForBase(baseId).catch(e => console.error('Webhook reg error:', e.message))
    }
  } catch (e) {
    console.error('Airtable callback error:', e.message)
    res.redirect('/erp/connectors?error=airtable_failed')
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
  if (base_id) registerWebhookForBase(base_id).catch(e => console.error('Webhook reg error:', e.message))
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
  if (base_id) registerWebhookForBase(base_id).catch(e => console.error('Webhook reg error:', e.message))
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
  if (base_id) registerWebhookForBase(base_id).catch(e => console.error('Webhook reg error:', e.message))
})

// ── Save Projets config
function saveProjetsConfig(req, res) {
  const { base_id, projects_table_id, field_map_projects, extra_tables } = req.body
  db.prepare(`
    INSERT INTO airtable_projets_config (base_id, projects_table_id, field_map_projects, extra_tables)
    VALUES (?,?,?,?)
    ON CONFLICT DO UPDATE SET
      base_id=excluded.base_id, projects_table_id=excluded.projects_table_id,
      field_map_projects=excluded.field_map_projects, extra_tables=excluded.extra_tables
  `).run(base_id || null, projects_table_id || null,
    field_map_projects ? JSON.stringify(field_map_projects) : null,
    extra_tables?.length ? JSON.stringify(extra_tables) : null)
  res.json({ ok: true })
  if (base_id) registerWebhookForBase(base_id).catch(e => console.error('Webhook reg error:', e.message))
}
router.put('/airtable/projets-config', requireAuth, saveProjetsConfig)
router.put('/airtable/inv-config', requireAuth, saveProjetsConfig)

// GET /api/connectors/airtable/projets/airtable-fields
// Retourne la liste des champs Airtable de la table projets configurée,
// EXCLUANT les champs « hardcodés » (mappés dans field_map_projects vers une
// colonne ERP fixe). Pour chaque champ retourné, on indique l'état
// import_disabled (0/1) déduit de airtable_field_defs.
router.get('/airtable/projets/airtable-fields', requireAuth, async (req, res) => {
  const config = db.prepare('SELECT * FROM airtable_projets_config').get()
  if (!config?.base_id || !config?.projects_table_id) {
    return res.json({ fields: [], hardcoded: [] })
  }
  let token
  try { token = await getAccessToken() }
  catch (e) { return res.status(500).json({ error: 'Airtable non connecté: ' + e.message }) }

  let tableMeta
  try {
    const data = await airtableFetch(`/meta/bases/${config.base_id}/tables`, token)
    tableMeta = (data.tables || []).find(t => t.id === config.projects_table_id)
  } catch (e) { return res.status(500).json({ error: 'Erreur metadata Airtable: ' + e.message }) }
  if (!tableMeta) return res.json({ fields: [], hardcoded: [] })

  const fieldMap = config.field_map_projects ? JSON.parse(config.field_map_projects) : {}
  // Les "hardcoded" Airtable field names = valeurs string du field_map (les
  // *_choices, etc. sont des objets et ne sont pas des field names).
  const hardcoded = new Set(Object.values(fieldMap).filter(v => typeof v === 'string'))

  const defs = db.prepare(
    "SELECT airtable_field_name, column_name, import_disabled FROM airtable_field_defs WHERE erp_table='projects'"
  ).all()
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
})

// POST /api/connectors/airtable/projets/airtable-field-disabled
// Body : { airtable_field_name: string, disabled: bool }
// - Toggle import_disabled dans airtable_field_defs (upsert).
// - Si on désactive et qu'une colonne existe : NULL-ifie les valeurs dans `projects`
//   pour que le champ disparaisse immédiatement de la fiche détail conditionnelle
//   et du tableau.
router.post('/airtable/projets/airtable-field-disabled', requireAuth, (req, res) => {
  const { airtable_field_name, disabled } = req.body || {}
  if (!airtable_field_name) return res.status(400).json({ error: 'airtable_field_name requis' })
  const flag = disabled ? 1 : 0

  // Bloc anti-mistake : empêche de désactiver un champ hardcodé (présent dans field_map_projects).
  const config = db.prepare('SELECT field_map_projects FROM airtable_projets_config').get()
  const fieldMap = config?.field_map_projects ? JSON.parse(config.field_map_projects) : {}
  const hardcoded = new Set(Object.values(fieldMap).filter(v => typeof v === 'string'))
  if (hardcoded.has(airtable_field_name)) {
    return res.status(400).json({ error: 'Ce champ est requis (hardcodé) et ne peut pas être désactivé' })
  }

  const def = db.prepare(
    "SELECT id, column_name FROM airtable_field_defs WHERE erp_table='projects' AND airtable_field_name=?"
  ).get(airtable_field_name)

  if (def) {
    db.prepare(
      "UPDATE airtable_field_defs SET import_disabled=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id=?"
    ).run(flag, def.id)
    if (flag === 1 && def.column_name) {
      // NULL-ifie la colonne dans projects pour disparition immédiate.
      try {
        db.prepare(`UPDATE projects SET ${def.column_name}=NULL`).run()
      } catch { /* ignore si la colonne n'existe pas pour une raison quelconque */ }
    }
  } else {
    // Pas encore de def → insère un placeholder désactivé. Au prochain sync,
    // si le champ est ré-activé, la def sera mise à jour avec le column_name réel.
    db.prepare(`
      INSERT INTO airtable_field_defs (id, module, erp_table, airtable_field_id, airtable_field_name, column_name, field_type, options, sort_order, import_disabled)
      VALUES (?, 'projets', 'projects', ?, ?, ?, 'text', '{}', 0, ?)
    `).run(uuid(), `pending_${Date.now()}`, airtable_field_name, '__pending__', flag)
  }
  res.json({ ok: true })
})

// ── Sync status
router.get('/sync/status', requireAuth, (req, res) => {
  res.json(getStatus())
})

// ── Manual sync triggers
router.post('/sync/gmail', requireAuth, async (req, res) => {
  tracked('gmail', () => syncAllMailboxes()).catch(console.error)
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
  if (base_id) registerWebhookForBase(base_id).catch(e => console.error('Webhook reg error:', e.message))
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
  if (base_id) registerWebhookForBase(base_id).catch(e => console.error('Webhook reg error:', e.message))
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
            enqueueTranscription(call.id, dest).catch(() => {})
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
      enqueueTranscription(call.id, filePath).catch(() => {})
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

  const users = readFtpUsers()
  if (users.find(u => u.ftpUser === ftpUser)) return res.status(409).json({ error: 'Cet identifiant FTP existe déjà' })

  users.push({ ftpUser, ftpPass, nom, erpFtpUsername: ftpUser })
  writeFtpUsers(users)

  db.prepare(`UPDATE users SET ftp_username=? WHERE id=?`).run(ftpUser, erpUserId)

  res.status(201).json({ ok: true })
})

// DELETE /api/connectors/ftp/phones/:ftpUser — supprimer un téléphone
router.delete('/ftp/phones/:ftpUser', requireAuth, (req, res) => {
  const { ftpUser } = req.params
  const users = readFtpUsers()
  const idx = users.findIndex(u => u.ftpUser === ftpUser)
  if (idx === -1) return res.status(404).json({ error: 'Téléphone introuvable' })

  const erpFtpUsername = users[idx].erpFtpUsername
  users.splice(idx, 1)
  writeFtpUsers(users)

  db.prepare(`UPDATE users SET ftp_username=NULL WHERE ftp_username=?`).run(erpFtpUsername)

  res.json({ ok: true })
})

// PUT /api/connectors/ftp/phones/:ftpUser — modifier le mot de passe
router.put('/ftp/phones/:ftpUser', requireAuth, (req, res) => {
  const { ftpPass } = req.body
  if (!ftpPass) return res.status(400).json({ error: 'ftpPass requis' })

  const users = readFtpUsers()
  const user = users.find(u => u.ftpUser === req.params.ftpUser)
  if (!user) return res.status(404).json({ error: 'Téléphone introuvable' })

  user.ftpPass = ftpPass
  writeFtpUsers(users)
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
  const state = Buffer.from(JSON.stringify({})).toString('base64url')
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
    JSON.parse(Buffer.from(state, 'base64url').toString())
    const tokens = await qbExchange(code)

    const expiry = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null
    const metadata = JSON.stringify({ realm_id: realmId })

    const existing = db.prepare(
      "SELECT id FROM connector_oauth WHERE connector='quickbooks' AND account_key='default'"
    ).get()

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
      `).run(uuid(), 'quickbooks', 'default', tokens.access_token, tokens.refresh_token, expiry, metadata)
    }

    res.redirect('/erp/connectors?success=quickbooks')
  } catch (e) {
    console.error('QB callback error:', e.message)
    res.redirect('/erp/connectors?error=quickbooks_failed')
  }
})

// GET /api/connectors/quickbooks/accounts — liste des comptes QB
// Par défaut: Expense + Bank + CreditCard. Avec ?all=1: tous les types actifs (pour journal entries).
router.get('/quickbooks/accounts', requireAuth, async (req, res) => {
  try {
    const all = req.query.all === '1' || req.query.all === 'true'
    const query = all
      ? "SELECT * FROM Account WHERE Active = true MAXRESULTS 1000"
      : "SELECT * FROM Account WHERE AccountType IN ('Expense', 'Other Expense', 'Bank', 'Credit Card') MAXRESULTS 200"
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

// GET /api/connectors/quickbooks/vendors — liste des fournisseurs QB
router.get('/quickbooks/vendors', requireAuth, async (req, res) => {
  try {
    const q = new URLSearchParams({ query: "SELECT * FROM Vendor WHERE Active = true MAXRESULTS 200" })
    const data = await qbGet(`/query?${q}`)
    res.json(data.QueryResponse?.Vendor || [])
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
  res.json({ configured })
})

// PUT /api/connectors/stripe — enregistrer la clé secrète
router.put('/stripe', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' })
  const { secret_key } = req.body
  if (!secret_key || !secret_key.startsWith('sk_')) {
    return res.status(400).json({ error: 'Clé Stripe invalide (doit commencer par sk_)' })
  }
  db.prepare(`
    INSERT INTO connector_config (connector, key, value) VALUES (?,?,?)
    ON CONFLICT(connector, key) DO UPDATE SET value=excluded.value
  `).run('stripe', 'secret_key', secret_key)
  res.json({ ok: true })
})

// DELETE /api/connectors/stripe — supprimer la clé
router.delete('/stripe', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin requis' })
  db.prepare(
    "DELETE FROM connector_config WHERE connector='stripe' AND key='secret_key'"
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
