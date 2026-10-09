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
  saveSessionCookie,
  getScrapeConfig,
} from '../services/instagramCommentScrape.js'
import { isSystemAutomationActive, logSystemRun } from '../services/systemAutomations.js'
import { getSessionStatus } from '../services/sessionHealth.js'
import { parseLimit } from '../utils/pagination.js'

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

  const limit = parseLimit(req.query.limit, { def: 100, max: 500 })
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
  // La fiche disparaît aussi d'Airtable : Philippe y travaille, une fiche
  // écartée d'un seul côté lui revient dans les mains. Non bloquant.
  import('../services/instagramProspects.js')
    .then(({ deleteFromAirtable }) => deleteFromAirtable(req.params.id))
    .catch(() => {})
  // Un message écrit d'avance ne doit jamais partir vers une fiche écartée.
  import('../services/instagramDrafts.js')
    .then(({ dropOpenDrafts }) => dropOpenDrafts(req.params.id))
    .catch(() => {})
  res.json({ ok: true })
})

// ── Interface ERP (/prospects-instagram) ────────────────────────────────────
// La liste de travail vit dans l'ERP ET dans Airtable : les deux sont le même
// enregistrement, `contacted` remonte dans les deux sens (cf. syncInstagramProspects).

/** Dernier état connu de la session Instagram (vérifié chaque matin). */
function sessionStatus() {
  try { return db.prepare("SELECT status, detail FROM connector_sessions WHERE connector='instagram'").get() || null }
  catch { return null }
}

const LIST_COLS = `
  id, ig_username, full_name, profile_url, keyword, has_keyword,
  first_comment_text, first_comment_at, first_post_url,
  last_comment_text, last_comment_at, last_post_url, comment_count,
  capture_kind, capture_label, capture_url, last_event_kind, last_event_at, manychat_tags, manychat_url,
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
      // Présence ≠ validité : un cookie mort laissait la page afficher un état
      // rassurant pendant que rien n'était capté. On rend l'état vérifié.
      session_ok: !!getSessionCookie().sessionid && sessionStatus()?.status !== 'expired',
      session_detail: sessionStatus()?.status === 'ok' ? null : sessionStatus()?.detail || null,
    },
  })
})

// ── Conversations ManyChat ─────────────────────────────────────────────────
//
// Philippe lit et répond depuis Boréal ; ManyChat reste la plomberie.
router.get('/conversations', requireAuth, (req, res) => {
  const onlyNamed = String(req.query.all || '') !== '1'
  const rows = db.prepare(`
    SELECT t.user_id, t.ig_username, t.full_name, t.status, t.optin, t.subscribed_at,
           t.last_message_text, t.last_message_at, t.last_direction, t.last_incoming_at,
           t.prospect_id, p.contacted
    FROM manychat_threads t
    LEFT JOIN instagram_prospects p ON p.id = t.prospect_id AND p.deleted_at IS NULL
    ${onlyNamed ? 'WHERE t.ig_username IS NOT NULL' : ''}
    ORDER BY COALESCE(t.last_message_at, t.subscribed_at) DESC
    LIMIT 200
  `).all()
  res.json({ conversations: rows, count: rows.length })
})

router.get('/conversations/:userId/messages', requireAuth, async (req, res) => {
  const refresh = String(req.query.refresh || '') === '1'
  if (refresh) {
    try {
      const { syncThreadMessages } = await import('../services/manychatSync.js')
      await syncThreadMessages(req.params.userId)
    } catch (e) { return res.status(502).json({ error: e.message }) }
  }
  const messages = db.prepare(`
    SELECT id, direction, text, kind, sent_at, link_url FROM manychat_messages
    WHERE user_id = ? ORDER BY sent_at
  `).all(req.params.userId)
  const thread = db.prepare('SELECT * FROM manychat_threads WHERE user_id=?').get(req.params.userId) || null
  res.json({ thread, messages })
})

/**
 * Envoi d'un message. Instagram n'autorise une réponse que dans les 24 h
 * suivant le dernier message de la personne : on laisse ManyChat trancher et
 * on remonte son refus tel quel plutôt que de deviner.
 */
router.post('/conversations/:userId/send', requireAuth, async (req, res) => {
  const text = String(req.body?.text || '').trim()
  if (!text) return res.status(400).json({ error: 'Message vide' })
  try {
    const { sendManychatMessage } = await import('../services/manychat.js')
    const { syncThreadMessages } = await import('../services/manychatSync.js')
    const out = await sendManychatMessage(req.params.userId, text)
    if (out?.state === false) {
      const msg = out?.$errors?.[0]?.message || out?.errors?.[0] || 'ManyChat a refusé l’envoi'
      return res.status(422).json({ error: msg })
    }
    let messages = []
    try {
      const { dropDraftsForThread } = await import('../services/instagramDrafts.js')
      dropDraftsForThread(req.params.userId)
      // Répondre depuis la page, c'est traiter la personne : elle sort de la pile.
      db.prepare(`
        UPDATE instagram_prospects SET contacted=1, contacted_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          contacted_by=?, contacted_source='boreal', updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE deleted_at IS NULL AND (manychat_subscriber_id = ?
          OR id IN (SELECT prospect_id FROM manychat_threads WHERE user_id = ?))
      `).run(req.user?.id || null, req.params.userId, req.params.userId)
    } catch { /* le message est parti, c'est l'essentiel */ }
    try { await syncThreadMessages(req.params.userId) } catch {}
    messages = db.prepare('SELECT id, direction, text, kind, sent_at, link_url FROM manychat_messages WHERE user_id=? ORDER BY sent_at').all(req.params.userId)
    res.json({ ok: true, messages })
  } catch (e) {
    res.status(502).json({ error: e.message })
  }
})

/**
 * Rattrapage : retire d'Airtable toutes les fiches écartées qui y sont encore.
 * Sert après un écartement en masse, ou quand Airtable était injoignable au
 * moment du clic.
 */
router.post('/prospects/purge-airtable', requireAdmin, async (req, res) => {
  const rows = db.prepare(`
    SELECT id FROM instagram_prospects WHERE deleted_at IS NOT NULL AND airtable_id IS NOT NULL
  `).all()
  const { deleteFromAirtable } = await import('../services/instagramProspects.js')
  let deleted = 0
  const errors = []
  for (const r of rows) {
    // Rythme volontaire : Airtable plafonne à 5 requêtes/seconde par base.
    await new Promise(res2 => setTimeout(res2, 250))
    const out = await deleteFromAirtable(r.id)
    if (out?.ok) deleted++
    else if (out?.error) errors.push(out.error)
  }
  res.json({ candidates: rows.length, deleted, errors: errors.slice(0, 5) })
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

  // Cocher « contactée » retire le message écrit d'avance : quelqu'un s'en est
  // occupé autrement, le brouillon ferait doublon.
  if (changed.includes('contacted') && req.body.contacted) {
    import('../services/instagramDrafts.js')
      .then(({ dropOpenDrafts }) => dropOpenDrafts(row.id, 'Marquée contactée à la main'))
      .catch(() => {})
  }

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
  // Le cookie présent ne dit pas qu'il marche : on joint le dernier verdict de
  // la vérification quotidienne, pour Instagram et pour ManyChat.
  const expired = ['instagram', 'manychat'].filter(c => getSessionStatus(c)?.status === 'expired')
  res.json({ configured: !!sessionid, expired, hint: sessionid ? `${sessionid.slice(0, 6)}…` : null, ds_user_id: dsUserId || null })
})

/** Rotation du cookie. Admin — c'est un secret de compte. */
router.put('/session', requireAdmin, (req, res) => {
  const sessionid = String(req.body?.sessionid || '').trim()
  const dsUserId = String(req.body?.ds_user_id || '').trim()
  if (sessionid && sessionid.length < 20) return res.status(400).json({ error: 'sessionid invalide (trop court)' })
  saveSessionCookie({ sessionid, dsUserId })
  // Une session fraîche ne dure pas : on en profite tout de suite pour lire,
  // trier, écrire et envoyer la liste de la semaine à Philippe.
  if (sessionid) {
    import('../services/instagramRefresh.js')
      .then(({ refreshAfterReconnect }) => refreshAfterReconnect({ trigger: 'reconnexion Instagram', sendDigest: true }))
      .catch(e => console.error('instagram refresh:', e.message))
  }
  res.json({ ok: true, configured: !!sessionid, refreshing: !!sessionid })
})

// ── Messages écrits d'avance et file d'envoi ───────────────────────────────

/** La liste unique : qui attend quelque chose, avec son message et son fil. */
router.get('/workbench', requireAuth, async (req, res) => {
  const { workbench } = await import('../services/instagramDrafts.js')
  res.json(workbench({ all: String(req.query.all || '') === '1' }))
})

/** Le type de demande choisi à la main : il ne se fait jamais réécrire. */
/**
 * Philippe revient de répondre dans Instagram : on relit la conversation, et si
 * son message y est, la personne est traitée d'elle-même.
 */
router.post('/prospects/:id/check-sent', requireAuth, async (req, res) => {
  const p = db.prepare('SELECT id, manychat_subscriber_id FROM instagram_prospects WHERE id=? AND deleted_at IS NULL').get(req.params.id)
  if (!p) return res.status(404).json({ error: 'Fiche introuvable' })
  const t = db.prepare('SELECT user_id FROM manychat_threads WHERE prospect_id=? OR user_id=?').get(p.id, p.manychat_subscriber_id || '')
  if (!t) return res.json({ handled: false })
  try {
    const { syncThreadMessages } = await import('../services/manychatSync.js')
    await syncThreadMessages(t.user_id)
  } catch (e) { return res.json({ handled: false, error: e.message }) }
  const { markAlreadyHandled } = await import('../services/instagramSegments.js')
  res.json({ handled: markAlreadyHandled({ ids: [p.id] }) > 0 })
})

router.post('/prospects/:id/segment', requireAuth, async (req, res) => {
  const { setSegment } = await import('../services/instagramSegments.js')
  try { res.json(setSegment(String(req.params.id), String(req.body?.segment || ''))) }
  catch (e) { res.status(400).json({ error: e.message }) }
})

/** Tri immédiat : range les piles, écarte les robots, sort les déjà traités. */
router.post('/segments/run', requireAdmin, async (req, res) => {
  const { runSegmentation } = await import('../services/instagramSegments.js')
  res.json(await runSegmentation({ force: true, trigger: 'page Instagram' }))
})

router.get('/drafts', requireAuth, async (req, res) => {
  const { listDrafts } = await import('../services/instagramDrafts.js')
  res.json(listDrafts())
})

/** Écrit (ou réécrit) le message d'une personne. */
router.post('/drafts/write', requireAuth, async (req, res) => {
  const { writeDraft } = await import('../services/instagramDrafts.js')
  try {
    const out = await writeDraft(String(req.body?.prospect_id || ''), {
      instructions: req.body?.instructions,
      force: req.body?.force !== false,
    })
    if (out.skipped) return res.status(422).json({ error: 'Aucune réponse vérifiée à cette question : à écrire soi-même, ou donner une consigne.' })
    res.json(out)
  } catch (e) { res.status(400).json({ error: e.message }) }
})

/** Un message tapé à la main, gardé pour qu'il soit encore là au retour. */
router.post('/drafts/manual', requireAuth, async (req, res) => {
  const { saveManualDraft } = await import('../services/instagramDrafts.js')
  try { res.json({ ok: true, draft: saveManualDraft(String(req.body?.prospect_id || ''), req.body?.text) }) } catch (e) { res.status(400).json({ error: e.message }) }
})

/** Tournée d'écriture pour tout le monde qui attend encore un message. */
router.post('/drafts/write-all', requireAuth, async (req, res) => {
  const { runDraftWriting } = await import('../services/instagramDrafts.js')
  res.json(await runDraftWriting({ force: true, trigger: 'bouton' }))
})

/** Le bouton : tout ce qui est prêt part maintenant, espacé. */
router.post('/drafts/send-now', requireAuth, async (req, res) => {
  const { sendAllNow } = await import('../services/instagramDrafts.js')
  res.json(await sendAllNow())
})

/** Retenir toute la file. */
router.post('/drafts/hold-all', requireAuth, async (req, res) => {
  const { holdAll } = await import('../services/instagramDrafts.js')
  res.json(holdAll())
})

/** Un seul message : texte, mise en file, retenue, envoi immédiat, abandon. */
router.patch('/drafts/:id', requireAuth, async (req, res) => {
  const { getDraft, queueDrafts, runDraftQueue } = await import('../services/instagramDrafts.js')
  const d = getDraft(req.params.id)
  if (!d) return res.status(404).json({ error: 'Message introuvable' })
  if (d.status === 'sent') return res.status(409).json({ error: 'Ce message est déjà parti' })

  const text = req.body?.text != null ? String(req.body.text).trim() : null
  if (text != null) {
    if (!text) return res.status(400).json({ error: 'Message vide' })
    db.prepare("UPDATE instagram_drafts SET text=?, edited=1, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
      .run(text, d.id)
  }
  const action = String(req.body?.action || '')
  if (action === 'hold') {
    db.prepare("UPDATE instagram_drafts SET status='held', scheduled_at=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(d.id)
  } else if (action === 'drop') {
    db.prepare("UPDATE instagram_drafts SET status='dropped', scheduled_at=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(d.id)
  } else if (action === 'approve') {
    db.prepare("UPDATE instagram_drafts SET status='draft', review_reason=NULL, error=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(d.id)
    queueDrafts({ ids: [d.id] })
  } else if (action === 'send') {
    db.prepare("UPDATE instagram_drafts SET status='draft', review_reason=NULL, error=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(d.id)
    const q = queueDrafts({ ids: [d.id], now: true })
    if (!q.queued) return res.status(422).json({ error: getDraft(d.id)?.error || 'Envoi impossible', draft: getDraft(d.id) })
    db.prepare("UPDATE instagram_drafts SET scheduled_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?").run(d.id)
    await runDraftQueue({ force: true, trigger: 'bouton' })
  }
  res.json({ ok: true, draft: getDraft(d.id) })
})

export default router
