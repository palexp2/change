/**
 * 136 — Documents importants (Autres outils → Documents importants).
 *
 * Les papiers de l'entreprise (statuts, assurances, permis, certifications,
 * baux…) étaient éparpillés entre Drive et les boîtes courriel. Une ligne par
 * document, avec son fichier, sa catégorie et une date d'échéance pour voir
 * venir les renouvellements. Le fichier vit sous uploads/documents-importants/.
 */
import db from '../database.js'

export const id = '136-important-documents'
export const description =
  'important_documents — documents importants de l\'entreprise (fichier, catégorie, échéance)'

export function up(migrationDb) {
  const d = migrationDb || db
  d.exec(`
    CREATE TABLE IF NOT EXISTS important_documents (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      category      TEXT,
      expires_at    TEXT,
      notes         TEXT,
      original_name TEXT,
      stored_name   TEXT,
      mime_type     TEXT,
      size          INTEGER,
      uploaded_by   TEXT REFERENCES users(id),
      created_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at    TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at    TEXT
    )
  `)
  return { created: ['important_documents'] }
}
