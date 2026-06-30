import db from '../db/database.js'

const BOC_SERIES = { USDCAD: 'FXUSDCAD' }

// Au-delà de cet âge (en jours), un taux en cache n'est plus assez frais pour
// servir de fallback fiable quand la Banque du Canada est indisponible : le
// USD↔CAD bouge assez pour fausser silencieusement les montants d'un Deposit
// QuickBooks. On préfère alors renvoyer null (→ erreur visible côté appelant)
// plutôt que propager un taux périmé dans la compta. Override : FX_MAX_FALLBACK_AGE_DAYS.
const MAX_FALLBACK_AGE_DAYS = Number(process.env.FX_MAX_FALLBACK_AGE_DAYS) || 7

// Âge (en jours, absolu) d'une observation de taux par rapport à la date cible.
export function fxRateAgeDays(rateDate, targetDate) {
  return Math.abs(new Date(rateDate) - new Date(targetDate)) / 86400000
}

// Un taux en cache est-il assez frais pour servir de fallback à `targetDate` ?
export function isFreshFallbackRate(rateDate, targetDate, maxAgeDays = MAX_FALLBACK_AGE_DAYS) {
  if (!rateDate) return false
  return fxRateAgeDays(rateDate, targetDate) <= maxAgeDays
}

function isoDate(d) {
  return (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10)
}

function shiftDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return isoDate(d)
}

// Bank of Canada Valet API — fetch a small window around `date` and cache every
// observation returned. Returns the full list of {d, v} observations in the window.
async function fetchBocWindow(pair, dateStr) {
  const series = BOC_SERIES[pair]
  if (!series) throw new Error(`Unsupported pair: ${pair}`)
  const start = shiftDays(dateStr, -7)
  const end   = shiftDays(dateStr, 1)
  const url = `https://www.bankofcanada.ca/valet/observations/${series}/json?start_date=${start}&end_date=${end}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`BoC HTTP ${res.status}`)
  const data = await res.json()
  const obs = (data.observations || [])
    .map(o => ({ d: o.d, v: parseFloat(o[series]?.v) }))
    .filter(o => o.d && !Number.isNaN(o.v))
    .sort((a, b) => a.d.localeCompare(b.d))
  const insert = db.prepare('INSERT OR IGNORE INTO fx_rates (pair, date, rate) VALUES (?, ?, ?)')
  const tx = db.transaction((list) => { for (const o of list) insert.run(pair, o.d, o.v) })
  tx(obs)
  return obs
}

// Pick the cached rate on or before a given date (nearest business day going
// backwards, fallback to the nearest after if none earlier is cached).
function pickCachedRate(pair, dateStr) {
  const before = db.prepare(`
    SELECT date, rate FROM fx_rates
    WHERE pair = ? AND date <= ?
    ORDER BY date DESC LIMIT 1
  `).get(pair, dateStr)
  if (before) return before
  return db.prepare(`
    SELECT date, rate FROM fx_rates
    WHERE pair = ? AND date > ?
    ORDER BY date ASC LIMIT 1
  `).get(pair, dateStr) || null
}

// Return the USD→CAD rate for `dateStr` (YYYY-MM-DD). Handles weekends/holidays
// by walking back to the nearest available business day. Results are cached in
// the `fx_rates` table so the BoC API is only hit once per window.
export async function getUsdCadRate(dateStr) {
  if (!dateStr) return null
  const date = dateStr.slice(0, 10)

  // Cache hit (exact)
  const exact = db.prepare("SELECT rate FROM fx_rates WHERE pair='USDCAD' AND date=?").get(date)
  if (exact) return exact.rate

  // Cache hit (nearest business day on or before — only if cache already has
  // an observation within a few days of the target)
  const near = pickCachedRate('USDCAD', date)
  if (near) {
    const diff = Math.abs(new Date(near.date) - new Date(date)) / 86400000
    if (diff <= 5) return near.rate
  }

  // Fetch from BoC and re-check
  try {
    await fetchBocWindow('USDCAD', date)
  } catch (e) {
    console.error('[fx] BoC fetch failed for', date, '-', e.message)
    // Fallback borné : ne retombe sur le cache que si l'observation la plus
    // proche est encore fraîche. Un taux trop vieux fausserait silencieusement
    // les conversions CAD/USD (Deposits QB) — on renvoie plutôt null pour rendre
    // l'erreur visible côté appelant.
    if (near && isFreshFallbackRate(near.date, date)) return near.rate
    if (near) {
      console.error(
        `[fx] cache USD→CAD trop vieux pour ${date} (obs ${near.date}, ` +
        `${Math.round(fxRateAgeDays(near.date, date))} j > ${MAX_FALLBACK_AGE_DAYS} j max) — rejeté`
      )
    }
    return null
  }
  // BoC a répondu — mais si la fenêtre ne contenait aucune observation (gap,
  // date trop ancienne/future), pickCachedRate peut encore renvoyer un taux
  // périmé : on applique la même borne de fraîcheur.
  const after = pickCachedRate('USDCAD', date)
  if (after && isFreshFallbackRate(after.date, date)) return after.rate
  if (after) {
    console.error(
      `[fx] aucun taux USD→CAD frais pour ${date} après fetch BoC (obs la plus proche ` +
      `${after.date}, ${Math.round(fxRateAgeDays(after.date, date))} j > ${MAX_FALLBACK_AGE_DAYS} j max) — rejeté`
    )
  }
  return null
}
