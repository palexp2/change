import { Router } from 'express';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/database.js';
import { requireAdmin } from '../middleware/auth.js';
import { readFileSync, statSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import os from 'os';
import { migrateLegacyTables } from '../services/migrateLegacy.js';

const router = Router();
router.use(requireAdmin);

// GET /api/admin/users
router.get('/users', (req, res) => {
  const users = db.prepare(
    'SELECT id, email, name, role, active, created_at FROM users WHERE tenant_id = ? ORDER BY name'
  ).all(req.user.tenant_id);
  res.json(users);
});

// POST /api/admin/users
router.post('/users', async (req, res) => {
  const { email, name, password, role } = req.body;
  if (!email || !name || !password || !role) {
    return res.status(400).json({ error: 'email, name, password, role are required' });
  }
  const validRoles = ['admin', 'sales', 'support', 'ops'];
  if (!validRoles.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  const existing = db.prepare('SELECT id FROM users WHERE email = ? AND tenant_id = ?').get(email.toLowerCase().trim(), req.user.tenant_id);
  if (existing) {
    return res.status(409).json({ error: 'Email already in use' });
  }

  const id = uuidv4();
  const passwordHash = await bcrypt.hash(password, 10);
  db.prepare(
    'INSERT INTO users (id, tenant_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(id, req.user.tenant_id, email.toLowerCase().trim(), passwordHash, name, role);

  res.status(201).json(db.prepare('SELECT id, email, name, role, active, created_at FROM users WHERE id = ?').get(id));
});

// PUT /api/admin/users/:id
router.put('/users/:id', async (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { name, email, role, active, password } = req.body;
  const validRoles = ['admin', 'sales', 'support', 'ops'];
  if (role && !validRoles.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  if (email) {
    const conflict = db.prepare('SELECT id FROM users WHERE email = ? AND tenant_id = ? AND id != ?').get(email.toLowerCase().trim(), req.user.tenant_id, req.params.id);
    if (conflict) return res.status(409).json({ error: 'Ce courriel est déjà utilisé' });
  }

  if (password) {
    const hash = await bcrypt.hash(password, 10);
    db.prepare('UPDATE users SET password_hash=? WHERE id = ?').run(hash, req.params.id);
  }

  const current = db.prepare('SELECT name, email, role FROM users WHERE id = ?').get(req.params.id);
  db.prepare('UPDATE users SET name=?, email=?, role=?, active=? WHERE id = ? AND tenant_id = ?')
    .run(name ?? current.name, email ? email.toLowerCase().trim() : current.email, role ?? current.role, active !== undefined ? (active ? 1 : 0) : 1, req.params.id, req.user.tenant_id);

  res.json(db.prepare('SELECT id, email, name, role, active, created_at FROM users WHERE id = ?').get(req.params.id));
});

// POST /api/admin/users/:id/reset-password
router.post('/users/:id/reset-password', async (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const { password } = req.body;
  if (!password || password.length < 8) return res.status(400).json({ error: 'Minimum 8 caractères' });
  const hash = await bcrypt.hash(password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.params.id);
  res.json({ ok: true });
});

// DELETE /api/admin/users/:id
router.delete('/users/:id', (req, res) => {
  // Can't delete yourself
  if (req.params.id === req.user.id) {
    return res.status(400).json({ error: 'Cannot delete your own account' });
  }
  const user = db.prepare('SELECT id FROM users WHERE id = ? AND tenant_id = ?').get(req.params.id, req.user.tenant_id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET active=0 WHERE id = ? AND tenant_id = ?').run(req.params.id, req.user.tenant_id);
  res.json({ message: 'User deactivated' });
});

// ─── Field Definitions ────────────────────────────────────────────────────────

function parseField(f) {
  return {
    ...f,
    options: f.options ? JSON.parse(f.options) : [],
    airtable_value_map: f.airtable_value_map ? JSON.parse(f.airtable_value_map) : {},
    is_system: !!f.is_system,
    required: !!f.required,
  };
}

// GET /api/admin/field-defs?entity_type=tickets
router.get('/field-defs', (req, res) => {
  const { entity_type } = req.query;
  const tid = req.user.tenant_id;
  const rows = entity_type
    ? db.prepare('SELECT * FROM custom_field_defs WHERE tenant_id=? AND entity_type=? ORDER BY sort_order, created_at').all(tid, entity_type)
    : db.prepare('SELECT * FROM custom_field_defs WHERE tenant_id=? ORDER BY entity_type, sort_order, created_at').all(tid);
  res.json(rows.map(parseField));
});

// POST /api/admin/field-defs — create custom field (not system)
router.post('/field-defs', (req, res) => {
  const { entity_type, key, label, field_type, options, required } = req.body;
  if (!entity_type || !key || !label || !field_type) {
    return res.status(400).json({ error: 'entity_type, key, label, field_type sont requis' });
  }
  const cleanKey = key.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const id = uuidv4();
  const maxSort = db.prepare('SELECT MAX(sort_order) as m FROM custom_field_defs WHERE tenant_id=? AND entity_type=?').get(req.user.tenant_id, entity_type);
  try {
    db.prepare(`
      INSERT INTO custom_field_defs (id, tenant_id, entity_type, key, label, field_type, options, is_system, required, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(id, req.user.tenant_id, entity_type, cleanKey, label, field_type,
      options ? JSON.stringify(options) : null,
      required ? 1 : 0,
      (maxSort?.m ?? -1) + 1);
    res.status(201).json(parseField(db.prepare('SELECT * FROM custom_field_defs WHERE id=?').get(id)));
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(409).json({ error: 'Cette clé existe déjà pour ce type d\'entité' });
    throw e;
  }
});

// PATCH /api/admin/field-defs/:id — update label, options, airtable mapping, sort_order
router.patch('/field-defs/:id', (req, res) => {
  const field = db.prepare('SELECT * FROM custom_field_defs WHERE id=? AND tenant_id=?').get(req.params.id, req.user.tenant_id);
  if (!field) return res.status(404).json({ error: 'Champ introuvable' });

  const { label, options, airtable_field_id, airtable_value_map, sort_order, required } = req.body;
  db.prepare(`
    UPDATE custom_field_defs SET
      label = COALESCE(?, label),
      options = ?,
      airtable_field_id = ?,
      airtable_value_map = ?,
      sort_order = COALESCE(?, sort_order),
      required = COALESCE(?, required),
      updated_at = datetime('now')
    WHERE id = ? AND tenant_id = ?
  `).run(
    label || null,
    options !== undefined ? JSON.stringify(options) : field.options,
    airtable_field_id !== undefined ? airtable_field_id : field.airtable_field_id,
    airtable_value_map !== undefined ? JSON.stringify(airtable_value_map) : field.airtable_value_map,
    sort_order ?? null,
    required !== undefined ? (required ? 1 : 0) : null,
    req.params.id, req.user.tenant_id
  );
  res.json(parseField(db.prepare('SELECT * FROM custom_field_defs WHERE id=?').get(req.params.id)));
});

// DELETE /api/admin/field-defs/:id — only custom fields
router.delete('/field-defs/:id', (req, res) => {
  const field = db.prepare('SELECT * FROM custom_field_defs WHERE id=? AND tenant_id=?').get(req.params.id, req.user.tenant_id);
  if (!field) return res.status(404).json({ error: 'Champ introuvable' });
  if (field.is_system) return res.status(400).json({ error: 'Les champs système ne peuvent pas être supprimés' });
  db.prepare('DELETE FROM custom_field_defs WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Legacy alias — keep for backward compat
router.get('/custom-fields', (req, res) => res.redirect(307, `/api/admin/field-defs${req.query.entity_type ? '?entity_type=' + req.query.entity_type : ''}`));

// GET /api/admin/health
router.get('/health', (req, res) => {
  // ── Disque ────────────────────────────────────────────────────────────────
  let disk = null
  try {
    const out = execSync("df -k / | tail -1").toString().trim().split(/\s+/)
    disk = { total: parseInt(out[1]) * 1024, used: parseInt(out[2]) * 1024, available: parseInt(out[3]) * 1024 }
  } catch {}

  // ── RAM ───────────────────────────────────────────────────────────────────
  const totalMem = os.totalmem()
  const freeMem  = os.freemem()
  const ram = { total: totalMem, used: totalMem - freeMem, free: freeMem }

  // ── CPU ───────────────────────────────────────────────────────────────────
  const load = os.loadavg()
  const cpu = { load1: load[0], load5: load[1], load15: load[2], cores: os.cpus().length }

  // ── Uptime ────────────────────────────────────────────────────────────────
  const uptime = os.uptime()

  // ── PM2 processes ─────────────────────────────────────────────────────────
  let processes = []
  try {
    const raw = execSync('pm2 jlist 2>/dev/null').toString()
    const list = JSON.parse(raw)
    processes = list.map(p => ({
      name: p.name,
      status: p.pm2_env.status,
      uptime: p.pm2_env.pm_uptime,
      restarts: p.pm2_env.restart_time,
      memory: p.monit?.memory || 0,
      cpu: p.monit?.cpu || 0,
      pid: p.pid,
    }))
  } catch {}

  // ── SQLite DB size ────────────────────────────────────────────────────────
  let dbSize = null
  try {
    const dbPath = process.env.DATABASE_PATH || './data/erp.db'
    dbSize = statSync(dbPath).size
  } catch {}

  // ── Répartition espace disque ─────────────────────────────────────────────
  function duBytes(p) {
    try {
      const out = execSync(`du -sb "${p}" 2>/dev/null`).toString().trim()
      return parseInt(out.split('\t')[0]) || 0
    } catch { return 0 }
  }
  const home = os.homedir()
  const diskBreakdown = [
    { label: 'Enregistrements d\'appels', bytes: duBytes(`${home}/erp/server/uploads/calls`) },
    { label: 'Photos produits',           bytes: duBytes(`${home}/erp/server/uploads/products`) },
    { label: 'Base de données',           bytes: duBytes(`${home}/erp/server/data`) },
    { label: 'Dépendances Node',          bytes: duBytes(`${home}/erp/server/node_modules`) },
    { label: 'Logs PM2',                  bytes: duBytes(`${home}/.pm2/logs`) },
    { label: 'FTP uploads',               bytes: duBytes(`${home}/ftp-server/uploads`) },
  ]
  if (disk) {
    const accounted = diskBreakdown.reduce((s, c) => s + c.bytes, 0)
    diskBreakdown.push({ label: 'Autres / Système', bytes: Math.max(0, disk.used - accounted) })
  }

  // ── Whisper queue ─────────────────────────────────────────────────────────
  const whisper = db.prepare(`
    SELECT transcription_status, COUNT(*) as total FROM calls GROUP BY transcription_status
  `).all().reduce((acc, r) => { acc[r.transcription_status] = r.total; return acc }, {})

  // ── Dernières erreurs ERP ─────────────────────────────────────────────────
  let recentErrors = []
  try {
    const logPath = process.env.PM2_ERROR_LOG || `${os.homedir()}/.pm2/logs/erp-server-error.log`
    if (existsSync(logPath)) {
      const lines = readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean)
      recentErrors = lines.slice(-8).reverse()
    }
  } catch {}

  res.json({ disk, ram, cpu, uptime, processes, dbSize, whisper, recentErrors, diskBreakdown })
})

// POST /api/admin/migrate-legacy
router.post('/migrate-legacy', (req, res) => {
  try {
    const results = migrateLegacyTables(req.user.tenant_id)
    res.json({ ok: true, results })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

export default router;
