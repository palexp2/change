/**
 * Le tri Instagram ne voyait que le nom et le commentaire : un potager de
 * cuisine qui écrit « 🌱 » passait pour une ferme de fleurs. On garde sur la
 * fiche le profil public lu (bio, publications) et ce qu'un modèle en a tiré.
 */
export const id = '083-instagram-profiles'
export const description = 'Profil Instagram lu et « Qui c\'est » sur chaque fiche prospect'

const COLUMNS = [
  ['profile_json', 'TEXT'],       // bio, catégorie, lien, abonnés, publications, analyse
  ['profile_status', 'TEXT'],     // 'ok' | 'private' | 'missing'
  ['profile_read_at', 'TEXT'],    // relu au plus tous les 30 jours
  ['profile_who', 'TEXT'],        // « Mark — potager en cuisine et hydroponie, amateur »
  ['profile_activity', 'TEXT'],   // fleurs | maraichage | potager | hydroponie | serre | contenu | commerce | autre
  ['profile_level', 'TEXT'],      // amateur | pro | inconnu
]

export function up(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(instagram_prospects)').all().map(c => c.name))
  for (const [name, type] of COLUMNS) {
    if (!cols.has(name)) db.exec(`ALTER TABLE instagram_prospects ADD COLUMN ${name} ${type}`)
  }
}
