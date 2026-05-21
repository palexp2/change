import { useState, useEffect, useCallback, useContext, createContext } from 'react'
import api from './api.js'

// Cache module-level pour éviter de re-fetcher les règles à chaque montage
// de FieldGuard. Une page détail charge typiquement 10-30 FieldGuards ; sans
// cache on génèrerait 30 requêtes identiques.
const cache = new Map()           // context -> { rules, ts }
const inflight = new Map()        // context -> Promise
const subscribers = new Map()     // context -> Set<setter>
const TTL_MS = 60_000

function notify(context, rules) {
  const subs = subscribers.get(context)
  if (!subs) return
  for (const setter of subs) setter(rules)
}

async function fetchRules(context) {
  if (inflight.has(context)) return inflight.get(context)
  const p = api.fieldVisibilityRules.list(context)
    .then(res => {
      const rules = res.data || []
      cache.set(context, { rules, ts: Date.now() })
      inflight.delete(context)
      notify(context, rules)
      return rules
    })
    .catch(err => {
      inflight.delete(context)
      console.error('useFieldVisibilityRules fetch error:', err)
      return []
    })
  inflight.set(context, p)
  return p
}

export function useFieldVisibilityRules(context) {
  const cached = cache.get(context)
  const [rules, setRules] = useState(cached?.rules || [])

  useEffect(() => {
    if (!context) return
    // Subscribe
    let subs = subscribers.get(context)
    if (!subs) { subs = new Set(); subscribers.set(context, subs) }
    subs.add(setRules)

    // Charge si pas en cache ou expiré
    const c = cache.get(context)
    if (!c || Date.now() - c.ts > TTL_MS) {
      fetchRules(context)
    } else {
      setRules(c.rules)
    }

    return () => {
      subs.delete(setRules)
      if (subs.size === 0) subscribers.delete(context)
    }
  }, [context])

  const invalidate = useCallback(() => {
    if (!context) return Promise.resolve([])
    cache.delete(context)
    return fetchRules(context)
  }, [context])

  return { rules, invalidate }
}

// Utilitaires d'optimistic update (utilisés par la modale après save/delete).
export function patchCachedRules(context, mutator) {
  const c = cache.get(context)
  const current = c?.rules || []
  const next = mutator(current)
  cache.set(context, { rules: next, ts: Date.now() })
  notify(context, next)
}

// Contexte React optionnel pour exposer le record courant et la liste des
// champs disponibles à <FieldGuard>. Permet à FieldGuard de ne pas redemander
// le record à chaque utilisation.
export const FieldGuardContext = createContext(null)

export function useFieldGuardContext() {
  return useContext(FieldGuardContext)
}
