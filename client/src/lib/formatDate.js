export function fmtDate(d, opts = {}) {
  if (!d) return '—'
  const safe = typeof d === 'string' && d.length === 10 ? d + 'T12:00:00' : d
  return new Date(safe).toLocaleDateString('fr-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    ...opts,
  })
}

export function fmtDateTime(d) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('fr-CA', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
