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
  const channel = opts.channel || (entity ? `${entity}:list` : null)
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
