/**
 * 052 — Novoxpress : réparation des identifiants stockés « 9413689.0 ».
 *
 * Signalement du 2026-09-10 : « Novoxpress /pickup/create-pickup (400):
 * {"message":"No shipment is exist with this shipment ID."} » sur un envoi dont
 * l'étiquette venait pourtant d'être achetée deux minutes plus tôt.
 *
 * Cause : Novoxpress renvoie `shipment_id` tantôt en texte
 * (« 1ZB799Y36837329590 » chez UPS), tantôt en NOMBRE JSON (9413689 chez Postes
 * Canada). Un nombre JS est lié en REAL par better-sqlite3 ; l'affinité TEXT de
 * la colonne le convertit alors en « 9413689.0 ». L'achat et le téléchargement
 * du PDF réussissaient (ils utilisent la valeur encore en mémoire), mais tout
 * appel ULTÉRIEUR relisait l'identifiant corrompu : print-label répond
 * {"status":404} et create-pickup 400 « No shipment is exist ». Vérifié en prod
 * le 2026-09-10 : `9413689` renvoie l'étiquette, `9413689.0` renvoie 404.
 *
 * Le code ne peut plus produire ce format (normalizeNovoxpressId dans
 * services/novoxpress.js, appliqué à l'écriture ET avant chaque appel) ; cette
 * migration répare les 5 envois déjà enregistrés.
 *
 * Garde-fou du WHERE : seuls les identifiants purement numériques suivis de
 * « .0 » sont touchés — un identifiant alphanumérique (UPS) ou un décimal
 * significatif reste intact.
 */
export const id = '052-normalize-novoxpress-ids'
export const description = "Retire le suffixe « .0 » des identifiants Novoxpress (shipment_id, pickup_id)"

const FIX = (table, column) => `
  UPDATE ${table}
     SET ${column} = substr(${column}, 1, length(${column}) - 2)
   WHERE ${column} IS NOT NULL
     AND ${column} LIKE '%.0'
     AND ${column} NOT GLOB '*[^0-9.]*'
     AND substr(${column}, 1, length(${column}) - 2) NOT GLOB '*[^0-9]*'
     AND length(${column}) > 2
`

export function up(db) {
  db.prepare(FIX('shipments', 'novoxpress_shipment_id')).run()
  db.prepare(FIX('shipments', 'novoxpress_pickup_id')).run()
  db.prepare(FIX('returns', 'return_novoxpress_shipment_id')).run()
}
