// L'absence de correspondance client ERP → QB n'invalide pas un dépôt choisi
// explicitement par un administrateur. On annote seulement un compte certain.
export function depositCreditAccount(deposit, customerIds) {
  const ids = customerIds.filter(Boolean).map(String)
  const lines = (deposit.Line || []).filter(line => line.DepositLineDetail)
  const matched = lines.filter(line => ids.includes(String(line.DepositLineDetail.Entity?.value)))
  if (ids.length && !matched.length) {
    const error = new Error('Ce dépôt ne contient aucune ligne pour le client de la facture.')
    error.status = 400
    throw error
  }
  const candidates = ids.length ? matched : lines
  if (!candidates.length) return null
  const accounts = candidates.map(line => line.DepositLineDetail.AccountRef)
  const account = accounts[0]
  return account?.value && accounts.every(item => String(item?.value) === String(account.value)) ? account : null
}
