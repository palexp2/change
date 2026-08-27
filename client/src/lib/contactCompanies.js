// Un contact peut appartenir à plusieurs entreprises : le lien legacy
// `contacts.company_id` (entreprise principale) ne raconte qu'une partie de
// l'histoire, les autres vivent dans `contact_companies` et arrivent du serveur
// agrégées dans `company_ids`.
//
// Filtrer un picker sur `company_id` seul rendait le contact invisible depuis
// toutes ses autres entreprises — d'où ce helper, à utiliser partout où l'on
// restreint une liste de contacts à une entreprise.
export function contactInCompany(contact, companyId) {
  if (!companyId) return true
  if (contact?.company_id === companyId) return true
  return Array.isArray(contact?.company_ids) && contact.company_ids.includes(companyId)
}

export function contactsForCompany(contacts, companyId) {
  if (!companyId) return contacts
  return contacts.filter(c => contactInCompany(c, companyId))
}
