import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import api from './api.js'

// ── Disposition des champs d'une fiche (ordre + champs retirés) ──────────────
//
// Une fiche (page détail ou panneau latéral) affiche une liste de champs codée
// en dur par le développeur. Cette couche la rend configurable par
// l'utilisateur : on peut retirer un champ, en remettre un, et changer l'ordre.
//
// La disposition est PARTAGÉE (une ligne par entité dans `detail_field_configs`,
// routes /api/views/detail/:entityType) : l'ordre choisi dans le panneau latéral
// vaut aussi pour la page pleine et pour tout le monde. C'est pour ça que
// l'édition est réservée aux admins côté UI (la route PUT l'est déjà côté
// serveur).
//
// Format stocké : [{ key, hidden }]. Le format historique (tableau de clés
// nues) reste lisible.

// Cache module + abonnés : plusieurs fiches de la même entité peuvent être
// montées en même temps (page dessous, panneau dessus) ; elles doivent toutes
// voir le même ordre sans re-fetch.
const cache = new Map() // entityType -> { layout, loaded, promise }
const subs = new Map()  // entityType -> Set<fn>

// Copie locale de la dernière disposition connue : sans elle, la fiche s'ouvre
// dans l'ordre du code puis se réordonne quand la requête revient — les champs
// sautent sous les yeux à chaque premier affichage.
const lsKey = (entityType) => `erp_detail_layout_${entityType}`

function readLocal(entityType) {
  try { return normalize(JSON.parse(localStorage.getItem(lsKey(entityType)))) } catch { return null }
}

function writeLocal(entityType, layout) {
  try {
    if (layout) localStorage.setItem(lsKey(entityType), JSON.stringify(layout))
    else localStorage.removeItem(lsKey(entityType))
  } catch { /* quota / mode privé : la disposition reste servie par l'API */ }
}

function entryOf(cacheKey) {
  let entry = cache.get(cacheKey)
  if (!entry) {
    entry = { layout: readLocal(cacheKey), loaded: false, promise: null }
    cache.set(cacheKey, entry)
  }
  return entry
}

function normalize(raw) {
  if (!Array.isArray(raw)) return null
  return raw
    .map(e => {
      if (typeof e === 'string') return { key: e, hidden: false }
      if (e && typeof e.key === 'string') return { key: e.key, hidden: !!e.hidden }
      return null
    })
    .filter(Boolean)
}

function notify(entityType) {
  for (const fn of subs.get(entityType) || []) fn()
}

function loadLayout(entityType) {
  const entry = entryOf(entityType)
  if (entry.loaded || entry.promise) return
  entry.promise = api.views.getDetailLayout(entityType)
    .then(d => {
      entry.layout = normalize(d?.field_order)
      writeLocal(entityType, entry.layout)
    })
    .catch(() => { /* pas de disposition = ordre du code */ })
    .finally(() => { entry.loaded = true; entry.promise = null; notify(entityType) })
}

// Fusionne la disposition stockée avec les champs déclarés par la fiche :
// - une clé stockée qui n'existe plus est ignorée ;
// - un champ nouvellement ajouté au code apparaît à la fin, visible — sauf
//   s'il se déclare `defaultHidden` (colonnes de sync), auquel cas il attend
//   dans le menu « Ajouter un champ ».
function mergeEntries(stored, fields) {
  const known = new Set(fields.map(f => f.key))
  const seen = new Set()
  const entries = []
  for (const e of stored || []) {
    if (!known.has(e.key) || seen.has(e.key)) continue
    entries.push(e)
    seen.add(e.key)
  }
  for (const f of fields) {
    if (!seen.has(f.key)) entries.push({ key: f.key, hidden: !!f.defaultHidden })
  }
  return entries
}

/**
 * Disposition des champs d'une entité.
 *
 * `fields` : liste déclarée par la fiche ([{ key, label, … }]).
 * Retourne les champs visibles dans l'ordre choisi, les champs retirés (pour le
 * menu « Ajouter un champ ») et les mutations — chacune persiste immédiatement
 * (autosave : pas de bouton « Enregistrer »).
 *
 * Les champs retirés sont rangés en fin de liste : remettre un champ le fait
 * réapparaître à la fin, d'où on le déplace où on veut.
 */
export function useDetailFieldLayout(entityType, fields) {
  const [, force] = useState(0)

  useEffect(() => {
    if (!entityType) return
    let set = subs.get(entityType)
    if (!set) { set = new Set(); subs.set(entityType, set) }
    const fn = () => force(n => n + 1)
    set.add(fn)
    loadLayout(entityType)
    return () => { set.delete(fn) }
  }, [entityType])

  const stored = entityType ? (cache.get(entityType)?.layout || null) : null

  const entries = useMemo(() => mergeEntries(stored, fields), [stored, fields])

  const persist = useCallback((next) => {
    if (!entityType) return
    const entry = entryOf(entityType)
    entry.layout = next
    entry.loaded = true
    writeLocal(entityType, next)
    notify(entityType)
    api.views.saveDetailLayout(entityType, next)
      .catch(err => console.error('[detailFieldLayout] échec sauvegarde:', err))
  }, [entityType])

  const byKey = useMemo(() => new Map(fields.map(f => [f.key, f])), [fields])
  const visible = useMemo(
    () => entries.filter(e => !e.hidden).map(e => byKey.get(e.key)).filter(Boolean),
    [entries, byKey],
  )
  const hidden = useMemo(
    () => entries.filter(e => e.hidden).map(e => byKey.get(e.key)).filter(Boolean),
    [entries, byKey],
  )

  const applyOrder = useCallback((nextVisibleKeys) => {
    const hiddenEntries = entries.filter(e => e.hidden)
    persist([...nextVisibleKeys.map(key => ({ key, hidden: false })), ...hiddenEntries])
  }, [entries, persist])

  const hide = useCallback((key) => {
    persist([
      ...entries.filter(e => e.key !== key && !e.hidden),
      ...entries.filter(e => e.key !== key && e.hidden),
      { key, hidden: true },
    ])
  }, [entries, persist])

  const show = useCallback((key) => {
    persist([
      ...entries.filter(e => e.key !== key && !e.hidden),
      { key, hidden: false },
      ...entries.filter(e => e.key !== key && e.hidden),
    ])
  }, [entries, persist])

  return { fields: visible, hiddenFields: hidden, applyOrder, hide, show }
}

// ── Mode édition porté par le panneau latéral ────────────────────────────────
// Le bouton vit dans l'en-tête du panneau (RecordPeekDrawer), la grille de
// champs vit dans la fiche embarquée : ce contexte les relie. La grille
// s'enregistre (le bouton n'apparaît que s'il y a quelque chose à éditer) et lit
// l'état `editing`.
const PeekFieldEditContext = createContext(null)

export const PeekFieldEditProvider = PeekFieldEditContext.Provider

export function usePeekFieldEdit() {
  return useContext(PeekFieldEditContext)
}
