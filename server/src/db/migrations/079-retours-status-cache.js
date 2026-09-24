// Le statut d'un retour est calculé depuis ses articles (migration 069).
// Une réception change donc returns_v sans écrire dans returns : le delta du
// cache client ignorait ce changement et gardait le retour « En transit ».
// Journaliser le parent couvre aussi les imports Airtable, les suppressions
// et les déplacements d'articles, sans modifier les données métier du retour.
export const id = '079-retours-status-cache'
export const description = 'Retours : rafraîchir le statut après une modification des articles reçus'

export function up(db) {
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS chl_return_items_parent_ins
    AFTER INSERT ON return_items
    BEGIN
      INSERT INTO change_log (table_name, record_id, change_type)
      SELECT 'returns', id, 'upsert' FROM returns WHERE id = NEW.return_id;
    END;

    CREATE TRIGGER IF NOT EXISTS chl_return_items_parent_upd
    AFTER UPDATE OF received_at, return_id ON return_items
    WHEN OLD.received_at IS NOT NEW.received_at OR OLD.return_id IS NOT NEW.return_id
    BEGIN
      INSERT INTO change_log (table_name, record_id, change_type)
      SELECT 'returns', id, 'upsert' FROM returns
      WHERE id IN (OLD.return_id, NEW.return_id);
    END;

    CREATE TRIGGER IF NOT EXISTS chl_return_items_parent_del
    AFTER DELETE ON return_items
    BEGIN
      INSERT INTO change_log (table_name, record_id, change_type)
      SELECT 'returns', id, 'upsert' FROM returns WHERE id = OLD.return_id;
    END;
  `)

  // Rattrapage unique des listes déjà ouvertes et des snapshots persistés.
  const result = db.prepare(`
    INSERT INTO change_log (table_name, record_id, change_type)
    SELECT 'returns', id, 'upsert' FROM returns WHERE deleted_at IS NULL
  `).run()
  return { refreshed_returns: result.changes }
}
