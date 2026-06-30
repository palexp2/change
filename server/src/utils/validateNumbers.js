// Parsers/validateurs numériques partagés pour rendre impossibles, côté serveur,
// les états corrompus : quantités NaN, décimales sournoises, négatifs, etc.
//
// Tous renvoient `null` quand l'entrée est invalide — l'appelant transforme ce
// `null` en réponse 400 avec un message explicite. On ne fait JAMAIS de
// `parseInt` permissif (qui avale "5x" → 5, "  " → NaN silencieux, etc.).

// Entier fini (positif, négatif ou zéro). Accepte un nombre entier ou une chaîne
// strictement entière ("-3", "42"). Refuse les décimales, NaN, Infinity, '',
// null, undefined, "5x", "1e3", etc.
export function parseFiniteInt(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) ? value : null
  }
  if (typeof value === 'string') {
    const t = value.trim()
    if (!/^-?\d+$/.test(t)) return null
    const n = Number(t)
    return Number.isSafeInteger(n) ? n : null
  }
  return null
}

// Entier strictement positif (>= 1). Pour les quantités de mouvement / de ligne.
export function parsePositiveInt(value) {
  const n = parseFiniteInt(value)
  return n !== null && n > 0 ? n : null
}

// Entier >= 0. Pour les valeurs absolues de stock / quantités prélevées.
export function parseNonNegativeInt(value) {
  const n = parseFiniteInt(value)
  return n !== null && n >= 0 ? n : null
}

// Nombre fini >= 0, décimales autorisées (coûts, prix). Refuse NaN, Infinity,
// négatifs, '', "abc".
export function parseNonNegativeNumber(value) {
  let n
  if (typeof value === 'number') n = value
  else if (typeof value === 'string') {
    const t = value.trim()
    if (t === '') return null
    n = Number(t)
  } else return null
  return Number.isFinite(n) && n >= 0 ? n : null
}

// Nombre fini quelconque (positif, négatif ou zéro), décimales autorisées.
// Refuse NaN, Infinity, '', null, undefined, "abc". Sert de base aux validations
// bornées (probabilité 0-100, montants >= 0, etc.).
export function parseFiniteNumber(value) {
  let n
  if (typeof value === 'number') n = value
  else if (typeof value === 'string') {
    const t = value.trim()
    if (t === '') return null
    n = Number(t)
  } else return null
  return Number.isFinite(n) ? n : null
}

// Valide un sous-ensemble de champs numériques d'un body HTTP, pour rejeter
// explicitement (400) les NaN, Infinity, négatifs et hors-bornes plutôt que de
// les coercer silencieusement en 0 (ce qui corromprait P&L / forecast).
//
//   const { error, values } = validateNumericFields(req.body, [
//     { key: 'probability', min: 0, max: 100 },
//     { key: 'value_cad' },                 // min défaut 0
//     { key: 'nb_greenhouses', int: true },
//   ])
//   if (error) return res.status(400).json({ error })
//
// Sémantique :
// - Champ absent du body (clé non présente) → ignoré, pas dans `values`.
// - Champ présent mais vide ('' / null / undefined) → `values[key] = null`
//   (l'appelant décide du défaut ou laisse la colonne intacte).
// - Champ présent et non vide → parsé/borné ; invalide ⇒ `{ error }`.
export function validateNumericFields(body, specs) {
  const values = {}
  for (const spec of specs) {
    const { key, int = false, min = 0, max = Infinity } = spec
    if (!Object.prototype.hasOwnProperty.call(body, key)) continue
    const raw = body[key]
    if (raw === '' || raw === null || raw === undefined) {
      values[key] = null
      continue
    }
    const n = int ? parseFiniteInt(raw) : parseFiniteNumber(raw)
    if (n === null) {
      return { error: `${key} doit être un nombre${int ? ' entier' : ''} valide` }
    }
    if (n < min) return { error: `${key} ne peut pas être inférieur à ${min}` }
    if (n > max) return { error: `${key} ne peut pas être supérieur à ${max}` }
    values[key] = n
  }
  return { values }
}
