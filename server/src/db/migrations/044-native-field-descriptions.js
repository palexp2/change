/**
 * 044 — Les descriptions de champs codées en dur deviennent éditables.
 *
 * Signalement utilisateur : « certains champs ont une description affichée au
 * survol, mais je ne peux pas l'éditer dans la case Description de la modale de
 * modification du champ » (constaté sur « Probabilité », /pipeline).
 *
 * Pourquoi. Le texte d'aide derrière le « ? » de l'en-tête de colonne avait DEUX
 * provenances : la description saisie par l'utilisateur (`custom_fields.description`,
 * migration 014) et une chaîne codée dans `client/src/lib/tableDefs.js`. La
 * seconde s'affichait mais n'était rangée nulle part : la modale ouvrait une case
 * vide, et ce qu'on y écrivait ne pouvait que la REMPLACER — impossible de
 * corriger le texte existant, ni de le retirer (l'effacer ressuscitait la version
 * codée en dur).
 *
 * Ce que fait la migration. Elle DÉPLACE les 41 descriptions restantes de
 * tableDefs.js dans `custom_fields.description`, à l'endroit exact où la modale
 * lit et écrit. Les mêmes textes s'affichent, à la lettre — mais éditables et
 * effaçables. tableDefs.js n'en porte plus aucune : une seule provenance.
 *
 * Défensive :
 *   • une description déjà saisie n'est JAMAIS écrasée (elle fait foi) ;
 *   • un champ supprimé (corbeille) reçoit sa description sans être ressuscité,
 *     pour que la restauration la retrouve ;
 *   • un champ PURGÉ (pierre tombale dans `purged_fields`) est ignoré : la
 *     purge est définitive, on ne recrée pas sa ligne.
 *
 * Clé de rangement : la table de CHAMPS, pas la clé de vue — les articles d'un
 * envoi (`shipment_items`) sont des `order_items`, les envois d'une commande
 * (`order_envois`) des `shipments` (cf. fieldKeyForView, customFieldDisplay.jsx).
 */
import db from '../database.js'
import { newRecordId } from '../../utils/recordId.js'

export const id = '044-native-field-descriptions'
export const description =
  'Descriptions de colonnes codées dans tableDefs.js déplacées dans custom_fields.description (éditables dans la modale de champ)'

// { table: clé de CHAMPS, column: id de colonne, description: texte d'origine }
const SEEDS = [
  { table: "changelog", column: "type", description: "Nature dominante de l’entrée : nouveauté, puis amélioration, puis correction." },
  { table: "changelog", column: "requester", description: "Qui a demandé le changement. Déduit de la demande traitée le même jour quand l’entrée ne le précise pas." },
  { table: "projects", column: "probability", description: "Probabilité de conclusion du projet, en pourcentage (0 à 100)." },
  { table: "projects", column: "nb_greenhouses", description: "Nombre de serres couvertes par ce projet." },
  { table: "orders", column: "items_count", description: "Nombre de lignes d'articles (line items) sur la commande." },
  { table: "order_items", column: "product_id", description: "Produit lié à la ligne — affiché par son nom, cliquable vers sa fiche." },
  { table: "shipments", column: "items_summary", description: "Articles de la commande rattachés à cet envoi." },
  { table: "shipments", column: "serials_summary", description: "Numéros de série des articles de cet envoi." },
  { table: "tickets", column: "survey_rating", description: "Note du sondage de satisfaction envoyé par SMS (1 à 5). Vide = sondage non envoyé ou sans réponse." },
  { table: "return_items", column: "serial_number", description: "Numéro de série retourné — cliquable vers sa fiche." },
  { table: "return_items", column: "product_name", description: "Produit de la ligne, à défaut celui du numéro de série — cliquable vers sa fiche." },
  { table: "factures", column: "customer_email", description: "Courriel du client Stripe (mapping configurable via « Sync Stripe »). Utile pour les clients Stripe sans entreprise dans l'ERP." },
  { table: "factures", column: "payment_date", description: "Date à laquelle la facture a été payée : encaissement Stripe (paid_at) ou, à défaut, dernier paiement manuel enregistré (chèque, virement…). Couvre les paiements Stripe qu'un rollup sur la table Paiements ne voit pas." },
  { table: "factures", column: "payment_reference", description: "Identifiant du paiement : payment intent Stripe (pi_…) ou, à défaut, charge Stripe, encaissements manuels de la table Paiements, ou identifiant de facture Stripe (in_…). Couvre les encaissements Stripe qu'un rollup sur la table Paiements ne voit pas (Stripe ne crée pas de ligne de paiement)." },
  { table: "factures", column: "amount_before_tax_cad", description: "Montant hors taxes converti en CAD au taux de la date de facture." },
  { table: "factures", column: "total_amount", description: "Total taxes incluses, dans la devise d'origine de la facture." },
  { table: "factures", column: "balance_due", description: "Reste à payer = total − paiements − remboursements. Zéro quand la facture est soldée." },
  { table: "factures", column: "refund_amount", description: "Somme des remboursements (refunds) appliqués à cette facture." },
  { table: "factures", column: "deferred_revenue_state", description: "État du revenu reporté : « En attente » tant que l'expédition n'a pas eu lieu, « Constaté » une fois la commande expédiée." },
  { table: "payments", column: "amount", description: "Montant du paiement dans sa devise d'origine." },
  { table: "payments", column: "amount_cad", description: "Montant converti en CAD au taux de la date du paiement. Vide pour les encaissements Stripe (convertis au payout)." },
  { table: "abonnement_events", column: "amount_cad_delta", description: "Variation du revenu mensuel récurrent (MRR) en CAD : positive pour un upgrade/création, négative pour un downgrade/churn." },
  { table: "abonnement_events", column: "rachat", description: "Statut de détection d'un rachat (churn suivi d'une recréation rapprochée) : probable, confirmé, fusionné ou aucun." },
  { table: "bom_items", column: "component_stock_qty", description: "Stock courant du composant en inventaire. Croisé avec « Qté requise » pour calculer le nombre d'unités assemblables." },
  { table: "bom_items", column: "buildable", description: "Unités du produit que ce composant seul permet d'assembler = plancher(Stock composant ÷ Qté requise)." },
  { table: "paie_items", column: "holiday_1_20", description: "Paie fériée Québec : 1/20 des heures régulières des 2 dernières paies × taux horaire × nombre de congés fériés. Calculé à la création de la paie." },
  { table: "paie_items", column: "insurance_gains", description: "Gains assurables — synchronisés depuis Airtable." },
  { table: "paie_items", column: "paid_leave", description: "Congés payés — synchronisés depuis Airtable." },
  { table: "paie_items", column: "rsde_pct", description: "Pourcentage RSDE (recherche scientifique) — synchronisé depuis Airtable." },
  { table: "vendor_subscriptions", column: "actions", description: "Bouton « Se désabonner » / « Réactiver » — ouvre la page d'annulation du fournisseur." },
  { table: "order_items", column: "line_weight_lbs", description: "Poids de la ligne = poids unitaire du produit × quantité." },
  { table: "bank_transactions", column: "description", description: "« Autres détails » du relevé (la nature réelle : bénéficiaire, fournisseur…), avec la description de la banque en dessous. Les relevés sans « Autres détails » affichent la description." },
  { table: "bank_transactions", column: "debit", description: "Sortie d’argent (montant négatif du relevé)." },
  { table: "bank_transactions", column: "credit", description: "Entrée d’argent (montant positif du relevé)." },
  { table: "bank_transactions", column: "status", description: "Dérivé automatiquement : rouge = aucun document trouvé (facture manquante), bleu = document apparié pas encore publié à QB, jaune = publié à QB, vert = rapproché avec le relevé." },
  { table: "stock_movements", column: "movement_value", description: "Valeur du mouvement = quantité × coût unitaire." },
  { table: "automations", column: "runs_30d", description: "Nombre de déclenchements de l'automation sur les 30 derniers jours." },
  { table: "automations", column: "health", description: "Nombre d'exécutions en erreur sur les 30 derniers jours. 0 = en bonne santé." },
  { table: "qualification_calls", column: "pain_points_count", description: "Nombre de points de douleur (pain points) relevés pendant l'appel de qualification." },
  { table: "qualification_calls", column: "red_flags_count", description: "Nombre de signaux d'alerte (red flags) identifiés pendant l'appel." },
  { table: "sale_receipts", column: "read_at", description: "Date de première ouverture du document. Vide = jamais consulté (point bleu dans la liste)." },
]

export function up(migrationDb) {
  const d = migrationDb || db
  const hasPurged = !!d.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='purged_fields'"
  ).get()
  const purged = hasPurged
    ? d.prepare('SELECT 1 FROM purged_fields WHERE erp_table=? AND column_name=?')
    : null
  const find = d.prepare(
    'SELECT id, description FROM custom_fields WHERE erp_table=? AND column_name=?'
  )
  const setDesc = d.prepare(
    "UPDATE custom_fields SET description=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?"
  )
  // Même forme d'insertion que PUT /api/custom-fields/:table/native : name et
  // type vides = « aucun renommage, aucun re-typage » (le libellé et le type de
  // tableDefs.js continuent de faire foi), sort_order NULL = aucun ordre choisi.
  const insert = d.prepare(`
    INSERT INTO custom_fields
      (id, erp_table, name, column_name, type, description, sort_order, kind, source)
    VALUES (?, ?, '', ?, '', ?, NULL, 'native', 'native')
  `)

  let updated = 0, created = 0, kept = 0, skipped = 0
  for (const s of SEEDS) {
    if (purged && purged.get(s.table, s.column)) { skipped++; continue }
    const row = find.get(s.table, s.column)
    if (row) {
      if (String(row.description || '').trim()) { kept++; continue }
      setDesc.run(s.description, row.id)
      updated++
    } else {
      insert.run(newRecordId(), s.table, s.column, s.description)
      created++
    }
  }
  return { updated, created, kept, skipped }
}
