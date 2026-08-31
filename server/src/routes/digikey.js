import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { getConfig, saveConfig, deleteConfig, isDigikeyConfigured, DEFAULTS } from '../connectors/digikey.js'
import { parseLimit } from '../utils/pagination.js'

// Intégration DigiKey — configuration, état et consultation des commandes
// rapatriées. La sync elle-même est déclenchée par POST /api/connectors/sync/digikey
// (même bouton et même journal que les autres connecteurs) ou par le cron.

const router = Router()
router.use(requireAuth)

// Le secret ne ressort jamais : l'UI n'affiche que « configuré / pas configuré ».
function publicConfig() {
  const cfg = getConfig()
  const { client_secret, ...rest } = cfg
  return { ...rest, client_secret_set: !!client_secret }
}

router.get('/status', (req, res) => {
  const last = db.prepare(`
    SELECT created_at, status, records_modified, error_message, duration_ms
    FROM sync_log WHERE module='digikey' ORDER BY created_at DESC LIMIT 1
  `).get() || null
  const counts = db.prepare(`
    SELECT COUNT(*) AS orders,
           SUM(CASE WHEN pdf_path IS NOT NULL THEN 1 ELSE 0 END) AS with_pdf
    FROM digikey_orders WHERE deleted_at IS NULL
  `).get()
  res.json({
    configured: isDigikeyConfigured(),
    config: publicConfig(),
    defaults: DEFAULTS,
    last_sync: last,
    orders_count: counts?.orders || 0,
    pdf_count: counts?.with_pdf || 0,
  })
})

router.put('/config', (req, res) => {
  const body = req.body || {}
  for (const key of ['api_base', 'sandbox_api_base']) {
    if (body[key] && !/^https:\/\/[\w.-]+/.test(String(body[key]))) {
      return res.status(400).json({ error: `${key} doit être une URL https` })
    }
  }
  for (const key of ['history_path', 'salesorder_path', 'invoice_path']) {
    if (body[key] !== undefined && body[key] !== '' && !String(body[key]).startsWith('/')) {
      return res.status(400).json({ error: `${key} doit commencer par « / »` })
    }
  }
  if (body.sandbox !== undefined && !['0', '1', 0, 1, true, false].includes(body.sandbox)) {
    return res.status(400).json({ error: 'sandbox doit valoir 0 ou 1' })
  }
  const patch = { ...body }
  if (patch.sandbox !== undefined) patch.sandbox = (patch.sandbox === true || patch.sandbox === '1' || patch.sandbox === 1) ? '1' : '0'
  try {
    saveConfig(patch)
    res.json({ ok: true, config: publicConfig(), configured: isDigikeyConfigured() })
  } catch (e) {
    res.status(400).json({ error: e.message })
  }
})

router.delete('/config', (req, res) => {
  deleteConfig()
  res.json({ ok: true, configured: isDigikeyConfigured() })
})

// Commandes rapatriées, avec l'achat fournisseur créé pour chacune.
router.get('/orders', (req, res) => {
  const limit = parseLimit(req.query.limit, { def: 50, max: 200 })
  const rows = db.prepare(`
    SELECT d.id, d.track_key, d.sales_order_id, d.invoice_id, d.achat_id, d.pdf_path,
           d.order_date, d.total, d.currency, d.synced_at,
           a.status AS achat_status, a.total_cad AS achat_total, a.quickbooks_id
    FROM digikey_orders d
    LEFT JOIN achats_fournisseurs a ON a.id = d.achat_id
    WHERE d.deleted_at IS NULL
    ORDER BY COALESCE(d.order_date, d.synced_at) DESC
    LIMIT ?
  `).all(limit)
  res.json({ data: rows })
})

export default router
