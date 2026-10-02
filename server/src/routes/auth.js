import { rolesOf } from '../../../shared/roles.mjs'
import { Router } from 'express';
import { newRecordId } from '../utils/recordId.js';
import bcrypt from 'bcrypt';
import { issueSession } from '../services/sessionSecurity.js';
import { loginRateLimit, makeLoginRateLimit } from '../middleware/loginRateLimit.js';
import { randomBytes, createHash } from 'node:crypto';
import { APP_URL } from '../config/appUrl.js';
import { resolveFromAddress, getPostmarkClient } from '../services/postmarkConfig.js';
import db from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';
import { sanitizeSignatureHtml } from '../utils/sanitizeHtml.js';

const router = Router();

// POST /api/auth/login
router.post('/login', loginRateLimit, async (req, res) => {
  const { email, password } = req.body;
  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password || email.length > 254 || password.length > 1024) {
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

  const token = issueSession(user);

  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role, roles: rolesOf(user), employee_id: user.employee_id || null,
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

  db.prepare('INSERT INTO users (id, email, password_hash, name, role, roles) VALUES (?, ?, ?, ?, ?, ?)')
    .run(userId, email.toLowerCase().trim(), passwordHash, admin_name, 'admin', JSON.stringify(['user', 'admin', 'rh']));

  res.status(201).json({ message: 'Setup complete. You can now log in.' });
});

// GET /api/auth/users — liste des utilisateurs actifs du tenant (accessible à tous)
router.get('/users', requireAuth, (req, res) => {
  const users = db.prepare(
    'SELECT id, name, role, roles FROM users WHERE active = 1 ORDER BY name'
  ).all();
  res.json(users.map(user => ({ ...user, roles: rolesOf(user) })));
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

// ─── Mot de passe oublié ──────────────────────────────────────────────────────
// Le lien en clair ne vit que dans le courriel : en base on ne garde que son
// hachage. Une nouvelle demande périme les précédentes.

const RESET_TTL_MS = 60 * 60 * 1000;
const forgotRateLimit = makeLoginRateLimit({ windowMs: 15 * 60_000, max: 5 });

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function findLiveReset(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
  const row = db.prepare(
    `SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL`
  ).get(hashToken(token));
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(row.user_id);
  if (!user) return null;
  return { row, user };
}

async function sendResetEmail(user, token) {
  const link = `${APP_URL}/erp/reset-password?token=${encodeURIComponent(token)}`;
  const from = resolveFromAddress();
  if (!from) throw new Error('Adresse expéditeur Postmark manquante');
  await getPostmarkClient().sendEmail({
    From: from,
    To: user.email,
    Subject: 'Boréal — réinitialisation de votre mot de passe',
    HtmlBody: `<p>Bonjour ${user.name || ''},</p>
<p>Votre identifiant : <strong>${user.email}</strong></p>
<p><a href="${link}">Choisir un nouveau mot de passe</a> (lien valide 1 heure).</p>
<p>Si vous n'avez rien demandé, ignorez ce message.</p>`,
    TextBody: `Identifiant : ${user.email}\nNouveau mot de passe (lien valide 1 heure) : ${link}`,
  });
}

// POST /api/auth/forgot-password — réponse volontairement identique que le
// compte existe ou non (pas d'énumération d'adresses).
router.post('/forgot-password', forgotRateLimit, async (req, res) => {
  const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase().trim() : '';
  if (!email || email.length > 254) return res.status(400).json({ error: 'Courriel requis' });

  const user = db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
  if (user) {
    db.prepare('UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL')
      .run(new Date().toISOString(), user.id);
    const token = randomBytes(32).toString('base64url');
    db.prepare(
      'INSERT INTO password_resets (id, user_id, token_hash, expires_at) VALUES (?, ?, ?, ?)'
    ).run(newRecordId(), user.id, hashToken(token), new Date(Date.now() + RESET_TTL_MS).toISOString());
    try {
      await sendResetEmail(user, token);
    } catch (err) {
      console.error('[auth] envoi du courriel de réinitialisation échoué:', err.message);
    }
  }
  res.json({ ok: true });
});

// POST /api/auth/reset-password/check — le lien est-il encore bon ?
router.post('/reset-password/check', (req, res) => {
  const found = findLiveReset(req.body?.token);
  if (!found) return res.json({ valid: false });
  res.json({ valid: true, email: found.user.email });
});

// POST /api/auth/reset-password — pose le nouveau mot de passe et connecte.
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body || {};
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024) {
    return res.status(400).json({ error: 'Le mot de passe doit contenir au moins 8 caractères' });
  }
  const found = findLiveReset(token);
  if (!found) return res.status(400).json({ error: 'Lien invalide ou expiré' });

  const hash = await bcrypt.hash(password, 10);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, found.user.id);
  db.prepare('UPDATE password_resets SET used_at = ? WHERE id = ?')
    .run(new Date().toISOString(), found.row.id);

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(found.user.id);
  res.json({
    token: issueSession(user),
    user: { id: user.id, email: user.email, name: user.name, role: user.role, roles: rolesOf(user), employee_id: user.employee_id || null },
  });
});

// GET /api/auth/me
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, email, name, role, roles, employee_id, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ ...user, roles: rolesOf(user) });
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

// Signature de courriel (HTML nettoyé), ajoutée en bas de la fenêtre d'envoi.
function readEmailSignature(userId) {
  return db.prepare('SELECT email_signature FROM users WHERE id = ?').get(userId)?.email_signature || '';
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
    email_signature: readEmailSignature(req.user.id),
  });
});

// PATCH /api/auth/preferences — maj des préférences UI (menu de gauche, décimales, largeur side-peek, etc.)
router.patch('/preferences', requireAuth, (req, res) => {
  const { nav_hidden, nav_order, nav_bookmarks, decimal_preferences, peek_width, peek_widths, email_signature } = req.body || {};
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
  if (email_signature !== undefined) {
    if (email_signature !== null && (typeof email_signature !== 'string' || email_signature.length > 50000)) {
      return res.status(400).json({ error: 'email_signature doit être une chaîne (50 000 caractères max)' });
    }
    db.prepare('UPDATE users SET email_signature = ? WHERE id = ?').run(sanitizeSignatureHtml(email_signature) || null, req.user.id);
  }
  res.json({
    nav_hidden: readNavHidden(req.user.id),
    nav_order: readNavOrder(req.user.id),
    nav_bookmarks: readNavBookmarks(req.user.id),
    decimal_preferences: readDecimalPreferences(req.user.id),
    peek_width: readPeekWidth(req.user.id),
    peek_widths: readPeekWidths(req.user.id),
    email_signature: readEmailSignature(req.user.id),
  });
});

export default router;
