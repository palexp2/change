import db from '../db/database.js'
import { getUsdCadRate } from './fx.js'
import { currencyFromCountry } from './airtable.js'

const USD_FALLBACK_RATE = 1.4

// Pick the "date" of a soumission for FX lookup: prefer expiration_date when
// set (real Airtable soumissions), fall back to the project's creation date
// (legacy soumissions imported from PDF attachments share the same import
// created_at and can't be dated otherwise), then finally the sync created_at.
function soumissionDate(s, projectCreation) {
  if (s.expiration_date) return s.expiration_date.slice(0, 10)
  if (projectCreation) return String(projectCreation).slice(0, 10)
  if (s.created_at) return s.created_at.slice(0, 10)
  return null
}

// Recompute `projects.valeur_cad_calc` for a single project from its latest
// soumission with a non-zero purchase_price. Returns the new value (or null).
export async function recomputeProjectValeurCad(projectId) {
  if (!projectId) return null
  const p = db.prepare('SELECT creation, value_cad, company_id FROM projects WHERE id = ?').get(projectId)
  if (!p) return null

  // Fallback: if no soumission has a non-zero purchase_price but the project
  // has a manual value_cad and at least one linked soumission sitting at 0,
  // populate the most recent soumission's purchase_price from project.value_cad.
  // For US clients the stored price is in USD, so divide the CAD value by 1.4.
  const hasNonZero = db.prepare(
    'SELECT 1 FROM soumissions WHERE project_id = ? AND purchase_price > 0 LIMIT 1'
  ).get(projectId)

  if (!hasNonZero && p.value_cad && p.value_cad > 0) {
    const target = db.prepare(`
      SELECT id FROM soumissions
      WHERE project_id = ? AND (purchase_price IS NULL OR purchase_price = 0)
      ORDER BY
        COALESCE(expiration_date, substr(created_at, 1, 10)) DESC,
        created_at DESC
      LIMIT 1
    `).get(projectId)

    if (target) {
      const country = p.company_id
        ? db.prepare('SELECT country FROM companies WHERE id = ?').get(p.company_id)?.country
        : null
      const cur = currencyFromCountry(country)
      const price = cur === 'USD'
        ? Math.round((Number(p.value_cad) / USD_FALLBACK_RATE) * 100) / 100
        : Number(p.value_cad)
      db.prepare(
        "UPDATE soumissions SET purchase_price = ?, currency = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?"
      ).run(price, cur, target.id)
    }
  }

  const latest = db.prepare(`
    SELECT purchase_price, currency, expiration_date, created_at
    FROM soumissions
    WHERE project_id = ? AND purchase_price IS NOT NULL AND purchase_price > 0
    ORDER BY
      COALESCE(expiration_date, substr(created_at, 1, 10)) DESC,
      created_at DESC
    LIMIT 1
  `).get(projectId)

  if (!latest) {
    db.prepare('UPDATE projects SET valeur_cad_calc = NULL WHERE id = ?').run(projectId)
    return null
  }

  const currency = (latest.currency || 'CAD').toUpperCase()
  let valeurCad = null

  if (currency === 'CAD') {
    valeurCad = Number(latest.purchase_price)
  } else if (currency === 'USD') {
    const date = soumissionDate(latest, p.creation)
    const rate = await getUsdCadRate(date)
    if (rate) valeurCad = Math.round(Number(latest.purchase_price) * rate * 100) / 100
  }
  // Other currencies (EUR, GBP, …) left null until explicitly supported.

  db.prepare('UPDATE projects SET valeur_cad_calc = ? WHERE id = ?').run(valeurCad, projectId)
  return valeurCad
}

// Recompute for every project that has at least one non-zero soumission.
export async function recomputeAllProjectsValeurCad({ onProgress } = {}) {
  const ids = db.prepare(`
    SELECT DISTINCT project_id AS id FROM soumissions
    WHERE project_id IS NOT NULL AND purchase_price > 0
    UNION
    SELECT DISTINCT s.project_id AS id
    FROM soumissions s
    JOIN projects p ON p.id = s.project_id
    WHERE s.project_id IS NOT NULL
      AND (s.purchase_price IS NULL OR s.purchase_price = 0)
      AND p.value_cad > 0
  `).all().map(r => r.id)

  let done = 0, failed = 0
  for (const id of ids) {
    try { await recomputeProjectValeurCad(id); done++ }
    catch (e) { failed++; console.error('[valeur_cad_calc]', id, e.message) }
    if (onProgress && done % 50 === 0) onProgress(done, ids.length)
  }
  return { total: ids.length, done, failed }
}
