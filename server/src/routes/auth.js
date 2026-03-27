import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import dotenv from 'dotenv';

dotenv.config();

const router = Router();
const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';

function generateToken(user) {
  return jwt.sign(
    { id: user.id, tenant_id: user.tenant_id, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password required' });
  }

  const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email.toLowerCase().trim());
  if (!user) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  const tenant = db.prepare('SELECT * FROM tenants WHERE id = ?').get(user.tenant_id);
  const token = generateToken(user);

  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      tenant_id: user.tenant_id,
      tenant_name: tenant?.name,
    },
  });
});

// POST /api/auth/setup — first-run setup
router.post('/setup', async (req, res) => {
  const count = db.prepare('SELECT COUNT(*) as c FROM tenants').get();
  if (count.c > 0) {
    return res.status(403).json({ error: 'Setup already completed' });
  }

  const { company_name, admin_name, email, password } = req.body;
  if (!company_name || !admin_name || !email || !password) {
    return res.status(400).json({ error: 'All fields required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const tenantId = uuidv4();
  const userId = uuidv4();
  const slug = company_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const passwordHash = await bcrypt.hash(password, 10);

  const createTenant = db.prepare('INSERT INTO tenants (id, name, slug) VALUES (?, ?, ?)');
  const createUser = db.prepare(
    'INSERT INTO users (id, tenant_id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?, ?)'
  );

  const run = db.transaction(() => {
    createTenant.run(tenantId, company_name, slug);
    createUser.run(userId, tenantId, email.toLowerCase().trim(), passwordHash, admin_name, 'admin');
  });
  run();

  res.status(201).json({ message: 'Setup complete. You can now log in.' });
});

// GET /api/auth/users — liste des utilisateurs actifs du tenant (accessible à tous)
router.get('/users', requireAuth, (req, res) => {
  const users = db.prepare(
    'SELECT id, name, role FROM users WHERE tenant_id = ? AND active = 1 ORDER BY name'
  ).all(req.user.tenant_id);
  res.json(users);
});

// POST /api/auth/change-password
router.post('/change-password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password) {
    return res.status(400).json({ error: 'current_password et new_password requis' });
  }
  if (new_password.length < 8) {
    return res.status(400).json({ error: 'Le nouveau mot de passe doit contenir au moins 8 caractères' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'Utilisateur introuvable' });
  const valid = await bcrypt.compare(current_password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Mot de passe actuel incorrect' });
  const hash = await bcrypt.hash(new_password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.user.id);
  res.json({ ok: true });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, email, name, role, tenant_id, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  const tenant = db.prepare('SELECT name, slug FROM tenants WHERE id = ?').get(user.tenant_id);
  res.json({ ...user, tenant_name: tenant?.name, tenant_slug: tenant?.slug });
});

export default router;
