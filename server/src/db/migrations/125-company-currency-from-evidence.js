/**
 * 125 — Devise des entreprises recalée sur les faits (2026-10-09).
 *
 * La colonne `companies.currency` est née avec DEFAULT 'CAD' : toutes les
 * fiches, y compris ~150 clients américains facturés en USD, affichaient CAD.
 * Preuve retenue, par ordre : dernière facture (hors Void/Draft), dernier
 * abonnement, pays des adresses (s'il est univoque), pays de livraison.
 * Sans preuve, la fiche garde sa valeur.
 */
export const id = '125-company-currency-from-evidence'
export const description = 'companies.currency : déduite des factures, abonnements et adresses'

export function up(db) {
  db.exec(`
    WITH ev AS (
      SELECT c.id, c.currency AS cur, coalesce(
        (SELECT upper(f.currency) FROM factures f
          WHERE f.company_id = c.id AND upper(f.currency) IN ('CAD','USD','EUR')
            AND coalesce(f.status, '') NOT IN ('Void', 'Draft')
          ORDER BY coalesce(f.document_date, f.created_at) DESC LIMIT 1),
        (SELECT upper(s.currency) FROM subscriptions s
          WHERE s.company_id = c.id AND upper(s.currency) IN ('CAD','USD','EUR')
          ORDER BY coalesce(s.start_date, s.created_at) DESC LIMIT 1),
        (SELECT CASE
            WHEN sum(upper(a.country) IN ('US','USA','UNITED STATES')) > 0
             AND sum(upper(a.country) IN ('CA','CANADA')) = 0 THEN 'USD'
            WHEN sum(upper(a.country) IN ('CA','CANADA')) > 0
             AND sum(upper(a.country) IN ('US','USA','UNITED STATES')) = 0 THEN 'CAD' END
          FROM adresses a WHERE a.company_id = c.id),
        CASE upper(c.pays_de_livraison) WHEN 'US' THEN 'USD' WHEN 'CA' THEN 'CAD' END
      ) AS target
      FROM companies c
    )
    UPDATE companies
       SET currency = (SELECT target FROM ev WHERE ev.id = companies.id)
     WHERE id IN (SELECT id FROM ev WHERE target IS NOT NULL AND target IS NOT coalesce(cur, ''))
  `)
}
