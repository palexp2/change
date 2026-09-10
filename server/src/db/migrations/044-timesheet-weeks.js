/**
 * 044 — Mode « semaine » des feuilles de temps : un seul chiffre par semaine.
 *
 * Certains employés ne déclarent pas leurs heures jour par jour : ils donnent
 * un total pour la semaine complète. Le stocker dans `timesheet_days` aurait
 * demandé de choisir un jour porteur (le lundi) et aurait laissé les six autres
 * jours ambigus — donc comptables deux fois à la paie.
 *
 * D'où une table à part, une ligne par (employé, lundi ISO). Le mode de saisie
 * lui-même reste une préférence de l'employé (`users.timesheet_default_mode`,
 * qui accepte désormais 'week') : c'est une façon de travailler, pas une
 * propriété d'une journée.
 *
 * Garde-fou anti double-compte côté route : on refuse d'enregistrer des heures
 * de semaine si la semaine contient déjà des heures saisies au jour.
 */
import db from '../database.js'

export const id = '044-timesheet-weeks'
export const description =
  'timesheet_weeks — total hebdomadaire pour les employés qui loguent un seul chiffre par semaine'

export function up(migrationDb) {
  const d = migrationDb || db
  d.exec(`
    CREATE TABLE IF NOT EXISTS timesheet_weeks (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      week_start TEXT NOT NULL,
      minutes INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      deleted_at TEXT
    )
  `)
  d.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_timesheet_weeks_user_week
            ON timesheet_weeks(user_id, week_start) WHERE deleted_at IS NULL`)
  d.exec(`CREATE INDEX IF NOT EXISTS idx_timesheet_weeks_week
            ON timesheet_weeks(week_start) WHERE deleted_at IS NULL`)
  return { created: ['timesheet_weeks'] }
}
