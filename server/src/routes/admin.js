import { Router } from 'express';
import bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/database.js';
import { requireAdmin } from '../middleware/auth.js';
import { readFileSync, statSync, existsSync } from 'fs';
import { execSync } from 'child_process';
import os from 'os';

const router = Router();
router.use(requireAdmin);

// GET /api/admin/users
router.get('/users', (req, res) => {
  const users = db.prepare(`
    SELECT u.id, u.email, u.name, u.role, u.active, u.created_at, u.employee_id,
           TRIM(COALESCE(e.first_name,'') || ' ' || COALESCE(e.last_name,'')) as employee_name
    FROM users u
    LEFT JOIN employees e ON u.employee_id = e.id
    ORDER BY u.name
  `).all();
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

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase().trim());
  if (existing) {
    return res.status(409).json({ error: 'Email already in use' });
  }

  const id = uuidv4();
  const passwordHash = await bcrypt.hash(password, 10);
  db.prepare(
    'INSERT INTO users (id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)'
  ).run(id, email.toLowerCase().trim(), passwordHash, name, role);

  res.status(201).json(db.prepare('SELECT id, email, name, role, active, created_at FROM users WHERE id = ?').get(id));
});

// PUT /api/admin/users/:id
router.put('/users/:id', async (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { name, email, role, active, password, employee_id } = req.body;
  const validRoles = ['admin', 'sales', 'support', 'ops'];
  if (role && !validRoles.includes(role)) {
    return res.status(400).json({ error: 'Invalid role' });
  }

  if (email) {
    const conflict = db.prepare('SELECT id FROM users WHERE email = ? AND id != ?').get(email.toLowerCase().trim(), req.params.id);
    if (conflict) return res.status(409).json({ error: 'Ce courriel est déjà utilisé' });
  }

  if (employee_id) {
    const exists = db.prepare('SELECT id FROM employees WHERE id = ?').get(employee_id);
    if (!exists) return res.status(400).json({ error: 'Employé introuvable' });
    const claimed = db.prepare('SELECT id FROM users WHERE employee_id = ? AND id != ?').get(employee_id, req.params.id);
    if (claimed) return res.status(409).json({ error: 'Cet employé est déjà lié à un autre utilisateur' });
  }

  if (password) {
    const hash = await bcrypt.hash(password, 10);
    db.prepare('UPDATE users SET password_hash=? WHERE id = ?').run(hash, req.params.id);
  }

  const current = db.prepare('SELECT name, email, role, employee_id FROM users WHERE id = ?').get(req.params.id);
  db.prepare('UPDATE users SET name=?, email=?, role=?, active=?, employee_id=? WHERE id = ?')
    .run(
      name ?? current.name,
      email ? email.toLowerCase().trim() : current.email,
      role ?? current.role,
      active !== undefined ? (active ? 1 : 0) : 1,
      employee_id !== undefined ? (employee_id || null) : current.employee_id,
      req.params.id,
    );

  res.json(db.prepare('SELECT id, email, name, role, active, employee_id, created_at FROM users WHERE id = ?').get(req.params.id));
});

// POST /api/admin/users/:id/reset-password
router.post('/users/:id/reset-password', async (req, res) => {
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
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
  const user = db.prepare('SELECT id FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  db.prepare('UPDATE users SET active=0 WHERE id = ?').run(req.params.id);
  res.json({ message: 'User deactivated' });
});

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



// GET /api/admin/trash — enregistrements supprimés de toutes les tables
router.get('/trash', (req, res) => {
  const trash = {}

  const tables = [
    { key: 'companies',     label: 'Entreprises',     sql: `SELECT id, name as label, deleted_at FROM companies WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC` },
    { key: 'contacts',      label: 'Contacts',        sql: `SELECT id, (first_name || ' ' || last_name) as label, deleted_at FROM contacts WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC` },
    { key: 'orders',        label: 'Commandes',       sql: `SELECT id, ('Commande #' || order_number) as label, deleted_at FROM orders WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC` },
    { key: 'products',      label: 'Produits',        sql: `SELECT id, COALESCE(name_fr, name_en, sku) as label, deleted_at FROM products WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC` },
    { key: 'shipments',     label: 'Envois',          sql: `SELECT s.id, COALESCE('Envoi #' || o.order_number, s.tracking_number, s.id) as label, s.deleted_at FROM shipments s LEFT JOIN orders o ON s.order_id=o.id WHERE s.deleted_at IS NOT NULL ORDER BY s.deleted_at DESC` },
    { key: 'returns',       label: 'Retours',         sql: `SELECT id, COALESCE(return_number, id) as label, deleted_at FROM returns WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC` },
    { key: 'projects',      label: 'Projets',         sql: `SELECT id, name as label, deleted_at FROM projects WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC` },
    { key: 'assemblages',   label: 'Assemblages',     sql: `SELECT id, COALESCE(name, id) as label, deleted_at FROM assemblages WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC` },
    { key: 'tasks',         label: 'Tâches',          sql: `SELECT id, title as label, deleted_at FROM tasks WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC` },
    { key: 'interactions',  label: 'Interactions',    sql: `SELECT i.id, COALESCE(e.subject, i.type) as label, i.deleted_at FROM interactions i LEFT JOIN emails e ON e.interaction_id=i.id WHERE i.deleted_at IS NOT NULL ORDER BY i.deleted_at DESC` },
    { key: 'serial_numbers',label: 'Numéros de série',sql: `SELECT id, serial as label, deleted_at FROM serial_numbers WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC` },
  ]

  for (const t of tables) {
    try { trash[t.key] = { label: t.label, items: db.prepare(t.sql).all() } }
    catch { trash[t.key] = { label: t.label, items: [] } }
  }

  res.json(trash)
})

// POST /api/admin/trash/:table/:id/restore
router.post('/trash/:table/:id/restore', (req, res) => {
  const allowed = ['companies','contacts','orders','products','shipments','returns','projects','assemblages','tasks','interactions','serial_numbers']
  if (!allowed.includes(req.params.table)) return res.status(400).json({ error: 'Table invalide' })

  const result = db.prepare(`UPDATE ${req.params.table} SET deleted_at = NULL WHERE id = ?`).run(req.params.id)
  if (result.changes === 0) return res.status(404).json({ error: 'Enregistrement introuvable' })
  res.json({ ok: true })
})

// DELETE /api/admin/trash — purge définitive de tous les enregistrements supprimés
router.delete('/trash', (req, res) => {
  const tables = ['companies','contacts','orders','products','shipments','returns','projects','assemblages','tasks','interactions','serial_numbers']
  let total = 0
  for (const t of tables) {
    try { total += db.prepare(`DELETE FROM ${t} WHERE deleted_at IS NOT NULL`).run().changes } catch {}
  }
  res.json({ purged: total })
})

export default router;
