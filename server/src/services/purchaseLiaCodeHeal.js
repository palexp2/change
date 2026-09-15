import db from '../db/database.js'
import { getAccessToken, airtableFetch } from '../connectors/airtable.js'

// Achats arrivés SANS leur code LIA — et comment ils le récupèrent.
//
// Le code d'un achat (« LIA-2022 ») n'est pas saisi : c'est une formule Airtable bâtie
// sur un numéro automatique. Quand un achat vient d'être créé, le webhook nous livre
// l'enregistrement AVANT qu'Airtable n'ait calculé ce champ : l'achat entre dans le
// miroir avec un code vide. Rien ne le relit ensuite — un webhook ne se redéclenche
// que si un champ surveillé change — et l'achat reste invisible partout où on le
// désigne par son code, à commencer par le rattachement des lignes de facture
// (purchaseLiaMatch.js écarte explicitement les achats sans code).
//
// Cas réel : les 4 achats DigiKey du 11 septembre 2026 (dont LIA-2022, 10 × BATT
// HOLDER AA) n'étaient proposés sur aucune ligne de la facture du lendemain. Le
// moteur proposait à la place un achat d'un an, de 1 unité, qui partageait la même
// référence de pièce.
//
// Réparation : après chaque synchronisation des achats, les enregistrements encore
// sans code sont relus un par un chez Airtable. Ils sont rares (quelques-uns par
// jour, le temps qu'Airtable calcule la formule) et la passe ne coûte rien quand il
// n'y en a pas.

const DEFAULT_CODE_FIELD = 'ID'
const BASE_ID = 'appB4Fehk9jYd4s4B'
const TABLE_ID = 'tblapHxZmIYJl8ZR6'

// Nom du champ Airtable qui porte le code, lu dans la table de correspondance —
// il peut être renommé côté Airtable sans toucher au code.
function codeFieldName() {
  try {
    const row = db.prepare(
      "SELECT airtable_field_name FROM airtable_field_mappings WHERE module='achats' AND column_name='at_id' LIMIT 1",
    ).get()
    return row?.airtable_field_name || DEFAULT_CODE_FIELD
  } catch {
    return DEFAULT_CODE_FIELD
  }
}

function pendingPurchases(limit) {
  return db.prepare(`
    SELECT id, airtable_id FROM purchases
    WHERE airtable_id IS NOT NULL AND airtable_id <> ''
      AND (at_id IS NULL OR at_id = '')
    ORDER BY created_at DESC
    LIMIT ?
  `).all(limit)
}

/**
 * Relit chez Airtable les achats dont le code manque et l'inscrit quand il existe.
 * Best effort : toute erreur réseau laisse la base intacte.
 *
 * @returns {Promise<{pending:number, healed:number}>}
 */
export async function healMissingLiaCodes({ limit = 50 } = {}) {
  let rows = []
  try { rows = pendingPurchases(limit) } catch { return { pending: 0, healed: 0 } }
  if (!rows.length) return { pending: 0, healed: 0 }

  const field = codeFieldName()
  let token
  try { token = await getAccessToken() } catch { return { pending: rows.length, healed: 0 } }

  const write = db.prepare("UPDATE purchases SET at_id=?, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?")
  let healed = 0
  for (const row of rows) {
    try {
      const rec = await airtableFetch(`/${BASE_ID}/${TABLE_ID}/${row.airtable_id}`, token)
      const code = rec?.fields?.[field]
      if (code == null || String(code).trim() === '') continue
      write.run(String(code).trim(), row.id)
      healed++
    } catch { /* enregistrement supprimé, réseau : on retentera au prochain sync */ }
  }
  if (healed) console.log(`Achats : ${healed} code(s) LIA récupéré(s) chez Airtable (formule pas encore calculée à la création)`)
  return { pending: rows.length, healed }
}
