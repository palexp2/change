// Les jetons ERP sont des JWT : trois segments ASCII base64url.
// Ne jamais encoder ou tronquer un jeton invalide pour le faire passer dans fetch.
export function normalizeToken(value) {
  const token = typeof value === 'string' ? value.trim().replace(/^Bearer\s+/i, '') : ''
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error('Jeton invalide — dans l’ERP, onglet Collecte, cliquez sur « Jeton », puis collez-le dans les Réglages du module et enregistrez. Ne collez pas votre mot de passe FedEx.')
  }
  return token
}
