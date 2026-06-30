import { runInNewContext } from 'node:vm'
import { parseDurationToSeconds, formatDurationSeconds } from './duration.js'

// ───────────────────────────────────────────────────────────────────────────
// Bibliothèque de fonctions de formule — parité Airtable.
//
// Deux consommateurs partagent EXACTEMENT les mêmes implémentations :
//
//  1. Le moteur de champs calculés (kind='formula') : ces fonctions sont
//     enregistrées comme UDF SQLite via registerFormulaFunctions(db) au
//     démarrage, de sorte qu'une expression comme
//        SWITCH(status, 'Gagné', total, 0)   ou   DATEADD(document_date, 30, 'days')
//     écrite dans custom_fields.formula_expr s'évalue réellement dans la VUE
//     <table>_v (voir customFieldsView.js). SQLite expose déjà nativement
//     abs/round/upper/lower/trim/replace/min/max/floor/ceil/pow/sqrt/exp/mod… ;
//     on n'enregistre donc QUE ce qui manque (et jamais un nom d'agrégat —
//     SUM/COUNT/MIN/MAX/AVG restent les agrégats natifs utilisés par les rollups).
//
//  2. evaluateFormula() : un évaluateur JS sandboxé (dialecte {champ}) gardé
//     comme moteur de référence / fallback. Il NE doit pas avaler les erreurs
//     silencieusement — il les loggue (voir plus bas).
//
// Chaque entrée déclare son `name`, sa `category`, sa `sig` (signature lisible),
// un `hint`, son `impl`, et des drapeaux : `sqlite:false` pour ne PAS exposer la
// fonction en UDF (opérateurs/agrégats), `deterministic:false` pour NOW/TODAY.
// ───────────────────────────────────────────────────────────────────────────

// ── Helpers de coercion ────────────────────────────────────────────────────
function toNum(v) {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
function toStr(v) { return v == null ? null : String(v) }
function toDate(v) {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}
const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, '0')

function isoWeek(d) {
  // Numéro de semaine ISO-8601 (semaine commençant lundi, semaine 1 = celle du
  // 1er jeudi de l'année).
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = (t.getUTCDay() + 6) % 7
  t.setUTCDate(t.getUTCDate() - day + 3)
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4))
  const fday = (firstThursday.getUTCDay() + 6) % 7
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fday + 3)
  return 1 + Math.round((t - firstThursday) / (7 * 24 * 3600 * 1000))
}

const DAY_MS = 24 * 3600 * 1000
const DIFF_UNIT_MS = {
  milliseconds: 1, ms: 1, seconds: 1000, s: 1000, minutes: 60000, m: 60000,
  hours: 3600000, h: 3600000, days: DAY_MS, d: DAY_MS, weeks: 7 * DAY_MS, w: 7 * DAY_MS,
}

function addToDate(d, count, units) {
  const u = String(units || 'days').toLowerCase()
  const r = new Date(d.getTime())
  const n = Math.trunc(count)
  if (u.startsWith('year')) r.setUTCFullYear(r.getUTCFullYear() + n)
  else if (u.startsWith('quarter')) r.setUTCMonth(r.getUTCMonth() + n * 3)
  else if (u.startsWith('month')) r.setUTCMonth(r.getUTCMonth() + n)
  else if (u.startsWith('week')) r.setUTCDate(r.getUTCDate() + n * 7)
  else if (u.startsWith('day') || u === 'd') r.setUTCDate(r.getUTCDate() + n)
  else if (u.startsWith('hour') || u === 'h') r.setUTCHours(r.getUTCHours() + n)
  else if (u.startsWith('minute')) r.setUTCMinutes(r.getUTCMinutes() + n)
  else if (u.startsWith('second')) r.setUTCSeconds(r.getUTCSeconds() + n)
  else return null
  return r
}

function dateDiff(a, b, units) {
  // Airtable : DATETIME_DIFF(a, b, unit) = a − b dans l'unité demandée.
  const u = String(units || 'days').toLowerCase()
  if (u.startsWith('year')) return a.getUTCFullYear() - b.getUTCFullYear()
  if (u.startsWith('month')) {
    return (a.getUTCFullYear() - b.getUTCFullYear()) * 12 + (a.getUTCMonth() - b.getUTCMonth())
  }
  const ms = DIFF_UNIT_MS[u] ?? DAY_MS
  return Math.trunc((a.getTime() - b.getTime()) / ms)
}

function datetimeFormat(d, fmt) {
  // Sous-ensemble des tokens Moment/Airtable les plus courants. Toujours en UTC
  // (cohérent avec le stockage ISO-Z de l'app). Format par défaut : ISO.
  if (!fmt) return d.toISOString()
  const tokens = {
    YYYY: d.getUTCFullYear(),
    YY: pad(d.getUTCFullYear() % 100),
    MMMM: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][d.getUTCMonth()],
    MMM: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()],
    MM: pad(d.getUTCMonth() + 1),
    M: d.getUTCMonth() + 1,
    DD: pad(d.getUTCDate()),
    D: d.getUTCDate(),
    HH: pad(d.getUTCHours()),
    H: d.getUTCHours(),
    mm: pad(d.getUTCMinutes()),
    m: d.getUTCMinutes(),
    ss: pad(d.getUTCSeconds()),
    s: d.getUTCSeconds(),
  }
  // Remplace les tokens du plus long au plus court pour éviter les collisions.
  return String(fmt).replace(/YYYY|MMMM|MMM|YY|MM|DD|HH|mm|ss|M|D|H|m|s/g, (t) => String(tokens[t]))
}

// ── Catalogue ──────────────────────────────────────────────────────────────
// `impl` reçoit déjà des valeurs JS (null pour SQL NULL). Retourner null = cellule
// vide ; les exceptions sont neutralisées en null par le wrapper (cf.
// registerFormulaFunctions / SANDBOX_BASE) pour ne jamais casser une VUE entière.

const F = [
  // — Texte —
  { name: 'UPPER', category: 'Texte', sig: 'UPPER(texte)', hint: 'Majuscules', sqlite: false,
    impl: (s) => s == null ? null : String(s).toUpperCase() },
  { name: 'LOWER', category: 'Texte', sig: 'LOWER(texte)', hint: 'Minuscules', sqlite: false,
    impl: (s) => s == null ? null : String(s).toLowerCase() },
  { name: 'TRIM', category: 'Texte', sig: 'TRIM(texte)', hint: 'Enlève les espaces', sqlite: false,
    impl: (s) => s == null ? null : String(s).trim() },
  { name: 'LEN', category: 'Texte', sig: 'LEN(texte)', hint: 'Longueur',
    impl: (s) => s == null ? null : String(s).length },
  { name: 'LEFT', category: 'Texte', sig: 'LEFT(texte, n)', hint: 'n premiers caractères',
    impl: (s, n) => s == null ? null : String(s).slice(0, Math.max(0, toNum(n) ?? 0)) },
  { name: 'RIGHT', category: 'Texte', sig: 'RIGHT(texte, n)', hint: 'n derniers caractères',
    impl: (s, n) => { if (s == null) return null; const k = Math.max(0, toNum(n) ?? 0); return k === 0 ? '' : String(s).slice(-k) } },
  { name: 'MID', category: 'Texte', sig: 'MID(texte, début, longueur)', hint: 'Sous-chaîne (début 1-indexé)',
    impl: (s, start, count) => { if (s == null) return null; const st = (toNum(start) ?? 1) - 1; const c = toNum(count); return String(s).slice(st, c == null ? undefined : st + c) } },
  { name: 'FIND', category: 'Texte', sig: 'FIND(cherché, texte, [début])', hint: 'Position (0 si absent)',
    impl: (needle, hay, start) => { if (needle == null || hay == null) return null; const p = String(hay).indexOf(String(needle), (toNum(start) ?? 1) - 1); return p < 0 ? 0 : p + 1 } },
  { name: 'SEARCH', category: 'Texte', sig: 'SEARCH(cherché, texte, [début])', hint: 'Position (vide si absent)',
    impl: (needle, hay, start) => { if (needle == null || hay == null) return null; const p = String(hay).indexOf(String(needle), (toNum(start) ?? 1) - 1); return p < 0 ? null : p + 1 } },
  { name: 'REPLACE', category: 'Texte', sig: 'REPLACE(texte, début, longueur, remplacement)', hint: 'Remplace par position',
    impl: (s, start, count, repl) => { if (s == null) return null; const str = String(s); const st = (toNum(start) ?? 1) - 1; const c = toNum(count) ?? 0; return str.slice(0, st) + String(repl ?? '') + str.slice(st + c) } },
  { name: 'SUBSTITUTE', category: 'Texte', sig: 'SUBSTITUTE(texte, ancien, nouveau, [n])', hint: 'Remplace une sous-chaîne',
    impl: (s, oldT, newT, nth) => {
      if (s == null) return null
      const str = String(s), o = String(oldT ?? ''), nw = String(newT ?? '')
      if (o === '') return str
      if (nth == null) return str.split(o).join(nw)
      const k = toNum(nth)
      let i = -1, count = 0
      while ((i = str.indexOf(o, i + 1)) !== -1) { count++; if (count === k) return str.slice(0, i) + nw + str.slice(i + o.length) }
      return str
    } },
  { name: 'CONCATENATE', category: 'Texte', sig: 'CONCATENATE(a, b, …)', hint: 'Concatène', varargs: true,
    impl: (...args) => args.filter(a => a != null).map(String).join('') },
  { name: 'T', category: 'Texte', sig: 'T(valeur)', hint: 'Texte si texte, sinon vide',
    impl: (v) => typeof v === 'string' ? v : '' },
  { name: 'VALUE', category: 'Texte', sig: 'VALUE(texte)', hint: 'Extrait un nombre',
    impl: (s) => { if (s == null) return null; const m = String(s).replace(/[^0-9.\-]/g, ''); const n = parseFloat(m); return Number.isFinite(n) ? n : null } },

  // — Nombres —
  { name: 'ABS', category: 'Nombre', sig: 'ABS(n)', hint: 'Valeur absolue', sqlite: false,
    impl: (n) => { const x = toNum(n); return x == null ? null : Math.abs(x) } },
  { name: 'ROUND', category: 'Nombre', sig: 'ROUND(n, [déc])', hint: 'Arrondit', sqlite: false,
    impl: (n, d) => { const x = toNum(n); if (x == null) return null; const f = 10 ** (toNum(d) ?? 0); return Math.round(x * f) / f } },
  { name: 'ROUNDUP', category: 'Nombre', sig: 'ROUNDUP(n, [déc])', hint: 'Arrondit vers le haut',
    impl: (n, d) => { const x = toNum(n); if (x == null) return null; const f = 10 ** (toNum(d) ?? 0); return Math.sign(x) * Math.ceil(Math.abs(x) * f) / f } },
  { name: 'ROUNDDOWN', category: 'Nombre', sig: 'ROUNDDOWN(n, [déc])', hint: 'Arrondit vers le bas',
    impl: (n, d) => { const x = toNum(n); if (x == null) return null; const f = 10 ** (toNum(d) ?? 0); return Math.sign(x) * Math.floor(Math.abs(x) * f) / f } },
  { name: 'CEILING', category: 'Nombre', sig: 'CEILING(n)', hint: 'Entier supérieur', sqlite: false,
    impl: (n) => { const x = toNum(n); return x == null ? null : Math.ceil(x) } },
  { name: 'FLOOR', category: 'Nombre', sig: 'FLOOR(n)', hint: 'Entier inférieur', sqlite: false,
    impl: (n) => { const x = toNum(n); return x == null ? null : Math.floor(x) } },
  { name: 'EVEN', category: 'Nombre', sig: 'EVEN(n)', hint: 'Pair supérieur',
    impl: (n) => { const x = toNum(n); if (x == null) return null; const s = x < 0 ? -1 : 1; let m = Math.ceil(Math.abs(x)); if (m % 2) m++; return s * m } },
  { name: 'ODD', category: 'Nombre', sig: 'ODD(n)', hint: 'Impair supérieur',
    impl: (n) => { const x = toNum(n); if (x == null) return null; const s = x < 0 ? -1 : 1; let m = Math.ceil(Math.abs(x)); if (m % 2 === 0) m++; return s * m } },
  { name: 'MOD', category: 'Nombre', sig: 'MOD(n, diviseur)', hint: 'Reste', sqlite: false,
    impl: (n, d) => { const x = toNum(n), y = toNum(d); return (x == null || !y) ? null : x % y } },
  { name: 'POWER', category: 'Nombre', sig: 'POWER(n, exp)', hint: 'Puissance', sqlite: false,
    impl: (n, e) => { const x = toNum(n), y = toNum(e); return (x == null || y == null) ? null : x ** y } },
  { name: 'SQRT', category: 'Nombre', sig: 'SQRT(n)', hint: 'Racine carrée', sqlite: false,
    impl: (n) => { const x = toNum(n); return x == null ? null : Math.sqrt(x) } },
  { name: 'EXP', category: 'Nombre', sig: 'EXP(n)', hint: 'e^n', sqlite: false,
    impl: (n) => { const x = toNum(n); return x == null ? null : Math.exp(x) } },
  { name: 'LOG', category: 'Nombre', sig: 'LOG(n, [base])', hint: 'Logarithme', sqlite: false,
    impl: (n, b) => { const x = toNum(n); if (x == null) return null; const base = toNum(b); return base == null ? Math.log10(x) : Math.log(x) / Math.log(base) } },
  { name: 'PI', category: 'Nombre', sig: 'PI()', hint: '3.14159…', sqlite: false, impl: () => Math.PI },
  { name: 'AVERAGE', category: 'Nombre', sig: 'AVERAGE(a, b, …)', hint: 'Moyenne', varargs: true,
    impl: (...args) => { const v = args.map(toNum).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null } },
  { name: 'MAX', category: 'Nombre', sig: 'MAX(a, b, …)', hint: 'Maximum', sqlite: false, varargs: true,
    impl: (...args) => { const v = args.map(toNum).filter(x => x != null); return v.length ? Math.max(...v) : null } },
  { name: 'MIN', category: 'Nombre', sig: 'MIN(a, b, …)', hint: 'Minimum', sqlite: false, varargs: true,
    impl: (...args) => { const v = args.map(toNum).filter(x => x != null); return v.length ? Math.min(...v) : null } },
  { name: 'SUM', category: 'Nombre', sig: 'SUM(a, b, …)', hint: 'Somme', sqlite: false, varargs: true,
    impl: (...args) => args.map(toNum).filter(x => x != null).reduce((a, b) => a + b, 0) },

  // — Logique —
  { name: 'IF', category: 'Logique', sig: 'IF(condition, siVrai, siFaux)', hint: 'Branche conditionnelle',
    impl: (c, t, f) => c ? t : f },
  { name: 'SWITCH', category: 'Logique', sig: 'SWITCH(valeur, cas1, res1, …, [défaut])', hint: 'Aiguillage multi-cas', varargs: true,
    impl: (...a) => { const e = a[0]; for (let i = 1; i + 1 < a.length; i += 2) { if (a[i] === e) return a[i + 1] } return (a.length % 2 === 0) ? a[a.length - 1] : null } },
  { name: 'AND', category: 'Logique', sig: 'AND(a, b, …)', hint: 'ET logique (opérateur SQL : a AND b)', sqlite: false, varargs: true,
    impl: (...args) => args.every(Boolean) ? 1 : 0 },
  { name: 'OR', category: 'Logique', sig: 'OR(a, b, …)', hint: 'OU logique (opérateur SQL : a OR b)', sqlite: false, varargs: true,
    impl: (...args) => args.some(Boolean) ? 1 : 0 },
  { name: 'NOT', category: 'Logique', sig: 'NOT(a)', hint: 'Négation', sqlite: false,
    impl: (a) => a ? 0 : 1 },
  { name: 'BLANK', category: 'Logique', sig: 'BLANK()', hint: 'Valeur vide', impl: () => null },
  { name: 'TRUE', category: 'Logique', sig: 'TRUE()', hint: 'Vrai (1)', impl: () => 1 },
  { name: 'FALSE', category: 'Logique', sig: 'FALSE()', hint: 'Faux (0)', impl: () => 0 },

  // — Dates —
  { name: 'YEAR', category: 'Date', sig: 'YEAR(date)', hint: 'Année', impl: (d) => { const x = toDate(d); return x && x.getUTCFullYear() } },
  { name: 'MONTH', category: 'Date', sig: 'MONTH(date)', hint: 'Mois (1-12)', impl: (d) => { const x = toDate(d); return x && x.getUTCMonth() + 1 } },
  { name: 'DAY', category: 'Date', sig: 'DAY(date)', hint: 'Jour du mois', impl: (d) => { const x = toDate(d); return x && x.getUTCDate() } },
  { name: 'HOUR', category: 'Date', sig: 'HOUR(date)', hint: 'Heure', impl: (d) => { const x = toDate(d); return x ? x.getUTCHours() : null } },
  { name: 'MINUTE', category: 'Date', sig: 'MINUTE(date)', hint: 'Minute', impl: (d) => { const x = toDate(d); return x ? x.getUTCMinutes() : null } },
  { name: 'SECOND', category: 'Date', sig: 'SECOND(date)', hint: 'Seconde', impl: (d) => { const x = toDate(d); return x ? x.getUTCSeconds() : null } },
  { name: 'WEEKDAY', category: 'Date', sig: 'WEEKDAY(date, [débutSemaine])', hint: 'Jour de la semaine (0-6)',
    impl: (d, start) => { const x = toDate(d); if (!x) return null; const w = x.getUTCDay(); return String(start || '').toLowerCase().startsWith('mon') ? (w + 6) % 7 : w } },
  { name: 'WEEKNUM', category: 'Date', sig: 'WEEKNUM(date)', hint: 'Numéro de semaine ISO', impl: (d) => { const x = toDate(d); return x ? isoWeek(x) : null } },
  { name: 'DATEADD', category: 'Date', sig: "DATEADD(date, n, 'days'|'months'|'years'…)", hint: 'Décale une date',
    impl: (d, n, u) => { const x = toDate(d); if (!x) return null; const r = addToDate(x, toNum(n) ?? 0, u); return r ? r.toISOString() : null } },
  { name: 'DATEDIFF', category: 'Date', sig: "DATEDIFF(a, b, 'days')", hint: 'Différence a − b',
    impl: (a, b, u) => { const x = toDate(a), y = toDate(b); return (x && y) ? dateDiff(x, y, u) : null } },
  { name: 'DATETIME_DIFF', category: 'Date', sig: "DATETIME_DIFF(a, b, 'days')", hint: 'Différence a − b',
    impl: (a, b, u) => { const x = toDate(a), y = toDate(b); return (x && y) ? dateDiff(x, y, u) : null } },
  { name: 'DATETIME_FORMAT', category: 'Date', sig: "DATETIME_FORMAT(date, 'YYYY-MM-DD')", hint: 'Formate une date',
    impl: (d, fmt) => { const x = toDate(d); return x ? datetimeFormat(x, fmt) : null } },
  { name: 'DATETIME_PARSE', category: 'Date', sig: 'DATETIME_PARSE(texte)', hint: 'Parse une date → ISO',
    impl: (s) => { const x = toDate(s); return x ? x.toISOString() : null } },
  { name: 'IS_BEFORE', category: 'Date', sig: 'IS_BEFORE(a, b)', hint: 'a < b → 1/0',
    impl: (a, b) => { const x = toDate(a), y = toDate(b); return (x && y) ? (x < y ? 1 : 0) : null } },
  { name: 'IS_AFTER', category: 'Date', sig: 'IS_AFTER(a, b)', hint: 'a > b → 1/0',
    impl: (a, b) => { const x = toDate(a), y = toDate(b); return (x && y) ? (x > y ? 1 : 0) : null } },
  { name: 'ISAFTER', category: 'Date', sig: 'ISAFTER(a, b)', hint: 'a > b → 1/0 (alias)',
    impl: (a, b) => { const x = toDate(a), y = toDate(b); return (x && y) ? (x > y ? 1 : 0) : null } },
  { name: 'IS_SAME', category: 'Date', sig: 'IS_SAME(a, b)', hint: 'a == b → 1/0',
    impl: (a, b) => { const x = toDate(a), y = toDate(b); return (x && y) ? (x.getTime() === y.getTime() ? 1 : 0) : null } },
  { name: 'NOW', category: 'Date', sig: 'NOW()', hint: 'Date+heure courante', deterministic: false, impl: () => new Date().toISOString() },
  { name: 'TODAY', category: 'Date', sig: 'TODAY()', hint: 'Date du jour', deterministic: false, impl: () => new Date().toISOString().split('T')[0] },
  { name: 'FROMUNIXTIMESTAMP', category: 'Date', sig: 'FROMUNIXTIMESTAMP(secondes)', hint: 'Timestamp Unix → ISO',
    impl: (n) => { const x = toNum(n); return x == null ? null : new Date(x * 1000).toISOString() } },
  { name: 'TIMESTAMPTOTEXT', category: 'Date', sig: 'TIMESTAMPTOTEXT(date)', hint: 'Date → texte ISO',
    impl: (d) => { const x = toDate(d); return x ? x.toISOString() : null } },

  // — Durées — (les champs de type 'duration' stockent des secondes)
  { name: 'DURATION_FORMAT', category: 'Durée', sig: "DURATION_FORMAT(secondes, ['h:mm:ss'])", hint: 'Formate des secondes en durée',
    impl: (sec, fmt) => { const x = toNum(sec); return x == null ? null : formatDurationSeconds(x, fmt === 'h:mm:ss' ? 'h:mm:ss' : 'h:mm') } },
  { name: 'DURATION_PARSE', category: 'Durée', sig: "DURATION_PARSE('1:30')", hint: 'Parse une durée en secondes',
    impl: (s) => parseDurationToSeconds(s) },
]

// Catalogue exposé (métadonnées sans les impls) — utile pour générer une doc ou
// une UI côté serveur si besoin. La liste du client est maintenue en parallèle
// dans CustomFieldModal.jsx (le client ne peut pas importer ce module serveur).
export const FORMULA_FUNCTIONS = F.map(({ name, category, sig, hint }) => ({ name, category, sig, hint }))

// Coerce une valeur de retour vers un type accepté par SQLite/JS :
// booléen → 1/0, undefined/NaN → null. (better-sqlite3 rejette les booléens.)
function coerceReturn(v) {
  if (v === undefined || v === null) return null
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'number' && !Number.isFinite(v)) return null
  return v
}

// Enregistre toutes les fonctions `sqlite !== false` comme UDF sur la connexion
// better-sqlite3 passée. Idempotent à l'échelle d'un process (à appeler une fois
// au démarrage). Les exceptions d'une impl sont neutralisées en null pour ne
// jamais casser la lecture d'une VUE entière à cause d'une cellule mal formée.
export function registerFormulaFunctions(db) {
  for (const f of F) {
    if (f.sqlite === false) continue
    const safe = (...args) => {
      try { return coerceReturn(f.impl(...args)) } catch { return null }
    }
    db.function(f.name, { deterministic: f.deterministic !== false, varargs: true }, safe)
  }
}

// SANDBOX_BASE : table de fonctions pour l'évaluateur JS sandboxé (dialecte
// {champ}). Inclut TOUTES les fonctions (y compris les opérateurs/agrégats non
// exposés en SQLite), plus quelques alias usuels.
export const SANDBOX_BASE = Object.fromEntries(F.map(f => [f.name, f.impl]))
SANDBOX_BASE.CONCAT = SANDBOX_BASE.CONCATENATE

/**
 * Évalue une expression formule (dialecte {champ}) pour un enregistrement.
 * Moteur de référence JS sandboxé — NE PAS confondre avec le moteur SQLite des
 * champs calculés (qui passe par les UDF + la VUE <table>_v).
 *
 * @param {string} formula - ex: "{prix} * {qty}" ou "IF({status} == 'Envoyé', {total}, 0)"
 * @param {object} recordData - données de l'enregistrement
 * @param {object[]} _fields - définitions de champs (réservé)
 * @param {object} [opts] - { onError: (err) => void } pour observer les erreurs
 * @returns {any} valeur calculée, ou null en cas d'erreur
 */
export function evaluateFormula(formula, recordData, _fields, opts = {}) {
  if (!formula) return null

  let expr
  try {
    expr = formula.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
      const val = recordData[key]
      if (val === null || val === undefined) return 'null'
      if (typeof val === 'boolean') return String(val)
      if (typeof val === 'number') return String(val)
      const escaped = String(val).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      return `"${escaped}"`
    })
    const sandbox = { ...SANDBOX_BASE }
    const result = runInNewContext(expr, sandbox, { timeout: 500 })
    return result ?? null
  } catch (err) {
    // On NE doit pas avaler l'erreur en silence : on la remonte à l'appelant
    // (callback) et on la loggue, tout en dégradant la cellule en null.
    if (typeof opts.onError === 'function') opts.onError(err)
    else console.warn(`[formulaEngine] échec d'évaluation: ${err.message} — expr: ${expr ?? formula}`)
    return null
  }
}
