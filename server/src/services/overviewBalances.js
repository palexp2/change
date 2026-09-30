// Comptes de la vue globale (ERP single-tenant). Les ids QuickBooks sont les
// comptes existants ; le mapping explicite du rapprochement reste prioritaire.
const ACCOUNTS = [
  { key: 'bnc-cad', name: 'BNC CAD', localName: 'BNC CAD', qbId: '61', currency: 'CAD' },
  { key: 'desjardins-credit', name: 'Marge de crédit Desjardins', localName: 'Marge Desjardins', qbId: '238', currency: 'CAD', credit: true },
  { key: 'bnc-credit', name: 'Marge de crédit BNC', localName: 'Marge BNC', qbId: '176', currency: 'CAD', credit: true },
  { key: 'venn-usd', name: 'VENN USD', localName: 'Venn USD', qbId: '256', currency: 'USD' },
]

const validBalance = value => typeof value === 'number' && Number.isFinite(value)
const qbIds = account => String(account?.qb_account_id || '').split(',').map(id => id.trim()).filter(Boolean)

// Dépendances injectées : les tests de priorité/source ne touchent ni la DB ni
// les banques. Une panne de connexion ne doit pas masquer les autres comptes.
export async function loadOverviewBalances({ accounts, items, fetchBalances, fetchQbAccounts }) {
  const selected = ACCOUNTS.map(def => ({
    def,
    local: accounts.find(a => qbIds(a).includes(def.qbId))
      || accounts.find(a => a.name.toLowerCase() === def.localName.toLowerCase()),
  }))
  const itemIds = [...new Set(selected.map(({ local }) => local?.plaid_account_id && local?.plaid_item_id).filter(Boolean))]
  const [liveResults, qbResult] = await Promise.all([
    Promise.allSettled(itemIds.map(id => fetchBalances(id))),
    Promise.resolve().then(fetchQbAccounts).catch(() => []),
  ])
  const live = new Map(itemIds.map((id, i) => [id, liveResults[i].status === 'fulfilled' ? liveResults[i].value : null]))
  return selected.map(({ def, local }) => {
    const result = { key: def.key, name: def.name, currency: def.currency, balance: null, source: null, as_of: null }
    const fresh = live.get(local?.plaid_item_id)
    const balance = fresh?.balances.find(a => a.plaid_account_id === local?.plaid_account_id)
    // Le solde courant d'une marge est la dette, pas le crédit disponible.
    // Même convention que la trésorerie QuickBooks : dette négative. Certaines
    // institutions (Desjardins) livrent déjà la marge avec un signe négatif.
    if (validBalance(balance?.current) && (!balance.iso_currency_code || balance.iso_currency_code === def.currency)) {
      return { ...result, balance: def.credit ? -Math.abs(balance.current) : balance.current, source: 'plaid_live', as_of: fresh.balanceAt }
    }
    const cached = items.find(i => i.itemId === local?.plaid_item_id)?.accounts?.find(a => a.plaid_account_id === local?.plaid_account_id)
    if (validBalance(cached?.balance) && (!local?.currency || local.currency === def.currency)) {
      return { ...result, balance: def.credit ? -Math.abs(cached.balance) : cached.balance, source: 'plaid_cached', as_of: cached.balance_at || null }
    }
    const ids = qbIds(local)
    const qb = qbResult.find(a => String(a.Id) === (ids.length === 1 ? ids[0] : def.qbId))
    if (validBalance(qb?.CurrentBalance) && (qb.CurrencyRef?.value || 'CAD') === def.currency) {
      return { ...result, balance: qb.CurrentBalance, source: 'quickbooks' }
    }
    return result
  })
}
