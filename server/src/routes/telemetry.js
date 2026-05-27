import { Router } from 'express';
import db from '../db/database.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth);

router.post('/page-load', (req, res) => {
  const { url, load_ms } = req.body || {};
  const ms = Number(load_ms);
  if (!url || !Number.isFinite(ms) || ms < 0) {
    return res.status(400).json({ error: 'invalid payload' });
  }
  if (ms < 500) return res.json({ ok: true, skipped: true });

  db.prepare(`
    INSERT INTO slow_page_loads (user_id, user_name, url, load_ms)
    VALUES (?, ?, ?, ?)
  `).run(req.user.id || null, req.user.name || null, String(url).slice(0, 500), Math.round(ms));

  res.json({ ok: true });
});

export default router;
