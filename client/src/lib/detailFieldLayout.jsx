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
//
// Groupes créés par l'utilisateur : une entrée `{ key: 'grp:…', group: true,
// label }` dans la même liste. Les champs visibles qui la suivent (jusqu'au
// groupe suivant) lui appartiennent — réordonner suffit à ranger un champ.

// Cache module + abonnés : plusieurs fiches de la même entité peuvent être
// montées en même temps (page dessous, panneau dessus) ; elles doivent toutes
// voir le même ordre sans re-fetch.
//
// `allowDelete` (true | false | null) vient de la même ligne : c'est la case
// « Autoriser la suppression de la fiche » du mode de personnalisation. null =
// non réglé, la fiche garde son comportement d'origine.
const cache = new Map() // entityType -> { layout, allowDelete, loaded, promise }
const subs = new Map()  // entityType -> Set<fn>

// Copie locale de la dernière disposition connue : sans elle, la fiche s'ouvre
// dans l'ordre du code puis se réordonne quand la requête revient — les champs
// sautent sous les yeux à chaque premier affichage.
const lsKey = (entityType) => `erp_detail_layout_${entityType}`
// Même raison pour la case « suppression » : sans copie locale, un bouton
// Supprimer apparaîtrait (ou disparaîtrait) une fraction de seconde après
// l'ouverture de la fiche, le temps de la requête.
const lsDeleteKey = (entityType) => `erp_detail_allow_delete_${entityType}`

function readLocal(entityType) {
  try { return normalize(JSON.parse(localStorage.getItem(lsKey(entityType)))) } catch { return null }
}

function writeLocal(entityType, layout) {
  try {
    if (layout) localStorage.setItem(lsKey(entityType), JSON.stringify(layout))
    else localStorage.removeItem(lsKey(entityType))
  } catch { /* quota / mode privé : la disposition reste servie par l'API */ }
}

function readLocalDelete(entityType) {
  try {
    const raw = localStorage.getItem(lsDeleteKey(entityType))
    return raw === '1' ? true : raw === '0' ? false : null
  } catch { return null }
}

function writeLocalDelete(entityType, allow) {
  try {
    if (allow === null || allow === undefined) localStorage.removeItem(lsDeleteKey(entityType))
    else localStorage.setItem(lsDeleteKey(entityType), allow ? '1' : '0')
  } catch { /* quota / mode privé */ }
}

// Ordre des sections (tableaux) de la fiche : même raison qu'au-dessus.
const lsSectionsKey = (entityType) => `erp_detail_sections_${entityType}`

function readLocalSections(entityType) {
  try {
    const v = JSON.parse(localStorage.getItem(lsSectionsKey(entityType)))
    return Array.isArray(v) ? v : null
  } catch { return null }
}

function writeLocalSections(entityType, order) {
  try {
    if (order) localStorage.setItem(lsSectionsKey(entityType), JSON.stringify(order))
    else localStorage.removeItem(lsSectionsKey(entityType))
  } catch { /* quota / mode privé */ }
}

// Hauteur des tableaux de la fiche (entier / limité) : même raison.
const lsSizesKey = (entityType) => `erp_detail_section_sizes_${entityType}`

function readLocalSizes(entityType) {
  try {
    const v = JSON.parse(localStorage.getItem(lsSizesKey(entityType)))
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch { return null }
}

function writeLocalSizes(entityType, sizes) {
  try {
    if (sizes) localStorage.setItem(lsSizesKey(entityType), JSON.stringify(sizes))
    else localStorage.removeItem(lsSizesKey(entityType))
  } catch { /* quota / mode privé */ }
}

// Bandeau du panneau (titre + sous-titre choisis) : même raison — sans copie
// locale le titre du code s'afficherait puis sauterait.
const lsHeaderKey = (entityType) => `erp_detail_header_${entityType}`

function readLocalHeader(entityType) {
  try { return normalizeHeader(JSON.parse(localStorage.getItem(lsHeaderKey(entityType)))) } catch { return null }
}

function writeLocalHeader(entityType, header) {
  try {
    if (header) localStorage.setItem(lsHeaderKey(entityType), JSON.stringify(header))
    else localStorage.removeItem(lsHeaderKey(entityType))
  } catch { /* quota / mode privé */ }
}

function normalizeHeader(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  return {
    title: typeof raw.title === 'string' && raw.title ? raw.title : null,
    // null = sous-titre du code ; [] = aucun sous-titre.
    subtitle: Array.isArray(raw.subtitle) ? raw.subtitle.filter(k => typeof k === 'string') : null,
  }
}

function entryOf(cacheKey) {
  let entry = cache.get(cacheKey)
  if (!entry) {
    entry = {
      layout: readLocal(cacheKey),
      allowDelete: readLocalDelete(cacheKey),
      sectionOrder: readLocalSections(cacheKey),
      sectionSizes: readLocalSizes(cacheKey),
      header: readLocalHeader(cacheKey),
      loaded: false,
      promise: null,
    }
    cache.set(cacheKey, entry)
  }
  return entry
}

function normalize(raw) {
  if (!Array.isArray(raw)) return null
  return raw
    .map(e => {
      if (typeof e === 'string') return { key: e, hidden: false }
      if (e && e.group && typeof e.key === 'string') return { key: e.key, group: true, label: String(e.label ?? '') }
      if (e && typeof e.key === 'string') {
        // Forme historique { key, visible } : un `visible:false` dit « masqué ».
        // Sans ce repli, un champ retiré avant le passage à `hidden` revenait
        // s'afficher tout seul (c'était le cas des notes d'une entreprise).
        const hidden = 'hidden' in e ? !!e.hidden : e.visible === false
        return { key: e.key, hidden }
      }
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
      entry.allowDelete = typeof d?.allow_delete === 'boolean' ? d.allow_delete : null
      writeLocalDelete(entityType, entry.allowDelete)
      entry.sectionOrder = Array.isArray(d?.section_order) ? d.section_order : null
      writeLocalSections(entityType, entry.sectionOrder)
      entry.sectionSizes = d?.section_sizes && typeof d.section_sizes === 'object' ? d.section_sizes : null
      writeLocalSizes(entityType, entry.sectionSizes)
      entry.header = normalizeHeader(d?.header_config)
      writeLocalHeader(entityType, entry.header)
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
    if (seen.has(e.key) || !(e.group || known.has(e.key))) continue
    entries.push(e)
    seen.add(e.key)
  }
  for (const f of fields) {
    if (!seen.has(f.key)) entries.push({ key: f.key, hidden: !!f.defaultHidden })
  }
  return entries
}

// Abonnement à la configuration de fiche d'une entité (disposition + case
// « suppression »), partagé par les deux hooks publics ci-dessous : une seule
// requête, un seul cache, tout le monde re-rend au même moment.
function useDetailConfig(entityType) {
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

  return entityType ? (cache.get(entityType) || null) : null
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
  const entry = useDetailConfig(entityType)
  const stored = entry?.layout || null

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
  // `items` : champs visibles ET en-têtes de groupe, dans l'ordre (mode édition).
  const items = useMemo(
    () => entries.filter(e => !e.hidden).map(e => (e.group ? e : byKey.get(e.key))).filter(Boolean),
    [entries, byKey],
  )
  const visible = useMemo(() => items.filter(i => !i.group), [items])
  const hidden = useMemo(
    () => entries.filter(e => e.hidden).map(e => byKey.get(e.key)).filter(Boolean),
    [entries, byKey],
  )
  const userGroups = useMemo(() => {
    const out = []
    for (const i of items) {
      if (i.group) out.push({ id: i.key, label: i.label, keys: [] })
      else if (out.length) out[out.length - 1].keys.push(i.key)
    }
    return out
  }, [items])

  // `nextVisibleKeys` peut contenir les clés de groupe ; un groupe absent de la
  // liste est gardé en fin (jamais perdu par un appelant qui l'ignore).
  const applyOrder = useCallback((nextVisibleKeys) => {
    const groupsByKey = new Map(entries.filter(e => e.group).map(e => [e.key, e]))
    const next = nextVisibleKeys.map(key => groupsByKey.get(key) || { key, hidden: false })
    for (const [key, g] of groupsByKey) if (!nextVisibleKeys.includes(key)) next.push(g)
    persist([...next, ...entries.filter(e => e.hidden)])
  }, [entries, persist])

  const addGroup = useCallback((label) => {
    const key = `grp:${Math.random().toString(36).slice(2, 10)}`
    persist([
      ...entries.filter(e => !e.hidden),
      { key, group: true, label },
      ...entries.filter(e => e.hidden),
    ])
    return key
  }, [entries, persist])

  const renameGroup = useCallback((key, label) => {
    persist(entries.map(e => (e.key === key ? { ...e, label } : e)))
  }, [entries, persist])

  // Retirer un groupe ne retire aucun champ : ils rejoignent le groupe précédent.
  const removeGroup = useCallback((key) => {
    persist(entries.filter(e => e.key !== key))
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

  return { fields: visible, items, userGroups, hiddenFields: hidden, applyOrder, hide, show, addGroup, renameGroup, removeGroup }
}

// ── « Autoriser la suppression de la fiche » ─────────────────────────────────
//
// Réglé dans le même mode de personnalisation que la disposition des champs, et
// donc lui aussi PARTAGÉ : décoché, plus personne ne voit l'action de
// suppression sur cette fiche — et le serveur refuse le DELETE
// (server/src/middleware/recordDeleteGuard.js), pour que la case ne soit pas
// qu'un bouton caché.
//
// `fallback` : ce que vaut la case quand personne ne l'a réglée. C'est le
// comportement d'origine de la fiche (voir lib/recordDelete.js) : vrai pour une
// fiche qui offrait déjà sa suppression, faux pour celles où l'action est
// nouvelle.
export function useRecordDeleteAllowed(entityType, fallback = true) {
  const entry = useDetailConfig(entityType)
  return typeof entry?.allowDelete === 'boolean' ? entry.allowDelete : fallback
}

// Même valeur, plus le réglage (réservé aux admins côté UI, comme la
// disposition ; la route PUT l'est déjà côté serveur).
export function useRecordDeletePolicy(entityType, fallback = true) {
  const allowed = useRecordDeleteAllowed(entityType, fallback)

  const setAllowed = useCallback((next) => {
    if (!entityType) return
    const entry = entryOf(entityType)
    entry.allowDelete = next
    writeLocalDelete(entityType, next)
    notify(entityType)
    api.views.setDetailDeleteAllowed(entityType, next)
      .catch(err => console.error('[detailFieldLayout] échec sauvegarde suppression:', err))
  }, [entityType])

  return { allowed, setAllowed }
}

// ── Ordre des sections de la fiche ───────────────────────────────────────────
//
// Les sections (Informations, Mouvements, Achats…) se réordonnent dans le même
// mode de personnalisation que les champs, et l'ordre est PARTAGÉ de la même
// façon (colonne `section_order` de la même ligne ; écriture réservée aux
// admins). `sections` : clés déclarées par la fiche, dans l'ordre du code —
// référence stable attendue. Une clé stockée disparue du code est ignorée ; une
// section neuve se pose à sa place d'origine relative (après sa voisine du code).
export function useDetailSectionOrder(entityType, sections) {
  const entry = useDetailConfig(entityType)
  const stored = entry?.sectionOrder || null

  const ordered = useMemo(() => {
    if (!stored?.length) return sections
    const known = new Set(sections)
    const out = [...new Set(stored.filter(k => known.has(k)))]
    sections.forEach((k, i) => {
      if (out.includes(k)) return
      const prev = sections.slice(0, i).reverse().find(p => out.includes(p))
      out.splice(prev ? out.indexOf(prev) + 1 : 0, 0, k)
    })
    return out
  }, [stored, sections])

  const applyOrder = useCallback((next) => {
    if (!entityType) return
    const entry = entryOf(entityType)
    entry.sectionOrder = next
    writeLocalSections(entityType, next)
    notify(entityType)
    api.views.saveDetailSectionOrder(entityType, next)
      .catch(err => console.error('[detailFieldLayout] échec sauvegarde ordre des sections:', err))
  }, [entityType])

  return { sections: ordered, applyOrder }
}

// ── Hauteur des tableaux de la fiche ─────────────────────────────────────────
//
// Réglée dans le mode personnalisation, PARTAGÉE comme l'ordre des sections
// (colonne `section_sizes`). 'full' : le tableau s'affiche en entier, sans
// ascenseur ; sinon il reste borné (défaut).
export function useDetailSectionSizes(entityType) {
  const entry = useDetailConfig(entityType)
  const sizes = entry?.sectionSizes || null

  const isFull = useCallback((key) => sizes?.[key] === 'full', [sizes])

  const setFull = useCallback((key, full) => {
    if (!entityType) return
    const entry = entryOf(entityType)
    const next = { ...(entry.sectionSizes || {}), [key]: full ? 'full' : 'limited' }
    entry.sectionSizes = next
    writeLocalSizes(entityType, next)
    notify(entityType)
    api.views.saveDetailSectionSizes(entityType, next)
      .catch(err => console.error('[detailFieldLayout] échec sauvegarde hauteur des tableaux:', err))
  }, [entityType])

  return { isFull, setFull }
}

// ── Bandeau du panneau latéral ───────────────────────────────────────────────
//
// Réglé dans le mode personnalisation, PARTAGÉ comme le reste (colonne
// `header_config`). `header` : { title: clé|null, subtitle: [clé…]|null } ;
// une partie à null = celle du code (registre des fiches / tableau d'origine).
export function useDetailHeaderConfig(entityType) {
  const entry = useDetailConfig(entityType)
  const header = entry?.header || null

  const setHeader = useCallback((next) => {
    if (!entityType) return
    const value = normalizeHeader(next)
    const entry = entryOf(entityType)
    entry.header = value
    writeLocalHeader(entityType, value)
    notify(entityType)
    api.views.saveDetailHeader(entityType, value)
      .catch(err => console.error('[detailFieldLayout] échec sauvegarde du bandeau:', err))
  }, [entityType])

  return { header, setHeader }
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
