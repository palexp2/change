/**
 * Décoder les conditions telles que QuickBooks les exporte.
 *
 * Constaté sur le vrai export de Charles (2026-09-12) : la colonne des
 * conditions ne contient pas une phrase lisible mais la structure interne de
 * QuickBooks, par exemple —
 *
 *   {"ruleConditions":[{"ruleType":10,"value":"-1"},
 *                      {"ruleType":3,"value":"-1000.00"},
 *                      {"ruleType":1,"value":"MISCELLANEOUS ACC."}],
 *    "isAndRule":true}
 *
 * Deux choses qu'on ne savait pas et qui comptent :
 *  • une règle porte PLUSIEURS conditions, reliées par ET **ou par OU**
 *    (`isAndRule: false`) — « FRAIS FORFAIT » OU « PACKAGE FEE » OU… ;
 *  • les seuils de montant sont SIGNÉS — « moins de −1 000 » désigne un débit
 *    de plus de 1 000 $. C'est ainsi que la règle SALAIRES se distingue de la
 *    règle NETHRIS, toutes deux sur le libellé « MISCELLANEOUS ACC. ».
 *
 * Un type de condition inconnu n'est JAMAIS deviné : il ressort en `unknown`,
 * s'affiche dans l'aperçu, et la règle reste incomplète plutôt que fausse.
 */

// Les types rencontrés dans l'export. Les autres sont signalés tels quels.
const TYPES = {
  1: { field: 'label', op: 'contains', label: 'le libellé contient' },
  6: { field: 'label', op: 'contains', label: 'le détail bancaire contient' },
  3: { field: 'amount', op: 'lt', label: 'montant inférieur à' },
  4: { field: 'amount', op: 'gt', label: 'montant supérieur à' },
  5: { field: 'amount', op: 'eq', label: 'montant égal à' },
  10: { field: 'direction', op: 'is', label: 'sens' },
}

// Le tableur découpe parfois la structure sur plusieurs cellules (les virgules
// à l'intérieur du JSON). On rassemble la ligne entière et on ne garde que le
// bloc, des premières accolades aux dernières.
export function extractJsonBlob(cells) {
  const joined = cells.map((c) => String(c ?? '')).join(',')
  const start = joined.indexOf('{"ruleConditions"')
  if (start < 0) return null
  // Fin = la dernière accolade fermante de la ligne : le bloc est le dernier
  // objet complet, et tout ce qui suit dans la ligne appartient à d'autres
  // colonnes (qui, elles, ne contiennent pas d'accolades).
  const end = joined.lastIndexOf('}')
  if (end <= start) return null
  return joined.slice(start, end + 1)
}

/**
 * @returns { mode, terms, direction, unknown, summary } ou null.
 *   `terms` = conditions traduites ; `direction` = 'sortie' | 'entree' | null ;
 *   `unknown` = les types qu'on n'a pas su lire, en toutes lettres.
 */
export function decodeQbConditions(raw) {
  const text = typeof raw === 'string' ? raw : extractJsonBlob(Array.isArray(raw) ? raw : [raw])
  if (!text) return null
  let parsed
  try { parsed = JSON.parse(text) } catch { return null }
  const list = parsed?.ruleConditions
  if (!Array.isArray(list) || !list.length) return null

  const terms = []
  const unknown = []
  let direction = null

  for (const c of list) {
    const spec = TYPES[Number(c?.ruleType)]
    if (!spec) { unknown.push(`condition de type ${c?.ruleType} non reconnue`); continue }
    if (spec.field === 'direction') {
      // −1 = argent qui sort, 1 = argent qui entre.
      direction = String(c.value).trim() === '1' ? 'entree' : 'sortie'
      continue
    }
    if (spec.field === 'amount') {
      const v = Number(String(c.value).replace(/\s/g, '').replace(',', '.'))
      if (!Number.isFinite(v)) { unknown.push(`montant « ${c.value} » illisible`); continue }
      terms.push({ field: 'amount', op: spec.op, value: v })
      continue
    }
    const value = String(c.value || '').trim()
    if (!value) continue
    terms.push({ field: 'label', op: 'contains', value })
  }

  if (!terms.length) return null
  // Le sens est une condition à part (il a sa propre colonne) : le ET/OU ne
  // porte que sur les conditions restantes.
  const mode = parsed.isAndRule === false ? 'any' : 'all'
  return {
    mode,
    terms,
    direction,
    unknown,
    summary: summarize(mode, terms),
  }
}

// Le résumé lisible qui s'affiche dans la liste et sert de motif de repli.
export function summarize(mode, terms) {
  const join = mode === 'any' ? ' ou ' : ' et '
  return terms.map((t) => (t.field === 'amount'
    ? `${t.op === 'lt' ? 'moins de' : t.op === 'gt' ? 'plus de' : 'égal à'} ${t.value}`
    : `« ${t.value} »`)).join(join)
}
