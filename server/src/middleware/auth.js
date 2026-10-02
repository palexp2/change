import { hasRole } from '../../../shared/roles.mjs'
import { verifySession } from '../services/sessionSecurity.js';
import { requestContext } from '../utils/requestContext.js';

export function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];
  // Accept token as query param for iframe/embed contexts (e.g. PDF viewer)
  const queryToken = ['GET', 'HEAD'].includes(req.method) && typeof req.query.token === 'string' ? req.query.token : null;
  if (!authHeader && !queryToken) {
    return res.status(401).json({ error: 'Authentication required' });
  }
  if (!authHeader?.startsWith('Bearer ') && !queryToken) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : queryToken;
  try {
    req.user = verifySession(token);
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
    if (!hasRole(req.user, 'admin')) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  });
}

export function requireHR(req, res, next) {
  requireAuth(req, res, () => {
    if (!hasRole(req.user, 'rh')) {
      return res.status(403).json({ error: 'Accès RH requis' });
    }
    next();
  });
}

export function isHR(user) {
  return !!user && hasRole(user, 'rh');
}

// Compatibility names; authorization is now the explicit RH grant only.
export const requireHROrAdmin = requireHR
