/**
 * Numéro séquentiel des System builder (customer_onboarding_responses), affiché
 * « SYS-1000 » en tête de fiche. Demande de Pierre-Alexandre Papillon
 * (2026-09-23).
 *
 * Les existants sont numérotés dans l'ordre de création à partir de 1000. Un
 * trigger numérote les suivants : deux chemins insèrent dans la table (fiche
 * admin et parcours post-paiement), aucun n'a à y penser.
 */
export const id = '089-discovery-forms-number'
export const description = 'customer_onboarding_responses.form_number (SYS-1000…) + trigger de numérotation'

export function up(db) {
  const cols = new Set(db.pragma('table_info(customer_onboarding_responses)').map(c => c.name))
  if (!cols.has('form_number')) db.exec('ALTER TABLE customer_onboarding_responses ADD COLUMN form_number INTEGER')

  const rows = db.prepare('SELECT id FROM customer_onboarding_responses WHERE form_number IS NULL ORDER BY created_at, rowid').all()
  let next = (db.prepare('SELECT MAX(form_number) AS m FROM customer_onboarding_responses').get()?.m ?? 999) + 1
  const set = db.prepare('UPDATE customer_onboarding_responses SET form_number = ? WHERE id = ?')
  for (const row of rows) set.run(next++, row.id)

  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_onboarding_form_number ON customer_onboarding_responses(form_number) WHERE form_number IS NOT NULL')
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS trg_onboarding_form_number
    AFTER INSERT ON customer_onboarding_responses
    WHEN NEW.form_number IS NULL
    BEGIN
      UPDATE customer_onboarding_responses
         SET form_number = (SELECT COALESCE(MAX(form_number), 999) + 1 FROM customer_onboarding_responses)
       WHERE rowid = NEW.rowid;
    END
  `)
  return { numbered: rows.length }
}
