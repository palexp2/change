// Import d'une session ouverte à la main.
//
// Certains portails protègent leur formulaire de connexion par un captcha
// (Wix) ou refusent tout navigateur automatisé (connexion via Google). Le
// collecteur ne peut alors pas se connecter lui-même — mais il n'en a pas
// besoin : une session ouverte dans un vrai navigateur, importée ici, lui
// suffit pour toutes ses tournées suivantes.
//
// Trois formats acceptés, parce que l'utilisateur colle ce que son outil
// exporte, pas ce qui nous arrangerait :
//   1. storageState Playwright  { cookies: [...], origins: [...] }
//   2. export d'extension type Cookie-Editor  [ { name, value, ... }, ... ]
//   3. en-tête brut  « a=b; c=d » (sans les cookies httpOnly — souvent insuffisant)

const SAME_SITE = { lax: 'Lax', strict: 'Strict', none: 'None', no_restriction: 'None', unspecified: 'Lax' }

function normalizeCookie(raw, defaultDomain) {
  const name = raw.name ?? raw.key
  if (!name || raw.value == null) return null
  const domain = raw.domain || defaultDomain
  if (!domain) return null

  // Playwright veut un `expires` en secondes epoch ; -1 = cookie de session.
  let expires = -1
  const rawExp = raw.expires ?? raw.expirationDate ?? raw.expiry
  if (typeof rawExp === 'number' && rawExp > 0) expires = Math.floor(rawExp)
  else if (typeof rawExp === 'string' && !Number.isNaN(Date.parse(rawExp))) expires = Math.floor(Date.parse(rawExp) / 1000)

  return {
    name: String(name),
    value: String(raw.value),
    domain: String(domain),
    path: raw.path || '/',
    expires,
    httpOnly: !!raw.httpOnly,
    secure: raw.secure !== false,
    sameSite: SAME_SITE[String(raw.sameSite || '').toLowerCase()] || 'Lax',
  }
}

/**
 * @param {string} payload ce que l'utilisateur a collé
 * @param {string} defaultDomain domaine appliqué aux cookies qui n'en portent pas
 * @returns {{cookies: Array, origins: Array}} storageState prêt pour Playwright
 */
export function parseSessionPayload(payload, defaultDomain = '') {
  const text = String(payload || '').trim()
  if (!text) throw new Error('Rien à importer')

  let parsed = null
  if (text.startsWith('{') || text.startsWith('[')) {
    try { parsed = JSON.parse(text) } catch { throw new Error('JSON invalide — recopier tout l\'export, accolades comprises') }
  }

  let rawCookies
  let origins = []
  if (Array.isArray(parsed)) {
    rawCookies = parsed
  } else if (parsed && Array.isArray(parsed.cookies)) {
    rawCookies = parsed.cookies
    if (Array.isArray(parsed.origins)) origins = parsed.origins
  } else if (parsed) {
    throw new Error('Format non reconnu — attendu un storageState Playwright ou un export de cookies')
  } else {
    // En-tête brut « a=b; c=d ».
    rawCookies = text.split(';').map(part => {
      const i = part.indexOf('=')
      if (i < 1) return null
      return { name: part.slice(0, i).trim(), value: part.slice(i + 1).trim() }
    }).filter(Boolean)
  }

  const cookies = rawCookies.map(c => normalizeCookie(c, defaultDomain)).filter(Boolean)
  if (!cookies.length) throw new Error('Aucun cookie exploitable dans ce qui a été collé')
  return { cookies, origins }
}

// Une session sans cookie du domaine attendu ne servira à rien : autant le dire
// à l'import plutôt qu'à la première tournée.
export function sessionCoversDomain(state, domainFragment) {
  return state.cookies.some(c => c.domain.includes(domainFragment))
}
