// Regrouper plusieurs lignes du relevé en une seule, et pouvoir revenir en
// arrière (Charles, 2026-10-06 : les 10 petits crédits Rona du 30 septembre
// contre une seule ligne de 163,49 $ — « avec l'option de les dégrouper, et de
// les regrouper si je les dégroupe »).
//
// Les lignes regroupées ne sont pas effacées : elles sont mises de côté
// (`deleted_at` + `group_parent_id`), ce qui les retire de toutes les vues, des
// soldes et des appariements sans rien changer ailleurs. Dégrouper fait
// l'inverse : la ligne groupée est mise de côté à son tour, et ses lignes
// reviennent — chacune garde le lien vers son groupe pour pouvoir le refaire.
import db from '../db/database.js'
import { newRecordId } from '../utils/recordId.js'
import { round2 } from '../utils/money.js'

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
const ZERO = 0.005

const get = (id) => db.prepare('SELECT * FROM bank_transactions WHERE id=?').get(id)
// Une ligne déjà écrite ailleurs (QuickBooks, document, virement) ne se fond
// pas dans un groupe : son écriture resterait orpheline.
const isBooked = (t) => !!(t.qb_txn_id || t.matched_id || t.transfer_txn_id)

export const membersOf = (parentId) => db.prepare(
  'SELECT * FROM bank_transactions WHERE group_parent_id=? ORDER BY txn_date, created_at',
).all(parentId)

function commonLabel(rows) {
  const labels = rows.map((r) => String(r.details || r.description || '').replace(/\s{2,}/g, ' ').trim())
  const first = labels[0] || ''
  if (labels.every((l) => l === first)) return first
  const word = first.split(' ')[0]
  return labels.every((l) => l.split(' ')[0] === word) ? word : 'Lignes'
}

/**
 * @param ids       les lignes à regrouper (≥ 2, même compte)
 * @param parentId  une ligne déjà existante qui porte le total (facultatif)
 */
export function groupTransactions(ids, { parentId = null } = {}) {
  const rows = [...new Set(ids)].map(get).filter(Boolean)
  if (rows.length < 2 && !parentId) throw new Error('Choisis au moins deux lignes')
  if (rows.some((r) => r.deleted_at)) throw new Error('Une des lignes n\'existe plus')
  const accountId = rows[0].account_id
  if (rows.some((r) => r.account_id !== accountId)) throw new Error('Les lignes doivent être du même compte')
  if (rows.some(isBooked)) throw new Error('Une des lignes est déjà comptabilisée ou appariée')
  if (rows.some((r) => membersOf(r.id).length)) throw new Error('Une des lignes est déjà un groupe')
  const total = round2(rows.reduce((s, r) => s + r.amount, 0))

  return db.transaction(() => {
    let parent
    if (parentId) {
      parent = get(parentId)
      if (!parent || parent.deleted_at || parent.account_id !== accountId) throw new Error('Ligne groupée introuvable')
      if (rows.some((r) => r.id === parent.id)) throw new Error('La ligne groupée ne peut pas être dans le groupe')
      if (Math.abs(parent.amount - total) > ZERO) throw new Error(`Le total (${total.toFixed(2)}) ne correspond pas à la ligne (${parent.amount.toFixed(2)})`)
    } else {
      const date = rows.map((r) => r.txn_date).sort().pop()
      const id = newRecordId()
      db.prepare(`
        INSERT INTO bank_transactions (id, account_id, txn_date, description, amount, dedup_key, status, pending)
        VALUES (?,?,?,?,?,?,'a_traiter',0)
      `).run(id, accountId, date, `${commonLabel(rows)} — ${rows.length} lignes regroupées`, total, `group:${id}`)
      parent = get(id)
    }
    const hide = db.prepare(`UPDATE bank_transactions SET group_parent_id=?, deleted_at=${NOW}, updated_at=${NOW} WHERE id=?`)
    for (const r of rows) hide.run(parent.id, r.id)
    return { parent: get(parent.id), count: rows.length }
  })()
}

export function ungroupTransaction(parentId) {
  const parent = get(parentId)
  if (!parent || parent.deleted_at) throw new Error('Ligne introuvable')
  const members = membersOf(parent.id)
  if (!members.length) throw new Error('Cette ligne n\'est pas un groupe')
  if (isBooked(parent)) throw new Error('La ligne groupée est déjà comptabilisée : annule d\'abord son écriture')
  db.transaction(() => {
    db.prepare(`UPDATE bank_transactions SET deleted_at=${NOW}, updated_at=${NOW} WHERE id=?`).run(parent.id)
    db.prepare(`UPDATE bank_transactions SET deleted_at=NULL, updated_at=${NOW} WHERE group_parent_id=?`).run(parent.id)
  })()
  return { parent_id: parent.id, count: members.length }
}

// Refaire un groupe défait, depuis n'importe laquelle de ses lignes.
export function regroupTransaction(id) {
  const row = get(id)
  if (!row) throw new Error('Ligne introuvable')
  const parentId = row.group_parent_id || row.id
  const parent = get(parentId)
  const members = membersOf(parentId)
  if (!parent || !members.length) throw new Error('Cette ligne n\'a pas de groupe')
  if (!parent.deleted_at) return { parent, count: members.length }
  const visible = members.filter((m) => !m.deleted_at)
  if (visible.some(isBooked)) throw new Error('Une des lignes a été comptabilisée depuis : regroupement impossible')
  db.transaction(() => {
    db.prepare(`UPDATE bank_transactions SET deleted_at=NULL, updated_at=${NOW} WHERE id=?`).run(parentId)
    db.prepare(`UPDATE bank_transactions SET deleted_at=${NOW}, updated_at=${NOW} WHERE group_parent_id=? AND deleted_at IS NULL`).run(parentId)
  })()
  return { parent: get(parentId), count: members.length }
}
