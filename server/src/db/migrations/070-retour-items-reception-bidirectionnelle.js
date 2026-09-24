/**
 * 070 — Réception d'un article de retour : « Date de réception » et
 * « Réceptionné par » deviennent bidirectionnels.
 *
 * La section « Réception » de la fiche retour (scan au pistolet) pose ces deux
 * valeurs sur l'article. Or les champs mirroités de `retour_items` sont en sens
 * « Airtable → Boréal » par défaut : la saisie ERP y est REFUSÉE (400), et
 * serait de toute façon écrasée au prochain sync. La réception se fait
 * maintenant ici, donc c'est Boréal qui écrit et Airtable qui reçoit.
 *
 * Les deux champs restent réglables dans /champs/return_items — cette migration
 * ne fait que poser le sens de départ, et seulement si l'utilisateur n'en a pas
 * déjà choisi un.
 */
export const id = '070-retour-items-reception-bidirectionnelle'
export const description =
  'Retours : date de réception et réceptionniste poussés vers Airtable (sens bidirectionnel)'

const MODULE = 'retour_items'
const KEYS = ['dyn:received_at', 'dyn:received_by']

export function up(d) {
  const set = d.prepare(
    `INSERT INTO airtable_field_directions (module, field_key, direction) VALUES (?, ?, 'both')
     ON CONFLICT(module, field_key) DO NOTHING`
  )
  const done = []
  for (const key of KEYS) {
    if (set.run(MODULE, key).changes) done.push(key)
  }
  return { directions: done }
}
