/**
 * 111 — Contact d'un retour : bidirectionnel.
 *
 * Le contact du retour fixe la langue du courriel d'instructions. Il est posé
 * à la création dans Boréal, et se lie à la main sur la fiche d'un retour qui
 * n'en a pas : c'est donc Boréal qui l'écrit et Airtable qui le reçoit.
 * Réglable ensuite dans /champs/returns — la migration ne pose que le sens de
 * départ, si aucun n'a été choisi.
 */
export const id = '111-returns-contact-two-way'
export const description = 'Retours : champ « Contact » bidirectionnel (Boréal ↔ Airtable)'

export function up(d) {
  const r = d.prepare(
    `INSERT INTO airtable_field_directions (module, field_key, direction) VALUES ('retours', 'dyn:cf_contact', 'both')
     ON CONFLICT(module, field_key) DO NOTHING`
  ).run()
  return { set: r.changes > 0 }
}
