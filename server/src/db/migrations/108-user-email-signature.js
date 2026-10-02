/**
 * 108 — Signature de courriel par utilisateur.
 *
 * Saisie dans Paramètres › Ma boîte Gmail, ajoutée par défaut en bas de la
 * fenêtre d'envoi de courriel (EmailComposerModal). HTML (copier-coller d'une
 * signature Gmail possible), nettoyé à l'écriture par PATCH /auth/preferences.
 */
export const id = '108-user-email-signature'
export const description = 'users.email_signature — signature ajoutée en bas des courriels envoyés depuis l\'ERP'

export function up(db) {
  const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name)
  if (cols.includes('email_signature')) return { added: false }
  db.exec('ALTER TABLE users ADD COLUMN email_signature TEXT')
  return { added: true }
}
