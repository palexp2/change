// The base role is implicit. Explicit grants are independent.
export function rolesOf(user) {
  if (!user) return []
  let roles = user.roles
  if (typeof roles === 'string') {
    try { roles = JSON.parse(roles) } catch { roles = [] }
  }
  if (roles == null) {
    // Compatibility for accounts created before the additive-role migration.
    roles = user.role === 'admin' ? ['admin', 'rh'] : user.role === 'rh' ? ['rh'] : []
  }
  return ['user', ...['admin', 'rh'].filter(role => Array.isArray(roles) && roles.includes(role))]
}
export const hasRole = (user, role) => rolesOf(user).includes(role)
export const isAdmin = user => hasRole(user, 'admin')
export const isHR = user => hasRole(user, 'rh')
export const legacyRole = roles => roles.includes('admin') ? 'admin' : roles.includes('rh') ? 'rh' : 'user'
export function validateRoles(value) {
  if (!Array.isArray(value) || value.some(role => !['user', 'admin', 'rh'].includes(role))) {
    throw new Error('Rôles invalides : user, admin et rh uniquement')
  }
  return rolesOf({ roles: value })
}
