/**
 * 130 — Retire les 94 fausses « baisses » d'abonnement du 13 oct. 2026.
 *
 * La sync Stripe au démarrage de 18:53 a recalculé les montants mensuels :
 * - 73 abonnements déjà annulés (MRR déjà sorti au churn) ont « baissé » ;
 * - 21 annuels actifs sont passés de taxes incluses à hors taxes.
 * Aucun n'est un mouvement client. Charles, 2026-10-14 : les retirer de la base.
 * Les montants courants des abonnements restent ceux recalculés (corrects).
 */
export const id = '130-drop-fake-mrr-downgrades-2026-10-13'
export const description = 'Retire les 94 fausses baisses de MRR créées par la sync Stripe du 13 oct. 2026'

export function up(db) {
  const where = `category = 'downgrade'
    AND event_date >= '2026-10-13T18:53:00' AND event_date < '2026-10-13T18:56:00'`
  const n = db.prepare(`SELECT COUNT(*) AS n FROM subscription_events WHERE ${where}`).get().n
  // Garde-fou : on ne supprime que le lot identifié, sinon on s'arrête.
  if (n !== 94 && n !== 0) throw new Error(`130 : ${n} événements trouvés, 94 attendus`)
  db.prepare(`DELETE FROM subscription_events WHERE ${where}`).run()
}
