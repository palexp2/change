/**
 * 123 — Contact d'un abonnement (2026-10-08), comme la 122 pour les factures :
 * courriel du client Stripe, sinon le seul contact de ses factures.
 */
import { linkSubscriptionContact } from '../../services/stripeProjectLink.js'

export const id = '123-subscriptions-contact-id'
export const description = 'subscriptions.contact_id + rattachement par courriel ou par ses factures'

export function up(db) {
  try { db.exec('ALTER TABLE subscriptions ADD COLUMN contact_id TEXT REFERENCES contacts(id)') } catch { /* déjà là */ }
  db.exec('CREATE INDEX IF NOT EXISTS idx_subscriptions_contact ON subscriptions(contact_id)')
  let linked = 0
  for (const { id: sid } of db.prepare("SELECT id FROM subscriptions WHERE contact_id IS NULL OR contact_id=''").all()) {
    if (linkSubscriptionContact(sid)) linked++
  }
  return { linked }
}
