import { Router } from 'express'
import { v4 as uuid } from 'uuid'
import { createHash, randomBytes } from 'crypto'
import jwt from 'jsonwebtoken'
import { requireAuth } from '../middleware/auth.js'
import db from '../db/database.js'
import { readFileSync, writeFileSync, existsSync, statSync, unlinkSync } from 'fs'
import { resolve, join } from 'path'
import os from 'os'

const FTP_USERS_FILE = process.env.FTP_USERS_FILE || '/home/ec2-user/ftp-server/users.json'
const FTP_HOST = process.env.FTP_PUBLIC_IP || '3.132.49.255'
const FTP_PORT = process.env.FTP_PORT_PUBLIC || '2121'

function readFtpUsers() {
  try { return JSON.parse(readFileSync(FTP_USERS_FILE, 'utf8')) } catch { return [] }
}
function writeFtpUsers(users) {
  writeFileSync(FTP_USERS_FILE, JSON.stringify(users, null, 2))
}

// Auth middleware that also accepts token as query param (needed for browser OAuth redirects)
function requireAuthOrQuery(req, res, next) {
  const tokenStr = req.headers['authorization']?.slice(7) || req.query.token
  if (!tokenStr) return res.status(401).json({ error: 'Authentication required' })
  try {
    const payload = jwt.verify(tokenStr, process.env.JWT_SECRET || 'change-this-secret-in-production')
    req.user = { id: payload.id, tenant_id: payload.tenant_id, role: payload.role, name: payload.name }
    next()
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' })
  }
}
import { getAuthUrl as googleAuthUrl, exchangeCode as googleExchange } from '../connectors/google.js'
import { getAuthUrl as airtableAuthUrl, exchangeCode as airtableExchange, airtableFetch, getAccessToken } from '../connectors/airtable.js'
import { syncAllMailboxes } from '../services/gmail.js'
import { syncDrive } from '../services/drive.js'
import { syncAirtable, syncInventaire, syncPieces, syncOrders, syncAchats, syncBillets, syncSerials, syncEnvois, syncSoumissions, syncRetours, syncRetourItems, syncAdresses, syncBomItems, syncSerialStateChanges, syncAbonnements, syncAssemblages, syncFactures } from '../services/airtable.js'
import { tracked, getStatus } from '../services/syncState.js'

const router = Router()

// ── List connected accounts
router.get('/', requireAuth, (req, res) => {
  const tid = req.user.tenant_id
  const accounts = db.prepare(`
    SELECT id, connector, account_email, account_key, updated_at,
    CASE WHEN refresh_token IS NOT NULL THEN 1 ELSE 0 END AS connected
    FROM connector_oauth WHERE tenant_id=? ORDER BY connector, account_email
  `).all(tid)

  const config = {}
  const configRows = db.prepare('SELECT connector, key, value FROM connector_config WHERE tenant_id=?').all(tid)
  for (const r of configRows) {
    if (!config[r.connector]) config[r.connector] = {}
    config[r.connector][r.key] = r.value
  }

  const airtableSync = db.prepare('SELECT * FROM airtable_sync_config WHERE tenant_id=?').get(tid) || {}
  const inventaireSync = db.prepare('SELECT * FROM airtable_inventaire_config WHERE tenant_id=?').get(tid) || {}
  const ordersSync = db.prepare('SELECT * FROM airtable_orders_config WHERE tenant_id=?').get(tid) || {}

  const moduleConfigs = {}
  for (const mod of SIMPLE_MODULES) {
    moduleConfigs[mod] = db.prepare("SELECT * FROM airtable_module_config WHERE tenant_id=? AND module=?").get(tid, mod) || {}
  }

  res.json({ accounts, config, airtable_sync: airtableSync, inventaire_sync: inventaireSync, orders_sync: ordersSync, ...moduleConfigs })
})

// ── Google OAuth start
router.get('/google/connect', requireAuthOrQuery, (req, res) => {
  const state = Buffer.from(JSON.stringify({ tenant_id: req.user.tenant_id, user_id: req.user.id })).toString('base64url')
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
    const { tenant_id } = JSON.parse(Buffer.from(state, 'base64url').toString())
    const { tokens, email } = await googleExchange(code)

    const existing = db.prepare(`
      SELECT id FROM connector_oauth WHERE tenant_id=? AND connector='google' AND account_email=?
    `).get(tenant_id, email)

    if (existing) {
      db.prepare(`
        UPDATE connector_oauth SET access_token=?, refresh_token=COALESCE(?,refresh_token),
        expiry_date=?, updated_at=datetime('now') WHERE id=?
      `).run(tokens.access_token, tokens.refresh_token || null, tokens.expiry_date || null, existing.id)
    } else {
      db.prepare(`
        INSERT INTO connector_oauth (id, tenant_id, connector, account_key, account_email, access_token, refresh_token, expiry_date)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(uuid(), tenant_id, 'google', email, email, tokens.access_token, tokens.refresh_token || null, tokens.expiry_date || null)
    }

    res.redirect('/erp/connectors?success=google')
  } catch (e) {
    console.error('Google callback error:', e.message)
    res.redirect('/erp/connectors?error=google_failed')
  }
})

// ── Airtable OAuth start (PKCE)
router.get('/airtable/connect', requireAuthOrQuery, (req, res) => {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  const state = Buffer.from(JSON.stringify({ tenant_id: req.user.tenant_id, verifier })).toString('base64url')
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
    const { tenant_id, verifier } = JSON.parse(Buffer.from(state, 'base64url').toString())
    const tokens = await airtableExchange(code, verifier)

    const existing = db.prepare(`
      SELECT id FROM connector_oauth WHERE tenant_id=? AND connector='airtable'
    `).get(tenant_id)

    const expiry = tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : null
    if (existing) {
      db.prepare(`
        UPDATE connector_oauth SET access_token=?, refresh_token=?, expiry_date=?, updated_at=datetime('now') WHERE id=?
      `).run(tokens.access_token, tokens.refresh_token, expiry, existing.id)
    } else {
      db.prepare(`
        INSERT INTO connector_oauth (id, tenant_id, connector, account_key, access_token, refresh_token, expiry_date)
        VALUES (?,?,?,?,?,?,?)
      `).run(uuid(), tenant_id, 'airtable', 'default', tokens.access_token, tokens.refresh_token, expiry)
    }

    res.redirect('/erp/connectors?success=airtable')
  } catch (e) {
    console.error('Airtable callback error:', e.message)
    res.redirect('/erp/connectors?error=airtable_failed')
  }
})

// ── Disconnect account
router.delete('/accounts/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT * FROM connector_oauth WHERE id=? AND tenant_id=?').get(req.params.id, req.user.tenant_id)
  if (!row) return res.status(404).json({ error: 'Not found' })
  db.prepare('DELETE FROM connector_oauth WHERE id=?').run(req.params.id)
  res.json({ ok: true })
})

// ── Save connector config
router.put('/config/:connector', requireAuth, (req, res) => {
  const { connector } = req.params
  const tid = req.user.tenant_id
  for (const [key, value] of Object.entries(req.body)) {
    db.prepare(`
      INSERT INTO connector_config (tenant_id, connector, key, value) VALUES (?,?,?,?)
      ON CONFLICT(tenant_id, connector, key) DO UPDATE SET value=excluded.value
    `).run(tid, connector, key, value ?? null)
  }
  res.json({ ok: true })
})

// ── Airtable: list bases
router.get('/airtable/bases', requireAuth, async (req, res) => {
  try {
    const token = await getAccessToken(req.user.tenant_id)
    const data = await airtableFetch('/meta/bases', token)
    res.json(data.bases || [])
  } catch (e) {
    res.status(503).json({ error: e.message })
  }
})

// ── Airtable: list tables in a base
router.get('/airtable/bases/:baseId/tables', requireAuth, async (req, res) => {
  try {
    const token = await getAccessToken(req.user.tenant_id)
    const data = await airtableFetch(`/meta/bases/${req.params.baseId}/tables`, token)
    res.json(data.tables || [])
  } catch (e) {
    res.json([])
  }
})

// ── Save Airtable CRM config (alias: crm-config → sync-config table)
function saveCrmConfig(req, res) {
  const tid = req.user.tenant_id
  const { base_id, contacts_table_id, companies_table_id, field_map_contacts, field_map_companies } = req.body
  db.prepare(`
    INSERT INTO airtable_sync_config (tenant_id, base_id, contacts_table_id, companies_table_id, field_map_contacts, field_map_companies)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(tenant_id) DO UPDATE SET
      base_id=excluded.base_id, contacts_table_id=excluded.contacts_table_id,
      companies_table_id=excluded.companies_table_id, field_map_contacts=excluded.field_map_contacts,
      field_map_companies=excluded.field_map_companies
  `).run(tid, base_id || null, contacts_table_id || null, companies_table_id || null,
    field_map_contacts ? JSON.stringify(field_map_contacts) : null,
    field_map_companies ? JSON.stringify(field_map_companies) : null)
  res.json({ ok: true })
}
router.put('/airtable/sync-config', requireAuth, saveCrmConfig)
router.put('/airtable/crm-config', requireAuth, saveCrmConfig)

// ── Save Inventaire config (alias: inv-config → inventaire-config table)
function saveInvConfig(req, res) {
  const tid = req.user.tenant_id
  const { base_id, projects_table_id, field_map_projects, extra_tables } = req.body
  db.prepare(`
    INSERT INTO airtable_inventaire_config (tenant_id, base_id, projects_table_id, field_map_projects, extra_tables)
    VALUES (?,?,?,?,?)
    ON CONFLICT(tenant_id) DO UPDATE SET
      base_id=excluded.base_id, projects_table_id=excluded.projects_table_id,
      field_map_projects=excluded.field_map_projects, extra_tables=excluded.extra_tables
  `).run(tid, base_id || null, projects_table_id || null,
    field_map_projects ? JSON.stringify(field_map_projects) : null,
    extra_tables?.length ? JSON.stringify(extra_tables) : null)
  res.json({ ok: true })
}
router.put('/airtable/inventaire-config', requireAuth, saveInvConfig)
router.put('/airtable/inv-config', requireAuth, saveInvConfig)

// ── Sync status
router.get('/sync/status', requireAuth, (req, res) => {
  res.json(getStatus(req.user.tenant_id))
})

// ── Manual sync triggers
router.post('/sync/gmail', requireAuth, async (req, res) => {
  tracked(req.user.tenant_id, 'gmail', () => syncAllMailboxes(req.user.tenant_id)).catch(console.error)
  res.json({ ok: true })
})

router.post('/sync/drive', requireAuth, async (req, res) => {
  tracked(req.user.tenant_id, 'drive', () => syncDrive(req.user.tenant_id)).catch(console.error)
  res.json({ ok: true })
})

router.post('/sync/airtable', requireAuth, async (req, res) => {
  tracked(req.user.tenant_id, 'airtable', () => syncAirtable(req.user.tenant_id)).catch(console.error)
  res.json({ ok: true })
})

router.post('/sync/inventaire', requireAuth, async (req, res) => {
  tracked(req.user.tenant_id, 'inventaire', () => syncInventaire(req.user.tenant_id)).catch(console.error)
  res.json({ ok: true })
})

// ── Save generic module config (pieces, achats, billets, serials, envois)
const SIMPLE_MODULES = ['pieces', 'achats', 'billets', 'serials', 'envois', 'soumissions', 'retours', 'retour_items', 'adresses', 'bom', 'serial_changes', 'abonnements', 'assemblages', 'factures']
router.put('/airtable/module-config/:module', requireAuth, (req, res) => {
  const { module } = req.params
  if (!SIMPLE_MODULES.includes(module)) return res.status(400).json({ error: 'Module invalide' })
  const tid = req.user.tenant_id
  const { base_id, table_id, field_map } = req.body
  db.prepare(`
    INSERT INTO airtable_module_config (tenant_id, module, base_id, table_id, field_map)
    VALUES (?,?,?,?,?)
    ON CONFLICT(tenant_id, module) DO UPDATE SET
      base_id=excluded.base_id, table_id=excluded.table_id, field_map=excluded.field_map
  `).run(tid, module, base_id || null, table_id || null, field_map ? JSON.stringify(field_map) : null)
  res.json({ ok: true })
})

// ── Save Pièces config
router.put('/airtable/pieces-config', requireAuth, (req, res) => {
  const tid = req.user.tenant_id
  const { base_id, table_id, field_map } = req.body
  db.prepare(`
    INSERT INTO airtable_pieces_config (tenant_id, base_id, table_id, field_map)
    VALUES (?,?,?,?)
    ON CONFLICT(tenant_id) DO UPDATE SET
      base_id=excluded.base_id, table_id=excluded.table_id, field_map=excluded.field_map
  `).run(tid, base_id || null, table_id || null, field_map ? JSON.stringify(field_map) : null)
  res.json({ ok: true })
})

router.post('/sync/pieces', requireAuth, async (req, res) => {
  tracked(req.user.tenant_id, 'pieces', () => syncPieces(req.user.tenant_id)).catch(console.error)
  res.json({ ok: true })
})

// ── Save Orders config
router.put('/airtable/orders-config', requireAuth, (req, res) => {
  const tid = req.user.tenant_id
  const { base_id, orders_table_id, items_table_id, field_map_orders, field_map_items } = req.body
  db.prepare(`
    INSERT INTO airtable_orders_config (tenant_id, base_id, orders_table_id, items_table_id, field_map_orders, field_map_items)
    VALUES (?,?,?,?,?,?)
    ON CONFLICT(tenant_id) DO UPDATE SET
      base_id=excluded.base_id, orders_table_id=excluded.orders_table_id,
      items_table_id=excluded.items_table_id, field_map_orders=excluded.field_map_orders,
      field_map_items=excluded.field_map_items
  `).run(tid, base_id || null, orders_table_id || null, items_table_id || null,
    field_map_orders ? JSON.stringify(field_map_orders) : null,
    field_map_items ? JSON.stringify(field_map_items) : null)
  res.json({ ok: true })
})

router.post('/sync/orders', requireAuth, async (req, res) => {
  tracked(req.user.tenant_id, 'orders', () => syncOrders(req.user.tenant_id)).catch(console.error)
  res.json({ ok: true })
})

// ── Save Achats config
router.put('/airtable/achats-config', requireAuth, (req, res) => {
  const tid = req.user.tenant_id
  const { base_id, table_id, field_map } = req.body
  db.prepare(`
    INSERT INTO airtable_achats_config (tenant_id, base_id, table_id, field_map)
    VALUES (?,?,?,?)
    ON CONFLICT(tenant_id) DO UPDATE SET
      base_id=excluded.base_id, table_id=excluded.table_id, field_map=excluded.field_map
  `).run(tid, base_id || null, table_id || null, field_map ? JSON.stringify(field_map) : null)
  res.json({ ok: true })
})

router.post('/sync/achats', requireAuth, async (req, res) => {
  tracked(req.user.tenant_id, 'achats', () => syncAchats(req.user.tenant_id)).catch(console.error)
  res.json({ ok: true })
})

// ── Save Billets config
router.put('/airtable/billets-config', requireAuth, (req, res) => {
  const tid = req.user.tenant_id
  const { base_id, table_id, field_map } = req.body
  db.prepare(`
    INSERT INTO airtable_billets_config (tenant_id, base_id, table_id, field_map)
    VALUES (?,?,?,?)
    ON CONFLICT(tenant_id) DO UPDATE SET
      base_id=excluded.base_id, table_id=excluded.table_id, field_map=excluded.field_map
  `).run(tid, base_id || null, table_id || null, field_map ? JSON.stringify(field_map) : null)
  res.json({ ok: true })
})

router.post('/sync/billets', requireAuth, async (req, res) => {
  tracked(req.user.tenant_id, 'billets', () => syncBillets(req.user.tenant_id)).catch(console.error)
  res.json({ ok: true })
})

// ── Save Serials config
router.put('/airtable/serials-config', requireAuth, (req, res) => {
  const tid = req.user.tenant_id
  const { base_id, table_id, field_map } = req.body
  db.prepare(`
    INSERT INTO airtable_serials_config (tenant_id, base_id, table_id, field_map)
    VALUES (?,?,?,?)
    ON CONFLICT(tenant_id) DO UPDATE SET
      base_id=excluded.base_id, table_id=excluded.table_id, field_map=excluded.field_map
  `).run(tid, base_id || null, table_id || null, field_map ? JSON.stringify(field_map) : null)
  res.json({ ok: true })
})

router.post('/sync/serials', requireAuth, async (req, res) => {
  tracked(req.user.tenant_id, 'serials', () => syncSerials(req.user.tenant_id)).catch(console.error)
  res.json({ ok: true })
})

// ── Save Envois config
router.put('/airtable/envois-config', requireAuth, (req, res) => {
  const tid = req.user.tenant_id
  const { base_id, table_id, field_map } = req.body
  db.prepare(`
    INSERT INTO airtable_envois_config (tenant_id, base_id, table_id, field_map)
    VALUES (?,?,?,?)
    ON CONFLICT(tenant_id) DO UPDATE SET
      base_id=excluded.base_id, table_id=excluded.table_id, field_map=excluded.field_map
  `).run(tid, base_id || null, table_id || null, field_map ? JSON.stringify(field_map) : null)
  res.json({ ok: true })
})

router.post('/sync/envois', requireAuth, async (req, res) => {
  tracked(req.user.tenant_id, 'envois', () => syncEnvois(req.user.tenant_id)).catch(console.error)
  res.json({ ok: true })
})
router.post('/sync/soumissions', requireAuth, async (req, res) => {
  tracked(req.user.tenant_id, 'soumissions', () => syncSoumissions(req.user.tenant_id)).catch(console.error)
  res.json({ ok: true })
})
router.post('/sync/retours', requireAuth, async (req, res) => {
  tracked(req.user.tenant_id, 'retours', () => syncRetours(req.user.tenant_id)).catch(console.error)
  res.json({ ok: true })
})
router.post('/sync/retour_items', requireAuth, async (req, res) => {
  tracked(req.user.tenant_id, 'retour_items', () => syncRetourItems(req.user.tenant_id)).catch(console.error)
  res.json({ ok: true })
})
router.post('/sync/adresses', requireAuth, async (req, res) => {
  tracked(req.user.tenant_id, 'adresses', () => syncAdresses(req.user.tenant_id)).catch(console.error)
  res.json({ ok: true })
})
router.post('/sync/bom', requireAuth, async (req, res) => {
  tracked(req.user.tenant_id, 'bom', () => syncBomItems(req.user.tenant_id)).catch(console.error)
  res.json({ ok: true })
})
router.post('/sync/serial_changes', requireAuth, async (req, res) => {
  tracked(req.user.tenant_id, 'serial_changes', () => syncSerialStateChanges(req.user.tenant_id)).catch(console.error)
  res.json({ ok: true })
})
router.post('/sync/abonnements', requireAuth, async (req, res) => {
  tracked(req.user.tenant_id, 'abonnements', () => syncAbonnements(req.user.tenant_id)).catch(console.error)
  res.json({ ok: true })
})
router.post('/sync/assemblages', requireAuth, async (req, res) => {
  tracked(req.user.tenant_id, 'assemblages', () => syncAssemblages(req.user.tenant_id)).catch(console.error)
  res.json({ ok: true })
})
router.post('/sync/factures', requireAuth, async (req, res) => {
  tracked(req.user.tenant_id, 'factures', () => syncFactures(req.user.tenant_id)).catch(console.error)
  res.json({ ok: true })
})

router.post('/sync/airtable-all', requireAuth, async (req, res) => {
  const tid = req.user.tenant_id
  const ALL_AIRTABLE_MODULES = [
    ['airtable',      syncAirtable],
    ['inventaire',    syncInventaire],
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
    ['abonnements',   syncAbonnements],
    ['assemblages',   syncAssemblages],
    ['factures',      syncFactures],
  ]
  ALL_AIRTABLE_MODULES.forEach(([key, fn]) => {
    tracked(tid, key, () => fn(tid)).catch(console.error)
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
    WHERE i.tenant_id=? GROUP BY transcription_status`).all(req.user.tenant_id)
  const retranscribable = db.prepare(`SELECT COUNT(*) as total FROM calls
    JOIN interactions i ON calls.interaction_id = i.id
    WHERE i.tenant_id=? AND recording_path IS NOT NULL AND transcription_status IN ('pending','error')`).get(req.user.tenant_id)
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
    WHERE i.tenant_id=? AND ca.drive_file_id IS NOT NULL AND ca.recording_path IS NOT NULL
  `).all(req.user.tenant_id)

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

  const oauthRow = db.prepare(`SELECT id FROM connector_oauth WHERE tenant_id=? AND connector='google' ORDER BY updated_at DESC LIMIT 1`).get(req.user.tenant_id)
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
    WHERE i.tenant_id=? AND ca.drive_file_id IS NOT NULL AND ca.recording_path IS NOT NULL
  `).all(req.user.tenant_id).filter(c => !existsSync(join(uploadsDir, c.recording_path)))

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
    WHERE i.tenant_id=? AND recording_path IS NOT NULL AND transcription_status IN ('pending','error')
  `).all(req.user.tenant_id)

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
  const erpUsers = db.prepare(`SELECT id, name, ftp_username FROM users WHERE tenant_id=? AND active=1 ORDER BY name`).all(req.user.tenant_id)

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
  const erpUser = db.prepare(`SELECT id, ftp_username FROM users WHERE id=? AND tenant_id=?`).get(erpUserId, req.user.tenant_id)
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

  db.prepare(`UPDATE users SET ftp_username=NULL WHERE ftp_username=? AND tenant_id=?`).run(erpFtpUsername, req.user.tenant_id)

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
router.post('/deduplicate-ftp-calls', (req, res) => {
  const tenantId = req.user.tenant_id
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
    AND i.tenant_id = ?
  `).all(tenantId)

  // Appels Drive avec fichier audio
  const driveCalls = db.prepare(`
    SELECT c.id as call_id, c.recording_path, c.callee_number, c.caller_number,
           c.duration_seconds, c.drive_filename, c.drive_file_id,
           i.id as interaction_id, i.timestamp
    FROM calls c JOIN interactions i ON i.id = c.interaction_id
    WHERE c.drive_filename IS NOT NULL AND c.recording_path IS NOT NULL
    AND i.tenant_id = ?
  `).all(tenantId)

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
router.post('/fix-ftp-timestamps', async (req, res) => {
  const tenantId = req.user.tenant_id

  // Récupère les dossiers Drive configurés
  let folders = []
  const foldersRow = db.prepare(`SELECT value FROM connector_config WHERE tenant_id=? AND connector='google' AND key='drive_folders'`).get(tenantId)
  if (foldersRow?.value) { try { folders = JSON.parse(foldersRow.value) } catch {} }
  if (folders.length === 0) {
    const fRow = db.prepare(`SELECT value FROM connector_config WHERE tenant_id=? AND connector='google' AND key='drive_folder_id'`).get(tenantId)
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
    AND i.tenant_id = ?
  `).all(tenantId)

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
        WHERE co.tenant_id=? AND co.connector='google'
        ORDER BY co.updated_at DESC LIMIT 1
      `).get(tenantId)
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

export default router
