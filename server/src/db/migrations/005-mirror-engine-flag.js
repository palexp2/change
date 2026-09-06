/**
 * 005 — Drapeau de moteur par miroir.
 *
 * Le moteur unique remplace vingt fonctions de sync écrites à la main. Le
 * basculer d'un coup serait imprudent : ces fonctions alimentent la production,
 * et deux d'entre elles seulement ont la garde anti-écho. La bascule se fait
 * donc table par table, chacune étant un déploiement autonome — d'où ce
 * drapeau, qui dit pour chaque miroir qui l'exécute.
 *
 *   legacy   la fonction historique de services/airtable.js (défaut)
 *   unified  le moteur piloté par le registre (services/airtableMirrorEngine.js)
 *
 * Le défaut est 'legacy' pour TOUS les miroirs existants : cette migration ne
 * change strictement aucun comportement. Un miroir ne bascule que par une
 * décision explicite, une fois son équivalence vérifiée.
 *
 * Le drapeau est aussi le chemin de retour : repasser un miroir à 'legacy'
 * suffit à annuler une bascule, sans redéploiement de code.
 */

export const id = '005-mirror-engine-flag'
export const description = "Ajoute airtable_mirrors.engine ('legacy'|'unified'), tout à 'legacy'"

export function up(db) {
  const cols = db.prepare('PRAGMA table_info(airtable_mirrors)').all().map(c => c.name)
  if (cols.includes('engine')) return

  // SQLite refuse un ALTER ADD COLUMN avec CHECK non constant, mais accepte un
  // CHECK simple sur la colonne ajoutée.
  db.exec(`
    ALTER TABLE airtable_mirrors
      ADD COLUMN engine TEXT NOT NULL DEFAULT 'legacy'
      CHECK (engine IN ('legacy','unified'))
  `)
  db.exec(`CREATE INDEX IF NOT EXISTS idx_airtable_mirrors_engine ON airtable_mirrors(engine)`)
}
