import { createContext, runInNewContext } from 'node:vm'

const SANDBOX_BASE = {
  UPPER:  (s) => s != null ? String(s).toUpperCase() : null,
  LOWER:  (s) => s != null ? String(s).toLowerCase() : null,
  ROUND:  (n, d = 0) => n != null ? Number(Number(n).toFixed(d)) : null,
  IF:     (cond, t, f) => cond ? t : f,
  CONCAT: (...args) => args.filter(a => a != null).join(''),
  TODAY:  () => new Date().toISOString().split('T')[0],
  NOW:    () => new Date().toISOString(),
  ABS:    (n) => n != null ? Math.abs(n) : null,
  MIN:    (...args) => { const v = args.filter(a => a != null); return v.length ? Math.min(...v) : null },
  MAX:    (...args) => { const v = args.filter(a => a != null); return v.length ? Math.max(...v) : null },
  SUM:    (...args) => args.filter(a => a != null).reduce((s, v) => s + Number(v), 0),
  LEN:    (s) => s != null ? String(s).length : null,
  TRIM:   (s) => s != null ? String(s).trim() : null,
  LEFT:   (s, n) => s != null ? String(s).substring(0, n) : null,
  RIGHT:  (s, n) => s != null ? String(s).slice(-n) : null,
  YEAR:   (d) => d ? new Date(d).getFullYear() : null,
  MONTH:  (d) => d ? new Date(d).getMonth() + 1 : null,
  DAY:    (d) => d ? new Date(d).getDate() : null,
}

/**
 * Evaluates a formula expression for a given record.
 * @param {string} formula - e.g. "{prix} * {qty}" or "IF({status} = 'Envoyé', {total}, 0)"
 * @param {object} recordData - Parsed data object of the record
 * @param {object[]} fields - Field definitions array
 * @returns {any} Computed value, or null on error
 */
export function evaluateFormula(formula, recordData, _fields) {
  if (!formula) return null

  try {
    // Substitute {key} references
    let expr = formula.replace(/\{([a-zA-Z0-9_]+)\}/g, (_, key) => {
      const val = recordData[key]
      if (val === null || val === undefined) return 'null'
      if (typeof val === 'boolean') return String(val)
      if (typeof val === 'number') return String(val)
      // Escape string: replace backslash and double-quote
      const escaped = String(val).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
      return `"${escaped}"`
    })

    const sandbox = createContext({ ...SANDBOX_BASE })
    const result = runInNewContext(expr, sandbox, { timeout: 500 })
    return result ?? null
  } catch {
    return null
  }
}
