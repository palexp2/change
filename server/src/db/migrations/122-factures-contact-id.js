/**
 * 122 — Contact d'une facture client (2026-10-08) : lien
 * vers le contact dont le courriel est celui du client Stripe. Les factures
 * déjà là sont rattachées ici ; les suivantes le sont à la synchro Stripe.
 */
import { linkFactureContact } from '../../services/stripeProjectLink.js'

export const id = '122-factures-contact-id'
export const description = 'factures.contact_id + rattachement par le courriel du client Stripe'

export function up(db) {
  try { db.exec('ALTER TABLE factures ADD COLUMN contact_id TEXT REFERENCES contacts(id)') } catch { /* déjà là */ }
  db.exec('CREATE INDEX IF NOT EXISTS idx_factures_contact ON factures(contact_id)')
  const ids = db.prepare(`
    SELECT id FROM factures
    WHERE (contact_id IS NULL OR contact_id='') AND customer_email IS NOT NULL AND customer_email<>''
  `).all()
  let linked = 0
  for (const { id: fid } of ids) if (linkFactureContact(fid)) linked++
  return { linked }
}
