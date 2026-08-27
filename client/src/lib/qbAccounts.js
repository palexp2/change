// Plan comptable QuickBooks, partagé par les écrans qui saisissent un numéro de
// compte (fin de mois, comptes prépayés). Un numéro seul (« 60000 ») ne dit pas à
// quel compte on impute : on affiche toujours le NOM à côté, et on fait choisir
// dans une liste plutôt qu'à la main.
//
// Un seul appel QB par session (cache module + requête en vol partagée) : la liste
// bouge rarement et l'appel passe par le connecteur QuickBooks.
import { useEffect, useMemo, useState } from 'react'
import api from './api.js'

let cache = null
let inflight = null

function load() {
  if (cache) return Promise.resolve(cache)
  inflight = inflight || api.quickbooks.accounts({ all: 1 })
    .then(list => { cache = Array.isArray(list) ? list : []; return cache })
    .catch(() => { inflight = null; return [] })
  return inflight
}

export function useQbAccounts() {
  const [accounts, setAccounts] = useState(cache || [])

  useEffect(() => {
    let alive = true
    load().then(list => { if (alive && list.length) setAccounts(list) })
    return () => { alive = false }
  }, [])

  return useMemo(() => {
    const byNum = new Map()
    for (const a of accounts) if (a.AcctNum) byNum.set(String(a.AcctNum), a)
    return {
      accounts,
      // Nom du compte pour un numéro, ou null s'il est inconnu (plan pas encore
      // chargé, ou numéro saisi qui n'existe pas dans QuickBooks).
      accountName: num => (num ? byNum.get(String(num))?.Name || null : null),
      // Options de sélecteur : « 60000 · Assurances », triées par numéro.
      options: accounts
        .filter(a => a.AcctNum)
        .map(a => ({ value: String(a.AcctNum), label: `${a.AcctNum} · ${a.Name}` }))
        .sort((x, y) => x.value.localeCompare(y.value)),
    }
  }, [accounts])
}
