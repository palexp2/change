/**
 * 132 — Statut des commandes : import Airtable coupé.
 *
 * Pierre-Alexandre Papillon, 2026-10-14 : la formule Airtable « Statut »
 * affichait « Tous les items sont disponibles » dès que rien n'était encore
 * envoyé, même avec des pièces à fabriquer. Boréal calcule désormais le statut
 * (services/orderStatus.js, automation `sys_order_status`).
 *
 * On garde la ligne de mapping en import_disabled=1 (c'est elle qui marque le
 * champ Airtable « désactivé » ; la supprimer le ferait réapparaître comme
 * importable). Sans mapping actif, le miroir ne calcule plus `status`.
 */
export const id = '132-orders-status-unplug-airtable'
export const description = "Commandes : coupe l'import du « Statut » Airtable (calculé par Boréal)"

export function up(db) {
  db.prepare(`
    UPDATE airtable_field_mappings
    SET import_disabled = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE erp_table = 'orders' AND column_name = 'status' AND import_disabled IS NOT 1
  `).run()
}
