/**
 * 133 — Retire 9 faux mouvements d'abonnement restés après la 130.
 *
 * Demandé par Pierre-Alexandre Papillon, 2026-10-14 (même décision que la 130 :
 * suppression réelle). Parcours de toute la table subscription_events :
 * - A (7) : baisse = montant mensuel passé de taxes QC incluses (× 1,14975) à
 *   hors taxes, sans changement de produit (ex. Université Laval, 17 sept.) ;
 * - C (2) : mouvement sur un abonnement déjà annulé (churn antérieur) ;
 * - B, D : aucun restant.
 * Liste explicite : la règle n'est pas réévaluée à chaque démarrage.
 */
export const id = '133-drop-fake-mrr-movements-all-dates'
export const description = 'Retire 9 faux mouvements d\'abonnement (taxes recomptées, abonnements déjà annulés)'

const IDS = [
  // A — taxes recomptées
  'borCsKeLQ22XOzo6D', // Université Laval, 2026-09-17, −4,49
  'e08b3d99-5406-4bee-b11a-d68689d631e3', // MRC Argenteuil, 2026-06-21, −4,49
  '542d3ec2-ec08-4518-8724-d1375b5a0c70', // Lupin & Fruits, 2026-06-09, −0,75
  '1b7f6b6d-1127-42eb-a1b5-9006799397bd', // CFP Alma, 2026-06-02, −13,98
  'borYg39jxMnzyVSk2', // Fred Lamontagne, 2026-09-17, −66,34
  '5aeeb97a-8a99-4d59-9066-cb9325edd48d', // Jardins Sauvé-Lafrance, 2026-06-01, −3,44
  '7570a272-a8ae-45fb-9a43-5843fec7de3c', // Club Populaire de Consommateurs, 2026-07-18, −2,00
  // C — abonnement déjà annulé
  'ed300a1f-f5d3-41dc-b34b-55bd456caa35', // Les Jardins du Coin, 2026-08-11, −0,75
  'borlm7e9WaEydgZHB', // Wild Hope Farm, 2026-09-23, +56,01
]

export function up(db) {
  const marks = IDS.map(() => '?').join(',')
  const n = db.prepare(`SELECT COUNT(*) AS n FROM subscription_events WHERE id IN (${marks})`).get(...IDS).n
  // Garde-fou : on ne supprime que le lot identifié, sinon on s'arrête.
  if (n !== IDS.length && n !== 0) throw new Error(`133 : ${n} événements trouvés, ${IDS.length} attendus`)
  db.prepare(`DELETE FROM subscription_events WHERE id IN (${marks})`).run(...IDS)
}
