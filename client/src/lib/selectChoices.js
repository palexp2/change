// Choix d'un champ Sélection, sous la forme unique { value, label, color }
// qu'attend <ChoiceSelect> (menu de pastilles des fiches et formulaires).
//
// `declared` : les choix connus du code — chaînes, { value, label }, ou
// { id, label, color } d'un champ perso (la valeur enregistrée est alors le
// libellé). `config` : `options` de la personnalisation d'un champ NATIF
// (JSON ou objet, { choices: [{ value, label, color|null }] }) — elle fixe
// l'ordre, les libellés et les couleurs. Couleur nulle = celle déclarée par le
// code, sinon gris : un choix sans couleur reste une pastille grise.
export function selectChoicesWithColors(declared, config) {
  const base = (Array.isArray(declared) ? declared : [])
    .map(o => {
      if (o == null || typeof o !== 'object') {
        const v = String(o ?? '')
        return { value: v, label: v, color: null }
      }
      const v = String(o.value ?? o.label ?? o.id ?? '')
      return { value: v, label: String(o.label ?? v), color: o.color || null }
    })
    .filter(c => c.value !== '')

  let opts = config
  if (typeof opts === 'string') { try { opts = JSON.parse(opts) } catch { opts = null } }
  const custom = Array.isArray(opts?.choices) ? opts.choices : []
  if (!custom.length) return base.map(c => ({ ...c, color: c.color || 'gray' }))

  const byValue = new Map(base.map(c => [c.value, c]))
  const out = []
  const seen = new Set()
  for (const c of custom) {
    const v = String((c && typeof c === 'object' ? (c.value ?? c.label) : c) ?? '')
    if (!v || seen.has(v)) continue
    seen.add(v)
    const own = c && typeof c === 'object' ? c : {}
    out.push({ value: v, label: String(own.label ?? byValue.get(v)?.label ?? v), color: own.color || byValue.get(v)?.color || 'gray' })
  }
  for (const c of base) if (!seen.has(c.value)) out.push({ ...c, color: c.color || 'gray' })
  return out
}
