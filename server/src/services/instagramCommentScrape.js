// Prospects Instagram — captation par LECTURE DES COMMENTAIRES.
//
// Second chemin de captation, complémentaire du webhook ManyChat
// (instagramProspects.js) : on lit nous-mêmes les commentaires des publications
// du compte via l'API web privée d'Instagram (celle que le site utilise), on
// garde ceux qui contiennent le mot-clé, et on les fait entrer par la MÊME
// porte d'ingestion que ManyChat — donc même dédup, même fusion de fiches,
// même miroir Airtable, même digest hebdomadaire.
//
// POURQUOI EN PLUS de ManyChat :
//  • ManyChat ne voit que ce que son flow a capté, et seulement pendant qu'il
//    tourne. Un flow arrêté, une panne, un ajout de mot-clé rétroactif → des
//    commentateurs perdus. Ici on relit la semaine entière, à volonté.
//  • Aucune revue d'application Meta, aucun forfait : c'est une lecture.
//
// PUBLICATIONS EN COLLAB : une publication en collaboration est UN SEUL média,
// avec UN SEUL fil de commentaires, affiché sur la grille des deux comptes. On
// lit donc plusieurs comptes (`accounts`) et on dédoublonne les médias par leur
// `pk` — peu importe lequel des deux a publié, la publication est vue une fois
// et ses commentaires sont lus une fois. C'est ce qui lève la limite notée dans
// instagramProspects.js, qui ne valait que pour l'API Graph : là, ManyChat ne
// reçoit les commentaires que si notre compte est l'éditeur.
//
// LIMITE ASSUMÉE : ça demande un cookie de session d'un compte connecté
// (`sessionid`), à coller dans Connecteurs → Instagram. Il expire ~1 fois par
// an ; Instagram répond alors 401 et l'automation journalise une ERREUR
// explicite (jamais un silence). Le compte connecté doit pouvoir voir les
// publications des comptes lus (comptes publics, ou abonnement accepté).
//
// Rate limit : Instagram étrangle au-delà de quelques centaines d'appels. On
// dort entre chaque appel et on recule exponentiellement sur 429/560. Une
// semaine de publications prend moins d'une minute.
import db from '../db/database.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'
import { recordSessionStatus } from './sessionHealth.js'
import { localDay, isoWeekKey, isoWeekday } from './marketingBudget.js'
import {
  ingestManychatEvent,
  pushToAirtable,
  detectKeyword,
  normalizeUsername,
  localHour,
} from './instagramProspects.js'

export const INSTAGRAM_SCRAPE_AUTOMATION_ID = 'sys_instagram_comment_scrape'

export const API_ROOT = 'https://www.instagram.com/api/v1'
const WEB_APP_ID = '936619743392459'
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

// Pages de commentaires maximum par publication. 20 × ~20 commentaires couvre
// largement nos publications ; le plafond existe pour qu'une publication virale
// ne fasse pas boucler la tournée pendant des heures.
const MAX_COMMENT_PAGES = 20

export const INSTAGRAM_SCRAPE_DEFAULT_CONFIG = {
  accounts: 'orisha_auto, growingformarketmagazine', // comptes dont on lit les publications (virgules)
  our_accounts: 'orisha_auto',   // une publication n'est retenue que si un de ces comptes en est l'auteur ou le co-auteur
  keywords: 'coach',             // ne filtre plus rien (tout le monde est capté) — sert à prioriser/étiqueter
  lookback_days: '7',            // la semaine qui vient de finir (tournée = lundi minuit)
  own_accounts: 'orisha_auto, growingformarketmagazine', // jamais des prospects
  run_weekday: '1',              // ISO : 1 = lundi — minuit dans la nuit de dimanche à lundi
  run_hour: '0',                 // heure de Montréal
}

function loadConfig() {
  const row = db.prepare('SELECT action_config FROM automations WHERE id=?').get(INSTAGRAM_SCRAPE_AUTOMATION_ID)
  let cfg = {}
  try { cfg = JSON.parse(row?.action_config || '{}') } catch {}
  const merged = { ...INSTAGRAM_SCRAPE_DEFAULT_CONFIG }
  for (const k of Object.keys(INSTAGRAM_SCRAPE_DEFAULT_CONFIG)) {
    // `keywords` peut légitimement être vidé (capter tout le monde) : on
    // distingue « absent » de « vidé exprès », contrairement aux autres clés.
    if (cfg[k] == null) continue
    const v = String(cfg[k]).trim()
    if (v !== '' || k === 'keywords') merged[k] = v
  }
  return merged
}

export function getScrapeConfig() { return loadConfig() }

/** 'orisha_auto, @growingformarketmagazine' → ['orisha_auto', 'growingformarketmagazine'] */
export function splitAccounts(value) {
  const out = []
  for (const raw of String(value || '').split(',')) {
    const u = normalizeUsername(raw)
    if (u && !out.some(x => x.toLowerCase() === u.toLowerCase())) out.push(u)
  }
  return out
}

// ── Session Instagram ───────────────────────────────────────────────────────
// Le cookie vit dans connector_config (rotatable depuis Connecteurs), avec
// repli sur l'environnement pour un dépannage rapide.

export function getSessionCookie() {
  const get = key => db.prepare("SELECT value FROM connector_config WHERE connector='instagram' AND key=?").get(key)?.value
  const sessionid = String(get('sessionid') || process.env.IG_SESSIONID || '').trim()
  const dsUserId = String(get('ds_user_id') || process.env.IG_DS_USER_ID || '').trim()
  return { sessionid, dsUserId }
}

export function hasSessionCookie() { return getSessionCookie().sessionid.length >= 20 }

const sleep = ms => new Promise(r => setTimeout(r, ms))

/** Erreur qui doit arrêter la tournée immédiatement (cookie mort). */
class SessionExpired extends Error {}

/**
 * Instagram nous met de côté sans nous déconnecter : il renvoie l'appel vers
 * sa page d'accueil (302) au lieu de répondre. Ça arrive après une rafale
 * d'appels. Ce n'est PAS un cookie mort — envoyer quelqu'un en recoller un
 * serait une fausse piste — mais ça arrête quand même la tournée, bruyamment.
 */
class Throttled extends Error {}

/**
 * GET avec repli exponentiel. Renvoie le JSON, ou null quand les tentatives
 * sont épuisées (publication sautée, tournée poursuivie). Un 401/403 lève
 * SessionExpired : inutile d'insister, et le message doit remonter clair.
 */
export async function igGet(url, { sessionid, dsUserId }, attempts = 4) {
  const cookie = [`sessionid=${sessionid}`, dsUserId ? `ds_user_id=${dsUserId}` : null].filter(Boolean).join('; ')
  for (let i = 0; i < attempts; i++) {
    let res
    try {
      res = await fetch(url, {
        headers: {
          'x-ig-app-id': WEB_APP_ID, 'User-Agent': UA, cookie, accept: '*/*',
          // Sans ces en-têtes, Instagram répond 400 « SecFetch Policy violation »
          // même avec un cookie valide — il vérifie qu'une requête « same-origin »
          // ressemble à celle d'un vrai onglet du navigateur.
          referer: 'https://www.instagram.com/',
          'x-requested-with': 'XMLHttpRequest',
          'sec-fetch-site': 'same-origin',
          'sec-fetch-mode': 'cors',
          'sec-fetch-dest': 'empty',
        },
        signal: AbortSignal.timeout(30_000),
        // Sans « manual », un cookie mort part en boucle de redirections vers
        // la page de connexion et fetch finit par lever « redirect count
        // exceeded » — une panne réseau indistinguable d'une vraie, donc une
        // tournée qui ne lit AUCUN commentaire en se déclarant réussie.
        redirect: 'manual',
      })
    } catch {
      await sleep(2 ** i * 1000 + Math.random() * 1000)
      continue
    }
    if (res.ok) {
      await sleep(400 + Math.random() * 500)   // politesse : ~0,4–0,9 s entre appels
      try { return await res.json() } catch { return null }
    }
    // Instagram ne répond pas toujours 401 : sur certaines routes il renvoie une
    // redirection. Vers /accounts/login = déconnecté. Ailleurs (son accueil) =
    // il nous met de côté, sans nous déconnecter : on retente, puis on abandonne
    // en le disant — jamais en se taisant.
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location') || ''
      if (/\/(accounts\/login|login|signin)\b/i.test(loc)) {
        throw new SessionExpired(
          'Instagram renvoie vers la page de connexion — le cookie de session est expiré ou invalide. ' +
          'Recoller un « sessionid » frais dans Connecteurs → Instagram.'
        )
      }
      if (i === attempts - 1) {
        throw new Throttled(
          'Instagram refuse de répondre pour le moment (trop d\'appels rapprochés) : la session reste valide, ' +
          'il faut simplement relancer la lecture plus tard.'
        )
      }
      await sleep(2 ** i * 4000 + Math.random() * 2000)
      continue
    }
    if (res.status === 401 || res.status === 403) {
      throw new SessionExpired(
        `Instagram a répondu ${res.status} — le cookie de session est expiré ou invalide. ` +
        'Recoller un « sessionid » frais dans Connecteurs → Instagram.'
      )
    }
    await sleep(2 ** i * 1000 + Math.random() * 1000)
  }
  return null
}

/** Publications du compte dans [sinceTs, untilTs). Remonte le fil du plus récent. */
async function fetchPosts(account, session, sinceTs, untilTs) {
  const out = []
  let maxId = null
  // Plafond de pagination : 20 pages × 12 = 240 publications, très au-delà de
  // n'importe quelle fenêtre raisonnable. Empêche une boucle infinie si
  // `more_available` reste vrai sans que `next_max_id` avance.
  for (let page = 0; page < 20; page++) {
    let url = `${API_ROOT}/feed/user/${encodeURIComponent(account)}/username/?count=12`
    if (maxId) url += `&max_id=${encodeURIComponent(maxId)}`
    const payload = await igGet(url, session)
    const items = payload?.items || []
    if (!items.length) break
    for (const item of items) {
      if (item.taken_at >= sinceTs && item.taken_at < untilTs) out.push(item)
    }
    // Tout le lot est plus vieux que la borne : le fil étant antichronologique,
    // la suite l'est aussi.
    if (items.every(i => i.taken_at < sinceTs)) break
    if (!payload.more_available || !payload.next_max_id) break
    maxId = payload.next_max_id
  }
  return out
}

/**
 * La publication est-elle À NOUS ?
 *
 * Lire le fil de @growingformarketmagazine sert à attraper les publications
 * faites EN COLLABORATION avec nous (un seul média, un seul fil, affiché sur
 * les deux grilles). Mais leur fil contient aussi leurs publications à eux
 * seuls — concours « commentez Subscribe », appels à leur infolettre — dont
 * les commentateurs ne sont pas nos prospects.
 *
 * Instagram donne l'auteur (`user`) et les co-auteurs (`coauthor_producers`,
 * plus `invited_coauthor_producers` tant que l'invitation n'est pas acceptée).
 * On retient la publication si l'un de nos comptes figure dans l'un des trois.
 * `ours` vide = aucun filtre (tout est retenu), pour ne jamais tout jeter sur
 * une configuration effacée par mégarde.
 */
export function postInvolvesUs(post, ours) {
  if (!ours || !ours.size) return true
  const names = [
    post?.user?.username,
    ...(post?.coauthor_producers || []).map(c => c?.username),
    ...(post?.invited_coauthor_producers || []).map(c => c?.username),
  ]
  return names.some(n => {
    const u = normalizeUsername(n)
    return u ? ours.has(u.toLowerCase()) : false
  })
}

/**
 * Commentaires d'une publication, réponses incluses (`is_reply`).
 *
 * Chaque commentaire top-level porte `repliedByUs` : vrai si un de ses
 * `preview_child_comments` (les réponses affichées sous lui) vient d'un des
 * `ownUsernames` — signe qu'on a déjà répondu publiquement à cette personne,
 * donc qu'elle n'a pas besoin d'être recontactée.
 */
async function fetchComments(mediaId, session, ownUsernames) {
  const out = []
  let minId = null
  for (let page = 0; page < MAX_COMMENT_PAGES; page++) {
    let url = `${API_ROOT}/media/${mediaId}/comments/?can_support_threading=true`
    if (minId) url += `&min_id=${encodeURIComponent(minId)}`
    const payload = await igGet(url, session)
    if (!payload) break
    for (const c of payload.comments || []) {
      const replies = c.preview_child_comments || []
      const ourReply = replies.find(r => ownUsernames.has(normalizeUsername(r.user?.username)?.toLowerCase()))
      out.push({
        ...normalizeComment(c), is_reply: false,
        repliedByUs: !!ourReply,
        repliedAt: ourReply?.created_at ? new Date(ourReply.created_at * 1000).toISOString() : null,
      })
      for (const r of replies) {
        out.push({ ...normalizeComment(r), is_reply: true, repliedByUs: false, repliedAt: null })
      }
    }
    minId = payload.next_min_id
    if (!minId) break
  }
  return out
}

/** Marque une fiche contactée avec sa source, sans jamais écraser une marque existante. */
function markContacted(prospectId, source, when) {
  db.prepare(`
    UPDATE instagram_prospects
    SET contacted = 1, contacted_source = ?, contacted_at = COALESCE(contacted_at, ?),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ? AND contacted = 0
  `).run(source, when || new Date().toISOString(), prospectId)
}

function normalizeComment(c) {
  return {
    pk: String(c.pk ?? c.id ?? ''),
    username: normalizeUsername(c.user?.username),
    // L'IGSID porte la dédup : il survit à un changement de nom d'usager, donc
    // à la personne qui commente une 2e fois sous un autre pseudo.
    user_id: c.user?.pk != null ? String(c.user.pk) : null,
    full_name: c.user?.full_name || null,
    text: String(c.text || ''),
    created_at: c.created_at ? new Date(c.created_at * 1000).toISOString() : null,
  }
}

/**
 * Une tournée. Chaque commentaire retenu entre par ingestManychatEvent avec
 * `event_id` = pk du commentaire : relire deux fois la même semaine ne crée
 * aucun doublon et ne regonfle aucun compteur.
 *
 * `force` court-circuite jour et heure (bouton « Exécuter »).
 */
export async function runCommentScrape({ force = false, trigger = 'schedule', days = null, today = null, hour = null } = {}) {
  const t0 = Date.now()
  const cfg = loadConfig()
  try {
    if (!force && !isSystemAutomationActive(INSTAGRAM_SCRAPE_AUTOMATION_ID)) return { skipped: 'inactive' }

    if (!force) {
      const dayIso = today || localDay()
      const runDay = Math.min(7, Math.max(1, Number(cfg.run_weekday) || 1))
      // `|| 0` serait absorbé par 0 lui-même : Number('') vaut 0, ce qui est la
      // valeur voulue. On ne passe donc PAS par un `||` de repli ici.
      const runHour = Math.min(23, Math.max(0, Number(cfg.run_hour) || 0))
      if (isoWeekday(dayIso) !== runDay) return { ok: true, ran: false, reason: "pas le jour de la tournée" }
      if ((hour == null ? localHour() : Number(hour)) !== runHour) return { ok: true, ran: false, reason: "pas l'heure de la tournée" }
    }

    const session = getSessionCookie()
    if (!session.sessionid) {
      throw new Error(
        "Aucun cookie de session Instagram. Le coller dans Connecteurs → Instagram " +
        '(DevTools → Application → Cookies → instagram.com → sessionid).'
      )
    }

    const lookback = Math.min(365, Math.max(1, Number(days ?? cfg.lookback_days) || 10))
    const untilTs = Math.floor(Date.now() / 1000)
    const sinceTs = untilTs - lookback * 86400
    const accounts = splitAccounts(cfg.accounts)
    if (!accounts.length) throw new Error("Aucun compte Instagram configuré (champ « accounts » de l'automation)")
    const own = new Set(
      String(cfg.own_accounts || '').split(',').map(s => normalizeUsername(s)?.toLowerCase()).filter(Boolean)
    )

    // Dédup par `pk` du média : une publication en collab apparaît sur la
    // grille des deux comptes, mais n'a qu'un seul fil de commentaires.
    const byMedia = new Map()
    for (const account of accounts) {
      for (const post of await fetchPosts(account, session, sinceTs, untilTs)) {
        if (!byMedia.has(String(post.pk))) byMedia.set(String(post.pk), post)
      }
    }
    const ours = new Set(
      String(cfg.our_accounts || '').split(',').map(s => normalizeUsername(s)?.toLowerCase()).filter(Boolean)
    )
    const allPosts = [...byMedia.values()]
    const posts = allPosts.filter(p => postInvolvesUs(p, ours))
    const skippedPosts = allPosts.length - posts.length
    const withComments = posts.filter(p => p.comment_count)

    let scanned = 0, matched = 0, created = 0, updated = 0, duplicates = 0, repliedByUsCount = 0
    const toPush = new Set()
    for (const post of withComments) {
      const postUrl = post.code ? `https://www.instagram.com/p/${post.code}/` : null
      for (const c of await fetchComments(post.pk, session, own)) {
        scanned++
        if (!c.username || own.has(c.username.toLowerCase())) continue
        // `keywords` ne FILTRE plus rien (tous les commentaires sont captés) :
        // il sert seulement à étiqueter/prioriser (has_keyword), avec
        // tolérance aux fautes de frappe (detectKeyword).
        const keyword = detectKeyword(c.text, cfg.keywords || 'coach')
        matched++

        const res = ingestManychatEvent({
          flow: 'comment',
          event_id: c.pk ? `scrape:${c.pk}` : undefined,
          ig_username: c.username,
          ig_user_id: c.user_id,
          full_name: c.full_name,
          comment_text: c.text,
          occurred_at: c.created_at,
          post_url: postUrl,
          keyword,
          source: 'scrape',
        })
        if (!res.ok) continue

        // Le signal « réponse publique » s'applique MÊME si le commentaire est
        // déjà connu (dédupliqué) : une fiche créée avant que ce signal existe,
        // ou lue une semaine puis répondue la suivante, doit être rattrapée —
        // pas seulement les commentaires tout juste ingérés.
        if (c.repliedByUs && res.prospect?.id && !res.prospect.contacted) {
          markContacted(res.prospect.id, 'public_reply', c.repliedAt)
          repliedByUsCount++
          toPush.add(res.prospect.id)
        }

        if (res.duplicate) { duplicates++; continue }
        if (res.is_new) created++; else updated++
        if (res.prospect?.id) toPush.add(res.prospect.id)
      }
    }

    // Garde-fou : des publications qui portent des commentaires mais pas un
    // seul commentaire lu = Instagram nous a fermé la porte (cookie mort,
    // blocage). Se taire ici donnerait une semaine vide indistinguable d'une
    // semaine sans activité.
    if (withComments.length && scanned === 0) {
      throw new Error(
        `${withComments.length} publication(s) portent des commentaires, aucun n'a pu être lu — ` +
        'Instagram refuse la lecture. Recoller un « sessionid » frais dans Connecteurs → Instagram.'
      )
    }

    // Miroir Airtable après coup, en série et non bloquant : une panne Airtable
    // ne doit jamais faire perdre les prospects déjà enregistrés en base.
    for (const id of toPush) { try { await pushToAirtable(id) } catch {} }

    // Historique des DM Instagram : détecte les prospects avec qui un fil de
    // conversation existe déjà (peu importe qui a écrit en premier ou via quel
    // outil — ManyChat, Philippe manuellement, etc.), best-effort — une panne
    // ici ne doit jamais faire perdre les commentaires déjà ingérés ci-dessus.
    let dmApplied = 0
    try {
      const { syncDmInbox, applyDmHistoryToProspects } = await import('./instagramDmHistory.js')
      await syncDmInbox({ full: false, session })
      dmApplied = applyDmHistoryToProspects()
    } catch (e) {
      console.error('instagram dm history sync:', e.message)
    }

    const summary =
      `${accounts.map(a => `@${a}`).join(' + ')} · ${lookback} j · ` +
      `${posts.length} publication(s) à nous, ${withComments.length} avec commentaires` +
      `${skippedPosts ? `, ${skippedPosts} écartée(s) (publication d'un autre compte)` : ''} · ` +
      `${scanned} commentaire(s) lus, tous captés (mot-clé « ${cfg.keywords.trim() || 'coach'} » priorisé) → ` +
      `${created} nouveau(x), ${updated} mis à jour, ${duplicates} déjà connu(s)` +
      `${repliedByUsCount ? ` · ${repliedByUsCount} déjà répondu(s) publiquement` : ''}` +
      `${dmApplied ? ` · ${dmApplied} déjà en DM` : ''}`

    // La tournée a lu des commentaires : la session est vivante, on le date.
    recordSessionStatus('instagram', { status: 'ok', detail: `tournée du ${new Date().toISOString().slice(0, 10)}` })

    logSystemRun(INSTAGRAM_SCRAPE_AUTOMATION_ID, {
      status: 'success', duration_ms: Date.now() - t0,
      triggerData: { trigger, accounts, lookback_days: lookback },
      result: summary,
    })
    return {
      ok: true, ran: true, accounts, lookback_days: lookback,
      posts: posts.length, posts_skipped: skippedPosts, posts_with_comments: withComments.length,
      scanned, matched, created, updated, duplicates, repliedByUsCount, dmApplied, summary,
    }
  } catch (e) {
    recordSessionStatus('instagram', {
      status: e instanceof SessionExpired ? 'expired' : 'error',
      detail: e.message,
    })
    logSystemRun(INSTAGRAM_SCRAPE_AUTOMATION_ID, {
      status: 'error', duration_ms: Date.now() - t0, triggerData: { trigger }, error: e,
    })
    console.error('instagram comment scrape:', e.message)
    return { error: e.message, expired: e instanceof SessionExpired, throttled: e instanceof Throttled }
  }
}

/** Aperçu (bouton « Simuler ») : état de la configuration, sans aucun appel Instagram. */
export function previewCommentScrape() {
  const cfg = loadConfig()
  const { sessionid, dsUserId } = getSessionCookie()
  const counts = db.prepare(`
    SELECT COUNT(*) total,
      COALESCE(SUM(CASE WHEN source='scrape' THEN 1 ELSE 0 END), 0) par_lecture,
      COALESCE(SUM(CASE WHEN contacted=1 THEN 1 ELSE 0 END), 0) contactes
    FROM instagram_prospects WHERE deleted_at IS NULL
  `).get()
  return {
    cookie: sessionid
      ? `configuré (${sessionid.slice(0, 6)}…${dsUserId ? `, ds_user_id ${dsUserId}` : ', ds_user_id absent'})`
      : '⚠️ absent — coller le cookie « sessionid » dans Connecteurs → Instagram, sinon la tournée échoue',
    comptes: splitAccounts(cfg.accounts).map(a => `@${a}`).join(' + ') || '⚠️ aucun compte configuré',
    publications_retenues: String(cfg.our_accounts || '').trim()
      ? `seulement celles dont ${splitAccounts(cfg.our_accounts).map(a => `@${a}`).join(' ou ')} est auteur ou co-auteur ` +
        '(les publications des autres comptes, collab exclue, sont ignorées)'
      : '⚠️ toutes — aucun compte dans « our_accounts », les publications des partenaires seront lues aussi',
    mots_cles: `${cfg.keywords.trim() || 'coach'} (priorisation seulement — tous les commentateurs sont captés)`,
    fenetre: `${cfg.lookback_days} jours relus à chaque tournée`,
    cedule: `jour ISO ${cfg.run_weekday} (1 = lundi … 7 = dimanche) à ${cfg.run_hour} h, heure de Montréal` +
      (cfg.run_weekday === '1' && cfg.run_hour === '0' ? ' — soit minuit dans la nuit de dimanche à lundi' : ''),
    semaine_courante: isoWeekKey(localDay()),
    prospects: counts,
  }
}
