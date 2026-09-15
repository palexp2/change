// Récolte ManyChat : contacts, conversations, et entrée dans la liste de
// prospects.
//
// RÈGLE DE TRI décidée avec Charles : un contact n'entre dans la liste de
// Philippe QUE si on connaît son nom d'usager Instagram. ManyChat ne le révèle
// qu'au moment où la personne répond ; avant ça, la fiche serait un fantôme
// que personne ne peut ouvrir ni contacter. Les autres sont quand même suivis
// ici (conversations), et basculent dans la liste d'eux-mêmes dès leur réponse.
import db from '../db/database.js'
import { activityLabel, fetchManychatContacts, fetchManychatMessages, hasManychatSession, isActivityLabel, manychatPageId } from './manychat.js'
import { ingestManychatEvent, pushToAirtable } from './instagramProspects.js'
import { isSystemAutomationActive, logSystemRun } from './systemAutomations.js'
import { recordSessionStatus } from './sessionHealth.js'

export const MANYCHAT_SYNC_AUTOMATION_ID = 'sys_manychat_contacts'

const upsertThread = db.prepare(`
  INSERT INTO manychat_threads (
    user_id, ig_id, ig_username, full_name, status, optin, subscribed_at, updated_at
  ) VALUES (?,?,?,?,?,?,?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  ON CONFLICT(user_id) DO UPDATE SET
    ig_id = COALESCE(excluded.ig_id, manychat_threads.ig_id),
    ig_username = COALESCE(excluded.ig_username, manychat_threads.ig_username),
    full_name = COALESCE(excluded.full_name, manychat_threads.full_name),
    status = excluded.status,
    optin = excluded.optin,
    subscribed_at = COALESCE(manychat_threads.subscribed_at, excluded.subscribed_at),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
`)

// Le texte peut changer d'une relecture à l'autre — pas parce que la personne
// se corrige, mais parce qu'on a appris à nommer un événement qu'on rendait
// vide. D'où la mise à jour plutôt qu'un simple « ignorer si déjà là ».
const insertMessage = db.prepare(`
  INSERT INTO manychat_messages (id, user_id, direction, text, kind, sent_at, link_url)
  VALUES (?,?,?,?,?,?,?)
  ON CONFLICT(id) DO UPDATE SET text = excluded.text, kind = excluded.kind, link_url = excluded.link_url
`)

function iso(ts) { return ts ? new Date(ts * 1000).toISOString() : null }

/**
 * Une tournée. Idempotente : chaque contact porte un identifiant stable, et
 * l'entrée dans la liste passe par la même porte que les commentaires — donc
 * même dédoublonnage, même fusion de fiches.
 */
export async function runManychatSync({ force = false, trigger = 'schedule' } = {}) {
  const t0 = Date.now()
  try {
    if (!force && !isSystemAutomationActive(MANYCHAT_SYNC_AUTOMATION_ID)) return { skipped: 'inactive' }
    if (!hasManychatSession()) throw new Error('Aucune session ManyChat — la rouvrir dans Connecteurs → ManyChat')

    const contacts = await fetchManychatContacts()
    // Une réponse vide alors que le compte a des contacts = porte fermée, pas
    // un compte vide. On le dit au lieu d'annoncer une tournée réussie à zéro.
    if (!contacts.length) throw new Error('ManyChat n’a renvoyé aucun contact — vérifier la session')

    const pageId = manychatPageId()
    let named = 0, created = 0, updated = 0, messagesRead = 0
    const toPush = new Set()
    for (const c of contacts) {
      upsertThread.run(
        String(c.user_id), c.ig_id ? String(c.ig_id) : null, c.ig_username || null,
        c.name || c.title || null, c.status || null, c.optin_ig ? 1 : 0, iso(c.ts_subscribed),
      )
      if (!c.ig_username) continue
      named++
      // On lit la conversation AVANT de créer la fiche : c'est elle qui dit ce
      // que la personne a fait (commenté quoi, sous quelle publication), et
      // c'est ça qui décide s'il vaut la peine de lui écrire.
      let first = null
      try {
        await syncThreadMessages(c.user_id)
        // « Début de la conversation » ne dit rien de ce que la personne a
        // fait : on prend le premier geste qui porte une information, et on ne
        // retombe sur l'ouverture du fil que s'il n'y a rien d'autre.
        first = db.prepare(`
          SELECT direction, text, kind, link_url, sent_at FROM manychat_messages
          WHERE user_id = ? AND direction = 'in' AND kind <> 'user_thread_new'
          ORDER BY sent_at LIMIT 1
        `).get(String(c.user_id))
          || db.prepare(`
            SELECT direction, text, kind, link_url, sent_at FROM manychat_messages
            WHERE user_id = ? AND direction = 'in' ORDER BY sent_at LIMIT 1
          `).get(String(c.user_id))
          || null
        messagesRead++
      } catch { /* une conversation illisible ne doit pas bloquer la fiche */ }

      const isComment = first?.kind === 'ig_cgt_trigger_comment'
      // Les mots de la personne, mis en contexte : « Tomato » seul sur une
      // fiche ne dit pas que c'est ce qu'elle nous a écrit.
      // Sans le moindre geste de sa part, on ne raconte pas une activité
      // qu'on n'a pas vue : on le dit, et on renvoie vers son profil.
      const label = (first ? activityLabel(first) : null) || '👤 Aucune activité visible'
      const profileUrl = `https://www.instagram.com/${c.ig_username}/`
      const res = ingestManychatEvent({
        flow: isComment ? 'comment' : (first?.kind === 'msgin_instagram' ? 'dm_in' : 'contact'),
        // Identifiant fixe : rejouer une tournée ne crée jamais un 2e événement.
        event_id: `mcui:${c.user_id}`,
        ig_username: c.ig_username,
        manychat_subscriber_id: String(c.user_id),
        full_name: c.name || c.title || null,
        occurred_at: first?.sent_at || iso(c.ts_subscribed),
        text: isComment ? (first.text || '').replace(/^📝 A commenté « (.*) »$/, '$1') : null,
        post_url: isComment ? first.link_url : null,
        source: 'manychat-ui',
        capture_label: label,
        capture_url: first?.link_url || profileUrl,
        manychat_url: pageId ? `https://app.manychat.com/${pageId}/chat/${c.user_id}` : null,
      })
      if (!res.ok || !res.prospect) continue
      db.prepare('UPDATE manychat_threads SET prospect_id=? WHERE user_id=?').run(res.prospect.id, String(c.user_id))
      // Rattrapage : une fiche créée avant qu'on sache lire le geste (ou née
      // d'un commentaire, puis retrouvée ici) reçoit son activité maintenant.
      // On ne remplace jamais une valeur déjà là.
      {
        // On remplace une étiquette tant qu'elle n'est pas une vraie phrase :
        // les valeurs brutes des premières tournées (« Tomato »,
        // « [story_reply_to] ») doivent céder la place, une activité déjà
        // formulée reste.
        const current = db.prepare('SELECT capture_label FROM instagram_prospects WHERE id=?').get(res.prospect.id)?.capture_label
        if (!current || !isActivityLabel(current)) {
          db.prepare(`
            UPDATE instagram_prospects SET
              capture_label = ?,
              capture_url = COALESCE(capture_url, ?),
              manychat_url = COALESCE(manychat_url, ?),
              updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
            WHERE id = ?
          `).run(
            label, first?.link_url || profileUrl,
            pageId ? `https://app.manychat.com/${pageId}/chat/${c.user_id}` : null,
            res.prospect.id,
          )
        }
      }

      if (res.duplicate) continue
      if (res.is_new) created++; else updated++
      toPush.add(res.prospect.id)
    }

    const messages = messagesRead

    for (const id of toPush) { try { await pushToAirtable(id) } catch {} }
    recordSessionStatus('manychat', { status: 'ok', detail: `tournée du ${new Date().toISOString().slice(0, 10)}` })

    const summary = `${contacts.length} contact(s) lus · ${named} avec nom d'usager · ` +
      `${created} nouveau(x), ${updated} mis à jour · ${messages} conversation(s) relues`
    logSystemRun(MANYCHAT_SYNC_AUTOMATION_ID, {
      status: 'success', duration_ms: Date.now() - t0, triggerData: { trigger }, result: summary,
    })
    return { ok: true, contacts: contacts.length, named, created, updated, messages, summary }
  } catch (e) {
    logSystemRun(MANYCHAT_SYNC_AUTOMATION_ID, {
      status: 'error', duration_ms: Date.now() - t0, triggerData: { trigger }, error: e,
    })
    return { error: e.message }
  }
}

/** Rapatrie les messages d'une conversation et met à jour son résumé. */
export async function syncThreadMessages(userId) {
  const msgs = await fetchManychatMessages(userId)
  const save = db.transaction(() => {
    for (const m of msgs) insertMessage.run(m.id, String(userId), m.direction, m.text, m.kind, m.sent_at, m.link_url || null)
    const last = msgs[msgs.length - 1]
    const lastIn = [...msgs].reverse().find(m => m.direction === 'in')
    db.prepare(`
      UPDATE manychat_threads SET
        last_message_text = ?, last_message_at = ?, last_direction = ?,
        last_incoming_at = COALESCE(?, last_incoming_at),
        messages_synced_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE user_id = ?
    `).run(last?.text || null, last?.sent_at || null, last?.direction || null, lastIn?.sent_at || null, String(userId))
  })
  save()
  // Elle vient d'écrire : un message préparé avant sa réponse ne lui répond
  // plus. Il sort de la file et attend Philippe.
  if (lastIncomingChanged(userId, msgs)) {
    try {
      const { flagDraftsOnIncoming } = await import('./instagramDrafts.js')
      flagDraftsOnIncoming(userId)
    } catch { /* la file se rattrapera au passage suivant */ }
  }
  return msgs.length
}

// Vrai quand le dernier message reçu est postérieur au message écrit d'avance.
function lastIncomingChanged(userId, msgs) {
  const lastIn = [...msgs].reverse().find(m => m.direction === 'in')
  if (!lastIn?.sent_at) return false
  const d = db.prepare(`
    SELECT generated_at FROM instagram_drafts
    WHERE manychat_user_id = ? AND status IN ('draft','queued','held')
    ORDER BY created_at DESC LIMIT 1
  `).get(String(userId))
  return !!d && String(lastIn.sent_at) > String(d.generated_at || '')
}

/** Aperçu (« Simuler ») : état connu, sans appeler ManyChat. */
export function previewManychatSync() {
  const t = db.prepare(`
    SELECT COUNT(*) total,
      COALESCE(SUM(CASE WHEN ig_username IS NOT NULL THEN 1 ELSE 0 END), 0) avec_nom,
      COALESCE(SUM(CASE WHEN prospect_id IS NOT NULL THEN 1 ELSE 0 END), 0) en_liste
    FROM manychat_threads
  `).get()
  return {
    session: hasManychatSession() ? 'ouverte' : '⚠️ absente — la rouvrir dans Connecteurs → ManyChat',
    contacts_connus: t.total,
    avec_nom_d_usager: t.avec_nom,
    dans_la_liste_de_philippe: t.en_liste,
    regle: "un contact entre dans la liste seulement quand son nom d'usager est connu",
  }
}
