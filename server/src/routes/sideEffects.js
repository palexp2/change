import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'

const router = Router()
router.use(requireAuth)

// Journal des side effects — timeline unifiée (cf. CLAUDE.md : « un endroit où
// l'utilisateur peut visualiser l'historique des déclenchements de side effect »).
//
// Agrège trois sources hétérogènes en une projection commune, triée par date :
//   - sync_log         → syncs connecteurs (Airtable, QB, Gmail, Drive, FTP…)
//   - automation_logs  → exécutions d'automations / side-effects (email, Slack,
//                        push QB, write-back Airtable, scripts) joint sur automations
//   - activity_log     → écritures CRUD applicatives (qui a créé/modifié/supprimé quoi)
//
// Colonnes normalisées (mêmes positions/types dans chaque UNION) :
//   source, source_id, ts, status, category, subtype, label, actor, error,
//   duration_ms, records, ref_type, ref_id
//
// `status` est normalisé en : success | error | skipped | info (les écritures
// CRUD n'ont pas de statut d'échec → 'info', tonalité neutre côté client).

const SOURCES = ['sync', 'automation', 'activity']

function buildSubquery(source) {
  switch (source) {
    case 'sync':
      return `
        SELECT 'sync' AS source, CAST(s.id AS TEXT) AS source_id, s.created_at AS ts,
               s.status AS status, s.module AS category, s.trigger AS subtype,
               NULL AS label, NULL AS actor, s.error_message AS error,
               s.duration_ms AS duration_ms, s.records_modified AS records,
               NULL AS ref_type, NULL AS ref_id
        FROM sync_log s`
    case 'automation':
      return `
        SELECT 'automation' AS source, l.id AS source_id, l.created_at AS ts,
               l.status AS status, COALESCE(au.action_type, au.kind, 'automation') AS category,
               au.trigger_type AS subtype, au.name AS label, NULL AS actor, l.error AS error,
               NULL AS duration_ms, NULL AS records,
               'automation' AS ref_type, l.automation_id AS ref_id
        FROM automation_logs l
        LEFT JOIN automations au ON au.id = l.automation_id`
    case 'activity':
      return `
        SELECT 'activity' AS source, CAST(a.id AS TEXT) AS source_id, a.created_at AS ts,
               'info' AS status, a.entity_type AS category, a.action AS subtype,
               a.detail AS label, u.name AS actor, NULL AS error,
               NULL AS duration_ms, NULL AS records,
               a.entity_type AS ref_type, a.entity_id AS ref_id
        FROM activity_log a
        LEFT JOIN users u ON u.id = a.user_id`
    default:
      return null
  }
}

// GET /api/side-effects
// Query: ?source=sync,automation  ?status=error  ?q=texte  ?limit=200  ?page=1  ?since=ISO
router.get('/', (req, res) => {
  const { source, status, q, since, page = 1 } = req.query
  const limitRaw = req.query.limit
  const limitAll = limitRaw === 'all'
  const limit = limitAll ? -1 : Math.min(parseInt(limitRaw) || 200, 2000)
  const offset = limitAll ? 0 : (Math.max(parseInt(page) || 1, 1) - 1) * (parseInt(limitRaw) || 200)

  // Filtre source : on n'inclut que les sous-requêtes demandées (moins de travail SQL).
  const wanted = source
    ? String(source).split(',').map(s => s.trim()).filter(s => SOURCES.includes(s))
    : SOURCES
  const active = wanted.length ? wanted : SOURCES

  const union = active.map(buildSubquery).filter(Boolean).join('\n      UNION ALL\n')

  // Filtres appliqués sur la projection unifiée.
  const where = []
  const params = {}
  if (status && ['success', 'error', 'skipped', 'info'].includes(status)) {
    where.push('t.status = @status')
    params.status = status
  }
  if (since) {
    where.push('t.ts >= @since')
    params.since = since
  }
  if (q && String(q).trim()) {
    where.push('(t.label LIKE @q OR t.category LIKE @q OR t.actor LIKE @q OR t.error LIKE @q OR t.subtype LIKE @q)')
    params.q = `%${String(q).trim()}%`
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''

  const base = `FROM (\n      ${union}\n    ) t ${whereSql}`

  const total = db.prepare(`SELECT COUNT(*) AS c ${base}`).get(params).c

  const rows = db.prepare(`
    SELECT t.* ${base}
    ORDER BY t.ts DESC
    LIMIT @limit OFFSET @offset
  `).all({ ...params, limit, offset })

  // Agrégats légers (24 h) pour la barre de stats — bornés aux sources actives.
  const stats = db.prepare(`
    SELECT
      COUNT(*) AS total_24h,
      SUM(CASE WHEN t.status = 'error' THEN 1 ELSE 0 END) AS errors_24h
    FROM (\n      ${union}\n    ) t
    WHERE t.ts >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')
  `).get()

  res.json({
    data: rows,
    total,
    page: limitAll ? 1 : parseInt(page),
    limit: limitAll ? 'all' : (parseInt(limitRaw) || 200),
    stats: { total24h: stats.total_24h || 0, errors24h: stats.errors_24h || 0 },
  })
})

export default router
