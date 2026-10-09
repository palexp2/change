// Revenu d'une commande — règle unique de la fiche Commande (routes/orders.js)
// et du tableau Rentabilité du dashboard (routes/dashboard.js).
//
//   Abonnement → 1re facture HT × 38 ; achat → SUM des factures HT, liées
//   directement (order_id) ou via le projet (project_id).
//
// Une commande est « abonnement » si elle est cochée comme telle OU si l'une de
// ses factures liées est une facture d'abonnement (factures.kind) : la case
// « Abonnement » n'est pas toujours cochée sur la commande, alors que la
// facture Stripe, elle, sait ce qu'elle est (demande P.-A. Papillon, 2026-10-05).
// La 1re facture retenue est alors celle d'abonnement de préférence.
//
// Le HT des factures Stripe est APRÈS rabais (total_excluding_tax) — d'où le
// filtre > 0 : un 1er mois offert (rabais 100 %) ne doit pas ramener la valeur
// projetée de l'abonnement à 0.
//
// `idExpr` / `projectExpr` : expressions SQL de l'id et du project_id de la
// commande dans la requête appelante ; `flagExpr` : sa colonne is_subscription.

export const SUBSCRIPTION_REVENUE_MULTIPLIER = 38

const linkedFactures = (idExpr, projectExpr) =>
  `(f.order_id = ${idExpr} OR (${projectExpr} IS NOT NULL AND f.project_id = ${projectExpr}))`

export const orderIsSubscriptionSql = (idExpr, projectExpr, flagExpr) => `(
  COALESCE(${flagExpr}, 0) = 1
  OR EXISTS (SELECT 1 FROM factures f
             WHERE ${linkedFactures(idExpr, projectExpr)} AND f.kind = 'subscription')
)`

export const orderRevenueSql = (idExpr, projectExpr, flagExpr) => `(
  CASE WHEN ${orderIsSubscriptionSql(idExpr, projectExpr, flagExpr)} THEN
    COALESCE((
      SELECT f.amount_before_tax_cad * ${SUBSCRIPTION_REVENUE_MULTIPLIER}
      FROM factures f
      WHERE ${linkedFactures(idExpr, projectExpr)}
        AND COALESCE(f.amount_before_tax_cad, 0) > 0
      ORDER BY (f.kind = 'subscription') DESC, COALESCE(f.document_date, f.created_at) ASC
      LIMIT 1
    ), 0)
  ELSE
    COALESCE((
      SELECT SUM(f.amount_before_tax_cad)
      FROM factures f
      WHERE ${linkedFactures(idExpr, projectExpr)}
    ), 0)
  END
)`
