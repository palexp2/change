import jwt from 'jsonwebtoken';
import dotenv from 'dotenv';

dotenv.config();

const JWT_SECRET = process.env.JWT_SECRET || 'change-this-secret-in-production';

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
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = {
      id: payload.id,
      role: payload.role,
      name: payload.name,
    };
    next();
  } catch (err) {
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
