// Canonical datetime storage convention : ISO UTC with Z suffix
// (e.g. "2026-04-23T18:47:10.533Z"). All timestamps in DB should match this.
// Use Node's Date#toISOString() directly, or strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
// in SQL. This module handles the edge case of naive local-time strings
// (e.g. from devices or legacy imports) that need conversion to UTC.

const DEFAULT_ZONE = 'America/Toronto'

// Parse a naive datetime string (no timezone suffix) as wall-clock time in the
// given zone, and return the equivalent ISO UTC string. Returns the input
// unchanged if it already ends with Z. Returns null if unparseable.
// Assumption for DST boundaries : spring-forward gaps are resolved to the "as if
// UTC" instant (off by at most 1 hour), fall-back duplicates are resolved to
// the first occurrence.
export function naiveLocalToUtcIso(value, zone = DEFAULT_ZONE) {
  if (!value) return value
  const s = String(value)
  if (s.endsWith('Z')) return s
  // Match both "YYYY-MM-DD HH:MM:SS" and "YYYY-MM-DDTHH:MM:SS[.fff]" forms
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/)
  if (!m) return null
  const [, y, mo, d, h, mi, se, ms] = m
  // Compute the instant "as if naive were UTC"
  const asIfUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se, ms ? +ms.slice(0, 3).padEnd(3, '0') : 0)
  // Find the UTC offset of the given zone at that instant (minutes to add to
  // naive to get real UTC — positive when zone is behind UTC, e.g. 240 for EDT).
  const offsetMin = zoneOffsetMinutes(new Date(asIfUtc), zone)
  return new Date(asIfUtc + offsetMin * 60000).toISOString()
}

// Normalize any datetime value to ISO UTC. Space-separated SQLite output is
// already UTC (just a format difference) — no conversion, only reformat.
// Naive ISO-T values are assumed to be local in the given zone and converted.
export function normalizeToUtcIso(value, zone = DEFAULT_ZONE) {
  if (!value) return value
  const s = String(value)
  if (s.endsWith('Z')) return s
  // Date-only "YYYY-MM-DD" → leave as-is (business date, no time component)
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s
  // Space-separated "YYYY-MM-DD HH:MM:SS" is SQLite's datetime('now') output,
  // which is already UTC. Just reformat to ISO Z.
  const spaceMatch = s.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.(\d+))?$/)
  if (spaceMatch) {
    const [, date, time, ms] = spaceMatch
    return `${date}T${time}.${(ms || '000').slice(0, 3).padEnd(3, '0')}Z`
  }
  // Naive ISO-T form → assume local in given zone
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(s)) {
    return naiveLocalToUtcIso(s, zone)
  }
  return s
}

function zoneOffsetMinutes(date, zone) {
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'shortOffset' })
  const parts = dtf.formatToParts(date)
  const tzName = parts.find(p => p.type === 'timeZoneName')?.value || 'GMT-05:00'
  const m = tzName.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/)
  if (!m) return 300
  const sign = m[1] === '+' ? 1 : -1
  const h = parseInt(m[2], 10)
  const mm = m[3] ? parseInt(m[3], 10) : 0
  return -sign * (h * 60 + mm)
}
