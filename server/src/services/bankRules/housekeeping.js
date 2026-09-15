/**
 * Le ménage des règles : ce qui encombre, nommé et chiffré.
 *
 * Une liste de règles s'encrasse de quatre façons, et aucune ne se voit à
 * l'œil nu sur vingt-sept lignes :
 *
 *   • des DOUBLONS — deux règles qui posent exactement la même condition ;
 *   • des ILLISIBLES — dont les conditions n'ont pas survécu à l'export ;
 *   • des SANS TRACE — dont le libellé n'apparaît nulle part au relevé ;
 *   • des DÉBORDANTES — qui ramassent plus large que leur fournisseur.
 *
 * Rien n'est effacé : une règle rangée est désactivée, elle garde sa place et
 * se restaure d'un clic. Une règle importée puis rangée ne revient pas à
 * l'import suivant — on ne remet pas de force ce qui a été écarté.
 */
import db from '../../db/database.js'
import { parseConditions } from './match.js'
import { verifyRule } from './verify.js'

const NOW = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`

// Deux règles sont identiques si elles posent la MÊME question : mêmes
// conditions, même sens, même compte. Leur nom n'entre pas en compte — c'est
// justement là que les doublons se cachent (« MARGE CRÉDIT DESJ. AJOUT » et
// « Întérêts sur la marge de crédit Desjardins » posent la même condition).
function conditionKey(rule) {
  const c = parseConditions(rule.conditions)
  const terms = c
    ? `${c.mode}:${(c.terms || []).map((t) => `${t.field}|${t.op}|${t.value}`).sort().join(';')}`
    : `simple:${(rule.label_pattern || '').toLowerCase().trim()}`
  return [terms, rule.direction, rule.account_id || '', rule.amount_min ?? '', rule.amount_max ?? ''].join('#')
}

/**
 * L'état du rangement, prêt à afficher. Chaque lot dit ce qu'il est, combien il
 * pèse, et quel geste le règle.
 */
export function housekeeping() {
  const rules = db.prepare('SELECT * FROM bank_rules WHERE deleted_at IS NULL').all()
  const checks = new Map(rules.map((r) => [r.id, verifyRule(r, { sample: 1 })]))

  // — Doublons : on garde la plus ancienne, les suivantes sont à ranger.
  const byKey = new Map()
  for (const r of rules) {
    const k = conditionKey(r)
    // Une règle illisible n'a pas de condition : elle relève de son propre lot.
    if (!r.conditions && /ruleType|ruleConditions/.test(r.label_pattern || '')) continue
    if (!byKey.has(k)) byKey.set(k, [])
    byKey.get(k).push(r)
  }
  const duplicates = []
  for (const group of byKey.values()) {
    if (group.length < 2) continue
    const sorted = [...group].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    const [keep, ...drop] = sorted
    for (const r of drop) duplicates.push({ id: r.id, name: r.name, why: `même condition que « ${keep.name} »` })
  }

  const dupIds = new Set(duplicates.map((d) => d.id))
  const unreadable = []
  const noTrace = []
  const spilling = []
  let healthy = 0

  for (const r of rules) {
    if (dupIds.has(r.id)) continue
    const check = checks.get(r.id)
    if (!r.conditions && /ruleType|ruleConditions/.test(r.label_pattern || '')) {
      unreadable.push({ id: r.id, name: r.name, why: 'conditions perdues à l\'export' })
      continue
    }
    if (!check.covers) {
      noTrace.push({ id: r.id, name: r.name, why: 'aucune ligne au relevé depuis 24 mois' })
      continue
    }
    if (check.warnings.filter((w) => !/aucune ligne passée/.test(w)).length) {
      spilling.push({ id: r.id, name: r.name, why: check.warnings[0], covers: check.covers })
      continue
    }
    healthy++
  }

  return {
    total: rules.length,
    healthy,
    lots: [
      { key: 'duplicates', label: 'Règles en double', action: 'Ranger', warn: true, items: duplicates },
      { key: 'unreadable', label: 'Règles illisibles', action: 'Ranger', warn: true, items: unreadable },
      { key: 'no_trace', label: 'Sans trace au relevé', action: 'Ranger', warn: false, items: noTrace },
      // Une règle qui déborde ne se range pas toute seule : elle se resserre à
      // la main, parce que seule une personne sait ce qu'elle devait viser.
      { key: 'spilling', label: 'Règles qui débordent', action: null, warn: true, items: spilling },
    ].filter((l) => l.items.length),
  }
}

// Ranger = désactiver, jamais effacer. Le retour en arrière est un clic.
export function archiveRules(ids = []) {
  if (!ids.length) return { archived: 0 }
  const upd = db.prepare(`UPDATE bank_rules SET active=0, updated_at=${NOW} WHERE id=? AND deleted_at IS NULL`)
  let archived = 0
  for (const id of ids) archived += upd.run(id).changes
  return { archived }
}

export function restoreRules(ids = []) {
  if (!ids.length) return { restored: 0 }
  const upd = db.prepare(`UPDATE bank_rules SET active=1, updated_at=${NOW} WHERE id=? AND deleted_at IS NULL`)
  let restored = 0
  for (const id of ids) restored += upd.run(id).changes
  return { restored }
}
