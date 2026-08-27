// Prospects Instagram — historique des DM.
//
// But : savoir si on a DÉJÀ échangé en privé avec un commentateur, pour ne
// jamais lui faire croire qu'on ne l'a pas contacté. `GET /direct_v2/inbox/`
// (la même API privée que le reste du module) liste les fils de conversation
// du compte connecté (@orisha_auto), paginable par `cursor`. La présence d'un
// fil, peu importe qui a écrit en premier ou via quel outil (ManyChat, DM
// manuel de Philippe, etc.), suffit à dire « déjà en contact ».
//
// Les demandes de message NON acceptées (spam / non sollicitées) vivent dans
// un dossier séparé (`pending_inbox`) et n'apparaissent PAS dans cet inbox
// principal (vérifié : `pending`/`spam` à false sur l'échantillon) — donc pas
// de faux positif venant d'un inconnu qui nous a écrit sans qu'on réponde.
//
// On ne fait PAS un appel par prospect (ça exploserait le taux de requêtes) :
// un seul balayage paginé de l'inbox alimente `instagram_dm_threads`, et
// `applyDmHistoryToProspects` fait ensuite une simple jointure locale.
import db from '../db/database.js'
import { igGet, API_ROOT, getSessionCookie } from './instagramCommentScrape.js'
import { pushToAirtable } from './instagramProspects.js'

// Plafond de sécurité pour le rattrapage complet (`full: true`) : au-delà,
// on arrête plutôt que de boucler indéfiniment si `has_older` ne se libère
// jamais (ex. changement de format de l'API).
const MAX_FULL_PAGES = 500
const PAGE_SIZE = 20

const upsertThread = db.prepare(`
  INSERT INTO instagram_dm_threads (ig_user_id, username, thread_id, last_activity_at, updated_at)
  VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(ig_user_id) DO UPDATE SET
    username = excluded.username, thread_id = excluded.thread_id,
    last_activity_at = excluded.last_activity_at, updated_at = excluded.updated_at
`)

function microsToIso(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? new Date(n / 1000).toISOString() : null
}

/**
 * Balaie l'inbox de `account` et alimente `instagram_dm_threads`.
 *
 * - `full: true`  → pagine tant que `has_older` est vrai (rattrapage unique).
 * - `full: false` → s'arrête dès qu'une page entière ne contient plus aucun
 *   fil nouveau : l'inbox est trié par activité récente, donc une page « déjà
 *   toute connue » signifie qu'on a rattrapé tout ce qui a changé depuis le
 *   dernier passage.
 *
 * Best-effort : une erreur réseau ou un format inattendu est journalisé et
 * renvoyé dans `{ error }`, jamais lancé — cet appel est un à-côté de la
 * tournée de commentaires, il ne doit jamais la faire échouer.
 */
export async function syncDmInbox({ full = false, account = 'orisha_auto', session = null } = {}) {
  const creds = session || getSessionCookie()
  if (!creds.sessionid) return { error: 'Aucun cookie de session Instagram configuré' }

  let cursor = null
  let pages = 0, threads = 0, newThreads = 0
  const maxPages = full ? MAX_FULL_PAGES : 20 // 20 pages incrémental = large marge, rare d'aller jusque-là

  try {
    for (; pages < maxPages; pages++) {
      let url = `${API_ROOT}/direct_v2/inbox/?limit=${PAGE_SIZE}`
      if (cursor) url += `&cursor=${encodeURIComponent(cursor)}`
      const payload = await igGet(url, creds)
      const inbox = payload?.inbox
      const pageThreads = inbox?.threads || []
      if (!pageThreads.length) break

      let pageHasNew = false
      const run = db.transaction((rows) => {
        for (const t of rows) {
          for (const u of t.users || []) {
            const igUserId = u.pk != null ? String(u.pk) : null
            if (!igUserId) continue
            const existing = db.prepare('SELECT 1 FROM instagram_dm_threads WHERE ig_user_id=?').get(igUserId)
            if (!existing) { newThreads++; pageHasNew = true }
            upsertThread.run(igUserId, u.username || null, String(t.thread_id || ''), microsToIso(t.last_activity_at))
            threads++
          }
        }
      })
      run(pageThreads)

      if (!full && !pageHasNew) break // rien de neuf sur cette page → rattrapé
      if (!inbox.has_older || !inbox.oldest_cursor) break
      cursor = inbox.oldest_cursor
    }
    return { ok: true, pages, threads, newThreads, capped: pages >= maxPages }
  } catch (e) {
    console.error('instagram dm inbox sync:', e.message)
    return { error: e.message }
  }
}

/**
 * Applique l'historique DM connu aux prospects pas encore marqués contactés.
 * Simple jointure locale (aucun appel réseau) — retourne le nombre mis à jour.
 */
export function applyDmHistoryToProspects() {
  const rows = db.prepare(`
    SELECT p.id, t.last_activity_at
    FROM instagram_prospects p
    JOIN instagram_dm_threads t ON t.ig_user_id = p.ig_user_id
    WHERE p.contacted = 0 AND p.deleted_at IS NULL AND p.ig_user_id IS NOT NULL
  `).all()
  if (!rows.length) return 0

  const mark = db.prepare(`
    UPDATE instagram_prospects
    SET contacted = 1, contacted_source = 'dm_history',
        contacted_at = COALESCE(?, strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `)
  db.transaction(() => { for (const r of rows) mark.run(r.last_activity_at, r.id) })()

  for (const r of rows) { pushToAirtable(r.id).catch(() => {}) }
  return rows.length
}
