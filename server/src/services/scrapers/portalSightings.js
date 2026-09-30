// « Voici les portails que tu utilises » — l'inverse de la saisie à la main.
//
// Le module de navigateur voit les sites ouverts et connectés dans le
// navigateur de l'utilisateur. Quand l'un d'eux correspond à un collecteur,
// sa session part vers l'ERP toute seule. Quand il ne correspond à rien,
// SEUL SON NOM DE DOMAINE remonte ici : jamais les témoins d'un site que
// l'ERP ne sait pas collecter. Cette liste sert à proposer le prochain
// portail à brancher, sans que personne ait à y penser.

import db from '../../db/database.js'
import { newRecordId } from '../../utils/recordId.js'
import { nowIso } from '../../utils/datetime.js'
import { SCRAPERS, BRIDGE_DOMAINS, VENDOR_DOMAINS } from './index.js'
import { SESSION_ONLY_TARGETS } from './bridgeSessions.js'

// Sites du quotidien qui ne facturent rien : les faire remonter noierait la
// liste sous du bruit. Tout le reste est montré — l'utilisateur écarte ce qui
// ne l'intéresse pas, une fois.
const IGNORED = [
  'google.com', 'google.ca', 'gstatic.com', 'youtube.com', 'bing.com', 'live.com',
  'microsoft.com', 'microsoftonline.com', 'office.com', 'sharepoint.com',
  'facebook.com', 'instagram.com', 'linkedin.com', 'x.com', 'twitter.com',
  'claude.ai', 'anthropic.com', 'openai.com', 'chatgpt.com', 'github.com',
  'orisha.io', 'airtable.com', 'slack.com', 'zoom.us', 'wikipedia.org',
  'duckduckgo.com', 'apple.com', 'icloud.com', 'reddit.com', 'stackoverflow.com',
]

export function normalizeDomain(raw) {
  let d = String(raw || '').trim().toLowerCase()
  if (!d) return null
  try { if (d.includes('://')) d = new URL(d).hostname } catch { /* déjà un domaine */ }
  d = d.replace(/^\.+/, '').replace(/:\d+$/, '')
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return null
  return d
}

const covers = (domain, list) =>
  (list || []).some(x => domain === x || domain.endsWith(`.${x}`))

export function isIgnored(domain) {
  return covers(domain, IGNORED)
}

// Le domaine le plus précis gagne : « business.bell.ca » appartient au
// Libre-service Affaires, pas à MyBell, même si les deux vivent sous bell.ca.
function bestMatch(domain, list) {
  let best = 0
  for (const x of list || []) {
    if (domain === x || domain.endsWith(`.${x}`)) best = Math.max(best, x.length)
  }
  return best
}

/** Ce domaine est-il celui d'un collecteur, ou d'un service déjà suivi ? */
export function collectorForDomain(domain) {
  let hit = null
  for (const vendor of Object.keys(SCRAPERS)) {
    const fragment = (VENDOR_DOMAINS[vendor] || '').replace(/^\./, '')
    const score = Math.max(
      bestMatch(domain, BRIDGE_DOMAINS[vendor]),
      fragment && domain.includes(fragment) ? fragment.length : 0,
    )
    if (score && (!hit || score > hit.score)) hit = { kind: 'collector', vendor, score }
  }
  for (const [key, target] of Object.entries(SESSION_ONLY_TARGETS)) {
    const score = bestMatch(domain, target.domains)
    if (score && (!hit || score > hit.score)) hit = { kind: 'session', vendor: key, score }
  }
  return hit ? { kind: hit.kind, vendor: hit.vendor } : null
}

/** Enregistre un domaine vu ouvert. Idempotent : un compteur, pas un journal. */
export function recordSighting(domain, { title = null, vendor = null } = {}) {
  const d = normalizeDomain(domain)
  if (!d || isIgnored(d)) return false
  db.prepare(`
    INSERT INTO portal_sightings (id, domain, title, vendor, times, last_seen_at)
    VALUES (?, ?, ?, ?, 1, ?)
    ON CONFLICT(domain) DO UPDATE SET
      times = portal_sightings.times + 1,
      title = COALESCE(excluded.title, portal_sightings.title),
      vendor = COALESCE(excluded.vendor, portal_sightings.vendor),
      last_seen_at = excluded.last_seen_at
  `).run(newRecordId(), d, title, vendor, nowIso())
  return true
}

/** Portails vus, pas encore branchés ni écartés. */
export function listSightings({ limit = 40 } = {}) {
  return db.prepare(`
    SELECT domain, title, vendor, times, first_seen_at, last_seen_at
    FROM portal_sightings
    WHERE dismissed_at IS NULL
    ORDER BY times DESC, last_seen_at DESC
    LIMIT ?
  `).all(limit).filter(r => !collectorForDomain(r.domain))
}

export function dismissSighting(domain) {
  const d = normalizeDomain(domain)
  if (!d) return false
  return db.prepare('UPDATE portal_sightings SET dismissed_at=? WHERE domain=?').run(nowIso(), d).changes > 0
}
