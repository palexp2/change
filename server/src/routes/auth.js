import { Router } from 'express';
import { newRecordId } from '../utils/recordId.js';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import db from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { JWT_SECRET } from '../config/secrets.js';

const router = Router();

// Durée de vie volontairement très longue (10 ans) : app single-tenant interne,
// pas de mécanisme de refresh token, et les déconnexions au bout de 7 jours
// étaient vécues comme un bug. Le rôle n'est pas figé pour autant — requireAuth
// le relit en DB à chaque requête, et désactiver un compte le coupe côté login.
function generateToken(user) {
  return jwt.sign(
    { id: user.id, role: user.role, name: user.name },
    JWT_SECRET,
    { expiresIn: '10y' }
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

  const userId = newRecordId();
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

// Ordre personnalisé du menu : { "<conteneur>": ["<clé>", …] }.
function readNavOrder(userId) {
  const row = db.prepare('SELECT nav_order FROM users WHERE id = ?').get(userId);
  let order = {};
  try { order = JSON.parse(row?.nav_order || '{}'); } catch { order = {}; }
  return order && typeof order === 'object' && !Array.isArray(order) ? order : {};
}

function validNavOrder(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return false;
  return Object.entries(obj).every(([k, v]) => (
    typeof k === 'string' && k.length > 0 && k.length <= 120
    && Array.isArray(v) && v.length <= 200
    && v.every((key) => typeof key === 'string' && key.length > 0 && key.length <= 200)
  ));
}

// Signets du menu de gauche : liste ordonnée de { to, label } (cf. migration 018).
function readNavBookmarks(userId) {
  const row = db.prepare('SELECT nav_bookmarks FROM users WHERE id = ?').get(userId);
  let list = [];
  try { list = JSON.parse(row?.nav_bookmarks || '[]'); } catch { list = []; }
  if (!Array.isArray(list)) return [];
  return list
    .filter((b) => b && typeof b.to === 'string')
    .map((b) => ({ to: b.to, label: typeof b.label === 'string' ? b.label : b.to }));
}

function validNavBookmarks(list) {
  if (!Array.isArray(list) || list.length > 50) return false;
  return list.every((b) => (
    b && typeof b === 'object' && !Array.isArray(b)
    && typeof b.to === 'string' && b.to.startsWith('/') && b.to.length <= 300
    && (b.label === undefined || (typeof b.label === 'string' && b.label.length <= 120))
  ));
}

function readDecimalPreferences(userId) {
  const row = db.prepare('SELECT decimal_preferences FROM users WHERE id = ?').get(userId);
  let prefs = {};
  try { prefs = JSON.parse(row?.decimal_preferences || '{}'); } catch { prefs = {}; }
  return prefs && typeof prefs === 'object' && !Array.isArray(prefs) ? prefs : {};
}

// Valide un objet { "<table>::<field>": <0-5> }. Les entrées invalides sont
// rejetées (réponse 400) plutôt que silencieusement ignorées.
function readPeekWidth(userId) {
  const row = db.prepare('SELECT peek_width FROM users WHERE id = ?').get(userId);
  const w = row?.peek_width;
  return Number.isInteger(w) && w > 0 ? w : null;
}

// Largeurs du side-peek par ressource : { "orders": 1100, "contacts": 560 }.
// `peek_width` (scalaire, historique) reste le repli pour les ressources sans
// entrée — voir migration 013.
function readPeekWidths(userId) {
  const row = db.prepare('SELECT peek_widths FROM users WHERE id = ?').get(userId);
  let widths = {};
  try { widths = JSON.parse(row?.peek_widths || '{}'); } catch { widths = {}; }
  if (!widths || typeof widths !== 'object' || Array.isArray(widths)) return {};
  const out = {};
  for (const [k, v] of Object.entries(widths)) {
    if (Number.isInteger(v) && v >= 320 && v <= 2000) out[k] = v;
  }
  return out;
}

function validPeekWidths(obj) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return false;
  const entries = Object.entries(obj);
  if (entries.length > 100) return false;
  return entries.every(([k, v]) => (
    typeof k === 'string' && k.length > 0 && k.length <= 64
    && Number.isInteger(v) && v >= 320 && v <= 2000
  ));
}

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
    nav_order: readNavOrder(req.user.id),
    nav_bookmarks: readNavBookmarks(req.user.id),
    decimal_preferences: readDecimalPreferences(req.user.id),
    peek_width: readPeekWidth(req.user.id),
    peek_widths: readPeekWidths(req.user.id),
  });
});

// PATCH /api/auth/preferences — maj des préférences UI (menu de gauche, décimales, largeur side-peek, etc.)
router.patch('/preferences', requireAuth, (req, res) => {
  const { nav_hidden, nav_order, nav_bookmarks, decimal_preferences, peek_width, peek_widths } = req.body || {};
  if (nav_hidden !== undefined) {
    if (!Array.isArray(nav_hidden) || !nav_hidden.every((k) => typeof k === 'string')) {
      return res.status(400).json({ error: 'nav_hidden doit être un tableau de chaînes' });
    }
    db.prepare('UPDATE users SET nav_hidden = ? WHERE id = ?').run(JSON.stringify(nav_hidden), req.user.id);
  }
  if (nav_order !== undefined) {
    if (!validNavOrder(nav_order)) {
      return res.status(400).json({ error: 'nav_order doit être un objet { "conteneur": ["clé", …] }' });
    }
    db.prepare('UPDATE users SET nav_order = ? WHERE id = ?').run(JSON.stringify(nav_order), req.user.id);
  }
  if (nav_bookmarks !== undefined) {
    if (!validNavBookmarks(nav_bookmarks)) {
      return res.status(400).json({ error: 'nav_bookmarks doit être un tableau de { to, label }' });
    }
    const clean = nav_bookmarks.map((b) => ({ to: b.to, label: (b.label || b.to).slice(0, 120) }));
    db.prepare('UPDATE users SET nav_bookmarks = ? WHERE id = ?').run(JSON.stringify(clean), req.user.id);
  }
  if (decimal_preferences !== undefined) {
    if (!validDecimalPreferences(decimal_preferences)) {
      return res.status(400).json({ error: 'decimal_preferences doit être un objet { "table::field": entier 0-5 }' });
    }
    db.prepare('UPDATE users SET decimal_preferences = ? WHERE id = ?').run(JSON.stringify(decimal_preferences), req.user.id);
  }
  if (peek_width !== undefined) {
    const w = Math.round(Number(peek_width));
    if (!Number.isFinite(w) || w < 320 || w > 2000) {
      return res.status(400).json({ error: 'peek_width doit être un entier de pixels entre 320 et 2000' });
    }
    db.prepare('UPDATE users SET peek_width = ? WHERE id = ?').run(w, req.user.id);
  }
  // Fusion et non remplacement : le client n'envoie que la ressource qu'il
  // vient de redimensionner, sans écraser les largeurs posées ailleurs (autre
  // navigateur, autre onglet).
  if (peek_widths !== undefined) {
    if (!validPeekWidths(peek_widths)) {
      return res.status(400).json({ error: 'peek_widths doit être un objet { "ressource": entier de pixels 320-2000 }' });
    }
    const merged = { ...readPeekWidths(req.user.id), ...peek_widths };
    db.prepare('UPDATE users SET peek_widths = ? WHERE id = ?').run(JSON.stringify(merged), req.user.id);
  }
  res.json({
    nav_hidden: readNavHidden(req.user.id),
    nav_order: readNavOrder(req.user.id),
    nav_bookmarks: readNavBookmarks(req.user.id),
    decimal_preferences: readDecimalPreferences(req.user.id),
    peek_width: readPeekWidth(req.user.id),
    peek_widths: readPeekWidths(req.user.id),
  });
});

export default router;
