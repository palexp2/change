/**
 * 072 — Correction de l'identifiant du classeur TRX_Orisha.
 *
 * La conversion du 2026-09-15 a produit un premier classeur qui a dû être
 * abandonné : un nettoyage mal ciblé y avait retiré des lignes d'origine. Le
 * classeur en service a été refait à partir d'une copie prise AVANT toute
 * écriture, donc avec un identifiant de plus.
 *
 * La migration 071 avait déjà inscrit l'identifiant abandonné dans la
 * configuration stockée ; elle ne repassera pas. Celle-ci corrige, et accepte
 * n'importe lequel des identifiants périmés.
 */
import db from '../database.js'

export const id = '072-trx-sheet-id-correction'
export const description = 'TRX_Orisha : identifiant du classeur corrigé'

const SUPERSEDED = new Set([
  '1fRE0c1zv5zks70pwzgpojB7LZz-V5lHR',              // le .xlsx d'origine
  '1eSGoeXGDuSvjyMJ1vem1HyBrmcNeod7A50fCdL4gPtk',   // première conversion, abandonnée
])
const CURRENT = '1zztgXO-Z6b0I4bGmP5TcyCXMbT-X3cjBjGG2z4ccUug'

export function up(migrationDb) {
  const d = migrationDb || db
  let updated = 0
  for (const autoId of ['sys_bank_trx_sheet', 'sys_trx_sheet_mirror']) {
    const row = d.prepare('SELECT action_config FROM automations WHERE id=?').get(autoId)
    if (!row) continue
    let cfg = {}
    try { cfg = JSON.parse(row.action_config || '{}') } catch { continue }
    const key = autoId === 'sys_bank_trx_sheet' ? 'file_id' : 'spreadsheet_id'
    if (cfg[key] && !SUPERSEDED.has(cfg[key]) && cfg[key] !== CURRENT) continue
    if (cfg[key] === CURRENT) continue
    cfg[key] = CURRENT
    d.prepare("UPDATE automations SET action_config=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
      .run(JSON.stringify(cfg), autoId)
    updated++
  }
  return { updated }
}
