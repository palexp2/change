export function fmtDate(d, opts = {}) {
  if (!d) return '—'
  const s = typeof d === 'string' ? d : ''
  // 10-char "YYYY-MM-DD" — date métier sans composante horaire : rendu à midi
  // pour éviter tout glissement de fuseau.
  if (s.length === 10) {
    return new Date(s + 'T12:00:00').toLocaleDateString('fr-CA', {
      year: 'numeric', month: 'short', day: 'numeric', ...opts,
    })
  }
  // Pattern "YYYY-MM-DDT00:00:00[.000]Z" — encodage Airtable d'un champ date-only :
  // l'utilisateur a choisi un jour calendaire qu'Airtable stocke comme minuit UTC.
  // Le rendre dans le fuseau du navigateur le décale d'un jour (ex. minuit UTC du
  // 1er avril → 31 mars 20h à Montréal). On force le rendu en UTC pour préserver
  // la date du sélecteur. Les vrais timestamps `new Date().toISOString()` ont des
  // millisecondes non nulles donc ne matchent pas.
  if (/^\d{4}-\d{2}-\d{2}T00:00:00(\.0+)?Z$/.test(s)) {
    return new Date(s).toLocaleDateString('fr-CA', {
      year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC', ...opts,
    })
  }
  return new Date(d).toLocaleDateString('fr-CA', {
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
