import { Router } from 'express'
import db from '../db/database.js'
import { requireAuth } from '../middleware/auth.js'
import { emitEntity } from '../services/realtimeEmitters.js'
import { buildPartialUpdate } from './partialUpdate.js'
import { parsePage } from './pagination.js'
import { newRecordId } from './recordId.js'

// Fabrique CRUD pilotée par un spec de db/recordRegistry.js.
//
//   export default crudRouter(RECORD_REGISTRY.vacations, {
//     extend: router => { router.get('/balance', …) },   // monté AVANT les /:id
//   })
//
// Migration partielle d'une route existante : `mountCrud(router, spec, { only: ['delete'] })`.
//
// Spec (en plus de table/idColumn/entity/softDelete/touchUpdatedAt/allowed/nonNullable/coerce) :
//   auth            middleware appliqué au routeur (défaut requireAuth)
//   writeAuth       middleware supplémentaire sur POST/PATCH/DELETE (ex. requireAdmin)
//   omit / only     verbes : list, get, create, update, delete
//   orderBy         SQL (défaut `created_at DESC`)
//   filters         colonnes acceptées en égalité dans req.query
//   search          colonnes cherchées en LIKE via ?q=
//   defaultLimit    50 | 'all' (défaut 'all')
//   view            relation de lecture pour GET /:id (ex. readRelation(table))
//   insertable      colonnes acceptées au POST (défaut allowed)
//   required        ['col'] ou { col: 'message' }
//   defaults        valeurs posées au POST quand la colonne est absente
//   validateCreate  body → message d'erreur | null
//   allowEmptyPatch un PATCH sans champ ne renvoie pas 400
//   serialize       row → objet renvoyé (list/get/create/update)
//   messages        { notFound, empty(key), noFields }
//   deleteResponse  corps du DELETE (défaut { success: true })
//   hooks           beforeCreate(body, req) · afterCreate(row, req) · beforeUpdate(id, body, req)
//                   afterUpdate(row, req) · beforeDelete(row, req) · afterDelete(id, req)
//                   Un hook qui retourne une string ⇒ 400 ; { status, error } ⇒ cette réponse.

export const NOW_SQL = `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`

const VERBS = ['list', 'get', 'create', 'update', 'delete']
const IDENT = /^[a-zA-Z_][a-zA-Z0-9_]*$/

function liveWhere(spec) {
  return spec.softDelete ? 'deleted_at IS NULL' : '1=1'
}

function serialize(spec, row) {
  return row && spec.serialize ? spec.serialize(row) : row
}

function hookResult(r) {
  if (!r) return null
  if (typeof r === 'string') return { status: 400, json: { error: r } }
  if (r.error) return { status: r.status || 400, json: { error: r.error } }
  return null
}

export function findExisting(spec, id) {
  return db.prepare(`SELECT * FROM ${spec.table} WHERE ${spec.idColumn} = ? AND ${liveWhere(spec)}`).get(id)
}

function notFound(spec) {
  return { status: 404, json: { error: spec.messages?.notFound || 'Not found' } }
}

export function listRows(spec, query = {}) {
  const where = [liveWhere(spec)]
  const params = []
  for (const col of spec.filters || []) {
    if (query[col] === undefined || query[col] === '') continue
    where.push(`${col} = ?`)
    params.push(query[col])
  }
  const q = query.q ?? query.search
  if (q && spec.search?.length) {
    where.push(`(${spec.search.map(c => `${c} LIKE ?`).join(' OR ')})`)
    for (const _ of spec.search) params.push(`%${q}%`)
  }
  const { page, limitVal, offset } = parsePage(query, spec.defaultLimit ?? 'all')
  const whereSql = where.join(' AND ')
  const from = spec.view || spec.table
  const total = db.prepare(`SELECT COUNT(*) c FROM ${spec.table} WHERE ${whereSql}`).get(...params).c
  const rows = db.prepare(
    `SELECT * FROM ${from} WHERE ${whereSql} ORDER BY ${spec.orderBy || 'created_at DESC'} LIMIT ? OFFSET ?`
  ).all(...params, limitVal, offset)
  return { data: rows.map(r => serialize(spec, r)), total, page: parseInt(page) || 1, limit: limitVal }
}

export function getRow(spec, id) {
  const from = spec.view || spec.table
  const row = db.prepare(`SELECT * FROM ${from} WHERE ${spec.idColumn} = ? AND ${liveWhere(spec)}`).get(id)
  return row ? { status: 200, json: serialize(spec, row) } : notFound(spec)
}

export function createRow(spec, body, req) {
  body = body || {}
  if (spec.validateCreate) {
    const err = spec.validateCreate(body)
    if (err) return { status: 400, json: { error: err } }
  }
  const required = Array.isArray(spec.required)
    ? Object.fromEntries(spec.required.map(k => [k, `${k} requis`]))
    : (spec.required || {})
  for (const [key, msg] of Object.entries(required)) {
    const v = body[key]
    if (v === undefined || v === null || String(v).trim() === '') return { status: 400, json: { error: msg } }
  }
  const early = hookResult(spec.beforeCreate?.(body, req))
  if (early) return early

  const cols = []
  const vals = []
  for (const key of spec.insertable || spec.allowed) {
    let v
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      v = body[key]
      if (spec.coerce?.[key]) v = spec.coerce[key](v)
      else if (v === '' || v === undefined) v = null
    } else if (spec.defaults && key in spec.defaults) {
      v = spec.defaults[key]
    } else continue
    cols.push(key)
    vals.push(v)
  }
  const id = newRecordId()
  db.prepare(`INSERT INTO ${spec.table} (${[spec.idColumn, ...cols].join(', ')}) VALUES (${[id, ...cols].map(() => '?').join(', ')})`)
    .run(id, ...vals)
  const row = db.prepare(`SELECT * FROM ${spec.view || spec.table} WHERE ${spec.idColumn} = ?`).get(id)
  if (spec.entity) emitEntity(spec.entity, 'created', id, row, req?.user?.id)
  spec.afterCreate?.(row, req)
  return { status: 201, json: serialize(spec, row) }
}

export function patchRow(spec, id, body, req) {
  body = body || {}
  if (!findExisting(spec, id)) return notFound(spec)
  const early = hookResult(spec.beforeUpdate?.(id, body, req))
  if (early) return early

  const { setClause, values, error } = buildPartialUpdate(body, {
    allowed: spec.allowed,
    coerce: spec.coerce,
    nonNullable: spec.nonNullable,
  })
  if (error) {
    const key = error.split(' ')[0]
    return { status: 400, json: { error: spec.messages?.empty?.(key) || error } }
  }
  if (!setClause && !spec.allowEmptyPatch) {
    return { status: 400, json: { error: spec.messages?.noFields || 'Aucun champ modifiable fourni' } }
  }
  const sets = [setClause, spec.touchUpdatedAt ? `updated_at = ${NOW_SQL}` : ''].filter(Boolean)
  if (sets.length) {
    db.prepare(`UPDATE ${spec.table} SET ${sets.join(', ')} WHERE ${spec.idColumn} = ?`).run(...values, id)
  }
  const row = db.prepare(`SELECT * FROM ${spec.view || spec.table} WHERE ${spec.idColumn} = ?`).get(id)
  if (spec.entity && setClause) emitEntity(spec.entity, 'updated', id, row, req?.user?.id)
  spec.afterUpdate?.(row, req)
  return { status: 200, json: serialize(spec, row) }
}

export function deleteRow(spec, id, req) {
  const row = findExisting(spec, id)
  if (!row) return notFound(spec)
  const early = hookResult(spec.beforeDelete?.(row, req))
  if (early) return early
  if (spec.softDelete) {
    db.prepare(`UPDATE ${spec.table} SET deleted_at = ${NOW_SQL} WHERE ${spec.idColumn} = ?`).run(id)
  } else {
    db.prepare(`DELETE FROM ${spec.table} WHERE ${spec.idColumn} = ?`).run(id)
  }
  if (spec.entity) emitEntity(spec.entity, 'deleted', id, { id }, req?.user?.id)
  spec.afterDelete?.(id, req)
  return { status: 200, json: spec.deleteResponse || { success: true } }
}

const send = (res, r) => res.status(r.status).json(r.json)

export function mountCrud(router, spec, { only, omit = [] } = {}) {
  for (const k of [spec.table, spec.idColumn, ...(spec.filters || []), ...(spec.search || [])]) {
    if (!IDENT.test(k)) throw new Error(`crudRouter: identifiant SQL invalide « ${k} »`)
  }
  const on = v => (only ? only.includes(v) : !omit.includes(v)) && VERBS.includes(v)
  const write = spec.writeAuth ? [spec.writeAuth] : []

  if (on('list')) router.get('/', (req, res) => res.json(listRows(spec, req.query)))
  if (on('get')) router.get('/:id', (req, res) => send(res, getRow(spec, req.params.id)))
  if (on('create')) router.post('/', ...write, (req, res) => send(res, createRow(spec, req.body, req)))
  if (on('update')) router.patch('/:id', ...write, (req, res) => send(res, patchRow(spec, req.params.id, req.body, req)))
  if (on('delete')) router.delete('/:id', ...write, (req, res) => send(res, deleteRow(spec, req.params.id, req)))
  return router
}

export function crudRouter(spec, { extend, only, omit } = {}) {
  const router = Router()
  router.use(spec.auth || requireAuth)
  extend?.(router)
  return mountCrud(router, spec, { only, omit })
}
