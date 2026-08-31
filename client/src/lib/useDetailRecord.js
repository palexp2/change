import { useCallback, useEffect, useRef, useState } from 'react'

// Hook partagé pour les pages détail qui chargent UN record principal par id.
// Remplace la plomberie recopiée dans chaque page :
//
//   async function load() {
//     setLoading(true); setLoadError(null)
//     try { setOrder(await api.orders.get(id)) }
//     catch (e) { setLoadError(e?.message || 'Erreur de chargement') }
//     finally { setLoading(false) }
//   }
//   useEffect(() => { load() }, [load])
//
// Usage :
//
//   const { record, setRecord, loading, loadError, reload } =
//     useDetailRecord(() => api.orders.get(id), [id])
//
// - `fetcher` : fonction sans argument qui retourne la promesse du record.
//   Elle est capturée dans une ref — pas besoin de useCallback côté appelant.
// - `deps` : dépendances qui déclenchent un rechargement (typiquement [id]).
// - Annulation : si le composant démonte ou si `deps` changent avant la fin
//   du fetch, le résultat (succès ou erreur) de la requête périmée est ignoré
//   — pas de setState sur un composant démonté, pas de record d'un ancien id
//   qui écrase le nouveau.
// - `reload()` relance le chargement (mêmes états loading/loadError).
// - Options : `clearOnError` (défaut false) remet `record` à null quand le
//   chargement échoue — pour les pages dont l'écran d'erreur est gardé par
//   `loadError && !record` et qui veulent l'afficher même après un premier
//   chargement réussi (l'ancien `catch { setX(null); setLoadError(...) }`).
// - Les rendus loading / erreur / « introuvable » restent dans la page :
//   le hook ne gère que l'état.
export function useDetailRecord(fetcher, deps, { clearOnError = false } = {}) {
  const [record, setRecord] = useState(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(null)

  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const clearOnErrorRef = useRef(clearOnError)
  clearOnErrorRef.current = clearOnError

  // Incrémenté à chaque chargement : seul le chargement le plus récent a le
  // droit d'écrire dans l'état (annulation logique des fetchs périmés).
  const runIdRef = useRef(0)

  const load = useCallback(async () => {
    const runId = ++runIdRef.current
    setLoading(true)
    setLoadError(null)
    try {
      const data = await fetcherRef.current()
      if (runIdRef.current !== runId) return
      setRecord(data)
    } catch (e) {
      if (runIdRef.current !== runId) return
      if (clearOnErrorRef.current) setRecord(null)
      setLoadError(e?.message || 'Erreur de chargement')
    } finally {
      if (runIdRef.current === runId) setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    // Au démontage (ou changement de deps) : invalider tout chargement en vol.
    const ref = runIdRef
    return () => { ref.current++ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)

  return { record, setRecord, loading, loadError, reload: load }
}

export default useDetailRecord
