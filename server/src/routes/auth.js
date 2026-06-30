import { Router } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import db from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { JWT_SECRET } from '../config/secrets.js';

const router = Router();

function generateToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, name: user.name },
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

  const token = generateToken(user);

  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    },
  });
});

// POST /api/auth/setup — first-run setup
router.post('/setup', async (req, res) => {
  const count = db.prepare('SELECT COUNT(*) as c FROM users').get();
  if (count.c > 0) {
    return res.status(403).json({ error: 'Setup already completed' });
  }

  const { admin_name, email, password } = req.body;
  if (!admin_name || !email || !password) {
    return res.status(400).json({ error: 'All fields required' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  const userId = uuidv4();
  const passwordHash = await bcrypt.hash(password, 10);

  db.prepare('INSERT INTO users (id, email, password_hash, name, role) VALUES (?, ?, ?, ?, ?)')
    .run(userId, email.toLowerCase().trim(), passwordHash, admin_name, 'admin');

  res.status(201).json({ message: 'Setup complete. You can now log in.' });
});

// GET /api/auth/users — liste des utilisateurs actifs du tenant (accessible à tous)
router.get('/users', requireAuth, (req, res) => {
  const users = db.prepare(
    'SELECT id, name, role FROM users WHERE active = 1 ORDER BY name'
  ).all();
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
  const user = db.prepare('SELECT id, email, name, role, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json(user);
});

function readNavHidden(userId) {
  const row = db.prepare('SELECT nav_hidden FROM users WHERE id = ?').get(userId);
  let navHidden = [];
  try { navHidden = JSON.parse(row?.nav_hidden || '[]'); } catch { navHidden = []; }
  return Array.isArray(navHidden) ? navHidden : [];
}

function readDecimalPreferences(userId) {
  const row = db.prepare('SELECT decimal_preferences FROM users WHERE id = ?').get(userId);
  let prefs = {};
  try { prefs = JSON.parse(row?.decimal_preferences || '{}'); } catch { prefs = {}; }
  return prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? prefs : {};
}

// Valide un objet { "<table>::<field>": <0-5> }. Les entrées invalides sont
// rejetées (réponse 400) plutôt que silencieusement ignorées.
function validDecimalPreferences(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return false;
  return Object.entries(obj).every(([k, v]) => (
    typeof k === 'string' && k.length > 0 && k.length <= 120
    && Number.isInteger(v) && v >= 0 && v <= 5
  ));
}

// GET /api/auth/preferences — préférences UI de l'utilisateur courant
router.get('/preferences', requireAuth, (req, res) => {
  res.json({
    nav_hidden: readNavHidden(req.user.id),
    decimal_preferences: readDecimalPreferences(req.user.id),
  });
});

// PATCH /api/auth/preferences — maj des préférences UI (menu de gauche, décimales, etc.)
router.patch('/preferences', requireAuth, (req, res) => {
  const { nav_hidden, decimal_preferences } = req.body || {};
  if (nav_hidden !== undefined) {
    if (!Array.isArray(nav_hidden) || !nav_hidden.every((k) => typeof k === 'string')) {
      return res.status(400).json({ error: 'nav_hidden doit être un tableau de chaînes' });
    }
    db.prepare('UPDATE users SET nav_hidden = ? WHERE id = ?').run(JSON.stringify(nav_hidden), req.user.id);
  }
  if (decimal_preferences !== undefined) {
    if (!validDecimalPreferences(decimal_preferences)) {
      return res.status(400).json({ error: 'decimal_preferences doit être un objet { "table::field": entier 0-5 }' });
    }
    db.prepare('UPDATE users SET decimal_preferences = ? WHERE id = ?').run(JSON.stringify(decimal_preferences), req.user.id);
  }
  res.json({
    nav_hidden: readNavHidden(req.user.id),
    decimal_preferences: readDecimalPreferences(req.user.id),
  });
});

export default router;
