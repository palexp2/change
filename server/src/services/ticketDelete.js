// Suppression d'un billet.
//
// SQLite tourne avec `foreign_keys = ON` : toute ligne qui référence
// tickets(id) doit être traitée AVANT le DELETE, sinon la suppression est
// rejetée (« FOREIGN KEY constraint failed ») et l'utilisateur ne voit qu'une
// erreur opaque. C'est ce qui rendait indélétable tout billet ayant reçu un
// sondage de satisfaction : ticket_surveys.ticket_id est NOT NULL, donc même
// un soft delete du sondage laisserait la FK en place.
//
// Les tâches, elles, survivent au billet : on se contente de délier.
export function deleteTicketCascade(database, ticketId) {
  const tx = database.transaction((id) => {
    database.prepare(
      `UPDATE tasks SET ticket_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE ticket_id = ?`
    ).run(id)
    database.prepare('DELETE FROM ticket_surveys WHERE ticket_id = ?').run(id)
    database.prepare('DELETE FROM tickets WHERE id = ?').run(id)
  })
  tx(ticketId)
}
