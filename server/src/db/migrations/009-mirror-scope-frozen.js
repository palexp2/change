/**
 * 009 — périmètre du miroir gelé : aucune nouvelle table Airtable.
 *
 * Décision de Guillaume, 2026-09-03 : « pas besoin d'importer de nouvelles
 * tables à partir d'Airtable, juste peaufiner celles qui sont déjà liées. »
 *
 * Les 32 tables Airtable qui n'avaient jamais été tranchées passent donc
 * d'`undecided` à `excluded` — un état DÉCLARÉ, avec sa raison. C'est ce que le
 * contrat du miroir demande : aucune table ne doit rester dans un troisième
 * état « on n'y a jamais pensé ». Le compteur « tables sans décision » de
 * l'auditeur tombe ainsi à zéro, et ce qui reste à faire se lit d'un coup d'œil.
 *
 * `decided_by='user'` protège l'arbitrage : `syncMirrorRegistry()` ne réécrit
 * jamais une ligne posée par un humain, donc le prochain rafraîchissement des
 * métadonnées Airtable ne les remettra pas en `undecided`.
 *
 * Réversible : remettre une table à 'mirrored' se fait en une ligne le jour où
 * l'un de ces sujets doit vivre dans Boréal.
 */
export const id = '009-mirror-scope-frozen'
export const description = 'Miroir : les 32 tables Airtable sans décision passent en « exclue »'

const REASON = 'Hors périmètre — décision de Guillaume (2026-09-03) : on ne branche aucune nouvelle table Airtable, on peaufine les tables déjà liées.'

export function up(db) {
  const r = db.prepare(`
    UPDATE airtable_mirrors
       SET status='excluded',
           exclude_reason=?,
           decided_by='user',
           decided_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),
           updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
     WHERE status='undecided'
  `).run(REASON)
  return { mirrors_excluded: r.changes }
}
