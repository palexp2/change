/**
 * 114 — Signature de courriel anglaise par utilisateur.
 *
 * `users.email_signature` reste la signature française (et celle par défaut) ;
 * `email_signature_en` est posée à la place quand le destinataire est un
 * contact anglophone (EmailComposerModal). Vide → la française sert partout.
 */
export const id = '114-user-email-signature-en'
export const description = 'users.email_signature_en — signature anglaise, choisie selon la langue du contact'

export function up(db) {
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name)
  if (cols.includes('email_signature_en')) return { added: false }
  db.exec('ALTER TABLE users ADD COLUMN email_signature_en TEXT')
  return { added: true }
}
