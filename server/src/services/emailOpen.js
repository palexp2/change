import db from '../db/database.js'
import { emitEntity } from './realtimeEmitters.js'

// Chargement du pixel de suivi d'un courriel : compteur, heure de la 1re
// ouverture et une ligne par ouverture (historique). Si le courriel est un
// envoi de soumission, la fiche ouverte l'affiche en direct. Ne lève jamais :
// le pixel doit toujours répondre.
export function recordEmailOpen(emailId) {
  try {
    const opened = db.prepare(`
      UPDATE emails SET open_count = COALESCE(open_count, 0) + 1,
        first_opened_at = COALESCE(first_opened_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      WHERE id = ? RETURNING first_opened_at
    `).get(emailId)
    if (!opened) return
    const at = db.prepare(`
      INSERT INTO email_opens (email_id, opened_at) VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) RETURNING opened_at
    `).get(emailId).opened_at
    const send = db.prepare(`
      SELECT ss.soumission_id, s.sent_email_id FROM soumission_sends ss
      JOIN soumissions s ON s.id = ss.soumission_id WHERE ss.email_id = ?
    `).get(emailId)
    if (!send) return
    const payload = { id: send.soumission_id, sends_updated_at: at }
    if (send.sent_email_id === emailId) Object.assign(payload, { sent_opened_at: opened.first_opened_at, sent_last_opened_at: at })
    emitEntity('soumission', 'updated', send.soumission_id, payload)
  } catch { /* silently ignore */ }
}
