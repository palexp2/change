// Conversion des valeurs d'une colonne `cf_*` quand on change le TYPE d'un champ
// personnalisé (kind='data').
//
// Pourquoi ce module : le type d'un champ de donnée était figé après création
// (sauf colonne adoptée depuis Airtable). Le verrou existait pour une seule
// raison — personne ne savait quoi faire des valeurs déjà stockées. Ici on le
// sait : chaque valeur passe par une représentation TEXTE pivot, puis est relue
// dans le type visé. Ce qui ne se relit pas est signalé à l'utilisateur, qui
// décide (avertissement outrepassable, cf. routes/custom-fields.js PUT /:id).
//
// Formes de stockage (rappel, cf. FIELD_KINDS.data) :
//   text / long_text / url / phone : TEXT
//   number / currency / duration   : REAL   (durée en SECONDES)
//   checkbox                       : INTEGER 0/1
//   date                           : TEXT ISO
//   single_select                  : TEXT   = LIBELLÉ du choix
//   multi_select                   : TEXT   = tableau JSON de libellés
//   attachment                     : TEXT   = tableau JSON de descripteurs de fichiers

import { v4 as uuid } from 'uuid'
import db from '../db/database.js'
import { regenerateView } from './customFieldsView.js'
import { parseDurationToSeconds, formatDurationSeconds, normalizeDurationFormat } from './duration.js'

const SAFE_IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/

// Affinité SQLite de la colonne physique selon le type de champ. Aligné sur le
// `sqlType` de FIELD_KINDS.data — c'est cette valeur qui décide si un changement
// de type exige de reconstruire la colonne (sinon un nombre irait s'écrire en
// texte dans une colonne TEXT, et `ORDER BY` trierait « 10 » avant « 9 »).
export function sqlAffinityFor(type) {
  if (type === 'number' || type === 'currency' || type === 'duration') return 'REAL'
  if (type === 'checkbox') return 'INTEGER'
  return 'TEXT'
}

// Types dont la valeur ne peut PAS être fabriquée à partir d'autre chose : les
// octets d'un fichier n'existent pas dans une chaîne. Convertir vers
// « attachement » vide donc la colonne — l'avertissement le dit.
const UNFABRICABLE = new Set(['attachment'])

const deaccent = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
const norm = s => deaccent(s).toLowerCase().trim()

function parseOptions(raw) {
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try { return JSON.parse(raw) || {} } catch { return {} }
}

function jsonArray(raw) {
  if (Array.isArray(raw)) return raw
  try {
    const v = JSON.parse(String(raw))
    return Array.isArray(v) ? v : null
  } catch { return null }
}

// ── Valeur stockée → texte pivot ────────────────────────────────────────────
// Le pivot est ce que l'utilisateur VOIT, pas la forme interne : une durée de
// 5400 s devient « 1:30 », une case cochée « Oui ». C'est ce qui rend la
// conversion réversible dans le cas courant (durée → texte → durée).
export function valueToText(raw, type, options) {
  if (raw === null || raw === undefined || raw === '') return null
  const opts = parseOptions(options)
  switch (type) {
    case 'checkbox':
      return (raw === 0 || raw === '0' || raw === false) ? 'Non' : 'Oui'
    case 'duration':
      return formatDurationSeconds(Number(raw), normalizeDurationFormat(opts.format))
    case 'number':
    case 'currency': {
      const n = Number(raw)
      return Number.isFinite(n) ? String(n) : String(raw)
    }
    case 'multi_select': {
      const arr = jsonArray(raw)
      return arr ? arr.map(v => String(v)).filter(Boolean).join(', ') || null : String(raw)
    }
    case 'attachment': {
      const arr = jsonArray(raw)
      if (!arr) return String(raw)
      const names = arr.map(f => String(f?.name || '')).filter(Boolean)
      return names.length ? names.join(', ') : null
    }
    default:
      return String(raw)
  }
}

// ── Texte pivot → valeur du type visé ───────────────────────────────────────
// Retourne { ok: true, value } ou { ok: false }. `ok: false` = valeur laissée à
// l'utilisateur (avertissement), jamais une écriture silencieuse.

const TRUE_WORDS = new Set(['1', 'true', 'vrai', 'oui', 'yes', 'y', 'o', 'x', 'on', 'coche'])
const FALSE_WORDS = new Set(['0', 'false', 'faux', 'non', 'no', 'n', 'off'])

function textToNumber(text) {
  // Tolère les formats saisis à la main : « 1 234,56 $ », « 1,234.56 », « 45 % ».
  // L'espace insécable est écrit en échappement (\u00a0) : un caractère invisible
  // dans une classe de regex est illisible — et refusé par le lint.
  let t = deaccent(text).replace(/[\s\u00a0$€%]/g, '')
  if (!t) return null
  const hasComma = t.includes(','), hasDot = t.includes('.')
  if (hasComma && hasDot) {
    // Le dernier séparateur rencontré est le décimal, l'autre groupe les milliers.
    t = t.lastIndexOf(',') > t.lastIndexOf('.')
      ? t.replace(/\./g, '').replace(',', '.')
      : t.replace(/,/g, '')
  } else if (hasComma) {
    t = t.replace(',', '.')
  }
  if (!/^[+-]?\d*\.?\d+$/.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

function textToDate(text) {
  const t = String(text).trim()
  // ISO (date, ou date+heure) — la forme que l'app écrit elle-même.
  let m = /^(\d{4})-(\d{2})-(\d{2})([T ].*)?$/.exec(t)
  if (m) return validDate(m[1], m[2], m[3]) ? (m[4] ? t : `${m[1]}-${m[2]}-${m[3]}`) : null
  // JJ/MM/AAAA ou JJ-MM-AAAA (convention d'ici — le mois d'abord n'est pas géré :
  // deviner entre 03/04 et 04/03 fabriquerait de fausses dates en silence).
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(t)
  if (m) {
    const d = m[1].padStart(2, '0'), mo = m[2].padStart(2, '0')
    return validDate(m[3], mo, d) ? `${m[3]}-${mo}-${d}` : null
  }
  // AAAA/MM/JJ
  m = /^(\d{4})[/](\d{1,2})[/](\d{1,2})$/.exec(t)
  if (m) {
    const mo = m[2].padStart(2, '0'), d = m[3].padStart(2, '0')
    return validDate(m[1], mo, d) ? `${m[1]}-${mo}-${d}` : null
  }
  return null
}

function validDate(y, m, d) {
  const dt = new Date(Date.UTC(+y, +m - 1, +d))
  return dt.getUTCFullYear() === +y && dt.getUTCMonth() === +m - 1 && dt.getUTCDate() === +d
}

// Index libellé normalisé → libellé exact, pour retrouver un choix malgré la
// casse et les accents (« installation » retrouve « Installation »).
function choiceIndex(options) {
  const choices = parseOptions(options)?.choices
  if (!Array.isArray(choices) || !choices.length) return null
  const idx = new Map()
  for (const c of choices) {
    const label = String(c?.label ?? '')
    if (label) idx.set(norm(label), label)
  }
  return idx.size ? idx : null
}

function textToValue(text, type, options, { choices } = {}) {
  switch (type) {
    case 'text':
    case 'long_text':
    case 'url':
    case 'phone':
      return { ok: true, value: text }
    case 'number':
    case 'currency': {
      const n = textToNumber(text)
      return n === null ? { ok: false } : { ok: true, value: n }
    }
    case 'duration': {
      const s = parseDurationToSeconds(text)
      return s === null ? { ok: false } : { ok: true, value: s }
    }
    case 'date': {
      const d = textToDate(text)
      return d === null ? { ok: false } : { ok: true, value: d }
    }
    case 'checkbox': {
      const k = norm(text)
      if (TRUE_WORDS.has(k)) return { ok: true, value: 1 }
      if (FALSE_WORDS.has(k)) return { ok: true, value: 0 }
      const n = textToNumber(text)
      if (n !== null) return { ok: true, value: n === 0 ? 0 : 1 }
      return { ok: false }
    }
    case 'single_select': {
      if (!choices) return { ok: false }
      const hit = choices.get(norm(text))
      return hit === undefined ? { ok: false } : { ok: true, value: hit }
    }
    case 'multi_select': {
      if (!choices) return { ok: false }
      const parts = String(text).split(',').map(s => s.trim()).filter(Boolean)
      if (!parts.length) return { ok: true, value: null }
      const labels = []
      for (const p of parts) {
        const hit = choices.get(norm(p))
        if (hit === undefined) return { ok: false }
        if (!labels.includes(hit)) labels.push(hit)
      }
      return { ok: true, value: JSON.stringify(labels) }
    }
    default:
      return { ok: false }
  }
}

// Choix DÉRIVÉS des données quand on passe à une sélection sans avoir encore
// configuré de liste : les valeurs distinctes déjà en base FONT la liste (c'est
// le geste attendu — sinon convertir « Texte → Sélection » viderait la colonne
// pour ensuite demander de retaper les mêmes libellés à la main).
const MAX_DERIVED_CHOICES = 100

function deriveChoices(texts, multi) {
  const labels = []
  const seen = new Set()
  for (const t of texts) {
    const parts = multi ? String(t).split(',').map(s => s.trim()).filter(Boolean) : [t]
    for (const p of parts) {
      const k = norm(p)
      if (!k || seen.has(k)) continue
      seen.add(k)
      labels.push(p)
      if (labels.length > MAX_DERIVED_CHOICES) return null // trop de valeurs : ce n'est pas une sélection
    }
  }
  if (!labels.length) return null
  return {
    choices: labels.map(label => ({ id: `opt_${uuid().slice(0, 8)}`, label, color: 'gray' })),
    default_id: null,
    default_ids: [],
    alphabetize: false,
  }
}

// ── Plan de conversion (lecture seule) ──────────────────────────────────────
// Calcule tout AVANT d'écrire : ce qui se convertit, ce qui ne se convertit
// pas, et les exemples à montrer. `field` = ligne custom_fields.
//
// `toOptions` : options DEMANDÉES pour le type visé (peut être absent). Pour une
// sélection sans liste fournie, on dérive la liste des données.
export function planTypeConversion(field, toType, toOptions) {
  const { erp_table: erpTable, column_name: columnName, type: fromType, options: fromOptions } = field
  if (!SAFE_IDENT.test(erpTable) || !SAFE_IDENT.test(columnName)) {
    throw new Error('Identifiant de colonne invalide')
  }

  const physical = new Set(db.pragma(`table_info(${erpTable})`).map(c => c.name))
  const plan = {
    from: fromType, to: toType,
    total: 0, filled: 0, converted: 0, unconvertible: 0,
    samples: [], derivedOptions: null,
    rows: [], clears: [],
    rebuild: sqlAffinityFor(fromType) !== sqlAffinityFor(toType) && physical.has(columnName),
  }
  if (!physical.has(columnName)) return plan // champ sans colonne physique : rien à convertir

  plan.total = db.prepare(`SELECT COUNT(*) n FROM ${erpTable}`).get().n
  const rows = db.prepare(
    `SELECT id, [${columnName}] AS v FROM ${erpTable} WHERE [${columnName}] IS NOT NULL AND [${columnName}] <> ''`
  ).all()
  plan.filled = rows.length
  if (!rows.length) {
    plan.derivedOptions = null
    return plan
  }

  // Pivot texte, mémoïsé par valeur brute : une colonne de 4000 lignes n'a
  // souvent que quelques dizaines de valeurs distinctes.
  const textByRaw = new Map()
  const textOf = raw => {
    const k = `${typeof raw}:${raw}`
    if (!textByRaw.has(k)) textByRaw.set(k, valueToText(raw, fromType, fromOptions))
    return textByRaw.get(k)
  }

  const isSelect = toType === 'single_select' || toType === 'multi_select'
  let choices = choiceIndex(toOptions)
  if (isSelect && !choices) {
    const derived = deriveChoices(rows.map(r => textOf(r.v)).filter(t => t != null), toType === 'multi_select')
    if (derived) {
      plan.derivedOptions = derived
      choices = choiceIndex(derived)
    }
  }

  const failCounts = new Map()
  const convByText = new Map()
  for (const r of rows) {
    const text = textOf(r.v)
    if (text == null) { plan.clears.push(r.id); continue }
    if (!convByText.has(text)) {
      convByText.set(text, UNFABRICABLE.has(toType) ? { ok: false } : textToValue(text, toType, toOptions, { choices }))
    }
    const res = convByText.get(text)
    if (res.ok) {
      plan.converted++
      plan.rows.push({ id: r.id, value: res.value })
    } else {
      plan.unconvertible++
      plan.clears.push(r.id)
      failCounts.set(text, (failCounts.get(text) || 0) + 1)
    }
  }

  plan.samples = [...failCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([value, count]) => ({ value: value.length > 60 ? value.slice(0, 60) + '…' : value, count }))
  return plan
}

// Convertit une valeur unique (sert au `default_value` du champ, qui suit le
// même chemin que les données — un défaut « Oui » sur une case reste « 1 »).
export function convertSingleValue(raw, fromType, fromOptions, toType, toOptions) {
  const text = valueToText(raw, fromType, fromOptions)
  if (text == null) return { ok: true, value: null }
  if (UNFABRICABLE.has(toType)) return { ok: false }
  return textToValue(text, toType, toOptions, { choices: choiceIndex(toOptions) })
}

// Une colonne indexée ne peut pas être droppée (SQLite refuse) : on garde alors
// l'affinité d'origine plutôt que d'échouer — les valeurs, elles, sont bien
// converties.
function columnIsIndexed(erpTable, columnName) {
  for (const idx of db.pragma(`index_list(${erpTable})`)) {
    if (db.pragma(`index_info(${idx.name})`).some(c => c.name === columnName)) return true
  }
  return false
}

// ── Application ─────────────────────────────────────────────────────────────
// Écrit les valeurs converties, vide les non convertibles. Si l'affinité de la
// colonne change (texte ↔ nombre ↔ booléen), la colonne physique est refaite :
// ADD → remplir → DROP → RENAME, la vue <table>_v étant détruite le temps de
// l'opération (SQLite refuse DROP COLUMN tant qu'elle la référence — même
// pattern que services/fieldPurge.js).
//
// N'ouvre PAS de transaction : l'appelant l'englobe avec la mise à jour de
// custom_fields, pour qu'un type ne puisse jamais mentir sur ses données.
export function applyTypeConversion(field, plan) {
  const { erp_table: erpTable, column_name: col } = field
  const rebuild = plan.rebuild && !columnIsIndexed(erpTable, col)

  if (rebuild) {
    const tmp = `${col}__cvt`.slice(0, 60)
    db.exec(`DROP VIEW IF EXISTS ${erpTable}_v`)
    db.exec(`ALTER TABLE ${erpTable} ADD COLUMN [${tmp}] ${sqlAffinityFor(plan.to)}`)
    const set = db.prepare(`UPDATE ${erpTable} SET [${tmp}]=? WHERE id=?`)
    for (const r of plan.rows) set.run(r.value, r.id)
    db.exec(`ALTER TABLE ${erpTable} DROP COLUMN [${col}]`)
    db.exec(`ALTER TABLE ${erpTable} RENAME COLUMN [${tmp}] TO [${col}]`)
    regenerateView(erpTable)
    return { rebuilt: true }
  }

  const set = db.prepare(`UPDATE ${erpTable} SET [${col}]=? WHERE id=?`)
  for (const r of plan.rows) set.run(r.value, r.id)
  if (plan.clears.length) {
    const clear = db.prepare(`UPDATE ${erpTable} SET [${col}]=NULL WHERE id=?`)
    for (const id of plan.clears) clear.run(id)
  }
  return { rebuilt: false }
}
