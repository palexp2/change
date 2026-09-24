/**
 * 071 — TRX_Orisha devient un Google Sheet natif : nouvel identifiant partout.
 *
 * Le fichier était un .xlsx déposé dans le Drive. L'ERP ne faisait que le LIRE,
 * donc le format n'avait pas d'importance. Depuis le 2026-09-15 le sens est
 * inversé — Boreal entretient le fichier : il y ajoute les lignes manquantes et
 * repeint les couleurs selon le statut.
 *
 * On ne peut pas écrire case par case dans un .xlsx : il faudrait le refaire au
 * complet à chaque passage et écraser qui l'aurait ouvert. Google refuse par
 * ailleurs de convertir un fichier sur place — la conversion ne peut créer
 * qu'une copie, donc un nouvel identifiant. Le classeur converti garde tout :
 * mêmes onglets, mêmes colonnes, mêmes couleurs, même contenu.
 *
 * Cette migration reporte le nouvel identifiant dans la configuration stockée
 * des automations, que le semis du démarrage ne réécrit jamais (il ne fait
 * qu'ajouter les clés absentes). Sans elle, la sync continuerait de lire
 * l'ancien .xlsx pendant que le miroir écrirait dans le nouveau.
 */
import db from '../database.js'

export const id = '071-trx-sheet-google-native'
export const description =
  'TRX_Orisha converti en Google Sheet : file_id des automations mis à jour'

const OLD_ID = '1fRE0c1zv5zks70pwzgpojB7LZz-V5lHR'
const NEW_ID = '1zztgXO-Z6b0I4bGmP5TcyCXMbT-X3cjBjGG2z4ccUug'

export function up(migrationDb) {
  const d = migrationDb || db
  const row = d.prepare('SELECT action_config FROM automations WHERE id=?').get('sys_bank_trx_sheet')
  if (!row) return { updated: 0 }
  let cfg = {}
  try { cfg = JSON.parse(row.action_config || '{}') } catch { return { updated: 0 } }
  // Idempotent, et respectueux d'un identifiant que quelqu'un aurait changé
  // à la main depuis : on ne remplace QUE l'ancien.
  if (cfg.file_id && cfg.file_id !== OLD_ID) return { updated: 0 }
  cfg.file_id = NEW_ID
  d.prepare('UPDATE automations SET action_config=?, updated_at=strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') WHERE id=?')
    .run(JSON.stringify(cfg), 'sys_bank_trx_sheet')
  return { updated: 1 }
}
