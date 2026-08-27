import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../config/secrets.js';
import { requestContext } from '../utils/requestContext.js';
import db from '../db/database.js';

// Le rôle encodé dans le JWT (10 ans) devient périmé dès qu'on modifie le
// compte : on relit donc le rôle courant en DB à chaque requête. Fallback sur
// le payload si le user n'existe plus (tokens de test signés sans record).
function currentRole(payload) {
  try {
    const row = db.prepare('SELECT role FROM users WHERE id = ?').get(payload.id);
    return row?.role || payload.role;
  } catch {
    return payload.role;
  }
}

export function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  // Accept token as query param for iframe/embed contexts (e.g. PDF viewer)
  const queryToken = req.query.token;
  if (!authHeader && !queryToken) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (!authHeader?.startsWith('Bearer ') && !queryToken) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = queryToken || authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    req.user = {
      id: payload.id,
      role: currentRole(payload),
      name: payload.name,
    };
    // Propage l'utilisateur dans le contexte async de toute la suite de la requête
    // (handlers + services), pour que les écritures QuickBooks soient attribuées à
    // la bonne personne sans threader req.user à travers chaque appel.
    requestContext.run({ user: req.user }, () => next());
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}

export function requireHROrAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!['admin', 'rh'].includes(req.user.role)) {
      return res.status(403).json({ error: 'Accès RH requis' });
    }
    next();
  });
}

export function isHROrAdmin(user) {
  return !!user && ['admin', 'rh'].includes(user.role);
}
