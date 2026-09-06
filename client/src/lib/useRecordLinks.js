import { useEffect, useState } from 'react'
import api from './api.js'

// Résolution paresseuse et mutualisée « identifiant → fiche ERP ».
//
// Les champs lien importés d'Airtable stockent des identifiants (id ERP ou
// record ID `recXXXX`) et rien d'autre. Pour les afficher en liens cliquables,
// chaque cellule a besoin du libellé et de l'URL de la fiche visée — soit
// potentiellement des dizaines de résolutions par écran, sur des enregistrements
// qui reviennent d'une ligne à l'autre.
//
// D'où ce module : un cache mémoire partagé par toute l'app + un regroupement
// des demandes en un seul appel réseau par salve (30 ms). Une clé déjà connue
// est rendue immédiatement, sans requête.

// clé de cache → { table, id, label, sub, url } (ou null = résolue, introuvable).
// Une résolution PAR LIBELLÉ dépend de la table visée (« Acme » n'est pas le même
// enregistrement selon qu'on cherche une entreprise ou un projet) : ces clés-là
// sont donc rangées sous leur table, contrairement aux identifiants, qui sont
// discriminants à eux seuls.
const cache = new Map()
const cacheKey = (key, hint, byLabel) => (byLabel ? `label:${hint || ''}:${key}` : key)
// Clés en attente de départ, avec leur indice de table éventuel.
let queue = new Map()
let timer = null
const subscribers = new Set()

const MAX_PER_CALL = 150

function notify() {
  for (const fn of subscribers) fn()
}

function flush() {
  timer = null
  const pending = queue
  queue = new Map()
  // Un appel par indice de table (l'indice accélère la résolution serveur), les
  // clés sans indice partant ensemble. La recherche par libellé se demande à
  // part : c'est une passe de plus côté serveur, inutile aux champs qui portent
  // déjà un identifiant.
  const byHint = new Map()
  for (const [, req] of pending) {
    const k = `${req.byLabel ? 'L' : 'K'}|${req.hint || ''}`
    if (!byHint.has(k)) byHint.set(k, { hint: req.hint, byLabel: req.byLabel, keys: [] })
    byHint.get(k).keys.push(req.key)
  }
  for (const { hint, byLabel, keys } of byHint.values()) {
    for (let i = 0; i < keys.length; i += MAX_PER_CALL) {
      const chunk = keys.slice(i, i + MAX_PER_CALL)
      api.recordLinks.resolve(chunk, hint || undefined, byLabel)
        .then(res => {
          const data = res?.data || {}
          for (const key of chunk) cache.set(cacheKey(key, hint, byLabel), data[key] || null)
          notify()
        })
        .catch(() => {
          // Échec réseau : on oublie ces clés (pas de valeur négative en cache)
          // pour qu'un prochain rendu retente.
          for (const key of chunk) cache.delete(cacheKey(key, hint, byLabel))
        })
    }
  }
}

function enqueue(keys, hint, byLabel) {
  let added = false
  for (const key of keys) {
    const ck = cacheKey(key, hint, byLabel)
    if (cache.has(ck) || queue.has(ck)) continue
    queue.set(ck, { key, hint: hint || null, byLabel: !!byLabel })
    added = true
  }
  if (added && !timer) timer = setTimeout(flush, 30)
}

// Retourne un tableau aligné sur `keys` : `undefined` = encore en cours,
// `null` = aucun enregistrement ERP derrière cette clé, sinon la fiche.
// `table` (optionnel) = table ERP cible connue du mapping du champ.
// `byLabel` : accepter aussi le LIBELLÉ de la fiche comme clé (colonnes qui
// portent un nom plutôt qu'un identifiant) — nécessite `table`.
export function useRecordLinks(keys, table = null, byLabel = false) {
  const list = Array.isArray(keys) ? keys : []
  const signature = list.join(',')
  const [, bump] = useState(0)

  useEffect(() => {
    const fn = () => bump(n => n + 1)
    subscribers.add(fn)
    return () => subscribers.delete(fn)
  }, [])

  useEffect(() => {
    if (list.length) enqueue(list, table, byLabel)
    // `signature` suffit à identifier la demande ; `list` change d'identité à
    // chaque rendu (tableau reconstruit par la cellule).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature, table, byLabel])

  return list.map(k => cache.get(cacheKey(k, table, byLabel)))
}

// Vide le cache — utilisé par les tests ; l'app n'en a pas besoin (un libellé
// d'enregistrement change trop rarement pour justifier une invalidation).
export function _resetRecordLinkCache() {
  cache.clear()
  queue = new Map()
  if (timer) { clearTimeout(timer); timer = null }
}
