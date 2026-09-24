// Instagram — trier ce qui attend une réponse, par TYPE de demande.
//
// Une seule liste mélangeait trois demandes qui n'appellent pas du tout le même
// message : celle qui a écrit « coach », celle qui fait pousser des fleurs, et
// celle qu'on peut simplement aborder. Chacune a maintenant sa pile, et son
// propre message écrit d'avance.
//
// Deux nettoyages vont avec :
//   • les robots sont reconnus et supprimés, et leur nom d'usager est retenu
//     pour qu'ils ne reviennent pas à la lecture suivante ;
//   • quelqu'un à qui Philippe a déjà écrit de sa main ne réapparaît plus comme
//     « à contacter » — il revient seulement s'il réécrit.
import db from '../db/database.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'
import { readProfiles, profileOf, ACTIVITIES } from './instagramProfiles.js'

export const SEGMENT_AUTOMATION_ID = 'sys_instagram_segments'

/** L'ordre est celui des sections dans la page. */
export const SEGMENTS = [
  { key: 'coach', label: 'Ont demandé le coaching' },
  { key: 'fleurs', label: 'Font pousser des fleurs' },
  { key: 'question', label: 'Posent une question' },
  { key: 'commentaire', label: 'Ont simplement commenté' },
  { key: 'abonne', label: 'Abonnés qu’on peut aborder' },
]
export const SEGMENT_LABELS = Object.fromEntries(SEGMENTS.map(s => [s.key, s.label]))
const SEGMENT_KEYS = new Set(SEGMENTS.map(s => s.key))

export const SEGMENT_DEFAULT_CONFIG = {
  model: 'gpt-4o-mini',
  max_per_run: '120',
  // Au-dessus de ce score, la fiche est supprimée sans même demander au modèle.
  bot_threshold: '4',
  // Lecture des profils publics : petits lots, relus au plus tous les N jours.
  profiles_per_run: '25',
  profile_refresh_days: '30',
  profile_model: 'gpt-4o-mini',
  msg_coach:
    "Elle a demandé le coaching. Confirme-lui qu'elle est au bon endroit, dis en une phrase ce " +
    "qu'elle y trouve, et demande-lui où elle en est dans sa saison.",
  msg_fleurs:
    "Elle fait pousser des fleurs. Parle fleurs, pas légumes : parle-lui de ce que le contrôle du " +
    "climat change pour une culture de fleurs, et demande-lui ce qu'elle cultive.",
  msg_abonne:
    "Elle nous suit sans rien avoir demandé. Aborde-la simplement, sans rien vendre, et demande-lui " +
    "ce qu'elle cultive.",
  msg_question:
    "Elle pose une vraie question technique. Ne l'invente pas : propose une réponse prudente en une " +
    "phrase, dis qu'un de nos gens va lui confirmer, et laisse la porte ouverte. Philippe relira.",
  msg_commentaire:
    "Elle a simplement réagi à une publication. Une phrase chaleureuse qui reprend ce qu'elle a dit, " +
    "puis UNE question ouverte sur ce qu'elle cultive. Pas de lien, pas d'offre.",
}

export function getSegmentConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get(SEGMENT_AUTOMATION_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch { /* config illisible : on garde les défauts */ }
  const merged = { ...SEGMENT_DEFAULT_CONFIG }
  for (const k of Object.keys(SEGMENT_DEFAULT_CONFIG)) {
    if (cfg[k] != null && String(cfg[k]).trim() !== '') merged[k] = String(cfg[k]).trim()
  }
  return merged
}

/** Les consignes d'écriture propres à un type de demande. */
export function instructionsForSegment(segment) {
  const cfg = getSegmentConfig()
  return cfg[`msg_${segment}`] || cfg.msg_commentaire
}

// ── Robots ──────────────────────────────────────────────────────────────────
//
// Un seul indice ne suffit jamais : c'est l'accumulation qui condamne. Chaque
// signal vaut son poids, et le total se compare au seuil réglable.

const BOT_SIGNALS = [
  [3, 'vend des abonnés', p => /\b(followers?|follow4follow|f4f|likes?|gain|boost|grow ?your|promo(tion)?s?|seo|smm)\b/i.test(`${p.ig_username} ${p.full_name || ''}`)],
  [3, 'crypto ou récupération de compte', p => /\b(crypto|bitcoin|btc|forex|trading|invest(ment)?|binary|recovery|recover|hack(er|ing)?|ethical)\b/i.test(`${p.ig_username} ${p.full_name || ''} ${p.text || ''}`)],
  [3, 'lien de redirection dans le message', p => /\b(t\.me\/|wa\.me\/|bit\.ly|tinyurl|cutt\.ly|whatsapp\s*:?\s*\+?\d)/i.test(p.text || '')],
  [2, 'demande d’aller voir son profil', p => /\b(check (out )?my (profile|page|bio)|dm me|inbox me|link in bio|message me now|contact me on)\b/i.test(p.text || '')],
  [2, 'nom d’usager fabriqué', p => /^[a-z]+[._]?\d{6,}$/i.test(p.ig_username || '') || /(.)\1{4,}/.test(p.ig_username || '')],
  [2, 'compte sans nom ni mot écrit', p => !p.full_name && !String(p.text || '').trim()],
  [2, 'flatterie de masse', p => /\b(nice (post|page|profile|content)|great (post|content)|amazing (post|page)|love your (page|content))\b\s*[!.]*$/i.test(String(p.text || '').trim())],
  [1, 'suite de chiffres dans le nom', p => (String(p.ig_username || '').match(/\d/g) || []).length >= 6],
  [1, 'écrit uniquement en émojis', p => {
    const t = String(p.text || '').trim()
    return !!t && !/[a-z0-9]/i.test(t)
  }],
  // Indices du profil lu — seulement quand il a vraiment été lu. Un profil
  // vide pèse peu : beaucoup de vraies gens regardent sans rien publier.
  [1, 'profil vide (ni bio ni publication)', p => ['ok', 'private'].includes(p.profile?.status) &&
    !String(p.profile.bio || '').trim() && p.profile.media_count === 0],
  [3, 'bio de vendeur d’abonnés', p => /\b((buy|get|gain|cheap|real)\s+(\d+k?\s*)?(followers|likes)|followers?\s*(&|and|\+)\s*likes|smm|promo(tion)? (page|service)|dm (for|to) (promo|promotion)|crypto|forex|bitcoin|account recovery|hacker)\b/i.test(p.profile?.bio || '')],
]

/** Ce que la lecture automatique retient contre une fiche. */
export function botSignals(p) {
  const reasons = []
  let score = 0
  for (const [weight, label, test] of BOT_SIGNALS) {
    let hit = false
    try { hit = test(p) } catch { hit = false }
    if (hit) { score += weight; reasons.push(label) }
  }
  return { score, reasons }
}

// ── Ce que la personne a réellement écrit ───────────────────────────────────

const STORY_KINDS = new Set(['story_reply', 'story_reply_to', 'story_mention'])

function isStoryText(t) {
  return /^(💬 A répondu à une story|💬 Réponse à une story|📣 Mention dans une story)/u.test(String(t || '').trim())
}

/** Les mots de la personne, sans nos étiquettes d'activité. */
function ownWords(text) {
  const t = String(text || '').trim()
  if (!t) return ''
  const quoted = t.match(/^📝 A commenté « (.*) »$/)
  if (quoted) return quoted[1]
  if (/^(📝|💬 A |💬 Réponse|📣|🔗|✨|📎|📷|🎬|🎧|👤)/u.test(t)) return ''
  return t
}

/**
 * Une fiche dont la SEULE trace est une réponse à une story : Charles ne veut
 * pas les voir. Celle qui a répondu à une story ET écrit autre chose reste.
 */
export function isStoryOnly({ first_comment_text, incoming = [] }) {
  if (String(first_comment_text || '').trim()) return false
  if (!incoming.length) return false
  let story = false
  for (const m of incoming) {
    const storyish = STORY_KINDS.has(m.kind) || isStoryText(m.text)
    if (storyish) { story = true; continue }
    if (m.kind === 'user_thread_new' || m.kind === 'click_url') continue
    if (ownWords(m.text)) return false
  }
  return story
}

// ── Déjà traité ─────────────────────────────────────────────────────────────

/**
 * Un message parti de la boîte de réception Instagram elle-même (« echo ») a
 * été écrit par un humain — ce n'est pas la réponse automatique de ManyChat,
 * qui, elle, part par l'API. Quelqu'un à qui on a déjà écrit de cette façon est
 * traité, point.
 */
export function markAlreadyHandled() {
  const rows = db.prepare(`
    SELECT p.id, MAX(m.sent_at) AS last_out
    FROM instagram_prospects p
    JOIN manychat_threads t ON t.prospect_id = p.id OR t.user_id = p.manychat_subscriber_id
    JOIN manychat_messages m ON m.user_id = t.user_id AND m.kind = 'msgout_echo_instagram'
    WHERE p.deleted_at IS NULL AND p.contacted = 0
    GROUP BY p.id
  `).all()
  const upd = db.prepare(`
    UPDATE instagram_prospects
    SET contacted = 1, contacted_at = ?, contacted_source = 'dm_human',
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ? AND contacted = 0
  `)
  let n = 0
  db.transaction(() => {
    for (const r of rows) { n += upd.run(r.last_out || new Date().toISOString(), r.id).changes }
  })()
  return n
}

// ── Classement ──────────────────────────────────────────────────────────────

function candidates(limit, onlyIds = null) {
  return db.prepare(`
    SELECT p.id, p.ig_username, p.full_name, p.keyword, p.has_keyword, p.capture_kind,
           p.capture_label, p.first_comment_text, p.last_comment_text,
           p.segment, p.segment_source, t.user_id AS thread_id,
           p.profile_json, p.profile_status, p.profile_who, p.profile_activity, p.profile_level
    FROM instagram_prospects p
    LEFT JOIN manychat_threads t ON t.prospect_id = p.id OR t.user_id = p.manychat_subscriber_id
    WHERE p.deleted_at IS NULL AND p.ig_username IS NOT NULL
      AND p.segment_source IS NOT 'manual'
      AND (p.segment IS NULL OR p.segment_at IS NULL)
      ${onlyIds?.length ? `AND p.id IN (${onlyIds.map(() => '?').join(',')})` : ''}
    GROUP BY p.id
    ORDER BY COALESCE(p.last_event_at, p.created_at) DESC
    LIMIT ?
  `).all(...(onlyIds || []), limit)
}

function incomingOf(threadId) {
  if (!threadId) return []
  return db.prepare(`
    SELECT direction, text, kind, sent_at FROM manychat_messages
    WHERE user_id = ? AND direction = 'in' ORDER BY sent_at
  `).all(String(threadId))
}

function saidByPerson(p, incoming) {
  const parts = [p.first_comment_text, p.last_comment_text]
  for (const m of incoming) { const w = ownWords(m.text); if (w) parts.push(w) }
  return [...new Set(parts.filter(Boolean))].join(' · ').slice(0, 600)
}

/** Ce qui se décide sans modèle : le mot-clé, et la fiche muette. */
function ruleSegment(p, said) {
  if (/\bcoach(ing)?\b/i.test(`${p.keyword || ''} ${p.capture_label || ''} ${said}`)) return 'coach'
  if (!said.trim()) return 'abonne'
  if (/\?/.test(said)) return 'question'
  return null
}

async function askModel(model, batch) {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY non configuré')
  const system =
    "Tu tries des contacts Instagram d'Orisha, qui vend du contrôle du climat en serre. " +
    'Pour CHAQUE personne, donne : ' +
    '"segment" parmi "coach" (elle demande le programme de coaching), "fleurs" (UNIQUEMENT si son ' +
    'profil dit « activité : Fleurs coupées » — jamais sur un commentaire seul, un émoji 🌱 ou le mot ' +
    '« plants » ; sans profil lu, jamais "fleurs"), "question" (elle pose une vraie question, technique ou ' +
    'commerciale, qui attend une réponse), "commentaire" (elle a seulement réagi : compliment, blague, ' +
    'remarque, critique), "abonne" (elle n\'a rien écrit du tout) ; ' +
    'et "bot" : true seulement si c\'est manifestement un faux compte, un démarcheur, une arnaque ' +
    'de récupération de compte ou un vendeur d\'abonnés — un vrai maraîcher maladroit n\'est PAS un bot. ' +
    'Réponds en JSON strict : { "results": [ { "i": <numéro>, "segment": "…", "bot": true|false } ] }.'
  const lines = batch.map((b, i) => {
    const bits = [`#${i} @${b.p.ig_username}`]
    if (b.p.full_name) bits.push(`nom: ${b.p.full_name}`)
    if (b.p.capture_label) bits.push(`geste: ${b.p.capture_label}`)
    if (b.p.profile_who) bits.push(`profil: ${b.p.profile_who}`)
    if (b.p.profile_activity) bits.push(`activité: ${ACTIVITIES[b.p.profile_activity] || b.p.profile_activity}${b.p.profile_level ? ` (${b.p.profile_level})` : ''}`)
    if (b.profile?.bio) bits.push(`bio: ${String(b.profile.bio).replace(/\s+/g, ' ').slice(0, 160)}`)
    if (b.said) bits.push(`dit: « ${b.said} »`)
    if (b.signals.reasons.length) bits.push(`indices: ${b.signals.reasons.join(', ')}`)
    return bits.join(' | ')
  }).join('\n')
  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      response_format: { type: 'json_object' },
      temperature: 0,
      messages: [{ role: 'system', content: system }, { role: 'user', content: lines }],
    }),
  })
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}))
    throw new Error(err.error?.message || `OpenAI HTTP ${resp.status}`)
  }
  const data = await resp.json()
  let parsed = {}
  try { parsed = JSON.parse(data.choices?.[0]?.message?.content || '{}') } catch { parsed = {} }
  return Array.isArray(parsed.results) ? parsed.results : []
}

/** Écarte définitivement un compte : la fiche part, le nom d'usager reste bloqué. */
export function blockAsBot(prospectId, username, reason, score) {
  db.prepare(`
    INSERT INTO instagram_blocked (ig_username, reason, score) VALUES (?,?,?)
    ON CONFLICT(ig_username) DO UPDATE SET reason=excluded.reason, score=excluded.score
  `).run(String(username || '').toLowerCase(), reason || null, score || null)
  db.prepare(`
    UPDATE instagram_prospects
    SET segment = 'robot', segment_source = 'ai', bot_reason = ?, bot_score = ?,
        deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(reason || null, score || null, prospectId)
}

/** Repêcher un compte écarté par erreur : la fiche revient, le blocage tombe. */
export function unblock(username) {
  const u = String(username || '').toLowerCase()
  db.prepare('DELETE FROM instagram_blocked WHERE ig_username = ?').run(u)
  return db.prepare(`
    UPDATE instagram_prospects
    SET deleted_at = NULL, segment = NULL, segment_source = NULL, segment_at = NULL,
        bot_score = NULL, bot_reason = NULL,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE lower(ig_username) = ? AND segment = 'robot'
  `).run(u).changes
}

export function isBlockedUsername(username) {
  if (!username) return false
  return !!db.prepare('SELECT 1 FROM instagram_blocked WHERE ig_username = ?').get(String(username).toLowerCase())
}

/** Réponse à une story et rien d'autre : hors de la liste, sans être perdue. */
function markStoryOnly(prospectId) {
  db.prepare(`
    UPDATE instagram_prospects
    SET segment = 'story', segment_source = 'rule',
        segment_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(prospectId)
}

export function setSegment(prospectId, segment, source = 'manual') {
  if (!SEGMENT_KEYS.has(segment)) throw new Error('Type de demande inconnu')
  db.prepare(`
    UPDATE instagram_prospects
    SET segment = ?, segment_source = ?, segment_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(segment, source, prospectId)
  return { ok: true }
}

/**
 * Tournée de classement : marque les fiches déjà traitées, supprime les robots,
 * range le reste par type de demande.
 */
export async function runSegmentation({ force = false, trigger = 'schedule', ids = null, profiles = true } = {}) {
  const t0 = Date.now()
  try {
    if (!force && !isSystemAutomationActive(SEGMENT_AUTOMATION_ID)) return { skipped: 'inactive' }
    const cfg = getSegmentConfig()
    const threshold = Math.max(2, Number(cfg.bot_threshold) || 4)
    const handled = markAlreadyHandled()

    // D'abord lire quelques profils : une fiche lue se remet d'elle-même au tri.
    // Une session morte arrête la lecture, jamais le tri.
    const prof = profiles
      ? await readProfiles({
        limit: ids?.length || Math.max(0, Number.isFinite(Number(cfg.profiles_per_run)) ? Number(cfg.profiles_per_run) : 25),
        refreshDays: Math.max(1, Number(cfg.profile_refresh_days) || 30),
        model: cfg.profile_model,
        ids,
      }).catch(e => ({ read: 0, stopped: e.message, problems: [] }))
      : null

    const rows = candidates(Math.max(1, Number(cfg.max_per_run) || 120), ids)
    const prepared = rows.map(p => {
      const incoming = incomingOf(p.thread_id)
      const said = saidByPerson(p, incoming)
      const profile = p.profile_status ? { ...(profileOf(p) || {}), status: p.profile_status } : null
      return { p, said, incoming, profile, signals: botSignals({ ...p, text: said, profile }) }
    })

    let robots = 0, classed = 0
    const toAsk = []
    for (const b of prepared) {
      if (b.signals.score >= threshold) {
        blockAsBot(b.p.id, b.p.ig_username, b.signals.reasons.join(', '), b.signals.score)
        robots++
        continue
      }
      if (isStoryOnly({ first_comment_text: b.p.first_comment_text, incoming: b.incoming })) {
        markStoryOnly(b.p.id)
        classed++
        continue
      }
      const rule = ruleSegment(b.p, b.said)
      if (rule === 'coach') { setSegment(b.p.id, 'coach', 'rule'); classed++; continue }
      toAsk.push(b)
    }

    const problems = []
    const changed = []
    for (let i = 0; i < toAsk.length; i += 15) {
      const batch = toAsk.slice(i, i + 15)
      let results = []
      try { results = await askModel(cfg.model, batch) } catch (e) { problems.push(e.message); continue }
      const byIndex = new Map(results.map(r => [Number(r.i), r]))
      batch.forEach((b, k) => {
        const r = byIndex.get(k)
        // Le modèle seul ne suffit pas à supprimer : une fiche sans un mot
        // écrit lui ressemble à un faux compte, alors que c'est souvent une
        // vraie ferme qui n'a rien dit. Il faut au moins un indice concret.
        if (r?.bot && b.signals.score > 0) {
          blockAsBot(b.p.id, b.p.ig_username, b.signals.reasons.join(', ') || 'faux compte', b.signals.score)
          robots++
          return
        }
        let seg = SEGMENT_KEYS.has(r?.segment) ? r.segment : (ruleSegment(b.p, b.said) || 'commentaire')
        // « Fleurs » exige la preuve du profil : sans elle, le message fleurs
        // tombe à côté (un potager de cuisine n'est pas une ferme de fleurs).
        if (seg === 'fleurs' && !b.profile?.ai?.flowers_main) seg = ruleSegment(b.p, b.said) || 'commentaire'
        if (seg !== b.p.segment) changed.push(b.p.id)
        setSegment(b.p.id, seg, 'ai')
        classed++
      })
    }

    const rewritten = await rewriteStaleDrafts(changed)
    const summary = `${classed} fiche(s) rangée(s) dont ${changed.length} changée(s) de pile, ` +
      `${robots} robot(s) supprimé(s), ${handled} déjà traitée(s)` +
      (prof ? ` · ${prof.read || 0} profil(s) lu(s)` + (prof.stopped ? ` — lecture arrêtée : ${prof.stopped}` : '') : '') +
      (problems.length ? ` · ${problems.length} échec(s)` : '')
    logSystemRun(SEGMENT_AUTOMATION_ID, {
      status: problems.length && !classed ? 'error' : 'success',
      duration_ms: Date.now() - t0, triggerData: { trigger }, result: summary,
    })
    return { ok: true, classed, changed, robots, handled, rewritten, profiles: prof, problems, summary }
  } catch (e) {
    logSystemRun(SEGMENT_AUTOMATION_ID, { status: 'error', duration_ms: Date.now() - t0, triggerData: { trigger }, error: e })
    return { error: e.message }
  }
}

/**
 * Une fiche qui change de pile ne garde pas le message écrit pour l'ancienne :
 * il est réécrit, sauf s'il a été retouché à la main ou part déjà.
 */
async function rewriteStaleDrafts(prospectIds) {
  if (!prospectIds.length) return 0
  const { writeDraft } = await import('./instagramDrafts.js')
  let n = 0
  for (const id of prospectIds) {
    const d = db.prepare(`
      SELECT id FROM instagram_drafts WHERE prospect_id = ? AND status IN ('draft','review','held') AND COALESCE(edited,0) = 0
    `).get(id)
    if (!d) continue
    try { await writeDraft(id, { force: true }); n++ } catch { /* le message reste, Philippe peut « Réécrire » */ }
  }
  return n
}

/** Remet au tri les fiches non choisies à la main (toutes, ou celles d'une pile). */
export function requeueForSegmentation({ segment = null } = {}) {
  return db.prepare(`
    UPDATE instagram_prospects SET segment_at = NULL
    WHERE deleted_at IS NULL AND segment_source IS NOT 'manual'
      AND COALESCE(segment,'') NOT IN ('robot','story')
      ${segment ? 'AND segment = ?' : ''}
  `).run(...(segment ? [segment] : [])).changes
}

export function previewSegmentation() {
  const cfg = getSegmentConfig()
  const todo = candidates(9999).length
  const bySeg = db.prepare(`
    SELECT COALESCE(segment,'non classé') s, COUNT(*) n FROM instagram_prospects
    WHERE deleted_at IS NULL AND ig_username IS NOT NULL GROUP BY 1 ORDER BY n DESC
  `).all()
  const handled = db.prepare(`
    SELECT COUNT(DISTINCT p.id) n FROM instagram_prospects p
    JOIN manychat_threads t ON t.prospect_id = p.id OR t.user_id = p.manychat_subscriber_id
    JOIN manychat_messages m ON m.user_id = t.user_id AND m.kind = 'msgout_echo_instagram'
    WHERE p.deleted_at IS NULL AND p.contacted = 0
  `).get().n
  return {
    a_classer: todo,
    deja_traites_a_sortir: handled,
    robots_deja_ecartes: db.prepare('SELECT COUNT(*) n FROM instagram_blocked').get().n,
    repartition: bySeg.map(r => `${r.s} : ${r.n}`).join(' · '),
    seuil_robot: cfg.bot_threshold,
    modele: cfg.model,
  }
}
