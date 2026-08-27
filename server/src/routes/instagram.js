import { Router } from 'express'
import { timingSafeEqual } from 'crypto'
import db from '../db/database.js'
import { requireAuth, requireAdmin } from '../middleware/auth.js'
import {
  INSTAGRAM_INTAKE_AUTOMATION_ID,
  ingestManychatEvent,
  pushToAirtable,
  getIntakeSecret,
  hasIntakeSecret,
} from '../services/instagramProspects.js'
import {
  runCommentScrape,
  getSessionCookie,
  getScrapeConfig,
} from '../services/instagramCommentScrape.js'
import { isSystemAutomationActive, logSystemRun } from '../services/systemAutomations.js'

/**
 * Prospects Instagram.
 *
 * POST /api/instagram/manychat est PUBLIC (appelé par l'action « External
 * Request » de ManyChat) et protégé par un secret partagé. On n'utilise pas le
 * moteur d'automations `kind='webhook'` : son allowlist de tables
 * (webhookEngine.js — tickets / projects / serial_numbers) exclut
 * instagram_prospects, et la logique requise (dédup par identifiant Instagram,
 * fusion de fiches, compteurs, réponse structurée que ManyChat consomme) n'est
 * pas exprimable en steps déclaratifs. La visibilité exigée par les règles de
 * design passe par l'automation système `sys_instagram_prospect_intake`
 * (activation, config, journal) et par la table instagram_prospect_events.
 *
 * La réponse porte `should_dm` : c'est l'ERP qui décide s'il faut écrire à la
 * personne, et le flow ManyChat branche dessus. ManyChat ne déclenche qu'une
 * fois par personne ET par publication — lui seul ne peut donc pas éviter de
 * recontacter quelqu'un qui commente une deuxième publication.
 */

const router = Router()

// Anti-bruit : l'endpoint est public, un scan ne doit pas remplir automation_logs.
let lastAuthFailureLogAt = 0
const AUTH_LOG_THROTTLE_MS = 60_000

function secretMatches(provided) {
  const expected = getIntakeSecret()
  if (!expected || !provided) return false
  const a = Buffer.from(String(provided))
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function providedSecret(req) {
  const auth = req.headers.authorization || ''
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim()
  // Replis pour le cas où l'UI ManyChat ne laisse pas poser d'en-tête. Moins
  // bon : le secret finit dans les logs d'accès nginx. Préférer l'en-tête.
  return req.headers['x-erp-secret'] || req.query.token || req.body?.secret || null
}

router.post('/manychat', async (req, res) => {
  const t0 = Date.now()

  if (!hasIntakeSecret()) {
    logSystemRun(INSTAGRAM_INTAKE_AUTOMATION_ID, {
      status: 'error', duration_ms: Date.now() - t0,
      error: new Error("Secret d'intake non configuré (connector_config manychat/webhook_secret) — appel de ManyChat refusé"),
    })
    return res.status(503).json({ error: 'Secret du webhook non configuré côté serveur' })
  }

  if (!secretMatches(providedSecret(req))) {
    if (Date.now() - lastAuthFailureLogAt > AUTH_LOG_THROTTLE_MS) {
      lastAuthFailureLogAt = Date.now()
      logSystemRun(INSTAGRAM_INTAKE_AUTOMATION_ID, {
        status: 'error', duration_ms: Date.now() - t0,
        error: new Error(`Secret invalide (appel refusé, ip ${req.ip})`),
      })
    }
    return res.status(401).json({ error: 'Secret invalide' })
  }

  // Automation désactivée : 200 volontaire. Un 4xx/5xx ferait rejouer ManyChat
  // en boucle alors que le refus est délibéré.
  if (!isSystemAutomationActive(INSTAGRAM_INTAKE_AUTOMATION_ID)) {
    return res.json({ ok: true, stored: false, should_dm: false, reason: 'automation inactive' })
  }

  const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body : {}

  let result
  try {
    result = ingestManychatEvent(body)
  } catch (e) {
    logSystemRun(INSTAGRAM_INTAKE_AUTOMATION_ID, {
      status: 'error', duration_ms: Date.now() - t0, triggerData: body, error: e,
    })
    console.error('instagram intake:', e.message)
    return res.status(500).json({ error: 'Erreur interne' })
  }

  if (!result.ok) {
    logSystemRun(INSTAGRAM_INTAKE_AUTOMATION_ID, {
      status: 'error', duration_ms: Date.now() - t0, triggerData: body,
      error: new Error(result.error),
    })
    return res.status(400).json({ error: result.error })
  }

  const p = result.prospect || {}

  // Miroir Airtable hors du chemin critique : ManyChat attend une réponse
  // rapide, et une panne Airtable ne doit pas faire perdre le prospect.
  if (result.stored) pushToAirtable(p.id).catch(() => {})

  logSystemRun(INSTAGRAM_INTAKE_AUTOMATION_ID, {
    status: 'success', duration_ms: Date.now() - t0, triggerData: body,
    result: result.duplicate
      ? `Rejeu ignoré — @${p.ig_username || '?'} (${body.flow || 'comment'})`
      : `${result.is_new ? 'Nouveau prospect' : 'Prospect mis à jour'} @${p.ig_username || '?'} · ${body.flow || 'comment'}` +
        `${p.has_keyword ? ' · mot-clé' : ''}${p.dm_sent ? ' · DM déjà envoyé' : ''}`,
  })

  return res.json({
    ok: true,
    stored: !!result.stored,
    duplicate: !!result.duplicate,
    is_new: !!result.is_new,
    prospect_id: p.id || null,
    // Le champ sur lequel le flow ManyChat branche avant d'envoyer le DM.
    should_dm: !p.dm_sent,
    already_dm_sent: !!p.dm_sent,
    comment_count: p.comment_count || 0,
    replied: !!p.replied,
    status: p.follow_up_status || null,
  })
})

/**
 * Lecture (authentifiée) — l'interface de travail est Airtable, mais cette route
 * sert à tester l'intake sans Airtable et à diagnostiquer si le miroir tombe.
 */
router.get('/prospects', requireAuth, (req, res) => {
  const where = ['deleted_at IS NULL']
  const args = []
  if (req.query.status) { where.push('follow_up_status = ?'); args.push(String(req.query.status)) }
  if (req.query.dm_sent != null && req.query.dm_sent !== '') {
    where.push('dm_sent = ?'); args.push(String(req.query.dm_sent) === '1' ? 1 : 0)
  }
  if (req.query.keyword_only === '1') where.push('has_keyword = 1')
  if (req.query.since) { where.push('first_comment_at >= ?'); args.push(String(req.query.since)) }

  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100))
  const rows = db.prepare(`
    SELECT * FROM instagram_prospects
    WHERE ${where.join(' AND ')}
    ORDER BY first_comment_at DESC
    LIMIT ?
  `).all(...args, limit)

  res.json({ prospects: rows, count: rows.length })
})

/**
 * Soft delete — pour écarter un commentateur hors sujet (spam, bot) de la liste
 * hebdomadaire. La fiche reste en base : si la personne recommente, elle sera
 * recréée, mais la trace de l'ancien passage demeure dans les événements.
 */
router.delete('/prospects/:id', requireAuth, (req, res) => {
  const info = db.prepare(`
    UPDATE instagram_prospects
    SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ? AND deleted_at IS NULL
  `).run(req.params.id)
  if (!info.changes) return res.status(404).json({ error: 'Prospect introuvable' })
  res.json({ ok: true })
})

// ── Interface ERP (/prospects-instagram) ────────────────────────────────────
// La liste de travail vit dans l'ERP ET dans Airtable : les deux sont le même
// enregistrement, `contacted` remonte dans les deux sens (cf. syncInstagramProspects).

const LIST_COLS = `
  id, ig_username, full_name, profile_url, keyword, has_keyword,
  first_comment_text, first_comment_at, first_post_url,
  last_comment_text, last_comment_at, last_post_url, comment_count,
  dm_sent, dm_sent_at, replied, replied_at, first_reply_text,
  contacted, contacted_at, contacted_by, contacted_source, follow_up_status, notes,
  week_key, source, airtable_id
`

/**
 * Liste groupée par semaine ISO — la forme de la page. Une seule requête :
 * le volume (quelques centaines de fiches par an) ne justifie pas de
 * pagination, et grouper côté serveur évite au client de refaire le calcul
 * de semaine.
 */
router.get('/weeks', requireAuth, (req, res) => {
  const where = ['deleted_at IS NULL']
  const args = []
  if (req.query.keyword_only === '1') where.push('has_keyword = 1')
  if (req.query.pending === '1') where.push('contacted = 0')
  if (req.query.q) {
    where.push('(ig_username LIKE ? OR full_name LIKE ? OR first_comment_text LIKE ?)')
    const like = `%${String(req.query.q).trim()}%`
    args.push(like, like, like)
  }

  const rows = db.prepare(`
    SELECT ${LIST_COLS} FROM instagram_prospects
    WHERE ${where.join(' AND ')}
    ORDER BY COALESCE(first_comment_at, created_at) DESC
  `).all(...args)

  // week_key peut manquer sur une fiche ancienne : on la range sous « — »
  // plutôt que de la faire disparaître de la page.
  const byWeek = new Map()
  for (const r of rows) {
    const key = r.week_key || '—'
    if (!byWeek.has(key)) byWeek.set(key, [])
    byWeek.get(key).push(r)
  }
  const weeks = [...byWeek.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([week, prospects]) => ({
      week,
      total: prospects.length,
      contacted: prospects.filter(p => p.contacted).length,
      replied: prospects.filter(p => p.replied).length,
      prospects,
    }))

  const cfg = getScrapeConfig()
  res.json({
    weeks,
    total: rows.length,
    pending: rows.filter(p => !p.contacted).length,
    config: {
      accounts: cfg.accounts,
      keywords: cfg.keywords,
      lookback_days: cfg.lookback_days,
      session_ok: !!getSessionCookie().sessionid,
    },
  })
})

/**
 * Édition d'une fiche. Autosave côté client : un clic sur la case « Contacté »
 * PATCH immédiatement, sans confirmation (action réversible). `contacted_at` et
 * `contacted_by` sont posés par le serveur — jamais par le client.
 */
router.patch('/prospects/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT id, contacted FROM instagram_prospects WHERE id=? AND deleted_at IS NULL').get(req.params.id)
  if (!row) return res.status(404).json({ error: 'Prospect introuvable' })

  const sets = []
  const args = []
  const changed = []

  if ('contacted' in req.body) {
    const v = req.body.contacted === true || req.body.contacted === 1 || req.body.contacted === '1' ? 1 : 0
    sets.push('contacted = ?'); args.push(v); changed.push('contacted')
    // Décocher efface la date : la fiche redevient « à contacter » sans laisser
    // un horodatage qui contredirait la case.
    sets.push('contacted_at = ?'); args.push(v ? new Date().toISOString() : null); changed.push('contacted_at')
    sets.push('contacted_by = ?'); args.push(v ? (req.user?.id || null) : null)
    // Une case cochée à la main écrase toute source auto-détectée : c'est
    // l'humain qui a le dernier mot sur sa propre liste.
    sets.push('contacted_source = ?'); args.push(v ? 'manual' : null)
  }
  if ('follow_up_status' in req.body) {
    const v = String(req.body.follow_up_status || '').trim().slice(0, 60) || 'À contacter'
    sets.push('follow_up_status = ?'); args.push(v); changed.push('follow_up_status')
  }
  if ('notes' in req.body) {
    const v = String(req.body.notes ?? '').trim().slice(0, 4000)
    sets.push('notes = ?'); args.push(v || null); changed.push('notes')
  }
  if (!sets.length) return res.status(400).json({ error: 'Aucun champ modifiable fourni' })

  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')")
  args.push(row.id)
  db.prepare(`UPDATE instagram_prospects SET ${sets.join(', ')} WHERE id = ?`).run(...args)

  // Miroir Airtable hors du chemin critique : la case doit se cocher
  // instantanément même si Airtable est en panne.
  pushToAirtable(row.id).catch(() => {})

  res.json({ ok: true, prospect: db.prepare(`SELECT ${LIST_COLS} FROM instagram_prospects WHERE id=?`).get(row.id) })
})

/**
 * Tournée immédiate (bouton « Actualiser » de la page). Admin : l'appel sort
 * vers Instagram avec le cookie de session et peut durer une minute.
 */
router.post('/scrape', requireAdmin, async (req, res) => {
  const days = req.body?.days != null ? Number(req.body.days) : null
  const result = await runCommentScrape({ force: true, trigger: 'manuel (page Prospects Instagram)', days })
  if (result.error) return res.status(502).json(result)
  res.json(result)
})

/** État du cookie de session — jamais la valeur, seulement s'il est là. */
router.get('/session', requireAuth, (req, res) => {
  const { sessionid, dsUserId } = getSessionCookie()
  res.json({ configured: !!sessionid, hint: sessionid ? `${sessionid.slice(0, 6)}…` : null, ds_user_id: dsUserId || null })
})

/** Rotation du cookie. Admin — c'est un secret de compte. */
router.put('/session', requireAdmin, (req, res) => {
  const sessionid = String(req.body?.sessionid || '').trim()
  const dsUserId = String(req.body?.ds_user_id || '').trim()
  if (sessionid && sessionid.length < 20) return res.status(400).json({ error: 'sessionid invalide (trop court)' })
  const put = db.prepare(`
    INSERT INTO connector_config (connector, key, value) VALUES ('instagram', ?, ?)
    ON CONFLICT(connector, key) DO UPDATE SET value = excluded.value
  `)
  db.transaction(() => {
    put.run('sessionid', sessionid)
    put.run('ds_user_id', dsUserId)
  })()
  res.json({ ok: true, configured: !!sessionid })
})

export default router
