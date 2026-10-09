/**
 * 113 — Retours : formule « Statut » mise en forme (retours de ligne, retraits).
 *
 * Demande de Pierre-Alexandre Papillon (2026-10-05, /retours?vue=bor7SvqpqO3cOYEXU).
 * Même logique que 112, seulement lisible dans l'éditeur. On ne réécrit que si
 * la formule est encore celle de 112 (espaces ignorés) : une retouche faite à la
 * main entre-temps reste intacte.
 */
import { regenerateView } from '../../services/customFieldsView.js'

export const id = '113-retours-statut-formule-lisible'
export const description = 'Retours : formule « Statut » mise en forme sur plusieurs lignes'

const FORMULA = `IF(
  cf_nb_items = 0, "Aucun item à retourner",
  IF(
    cf_items_a_recevoir > 0, "En retour",
    IF(
      cf_items_a_analyser > 0, "À analyser",
      IF(
        cf_items_a_traiter > 0, "À traiter",
        IF(cf_items_traitables > 0, "Traité", "Analysé")
      )
    )
  )
)`

const squash = s => String(s || '').replace(/\s+/g, '')

export function up(d) {
  const f = d.prepare(`SELECT id, formula_expr FROM custom_fields
                       WHERE erp_table='returns' AND column_name='cf_statut' AND deleted_at IS NULL`).get()
  if (!f || squash(f.formula_expr) !== squash(FORMULA)) return { updated: 0 }
  d.prepare(`UPDATE custom_fields SET formula_expr=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
    .run(FORMULA, f.id)
  regenerateView('returns')
  return { updated: 1 }
}
