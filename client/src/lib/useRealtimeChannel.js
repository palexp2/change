import { useEffect, useRef } from 'react'
import { subscribe } from './realtime.js'

/**
 * Subscribe to a realtime channel for the lifetime of the calling component.
 * The handler is captured via ref so the subscription does NOT tear down on
 * each render even if the caller passes a fresh function reference.
 *
 * @param {string|null} channel — pass null/undefined to skip subscription
 * @param {(msg: { type: string, channel: string, payload: any, actorUserId: string|null, ts: number }) => void} handler
 */
export function useRealtimeChannel(channel, handler) {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    if (!channel) return
    return subscribe(channel, (msg) => {
      handlerRef.current?.(msg)
    })
  }, [channel])
}

// Champs méta qui changent à chaque mutation sans intérêt visuel — exclus du
// diff pour ne pas faire clignoter des colonnes invisibles / techniques.
const FLASH_IGNORED_FIELDS = new Set(['updated_at', 'created_at', 'synced_at', 'last_synced_at'])

/**
 * Compare deux versions d'un même record (prev = ce qui est affiché, next =
 * payload realtime) et retourne la liste des `field` dont la valeur a changé.
 * On ne considère que les clés déjà présentes dans `prev` (même shape que la
 * ligne affichée) pour ignorer les champs joints absents côté liste, et on
 * saute les champs méta (updated_at…). Sert à savoir quelle cellule surligner.
 *
 * @param {Record<string, any>|null|undefined} prev
 * @param {Record<string, any>|null|undefined} next
 * @returns {string[]} noms de champs modifiés
 */
export function diffFields(prev, next) {
  if (!prev || !next) return []
  const out = []
  for (const k of Object.keys(next)) {
    if (k === 'id' || FLASH_IGNORED_FIELDS.has(k)) continue
    if (!(k in prev)) continue
    if (prev[k] !== next[k]) out.push(k)
  }
  return out
}

/**
 * Wires a list-page state setter to `${entity}:list` events: created prepends,
 * updated merges by id, deleted filters out. Idempotent (skips if id is
 * already present on `created`). Pass `predicate(payload)` to ignore events
 * for rows that don't match the current filter (eg. lifecycle_phase pill).
 *
 * @param {string} entity — entity name, e.g. 'contact', 'product', 'task'
 * @param {(updater: (prev: any[]) => any[]) => void} setData
 * @param {{ predicate?: (payload: any) => boolean }} [opts]
 */
export function useEntityListRealtime(entity, setData, opts = {}) {
  const channel = entity ? `${entity}:list` : null
  const predicate = opts.predicate
  useRealtimeChannel(channel, (msg) => {
    const verb = msg.type?.split(':').slice(1).join(':') // strip "<entity>:" prefix
    if (verb === 'created') {
      if (predicate && !predicate(msg.payload)) return
      setData(prev => Array.isArray(prev) && prev.some(x => x.id === msg.payload.id) ? prev : [msg.payload, ...(prev || [])])
    } else if (verb === 'updated') {
      setData(prev => Array.isArray(prev) ? prev.map(x => x.id === msg.payload.id ? { ...x, ...msg.payload } : x) : prev)
    } else if (verb === 'deleted') {
      setData(prev => Array.isArray(prev) ? prev.filter(x => x.id !== msg.payload.id) : prev)
    }
  })
}
